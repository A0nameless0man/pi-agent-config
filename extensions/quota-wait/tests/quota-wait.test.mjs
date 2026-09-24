// quota-wait 行为测试:直接 import 扩展模块,喂造 agent_before_settle 事件并断言。
//   运行:node --test extensions/quota-wait/tests/quota-wait.test.mjs
// 等待时长通过"状态栏首帧倒计时文本"读取,并用虚拟时钟(倍速)压缩真实等待,
// 所以整份测试只花几秒。

import test from "node:test";
import assert from "node:assert/strict";
import extension from "../index.ts";

const REAL_NOW = Date.now;
const RATE = 3000; // 虚拟时间流速:1 虚拟秒 ≈ 1/3000 真实秒

/** 虚拟时钟:让模块内 Date.now() 走得比真实时间快 RATE 倍 */
function speedUp() {
	const started = REAL_NOW();
	Date.now = () => started + (REAL_NOW() - started) * RATE;
}
function realClock() {
	Date.now = REAL_NOW;
}

const pad = (n) => String(n).padStart(2, "0");
/** 按智谱的格式给出"距现在 offsetMs 之后"的重置时刻(北京时间 UTC+8) */
function stampIn(offsetMs) {
	const d = new Date(Date.now() + offsetMs + 8 * 3600 * 1000);
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
const ZHIPU_1308 = (offsetMs) =>
	`429: {"code":"1308","message":"已达到 5 小时的使用上限。您的限额将在 ${stampIn(offsetMs)} 重置。"}`;

function installHandlers() {
	const handlers = new Map();
	extension({
		on(event, handler) {
			handlers.set(event, handler);
			return () => {};
		},
	});
	return handlers;
}

function makeCtx() {
	const statuses = [];
	const notes = [];
	const controller = new AbortController();
	return {
		statuses,
		notes,
		controller,
		ctx: {
			signal: controller.signal,
			sessionManager: {},
			ui: {
				theme: { fg: (_color, text) => text },
				setStatus: (_key, text) => statuses.push(text),
				notify: (text, type) => notes.push([type, text]),
			},
		},
	};
}

function makeEvent(outcome, errorMessage) {
	return {
		type: "agent_before_settle",
		outcome,
		entries: [],
		continue: false,
		context: {
			contextEntries: [
				{ sourceEntry: { id: "u1" }, messages: [{ role: "user", content: "hi" }] },
				{ sourceEntry: { id: "a1" }, messages: [{ role: "assistant", stopReason: "error", errorMessage }] },
			],
			contextMessages: [],
			llmMessages: [],
			pendingMessages: [],
			canContinue: false,
		},
	};
}

/** 状态栏首帧即本次请求的等待量 */
function requestedWait(statuses) {
	return statuses.find((s) => typeof s === "string" && s.includes("配额等待")) ?? "";
}

async function run(settle, event, { abortAfter = false } = {}) {
	const { ctx, statuses, notes, controller } = makeCtx();
	const startedAt = Date.now();
	const promise = settle(event, ctx);
	if (abortAfter) {
		await new Promise((resolve) => setImmediate(resolve)); // 让 handler 先渲染状态
		controller.abort(); // 模拟用户按 Esc
	}
	const result = await promise;
	return { result, statuses, notes, elapsedMs: Date.now() - startedAt };
}

const handlers = installHandlers();

test("注册 agent_before_settle 与 session_shutdown", () => {
	assert.equal(typeof handlers.get("agent_before_settle"), "function");
	assert.equal(typeof handlers.get("session_shutdown"), "function");
});

test("正常结束的 settle 不干预", async () => {
	realClock();
	const { result, statuses } = await run(handlers.get("agent_before_settle"), makeEvent("completed", undefined));
	assert.equal(result, undefined);
	assert.ok(!statuses.some((s) => s !== undefined));
});

test("非配额错误不等待", async () => {
	const { result, statuses } = await run(handlers.get("agent_before_settle"), makeEvent("error", "503: service unavailable"));
	assert.equal(result, undefined);
	assert.equal(requestedWait(statuses), "");
});

test("解析出的重置时刻超过 12h 预算,仍按 1h 一段等待", async () => {
	const { result, statuses } = await run(handlers.get("agent_before_settle"), makeEvent("error", ZHIPU_1308(13 * 3600 * 1000)), {
		abortAfter: true,
	});
	assert.match(requestedWait(statuses), /1h00m/);
	assert.equal(result, undefined); // 被 Esc 中断
});

test("解析出的重置在 30 分钟后 → 等到那一刻(含 30s 缓冲)", async () => {
	const { statuses } = await run(handlers.get("agent_before_settle"), makeEvent("error", ZHIPU_1308(30 * 60 * 1000)), {
		abortAfter: true,
	});
	assert.match(requestedWait(statuses), /30m30s/);
});

test("解析不出重置时刻 → 指数退避 30s / 1m / 2m,每次都续跑", async () => {
	speedUp();
	const seen = [];
	for (let i = 0; i < 3; i += 1) {
		const { result, statuses } = await run(handlers.get("agent_before_settle"), makeEvent("error", "429: insufficient_quota"));
		seen.push(requestedWait(statuses));
		assert.equal(result?.continue, true);
	}
	assert.match(seen[0], /30s/);
	assert.match(seen[1], /1m00s/);
	assert.match(seen[2], /2m00s/);
});

test("续跑载荷 = 剔除失败消息的 context_edit + continue;恢复后清空累计", async () => {
	// 先结束上一轮 episode,让本轮重新提示
	await run(handlers.get("agent_before_settle"), makeEvent("completed", undefined));

	const { result, statuses, notes } = await run(handlers.get("agent_before_settle"), makeEvent("error", ZHIPU_1308(20 * 1000)));
	assert.equal(result?.continue, true);
	assert.deepEqual(result?.entries, [{ type: "context_edit", targetId: "a1", replacement: null }]);
	assert.ok(notes.some(([type]) => type === "warning"), "episode 开始应提示一次");
	assert.equal(statuses.at(-1), undefined, "等待结束应清空状态栏");

	const recovered = await run(handlers.get("agent_before_settle"), makeEvent("completed", undefined));
	assert.ok(recovered.notes.some(([, text]) => text.includes("配额已恢复")));
});

test("累计等待 12h 后放弃,并按原错误结束", async () => {
	speedUp();
	let iterations = 0;
	let gaveUp = false;
	let lastNotes = [];
	for (; iterations < 40; iterations += 1) {
		const { result, notes } = await run(handlers.get("agent_before_settle"), makeEvent("error", ZHIPU_1308(13 * 3600 * 1000)));
		lastNotes = notes;
		if (!result?.continue) {
			gaveUp = true;
			break;
		}
	}
	assert.equal(gaveUp, true);
	assert.ok(iterations >= 8 && iterations <= 30, `iterations=${iterations}`);
	assert.ok(lastNotes.some(([type, text]) => type === "warning" && text.includes("已达上限")));
});

test("Esc 中断等待:立即返回且不续跑", async () => {
	realClock();
	const { result, notes } = await run(handlers.get("agent_before_settle"), makeEvent("error", ZHIPU_1308(6 * 3600 * 1000)), {
		abortAfter: true,
	});
	assert.equal(result, undefined);
	assert.ok(!notes.some(([type, text]) => type === "warning" && text.includes("已达上限")));
});

test("失败的 assistant 消息不在投影末尾时不接管", async () => {
	realClock();
	const event = makeEvent("error", ZHIPU_1308(60 * 1000));
	event.context.contextEntries.push({ sourceEntry: { id: "u2" }, messages: [{ role: "user", content: "again" }] });
	const { result } = await run(handlers.get("agent_before_settle"), event);
	assert.equal(result, undefined);
});
