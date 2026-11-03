#!/bin/sh
# 部署类型检查服务（无密钥、无绑定；纯计算 worker）
set -e
cd "$(dirname "$0")"
docker run --rm -v "$(pwd)":/app -w /app node:22-alpine sh -c \
  "npm i --registry=https://registry.npmmirror.com --silent >/dev/null 2>&1"
set -a; . ../../../.env; set +a
docker run --rm --network backend -v "$(pwd)":/app -w /app \
  -e AWS_ACCESS_KEY_ID=$MINIO_ROOT_USER -e AWS_SECRET_ACCESS_KEY=$MINIO_ROOT_PASSWORD \
  -e S3_ENDPOINT=http://minio:9000 -e AWS_REGION=us-east-1 \
  celld-full:latest deploy . --bucket s3://celld-fleet
