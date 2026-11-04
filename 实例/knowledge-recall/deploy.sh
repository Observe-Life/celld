#!/bin/sh
# 部署 knowledge-recall（本容器的根，必须最后部署：celld 的全局指针 deploy/current.json 是单选器）
set -e
cd "$(dirname "$0")"
GATES="${CELLD_PREFLIGHT_GATES:-/vol1/docker/astrbot/data/plugins/astrbot_plugin_celld_preflight/skills/celld-preflight/gates}"
SKIP=0
for a in "$@"; do [ "$a" = "--skip-gates" ] && SKIP=1; done
if [ "$SKIP" = "1" ]; then
  echo "[gates] 显式跳过闸门（已留痕）"; echo "$(date -Is) SKIP-GATES knowledge-recall" >> .gates-audit.log
else
  [ -f acceptance.json ] || { echo "[gates] FAIL: 缺少 acceptance.json"; exit 1; }
  bash "$GATES/preflight.sh" "$(pwd)/acceptance.json" || { echo "[gates] L0 失败，拒绝部署"; exit 1; }
  bash "$GATES/platform-contract.sh" "$(pwd)" || { echo "[gates] L0.5 失败，拒绝部署"; exit 1; }
  bash "$GATES/typecheck.sh" "$(pwd)" || { echo "[gates] L1 失败，拒绝部署"; exit 1; }
  echo "[gates] L0+L0.5+L1 通过"
fi
# 生成真实配置（先产出、后闸门复检，避免拿旧生成物卡死）
python3 - <<PYEOF
import json
tpl = open("wrangler.template.jsonc").read()
sec = json.load(open("secrets.json"))
tpl = tpl.replace("@WEKNORA_KEY@", sec["WEKNORA_KEY"])
open("wrangler.jsonc", "w").write(tpl)
PYEOF
chmod 600 wrangler.jsonc secrets.json
if grep -q '@[A-Z_]*@' wrangler.jsonc; then echo "[gates] FAIL: 生成配置残留占位符"; exit 1; fi
set -a; . ../../.env; set +a
docker run --rm --network backend -v "$(pwd)":/app -w /app \
  -e AWS_ACCESS_KEY_ID=$MINIO_ROOT_USER -e AWS_SECRET_ACCESS_KEY=$MINIO_ROOT_PASSWORD \
  -e S3_ENDPOINT=http://minio:9000 -e AWS_REGION=us-east-1 \
  celld-full:latest deploy . --bucket s3://celld-recall
echo "knowledge-recall 已部署（本容器的根）"
