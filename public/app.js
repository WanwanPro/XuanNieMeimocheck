'use strict';
/* ============================================================
   MeimoAI 值守台 · 前端逻辑
   全部事件通过 addEventListener 绑定（CSP 只允许外链脚本），
   页面不包含任何 onclick / onkeydown 内联处理器。
   ============================================================ */

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');

const STATUS_META = {
  success: { tone: 'ok', verb: '签到成功', pill: '成功' },
  already: { tone: 'ok', verb: '今日已签到', pill: '已完成' },
  clicked: { tone: 'warn', verb: '待人工确认', pill: '不确定' },
  skipped: { tone: 'warn', verb: '本次已跳过', pill: '已跳过' },
  error: { tone: 'err', verb: '签到失败', pill: '失败' },
};

const MODAL_ICONS = {
  loading: '<div class="spinner"></div>',
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  fail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
};

let authRequired = false;
let passwordEnabled = true;
let feishuEnabled = false;
let feishuAppId = '';
let feishuConfigProblems = [];
let authenticated = false;
let pendingAuthError = '';
let feishuSdkPromise = null;
let feishuAutoTried = false;
let feishuAutoRedirectBlocked = false;
let passwordFallbackOpen = false;
let cronSchedule = '';
let countdownTimer = null;
let clockTimer = null;
let checkinPollTimer = null;
let activeRunId = '';
let rawLogs = [];
let logLevel = 'all';
let logKeyword = '';
let shotObjectUrl = '';
let lastFocus = null;
let confirmResolver = null;
let checkinBtnHtml = '';
let toastTimer = null;

/* ---------------- 基础工具 ---------------- */

function escHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toast(msg, type) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show ' + (type || 'ok');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
}

function authHeaders() {
  return { 'Content-Type': 'application/json' };
}

function parseDate(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtDateTime(ts) {
  const d = parseDate(ts);
  if (!d) return '--';
  return d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16).replace('T', ' ');
}

function fmtShort(ts) {
  const v = fmtDateTime(ts);
  return v === '--' ? '--' : v.slice(5);
}

function fmtClock(ts) {
  const d = parseDate(ts);
  if (!d) return ts ? String(ts).slice(11, 19) : '';
  return d.toLocaleTimeString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false });
}

/* 把任意时刻映射成"北京墙上时间"的伪 UTC Date，便于做纯本地算术。 */
function bjWall(date) {
  const s = (date || new Date()).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
  return new Date(s.replace(' ', 'T') + 'Z');
}

function targetText(t) {
  return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate())
    + ' ' + pad(t.getUTCHours()) + ':' + pad(t.getUTCMinutes());
}

/* ---------------- cron 解析 ---------------- */

function cronField(spec, min, max) {
  const set = new Set();
  const parts = String(spec === null || spec === undefined ? '' : spec).split(',');
  if (!parts.length || parts.some((p) => !p.trim())) return null;
  for (const raw of parts) {
    const part = raw.trim();
    let m;
    if ((m = /^\*\/(\d+)$/.exec(part))) {
      const step = Number(m[1]);
      if (step < 1) return null;
      for (let i = min; i <= max; i += step) set.add(i);
    } else if (part === '*') {
      for (let i = min; i <= max; i++) set.add(i);
    } else if ((m = /^(\d+)-(\d+)(?:\/(\d+))?$/.exec(part))) {
      const from = Number(m[1]);
      const to = Number(m[2]);
      const step = Number(m[3] || 1);
      if (step < 1 || from > to || from < min || to > max) return null;
      for (let i = from; i <= to; i += step) set.add(i);
    } else if ((m = /^(\d+)$/.exec(part))) {
      const v = Number(m[1]);
      if (v < min || v > max) return null;
      set.add(v);
    } else {
      return null;
    }
  }
  return set.size ? set : null;
}

function validateCron(expr) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length !== 5) return false;
  const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  return f.every((field, i) => cronField(field, bounds[i][0], bounds[i][1]) !== null);
}

function nextRunDate(expr, from) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length !== 5) return null;
  const mins = cronField(f[0], 0, 59);
  const hours = cronField(f[1], 0, 23);
  const doms = cronField(f[2], 1, 31);
  const months = cronField(f[3], 1, 12);
  const dows = cronField(f[4], 0, 7);
  if (!mins || !hours || !doms || !months || !dows) return null;
  if (dows.has(7)) { dows.delete(7); dows.add(0); }

  const domRestricted = f[2].trim() !== '*';
  const dowRestricted = f[4].trim() !== '*';
  const base = new Date(bjWall(from || new Date()).getTime() + 60000);
  base.setUTCSeconds(0, 0);

  const minuteList = [...mins].sort((a, b) => a - b);
  const hourList = [...hours].sort((a, b) => a - b);
  const dayStart = new Date(base.getTime());
  dayStart.setUTCHours(0, 0, 0, 0);

  /* 逐天推进，最多覆盖 8 年：Gregorian 里最长的「下一个 2 月 29 日」间隔
     出现在世纪非闰年附近（如 2096-02-29 → 2104-02-29）。每天只检查
     月份/星期/日期，再按升序尝试小时和分钟，避免固定小窗口漏掉月度、
     年度或闰日规则。 */
  for (let dayOffset = 0; dayOffset <= 366 * 8 + 2; dayOffset++) {
    const day = new Date(dayStart.getTime() + dayOffset * 86400000);
    if (!months.has(day.getUTCMonth() + 1)) continue;
    const domOk = doms.has(day.getUTCDate());
    const dowOk = dows.has(day.getUTCDay());
    let dayOk = true;
    if (domRestricted && dowRestricted) dayOk = domOk || dowOk;
    else if (domRestricted) dayOk = domOk;
    else if (dowRestricted) dayOk = dowOk;
    if (!dayOk) continue;

    for (const hour of hourList) {
      for (const minute of minuteList) {
        const candidate = new Date(Date.UTC(
          day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute
        ));
        if (candidate.getTime() >= base.getTime()) return candidate;
      }
    }
  }
  return null;
}
/* ---------------- 倒计时 ---------------- */

function tickCountdown() {
  const el = $('countdown');
  const at = $('nextAt');
  if (!cronSchedule) { el.textContent = '--:--:--'; at.textContent = '未设置定时规则'; return; }
  const target = nextRunDate(cronSchedule);
  if (!target) { el.textContent = '--:--:--'; at.textContent = '无法解析该 cron 表达式'; return; }
  const diff = Math.max(0, target.getTime() - bjWall(new Date()).getTime());
  const total = Math.floor(diff / 1000);
  el.textContent = pad(Math.floor(total / 3600)) + ':' + pad(Math.floor((total % 3600) / 60)) + ':' + pad(total % 60);
  at.textContent = '北京时间 ' + targetText(target);
}

function startCountdown(expr) {
  cronSchedule = expr || '';
  $('scheduleText').textContent = cronSchedule || '未设置';
  $('scheduleText').title = cronSchedule;
  if (countdownTimer) clearInterval(countdownTimer);
  tickCountdown();
  countdownTimer = setInterval(tickCountdown, 1000);
}

/* ---------------- 时钟 ---------------- */

function updateClock() {
  const el = $('clockTime');
  if (!el) return;
  el.textContent = new Date().toLocaleTimeString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false });
}

/* ---------------- 弹层 ---------------- */

function openOverlay(id, focusId) {
  const el = $(id);
  if (!el) return;
  const alreadyOpen = el.classList.contains('show');
  if (!alreadyOpen) lastFocus = document.activeElement;
  el.classList.add('show');
  const focusTarget = (focusId && $(focusId)) || el.querySelector('.modal-card') || el;
  if (!focusTarget.hasAttribute('tabindex') && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(focusTarget.tagName || '')) {
    focusTarget.setAttribute('tabindex', '-1');
  }
  setTimeout(() => { try { focusTarget.focus(); } catch (e) { /* 忽略 */ } }, 40);
}

function closeOverlay(id) {
  const el = $(id);
  if (!el) return;
  el.classList.remove('show');
  const restore = lastFocus;
  lastFocus = null;
  if (restore && document.contains(restore)) { try { restore.focus(); } catch (e) { /* 忽略 */ } }
}

function showCheckinModal(icon, title, msgHtml, showClose) {
  const iconEl = $('modalIcon');
  iconEl.className = 'modal-icon ' + icon;
  iconEl.innerHTML = MODAL_ICONS[icon] || MODAL_ICONS.loading;
  $('modalTitle').textContent = title;
  $('modalMsg').innerHTML = msgHtml;
  $('modalCloseBtn').hidden = !showClose;
  openOverlay('checkinModal', showClose ? 'modalCloseBtn' : null);
}

function dismissCheckin() {
  if (checkinPollTimer) { clearInterval(checkinPollTimer); checkinPollTimer = null; }
  unlockCheckinBtn();
  closeOverlay('checkinModal');
}

function askConfirm(title, msg) {
  $('confirmTitle').textContent = title;
  $('confirmMsg').textContent = msg;
  openOverlay('confirmModal', 'confirmCancel');
  return new Promise((resolve) => { confirmResolver = resolve; });
}

function settleConfirm(value) {
  closeOverlay('confirmModal');
  if (confirmResolver) { const r = confirmResolver; confirmResolver = null; r(value); }
}

function openLightbox() {
  if (!$('lightboxImg').getAttribute('src')) { toast('暂无可用截图', 'fail'); return; }
  openOverlay('lightbox', 'lightboxClose');
}

/* ---------------- 渲染 ---------------- */

function setPill(el, text, tone) {
  el.textContent = text;
  if (tone) el.dataset.tone = tone; else delete el.dataset.tone;
}

function setGauge(gaugeId, barId, ratio, tone) {
  const value = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
  $(barId).style.width = (value * 100).toFixed(1) + '%';
  if (tone) $(gaugeId).dataset.tone = tone;
}

function renderHero(d) {
  const run = d.lastRun || null;
  const meta = STATUS_META[d.lastRunStatus] || { tone: '', verb: run ? '状态未知' : '暂无记录', pill: run ? '未知' : '未运行' };

  $('lastState').textContent = meta.verb;
  const dot = $('lastStateDot');
  if (meta.tone) dot.dataset.tone = meta.tone; else delete dot.dataset.tone;
  setPill($('lastPill'), meta.pill, meta.tone);

  let detail = '还没有运行记录，点击「手动签到」可以立即执行一次。';
  if (run) {
    if (d.lastRunStatus === 'success') detail = '余额 ' + (run.balanceAfter || '未识别') + (run.gained ? '，本次增加 ' + run.gained : '');
    else if (d.lastRunStatus === 'already') detail = '今天已经签到过了，余额 ' + (run.balanceAfter || '未识别');
    else if (d.lastRunStatus === 'clicked') detail = '页面已点击，但没有检测到成功文案，建议人工核对截图或登录站点确认。';
    else if (d.lastRunStatus === 'skipped') detail = '按跳过概率主动放弃本次执行，当天不会自动补签。';
    else if (d.lastRunStatus === 'error') detail = run.error ? String(run.error) : '签到过程中出现未知错误。';
  }
  $('lastDetail').textContent = detail;

  $('lastTime').textContent = fmtDateTime(run && run.ts);
  $('lastBalance').textContent = run && run.balanceAfter ? run.balanceAfter : '--';
  $('lastDuration').textContent = run && run.durationMs ? (run.durationMs / 1000).toFixed(1) + 's' : '--';
  $('lastTrigger').textContent = run ? (run.trigger === 'manual' ? '手动' : '定时') : '--';
}

function renderMetrics(d) {
  const cronOn = d.cronStatus === '已启用';
  setPill($('gCronStatus'), d.cronStatus || '--', cronOn ? 'ok' : 'warn');
  $('gCronSchedule').textContent = d.cronSchedule || '--';

  const nx = nextRunDate(d.cronSchedule);
  $('gNextRun').textContent = nx ? targetText(nx).slice(5) : '--';
  $('gRandomDelay').textContent = d.randomDelay === 'true' ? '开启 · 0 ~ ' + (d.randomDelayMax || 0) + ' 分钟' : '关闭';
  $('gLastSuccess').textContent = d.lastSuccessDate || '--';

  const maxFail = Number(d.maxConsecutiveFailures) || 0;
  const fails = Number(d.consecutiveFailures) || 0;
  const clicked = Number(d.consecutiveClicked) || 0;
  const skips = Number(d.consecutiveSkips) || 0;

  $('gFail').textContent = String(fails);
  $('gFailMax').textContent = String(maxFail);
  setGauge('gaugeFail', 'gFailBar', maxFail > 0 ? fails / maxFail : 0,
    maxFail > 0 && fails >= maxFail ? 'verm' : (fails > 0 ? 'amber' : 'jade'));

  $('gClicked').textContent = String(clicked);
  setGauge('gaugeClicked', 'gClickedBar', clicked / 5, clicked > 0 ? 'amber' : 'jade');

  $('gSkip').textContent = String(skips);
  setGauge('gaugeSkip', 'gSkipBar', skips / 5, skips > 0 ? 'amber' : 'jade');

  const prob = Number(d.skipProbability);
  $('gSkipProb').textContent = Number.isFinite(prob)
    ? (prob <= 0 ? '关闭 (0)' : (prob * 100).toFixed(prob * 100 % 1 ? 1 : 0) + '%')
    : '--';

  setPill($('gPause'), d.paused ? '已暂停' : '正常', d.paused ? 'err' : 'ok');
  $('gPause').title = d.pausedReason || '';
  $('resumeBtn').hidden = !d.paused;

  $('gAccount').textContent = d.account || '未设置';
  $('gUrl').textContent = d.url || '--';
  $('gLastChecked').textContent = d.lastCheckedDate || '--';
  setPill($('gScreenshot'), d.hasErrorScreenshot ? '有截图' : '无截图', d.hasErrorScreenshot ? 'err' : 'ok');
}

function renderHistory(d) {
  const list = $('historyList');
  const hist = Array.isArray(d.history) ? d.history : [];
  $('historyCount').textContent = hist.length ? hist.length + ' 条' : '';
  if (!hist.length) {
    list.innerHTML = '<li><div class="empty" style="width:100%"><b>暂无运行记录</b><span>每次签到结束后都会在这里留档</span></div></li>';
    return;
  }
  list.innerHTML = hist.map((h) => {
    const meta = STATUS_META[h.status] || { tone: '', verb: h.status || '未知' };
    const sub = fmtShort(h.ts) + ' · ' + (h.trigger === 'manual' ? '手动' : '定时');
    let gain = '';
    if (h.gained) gain = '+' + escHtml(h.gained);
    else if (h.balanceAfter) gain = '余额 ' + escHtml(h.balanceAfter);
    return '<li><span class="lamp"' + (meta.tone ? ' data-tone="' + meta.tone + '"' : '') + '></span>'
      + '<span class="hist-main"><b>' + escHtml(meta.verb) + '</b><span>' + escHtml(sub) + '</span></span>'
      + '<span class="hist-gain">' + gain + '</span></li>';
  }).join('');
}

async function loadScreenshot() {
  try {
    const r = await fetch('/api/screenshot?t=' + Date.now(), { headers: authHeaders(), cache: 'no-store' });
    if (r.status === 401) { checkAuth(); return; }
    if (!r.ok) return;
    const url = URL.createObjectURL(await r.blob());
    if (shotObjectUrl) URL.revokeObjectURL(shotObjectUrl);
    shotObjectUrl = url;
    $('screenshotImg').src = url;
    $('lightboxImg').src = url;
    $('lightboxDownload').href = url;
  } catch (e) { /* 截图加载失败不影响主流程 */ }
}

function renderShot(d) {
  const box = $('shotBox');
  if (!d.hasErrorScreenshot) {
    box.hidden = true;
    if (shotObjectUrl) { URL.revokeObjectURL(shotObjectUrl); shotObjectUrl = ''; }
    $('screenshotImg').removeAttribute('src');
    $('lightboxImg').removeAttribute('src');
    $('lightboxDownload').removeAttribute('href');
    return;
  }
  box.hidden = false;
  $('gShotTime').textContent = '截图时间 · ' + (d.screenshotTime || '未知');
  loadScreenshot();
}

function setBeacon(d) {
  const b = $('beacon');
  const txt = $('beaconText');
  if (!d) { b.dataset.tone = 'err'; txt.textContent = '连接异常'; return; }
  if (d.paused) { b.dataset.tone = 'err'; txt.textContent = '已熔断暂停'; return; }
  if (d.hasErrorScreenshot || Number(d.consecutiveFailures) > 0 || Number(d.consecutiveClicked) > 0) {
    b.dataset.tone = 'warn'; txt.textContent = '需要关注'; return;
  }
  if (d.cronStatus === '已启用') { b.dataset.tone = 'ok'; txt.textContent = '运行正常'; return; }
  b.dataset.tone = 'warn'; txt.textContent = '定时未启用';
}

async function loadStatus() {
  try {
    const r = await fetch('/api/status', { headers: authHeaders(), cache: 'no-store' });
    if (r.status === 401) { checkAuth(); return; }
    if (!r.ok) throw new Error('status ' + r.status);
    const d = await r.json();
    renderHero(d);
    renderMetrics(d);
    renderHistory(d);
    renderShot(d);
    setBeacon(d);
    startCountdown(d.cronSchedule);
  } catch (e) {
    setBeacon(null);
    toast('加载状态失败', 'fail');
  }
}

/* ---------------- 日志 ---------------- */

function parseLogLine(raw) {
  const m = /^(\S+)\s+\[(INFO|WARN|ERROR|STEP)\]\s*([\s\S]*)$/.exec(raw);
  if (m) return { ts: m[1], level: m[2], msg: m[3] };
  return { ts: '', level: '', msg: raw };
}

const HIGHLIGHT = /(签到成功|今日已签到|已经签到|已点击签到|签到失败|已跳过|跳过|风控|熔断|已暂停|人工确认|失败|错误|异常|超时|无法|拒绝)/g;
const BAD_WORD = /(失败|错误|异常|超时|无法|拒绝)/;

function renderLogs() {
  const box = $('logBox');
  const prevTop = box.scrollTop;
  const kw = logKeyword.trim().toLowerCase();
  const filtered = rawLogs.filter((line) => {
    const p = parseLogLine(line);
    if (logLevel !== 'all' && p.level !== logLevel) return false;
    if (kw && !line.toLowerCase().includes(kw)) return false;
    return true;
  });

  if (!filtered.length) {
    box.innerHTML = '<div class="empty"><b>' + (rawLogs.length ? '没有匹配的日志' : '暂无日志')
      + '</b><span>' + (rawLogs.length ? '换个级别或关键词再试试' : '签到运行后日志会显示在这里') + '</span></div>';
    return;
  }

  box.innerHTML = filtered.map((line) => {
    const p = parseLogLine(line);
    const lv = p.level || 'RAW';
    const msg = escHtml(p.msg).replace(HIGHLIGHT, (m) => '<span class="' + (BAD_WORD.test(m) ? 'hl-bad' : 'hl') + '">' + m + '</span>');
    return '<div class="ln" data-lv="' + lv + '">'
      + '<span class="ln-t">' + escHtml(fmtClock(p.ts)) + '</span>'
      + '<span class="ln-lv">' + escHtml(lv) + '</span>'
      + '<span class="ln-m">' + msg + '</span></div>';
  }).join('');

  if ($('autoScroll').checked) box.scrollTop = box.scrollHeight;
  else box.scrollTop = prevTop;
}

async function loadLogs(silent) {
  try {
    const r = await fetch('/api/logs?limit=400', { headers: authHeaders(), cache: 'no-store' });
    if (r.status === 401) { checkAuth(); return; }
    if (!r.ok) throw new Error('logs ' + r.status);
    const d = await r.json();
    rawLogs = Array.isArray(d.lines) ? d.lines : [];
    $('logCount').textContent = d.total ? d.total + ' 行' : '';
    renderLogs();
  } catch (e) {
    if (!silent) toast('加载日志失败', 'fail');
  }
}

function setLogLevel(level) {
  logLevel = level;
  document.querySelectorAll('.seg button[data-level]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.level === level));
  });
  renderLogs();
}

function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) resolve(); else reject(new Error('copy rejected'));
    } catch (e) { reject(e); }
  });
}

async function copyLogs() {
  if (!rawLogs.length) { toast('没有可复制的日志', 'fail'); return; }
  try {
    await copyText(rawLogs.join('\n'));
    toast('日志已复制到剪贴板');
  } catch (e) {
    toast('浏览器拒绝了复制操作', 'fail');
  }
}

async function clearLogs() {
  const ok = await askConfirm('清空日志与截图', '将删除全部运行日志和错误截图，此操作不可撤销。');
  if (!ok) return;
  try {
    const r = await fetch('/api/logs/clear', { method: 'POST', headers: authHeaders() });
    if (r.status === 401) { checkAuth(); return; }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { toast(d.error || '清空失败', 'fail'); return; }
    rawLogs = [];
    $('logCount').textContent = '';
    renderLogs();
    toast('日志与截图已清空');
    loadStatus();
  } catch (e) { toast('清空失败', 'fail'); }
}

/* ---------------- 配置 ---------------- */

function markDirty(state) {
  $('formDirty').hidden = !state;
}

function setFormMsg(text, tone) {
  const el = $('formMsg');
  el.textContent = text || '';
  el.className = 'form-msg' + (tone ? ' ' + tone : '');
}

function validateCronInput() {
  const input = $('cronInput');
  const hint = $('cronHint');
  const v = input.value.trim();
  if (!v) {
    input.setAttribute('aria-invalid', 'true');
    hint.className = 'field-hint err';
    hint.textContent = '定时规则不能为空，容器重启时会因为 cron 初始化失败而反复退出。';
    return true;
  }
  if (!validateCron(v)) {
    input.setAttribute('aria-invalid', 'true');
    hint.className = 'field-hint err';
    hint.textContent = '不是合法的 5 段 cron 表达式，例如 0 1 * * *。';
    return true;
  }
  input.removeAttribute('aria-invalid');
  hint.className = 'field-hint';
  const nx = nextRunDate(v);
  hint.textContent = nx ? '解析正常 · 下次执行：' + targetText(nx) + '（北京时间）' : '解析正常。';
  return false;
}

async function loadEnv() {
  try {
    const r = await fetch('/api/env', { headers: authHeaders(), cache: 'no-store' });
    if (r.status === 401) { checkAuth(); return; }
    if (!r.ok) throw new Error('env ' + r.status);
    const d = await r.json();
    const form = $('envForm');
    Object.keys(d).forEach((k) => {
      const field = form.querySelector('[name="' + k + '"]');
      if (field) field.value = d[k] === null || d[k] === undefined ? '' : d[k];
    });
    markDirty(false);
    setFormMsg('', '');
    validateCronInput();
  } catch (e) { /* 静默失败，避免打断主流程 */ }
}

async function saveEnv(e) {
  if (e) e.preventDefault();
  if (validateCronInput()) {
    toast('定时规则不合法，请先修正', 'fail');
    $('cronInput').focus();
    return;
  }
  const form = $('envForm');
  const data = {};
  new FormData(form).forEach((v, k) => { data[k] = v; });
  const btn = $('saveEnvBtn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '保存中…';
  setFormMsg('', '');
  try {
    const r = await fetch('/api/env', { method: 'POST', headers: authHeaders(), body: JSON.stringify(data) });
    if (r.status === 401) { checkAuth(); return; }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setFormMsg(d.error || '保存失败', 'err');
      toast(d.error || '保存失败', 'fail');
      return;
    }
    markDirty(false);
    if (d.passwordChanged) {
      setFormMsg('配置已保存，管理密码已变更，请重新登录。', 'ok');
      toast('配置已保存，请重新登录');
      checkAuth();
      return;
    }
    if (d.cronWarning) {
      setFormMsg(d.cronWarning, 'err');
      toast('配置已保存，但 cron 重载失败', 'fail');
    } else {
      setFormMsg('配置已保存', 'ok');
      toast('配置已保存');
    }
    await loadStatus();
    await loadEnv();
  } catch (err) {
    setFormMsg('保存失败：无法连接服务器', 'err');
    toast('保存失败', 'fail');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/* ---------------- 签到 ---------------- */

function lockCheckinBtn() {
  const btn = $('checkinBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner" style="width:15px;height:15px;border-width:2px"></span>签到中';
}

function unlockCheckinBtn() {
  const btn = $('checkinBtn');
  btn.disabled = false;
  if (checkinBtnHtml) btn.innerHTML = checkinBtnHtml;
}

function finishCheckin(d) {
  if (checkinPollTimer) { clearInterval(checkinPollTimer); checkinPollTimer = null; }
  unlockCheckinBtn();
  const result = d.lastResult || '';
  if (d.lastRunStatus === 'success') {
    showCheckinModal('success', '签到成功', escHtml(result), true);
  } else if (d.lastRunStatus === 'already') {
    showCheckinModal('success', '今日已签到', escHtml(result), true);
  } else if (d.lastRunStatus === 'clicked') {
    showCheckinModal('warn', '结果待人工确认', escHtml(result) + '<span class="detail">没有检测到成功文案，请人工核对页面状态。</span>', true);
  } else if (d.lastRunStatus === 'skipped') {
    showCheckinModal('warn', '本次已跳过', escHtml(result) + '<span class="detail">按概率跳过当天不会自动补签。</span>', true);
  } else {
    showCheckinModal('fail', '签到失败', escHtml(result || '签到过程中出现错误'), true);
  }
  loadStatus();
  loadLogs(true);
}

function pollCheckin(startedAt) {
  if (checkinPollTimer) clearInterval(checkinPollTimer);
  let ticks = 0;
  checkinPollTimer = setInterval(async () => {
    ticks += 1;
    try {
      const r = await fetch('/api/status', { headers: authHeaders(), cache: 'no-store' });
      if (r.status === 401) {
        if (checkinPollTimer) { clearInterval(checkinPollTimer); checkinPollTimer = null; }
        unlockCheckinBtn();
        closeOverlay('checkinModal');
        activeRunId = '';
        checkAuth();
        return;
      }
      const d = await r.json();
      const run = d.lastRun || {};
      const isThisRun = activeRunId
        ? run.runId === activeRunId
        : (!run.runId && Date.parse(run.ts || '') >= startedAt);
      if (isThisRun && STATUS_META[d.lastRunStatus]) { finishCheckin(d); return; }
    } catch (e) { /* 单次轮询失败不影响后续重试 */ }
    if (ticks >= 60) {
      clearInterval(checkinPollTimer);
      checkinPollTimer = null;
      closeOverlay('checkinModal');
      unlockCheckinBtn();
      toast('签到超时，请查看日志', 'fail');
      loadStatus();
      loadLogs(true);
    }
  }, 3000);
}

async function runCheckin() {
  const btn = $('checkinBtn');
  if (btn.disabled) return;
  lockCheckinBtn();
  try {
    const r = await fetch('/api/checkin', { method: 'POST', headers: authHeaders() });
    const body = await r.json().catch(() => ({}));
    if (r.status === 401) { checkAuth(); unlockCheckinBtn(); return; }
    if (!r.ok) {
      unlockCheckinBtn();
      showCheckinModal('fail', r.status === 409 ? '正在运行' : '无法启动', escHtml(body.error || '签到任务启动失败'), true);
      return;
    }
    activeRunId = body.runId || '';
    showCheckinModal('loading', '正在签到', '<span class="dots"><i></i><i></i><i></i></span>正在浏览器中执行签到，请保持页面打开', false);
    pollCheckin(Date.now());
  } catch (e) {
    unlockCheckinBtn();
    showCheckinModal('fail', '连接失败', '无法连接服务器，请检查容器是否正在运行。', true);
  }
}

async function resumeSchedule() {
  const btn = $('resumeBtn');
  btn.disabled = true;
  try {
    const r = await fetch('/api/state/resume', { method: 'POST', headers: authHeaders() });
    if (r.status === 401) { checkAuth(); return; }
    const d = await r.json().catch(() => ({}));
    if (r.ok) { toast('已恢复定时签到'); await loadStatus(); }
    else toast(d.error || '恢复失败', 'fail');
  } catch (e) {
    toast('恢复失败', 'fail');
  } finally {
    btn.disabled = false;
  }
}

async function refreshWithBtn(btn) {
  if (btn.disabled) return;
  const html = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px"></span>刷新中';
  try {
    await Promise.all([loadStatus(), loadLogs(true)]);
  } finally {
    btn.disabled = false;
    btn.innerHTML = html;
  }
}

/* ---------------- 认证 ---------------- */

/* 飞书客户端（含手机端）UA 判定：国际版 Lark、国内版 Feishu 都会命中 */
const FEISHU_UA_RE = /(Lark|Feishu)/i;
const AUTH_ERROR_TEXT = {
  disabled: '飞书登录未启用，请使用管理密码进入。',
  denied: '已取消飞书授权，可重新点击飞书登录。',
  state: '登录会话已过期或被重复使用，请重新发起飞书登录。',
  exchange: '飞书授权码校验失败，请稍后重试或改用管理密码。',
  userinfo: '无法读取飞书用户信息，请确认应用权限已开通且版本已发布。',
  forbidden: '当前飞书账号不在允许名单内，请联系管理员加入 open_id 或企业 tenant_key。',
  unavailable: '飞书登录服务暂时不可用，请稍后重试或改用管理密码。',
};

function setGateError(msg) {
  const el = $('loginError');
  if (!msg) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = msg;
}

function setGateInfo(msg) {
  const el = $('gateInfo');
  if (!el) return;
  if (!msg) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = msg;
}

function isFeishuClient() {
  try {
    if (new URLSearchParams(location.search).get('feishu') === '1') return true;
    if (FEISHU_UA_RE.test(navigator.userAgent || '')) return true;
    return Boolean(window.h5sdk || window.tt || window.ttJSBridge || window.lark);
  } catch (e) {
    return false;
  }
}

function setGateBusy(btn, busy, busyText) {
  if (!btn) return;
  if (busy) {
    if (!btn.dataset.label) btn.dataset.label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner spinner-sm"></span>' + escHtml(busyText || '处理中…');
  } else {
    btn.disabled = false;
    if (btn.dataset.label) { btn.innerHTML = btn.dataset.label; delete btn.dataset.label; }
  }
}

function showMain() {
  $('loginOverlay').hidden = true;
  $('mainContent').hidden = false;
  $('logoutBtn').hidden = !authRequired;
  loadStatus();
  loadEnv();
  loadLogs(true);
}

function updateGateCopy() {
  const sub = $('gateSub');
  if (sub) {
    if (passwordFallbackOpen) sub.textContent = '输入管理密码以进入控制面板';
    else if (feishuEnabled) {
      sub.textContent = isFeishuClient()
        ? '正在使用飞书账号免密登录'
        : '打开后将自动前往飞书扫码登录';
    } else {
      sub.textContent = passwordEnabled ? '输入管理密码以进入控制面板' : '当前没有可用的登录方式';
    }
  }
  const hint = $('feishuHint');
  if (!hint || !feishuEnabled) return;
  if (pendingAuthError) hint.textContent = '自动跳转已暂停，点击上方按钮可重试飞书授权';
  else if (isFeishuClient()) hint.textContent = '已检测到飞书客户端，将自动尝试免密登录';
  else hint.textContent = '页面打开后会自动前往飞书授权页，可直接扫码登录';
}

function setPasswordFallback(open, focusPassword = false) {
  passwordFallbackOpen = Boolean(open && passwordEnabled);
  const pane = $('passwordPane');
  if (pane) pane.hidden = !passwordFallbackOpen;
  const divider = $('gateDivider');
  if (divider) divider.hidden = !passwordFallbackOpen;
  const form = $('loginForm');
  if (form) form.hidden = !passwordFallbackOpen;
  const mark = $('gateMark');
  if (mark) {
    mark.disabled = !passwordEnabled;
    mark.setAttribute('aria-expanded', String(passwordFallbackOpen));
    mark.setAttribute('aria-label', passwordFallbackOpen ? '隐藏管理密码登录' : '显示管理密码登录');
  }
  updateGateCopy();
  if (passwordFallbackOpen && focusPassword) {
    setTimeout(() => { try { $('loginPassword').focus(); } catch (e) { /* 忽略 */ } }, 60);
  }
}

function togglePasswordFallback() {
  if (!passwordEnabled) return;
  setPasswordFallback(!passwordFallbackOpen, !passwordFallbackOpen);
}

function applyGateOptions() {
  $('feishuPane').hidden = !feishuEnabled;
  setPasswordFallback(passwordEnabled && !feishuEnabled, false);
}

/* 读取服务端回调带回来的稳定错误码（不把内部细节写进 URL） */
function readAuthErrorFromUrl() {
  let code = '';
  try {
    const params = new URLSearchParams(location.search);
    code = params.get('auth_error') || '';
  } catch (e) { /* 老浏览器忽略 */ }
  if (!code) return false;
  pendingAuthError = AUTH_ERROR_TEXT[code] || AUTH_ERROR_TEXT.unavailable;
  feishuAutoRedirectBlocked = true;
  try {
    const url = new URL(location.href);
    url.searchParams.delete('auth_error');
    history.replaceState(null, '', url.pathname + (url.search ? url.search : '') + url.hash);
  } catch (e) { /* 忽略 */ }
  return true;
}

/* 免登链路各段超时：SDK 加载与签名获取属"管道"，短超时快速失败；
   授权码要等用户在确认框上点「允许」，必须给足时间，否则晚到的 code 会被丢弃。 */
const FEISHU_SDK_TIMEOUT_MS = 8000;
const FEISHU_BRIDGE_TIMEOUT_MS = 2000;
const FEISHU_CONFIG_TIMEOUT_MS = 8000;
const FEISHU_AUTH_CODE_TIMEOUT_MS = 60000;
const FEISHU_AUTH_CODE_RETRY_DELAY_MS = 350;
const FEISHU_AUTH_CODE_RETRIES = 1;

/** 给 Promise 加超时；超时不取消底层操作，只让上层不再无限等待 */
function withTimeout(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).then(
    (value) => { clearTimeout(timer); return value; },
    (err) => { clearTimeout(timer); throw err; },
  );
}

function loadFeishuSdk() {
  if (window.h5sdk && window.tt) return Promise.resolve();
  if (feishuSdkPromise) return feishuSdkPromise;
  feishuSdkPromise = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    const script = document.createElement('script');
    script.src = '/vendor/feishu-h5-sdk.js';
    script.async = true;
    script.onload = () => {
      if (window.h5sdk && window.tt) finish(resolve);
      else finish(reject, new Error('飞书 JSAPI 未注入全局对象'));
    };
    script.onerror = () => finish(reject, new Error('飞书 JSAPI 加载失败'));
    document.head.appendChild(script);
    setTimeout(() => finish(reject, new Error('飞书 JSAPI 加载超时')), FEISHU_SDK_TIMEOUT_MS);
  });
  feishuSdkPromise.catch(() => { feishuSdkPromise = null; });
  return feishuSdkPromise;
}

function requestFeishuConfig() {
  const pageUrl = location.href.split('#')[0];
  return withTimeout(
    fetch('/api/auth/feishu/jsapi-config?url=' + encodeURIComponent(pageUrl), { cache: 'no-store' })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.ok) throw new Error(d.error || 'JSAPI 签名获取失败');
        return d;
      }),
    FEISHU_CONFIG_TIMEOUT_MS,
    '飞书 JSAPI 签名获取超时',
  );
}

/* requestAuthCode 官方示例只要求 h5sdk.ready + requestAuthCode，不需要 h5sdk.config。
   手机端首次自动免登时原生 bridge 可能稍晚才就绪；先调 config 会让 ready() 等待
   一个可能丢失的回调，表现就是第一次一直转圈、手动第二次点才成功。 */
function hasFeishuNativeBridge() {
  try {
    const webkit = window.webkit && window.webkit.messageHandlers;
    return Boolean(
      window.Lark_Bridge
      || (webkit && (webkit.invoke || webkit.invokeNative))
      || (window.LkWebViewJavascriptBridge && typeof window.LkWebViewJavascriptBridge.callHandler === 'function')
      || (window.WebViewJavascriptBridge && typeof window.WebViewJavascriptBridge.invoke === 'function')
      || (window.__LarkPCSDK__ && window.__LarkPCSDK__.bridge)
    );
  } catch (e) {
    return false;
  }
}

function waitForFeishuBridge(timeoutMs = FEISHU_BRIDGE_TIMEOUT_MS) {
  if (hasFeishuNativeBridge()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const events = ['WebViewJavascriptBridgeReady', 'LkWebViewJavascriptBridgeReady', 'LarkConfigReady'];
    const finish = (ready) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      events.forEach((name) => window.removeEventListener(name, check));
      resolve(ready);
    };
    const check = () => { if (hasFeishuNativeBridge()) finish(true); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const poll = setInterval(check, 50);
    events.forEach((name) => window.addEventListener(name, check));
    check();
  });
}

function normalizeFeishuJsapiError(err, fallback) {
  if (err instanceof Error) return err;
  const code = err && (err.errCode !== undefined ? err.errCode : err.errno);
  const message = err && (err.errMsg || err.errorMessage || err.message);
  const text = [message, code === undefined || code === null || code === '' ? '' : `code=${code}`]
    .filter(Boolean).join(' ');
  const error = new Error(text || fallback);
  if (code !== undefined && code !== null) error.code = code;
  return error;
}

function isRetryableFeishuJsapiError(err) {
  const message = String((err && (err.message || err.errMsg)) || err || '');
  if (/cancel|denied|拒绝|取消|超时|timeout/i.test(message)) return false;
  const code = err && err.code;
  return !['denied', 'forbidden', 'disabled', 'state', 'csrf'].includes(String(code || ''));
}

function invokeFeishuAuthCode(config) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    try {
      if (typeof window.h5sdk.error === 'function') {
        window.h5sdk.error((err) => { console.warn('h5sdk error:', err); });
      }
      window.h5sdk.ready(() => {
        if (!window.tt || typeof window.tt.requestAuthCode !== 'function') {
          finish(reject, new Error('当前环境不支持飞书免登接口'));
          return;
        }
        try {
          window.tt.requestAuthCode({
            appId: config.appId,
            success: (res) => {
              const code = res && (res.code || res.authCode);
              if (code) finish(resolve, code);
              else finish(reject, new Error('未取得授权码'));
            },
            fail: (err) => finish(reject, normalizeFeishuJsapiError(err, '免登授权被拒绝')),
          });
        } catch (err) {
          finish(reject, normalizeFeishuJsapiError(err, '免登调用异常'));
        }
      });
    } catch (err) {
      finish(reject, normalizeFeishuJsapiError(err, '免登调用异常'));
    }
    setTimeout(() => finish(reject, new Error('飞书免登超时')), FEISHU_AUTH_CODE_TIMEOUT_MS);
  });
}

async function requestFeishuAuthCode(config) {
  await waitForFeishuBridge();
  let lastError = null;
  for (let attempt = 0; attempt <= FEISHU_AUTH_CODE_RETRIES; attempt++) {
    try {
      return await invokeFeishuAuthCode(config);
    } catch (err) {
      lastError = err;
      if (attempt >= FEISHU_AUTH_CODE_RETRIES || !isRetryableFeishuJsapiError(err)) throw err;
      console.warn('飞书免登首次失败，自动重试：', err);
      await new Promise((resolve) => setTimeout(resolve, FEISHU_AUTH_CODE_RETRY_DELAY_MS));
    }
  }
  throw lastError;
}

async function tryFeishuJsapi() {
  if (!feishuEnabled || !feishuAppId) return false;
  const hint = $('feishuHint');
  try {
    if (hint) hint.textContent = '正在飞书客户端内免密登录…';
    await loadFeishuSdk();
    const config = await requestFeishuConfig();
    const code = await requestFeishuAuthCode(config);
    if (!code) throw new Error('未取得授权码');
    const r = await fetch('/api/auth/feishu/jsapi', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, nonce: config.nonce }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) {
      throw new Error(AUTH_ERROR_TEXT[d.error] || '免登校验未通过');
    }
    authenticated = true;
    setGateError('');
    setGateInfo('');
    showMain();
    return true;
  } catch (err) {
    if (hint) hint.textContent = '免登未成功，点击下方按钮继续飞书授权登录';
    return false;
  }
}

function doFeishuLogin() {
  if (!feishuEnabled) return;
  const btn = $('feishuLoginBtn');
  if (!isFeishuClient()) {
    window.location.href = '/api/auth/feishu/start';
    return;
  }
  setGateBusy(btn, true, '飞书免登中…');
  tryFeishuJsapi().then((ok) => {
    setGateBusy(btn, false);
    if (!ok) window.location.href = '/api/auth/feishu/start';
  });
}

async function checkAuth(options = {}) {
  const allowAutoFeishuRedirect = options.allowAutoFeishuRedirect !== false;
  readAuthErrorFromUrl();
  try {
    const r = await fetch('/api/auth-status', { cache: 'no-store' });
    const d = await r.json();
    authRequired = Boolean(d.authRequired);
    passwordEnabled = d.passwordEnabled !== false;
    feishuEnabled = Boolean(d.feishuEnabled);
    feishuAppId = d.feishuAppId || '';
    feishuConfigProblems = Array.isArray(d.feishuConfigProblems) ? d.feishuConfigProblems : [];
    authenticated = Boolean(d.authenticated);
  } catch (e) {
    toast('无法连接服务器', 'fail');
    $('mainContent').hidden = true;
    $('loginOverlay').hidden = false;
    setGateError('无法连接服务器，请检查容器是否正在运行。');
    return;
  }

  if (authenticated || !authRequired) {
    pendingAuthError = '';
    feishuAutoRedirectBlocked = false;
    setGateError('');
    showMain();
    return;
  }

  $('mainContent').hidden = true;
  $('loginOverlay').hidden = false;
  applyGateOptions();
  setGateError(pendingAuthError || '');
  const info = pendingAuthError
    ? (passwordEnabled ? '点击上方 logo 可展开管理密码入口。' : '')
    : (feishuConfigProblems.length
      ? '飞书 SSO 已开启但配置不完整：' + feishuConfigProblems.join('、')
      : (feishuEnabled && !passwordEnabled
        ? '未设置管理密码：当前仅飞书 SSO 可登录，请确保飞书配置长期有效。'
        : ''));
  setGateInfo(info);
  updateGateCopy();

  if (feishuEnabled && !isFeishuClient() && allowAutoFeishuRedirect && !feishuAutoRedirectBlocked) {
    feishuAutoRedirectBlocked = true;
    setGateBusy($('feishuLoginBtn'), true, '正在前往飞书扫码…');
    window.location.href = '/api/auth/feishu/start';
    return;
  }

  if (feishuEnabled && isFeishuClient() && !feishuAutoTried) {
    feishuAutoTried = true;
    const btn = $('feishuLoginBtn');
    setGateBusy(btn, true, '飞书免登中…');
    tryFeishuJsapi().then((ok) => {
      setGateBusy(btn, false);
      updateGateCopy();
      if (!ok) {
        setGateInfo(passwordEnabled
          ? '免登未成功，点击上方 logo 可展开管理密码入口，或点击飞书按钮重试。'
          : '免登未成功，请点击飞书按钮重试。');
      }
    });
  } else if (passwordFallbackOpen) {
    setTimeout(() => { try { $('loginPassword').focus(); } catch (e) { /* 忽略 */ } }, 80);
  }
}

async function doLogin(e) {
  if (e) e.preventDefault();
  const btn = $('loginBtn');
  const label = btn.textContent;
  const password = $('loginPassword').value;
  btn.disabled = true;
  btn.textContent = '验证中…';
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.ok && d.authenticated === true) {
      authRequired = Boolean(d.authRequired);
      authenticated = true;
      setGateError('');
      $('loginPassword').value = '';
      showMain();
    } else if (r.ok && d.ok) {
      // 服务端明确回包“未认证”（例如飞书 SSO 未就绪且未设置管理密码），不能当成功处理。
      authenticated = false;
      setGateError(d.error || '认证尚未就绪，请检查飞书或管理密码配置');
    } else {
      setGateError(d.error || '密码错误');
      if (passwordEnabled) $('loginPassword').select();
    }
  } catch (err) {
    setGateError('无法连接服务器');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function logout() {
  try { await fetch('/api/logout', { method: 'POST', headers: authHeaders() }); } catch (e) { /* 忽略 */ }
  rawLogs = [];
  authenticated = false;
  feishuAutoTried = false;
  pendingAuthError = '';
  feishuAutoRedirectBlocked = true;
  checkAuth({ allowAutoFeishuRedirect: false });
}

/* ---------------- 设置面板 ---------------- */

function toggleSettings() {
  const panel = $('settingsPanel');
  const body = $('settingsBody');
  const open = !body.classList.contains('open');
  body.classList.toggle('open', open);
  panel.classList.toggle('open', open);
  $('settingsToggle').setAttribute('aria-expanded', String(open));
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  $('loginForm').addEventListener('submit', doLogin);
  $('gateMark').addEventListener('click', togglePasswordFallback);
  $('feishuLoginBtn').addEventListener('click', doFeishuLogin);
  $('logoutBtn').addEventListener('click', logout);

  $('checkinBtn').addEventListener('click', runCheckin);
  $('refreshBtn').addEventListener('click', (e) => refreshWithBtn(e.currentTarget));
  $('resumeBtn').addEventListener('click', resumeSchedule);

  const settingsToggle = $('settingsToggle');
  settingsToggle.addEventListener('click', toggleSettings);
  settingsToggle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSettings(); }
  });

  $('envForm').addEventListener('submit', saveEnv);
  $('envForm').addEventListener('input', (e) => {
    markDirty(true);
    setFormMsg('', '');
    if (e.target && e.target.id === 'cronInput') validateCronInput();
  });
  $('envForm').addEventListener('change', () => markDirty(true));
  $('cronInput').addEventListener('blur', validateCronInput);

  $('logsRefreshBtn').addEventListener('click', () => loadLogs());
  $('clearLogsBtn').addEventListener('click', clearLogs);
  $('logCopyBtn').addEventListener('click', copyLogs);
  $('logSearch').addEventListener('input', (e) => { logKeyword = e.target.value; renderLogs(); });
  $('logWrap').addEventListener('change', (e) => {
    const box = $('logBox');
    box.classList.toggle('wrap-soft', e.target.checked);
    box.classList.toggle('wrap-off', !e.target.checked);
  });
  document.querySelectorAll('.seg button[data-level]').forEach((b) => {
    b.addEventListener('click', () => setLogLevel(b.dataset.level));
  });

  $('modalCloseBtn').addEventListener('click', dismissCheckin);
  $('confirmCancel').addEventListener('click', () => settleConfirm(false));
  $('confirmOk').addEventListener('click', () => settleConfirm(true));

  $('screenshotImg').addEventListener('click', openLightbox);
  $('shotOpen').addEventListener('click', openLightbox);
  $('lightboxClose').addEventListener('click', () => closeOverlay('lightbox'));
  $('lightbox').addEventListener('click', (e) => { if (e.target === $('lightbox')) closeOverlay('lightbox'); });
  $('checkinModal').addEventListener('click', (e) => {
    if (e.target === $('checkinModal') && !$('modalCloseBtn').hidden) dismissCheckin();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($('lightbox').classList.contains('show')) { closeOverlay('lightbox'); return; }
    if ($('confirmModal').classList.contains('show')) { settleConfirm(false); return; }
    if ($('checkinModal').classList.contains('show') && !$('modalCloseBtn').hidden) dismissCheckin();
  });
}

/* ---------------- 启动 ---------------- */

function init() {
  checkinBtnHtml = $('checkinBtn').innerHTML;
  bindEvents();
  updateClock();
  clockTimer = setInterval(updateClock, 1000);

  /* 面板可见时保持轻度自动刷新，切到后台就停 */
  setInterval(() => {
    if (document.visibilityState !== 'visible' || $('mainContent').hidden) return;
    loadStatus();
  }, 30000);
  setInterval(() => {
    if (document.visibilityState !== 'visible' || $('mainContent').hidden) return;
    loadLogs(true);
  }, 15000);

  checkAuth();
}

init();
