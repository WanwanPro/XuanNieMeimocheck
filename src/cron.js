// 系统 cron 文件的统一生成与安装。
// Web 设置页和容器 entrypoint 共用这份逻辑，避免两处 cron 行漂移。
//
// 容器内 cron 使用 Debian 的 /etc/cron.d 格式，必须包含执行用户字段：
//   分 时 日 月 周 用户 命令
// cron 守护进程会自动感知 /etc/cron.d 文件 mtime 变化，因此无需执行 crontab 命令。
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { isValidCron } from './config.js';
import { APP_DIR, CHECKIN_SCRIPT, CRON_FILE, LOG_FILE } from './paths.js';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function buildCronContent(schedule, options = {}) {
  if (!isValidCron(schedule)) throw new Error('CRON_SCHEDULE 格式无效');
  const appDir = options.appDir || APP_DIR;
  const nodePath = options.nodePath || process.execPath;
  const script = options.script || CHECKIN_SCRIPT;
  const logFile = options.logFile || LOG_FILE;
  const user = options.user || 'root';
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(user)) throw new Error('cron 执行用户格式无效');

  return [
    'SHELL=/bin/bash',
    'PATH=/usr/local/bin:/usr/bin:/bin',
    `${schedule} ${user} cd ${shellQuote(appDir)} && ${shellQuote(nodePath)} ${shellQuote(script)} >> ${shellQuote(logFile)} 2>&1`,
    '',
  ].join('\n');
}

export function writeCronFile(schedule, options = {}) {
  const file = options.file || CRON_FILE;
  const dir = dirname(file);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });

  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, buildCronContent(schedule, options), { encoding: 'utf8', mode: 0o644 });
    chmodSync(tmp, 0o644);
    renameSync(tmp, file);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw error;
  }
  return file;
}

/** 兼容旧调用：/etc/cron.d 由 cron 自动重载，这里只确认文件已存在。 */
export function reloadCrontab(file = CRON_FILE) {
  if (!existsSync(file)) throw new Error(`cron 文件不存在：${file}`);
  return true;
}

export function installCron(schedule, options = {}) {
  const file = writeCronFile(schedule, options);
  reloadCrontab(file);
  return file;
}
