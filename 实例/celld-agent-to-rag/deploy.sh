# 生成真实配置：把 @占位符@ 换成 secrets.json 里的值（漏了这步会把占位符字面量当密钥注入）
python3 - <<PYEOF
import json
tpl = open("wrangler.template.jsonc").read()
secrets = json.load(open("secrets.json"))
for key in ("GEMINI_KEY", "WEKNORA_KEY", "SHAPI_KEY", "JBB_KEY", "INGEST_TOKEN"):
    tpl = tpl.replace("@" + key + "@", secrets[key])
tpl = tpl.replace("@SYNC_ALLOWLIST@", "$ALLOWLIST")
open("wrangler.jsonc", "w").write(tpl)
PYEOF
chmod 600 wrangler.jsonc secrets.json

# ===== 上线前闸门（celld-preflight）：L0+L1 不过即拒绝部署；--skip-gates 显式绕过并留痕 =====
GATES="${CELLD_PREFLIGHT_GATES:-/vol1/docker/astrbot/data/plugins/astrbot_plugin_celld_preflight/skills/celld-preflight/gates}"
SKIP=0
for a in "$@"; do [ "$a" = "--skip-gates" ] && SKIP=1; done
if [ "$SKIP" = "1" ]; then
  echo "[gates] 显式跳过闸门（已留痕 .gates-audit.log）"
  echo "$(date -Is) SKIP-GATES user=$(id -un) target:celld-agent-to-rag" >> .gates-audit.log
else
  [ -f acceptance.json ] || { echo "[gates] FAIL: 缺少 acceptance.json"; exit 1; }
  bash "$GATES/preflight.sh" "$(pwd)/acceptance.json" || { echo "[gates] L0 预检失败，拒绝部署"; exit 1; }
  bash "$GATES/typecheck.sh" "$(pwd)" || { echo "[gates] L1 类型检查失败，拒绝部署"; exit 1; }
  echo "[gates] L0+L1 通过"
fi
# =====================================================================
#!/bin/sh
# 用法: ./deploy.sh [SYNC_ALLOWLIST]
# 从 wrangler.template.jsonc + secrets.json 生成 wrangler.jsonc（含密钥，git 忽略），再用 celld 镜像部署
# 本容器是独立舰队：桶 s3://celld-rag，节点容器 celld-agent-to-rag
set -e
cd "$(dirname "$0")"
ALLOWLIST="${1:-}"


# 生成真实配置：把 @占位符@ 换成 secrets.json 里的值（漏了这步会把占位符字面量当密钥注入）
python3 - <<PYEOF
import json
tpl = open("wrangler.template.jsonc").read()
secrets = json.load(open("secrets.json"))
for key in ("GEMINI_KEY", "WEKNORA_KEY", "SHAPI_KEY", "JBB_KEY", "INGEST_TOKEN"):
    tpl = tpl.replace("@" + key + "@", secrets[key])
tpl = tpl.replace("@SYNC_ALLOWLIST@", "$ALLOWLIST")
open("wrangler.jsonc", "w").write(tpl)
PYEOF
chmod 600 wrangler.jsonc secrets.json

# 闸门复检：生成物不得残留占位符（残留即拒绝上线）
if grep -q '@[A-Z_]*@' wrangler.jsonc; then
  echo "[gates] FAIL: wrangler.jsonc 仍残留占位符，拒绝部署"
  grep -o '@[A-Z_]*@' wrangler.jsonc | sort -u
  exit 1
fi

set -a; . ../../.env; set +a
docker run --rm --network backend -v "$(pwd)":/app -w /app \
  -e AWS_ACCESS_KEY_ID=$MINIO_ROOT_USER -e AWS_SECRET_ACCESS_KEY=$MINIO_ROOT_PASSWORD \
  -e S3_ENDPOINT=http://minio:9000 -e AWS_REGION=us-east-1 \
  celld-full:latest deploy . --bucket s3://celld-rag
docker restart celld-agent-to-rag >/dev/null && echo "celld-agent-to-rag restarted to load new bundle"
