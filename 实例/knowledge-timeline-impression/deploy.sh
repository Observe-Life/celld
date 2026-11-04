#!/bin/sh
# 部署 knowledge-timeline-impression 到 celld-knowledge-recall 容器（桶 s3://celld-recall）
set -e
cd "$(dirname "$0")"
cp wrangler.template.jsonc wrangler.jsonc
GATES="${CELLD_PREFLIGHT_GATES:-/vol1/docker/astrbot/data/plugins/astrbot_plugin_celld_preflight/skills/celld-preflight/gates}"
SKIP=0
for a in "$@"; do [ "$a" = "--skip-gates" ] && SKIP=1; done
if [ "$SKIP" = "1" ]; then
  echo "[gates] 显式跳过闸门"; echo "$(date -Is) SKIP-GATES knowledge-timeline-impression" >> .gates-audit.log
else
  bash "$GATES/preflight.sh" "$(pwd)/acceptance.json" || { echo "[gates] L0 失败，拒绝部署"; exit 1; }
  bash "$GATES/platform-contract.sh" "$(pwd)" || { echo "[gates] L0.5 失败，拒绝部署"; exit 1; }
  bash "$GATES/typecheck.sh" "$(pwd)" || { echo "[gates] L1 失败，拒绝部署"; exit 1; }
  echo "[gates] L0+L0.5+L1 通过"
fi
set -a; . ../../.env; set +a
docker run --rm --network backend -v "$(pwd)":/app -w /app \
  -e AWS_ACCESS_KEY_ID=$MINIO_ROOT_USER -e AWS_SECRET_ACCESS_KEY=$MINIO_ROOT_PASSWORD \
  -e S3_ENDPOINT=http://minio:9000 -e AWS_REGION=us-east-1 \
  celld-full:latest deploy . --bucket s3://celld-recall
echo "注意：本实例是 cohosted 组件。若本次只部署了它，根指针不会变化，节点不会加载新 bundle。"
echo "     请随后重新部署 knowledge-recall（根），或执行：docker restart celld-knowledge-recall"
