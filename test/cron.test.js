import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildCronContent, writeCronFile } from '../src/cron.js';

test('buildCronContent 生成 cron.d 所需用户字段并正确转义空格路径', () => {
  const content = buildCronContent('0 1 * * *', {
    appDir: '/app with space',
    nodePath: '/usr/local/bin/node',
    script: '/app with space/scripts/meimoai-checkin.js',
    logFile: '/app with space/logs/checkin.log',
    user: 'root',
  });

  assert.match(content, /^SHELL=\/bin\/bash$/m);
  assert.match(content, /^0 1 \* \* \* root /m);
  assert.match(content, /'\/app with space'/);
  assert.match(content, /'\/app with space\/scripts\/meimoai-checkin\.js'/);
});

test('writeCronFile 写入临时目录且内容可读取', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'meimoai-cron-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'meimoai-checkin');

  writeCronFile('30 2 * * *', {
    file,
    appDir: '/app',
    nodePath: '/usr/local/bin/node',
    script: '/app/scripts/meimoai-checkin.js',
    logFile: '/app/logs/checkin.log',
  });

  const content = await readFile(file, 'utf8');
  assert.match(content, /^30 2 \* \* \* root /m);
});

test('buildCronContent 拒绝非法表达式和非法用户', () => {
  assert.throws(() => buildCronContent('bad'), /CRON_SCHEDULE/);
  assert.throws(() => buildCronContent('0 1 * * *', { user: 'root; rm -rf /' }), /执行用户/);
});
