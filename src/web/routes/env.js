// 配置读写：白名单 + 逐项校验 + JSON 无损序列化 + 原子写入。
import { CONFIG_KEYS, MASK, isSecretKey, validateValue } from '../../config.js';

// 这些配置直接决定谁能登录：一旦变化必须让已签发的会话立即失效。
const AUTH_KEYS = Object.freeze([
  'WEB_PASSWORD',
  'FEISHU_SSO_ENABLED',
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'FEISHU_REDIRECT_URI',
  'FEISHU_ALLOWED_TENANT_KEYS',
  'FEISHU_ALLOWED_OPEN_IDS',
]);
import { loadConfig, writeEnvAtomic } from '../../envfile.js';
import { appendToLogFile, beijingTime } from '../../logger.js';
import { clearPaused } from '../../state.js';
import { installCron } from '../../cron.js';

function publicConfig(config) {
  const out = {};
  for (const key of CONFIG_KEYS) {
    const value = config[key] ?? '';
    out[key] = isSecretKey(key) && value ? MASK : value;
  }
  return out;
}

export function registerEnvRoutes(app, {
  authMiddleware,
  envFile,
  stateFile,
  logFile,
  logger = console,
  syncCron = installCron,
  onPasswordChanged = () => {},
  onAuthConfigChanged = onPasswordChanged,
}) {
  app.get('/api/env', authMiddleware, (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(publicConfig(loadConfig({ envFile })));
    } catch (error) {
      logger.error('读取配置失败：', error);
      res.status(500).json({ error: '服务器内部错误' });
    }
  });

  app.post('/api/env', authMiddleware, (req, res) => {
    try {
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: '请求体格式无效' });
      }

      const unknownKeys = Object.keys(body).filter((key) => !CONFIG_KEYS.includes(key));
      if (unknownKeys.length) {
        return res.status(400).json({ error: `不允许的配置项：${unknownKeys.join(', ')}` });
      }

      const existing = loadConfig({ envFile });
      const next = { ...existing };
      const errors = [];

      for (const [key, value] of Object.entries(body)) {
        if (typeof value !== 'string') {
          errors.push(`${key} 必须是字符串`);
          continue;
        }
        if (value === MASK) continue;
        // 账号/密码允许暂时清空，但 CRON_SCHEDULE 为空会导致容器重启时 cron 初始化失败。
        const allowEmpty = key !== 'CRON_SCHEDULE';
        const error = validateValue(key, value, { allowEmpty });
        if (error) errors.push(error);
        else next[key] = value;
      }

      if (errors.length) return res.status(400).json({ error: errors.join('；') });

      const passwordChanged = next.WEB_PASSWORD !== existing.WEB_PASSWORD;
      const feishuAuthChanged = AUTH_KEYS.slice(1).some((key) => next[key] !== existing[key]);
      const cronChanged = next.CRON_SCHEDULE !== existing.CRON_SCHEDULE;
      const failureThresholdChanged = next.MAX_CONSECUTIVE_FAILURES !== existing.MAX_CONSECUTIVE_FAILURES;

      writeEnvAtomic(envFile, next, CONFIG_KEYS);
      if (passwordChanged) {
        onAuthConfigChanged();
        appendToLogFile(logFile, `[WARN] 管理密码已修改，所有登录会话已失效 (${beijingTime()})`);
      } else if (feishuAuthChanged) {
        onAuthConfigChanged();
        appendToLogFile(logFile, `[WARN] 飞书 SSO 配置已修改，所有登录会话已失效 (${beijingTime()})`);
      }

      let cronWarning = '';
      if (cronChanged) {
        try {
          syncCron(next.CRON_SCHEDULE);
        } catch (error) {
          cronWarning = `配置已保存，但 cron 重载失败：${error.message}`;
          logger.warn(cronWarning);
        }
      }

      if (failureThresholdChanged) {
        clearPaused(stateFile);
        appendToLogFile(logFile, `[INFO] 熔断阈值已修改，自动恢复定时签到 (${beijingTime()})`);
      }

      return res.json({ ok: true, passwordChanged, feishuAuthChanged, cronWarning });
    } catch (error) {
      logger.error('保存配置失败：', error);
      return res.status(500).json({ error: '服务器内部错误' });
    }
  });
}

