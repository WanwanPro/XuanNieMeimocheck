# MeimoAI Docker 签到

个人使用的 MeimoAI 定时签到容器。项目把“稳定运行、跨进程互斥、配置可恢复、降低自动化痕迹”放在首位，而不是追求激进的浏览器指纹伪造。

## 功能概览

- Firefox + Playwright 持久化浏览器 profile，保留登录态。
- 使用浏览器原生 UA，并持久化 viewport、locale、时区、语言等设备指纹。
- 区域（region）、`navigator.languages`、`Accept-Language`、时区由同一配置派生，避免互相矛盾。
- 人类化操作：右偏延时、贝塞尔鼠标轨迹、偶发输入纠错、滚动与页面预热。
- 风控识别：验证码、人机验证、访问受限等特征命中后直接停止本次任务。
- 连续失败熔断：达到阈值自动暂停定时签到，可在 Web 页面手动恢复。
- 概率跳签：通过 `SKIP_PROBABILITY` 模拟偶发漏签（可选，默认 0.05）。
- 跨进程文件锁：cron 和 Web 手动签到不会同时打开同一个 Firefox profile。
- Web 管理：配置、状态、日志、错误截图、手动签到、恢复熔断。
- 结构化状态 `state.json` + `runId`，避免只靠日志文本猜执行结果。
- 推送渠道：Wanwan、PushPlus、ServerChan、Webhook。

## 快速开始

1. 复制环境变量模板：

```powershell
Copy-Item .env.example .env
```

2. 编辑 `.env`，至少填写：

```dotenv
MEIMOAI_ACCOUNT=你的账号
MEIMOAI_PASSWORD=你的密码
WEB_PASSWORD=你的管理密码
# 可选：飞书企业 SSO 免登（手机端即点即用）
FEISHU_SSO_ENABLED=false
```

`WEB_PASSWORD` 可以使用明文，也可以使用：

```powershell
npm run hash
```

生成的 `scrypt$salt$hash` 更安全。

3. 启动：

```powershell
docker compose up -d --build
```

4. 查看状态：

```powershell
docker compose ps
docker compose logs -f --tail=100
```

默认只绑定宿主机回环地址：`127.0.0.1:7788`。本机访问 <http://127.0.0.1:7788>。

## 编译与更新

推荐使用 Docker Compose 构建：

```powershell
docker compose build --pull
docker compose up -d
```

也可以一条命令完成重新构建和滚动替换：

```powershell
docker compose up -d --build
```

如果只使用 Docker CLI：

```powershell
docker build -t meimoai-checkin:latest .
docker run -d --name meimoai-checkin --restart unless-stopped `
  -p 127.0.0.1:7788:7788 `
  -v checkin-data:/app/.browser-profile `
  -v checkin-logs:/app/logs `
  -v checkin-env:/app/.env-data `
  --env-file .env `
  meimoai-checkin:latest
```

更新前建议先备份持久化数据。容器运行中可以直接复制：

```powershell
New-Item -ItemType Directory -Force .\backup | Out-Null
docker compose cp meimoai-checkin:/app/.env-data .\backup\env-data
docker compose cp meimoai-checkin:/app/logs .\backup\logs
docker compose cp meimoai-checkin:/app/.browser-profile .\backup\browser-profile
```

更新流程：

```powershell
docker compose cp meimoai-checkin:/app/.env-data .\backup\env-data
docker compose build --pull
docker compose up -d
docker compose ps
docker compose logs --tail=100
```

> 严禁执行 `docker compose down -v`。`-v` 会删除 `checkin-data`、`checkin-logs`、`checkin-env` 三个数据卷，浏览器登录态、日志和 Web 配置都会丢失。

## 数据卷

| 卷 | 容器路径 | 内容 |
|---|---|---|
| `checkin-data` | `/app/.browser-profile` | Firefox profile、`device.json`、登录态 |
| `checkin-logs` | `/app/logs` | `checkin.log`、`state.json`、错误截图、签到锁 |
| `checkin-env` | `/app/.env-data` | 持久化 `.env`，Web 修改后的配置事实来源 |

根目录 `.env` 用于 `docker compose` 首次创建容器时的环境变量注入。首次启动后，`init-env.js` 会把配置写入 `checkin-env:/app/.env-data/.env`；之后 Web 修改的是持久化 `.env`，不会被重新构建镜像覆盖。

## 反机器人检测设计

### 1. 原生 Firefox 指纹

旧方案会把 Firefox 伪装成 iPhone Safari UA，导致 UA、JS 引擎、TLS 指纹互相矛盾。现在不再覆盖 `userAgent`，直接使用 Playwright Firefox 的真实 UA。

### 2. 稳定而不是频繁随机

设备指纹生成一次后写入 `device.json` 并持久化：

- `region`
- `viewport`
- `locale`
- `timezoneId`
- `languages`
- `acceptLanguage`
- `hardwareConcurrency`
- `colorScheme`

频繁变化通常比固定值更可疑，因此这些值不会每天重新随机。

### 3. 区域一致性

默认 `region=CN`，对应的 locale、时区、语言和请求头为：

```text
locale: zh-CN
timezone: Asia/Shanghai
Accept-Language: zh-CN,zh;q=0.9,en;q=0.8
```

如果使用海外代理，代理出口 IP 应与浏览器区域一致。可以把 `/app/.browser-profile/device.json` 中的 `region` 改为 `GLOBAL`，下次启动会统一迁移为 `en-US` / `America/New_York` 组合。

### 4. 行为节奏

- 随机延迟使用右偏采样，而不是每天固定时刻执行。
- 鼠标轨迹使用三次贝塞尔曲线和变速。
- 输入可能打错并回退纠正。
- 页面预热包含滚动、鼠标移动和自然停顿。

### 5. 风控与熔断

命中验证码、人机验证、访问受限等特征时，本次任务直接停止。连续失败或连续 `clicked`（点击后无确定结果）达到 `MAX_CONSECUTIVE_FAILURES` 后自动暂停定时签到，避免持续撞风控或长期处于不确定状态。

## 配置语义

| 配置 | 说明 |
|---|---|
| `CRON_SCHEDULE` | 5 段 cron，例如 `0 1 * * *`。Web 端不允许保存空值，避免容器重启时崩溃循环 |
| `RANDOM_DELAY` | 是否在 cron 触发后随机等待 |
| `RANDOM_DELAY_MAX_MINUTES` | 随机等待上限，默认 300 分钟 |
| `SKIP_PROBABILITY` | 每次自动签到跳过的概率，0 表示不跳过 |
| `MAX_CONSECUTIVE_FAILURES` | 连续失败 / 连续 `clicked` 熔断阈值 |
| `PROXY_SERVER` | 可选 HTTP/SOCKS5 代理；出口区域应与浏览器区域一致 |
| `WEB_PASSWORD` | Web 管理密码；留空表示关闭认证 |
| `WEB_TRUST_PROXY` | Express `trust proxy` 配置；仅在明确受控的反向代理后设置（推荐 `1` / `loopback` / 具体 IP）。`true` / `all` 会被忽略并降级为 `false`（避免信任伪造的 `X-Forwarded-For`），修改后重启容器生效 |
| `FEISHU_SSO_ENABLED` | 是否开启飞书企业 SSO 免登 |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 飞书企业自建应用凭证，仅服务端使用 |
| `FEISHU_REDIRECT_URI` | OAuth 回调地址，必须与飞书平台重定向 URL 完全一致 |
| `FEISHU_ALLOWED_TENANT_KEYS` | 企业 `tenant_key` 白名单，多项逗号分隔 |
| `FEISHU_ALLOWED_OPEN_IDS` | 用户 `open_id` 白名单，多项逗号分隔 |
| `FEISHU_SCOPE` | 可选授权范围，默认空（用应用默认权限） |

### `SKIP_PROBABILITY` 的重要语义

当 `SKIP_PROBABILITY > 0` 时，当天可能真的不签到，**且当天不会自动补签**。跳过后：

- 写入 `state.json`，状态为 `skipped`；
- Web 状态显示“本次已跳过”；
- 推送一条跳过通知。

如果要求每天必签，请设置为 `0`。

### `clicked` 状态

`clicked` 表示点击已经发生，但页面没有出现明确的成功文案，结果不确定。该状态：

- 不计为成功；
- 不清零连续失败计数；
- 单独累计 `consecutiveClicked`，连续达到 `MAX_CONSECUTIVE_FAILURES` 时也会熔断暂停；
- 不自动解除熔断暂停；
- 进程退出码为 `3`，与普通成功 `0`、失败 `1` 区分。

### 手动签到与 cron 的关系

`success` / `already` / `skipped` 才算当天已完成并阻止当天后续 cron 再次执行。
`error` / `clicked` 属于失败或不确定结果，会允许同一天后续 cron 再尝试一次（适合配置 `0 1,13 * * *` 这类重试规则）。
同一天一旦出现过 `success` / `already` / `skipped`，后续手动产生的 `error` / `clicked` 不会重新放行 cron；判断会检查当天历史，而不是只看最新一条记录。
连续 `clicked` 触发熔断后，暂停期间不会写入 `skipped` 覆盖熔断证据；达到阈值的那次 `clicked` 仍会保留在状态历史中。
如果希望失败后当天绝不重试，请把 cron 配置为每天只触发一次；如果要求每天必签，请将 `SKIP_PROBABILITY` 设为 `0`。

## Web 界面

界面是一套自绘的「浅色液态玻璃（Light Liquid Glass）」风格，不依赖任何 CDN 或远程资源，完全离线可用：

- **配色与氛围**：冷蓝强调（`#3d55e8`，渐变中保留少量 `#4b6bfb` 过渡色）+ 通透白玻璃层，正文用深墨色；语义色 jade / amber / verm 表示正常、警告、错误；背景由柔和冷色辉光与磨砂模糊叠加，不使用金色。
- **字体**：标题用衬线族、正文用无衬线族、数字与日志用等宽族，全部走系统已安装字体（Iowan Old Style / Palatino / 苹方 / 微软雅黑 / Cascadia Code 等），不回源加载 Web Font。
- **主面板**：顶部运行状态 + 余额/时长/触发来源，右侧倒计时与「下次执行」绝对时间；中部三栏为运行计划、风控熔断仪表、账户诊断（含错误截图）；下部为可级别过滤与关键词搜索的日志、运行记录时间线；底部为可折叠配置面板，带 cron 实时校验。
- **登录门**：支持飞书企业 SSO 一键登录与 `WEB_PASSWORD` 应急入口；飞书客户端（含手机端）自动尝试 JSAPI 免登。
- **移动端**：`viewport-fit=cover` + `env(safe-area-inset-*)` 适配 iPhone 刘海/底部横条和飞书手机 WebView；760px / 400px 两级断点、横屏低高度布局、`100dvh` 动态视口（弹层/日志/灯箱）、单列布局、≥44px 触控目标、输入框 16px 防 iOS 自动放大，登录门在窄屏可滚动；飞书客户端可通过 UA 或 `?feishu=1` 强制尝试 JSAPI 免登。
- **交互**：自绘 Toast、确认弹层与截图灯箱替代原生 `alert/confirm`，弹层做了焦点归还；自动刷新仅在页面可见且主面板显示时运行（状态 30s、日志 15s）。
- **主题**：浅色液态玻璃 + 冷蓝强调色（无金色）。当前仅提供浅色模式（<meta name="color-scheme" content="light">），不随系统深色模式切换。
- **CSP**：不使用内联脚本与内联事件处理器，`script-src 'self'`、`connect-src 'self'` 下正常工作；本地 vendor 的飞书 SDK 不含 `eval` / `Function` 构造器。`style-src` 仍保留 `'unsafe-inline'`，页面存在少量内联 `style=` 属性（如进度条宽度），因此并非“零内联样式”。`prefers-reduced-motion` 时关闭动效。

## 飞书企业 SSO（可选）

开启后，手机飞书 / 桌面飞书内打开控制台可「一键免登」，同时保留 `WEB_PASSWORD` 作为应急入口。整条链路只信任 `open_id` + `tenant_key`，不使用邮箱/手机号。

### 两条登录通道

| 通道 | 触发场景 | 流程 |
|---|---|---|
| JSAPI 免登 | 飞书客户端内（含手机端） | 前端加载本地 `vendor/feishu-h5-sdk.js` → 取 JSAPI 签名与一次性 nonce → `tt.requestAuthCode` → 后端校验同源 Origin + HttpOnly nonce Cookie 后换取身份 |
| OAuth 跳转 | 普通浏览器 | 跳转飞书授权页（PKCE S256）→ 回调 `redirect_uri` → 后端换取身份 |

两条通道最终都落到内存会话（HttpOnly Cookie `meimoai_session`，24h）。浏览器前端只依赖 Cookie，服务端仍保留 `X-Auth-Token` 解析以兼容旧 API 客户端。

### 飞书开放平台配置

1. 登录 [飞书开放平台](https://open.feishu.cn/)，创建**企业自建应用**。
2. 「凭证与基础信息」拿到 `App ID` / `App Secret`，填入 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`。
3. 「安全设置」→ 重定向 URL 添加 `https://你的域名/api/auth/feishu/callback`，必须与 `FEISHU_REDIRECT_URI` **完全一致**（协议、域名、路径、结尾斜杠都不能差）。
4. 「权限管理」开通网页应用登录与用户信息读取权限（如 `authen:user.id.obtain`、`contact:user.base:readonly`）。
5. 「版本管理与发布」发布版本并等待企业管理员审核通过；未发布时授权会报 `20029` / `20027`。
6. 在应用「网页应用」开启网页能力，并把控制台域名加入可信域名 / 桌面端主页。

### 本项目配置

```dotenv
FEISHU_SSO_ENABLED=true
FEISHU_APP_ID=cli_xxxxxxxx
FEISHU_APP_SECRET=xxxxxxxx
FEISHU_REDIRECT_URI=https://checkin.example.com/api/auth/feishu/callback
# 白名单：两项都留空 = 拒绝所有飞书登录，必须至少填一项
FEISHU_ALLOWED_TENANT_KEYS=
FEISHU_ALLOWED_OPEN_IDS=ou_xxxxxxxx
FEISHU_SCOPE=
```

- `FEISHU_ALLOWED_TENANT_KEYS`：企业 `tenant_key`，同企业所有人可登录。
- `FEISHU_ALLOWED_OPEN_IDS`：具体用户 `open_id`，仅名单内用户可登录。
- 白名单为空时**一律拒绝**，避免「配置漏填 = 全公司可进」。
- 获取自己的 `open_id`：先临时放开企业白名单登录一次，日志里 `飞书登录成功：<名字>` 与拒绝条目都会打印 `open_id`，拿到后再收紧名单。

### 手机端要点（重要）

- 手机飞书**无法访问** `127.0.0.1:7788`。默认 Compose 只绑定回环地址，必须改为局域网/公网入口，或通过带 TLS 的反向代理暴露，并把手机可达的 **HTTPS 域名**填进 `FEISHU_REDIRECT_URI` 与飞书重定向 URL。
- JSAPI 签名由 `/api/auth/feishu/jsapi-config` 按当前页面 URL 现算，并下发 5 分钟有效的一次性 nonce（HttpOnly + SameSite=Strict Cookie）。`POST /api/auth/feishu/jsapi` 只接受同源 `application/json` 且 nonce/Cookie 完全匹配的请求，跨站表单、跨域 Origin 与重放都会被拒绝。前端与后端必须同源访问（走反向代理时保持域名一致）。
- SDK 已本地化到 `public/vendor/feishu-h5-sdk.js`（约 230KB），满足 `script-src 'self'`；`connect-src` 仍为 `'self'`，`requestAuthCode` 走原生 bridge，正常不受影响。若真机上遇到 JSAPI 加载/签名失败，请核对 CSP 与页面 URL 是否被反代改写。
- **必须真机验证一次**：静态测试覆盖不到飞书 WebView 的原生 bridge 行为。

### 常见错误码

回调失败会以 `/?auth_error=<code>` 回首页，前端展示中文提示，服务端日志记录详细原因：

| code | 含义 |
|---|---|
| `disabled` | 未启用或配置不完整 |
| `denied` | 用户取消授权 |
| `state` | state 过期/重复使用/缺失（防重放） |
| `exchange` | 授权码换取令牌失败 |
| `userinfo` | 读取用户信息失败（权限未开/未发布） |
| `forbidden` | 账号不在白名单 |
| `unavailable` | 飞书接口或网络异常 |

## Web 安全边界

- 默认 Compose 只绑定 `127.0.0.1`，不要无保护地暴露到 LAN 或公网。
- `FEISHU_SSO_ENABLED=true` 但凭据/白名单不完整时采用 **fail-closed**：受保护接口不会退化成无认证，管理界面会提示缺失项；配置完成前请保留 `WEB_PASSWORD` 应急入口。
- 需要远程访问时，至少设置 `WEB_PASSWORD`，并优先通过带 TLS 的反向代理访问。
- API 对账号、密码、推送 token、代理和 Webhook 做了掩码处理，但日志、错误截图和持久化 `.env` 仍是敏感数据，需要保护数据卷。
- Web 认证限流基于 `req.ip`。反向代理场景下，如果不设置 `WEB_TRUST_PROXY`，所有请求会共享代理 IP；如果对公网直连盲目开启，又可能被伪造的 `X-Forwarded-For` 绕过。仅在明确受控的反向代理后设置 `WEB_TRUST_PROXY`（例如 `1` 或 `loopback`），修改后重启容器。为避免误配置，`true` / `all` 会被代码忽略（等效 `false`）并打印启动告警。

## 已知限制与残留风险

- **签到锁已移除 cleanup guard 层，但未做到内核级互斥。** 陈旧锁回收的唯一仲裁点是 `renameSync`：并发时只有一个进程能把锁文件移走，移走后回读比对，若发现移走的是别人刚建立的新锁就用 `link` 放回并放弃，全程不 `unlink` 主锁。早期版本额外用一层 guard 文件串行化回收，但 guard 自身的「判断陈旧 → 抢占」同样无法原子化，反而叠加出新的双清理者竞态，已删除。Node 没有内建的 `flock`/`LockFileEx` 封装，所以「读快照 → rename」之间仍有一个需要 ≥3 个进程微秒级交错才会命中的理论窗口。命中时的最坏结果是两个进程同时进入签到、争用同一个 Firefox profile（通常表现为启动失败），并残留 `checkin.lock.reclaim-*` 隔离文件；确认没有签到进程在跑后手动删除即可。要彻底消除，只能改用 `flock(1)` 之类的 OS 锁。
- **`GLOBAL` 区域固定为 `en-US` + `America/New_York`**，只适配美东出口。使用其它地区代理时，请把 `device.json` 的 `region` 改为 `CN`，或自行扩展 `src/checkin/device.js` 的区域表。
- **仓库已提交 `package-lock.json`**。`Dockerfile` 使用 `COPY package*.json`，存在 lock 时走 `npm ci` 进行可复现构建；无 lock 的旧检出仍会回退 `npm install`。
- **Dockerfile 的 HEALTHCHECK 固定探测 7788**，如果以后让 `WEB_PORT` 生效，需要同步修改。
- **entrypoint 的后台 Web 重启循环不受 SIGTERM 管理**（PID 1 是 cron），`docker stop` 时 Web 进程会被强杀，属个人工具可接受行为。

## 测试

项目不依赖第三方测试框架：

```powershell
node --test
```

测试同时覆盖后端与前端（`test/frontend.test.js` 守护前端生成链、DOM 绑定与 CSP 合规），当前共 87 项。前端唯一源文件是 `tools/_page.html`，它内联了完整的 `<style>` 与 `<script>` 块；`tools/split-web.mjs` 只做纯拆分，把这两个块抽出为 `public/styles.css` / `public/app.js`，并把页面中的块替换为外链。改完后重新生成：

```powershell
node tools\split-web.mjs
```

该生成器已做根目录锚定（基于自身路径解析，不依赖当前工作目录）与「恰好一个 style / script 块」的强校验：块数量不符会直接报错，而不是产出残缺文件。不要只修改 `public/app.js`、`public/index.html` 或 `public/styles.css`，它们会被下次生成覆盖。

## 故障排查

- 页面提示“未找到领电量入口 / 签到按钮”：站点可能改版，集中检查 `src/checkin/selectors.js`。
- 登录后仍为未登录：检查账号密码、验证码、登录态 profile 是否有效。
- 代理出口与浏览器区域不一致：修改 `device.json` 的 `region`，或关闭代理后重新登录。
- 端口冲突导致 Web 反复退出：entrypoint 已使用 3s → 60s 指数退避，查看 `docker compose logs` 定位占用进程。
- 容器启动失败：优先检查 `CRON_SCHEDULE` 是否为空或非法。Web 端现在会拒绝保存非法 cron，但手工编辑 `.env-data/.env` 仍可能写坏。

## 仓库清理说明

旧的 2026-06 审查报告和调试页面已归档到 `docs/archive/`。旧报告中的部分问题已经修复，仅作为历史记录保留，不应作为当前代码质量判断依据。
