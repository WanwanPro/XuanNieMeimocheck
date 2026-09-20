// 设备指纹：每个部署实例生成一次并持久化，之后每天复用。
//
// 关键原则（方案 A）：
//   1. 不再伪造 UA。旧版用 Firefox 引擎却伪装成 "iPhone Safari"，UA / 引擎 /
//      TLS 指纹三者互相矛盾，是最好识别的一类特征。现在使用浏览器原生 UA
//      （真实 Firefox on Linux），三者天然自洽。
//   2. 指纹"稳定"比"随机"更重要：频繁变化的指纹反而比固定指纹更可疑。
//      因此 viewport / locale / 时区只生成一次，落盘到 profile 目录。
//   3. locale、时区、navigator.languages、Accept-Language 由同一个区域配置派生，
//      避免出现"中文界面 + 海外出口 IP"之类的组合矛盾。
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

const DEVICE_VERSION = 3;
const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1600, height: 900 },
  { width: 1280, height: 800 },
  { width: 1680, height: 1050 },
];

const HARDWARE = [4, 8, 8, 12, 16];

// 只保留常见的区域组合；默认 CN 与项目默认站点/时区保持一致。
// 使用海外代理时，可在持久化 volume 中把 device.json 的 region 改为 GLOBAL，
// 下次启动会统一迁移 locale、时区、languages 和 Accept-Language。
const REGION_PROFILES = Object.freeze({
  CN: Object.freeze({
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    languages: Object.freeze(['zh-CN', 'zh', 'en-US', 'en']),
    acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
  }),
  GLOBAL: Object.freeze({
    locale: 'en-US',
    timezoneId: 'America/New_York',
    languages: Object.freeze(['en-US', 'en']),
    acceptLanguage: 'en-US,en;q=0.9',
  }),
});

const DEFAULT_REGION = 'CN';

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function normalizeRegion(value) {
  const region = String(value || '').trim().toUpperCase();
  return Object.hasOwn(REGION_PROFILES, region) ? region : DEFAULT_REGION;
}

function regionProfile(region) {
  return REGION_PROFILES[normalizeRegion(region)];
}

function createDevice(region = DEFAULT_REGION) {
  const regionKey = normalizeRegion(region);
  const profile = regionProfile(regionKey);
  return {
    version: DEVICE_VERSION,
    createdAt: new Date().toISOString(),
    region: regionKey,
    // 留空且 browser.js 不再覆盖：始终使用 Playwright/Firefox 原生 UA
    userAgent: '',
    viewport: pick(VIEWPORTS),
    deviceScaleFactor: 1,
    locale: profile.locale,
    timezoneId: profile.timezoneId,
    languages: [...profile.languages],
    acceptLanguage: profile.acceptLanguage,
    hardwareConcurrency: pick(HARDWARE),
    colorScheme: 'light',
  };
}

function normalize(device) {
  const region = normalizeRegion(device && device.region);
  const profile = regionProfile(region);
  const base = createDevice(region);
  const merged = { ...base, ...(device || {}) };
  const width = Number(device && device.viewport && device.viewport.width);
  const height = Number(device && device.viewport && device.viewport.height);
  merged.viewport = Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
    ? { width, height }
    : base.viewport;

  // 方案 A 迁移：区域维度始终由 region 统一派生，旧 profile 中的 locale /
  // 语言 / UA / deviceMemory / seed 一律不保留，防止历史字段互相矛盾。
  merged.version = DEVICE_VERSION;
  merged.region = region;
  merged.locale = profile.locale;
  merged.timezoneId = profile.timezoneId;
  merged.languages = [...profile.languages];
  merged.acceptLanguage = profile.acceptLanguage;
  merged.userAgent = '';
  merged.deviceScaleFactor = 1;
  merged.hardwareConcurrency = Number.isInteger(Number(merged.hardwareConcurrency))
    && HARDWARE.includes(Number(merged.hardwareConcurrency))
    ? Number(merged.hardwareConcurrency)
    : base.hardwareConcurrency;
  delete merged.seed;
  delete merged.deviceMemory;
  return merged;
}

export function deviceFilePath(profileDir) {
  return join(profileDir, 'device.json');
}

function persistDevice(file, device, logger) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(device, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    if (logger) logger.warn(`设备指纹写入失败（本次使用内存值）：${err.message}`);
    return false;
  }
}

function sameViewport(a, b) {
  const aw = Number(a && a.width);
  const ah = Number(a && a.height);
  const bw = Number(b && b.width);
  const bh = Number(b && b.height);
  return Number.isFinite(aw) && Number.isFinite(ah)
    && aw === bw && ah === bh;
}

function needsMigration(saved, normalized) {
  if (!saved) return true;
  return saved.version !== normalized.version
    || saved.region !== normalized.region
    || saved.userAgent !== normalized.userAgent
    || !sameViewport(saved.viewport, normalized.viewport)
    || Number(saved.deviceScaleFactor) !== normalized.deviceScaleFactor
    || saved.locale !== normalized.locale
    || saved.timezoneId !== normalized.timezoneId
    || !Array.isArray(saved.languages)
    || saved.languages.join('|') !== normalized.languages.join('|')
    || saved.acceptLanguage !== normalized.acceptLanguage
    || Number(saved.hardwareConcurrency) !== normalized.hardwareConcurrency
    || saved.colorScheme !== normalized.colorScheme
    || Object.hasOwn(saved, 'seed')
    || Object.hasOwn(saved, 'deviceMemory');
}

/** 读取或首次生成设备指纹 */
export function loadDevice(profileDir, logger) {
  const file = deviceFilePath(profileDir);
  try {
    if (profileDir && !existsSync(profileDir)) mkdirSync(profileDir, { recursive: true });
  } catch (err) {
    if (logger) logger.warn(`设备目录创建失败（本次尝试继续）：${err.message}`);
  }

  if (existsSync(file)) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      const device = normalize(saved);
      if (needsMigration(saved, device)) persistDevice(file, device, logger);
      if (logger) logger.info(`设备指纹已加载：${device.viewport.width}x${device.viewport.height}，区域 ${device.region}`);
      return device;
    } catch (err) {
      if (logger) logger.warn(`设备指纹文件损坏，将重新生成：${err.message}`);
    }
  }

  const device = createDevice();
  if (persistDevice(file, device, logger) && logger) {
    logger.info(`已生成新的设备指纹：${device.viewport.width}x${device.viewport.height}，区域 ${device.region}`);
  }
  return device;
}

/**
 * 供 addInitScript 使用的轻量反自动化痕迹处理。
 * 只做最小必要的处理，避免引入新的可检测特征：
 *   - navigator.webdriver -> undefined
 *   - languages 与 locale/区域保持一致
 *   - 只暴露 Firefox 原生存在的 hardwareConcurrency
 * 注意：不做 getter 伪装以外的花哨处理，过度的"stealth"补丁本身就是特征。
 *       Firefox 没有 navigator.deviceMemory，额外注入反而是可识别特征。
 */
export function buildInitScript(device) {
  const payload = JSON.stringify({
    languages: device.languages,
    hardwareConcurrency: device.hardwareConcurrency,
  });
  return `(() => {
  const cfg = ${payload};
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });
  } catch (e) {}
  try {
    Object.defineProperty(Navigator.prototype, 'languages', {
      get: () => cfg.languages,
      configurable: true,
    });
  } catch (e) {}
  try {
    Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', {
      get: () => cfg.hardwareConcurrency,
      configurable: true,
    });
  } catch (e) {}
})();`;
}