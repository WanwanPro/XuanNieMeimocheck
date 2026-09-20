// GET /api/status：结构化状态优先，日志只作为展示与兜底。
import { existsSync, readFileSync, statSync } from 'fs';
import { MASK } from '../../config.js';
import { loadConfig } from '../../envfile.js';
import { appendToLogFile, beijingTime } from '../../logger.js';
import { clearPaused, readState } from '../../state.js';

function truncate(value, max = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export function formatLastResult(lastRun) {
  if (!lastRun || !lastRun.ts) return '暂无记录';
  const time = beijingTime(new Date(lastRun.ts));
  if (lastRun.status === 'success') {
    return `签到成功 | 余额 ${lastRun.balanceAfter || '未识别'}${lastRun.gained ? `（${lastRun.gained}）` : ''} | ${time}`;
  }
  if (lastRun.status === 'already') return `今日已签到 | 余额 ${lastRun.balanceAfter || '未识别'} | ${time}`;
  if (lastRun.status === 'clicked') return `已点击签到，请人工确认页面状态 | ${time}`;
  if (lastRun.status === 'skipped') return `本次已跳过 | ${time}`;
  if (lastRun.status === 'error') return `签到失败：${truncate(lastRun.error) || '未知错误'} | ${time}`;
  return `${lastRun.status || '未知状态'} | ${time}`;
}

export function registerStatusRoutes(app, { authMiddleware, envFile, stateFile, logFile, screenshotFile, cronFile }) {
  app.post('/api/state/resume', authMiddleware, (req, res) => {
    try {
      clearPaused(stateFile);
      appendToLogFile(logFile, `[INFO] 用户已手动恢复定时签到 (${beijingTime()})`);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: '服务器内部错误' });
    }
  });

  app.get('/api/status', authMiddleware, (req, res) => {
    try {
      const config = loadConfig({ envFile });
      const state = readState(stateFile);
      const content = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
      const lines = content.trim() ? content.trim().split(/\r?\n/).filter(Boolean) : [];

      let screenshotTime = '';
      if (existsSync(screenshotFile)) {
        try { screenshotTime = beijingTime(statSync(screenshotFile).mtime); } catch { /* ignore */ }
      }

      res.json({
        lastResult: formatLastResult(state.lastRun),
        lastRun: state.lastRun,
        lastRunStatus: state.lastRun ? state.lastRun.status : '',
        paused: Boolean(state.paused),
        pausedReason: state.pausedReason || '',
        consecutiveFailures: Number(state.consecutiveFailures) || 0,
        consecutiveSkips: Number(state.consecutiveSkips) || 0,
        consecutiveClicked: Number(state.consecutiveClicked) || 0,
        lastSuccessDate: state.lastSuccessDate || '',
        lastCheckedDate: state.lastCheckedDate || '',
        history: Array.isArray(state.history) ? state.history.slice(0, 10) : [],
        cronStatus: existsSync(cronFile) ? '已启用' : '未启用',
        cronSchedule: config.CRON_SCHEDULE,
        account: config.MEIMOAI_ACCOUNT ? MASK : '',
        url: config.MEIMOAI_URL,
        randomDelay: config.RANDOM_DELAY,
        randomDelayMax: config.RANDOM_DELAY_MAX_MINUTES,
        skipProbability: config.SKIP_PROBABILITY,
        maxConsecutiveFailures: config.MAX_CONSECUTIVE_FAILURES,
        hasErrorScreenshot: Boolean(screenshotTime),
        screenshotTime,
        recentLogs: lines.slice(-20),
      });
    } catch (error) {
      res.status(500).json({ error: '服务器内部错误' });
    }
  });
}
