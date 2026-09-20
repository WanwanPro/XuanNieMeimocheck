// 站点流程动作：登录、进入电量页、签到、读取余额。
//
// 相比旧版，这里增加了：
//   - 网络响应采集（作为 DOM 解析之外的补充信号）
//   - 风控识别（命中即抛 RiskError，上层不再重试）
//   - 更明确的选择器失效报错信息
import {
  humanClick, humanDelay, humanScroll, humanType, humanWarmup, maybeClick,
} from './humanize.js';
import {
  agreementCandidates, checkinButtonCandidates, checkinRewardCandidates,
  claimButtonCandidates, guideCloseCandidates, loginEntryCandidates,
  loginSubmitCandidates, passwordLoginCandidates, powerEntryCandidates,
  profileTabCandidates, TEXT,
} from './selectors.js';
import { detectRisk, RiskError } from './risk.js';

async function visible(locator) {
  return locator.first().isVisible().catch(() => false);
}

/** 连续关闭可能出现的引导弹窗（最多 3 轮） */
export async function closeGuideIfPresent(page, logger) {
  for (let i = 0; i < 3; i += 1) {
    const clicked = await maybeClick(page, guideCloseCandidates(page), 1500);
    if (!clicked) break;
    await humanDelay(600, 1400);
  }
}

export async function isLoggedIn(page) {
  for (const text of TEXT.loggedIn) {
    if (await visible(page.getByText(text, { exact: true }))) return true;
  }
  for (const text of TEXT.loggedOut) {
    if (await visible(page.getByText(text, { exact: true }))) return false;
  }
  // 没有明确信号时按"未登录"处理，走完整登录流程更安全
  return false;
}

export async function openLoginIfNeeded(page, logger) {
  await maybeClick(page, loginEntryCandidates(page), 3000);

  if (!page.url().includes('/pages/login/login')) {
    await maybeClick(page, profileTabCandidates(page), 5000);
    await humanDelay(900, 1800);
    await maybeClick(page, loginEntryCandidates(page), 5000);
  }

  await page.waitForLoadState('networkidle').catch(() => {});
  await humanDelay(1000, 2400);
}

/** 勾选用户协议（.select-box 优先，失败回退到 .services-box） */
export async function clickAgreement(page, logger) {
  const ok = await maybeClick(page, agreementCandidates(page), 5000);
  if (!ok) return false;
  await humanDelay(800, 2000);
  logger.info('已勾选用户协议');
  return true;
}

export async function ensureLoggedIn(page, config, logger) {
  await closeGuideIfPresent(page, logger);
  await humanScroll(page);

  if (await isLoggedIn(page)) {
    logger.info('已是登录态，跳过登录流程');
    return;
  }

  await openLoginIfNeeded(page, logger);
  await maybeClick(page, passwordLoginCandidates(page));

  // 优先按语义定位，避免页面新增隐藏 input / 搜索框后按位置填错。
  const accountInput = page.locator(
    'input[autocomplete="username"]:visible, input[name*="account" i]:visible, '
    + 'input[name*="user" i]:visible, input[type="text"]:visible, '
    + 'input[type="tel"]:visible, input:not([type]):visible',
  ).first();
  const passwordInput = page.locator('input[type="password"]:visible').first();
  const accountCount = await accountInput.count();
  const passwordCount = await passwordInput.count();
  if (accountCount < 1 || passwordCount < 1) {
    throw new Error(`登录页未找到可见的账号/密码输入框（账号 ${accountCount}，密码 ${passwordCount}），站点可能已改版`);
  }

  logger.info('正在输入账号密码');
  await humanType(accountInput, config.account);
  await humanDelay(500, 1400);
  await humanType(passwordInput, config.password);
  await humanDelay(400, 1100);

  const agreed = await clickAgreement(page, logger);
  if (!agreed) {
    throw new Error('未能勾选用户协议，站点可能已改版（请检查 selectors.js 中的 agreementCandidates）');
  }

  await maybeClick(page, loginSubmitCandidates(page), 6000);
  await page.waitForLoadState('networkidle').catch(() => {});
  await humanDelay(2500, 4500);
  await closeGuideIfPresent(page, logger);

  const risk = await detectRisk(page);
  if (risk.risk) throw new RiskError(`登录环节被风控拦截：${risk.reason}`);

  if (!(await isLoggedIn(page))) {
    throw new Error('登录后仍为未登录状态（账号密码错误、需要验证码，或站点改版）');
  }
  logger.info('登录成功');
}

export async function goToPowerPage(page, logger) {
  await closeGuideIfPresent(page, logger);
  await humanScroll(page);

  const clicked = await maybeClick(page, powerEntryCandidates(page), 6000);
  if (!clicked) {
    throw new Error('未找到"领电量"入口，站点可能已改版（请检查 selectors.js 中的 powerEntryCandidates）');
  }
  await page.waitForLoadState('networkidle').catch(() => {});
  await humanDelay(1300, 3200);
  await closeGuideIfPresent(page, logger);
}

// ------------------------------------------------------------ 网络响应采集

const BALANCE_KEY = /^(balance|power|energy|points?|score|coins?|amount|remain(ing)?|left|electric(ity)?)$/i;
const BALANCE_KEY_CN = /(电量|余额)/;

function walkForNumber(node, keyRe, depth = 0) {
  if (depth > 6 || node === null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = walkForNumber(item, keyRe, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  for (const [key, value] of Object.entries(node)) {
    if ((keyRe.test(key) || BALANCE_KEY_CN.test(key)) && typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    const found = walkForNumber(value, keyRe, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/**
 * 采集页面自身的 XHR/fetch JSON 响应。
 * 用途：作为 DOM 解析的补充信号（余额兜底 + 签到结果判定 + 站点改版排查）。
 * 注意：不做投机性的字段猜测，只在键名强匹配时采用。
 */
export function createResponseCollector(page, logger) {
  const records = [];
  const MAX = 60;

  page.on('response', (response) => {
    (async () => {
      try {
        const type = response.request().resourceType();
        if (type !== 'xhr' && type !== 'fetch') return;
        const contentType = response.headers()['content-type'] || '';
        if (!contentType.includes('json')) return;
        const body = await response.json().catch(() => null);
        if (!body) return;
        if (records.length >= MAX) records.shift();
        records.push({ url: response.url(), status: response.status(), body });
      } catch {
        /* 响应读取失败忽略 */
      }
    })();
  });

  return {
    records,
    /** 在已采集的响应里找余额（强键名匹配） */
    findBalance() {
      for (let i = records.length - 1; i >= 0; i -= 1) {
        const found = walkForNumber(records[i].body, BALANCE_KEY);
        if (found !== null) return { value: found, url: records[i].url };
      }
      return null;
    },
    /** 供排查站点改版时查看接口结构 */
    dump() {
      if (!logger) return;
      for (const r of records.slice(-8)) {
        let preview = '';
        try { preview = JSON.stringify(r.body).slice(0, 200); } catch { preview = '<unserializable>'; }
        logger.info(`接口 ${r.status} ${r.url} -> ${preview}`);
      }
    },
  };
}

// ------------------------------------------------------------ 余额 / 签到

const BALANCE_PATTERNS = [
  /电量(?:余额|剩余|：|:)?\s*([0-9]+(?:\.[0-9]+)?)/,
  /余额(?:：|:)?\s*([0-9]+(?:\.[0-9]+)?)/,
  /我的电量(?:：|:)?\s*([0-9]+(?:\.[0-9]+)?)/,
];

export async function readBalance(page, { logger, collector } = {}) {
  // DOM 优先：显示给用户的值应与页面一致
  const bodyText = await page.locator('body').innerText({ timeout: 15000 }).catch(() => '');
  const compact = bodyText.replace(/\s+/g, ' ');
  for (const pattern of BALANCE_PATTERNS) {
    const match = compact.match(pattern);
    if (match) return match[1];
  }

  // DOM 解析失败时用接口数据兜底
  if (collector) {
    const api = collector.findBalance();
    if (api) {
      if (logger) logger.warn(`页面未解析到余额，改用接口数据：${api.value}（${api.url}）`);
      return String(api.value);
    }
  }
  return '未识别';
}

/**
 * 执行签到。
 * @returns 'success' | 'already' | 'clicked' | 'dry-run'
 */
export async function checkIn(page, { logger, dryRun = false } = {}) {
  await closeGuideIfPresent(page, logger);
  await humanScroll(page);

  if (await visible(page.getByText(TEXT.alreadyCheckedIn))) {
    logger.info('检测到今日已签到');
    return 'already';
  }

  await maybeClick(page, checkinRewardCandidates(page));
  await humanScroll(page);

  if (dryRun) {
    logger.info('[dry-run] 已完成登录与页面定位，跳过实际点击');
    return 'dry-run';
  }

  const clicked = await maybeClick(page, checkinButtonCandidates(page), 8000);
  if (!clicked) {
    if (await visible(page.getByText(TEXT.alreadyCheckedIn))) return 'already';
    throw new Error('未找到签到按钮，站点可能已改版（请检查 selectors.js 中的 checkinButtonCandidates）');
  }

  // 部分活动会再弹一层"领取"
  await maybeClick(page, claimButtonCandidates(page), 6000);
  await humanDelay(2500, 5200);

  const risk = await detectRisk(page);
  if (risk.risk) throw new RiskError(`签到环节被风控拦截：${risk.reason}`);

  return (await visible(page.getByText(TEXT.checkinDone))) ? 'success' : 'clicked';
}

export async function warmup(page, logger) {
  logger.info('页面预热中');
  await humanWarmup(page);
}

export { detectRisk, RiskError, isLoggedIn as checkLoggedIn };
