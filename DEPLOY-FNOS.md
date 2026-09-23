# 飞牛 NAS（fnOS）部署与旧版本替换指南

本文档针对的场景是：**飞牛 NAS 上已经跑着一个旧版本，现在要用新版本原地替换掉它。**

> 仓库里已有的 [DEPLOY.md](DEPLOY.md) 和 [README.md](README.md) 是写给「云服务器 + Caddy + GitHub Actions 构建镜像」的，
> 没有覆盖飞牛 NAS，也漏掉了升级时最容易丢数据/最容易被静默忽略的两件事。
> **替换场景请以本文档为准**，DEPLOY.md 只在「镜像怎么构建、飞书平台怎么配」这些环节作为补充参考。

本文档的每条命令都经过核查；凡是我无法在飞牛 NAS 上替你验证的，都在
[第 9 节](#9-需要你在自己机器上确认的事) 单独列出，并给了确认命令。

---

## 0. 先记住三件事（读完再动手）

**① 数据跟着「卷名」走，而卷名由部署目录名决定 —— 放错目录 = 登录态全丢。**
新版 Firefox 的登录态存在命名卷里。如果你把新版本解压到**另一个目录**再启动，Compose
会新建一整套**空卷**，旧登录态不会被挂载，你得重新扫码登录。
更隐蔽的是：如果旧版本当初是用 `docker run -v checkin-data:...` 部署的，卷名是不带前缀的
字面量 `checkin-data`，此时**即使放回原目录**也挂不到旧数据。
**所以第一步永远是先用 `docker inspect` 把真实卷名查出来，而不是假设。**（见第 1 节）

**② 卷里的 `.env` 一旦存在，就会「钉死」它里面已经有的每一个配置键。**
`/app/.env-data/.env` 里只要存在某个键（**哪怕是空字符串**），宿主机 `.env` 里对同一个键的新值
就会被**静默忽略**。这对「从旧版本升级」尤其致命，因为它会让你以为配置改了、其实没生效。
实测三种情形：

| 卷内旧 `.env` 的样子 | 你在宿主机 `.env` 里新写的配置 | 结果 |
|---|---|---|
| 完全没有 `FEISHU_*` / `WEB_PASSWORD` 键 | ✅ 生效 | 正常 |
| 有 `WEB_PASSWORD=""` | ❌ 被空值盖掉 | 飞书能登，但密码应急入口失效 |
| 有 `FEISHU_SSO_ENABLED="false"` | ❌ 全部被盖掉 | **`authRequired=false`，面板完全无认证** |

第三种情况意味着：任何能访问 7788 端口的人都能看到你的明文账号密码、改配置、触发签到。
修复办法见第 4 节。

**③ 飞书登录必须有一个「公网可达的 HTTPS 域名」——这是代码层面的硬约束，绕不开。**
回调地址在 [src/config.js:84](src/config.js:84) 里被强制要求 HTTPS（只有 localhost 可以 HTTP），
路径必须精确是 `/api/auth/feishu/callback`。手机飞书也要能打开这个页面。
飞牛系统**没有**「把任意域名代理到容器端口」的通用反向代理功能，得自己加（见第 6 节）。

---

## 1. 第 0 步：摸清旧部署的现状

SSH 登录 NAS，逐条执行。**这些命令只读，不改任何东西。**

```bash
# 1) 架构必须先确认：镜像只构建了 linux/amd64
uname -m
docker info --format '{{.Architecture}}'
```

期望 `x86_64` / `amd64`。**如果输出 `aarch64` / `arm64`，预构建的镜像无法运行**
（会报 `exec format error`），需要改为在本机从源码构建（见第 3 节）。

```bash
# 2) compose CLI 是 v2 还是 v1 —— 飞牛上这两者不保证都有，必须实测
docker compose version
docker-compose version
```

哪条有版本输出就用哪条。下文统一按 v2 的 `docker compose` 写；若你的机器只有 v1，
把命令里的 `docker compose` 换成 `docker-compose` 即可。

```bash
# 3) 找到旧容器，并查出它的真实卷名 —— 【这一步最关键，不要跳过】
docker ps -a --filter name=meimoai-checkin
docker inspect meimoai-checkin --format '{{json .Mounts}}'
```

`Mounts` 里 `Destination` 对应 `/app/.browser-profile`、`/app/.env-data`、`/app/logs`
的三项，它们的 `Name` 就是**真实卷名**。把这三个名字抄下来，例如：

- 卷名可能是 `meimoai-checkin_checkin-data`（Compose 部署，前缀 = 项目目录名）
- 也可能是 `checkin-data`（`docker run -v` 部署，无前缀）

后面所有对卷的操作**都用你抄下来的真实卷名**，不要照抄文档里的示例名。

```bash
# 4) 记录旧容器的端口绑定，替换后好对比
docker inspect meimoai-checkin --format '{{json .HostConfig.PortBindings}}'

# 5) 记录旧的卷名前缀，用于判断新版本该放哪个目录
docker volume ls | grep -i checkin
```

```bash
# 6) 看旧版本当初是怎么起的：有 compose 文件就用它，没有就是 docker run
docker inspect meimoai-checkin --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}'
docker inspect meimoai-checkin --format '{{index .Config.Labels "com.docker.compose.project"}}'
```

这两条会告诉你旧部署的**目录**和**项目名**。新版本应当放回这个目录，
项目名才会一致、卷才会复用。

```bash
# 7) 看一眼旧容器里现有配置（含所有凭据），确认第 0 节②说的是哪种情形
docker exec meimoai-checkin cat /app/.env-data/.env
```

**重点看两行**：`FEISHU_SSO_ENABLED=` 和 `WEB_PASSWORD=` 是否存在、值是什么。
- 这两个键**都不存在** → 你在宿主机 `.env` 里写的新值会生效，升级后按第 4 节正常配置即可。
- 存在（哪怕值是空）→ 它们被钉死了，必须按第 4 节先处理卷内 `.env`。

如果容器已经跑不起来，用临时容器读：

```bash
VOL=$(docker inspect meimoai-checkin --format '{{range .Mounts}}{{if eq .Destination "/app/.env-data"}}{{.Name}}{{end}}{{end}}')
echo "$VOL"
docker run --rm -v "$VOL":/d alpine cat /d/.env
```

---

## 2. 第 1 步：备份（替换前必做）

对三个卷各跑一次。把 `<卷名>` 换成第 1 节查到的真实卷名。

```bash
mkdir -p ~/meimoai-backup && cd ~/meimoai-backup

for pair in "<卷名_checkin-data>|checkin-data" "<卷名_checkin-env>|checkin-env" "<卷名_checkin-logs>|checkin-logs"; do
  vol="${pair%%|*}"; out="${pair##*|}"
  docker run --rm -v "$vol":/data -v "$PWD":/backup alpine \
    sh -c "tar czf /backup/$out.tar.gz -C /data ."
done

ls -lh *.tar.gz
```

**备份后一定要确认不是空包**（写错卷名时 Docker 会静默新建一个空卷，命令照样成功）：

```bash
tar tzf checkin-env.tar.gz    # 应看到 .env
tar tzf checkin-data.tar.gz | head   # 应看到 Firefox profile 相关文件
```

> ⚠️ 任何时候都**不要**执行 `docker compose down -v`。`-v` 会删掉这三个卷，
> 浏览器登录态、日志、Web 配置全部丢失。

---

## 3. 第 2 步：准备新镜像（并留好回滚点）

先给当前镜像打个标签，万一翻车可以一键退回（`docker load` 会覆盖同名标签）：

```bash
docker tag meimoai-checkin:latest meimoai-checkin:pre-upgrade
docker images | grep meimoai-checkin
```

然后二选一：

**方式 A：在 NAS 上从源码构建（推荐，尤其是 ARM 机器，或你想带上最新修复）**

前提：这个目录里要有**完整源码**（`Dockerfile`、`src/`、`public/`、`entrypoint.sh` 等），
而不只是 compose 文件。如果你的部署目录当初是照 DEPLOY.md 第 3 节逐个文件拷的，
那就只有 compose 和镜像包——这种情况要么改用方式 B，要么把整个仓库 clone/clone 到这个目录。

```bash
cd <旧部署所在目录>        # 放回原目录，卷才会复用
docker compose build --pull
```

注意要用带 `build:` 的 [docker-compose.yml](docker-compose.yml)。
[docker-compose.prod.yml](docker-compose.prod.yml) **只有 `image:` 没有 `build:`**，
对着它执行 `build` 是不行的。

**方式 B：加载 CI 构建好的镜像包**

```bash
sha256sum -c meimoai-checkin-<commit>-amd64.tar.gz.sha256
gzip -dc meimoai-checkin-<commit>-amd64.tar.gz | docker load
docker images | grep meimoai-checkin
```

之后用 `docker-compose.prod.yml` 启动（它不构建，直接用 load 进来的镜像）。

> **关于本次的代码修复**：`src/web/feishu.js` 与 `tools/_page.html` 里修掉了两个会导致
> 飞书免登失败/不可靠的问题（详见文末附录）。这两个修复已随当前提交进入源码。
> 想让它进 CI 镜像，需要在 push 后等 Actions 重新构建；
> 或者直接用方式 A 在本机从这份源码构建，也会带上修复。

---

## 4. 第 3 步：写配置（这里最容易把自己锁在门外）

进入旧部署目录，准备 `.env`：

```bash
cd <旧部署所在目录>
cp deploy/.env.production.example .env   # 已有 .env 就别覆盖，直接编辑
```

**两条铁律，务必遵守：**

**① `WEB_PASSWORD` 必须先设成一个真实密码，再启动。**
仓库自带的模板默认是 `FEISHU_SSO_ENABLED=true` + `WEB_PASSWORD=`（空）。
如果飞书凭证/白名单没填全，这是 fail-closed：面板会锁死，`/api/login` 返回 401、
飞书入口 302 到 `?auth_error=disabled`，**页面上没有任何能点的登录入口**。
（模板里还有个自相矛盾：DEPLOY.md 第 7 节期望 `passwordEnabled: true`，
但第 4 节又让你把 `WEB_PASSWORD` 留空——这两件事不可能同时成立。）

**② 白名单两项都不能留空。**
`FEISHU_ALLOWED_TENANT_KEYS` 和 `FEISHU_ALLOWED_OPEN_IDS` 都为空时，
`/api/auth/feishu/start` 不会进入授权流程，而是直接 302 到 `/?auth_error=disabled`。
更麻烦的是：**这样你永远拿不到自己的 `open_id`**，因为所有会打印 `open_id` 的日志都在
配置完整性检查之后，走不到那儿。
正确做法是先填一个**占位值**，把流程跑通、从日志拿到 `open_id`，
再把占位值删掉（见第 7 节）。

一份能安全启动的最小配置：

```dotenv
MEIMOAI_ACCOUNT=你的签到账号
MEIMOAI_PASSWORD=你的签到密码

# 先用真实密码把自己保住，配置齐了再考虑要不要去掉
WEB_PASSWORD=你的管理密码

FEISHU_SSO_ENABLED=true
FEISHU_APP_ID=cli_xxxxxxxx
FEISHU_APP_SECRET=xxxxxxxx
FEISHU_REDIRECT_URI=https://你的域名/api/auth/feishu/callback
# 先填占位值！拿到 open_id 后再换（见第 7 节）
FEISHU_ALLOWED_TENANT_KEYS=placeholder
FEISHU_ALLOWED_OPEN_IDS=

WEB_TRUST_PROXY=1
HOST_PORT=7788
```

`FEISHU_REDIRECT_URI` 必须与飞书开放平台里配的重定向 URL **完全一致**，
且不能用 `http://192.168.x.x:7788/...` 这类内网地址。

### 如果第 1 节发现「卷内 `.env` 已经钉死了键」

**手段一（推荐，改动最小）** —— 直接改卷内 `.env`：

```bash
docker exec meimoai-checkin sh -c 'cp /app/.env-data/.env /app/.env-data/.env.bak'

# 键已存在就替换；不存在则追加（注意值是 KEY="value" 的带引号形式）
docker exec meimoai-checkin sh -c 'f=/app/.env-data/.env
  grep -q "^FEISHU_SSO_ENABLED=" $f && sed -i "s|^FEISHU_SSO_ENABLED=.*|FEISHU_SSO_ENABLED=\"true\"|" $f || echo "FEISHU_SSO_ENABLED=\"true\"" >> $f
  grep -q "^WEB_PASSWORD=" $f && sed -i "s|^WEB_PASSWORD=.*|WEB_PASSWORD=\"你的管理密码\"|" $f || echo "WEB_PASSWORD=\"你的管理密码\"" >> $f'

docker exec meimoai-checkin cat /app/.env-data/.env    # 逐行确认格式是 KEY="value"
docker restart meimoai-checkin
```

**手段二（一次性对齐全部配置）** —— 先确保宿主机 `.env` 已填全，再删掉卷内文件让它重新生成：

```bash
docker exec meimoai-checkin rm /app/.env-data/.env
docker restart meimoai-checkin
docker logs meimoai-checkin 2>&1 | grep init-env    # 期望看到「[init-env] 已生成」
```

代价是：只在 Web 面板里改过、而宿主机 `.env` 里没有的配置会丢。

> 注意：宿主机 `.env` 的改动只在容器**重建**时注入。`docker restart` 复用原容器、
> **不会**应用新的 `.env`，必须用 `up -d`（保险起见加 `--force-recreate`）。

---

## 5. 第 4 步：替换并启动

```bash
cd <旧部署所在目录>

# 先停掉旧容器，避免容器名冲突（两份 compose 都写死了 container_name: meimoai-checkin）
docker stop meimoai-checkin && docker rm meimoai-checkin

# 方式 A（本机构建）：
docker compose up -d --force-recreate

# 方式 B（load 镜像）：
docker compose -f docker-compose.prod.yml up -d --force-recreate

docker compose ps
docker logs --tail=100 meimoai-checkin
```

确认容器真的挂到了旧卷（这一步能立刻发现「挂错卷了」）：

```bash
docker inspect meimoai-checkin --format '{{range .Mounts}}{{.Name}} -> {{.Destination}}{{"\n"}}{{end}}'
```

三个卷名应当与你第 1 节抄下来的**完全一致**。不一致就说明放错目录了，
登录态会丢——立刻停容器、把目录换回去重来。

健康检查：

```bash
curl -fsS http://127.0.0.1:7788/healthz        # 期望 {"ok":true}
curl -fsS http://127.0.0.1:7788/api/auth-status
```

`/api/auth-status` 的期望值（填了 `WEB_PASSWORD` 的前提下）：

```json
{ "authRequired": true, "passwordEnabled": true, "feishuEnabled": true, "feishuConfigProblems": [] }
```

如果 `feishuEnabled` 是 `false`，看 `feishuConfigProblems` 数组——它会列出缺哪一项。

**注意端口绑定的变化**：新版两份 compose 都只绑 `127.0.0.1:7788`（仅宿主机回环）。
如果你的旧容器当初绑的是 `0.0.0.0:7788`（局域网可访问），替换后从手机/局域网就打不开了。
要么改回 `7788:7788`，要么走第 6 节的反向代理。

---

## 6. 第 5 步：HTTPS 入口（飞书登录的前置条件）

飞牛系统**没有**通用的「域名 → 容器端口」反向代理（官方帮助中心只有公网 IP 直连、DDNS、
FN Connect、P2P 四种「访问 NAS 本身」的方式，没有反代类目）。
所以要自己加一层，两条路选一条：

### 方案 A：Caddy（有公网 IP 时，推荐）

把仓库里的 [deploy/Caddyfile.example](deploy/Caddyfile.example) 复制到 NAS 上，
内容就两行，Caddy 会自动申请并续期受信任证书：

```caddyfile
你的域名 {
    encode zstd gzip
    reverse_proxy 127.0.0.1:7788
}
```

Caddy 装在**宿主机**上（不是容器里）时，直接就能访问 `127.0.0.1:7788`，
因为服务本身就发布在宿主机回环上。安装后：

```bash
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
curl -I https://你的域名
```

防火墙只需开放 80 / 443，**不要**把 7788 暴露到公网。

### 方案 B：Cloudflare Tunnel（没有公网 IP，或 80/443 被运营商封了）

前置条件：**域名必须托管在 Cloudflare**（把域名的 NS 改到 CF）。
好处是不需要公网 IP、不需要开放任何入站端口，cloudflared 只做出站连接。

```bash
docker run -d --name cloudflared --restart unless-stopped \
  cloudflare/cloudflared:latest tunnel --no-autoupdate run --token <你的TOKEN>
```

在 Cloudflare Dashboard 里建隧道，Service URL 填 `http://127.0.0.1:7788`。
让 cloudflared 能访问到这个地址有两种做法，选一种即可：

- 给 cloudflared 容器加 `--network host`；或
- 把 cloudflared 接入**与本服务同一个 docker 网络**，Service URL 填 `http://meimoai-checkin:7788`
  （容器内进程默认监听 `0.0.0.0`，见 [src/paths.js:20](src/paths.js:20)）。

子域请用单级（如 `check.你的域名`）——多级子域在 Cloudflare 需要额外买证书。

```bash
docker logs cloudflared          # 出现 Registered tunnel connection 即已连上
```

### 无论走哪条路，都必须做这一件事

**把 `WEB_TRUST_PROXY` 设为 `1`。** 不设的话：

- 会话 Cookie 不会带 `Secure` 属性（一次 http 访问就会明文泄露 24 小时有效的会话凭据）；
- 登录限流基于 `req.ip`，会把所有请求算成同一个代理 IP——任意人发 10 次错误密码
  就能把密码入口锁 15 分钟，而且可以无限续锁。

Caddy 和 Cloudflare 默认都会下发 `X-Forwarded-Proto`，所以填 `1` 就对了。
**注意 `WEB_TRUST_PROXY` 写 `true` 或 `all` 会被代码强制降级为 `false` 并只打一行告警**，
别用。这个值是进程启动时读一次，改完必须重建容器。

> 不建议用 Tailscale / WireGuard 一类组网做飞书入口：飞书登录要的是「公网可达、
> 受信任证书」的域名，组网只保证装了客户端的设备互访。它适合你自己用浏览器访问，
> 不适合当飞书 SSO 的入口。

---

## 7. 第 6 步：飞书开放平台配置 + 拿到自己的 `open_id`

在[飞书开放平台](https://open.feishu.cn/app/)里逐项配好，缺一项就会卡在对应的错误码上：

1. 创建**企业自建应用**，「凭证与基础信息」里拿 App ID / App Secret。
2. **安全设置 → 重定向 URL** 添加 `https://你的域名/api/auth/feishu/callback`
   （必须与 `FEISHU_REDIRECT_URI` 完全一致：协议、域名、路径、结尾斜杠都不能差）。
3. **网页应用**：开启网页能力，桌面端主页和移动端主页都填 `https://你的域名`。
4. **H5 可信域名**：把 `你的域名` 加进去。免登（JSAPI）依赖这一项，容易漏。
5. **权限管理**：开通登录与用户基本信息读取权限。
6. **版本管理与发布**：创建版本并发布，等企业管理员审核通过。未发布时授权会报 `20029` / `20027`。

### 拿 `open_id` 的正确姿势

模板里让你填 `FEISHU_ALLOWED_TENANT_KEYS=你的tenant_key`，但 `tenant_key` 代码里从来不打印，
而白名单两项都留空又会让流程被拦在门口（见第 4 节②）。
所以**先填占位值**：

```dotenv
FEISHU_ALLOWED_TENANT_KEYS=placeholder
```

重启后用飞书登录一次（会被拒绝，这是预期的），日志里就会打印你自己的 `open_id`：

```bash
docker exec meimoai-checkin grep -i "open_id" /app/logs/checkin.log
```

拿到后改成真实名单，并把占位值删掉：

```dotenv
FEISHU_ALLOWED_TENANT_KEYS=
FEISHU_ALLOWED_OPEN_IDS=ou_你的openid
```

> 想只限制自己一个人，就只填 `FEISHU_ALLOWED_OPEN_IDS`。
> 想放行整个企业，就填 `FEISHU_ALLOWED_TENANT_KEYS`——
> 注意这两个是**或**的关系，填了企业 `tenant_key` 就等于该企业所有人可登录。

---

## 8. 第 7 步：验收

替换完成后按这个顺序测，能把问题隔离开：

**① 浏览器扫码（验证 OAuth 通道）** —— 用电脑浏览器打开 `https://你的域名`，
应当自动跳转飞书授权页，扫码/确认后回到面板。这一步验证了域名、证书、反代、
飞书平台配置、白名单、会话落地。**这一步通过，说明大部分配置都是对的。**

**② 飞书客户端内免登（验证 JSAPI 通道）** —— 用手机飞书打开同一个地址，
应当直接免密进入。

失败时抓两样东西：

```bash
docker exec meimoai-checkin grep "\[FEISHU\]" /app/logs/checkin.log | tail -30
```

以及浏览器/H5 调试里 `h5sdk.config` 的 errMsg / errCode。
`333441`（签名错误）、`333444`（签名过期）指向签名问题；`333447`/`333448` 指向可信域名未配。

**③ 面板功能** —— 确认状态、日志、配置页都能打开，配置页里能看到你的飞书配置。
**④ 定时任务** —— 确认 cron 已生成：

```bash
docker exec meimoai-checkin cat /etc/cron.d/meimoai-checkin
```

---

## 9. 回滚

```bash
docker tag meimoai-checkin:pre-upgrade meimoai-checkin:latest
docker compose -f docker-compose.prod.yml up -d --force-recreate    # 或 docker compose
```

镜像回滚不影响数据卷。如果数据也出问题了，用第 2 节的备份包恢复：

```bash
VOL=$(docker inspect meimoai-checkin --format '{{range .Mounts}}{{if eq .Destination "/app/.env-data"}}{{.Name}}{{end}}{{end}}')
docker run --rm -v "$VOL":/data -v "$PWD":/backup alpine sh -c 'rm -rf /data/* && tar xzf /backup/checkin-env.tar.gz -C /data'
docker restart meimoai-checkin
```

---

## 10. 需要你在自己机器上确认的事

以下几项我无法替你验证，都给了确认命令。**其中前两项直接决定替换会不会丢数据。**

| # | 待确认 | 命令 | 期望 / 影响 |
|---|---|---|---|
| 1 | 旧卷的真实名字（会不会挂错卷） | `docker inspect meimoai-checkin --format '{{json .Mounts}}'` | 抄下三个 `Name`；与第 5 节替换后的输出比对，必须一致 |
| 2 | 旧部署是 Compose 还是 `docker run` | `docker inspect meimoai-checkin --format '{{index .Config.Labels "com.docker.compose.project"}}'` | 有输出=Compose（卷名带目录前缀）；空=`docker run`（卷名无前缀，此时放回原目录也不复用，需按真实卷名改 compose） |
| 3 | 卷内 `.env` 里 `FEISHU_*` / `WEB_PASSWORD` 是否已被钉死 | `docker exec meimoai-checkin cat /app/.env-data/.env` | 决定走第 4 节的哪种修复手段 |
| 4 | compose CLI 是 v2 还是 v1 | `docker compose version` / `docker-compose version` | 决定命令写法 |
| 5 | NAS 架构 | `uname -m` | 必须是 `x86_64`；ARM 需本地构建 |
| 6 | 旧容器原来的端口绑定 | `docker inspect meimoai-checkin --format '{{json .HostConfig.PortBindings}}'` | 若原来是 `0.0.0.0`，替换后局域网访问会断 |
| 7 | 飞牛系统里是否真有内置反向代理 | 在设置/应用中心搜「反向代理」「代理」 | 搜不到就按无内置处理，用第 6 节的方案 |
| 8 | 旧版本当初是否把密码/token 明文写在 compose 里 | `grep -nE 'PASSWORD\|TOKEN\|SECRET' <旧目录>/docker-compose.yml` | 命中即为明文残留，建议轮换这些凭据 |

> 另外：旧版本的源码不在当前仓库的可达历史里，所以旧版的容器路径、端口、
> 卷挂载、entrypoint 行为我无法逐项对比。上面第 1、2、3、6 项就是在补这个缺口。

---

## 11. 已知的、替换后依然存在的行为（不是 bug，但要知道）

- **会话只存在内存里**：容器一重建，所有人被弹回登录页，飞书要重新授权一次。
  这是设计如此（换来的是改密码/改白名单能立即吊销所有会话）。
- **白名单是「或」的关系**：`FEISHU_ALLOWED_TENANT_KEYS` 填了就等于该企业所有人可登录，
  不会与会 `FEISHU_ALLOWED_OPEN_IDS` 求交集。
  代码里那句「租户与用户维度都命中至少一项才放行」的注释写得有歧义，实现是 OR。
- **`PROXY_SERVER` 不作用于飞书 API 调用**：它只管签到用的浏览器。
  如果你的 NAS 必须走代理才能出网，飞书两条通道会连不上（报 `exchange` / `unavailable`）。
- **`/api/auth/feishu/start` 没有限流**，且全局 state 池有容量上限。
  公网暴露时理论上可被刷满导致登录失败（未设 `WEB_PASSWORD` 时影响更大）。
  这也是第 4 节①建议保留 `WEB_PASSWORD` 的原因之一。

---

## 附录：本次一并修掉的两个飞书登录问题

如果直接用这份源码构建（第 3 节方式 A），会带上以下修复：

**1. 免登签名的 `timestamp` 用了秒，飞书要求毫秒** —— [src/web/feishu.js](src/web/feishu.js)
原来是 `Math.floor(now() / 1000)`（10 位秒级）。飞书官方示例代码里写的是
`const timestamp = Date.now();`（13 位毫秒），且签名与下发给 `h5sdk.config` 的值必须一致。
秒级会被按 1970 年解析，签名新鲜度校验必然失败 → 免登整体失效。

**2. 前端把免登绑在了一个它并不依赖的鉴权步骤上** —— [tools/_page.html](tools/_page.html)
（`public/app.js` 由它生成）原本把 `h5sdk.config` 的 `onFail` 接进了免登 Promise，
config 一失败就整个 reject。但飞书官方明确 `requestAuthCode`「**无需进行网页应用鉴权**即可调用」，
官方免登示例根本不调 `config`。现在改为：`config` 只做尽力而为的调用，失败只记日志、
不再中断免登。

顺带补上了两处超时：原来只有 `requestAuthCode` 一处 9 秒超时，导致用户在授权确认框上
停留超过 9 秒就会丢掉晚到的授权码；而加载 SDK 和取签名两段完全没有超时，
一旦网络半开按钮会永久卡在「飞书免登中…」。现在三段各有独立超时
（SDK 8 秒、签名 8 秒、授权码 60 秒）。

测试：`npm test` 全绿（89 项），并新增了两条针对上述问题的回归测试，
防止以后被改回去。
