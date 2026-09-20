# GitHub Actions 构建与服务器部署

这套流程的目标是：

1. 代码推送到 GitHub。
2. GitHub Actions 自动安装依赖、运行测试、构建 `linux/amd64` Docker 镜像。
3. 自动导出 `meimoai-checkin-<commit>-amd64.tar.gz` 和对应 SHA256。
4. 你在服务器上下载并执行 `docker load`，通过 Docker Compose 启动。
5. Caddy 负责 `check.wanwanpro.top` 的 HTTPS 和反向代理。

## 0. 先处理飞书 App Secret

飞书开放平台里的 App Secret 一旦出现在聊天、截图、Issue、提交记录或日志中，应视为已经泄露。

请先去飞书开放平台重置 App Secret，然后把新值只写入服务器上的 `.env`。不要写进 Git 仓库、Workflow 或 Docker 镜像。

## 1. 推送到 GitHub

如果当前目录还没有 Git 仓库：

```powershell
git init -b main
git add -A
git commit -m "Initial commit"
git remote add origin https://github.com/<你的账号>/<仓库名>.git
git push -u origin main
```

之后每次推送 `main` 或 `master`，GitHub Actions 都会自动构建。

也可以创建一个版本标签，构建后会同时上传到 GitHub Release：

```powershell
git tag v2.1.0
git push origin v2.1.0
```

GitHub Release 中可以直接下载：

```text
meimoai-checkin-<commit>-amd64.tar.gz
meimoai-checkin-<commit>-amd64.tar.gz.sha256
```

如果只是普通 push，可以在 GitHub Actions 页面下载 Artifact，保留时间为 30 天。

## 2. Workflow 会做什么

Workflow 文件：

```text
.github/workflows/build-image.yml
```

执行步骤：

1. 安装 Node.js 20 和生产依赖。
2. 执行 `npm test`。
3. 用 Dockerfile 构建 `meimoai-checkin:latest` 和 commit SHA 标签。
4. 使用 `docker save | gzip` 导出服务器可直接加载的镜像压缩包。
5. 上传 GitHub Actions Artifact。
6. 如果触发的是 `v*` 标签，则同时上传 GitHub Release。

默认构建目标为 `linux/amd64`，适合常见 x86_64 云服务器。若服务器是 ARM，需要同步修改 Workflow 的 `--platform`。

## 3. 准备服务器目录

服务器需要安装：

- Docker
- Docker Compose Plugin
- Caddy

建议目录：

```bash
sudo mkdir -p /opt/meimoai-checkin
sudo chown -R "$USER":"$USER" /opt/meimoai-checkin
cd /opt/meimoai-checkin
```

把以下文件放到这个目录：

```text
docker-compose.prod.yml
deploy/.env.production.example
deploy/Caddyfile.example
deploy/install-image.sh
meimoai-checkin-<commit>-amd64.tar.gz
meimoai-checkin-<commit>-amd64.tar.gz.sha256
```

如果你在服务器上直接拉取 Git 仓库，项目根目录已经包含前四项，只需要额外下载镜像 tar.gz。

## 4. 创建生产环境配置

```bash
cp deploy/.env.production.example .env
nano .env
```

至少填写：

```dotenv
MEIMOAI_ACCOUNT=你的签到账号
MEIMOAI_PASSWORD=你的签到密码

FEISHU_SSO_ENABLED=true
FEISHU_APP_ID=cli_你的AppID
FEISHU_APP_SECRET=重置后的新AppSecret
FEISHU_REDIRECT_URI=https://check.wanwanpro.top/api/auth/feishu/callback

# 两项至少填一项
FEISHU_ALLOWED_TENANT_KEYS=你的tenant_key
FEISHU_ALLOWED_OPEN_IDS=

# 可选：紧急管理密码；推荐使用 npm run hash 生成 scrypt 哈希
WEB_PASSWORD=

WEB_TRUST_PROXY=1
HOST_PORT=7788
```

注意：

- `FEISHU_REDIRECT_URI` 必须和飞书开放平台中的重定向 URL 完全一致。
- 不要填写 `http://192.168.0.98:7788/...` 或 `http://10.126.126.98:7788/...`。当前项目只接受 HTTPS 回调，本机调试除外。
- `.env` 已被 `.gitignore` 忽略，不要强制提交。
- 不要在没有认证的情况下把 7788 端口暴露到公网。

## 5. 加载镜像并启动

在项目根目录执行：

```bash
bash deploy/install-image.sh meimoai-checkin-<commit>-amd64.tar.gz
```

也可以手动执行：

```bash
sha256sum -c meimoai-checkin-<commit>-amd64.tar.gz.sha256
gzip -dc meimoai-checkin-<commit>-amd64.tar.gz | docker load
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
```

Compose 只把服务绑定到：

```text
127.0.0.1:7788
```

公网请求由 Caddy 转发，不会直接暴露应用端口。

检查容器：

```bash
curl -fsS http://127.0.0.1:7788/healthz
docker compose -f docker-compose.prod.yml logs -f --tail=100
```

## 6. 配置 DNS 与 Caddy HTTPS

在域名服务商处添加：

```text
类型：A
名称：check
值：服务器公网 IPv4
```

让 `check.wanwanpro.top` 解析到服务器公网 IP。

安装 Caddy 后，复制配置：

```bash
sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddyfile 示例：

```caddyfile
check.wanwanpro.top {
    encode zstd gzip
    reverse_proxy 127.0.0.1:7788
}
```

服务器防火墙只需开放：

```text
80/tcp
443/tcp
```

不要向公网开放 7788。Caddy 会自动申请并续期 HTTPS 证书。

验证：

```bash
curl -I https://check.wanwanpro.top
curl -fsS https://check.wanwanpro.top/healthz
```

## 7. 飞书开放平台最终配置

网页应用配置：

```text
桌面端主页：https://check.wanwanpro.top
移动端主页：https://check.wanwanpro.top
```

安全设置中的重定向 URL：

```text
https://check.wanwanpro.top/api/auth/feishu/callback
```

同时确认：

- 已开启网页应用能力。
- 已将 `check.wanwanpro.top` 加入可信域名。
- 已开通登录及用户基本信息相关权限。
- 已发布应用版本并完成企业管理员审核。

检查配置是否生效：

```bash
curl -fsS https://check.wanwanpro.top/api/auth-status
```

理想结果包含：

```json
{
  "authRequired": true,
  "passwordEnabled": true,
  "feishuEnabled": true,
  "feishuConfigProblems": []
}
```

如果 `feishuEnabled` 仍为 `false`，查看 `feishuConfigProblems`，其中会列出缺少的配置项。飞书客户端内出现登录问题时，同时查看：

```bash
docker compose -f docker-compose.prod.yml logs --tail=200
```

## 8. 后续更新流程

日常更新：

1. 本地修改代码并推送 `main`。
2. 等待 GitHub Actions 成功。
3. 下载新的镜像 tar.gz。
4. 上传到服务器项目目录。
5. 执行：

```bash
bash deploy/install-image.sh meimoai-checkin-<新commit>-amd64.tar.gz
```

脚本会先校验 SHA256，再加载新镜像，并以新镜像重新创建容器。

生产发布建议使用版本标签：

```bash
git tag v2.1.1
git push origin v2.1.1
```

这样可以直接从 GitHub Release 下载对应版本，回滚时也有明确的镜像版本记录。

## 9. 数据与备份

持久化卷：

```text
checkin-data  -> /app/.browser-profile
checkin-logs  -> /app/logs
checkin-env   -> /app/.env-data
```

升级或迁移前备份：

```bash
docker run --rm \
  -v meimoai-checkin_checkin-data:/data \
  -v "$PWD":/backup \
  alpine sh -c 'tar czf /backup/checkin-data.tar.gz -C /data .'

docker run --rm \
  -v meimoai-checkin_checkin-env:/data \
  -v "$PWD":/backup \
  alpine sh -c 'tar czf /backup/checkin-env.tar.gz -C /data .'
```

卷名前缀可能随 Compose 项目目录名变化，先用以下命令确认：

```bash
docker volume ls
```