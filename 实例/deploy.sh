#!/bin/sh
# 一键部署整个套件（worker 互绑闭包完整；scheduler 最后部署=常驻根与入口）
# 白名单（测试期约束）可通过第一个参数覆盖；默认保持两篇文档
set -e
cd "$(dirname "$0")"

# ===== 上线前闸门（celld-preflight）：L0+L1 不过即拒绝部署；--skip-gates 显式绕过并留痕 =====
GATES="${CELLD_PREFLIGHT_GATES:-/vol1/docker/astrbot/data/plugins/astrbot_plugin_celld_preflight/skills/celld-preflight/gates}"
SKIP=0; ALLOWLIST=""
for a in "$@"; do
  case "$a" in
    --skip-gates) SKIP=1 ;;
    *) [ -z "$ALLOWLIST" ] && ALLOWLIST="$a" ;;
  esac
done
if [ "$SKIP" = "1" ]; then
  echo "[gates] 显式跳过闸门（已留痕 .gates-audit.log）"
  echo "$(date -Is) SKIP-GATES user=$(id -un) args:$*" >> .gates-audit.log
else
  [ -f acceptance.json ] || { echo "[gates] FAIL: 缺少 acceptance.json（实例声明文件）"; exit 1; }
  bash "$GATES/preflight.sh" "$(pwd)/acceptance.json" || { echo "[gates] L0 预检失败，拒绝部署"; exit 1; }
  DIRS=$(python3 -c "import json;print(' '.join(json.load(open('acceptance.json')).get('typecheck_dirs',[])))")
  for d in $DIRS; do
    bash "$GATES/typecheck.sh" "$(pwd)/$d" || { echo "[gates] L1 类型检查失败（$d），拒绝部署"; exit 1; }
  done
  echo "[gates] L0+L1 通过"
fi
# =====================================================================

./multimedia/deploy.sh
# kb-sync 已拆分为独立容器 celld-agent-to-rag（见 实例/celld-agent-to-rag/），本套件不再部署它
./scheduler/deploy.sh
# celld 只在根指针变化时重走闭包；组件单独更新需重启节点生效（20秒，状态在桶里无损）
docker restart celld >/dev/null && echo "node restarted to load new components"
echo "suite deployed"
