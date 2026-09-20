// 结构化运行状态（state.json）。
//
// 原来是靠 grep 日志关键词猜"上次签到结果"，既脆弱又不精确。
// 现在每次运行写一条结构化记录，Web 直接读它。
// 写入使用独立文件锁串行化 read-modify-write，避免签到进程与 Web 同时更新时丢数据。
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { acquireLock } from './lock.js';

const MAX_HISTORY = 60;
const STATE_LOCK_RETRIES = 50;
const STATE_LOCK_RETRY_MS = 10;

export const EMPTY_STATE = {
  lastRun: null,
  history: [],
  consecutiveFailures: 0,
  consecutiveSkips: 0,
  consecutiveClicked: 0,
  lastSuccessDate: '',
  lastCheckedDate: '',
  paused: false,
  pausedReason: '',
  updatedAt: '',
};

/** 北京时间 YYYY-MM-DD（北京时间 00:00-07:59 不能落到前一天） */
export function beijingDate(ts) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

export function readState(stateFile) {
  if (!stateFile || !existsSync(stateFile)) return { ...EMPTY_STATE };
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
    return { ...EMPTY_STATE, ...parsed };
  } catch {
    return { ...EMPTY_STATE };
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withStateLock(stateFile, fn) {
  const dir = dirname(stateFile);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const lockFile = `${stateFile}.lock`;

  for (let i = 0; i < STATE_LOCK_RETRIES; i += 1) {
    const lock = acquireLock(lockFile);
    if (lock) {
      try {
        return fn();
      } finally {
        lock.release();
      }
    }
    sleepSync(STATE_LOCK_RETRY_MS);
  }
  throw new Error(`状态文件锁获取超时：${lockFile}`);
}

function writeStateUnlocked(stateFile, state) {
  const dir = dirname(stateFile);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${stateFile}.tmp-${process.pid}`;
  const payload = { ...state, updatedAt: new Date().toISOString() };
  try {
    writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, stateFile);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
  return payload;
}

export function writeState(stateFile, state) {
  return withStateLock(stateFile, () => writeStateUnlocked(stateFile, state));
}

/**
 * 记录一次运行结果并更新熔断计数。
 * status: success | already | clicked | error | skipped
 */
export function recordRun(stateFile, run) {
  return withStateLock(stateFile, () => {
    const state = readState(stateFile);
    const entry = {
      ts: run.ts || new Date().toISOString(),
      status: run.status,
      runId: run.runId || '',
      balanceBefore: run.balanceBefore ?? '',
      balanceAfter: run.balanceAfter ?? '',
      gained: run.gained ?? '',
      durationMs: run.durationMs ?? 0,
      delayMs: run.delayMs ?? 0,
      trigger: run.trigger || 'cron',
      error: run.error || '',
    };

    state.lastRun = entry;
    state.history = [entry, ...(state.history || [])].slice(0, MAX_HISTORY);

    if (entry.status === 'error') {
      state.consecutiveFailures = (state.consecutiveFailures || 0) + 1;
      state.consecutiveSkips = 0;
      state.consecutiveClicked = 0;
    } else if (entry.status === 'skipped') {
      state.consecutiveSkips = (state.consecutiveSkips || 0) + 1;
      state.consecutiveClicked = 0;
    } else if (entry.status === 'clicked') {
      // clicked 是“不确定结果”：不重置失败/跳过计数，也不更新最后成功日期；
      // 但单独累计连续 clicked，避免站点长期返回不确定结果时永远不会熔断。
      state.consecutiveClicked = (state.consecutiveClicked || 0) + 1;
    } else {
      state.consecutiveFailures = 0;
      state.consecutiveSkips = 0;
      state.consecutiveClicked = 0;
    }

    if (entry.status === 'success' || entry.status === 'already') {
      state.lastSuccessDate = beijingDate(entry.ts);
    }
    if (entry.trigger !== 'manual') {
      state.lastCheckedDate = beijingDate(entry.ts);
    }
    return writeStateUnlocked(stateFile, state);
  });
}

export function setPaused(stateFile, paused, reason = '') {
  return withStateLock(stateFile, () => {
    const state = readState(stateFile);
    state.paused = Boolean(paused);
    state.pausedReason = paused ? reason : '';
    return writeStateUnlocked(stateFile, state);
  });
}

export function clearPaused(stateFile) {
  return withStateLock(stateFile, () => {
    const state = readState(stateFile);
    state.paused = false;
    state.pausedReason = '';
    state.consecutiveFailures = 0;
    state.consecutiveClicked = 0;
    return writeStateUnlocked(stateFile, state);
  });
}

/**
 * 今日是否已有可视为“已完成”的运行记录。
 * 只有确定完成/明确跳过的记录才阻止当天再次执行：
 * - success / already：当天已经签到完成；
 * - skipped：概率跳过等明确不执行，应当保持“今天不签”的语义。
 * error / clicked 属于失败或不确定结果，允许同一天后续 cron 再次尝试。
 * 判断必须扫描当天全部历史，而不是只看 lastRun：当天的 success/already/skipped
 * 之后若又发生一次手动 error/clicked，不能被最新状态覆盖而重新放行 cron。
 */
export function hasRunToday(state, todayStr) {
  const terminalStatuses = new Set(['success', 'already', 'skipped']);
  const entries = [state && state.lastRun, ...(Array.isArray(state && state.history) ? state.history : [])];
  return entries.some((entry) => {
    if (!entry || !entry.ts) return false;
    return beijingDate(entry.ts) === todayStr && terminalStatuses.has(entry.status);
  });
}
