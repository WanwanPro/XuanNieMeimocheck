// 签到流程编排：配置装载 -> 熔断判定 -> 概率跳过 -> 随机延迟 -> 加锁 -> 执行 -> 落状态 -> 推送。
import { boolValue, floatValue, intValue } from '../config.js';
import { loadConfig } from '../envfile.js';
import { acquireLock } from '../lock.js';
import { createLogger, rotateIfNeeded } from '../logger.js';
import { ENV_FILE, LOCK_FILE, LOG_FILE, SCREENSHOT_FILE, STATE_FILE, USER_DATA_DIR } from '../paths.js';
import { sendPush } from '../push.js';
import {
  beijingDate, clearPaused, hasRunToday, readState, recordRun, setPaused,
} from '../state.js';
import {
  checkIn, createResponseCollector, detectRisk, ensureLoggedIn, goToPowerPage,
  readBalance, RiskError, warmup,
} from './actions.js';
import { launchBrowser, saveErrorScreenshot } from './browser.js';
import { sampleDuration, sleep } from './humanize.js';
import { circuitBreakReason, shouldCircuitBreak } from './risk.js';

/** 从配置项组装运行期配置 */
export function buildCheckinConfig(raw) {
  return {
    url: raw.MEIMOAI_URL,
    account: raw.MEIMOAI_ACCOUNT,
    password: raw.MEIMOAI_PASSWORD,
    headless: boolValue(process.env.HEADLESS, true),
    slowMo: intValue(process.env.SLOW_MO, 0),
    userDataDir: process.env.USER_DATA_DIR || USER_DATA_DIR,
    randomDelay: boolValue(raw.RANDOM_DELAY, true),
    randomDelayMaxMinutes: intValue(raw.RANDOM_DELAY_MAX_MINUTES, 300),
    skipProbability: floatValue(raw.SKIP_PROBABILITY, 0.05),
    maxConsecutiveFailures: Math.max(1, intValue(raw.MAX_CONSECUTIVE_FAILURES, 3)),
    proxyServer: raw.PROXY_SERVER || '',
    WANWAN_PUSH_TOKEN: raw.WANWAN_PUSH_TOKEN || '',
    PUSHPLUS_TOKEN: raw.PUSHPLUS_TOKEN || '',
    SERVERCHAN_SENDKEY: raw.SERVERCHAN_SENDKEY || '',
    WEBHOOK_URL: raw.WEBHOOK_URL || '',
  };
}

/** 随机延迟：对数正态右偏采样，让人为时间更自然地集中在窗口前段 */
async function maybeDailyRandomDelay(config, logger) {
  if (!config.randomDelay) return 0;
  const maxMs = Math.max(0, config.randomDelayMaxMinutes) * 60 * 1000;
  if (maxMs === 0) return 0;
  const delayMs = sampleDuration(0, maxMs, 0.35);
  logger.info(`启用随机延迟：等待约 ${Math.round(delayMs / 60000)} 分钟（上限 ${config.randomDelayMaxMinutes} 分钟）`);
  await sleep(delayMs);
  return delayMs;
}

/**
 * 随机延迟结束后，或拿到锁后，复查是否已被暂停/今日已有可视为完成的记录。
 * 手动失败/clicked 不会阻止 cron 重试；手动 success/already 会阻止。
 */
export function shouldSkipScheduledRun(state, now = new Date()) {
  return Boolean(state.paused) || hasRunToday(state, beijingDate(now.toISOString()));
}

function summarize(status, balanceBefore, balanceAfter, gained) {
  if (status === 'success') return '签到成功';
  if (status === 'already') return '今日已签到';
  if (status === 'clicked') return '已点击签到，请人工确认页面状态';
  return status;
}

export async function runCheckin({ manual = false, dryRun = false, runId = '' } = {}) {
  const logger = createLogger();
  let raw = loadConfig({ envFile: ENV_FILE });
  let config = buildCheckinConfig(raw);
  const trigger = manual ? 'manual' : 'cron';

  if (!config.account || !config.password) {
    logger.error('缺少 MEIMOAI_ACCOUNT 或 MEIMOAI_PASSWORD，无法执行签到');
    return 2;
  }

  // ---- 熔断：连续失败过多则暂停自动签到（手动 / dry-run 不受限） ----
  const stateBefore = readState(STATE_FILE);
  if (!manual && !dryRun && stateBefore.paused) {
    logger.warn(`定时签到当前处于暂停状态：${stateBefore.pausedReason || '等待人工恢复'}`);
    return 0;
  }
  if (!manual && !dryRun && shouldCircuitBreak(stateBefore, config.maxConsecutiveFailures)) {
    const reason = circuitBreakReason(stateBefore, config.maxConsecutiveFailures);
    setPaused(STATE_FILE, true, reason);
    logger.warn(reason);
    await sendPush(config, 'MeimoAI 签到已暂停', reason, {
      status: 'error', errorMsg: reason,
    }, logger).catch(() => {});
    return 0;
  }

  // ---- 概率跳过：低概率"今天忘了签"，避免形成完美周期 ----
  if (!manual && !dryRun && Math.random() < config.skipProbability) {
    const message = `本次按概率跳过（SKIP_PROBABILITY=${config.skipProbability}）；当天不会自动补签，如需每天必签请将 SKIP_PROBABILITY 设为 0`;
    logger.warn(message);
    recordRun(STATE_FILE, { status: 'skipped', trigger });
    await sendPush(config, 'MeimoAI 签到跳过', message, {
      status: 'skipped', balance: '未识别', balanceBefore: '未识别', gained: '',
    }, logger).catch(() => {});
    return 0;
  }

  // ---- 随机延迟（在加锁之前完成，避免长时间持锁） ----
  const delayMs = manual || dryRun ? 0 : await maybeDailyRandomDelay(config, logger);

  // 延迟期间配置/状态可能变化：重新加载配置并确认今天还没有执行过。
  if (!manual && !dryRun) {
    raw = loadConfig({ envFile: ENV_FILE });
    config = buildCheckinConfig(raw);
    if (!config.account || !config.password) {
      logger.error('延迟结束后复查发现缺少 MEIMOAI_ACCOUNT 或 MEIMOAI_PASSWORD，本次不执行');
      return 2;
    }
    if (shouldSkipScheduledRun(readState(STATE_FILE))) {
      logger.info('延迟结束后复查：任务已暂停或今日已有运行记录，本次不再执行');
      return 0;
    }
  }

  // ---- 跨进程锁：cron 与手动签到互斥 ----
  const lock = acquireLock(LOCK_FILE);
  if (!lock) {
    logger.warn('另一个签到任务正在运行，本次跳过（锁被占用）');
    return 0;
  }

  if (!manual && !dryRun && shouldSkipScheduledRun(readState(STATE_FILE))) {
    logger.info('拿到锁后复查：任务已暂停或今日已有运行记录，本次不再执行');
    lock.release();
    return 0;
  }

  // 锁回收存在理论竞态：本进程刚建立的锁文件可能被另一个清理者移走。
  // 打开 Firefox profile 之前再核验一次 token，避免两个进程同时操作同一 profile。
  if (!lock.verify()) {
    lock.release(); // 此时 token 已不属于本进程，release 是 no-op，只为路径一致性
    logger.warn('签到锁已失效（可能被其它进程回收），本次不执行');
    return 0;
  }

  // 轮转放在锁校验之后：锁已失效就不要产生日志轮转副作用，
  // 否则可能与真正持有锁的进程同时操作日志。
  // 轮转必须在拿到签到锁后执行，避免与另一个进程正在写的日志互相截断。
  rotateIfNeeded(LOG_FILE);

  const startedAt = Date.now();
  let status = 'error';
  let balanceBefore = '';
  let balanceAfter = '';
  let gained = '';
  let errorMessage = '';
  let browserHandle = null;

  try {
    browserHandle = await launchBrowser(config, logger);
    const { context, page } = browserHandle;
    const collector = createResponseCollector(page, logger);

    logger.step(`打开站点：${config.url}`);
    await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle').catch(() => {});
    await warmup(page, logger);

    const entryRisk = await detectRisk(page);
    if (entryRisk.risk) throw new RiskError(`进入站点即被风控：${entryRisk.reason}`);

    await ensureLoggedIn(page, config, logger);
    await goToPowerPage(page, logger);

    balanceBefore = await readBalance(page, { logger, collector });
    logger.info(`签到前电量余额：${balanceBefore}`);

    status = await checkIn(page, { logger, dryRun });

    if (dryRun) {
      logger.info('dry-run 结束：已完成登录与定位，未执行实际签到');
      return 0;
    }

    balanceAfter = await readBalance(page, { logger, collector });

    const gainedNum = (status === 'success' && balanceBefore !== '未识别' && balanceAfter !== '未识别')
      ? (Number.parseFloat(balanceAfter) - Number.parseFloat(balanceBefore)).toFixed(1)
      : '';
    gained = gainedNum ? `+${gainedNum}` : '';

    const summary = summarize(status, balanceBefore, balanceAfter, gained);
    const plainMsg = `${summary}\n电量余额：${balanceAfter}${gained ? `（${gained}）` : ''}\n签到前：${balanceBefore} → 签到后：${balanceAfter}`;
    logger.info(plainMsg.replace(/\n/g, ' | '));

    await sendPush(config, 'MeimoAI 签到结果', plainMsg, {
      status, balance: balanceAfter, balanceBefore, gained,
    }, logger);
  } catch (error) {
    status = 'error';
    errorMessage = error.message;

    let screenshotSaved = false;
    if (browserHandle && browserHandle.page) {
      screenshotSaved = await saveErrorScreenshot(browserHandle.page, SCREENSHOT_FILE, logger);
    }
    if (error.isRisk) {
      logger.error(`触发风控：${errorMessage}`);
    } else {
      logger.error(`签到失败：${errorMessage}`);
    }

    const plainMsg = `签到失败：${errorMessage}\n错误截图：${screenshotSaved ? '已保存' : '未保存'}（${SCREENSHOT_FILE}）`;
    await sendPush(config, 'MeimoAI 签到失败', plainMsg, {
      status: 'error', errorMsg: errorMessage, screenshotSaved,
    }, logger);
  } finally {
    if (browserHandle && browserHandle.context) {
      await browserHandle.context.close().catch(() => {});
    }
    lock.release();
  }

  // ---- 落状态 + 熔断检查 ----
  const state = recordRun(STATE_FILE, {
    status,
    runId,
    balanceBefore,
    balanceAfter,
    gained,
    durationMs: Date.now() - startedAt,
    trigger,
    error: errorMessage,
    delayMs,
  });

  if ((status === 'success' || status === 'already') && state.paused) {
    clearPaused(STATE_FILE);
    logger.info('签到已恢复，熔断暂停状态已解除');
  } else if (status === 'clicked' && state.paused) {
    logger.warn('本次结果为 clicked（不确定），不会自动解除熔断暂停，请人工确认后再恢复');
  }

  if ((status === 'error' || status === 'clicked') && shouldCircuitBreak(state, config.maxConsecutiveFailures)) {
    const reason = circuitBreakReason(state, config.maxConsecutiveFailures);
    setPaused(STATE_FILE, true, reason);
    logger.warn(reason);
    const recovery = status === 'clicked'
      ? '请人工确认页面状态并检查账号是否被风控，再重新保存配置以恢复。'
      : '请检查日志后重新保存配置以恢复。';
    await sendPush(config, 'MeimoAI 自动签到已暂停', `${reason}\n${recovery}`, {
      status: 'error', errorMsg: reason,
    }, logger).catch(() => {});
  }

  if (status === 'error') return 1;
  if (status === 'clicked') return 3;
  return 0;
}
