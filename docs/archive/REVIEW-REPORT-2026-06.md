# MeimoAI 签到 Docker 项目 — 审查报告

> 审查日期：2026-06-06

---

## 一、严重问题（会导致功能异常或安全漏洞）

### 1.1 日志路径不一致 — 签到日志写到两个不同位置

这是整个项目最隐蔽也最实际的 bug。

| 位置 | 写入路径 |
|------|----------|
| `entrypoint.sh` 第 22 行（cron 定时执行时） | `/app/logs/checkin.log` |
| `server.js` 第 117 行（手动签到时） | `/app/checkin.log` |
| `server.js` 第 8 行（Web 界面读取日志） | `/app/logs/checkin.log` |

**后果：** 手动签到产生的日志写到了 `/app/checkin.log`，但 Web 管理界面只从 `/app/logs/checkin.log` 读取。用户在管理面板点"手动签到"后，永远看不到这次签到的日志输出。同时 `/app/checkin.log` 不在任何 volume 挂载范围内，容器重建后数据丢失。

同样的问题存在于 `server.js` 第 104 行的 cron 更新逻辑：

```javascript
execSync(`echo "${env.CRON_SCHEDULE} cd /app && node scripts/meimoai-checkin.js >> /app/checkin.log 2>&1"...`)
```

这里写的是 `/app/checkin.log`，但 entrypoint.sh 设置的是 `/app/logs/checkin.log`。通过 Web 界面修改定时规则后，日志也会跑到错误的路径。

### 1.2 CRON_SCHEDULE 存在命令注入风险

`server.js` 第 104 行：

```javascript
execSync(`echo "${env.CRON_SCHEDULE} cd /app && ..."`)
```

`env.CRON_SCHEDULE` 直接从 HTTP 请求体中获取，未经任何校验就拼接进 shell 命令。如果有人在 Web 界面填入 `0 1 * * *"; rm -rf / #`，会直接执行任意命令。

虽然目前 Web 界面没有认证（后面会提到），但即使加上认证，也应该对 cron 表达式做格式校验。

### 1.3 Web 管理界面完全没有认证

端口 7788 暴露在局域网（甚至可能暴露到公网），任何能访问该端口的人都可以：

- 查看账号密码（`/api/env` 接口直接返回明文密码）
- 修改账号密码
- 修改定时规则（包括注入恶意命令）
- 触发签到操作
- 清空日志

对于部署在飞牛 NAS 上的服务，局域网内的其他设备或访客都能直接操作。

### 1.4 环境变量保存时特殊字符处理缺陷

`entrypoint.sh` 第 8-18 行：

```bash
cat > /app/.env << EOF
MEIMOAI_PASSWORD=${MEIMOAI_PASSWORD}
EOF
```

如果密码中包含 `$`、`` ` ``、`\`、`!` 等 shell 特殊字符，bash 会在 heredoc 中进行变量替换或命令替换，导致写入 `.env` 文件的密码与实际密码不一致。

`server.js` 第 98 行也有类似问题：

```javascript
const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
```

如果值中包含换行符，会破坏 `.env` 文件格式。虽然 `parseEnv` 用 `indexOf('=')` 解析，但值中包含 `=` 时虽然不会解析错误，换行仍会导致后续键值对被截断。

---

## 二、中等问题（影响可用性或健壮性）

### 2.1 没有 `.dockerignore` 文件

当前 `docker-compose.yml`、`.git`、`README.md` 等都会被 COPY 到镜像中（虽然只 COPY 了特定文件，但 build context 传输时仍会包含全部文件）。建议在项目根目录创建 `.dockerignore`：

```
.git
node_modules
docker-compose.yml
*.md
.env
```

### 2.2 签到脚本的截图保存路径

`scripts/meimoai-checkin.js` 第 403 行：

```javascript
await page.screenshot({ path: 'meimoai-checkin-error.png', fullPage: true });
```

使用的是相对路径，截图保存到进程的工作目录。当 cron 执行时 cwd 是 `/app`（由 entrypoint.sh 中 `cd /app` 指定），截图会保存到 `/app/meimoai-checkin-error.png`，这刚好和 `server.js` 第 42 行读取的路径一致。

但当通过 Web 手动触发时，`exec` 的 cwd 取决于 Node 进程的工作目录，虽然 entrypoint 中也加了 `cd /app`，但这种隐式依赖不够可靠。建议在脚本中使用绝对路径。

### 2.3 手动签到的结果无法追踪

`server.js` 第 115-124 行：

```javascript
app.post('/api/checkin', (req, res) => {
  const child = exec('cd /app && RANDOM_DELAY=false node scripts/meimoai-checkin.js >> /app/checkin.log 2>&1', {
    env: { ...process.env, RANDOM_DELAY: 'false' },
  });
  res.json({ ok: true, message: '签到任务已启动，请稍后查看日志' });
});
```

问题：
- `exec` 的返回的 `child` 进程没有监听 `error` 或 `exit` 事件
- 传入的 `env` 中 `RANDOM_DELAY` 设为 `'false'`，但 `process.env` 中可能仍然保留着原始值，合并后 `RANDOM_DELAY` 取决于展开顺序（Node 中后面的会覆盖前面的，所以这里是正确的）
- 由于 1.1 的日志路径 bug，手动签到的日志用户看不到

### 2.4 容器重启后 Web 修改的环境变量被覆盖

`entrypoint.sh` 每次容器启动时都会用 Docker 环境变量覆盖 `/app/.env` 文件。如果用户通过 Web 界面修改了配置（如更换账号、调整定时规则），容器重启后这些修改全部丢失。

这在 `docker-compose.yml` 使用 `restart: unless-stopped` 时尤其容易触发——Docker 守护进程重启、系统重启都会导致容器重建。

### 2.5 `parseEnv()` 不处理带引号的值

`server.js` 第 136-149 行的 `parseEnv` 函数直接用 `indexOf('=')` 切分，不处理引号包裹的值。虽然当前的 `entrypoint.sh` 生成的 `.env` 不带引号，但如果用户手动编辑或通过其他方式生成带引号的值，解析会出错。

### 2.6 `package.json` 中 playwright 版本未锁定

```json
"playwright": "^1.49.1"
```

`^` 允许 minor 版本升级。Playwright 的浏览器二进制文件在不同版本间可能有兼容性变化，虽然 `package-lock.json` 会锁定实际安装版本，但 `npm install --production` 的行为取决于是否存在 lock file。建议确保 `package-lock.json` 存在于项目中并被 COPY 到镜像。

---

## 三、轻微问题（改进建议）

### 3.1 docker-compose.yml 中的 `version` 字段

```yaml
version: "3.8"
```

Docker Compose V2（Docker Desktop 自带的 `docker compose` 命令）已废弃 `version` 字段，会输出警告。可以删除这行。

### 3.2 缺少 Docker HEALTHCHECK

容器没有定义健康检查。建议在 Dockerfile 中添加：

```dockerfile
HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:7788/api/status || exit 1
```

或者在 `docker-compose.yml` 中定义。注意需要在镜像中安装 `curl` 或使用 Node 脚本做健康检查。

### 3.3 容器以 root 运行

Node.js 进程和 cron 都以 root 身份运行。最佳实践是创建非 root 用户。不过对于个人 NAS 上的签到工具，这属于锦上添花。

### 3.4 镜像体积较大

`node:20-bookworm` 基础镜像 + Chromium + Playwright 依赖，预计镜像大小在 1GB 以上。可以考虑：

- 使用 `node:20-slim` 代替 `node:20-bookworm`（需要手动安装更多依赖）
- 构建完成后清理 apt 缓存：`RUN apt-get clean && rm -rf /var/lib/apt/lists/*`
- 多阶段构建（将 Playwright 安装层和应用层分开）

### 3.5 日志文件无限增长

`checkin.log` 没有日志轮转机制。每天签到产生的日志会一直追加，长期运行后文件会越来越大。建议：

- 使用 `logrotate`（需要在容器中安装配置）
- 或在脚本中限制日志行数
- 或在 Dockerfile 中安装 `cron` 之外的日志轮转方案

### 3.6 Web 界面 UI 小问题

- 密码输入框使用了 `type="password"`，但 `GET /api/env` 返回明文密码。前端获取密码后填入 input，密码值在 HTML DOM 中可被开发者工具读取
- 保存配置时 `new FormData(form).forEach((v, k) => { if (v) data[k] = v; })` —— 如果用户想清空某个可选字段（如 PUSHPLUS_TOKEN），因为 `if (v)` 的判断，空值不会被提交，导致无法清除已有配置

### 3.7 前端日志高亮逻辑

```javascript
if (l.includes('成功') || l.includes('已签到')) cls = 'ok';
if (l.includes('失败') || l.includes('Error') || l.includes('error')) cls = 'err';
```

如果一行日志同时包含"成功"和"error"（虽然概率低），会显示为红色错误。`includes` 匹配过于宽泛，比如"签到成功，电量余额：0.01"这种正常行如果碰巧包含某个关键词可能误判。

---

## 四、问题汇总与优先级

| # | 严重度 | 问题 | 文件 | 行号 |
|---|--------|------|------|------|
| 1 | **严重** | 日志路径不一致（手动签到日志无法在 Web 查看） | server.js | 117, 104 |
| 2 | **严重** | CRON_SCHEDULE 命令注入 | server.js | 104 |
| 3 | **严重** | Web 界面无认证，密码明文可读 | server.js | 全局 |
| 4 | **严重** | heredoc 中特殊字符导致密码错误 | entrypoint.sh | 8-18 |
| 5 | 中等 | 缺少 .dockerignore | 项目根目录 | - |
| 6 | 中等 | 截图路径用相对路径 | meimoai-checkin.js | 403 |
| 7 | 中等 | 手动签到结果不可追踪 | server.js | 115-124 |
| 8 | 中等 | 容器重启后 Web 配置丢失 | entrypoint.sh | 8-18 |
| 9 | 中等 | parseEnv 不处理引号 | server.js | 136-149 |
| 10 | 中等 | playwright 版本未完全锁定 | package.json | 12 |
| 11 | 轻微 | version 字段已废弃 | docker-compose.yml | 1 |
| 12 | 轻微 | 缺少 HEALTHCHECK | Dockerfile | - |
| 13 | 轻微 | 容器以 root 运行 | Dockerfile | - |
| 14 | 轻微 | 镜像体积较大 | Dockerfile | - |
| 15 | 轻微 | 日志无轮转 | entrypoint.sh | - |
| 16 | 轻微 | 清空可选字段无效 | server.js | 315 |
| 17 | 轻微 | 日志高亮可能误判 | server.js | 289-291 |

---

## 五、总结

项目整体结构清晰，核心签到逻辑（反检测、持久化登录态、多推送渠道）实现得比较完善。主要问题集中在 **Web 管理后台的安全性** 和 **路径一致性** 上。

**必须修复的 4 个严重问题：**
1. 统一所有日志路径为 `/app/logs/checkin.log`
2. 对 CRON_SCHEDULE 做 cron 表达式格式校验（正则匹配 `^[\d*/,\- ]+$`）
3. 给 Web 界面加基础认证（HTTP Basic Auth 或简单的密码保护）
4. 用 `cat << 'EOF'`（单引号 EOF）禁用 heredoc 变量替换，或改用 `printf '%s\n'` 写入

修复这 4 个问题后，项目就可以放心部署到 NAS 上长期运行了。
