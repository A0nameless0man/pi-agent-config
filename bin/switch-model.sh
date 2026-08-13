#!/usr/bin/env bash
# switch-model.sh - 切换 pi 的默认模型集合 (deepseek / 智谱按量 / 个人 coding / 公司 coding)
# 用法:
#   switch-model.sh                     # 列出所有可用集合
#   switch-model.sh deepseek            # 切到 deepseek (v4-pro)
#   switch-model.sh zhipu               # 切到 智谱按量 (glm-5.2)
#   switch-model.sh zhipu-coding-personal
#   switch-model.sh zhipu-coding-company

set -euo pipefail

SETTINGS="$HOME/.pi/agent/settings.json"
# Windows Python 不认 /c/Users/... 路径,统一转成 Windows 路径
SETTINGS_WIN="$(cygpath -w "$SETTINGS")"

provider_of() {
  case "$1" in
    deepseek)               echo "deepseek" ;;
    zhipu)                  echo "zhipu" ;;
    zhipu-coding-personal)  echo "zhipu-coding-personal" ;;
    zhipu-coding-company)   echo "zhipu-coding-company" ;;
    *)                      echo "" ;;
  esac
}

model_of() {
  case "$1" in
    deepseek)               echo "deepseek-v4-pro" ;;
    zhipu)                  echo "glm-5.2" ;;
    zhipu-coding-personal)  echo "glm-5.2" ;;
    zhipu-coding-company)   echo "glm-5.2" ;;
    *)                      echo "" ;;
  esac
}

ALL_SETS="deepseek zhipu zhipu-coding-personal zhipu-coding-company"

get_json() {
  python -c "import json;d=json.load(open(r'$SETTINGS_WIN',encoding='utf-8'));print(d.get('$1',''))" 2>/dev/null || echo ""
}

list_sets() {
  local cur_p cur_m
  cur_p="$(get_json defaultProvider)"
  cur_m="$(get_json defaultModel)"
  echo "Current: $cur_p/$cur_m"
  echo ""
  echo "Available sets:"
  for name in $ALL_SETS; do
    local p m mark
    p="$(provider_of "$name")"
    m="$(model_of "$name")"
    if [ "$cur_p" = "$p" ]; then mark="(active)"; else mark="       "; fi
    printf "  %s %-24s -> %s/%s\n" "$mark" "$name" "$p" "$m"
  done
}

name="${1:-}"

if [ -z "$name" ]; then
  list_sets
  exit 0
fi

p="$(provider_of "$name")"
m="$(model_of "$name")"

if [ -z "$p" ]; then
  echo "Error: 未知集合 '$name'" >&2
  echo ""
  list_sets
  exit 1
fi

# 用 python 安全改写 settings.json 的 defaultProvider / defaultModel
python - "$SETTINGS_WIN" "$p" "$m" <<'PYEOF'
import json, sys
path, provider, model = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, encoding='utf-8') as f:
    d = json.load(f)
d['defaultProvider'] = provider
d['defaultModel'] = model
with open(path, 'w', encoding='utf-8') as f:
    json.dump(d, f, ensure_ascii=False, indent=2)
    f.write('\n')
PYEOF

echo "Switched to: $name -> $p/$m"
echo "新会话将默认使用该模型;当前会话可用 /model 即时切换。"
