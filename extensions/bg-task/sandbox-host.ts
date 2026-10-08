/**
 * sandbox-host.ts — CodemodeSandbox 宿主层
 *
 * bg-task 的任务载荷是 js 脚本,经 @earendil-works/pi-codemode 的 CodemodeSandbox
 * (QuickJS/wasm)在扩展进程内长驻执行(timeoutMs: Infinity)。本文件负责:
 *   1. 运行时定位并加载 pi-codemode(它是 pi 的嵌套 ESM 依赖,不在扩展的
 *      jiti 解析路径上,故从 process.argv[1] 锚定 pi 安装目录后原生动态 import)
 *   2. 为每个任务构建沙箱工具面(emit/alert/sleep/sh/status/recv)
 *   3. 驱动 sandbox.execute() 至终态并回写任务记录
 *
 * 设计依据: extensions/bg-task/DESIGN.md §3.1/§3.5(2026-09-30 定案)
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// 最小类型声明(避免在编译期依赖 pi-codemode 的解析路径)
// ---------------------------------------------------------------------------

/** 与 @earendil-works/pi-codemode 的 CodemodeTool 结构对齐(host 侧鸭子类型)。 */
interface SandTool {
    name: string;
    description?: string;
    inputSchema?: unknown;
    execute(args: unknown, context: { signal: AbortSignal }): Promise<unknown> | unknown;
}

interface SandResultOk {
    ok: true;
    value: unknown;
    output: { type: string; text?: string; data?: string }[];
    storeWrites: Record<string, unknown>;
}
interface SandResultFail {
    ok: false;
    error: { message?: string; kind?: string } | string;
    output: { type: string; text?: string; data?: string }[];
}
type SandResult = SandResultOk | SandResultFail;

interface SandSandbox {
    registerTool(tool: SandTool): void;
    unregisterTool(name: string): boolean;
    execute(code: string, options?: { signal?: AbortSignal; timeoutMs?: number; store?: Record<string, unknown> }): Promise<SandResult>;
    close?(): void;
}

type SandSandboxCtor = new (options: {
    tools?: SandTool[];
    /** 顶层裸函数(非 tools.* 成员、不入 result.calls)——bg-task 通道原语的正确性态 */
    globals?: SandTool[];
    timeoutMs?: number;
    memoryLimitBytes?: number;
}) => SandSandbox;

interface TaskRecordLike {
    id: string;
    name?: string;
    cwd: string;
    status: string;
    startedAt?: number;
    completedAt?: number;
    store: Record<string, unknown>;
    abort: AbortController;
    cancelRequested?: boolean;
    resultText?: string;
    errorText?: string;
}

export interface TaskHostDeps {
    /** 沙箱 alert 工具 → 通道告警管线(index.ts 侧负责折叠/join 唤醒/注入)。 */
    onAlert(record: TaskRecordLike, alert: { code: string; sev: string; msg: string; paths?: string[] }): void;
    /** 任务到达终态(status 已定)时回调。 */
    onTerminal(record: TaskRecordLike, status: "done" | "error" | "cancelled"): void;
}

// ---------------------------------------------------------------------------
// pi-codemode 运行时解析与加载
// ---------------------------------------------------------------------------

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const CODEMODE_REL = path.join("node_modules", "@earendil-works", "pi-codemode", "dist", "index.js");

let codemodePromise: Promise<{ CodemodeSandbox: SandSandboxCtor }> | undefined;

function readPackageName(dir: string): string | undefined {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
        return typeof pkg?.name === "string" ? pkg.name : undefined;
    } catch {
        return undefined;
    }
}

/** 从某个起始目录向上找 pi-coding-agent 包根目录。 */
function findPiRoot(startFile: string): string | undefined {
    let dir = path.dirname(path.resolve(startFile));
    for (let i = 0; i < 12; i++) {
        if (readPackageName(dir) === PI_PACKAGE_NAME) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
    return undefined;
}

/**
 * 解析 pi-codemode 的 dist 入口绝对路径。
 * 锚点:process.argv[1] 先 realpath 再向上找包根(npm 形态下 argv[1] 是 bin 符号链接,
 * 必须解析到包内 cli.js 才能命中包根)。
 * 失败场景:pi 以编译单文件形态运行(无 node_modules)→ 返回 undefined,上层优雅降级。
 */
export function resolveCodemodeEntry(): string | undefined {
    const candidates: string[] = [];
    if (process.argv[1]) candidates.push(process.argv[1]);
    // 嵌入式/二进制形态兜底:execPath 附近也可能有安装树
    candidates.push(process.execPath);
    for (const start of candidates) {
        // npm 全局安装形态下 bin 入口是符号链接(/usr/local/bin/pi → 包内 cli.js),
        // 而 node 不改写 argv[1] 的符号链接路径 —— 不做 realpath 的话向上找包根
        // 会止步于 /usr/local,永远摸不到 node_modules 安装树(2026-10-08 实测)
        let resolved = path.resolve(start);
        try {
            resolved = fs.realpathSync(resolved);
        } catch {
            // 候选路径不存在(嵌入式形态)时按原路径继续
        }
        const root = findPiRoot(resolved);
        if (!root) continue;
        const entry = path.join(root, CODEMODE_REL);
        if (fs.existsSync(entry)) return entry;
    }
    return undefined;
}

function loadCodemode() {
    codemodePromise ??= (async () => {
        const entry = resolveCodemodeEntry();
        if (!entry) {
            throw new Error(
                "pi-codemode runtime not found (pi must be installed via npm so that " +
                    "node_modules/@earendil-works/pi-codemode exists next to pi-coding-agent)",
            );
        }
        const mod = (await import(pathToFileURL(entry).href)) as { CodemodeSandbox: SandSandboxCtor };
        if (typeof mod?.CodemodeSandbox !== "function") {
            throw new Error(`CodemodeSandbox missing in ${entry}`);
        }
        return mod;
    })();
    return codemodePromise;
}

// ---------------------------------------------------------------------------
// 沙箱工具面
// ---------------------------------------------------------------------------

const SH_DEFAULT_TIMEOUT_MS = 10 * 60_000; // 单次探针默认 10min(与既有 watchdog 短轮询纪律同源)
const SH_MAX_TIMEOUT_MS = 30 * 60_000;
const SH_OUTPUT_CAP = 256 * 1024; // 256KB,超限保留头尾
const SLEEP_MAX_MS = 60 * 60_000;

// ---------------------------------------------------------------------------
// 任务脚本前奏:对象返回值守卫
//
// 宿主 execute() 的返回值以 JSON.stringify 跨界(pi-codemode host.js),方法与
// Symbol 键无法随行,守卫只能在沙箱内注入;而 prelude 用 defineProperty 安装
// 全局(writable/configurable 均为 false),脚本无法重赋值包装——唯一干净的做法
// 是在脚本体前插一段同作用域前奏(worker 把脚本插值进 (async (tools,console)=>{…}),
// const 声明即可遮蔽全局)。只遮蔽脚本未自行声明同名标识符的原语,不改既有脚本语义。
// 背景:2026-10-04 一次 TTL 探测里 res.stdout 误用导致四个监视点全部静默解析为空。
// ---------------------------------------------------------------------------

const OBJECT_RETURNING_PRIMITIVES = ["emit", "alert", "sleep", "sh", "status", "recv"];

const SANDBOX_PROLOGUE_HELPERS = `
const __bgTaskGuard = (name, raw) => async (...args) => {
    const r = await raw(...args);
    if (r && typeof r === "object") {
        try {
            Object.defineProperty(r, Symbol.toPrimitive, {
                value() {
                    throw new TypeError(name + "() 返回对象,不能当字符串用;请取属性(sh 取 .output/.exit_code/.truncated),不要 String()/模板字符串/拼接");
                },
                configurable: true,
            });
        } catch {}
    }
    return r;
};
`;

export function buildTaskScript(script: string): string {
    const declared = new Set<string>();
    for (const m of script.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) {
        declared.add(m[1]);
    }
    const shadows = OBJECT_RETURNING_PRIMITIVES.filter((n) => !declared.has(n))
        .map((n) => `const ${n} = __bgTaskGuard("${n}", globalThis.${n});`);
    if (shadows.length === 0) return script;
    return `${SANDBOX_PROLOGUE_HELPERS}${shadows.join("\n")}\n${script}`;
}

function resolveShell(): string {
    if (process.platform === "win32") {
        const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
        if (fs.existsSync(gitBash)) return gitBash;
    }
    return "bash";
}

function truncateMiddle(buf: string[], cap: number): { output: string; truncated: boolean } {
    const full = buf.join("");
    if (full.length <= cap) return { output: full, truncated: false };
    const head = Math.floor(cap * 0.7);
    const tail = cap - head;
    return { output: full.slice(0, head) + `\n... [truncated ${full.length - cap} chars] ...\n` + full.slice(-tail), truncated: true };
}

/** sh 探针:spawn bash -c,abort/超时杀进程,输出截断。 */
function runSh(record: TaskRecordLike, cmd: string, opts: { cwd?: string; timeout_ms?: number }, signal: AbortSignal): Promise<{ exit_code: number | null; output: string; truncated: boolean; timed_out?: boolean }> {
    return new Promise((resolve) => {
        const timeout = Math.min(Math.max(opts.timeout_ms ?? SH_DEFAULT_TIMEOUT_MS, 1000), SH_MAX_TIMEOUT_MS);
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(resolveShell(), ["-c", cmd], {
                cwd: opts.cwd && path.isAbsolute(opts.cwd) ? opts.cwd : record.cwd,
                env: process.env,
                windowsHide: true,
            });
        } catch (err) {
            resolve({ exit_code: null, output: `spawn failed: ${err instanceof Error ? err.message : String(err)}`, truncated: false });
            return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let settled = false;
        const finish = (r: { exit_code: number | null; output: string; truncated: boolean; timed_out?: boolean }) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            resolve(r);
        };
        const onAbort = () => {
            try { child.kill("SIGKILL"); } catch { /* already dead */ }
            finish({ exit_code: null, output: "", truncated: false });
        };
        const timer = setTimeout(() => {
            try { child.kill("SIGKILL"); } catch { /* already dead */ }
            finish({ exit_code: null, ...truncateMiddle(chunks.map((c) => c.toString("utf-8")), SH_OUTPUT_CAP), timed_out: true });
        }, timeout);
        signal.addEventListener("abort", onAbort, { once: true });
        child.stdout?.on("data", (d: Buffer) => {
            if (size < SH_OUTPUT_CAP * 2) { chunks.push(d); size += d.length; }
        });
        child.stderr?.on("data", (d: Buffer) => {
            if (size < SH_OUTPUT_CAP * 2) { chunks.push(d); size += d.length; }
        });
        child.on("error", (err) => finish({ exit_code: null, output: `spawn error: ${err.message}`, truncated: false }));
        child.on("close", (code) => finish({ exit_code: code, ...truncateMiddle(chunks.map((c) => c.toString("utf-8")), SH_OUTPUT_CAP) }));
    });
}

export interface SandboxTaskHooks {
    onEmit(data: unknown): void;
    onAlert(alert: { code: string; sev: string; msg: string; paths?: string[] }): void;
    pendingAlertCount(): number;
    drainInbox(): unknown[];
    statusSnapshot(): Record<string, unknown>;
}

/** 构建任务专属沙箱并执行脚本至终态。不抛错——所有失败落在 record 上。 */
export async function runTaskSandbox(
    record: TaskRecordLike & { status: string },
    script: string,
    hooks: SandboxTaskHooks,
    deps: TaskHostDeps,
): Promise<void> {
    let sandbox: SandSandbox | undefined;
    try {
        const { CodemodeSandbox } = await loadCodemode();
        // 通道原语注册为 globals:脚本内裸调用(await emit(...)/await alert({...})/await sleep(ms)/...),
        // 不占 tools.* 命名也不入 result.calls —— 它们是宿主通道而非 pi 工具
        const primitives: SandTool[] = [
            {
                name: "emit",
                description: "记录一条信息级事件(心跳/进度采样)。只进环形缓冲,不打扰 agent。data 任意 JSON(也接受裸值)。",
                inputSchema: { type: "object", properties: { data: { description: "任意 JSON 采样数据" } }, required: ["data"] },
                execute: (args) => {
                    const data = typeof args === "object" && args !== null && "data" in args ? (args as { data?: unknown }).data : args;
                    hooks.onEmit(data ?? null);
                    return { ok: true };
                },
            },
            {
                name: "alert",
                description: "上报需要 agent 裁决的异常。sev: info|warn|critical(默认 warn)。msg 只放短结论(会进对话);大材料写文件后 paths 给路径。同 code 60s 内折叠计数。",
                inputSchema: {
                    type: "object",
                    properties: {
                        code: { type: "string", description: "告警码,如 stalled/no_output/done" },
                        sev: { type: "string", description: "info | warn | critical" },
                        msg: { type: "string", description: "短结论" },
                        paths: { type: "array", items: { type: "string" }, description: "材料文件路径(可选)" },
                    },
                    required: ["code", "msg"],
                },
                execute: (args) => {
                    const a = args as { code?: string; sev?: string; msg?: string; paths?: string[] };
                    if (!a?.code || !a?.msg) throw new Error("alert requires code and msg");
                    const sev = a.sev === "info" || a.sev === "critical" ? a.sev : "warn";
                    deps.onAlert(record, { code: a.code, sev, msg: String(a.msg).slice(0, 2000), paths: Array.isArray(a.paths) ? a.paths.slice(0, 8).map(String) : undefined });
                    return { ok: true, pending: hooks.pendingAlertCount() };
                },
            },
            {
                name: "sleep",
                description: "暂停 ms 毫秒(宿主定时器,无子进程开销)。任务取消时立即中断。",
                inputSchema: { type: "object", properties: { ms: { type: "number" } }, required: ["ms"] },
                execute: (args, ctx) => {
                    // globals 默认传第一个实参:sleep(12000) → args 是数字 12000(非 {ms} 对象)
                    const raw = typeof args === "number" ? args : (args as { ms?: number })?.ms;
                    const ms = Math.min(Math.max(Number(raw) || 0, 0), SLEEP_MAX_MS);
                    return new Promise((resolve, reject) => {
                        const t = setTimeout(() => { ctx.signal.removeEventListener("abort", onAbort); resolve({ ok: true }); }, ms);
                        const onAbort = () => { clearTimeout(t); reject(new Error("task cancelled")); };
                        if (ctx.signal.aborted) { onAbort(); return; }
                        ctx.signal.addEventListener("abort", onAbort, { once: true });
                    });
                },
            },
            {
                name: "sh",
                description: "运行 bash 命令(探针/check 脚本驱动):sh(cmd) 或 sh({cmd, cwd, timeout_ms})。默认 10min 超时、上限 30min;输出 256KB 截断(保头尾);结果只留在沙箱内,不进 agent 对话。",
                inputSchema: {
                    type: "object",
                    properties: {
                        cmd: { type: "string" },
                        cwd: { type: "string", description: "绝对路径(可选,默认任务启动时 cwd)" },
                        timeout_ms: { type: "number", description: "默认 600000,上限 1800000" },
                    },
                    required: ["cmd"],
                },
                execute: (args, ctx) => {
                    // globals 默认传第一个实参:sh("cmd") → args 是字符串;sh({cmd,...}) → 对象
                    const a = typeof args === "string" ? { cmd: args } : ((args as { cmd?: string; cwd?: string; timeout_ms?: number }) ?? {});
                    return runSh(record, String(a?.cmd ?? ""), a ?? {}, ctx.signal);
                },
            },
            {
                name: "status",
                description: "查询自身任务状态摘要(alerts_pending、emit 计数等)。",
                inputSchema: { type: "object", properties: {} },
                execute: () => hooks.statusSnapshot(),
            },
            {
                name: "recv",
                description: "收取 agent 经 bg_task_send 投递的消息(一次取空)。",
                inputSchema: { type: "object", properties: {} },
                execute: () => ({ messages: hooks.drainInbox() }),
            },
        ];
        sandbox = new CodemodeSandbox({ globals: primitives, timeoutMs: Infinity });
        const result = await sandbox.execute(buildTaskScript(script), { signal: record.abort.signal, store: record.store });
        const textOf = (output: { type: string; text?: string }[]) =>
            output
                .filter((i) => i.type === "text" && typeof i.text === "string")
                .map((i) => i.text as string)
                .join("\n")
                .slice(0, 4000);
        if (result.ok) {
            // storeWrites 是写入日志格式 {set:{k:v},delete:[k]},需应用而非直接展开
            const writes = result.storeWrites as { set?: Record<string, unknown>; delete?: string[] } | undefined;
            if (writes?.set) Object.assign(record.store, writes.set);
            if (Array.isArray(writes?.delete)) for (const k of writes.delete) delete record.store[k];
            const txt = textOf(result.output);
            // return 值不在 output items 里(text()/console 才是);无文本输出时序列化 return 值
            let valueText = "";
            if (result.value !== undefined) {
                try { valueText = JSON.stringify(result.value) ?? String(result.value); } catch { valueText = String(result.value); }
            }
            record.resultText = txt || (valueText ? valueText.slice(0, 4000) : "(no output)");
            record.status = "done";
            deps.onTerminal(record, "done");
        } else {
            record.errorText = typeof result.error === "string" ? result.error : result.error?.message || "script failed";
            record.resultText = textOf(result.output);
            record.status = record.cancelRequested ? "cancelled" : "error";
            deps.onTerminal(record, record.cancelRequested ? "cancelled" : "error");
        }
    } catch (err) {
        record.errorText = err instanceof Error ? err.message : String(err);
        record.resultText = record.resultText ?? "";
        record.status = record.cancelRequested ? "cancelled" : "error";
        deps.onTerminal(record, record.cancelRequested ? "cancelled" : "error");
    } finally {
        // execute 已 settle 的沙箱仍持有 worker;close 释放(容错:旧版本可能没有 close)
        try { sandbox?.close?.(); } catch { /* best-effort */ }
    }
}

// ---------------------------------------------------------------------------
// 终态持久化(仅为排查与手动重跑;不做自动恢复 —— DESIGN §3.3)
// ---------------------------------------------------------------------------

export function persistTaskRecord(record: TaskRecordLike): void {
    try {
        const dir = path.join(os.homedir(), ".pi", "agent", ".bg-task");
        fs.mkdirSync(dir, { recursive: true });
        const slim = {
            id: record.id,
            name: record.name,
            status: record.status,
            startedAt: record.startedAt,
            completedAt: record.completedAt,
            store: record.store,
            resultText: (record.resultText ?? "").slice(0, 2000),
            errorText: record.errorText,
        };
        fs.writeFileSync(path.join(dir, `${record.id}.json`), JSON.stringify(slim, null, 1));
    } catch { /* 持久化失败不影响任务本身 */ }
}
