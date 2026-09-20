// POST /api/checkin：以子进程启动一次手动签到。
// Web 进程只负责启动和记录生命周期，真正的互斥由签到脚本的文件锁保证，
// 因此 cron 与手动签到不会同时打开同一个 Firefox profile。
import { randomUUID } from 'crypto';
import { closeSync, openSync } from 'fs';
import { spawn } from 'child_process';
import { loadConfig } from '../../envfile.js';
import {
  APP_DIR, CHECKIN_SCRIPT, ENV_FILE, LOCK_FILE, LOG_FILE,
} from '../../paths.js';
import { appendToLogFile, beijingTime } from '../../logger.js';
import { isLocked } from '../../lock.js';

export function registerCheckinRoutes(app, {
  authMiddleware,
  envFile = ENV_FILE,
  lockFile = LOCK_FILE,
  logFile = LOG_FILE,
  appDir = APP_DIR,
  checkinScript = CHECKIN_SCRIPT,
  spawnCheckin = spawn,
} = {}) {
  let launching = false;

  app.post('/api/checkin', authMiddleware, (req, res) => {
    if (launching || isLocked(lockFile)) {
      return res.status(409).json({ error: '签到任务正在运行中，请勿重复触发' });
    }

    let current;
    try {
      current = loadConfig({ envFile });
    } catch (error) {
      appendToLogFile(logFile, `[ERROR] 读取配置失败：${error.message}`);
      return res.status(500).json({ error: '服务器内部错误' });
    }
    if (!current.MEIMOAI_ACCOUNT || !current.MEIMOAI_PASSWORD) {
      return res.status(400).json({ error: '请先配置账号和密码' });
    }

    const runId = randomUUID();
    let child;
    let fd;
    try {
      launching = true;
      fd = openSync(logFile, 'a', 0o600);
      appendToLogFile(logFile, `[INFO] 手动签到任务已启动 (runId=${runId}, ${beijingTime()})`);
      child = spawnCheckin(process.execPath, [checkinScript, '--manual', '--run-id', runId], {
        cwd: appDir,
        env: { ...process.env },
        stdio: ['ignore', fd, fd],
      });
    } catch (error) {
      launching = false;
      if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
      return res.status(500).json({ error: '服务器内部错误' });
    }

    try { closeSync(fd); } catch { /* child 已继承 fd */ }

    let responded = false;
    child.once('spawn', () => {
      responded = true;
      res.json({ ok: true, runId, message: '签到任务已启动，请稍后查看日志' });
    });

    child.once('error', (error) => {
      launching = false;
      appendToLogFile(logFile, `[ERROR] 手动签到进程启动失败（runId=${runId}）：${error.message}`);
      if (!responded && !res.headersSent) res.status(500).json({ error: '服务器内部错误' });
    });

    child.once('exit', (code, signal) => {
      launching = false;
      const detail = signal ? `signal ${signal}` : `exit code ${code}`;
      appendToLogFile(logFile, `[INFO] 手动签到进程已结束 (runId=${runId}, ${detail})`);
    });
  });
}
