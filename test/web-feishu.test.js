import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { CONFIG_KEYS } from '../src/config.js';
import { writeEnvAtomic } from '../src/envfile.js';
import { createAuthService, parseCookies } from '../src/web/auth.js';
import {
  FEISHU_JSAPI_COOKIE,
  FEISHU_JSAPI_TICKET_URL,
  FEISHU_TENANT_TOKEN_URL,
  FEISHU_TOKEN_URL,
  FEISHU_USERINFO_URL,
  FEISHU_STATE_COOKIE,
  SESSION_COOKIE,
  createFeishuService,
  createPkcePair,
  feishuConfigProblems,
  jsapiSignature,
  parseList,
  readFeishuConfig,
} from '../src/web/feishu.js';
import { registerFeishuRoutes } from '../src/web/routes/feishu.js';
import {
  createFakeApp, createReq, createRes, invoke, routeOf,
} from '../test-support/harness.mjs';

function b64url(value) {
  return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function baseEnv(overrides = {}) {
  const values = {};
  for (const key of CONFIG_KEYS) values[key] = '';
  Object.assign(values, {
    MEIMOAI_URL: 'https://meimoai13.com/',
    CRON_SCHEDULE: '0 1 * * *',
    RANDOM_DELAY: 'true',
    RANDOM_DELAY_MAX_MINUTES: '300',
    SKIP_PROBABILITY: '0.05',
    MAX_CONSECUTIVE_FAILURES: '3',
    FEISHU_SSO_ENABLED: 'true',
    FEISHU_APP_ID: 'cli_test_app',
    FEISHU_APP_SECRET: 'app-secret',
    FEISHU_REDIRECT_URI: 'https://checkin.example.com/api/auth/feishu/callback',
    FEISHU_ALLOWED_TENANT_KEYS: 'tenant-ok',
    FEISHU_ALLOWED_OPEN_IDS: '',
    FEISHU_SCOPE: '',
  }, overrides);
  return values;
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(payload); },
  };
}

function createFetchMock({ user = {}, tokenPayload = null, userInfoPayload = null } = {}) {
  const calls = [];
  const finalUser = {
    open_id: 'ou_allowed',
    tenant_key: 'tenant-ok',
    name: '测试用户',
    avatar_url: '',
    ...user,
  };
  async function fetchImpl(url, options = {}) {
    const target = String(url);
    let body = null;
    if (options.body) {
      try { body = JSON.parse(String(options.body)); } catch { body = String(options.body); }
    }
    calls.push({ url: target, options, body });
    if (target === FEISHU_TOKEN_URL) {
      return jsonResponse(tokenPayload || {
        access_token: 'user-token-1',
        refresh_token: 'refresh-token-1',
      });
    }
    if (target === FEISHU_USERINFO_URL) {
      return jsonResponse(userInfoPayload || { code: 0, data: finalUser });
    }
    if (target === FEISHU_TENANT_TOKEN_URL) {
      return jsonResponse({ code: 0, tenant_access_token: 'tenant-token-1', expire: 7200 });
    }
    if (target === FEISHU_JSAPI_TICKET_URL) {
      return jsonResponse({ code: 0, data: { ticket: 'ticket-123', expire_in: 7200 } });
    }
    throw new Error(`unexpected fetch: ${target}`);
  }
  return { fetchImpl, calls, user: finalUser };
}

async function setup(t, { overrides = {}, fetchImpl } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'meimoai-web-feishu-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const envFile = join(dir, '.env');
  const logFile = join(dir, 'checkin.log');
  writeEnvAtomic(envFile, baseEnv(overrides), CONFIG_KEYS);

  const auth = createAuthService({ envFile, logFile });
  const feishu = createFeishuService({ envFile, logFile, fetchImpl });
  const { app, routes } = createFakeApp();
  registerFeishuRoutes(app, {
    feishu,
    auth,
    logFile,
    logger: { error() {} },
  });
  return { dir, envFile, logFile, auth, feishu, routes };
}

function invokeRoute(ctx, method, path, req = {}) {
  return invoke(routeOf(ctx.routes, method, path), createReq({ method, ...req }), createRes());
}

function setCookies(res) {
  const raw = res.headers['set-cookie'];
  return raw === undefined ? [] : (Array.isArray(raw) ? raw : [raw]);
}

function cookieValue(res, name) {
  return parseCookies(setCookies(res))[name] || '';
}

async function getJsapiConfig(ctx) {
  const res = await invokeRoute(ctx, 'GET', '/api/auth/feishu/jsapi-config');
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.nonce, 'jsapi-config 必须下发一次性 nonce');
  const nonceCookie = cookieValue(res, FEISHU_JSAPI_COOKIE);
  assert.equal(nonceCookie, res.body.nonce, 'nonce 应与 HttpOnly Cookie 绑定');
  return { res, nonce: res.body.nonce, nonceCookie };
}

test('readFeishuConfig 解析开关、清单与配置缺项', () => {
  const cfg = readFeishuConfig({
    processEnv: {
      FEISHU_SSO_ENABLED: ' TRUE ',
      FEISHU_APP_ID: ' cli_x ',
      FEISHU_APP_SECRET: ' secret ',
      FEISHU_REDIRECT_URI: ' https://example.com/api/auth/feishu/callback ',
      FEISHU_ALLOWED_TENANT_KEYS: 'tk1, tk2\ntk1',
      FEISHU_ALLOWED_OPEN_IDS: 'ou_1; ou_2',
      FEISHU_SCOPE: ' scope-a scope-b ',
    },
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.appId, 'cli_x');
  assert.equal(cfg.appSecret, 'secret');
  assert.deepEqual(cfg.tenantKeys, ['tk1', 'tk2']);
  assert.deepEqual(cfg.openIds, ['ou_1', 'ou_2']);
  assert.deepEqual(feishuConfigProblems(cfg), []);

  assert.deepEqual(parseList('a,b; c\na'), ['a', 'b', 'c']);
  assert.deepEqual(feishuConfigProblems({ enabled: false }), ['FEISHU_SSO_ENABLED']);
  assert.deepEqual(feishuConfigProblems({
    enabled: true, appId: '', appSecret: '', redirectUri: '', tenantKeys: [], openIds: [],
  }), [
    'FEISHU_APP_ID',
    'FEISHU_APP_SECRET',
    'FEISHU_REDIRECT_URI',
    'FEISHU_ALLOWED_TENANT_KEYS / FEISHU_ALLOWED_OPEN_IDS',
  ]);
});

test('PKCE 与 JSAPI 签名使用标准算法', () => {
  const pair = createPkcePair();
  assert.match(pair.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(pair.challenge, b64url(createHash('sha256').update(pair.verifier).digest()));
  assert.equal(
    jsapiSignature({
      ticket: 'ticket-123',
      nonceStr: 'nonce-abc',
      timestamp: 1700000000,
      url: 'https://example.com/console',
    }),
    'b4d9af552975eab8a7eb85c74df393e3a162421a',
  );
});

test('state 一次性消费且超过 TTL 后失效（明确断言）', () => {
  let now = 1700000000000;
  const service = createFeishuService({ now: () => now });
  const created = service.createState();
  const consumed = service.consumeState(created.state);
  assert.ok(consumed);
  assert.equal(service.consumeState(created.state), null, '同一 state 不可重复使用');

  const expired = service.createState();
  now += service.stateTtlMs + 1;
  assert.equal(service.consumeState(expired.state), null, '过期 state 不可使用');
});

test('OAuth start 生成带 PKCE 的飞书授权地址，回调创建 Cookie 会话', async (t) => {
  const mock = createFetchMock();
  const ctx = await setup(t, { fetchImpl: mock.fetchImpl });

  const start = await invokeRoute(ctx, 'GET', '/api/auth/feishu/start');
  assert.equal(start.statusCode, 302);
  const authorize = new URL(start.location);
  assert.equal(authorize.origin, 'https://accounts.feishu.cn');
  assert.equal(authorize.searchParams.get('client_id'), 'cli_test_app');
  assert.equal(authorize.searchParams.get('redirect_uri'), 'https://checkin.example.com/api/auth/feishu/callback');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  const state = authorize.searchParams.get('state');
  assert.ok(state);
  const stateCookie = cookieValue(start, FEISHU_STATE_COOKIE);
  assert.equal(stateCookie, state, 'start 应将 state 绑定到 HttpOnly Cookie');

  const callback = await invokeRoute(ctx, 'GET', '/api/auth/feishu/callback', {
    query: { state, code: 'auth-code-1' },
    headers: { cookie: `${FEISHU_STATE_COOKIE}=${stateCookie}` },
  });
  assert.equal(callback.statusCode, 302);
  assert.equal(callback.location, '/');
  assert.ok(setCookies(callback).some((item) => /HttpOnly/.test(item)));
  assert.ok(setCookies(callback).some((item) => /SameSite=Lax/.test(item)));
  const sessionCookie = cookieValue(callback, SESSION_COOKIE);
  assert.equal(ctx.auth.validateToken(sessionCookie), true);
  assert.equal(callback.body, undefined, 'OAuth 回调不应把 token 暴露给前端脚本');
  assert.equal(mock.calls[0].url, FEISHU_TOKEN_URL);
  assert.equal(mock.calls[0].body.code, 'auth-code-1');
  assert.equal(mock.calls[0].body.redirect_uri, 'https://checkin.example.com/api/auth/feishu/callback');
  assert.ok(mock.calls[0].body.code_verifier);

  const replay = await invokeRoute(ctx, 'GET', '/api/auth/feishu/callback', {
    query: { state, code: 'auth-code-1' },
    headers: { cookie: `${FEISHU_STATE_COOKIE}=${stateCookie}` },
  });
  assert.equal(replay.location, '/?auth_error=state');
});

test('OAuth 回调区分拒绝授权、白名单拒绝与缺失 state', async (t) => {
  const mock = createFetchMock({ user: { open_id: 'ou_blocked', tenant_key: 'tenant-blocked' } });
  const ctx = await setup(t, { fetchImpl: mock.fetchImpl });

  const denied = await invokeRoute(ctx, 'GET', '/api/auth/feishu/callback', {
    query: { error: 'access_denied' },
  });
  assert.equal(denied.location, '/?auth_error=denied');

  const missing = await invokeRoute(ctx, 'GET', '/api/auth/feishu/callback', { query: {} });
  assert.equal(missing.location, '/?auth_error=state');

  const start = await invokeRoute(ctx, 'GET', '/api/auth/feishu/start');
  const state = new URL(start.location).searchParams.get('state');
  const stateCookie = cookieValue(start, FEISHU_STATE_COOKIE);
  const forbidden = await invokeRoute(ctx, 'GET', '/api/auth/feishu/callback', {
    query: { state, code: 'auth-code-2' },
    headers: { cookie: `${FEISHU_STATE_COOKIE}=${stateCookie}` },
  });
  assert.equal(forbidden.location, '/?auth_error=forbidden');
  assert.equal(cookieValue(forbidden, SESSION_COOKIE), '', '白名单拒绝不应签发会话');
  assert.ok(setCookies(forbidden).some((item) => /Max-Age=0/.test(item)), '失败回调应清除 state Cookie');
});

test('JSAPI 免登成功时签发 Cookie，并将 open_id/tenant_key 写入会话', async (t) => {
  const mock = createFetchMock();
  const ctx = await setup(t, { fetchImpl: mock.fetchImpl });
  const config = await getJsapiConfig(ctx);
  const res = await invokeRoute(ctx, 'POST', '/api/auth/feishu/jsapi', {
    headers: {
      'content-type': 'application/json',
      origin: 'https://checkin.example.com',
      cookie: `${FEISHU_JSAPI_COOKIE}=${config.nonceCookie}`,
    },
    body: { code: 'jsapi-code-1', nonce: config.nonce },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.token, undefined, 'JSAPI 成功也应为 Cookie-only');
  const token = cookieValue(res, SESSION_COOKIE);
  assert.equal(ctx.auth.validateToken(token), true);
  assert.equal(ctx.auth.resolveSession(token).identity.type, 'feishu');
  assert.equal(ctx.auth.resolveSession(token).identity.openId, 'ou_allowed');
  assert.equal(ctx.auth.resolveSession(token).identity.tenantKey, 'tenant-ok');
});

test('JSAPI 签名接口拒绝跨域 URL，并返回与 jsapi_ticket 匹配的签名', async (t) => {
  const mock = createFetchMock();
  const ctx = await setup(t, { fetchImpl: mock.fetchImpl });
  const res = await invokeRoute(ctx, 'GET', '/api/auth/feishu/jsapi-config', {
    query: {
      url: 'https://evil.example.net/steal?x=1',
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.url, 'https://checkin.example.com/');
  assert.equal(res.body.appId, 'cli_test_app');
  assert.deepEqual(res.body.jsApiList, ['requestAuthCode']);
  assert.equal(res.body.signature, jsapiSignature({
    ticket: 'ticket-123',
    nonceStr: res.body.nonceStr,
    timestamp: res.body.timestamp,
    url: res.body.url,
  }));
  assert.equal(mock.calls[0].url, FEISHU_TENANT_TOKEN_URL);
  assert.equal(mock.calls[1].url, FEISHU_JSAPI_TICKET_URL);
});

test('JSAPI 免登拒绝跨站 Origin 与表单编码请求，且不签发会话', async (t) => {
  const mock = createFetchMock();
  const ctx = await setup(t, { fetchImpl: mock.fetchImpl });
  const config = await getJsapiConfig(ctx);

  const crossSite = await invokeRoute(ctx, 'POST', '/api/auth/feishu/jsapi', {
    headers: {
      'content-type': 'application/json',
      origin: 'https://evil.example.net',
      cookie: `${FEISHU_JSAPI_COOKIE}=${config.nonceCookie}`,
    },
    body: { code: 'jsapi-code-evil', nonce: config.nonce },
  });
  assert.equal(crossSite.statusCode, 403);
  assert.equal(crossSite.body.error, 'csrf');
  assert.equal(cookieValue(crossSite, SESSION_COOKIE), '', '跨站请求不能签发会话');

  const formPost = await invokeRoute(ctx, 'POST', '/api/auth/feishu/jsapi', {
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://checkin.example.com',
      cookie: `${FEISHU_JSAPI_COOKIE}=${config.nonceCookie}`,
    },
    body: { code: 'jsapi-code-form', nonce: config.nonce },
  });
  assert.equal(formPost.statusCode, 415);
  assert.equal(formPost.body.error, 'unsupported_media_type');
  assert.equal(cookieValue(formPost, SESSION_COOKIE), '', '表单编码请求不能签发会话');
});

test('飞书关闭或配置不完整时，登录入口返回稳定错误码', async (t) => {
  const ctx = await setup(t, { overrides: { FEISHU_SSO_ENABLED: 'false' } });
  const res = await invokeRoute(ctx, 'GET', '/api/auth/feishu/start');
  assert.equal(res.statusCode, 302);
  assert.equal(res.location, '/?auth_error=disabled');
});
