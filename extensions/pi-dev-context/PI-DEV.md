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
| `agents/{planner,reviewer,scout,visual,visual-worker,worker,Designer}.md.example` | `agents/<role>.md`（switch-model 生成） |
| `models.json.example`（仅公开标准 provider） | `models.json`（可含内网自建 provider） |
| `skills/`、`extensions/`、`install.sh`、`switch-model.*`、`model-profiles.json`（角色分工：scout/visual=flash，visual-worker=视觉+max，planner/Designer/reviewer/worker=pro，Designer=pro+medium；visual/visual-worker 需多模态模型——zhipu 系用 glm-5.3-flash，deepseek 用 deepseek-flash（V4.1 Flash 原生多模态，2026-09 起）） | `auth.json`、`extensions/openviking-memory/openviking-config.json`、`~/.openviking/ovcli.conf`（官方扩展凭证）、`skills/glm-plan-usage/team.json` |

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
- **`pi-sessions` 已改为自维护 fork**：`git:github.com/A0nameless0man/pi-sessions`（原 `npm:pi-sessions`）。
  fork 上两个补丁 commit：标题输入文本化+遵循 ACP 压缩状态、失败请求落盘。上游发版后在该仓库
  `git fetch upstream && git rebase upstream/main && git push origin main`，各机 pull + refresh 即生效
  （pi 的 git 包跟踪 main，改完必须 push 才装得到；重装/更新用 `pi update git:github.com/A0nameless0man/pi-sessions`）
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
- **auto-title 不 pin 模型**（去掉 `sessions.autoTitle.model`，用当前会话模型）：pin 一个
  端点挂掉/余额不足的模型时，解析期不失败而请求期失败，标题会静默停更。反过来，zhipu 机器上
  若当前会话模型是 glm-5.3\*，需临时 pin（zai 格式发 `thinking:{type:disabled}` 被该系拒为 1210）

### 提交规范

本仓库 commit 遵循全局 AGENTS.md 的 git 节（conventional + 中文 + Co-Authored-By 双 trailer）。
提交前自查 diff 无 key、内网 IP、域名拓扑。

## OpenViking 扩展本地补丁（勿丢，重装/升级会覆盖，必须重打）

官方扩展来自 volcengine/OpenViking upstream（`install.sh --harness pi` 安装于 `extensions/openviking/`）。共三处偏离 upstream：

### 1. lib/uri-guard-adapter.mjs（+ tests/uri-guard.test.mjs）

- bash 不拦截（否则 bash 里 `ov read viking://...` 等 CLI 运维命令全被堵死）
- read/edit/grep/find/ls 保留 guard 但**仅对路径概念参数生效**（PATH_PARAM_KEYS：path/file_path/dir/uri 等），非路径参数（如 grep 的 pattern 搜字面量）不拦截；edit 为补丁新增
- 全套 49 测试绿（`node --test extensions/openviking/tests/uri-guard.test.mjs`）

### 2. index.ts（stale-ctx 防护）

修 irail 报的 `ctx is stale after session replacement or reload`：upstream 的 `start()` 在多次网络 await 后才碰 `ctx.sessionManager`/`ctx.ui`，pi ≥0.84.2 每次访问都 assertActive，reload 期间 handler 等网络时 runner 被再 invalidate（连按 /reload、/new、/resume）即抛错。修复：sessionId/branch 在任何 await 前捕获（捕获失败直接 bail）；`safeNotify()` 包裹 await 后的 ctx.ui.notify；`updateStatus()` 的 getter 访问加 try 守卫。turn_end 的 getBranch 在 handler 首行无 await，安全不改。

### 3. index.ts + config.ts + sync.ts + config.json（OV 同步不得阻塞 pi 回合，2026-10-08）

背景事故：OV 队列被 session_commit 重试风暴打死（`ov status` 显示 SessionCommit Requeued 3,007,038 ≈ Processed；失败原因全是 `The input (29-34 万 tokens) is longer than the model's context length (262144 tokens)`——抽取模型是本地 sglang `qwen38-27b-fp8`，`--context-length 262144`；OV 0.4.16 的 commit 路径不做 budget 裁剪，且包是 mypyc 编译的改不了内部）。写入被拖到 13-20s > pi 客户端 10s 超时 → 所有 payload 进 `~/.openviking/pending/`（积压 165 条）→ `turn_end`/`session_start` 里的同步串行 await（50 条 × 10s）把 pi 卡死十几分钟：spinner 一直转、**没有发出任何模型请求**。

补丁内容：
- `index.ts`：新增 `runSyncInBackground()`——`turn_end` 改为同步抓 branch 快照后后台同步（`syncInFlight` 防重入 + 失败指数冷却 2min→15min），不再 await 在回合路径里；`start()` 的 `replayPending()` 改为后台 fire-and-forget。
- `sync.ts` + `config.ts` + `config.json`：新增 `commitMaxPendingTokens`（默认 200000）——服务端 pending 超过该值时跳过 commit，避免制造注定 400 必失败、只会 requeue 自旋的任务。
- 验证：`node --test extensions/openviking/tests/*.test.mjs` 49/49 绿；esbuild 语法检查三文件通过。
- **根因修正（同一事故复核后，重要）**：commit 输入 = **当时未提交的积压量**（不是整段会话历史）——对“卡住”的会话手动 `POST /sessions/{id}/commit`（pending 14443）**12 秒内成功**，pending → 0。真正的自增强螺旋是：某次 commit/写入失败 → 积压继续长（到 28-34 万）→ 超过 262144 后 commit 永久 400 → OV 无上限重试（`cancel` 也清不掉的僵尸行）→ 队列饱和 → 客户端写入 13-20s 超时 → 积压更大。**因此无需动 GPU/模型窗口**（26 万积压是病理状态，正常 commit 输入只有 2 万）。
- **服务端 unjam 手册（hg-dev-debian，2026-10-08 实操验证）**：
  1. `python3 ov_unjam.py`（`POST /api/v1/tasks/{id}/cancel`）只能清掉部分；**僵尸行靠 cancel 清不干净**。
  2. 队列状态在 `/home/debian/.openviking/data/_system/queue/queue.db`（表 `queue_messages`；`ov status` 的 Processed/Requeued 是生命周期计数，不是行数）。手术：`systemctl --user stop openviking` → 备份 `queue.db` → `DELETE FROM queue_messages WHERE queue_name='SessionCommit' AND status IN ('pending','processing')` → `VACUUM`（本次 181MB → 36KB，3M 历史行留下的空闲页）→ `systemctl --user start openviking`。
  3. 清完后必须把各会话积压 commit 掉（`POST /sessions/{id}/commit`）否则会重新堆积；写入延迟应回到 ~1-2s（实测 13.4s/20.4s → 1.7s）。
- 排障工具（非仓库文件，放在 `%TEMP%\probe/`）：`cdp.mjs`（--inspect + CDP 拉 active handles / CPU profile / 全局 fetch 拦截，用 fetch 日志直接抓到 10s 一发的 AbortError 才是定位关键）、`ov_unjam.py`（批量 cancel 注定失败的 session_commit 任务）、`ov_drain_pending.py`（把本地 pending 队列一次性灌回 OV）、`ov_commit_diag.py`（列 live 任务/会话 pending，看谁在循环）。

### 4. sync.ts + index.ts（commitMaxPendingTokens 必须覆盖全部 commit 路径，2026-10-08）

第 3 条的 `commitMaxPendingTokens` 只在 `commitIfNeeded()`（turn_end 路径）检查，而 `session_shutdown` 与 `session_before_compact` 走裸 `sync.commit()`，**绕过上限**——这正是把积压一次性灌成巨型请求（随后 400）的机制；失败不推进 watermark，所以下次尝试更大。

补丁内容：
- `sync.ts`：抽出 `pendingTokens()` 与 `overPendingCap(pending?)`；`commit()` **自身**默认执行上限检查（超限记 `commit skipped` 调试日志并返回 `null`，不发请求）。新增 `opts.force` 与 `opts.pendingTokens`（后者让 `commitIfNeeded` 复用已取到的计数，少一次 round trip）。
- `index.ts`：`/viking commit` 是用户显式命令，改为 `sync.commit({ force: true })`，不被上限静默吞掉；其余路径自动受保护，无需改动。
- 验证：`tests/commit-cap.test.mjs` 新增 8 个用例（超限跳过 / 等于上限放行 / force 覆盖 / pendingTokens 免 round trip / commitIfNeeded 两条 / cap=0 关闭）。**判别性已实测**：删掉 `commit()` 里那行守卫 → 1 个用例失败；恢复 → 8/8 绿。全量 `node --test extensions/openviking/tests/*.test.mjs` = 57/57。

### 5. 服务端配置与升级（v0.4.16 → v0.4.23，2026-10-08）

抽取分批（`plan_extraction_batches`）**v0.4.19 才发布**，v0.4.16 没有，且空 `auto_commit_policy` 会解析成 disabled limits → 整段归档塞进单次 LLM 调用 → 超 262144 必 400。故服务端必须 ≥ v0.4.19。

- 镜像：`ghcr.io/volcengine/openviking:v0.4.23`（与 `latest` 同 digest）。旧镜像保留在本地 `latest` tag（ID `559c485864b5…`）可回滚。拉取经 ssh `RemoteForward 7890` → 容器内走 `http_proxy=127.0.0.1:7890`。
- 回滚安全性：OV 的数据迁移是**显式管理端点**（`/api/v1/admin` 的 `migrate_legacy_data`），**不是启动步骤**，所以直接起新镜像不会改写数据。
- 配置 `~/.openviking/ov.conf`：顶层 `user_config_defaults` 会被拒（`Unknown config field`，v0.4.16 曾因此启动失败循环），**正确位置是 `server.user_config_defaults`**（根配置靠 `extra_valid_fields={"server","bot","parsers"}` 放行）。实测有效段：
  ```
  server: { user_config_defaults: { auto_commit_policy: { pending_token_threshold: 150000, message_count_threshold: 100, keep_recent_count: 10, idle_timeout_seconds: 86400, min_commit_interval_seconds: 0 } } }
  memory: { session_auto_commit: { enabled: true, check_interval_seconds: 600 } }
  ```
  想在不碰线上数据的前提下验配置：用一次性容器挂只读配置跑 `load_server_config()`。
- 上限分工（分层，勿混）：**服务端** `pending_token_threshold=150000` 既是“积压到多少自动提交”也是“单批最大 token”，把会话积压钉在 15 万以下，客户端根本不该攒出巨型 backlog；**客户端** `commitMaxPendingTokens=200000` 只是最后一道保险。
- **`user_config_defaults` 只对新建会话生效**：既有会话 `auto_commit_policy` 仍为空（实测升级后旧会话 pi-01a11905 的 commit 仍带 `{}`）。回填脚本 `ov_backfill.sh`（按目录 mtime 圈最近 N 天）PATCH `/api/v1/sessions/{id}/config`；本次 14 天窗口 2349 个会话全部 ok。单次 PATCH 约 0.07-1.7s（该机 IO 慢，全量 6810 个会话不值得做）。
- 另修一个与上游无关的热循环：`Semantic` 队列每 5s 重试 `PermissionDeniedError: Access denied for viking://user/.overview.md`（用户级 context 永远读不了该路径的父刷新任务），直接把这两行删掉即可。
- 孤儿归档恢复（本仓库无代码，纯运维）：归档只有队列行被消费才会写 `.done`；行长时挂 → 队列行消失但归档留 `pending`，且因 `_can_run_archive` 要求前驱终态而被永久跳过。恢复 = 往 `queue_messages` 插一行 `SessionCommit`（`data` 为 `{id, timestamp, data:[utf8 整数数组]}`，内层 payload 字段：`task_id / session_id / session_uri / archive_uri / user{account_id,user_id} / memory_policy / record_auto_commit_success / event_search_tags / auto_commit_policy / _task_work_id / account_id / user_id`）+ 若前驱非终态则补写 `.failed.json`（`{stage,error,failed_at,skipped:true,completed_memory_steps:{}}`，与 `_write_failed_marker` 同构）。实测插队列行**无需重启**即被消费，170KB 归档约 5 分钟转 DONE（pi-01a104ea 的 archive_035 实证）。

### 6. 陷阱：`memory.session_auto_commit.enabled` 不是分批的前提，却会扫全库（2026-10-08）

**不要为了方便而打开它。** 它只控制 `SessionAutoCommitScheduler`，而分批策略另有来源：`_new_session_auto_commit_policy()` 先看 `server.user_config_defaults.auto_commit_policy`，**命中就直接返回**，根本不会走到 `session_auto_commit.enabled` 分支（v0.4.23 `session_service.py:142`）。所以只靠 `user_config_defaults` 就能让新会话拿到能被分批的策略。

打开后的实际后果：scheduler 每 `check_interval_seconds` 扫**全部**会话 `.meta.json`（AGFS `/local` 整棵树，本机 6810 个，受 `scan_rate_limit_files_per_second` 限速），对每个 `has_idle_uncommitted_content` 且超 `idle_timeout_seconds` 的会话排一次提交；而 idle 分支在 `_should_run_auto_commit` 里**硬性要求该开关为 true**（v0.4.23 `session_service.py:656`）。

陷阱组合：先给 2349 个老会话回填了策略（它们从“无策略→永不自动提交”变成“有策略且已闲置 >24h”），再打开这个开关 → 一次扫描把每个会话各排一个提交（实测 988 行 = 988 个**不同**会话、各 1 行，不是重复自旋），产生速率约 0.6-0.9/s，而 8 个 worker 的消费速度约 0.6/min（本机 + 本地 qwen38-27b 很慢），积压到 ~1109 行、预计 ~24h 才能排完。

结论：**保持 `enabled: false`**；需要给新会话分批只需 `server.user_config_defaults.auto_commit_policy`。若确实要跑一次全库闲置提交，先估好 `会话数 × 单次提交耗时 / 8 并发` 再决定。配置改动必须重启容器（scheduler 在 core 启动时按配置创建，无运行时开关）。
