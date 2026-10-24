/**
 * 子代理完成唤醒 join 的单元测试(DESIGN.md §5.5 兼容性缺口的修复验证)
 *
 * 运行方式(仓库根或本目录):
 *   node --test extensions/bg-task/tests/subagent-wake.test.mjs
 *
 * 机制:esbuild 把 index.ts 打包为 ESM,sandbox-host.js 换成 stub
 * (runTaskSandbox no-op → 任务记录保持 running;persistTaskRecord no-op),
 * 用最小 mock 的 pi 对象驱动扩展工厂,验证四条路径:
 *   1. join 阻塞中收到 subagents:completed → 立即以 "subagent" 唤醒
 *   2. join 阻塞中收到 subagents:failed → 同样唤醒
 *   3. 事件落在 join 注册前的间隙 → pending 标志使下一次 join 立即返回
 *   4. turn_start 清除 pending 标志 → 之后的 join 正常阻塞(超时才退)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// --- 加载被测模块:jiti 直接转译 index.ts,sandbox-host.js 换成 stub
//    (runTaskSandbox no-op → 任务记录保持 running;persistTaskRecord no-op);
//    typebox 与 jiti 均从 pi 安装树解析(bg-task 生产环境同样由 pi 的 jiti 装载) ---

const PI_PKG = path.join("C:/Users/hugua/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/package.json");
const { createJiti } = createRequire(PI_PKG)("jiti");

const stubDir = mkdtempSync(path.join(tmpdir(), "bgtask-test-"));
mkdirSync(path.join(stubDir, "stub"), { recursive: true });
const stubHost = path.join(stubDir, "stub", "sandbox-host.js");
writeFileSync(
    stubHost,
    `export async function runTaskSandbox() {}
export function persistTaskRecord() {}
`,
);

const jiti = createJiti(import.meta.url, {
    alias: {
        "./sandbox-host.js": stubHost,
        // index.ts 里 `import { Type } from "typebox"` — 从 pi 依赖树解析,
        // 避免 jiti 从 extensions/ 目录向上找不到包
        typebox: createRequire(PI_PKG).resolve("typebox"),
    },
});
const { default: bgTaskExtension } = await jiti.import("../index.ts");

// --- 最小 pi mock ---

function makeMockPi() {
    const eventHandlers = new Map();
    const listeners = []; // pi.on 的生命周期事件
    const tools = new Map();
    const sentMessages = [];
    const unsubscribers = [];
    const pi = {
        registerTool(def) {
            tools.set(def.name, def);
        },
        on(event, handler) {
            listeners.push({ event, handler });
            return () => {};
        },
        events: {
            on(channel, handler) {
                if (!eventHandlers.has(channel)) eventHandlers.set(channel, new Set());
                eventHandlers.get(channel).add(handler);
                const off = () => eventHandlers.get(channel)?.delete(handler);
                unsubscribers.push(off);
                return off;
            },
            emit(channel, data) {
                for (const h of eventHandlers.get(channel) ?? []) h(data);
            },
        },
        sendMessage(message, options) {
            sentMessages.push({ message, options });
        },
    };
    return {
        pi,
        tools,
        listeners,
        sentMessages,
        fire(event, arg) {
            for (const l of listeners) if (l.event === event) l.handler(arg);
        },
    };
}

const SID = "sess-test-1";
function makeCtx() {
    return {
        cwd: stubDir,
        isIdle: () => true,
        sessionManager: { getSessionId: () => SID },
    };
}

/** 装载一个干净扩展实例;返回 {pi, start, join} 工具的 execute */
function setup() {
    const m = makeMockPi();
    bgTaskExtension(m.pi);
    const start = m.tools.get("bg_task_start");
    const join = m.tools.get("bg_task_join");
    assert.ok(start && join, "bg_task_start/bg_task_join must be registered");
    return { m, start: start.execute, join: join.execute };
}

async function startOneRunningTask(start) {
    const res = await start("tc1", { script: "void 0" }, undefined, undefined, makeCtx());
    return res.details.task_id;
}

test("join 阻塞中收到 subagents:completed → 立即以 subagent 唤醒", async () => {
    const { m, start, join } = setup();
    const taskId = await startOneRunningTask(start);

    const joinPromise = join("tc2", { timeout_ms: 30_000 }, undefined, undefined, makeCtx());
    // join 已注册(微任务让 execute 走到 Promise 等待点)
    await new Promise((r) => setTimeout(r, 10));
    m.pi.events.emit("subagents:completed", { id: "agent-1", status: "completed" });

    const res = await joinPromise;
    assert.equal(res.details.reason, "subagent");
    assert.match(res.content[0].text, /join woke: subagent/);
    // 任务摘要仍在
    assert.match(res.content[0].text, new RegExp(taskId));
});

test("join 阻塞中收到 subagents:failed → 同样唤醒", async () => {
    const { m, start, join } = setup();
    await startOneRunningTask(start);

    const joinPromise = join("tc1", { timeout_ms: 30_000 }, undefined, undefined, makeCtx());
    await new Promise((r) => setTimeout(r, 10));
    m.pi.events.emit("subagents:failed", { id: "agent-2", status: "error" });

    const res = await joinPromise;
    assert.equal(res.details.reason, "subagent");
});

test("事件落在 join 注册前的间隙 → pending 标志使下一次 join 立即返回", async () => {
    const { m, start, join } = setup();
    await startOneRunningTask(start);

    // 无 join 活跃时事件到达(间隙)
    m.pi.events.emit("subagents:completed", { id: "agent-3", status: "completed" });
    // 下一次 join 注册应立即消费标志返回,而不是阻塞 30s
    const t0 = Date.now();
    const res = await join("tc1", { timeout_ms: 30_000 }, undefined, undefined, makeCtx());
    assert.equal(res.details.reason, "subagent");
    assert.ok(Date.now() - t0 < 5_000, "join must return immediately on pending subagent flag");
});

test("turn_start 清除 pending 标志 → 之后的 join 正常阻塞至超时", async () => {
    const { m, start, join } = setup();
    await startOneRunningTask(start);

    m.pi.events.emit("subagents:completed", { id: "agent-4", status: "completed" });
    m.fire("turn_start", {});

    const t0 = Date.now();
    const res = await join("tc1", { timeout_ms: 300 }, undefined, undefined, makeCtx());
    assert.equal(res.details.reason, "timeout");
    assert.ok(Date.now() - t0 >= 250, "join must block until timeout when flag was cleared");
});

test("input 入队仍按原语义唤醒(回归保障)", async () => {
    const { m, start, join } = setup();
    await startOneRunningTask(start);

    const joinPromise = join("tc1", { timeout_ms: 30_000 }, undefined, undefined, makeCtx());
    await new Promise((r) => setTimeout(r, 10));
    m.fire("input", {});

    const res = await joinPromise;
    assert.equal(res.details.reason, "input");
});

// 清理临时目录
test.after(() => {
    try {
        rmSync(stubDir, { recursive: true, force: true });
    } catch { /* Windows 句柄延迟,忽略 */ }
});
