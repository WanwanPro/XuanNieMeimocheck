// 推送通道：Wanwan / PushPlus / ServerChan / 自定义 Webhook。
// 各通道有独立的正文格式（纯文本 / HTML / Markdown），内容与原实现保持一致。
import { beijingTime } from './logger.js';

const SEP = '━━━━━━━━━━━━━━━━';
const PUSH_TIMEOUT_MS = 15000;

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function screenshotText(saved, html = false) {
  const text = saved === true ? '错误截图已保存' : '错误截图未保存';
  return html ? `<p style="margin:8px 0 0;color:#b91c1c;font-size:13px">📸 ${text}</p>` : `📸 ${text}`;
}

/** HTTP 200 也可能是业务失败；对已知渠道校验业务码。 */
export function validatePushResponse(name, text) {
  if (!text) return;
  let body;
  try { body = JSON.parse(text); } catch { return; }
  if (!body || typeof body !== 'object') return;

  if (name === 'PushPlus' && body.code !== undefined && Number(body.code) !== 200) {
    throw new Error(`PushPlus 业务失败 ${body.code}: ${body.msg || body.message || 'unknown'}`);
  }
  if (name === 'ServerChan' && body.code !== undefined && Number(body.code) !== 0) {
    throw new Error(`ServerChan 业务失败 ${body.code}: ${body.message || body.msg || 'unknown'}`);
  }
}

function statusMeta(status, balanceBefore) {
  if (status === 'error') {
    return { icon: '❌', text: '签到失败', color: '#ef4444', bg: '#fef2f2', border: '#fecaca' };
  }
  if (status === 'skipped') {
    return { icon: '⏭️', text: '今日跳过', color: '#64748b', bg: '#f8fafc', border: '#e2e8f0' };
  }
  if (status === 'already') {
    return { icon: 'ℹ️', text: '今日已签到', color: '#4f8ef7', bg: '#eff6ff', border: '#bfdbfe' };
  }
  if (status === 'success') {
    return { icon: '✅', text: '签到成功', color: '#22c55e', bg: '#f0fdf4', border: '#bbf7d0' };
  }
  return { icon: '⚠️', text: '签到完成，请确认', color: '#f59e0b', bg: '#fffbeb', border: '#fde68a' };
}

export function buildPushContent(status, balance, balanceBefore, gained, errorMsg, screenshotSaved) {
  const time = beijingTime();
  const meta = statusMeta(status, balanceBefore);

  if (status === 'error') {
    return [
      '❌ 签到失败',
      SEP,
      `📝 错误：${errorMsg}`,
      screenshotText(screenshotSaved),
      `⏰ ${time}`,
      SEP,
      '🤖 MeimoAI 自动签到',
    ].join('\n');
  }

  const gainedText = gained ? `（${gained}）` : '';
  const lines = [
    `${meta.icon} ${meta.text}`,
    SEP,
    `⚡ 电量余额：${balance}${gainedText}`,
  ];
  if (status === 'success' && balanceBefore !== '未识别') {
    lines.push(`📊 签到前：${balanceBefore} → 签到后：${balance}`);
  }
  if (status === 'clicked') {
    lines.push('📝 已点击签到，请人工确认页面状态');
  }
  lines.push(`⏰ ${time}`, SEP, '🤖 MeimoAI 自动签到');
  return lines.join('\n');
}

export function buildPushHtml(status, balance, balanceBefore, gained, errorMsg, screenshotSaved) {
  const time = beijingTime();
  const gainedText = gained
    ? `<span style="color:#22c55e;font-weight:600">${escHtml(gained)}</span>`
    : '';

  if (status === 'error') {
    return `<div style="font-family:-apple-system,sans-serif;max-width:420px;margin:0 auto;padding:20px;background:#fff;border-radius:16px;box-shadow:0 2px 12px rgba(0,0,0,0.08)">
<div style="text-align:center;margin-bottom:16px"><span style="font-size:40px">❌</span></div>
<h2 style="text-align:center;color:#ef4444;font-size:18px;margin:0 0 16px">签到失败</h2>
<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:14px;margin-bottom:16px">
<p style="margin:0;color:#991b1b;font-size:14px;word-break:break-all">📝 ${escHtml(errorMsg)}</p>
${screenshotText(screenshotSaved, true)}
</div>
<p style="text-align:center;color:#94a3b8;font-size:12px;margin:0">⏰ ${time}</p>
<hr style="border:none;border-top:1px solid #e5e7eb;margin:12px 0">
<p style="text-align:center;color:#94a3b8;font-size:11px;margin:0">🤖 MeimoAI 自动签到</p>
</div>`;
  }

  const meta = statusMeta(status, balanceBefore);
  const extraLine = status === 'clicked'
    ? '<p style="margin:8px 0 0;color:#92400e;font-size:13px">📝 已点击签到，请人工确认页面状态</p>'
    : (status === 'success' && balanceBefore !== '未识别')
      ? `<p style="margin:8px 0 0;color:#6b7280;font-size:13px">📊 签到前：${escHtml(balanceBefore)} → 签到后：${escHtml(balance)}</p>`
      : '';

  return `<div style="font-family:-apple-system,sans-serif;max-width:420px;margin:0 auto;padding:20px;background:#fff;border-radius:16px;box-shadow:0 2px 12px rgba(0,0,0,0.08)">
<div style="text-align:center;margin-bottom:16px"><span style="font-size:40px">${meta.icon}</span></div>
<h2 style="text-align:center;color:${meta.color};font-size:18px;margin:0 0 16px">${meta.text}</h2>
<div style="background:${meta.bg};border:1px solid ${meta.border};border-radius:12px;padding:14px;margin-bottom:16px">
<p style="margin:0;text-align:center;font-size:22px;font-weight:700;color:#1a2332">⚡ ${escHtml(balance)}</p>
<p style="margin:4px 0 0;text-align:center;color:#6b7280;font-size:12px">电量余额${gainedText}</p>
${extraLine}
</div>
<p style="text-align:center;color:#94a3b8;font-size:12px;margin:0">⏰ ${time}</p>
<hr style="border:none;border-top:1px solid #e5e7eb;margin:12px 0">
<p style="text-align:center;color:#94a3b8;font-size:11px;margin:0">🤖 MeimoAI 自动签到</p>
</div>`;
}

export function buildPushMarkdown(status, balance, balanceBefore, gained, errorMsg, screenshotSaved) {
  const time = beijingTime();
  const gainedText = gained ? ` **${gained}**` : '';

  if (status === 'error') {
    return [
      '## ❌ 签到失败',
      '',
      `> 📝 **错误：** ${errorMsg}`,
      `> ${screenshotText(screenshotSaved)}`,
      '',
      `⏰ ${time}`,
      '',
      '---',
      '🤖 MeimoAI 自动签到',
    ].join('\n');
  }

  const meta = statusMeta(status, balanceBefore);
  const lines = [
    `## ${meta.icon} ${meta.text}`,
    '',
    '| 项目 | 数据 |',
    '|------|------|',
    `| ⚡ 电量余额 | **${balance}**${gainedText} |`,
  ];
  if (status === 'success' && balanceBefore !== '未识别') {
    lines.push(`| 📊 签到前 | ${balanceBefore} |`);
    lines.push(`| 📊 签到后 | ${balance} |`);
  }
  lines.push('');
  if (status === 'clicked') {
    lines.push('> ⚠️ 已点击签到，请人工确认页面状态', '');
  }
  lines.push(`⏰ ${time}`, '', '---', '🤖 MeimoAI 自动签到');
  return lines.join('\n');
}

/**
 * 并行推送到所有已配置通道。
 * @returns {Promise<{sent: string[], failed: Array<{name:string, error:string}>}>}
 */
export async function sendPush(config, title, content, data = {}, logger = console) {
  const { status, balance, balanceBefore, gained, errorMsg, screenshotSaved } = data;
  const hasData = status !== undefined;
  const tasks = [];

  const add = (name, send) => tasks.push({ name, send });

  if (config.WANWAN_PUSH_TOKEN) {
    add('Wanwan', () => fetch('https://push.wanwanpro.top/api/push', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.WANWAN_PUSH_TOKEN}`,
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      body: JSON.stringify({
        title,
        content: hasData ? buildPushContent(status, balance, balanceBefore, gained, errorMsg, screenshotSaved) : content,
        type: 'text',
      }),
    }));
  }

  if (config.PUSHPLUS_TOKEN) {
    add('PushPlus', () => fetch('https://www.pushplus.plus/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      body: JSON.stringify({
        token: config.PUSHPLUS_TOKEN,
        title,
        content: hasData ? buildPushHtml(status, balance, balanceBefore, gained, errorMsg, screenshotSaved) : content,
        template: hasData ? 'html' : 'txt',
      }),
    }));
  }

  if (config.SERVERCHAN_SENDKEY) {
    add('ServerChan', () => fetch(`https://sctapi.ftqq.com/${config.SERVERCHAN_SENDKEY}.send`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      body: new URLSearchParams({
        title,
        desp: hasData ? buildPushMarkdown(status, balance, balanceBefore, gained, errorMsg, screenshotSaved) : content,
      }),
    }));
  }

  if (config.WEBHOOK_URL) {
    add('Webhook', () => fetch(config.WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      body: JSON.stringify({
        title,
        content: hasData ? buildPushContent(status, balance, balanceBefore, gained, errorMsg, screenshotSaved) : content,
        status,
        balance,
        balanceBefore,
        gained,
        time: beijingTime(),
      }),
    }));
  }

  if (tasks.length === 0) {
    logger.info('No push channel configured. Message:', `${title} | ${content}`);
    return { sent: [], failed: [] };
  }

  const results = await Promise.allSettled(
    tasks.map(async ({ name, send }) => {
      const response = await send();
      const text = await response.text().catch(() => '');
      if (!response.ok) {
        throw new Error(`${name} HTTP ${response.status}: ${text.slice(0, 300)}`);
      }
      validatePushResponse(name, text);
      logger.info(`${name} push sent.`);
      return name;
    }),
  );

  const sent = [];
  const failed = [];
  results.forEach((result, i) => {
    const name = tasks[i].name;
    if (result.status === 'fulfilled') sent.push(name);
    else failed.push({ name, error: result.reason && result.reason.message ? result.reason.message : String(result.reason) });
  });
  for (const f of failed) logger.warn(`Push failed [${f.name}]: ${f.error}`);
  return { sent, failed };
}
