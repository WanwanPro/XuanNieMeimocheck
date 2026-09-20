import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { CONFIG_KEYS, MASK } from '../src/config.js';
import { writeEnvAtomic } from '../src/envfile.js';
import { recordRun } from '../src/state.js';
import { registerStatusRoutes } from '../src/web/routes/status.js';
import { registerCheckinRoutes } from '../src/web/routes/checkin.js';
import {
  createFakeApp, createReq, createRes, invoke, routeOf, waitFor,
} from '../test-support/harness.mjs';

const passAuth = (req, res, next) => next();

function baseValues(overrides = {}) {
  const values = {};
  for (const key of CONFIG_KEYS) values[key] = '';
  values.MEIMOAI_URL = 'https://meimoai13.com/';
  values.CRON_SCHEDULE = '0 1 * * *';
  values.RANDOM_DELAY = 'true';
  values.RANDOM_DELAY_MAX_MINUTES = '300';
  values.SKIP_PROBABILITY = '0.05';
  values.MAX_CONSECUTIVE_FAILURES = '3';
  return { ...values, ...overrides };
}

async function setup(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'meimoai-web-status-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const envFile = join(dir, '.env');
  const stateFile = join(dir, 'state.json');
  const logFile = join(dir, 'checkin.log');
  const screenshotFile = join(dir, 'error.png');
  const cronFile = join(dir, 'cron.d');
  const lockFile = join(dir, 'checkin.lock');
  writeEnvAtomic(envFile, baseValues(overrides), CONFIG_KEYS);
  return { dir, envFile, stateFile, logFile, screenshotFile, cronFile, lockFile };
}

test('GET /api/status 不返回明文账号，且带连续跳过计数', async (t) => {
  const ctx = await setup(t, { MEIMOAI_ACCOUNT: 'alice@example.com', MEIMOAI_PASSWORD: 'pw' });
  recordRun(ctx.stateFile, { status: 'skipped', trigger: 'cron' });
  recordRun(ctx.stateFile, { status: 'skipped', trigger: 'cron' });

  const { app, routes } = createFakeApp();
  registerStatusRoutes(app, {
    authMiddleware: passAuth,
    envFile: ctx.envFile,
    stateFile: ctx.stateFile,
    logFile: ctx.logFile,
    screenshotFile: ctx.screenshotFile,
    cronFile: ctx.cronFile,
  });

  const res = createRes();
  await invoke(routeOf(routes, 'GET', '/api/status'), createReq(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.account, MASK);
  assert.equal(JSON.stringify(res.body).includes('alice@example.com'), false);
  assert.equal(res.body.consecutiveSkips, 2);
  assert.equal(res.body.lastRunStatus, 'skipped');
});

test('GET /api/status 返回连续 clicked 计数，供前端判断不确定结果累积', async (t) => {
  const ctx = await setup(t, { MEIMOAI_ACCOUNT: 'alice@example.com', MEIMOAI_PASSWORD: 'pw' });
  recordRun(ctx.stateFile, { status: 'clicked', trigger: 'cron' });
  recordRun(ctx.stateFile, { status: 'clicked', trigger: 'cron' });

  const { app, routes } = createFakeApp();
  registerStatusRoutes(app, {
    authMiddleware: passAuth,
    envFile: ctx.envFile,
    stateFile: ctx.stateFile,
    logFile: ctx.logFile,
    screenshotFile: ctx.screenshotFile,
    cronFile: ctx.cronFile,
  });

  const res = createRes();
  await invoke(routeOf(routes, 'GET', '/api/status'), createReq(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.consecutiveClicked, 2);
  assert.equal(res.body.lastRunStatus, 'clicked');
});

test('POST /api/checkin 缺少账号密码时返回 400 且不启动子进程', async (t) => {
  const ctx = await setup(t, { MEIMOAI_ACCOUNT: '', MEIMOAI_PASSWORD: '' });
  const spawned = [];
  const { app, routes } = createFakeApp();
  registerCheckinRoutes(app, {
    authMiddleware: passAuth,
    envFile: ctx.envFile,
    lockFile: ctx.lockFile,
    logFile: ctx.logFile,
    appDir: ctx.dir,
    checkinScript: join(ctx.dir, 'fake-checkin.js'),
    spawnCheckin: (...args) => { spawned.push(args); throw new Error('should not spawn'); },
  });

  const res = createRes();
  await invoke(routeOf(routes, 'POST', '/api/checkin'), createReq({ method: 'POST' }), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /账号和密码/);
  assert.deepEqual(spawned, []);
});

test('POST /api/checkin 成功时返回 runId，并以 --run-id 透传给子进程', async (t) => {
  const ctx = await setup(t, { MEIMOAI_ACCOUNT: 'alice', MEIMOAI_PASSWORD: 'pw' });
  const spawned = [];
  const fakeSpawn = (cmd, args, opts) => {
    spawned.push({ cmd, args, opts });
    const child = new EventEmitter();
    setImmediate(() => { child.emit('spawn'); child.emit('exit', 0, null); });
    return child;
  };

  const { app, routes } = createFakeApp();
  registerCheckinRoutes(app, {
    authMiddleware: passAuth,
    envFile: ctx.envFile,
    lockFile: ctx.lockFile,
    logFile: ctx.logFile,
    appDir: ctx.dir,
    checkinScript: join(ctx.dir, 'fake-checkin.js'),
    spawnCheckin: fakeSpawn,
  });

  const res = createRes();
  await invoke(routeOf(routes, 'POST', '/api/checkin'), createReq({ method: 'POST' }), res);
  await waitFor(() => res.ended);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.match(res.body.runId, /^[0-9a-f-]{36}$/);
  assert.equal(spawned.length, 1);
  const args = spawned[0].args;
  assert.ok(args.includes('--manual'), '必须带 --manual');
  assert.equal(args[args.indexOf('--run-id') + 1], res.body.runId, 'runId 必须透传给子进程');
});

test('POST /api/checkin 启动进程失败时不泄露内部错误', async (t) => {
  const ctx = await setup(t, { MEIMOAI_ACCOUNT: 'alice', MEIMOAI_PASSWORD: 'pw' });
  const { app, routes } = createFakeApp();
  registerCheckinRoutes(app, {
    authMiddleware: passAuth,
    envFile: ctx.envFile,
    lockFile: ctx.lockFile,
    logFile: ctx.logFile,
    appDir: ctx.dir,
    checkinScript: join(ctx.dir, 'fake-checkin.js'),
    spawnCheckin: () => { throw new Error('EACCES: C:\\secret\\fake-checkin.js'); },
  });

  const res = createRes();
  await invoke(routeOf(routes, 'POST', '/api/checkin'), createReq({ method: 'POST' }), res);

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: '服务器内部错误' });
  assert.equal(JSON.stringify(res.body).includes('secret'), false);
});

test('POST /api/checkin 在已有锁占用时返回 409，不重复启动', async (t) => {
  const ctx = await setup(t, { MEIMOAI_ACCOUNT: 'alice', MEIMOAI_PASSWORD: 'pw' });
  const { acquireLock } = await import('../src/lock.js');
  const held = acquireLock(ctx.lockFile);
  assert.ok(held);

  let spawnedCount = 0;
  const { app, routes } = createFakeApp();
  registerCheckinRoutes(app, {
    authMiddleware: passAuth,
    envFile: ctx.envFile,
    lockFile: ctx.lockFile,
    logFile: ctx.logFile,
    appDir: ctx.dir,
    checkinScript: join(ctx.dir, 'fake-checkin.js'),
    spawnCheckin: () => { spawnedCount += 1; throw new Error('should not spawn'); },
  });

  const res = createRes();
  await invoke(routeOf(routes, 'POST', '/api/checkin'), createReq({ method: 'POST' }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(spawnedCount, 0);
  held.release();
});
