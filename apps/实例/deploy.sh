#!/bin/sh
# 一键部署整个套件（worker 互绑闭包完整；scheduler 最后部署=常驻根与入口）
# 白名单（测试期约束）可通过第一个参数覆盖；默认保持两篇文档
set -e
cd "$(dirname "$0")"
ALLOWLIST="${1:-}"
./multimedia/deploy.sh
./kb-sync/deploy.sh "$ALLOWLIST"
./scheduler/deploy.sh
# celld 只在根指针变化时重走闭包；组件单独更新需重启节点生效（20秒，状态在桶里无损）
docker restart celld >/dev/null && echo "node restarted to load new components"
echo "suite deployed"
