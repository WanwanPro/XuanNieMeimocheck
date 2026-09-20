// Web 认证：会话 token、登录限流、密码校验、飞书 SSO 会话落地。
//
// 设计要点：
//   - 会话只存在内存中，容器重启即失效；管理密码/飞书配置始终从 .env 实时读取，
//     因此 Web 修改密码或飞书白名单后可以立即 revoke 全部旧会话。
//   - 会话凭据同时支持 HttpOnly Cookie（浏览器首选）与 X-Auth-Token（API/旧版兼容）。
//   - 浏览器端不再需要把 token 存进 JS 变量，降低 XSS 泄漏面。
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { loadConfig } from '../envfile.js';
import { appendToLogFile, beijingTime } from '../logger.js';
import { SESSION_COOKIE, feishuConfigProblems, readFeishuConfig } from './feishu.js';

const TOKEN_TTL = 24 * 60 * 60 * 1000;
const LOGIN_WINDOW = 5 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const MAX_SESSIONS = 500;
const MAX_LOGIN_ATTEMPT_ENTRIES = 1024;

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

/** 解析 Cookie 头，返回普通对象；同名取最后一个（与浏览器行为一致） */
export function parseCookies(header) {
  const out = {};
  const input = Array.isArray(header) ? header.join('; ') : header;
  if (!input || typeof input !== 'string') return out;
  for (const part of input.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    let value = part.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

export function buildSessionCookie(token, { secure = false, maxAgeMs = TOKEN_TTL } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie({ secure = false } = {}) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** 追加 Set-Cookie，保留已有的 state/session Cookie。 */
export function appendSetCookie(res, cookie) {
  const current = typeof res.getHeader === 'function' ? res.getHeader('Set-Cookie') : undefined;
  const values = current === undefined ? [] : (Array.isArray(current) ? current.slice() : [current]);
  values.push(cookie);
  res.setHeader('Set-Cookie', values.length === 1 ? values[0] : values);
}

/** 支持 scrypt$salt$hash 与旧版明文 */
export function verifyPassword(input, stored) {
  if (!stored) return false;
  if (stored.startsWith('scrypt$')) {
    const parts = stored.split('$');
    if (parts.length !== 3 || !parts[1] || !parts[2]) return false;
    try {
      const derived = scryptSync(Buffer.from(String(input)), Buffer.from(parts[1], 'hex'), 64);
      const expected = Buffer.from(parts[2], 'hex');
      return derived.length === expected.length && timingSafeEqual(derived, expected);
    } catch {
      return false;
    }
  }
  return safeEqual(input, stored);
}

export function createAuthService({ envFile, logFile, now = () => Date.now() } = {}) {
  const sessions = new Map(); // token -> { expiresAt, identity }
  const loginAttempts = new Map();

  function getWebPassword() {
    return loadConfig({ envFile }).WEB_PASSWORD || '';
  }

  function getFeishuConfig() {
    return readFeishuConfig({ envFile });
  }

  function isPasswordEnabled() {
    return getWebPassword().length > 0;
  }

  function getFeishuRuntime() {
    const cfg = getFeishuConfig();
    const problems = feishuConfigProblems(cfg);
    return { cfg, problems, ready: cfg.enabled && problems.length === 0 };
  }

  function isFeishuEnabled() {
    return getFeishuRuntime().ready;
  }

  /** 飞书 SSO 是否被请求开启（即使配置不完整也算请求开启）。
   *  认证中间件必须按“请求开启”fail-closed，不能因为缺配置就退化成无认证。 */
  function isFeishuRequested() {
    return getFeishuRuntime().cfg.enabled;
  }

  function isAuthEnabled() {
    return isPasswordEnabled() || isFeishuRequested();
  }

  function revokeAll() {
    sessions.clear();
  }

  function pruneSessions() {
    const ts = now();
    for (const [token, rec] of sessions) if (ts > rec.expiresAt) sessions.delete(token);
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  }

  function createSession(identity = { type: 'password' }) {
    pruneSessions();
    const token = randomBytes(32).toString('hex');
    sessions.set(token, { expiresAt: now() + TOKEN_TTL, identity, createdAt: now() });
    return token;
  }

  function resolveSession(token) {
    if (!token || !sessions.has(token)) return null;
    const rec = sessions.get(token);
    if (now() > rec.expiresAt) {
      sessions.delete(token);
      return null;
    }
    return rec;
  }

  function validateToken(token) {
    return Boolean(resolveSession(token));
  }

  function destroySession(token) {
    if (!token) return false;
    return sessions.delete(token);
  }

  function tokenFromRequest(req) {
    const header = req && req.headers ? req.headers['x-auth-token'] : '';
    if (header) return String(header);
    const cookies = parseCookies(req && req.headers ? req.headers.cookie : '');
    return cookies[SESSION_COOKIE] || '';
  }

  function isSecureRequest(req) {
    return Boolean(req && req.secure === true);
  }

  function issueSession(req, res, identity) {
    const token = createSession(identity);
    appendSetCookie(res, buildSessionCookie(token, { secure: isSecureRequest(req) }));
    return token;
  }

  function getLoginRecord(ip) {
    const ts = now();
    const rec = loginAttempts.get(ip);
    if (!rec) return null;
    if (rec.lockedUntil) {
      if (ts < rec.lockedUntil) return rec;
      loginAttempts.delete(ip);
      return null;
    }
    if (ts - rec.windowStart > LOGIN_WINDOW) {
      loginAttempts.delete(ip);
      return null;
    }
    return rec;
  }

  function isLoginLocked(ip) {
    const rec = getLoginRecord(ip);
    return Boolean(rec && rec.lockedUntil && now() < rec.lockedUntil);
  }

  function recordLoginFailure(ip) {
    let rec = getLoginRecord(ip);
    if (!rec) {
      while (loginAttempts.size >= MAX_LOGIN_ATTEMPT_ENTRIES) {
        loginAttempts.delete(loginAttempts.keys().next().value);
      }
      rec = { windowStart: now(), failures: 0 };
      loginAttempts.set(ip, rec);
    }
    rec.failures += 1;
    if (rec.failures >= LOGIN_MAX_ATTEMPTS) {
      rec.lockedUntil = now() + LOGIN_LOCK_MS;
      appendToLogFile(logFile, `[WARN] 登录失败次数过多，IP ${ip} 已锁定 15 分钟 (${beijingTime()})`);
    }
  }

  function clearLoginFailures(ip) {
    loginAttempts.delete(ip);
  }

  function authMiddleware(req, res, next) {
    if (!isAuthEnabled()) return next();
    if (validateToken(tokenFromRequest(req))) return next();
    return res.status(401).json({ error: '未授权，请先登录' });
  }

  function authStatus() {
    const feishu = getFeishuRuntime();
    return {
      authRequired: isAuthEnabled(),
      passwordEnabled: isPasswordEnabled(),
      feishuEnabled: feishu.ready,
      feishuAppId: feishu.ready ? feishu.cfg.appId : '',
      feishuConfigProblems: feishu.cfg.enabled ? feishu.problems : [],
    };
  }

  function registerRoutes(app) {
    app.post('/api/login', (req, res) => {
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      if (isLoginLocked(ip)) {
        return res.status(429).json({ error: '登录失败次数过多，请 15 分钟后再试' });
      }

      const password = req.body && req.body.password;
      const webPassword = getWebPassword();
      if (!webPassword) {
        // 未设置管理密码时，只有认证本身未开启（既无密码也未请求飞书）才是开放模式。
        // 若飞书被开启但配置不完整，这里必须 fail-closed，不能把匿名请求标记成已认证。
        if (isAuthEnabled()) {
          recordLoginFailure(ip);
          return res.status(401).json({ error: '飞书登录尚未就绪且未设置管理密码，暂时无法登录' });
        }
        return res.json({ ok: true, authRequired: false, authenticated: true });
      }

      if (verifyPassword(password, webPassword)) {
        clearLoginFailures(ip);
        issueSession(req, res, { type: 'password' });
        return res.json({ ok: true, authRequired: true, authenticated: true });
      }

      recordLoginFailure(ip);
      return res.status(401).json({ error: '密码错误' });
    });

    app.get('/api/auth-status', (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ...authStatus(), authenticated: validateToken(tokenFromRequest(req)) });
    });

    app.post('/api/logout', (req, res) => {
      destroySession(tokenFromRequest(req));
      res.setHeader('Set-Cookie', clearSessionCookie({ secure: isSecureRequest(req) }));
      res.json({ ok: true });
    });
  }

  return {
    registerRoutes,
    authMiddleware,
    revokeAll,
    isAuthEnabled,
    isPasswordEnabled,
    isFeishuEnabled,
    getWebPassword,
    getFeishuConfig,
    createSession,
    issueSession,
    resolveSession,
    destroySession,
    validateToken,
    tokenFromRequest,
    isSecureRequest,
    authStatus,
    sessionTtlMs: TOKEN_TTL,
  };
}
