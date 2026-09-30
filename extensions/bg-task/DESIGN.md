# bg-task 后台任务通道 + watchdog 异步化 — 设计纪要

- 日期:2026-09-30(讨论起于 pi 0.99.1 升级当日;同日重开宿主运行时选型并新增 §3.5)
- 状态:主体定稿待实现;§2-1 宿主运行时(bash/codemode/双栈)待用户定案;尚未写任何代码
- 目标产物:`extensions/bg-task/`(新扩展)+ `skills/watchdog/scripts/watchdog.sh` 增加 `--emit jsonl` 传输模式

## 1. 背景与动机

本机(Windows 主力机)pi 已于 2026-09-30 从 0.87.1 升级到 0.99.1,冒烟全过(见 OpenViking 事件记忆)。0.99 引入 codemode(MCP + QuickJS 脚本调用工具)、工具编排 API(`exposure` 分级、`ctx.executeTool`、`prepareLoadout`)以及 SDK 层的 `AgentSession.steer()/followUp()`。

讨论始于"watchdog skill 能否改写为 codemode 实现"。起初否决(理由令日已三处崩塌,见 §2-1),但讨论收敛出一个关键原语:**带事件通道的后台任务**——任务能在单次工具调用之外存活,能向 agent 发消息,能被 agent 取消。基于这个原语,watchdog 可以从"阻塞式 bash loop"重构为"事件驱动的后台监视",多实验批量场景下的编排也随之大幅简化。2026-09-30 核实 CodemodeSandbox 可宿主化(§3.5)后,codemode 作为 guest 运行时重新入围。

## 2. 决策清单(2026-09-30 定案)

1. **宿主运行时:异步 codemode 单栈(用户 2026-09-30 定案)**——watchdog 一并改写为 bg-task 消费者(§4),理由:可移植性。原否决理由当日已逐条证伪(沙箱 timeoutMs:Infinity 官方支持;sleep 可由宿主工具提供;"30min tool call 终止"实为 GLLA,§5.3.1)。技术细节见 §3.5。
2. **采用"通道与运行时分离"的架构**:底层原语是后台任务通道(扩展实现);codemeode 沙箱是当前唯一 guest 运行时,但通道协议对 guest 透明,未来加新 guest 不动核心。
3. ~~watchdog.sh 引擎不动只换传输层~~ **已反转(2026-09-30)**:watchdog 改写为 bg-task 消费者,bash 引擎退役,重定位见 §4。业务假设:pi 可靠、agent 不猝死,不为 pi 崩溃做工程。
4. **告警双严重度**:信息级事件进缓冲零 token,只有可裁决异常才唤醒 agent。每条 alert 都是一次模型请求,协议必须自带限流折叠。alert 的 msg 只放短结论;大材料一律落文件,paths[] 给路径(与原 watchdog report 材料包契约同构)。注入边界(安全关键):只有任务脚本自己发出的结构化事件才允许进告警/steer;被监视进程的日志输出永远只落盘绝不进对话——日志是敌性输入,不守边界则监视对象可借日志向 agent 注入指令。
5. **子代理存活语义(用户 2026-09-30 提出)**:子 agent 名下有存活任务时必须视为仍在执行。收敛为 join 方案(§5.3),零 pi-subagents 改动。

## 3. bg-task 通道协议

### 3.1 工具面(2026-09-30 定案:codemode 单栈;命名统一 bg_task_* + namespace)

扩展注册五个工具,全部 `bg_task_*` 前缀 + `namespace: { name: "bg-task", description: "后台任务通道:在 codemode 沙箱中长驻执行监视/巡检脚本,事件驱动回报" }` 分组(pi 的 namespace 只影响分组展示与 codemeode 列表聚合,模型调用扁平名;MCP 生态先例 mcp__server__tool。裸名如 task_start 有冲突风险——tintinweb pi-tasks 已注册 TaskExecute/TaskOutput 同类工具):

| 工具 | 行为 |
|---|---|
| `bg_task_start <script> [--name n] [--steer-sev min_level] [--store json]` | 载荷为 js 任务脚本(CodemodeSandbox 执行,timeoutMs:Infinity,见 §3.5),立即返回 `task_id`。沙箱工具面见 §3.5(naming 见下) |
| `bg_task_status [task_id]` | 无参列出全部任务及存活状态;带参拉取该任务 emit 缓冲(环形) |
| `bg_task_send <task_id> <payload>` | 向任务投递消息(入任务收件箱,脚本经工具/回调收取;最小实现可砍) |
| `bg_task_cancel <task_id>` | abort signal → 沙箱与工具调用感知 → 清理退出;超宽限期强制销毁沙箱 |
| `bg_task_join [--timeout N] [--sev min] [--ids ...]` | 事件驱动阻塞等待,详见 §5.3 |

**沙箱内工具面命名**(任务脚本可见;沙箱里只有 bg-task 注册的工具,无外部冲突,LLM 写脚本时的清晰度优先,故用短裸名而非再带前缀):`emit`(入环形缓冲)/`alert`(唤醒 agent)/`sleep(ms)`/`sh(cmd, opts)`(探针,cwd/timeout 约束)/`status()`(查自身任务状态)/`send_ack` 等;常用纯辅助项以 globals 暴露为顶层函数(sleep、status 适合)。描述文本里写清交互关系(alert 会唤醒 agent、emit 不打扰),renderDeclarations 自动把描述渲染成脚本文档——LLM 在沙箱里看到的就是这份声明。

所有权登记:`bg_task_start` 发生在哪个会话,任务登记在该会话名下(同进程全局注册表 `Symbol.for("bg-task:registry")`),子代理存活语义(§5)与 GLLA 豁免(§5.3.1)都查它。

### 3.2 事件面(script → agent,双严重度)

| 事件 | 语义 | 通路 |
|---|---|---|
| `{"t":"emit", ...}` | 心跳/进度采样,不打扰 | 环形缓冲,`task_status` 拉取,零 token |
| `{"t":"alert", code, msg, paths[]}` | 需要裁决的异常 | 转发进对话:会话 idle 时走 followUp 排队;活跃 turn 期间默认排队不打断,critical 级可选打断 |

配套纪律:

- **限流折叠**:同 code 告警在窗口期内合并为一条(附 repeat 次数);每分钟 steer 有上限。防告警风暴烧穿对话。
- **载荷纪律**:alert 的 `msg` 只放短结论;大材料一律落文件,`paths[]` 给路径,由 agent 按需读取——与现有 watchdog `report` 材料包契约同构。
- **注入边界(安全关键)**:只有监视脚本自己输出的结构化行才允许进 steer;被监视进程的日志输出永远只落盘,绝不直接进对话。日志是敌性输入,不守住这条边界,监视对象就能借日志内容向 agent 注入指令。

### 3.3 持久性(2026-09-30 定案简化)

业务假设:pi 运行足够可靠,agent 不会突然死亡(用户明确)——不为 pi 进程崩溃/重启做工程:

- 无 re-attach、无 PID 文件、无 ALERT 文件兜底(原 bash guest 机制随单栈定案取消)。
- 任务 store 持久化到状态目录,仅为排查与手动重跑提供便利,不做自动恢复;任务脚本按幂等监视器写法(参考模板提供),便于需要时重跑。
- 被监视进程(实验本体)仍与 pi 无关:任务死了实验不死,重新 task_start 即可恢复监视。

### 3.5 js/codemode guest:技术可行性(2026-09-30 源码核实,同日定为唯一 guest 运行时)

pi 的 codemode 沙箱运行时是独立可导入的包(`@earendil-works/pi-codemode`,pi 的 npm 依赖,quickjs-wasi/WASM,Windows 可用),**不绑死在单次 codemeode 工具调用内**:

```ts
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
const sandbox = new CodemodeSandbox({
  tools: [/* 宿主定义的工具面 */],
  timeoutMs: Infinity,   // 官方语义:"the execution then only ends when the script settles or is aborted"
});
const result = await sandbox.execute(scriptCode, { signal, store });
```

- **task 内主动发消息 = 宿主工具**:`CodemodeTool { name, inputSchema, execute(args, ctx) }` 在 Node 侧实现,脚本内 `await tools.alert({code, msg, paths})` 即时出沙箱到扩展→路由到 agent。同理注册 emit(入环形缓冲)、sleep(宿主 setTimeout,无子进程开销)、sh(探针,可加 cwd/timeout 约束)、send/ack 等;命名约定见 §3.1(沙箱内短裸名 + globals 顶层函数)。
- **分层原则(用户 2026-09-30,推荐而非强制)**:js 任务脚本主要做**调度与编排**(循环节奏、阈值时机、emit/alert 决策、限流折叠);复杂检查逻辑推荐由 agent 用 write 工具写成 bash check 脚本(独立文件、可单独手工执行验证),js 调度器经 `sh` 驱动。简单/内联检查直接写在 js 里也完全合理。check 脚本约定输出结构化判定(JSON 行),调度器解析后决策。附带两个结构性收益:①**注入边界升级**——探针原始输出(含被监视进程日志)只留在沙箱内被 js 消费,永不进模型上下文(旧 watchdog 模型里 bash 输出直接是 tool result,模型可见);②token——大段探针输出零入上下文,只有结构化 alert 摘要出沙箱。
- **超时/取消**:sandbox 级 `timeoutMs: Infinity` + per-execute `signal`(CodemodeToolContext.signal 同时传导到工具调用)→ task_cancel 直接 abort,工具内可感知。
- **store**:`execute(code, {store})` 注入,脚本 `store()/load()` 写回 `result.storeWrites`,持久化由 bg-task 自己落状态目录——无 codemode 工具层的 session entry 副作用。
- **沙箱安全**:QuickJS 内存限制、无 fs/net,除非宿主工具暴露——比 bash guest(裸跑在主机)更强隔离。模型写的任务脚本被沙箱包看,风险面更小。
- **能力上限(可选)**:宿主可再桥接 classify 工具(调小模型)——任务内直接做 L3 智能巡检,零 agent 轮次。这是 bash guest 给不了的。

**双栈权衡(bash vs js guest)**:

| 维度 | bash guest | js/codemode guest |
|---|---|---|
| 生命周期 | detached 进程,pi 重启存活,re-attach | 进程内,pi 重启即失(幂等重跑缓解) |
| 主动发消息 | echo JSONL 行(可用但粗糙) | `await tools.alert(...)` 一等公民 |
| 决策逻辑 | bash 胶水,复杂聚合/限流/去重难写 | 真正编程语言 + store 状态 |
| 沙箱 | 无(裸 bash) | QuickJS 隔离 + 宿主工具白名单 |
| 生态 | watchdog.sh 现有引擎直接复用 | 新写,但可 `tools.bash` 借用探针 |
| 平台 | Git Bash/Linux | WASM,全平台 |

定案(2026-09-30):codemode 单栈,watchdog 一并改写(§4),双栈权衡表降级为历史参考(解释了为何当初考虑保留 bash guest)。

## 4. watchdog 重定位(2026-09-30 定案:改写为 bg-task 消费者,bash 引擎退役)

用户定案:**单栈 codemode guest,watchdog 改写为使用 bg-task 实现**(理由:可移植性——js 全平台一致,bash+Git Bash 有平台怪癖)。原"引擎不动只换传输层"决策反转,watchdog.sh 不再加 `--emit jsonl`,其引擎/调度/状态目录/退出码协议随重写退役。watchdog skill 重定位为薄层,提供三样东西:

1. **一个简单的进程存活与健康 check**:最小可用探针(存活/停止/输出停滞/资源阈值这类基本项),以 bash check 脚本形式提供;复杂检查推荐由 agent 用 write 写 bash check 脚本(分层原则见 §3.5,非强制)。
2. **参考 codemode 脚本与子代理提示**:js 调度器模板(监视循环、sh 驱动 check、限流折叠写法——只做调度,检查逻辑在 bash)+ bash check 脚本模板(从现 watchdog.sh 引擎的 L1 探针迁移,结构化输出)+ 多实验拓扑的 subagent prompt 模板(搭建→bg_task_start→join 循环→告警处理→终态收尾)。
3. **授权链提醒(用户 2026-09-30 指出,模板必备)**:子代理若需调用孙级代理,必须由父级**提前放权**——机制是 agent 定义 frontmatter 的 `allowed_subagents`(默认关闭:省略/none 时子代理根本没有 Agent 工具;"all"/"*" → 全部;csv → 指定类型;嵌套深度上限 2)。两处落地:① subagent prompt 模板里写"父级须知"——期望子代理用 watchdog 拓扑并调用孙级时,须以带 allowed_subagents 的 agent 定义 spawn,否则子代理无法再派生;② 子代理侧模板提醒:计划孙级前先确认自身是否持有该授权,未授权时改用自身工具或回报父级。
4. **检查调度原则**:开始密后续宽、超时回紧、L2 检查点、双严重度纪律、载荷纪律(短结论+paths)——从现 watchdog 的调度曲线与边界经验迁移,以文档+模板形式承载,不再以 bash 代码承载。

**业务假设(用户 2026-09-30 明确)**:pi 运行足够可靠,agent 不会突然死亡——不为 pi 进程崩溃/重启做工程(无 re-attach、无 PID 文件、无 ALERT 文件兑底)。任务 store 仍持久化到状态目录,仅为排查与手动重跑提供便利,不做自动恢复。阻塞模式退出码表(10-17)不再保留——新契约以 join 返回值与事件流为准。

## 5. 子代理存活语义(2026-09-30 修订:join 方案,零 pi-subagents 改动)

### 5.1 需求陈述

当子 agent 名下还有在执行的后台任务时,该子 agent 必须视为仍在执行。具体到 pi-subagents 的机制:**后台子代理的完成通知不得在任务存活期间发出**。

### 5.2 背景:该语义为什么是必须的

现有多实验拓扑是"主会话派 N 个实验子代理,每个子代理搭实验 → 起任务 → 阻塞跑 `watchdog.sh loop`"。阻塞模型下子代理天然"活着"(卡在工具调用里),完成通知只在 loop 退出后到达。

bg-task 模型取消阻塞后,子代理 `task_start` 完就会返回,pi-subagents 会立即判定完成并通知父会话——但实验和监视都还在天上飞。若不处理,父会话会过早收尾、汇总,整个异步化就失去意义。

### 5.3 采纳方案(2026-09-30 用户提出,更轻量):`bg_task_join` 阻塞等待 + settle 守卫

放弃 §5.3-parked 全套机制(consume 抑制、cleanup 补丁、sendCustomMessage 唤醒),改为:

- **`bg_task_join [--timeout N] [--sev min] [--ids ...]` 工具**:事件驱动阻塞等待,返回条件:任一任务产生 ≥sev 告警 / 任一任务到达终态 / 超时。返回时携帯 emit 缓冲摘要与告警。agent 在 join 里阻塞 = record 全程 running:
  - 完成通知不会提前发出(join 返回→agent 收尾→自然 settle→通知时序天然正确)
  - 10 分钟 cleanup 不适用(只驱逐 settled record,running 跳过)
  - `/agents` 面板诚实显示 running;`get_subagent_result` 正确报告仍在运行;GLLA 不会看到假完成事件
  - **零 pi-subagents 补丁、零跨扩展协议**
- **settle 守卫**:`agent_before_settle` 事件(pi 0.99.1,types.d.ts:748-755,BoundaryResult.continue 可否决 settle 并强制一次 provider request)——若会话名下有存活任务而 agent 试图无工具调用结束,返回 `{continue:true, entries:[提示]}` 提醒模型调 `bg_task_join` 或 `bg_task_kill`。有界升级:最多 veto K=3 次(每次 1 次 provider request,预期模型立即服从);仍拒绝则放行 settle,任务所有权重挂到主会话(告警走 §3.2 主会话路由兑底)。注意与驻留否决的区别:这里 veto 是一次性重定向(预期仅 1 次额外请求),不是无限保活——无限保活会 token 空转,已否决。
- **join 超时(2026-09-30 修订:steer 观察已确认可行,超时理由收窄)**:唯一硬理由是 GLA 兼容(§5.3.1)+ 兑底安全网。原"无限 join 卡死 steer 队列"问题已解——**join 主动在输入入队时退出**:pi core 中 steer/followUp 公共入口 `_queueUserInput` **先**跑扩展 `input` 事件处理器(`_runInputHandlers`,在子会话扩展 runner 内同步执行)**再**入队;扩展事件面有 `on("input", InputEvent)`(types.d.ts:862-872/1179,bundle 确证 steer()/followUp() 均经此路径,入队时刻触发)。bg-task 子侧实例监听 input → 任何输入到达(含 steer_subagent 底层 session.steer(),默认 source 同样走此路径)→ 立即中断 join → 工具批结束 → steer 在下一 LLM 调用前投递。join 退出条件集:{告警 ≥sev, 任务终态, 输入入队, 可选超时}。超时仅无豁免时需要(<30min 留余量);escalation 禁用/豁免后可不设,仅留大间隔安全网。代价模型不变:静置零 provider request,每超时周期 1 次;可与 watchdog 调度曲线同构地动态拉长。

### 5.3.1 关键机制澄清:所谓"pi-subagents 30min 自动终止"实为 GLLA hang 升级 abort(2026-09-30 代码确证)

历史误记(AGENTS.md 曾写"pi-subagents 对 ≥30min 阻塞 tool call 自动终止"):全量枚举 pi-subagents 0.19.0 与 pi core 0.99.1,**均无任何工具调用时长超时**;core 工具管线在 session abort 时产出合成消息 "Tool execution was cancelled before completion",而非 AbortError。真实机制:

- **GLLA heartbeat 的 subagent hang watchdog**(goal-heartbeat.ts):progress 判据仅两项——`record.toolUses`(工具活动**结束**才 +1)与 `lifetimeUsage.output`(assistant message_end);`lastActivityAt` 字段在 pi-subagents 0.19.0 中不存在(GLLA 防御性读取,恒 undefined)。单次阻塞工具调用期间两者均冻结。
- 阈值:无进展 5min(`SUBAGENT_HANG_NO_PROGRESS_MS`)→ 警告(5min 节流);**无进展 30min**(`SUBAGENT_HANG_ESCALATION_DEFAULT_MINUTES=30`,GLLA settings 键 `subagentHangEscalationMinutes` 默认 30,0=禁用,<5 回落默认)→ 经 `subagents:rpc:stop` RPC 调 `manager.abort()` → record status "stopped"(UI 误显 STOPPED BY THE USER)→ 工具 exec 的 AbortSignal 触发 → "This operation was aborted"。与历史观察完全吻合(30min、误标、AbortError)。
- 现有 watchdog 短轮询纪律(每轮 ≤10min)的成因正是在躲这个 30min 升级。
- **join 的 GLLA 兼容**:(a) 无 GLLA 或 escalation=0 时 join 可无限阻塞(事件驱动,零空闲成本);(b) 默认环境下 join 超时须 <30min 留余量(建议 ≤25min);(c) ~~GLA 豁免功能~~(用户 2026-09-30 否决,采用纯配置方案,见 §7-4)。
- **escalation 可纯配置禁用(2026-09-30 确认)**:GLA settings 键 `subagentHangEscalationMinutes`——默认 30,**0 = 仅警告/遥测、不 abort**(显式 opt-out;1-4 非法回落 30)。非 GLOBAL_ONLY 键,项目级覆盖全局:全局 `~/.pi/agent/pi-goal-list-loop-audit.settings.json`,项目级 `<cwd>/.pi-glla/settings.json`(merge 顺序 default→global→project)。注意:**5min/20min 检测警告不可配置**(硬编码),设 0 后每 5min 节流告警仍会发(ui.notify + ledger,12h ≈ 144 条噪音)——已定案采用配置禁用(§7-4,全局文件已生效),GLA 豁免功能路线否决。
- 注:工具的 partialResult 更新(tool_update 事件)不刷新 toolUses——已排除"靠发 partial 自证活跃"的路线。

### 5.3.2 备选:parked/consume 全套机制(保留存档,降级为备选)

若 join 路线遇阻(如模型不服从 settle 提示率过高),备选是 consume 抑制方案:父侧监听 `subagents:completed` 同步 emit `subagents:rpc:consume` 抑制通知(docs/rpc.md 认可的 clean path,消费非终态可由 resume 重置)+ 子侧 `pi.sendMessage(triggerTurn:true)` 唤醒 + `Symbol.for("bg-task:registry")` 注册表。硬约束:cleanup() 对 settled record 10min 驱逐并 shutdownChildSession,长驻留必须补 cleanup(约 3 行)。次级:`subagents:completed` 事件先于 consume 检查发出(GLLA 会看到假完成);/agents 面板显示 completed;resume 未暴露在注册表/RPC 面。详见本节历史版本,不再展开。

### 5.4 备选拓扑(已被 §5.3 join 方案取代,存档)

若 pi-subagents 改动成本过高,备选方案是:任务全部登记在主会话名下,子代理只做搭建即返回,告警统一路由到主会话处理。代价是丢失每实验的上下文隔离,主会话承担全部告警处理。用户当前倾向是正推 §5.3 的子代理存活语义。

## 6. API 缺口核实结果(2026-09-30)

1. **注入/唤起 API 已确认**:`pi.sendMessage({customType, content, display, details}, {triggerTurn: true, deliverAs})`(extensions/types.d.ts:1208-1211)→ `AgentSession.sendCustomMessage`,idle+triggerTurn 即"开新轮"。join 主方案下仅兑底路由需要它;settle 守卫用 `agent_before_settle` + BoundaryResult(entries+continue)。
2. **跨扩展面已确认**:pi.events 同进程同步总线(11 个 subagents:* 生命周期事件 + rpc:ping/spawn/stop/consume 通道 + Symbol 注册表)。join 主方案不再依赖;GLA 豁免功能用 `Symbol.for("bg-task:registry")` 同构模式。
3. **30min 神秘机制已确证为 GLLA**(见 §5.3.1):解除方案定为纯配置(§7-4,已生效)。
4. 环境前置:Linux 机器升级 pi ≥0.99 后铺开,且各机同样写全局 GLLA 配置 `subagentHangEscalationMinutes: 0`(该文件不走 git 同步,需分发)。

## 7. 实施顺序(2026-09-30 定案版;用户指示:先完整实现 bg-task,测试试用后再更新 watchdog)

1. ~~核实注入机制 / 30min 机制~~ 已完成(§6、§5.3.1);30min 实证测试见 §9。
2. **bg-task 扩展完整实现**(§3 契约全量:CodemodeSandbox 宿主 + 沙箱工具面 emit/alert/sleep/sh/status + 任务注册表 `Symbol.for("bg-task:registry")` + 五工具 bg_task_start/status/send/cancel/join + emit 环形缓冲 + 限流折叠 + `agent_before_settle` 守卫 K=3;bg_task_send 仍可后置为最小实现)。
3. Windows 本机端到端——**已完成(2026-09-30 现实化场景)**:被监视实验进程(nohup 独立)+ bash check 脚本(PID kill -0 + 日志 mtime)+ js 调度器驱动;30s 进度→45s 停滞→恢复→退出。结果:stalled 告警 22s 阈值精确触发(带 paths)、agent tail 核实材料、exit 告警、terminal 收尾;全程 agent 仅 ~5 次工具调用,静默期零 provider request,探针输出未进对话(注入边界实证)。**两条工效教训(watchdog 模板必须继承)**:①headless 复杂多步流程须主力档模型——flash 档无视逐字指令自由发挥(自写脚本、手动探针、调不存在的命令)烧穿 300s;②本机 Git Bash 无 procps(pgrep/pkill 不存在),探针零依赖方案 = PID 文件 + kill -0(纯 bash 内建),禁用 pgrep/pkill/ps。
4. **30min 约束解除——纯配置方案(用户 2026-09-30 定案,不改 GLA 源码)**:全局 `~/.pi/agent/pi-goal-list-loop-audit.settings.json` 写 `"subagentHangEscalationMinutes": 0`(已于同日生效)。代价接受:①全机失去 hang 自动 abort(5min 检测警告保留,作为人工/主会话介入信号——回到"检测+提示、不自动杀"的原始哲学);②join 静默 >5min 起每 5min 一条警告噪音(ui.notify + ledger),静默 12h ≈ 144 条,接受。若未来噪音不可忍受,再评估 join 默认加 ~4min 超时轮换(每轮 toolUses+1 重置检测,代价 1 provider request/轮)或重启 GLA 豁免功能议题。
5. **真实试用**(用户指示):日常实验监视场景实际使用一段时间,暴露协议/工效问题。
6. watchdog skill 重写为薄层——**已完成(2026-09-30,用户提前指令跳过试用等待)**:templates/{check.sh.tmpl, scheduler.js.tmpl, subagent-prompt.md.tmpl} + SKILL.md 重写;watchdog.sh 退役(git rm)。四轮 headless 验收通过(done/stall/材料 paths/CFG 适配)。**验收发现并修复设计缺陷**:L1 宽曲线(开始密后续宽)与停滞检测矛盾——宽化后 poll 间隔超过停滞窗口即漏检(40s 停滞被 90s 间隔跳过,实测);事件驱动模型下机械探针极便宜(emit 零 token),改为固定密集轮询 min(pollSec, stallSec/2),宽曲线仅保留给昂贵的 L2 智能巡检。
7. 子代理拓扑端到端:多实验并发,完成通知时序正确、GLLA 豁免生效、steer 入队即退 join。
8. Linux 机器升级 pi + GLLA 后铺开。

## 8. 验收要点(2026-09-30 定案版)

- alert 消息只携带短结论 + paths,大材料永远落文件;探针原始输出只留在沙箱内、被监视进程日志永不进入模型上下文(注入边界,结构性保证而非纪律约束)。
- 分层(推荐):js 任务脚本以调度/编排为主;复杂检查逻辑在 write 生成的 bash check 脚本中,可独立手工执行。
- join 静置期间零 provider request;输入入队(steer/followUp)即退 join。
- join 期间 /agents 显示 running;完成通知仅在子代理真正收尾后发出。
- settle 守卫 veto ≤3 次,拒绝后任务重挂主会话路由兜底。
- 30min abort 已由全局配置 `subagentHangEscalationMinutes: 0` 解除(§7-4);join 静默无时长上限,5min 节流 hang 警告噪音为已接受代价(仅 ui.notify/ledger,不影响执行)。
- 任务沙箱崩溃/超内存不影响扩展与其它任务(每任务独立沙箱)。
- task_cancel 后沙箱与工具调用可感知退出,无泄漏的任务句柄/定时器。
- watchdog 参考脚本在 Windows 与 Linux 行为一致(可移植性目标)。

## 9. 30min 机制实证测试(2026-09-30 完成,预测应验)

- 方案:后台 worker 子代理单次 `sleep 2400`(40min) bash 调用,时间戳落盘 /tmp/bgtask-test/。spawn 13:25:40,bash 始 13:26:00。
- **结果(四要素全中)**:13:56:12 ledger 落 `subagent_hang_action_requested`(silentMs=1809761,action=abort,via=subagents:rpc:stop)→ 13:56:14 transcript 落 assistant `stopReason:"error", errorMessage:"This operation was aborted"` → 通知 "Stopped (STOPPED BY THE USER)" → end.log 空(sleep 被杀)。40min sleep 未跑完。
- 前置预警链也应验:13:31:03 起每 5min 节流 `subagent_hang_detected`(silentMs 300280/911989/1217428/…)。
- 结论:GLLA hang 升级是唯一的 30min 杀手(§5.3.1),AGENTS.md 误记已在同日纠正。bg-task 的 join(§5.3)+ 30min 约束解除(配置项或 GLA 豁免功能,§7-4)即为此约束的系统性解。

## 10. 参考

- pi 0.99.0/0.99.1 CHANGELOG:github.com/earendil-works/pi(packages/coding-agent/CHANGELOG.md)
- 扩展 API 文档:packages/coding-agent/docs/extensions.md(Tool exposure / ctx.executeTool / prepareLoadout 各节)
- codemode 文档:packages/coding-agent/docs/cli.md(Enable codemode / How codemode works 各节;`store/load` 跨调用状态、`timeout_ms`、bash 结构化结果 1MiB + `full_output_path`)
- watchdog skill:`~/.pi/agent/skills/watchdog/SKILL.md`(退出码表、调度曲线、多实验拓扑、边界与注意)
- 本机升级记录:OpenViking 事件记忆"2026-09-30 Windows 主力机 pi 从 0.87.1 升级到 0.99.1"
- 相关偏好:工具接口设计哲学、watchdog 设计取舍(bash + 常用组件,不引入重型运行时)
