import test from 'node:test';
import assert from 'node:assert/strict';
import { RISK_PATTERNS } from '../src/checkin/selectors.js';
import { circuitBreakReason, shouldCircuitBreak } from '../src/checkin/risk.js';

function isRiskText(text) {
  return RISK_PATTERNS.some((pattern) => pattern.test(text));
}

test('普通验证码登录文案不会被误判为风控', () => {
  assert.equal(isRiskText('验证码登录 获取验证码 请输入验证码'), false);
});

test('明确的验证失败或人机校验文案仍会命中风控', () => {
  assert.equal(isRiskText('验证码错误，请重试'), true);
  assert.equal(isRiskText('请完成安全验证'), true);
  assert.equal(isRiskText('操作过于频繁，请稍后再试'), true);
});

test('连续 clicked 达到阈值也会触发熔断（独立于普通失败计数）', () => {
  const state = { consecutiveFailures: 0, consecutiveClicked: 3 };
  assert.equal(shouldCircuitBreak(state, 3), true);
  assert.match(circuitBreakReason(state, 3), /状态不确定/);
  assert.equal(shouldCircuitBreak({ consecutiveFailures: 2, consecutiveClicked: 2 }, 3), false);
});
