/**
 * bg-task — 带事件通道的后台任务(codemode 沙箱 guest)
 *
 * 设计: extensions/bg-task/DESIGN.md(2026-09-30 定案)
 * 核心语义:
 *   - bg_task_start 在 CodemodeSandbox(timeoutMs:Infinity)中长驻执行 js 任务脚本,
 *     脚本经沙箱工具 emit/alert/sleep/sh/status/recv 与通道交互
 *   - bg_task_join 事件驱动阻塞等待(告警/终态/输入入队/超时),静默期零 provider request
 *   - agent_before_settle 守卫:名下有存活任务时阻止无工具调用的收尾(≤3 次 veto)
 *   - 任务注册表 Symbol.for("bg-task:registry") 按会话隔离所有权(同进程共享)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { persistTaskRecord, runTaskSandbox } from "./sandbox-host.js";

// ---------------------------------------------------------------------------
// 类型与常量
// ---------------------------------------------------------------------------

type Sev = "info" | "warn" | "critical";
const SEV_ORDER: Record<Sev, number> = { info: 0, warn: 1, critical: 2 };

interface AlertItem {
    taskId: string;
    taskName?: string;
    code: string;
    sev: Sev;
    msg: string;
    paths?: string[];
    ts: number;
    repeat: number;
}

interface EmitItem {
    ts: number;
    data: unknown;
}

type TaskStatus = "running" | "done" | "error" | "cancelled";

interface TaskRecord {
    id: string;
    name?: string;
    sessionId: string;
    cwd: string;
    status: TaskStatus;
    startedAt: number;
    completedAt?: number;
    emit: EmitItem[];
    emitDropped: number;
    pendingAlerts: AlertItem[];
    deliveredAlerts: number;
    fold: Map<string, { item: AlertItem; firstTs: number }>;
    inbox: unknown[];
    abort: AbortController;
    cancelRequested?: boolean;
    store: Record<string, unknown>;
    resultText?: string;
    errorText?: string;
}

const REGISTRY_KEY = Symbol.for("bg-task:registry");
interface Registry {
    sessions: Map<string, Map<string, TaskRecord>>;
}
function getRegistry(): Registry {
    const g = globalThis as Record<symbol, Registry | undefined>;
    if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = { sessions: new Map() };
    return g[REGISTRY_KEY] as Registry;
}

const EMIT_RING_CAP = 200;
const ALERT_PENDING_CAP = 100;
const FOLD_WINDOW_MS = 60_000;
const INJECT_MIN_INTERVAL_MS = 30_000;
const GUARD_MAX_VETOES = 3;
const TASK_DESCRIPTION_HINT =
    "任务脚本(js,async function body,支持顶层 await)在 QuickJS 沙箱内长驻运行;" +
    "通道原语为顶层裸函数:emit(data)(信息级采样,不打扰)/await alert({code,sev,msg,paths})(唤醒 agent)/await sleep(ms)/await sh(cmd,{cwd,timeout_ms})(bash 探针,输出只留沙箱)/status()/recv(收 agent 消息)。" +
    "推荐结构:js 只做调度与告警决策,复杂检查写成 bash 脚本由 sh 驱动。" +
    "await sh(cmd) 返回对象 {exit_code, output, truncated} 而非字符串——stdout 取 res.output,按字符串解析会全空且静默失效,行尾可能带 CRLF;alert 的 code 不可为 0 或空(falsy 判缺参直接抛错)。";

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

export default function bgTaskExtension(pi: ExtensionAPI) {
    const registry = getRegistry();
    let mySessionId: string | undefined;
    let myTasks: Map<string, TaskRecord> | undefined;
    let taskCounter = 0;

    // join 状态(每会话同时最多一个 join —— agent 单线程)
    interface JoinWait {
        watched: Set<string>;
        minSev: Sev;
        resolve: (reason: string) => void;
        startedAt: number;
    }
    let activeJoin: JoinWait | undefined;
    let lastInjectionAt = 0;
    // 最新 ctx(工具执行时更新):告警注入需要判断会话 idle;mid-turn 告警留 pending 等 join 排水
    let currentCtx: ExtensionContext | undefined;

    // settle 守卫状态
    let guardVetoes = 0;
    let guardArmed = true;
    // 本 turn 内已有输入入队的时刻(joint 注册时消费;turn_start 清除)——
    // 修复 steer 在 join 注册前间隙到达导致唤醒信号丢失的竞态
    let inputPendingSince: number | undefined;

    function ensureSession(ctx: ExtensionContext): Map<string, TaskRecord> {
        const sid = ctx.sessionManager.getSessionId();
        if (mySessionId === sid && myTasks) return myTasks;
        mySessionId = sid;
        myTasks = registry.sessions.get(sid) ?? new Map();
        registry.sessions.set(sid, myTasks);
        return myTasks;
    }

    function aliveCountOf(sid: string | undefined): number {
        if (!sid) return 0;
        const m = registry.sessions.get(sid);
        if (!m) return 0;
        let n = 0;
        for (const t of m.values()) if (t.status === "running") n++;
        return n;
    }

    // -------------------------------------------------------------------------
    // 告警管线:折叠 → join 唤醒 / 会话注入
    // -------------------------------------------------------------------------

    function sevRank(s: string): number {
        return s in SEV_ORDER ? SEV_ORDER[s as Sev] : SEV_ORDER.warn;
    }

    function onTaskAlert(record: TaskRecord, raw: { code: string; sev: string; msg: string; paths?: string[] }): void {
        const sev: Sev = raw.sev in SEV_ORDER ? (raw.sev as Sev) : "warn";
        const now = Date.now();
        const existing = record.fold.get(raw.code);
        if (existing && now - existing.firstTs < FOLD_WINDOW_MS) {
            existing.item.repeat++;
            existing.item.ts = now;
            existing.item.msg = raw.msg; // 保留最新结论
            return; // 折叠期内不重复唤醒
        }
        const item: AlertItem = {
            taskId: record.id,
            taskName: record.name,
            code: raw.code,
            sev,
            msg: raw.msg,
            paths: raw.paths,
            ts: now,
            repeat: 1,
        };
        record.fold.set(raw.code, { item, firstTs: now });
        record.pendingAlerts.push(item);
        if (record.pendingAlerts.length > ALERT_PENDING_CAP) record.pendingAlerts.splice(0, record.pendingAlerts.length - ALERT_PENDING_CAP);

        // 1) join 活跃且监控该任务且严重度达标 → 唤醒 join(由 join 消费)
        if (activeJoin && activeJoin.watched.has(record.id)) {
            if (sevRank(sev) >= sevRank(activeJoin.minSev)) {
                const j = activeJoin;
                activeJoin = undefined;
                j.resolve("alert");
            }
            return;
        }
        // 2) 无 join → 仅会话 idle 时注入(mid-turn 告警留 pending,由 join 排水;
        //    settle 守卫保证 agent 终将在收尾前 join,不会遇漏)
        if (!currentCtx || !currentCtx.isIdle()) return;
        if (Date.now() - lastInjectionAt < INJECT_MIN_INTERVAL_MS) return;
        lastInjectionAt = Date.now();
        const drained = drainAlerts(record, "info");
        const text =
            `bg-task alert${drained.length > 1 ? ` (x${drained.length})` : ""}:\n` +
            drained
                .map((a) => `[${a.taskName ?? a.taskId}] ${a.sev} ${a.code}: ${a.msg}${a.paths?.length ? `\n  paths: ${a.paths.join(", ")}` : ""}`)
                .join("\n");
        pi.sendMessage(
            { customType: "bg-task-alert", content: text, display: true, details: { alerts: drained } },
            { triggerTurn: true, deliverAs: "followUp" },
        );
    }

    function drainAlerts(record: TaskRecord, minSev: Sev): AlertItem[] {
        const keep: AlertItem[] = [];
        const out: AlertItem[] = [];
        for (const a of record.pendingAlerts) {
            if (sevRank(a.sev) >= sevRank(minSev)) out.push(a);
            else keep.push(a);
        }
        record.pendingAlerts = keep;
        record.deliveredAlerts += out.length;
        return out;
    }

    function onTerminal(record: TaskRecord): void {
        record.completedAt = Date.now();
        persistTaskRecord(record);
        guardArmed = true; // 终态变化后重新武装守卫(0→>0 边界由 start 处理)
        if (activeJoin && activeJoin.watched.has(record.id)) {
            const j = activeJoin;
            activeJoin = undefined;
            j.resolve("terminal");
        }
    }

    // -------------------------------------------------------------------------
    // 沙箱 hooks(通道侧)
    // -------------------------------------------------------------------------

    function makeHooks(record: TaskRecord) {
        return {
            onEmit: (data: unknown) => {
                record.emit.push({ ts: Date.now(), data });
                if (record.emit.length > EMIT_RING_CAP) {
                    record.emit.splice(0, record.emit.length - EMIT_RING_CAP);
                    record.emitDropped++;
                }
            },
            onAlert: (a: { code: string; sev: string; msg: string; paths?: string[] }) => onTaskAlert(record, a),
            pendingAlertCount: () => record.pendingAlerts.length,
            drainInbox: () => record.inbox.splice(0),
            statusSnapshot: () => ({
                task: record.id,
                name: record.name,
                status: record.status,
                alive_ms: Date.now() - record.startedAt,
                alerts_pending: record.pendingAlerts.length,
                alerts_delivered: record.deliveredAlerts,
                emits: record.emit.length,
                inbox_pending: record.inbox.length,
                last_emit: record.emit.length ? record.emit[record.emit.length - 1] : undefined,
            }),
        };
    }

    // -------------------------------------------------------------------------
    // 工具注册
    // -------------------------------------------------------------------------

    const namespace = {
        name: "bg-task",
        description: "后台任务通道:codemode 沙箱长驻监视/巡检脚本,事件驱动回报(alert 打扰,emit 零 token)",
    };

    pi.registerTool({
        name: "bg_task_start",
        label: "BgTask Start",
        namespace,
        description:
            "启动一个后台任务:js 脚本在 QuickJS 沙箱内长驻执行(无超时),立即返回 task_id。" +
            TASK_DESCRIPTION_HINT +
            " 启动后用 bg_task_join 等待事件;名下任务存活期间不要无工具调用地结束回合。",
        parameters: Type.Object({
            script: Type.String({ description: "js 任务脚本(async function body,顶层 await 可用)" }),
            name: Type.Optional(Type.String({ description: "任务简称(告警与状态里显示)" })),
            store: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "注入脚本的初始 store(load() 可读)" })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            currentCtx = ctx;
            const tasks = ensureSession(ctx);
            const id = `bt${Date.now().toString(36)}${(taskCounter++).toString(36)}`;
            const record: TaskRecord = {
                id,
                name: params.name,
                sessionId: ctx.sessionManager.getSessionId(),
                cwd: ctx.cwd,
                status: "running",
                startedAt: Date.now(),
                emit: [],
                emitDropped: 0,
                pendingAlerts: [],
                deliveredAlerts: 0,
                fold: new Map(),
                inbox: [],
                abort: new AbortController(),
                store: (params.store as Record<string, unknown>) ?? {},
            };
            tasks.set(id, record);
            guardArmed = true;
            // 沙箱失败(如 pi-codemode 不可达)异步落到 record,工具调用本身成功
            void runTaskSandbox(record, params.script, makeHooks(record), {
                onAlert: (rec, a) => onTaskAlert(rec as TaskRecord, a),
                onTerminal: (rec) => {
                    if (rec.status === "running") return; // 防御:只接受终态写入
                    onTerminal(rec as TaskRecord);
                },
            });
            return {
                content: [
                    {
                        type: "text",
                        text:
                            `task ${id} started${params.name ? ` (name: ${params.name})` : ""}.\n` +
                            `Next: call bg_task_join to wait for events (zero provider requests while quiet). ` +
                            `Cancel with bg_task_cancel.`,
                    },
                ],
                details: { task_id: id, name: params.name },
            };
        },
    });

    pi.registerTool({
        name: "bg_task_status",
        label: "BgTask Status",
        namespace,
        description: "列出本会话全部后台任务及状态;带 task_id 时返回单任务详情(emit 最近 20 条 + 未决告警)。",
        parameters: Type.Object({
            task_id: Type.Optional(Type.String()),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const tasks = ensureSession(ctx);
            if (params.task_id) {
                const t = tasks.get(params.task_id);
                if (!t) return { content: [{ type: "text", text: `no such task: ${params.task_id}` }], details: { error: "not found" } };
                const body = {
                    id: t.id,
                    name: t.name,
                    status: t.status,
                    started_at: new Date(t.startedAt).toISOString(),
                    completed_at: t.completedAt ? new Date(t.completedAt).toISOString() : undefined,
                    alive_ms: t.status === "running" ? Date.now() - t.startedAt : undefined,
                    result: t.resultText?.slice(0, 1500),
                    error: t.errorText,
                    alerts_pending: t.pendingAlerts,
                    alerts_delivered: t.deliveredAlerts,
                    emits_total: t.emit.length + t.emitDropped,
                    emits_dropped: t.emitDropped,
                    emit_tail: t.emit.slice(-20),
                    inbox_pending: t.inbox.length,
                    store: t.store,
                };
                return { content: [{ type: "text", text: JSON.stringify(body, null, 1) }], details: body };
            }
            const list = [...tasks.values()].map((t) => ({
                id: t.id,
                name: t.name,
                status: t.status,
                alive_ms: t.status === "running" ? Date.now() - t.startedAt : undefined,
                alerts_pending: t.pendingAlerts.length,
                result_preview: t.resultText?.slice(0, 200) ?? t.errorText?.slice(0, 200),
            }));
            return {
                content: [{ type: "text", text: list.length ? JSON.stringify(list, null, 1) : "no bg-tasks in this session" }],
                details: { tasks: list },
            };
        },
    });

    pi.registerTool({
        name: "bg_task_send",
        label: "BgTask Send",
        namespace,
        description: "向运行中的任务投递一条消息(入任务收件箱);脚本用 recv() 收取。",
        parameters: Type.Object({
            task_id: Type.String(),
            payload: Type.Unknown({ description: "任意 JSON 消息" }),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const tasks = ensureSession(ctx);
            const t = tasks.get(params.task_id);
            if (!t) return { content: [{ type: "text", text: `no such task: ${params.task_id}` }], details: { error: "not found" } };
            if (t.status !== "running") return { content: [{ type: "text", text: `task ${t.id} is ${t.status}, not running` }], details: { error: "not running" } };
            t.inbox.push(params.payload);
            return { content: [{ type: "text", text: `delivered to ${t.id} (inbox: ${t.inbox.length})` }], details: { delivered: true } };
        },
    });

    pi.registerTool({
        name: "bg_task_cancel",
        label: "BgTask Cancel",
        namespace,
        description: "取消任务:abort 信号传导进沙箱(sleep/sh 立即中断,脚本感知退出)。任务脚本应在 try/finally 中做清理。",
        parameters: Type.Object({
            task_id: Type.String(),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const tasks = ensureSession(ctx);
            const t = tasks.get(params.task_id);
            if (!t) return { content: [{ type: "text", text: `no such task: ${params.task_id}` }], details: { error: "not found" } };
            if (t.status !== "running") return { content: [{ type: "text", text: `task ${t.id} already ${t.status}` }], details: { status: t.status } };
            t.cancelRequested = true;
            t.abort.abort();
            return { content: [{ type: "text", text: `cancel signal sent to ${t.id}` }], details: { cancelling: true } };
        },
    });

    pi.registerTool({
        name: "bg_task_join",
        label: "BgTask Join",
        namespace,
        description:
            "事件驱动阻塞等待本会话的后台任务(静默期零 provider request)。返回条件:任一监控任务产生 ≥min_sev 告警 / 任一监控任务到达终态 / " +
            "本会话有新输入入队(steer/followUp,立即让路)/ timeout_ms 到期(0=不限,默认 0)。返回携带送达的告警与任务状态摘要。" +
            "名下有存活任务时应以 join 等待,而不是结束回合。",
        parameters: Type.Object({
            timeout_ms: Type.Optional(Type.Number({ description: "最长阻塞毫秒数;0 = 不限(默认)" })),
            min_sev: Type.Optional(Type.String({ description: "唤醒所需最低告警级别:info|warn|critical(默认 info)" })),
            ids: Type.Optional(Type.Array(Type.String(), { description: "只监控这些 task_id(默认全部存活任务)" })),
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            const tasks = ensureSession(ctx);
            const minSev: Sev = params.min_sev && params.min_sev in SEV_ORDER ? (params.min_sev as Sev) : "info";
            const alive = [...tasks.values()].filter((t) => t.status === "running" && (!params.ids || params.ids.includes(t.id)));
            if (alive.length === 0) {
                const drainedAll = [...tasks.values()].flatMap((t) => drainAlerts(t, minSev));
                return {
                    content: [{ type: "text", text: `no running tasks to wait on. ${drainedAll.length ? `drained ${drainedAll.length} pending alert(s).` : ""}` }],
                    details: { reason: "no-tasks", alerts: drainedAll },
                };
            }
            // 预排水:已有达标告警立即返回
            for (const t of alive) {
                const drained = drainAlerts(t, minSev);
                if (drained.length > 0) {
                    return { content: [{ type: "text", text: formatJoinResult("alert", drained, tasks) }], details: { reason: "alert", alerts: drained } };
                }
            }
            const watched = new Set(alive.map((t) => t.id));
            // 消费 pending 输入标志:本 turn 已有 steer/followUp 入队(在 join 注册前的间隙到达),
            // 它们会在本轮工具批结束后才投递——立即返回让路,而不是阻塞 120s 把 steer 卡死在队列里
            if (inputPendingSince !== undefined) {
                inputPendingSince = undefined;
                return {
                    content: [{ type: "text", text: formatJoinResult("input", [], tasks) }],
                    details: { reason: "input", alerts: [] },
                };
            }
            const wakeReason = await new Promise<string>((resolve) => {
                const wait: JoinWait = { watched, minSev, resolve, startedAt: Date.now() };
                activeJoin = wait;
                // agent 侧中断(用户 interrupt / /agents stop)也要能退出
                signal?.addEventListener("abort", () => {
                    if (activeJoin === wait) {
                        activeJoin = undefined;
                        resolve("aborted");
                    }
                }, { once: true });
                if (params.timeout_ms && params.timeout_ms > 0) {
                    const timer = setTimeout(() => {
                        if (activeJoin === wait) {
                            activeJoin = undefined;
                            resolve("timeout");
                        }
                    }, params.timeout_ms);
                    timer.unref?.();
                }
            });
            const drained = [...watched].flatMap((id) => {
                const t = tasks.get(id);
                return t ? drainAlerts(t, minSev) : [];
            });
            return {
                content: [{ type: "text", text: formatJoinResult(wakeReason, drained, tasks) }],
                details: { reason: wakeReason, alerts: drained },
            };
        },
    });

    function formatJoinResult(reason: string, alerts: AlertItem[], tasks: Map<string, TaskRecord>): string {
        const lines = [`join woke: ${reason}`];
        if (alerts.length) {
            lines.push(`alerts (${alerts.length}):`);
            for (const a of alerts) {
                lines.push(`  [${a.taskName ?? a.taskId}] ${a.sev} ${a.code}: ${a.msg}${a.repeat > 1 ? ` (x${a.repeat})` : ""}`);
                if (a.paths?.length) lines.push(`    paths: ${a.paths.join(", ")}`);
            }
        } else {
            lines.push("no alerts (pending below min_sev or reason was input/timeout/terminal)");
        }
        lines.push("tasks:");
        for (const t of tasks.values()) {
            lines.push(`  ${t.id}${t.name ? ` (${t.name})` : ""}: ${t.status}${t.status === "running" ? `, alive ${Math.round((Date.now() - t.startedAt) / 1000)}s` : ""}`);
        }
        return lines.join("\n");
    }

    // -------------------------------------------------------------------------
    // 事件:输入入队即退 join;settle 守卫;工具活动重置守卫计数
    // -------------------------------------------------------------------------

    pi.on("input", () => {
        // 不只唤醒当前 join:置 pending 标志。steer 可能在 join 注册前到达
        // (两个工具调用之间的间隙),那时无 join 可唤;标志由 join 注册时消费,
        // 由 turn_start 清除(已进入上下文送达的输入不再算 pending)
        inputPendingSince = Date.now();
        if (activeJoin) {
            const j = activeJoin;
            activeJoin = undefined;
            j.resolve("input");
        }
    });

    pi.on("turn_start", () => {
        inputPendingSince = undefined;
    });

    pi.on("tool_execution_end", () => {
        guardVetoes = 0; // 任何工具活动都证明 agent 在处理,重置 veto 计数
    });

    pi.on("agent_settled", () => {
        // 兑底:mid-turn 到达的告警留在了 pending(等 join 排水),但 agent 已 settle 且未 join——
        // 此刻会话 idle,注入唤醒;注入即标记送达,不会循环
        if (activeJoin || !currentCtx || !mySessionId) return;
        const tasks = registry.sessions.get(mySessionId);
        if (!tasks) return;
        const drained = [...tasks.values()].flatMap((t) => drainAlerts(t, "info"));
        if (drained.length === 0) return;
        const text =
            `bg-task alert (x${drained.length}):
` +
            drained.map((a) => `[${a.taskName ?? a.taskId}] ${a.sev} ${a.code}: ${a.msg}${a.paths?.length ? `\n  paths: ${a.paths.join(", ")}` : ""}`).join("\n");
        pi.sendMessage(
            { customType: "bg-task-alert", content: text, display: true, details: { alerts: drained } },
            { triggerTurn: true, deliverAs: "followUp" },
        );
    });

    pi.on("agent_before_settle", (event) => {
        const sid = mySessionId;
        if (!guardArmed || !sid) return;
        const alive = aliveCountOf(sid);
        if (alive === 0) return;
        if (activeJoin) return; // 正在 join(settle 不该发生,防御)
        guardVetoes++;
        if (guardVetoes > GUARD_MAX_VETOES) {
            return; // 放行 settle;告警仍会经注入路由兜底
        }
        const aliveList = [...(registry.sessions.get(sid)?.values() ?? [])]
            .filter((t) => t.status === "running")
            .map((t) => `${t.id}${t.name ? `(${t.name})` : ""}`)
            .join(", ");
        return {
            continue: true,
            entries: [
                {
                    type: "custom_message" as const,
                    customType: "bg-task-settle-guard",
                    content:
                        `[bg-task] 名下仍有 ${alive} 个存活后台任务(${aliveList})。` +
                        `不要无工具调用地结束:调用 bg_task_join 等待事件,或 bg_task_cancel 显式取消后再收尾。` +
                        `(settle guard ${guardVetoes}/${GUARD_MAX_VETOES})`,
                    display: false,
                },
            ],
        };
    });
}
