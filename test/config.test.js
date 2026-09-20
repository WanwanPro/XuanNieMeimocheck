import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boolValue,
  floatValue,
  intValue,
  isValidCron,
  isDangerousTrustProxy,
  isSecretKey,
  parseTrustProxy,
  validateValue,
} from '../src/config.js';

test('isValidCron 接受合法 5 段表达式并拒绝注入/段数错误', () => {
  assert.equal(isValidCron('0 1 * * *'), true);
  assert.equal(isValidCron('*/15 0-6 * * 1-5'), true);
  assert.equal(isValidCron('0 1 * * * extra'), false);
  assert.equal(isValidCron('0 1 * * *; rm -rf /'), false);
  assert.equal(isValidCron('99 99 * * *'), false);
  assert.equal(isValidCron('*/0 * * * *'), false);
  assert.equal(isValidCron('0 1 * * 7'), true);
  assert.equal(isValidCron(''), false);
});

test('validateValue 校验 int/float/bool/url/cron 边界', () => {
  assert.equal(validateValue('RANDOM_DELAY_MAX_MINUTES', '0'), null);
  assert.equal(validateValue('RANDOM_DELAY_MAX_MINUTES', '-1'), 'RANDOM_DELAY_MAX_MINUTES 不能小于 0');
  assert.equal(validateValue('SKIP_PROBABILITY', '1'), null);
  assert.equal(validateValue('SKIP_PROBABILITY', '1.1'), 'SKIP_PROBABILITY 不能大于 1');
  assert.equal(validateValue('RANDOM_DELAY', 'TRUE'), null);
  assert.equal(validateValue('RANDOM_DELAY', 'yes'), 'RANDOM_DELAY 只能是 true 或 false');
  assert.equal(validateValue('MEIMOAI_URL', 'ftp://example.com'), 'MEIMOAI_URL 必须是 http(s):// 开头的地址');
  assert.equal(validateValue('CRON_SCHEDULE', '0 1 * * *'), null);
  assert.equal(validateValue('CRON_SCHEDULE', 'bad'), 'CRON_SCHEDULE 不是合法的 5 段 cron 表达式（如 0 1 * * *）');
  assert.equal(validateValue('UNKNOWN', 'x'), '未知配置项：UNKNOWN');
});

test('Web 更新允许清空 required 字段，默认校验仍要求必填', () => {
  assert.equal(validateValue('MEIMOAI_PASSWORD', '', { allowEmpty: true }), null);
  assert.equal(validateValue('MEIMOAI_PASSWORD', ''), 'MEIMOAI_PASSWORD 不能为空');
  assert.equal(validateValue('MEIMOAI_ACCOUNT', '', { allowEmpty: true }), null);
  assert.equal(validateValue('MEIMOAI_ACCOUNT', ''), 'MEIMOAI_ACCOUNT 不能为空');
});

// 回归：CRON_SCHEDULE 曾因未标 required 且 cron 分支只在非空时校验，
// 导致 Web 可以保存空值 -> 容器重启 install-cron 抛错 -> entrypoint set -e 崩溃循环。
test('CRON_SCHEDULE 即使 allowEmpty 也必须非空且合法', () => {
  assert.equal(validateValue('CRON_SCHEDULE', ''), 'CRON_SCHEDULE 不能为空');
  assert.equal(
    validateValue('CRON_SCHEDULE', '', { allowEmpty: true }),
    'CRON_SCHEDULE 不是合法的 5 段 cron 表达式（如 0 1 * * *）',
  );
  assert.equal(
    validateValue('CRON_SCHEDULE', '   ', { allowEmpty: true }),
    'CRON_SCHEDULE 不是合法的 5 段 cron 表达式（如 0 1 * * *）',
  );
  assert.equal(validateValue('CRON_SCHEDULE', '0 1 * * *', { allowEmpty: true }), null);
});

test('账号等敏感项被标记为 secret，供状态/配置接口脱敏', () => {
  assert.equal(isSecretKey('MEIMOAI_ACCOUNT'), true);
  assert.equal(isSecretKey('MEIMOAI_PASSWORD'), true);
  assert.equal(isSecretKey('CRON_SCHEDULE'), false);
});

test('配置转换函数提供稳定默认值', () => {
  assert.equal(boolValue(undefined, true), true);
  assert.equal(boolValue('FALSE', true), false);
  assert.equal(intValue('12', 0), 12);
  assert.equal(intValue('bad', 7), 7);
  assert.equal(floatValue('0.25', 0), 0.25);
  assert.equal(floatValue('bad', 1.5), 1.5);
});

test('parseTrustProxy 拒绝 true/all，避免信任伪造的 X-Forwarded-For', () => {
  assert.equal(parseTrustProxy(''), false);
  assert.equal(parseTrustProxy('false'), false);
  assert.equal(parseTrustProxy('true'), false, 'true 必须降级为不信任');
  assert.equal(parseTrustProxy('all'), false, 'all 必须降级为不信任');
  assert.equal(parseTrustProxy('1'), 1);
  assert.equal(parseTrustProxy('loopback'), 'loopback');
  assert.equal(parseTrustProxy('10.0.0.0/8'), '10.0.0.0/8');
  assert.equal(isDangerousTrustProxy('true'), true);
  assert.equal(isDangerousTrustProxy('ALL'), true);
  assert.equal(isDangerousTrustProxy('1'), false);
});
