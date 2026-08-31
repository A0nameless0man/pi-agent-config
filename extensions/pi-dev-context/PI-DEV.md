# pi 配置目录维护专属指令

> 本文件由 extensions/pi-dev-context/index.ts 注入——仅当 cwd 位于 `~/.pi/agent` 内时
> 附加到 system prompt（原 pi-config-dev skill 已合并于此，2026-08-25）。
> 修改本文件后需 `/reload`（内容在 system prompt 构建时读取）。
> 内容原则：**只在维护 pi 配置仓库本身时才有用**；所有项目通用的行为规则属全局 AGENTS.md。
> 本文件是公开仓库文件：严禁写入 key、内网 IP、域名拓扑。

## pi-agent-config 仓库维护

`~/.pi/agent` 是 git clone 的多机同步配置仓库（A0nameless0man/pi-agent-config）。
机器清单、各机 profile、内网 endpoint 等敏感细节见 openviking 记忆
`viking://user/hugua/memories/entities/irail_pi_deployment.md`。

### 模板与派生文件

git 只跟踪**模板与源码**；实际生效文件是**机器本地派生物，gitignored**：

| git 跟踪 | 本地生成（不入库） |
|---|---|
| `settings.json.example` | `settings.json`（switch-model 生成） |
| `agents/{planner,reviewer,scout,worker}.md.example` | `agents/<role>.md`（switch-model 生成） |
| `models.json.example`（仅公开标准 provider） | `models.json`（可含内网自建 provider） |
| `skills/`、`extensions/`、`install.sh`、`switch-model.*`、`model-profiles.json`（角色分工：scout/visual=flash，visual-worker=视觉+max，planner/reviewer/worker=pro；visual/visual-worker 需多模态模型——zhipu 系用 glm-5.3-flash，deepseek 用 deepseek-v4-flash-vision-exp） | `auth.json`、`extensions/openviking-memory/openviking-config.json`、`~/.openviking/ovcli.conf`（官方扩展凭证）、`skills/glm-plan-usage/team.json` |

**核心规则：持久改动必须写 `.example` 模板**。直接编辑实际文件（settings.json、agents/*.md）
会在下次 switch-model / refresh 时被模板覆盖。

### 同步工作流（日常）

```
Windows（改模板/加 skill/插件源码）
  → git push（commit 规范见 AGENTS.md；公开仓库严禁 key/IP）
  → 各 Linux 机器: cd ~/.pi/agent && git pull && bash switch-model.sh refresh
```

- refresh 自动检测激活 profile 并从模板重新生成实际文件
- packages 新增（如 `npm:pi-sessions`）要写进 `settings.json.example` 的 packages 数组，
  各机 pull + refresh 后 pi 启动时自动安装（或手动 `pi install npm:<pkg>`）
- github.com:443 在部分内网机器**间歇性阻断**：pull 失败静默重试 2-3 轮（GnuTLS -110 /
  超时属预期）；install.sh HTTPS 克隆失败会自动退试 SSH remote，也可 `PI_AGENT_REPO_URL` 覆盖

### 新机器冷启动

install.sh 幂等，完成 preflight → 装 pi → 克隆 → auth.json → models.json →
switch-model → openviking → 冒烟：

```bash
curl -fsSL https://raw.githubusercontent.com/A0nameless0man/pi-agent-config/main/install.sh | bash -s -- <profile> --key <KEY> --ov-endpoint <URL> --ov-key <OVKEY>
```

从另一台已配置机器远程喂（本地已有仓库时 `cat install.sh | ssh host 'bash -s -- ...'`）。

**key 安全中转模式**（key 不得出现在命令行参数/会话输出/中间落盘）：

```bash
# 1) 从权威机器读出，经 stdin 写入远端受保护临时文件
printf '%s\n%s\n' "$ZKEY" "$OVK" | ssh <host> 'umask 077; cat > /tmp/.pi-sync-keys'
# 2) 远端解包成变量、组装 argv、立即删除
ssh <host> 'ZKEY=$(sed -n 1p /tmp/.pi-sync-keys); OVK=$(sed -n 2p /tmp/.pi-sync-keys); rm -f /tmp/.pi-sync-keys; bash -s -- <profile> --key "$ZKEY" ...'
```

### 已知坑

- **auth.json 格式**：value 必须是对象 `{"key":"...","type":"api_key"}`，裸 string 会导致
  "No models available"
- **settings.json 不配 shellPath**：显式 Windows 路径会随 git 同步到 Linux 导致 bash 工具失效
- **环境变量类 key**（如 BOCHA_API_KEY）：各机 `~/.bashrc` 追加 export 并 `chmod 600`，
  传输同上节中转模式
- **gitignored 的本地配置文件**（team.json / openviking-config.json / auth.json）：openviking 相关两个由 install.sh `--ov-endpoint/--ov-key` 直接生成（toolsOnly 形态 + ovcli.conf），其余冷启动后需单独分发
- **OpenViking 双扩展共存**：官方扩展（`extensions/openviking/`，git 跟踪）负责 recall/捕获/commit，读 `~/.openviking/ovcli.conf`；openviking-memory 走 toolsOnly（仅 memwrite/memimport），读 `openviking-config.json`。旧机器升级后需手动补 `~/.openviking/ovcli.conf`（install.sh 只在冷启动时生成）
- Windows 无 tmux：pi-sessions 需 `sessions.subagents.enable:false`（本地 settings.json 覆盖，
  不进模板）；Linux 机器全功能

### 提交规范

本仓库 commit 遵循全局 AGENTS.md 的 git 节（conventional + 中文 + Co-Authored-By 双 trailer）。
提交前自查 diff 无 key、内网 IP、域名拓扑。

## OpenViking 扩展本地补丁（勿丢，重装/升级会覆盖，必须重打）

官方扩展来自 volcengine/OpenViking upstream（`install.sh --harness pi` 安装于 `extensions/openviking/`）。共两处偏离 upstream：

### 1. lib/uri-guard-adapter.mjs（+ tests/uri-guard.test.mjs）

- bash 不拦截（否则 bash 里 `ov read viking://...` 等 CLI 运维命令全被堵死）
- read/edit/grep/find/ls 保留 guard 但**仅对路径概念参数生效**（PATH_PARAM_KEYS：path/file_path/dir/uri 等），非路径参数（如 grep 的 pattern 搜字面量）不拦截；edit 为补丁新增
- 全套 49 测试绿（`node --test extensions/openviking/tests/uri-guard.test.mjs`）

### 2. index.ts（stale-ctx 防护）

修 irail 报的 `ctx is stale after session replacement or reload`：upstream 的 `start()` 在多次网络 await 后才碰 `ctx.sessionManager`/`ctx.ui`，pi ≥0.84.2 每次访问都 assertActive，reload 期间 handler 等网络时 runner 被再 invalidate（连按 /reload、/new、/resume）即抛错。修复：sessionId/branch 在任何 await 前捕获（捕获失败直接 bail）；`safeNotify()` 包裹 await 后的 ctx.ui.notify；`updateStatus()` 的 getter 访问加 try 守卫。turn_end 的 getBranch 在 handler 首行无 await，安全不改。
