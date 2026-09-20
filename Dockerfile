# 构建阶段只安装 Node 依赖，避免把 npm 缓存带进运行时镜像。
FROM node:20-bookworm AS deps
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; else npm install --omit=dev --no-audit --no-fund; fi

FROM node:20-bookworm

ARG TZ=Asia/Shanghai
ENV NODE_ENV=production \
    TZ=${TZ} \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# cron 需要 root 才能读取 /etc/cron.d；这是该容器保留 root 的唯一必要原因。
RUN apt-get update \
    && apt-get install -y --no-install-recommends cron tzdata ca-certificates \
    && ln -snf /usr/share/zoneinfo/${TZ} /etc/localtime \
    && echo ${TZ} > /etc/timezone \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
RUN npx playwright install --with-deps firefox \
    && rm -rf /var/lib/apt/lists/*

COPY src/ ./src/
COPY public/ ./public/
COPY scripts/ ./scripts/
COPY server.js ./
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh \
    && mkdir -p /app/logs /app/.env-data /app/.browser-profile

EXPOSE 7788

ENV MEIMOAI_ACCOUNT="" \
    MEIMOAI_PASSWORD="" \
    MEIMOAI_URL="https://meimoai13.com/" \
    RANDOM_DELAY="true" \
    RANDOM_DELAY_MAX_MINUTES="300" \
    SKIP_PROBABILITY="0.05" \
    MAX_CONSECUTIVE_FAILURES="3" \
    PROXY_SERVER="" \
    WANWAN_PUSH_TOKEN="" \
    PUSHPLUS_TOKEN="" \
    SERVERCHAN_SENDKEY="" \
    WEBHOOK_URL="" \
    WEB_PASSWORD="" \
    WEB_TRUST_PROXY="" \
    FEISHU_SSO_ENABLED="false" \
    FEISHU_APP_ID="" \
    FEISHU_APP_SECRET="" \
    FEISHU_REDIRECT_URI="" \
    FEISHU_ALLOWED_TENANT_KEYS="" \
    FEISHU_ALLOWED_OPEN_IDS="" \
    FEISHU_SCOPE="" \
    CRON_SCHEDULE="0 1 * * *"

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:7788/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["./entrypoint.sh"]
