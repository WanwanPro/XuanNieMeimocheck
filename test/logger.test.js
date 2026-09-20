import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, openSync, readFileSync, writeSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { rotateIfNeeded } from '../src/logger.js';

test('日志轮转使用 copy+truncate，保持已打开 fd 继续写当前日志', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'meimoai-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const logFile = join(dir, 'checkin.log');
  const fd = openSync(logFile, 'a');

  try {
    writeSync(fd, 'before\n');
    assert.equal(rotateIfNeeded(logFile, 1), true);
    writeSync(fd, 'after\n');
  } finally {
    closeSync(fd);
  }

  assert.equal(readFileSync(logFile, 'utf8'), 'after\n');
  assert.equal(readFileSync(`${logFile}.1`, 'utf8'), 'before\n');
});