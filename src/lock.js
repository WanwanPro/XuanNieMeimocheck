// 跨进程互斥锁（文件锁）。
//
// 背景：cron 与 Web「手动签到」是两个独立进程，原来只用 Web 进程内的内存变量
// 互斥，cron 触发时会与手动签到同时打开同一个 Firefox profile，导致
// "profile is already in use" 或 profile 损坏。
// 这里用 fs.open(path,'wx') 的原子性 + PID 存活检测实现跨进程锁。
//
// 加固点：
//   - 锁内容带随机 token，release 只删除自己创建的锁，避免删除后来进程的锁。
//   - 陈旧锁回收的唯一仲裁点是 renameSync：并发时只有一个进程能把锁文件移走，
//     移走后回读隔离文件并与快照比对；若移走的是别人刚建的新锁，用 link 放回
//     （link 不覆盖已存在文件）并放弃，绝不 unlink 主锁。
//   - 刻意不再使用额外的 cleanup guard 文件：guard 的"判断陈旧 → 抢占"同样无法
//     原子化，只会在主锁之外再叠加一层"两个清理者同时进入"的竞态。
//   - isLocked() 只读，不产生任何清理副作用。
//
// 已知残留（best-effort 语义，不是严格互斥锁）：Node 没有内建的 flock/LockFileEx
// 封装，"读快照 → rename"之间仍有一个理论窗口（需要 ≥3 个签到进程微秒级交错）。
// 命中时的最坏结果是两个进程争用同一 Firefox profile（通常表现为启动失败），
// 并可能残留 `*.reclaim-*` 隔离文件。需要内核级保证时应改用 flock(1) 之类的 OS 锁。
import {
  closeSync, existsSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'fs';
import { randomBytes } from 'crypto';

const CORRUPT_LOCK_GRACE_MS = 5000;

function readJson(file) {
  try {
    const info = JSON.parse(readFileSync(file, 'utf8'));
    return info && typeof info === 'object' ? info : null;
  } catch {
    return null;
  }
}

function readLock(lockFile) {
  const info = readJson(lockFile);
  if (!info) return null;
  return {
    pid: Number(info.pid),
    startedAt: Number(info.startedAt),
    token: typeof info.token === 'string' ? info.token : '',
  };
}

/** 数值字段归一化：缺失/非法一律折成 null，避免 NaN !== NaN 让回收永远失败 */
function normalizeNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function sameLockSnapshot(a, b) {
  if (!a || !b) return !a && !b;
  return normalizeNumber(a.pid) === normalizeNumber(b.pid)
    && normalizeNumber(a.startedAt) === normalizeNumber(b.startedAt)
    && String(a.token ?? '') === String(b.token ?? '');
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function isStale(lockFile, info) {
  if (!info) {
    try {
      return Date.now() - statSync(lockFile).mtimeMs >= CORRUPT_LOCK_GRACE_MS;
    } catch {
      return false;
    }
  }
  return !isAlive(info.pid);
}

function tryUnlink(file) {
  try { unlinkSync(file); } catch { /* ignore */ }
}

/**
 * 回收陈旧锁：rename 到唯一隔离名是唯一的原子仲裁点。
 * 并发进程同时回收时只有一个能成功移走文件，其余拿到 ENOENT 直接放弃；
 * 移走后立刻回读隔离文件，确认它仍是"判定陈旧"时的那份快照，否则说明期间
 * 主锁已被重建 —— 用 link 放回原路径（不覆盖）后放弃。
 */
function reclaimStaleLock(lockFile, options = {}) {
  if (!existsSync(lockFile)) return false;
  const observed = readLock(lockFile);
  if (!isStale(lockFile, observed)) return false;

  if (typeof options.beforeClaim === 'function') options.beforeClaim();
  const claim = `${lockFile}.reclaim-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    renameSync(lockFile, claim);
  } catch {
    return false; // 被其它进程抢先移走
  }
  if (typeof options.afterClaim === 'function') options.afterClaim();

  if (!sameLockSnapshot(observed, readLock(claim))) {
    try {
      linkSync(claim, lockFile); // 目标已存在则 EEXIST，绝不覆盖
      tryUnlink(claim);
    } catch { /* 原路径已被第三个进程占用：保留隔离文件，绝不删除可能仍被持有的锁 */ }
    return false;
  }

  tryUnlink(claim);
  return true;
}

/**
 * 尝试获取锁。成功返回 handle，失败返回 null。
 * 若发现持有者进程已不存在（崩溃残留），会自动清理后重试一次。
 * options.beforeClaim / options.afterClaim 仅供测试注入回收时序，生产调用不传。
 */
export function acquireLock(lockFile, options = {}) {
  const token = randomBytes(16).toString('hex');

  const attempt = () => {
    let fd;
    let created = false;
    try {
      fd = openSync(lockFile, 'wx');
      created = true;
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now(), token }));
    } catch (err) {
      if (created) tryUnlink(lockFile);
      throw err;
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
    }

    // open + write 存在极短窗口；读回并核验 token，避免被并发清理后误以为自己持锁。
    const current = readLock(lockFile);
    if (!current || current.token !== token) return null;

    return {
      path: lockFile,
      token,
      /**
       * 锁是否仍由本进程持有。
       * 回收竞态理论上可能让本进程刚建立的锁文件被别人移走，
       * 调用方可在关键操作（如打开 Firefox profile）前复查一次。
       */
      verify() {
        const current = readLock(lockFile);
        return Boolean(current && current.token === token);
      },
      release() {
        const currentLock = readLock(lockFile);
        if (!currentLock || currentLock.token !== token) return;
        try { unlinkSync(lockFile); } catch { /* ignore */ }
      },
    };
  };

  try {
    const lock = attempt();
    if (lock) return lock;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  if (reclaimStaleLock(lockFile, options)) {
    try {
      return attempt();
    } catch (err) {
      if (err.code === 'EEXIST') return null;
      throw err;
    }
  }
  return null;
}

/** 锁是否被占用（用于 Web 端提示；纯读，不清理文件） */
export function isLocked(lockFile) {
  if (!existsSync(lockFile)) return false;
  const info = readLock(lockFile);
  if (!info) {
    // open 与首次写入之间有极短窗口；老旧腐坏文件视为陈旧，但不在这里删除。
    try {
      return Date.now() - statSync(lockFile).mtimeMs < CORRUPT_LOCK_GRACE_MS;
    } catch {
      return true;
    }
  }
  return isAlive(info.pid);
}
