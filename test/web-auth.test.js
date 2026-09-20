import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes, scryptSync } from 'crypto';
import { CONFIG_KEYS } from '../src/config.js';
import { writeEnvAtomic } from '../src/envfile.js';
import { createAuthService, parseCookies, verifyPassword } from '../src/web/auth.js';
import { SESSION_COOKIE } from '../src/web/feishu.js';
import {
  createFakeApp, createReq, createRes, invoke, routeOf,
} from '../test-support/harness.mjs';

function scryptHash(password) {
  const salt = randomBytes(16);
  const derived = scryptSync(Buffer.from(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function setup(t, { webPassword = '', extra = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'meimoai-web-auth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const envFile = join(dir, '.env');
  const logFile = join(dir, 'checkin.log');
  const values = {};
  for (const key of CONFIG_KEYS) values[key] = '';
  values.MEIMOAI_URL = 'https://meimoai13.com/';
  values.CRON_SCHEDULE = '0 1 * * *';
  values.WEB_PASSWORD = webPassword;
  Object.assign(values, extra);
  writeEnvAtomic(envFile, values, CONFIG_KEYS);

  const auth = createAuthService({ envFile, logFile });
  const { app, routes } = createFakeApp();
  auth.registerRoutes(app);
  return { dir, envFile, logFile, auth, routes };
}

async function login(ctx, password) {
  const res = createRes();
  await invoke(routeOf(ctx.routes, 'POST', '/api/login'), createReq({
    method: 'POST', body: { password },
  }), res);
  return res;
}

function sessionToken(res) {
  return parseCookies(res.headers['set-cookie'] || '')[SESSION_COOKIE] || '';
}

async function authMiddlewareCall(ctx, token, extraHeaders = {}) {
  const res = createRes();
  let passed = false;
  const headers = { ...(token ? { 'x-auth-token': token } : {}), ...extraHeaders };
  await ctx.auth.authMiddleware(createReq({ headers }), res, () => { passed = true; });
  return { res, passed };
}

async function authStatus(ctx, headers = {}) {
  const res = createRes();
  await invoke(routeOf(ctx.routes, 'GET', '/api/auth-status'), createReq({ headers }), res);
  return res;
}

test('verifyPassword 支持明文与 scrypt 前缀', () => {
  assert.equal(verifyPassword('abc', 'abc'), true);
  assert.equal(verifyPassword('abc', 'abcd'), false);
  const hash = scryptHash('abc');
  assert.equal(verifyPassword('abc', hash), true);
  assert.equal(verifyPassword('nope', hash), false);
  assert.equal(verifyPassword('abc', ''), false);
});

test('未设置 WEB_PASSWORD 时认证关闭，中间件直接放行', async (t) => {
  const ctx = await setup(t, { webPassword: '' });
  assert.equal(ctx.auth.isAuthEnabled(), false);

  const { passed } = await authMiddlewareCall(ctx);
  assert.equal(passed, true, '无密码时应直接 next()');

  const res = await login(ctx, '');
  assert.equal(res.body.ok, true);
  assert.equal(res.body.authRequired, false);
});

test('设置 WEB_PASSWORD 后无 token 被拒绝，登录后可访问', async (t) => {
  const ctx = await setup(t, { webPassword: scryptHash('correct-horse') });
  assert.equal(ctx.auth.isAuthEnabled(), true);

  const denied = await authMiddlewareCall(ctx);
  assert.equal(denied.passed, false);
  assert.equal(denied.res.statusCode, 401);

  const res = await login(ctx, 'correct-horse');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.authRequired, true);
  assert.equal(res.body.token, undefined, '浏览器端不应再收到 JS 可读 token');
  const token = sessionToken(res);
  assert.ok(token, 'Set-Cookie 应带会话 token');

  const allowed = await authMiddlewareCall(ctx, '', { cookie: `${SESSION_COOKIE}=${token}` });
  assert.equal(allowed.passed, true);
});

test('密码错误返回 401，连续失败会触发 15 分钟锁定', async (t) => {
  const ctx = await setup(t, { webPassword: scryptHash('right') });

  const first = await login(ctx, 'wrong');
  assert.equal(first.statusCode, 401);
  assert.equal(first.body.error, '密码错误');

  // 第 10 次失败写入锁定，之后即使密码正确也应先被限流拦截。
  let last;
  for (let i = 0; i < 10; i += 1) last = await login(ctx, 'wrong');
  assert.equal(last.statusCode, 429);

  const locked = await login(ctx, 'right');
  assert.equal(locked.statusCode, 429);
});

test('logout 与 revokeAll 都会立即失效已签发的 Cookie 会话', async (t) => {
  const ctx = await setup(t, { webPassword: scryptHash('pw') });

  const first = await login(ctx, 'pw');
  const firstToken = sessionToken(first);
  assert.equal((await authMiddlewareCall(ctx, '', { cookie: `${SESSION_COOKIE}=${firstToken}` })).passed, true);

  const logoutRes = createRes();
  await invoke(routeOf(ctx.routes, 'POST', '/api/logout'), createReq({
    method: 'POST', headers: { cookie: `${SESSION_COOKIE}=${firstToken}` },
  }), logoutRes);
  assert.match(logoutRes.headers['set-cookie'], /Max-Age=0/);
  assert.equal((await authMiddlewareCall(ctx, '', { cookie: `${SESSION_COOKIE}=${firstToken}` })).passed, false, 'logout 后 Cookie 会话失效');

  const second = await login(ctx, 'pw');
  const secondToken = sessionToken(second);
  ctx.auth.revokeAll();
  assert.equal((await authMiddlewareCall(ctx, '', { cookie: `${SESSION_COOKIE}=${secondToken}` })).passed, false, 'revokeAll 后 Cookie 会话失效');
});

test('auth-status 反映当前是否需要认证', async (t) => {
  const ctx = await setup(t, { webPassword: scryptHash('pw') });
  const res = createRes();
  await invoke(routeOf(ctx.routes, 'GET', '/api/auth-status'), createReq(), res);
  assert.equal(res.body.authRequired, true);
});


test('登录签发 HttpOnly Cookie，可用 Cookie 访问受保护资源', async (t) => {
  const ctx = await setup(t, { webPassword: scryptHash('pw') });
  const res = await login(ctx, 'pw');
  const setCookie = res.headers['set-cookie'];
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Path=\//);
  const token = parseCookies(setCookie)[SESSION_COOKIE];
  assert.ok(token, 'Set-Cookie 应带会话 token');

  const cookieHeader = `${SESSION_COOKIE}=${token}`;
  assert.equal((await authMiddlewareCall(ctx, '', { cookie: cookieHeader })).passed, true, 'Cookie 应可通过中间件');
  assert.equal((await authMiddlewareCall(ctx, '', { cookie: `${SESSION_COOKIE}=deadbeef` })).passed, false, '伪造 Cookie 不应通过');
});

test('auth-status 返回 authenticated，并区分已登录/未登录', async (t) => {
  const ctx = await setup(t, { webPassword: scryptHash('pw') });

  const anonymous = await authStatus(ctx);
  assert.equal(anonymous.body.authRequired, true);
  assert.equal(anonymous.body.authenticated, false);
  assert.equal(anonymous.body.passwordEnabled, true);
  assert.equal(anonymous.body.feishuEnabled, false);

  const loginRes = await login(ctx, 'pw');
  assert.equal(loginRes.body.token, undefined);
  const token = sessionToken(loginRes);
  const authedByCookie = await authStatus(ctx, { cookie: `${SESSION_COOKIE}=${token}` });
  assert.equal(authedByCookie.body.authenticated, true, 'Cookie 会话应被识别');

  const authedByHeader = await authStatus(ctx, { 'x-auth-token': token });
  assert.equal(authedByHeader.body.authenticated, true, 'X-Auth-Token 兼容路径也应被识别');
});

test('auth-status 暴露飞书启用与 appId，缺配置时不启用', async (t) => {
  const ctx = await setup(t, {
    webPassword: '',
    extra: {
      FEISHU_SSO_ENABLED: 'true',
      FEISHU_APP_ID: 'cli_demo',
      FEISHU_APP_SECRET: 'secret',
      FEISHU_REDIRECT_URI: 'https://checkin.example.com/api/auth/feishu/callback',
      FEISHU_ALLOWED_TENANT_KEYS: 'tenant-ok',
    },
  });
  const res = await authStatus(ctx);
  assert.equal(res.body.feishuEnabled, true);
  assert.equal(res.body.feishuAppId, 'cli_demo');
  assert.equal(res.body.authRequired, true, '仅飞书可用时认证仍开启');
  assert.equal(res.body.passwordEnabled, false);
  assert.deepEqual(res.body.feishuConfigProblems, []);

  const broken = await setup(t, {
    extra: { FEISHU_SSO_ENABLED: 'true' },
  });
  const brokenStatus = await authStatus(broken);
  assert.equal(brokenStatus.body.feishuEnabled, false);
  assert.equal(brokenStatus.body.feishuAppId, '');
  assert.equal(brokenStatus.body.authRequired, true, '飞书开启但缺配置时必须 fail-closed');
  assert.ok(brokenStatus.body.feishuConfigProblems.includes('FEISHU_APP_ID'));

  assert.equal(broken.auth.isAuthEnabled(), true);
  const denied = await authMiddlewareCall(broken);
  assert.equal(denied.passed, false, '缺配置不能退化成无认证放行');
  assert.equal(denied.res.statusCode, 401);
  const anonymousLogin = await login(broken, '');
  assert.equal(anonymousLogin.statusCode, 401, '无密码且飞书不可用时必须 fail-closed');
  assert.notEqual(anonymousLogin.body.authenticated, true, '不能把匿名请求标记成已认证');
});
