/**
 * acp — Active Context Pruning for pi (MVP)
 *
 * 移植自 opencode-acp (https://github.com/ranxianglei/opencode-acp, AGPL-3.0).
 * 核心机制:模型主动调用 compress 工具指定对话范围 + 写好的摘要,
 * 扩展记录状态,之后每次发给 LLM 前(context 事件)删除被压缩的原始消息。
 * 摘要靠 compress 工具调用那条 assistant 消息(toolCall.arguments.summary)天然保留。
 *
 * MVP 范围:
 *   ✅ compress 工具(范围 + 摘要,模型传参,无独立 LLM 调用)
 *   ✅ prune:context 事件删除被压缩消息,保留第一条 user
 *   ✅ mNNNNN 消息标识注入 + 边界解析
 *   ✅ toolCall/toolResult 配对完整性保护
 *   ✅ 状态持久化(pi.appendEntry,branching 友好)
 *   ✅ 用量告知(每增长 15% 告知现状,不催促 —— 用户偏好)
 *   ✅ decompress 工具(停用块→消息重现)
 *   ⏳ 二期:GC old-gen 合并、质量门控、KEEP/REF 标记、tier 2/3 蒸馏
 *
 * 设计文档:C:\Users\hugua\project-codes\experiment\opencode-acp\PORT_TO_PI_DESIGN.md
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ============ 常量 ============
const STATE_TYPE = "acp-state"; // pi.appendEntry 的 customType(不参与 LLM 上下文)
const REF_PREFIX = "m";
const REF_WIDTH = 5;
const ID_TAG_OPEN = `<acp-id>`;
const ID_TAG_CLOSE = `</acp-id>`;
const REF_RE = /^m(\d{1,5})$/;
const USAGE_TYPE = "acp-usage"; // before_agent_start 注入的用量消息 customType
const USAGE_GROWTH_THRESHOLD = 0.15; // 用量每增长 15% 告知一次
const PROTECT_RECENT_N = 3; // 保护最近 N 条消息不被压缩

// ============ 类型 ============
interface CompressionBlock {
	blockId: number;
	runId: number;
	active: boolean;
	tier: 1 | 2 | 3;
	directMessageIds: string[]; // pi entry ids
	effectiveMessageIds: string[];
	consumedBlockIds: number[];
	anchorToolCallId: string; // compress 工具调用的 toolCallId
	summary: string;
	summaryTokens: number;
	topic?: string;
	startRef: string;
	endRef: string;
	createdAt: number;
}

interface PrunedMessageEntry {
	tokenCount: number;
	allBlockIds: number[];
	activeBlockIds: number[];
}

interface PruneMessagesState {
	byMessageId: Record<string, PrunedMessageEntry>; // entryId → entry
	blocksById: Record<number, CompressionBlock>;
	activeBlockIds: number[];
	nextBlockId: number;
	nextRunId: number;
}

interface SessionState {
	sessionId: string | null;
	prune: PruneMessagesState;
	lastUsageTokens: number; // 上次告知用量时的 token 数
	modelContextLimit?: number;
}

// ============ 状态注册表 ============
// per-session 内存缓存 + pi.appendEntry 持久化
const stateCache = new Map<string, SessionState>();

function freshState(sessionId: string | null): SessionState {
	return {
		sessionId,
		prune: {
			byMessageId: {},
			blocksById: {},
			activeBlockIds: [],
			nextBlockId: 1,
			nextRunId: 1,
		},
		lastUsageTokens: 0,
	};
}

/** 从 session 的 custom entry 恢复状态;无则新建空状态 */
function loadState(ctx: ExtensionContext): SessionState {
	const sid = ctx.sessionManager.getSessionId() ?? null;
	if (sid && stateCache.has(sid)) return stateCache.get(sid)!;

	let state: SessionState | null = null;
	if (sid) {
		// 从当前 branch 找最新的 acp-state custom entry
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const e = branch[i] as any;
			if (e?.type === "custom" && e?.customType === STATE_TYPE && e?.data) {
				try {
					state = reviveState(e.data, sid);
					break;
				} catch {
					/* 损坏数据,忽略 */
				}
			}
		}
	}
	if (!state) state = freshState(sid);
	if (sid) stateCache.set(sid, state);
	return state;
}

function reviveState(data: any, sid: string): SessionState {
	// 容错恢复:只取认识的字段
	const p = data?.prune ?? {};
	return {
		sessionId: sid,
		prune: {
			byMessageId: p.byMessageId ?? {},
			blocksById: p.blocksById ?? {},
			activeBlockIds: Array.isArray(p.activeBlockIds) ? p.activeBlockIds : [],
			nextBlockId: typeof p.nextBlockId === "number" ? p.nextBlockId : 1,
			nextRunId: typeof p.nextRunId === "number" ? p.nextRunId : 1,
		},
		lastUsageTokens: typeof data?.lastUsageTokens === "number" ? data.lastUsageTokens : 0,
		modelContextLimit: data?.modelContextLimit,
	};
}

/** 持久化状态(fire-and-forget) */
function saveState(state: SessionState, pi: ExtensionAPI): void {
	if (!state.sessionId) return;
	const data = {
		prune: state.prune,
		lastUsageTokens: state.lastUsageTokens,
		modelContextLimit: state.modelContextLimit,
	};
	try {
		pi.appendEntry(STATE_TYPE, data);
	} catch {
		/* 持久化失败不阻塞主流程 */
	}
}

function invalidateState(ctx: ExtensionContext): void {
	const sid = ctx.sessionManager.getSessionId();
	if (sid) stateCache.delete(sid);
}

// ============ 消息 ↔ entry 关联 + mNNNNN 分配 ============
/**
 * 返回参与 LLM 上下文的 entry 列表(type=message | custom_message),
 * 与 context 事件的 event.messages 按位置 1:1 对应(已验证)。
 * entry.id 是稳定标识,entry.message 是消息体。
 */
function getMessageEntries(ctx: ExtensionContext): any[] {
	const all = ctx.sessionManager.buildContextEntries();
	return all.filter((e: any) => e && (e.type === "message" || e.type === "custom_message"));
}

/** 确定性分配 mNNNNN:按 entry 顺序,index+1 零填充。被压缩的消息仍占号(稳定 ref)。 */
function buildRefMap(entries: any[]): Map<string, string> {
	const refByEntryId = new Map<string, string>();
	for (let i = 0; i < entries.length; i++) {
		const id = entries[i]?.id;
		if (typeof id === "string") {
			refByEntryId.set(id, REF_PREFIX + String(i + 1).padStart(REF_WIDTH, "0"));
		}
	}
	return refByEntryId;
}

function refToIndex(ref: string): number | null {
	const m = REF_RE.exec(ref);
	if (!m) return null;
	return parseInt(m[1], 10) - 1; // m00001 → index 0
}

// ============ 消息工具 ============
/** 取 entry 对应的 AgentMessage(context 事件里同位置的消息) */
function entryMessage(entry: any): any {
	return entry?.message ?? entry?.data ?? undefined;
}

/** 给一条消息追加 acp-id 标签(就地修改 deep copy) */
function injectIdTag(msg: any, ref: string): void {
	if (!msg || typeof msg !== "object") return;
	const tag = `${ID_TAG_OPEN}${ref}${ID_TAG_CLOSE}`;
	const c = msg.content;
	if (typeof c === "string") {
		msg.content = c.endsWith("\n") ? c + tag : c + "\n" + tag;
	} else if (Array.isArray(c)) {
		// 找最后一个 text block 追加
		for (let i = c.length - 1; i >= 0; i--) {
			if (c[i]?.type === "text") {
				const t = c[i].text as string;
				c[i].text = t.endsWith("\n") ? t + tag : t + "\n" + tag;
				return;
			}
		}
		// 无 text block,新建一个
		c.push({ type: "text", text: tag });
	}
}

/** 估算一条消息的 token 数(chars/4 粗估) */
function estimateMessageTokens(msg: any): number {
	const c = msg?.content;
	if (typeof c === "string") return Math.ceil(c.length / 4);
	if (Array.isArray(c)) {
		let chars = 0;
		for (const b of c) {
			if (b?.type === "text" && typeof b.text === "string") chars += b.text.length;
			else if (b?.type === "toolCall") chars += JSON.stringify(b.arguments ?? {}).length;
			else chars += JSON.stringify(b ?? {}).length;
		}
		return Math.ceil(chars / 4);
	}
	return 0;
}

/** 收集一条 assistant 消息里所有 toolCall.id */
function toolCallIdsOf(msg: any): string[] {
	const c = msg?.content;
	if (!Array.isArray(c)) return [];
	return c.filter((b: any) => b?.type === "toolCall" && typeof b.id === "string").map((b: any) => b.id);
}

// ============ 配对保护:调整边界,不拆散 toolCall/toolResult 对 ============
/**
 * 给定 entries(消息型)和 [startIdx,endIdx],调整边界使范围内不留下
 * 孤儿 toolCall 或孤儿 toolResult。
 * - 若范围内 assistant 有 toolCall,其 toolResult 必须也在范围内(否则 endIdx 后扩)
 * - 若范围边界落在 toolResult 上,其 toolCall 必须也在范围内(否则 startIdx 前扩)
 */
function adjustForToolPairs(entries: any[], startIdx: number, endIdx: number): { start: number; end: number } {
	const msgs = entries.map(entryMessage);
	let start = startIdx;
	let end = endIdx;
	// 多轮收敛(toolResult 后扩可能引入新 assistant 的 toolCall)
	for (let pass = 0; pass < 3; pass++) {
		let changed = false;
		// 收集 [start,end] 内所有 toolCall.id 和 toolResult.toolCallId
		const callIdsInRange = new Set<string>();
		const resultIdsInRange = new Set<string>();
		for (let i = start; i <= end && i < msgs.length; i++) {
			const m = msgs[i];
			if (!m) continue;
			if (m.role === "toolResult" && typeof m.toolCallId === "string") resultIdsInRange.add(m.toolCallId);
			for (const id of toolCallIdsOf(m)) callIdsInRange.add(id);
		}
		// 向后扩展:end 到的 assistant 的 toolCall,其 toolResult 可能在 end 之后
		for (let i = start; i <= end && i < msgs.length; i++) {
			for (const callId of toolCallIdsOf(msgs[i])) {
				const resultIdx = msgs.findIndex((m: any) => m?.role === "toolResult" && m?.toolCallId === callId);
				if (resultIdx > end) {
					end = resultIdx;
					changed = true;
				}
			}
		}
		// 向前扩展:start 落在 toolResult 上,其 toolCall 可能在 start 之前
		for (let i = start; i <= end && i < msgs.length; i++) {
			const m = msgs[i];
			if (m?.role === "toolResult" && typeof m.toolCallId === "string" && !callIdsInRange.has(m.toolCallId)) {
				const callIdx = msgs.findIndex((mm: any) => toolCallIdsOf(mm).includes(m.toolCallId));
				if (callIdx >= 0 && callIdx < start) {
					start = callIdx;
					changed = true;
				}
			}
		}
		if (!changed) break;
	}
	return { start, end };
}

// ============ 扩展主体 ============
export default function acpExtension(pi: ExtensionAPI): void {
	// ---- session_start: 预加载状态到缓存 ----
	pi.on("session_start", async (_event, ctx) => {
		loadState(ctx);
	});

	// ---- session_compact: compaction 删除了旧消息 entry,ACP 状态失效,重置 ----
	pi.on("session_compact", async (_event, ctx) => {
		// pi 原生 compaction 把旧消息总结成 summary entry,被 ACP 压缩的消息 entry 没了。
		// 清空 ACP 状态重新开始(byMessageId 指向的 entry 已不存在)。
		invalidateState(ctx);
		const sid = ctx.sessionManager.getSessionId();
		if (sid) {
			const fresh = freshState(sid);
			stateCache.set(sid, fresh);
			saveState(fresh, pi);
		}
	});

	// ---- before_agent_start: 用量告知(每增长 15% 告知,不催促)----
	pi.on("before_agent_start", async (_event, ctx) => {
		const state = loadState(ctx);
		const usage = ctx.getContextUsage();
		if (!usage || !usage.contextWindow || usage.contextWindow <= 0) return;
		const tokens = usage.tokens ?? 0;
		const window = usage.contextWindow;
		state.modelContextLimit = window;
		const pct = tokens / window;
		const growth = tokens - state.lastUsageTokens;
		// 首次超 35%,或之后每增长 15%,告知一次
		const shouldInform =
			(state.lastUsageTokens === 0 && pct >= 0.35) ||
			(state.lastUsageTokens > 0 && growth >= window * USAGE_GROWTH_THRESHOLD);
		if (!shouldInform) return;
		state.lastUsageTokens = tokens;
		saveState(state, pi);
		const line =
			`[acp] Context usage: ${tokens.toLocaleString()} tokens (${(pct * 100).toFixed(0)}% of ${window.toLocaleString()}). ` +
			`A \`compress\` tool is available to summarize concluded conversation ranges into compact summaries ` +
			`(use the mNNNNN refs in <acp-id> tags as startId/endId). Use it when context grows tight.`;
		return {
			message: { customType: USAGE_TYPE, content: line, display: false },
		};
	});

	// ---- message_end: 清除模型输出里幻觉的 <acp-*> 标签 ----
	pi.on("message_end", async (event, _ctx) => {
		if (event.message.role !== "assistant") return;
		const msg = event.message as any;
		let changed = false;
		const c = msg.content;
		if (Array.isArray(c)) {
			const newC = c.map((b: any) => {
				if (b?.type === "text" && typeof b.text === "string" && b.text.includes("<acp-")) {
					changed = true;
					return { ...b, text: stripAcpTags(b.text) };
				}
				return b;
			});
			if (changed) return { message: { ...msg, content: newC } };
		}
	});

	// ---- context: 核心流水线(sync → prune → 注入 id 标签)----
	pi.on("context", async (event, ctx) => {
		const state = loadState(ctx);
		const msgs = event.messages as any[];
		const entries = getMessageEntries(ctx);

		// 位置对应守卫:若不一致(异常情况),跳过 prune 保守处理,只尽量注入标签
		const aligned = entries.length === msgs.length;

		// prune + 注入 acp-id 标签(单循环完成:先决定保留,保留则就地注入标签)
		const refByEntryId = aligned ? buildRefMap(entries) : new Map<string, string>();
		const hasCompressed = Object.keys(state.prune.byMessageId).length > 0;
		const firstUserMsgIdx = msgs.findIndex((m) => m?.role === "user");
		const retained: any[] = [];
		for (let i = 0; i < msgs.length; i++) {
			const msg = msgs[i];
			const entryId = aligned ? entries[i]?.id : undefined;
			let keep = true;
			if (aligned && hasCompressed && entryId) {
				const pe = state.prune.byMessageId[entryId];
				keep = !pe || !pe.activeBlockIds || pe.activeBlockIds.length === 0;
			}
			if (i === firstUserMsgIdx) keep = true; // 强制保留第一条 user(provider API 要求至少一条 user)
			if (!keep) continue;
			const ref = entryId ? refByEntryId.get(entryId) : undefined;
			if (ref) injectIdTag(msg, ref); // 就地改 deep copy,安全;其他 handler 看到的是返回后的数组
			retained.push(msg);
		}
		return { messages: retained };
	});

	// ---- compress 工具 ----
	pi.registerTool({
		name: "compress",
		label: "Compress Context",
		description:
			"Compress one or more conversation ranges into summaries. Each range needs startId/endId " +
			"(the mNNNNN refs shown in <acp-id> tags) and a `summary` you write that replaces all content in the range. " +
			"Keep only essential details: conclusions, file paths, decisions, exact values. The summary replaces the " +
			"original messages in future context — write it as if the team needs to continue from it. Batch multiple " +
			"non-overlapping ranges in one call. Never compress the last few messages (still in active use).",
		promptGuidelines: [
			"Use compress to summarize COMPLETED conversation ranges (concluded topics, verbose exploration, " +
				"repetitive tool output) into concise summaries, freeing context. Specify boundaries with the mNNNNN " +
				"refs from <acp-id> tags and write a complete technical summary.",
		],
		parameters: Type.Object({
			content: Type.Array(
				Type.Object({
					topic: Type.Optional(Type.String({ description: "Short label (3-5 words) for this range" })),
					startId: Type.String({ description: "Start message ref, e.g. m00003 (from <acp-id> tag)" }),
					endId: Type.String({ description: "End message ref, e.g. m00010 (from <acp-id> tag)" }),
					summary: Type.String({
						description:
							"Complete technical summary replacing all content in range. Keep conclusions, file paths, decisions, exact values.",
					}),
				}),
				{ description: "One or more non-overlapping ranges to compress" },
			),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const state = loadState(ctx);
			const entries = getMessageEntries(ctx);
			const refByEntryId = buildRefMap(entries);
			const entryByRef = new Map<string, any>();
			for (const e of entries) {
				const r = refByEntryId.get(e.id);
				if (r) entryByRef.set(r, e);
			}

			const runId = state.prune.nextRunId++;
			const results: string[] = [];
			const coveredEntryIds = new Set<string>();

			for (const item of params.content) {
				const startIdx = refToIndex(item.startId);
				const endIdx = refToIndex(item.endId);
				if (startIdx === null || endIdx === null) {
					results.push(`✗ ${item.startId}–${item.endId}: invalid ref (use mNNNNN from <acp-id> tags)`);
					continue;
				}
				if (startIdx >= entries.length || endIdx >= entries.length) {
					results.push(`✗ ${item.startId}–${item.endId}: ref out of range (max m${String(entries.length).padStart(REF_WIDTH, "0")})`);
					continue;
				}
				let s = Math.min(startIdx, endIdx);
				let e = Math.max(startIdx, endIdx);

				// 保护最近 N 条消息
				const minCompressable = entries.length - PROTECT_RECENT_N;
				if (s >= minCompressable) {
					results.push(`✗ ${item.startId}–${item.endId}: includes recent messages (protected, still in use)`);
					continue;
				}
				if (e >= minCompressable) e = minCompressable - 1;
				if (e < s) {
					results.push(`✗ ${item.startId}–${item.endId}: entire range is protected recent messages`);
					continue;
				}

				// 配对保护
				const adj = adjustForToolPairs(entries, s, e);
				s = adj.start;
				e = adj.end;

				// 收集范围内的 entry id(message 型;custom_message 也可压缩)
				const rangeIds: string[] = [];
				let rangeTokens = 0;
				for (let i = s; i <= e; i++) {
					const id = entries[i]?.id;
					if (typeof id === "string") {
						rangeIds.push(id);
						rangeTokens += estimateMessageTokens(entryMessage(entries[i]));
					}
				}

				// 跳过已被其他活跃块完全覆盖的消息(防重复压缩产生空块)
				const newIds = rangeIds.filter((id) => {
					const pe = state.prune.byMessageId[id];
					return !pe || !pe.activeBlockIds || pe.activeBlockIds.length === 0;
				});
				if (newIds.length === 0) {
					results.push(`✗ ${item.startId}–${item.endId}: all messages already compressed`);
					continue;
				}

				// 创建 block
				const blockId = state.prune.nextBlockId++;
				const summaryTokens = Math.ceil(item.summary.length / 4);
				const block: CompressionBlock = {
					blockId,
					runId,
					active: true,
					tier: 1,
					directMessageIds: newIds,
					effectiveMessageIds: newIds,
					consumedBlockIds: [],
					anchorToolCallId: toolCallId,
					summary: item.summary,
					summaryTokens,
					topic: item.topic,
					startRef: item.startId,
					endRef: item.endId,
					createdAt: Date.now(),
				};
				state.prune.blocksById[blockId] = block;
				state.prune.activeBlockIds.push(blockId);

				// 更新 byMessageId
				for (const id of newIds) {
					coveredEntryIds.add(id);
					const existing = state.prune.byMessageId[id] ?? { tokenCount: 0, allBlockIds: [], activeBlockIds: [] };
					existing.allBlockIds.push(blockId);
					existing.activeBlockIds.push(blockId);
					if (existing.tokenCount === 0) existing.tokenCount = rangeTokens / newIds.length;
					state.prune.byMessageId[id] = existing;
				}

				results.push(
					`✓ block b${blockId}: compressed ${newIds.length} messages ` +
						`(~${Math.round(rangeTokens)} tokens) → summary ${summaryTokens} tokens` +
						(item.topic ? ` [${item.topic}]` : ""),
				);
			}

			saveState(state, pi);

			const totalSaved = Object.values(state.prune.byMessageId).reduce(
				(sum, pe) => sum + (pe.activeBlockIds.length > 0 ? pe.tokenCount : 0),
				0,
			);
			return {
				content: [
					{
						type: "text",
						text:
							results.join("\n") +
							`\n\nTotal compressed so far: ~${Math.round(totalSaved)} tokens across ` +
							`${state.prune.activeBlockIds.length} active block(s).`,
					},
				],
				details: { runId, blocks: state.prune.activeBlockIds.length },
			};
		},
	});

	// ---- decompress 工具:停用块,消息重现 ----
	pi.registerTool({
		name: "decompress",
		label: "Decompress Context",
		description:
			"Restore previously compressed conversation content by deactivating a compression block. " +
			"Pass a blockId (bN) to restore that range's original messages into context.",
		parameters: Type.Object({
			blockId: Type.String({ description: "Block id to deactivate, e.g. b1" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = loadState(ctx);
			const m = /^b(\d+)$/.exec(params.blockId);
			if (!m) {
				return { content: [{ type: "text", text: `Invalid blockId: ${params.blockId} (use bN format)` }], details: {} };
			}
			const bid = parseInt(m[1], 10);
			const block = state.prune.blocksById[bid];
			if (!block) {
				return { content: [{ type: "text", text: `Block b${bid} not found` }], details: {} };
			}
			if (!block.active) {
				return { content: [{ type: "text", text: `Block b${bid} already inactive` }], details: {} };
			}
			// 停用块:从 activeBlockIds 移除,从其消息的 activeBlockIds 移除
			block.active = false;
			state.prune.activeBlockIds = state.prune.activeBlockIds.filter((x) => x !== bid);
			for (const id of block.directMessageIds) {
				const pe = state.prune.byMessageId[id];
				if (pe) pe.activeBlockIds = pe.activeBlockIds.filter((x) => x !== bid);
			}
			saveState(state, pi);
			return {
				content: [
					{
						type: "text",
						text: `Decompressed b${bid}: ${block.directMessageIds.length} messages restored to context. ` +
							`Active blocks remaining: ${state.prune.activeBlockIds.length}.`,
					},
				],
				details: { deactivated: bid },
			};
		},
	});
}

// ============ 辅助 ============
function stripAcpTags(text: string): string {
	// 删除所有 <acp-...>...</acp-...> 标签及未配对的 <acp-...>
	return text
	.replace(/<acp-[a-z]+>[^<]*<\/acp-[a-z]+>/g, "")
	.replace(/<acp-[a-z]+[^>]*\/?>/g, "");
}
