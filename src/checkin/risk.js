// 风控识别与熔断判定。
import { RISK_PATTERNS, RISK_SELECTORS } from './selectors.js';

/** 表示"被风控拦截"，与普通异常区分开，便于上层做不同的告警/退避 */
export class RiskError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RiskError';
    this.isRisk = true;
  }
}

/**
 * 检测页面是否出现人机校验 / 风控拦截。
 * 只在明确命中时才判定为风控，避免误伤正常页面。
 */
export async function detectRisk(page) {
  for (const sel of RISK_SELECTORS) {
    const visible = await page.locator(sel).first().isVisible().catch(() => false);
    if (visible) return { risk: true, reason: `检测到验证组件：${sel}` };
  }

  const body = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  if (body) {
    for (const pattern of RISK_PATTERNS) {
      const m = pattern.exec(body);
      if (m) return { risk: true, reason: `页面出现风控提示："${m[0]}"` };
    }
  }
  return { risk: false, reason: '' };
}

function count(value) {
  return Number(value) || 0;
}

/** 连续失败或连续 clicked（结果不确定）达到阈值 -> 需要熔断暂停 */
export function shouldCircuitBreak(state, maxConsecutiveFailures) {
  const failures = count(state && state.consecutiveFailures);
  const clicked = count(state && state.consecutiveClicked);
  return failures >= maxConsecutiveFailures || clicked >= maxConsecutiveFailures;
}

export function circuitBreakReason(state, maxConsecutiveFailures) {
  const failures = count(state && state.consecutiveFailures);
  const clicked = count(state && state.consecutiveClicked);
  if (clicked >= maxConsecutiveFailures && clicked >= failures) {
    return `连续 ${clicked} 次点击后状态不确定（阈值 ${maxConsecutiveFailures}），已自动暂停定时签到，请人工确认页面状态后再恢复`;
  }
  return `连续失败 ${failures} 次（阈值 ${maxConsecutiveFailures}），已自动暂停定时签到，请检查后再恢复`;
}
