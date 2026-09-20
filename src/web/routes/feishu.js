// 飞书 SSO 路由：授权跳转 / 回调 / 客户端 JSAPI 免登 / JSAPI 签名配置。
//
// 约定：所有失败都以稳定错误码重定向回首页（?auth_error=xxx），
// 前端按码表展示中文提示；详细原因只写进服务端日志，避免把
// 内部错误、client_secret 相关响应或租户信息回显到浏览器。
import { randomBytes, timingSafeEqual } from 'crypto';
import { appendSetCookie, parseCookies } from '../auth.js';
import { FEISHU_JSAPI_COOKIE, FEISHU_STATE_COOKIE, feishuConfigProblems } from '../feishu.js';

const AUTH_ERROR_CODES = new Set([
  'disabled', 'denied', 'state', 'exchange', 'userinfo', 'forbidden', 'unavailable',
]);
const STATE_COOKIE_MAX_AGE_MS = 10 * 60 * 1000;
const JSAPI_NONCE_MAX_AGE_MS = 5 * 60 * 1000;
const MAX_JSAPI_NONCES = 1024;

function safeStateEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

function buildStateCookie(value, req, auth, maxAgeMs = STATE_COOKIE_MAX_AGE_MS) {
  const parts = [
    `${FEISHU_STATE_COOKIE}=${value || ''}`,
    'Path=/api/auth/feishu',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (auth && auth.isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

function clearStateCookie(req, res, auth) {
  appendSetCookie(res, buildStateCookie('', req, auth, 0));
}

function buildJsapiNonceCookie(value, req, auth, maxAgeMs = JSAPI_NONCE_MAX_AGE_MS) {
  const parts = [
    `${FEISHU_JSAPI_COOKIE}=${value || ''}`,
    'Path=/api/auth/feishu',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (auth && auth.isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

function clearJsapiNonceCookie(req, res, auth) {
  appendSetCookie(res, buildJsapiNonceCookie('', req, auth, 0));
}

/** JSAPI 免登只接受同源 JSON 请求；Origin/Referer 与配置的回调域名必须完全一致。 */
function isSameOriginRequest(req, cfg) {
  let expected = '';
  try { expected = new URL(cfg.redirectUri).origin; } catch { return false; }
  if (!expected) return false;

  const headers = (req && req.headers) || {};
  const raw = headers.origin || headers.referer || '';
  if (raw) {
    try { return new URL(String(raw)).origin === expected; } catch { return false; }
  }

  // 少数旧 WebView 同源 POST 不带 Origin/Referer；只接受明确同源或导航来源的 Fetch Metadata。
  const site = String(headers['sec-fetch-site'] || '').toLowerCase();
  return site === 'same-origin' || site === 'none';
}

function isJsonContentType(req) {
  const value = String(((req && req.headers) || {})['content-type'] || '').toLowerCase();
  return /^application\/(?:json|[^;]+\+json)(?:\s*;|$)/.test(value);
}

function safeErrorCode(code) {
  return AUTH_ERROR_CODES.has(code) ? code : 'unavailable';
}

/** 回调失败时回首页；请求显式要求 JSON（或 JSAPI 通道）时返回 JSON */
function fail(req, res, code, { json = false, message = '' } = {}) {
  const finalCode = safeErrorCode(code);
  if (json) return res.status(401).json({ ok: false, error: finalCode, message });
  return res.redirect(302, `/?auth_error=${finalCode}`);
}

/** 计算当前 H5 页面地址（jsapi_ticket 签名必须与页面 URL 完全一致） */
export function resolvePageUrl(req, cfg) {
  if (!cfg || !cfg.redirectUri) throw new Error('飞书回调地址未配置');
  let base;
  try {
    base = `${new URL(cfg.redirectUri).origin}/`;
  } catch {
    throw new Error('飞书回调地址无效');
  }

  const requested = req.query && req.query.url ? String(req.query.url) : '';
  if (requested && !/[\r\n]/.test(requested)) {
    try {
      const target = new URL(requested);
      const allowed = new URL(base);
      if (target.origin === allowed.origin && (target.protocol === 'http:' || target.protocol === 'https:')) {
        return `${target.origin}${target.pathname}${target.search}`;
      }
    } catch { /* 非法 URL 直接回退到默认页面地址 */ }
  }
  return base;
}

export function registerFeishuRoutes(app, { feishu, auth, logFile, logger = console }) {
  // 一次性 nonce：jsapi-config 下发并写入 HttpOnly Cookie，jsapi 兑换时消费。
  // 这样跨站表单即使能带上受害者 Cookie，也无法猜中服务端保存的 nonce。
  const jsapiNonces = new Map(); // nonce -> expiresAt

  function pruneJsapiNonces() {
    const ts = Date.now();
    for (const [nonce, expiresAt] of jsapiNonces) if (ts > expiresAt) jsapiNonces.delete(nonce);
    while (jsapiNonces.size >= MAX_JSAPI_NONCES) jsapiNonces.delete(jsapiNonces.keys().next().value);
  }

  function issueJsapiNonce(req, res) {
    pruneJsapiNonces();
    const nonce = randomBytes(24).toString('hex');
    jsapiNonces.set(nonce, Date.now() + JSAPI_NONCE_MAX_AGE_MS);
    appendSetCookie(res, buildJsapiNonceCookie(nonce, req, auth));
    return nonce;
  }

  function consumeJsapiNonce(nonce) {
    const expiresAt = jsapiNonces.get(nonce);
    if (expiresAt === undefined) return false;
    jsapiNonces.delete(nonce);
    return Date.now() <= expiresAt;
  }

  function rejectJsapi(req, res, status, error) {
    clearJsapiNonceCookie(req, res, auth);
    return res.status(status).json({ ok: false, error });
  }

  function disabled(req, res) {
    const json = req.method !== 'GET' || (req.query && req.query.format === 'json');
    return fail(req, res, 'disabled', { json, message: '飞书 SSO 未启用' });
  }

  function guard(req, res) {
    if (feishu.isEnabled()) return true;
    const cfg = feishu.getConfig();
    const problems = feishuConfigProblems(cfg);
    if (cfg.enabled && problems.length) {
      feishu.log(`飞书 SSO 已开启但配置不完整：缺少 ${problems.join('、')}`);
    }
    disabled(req, res);
    return false;
  }

  app.get('/api/auth/feishu/start', (req, res) => {
    if (!guard(req, res)) return undefined;
    try {
      feishu.pruneStates();
      const { state, challenge } = feishu.createState();
      const url = feishu.buildAuthorizeUrl({ state, challenge });
      appendSetCookie(res, buildStateCookie(state, req, auth));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      return res.redirect(302, url);
    } catch (error) {
      logger.error('飞书授权跳转失败：', error);
      return fail(req, res, 'unavailable');
    }
  });

  app.get('/api/auth/feishu/callback', async (req, res) => {
    if (!guard(req, res)) return undefined;
    const query = req.query || {};
    const cookieState = parseCookies(req.headers && req.headers.cookie)[FEISHU_STATE_COOKIE] || '';

    if (query.error) {
      clearStateCookie(req, res, auth);
      feishu.log(`飞书授权被拒绝：${String(query.error).slice(0, 60)}`);
      return fail(req, res, 'denied');
    }

    if (!safeStateEqual(query.state, cookieState)) {
      clearStateCookie(req, res, auth);
      feishu.log('飞书回调 state 与浏览器绑定 Cookie 不一致或缺失');
      return fail(req, res, 'state');
    }

    const record = feishu.consumeState(query.state);
    if (!record) {
      clearStateCookie(req, res, auth);
      feishu.log('飞书回调 state 校验失败（过期、重复使用或缺失）');
      return fail(req, res, 'state');
    }

    const code = query.code ? String(query.code) : '';
    if (!code) {
      clearStateCookie(req, res, auth);
      return fail(req, res, 'exchange');
    }

    try {
      let exchanged = await feishu.exchangeCode(code, { codeVerifier: record.verifier });
      if (!exchanged.ok) {
        clearStateCookie(req, res, auth);
        feishu.log(`授权码兑换失败：${exchanged.error}`);
        return fail(req, res, 'exchange');
      }
      const info = await feishu.fetchUserInfo(exchanged.accessToken);
      if (!info.ok) {
        clearStateCookie(req, res, auth);
        feishu.log(`用户信息读取失败：${info.error}`);
        return fail(req, res, 'userinfo');
      }
      const access = feishu.checkAccess(info.user);
      if (!access.ok) {
        clearStateCookie(req, res, auth);
        feishu.log(`拒绝登录：${access.reason}（open_id=${info.user.openId || '-'}）`);
        return fail(req, res, 'forbidden');
      }
      auth.issueSession(req, res, {
        type: 'feishu',
        openId: info.user.openId,
        tenantKey: info.user.tenantKey,
        name: info.user.name,
      });
      clearStateCookie(req, res, auth);
      feishu.log(`飞书登录成功：${info.user.name || info.user.openId}`);
      return res.redirect(302, '/');
    } catch (error) {
      clearStateCookie(req, res, auth);
      logger.error('飞书回调处理异常：', error);
      feishu.log(`回调处理异常：${error.message}`);
      return fail(req, res, 'unavailable');
    }
  });

  app.post('/api/auth/feishu/jsapi', async (req, res) => {
    if (!guard(req, res)) return undefined;
    if (!isJsonContentType(req)) return rejectJsapi(req, res, 415, 'unsupported_media_type');

    const cfg = feishu.getConfig();
    if (!isSameOriginRequest(req, cfg)) {
      feishu.log('拒绝跨站 JSAPI 免登请求（Origin/Referer 校验失败）');
      return rejectJsapi(req, res, 403, 'csrf');
    }

    const cookieNonce = parseCookies(req.headers && req.headers.cookie)[FEISHU_JSAPI_COOKIE] || '';
    const bodyNonce = req.body && req.body.nonce ? String(req.body.nonce) : '';
    if (!safeStateEqual(bodyNonce, cookieNonce) || !consumeJsapiNonce(bodyNonce)) {
      feishu.log('拒绝 JSAPI 免登请求（nonce 缺失、过期或与 Cookie 不一致）');
      return rejectJsapi(req, res, 403, 'csrf');
    }

    const code = req.body && req.body.code ? String(req.body.code) : '';
    if (!code) return rejectJsapi(req, res, 400, 'missing_code');

    try {
      // JSAPI 免登拿到的 code 与授权码同源；部分租户不校验 redirect_uri，
      // 因此先在带 redirect_uri 失败时无参重试一次。
      let exchanged = await feishu.exchangeCode(code, {});
      if (!exchanged.ok) {
        exchanged = await feishu.exchangeCode(code, { withRedirectUri: false });
      }
      if (!exchanged.ok) {
        feishu.log(`JSAPI 免登授权码兑换失败：${exchanged.error}`);
        return res.status(401).json({ ok: false, error: 'exchange' });
      }
      const info = await feishu.fetchUserInfo(exchanged.accessToken);
      if (!info.ok) {
        feishu.log(`JSAPI 用户信息读取失败：${info.error}`);
        return res.status(401).json({ ok: false, error: 'userinfo' });
      }
      const access = feishu.checkAccess(info.user);
      if (!access.ok) {
        feishu.log(`拒绝 JSAPI 登录：${access.reason}（open_id=${info.user.openId || '-'}）`);
        return res.status(403).json({ ok: false, error: 'forbidden' });
      }
      auth.issueSession(req, res, {
        type: 'feishu',
        openId: info.user.openId,
        tenantKey: info.user.tenantKey,
        name: info.user.name,
      });
      clearJsapiNonceCookie(req, res, auth);
      feishu.log(`飞书 JSAPI 免登成功：${info.user.name || info.user.openId}`);
      return res.json({ ok: true, authRequired: auth.isAuthEnabled(), authenticated: true });
    } catch (error) {
      logger.error('飞书 JSAPI 免登异常：', error);
      feishu.log(`JSAPI 免登异常：${error.message}`);
      return res.status(500).json({ ok: false, error: 'unavailable' });
    }
  });

  app.get('/api/auth/feishu/jsapi-config', async (req, res) => {
    if (!guard(req, res)) return undefined;
    try {
      const cfg = feishu.getConfig();
      const pageUrl = resolvePageUrl(req, cfg);
      const config = await feishu.getJsapiConfig(pageUrl);
      const nonce = issueJsapiNonce(req, res);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ok: true, url: pageUrl, nonce, ...config });
    } catch (error) {
      logger.error('飞书 JSAPI 签名失败：', error);
      feishu.log(`JSAPI 签名失败：${error.message}`);
      return res.status(503).json({ ok: false, error: 'unavailable' });
    }
  });
}
