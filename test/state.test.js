import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  clearPaused,
  hasRunToday,
  readState,
  recordRun,
  setPaused,
} from '../src/state.js';

test('recordRun 维护连续失败与连续跳过计数', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'meimoai-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');

  let state = recordRun(file, { status: 'error', trigger: 'cron', error: 'boom' });
  assert.equal(state.consecutiveFailures, 1);
  assert.equal(state.consecutiveSkips, 0);
  assert.equal(state.consecutiveClicked, 0);

  state = recordRun(file, { status: 'skipped', trigger: 'cron' });
  assert.equal(state.consecutiveFailures, 1);
  assert.equal(state.consecutiveSkips, 1);
  assert.equal(state.consecutiveClicked, 0);

  const successTs = '2026-09-10T17:00:00.000Z'; // 北京时间 2026-09-11 01:00
  state = recordRun(file, {
    status: 'success', trigger: 'cron', balanceAfter: '10', ts: successTs, delayMs: 1234,
  });
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.consecutiveSkips, 0);
  assert.equal(state.consecutiveClicked, 0);
  assert.equal(state.lastSuccessDate, '2026-09-11');
  assert.equal(state.lastCheckedDate, '2026-09-11');
  assert.equal(state.lastRun.delayMs, 1234);
});

// clicked 代表"点了按钮但页面没给出确定结论"，必须当作不确定结果：
// 不清失败/跳过计数，不算成功，也不解除熔断暂停；同时单独累计 clicked。
test('recordRun 不把 clicked 当作成功，计数保持不清零', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'meimoai-clicked-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');

  recordRun(file, { status: 'error', trigger: 'cron', error: 'boom' });
  recordRun(file, { status: 'skipped', trigger: 'cron' });
  let state = readState(file);
  assert.equal(state.consecutiveFailures, 1);
  assert.equal(state.consecutiveSkips, 1);

  state = recordRun(file, { status: 'clicked', trigger: 'cron', ts: '2026-09-10T17:00:00.000Z' });
  assert.equal(state.consecutiveFailures, 1, 'clicked 不清零连续失败');
  assert.equal(state.consecutiveSkips, 1, 'clicked 不清零连续跳过');
  assert.equal(state.consecutiveClicked, 1, 'clicked 单独累计');
  assert.equal(state.lastSuccessDate, '', 'clicked 不更新最后成功日期');
  assert.equal(state.lastRun.status, 'clicked');

  state = recordRun(file, { status: 'clicked', trigger: 'cron' });
  assert.equal(state.consecutiveClicked, 2, '连续 clicked 应继续累计');

  state = recordRun(file, { status: 'success', trigger: 'cron' });
  assert.equal(state.consecutiveClicked, 0, '确定结果应清零连续 clicked');
});

test('cron 运行会更新 lastCheckedDate，manual 运行不会', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'meimoai-checked-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');
  const ts = '2026-09-10T17:00:00.000Z'; // 北京时间 2026-09-11

  let state = recordRun(file, { status: 'clicked', trigger: 'manual', ts });
  assert.equal(state.lastCheckedDate, '', 'manual 不算"当天已检查过"');

  state = recordRun(file, { status: 'skipped', trigger: 'cron', ts });
  assert.equal(state.lastCheckedDate, '2026-09-11', 'cron skipped 也必须标记当天已检查');
  assert.equal(state.lastSuccessDate, '', 'skipped 不算成功');
});
test('manual 失败/clicked 不会阻止当天 cron 重试', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'meimoai-manual-retry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');
  const ts = '2026-09-10T17:00:00.000Z';

  let state = recordRun(file, { status: 'error', trigger: 'manual', ts, error: 'boom' });
  assert.equal(hasRunToday(state, '2026-09-11'), false);

  state = recordRun(file, { status: 'clicked', trigger: 'manual', ts });
  assert.equal(hasRunToday(state, '2026-09-11'), false);

  state = recordRun(file, { status: 'success', trigger: 'manual', ts });
  assert.equal(hasRunToday(state, '2026-09-11'), true);
});


test('setPaused/clearPaused 可以恢复熔断状态', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'meimoai-pause-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');

  recordRun(file, { status: 'error', trigger: 'cron', error: 'boom' });
  recordRun(file, { status: 'error', trigger: 'cron', error: 'boom' });
  setPaused(file, true, '连续失败');
  let state = readState(file);
  assert.equal(state.paused, true);
  assert.equal(state.pausedReason, '连续失败');
  assert.equal(state.consecutiveFailures, 2);

  clearPaused(file);
  state = readState(file);
  assert.equal(state.paused, false);
  assert.equal(state.pausedReason, '');
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.consecutiveClicked, 0);
});

test('hasRunToday 按北京时间判断，失败/clicked 可重试但当天终态不会被覆盖', () => {
  const today = '2026-09-11';
  const ts = '2026-09-10T17:00:00.000Z';
  assert.equal(hasRunToday({ lastRun: { ts } }, today), false, '缺少状态不能视为完成');
  assert.equal(hasRunToday({ lastRun: { ts: '2026-09-10T15:59:59.000Z' } }, today), false);
  assert.equal(hasRunToday({ lastRun: null }, today), false);

  assert.equal(hasRunToday({ lastRun: { ts, trigger: 'manual', status: 'success' } }, today), true);
  assert.equal(hasRunToday({ lastRun: { ts, trigger: 'manual', status: 'already' } }, today), true);
  assert.equal(hasRunToday({ lastRun: { ts, trigger: 'manual', status: 'error' } }, today), false);
  assert.equal(hasRunToday({ lastRun: { ts, trigger: 'manual', status: 'clicked' } }, today), false);
  assert.equal(hasRunToday({ lastRun: { ts, trigger: 'cron', status: 'error' } }, today), false, 'cron 失败应允许当天重试');
  assert.equal(hasRunToday({ lastRun: { ts, trigger: 'cron', status: 'clicked' } }, today), false, 'cron clicked 应允许当天人工干预后重试');
  assert.equal(hasRunToday({ lastRun: { ts, trigger: 'cron', status: 'skipped' } }, today), true, '概率/熔断跳过应保持当天不再触发');
  assert.equal(hasRunToday({ lastRun: { ts, trigger: 'cron', status: 'success' } }, today), true);

  assert.equal(hasRunToday({
    lastRun: { ts, trigger: 'manual', status: 'error' },
    history: [{ ts, trigger: 'cron', status: 'success' }],
  }, today), true, '当天已有 success 后，后续手动 error 不能重新放行 cron');
  assert.equal(hasRunToday({
    lastRun: { ts, trigger: 'manual', status: 'clicked' },
    history: [{ ts, trigger: 'cron', status: 'skipped' }],
  }, today), true, '当天已有 skipped 后，后续手动 clicked 不能重新放行 cron');
  assert.equal(hasRunToday({
    lastRun: { ts, trigger: 'cron', status: 'success' },
    history: [{ ts: '2026-09-09T17:00:00.000Z', trigger: 'cron', status: 'success' }],
  }, today), true);
});
