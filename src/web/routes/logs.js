// 日志读取、清空与错误截图删除。
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';

export function registerLogRoutes(app, { authMiddleware, logFile, screenshotFile }) {
  app.get('/api/logs', authMiddleware, (req, res) => {
    try {
      const requested = Number.parseInt(req.query.limit, 10);
      const limit = Number.isFinite(requested) ? Math.min(1000, Math.max(1, requested)) : 200;
      const content = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
      const lines = content.trim() ? content.trim().split(/\r?\n/).filter(Boolean) : [];
      res.setHeader('Cache-Control', 'no-store');
      res.json({ lines: lines.slice(-limit), total: lines.length });
    } catch (error) {
      res.status(500).json({ error: '服务器内部错误' });
    }
  });

  app.post('/api/logs/clear', authMiddleware, (req, res) => {
    try {
      writeFileSync(logFile, '', { encoding: 'utf8', mode: 0o600 });
      if (existsSync(screenshotFile)) unlinkSync(screenshotFile);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: '服务器内部错误' });
    }
  });
}
