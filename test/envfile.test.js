import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadConfig,
  parseEnvFile,
  parseEnvValue,
  serializeEnv,
  writeEnvAtomic,
} from '../src/envfile.js';

test('parseEnvValue 兼容 JSON、单引号和旧裸值', () => {
  assert.equal(parseEnvValue('plain'), 'plain');
  assert.equal(parseEnvValue('"a\\\\b"'), 'a\\b');
  assert.equal(parseEnvValue("'a#b'"), 'a#b');
  assert.equal(parseEnvValue('"unterminated'), '"unterminated');
});

test('.env 序列化可以无损往返特殊字符', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'meimoai-env-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const original = {
    A: 'quote"inside',
    B: 'back\\slash',
    C: 'hash#value',
    D: 'line1\nline2',
    E: 'equals=value',
  };
  const file = join(dir, '.env');
  await writeFile(file, serializeEnv(original, ['A', 'B', 'C', 'D', 'E']), 'utf8');

  assert.deepEqual(parseEnvFile(file), original);
});

test('loadConfig 优先级为默认值 < process.env < .env 文件', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'meimoai-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const file = join(dir, '.env');
  await writeFile(file, 'MEIMOAI_ACCOUNT=file-account\nRANDOM_DELAY=false\n', 'utf8');
  const config = loadConfig({
    envFile: file,
    processEnv: {
      MEIMOAI_ACCOUNT: 'process-account',
      MEIMOAI_URL: 'https://process.example/',
    },
  });

  assert.equal(config.MEIMOAI_ACCOUNT, 'file-account');
  assert.equal(config.MEIMOAI_URL, 'https://process.example/');
  assert.equal(config.RANDOM_DELAY, 'false');
  assert.equal(config.SKIP_PROBABILITY, '0.05');
});

test('writeEnvAtomic 写入后可直接读取', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'meimoai-atomic-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const file = join(dir, 'nested', '.env');
  writeEnvAtomic(file, { MEIMOAI_ACCOUNT: 'a"b', WEB_PASSWORD: 'p#1' }, ['MEIMOAI_ACCOUNT', 'WEB_PASSWORD']);
  const content = await readFile(file, 'utf8');
  assert.match(content, /MEIMOAI_ACCOUNT="a\\"b"/);
  assert.equal(parseEnvFile(file).WEB_PASSWORD, 'p#1');
});
