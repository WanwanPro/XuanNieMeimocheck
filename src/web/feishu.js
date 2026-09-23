// 飞书企业自建应用 SSO。
//
// 支持两条通道，最终都落到同一套本地会话：
//   1) 普通浏览器：OAuth 授权码 + PKCE（accounts.feishu.cn/oauth/v3/token）；
//   2) 飞书客户端 / 手机端：H5 JSAPI requestAuthCode 免登（免跳转，即点即用）。
//
// 安全约束：
//   - 身份标识只认 open_id + tenant_key，不使用邮箱/手机号（后者可变且可伪造口径不一）；
//   - 必须命中白名单，白名单为空时一律拒绝，避免"配置漏填 = 全公司可进"；
//   - state 一次性使用，10 分钟过期，防止回调重放/CSRF；
//   - app_secret 只存在于服务端，前端拿到的只有 app_id 与一次性 state。
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { isValidFeishuRedirectUri } from '../config.js';
import { loadConfig } from '../envfile.js';
import { appendToLogFile, beijingTime } from '../logger.js';

export const FEISHU_AUTHORIZE_URL = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize';
export const FEISHU_TOKEN_URL = 'https://accounts.feishu.cn/oauth/v3/token';
export const FEISHU_USERINFO_URL = 'https://open.feishu.cn/open-apis/authen/v1/user_info';
export const FEISHU_TENANT_TOKEN_URL = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
export const FEISHU_JSAPI_TICKET_URL = 'https://open.feishu.cn/open-apis/jssdk/ticket/get';
export const SESSION_COOKIE = 'meimoai_session';
export const FEISHU_STATE_COOKIE = 'meimoai_feishu_state';
export const FEISHU_JSAPI_COOKIE = 'meimoai_feishu_jsapi_nonce';
export const FEISHU_JSAPI_LIST = ['requestAuthCode'];

const STATE_TTL = 10 * 60 * 1000;
const TOKEN_TIMEOUT = 12 * 1000;
const TICKET_SAFETY_MS = 60 * 1000;
const MAX_STATES = 512;
const MAX_UPSTREAM_BYTES = 256 * 1024;

function base64Url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function createPkcePair() {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** jsapi_ticket 签名：sha1(jsapi_ticket=..&noncestr=..&timestamp=..&url=..)
 *  timestamp 为毫秒级（13 位），与下发给 h5sdk.config 的值必须完全一致。 */
export function jsapiSignature({ ticket, nonceStr, timestamp, url }) {
  return createHash('sha1')
    .update(`jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${url}`)
    .digest('hex');
}

/** 逗号 / 换行 / 分号分隔的名单，去空去重 */
export function parseList(raw) {
  if (!raw) return [];
  return [...new Set(String(raw).split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];
}

/** 读取飞书相关配置（纯函数，便于测试注入 processEnv） */
export function readFeishuConfig({ envFile, processEnv = process.env } = {}) {
  const cfg = loadConfig({ envFile, processEnv });
  const enabled = String(cfg.FEISHU_SSO_ENABLED || '').trim().toLowerCase() === 'true';
  return {
    enabled,
    appId: String(cfg.FEISHU_APP_ID || '').trim(),
    appSecret: String(cfg.FEISHU_APP_SECRET || '').trim(),
    redirectUri: String(cfg.FEISHU_REDIRECT_URI || '').trim(),
    tenantKeys: parseList(cfg.FEISHU_ALLOWED_TENANT_KEYS),
    openIds: parseList(cfg.FEISHU_ALLOWED_OPEN_IDS),
    scope: String(cfg.FEISHU_SCOPE || '').trim(),
  };
}

/** 配置是否真的可用；返回缺失项列表（空数组 = 可用） */
export function feishuConfigProblems(cfg) {
  if (!cfg || !cfg.enabled) return ['FEISHU_SSO_ENABLED'];
  const missing = [];
  if (!cfg.appId) missing.push('FEISHU_APP_ID');
  if (!cfg.appSecret) missing.push('FEISHU_APP_SECRET');
  if (!cfg.redirectUri) missing.push('FEISHU_REDIRECT_URI');
  else if (!isValidFeishuRedirectUri(cfg.redirectUri)) {
    missing.push('FEISHU_REDIRECT_URI（必须 HTTPS/localhost HTTP，且路径为 /api/auth/feishu/callback）');
  }
  if (!cfg.tenantKeys.length && !cfg.openIds.length) missing.push('FEISHU_ALLOWED_TENANT_KEYS / FEISHU_ALLOWED_OPEN_IDS');
  return missing;
}

function pickError(payload, fallback = '飞书接口返回错误') {
  if (!payload || typeof payload !== 'object') return fallback;
  return payload.error_description || payload.error || payload.msg || payload.message
    || (payload.code !== undefined && payload.code !== 0 ? `code=${payload.code}` : fallback);
}

function unwrap(payload) {
  if (payload && typeof payload === 'object' && payload.data && typeof payload.data === 'object') return payload.data;
  return payload && typeof payload === 'object' ? payload : {};
}

function pickToken(payload) {
  const data = unwrap(payload);
  return payload?.access_token || data.access_token || '';
}

/** 常量时间比较，避免白名单比对出现时序侧信道 */
function inList(value, list) {
  if (!value) return false;
  let hit = false;
  for (const item of list) {
    const a = Buffer.from(String(item));
    const b = Buffer.from(String(value));
    if (a.length === b.length && timingSafeEqual(a, b)) hit = true;
  }
  return hit;
}

export function createFeishuService({
  envFile, logFile, fetchImpl = globalThis.fetch, now = () => Date.now(),
} = {}) {
  const states = new Map();
  let ticketCache = null; // { ticket, expiresAt }
  let tenantTokenCache = null; // { token, expiresAt }

  function getConfig() {
    return readFeishuConfig({ envFile });
  }

  function isEnabled() {
    const cfg = getConfig();
    return cfg.enabled && feishuConfigProblems(cfg).length === 0;
  }

  function log(message) {
    try { appendToLogFile(logFile, `[FEISHU] ${message} (${beijingTime()})`); } catch { /* 日志失败不影响登录 */ }
  }

  async function readBody(res) {
    const declared = Number((res.headers && typeof res.headers.get === 'function' && res.headers.get('content-length')) || 0);
    if (declared > MAX_UPSTREAM_BYTES) throw new Error('飞书接口响应过大');
    const text = await res.text();
    if (Buffer.byteLength(text || '', 'utf8') > MAX_UPSTREAM_BYTES) throw new Error('飞书接口响应过大');
    return text;
  }

  async function postJson(url, body, { token } = {}) {
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TOKEN_TIMEOUT);
    try {
      const res = await fetchImpl(url, {
        method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
      });
      const text = await readBody(res);
      let payload = {};
      try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
      return { ok: res.ok, status: res.status, payload };
    } finally {
      clearTimeout(timer);
    }
  }

  function createState() {
    pruneStates(true);
    const state = base64Url(randomBytes(24));
    const { verifier, challenge } = createPkcePair();
    states.set(state, { verifier, createdAt: now() });
    return { state, challenge };
  }

  function consumeState(state) {
    if (!state || typeof state !== 'string') return null;
    const rec = states.get(state);
    if (!rec) return null;
    states.delete(state);
    if (now() - rec.createdAt > STATE_TTL) return null;
    return rec;
  }

  function pruneStates(trim = false) {
    const deadline = now() - STATE_TTL;
    for (const [key, rec] of states) if (rec.createdAt < deadline) states.delete(key);
    if (trim && states.size >= MAX_STATES) {
      const removeCount = states.size - MAX_STATES + 1;
      let removed = 0;
      for (const key of states.keys()) {
        states.delete(key);
        removed += 1;
        if (removed >= removeCount) break;
      }
    }
  }

  function buildAuthorizeUrl({ state, challenge, redirectUri }) {
    const cfg = getConfig();
    const url = new URL(FEISHU_AUTHORIZE_URL);
    url.searchParams.set('client_id', cfg.appId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', redirectUri || cfg.redirectUri);
    url.searchParams.set('state', state);
    if (cfg.scope) url.searchParams.set('scope', cfg.scope);
    if (challenge) {
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
    }
    return url.toString();
  }

  /**
   * 用授权码兑换 user_access_token。
   * redirect_uri 在 OAuth 跳转链路必须与授权时一致；JSAPI 链路部分租户校验不严格，
   * 因此 withRedirectUri=false 时省略该参数（调用方可按需重试）。
   */
  async function exchangeCode(code, { codeVerifier, redirectUri, withRedirectUri = true } = {}) {
    const cfg = getConfig();
    const body = {
      grant_type: 'authorization_code',
      client_id: cfg.appId,
      client_secret: cfg.appSecret,
      code,
    };
    const target = redirectUri || cfg.redirectUri;
    if (withRedirectUri && target) body.redirect_uri = target;
    if (codeVerifier) body.code_verifier = codeVerifier;

    const { ok, status, payload } = await postJson(FEISHU_TOKEN_URL, body);
    const accessToken = pickToken(payload);
    if (!ok || !accessToken) {
      return { ok: false, error: pickError(payload, `飞书换取用户令牌失败（HTTP ${status}）`), raw: payload };
    }
    return { ok: true, accessToken, refreshToken: payload?.refresh_token || unwrap(payload).refresh_token || '' };
  }

  async function fetchUserInfo(accessToken) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TOKEN_TIMEOUT);
    try {
      const res = await fetchImpl(FEISHU_USERINFO_URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      });
      const text = await readBody(res);
      let payload = {};
      try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
      const data = unwrap(payload);
      if (!res.ok || (payload?.code !== undefined && payload.code !== 0) || !data.open_id) {
        return { ok: false, error: pickError(payload, `飞书用户信息获取失败（HTTP ${res.status}）`), raw: payload };
      }
      return {
        ok: true,
        user: {
          openId: data.open_id,
          unionId: data.union_id || '',
          tenantKey: data.tenant_key || '',
          name: data.name || '',
          avatarUrl: data.avatar_url || '',
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 白名单校验：租户与用户维度都命中至少一项才放行 */
  function checkAccess(user) {
    const cfg = getConfig();
    const tenantOk = cfg.tenantKeys.length > 0 && inList(user.tenantKey, cfg.tenantKeys);
    const userOk = cfg.openIds.length > 0 && inList(user.openId, cfg.openIds);
    if (tenantOk || userOk) return { ok: true };
    if (!cfg.tenantKeys.length && !cfg.openIds.length) {
      return { ok: false, reason: '未配置飞书访问白名单（FEISHU_ALLOWED_TENANT_KEYS / FEISHU_ALLOWED_OPEN_IDS）' };
    }
    return { ok: false, reason: '该飞书账号不在允许名单内' };
  }

  async function getTenantToken() {
    if (tenantTokenCache && tenantTokenCache.expiresAt > now()) return tenantTokenCache.token;
    const cfg = getConfig();
    const { ok, status, payload } = await postJson(FEISHU_TENANT_TOKEN_URL, {
      app_id: cfg.appId, app_secret: cfg.appSecret,
    });
    const token = payload?.tenant_access_token || unwrap(payload).tenant_access_token || '';
    if (!ok || !token) {
      throw new Error(pickError(payload, `获取 tenant_access_token 失败（HTTP ${status}）`));
    }
    const expireSec = Number(payload?.expire || unwrap(payload).expire || 7200);
    tenantTokenCache = { token, expiresAt: now() + Math.max(60, expireSec - 120) * 1000 };
    return token;
  }

  async function getJsapiTicket() {
    if (ticketCache && ticketCache.expiresAt > now()) return ticketCache.ticket;
    const token = await getTenantToken();
    const { ok, status, payload } = await postJson(FEISHU_JSAPI_TICKET_URL, {}, { token });
    const data = unwrap(payload);
    const ticket = data.ticket || '';
    if (!ok || (payload?.code !== undefined && payload.code !== 0) || !ticket) {
      throw new Error(pickError(payload, `获取 jsapi_ticket 失败（HTTP ${status}）`));
    }
    const expireSec = Number(data.expire_in || 7200);
    ticketCache = { ticket, expiresAt: now() + Math.max(60, expireSec) * 1000 - TICKET_SAFETY_MS };
    return ticket;
  }

  /** 生成 h5sdk.config 所需签名；url 必须是当前页面地址（不含 #）。
   *  timestamp 必须是毫秒级（官方 h5sdk.config 文档要求「毫秒级，数据类型不能是 string」，
   *  签名有效期从该时间戳开始计算）——用秒级会被按 1970 年解析，导致签名校验失败。 */
  async function getJsapiConfig(pageUrl) {
    const cfg = getConfig();
    const ticket = await getJsapiTicket();
    const timestamp = now();
    const nonceStr = base64Url(randomBytes(16));
    return {
      appId: cfg.appId,
      timestamp,
      nonceStr,
      signature: jsapiSignature({ ticket, nonceStr, timestamp, url: pageUrl }),
      jsApiList: FEISHU_JSAPI_LIST,
    };
  }

  function resetCaches() {
    ticketCache = null;
    tenantTokenCache = null;
    states.clear();
  }

  return {
    getConfig,
    isEnabled,
    createState,
    consumeState,
    pruneStates,
    buildAuthorizeUrl,
    exchangeCode,
    fetchUserInfo,
    checkAccess,
    getJsapiConfig,
    resetCaches,
    log,
    stateTtlMs: STATE_TTL,
  };
}
