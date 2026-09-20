import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile, readdir, readFile } from 'fs/promises';
import { existsSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { acquireLock, isLocked } from '../src/lock.js';

test('跨进程锁拒绝重复获取并在释放后可再次获取', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'meimoai-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'checkin.lock');

  const first = acquireLock(file);
  assert.ok(first);
  assert.equal(isLocked(file), true);
  assert.equal(acquireLock(file), null);

  first.release();
  assert.equal(isLocked(file), false);

  const second = acquireLock(file);
  assert.ok(second);
  second.release();
});

test('acquireLock 清理持有进程已死亡的陈旧锁', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'meimoai-stale-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'checkin.lock');
  await writeFile(file, JSON.stringify({ pid: 99999999, startedAt: Date.now() }), 'utf8');

  const lock = acquireLock(file);
  assert.ok(lock);
  lock.release();
  // 隔离名不应残留
  const leftovers = (await readdir(dir)).filter((n) => n !== 'checkin.lock');
  assert.deepEqual(leftovers, []);
});

test('不会因 mtime 超时抢占仍存活的 PID', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'meimoai-live-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'checkin.lock');
  await writeFile(file, JSON.stringify({ pid: process.pid, startedAt: Date.now() - 7200000, token: 'live' }), 'utf8');
  await utimes(file, new Date(0), new Date(0));

  assert.equal(acquireLock(file), null);
  assert.equal(isLocked(file), true);
});

test('release 只删除自己 token 对应的锁', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'meimoai-owned-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'checkin.lock');

  const first = acquireLock(file);
  assert.ok(first);
  await rm(file);
  const second = acquireLock(file);
  assert.ok(second);

  first.release();
  assert.equal(isLocked(file), true);
  second.release();
  assert.equal(isLocked(file), false);
});

test('isLocked 对陈旧腐坏锁只读：返回 false 但不删除文件', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'meimoai-corrupt-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'checkin.lock');
  await writeFile(file, '{bad json', 'utf8');
  await utimes(file, new Date(0), new Date(0));

  assert.equal(isLocked(file), false);
  // 清理副作用交给 acquireLock，isLocked 必须保持纯读
  assert.equal(existsSync(file), true);
});

// 回归：缺少/非法 startedAt 的残留锁曾因 NaN !== NaN 让快照比对永远不相等，
// 结果旧锁既回收不掉、又被反复"放回"，手动签到被永久堵死。
test('缺少 startedAt 的残留锁仍能被回收，不会卡死', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'meimoai-lock-legacy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'checkin.lock');
  await writeFile(file, JSON.stringify({ pid: 99999999, token: 'legacy' }), 'utf8');

  const lock = acquireLock(file);
  assert.ok(lock, '缺失时间戳的残留锁必须能被回收');
  lock.release();
  const leftovers = (await readdir(dir)).filter((n) => n !== 'checkin.lock');
  assert.deepEqual(leftovers, []);
});

test('回收陈旧锁期间若目标已被新锁替换，会恢复新锁且不返回句柄', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'meimoai-reclaim-race-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'checkin.lock');
  const freshToken = 'fresh-lock-after-snapshot';
  await writeFile(file, JSON.stringify({ pid: 99999999, startedAt: Date.now(), token: 'stale' }), 'utf8');

  const lock = acquireLock(file, {
    beforeClaim() {
      unlinkSync(file);
      writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: freshToken }), 'utf8');
    },
  });

  assert.equal(lock, null, '检测到偷到新锁后不应返回持锁句柄');
  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(raw.token, freshToken, '新锁必须恢复到原路径');
  const leftovers = (await readdir(dir)).filter((n) => n !== 'checkin.lock');
  assert.deepEqual(leftovers, [], '恢复新锁后不应留下隔离文件');
});

// 回滚兜底：rename 之后、link 放回之前，原路径若已被第三个进程重建，
// linkSync 会因 EEXIST 失败。此时必须保住对方的新锁，并把隔离文件留下来待排查
// （宁可留下孤儿文件，也不能删掉正在被使用的锁）。
test('回收期间原路径已被他人重建时，保住对方新锁并保留隔离文件', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'meimoai-reclaim-eexist-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'checkin.lock');
  const competitorToken = 'competitor-lock';
  await writeFile(file, JSON.stringify({ pid: 99999999, startedAt: Date.now(), token: 'stale' }), 'utf8');

  const lock = acquireLock(file, {
    beforeClaim() {
      // 快照读取之后、rename 之前，主锁已被换成别人的新锁
      unlinkSync(file);
      writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: 'fresh-replaced' }), 'utf8');
    },
    afterClaim() {
      // rename 之后、link 放回之前，原路径又被第三个进程重建
      writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: competitorToken }), 'utf8');
    },
  });

  assert.equal(lock, null, '回滚失败时不能返回持锁句柄');
  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(raw.token, competitorToken, '第三方新锁必须保持原样');
  const quarantined = (await readdir(dir)).filter((n) => n.includes('.reclaim-'));
  assert.equal(quarantined.length, 1, '回滚失败时保留隔离文件，不误删也不静默丢弃');
  // 记录已知残留：被移走的那把锁（fresh-replaced）无法放回，只能留在隔离文件里。
  // 这正是 README「已知限制」里描述的最坏情形，改动时不要静默丢掉这条证据。
  const stranded = JSON.parse(await readFile(join(dir, quarantined[0]), 'utf8'));
  assert.equal(stranded.token, 'fresh-replaced', '隔离文件应保存被移走的锁内容');
});

// 回收竞态下，本进程刚建立的锁文件理论上可能被另一个清理者移走。
// handle 必须能自己察觉，调用方才能在打开 Firefox profile 前放弃。
test('已返回的 handle 在锁被移走后 verify() 变为 false', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'meimoai-lock-verify-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'checkin.lock');

  const lock = acquireLock(file);
  assert.ok(lock);
  assert.equal(lock.verify(), true, '刚拿到锁时应判定为持有');

  unlinkSync(file); // 模拟回收者把本进程的锁文件移走
  assert.equal(lock.verify(), false, '锁文件被移走后必须能察觉');
  lock.release(); // 此时 release 应是 no-op，且不抛错
});
