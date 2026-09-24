/**
 * quota-wait — coding plan 配额耗尽时自动等待到重置时刻并继续(pi extension)。
 *
 * 背景:pi 不给配额类错误兜底。`isRetryableAssistantError`(pi-ai/utils/retry.js)把英文
 * quota/billing 词表列为不可重试;智谱那条 `429: {"code":"1308",...}` 虽然会被判为可重试,
 * 但退避预算(默认 3 次 / 2s+4s+8s)耗尽后照样失败。上游 CHANGELOG #3485、#4991 说明这是
 * 刻意的 fail-fast(因为服务端可能要求等 5 小时)。本扩展补上"等"这一环。
 *
 * 接管点只能是 `agent_before_settle`:
 * - `turn_end` 在错误路径上无效——低层 runLoop 的 error 分支直接丢弃 finishTurn 的返回值,
 *   emit turn_end + agent_end 后 return,`continue: true` 不会被采纳;
 * - `agent_before_settle` 的 `continue: true` 会走到 agent-session 的 `agent.continue()`
 *   (dist/core/agent-session.js:1090)。
 * 返回 `context_edit(targetId, null)` 把失败的 assistant 消息从模型视野剔除——与 pi 自己的
 * `_omitRecoveryAttempt` 同一机制,所以复跑的是原来那个用户请求,而不是追加一句"请继续"。
 * 剔除后投影不再以 assistant 结尾,`canContinue` 成立(commit 后 _refreshFinalizedContext
 * 会重设 agent.state.messages,continue 的前置校验也通过)。
 *
 * 等待策略(用户指定):
 * - 能解析出重置时刻 → 等到那一刻(智谱给的是北京时间 UTC+8,另加 RESET_BUFFER_MS 缓冲),
 *   **单次一律封顶 1h**:重置在 4h 后 → 分 4 段等待,每段结束探一次;重置在 24h 后 →
 *   同样每 1h 探一次,一直探到累计上限(不做"超出总预算就放弃"的预判)。
 * - 解析不出重置时刻,或解析出的时刻已过期(疑似本机与服务器有钟差)→ 指数退避探测
 *   (BACKOFF_BASE_MS 起,2 倍递增,封顶 1h);同时给这种情形一个自然的最小间隔,
 *   不会退化成 5s 一次的高频打点。
 * - 单次 ≤1h、累计 ≤12h;累计耗尽即放弃,本轮按原错误结束。
 *   每次等待结束都 continue 探一次,仍 429 就回到这里继续记账。
 *
 * 取消:`ctx.signal` 就是 agent.signal(agent-session.js:2449),用户按 Esc → abort() 会
 * abort 它,等待立即退出、本轮按原错误结束,不会卡住几小时。
 *
 * 统计口径:一轮"配额 episode"= 从第一次配额错误到下一次非错误 settle。任何一次成功
 * settle(agent_before_settle 的 outcome !== "error")都会清空累计等待时长。
 *
 * 测试:node --test extensions/quota-wait/tests/quota-wait.test.mjs(虚拟时钟压缩等待)
 */

import type { AgentBeforeSettleEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_ID = "quota-wait";

// 预算(用户指定:单次最多 1h,总最多 12h)
const MAX_SINGLE_WAIT_MS = 60 * 60 * 1000;
const MAX_TOTAL_WAIT_MS = 12 * 60 * 60 * 1000;
// 重置时刻之后留的缓冲:避免钟差导致刚好卡在边界再吃一个 429
const RESET_BUFFER_MS = 30 * 1000;
// 单次等待下限:防止等待时长退化成 0 而变成热循环
const MIN_PROBE_GAP_MS = 5 * 1000;
// 退避探测起点(解析不出重置时刻 / 重置时刻已过期)
const BACKOFF_BASE_MS = 30 * 1000;

// 配额/账单类耗尽的特征:命中即进入等待流程,否则交给 pi 原有行为
const QUOTA_PATTERN =
	/GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|\busage limit\b|\bbilling\b|使用上限|限额将在|额度.{0,6}(用尽|不足|已)|配额.{0,6}(用尽|不足|已)/i;
// 目前只有智谱在错误体里给出 "2026-09-24 18:23:28" 这种时刻
const RESET_TIME_PATTERN = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;
// 解析结果超出这个跨度就不信它(宁可走退避探测)
const MAX_TRUSTED_RESET_SPAN_MS = 13 * 60 * 60 * 1000;

interface QuotaEpisode {
	waitedMs: number;
	backoffIndex: number;
	notified: boolean;
}

let episode: QuotaEpisode | null = null;

// ---------------------------------------------------------------- 解析

/** 取投影里最后一条消息;只有它正好是失败的 assistant 消息才认。 */
function findErroredAssistant(event: AgentBeforeSettleEvent): { entryId: string; errorMessage: string } | undefined {
	const projected: Array<{ entryId: string; message: { role?: string; stopReason?: string; errorMessage?: string } }> = [];
	for (const entry of event.context.contextEntries) {
		for (const message of entry.messages) {
			projected.push({ entryId: entry.sourceEntry.id, message });
		}
	}
	const last = projected[projected.length - 1];
	if (!last || last.message.role !== "assistant" || last.message.stopReason !== "error") return undefined;
	return { entryId: last.entryId, errorMessage: last.message.errorMessage ?? "" };
}

function isQuotaError(errorMessage: string): boolean {
	return QUOTA_PATTERN.test(errorMessage);
}

/** 智谱给的是北京时间,固定按 UTC+8 解析;跨度不合理则视为解析失败。 */
function parseResetAt(errorMessage: string): number | undefined {
	const match = RESET_TIME_PATTERN.exec(errorMessage);
	if (!match) return undefined;
	const [, year, month, day, hour, minute, second] = match;
	const at = Date.UTC(
		Number(year),
		Number(month) - 1,
		Number(day),
		Number(hour) - 8,
		Number(minute),
		Number(second),
	);
	if (!Number.isFinite(at)) return undefined;
	const span = at - Date.now();
	if (span > MAX_TRUSTED_RESET_SPAN_MS) return undefined;
	return at;
}

// ---------------------------------------------------------------- 渲染

function fmtClock(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
	return `${minutes}m${String(totalSeconds % 60).padStart(2, "0")}s`;
}

function renderWaitStatus(ctx: ExtensionContext, label: string, deadline: number, waitedMs: number): string {
	const theme = ctx.ui.theme;
	const left = fmtDuration(Math.max(0, deadline - Date.now()));
	return (
		theme.fg("warning", "⏳ 配额等待 ") +
		theme.fg("muted", `${label} · 还需 ${left}`) +
		theme.fg("dim", ` · 已等 ${fmtDuration(waitedMs)}`)
	);
}

// ---------------------------------------------------------------- 等待

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("aborted"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, Math.max(0, ms));
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * 可中断等待:每 1s 刷新状态栏倒计时。
 * 返回 false 表示应放弃等待(Esc 中断 / ctx 已失效)。signal 一次性捕获,避免 await 期间
 * 反复读 ctx 触发 stale 断言(参考 openviking 扩展的 stale-ctx 补丁)。
 */
async function waitForQuota(ms: number, ctx: ExtensionContext, label: string): Promise<boolean> {
	let signal: AbortSignal | undefined;
	try {
		signal = ctx.signal;
	} catch {
		return false;
	}
	const startedAt = Date.now();
	const deadline = startedAt + ms;
	const waitedBefore = episode?.waitedMs ?? 0;
	const render = () => {
		try {
			ctx.ui.setStatus(STATUS_ID, renderWaitStatus(ctx, label, deadline, waitedBefore + (Date.now() - startedAt)));
		} catch {
			// ctx 失效(会话被替换/重载):状态栏留给下一次重绘
		}
	};
	render();
	const ticker = setInterval(render, 1000);
	ticker.unref?.();
	try {
		for (;;) {
			if (signal?.aborted) return false;
			const left = deadline - Date.now();
			if (left <= 0) return !signal?.aborted;
			await sleep(Math.min(left, 1000), signal);
		}
	} catch {
		return false;
	} finally {
		clearInterval(ticker);
		try {
			ctx.ui.setStatus(STATUS_ID, undefined);
		} catch {
			// 同上
		}
	}
}

// ---------------------------------------------------------------- 状态

function clearWaitStatus(ctx: ExtensionContext): void {
	try {
		ctx.ui.setStatus(STATUS_ID, undefined);
	} catch {
		// ctx 失效,无需清理
	}
}

function notify(ctx: ExtensionContext, text: string, type: "info" | "warning" = "info"): void {
	try {
		ctx.ui.notify(text, type);
	} catch {
		// ctx 失效,静默
	}
}

/** 结束本轮 episode;成功恢复时给一条提示。 */
function endEpisode(ctx: ExtensionContext, reason: "recovered" | "giveUp" | "other", waitedMs = 0): void {
	const had = episode;
	episode = null;
	if (reason === "recovered" && had) notify(ctx, "配额已恢复,继续执行", "info");
	if (reason === "giveUp" && had) {
		notify(ctx, `配额等待已达上限(累计 ${fmtDuration(waitedMs)}),本轮按原错误结束`, "warning");
	}
}

// ---------------------------------------------------------------- 入口

export default function (pi: ExtensionAPI) {
	pi.on("agent_before_settle", async (event, ctx) => {
		const target = findErroredAssistant(event);

		// 正常结束(含压缩/继续等所有非错误收尾):episode 收尾并清空累计
		if (event.outcome !== "error" || !target) {
			if (episode) endEpisode(ctx, "recovered");
			else clearWaitStatus(ctx);
			return;
		}
		if (!isQuotaError(target.errorMessage)) {
			// 非配额错误(网络/5xx/上下文超限等)不该在此等待
			if (episode) endEpisode(ctx, "other");
			return;
		}

		episode ??= { waitedMs: 0, backoffIndex: 0, notified: false };
		const current = episode;
		const remainingBudget = MAX_TOTAL_WAIT_MS - current.waitedMs;
		if (remainingBudget < MIN_PROBE_GAP_MS) {
			// 累计等待已耗尽(12h):不再等待,本轮按原错误结束
			endEpisode(ctx, "giveUp", current.waitedMs);
			return;
		}

		// 解析出重置时刻且尚未到达 → 等到那一刻(缓冲后仍超 1h 也只等 1h,等下段再探);
		// 解析不出 / 时刻已过期(钟差)→ 走指数退避,避免拿错时刻或高频打点
		const resetAt = parseResetAt(target.errorMessage);
		const untilReset = resetAt === undefined ? Number.NEGATIVE_INFINITY : resetAt + RESET_BUFFER_MS - Date.now();
		let desired: number;
		let label: string;
		if (untilReset > 0) {
			desired = untilReset;
			label = `等待 ${fmtClock(resetAt as number)} 重置`;
		} else {
			desired = BACKOFF_BASE_MS * 2 ** current.backoffIndex;
			current.backoffIndex += 1;
			label = resetAt === undefined ? "未解析出重置时刻,退避探测" : "重置时刻已过,退避探测";
		}
		const waitMs = Math.min(Math.max(desired, MIN_PROBE_GAP_MS), MAX_SINGLE_WAIT_MS, remainingBudget);
		if (!current.notified) {
			current.notified = true;
			notify(
				ctx,
				`配额耗尽,自动等待后继续(本次 ${fmtDuration(waitMs)},累计上限 ${fmtDuration(MAX_TOTAL_WAIT_MS)});按 Esc 可取消`,
				"warning",
			);
		}

		const startedAt = Date.now();
		const completed = await waitForQuota(waitMs, ctx, label);
		if (!completed) {
			// Esc 或 ctx 失效:不续跑,本轮按原错误结束
			endEpisode(ctx, "other");
			return;
		}

		current.waitedMs += Date.now() - startedAt;

		// 剔除失败的 assistant 消息并复跑原请求;若仍 429,下一轮会再次回到这里继续记账
		return {
			entries: [{ type: "context_edit" as const, targetId: target.entryId, replacement: null }],
			continue: true,
		};
	});

	pi.on("session_shutdown", (_event, ctx) => {
		episode = null;
		clearWaitStatus(ctx);
	});
}
