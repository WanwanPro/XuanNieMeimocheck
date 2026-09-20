// 错误截图读取。截图是敏感内容，仍走认证中间件。
import { existsSync } from 'fs';

export function registerScreenshotRoutes(app, { authMiddleware, screenshotFile }) {
  app.get('/api/screenshot', authMiddleware, (req, res) => {
    if (!existsSync(screenshotFile)) return res.status(404).json({ error: '没有错误截图' });
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(screenshotFile, (error) => {
      if (error && !res.headersSent) res.status(500).json({ error: '服务器内部错误' });
    });
  });
}
