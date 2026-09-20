// 浏览器启动与生命周期。
//
// 方案 A：使用浏览器原生 UA（真实 Firefox），不再伪造 iPhone Safari UA。
// 只随机化/持久化"与引擎无关"的维度（viewport、locale、时区），保证指纹自洽。
import { firefox } from 'playwright';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { buildInitScript, loadDevice } from './device.js';
import { resetMousePointer } from './humanize.js';

/** 清理上次崩溃残留的 profile 锁文件 */
export function cleanStaleLocks(userDataDir, logger) {
  const names = ['lock', '.parentlock', 'parent.lock'];
  for (const name of names) {
    const file = join(userDataDir, name);
    if (existsSync(file)) {
      try {
        unlinkSync(file);
        logger.info(`已清理残留锁文件：${file}`);
      } catch {
        /* 清理失败不影响主流程 */
      }
    }
  }
}

/**
 * 启动持久化上下文（复用 profile 以保留登录态）。
 * @returns {{ context, page, device }}
 */
export async function launchBrowser(config, logger) {
  const userDataDir = config.userDataDir;
  const device = loadDevice(userDataDir, logger);
  cleanStaleLocks(userDataDir, logger);

  const launchOptions = {
    headless: config.headless,
    slowMo: config.slowMo,
    viewport: device.viewport,
    deviceScaleFactor: device.deviceScaleFactor,
    locale: device.locale,
    timezoneId: device.timezoneId,
    colorScheme: device.colorScheme,
    extraHTTPHeaders: {
      'Accept-Language': device.acceptLanguage,
    },
  };
  if (config.proxyServer) launchOptions.proxy = { server: config.proxyServer };

  logger.info(`启动浏览器：${config.headless ? 'headless' : 'headful'}，viewport ${device.viewport.width}x${device.viewport.height}，区域 ${device.region}`);
  const context = await firefox.launchPersistentContext(userDataDir, launchOptions);

  // 自动化痕迹处理（最小必要，避免过度 patch 引入新特征）
  await context.addInitScript(buildInitScript(device)).catch((err) => {
    logger.warn(`init script 注入失败：${err.message}`);
  });

  // 复用持久化上下文自带的空白页，避免多余标签页
  const existing = context.pages();
  const page = existing.length > 0 ? existing[0] : await context.newPage();
  resetMousePointer(device.viewport);
  return { context, page, device };
}

/** 出错时保存截图（绝对路径，避免依赖 cwd） */
export async function saveErrorScreenshot(page, file, logger) {
  try {
    await page.screenshot({ path: file, fullPage: true });
    logger.info(`错误截图已保存：${file}`);
    return true;
  } catch (err) {
    logger.warn(`错误截图保存失败：${err.message}`);
    return false;
  }
}
