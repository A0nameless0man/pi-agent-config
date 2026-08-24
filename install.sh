#!/usr/bin/env bash
# install.sh — 全新机器冷启动安装 pi 配置
#
# 两种引导方式:
#   1) curl 一行引导(全新机器):
#      curl -fsSL https://raw.githubusercontent.com/A0nameless0man/pi-agent-config/main/install.sh | bash -s -- [profile] [选项]
#   2) clone 引导:
#      git clone https://github.com/A0nameless0man/pi-agent-config.git ~/.pi/agent
#      bash ~/.pi/agent/install.sh [profile] [选项]
#
# 选项:
#   <profile>          model-profiles.json 中的 profile 名(交互模式下省略则菜单选择)
#   --key KEY          该 profile provider 的 API key(非交互环境必须;交互环境可隐藏输入)
#   --ov-endpoint URL  配置 openviking 记忆服务 endpoint(可选)
#   --ov-key KEY       openviking apiKey(与 --ov-endpoint 搭配)
#   --no-test          跳过结尾的 pi 冒烟测试
#   --no-pull          跳过开头的 git pull(在已有克隆内运行时)
#
# 幂等:可在已有机器上重复运行——拉取更新、保留 auth.json / models.json 中
# 本机已有的其他条目(如内网自建 provider、其他 profile 的 key)。
set -euo pipefail

# 可用环境变量覆盖克隆源(镜像/测试用);默认 GitHub HTTPS
REPO_URL="${PI_AGENT_REPO_URL:-https://github.com/A0nameless0man/pi-agent-config.git}"
REPO_URL_SSH="git@github.com:A0nameless0man/pi-agent-config.git"

say()  { printf '\033[1;32m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[install]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[install]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- 解析参数 ----------
# 先保存原始参数:curl|bash 引导路径 exec 时需要原样转交(解析循环会 shift 掉)
ORIG_ARGS=("$@")
PROFILE="" KEY="" OV_ENDPOINT="" OV_KEY="" NO_TEST=0 NO_PULL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --key)         KEY="${2:?--key 需要值}"; shift 2 ;;
    --ov-endpoint) OV_ENDPOINT="${2:?--ov-endpoint 需要值}"; shift 2 ;;
    --ov-key)      OV_KEY="${2:?--ov-key 需要值}"; shift 2 ;;
    --no-test)     NO_TEST=1; shift ;;
    --no-pull)     NO_PULL=1; shift ;;
    -h|--help)     grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)            die "未知选项: $1" ;;
    *)             PROFILE="$1"; shift ;;
  esac
done

# ---------- 定位仓库:curl 引导则先克隆再转交仓库内脚本 ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)" || SCRIPT_DIR=""
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/model-profiles.json" ]; then
  AGENT_DIR="$SCRIPT_DIR"
else
  AGENT_DIR="$HOME/.pi/agent"
  command -v git >/dev/null 2>&1 || die "缺少 git,请先安装 Git"
  if [ ! -d "$AGENT_DIR/.git" ]; then
    say "克隆配置仓库 → $AGENT_DIR"
    # 国内网络对 github:443 常有间歇性阻断;默认源失败时退试 SSH(需已配 key)
    if ! git clone "$REPO_URL" "$AGENT_DIR"; then
      if [ -z "${PI_AGENT_REPO_URL:-}" ]; then
        warn "HTTPS 克隆失败(网络阻断?),尝试 SSH…"
        git clone "$REPO_URL_SSH" "$AGENT_DIR" \
          || die "克隆失败;可重试,或用 PI_AGENT_REPO_URL 指定镜像源"
      else
        die "克隆失败(PI_AGENT_REPO_URL 指定源不可达)"
      fi
    fi
  fi
  exec bash "$AGENT_DIR/install.sh" "${ORIG_ARGS[@]}"
fi

# ---------- preflight ----------
command -v git  >/dev/null 2>&1 || die "缺少 git"
command -v node >/dev/null 2>&1 || die "缺少 Node.js(需 >=20): https://nodejs.org"
node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' \
  || die "Node 版本过低(需 >=20): $(node -p process.versions.node)"
command -v npm >/dev/null 2>&1 || die "缺少 npm"
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) IS_WIN=1 ;; *) IS_WIN=0 ;; esac

cd "$AGENT_DIR"
if [ "$NO_PULL" != 1 ]; then
  git pull --ff-only >/dev/null 2>&1 || warn "git pull 失败(本地修改或网络),继续用当前版本"
fi

# ---------- 安装 pi 本体 ----------
if command -v pi >/dev/null 2>&1; then
  say "pi 已安装: $(pi --version 2>/dev/null || echo '?')"
else
  say "安装 pi(npm 全局)…"
  if ! npm install -g @earendil-works/pi-coding-agent; then
    # Linux 全局目录通常需要 sudo;irail 等机器有 passwordless sudo
    if [ "$IS_WIN" = 0 ] && command -v sudo >/dev/null 2>&1; then
      sudo npm install -g @earendil-works/pi-coding-agent
    else
      die "npm 全局安装失败,请手动执行: npm install -g @earendil-works/pi-coding-agent"
    fi
  fi
fi

# ---------- 安装 codegraph CLI(extensions/codegraph 桥的运行时依赖) ----------
# 桥在调用时才解析二进制,缺失只会报友好错误;这里装上则开箱即用。
# 幂等:已安装则跳过。失败不阻塞安装(非核心依赖)。
if command -v codegraph >/dev/null 2>&1; then
  say "codegraph 已安装: $(codegraph --version 2>/dev/null || echo '?')"
else
  say "安装 codegraph(npm 全局)…"
  CG_OK=0
  if npm install -g @colbymchenry/codegraph; then CG_OK=1
  elif [ "$IS_WIN" = 0 ] && command -v sudo >/dev/null 2>&1 && sudo npm install -g @colbymchenry/codegraph; then CG_OK=1
  fi
  if [ "$CG_OK" = 1 ]; then
    say "codegraph 安装完成: $(codegraph --version 2>/dev/null || echo '?')"
  else
    warn "codegraph 安装失败(非核心依赖,不阻塞);可稍后手动: npm i -g @colbymchenry/codegraph"
  fi
fi

# ---------- 选择 profile ----------
PROFILES="$(node -p 'Object.keys(require("./model-profiles.json")).join(" ")')"
if [ -z "$PROFILE" ]; then
  [ -t 0 ] || die "非交互环境必须显式指定 profile。可用: $PROFILES"
  say "可用 profile: $PROFILES"
  while [ -z "$PROFILE" ]; do
    read -r -p "选择 profile: " PROFILE || die "输入中断"
    case " $PROFILES " in
      *" $PROFILE "*) ;;
      *) warn "无效 profile: $PROFILE"; PROFILE="" ;;
    esac
  done
else
  case " $PROFILES " in
    *" $PROFILE "*) ;;
    *) die "未知 profile: $PROFILE(可用: $PROFILES)" ;;
  esac
fi
PROVIDER="$(node -p 'require("./model-profiles.json")[process.argv[1]].provider' "$PROFILE")"

# ---------- API key ----------
if [ -z "$KEY" ]; then
  [ -t 0 ] || die "非交互环境必须用 --key 传入 $PROVIDER 的 API key"
  while [ -z "$KEY" ]; do
    read -r -s -p "输入 $PROVIDER 的 API key(不回显): " KEY || die "输入中断"
    echo
  done
fi

# ---------- auth.json:按 provider 合并,保留其他条目 ----------
node -e '
const fs = require("fs");
const [provider, key, p] = process.argv.slice(1);
let a = {};
try { a = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
a[provider] = { key, type: "api_key" };
fs.writeFileSync(p, JSON.stringify(a, null, 2) + "\n");
' "$PROVIDER" "$KEY" auth.json
[ "$IS_WIN" = 0 ] && chmod 600 auth.json 2>/dev/null || true
say "auth.json: 写入 $PROVIDER(其他条目保留)"

# ---------- models.json:模板基底 + 保留本机额外 provider ----------
if [ ! -f models.json ]; then
  cp models.json.example models.json
  say "models.json: 从模板生成(4 个标准 provider)"
else
  node -e '
    const fs = require("fs");
    const [provider] = process.argv.slice(1);
    const m = JSON.parse(fs.readFileSync("models.json", "utf8"));
    if (m.providers && m.providers[provider]) process.exit(0);
    const ex = JSON.parse(fs.readFileSync("models.json.example", "utf8"));
    if (!ex.providers[provider]) {
      console.error("模板中无该 provider,可用: " + Object.keys(ex.providers).join(", "));
      process.exit(2);
    }
    m.providers = m.providers || {};
    m.providers[provider] = ex.providers[provider];
    fs.writeFileSync("models.json", JSON.stringify(m, null, 2) + "\n");
  ' "$PROVIDER" || die "models.json 模板缺少 $PROVIDER 定义"
  say "models.json: 已确保 $PROVIDER 定义(内网/自建 provider 保留)"
fi

# ---------- 生成 profile 派生文件(settings.json + agents/*.md) ----------
bash switch-model.sh "$PROFILE"

# ---------- openviking 记忆服务(可选) ----------
if [ -n "$OV_ENDPOINT" ] && [ -z "$OV_KEY" ]; then
  die "指定了 --ov-endpoint 但缺少 --ov-key"
fi
if [ -z "$OV_ENDPOINT" ] && [ -t 0 ]; then
  read -r -p "配置 openviking 记忆服务?(输入 endpoint,回车跳过): " OV_ENDPOINT || OV_ENDPOINT=""
  if [ -n "$OV_ENDPOINT" ]; then
    while [ -z "$OV_KEY" ]; do
      read -r -s -p "openviking apiKey(不回显): " OV_KEY || die "输入中断"
      echo
    done
  fi
fi
if [ -n "$OV_ENDPOINT" ]; then
  # 双扩展共存：官方扩展(extensions/openviking)读 ~/.openviking/ovcli.conf；
  # openviking-memory 走 toolsOnly 模式(仅 memwrite/memimport)，捕获/recall/commit 由官方扩展负责
  mkdir -p "$HOME/.openviking"
  node -e '
    const fs = require("fs");
    const [endpoint, key, confPath, ovcliPath] = process.argv.slice(1);
    fs.writeFileSync(confPath, JSON.stringify({
      endpoint,
      toolsOnly: true,
      autoCommit: { intervalMinutes: 10, enabled: false },
      apiKey: key,
      timeoutMs: 30000,
      enabled: true,
      autoRecall: {
        enabled: false, limit: 6, scoreThreshold: 0.15,
        maxContentChars: 500, preferAbstract: true, tokenBudget: 2000,
      },
    }, null, 2) + "\n");
    fs.writeFileSync(ovcliPath, JSON.stringify({
      url: endpoint, api_key: key,
    }, null, 2) + "\n");
  ' "$OV_ENDPOINT" "$OV_KEY" \
    "extensions/openviking-memory/openviking-config.json" \
    "$HOME/.openviking/ovcli.conf"
  chmod 600 "$HOME/.openviking/ovcli.conf" 2>/dev/null || true
  say "openviking: $OV_ENDPOINT (官方扩展 ovcli.conf + openviking-memory toolsOnly)"
fi

# ---------- 冒烟测试 ----------
if [ "$NO_TEST" = 1 ]; then
  warn "跳过冒烟测试(--no-test)"
else
  say "冒烟测试(首跑会自动安装 settings.json 里的 npm 包,可能较慢)…"
  OUT="$(pi -p --no-session "Reply with exactly: ok" 2>&1 | tail -1)" || true
  case "$OUT" in
    *ok*) say "冒烟通过 ✓" ;;
    *)    warn "冒烟输出异常(多为首次安装包/网络抖动,可重跑): $OUT" ;;
  esac
fi

echo ""
say "完成。profile=$PROFILE provider=$PROVIDER"
echo "  后续: /model 查看当前模型;改共享配置改 .example 后 git pull && bash switch-model.sh refresh"
echo "  可选手工项: skills/glm-plan-usage/team.json(团队版)、bin/fd.exe(Windows)"
