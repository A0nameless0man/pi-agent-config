#!/usr/bin/env bash
# switch-model.sh - 切换 pi 模型 provider profile
# 用法:
#   switch-model.sh              # 列出所有可用 profile
#   switch-model.sh deepseek     # 切换到 deepseek profile
#   switch-model.sh zhipu        # 切换到 zhipu profile
set -euo pipefail

dir="$(cd "$(dirname "$0")" && pwd)"
exec node "$dir/switch-model.mjs" "$@"
