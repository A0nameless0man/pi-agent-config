#!/usr/bin/env bash
# watchdog.sh — 长时间任务分级监视组件（L1 机械探针，无状态设计）
#
# 设计原则（2026-06-15 调研市面 watchdog skill 后提炼，详见 SKILL.md）：
#   - 观察不调度：本脚本只读任务状态 + 写自己的状态目录，不接管任务本身
#   - 无状态检查：每轮 check 从文件系统实时推导，不依赖常驻内存；
#     "谁在什么时机调用"由宿主决定（pi 子代理循环 / tmux 循环 / cron / 人）
#   - 零 LLM token：状态判定全部纯正则/数值比较，供调用方决定是否值得深查
#   - 分级调度：next_interval 按"开始密、后续宽、超时嫌疑重新加密"的曲线演化，
#     并在期望时长的 20%/50%/80%/110%/150% 处置位 l2_due，提示宿主派轻量 agent 巡检
#
# 用法见 bottom 或 SKILL.md。Git Bash (Windows) 与 Linux 均可运行；
# CPU/RSS 采样为尽力而为（MSYS ps 能力受限时留空），进度信号以日志增长为准。

set -euo pipefail

WATCHDOG_HOME="${WATCHDOG_HOME:-$HOME/.pi/watchdog}"

# ── 工具函数 ──────────────────────────────────────────────────────────

now() { date +%s; }

json_escape() {
  # 单行化 + 去反斜杠/双引号，够用于状态字段（不用于任意文本存储）
  printf '%s' "$1" | tr -d '\000-\010\013\014\016-\037' | tr '\n' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g' | cut -c1-200
}

json_esc_keep_bs() {
  # 用于正则/命令字段：按 JSON 标准转义（反斜杠翻倍、引号加反斜杠），
  # 读取时由 get_field 还原。此前保留裸反斜杠会产生非法 JSON（\( 是非法转义序列），
  # python 解析 task.json 直接炸
  printf '%s' "$1" | tr -d '\000-\010\013\014\016-\037' | tr '\n' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g' | cut -c1-300
}

state_dir() { printf '%s/%s' "$WATCHDOG_HOME" "$1"; }

require_task() {
  local dir; dir="$(state_dir "$1")"
  [[ -f "$dir/task.json" ]] || { echo "ERROR: no such task '$1' (init first)" >&2; exit 2; }
  printf '%s' "$dir"
}

# 读取 task.json 字段。值可含 JSON 转义（\\ 与 \"），读出后还原为原文。
# 用 sed 行级提取而非 grep -oE：Git Bash 的 grep 对 \\. 交替组会静默提取失败；
# 键名锚定而非贪婪 .*:，避免值内冒号被咬残（ai_cmd 含 VERDICT: 时曾被咬成残缺命令）
get_field() {
  local dir="$1" key="$2" default="${3:-}" v="" esc=$'\001' esc2=$'\002'
  v="$(grep -F "\"$key\"" "$dir/task.json" 2>/dev/null | head -1)"
  [[ -z "$v" ]] && { printf '%s' "$default"; return; }
  if printf '%s' "$v" | grep -q ':[[:space:]]*"'; then
    # 字符串分支，五步转义链（顺序不可换）：
    # 1) 剥头（键+冒号+开引号）
    v="$(printf '%s' "$v" | sed "s/^.*\"$key\"[[:space:]]*:[[:space:]]*\"//")"
    # 2) 值内转义引号 \" → 占位2（防止剥尾误伤以引号结尾的值）
    v="$(printf '%s' "$v" | sed "s/\\\\\"/${esc2}/g")"
    # 3) 剥尾（闭引号+可选逗号）
    v="$(printf '%s' "$v" | sed "s/\",[[:space:]]*\$//; s/\"[[:space:]]*\$//")"
    # 4) 成对转义 \\\\ → 占位1（必须成对匹配，逐字符替换会丢失反转义语义）
    v="$(printf '%s' "$v" | sed "s/\\\\\\\\/${esc}/g")"
    # 5) 占位还原：占位1 → \，占位2 → "
    v="$(printf '%s' "$v" | sed "s/${esc}/\\\\/g; s/${esc2}/\"/g")"
  else
    # 数字分支：剥头剥尾逗号
    v="$(printf '%s' "$v" | sed "s/^.*\"$key\"[[:space:]]*:[[:space:]]*//; s/,[[:space:]]*\$//")"
  fi
  printf '%s' "${v:-$default}"
}

set_field() { # 原位更新 task.json 中一个标量字段（数字或字符串）
  local file="$1" key="$2" value="$3"
  if grep -q "\"$key\"" "$file"; then
    sed -i "s/\"$key\"[[:space:]]*:[[:space:]]*[^,}]*/\"$key\": $value/" "$file"
  else
    # 字段不存在则追加（插到收尾 } 之前）
    sed -i "s/}$/ ,\"$key\": $value}/" "$file"
  fi
}

# ── 分级调度曲线 ──────────────────────────────────────────────────────
# 输入期望秒数，输出 "base cap"（秒）。开始密、后续宽；任务越长基数越宽。
tier_of() {
  local expect_s="$1"
  if   (( expect_s < 1800 ));    then echo "60 300"       # <30min
  elif (( expect_s < 14400 ));   then echo "120 900"      # 30min~4h
  elif (( expect_s < 86400 ));   then echo "600 3600"     # 4h~24h
  else                                echo "900 7200"; fi # >24h
}

next_interval() { # <dir>: 基于健康连续轮数做 1.5x 指数放宽，超时嫌疑回落 base
  local dir="$1"
  local expect_s healthy elapsed base cap
  expect_s="$(get_field "$dir" expect_s 0)"
  healthy="$(get_field "$dir" healthy_rounds 0)"
  elapsed=$(( $(now) - $(get_field "$dir" created_at "$(now)") ))
  read -r base cap <<< "$(tier_of "$expect_s")"
  local interval
  interval=$(( base * 15 ** 1 )) # placeholder, replaced below (bash 无浮点乘方，用连乘)
  interval="$base"
  local i
  for (( i=0; i<healthy && i<6; i++ )); do
    interval=$(( interval * 3 / 2 ))
    (( interval >= cap )) && { interval="$cap"; break; }
  done
  # 超过期望时长的 1.2 倍仍在跑：加密观察
  if (( expect_s > 0 && elapsed > expect_s * 12 / 10 )); then
    interval="$base"
  fi
  echo "$interval"
}

# ── init：登记任务档案 ────────────────────────────────────────────────

cmd_init() {
  local label="" pid="" pidfile="" log="" expect_min="" done_re="" fail_re=""
  local stall_sec="" metric_cmd="" dir="" ai_cmd="" ai_interval_sec=0 ai_fail_re="" ai_timeout_sec=600 check_cmd=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --label) label="$2"; shift 2 ;;
      --pid) pid="$2"; shift 2 ;;
      --pidfile) pidfile="$2"; shift 2 ;;
      --log) log="$2"; shift 2 ;;
      --expect-min) expect_min="$2"; shift 2 ;;
      --done-re) done_re="$2"; shift 2 ;;
      --fail-re) fail_re="$2"; shift 2 ;;
      --stall-sec) stall_sec="$2"; shift 2 ;;
      --metric-cmd) metric_cmd="$2"; shift 2 ;;
      --ai-cmd) ai_cmd="$2"; shift 2 ;;
      --ai-interval-sec) ai_interval_sec="$2"; shift 2 ;;
      --ai-fail-re) ai_fail_re="$2"; shift 2 ;;
      --ai-timeout-sec) ai_timeout_sec="$2"; shift 2 ;;
      --check-cmd) check_cmd="$2"; shift 2 ;;
      --dir) dir="$2"; shift 2 ;;
      *) echo "ERROR: unknown init option $1" >&2; exit 2 ;;
    esac
  done
  [[ -n "$label" && -n "$log" && -n "$expect_min" ]] || { echo "ERROR: init 需要 --label --log --expect-min" >&2; exit 2; }
  [[ -n "$pid" || -n "$pidfile" ]] || { echo "ERROR: init 需要 --pid 或 --pidfile 之一" >&2; exit 2; }

  [[ -n "$dir" ]] && WATCHDOG_HOME="$dir"
  local d="$WATCHDOG_HOME/$label"
  mkdir -p "$d"

  # L2 巡检检查点：期望时长的 20/50/80/110/150%
  local expect_s=$(( expect_min * 60 ))
  local l2_cp="["
  local sep="" f
  for f in 20 50 80 110 150; do
    l2_cp+="$sep$(( expect_s * f / 100 ))"; sep=","
  done
  l2_cp+="]"

  cat > "$d/task.json" <<EOF
{
  "label": "$(json_escape "$label")",
  "pid": "${pid:-}",
  "pidfile": "$(json_escape "$pidfile")",
  "log": "$(json_escape "$log")",
  "expect_s": $expect_s,
  "stall_sec": ${stall_sec:-0},
  "done_re": "$(json_esc_keep_bs "$done_re")",
  "fail_re": "$(json_esc_keep_bs "$fail_re")",
  "metric_cmd": "$(json_esc_keep_bs "$metric_cmd")",
  "check_cmd": "$(json_esc_keep_bs "$check_cmd")",
  "ai_cmd": "$(json_esc_keep_bs "$ai_cmd")",
  "ai_interval_sec": $ai_interval_sec,
  "ai_fail_re": "$(json_esc_keep_bs "$ai_fail_re")",
  "ai_timeout_sec": $ai_timeout_sec,
  "ai_last_run": $(now),
  "created_at": $(now),
  "healthy_rounds": 0,
  "l2_checkpoints": $l2_cp,
  "l2_crossed": [],
  "last_state": "\"registered\""
}
EOF
  echo "registered: $label (state dir: $d)"
}

# ── 探针 ─────────────────────────────────────────────────────────────

alive_check() { # <pid> → 0 存活
  local pid="$1"
  [[ -z "$pid" ]] && return 1
  kill -0 "$pid" 2>/dev/null
}

resolve_pid() {
  local dir="$1" pid; pid="$(get_field "$dir" pid "")"
  if [[ -z "$pid" ]]; then
    local pf; pf="$(get_field "$dir" pidfile "")"
    [[ -n "$pf" && -f "$pf" ]] && pid="$(head -1 "$pf" | tr -dc '0-9')"
  fi
  printf '%s' "$pid"
}

log_tail() { tail -n 200 "$1" 2>/dev/null || true; }

# ── check：跑一轮 L1 全套探针 ────────────────────────────────────────

cmd_check() {
  local label="${1:-}"; [[ -n "$label" ]] || { echo "ERROR: check <label>" >&2; exit 2; }
  local dir; dir="$(require_task "$label")"
  local ts; ts="$(now)"
  local flags=() state="running" exit_code=0 alert=false

  local expect_s created_at elapsed
  expect_s="$(get_field "$dir" expect_s 0)"
  created_at="$(get_field "$dir" created_at "$ts")"
  elapsed=$(( ts - created_at ))

  # 1. 进程存活
  local pid alive=false
  pid="$(resolve_pid "$dir")"
  if alive_check "$pid"; then alive=true; else alive=false; fi

  # 2. 日志信号（完成/失败正则 + 增长 + 新鲜度）
  local log; log="$(get_field "$dir" log "")"
  local done_re fail_re stall_sec tail_text="" log_bytes=0 log_mtime=0 freshness_s=-1
  done_re="$(get_field "$dir" done_re "")"
  fail_re="$(get_field "$dir" fail_re "")"
  stall_sec="$(get_field "$dir" stall_sec 0)"
  if [[ -f "$log" ]]; then
    log_bytes="$(stat -c %s "$log" 2>/dev/null || echo 0)"
    log_mtime="$(stat -c %Y "$log" 2>/dev/null || echo 0)"
    freshness_s=$(( ts - log_mtime ))
    (( freshness_s < 0 )) && freshness_s=0   # Windows 时钟粒度可能致 mtime 略未来
    tail_text="$(log_tail "$log")"
  fi

  local done_hit=false fail_hit=false
  [[ -n "$done_re" ]] && printf '%s\n' "$tail_text" | grep -Eq "$done_re" && done_hit=true
  [[ -n "$fail_re" ]] && printf '%s\n' "$tail_text" | grep -Eq "$fail_re" && fail_hit=true

  # 3. 状态机（优先级：done > failed > dead > stalled > plateau > slow > running）
  if $done_hit; then
    state="done"; flags+=("done_signal"); exit_code=10; alert=true
  elif $fail_hit; then
    state="failed"; flags+=("fail_signal"); exit_code=11; alert=true
  elif ! $alive; then
    state="dead"; flags+=("process_gone"); exit_code=13; alert=true
  elif (( stall_sec > 0 && freshness_s > stall_sec )); then
    state="stalled"; flags+=("output_stall"); exit_code=12; alert=true
  fi

  # 4. METRIC_PLATEAU（可选探针：metric_cmd 每次输出一个数值）
  local metric_val="" plateau=false
  local metric_cmd; metric_cmd="$(get_field "$dir" metric_cmd "")"
  if [[ -n "$metric_cmd" ]]; then
    metric_val="$(eval "$metric_cmd" 2>/dev/null | tail -1 | tr -dc '0-9.eE+-')" || true
    if [[ -n "$metric_val" ]]; then
      echo "$ts $metric_val" >> "$dir/metric_history.txt"
      # 最近 10 个点相对变化 < 0.1% → plateau
      local n; n="$(wc -l < "$dir/metric_history.txt")"
      if (( n >= 10 )); then
        local first last
        first="$(awk 'NR>'$((n-10))'{print $2; exit}' "$dir/metric_history.txt")"
        last="$(tail -1 "$dir/metric_history.txt" | awk '{print $2}')"
        if awk -v a="$first" -v b="$last" 'BEGIN { d=(a==0?0:(a<0?-a:a)); exit !(d>0 && (b>a?b-a:a-b)/d < 0.001) }'; then
          plateau=true; flags+=("metric_plateau")
          [[ "$state" == "running" ]] && { state="plateau"; exit_code=15; alert=true; }
        fi
      fi
    fi
  fi

  # 4.5 自定义机械检查（用户脚本，非零退出即异常；仅在任务尚健康时执行）
  local check_cmd; check_cmd="$(get_field "$dir" check_cmd "")"
  if [[ -n "$check_cmd" && ( "$state" == "running" || "$state" == "plateau" ) ]]; then
    if ! bash -c "$check_cmd" < /dev/null > "$dir/custom_check.log" 2>&1; then
      state="check_failed"; flags+=("custom_check"); exit_code=17; alert=true
      tail -3 "$dir/custom_check.log" > "$dir/custom_check.last_error" 2>/dev/null || true
    fi
  fi

  # 5. SLOW_PROGRESS / 超时嫌疑（ADVISORY，不强杀——杀留给人或 L2 判断）
  if [[ "$state" == "running" || "$state" == "plateau" ]] && (( expect_s > 0 )); then
    if (( elapsed > expect_s * 2 )); then
      state="slow"; flags+=("timeout_2x"); exit_code=14; alert=true
    elif (( elapsed > expect_s * 12 / 10 )); then
      flags+=("over_1_2x_expect")
      [[ "$state" == "running" ]] && { state="slow"; exit_code=14; }
    fi
  fi

  # 6. 资源采样（尽力而为；MSYS ps 受限时留空）
  local cpu="null" rss_kb="null" gpu="null"
  if $alive; then
    local ps_out
    ps_out="$(ps -p "$pid" -o pcpu=,rss= 2>/dev/null | head -1)" || ps_out=""
    if [[ -n "$ps_out" ]]; then
      cpu="$(printf '%s' "$ps_out" | awk '{print $1}')"
      rss_kb="$(printf '%s' "$ps_out" | awk '{print $2}')"
    fi
    if command -v nvidia-smi >/dev/null 2>&1; then
      local g; g="$(nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader,nounits 2>/dev/null | head -1)"
      [[ -n "$g" ]] && gpu="\"$(json_escape "$g")\""
    fi
    echo "$ts cpu=$cpu rss_kb=$rss_kb gpu=$gpu" >> "$dir/samples.txt"
  fi

  # 7. L2 检查点判定
  local l2_due=false l2_crossed_new
  l2_crossed_new="$(python - "$dir/task.json" "$elapsed" <<'PYEOF'
import json, sys
task_path, elapsed = sys.argv[1], int(sys.argv[2])
with open(task_path, encoding='utf-8') as f:
    t = json.load(f)
crossed = set(t.get('l2_crossed', []))
due = [c for c in t.get('l2_checkpoints', []) if c <= elapsed and c not in crossed]
for c in due:
    crossed.add(c)
with open(task_path, 'w', encoding='utf-8') as f:
    t['l2_crossed'] = sorted(crossed)
    json.dump(t, f, ensure_ascii=False, indent=1)
print('true' if due else 'false')
PYEOF
)" || l2_crossed_new="false"
  [[ "$l2_crossed_new" == "true" ]] && { l2_due=true; flags+=("l2_checkpoint"); }

  # 8. 健康轮数维护（放宽节奏用；任何异常归零重新加密）
  if [[ "$state" == "running" ]]; then
    local h; h="$(get_field "$dir" healthy_rounds 0)"; set_field "$dir/task.json" healthy_rounds $((h+1))
  else
    set_field "$dir/task.json" healthy_rounds 0
  fi
  set_field "$dir/task.json" last_state "\"$state\""
  set_field "$dir/task.json" last_check "$ts"

  # 9. 告警文件（存在即未确认；ack 清除）
  if $alert && [[ ! -f "$dir/ALERT" ]]; then
    printf '{"ts": %s, "state": "%s", "flags": ["%s"]}\n' "$ts" "$state" "$(IFS='","'; echo "${flags[*]}")" > "$dir/ALERT"
  fi

  # 10. timeline 追加
  printf '{"ts": %s, "state": "%s", "flags": ["%s"], "elapsed_s": %s, "log_bytes": %s, "freshness_s": %s, "cpu": %s, "rss_kb": %s, "gpu": %s, "metric": "%s", "l2_due": %s}\n' \
    "$ts" "$state" "$(IFS='","'; echo "${flags[*]}")" "$elapsed" "$log_bytes" "$freshness_s" "$cpu" "$rss_kb" "$gpu" "$metric_val" "$l2_due" \
    >> "$dir/timeline.jsonl"

  # 11. 输出（首行人类可读，次行 JSON 机器可读）
  echo "[$label] state=$state elapsed=${elapsed}s/${expect_s}s flags=[${flags[*]:-}] log=${log_bytes}B fresh=${freshness_s}s next_interval=$(next_interval "$dir")s"
  printf '{"label":"%s","state":"%s","flags":["%s"],"elapsed_s":%s,"expect_s":%s,"alive":%s,"log_bytes":%s,"freshness_s":%s,"cpu":%s,"rss_kb":%s,"gpu":%s,"metric":"%s","plateau":%s,"l2_due":%s,"next_interval_s":%s,"alert":%s,"exit_code":%s}\n' \
    "$(json_escape "$label")" "$state" "$(IFS='","'; echo "${flags[*]}")" "$elapsed" "$expect_s" "$alive" "$log_bytes" "$freshness_s" "$cpu" "$rss_kb" "$gpu" "$metric_val" "$plateau" "$l2_due" "$(next_interval "$dir")" "$alert" "$exit_code"
  exit "$exit_code"
}

# ── ai-check：L2 智能巡检（pi -p headless 或任意输出约定命令） ─────────

cmd_ai_check() {
  local label="${1:-}"; [[ -n "$label" ]] || { echo "ERROR: ai-check <label>" >&2; exit 2; }
  local dir; dir="$(require_task "$label")"
  local ai_cmd; ai_cmd="$(get_field "$dir" ai_cmd "")"
  [[ -z "$ai_cmd" ]] && { echo "no ai_cmd configured for $label"; exit 0; }
  local fail_re timeout_sec
  fail_re="$(get_field "$dir" ai_fail_re "")"
  [[ -z "$fail_re" ]] && fail_re='VERDICT:[[:space:]]*(ABNORMAL|FAIL|ANOMALY)'
  timeout_sec="$(get_field "$dir" ai_timeout_sec 600)"
  # AI 检查可能慢：限时执行，超时/非零退出/命中异常正则均视为异常
  local out rc
  if command -v timeout >/dev/null 2>&1; then
    out="$(timeout "$timeout_sec" bash -c "$ai_cmd" < /dev/null 2>&1)" && rc=0 || rc=$?
  else
    out="$(bash -c "$ai_cmd" < /dev/null 2>&1)" && rc=0 || rc=$?
  fi
  printf '%s rc=%s | %s\n' "$(now)" "$rc" "$(printf '%s' "$out" | tail -3 | tr '\n' ' ' | cut -c1-200)" >> "$dir/ai_history.txt"
  if (( rc != 0 )) || printf '%s\n' "$out" | grep -Eq "$fail_re"; then
    echo "[$label] AI-CHECK ALERT (cmd rc=$rc):"
    printf '%s\n' "$out" | tail -10
    set_field "$dir/task.json" last_state "\"ai_alert\""
    printf '{"ts": %s, "state": "ai_alert"}\n' "$(now)" > "$dir/ALERT"
    exit 16
  fi
  echo "[$label] AI-CHECK ok: $(printf '%s\n' "$out" | tail -1 | cut -c1-120)"
}

# ── loop：L1 循环宿主（tmux/cron/子代理内跑） ────────────────────────

cmd_loop() { # loop <label> [--max-rounds N] [--wake-cmd 'cmd'] [--quiet]
  local label="${1:-}"; shift || true
  [[ -n "$label" ]] || { echo "ERROR: loop <label>" >&2; exit 2; }
  local max_rounds=0 wake_cmd="" quiet=false script_self
  script_self="$(readlink -f "${BASH_SOURCE[0]}")"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --max-rounds) max_rounds="$2"; shift 2 ;;
      --wake-cmd) wake_cmd="$2"; shift 2 ;;
      --quiet) quiet=true; shift ;;
      *) echo "ERROR: unknown loop option $1" >&2; exit 2 ;;
    esac
  done
  local dir; dir="$(require_task "$label")"
  local rounds=0 rc=0 ai_interval
  ai_interval="$(get_field "$dir" ai_interval_sec 0)"
  while :; do
    local out rc=0
    out="$(bash "$script_self" check "$label" 2>&1)" && rc=0 || rc=$?
    $quiet || echo "$out"
    # 终态或需关注：按需唤醒后退出；运行中按曲线休眠
    if (( rc >= 10 )); then
      if [[ -n "$wake_cmd" ]]; then
        # 只把状态与标签交给唤醒命令，不透传日志内容（避免泄密/超长参数）
        eval "$wake_cmd \"watchdog:$label state changed (code=$rc)\"" || true
      fi
      break
    fi
    # 智能巡检（间隔到点且任务健康时执行；发现异常即退出）
    if (( ai_interval > 0 )); then
      local ts_now ai_last ai_out ai_rc
      ts_now="$(now)"; ai_last="$(get_field "$dir" ai_last_run 0)"
      if (( ts_now - ai_last >= ai_interval )); then
        set_field "$dir/task.json" ai_last_run "$ts_now"
        ai_out="$(bash "$script_self" ai-check "$label" 2>&1)" && ai_rc=0 || ai_rc=$?
        $quiet || echo "$ai_out"
        if (( ai_rc >= 10 )); then exit "$ai_rc"; fi
      fi
    fi
    (( max_rounds > 0 && ++rounds >= max_rounds )) && break
    sleep "$(next_interval "$dir")"
  done
  # 终态退出码不能被后续语句覆盖——宿主（子 agent / bash 工具）靠它判定报警类型
  exit "$rc"
}

# ── status / report / ack / stop / forget ────────────────────────────

cmd_status() {
  local label="${1:-}"
  if [[ -n "$label" ]]; then
    local dir; dir="$(require_task "$label")"
    grep -E '"(label|last_state|last_check|expect_s|created_at)"' "$dir/task.json"
    [[ -f "$dir/ALERT" ]] && echo "ALERT: $(cat "$dir/ALERT")"
    [[ -f "$dir/timeline.jsonl" ]] && tail -3 "$dir/timeline.jsonl"
  else
    local d
    for d in "$WATCHDOG_HOME"/*/; do
      [[ -f "$d/task.json" ]] || continue
      . /dev/null # noop 保持结构
      local l s
      l="$(get_field "$d" label "?")"
      s="$(get_field "$d" last_state "?")"
      printf '%-24s %s\n' "$l" "$s"
    done
  fi
}

cmd_report() { # L2 巡检材料包：档案 + 近期 timeline + 日志尾部 + 指标历史 + 资源采样
  local label="${1:-}"; [[ -n "$label" ]] || { echo "ERROR: report <label>" >&2; exit 2; }
  local dir; dir="$(require_task "$label")"
  echo "===== task.json ====="; cat "$dir/task.json"
  echo "===== timeline (last 20) ====="; tail -20 "$dir/timeline.jsonl" 2>/dev/null || true
  echo "===== metric history (last 20) ====="; tail -20 "$dir/metric_history.txt" 2>/dev/null || true
  echo "===== resource samples (last 10) ====="; tail -10 "$dir/samples.txt" 2>/dev/null || true
  echo "===== log tail (last 50) ====="
  local log; log="$(get_field "$dir" log "")"
  [[ -f "$log" ]] && tail -50 "$log"
  [[ -f "$dir/ALERT" ]] && { echo "===== ALERT ====="; cat "$dir/ALERT"; }
}

cmd_ack() { # 确认告警（处理后清除）
  local label="${1:-}"; [[ -n "$label" ]] || { echo "ERROR: ack <label>" >&2; exit 2; }
  local dir; dir="$(require_task "$label")"
  rm -f "$dir/ALERT"
  echo "alert cleared: $label"
}

cmd_stop() { # 标记停止并清告警（保留历史供回看）
  local label="${1:-}"; [[ -n "$label" ]] || { echo "ERROR: stop <label>" >&2; exit 2; }
  local dir; dir="$(require_task "$label")"
  set_field "$dir/task.json" last_state "\"stopped\""
  rm -f "$dir/ALERT"
  echo "stopped: $label"
}

cmd_forget() {
  local label="${1:-}"; [[ -n "$label" ]] || { echo "ERROR: forget <label>" >&2; exit 2; }
  rm -rf "$(state_dir "$label")"
  echo "forgotten: $label"
}

# ── 入口 ─────────────────────────────────────────────────────────────

case "${1:-}" in
  init)  shift; cmd_init "$@" ;;
  check) shift; cmd_check "$@" ;;
  loop)  shift; cmd_loop "$@" ;;
  status) shift; cmd_status "$@" ;;
  report) shift; cmd_report "$@" ;;
  ai-check) shift; cmd_ai_check "$@" ;;
  ack)  shift; cmd_ack "$@" ;;
  stop) shift; cmd_stop "$@" ;;
  forget) shift; cmd_forget "$@" ;;
  next-interval) shift; next_interval "$(require_task "$1")" ;;
  *) sed -n '30,60p' "$0" | grep -E '^#   (watchdog|usage)' ; cat <<'USAGE'
用法: watchdog.sh <command> [args]
  init   --label L --pid PID|--pidfile F --log F --expect-min N [--done-re RE] [--fail-re RE] [--stall-sec S] [--metric-cmd CMD] [--check-cmd CMD] [--ai-cmd CMD --ai-interval-sec S [--ai-fail-re RE] [--ai-timeout-sec S]] [--dir D]
  check  <label>                 # 一轮机械探针；exit code: 0 running /10 done /11 failed /12 stalled /13 dead /14 slow /15 plateau /16 ai_alert /17 check_failed
  ai-check <label>               # 单次智能巡检（pi -p 等输出约定命令）
  loop   <label> [--max-rounds N] [--wake-cmd CMD] [--quiet]   # 阻塞调度框架：定期执行内建探针+check-cmd+ai-cmd，任一异常即退出报警
  status [label]                 # 概览 / 单任务详情
  report <label>                 # L2 巡检材料包（喂给 scout agent）
  ack    <label>                 # 确认并清除 ALERT
  stop   <label> | forget <label>
  next-interval <label>          # 打印建议的下一间隔秒数
状态目录: ${WATCHDOG_HOME:-~/.pi/watchdog}/<label>/
USAGE
  exit 1 ;;
esac
