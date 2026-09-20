import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPushContent, validatePushResponse } from '../src/push.js';

test('PushPlus/ServerChan HTTP 200 的业务失败码会被识别', () => {
  assert.throws(() => validatePushResponse('PushPlus', JSON.stringify({ code: 401, msg: 'token invalid' })), /PushPlus 业务失败/);
  assert.throws(() => validatePushResponse('ServerChan', JSON.stringify({ code: 1, message: 'bad key' })), /ServerChan 业务失败/);
  assert.doesNotThrow(() => validatePushResponse('PushPlus', JSON.stringify({ code: 200 })));
  assert.doesNotThrow(() => validatePushResponse('ServerChan', JSON.stringify({ code: 0 })));
  assert.doesNotThrow(() => validatePushResponse('Webhook', 'ok'));
});

test('错误推送按实际截图结果生成文案', () => {
  const failed = buildPushContent('error', '未识别', '', '', 'boom', false);
  const saved = buildPushContent('error', '未识别', '', '', 'boom', true);
  assert.match(failed, /错误截图未保存/);
  assert.match(saved, /错误截图已保存/);
});