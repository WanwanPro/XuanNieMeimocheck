#!/usr/bin/env bash
set -euo pipefail

archive="${1:-}"
if [[ -z "${archive}" ]]; then
  echo "用法: bash deploy/install-image.sh meimoai-checkin-<sha>-amd64.tar.gz" >&2
  exit 2
fi
if [[ ! -f "${archive}" ]]; then
  echo "找不到镜像文件: ${archive}" >&2
  exit 2
fi
if [[ ! -f .env ]]; then
  echo "缺少项目根目录 .env，请先参考 deploy/.env.production.example 创建。" >&2
  exit 2
fi

if command -v sha256sum >/dev/null 2>&1 && [[ -f "${archive}.sha256" ]]; then
  sha256sum -c "${archive}.sha256"
fi

gzip -dc "${archive}" | docker load
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps