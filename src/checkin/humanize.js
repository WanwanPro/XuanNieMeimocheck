// 人类行为模拟：延时分布、贝塞尔鼠标轨迹、带纠错的键盘输入、滚动与预热。
//
// 相比旧版（mouse.move 直线插值 + 均匀随机延时 + 固定速率打字），
// 这里的关键改进：
//   1. 延时用对数正态采样，而不是均匀分布（真人操作间隔是右偏的）
//   2. 鼠标走三次贝塞尔曲线 + 缓动，且逐步变速
//   3. 打字有概率打错并回退纠正，偶尔停顿
//   4. 进入页面先"预热"（滚动 / 悬停 / 发呆）

export function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/** Box-Muller 正态采样 */
export function gaussian(mean = 0, sd = 1) {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * 在 [min, max] 内采样一个"人类式"的操作间隔。
 * 对数正态分布（右偏），skew 控制众数位置。
 */
export function sampleDuration(min, max, skew = 0.45) {
  if (max <= min) return Math.max(0, min);
  const mode = min + (max - min) * skew;
  const mu = Math.log(Math.max(1, mode));
  const sigma = 0.55;
  for (let i = 0; i < 8; i += 1) {
    const v = Math.exp(gaussian(mu, sigma));
    if (v >= min && v <= max) return Math.round(v);
  }
  return Math.round(min + Math.random() * (max - min));
}

export async function humanDelay(min = 500, max = 1800) {
  await sleep(sampleDuration(min, max));
}

export async function humanIdle(min = 800, max = 2400) {
  await humanDelay(min, max);
}

// ---------------------------------------------------------------- 鼠标轨迹

function cubicBezier(t, p0, p1, p2, p3) {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
}

/** 生成 from -> to 的贝塞尔轨迹点（含轻微抖动） */
export function buildPath(from, to, { spread = 0.22 } = {}) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  const nx = dist === 0 ? 0 : -dy / dist;
  const ny = dist === 0 ? 0 : dx / dist;

  const bend = () => dist * spread * (0.2 + Math.random() * 0.6) * (Math.random() < 0.5 ? -1 : 1);
  const b1 = bend();
  const b2 = bend();
  const c1 = { x: from.x + dx * 0.3 + nx * b1, y: from.y + dy * 0.3 + ny * b1 };
  const c2 = { x: from.x + dx * 0.7 + nx * b2, y: from.y + dy * 0.7 + ny * b2 };

  const steps = clamp(Math.round(dist / 12) + randomInt(6, 14), 12, 60);
  const points = [];
  for (let i = 1; i <= steps; i += 1) {
    const lin = i / steps;
    // easeInOutQuad：起步与收尾更慢（点更密集 => 看起来更慢）
    const t = lin < 0.5 ? 2 * lin * lin : 1 - ((-2 * lin + 2) ** 2) / 2;
    points.push({
      x: cubicBezier(t, from.x, c1.x, c2.x, to.x) + gaussian(0, 0.7),
      y: cubicBezier(t, from.y, c1.y, c2.y, to.y) + gaussian(0, 0.7),
    });
  }
  return points;
}

let lastMouse = null;

/** 重置记录的鼠标位置（新页面 / 新会话时调用） */
export function resetMousePointer(viewport) {
  const vp = viewport || { width: 1280, height: 800 };
  lastMouse = {
    x: randomInt(Math.round(vp.width * 0.2), Math.round(vp.width * 0.8)),
    y: randomInt(Math.round(vp.height * 0.2), Math.round(vp.height * 0.7)),
  };
}

async function currentPointer(page) {
  if (!lastMouse) resetMousePointer(page.viewportSize());
  return lastMouse;
}

/** 沿贝塞尔曲线把鼠标移到目标点 */
export async function humanMove(page, target) {
  const from = await currentPointer(page);
  const path = buildPath(from, target);
  let prev = from;
  for (const point of path) {
    const seg = Math.hypot(point.x - prev.x, point.y - prev.y);
    await page.mouse.move(point.x, point.y, { steps: 1 });
    // 位移越大越快：约 0.35ms/px，叠加抖动，夹在 1~22ms
    await sleep(clamp(seg * 0.35 + gaussian(0, 1.2), 1, 22));
    prev = point;
  }
  lastMouse = { x: target.x, y: target.y };
}

/** 在视口内随机"闲逛"一次 */
export async function humanWander(page) {
  const size = page.viewportSize() || { width: 1280, height: 800 };
  const target = {
    x: randomInt(40, Math.max(80, size.width - 40)),
    y: randomInt(60, Math.max(120, size.height - 60)),
  };
  await humanMove(page, target);
}

// ---------------------------------------------------------------- 点击

export async function humanClick(locator, { timeout = 3000 } = {}) {
  const target = locator.first();
  await target.waitFor({ state: 'visible', timeout });
  await humanDelay(280, 1100);

  const box = await target.boundingBox();
  const page = target.page();
  if (!box) {
    await target.click({ timeout });
    await humanDelay();
    return;
  }

  const point = {
    x: box.x + box.width * (0.28 + Math.random() * 0.44),
    y: box.y + box.height * (0.32 + Math.random() * 0.36),
  };

  await humanMove(page, point);
  await humanDelay(90, 320);
  await page.mouse.down();
  await sleep(randomInt(45, 140));
  await page.mouse.up();
  await humanDelay(600, 1800);
}

/** 依次尝试多个候选选择器，命中即返回 true */
export async function maybeClick(page, candidates, timeout = 2500) {
  for (const candidate of candidates) {
    const locator = typeof candidate === 'string' ? page.locator(candidate) : candidate;
    try {
      await humanClick(locator, { timeout });
      return true;
    } catch (err) {
      // 页面/浏览器已关闭等致命错误不能伪装成“选择器未命中”。
      if (/Target page, context or browser has been closed|Target closed|browser has been closed|Target crashed/i.test(err && err.message ? err.message : '')) {
        throw err;
      }
      // 尝试下一个候选
    }
  }
  return false;
}

// ---------------------------------------------------------------- 键盘

const NEIGHBORS = {
  a: 's', b: 'v', c: 'x', d: 'f', e: 'r', f: 'g', g: 'h', h: 'j', i: 'o',
  j: 'k', k: 'l', l: 'm', m: 'n', n: 'b', o: 'p', p: 'o', q: 'w', r: 't',
  s: 'd', t: 'y', u: 'i', v: 'c', w: 'e', x: 'z', y: 'u', z: 'x',
};

function typoFor(ch) {
  if (/[0-9]/.test(ch)) return String(randomInt(0, 9));
  const lower = ch.toLowerCase();
  const repl = NEIGHBORS[lower];
  if (!repl) return null;
  return ch === lower ? repl : repl.toUpperCase();
}

/**
 * 逐字输入，带偶发打错 + 退格纠正 + 偶发停顿。
 */
export async function humanType(locator, text, { typoChance = 0.07, minDelay = 55, maxDelay = 185 } = {}) {
  await locator.click({ timeout: 5000 });
  await locator.fill('');
  await humanDelay(200, 600);

  for (const ch of text) {
    if (Math.random() < typoChance) {
      const wrong = typoFor(ch);
      if (wrong && wrong !== ch) {
        await locator.pressSequentially(wrong, { delay: randomInt(minDelay, maxDelay) });
        await humanDelay(120, 420);
        await locator.press('Backspace');
        await humanDelay(90, 300);
      }
    }
    await locator.pressSequentially(ch, { delay: randomInt(minDelay, maxDelay) });
    if (Math.random() < 0.06) await humanDelay(400, 1100);
  }
}

// ---------------------------------------------------------------- 滚动 / 预热

export async function humanScroll(page, { chance = 0.45 } = {}) {
  if (Math.random() > chance) return;
  const rounds = randomInt(1, 3);
  for (let i = 0; i < rounds; i += 1) {
    await page.mouse.wheel(0, randomInt(90, 420));
    await humanDelay(280, 900);
  }
}

/** 进入站点后的"预热"：发呆 + 滚动 + 鼠标闲逛 + 再发呆 */
export async function humanWarmup(page, { minMs = 1500, maxMs = 5000 } = {}) {
  await humanDelay(minMs, maxMs);
  await humanScroll(page, { chance: 0.8 });
  for (let i = 0; i < randomInt(1, 3); i += 1) {
    await humanWander(page);
    await humanDelay(300, 1100);
  }
  await humanDelay(800, 2400);
}
