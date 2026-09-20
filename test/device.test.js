import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildInitScript, deviceFilePath, loadDevice } from '../src/checkin/device.js';

test('loadDevice 自动创建 profile 目录并持久化区域一致的 Firefox 指纹', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'meimoai-device-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const profile = join(dir, 'nested', 'profile');

  const device = loadDevice(profile);
  const saved = JSON.parse(await readFile(deviceFilePath(profile), 'utf8'));

  assert.equal(device.version, 3);
  assert.equal(device.region, 'CN');
  assert.equal(device.locale, 'zh-CN');
  assert.equal(device.timezoneId, 'Asia/Shanghai');
  assert.equal(device.acceptLanguage, 'zh-CN,zh;q=0.9,en;q=0.8');
  assert.equal(device.userAgent, '');
  assert.equal(Object.hasOwn(device, 'seed'), false);
  assert.equal(Object.hasOwn(device, 'deviceMemory'), false);
  assert.equal(saved.viewport.width, device.viewport.width);
  assert.equal(saved.viewport.height, device.viewport.height);
  assert.equal(saved.acceptLanguage, device.acceptLanguage);
});

test('loadDevice 迁移旧版伪装 UA 并删除 seed/deviceMemory', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'meimoai-device-legacy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const profile = join(dir, 'profile');
  await mkdir(profile, { recursive: true });
  const file = deviceFilePath(profile);
  await writeFile(file, JSON.stringify({
    version: 2,
    seed: 'deadbeef',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
    languages: ['zh-CN', 'zh'],
    acceptLanguage: 'zh-CN',
    hardwareConcurrency: 8,
    deviceMemory: 8,
  }), 'utf8');

  const device = loadDevice(profile);
  assert.equal(device.version, 3);
  assert.equal(device.region, 'CN');
  assert.equal(device.userAgent, '');
  assert.equal(Object.hasOwn(device, 'seed'), false);
  assert.equal(Object.hasOwn(device, 'deviceMemory'), false);
  assert.equal(device.viewport.width, 390);
  assert.equal(device.hardwareConcurrency, 8);
  assert.equal(device.acceptLanguage, 'zh-CN,zh;q=0.9,en;q=0.8');

  const migrated = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(migrated.version, 3);
  assert.equal(Object.hasOwn(migrated, 'seed'), false);
  assert.equal(Object.hasOwn(migrated, 'deviceMemory'), false);

  const script = buildInitScript(device);
  assert.doesNotMatch(script, /deviceMemory/);
  assert.match(script, /hardwareConcurrency/);
});

test('loadDevice 会修复并持久化非法 hardwareConcurrency/viewport', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'meimoai-device-invalid-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const profile = join(dir, 'profile');
  await mkdir(profile, { recursive: true });
  const file = deviceFilePath(profile);
  await writeFile(file, JSON.stringify({
    version: 3,
    region: 'CN',
    userAgent: '',
    viewport: { width: 0, height: 0 },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    languages: ['zh-CN', 'zh', 'en-US', 'en'],
    acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
    hardwareConcurrency: 6,
    colorScheme: 'light',
  }), 'utf8');

  const device = loadDevice(profile);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.notEqual(saved.hardwareConcurrency, 6);
  assert.ok([4, 8, 12, 16].includes(saved.hardwareConcurrency));
  assert.equal(saved.hardwareConcurrency, device.hardwareConcurrency);
  assert.equal(saved.viewport.width, device.viewport.width);
  assert.equal(saved.viewport.height, device.viewport.height);
  assert.ok(saved.viewport.width > 0 && saved.viewport.height > 0);
});


test('loadDevice 支持 GLOBAL 区域并统一派生语言与时区', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'meimoai-device-global-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const profile = join(dir, 'profile');
  await mkdir(profile, { recursive: true });
  await writeFile(deviceFilePath(profile), JSON.stringify({ region: 'GLOBAL', viewport: { width: 1440, height: 900 } }), 'utf8');

  const device = loadDevice(profile);
  assert.equal(device.region, 'GLOBAL');
  assert.equal(device.locale, 'en-US');
  assert.equal(device.timezoneId, 'America/New_York');
  assert.equal(device.acceptLanguage, 'en-US,en;q=0.9');
});