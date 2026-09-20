import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { CONFIG_KEYS } from '../src/config.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = join(root, 'tools', '_page.html');
const publicDir = join(root, 'public');

test('前端源文件是单块 style/script 且不包含内联事件或远程资源', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const styles = source.match(/<style>[\s\S]*?<\/style>/g) || [];
  const scripts = source.match(/<script>[\s\S]*?<\/script>/g) || [];

  assert.equal(styles.length, 1, '应只有一个 <style> 块');
  assert.equal(scripts.length, 1, '应只有一个 <script> 块');
  assert.doesNotMatch(source, /\son(?:click|keydown|submit|change|input|load|error)\s*=/i, '不应使用内联事件处理器');
  assert.doesNotMatch(source, /<(?:script|link)[^>]+(?:src|href)=["']https?:\/\//i, '不应引用远程脚本或样式');
});

test('本地飞书 SDK 满足严格 CSP 且不依赖动态代码执行', async () => {
  const js = await readFile(join(root, 'public', 'vendor', 'feishu-h5-sdk.js'), 'utf8');
  assert.doesNotMatch(js, /\bFunction\s*\(/, 'SDK 不应使用 Function 构造器（含裸调用），避免 CSP unsafe-eval');
  assert.doesNotMatch(js, /\beval\s*\(/, 'SDK 不应使用 eval');
  assert.match(js, /window\.h5sdk/, 'SDK 应注入 window.h5sdk');
  assert.match(js, /requestAuthCode/, 'SDK 应包含飞书免登接口');
  assert.doesNotMatch(js, /<(?:script|link)[^>]+(?:src|href)=["']https?:\/\//i, 'SDK 不应引用远程脚本或样式');
});

test('浏览器前端只使用 HttpOnly Cookie，不把会话令牌写入 JS 状态', async () => {
  const js = await readFile(join(publicDir, 'app.js'), 'utf8');
  assert.doesNotMatch(js, /X-Auth-Token/i, '浏览器前端不应发送 X-Auth-Token');
  assert.doesNotMatch(js, /\bauthToken\b/, '浏览器前端不应保存会话令牌');
  assert.doesNotMatch(js, /\blocalStorage\b/, '浏览器前端不应把凭据写入 localStorage');
  assert.doesNotMatch(js, /\bsessionStorage\b/, '浏览器前端不应把凭据写入 sessionStorage');
  assert.doesNotMatch(js, /document\.cookie/, '浏览器前端不应直接读写 document.cookie');
  assert.doesNotMatch(js, /\bAuthorization\b/, '浏览器前端不应使用 Authorization 头');
});
test('split-web.mjs 生成结果与 public 三个交付文件一致', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'meimoai-frontend-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'tools'));
  await copyFile(sourcePath, join(dir, 'tools', '_page.html'));
  await copyFile(join(root, 'tools', 'split-web.mjs'), join(dir, 'tools', 'split-web.mjs'));
  execFileSync(process.execPath, ['tools/split-web.mjs'], { cwd: dir, stdio: 'pipe' });

  for (const name of ['index.html', 'styles.css', 'app.js']) {
    assert.equal(
      await readFile(join(dir, 'public', name), 'utf8'),
      await readFile(join(publicDir, name), 'utf8'),
      `${name} 与源文件生成结果不一致`
    );
  }
});

test('public DOM ID 与 app.js 的动态引用一致，且保留关键绑定', async () => {
  const html = await readFile(join(publicDir, 'index.html'), 'utf8');
  const js = await readFile(join(publicDir, 'app.js'), 'utf8');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const refs = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  const dynamicIds = ['gaugeFail', 'gFailBar', 'gaugeClicked', 'gClickedBar', 'gaugeSkip', 'gSkipBar'];
  const missing = [...refs].filter((id) => !ids.has(id)).concat(dynamicIds.filter((id) => !ids.has(id))).sort();

  assert.deepEqual(missing, [], '存在 JS 引用但 HTML 不存在的 DOM ID');
  assert.match(html, /<link rel="stylesheet" href="\/styles.css">/);
  assert.match(html, /<script src="\/app\.js" defer><\/script>/);
  assert.doesNotMatch(html, /<style[\s>]|<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i);
  assert.match(js, /\$\('scheduleText'\)\.textContent/);
});

test('设置表单覆盖配置 schema 的全部键', async () => {
  const html = await readFile(join(publicDir, 'index.html'), 'utf8');
  const names = new Set([...html.matchAll(/\bname="([A-Z0-9_]+)"/g)].map((m) => m[1]));
  const missing = CONFIG_KEYS.filter((key) => !names.has(key));
  assert.deepEqual(missing, [], '设置表单缺少 CONFIG_SCHEMA 配置项');
});
test('前端 cron 预览覆盖月度和年度规则', async () => {
  let code = await readFile(join(publicDir, 'app.js'), 'utf8');
  code = code.replace(/\ninit\(\);\s*$/, '\n');
  const context = { console, Date, Set, Number, String, RegExp, Math, Intl, JSON, URL };
  vm.createContext(context);
  vm.runInContext(code, context);

  const monthly = context.nextRunDate('0 1 1 * *', new Date('2026-09-11T00:00:00Z'));
  const yearly = context.nextRunDate('59 23 31 12 *', new Date('2026-09-11T00:00:00Z'));
  assert.equal(monthly.toISOString(), '2026-10-01T01:00:00.000Z');
  assert.equal(yearly.toISOString(), '2026-12-31T23:59:00.000Z');
  // 闰日：从 2026-03-01 起下一个 2 月 29 日是 2028，超出旧的 366 天窗口
  assert.equal(
    context.nextRunDate('0 0 29 2 *', new Date('2026-03-01T00:00:00Z')).toISOString(),
    '2028-02-29T00:00:00.000Z'
  );
  // 世纪非闰年空档：2096-02-29 的下一次是 2104-02-29（相隔 8 年）
  assert.equal(
    context.nextRunDate('0 0 29 2 *', new Date('2096-03-01T00:00:00Z')).toISOString(),
    '2104-02-29T00:00:00.000Z'
  );
  // 不存在的日期（2 月 30 日）应返回 null，而不是抛错或死循环
  assert.equal(context.nextRunDate('0 0 30 2 *', new Date('2026-03-01T00:00:00Z')), null);
});


test('登录门包含飞书 SSO 入口，且 SDK 走本地 vendor', async () => {
  const html = await readFile(join(publicDir, 'index.html'), 'utf8');
  const js = await readFile(join(publicDir, 'app.js'), 'utf8');
  assert.match(html, /id="feishuLoginBtn"/, '缺少飞书登录按钮');
  assert.match(html, /id="feishuPane"/);
  assert.match(html, /id="gateDivider"/);
  assert.match(js, /\/vendor\/feishu-h5-sdk\.js/, 'SDK 应从本站 vendor 加载');
  assert.match(js, /nonce: config\.nonce/, 'JSAPI 免登必须回传一次性 nonce');
  assert.match(js, /feishuConfigProblems/, '登录门应显示飞书配置缺项，避免 fail-closed 后无提示');
  assert.doesNotMatch(js, /https?:\/\/[^""']*feishu[^""']*\.js/i, '不应引用远程飞书 SDK');
});

test('桌面端未登录时自动跳飞书，管理密码入口默认隐藏且由 logo 展开', async () => {
  const html = await readFile(join(publicDir, 'index.html'), 'utf8');
  const js = await readFile(join(publicDir, 'app.js'), 'utf8');
  assert.match(html, /id="passwordPane" hidden/, '密码入口应默认隐藏');
  assert.match(html, /id="loginForm" hidden/, '密码表单应默认隐藏');
  assert.match(html, /id="gateMark"[^>]*aria-controls="passwordPane"/, 'logo 应控制密码入口');
  assert.match(js, /feishuEnabled && !isFeishuClient\(\) && allowAutoFeishuRedirect && !feishuAutoRedirectBlocked/, '桌面端未登录应自动跳飞书');
  assert.match(js, /window\.location\.href = '\/api\/auth\/feishu\/start'/, '自动跳转应使用飞书启动路由');
  assert.match(js, /\$\('gateMark'\)\.addEventListener\('click', togglePasswordFallback\)/, 'logo 点击应展开/收起密码入口');
  assert.match(js, /setPasswordFallback\(passwordEnabled && !feishuEnabled, false\)/, '飞书不可用时应自动显示密码入口');
});

test('登录回包必须由服务端确认 authenticated=true，未认证回包不能进主界面', async () => {
  const js = await readFile(join(publicDir, 'app.js'), 'utf8');
  assert.match(js, /d\.authenticated === true/, 'doLogin 必须严格要求 authenticated 为 true');
  assert.doesNotMatch(
    js,
    /if \(r\.ok && d\.ok\) \{\s*\n\s*authRequired = Boolean/,
    '不得仅凭 r.ok && d.ok 就进入主界面'
  );
});

test('viewport 支持安全区，移动端样式覆盖刘海/触控目标', async () => {
  const html = await readFile(join(publicDir, 'index.html'), 'utf8');
  const css = await readFile(join(publicDir, 'styles.css'), 'utf8');
  assert.match(html, /viewport-fit=cover/, 'viewport 必须声明 viewport-fit=cover');
  assert.match(css, /env\(safe-area-inset-top/, '缺少顶部安全区');
  assert.match(css, /env\(safe-area-inset-bottom/, '缺少底部安全区');
  assert.match(css, /@media \(max-width:760px\)/, '缺少窄屏断点');
  assert.match(css, /@media \(max-width:400px\)/, '缺少超窄屏断点');
  assert.match(css, /@media \(hover:none\)/, '缺少触屏 hover 兜底');
  assert.match(css, /@media \(orientation:landscape\) and \(max-height:520px\)/, '缺少飞书手机横屏低高度适配');
  assert.match(css, /@supports not/, '缺少不支持 backdrop-filter 时的降级方案');
  assert.match(css, /min-height:100dvh/, '缺少动态视口高度适配');
  assert.match(css, /\.modal-card\{[^}]*max-height:88dvh/, '弹层卡片应使用 dvh 动态视口高度');
  assert.match(css, /\.lightbox img\{[^}]*max-height:64dvh/, '灯箱图片应使用 dvh 动态视口高度');
  assert.match(css, /\.hist,\.logbox\{[^}]*max-height:56dvh/, '日志/历史区应使用 dvh 动态视口高度');
  const landscape = css.match(/@media \(orientation:landscape\) and \(max-height:520px\)\{[\s\S]*?\n\}/);
  assert.ok(landscape, '缺少飞书手机横屏媒体查询');
  for (const sel of ['\.modal,\.lightbox', '\.toast']) {
    const rule = landscape[0].match(new RegExp(sel + '\\{[^}]*\\}'));
    assert.ok(rule && /safe-area-inset-left/.test(rule[0]) && /safe-area-inset-right/.test(rule[0]), sel + ' 横屏应处理左右安全区');
  }
  assert.match(css, /\.gate\{[^}]*env\(safe-area-inset-top[^}]*align-items:flex-start[^}]*\}/, '窄屏登录门应保留顶部安全区并改为顶部对齐，避免超高时被裁剪');
  assert.match(css, /\.gate\{[^}]*env\(safe-area-inset-bottom[^}]*\}/, '窄屏登录门应保留底部安全区');
});

test('登录门在小屏可滚动，顶栏 sticky 让出安全区', async () => {
  const css = await readFile(join(publicDir, 'styles.css'), 'utf8');
  const gateRule = css.match(/\.gate\{[^}]*\}/);
  assert.ok(gateRule, '找不到 .gate 规则');
  assert.match(gateRule[0], /overflow-y:auto/, '登录门内容超高时应可滚动');
  assert.match(gateRule[0], /safe-area-inset-top/, '登录门应让出刘海安全区');

  const stickyTop = css.match(/\.topbar\{[^}]*top:env\(safe-area-inset-top[^}]*\}/);
  assert.ok(stickyTop, '移动端 sticky 顶栏应使用环境安全区偏移');
});

test('登录门不再使用金色强调，主题为浅色冷蓝', async () => {
  const css = await readFile(join(publicDir, 'styles.css'), 'utf8');
  assert.doesNotMatch(css, /#c9a227|#d4af37|goldenrod/i, '不应残留金色主题');
  assert.match(css, /\.btn-feishu\{/, '缺少飞书按钮样式');
});

