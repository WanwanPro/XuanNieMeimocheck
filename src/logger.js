// 统一日志：带级别标签的行式输出 + 简易体积轮转。
//
// 级别标签（[INFO]/[WARN]/[ERROR]/[STEP]）位于时间戳之后，
// Web 前端据此上色，避免历史上用 "包含某个中文词" 判断级别的误判问题。
import { appendFileSync, copyFileSync, existsSync, statSync, truncateSync } from 'fs';

export const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** 北京时间（ISO 风格，秒级可读） */
export function beijingTime(date) {
  const d = date || new Date();
  return d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(' ', 'T');
}

/** ISO 时间戳（UTC），机器可解析 */
export function timestamp() {
  return new Date().toISOString();
}

/**
 * 超过 maxBytes 时把日志滚动为 .1（旧的 .1 被覆盖）。
 * 使用 copy + truncate 而不是 rename：cron/Web 可能已持有日志 fd，
 * rename 后 fd 仍指向旧 inode，会把当前运行继续写进 .1。
 */
export function rotateIfNeeded(logFile, maxBytes = DEFAULT_LOG_MAX_BYTES) {
  try {
    if (!existsSync(logFile)) return false;
    if (statSync(logFile).size < maxBytes) return false;
    copyFileSync(logFile, `${logFile}.1`);
    truncateSync(logFile, 0);
    return true;
  } catch {
    return false;
  }
}

function emit(level, args) {
  const line = `${timestamp()} [${level}] ${args.map(formatArg).join(' ')}`;
  if (level === 'ERROR') console.error(line);
  else console.log(line);
  return line;
}

function formatArg(arg) {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack || arg.message;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

export function createLogger() {
  return {
    info: (...args) => emit('INFO', args),
    warn: (...args) => emit('WARN', args),
    error: (...args) => emit('ERROR', args),
    step: (...args) => emit('STEP', args),
    raw: (message) => `${timestamp()} ${message}`,
  };
}

/** 追加一行到日志文件（Web 服务自身的事件使用） */
export function appendToLogFile(logFile, message) {
  try {
    appendFileSync(logFile, `${timestamp()} ${message}\n`, 'utf8');
  } catch {
    /* 日志失败不应影响主流程 */
  }
}

/** 从一行日志中提取级别，供前端上色 */
export function levelOf(line) {
  const m = /\[(INFO|WARN|ERROR|STEP)\]/.exec(line || '');
  return m ? m[1] : '';
}
