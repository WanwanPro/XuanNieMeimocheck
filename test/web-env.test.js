import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { CONFIG_KEYS, MASK } from '../src/config.js';
import { parseEnvFile, writeEnvAtomic } from '../src/envfile.js';
import { registerEnvRoutes } from '../src/web/routes/env.js';
import {
  createFakeApp, createReq, createRes, invoke, routeOf,
} from '../test-support/harness.mjs';

export function baseEnv(overrides = {}) {
  const out = {};
  for (const key of CONFIG_KEYS) out[key] = '';
  out.MEIMOAI_URL = 'https://meimoai13.com/';
  out.CRON_SCHEDULE = '0 1 * * *';
  out.RANDOM_DELAY = 'true';
  out.RANDOM_DELAY_MAX_MINUTES = '300';
  out.SKIP_PROBABILITY = '0.05';
  out.MAX_CONSECUTIVE_FAILURES = '3';
  return { ...out, ...overrides };
}

function setup(t, initial = {}) {
  return (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'meimoai-web-env-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const envFile = join(dir, '.env');
    const stateFile = join(dir, 'state.json');
    const logFile = join(dir, 'checkin.log');
    writeEnvAtomic(envFile, baseEnv(initial), CONFIG_KEYS);

    const calls = { syncCron: [], passwordChanged: 0, authChanged: 0 };
    const { app, routes } = createFakeApp();
    registerEnvRoutes(app, {
      authMiddleware: (req, res, next) => next(),
      envFile,
      stateFile,
      logFile,
      logger: { error() {}, warn() {} },
      syncCron: (schedule) => { calls.syncCron.push(schedule); },
      onPasswordChanged: () => { calls.passwordChanged += 1; },
      onAuthConfigChanged: () => { calls.authChanged += 1; },
    });
    return { dir, envFile, stateFile, logFile, calls, routes };
  })();
}

async function getEnv(ctx) {
  const res = createRes();
  await invoke(routeOf(ctx.routes, 'GET', '/api/env'), createReq(), res);
  return res;
}

async function postEnv(ctx, body) {
  const res = createRes();
  await invoke(routeOf(ctx.routes, 'POST', '/api/env'), createReq({ method: 'POST', body }), res);
  return res;
}

test('GET /api/env 对账号/密码/token 一律脱敏', async (t) => {
  const ctx = await setup(t, {
    MEIMOAI_ACCOUNT: 'alice@example.com',
    MEIMOAI_PASSWORD: 's3cret',
    WANWAN_PUSH_TOKEN: 'wanwan-token',
    WEBHOOK_URL: 'https://hooks.example.com/x',
  });

  const res = await getEnv(ctx);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.MEIMOAI_ACCOUNT, MASK);
  assert.equal(res.body.MEIMOAI_PASSWORD, MASK);
  assert.equal(res.body.WANWAN_PUSH_TOKEN, MASK);
  assert.equal(res.body.WEBHOOK_URL, MASK);
  assert.equal(res.body.CRON_SCHEDULE, '0 1 * * *', '非敏感项原样返回');
  assert.equal(JSON.stringify(res.body).includes('alice@example.com'), false);
});

// 回归：曾经 CRON_SCHEDULE 未标 required，空值可以保存 -> 重启后 entrypoint 崩溃循环。
test('POST /api/env 拒绝空 CRON_SCHEDULE：400 且不落盘、不重载 cron', async (t) => {
  const ctx = await setup(t);
  const res = await postEnv(ctx, { CRON_SCHEDULE: '' });

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /CRON_SCHEDULE/);
  assert.equal(parseEnvFile(ctx.envFile).CRON_SCHEDULE, '0 1 * * *', '文件必须保持原值');
  assert.deepEqual(ctx.calls.syncCron, [], '校验失败不得触碰 cron');
});

test('POST /api/env 拒绝非法 CRON_SCHEDULE', async (t) => {
  const ctx = await setup(t);
  const res = await postEnv(ctx, { CRON_SCHEDULE: 'not a cron' });
  assert.equal(res.statusCode, 400);
  assert.equal(parseEnvFile(ctx.envFile).CRON_SCHEDULE, '0 1 * * *');
});

test('POST /api/env 遇到 MASK 时保持原值不变', async (t) => {
  const ctx = await setup(t, { MEIMOAI_PASSWORD: 'keep-me', WANWAN_PUSH_TOKEN: 'tok' });

  const res = await postEnv(ctx, {
    MEIMOAI_PASSWORD: MASK,
    WANWAN_PUSH_TOKEN: MASK,
    MEIMOAI_ACCOUNT: 'bob',
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  const saved = parseEnvFile(ctx.envFile);
  assert.equal(saved.MEIMOAI_PASSWORD, 'keep-me');
  assert.equal(saved.WANWAN_PUSH_TOKEN, 'tok');
  assert.equal(saved.MEIMOAI_ACCOUNT, 'bob');
});

test('POST /api/env 拒绝未知配置项，避免写入任意键', async (t) => {
  const ctx = await setup(t);
  const res = await postEnv(ctx, { EVIL_KEY: 'x' });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /EVIL_KEY/);
});

test('POST /api/env 合法修改 cron 会落盘并重载', async (t) => {
  const ctx = await setup(t);
  const res = await postEnv(ctx, { CRON_SCHEDULE: '30 2 * * *' });

  assert.equal(res.statusCode, 200);
  assert.equal(parseEnvFile(ctx.envFile).CRON_SCHEDULE, '30 2 * * *');
  assert.deepEqual(ctx.calls.syncCron, ['30 2 * * *']);
});

test('POST /api/env 修改 WEB_PASSWORD 会触发会话失效回调', async (t) => {
  const ctx = await setup(t, { WEB_PASSWORD: '' });
  const res = await postEnv(ctx, { WEB_PASSWORD: 'new-pass' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.passwordChanged, true);
  assert.equal(ctx.calls.authChanged, 1, '密码变化同样归入会话失效回调');
  assert.equal(parseEnvFile(ctx.envFile).WEB_PASSWORD, 'new-pass');
});



test('POST /api/env 保存飞书配置会落盘并触发会话失效回调', async (t) => {
  const ctx = await setup(t, { FEISHU_SSO_ENABLED: 'false' });
  const res = await postEnv(ctx, {
    FEISHU_SSO_ENABLED: 'true',
    FEISHU_APP_ID: 'cli_test',
    FEISHU_APP_SECRET: 'top-secret',
    FEISHU_REDIRECT_URI: 'https://checkin.example.com/api/auth/feishu/callback',
    FEISHU_ALLOWED_TENANT_KEYS: 'tenant-ok',
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.feishuAuthChanged, true);
  assert.equal(ctx.calls.authChanged, 1, '飞书配置变化应让旧会话全部失效');
  assert.equal(ctx.calls.passwordChanged, 0, '未改密码时不应误报 passwordChanged');

  const saved = parseEnvFile(ctx.envFile);
  assert.equal(saved.FEISHU_SSO_ENABLED, 'true');
  assert.equal(saved.FEISHU_APP_ID, 'cli_test');
  assert.equal(saved.FEISHU_ALLOWED_TENANT_KEYS, 'tenant-ok');
});

test('POST /api/env 未改动飞书配置时不会误触发会话失效', async (t) => {
  const ctx = await setup(t, {
    FEISHU_SSO_ENABLED: 'true',
    FEISHU_APP_ID: 'cli_test',
    FEISHU_APP_SECRET: 'secret',
    FEISHU_REDIRECT_URI: 'https://checkin.example.com/api/auth/feishu/callback',
    FEISHU_ALLOWED_TENANT_KEYS: 'tenant-ok',
  });
  const res = await postEnv(ctx, { RANDOM_DELAY_MAX_MINUTES: '120' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.feishuAuthChanged, false);
  assert.equal(ctx.calls.authChanged, 0, '无关改动不应让会话失效');
});

test('GET /api/env 对飞书 app_secret 脱敏，app_id 明文可见', async (t) => {
  const ctx = await setup(t, {
    FEISHU_SSO_ENABLED: 'true',
    FEISHU_APP_ID: 'cli_visible',
    FEISHU_APP_SECRET: 'should-be-hidden',
  });
  const res = await getEnv(ctx);
  assert.equal(res.body.FEISHU_APP_ID, 'cli_visible');
  assert.equal(res.body.FEISHU_APP_SECRET, MASK);
  assert.equal(JSON.stringify(res.body).includes('should-be-hidden'), false);
});


