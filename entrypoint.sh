#!/bin/bash
set -euo pipefail

mkdir -p /app/logs /app/.env-data /app/.browser-profile

# 首次启动从 compose/container 环境变量生成持久化 .env；已存在时保留 Web 修改。
node /app/scripts/init-env.js

# 生成 /etc/cron.d/meimoai-checkin，并让 cron 守护进程在启动时读取。
node /app/scripts/install-cron.js

# 方便外部脚本/旧工具按默认路径发现配置；真实事实来源仍是 .env-data/.env。
ln -sf /app/.env-data/.env /app/.env

echo "=== MeimoAI 签到服务已启动 ==="
echo "管理界面: http://0.0.0.0:7788"
echo "日志文件: /app/logs/checkin.log"
echo "状态文件: /app/logs/state.json"
echo "配置挂载: /app/.env-data/.env"
echo "=========================="

# Web 服务自动重启；异常退出时指数退避，避免端口冲突时刷爆日志。
web_restart_loop() {
  local delay=3
  while true; do
    local exit_code=0
    if node /app/server.js; then
      exit_code=0
    else
      exit_code=$?
    fi
    echo "[$(date -Iseconds)] Web server exited (code ${exit_code}), restarting in ${delay}s..."
    sleep "$delay"
    if [ "$delay" -lt 60 ]; then
      delay=$((delay * 2))
      if [ "$delay" -gt 60 ]; then
        delay=60
      fi
    fi
  done
}

web_restart_loop &

# cron 在容器前台运行并负责定时签到。
exec cron -f