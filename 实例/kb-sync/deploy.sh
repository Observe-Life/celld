#!/bin/sh
# 用法: ./deploy.sh [SYNC_ALLOWLIST]
# 从 wrangler.template.jsonc + secrets.json 生成 wrangler.jsonc（含密钥，git 忽略），再用 celld 镜像部署
set -e
cd "$(dirname "$0")"
ALLOWLIST="${1:-}"
python3 - <<PYEOF
import json
tpl = open("wrangler.template.jsonc").read()
secrets = json.load(open("secrets.json"))
tpl = tpl.replace("@GEMINI_KEY@", secrets["GEMINI_KEY"])
tpl = tpl.replace("@WEKNORA_KEY@", secrets["WEKNORA_KEY"])
tpl = tpl.replace("@SHAPI_KEY@", secrets["SHAPI_KEY"])
tpl = tpl.replace("@JBB_KEY@", secrets["JBB_KEY"])
tpl = tpl.replace("@INGEST_TOKEN@", secrets["INGEST_TOKEN"])
tpl = tpl.replace("@SYNC_ALLOWLIST@", "$ALLOWLIST")
open("wrangler.jsonc", "w").write(tpl)
PYEOF
chmod 600 wrangler.jsonc secrets.json
set -a; . ../../.env; set +a
docker run --rm --network backend -v "$(pwd)":/app -w /app   -e AWS_ACCESS_KEY_ID=$MINIO_ROOT_USER -e AWS_SECRET_ACCESS_KEY=$MINIO_ROOT_PASSWORD   -e S3_ENDPOINT=http://minio:9000 -e AWS_REGION=us-east-1   celld-full:latest deploy . --bucket s3://celld-fleet
