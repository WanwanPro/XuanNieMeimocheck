// Express 应用工厂与启动入口。
import express from 'express';
import { existsSync } from 'fs';
import { join } from 'path';
import { isDangerousTrustProxy, parseTrustProxy } from '../config.js';
import { loadConfig } from '../envfile.js';
import { createLogger } from '../logger.js';
import {
  APP_DIR, CHECKIN_SCRIPT, CRON_FILE, ENV_FILE, LOCK_FILE, LOG_FILE, PUBLIC_DIR,
  SCREENSHOT_FILE, STATE_FILE, WEB_HOST, WEB_PORT,
} from '../paths.js';
import { createAuthService } from './auth.js';
import { createFeishuService, feishuConfigProblems } from './feishu.js';
import { registerCheckinRoutes } from './routes/checkin.js';
import { registerFeishuRoutes } from './routes/feishu.js';
import { registerEnvRoutes } from './routes/env.js';
import { registerLogRoutes } from './routes/logs.js';
import { registerScreenshotRoutes } from './routes/screenshot.js';
import { registerStatusRoutes } from './routes/status.js';

export function createWebApp(options = {}) {
  const logger = options.logger || createLogger();
  const paths = {
    appDir: options.appDir || APP_DIR,
    envFile: options.envFile || ENV_FILE,
    logFile: options.logFile || LOG_FILE,
    stateFile: options.stateFile || STATE_FILE,
    screenshotFile: options.screenshotFile || SCREENSHOT_FILE,
    cronFile: options.cronFile || CRON_FILE,
    lockFile: options.lockFile || LOCK_FILE,
    checkinScript: options.checkinScript || CHECKIN_SCRIPT,
    publicDir: options.publicDir || PUBLIC_DIR,
  };

  const app = express();
  let trustProxy = options.trustProxy;
  if (trustProxy === undefined) {
    try { trustProxy = loadConfig({ envFile: paths.envFile }).WEB_TRUST_PROXY; } catch { trustProxy = process.env.WEB_TRUST_PROXY; }
  }
  app.set('trust proxy', parseTrustProxy(trustProxy));
  if (isDangerousTrustProxy(trustProxy)) {
    console.warn('[web] WEB_TRUST_PROXY=true/all 不受支持，已降级为 false（不信任 X-Forwarded-For）；请改用跳数或 loopback。');
  }
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    next();
  });

  const auth = createAuthService({ envFile: paths.envFile, logFile: paths.logFile });
  const feishu = options.feishu || createFeishuService({
    envFile: paths.envFile,
    logFile: paths.logFile,
    fetchImpl: options.fetchImpl,
  });
  auth.registerRoutes(app);
  registerFeishuRoutes(app, { feishu, auth, logFile: paths.logFile, logger });

  app.get('/healthz', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true });
  });

  registerStatusRoutes(app, { authMiddleware: auth.authMiddleware, ...paths });
  registerLogRoutes(app, { authMiddleware: auth.authMiddleware, ...paths });
  registerEnvRoutes(app, {
    authMiddleware: auth.authMiddleware,
    envFile: paths.envFile,
    stateFile: paths.stateFile,
    logFile: paths.logFile,
    logger,
    onPasswordChanged: auth.revokeAll,
    onAuthConfigChanged: () => {
      auth.revokeAll();
      feishu.resetCaches();
    },
  });
  registerCheckinRoutes(app, {
    authMiddleware: auth.authMiddleware,
    envFile: paths.envFile,
    lockFile: paths.lockFile,
    logFile: paths.logFile,
    appDir: paths.appDir,
    checkinScript: paths.checkinScript,
  });
  registerScreenshotRoutes(app, { authMiddleware: auth.authMiddleware, screenshotFile: paths.screenshotFile });

  app.use(express.static(paths.publicDir, {
    index: false,
    etag: true,
    maxAge: '1h',
    setHeaders(res, filePath) {
      /* 前端资源用固定文件名，若沿用 maxAge 会让浏览器在重新部署后
         继续使用旧的 app.js / styles.css，最多 1 小时版本错配。
         这里统一改为 no-cache：仍带 ETag，未变化时走 304，不浪费带宽。 */
      if (/\.(html|js|css)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    },
  }));

  app.get('/', (req, res, next) => {
    const indexFile = join(paths.publicDir, 'index.html');
    if (!existsSync(indexFile)) return next(new Error(`前端文件不存在：${indexFile}`));
    res.setHeader('Cache-Control', 'no-cache');
    return res.sendFile(indexFile);
  });

  app.use((req, res) => {
    res.status(404).json({ error: '接口或页面不存在' });
  });

  app.use((error, req, res, next) => {
    logger.error('Web 请求失败：', error);
    if (res.headersSent) return next(error);
    const status = error.status || 500;
    const message = status >= 500 ? '服务器内部错误' : (error.message || '请求失败');
    return res.status(status).json({ error: message });
  });

  return { app, auth, feishu, paths };
}

export function startWebServer(options = {}) {
  const { app, auth, feishu } = createWebApp(options);
  const port = options.port || WEB_PORT;
  const host = options.host || WEB_HOST;

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const logger = options.logger || createLogger();
      logger.info(`MeimoAI 签到管理系统已启动: http://${host}:${port}`);

      const feishuCfg = feishu.getConfig();
      if (feishuCfg.enabled) {
        const problems = feishuConfigProblems(feishuCfg);
        if (problems.length) {
          logger.warn(`[安全告警] 飞书 SSO 已开启但配置不完整，登录入口不可用；缺少：${problems.join('、')}`);
        } else {
          logger.info(`飞书 SSO 已启用（app_id=${feishuCfg.appId}；白名单 企业 ${feishuCfg.tenantKeys.length} 项 / 用户 ${feishuCfg.openIds.length} 项）`);
        }
      }

      if (!auth.isAuthEnabled()) {
        logger.warn('[安全告警] WEB_PASSWORD 未设置且飞书 SSO 未启用，所有接口处于无认证状态，严禁暴露到公网！');
      } else if (!auth.isPasswordEnabled()) {
        logger.info('Web 认证仅依赖飞书 SSO；如需应急入口可在配置中设置 WEB_PASSWORD。');
      } else if (!auth.getWebPassword().startsWith('scrypt$')) {
        logger.warn('[安全提示] WEB_PASSWORD 为明文存储，建议使用 scrypt 哈希（npm run hash 生成）。');
      }

      resolve(server);
    });
    server.once('error', reject);
  });
}
