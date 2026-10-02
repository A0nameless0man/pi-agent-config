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
 *   ✅ 用量提示:自然边界触发(agent 一轮结束 / todo 完成 / 硬限兜底),
 *      目标控制带 180K~250K(用户偏好),瞬态注入不污染 session —— 用户偏好)
 *   ✅ decompress 工具(停用块→消息重现)
 *   ✅ tier 2/3 蒸馏(2026-10-02 二期):compress 的 startId/endId 也接受块引用
 *      bN..bM → 旧块折叠成更高层摘要(tier-1→2→3,"散文上的 LSM 树"),consumed 块
 *      停用但保留谱系(effectiveMessageIds 传递闭包),decompress 上翻一代
 *   ✅ 锚点隐藏:被消费块的摘要承载(compress 调用 assistant 消息 + toolResult)
 *      随消费一起隐藏,decompress 自动恢复 —— 派生规则,不落盘
 *   ✅ search_context 工具(2026-10-02 二期):块摘要 + 被折叠原文的零成本关键词
 *      召回(hybrid: 0.7×BM25 + 0.3×char-bigram,CJK 分词感知,不改任何状态)
 *   ⏳ 三期:GC old-gen 合并、质量门控、KEEP/REF 标记、acp_status、/acp 命令
 *
 * pi ≥0.99 兼容(2026-09-30 修复):session 现在把 system prompt 也存为 message entry
 * (role=system),且 compaction/branch_summary entry 会展开出 compactionSummary /
 * branchSummary 消息;context 事件的 event.messages 过滤了 system 消息。旧的
 * "entry 列表与 messages 1:1"假设因此失效,导致 aligned 恒为 false、标签整体不注入
 * (模型看不到任何 <acp-id>)。现在用 getAlignmentRows 复刻 pi 的投影规则做对齐。
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
const BLOCK_REF_RE = /^b(\d+)$/;

// ---- 用量提示(自然边界触发,用户偏好:控制带 180K~250K,不要频繁 nudge)----
// 软限:超过后在自然边界(agent 一轮结束/todo 完成)提示;目标:提示里让模型压到这儿
// 硬限:长自治 run 不结束,靠 turn 级兜底强制提示(最小间隔 FORCED_NUDGE_TURN_GAP)
// 小窗口模型按比例收敛:min(绝对值, ratio × window)
const TARGET_TOKENS = envInt("ACP_TARGET_TOKENS", 180_000);
const SOFT_LIMIT_TOKENS = envInt("ACP_SOFT_LIMIT_TOKENS", 250_000);
const HARD_LIMIT_TOKENS = envInt("ACP_HARD_LIMIT_TOKENS", 320_000);
const TARGET_RATIO = 0.18;
const SOFT_LIMIT_RATIO = 0.25;
const HARD_LIMIT_RATIO = 0.32;
const FORCED_NUDGE_TURN_GAP = 8; // 硬限强制提示的最小 turn 间隔
const REPEAT_GROWTH_RATIO = 0.1; // 提示后未压缩:用量再涨 10% 才允许同边界重复提示

function envInt(name: string, dflt: number): number {
	const v = process.env[name];
	if (v && /^\d+$/.test(v)) return parseInt(v, 10);
	return dflt;
}
const PROTECT_RECENT_N = 3; // 保护最近 N 条消息不被压缩
// nudge 中蒸馏建议的活跃块数下限(安全阀定位:tier-2 蒸馏是长会话封顶手段而非常规路径,
// 参考论文结论"块数不是需求信号"——只挂在已超软限的提示里,不做独立触发)
const TIER2_HINT_MIN = 4;
const TIER3_HINT_MIN = 3;

// ============ 类型 ============
interface CompressionBlock {
	blockId: number;
	runId: number;
	active: boolean;
	tier: 1 | 2 | 3;
	directMessageIds: string[]; // pi entry ids
	effectiveMessageIds: string[];
	consumedBlockIds: number[];
	anchorToolCallId: string; // compress 工具调用的 toolCallId(摘要的 in-band 承载锚点)
	summary: string;
	summaryTokens: number;
	topic?: string;
	startRef: string;
	endRef: string;
	createdAt: number;
	coveredTokens?: number; // 被覆盖原始消息的 token 估算(统计与搜索展示;旧状态缺省=0)
	// 停用原因:"consumed"=被更高层块蒸馏(锚点隐藏);"decompress"=用户停用(锚点保留);
	// undefined=从未停用或旧版本状态(视为 decompress 语义,锚点保留)
	deactivatedBy?: "consumed" | "decompress";
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

interface NudgeState {
	pending: boolean; // 自然边界已到、待注入提示
	reason: "run-settled" | "todo-completed" | "forced-high-usage" | "";
	markedAtUsage: number; // 标记 pending 时的用量(注入时复核,防陈旧标记)
	lastNudgeUsage: number; // 上次实际注入提示时的用量(频控基线,compress 成功后重置)
	turnCounter: number; // 会话累计 turn 数(硬限间隔控制)
	lastNudgeTurn: number; // 上次注入提示时的 turnCounter
}

interface SessionState {
	sessionId: string | null;
	prune: PruneMessagesState;
	nudge: NudgeState;
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
		nudge: { pending: false, reason: "", markedAtUsage: 0, lastNudgeUsage: 0, turnCounter: 0, lastNudgeTurn: 0 },
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
	const n = data?.nudge ?? {};
	// blocksById 补齐二期新字段(JSON round-trip 后键为字符串,数值访问天然兼容)
	const blocksById: Record<number, CompressionBlock> = {};
	for (const [k, v] of Object.entries(p.blocksById ?? {})) {
		const bid = Number(k);
		if (!Number.isFinite(bid) || !v || typeof v !== "object") continue;
		blocksById[bid] = {
			...(v as CompressionBlock),
			coveredTokens: typeof (v as any).coveredTokens === "number" ? (v as any).coveredTokens : 0,
			deactivatedBy:
				(v as any).deactivatedBy === "consumed" || (v as any).deactivatedBy === "decompress"
					? (v as any).deactivatedBy
					: undefined,
		};
	}
	return {
		sessionId: sid,
		prune: {
			byMessageId: p.byMessageId ?? {},
			blocksById,
			activeBlockIds: Array.isArray(p.activeBlockIds) ? p.activeBlockIds : [],
			nextBlockId: typeof p.nextBlockId === "number" ? p.nextBlockId : 1,
			nextRunId: typeof p.nextRunId === "number" ? p.nextRunId : 1,
		},
		nudge: {
			pending: n.pending === true,
			reason: ["run-settled", "todo-completed", "forced-high-usage", ""].includes(n.reason) ? n.reason : "",
			markedAtUsage: typeof n.markedAtUsage === "number" ? n.markedAtUsage : 0,
			lastNudgeUsage: typeof n.lastNudgeUsage === "number" ? n.lastNudgeUsage : 0,
			turnCounter: typeof n.turnCounter === "number" ? n.turnCounter : 0,
			lastNudgeTurn: typeof n.lastNudgeTurn === "number" ? n.lastNudgeTurn : 0,
		},
		modelContextLimit: data?.modelContextLimit,
	};
}

/** 持久化状态(fire-and-forget) */
function saveState(state: SessionState, pi: ExtensionAPI): void {
	if (!state.sessionId) return;
	const data = {
		prune: state.prune,
		nudge: state.nudge,
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
/** 对齐行:与 context 事件 event.messages 的一行对应。entryId 为 null 表示该行
 *  消息没有可压缩的 session entry(compactionSummary / branchSummary),
 *  不注入标签、不可压缩、永不被 prune。 */
interface AlignmentRow {
	entryId: string | null;
	msg: any;
}

/**
 * 复刻 pi 的 entry→messages 投影,返回与 context 事件 event.messages 位置 1:1
 * 对应的对齐行序列。
 *
 * pi ≥0.99 投影规则(dist/core/session-manager.js sessionEntryToContextMessages):
 *   - message:        → [message],但 role=system 被 context 事件过滤(不占行)
 *   - custom_message: → 1 条 role=custom 消息
 *   - branch_summary: → summary 存在时 1 条 role=branchSummary 消息
 *   - compaction:     → systemMessage(role=system,被过滤)+ summary(role=compactionSummary)
 *   - 其他(custom 等): → 0 条
 * 一旦 pi 投影规则再变,aligned 守卫仍会兜底(放弃注入而不是错位注入)。
 */
function getAlignmentRows(ctx: ExtensionContext): AlignmentRow[] {
	const all = ctx.sessionManager.buildContextEntries() as any[];
	const rows: AlignmentRow[] = [];
	for (const e of all) {
		if (!e) continue;
		const id = typeof e.id === "string" ? e.id : null;
		if (e.type === "message") {
			const m = e.message;
			if (!m || m.role === "system") continue; // context 事件不含 system 消息
			rows.push({ entryId: id, msg: m });
		} else if (e.type === "custom_message") {
			rows.push({ entryId: id, msg: entryMessage(e) });
		} else if (e.type === "branch_summary") {
			if (e.summary) rows.push({ entryId: null, msg: e });
		} else if (e.type === "compaction") {
			// systemMessage 被 context 事件过滤;仅 summary 占一行(entryId=null,不可压缩)
			if (e.summary) rows.push({ entryId: null, msg: e });
		}
	}
	return rows;
}

/** 确定性分配 mNNNNN:按对齐行顺序,index+1 零填充。被压缩的消息仍占号(稳定 ref)。 */
function buildRefMap(rows: AlignmentRow[]): Map<string, string> {
	const refByEntryId = new Map<string, string>();
	for (let i = 0; i < rows.length; i++) {
		const id = rows[i]?.entryId;
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
function adjustForToolPairs(msgs: any[], startIdx: number, endIdx: number): { start: number; end: number } {
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

// ============ 用量提示:阈值计算与文案 ============
interface AcpLimits {
	soft: number;
	target: number;
	hard: number;
	window: number;
}

/** 计算当前会话的提示阈值:绝对值优先,小窗口按比例收敛 */
function computeLimits(window: number): AcpLimits {
	return {
		window,
		soft: Math.min(SOFT_LIMIT_TOKENS, Math.round(window * SOFT_LIMIT_RATIO)),
		target: Math.min(TARGET_TOKENS, Math.round(window * TARGET_RATIO)),
		hard: Math.min(HARD_LIMIT_TOKENS, Math.round(window * HARD_LIMIT_RATIO)),
	};
}

function nudgeText(tokens: number, limits: AcpLimits, hint = ""): string {
	const need = Math.max(0, tokens - limits.target);
	return (
		`[acp] Context check-in: ${tokens.toLocaleString()} tokens (${((tokens / limits.window) * 100).toFixed(1)}% of ${limits.window.toLocaleString()}). ` +
		`Usage is above the ~${limits.soft.toLocaleString()} working band. When current work reaches a stopping point, ` +
		`use \`compress\` (mNNNNN refs from <acp-id> tags as startId/endId) to summarize completed ranges ` +
		`and free ~${need.toLocaleString()} tokens, bringing usage toward ~${limits.target.toLocaleString()}. ` +
		`If everything is genuinely still in active use, continue and compress later.` +
		hint
	);
}

/** 蒸馏建议(仅附加在已超软限的 nudge 里):活跃 tier-1 块堆积时可折成 tier-2,tier-2 → tier-3 同理 */
function tierHintText(state: SessionState): string {
	const activeOfTier = (t: 1 | 2 | 3) =>
		state.prune.activeBlockIds
			.map((id) => state.prune.blocksById[id])
			.filter((b): b is CompressionBlock => !!b && b.tier === t)
			.map((b) => b.blockId);
	const t2 = activeOfTier(2);
	if (t2.length >= TIER3_HINT_MIN) {
		const [lo, hi] = [Math.min(...t2), Math.max(...t2)];
		return ` Alternatively, condense the ${t2.length} tier-2 blocks (b${lo}${hi > lo ? `–b${hi}` : ""}) into one tier-3 block via compress with block refs.`;
	}
	const t1 = activeOfTier(1);
	if (t1.length >= TIER2_HINT_MIN) {
		const [lo, hi] = [Math.min(...t1), Math.max(...t1)];
		return ` Alternatively, distill the ${t1.length} tier-1 blocks (b${lo}${hi > lo ? `–b${hi}` : ""}) into one tier-2 block: compress({content:[{startId:"b${lo}",endId:"b${hi}",summary:"…"}]}).`;
	}
	return "";
}

// ============ 二期:块蒸馏 / 锚点隐藏 / 统计 ============

/** 块范围蒸馏:把 [firstBid..lastBid] 内全部活跃同层块折成一个高层块。
 *  语义对齐 acp-kernel applyCompression:block 边界 → outputTier = min(3, targetTier+1);
 *  children 置 inactive-consumed 但不清 byMessageId(原文仍隐藏,由新块覆盖);
 *  effectiveMessageIds 取 children 的传递闭包(谱系在再压缩后仍存活)。
 *  返回 ✓ 结果行或 ✗ 原因(不抛错,与消息分支的 per-item 报告风格一致)。 */
function distillBlocks(
	state: PruneMessagesState,
	firstBid: number,
	lastBid: number,
	item: { topic?: string; startId: string; endId: string; summary: string },
	runId: number,
	toolCallId: string,
): string {
	const lo = Math.min(firstBid, lastBid);
	const hi = Math.max(firstBid, lastBid);
	if (hi - lo > 500) return `✗ range too large (b${lo}–b${hi}); distill in smaller batches`;
	// 端点必须存在且活跃(捕获常见 stale-ref 错误);区间中段对 inactive/不存在的 id 透明
	// ——被消费/已解压的块不占可见空间,数字区间按创建序穿透它们(对齐 BC "只有活跃块占位"语义)
	const bLo = state.blocksById[lo];
	if (!bLo || !bLo.active) {
		return `✗ block b${lo} ${bLo ? "is not active (folded into a higher-tier block or already decompressed)" : "does not exist"} — use active block ids from compress tool results`;
	}
	const bHi = state.blocksById[hi];
	if (!bHi || !bHi.active) {
		return `✗ block b${hi} ${bHi ? "is not active (folded into a higher-tier block or already decompressed)" : "does not exist"} — use active block ids from compress tool results`;
	}
	const ids: number[] = [];
	const blocks: CompressionBlock[] = [];
	for (let bid = lo; bid <= hi; bid++) {
		const b = state.blocksById[bid];
		if (b && b.active) {
			ids.push(bid);
			blocks.push(b);
		}
	}
	const targetTier = Math.min(...blocks.map((b) => b.tier));
	if (blocks.some((b) => b.tier !== targetTier)) {
		return `✗ range mixes tiers (${blocks.map((b) => `b${b.blockId}:T${b.tier}`).join(", ")}) — distill same-tier blocks only`;
	}
	// T3 是终态:重凝结 T3 零收益且可无限循环(参考 dog/billion-context-pi#3 防环护栏)
	if (targetTier >= 3) {
		return `✗ tier-3 is the highest tier — re-condensing tier-3 blocks reclaims nothing; compress new messages into fresh tier-1 blocks instead`;
	}
	const outputTier = (targetTier + 1) as 2 | 3;
	const summaryTokens = Math.ceil(item.summary.length / 4);
	// effectiveMessageIds = children 传递闭包(块蒸馏不直接覆盖消息)
	const eff = new Set<string>();
	let coveredTokens = 0;
	let foldedSummaryTokens = 0;
	for (const b of blocks) {
		for (const id of b.effectiveMessageIds) eff.add(id);
		coveredTokens += b.coveredTokens ?? 0;
		foldedSummaryTokens += b.summaryTokens;
	}
	const blockId = state.nextBlockId++;
	state.blocksById[blockId] = {
		blockId,
		runId,
		active: true,
		tier: outputTier,
		directMessageIds: [],
		effectiveMessageIds: [...eff],
		consumedBlockIds: ids,
		anchorToolCallId: toolCallId,
		summary: item.summary,
		summaryTokens,
		topic: item.topic,
		startRef: item.startId,
		endRef: item.endId,
		createdAt: Date.now(),
		coveredTokens,
	};
	state.activeBlockIds.push(blockId);
	for (const b of blocks) {
		b.active = false;
		b.deactivatedBy = "consumed";
	}
	state.activeBlockIds = state.activeBlockIds.filter((x) => !ids.includes(x));
	return (
		`✓ block b${blockId} (tier ${outputTier}): distilled ${ids.length} tier-${targetTier} block(s) ` +
		`(b${lo}${hi > lo ? `–b${hi}` : ""}, ~${Math.round(coveredTokens)} tok originals + ${foldedSummaryTokens} tok of summaries) ` +
		`→ ${summaryTokens} tok summary${item.topic ? ` [${item.topic}]` : ""}`
	);
}

/** 计算应隐藏的锚点 entry 集合:被完全消费的 compress 调用所承载的
 *  assistant 消息 + 其 toolResult。摘要 in-band 承载于 compress 调用消息,消费后
 *  旧摘要被高层摘要取代 → 锚点一起隐藏(decompress 复活子块时自动恢复,派生规则不落盘)。
 *  - assistant 行仅在全部 toolCall 均为已隐藏 compress 调用时才隐藏(兄弟调用保护);
 *  - toolResult 仅在其调用方 assistant 行被隐藏时才隐藏(不拆 toolCall/toolResult 对);
 *  - 同一调用批量建的块只要还有任一块可见(含 decompress 停用),锚点保留。 */
function computeHiddenAnchorEntries(state: SessionState, rows: AlignmentRow[]): Set<string> {
	const empty = new Set<string>();
	const allBlocks = Object.values(state.prune.blocksById);
	if (allBlocks.length === 0) return empty;
	const hiddenCallIds = new Set<string>();
	const groups = new Map<string, CompressionBlock[]>();
	for (const b of allBlocks) {
		if (!b?.anchorToolCallId) continue;
		const list = groups.get(b.anchorToolCallId) ?? [];
		list.push(b);
		groups.set(b.anchorToolCallId, list);
	}
	for (const [tcid, bs] of groups) {
		if (!bs.some((b) => b.active || b.deactivatedBy !== "consumed")) hiddenCallIds.add(tcid);
	}
	if (hiddenCallIds.size === 0) return empty;
	const hidden = new Set<string>();
	const carrierEntryByCallId = new Map<string, string>();
	for (const row of rows) {
		if (!row.entryId || !row.msg) continue;
		if (row.msg.role === "assistant") {
			const calls = toolCallIdsOf(row.msg);
			if (calls.length > 0 && calls.every((id) => hiddenCallIds.has(id))) hidden.add(row.entryId);
			for (const id of calls) carrierEntryByCallId.set(id, row.entryId);
		}
	}
	for (const row of rows) {
		if (!row.entryId || !row.msg) continue;
		if (
			row.msg.role === "toolResult" &&
			typeof row.msg.toolCallId === "string" &&
			hiddenCallIds.has(row.msg.toolCallId)
		) {
			const carrier = carrierEntryByCallId.get(row.msg.toolCallId);
			if (carrier && hidden.has(carrier)) hidden.add(row.entryId);
		}
	}
	return hidden;
}

/** 压缩统计(按块口径,避免 byMessageId 在蒸馏后双计):
 *  活跃块覆盖的原文 token + 已消费块被取代的摘要锚点 token */
function compressionStats(state: SessionState): { totalTokens: number; activeByTier: [number, number, number] } {
	const activeSet = new Set(state.prune.activeBlockIds);
	let covered = 0;
	let anchorFreed = 0;
	const activeByTier: [number, number, number] = [0, 0, 0];
	for (const b of Object.values(state.prune.blocksById)) {
		if (!b) continue;
		if (activeSet.has(b.blockId)) {
			covered += b.coveredTokens ?? 0;
			if (b.tier >= 1 && b.tier <= 3) activeByTier[b.tier - 1]++;
		} else if (b.deactivatedBy === "consumed") {
			// 其摘要锚点(compress 调用消息)已被高层摘要取代 → 实际释放
			anchorFreed += b.summaryTokens;
		}
	}
	return { totalTokens: Math.round(covered + anchorFreed), activeByTier };
}

// ============ search_context:被折叠内容的零成本关键词召回 ============
// 设计对齐 acp-kernel hybrid 检索:0.7×BM25(stem + CJK 分词) + 0.3×char-bigram,
// 角色权重 user 1.5 / assistant 1 / tool 0.6 / block 1。文档集 =
// 全部块摘要(含 inactive,谱系可搜) + 被任一块覆盖的原始消息(session 里仍存全文);
// 未被压缩的消息不进索引(模型本来就看得见)。检索零状态改动,不污染上下文。

interface SearchDoc {
	kind: "block" | "message";
	ref: string;
	text: string;
	title: string;
	role?: "user" | "assistant" | "tool";
	tier?: number;
	tokens?: number;
	blockId?: number;
	active?: boolean; // block 文档用:inactive 块谱系可搜但不可直接 decompress
}

const LATIN_TOKEN_RE = /[a-z0-9][a-z0-9_+-]*/g;
const CJK_RUN_RE = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g;
const CJK_CHAR_RE = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
let cjkSegmenter: Intl.Segmenter | null | undefined; // undefined=未初始化
function getSegmenter(): Intl.Segmenter | null {
	if (cjkSegmenter !== undefined) return cjkSegmenter;
	try {
		cjkSegmenter = new Intl.Segmenter("zh", { granularity: "word" });
	} catch {
		cjkSegmenter = null;
	}
	return cjkSegmenter;
}

/** 极简英文词形归一(只处理规则复数,与 acp-kernel stem 的轻量定位一致) */
function stemLatin(w: string): string {
	if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
	return w;
}

/** CJK 分词:Intl.Segmenter 词典分词;退化到 字符 bigram + 单字 */
function cjkRunTokens(run: string): string[] {
	const seg = getSegmenter();
	if (seg) {
		const words: string[] = [];
		for (const s of seg.segment(run)) {
			if (s.segment.length >= 2 && CJK_CHAR_RE.test(s.segment)) words.push(s.segment);
		}
		if (words.length > 0) return words;
	}
	const out: string[] = [];
	for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
	for (const ch of run) out.push(ch);
	return out;
}

function tokenize(text: string): string[] {
	const lower = text.toLowerCase();
	const out: string[] = [];
	for (const w of lower.match(LATIN_TOKEN_RE) ?? []) if (w.length >= 2) out.push(stemLatin(w));
	for (const run of lower.match(CJK_RUN_RE) ?? []) out.push(...cjkRunTokens(run));
	return out;
}

function charBigramsOf(text: string): string[] {
	const lower = text.toLowerCase();
	const out: string[] = [];
	for (const run of lower.match(CJK_RUN_RE) ?? []) {
		for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
	}
	for (const w of lower.match(LATIN_TOKEN_RE) ?? []) {
		if (w.length >= 2) for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2));
	}
	return out;
}

function bm25Scores(docs: SearchDoc[], qTerms: string[]): Map<string, number> {
	const out = new Map<string, number>();
	if (docs.length === 0 || qTerms.length === 0) return out;
	const k1 = 1.2;
	const b = 0.75;
	const parsed = docs.map((d) => {
		const tf = new Map<string, number>();
		let len = 0;
		for (const t of tokenize(d.text)) {
			tf.set(t, (tf.get(t) ?? 0) + 1);
			len++;
		}
		return { ref: d.ref, tf, len };
	});
	const avgdl = parsed.reduce((s, d) => s + d.len, 0) / docs.length;
	if (avgdl <= 0) return out;
	const idf = new Map<string, number>();
	for (const t of new Set(qTerms)) {
		let df = 0;
		for (const d of parsed) if (d.tf.has(t)) df++;
		idf.set(t, Math.log(1 + (docs.length - df + 0.5) / (df + 0.5)));
	}
	for (const d of parsed) {
		let s = 0;
		for (const t of qTerms) {
			const f = d.tf.get(t) ?? 0;
			if (f === 0) continue;
			s += ((idf.get(t) ?? 0) * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * d.len) / avgdl));
		}
		out.set(d.ref, s);
	}
	return out;
}

function fuzzyScores(docs: SearchDoc[], qGrams: Set<string>): Map<string, number> {
	const out = new Map<string, number>();
	if (qGrams.size === 0) return out;
	for (const d of docs) {
		const dg = new Set(charBigramsOf(d.text));
		let hits = 0;
		for (const g of qGrams) if (dg.has(g)) hits++;
		out.set(d.ref, hits / qGrams.size);
	}
	return out;
}

function searchDocs(docs: SearchDoc[], query: string, limit: number): { doc: SearchDoc; score: number }[] {
	const bm = bm25Scores(docs, tokenize(query));
	const fz = fuzzyScores(docs, new Set(charBigramsOf(query)));
	let maxBm = 1e-9;
	let maxFz = 1e-9;
	for (const v of bm.values()) maxBm = Math.max(maxBm, v);
	for (const v of fz.values()) maxFz = Math.max(maxFz, v);
	const ROLE_W = { user: 1.5, assistant: 1, tool: 0.6, block: 1 };
	return docs
		.map((d) => {
			const bmS = (bm.get(d.ref) ?? 0) / maxBm;
			const fzS = (fz.get(d.ref) ?? 0) / maxFz;
			// 噪声门:fuzzy bigram 对长 token 会随机命中常见双字(at/no/ma…),
			// 要求词级 BM25 命中、或 bigram 覆盖率足够高(≥1/3)才算真实命中
			const ok = (bm.get(d.ref) ?? 0) > 0 || (fz.get(d.ref) ?? 0) >= 0.34;
			const w = d.kind === "block" ? ROLE_W.block : (d.role && ROLE_W[d.role]) ?? 1;
			return { doc: d, score: ok ? (0.7 * bmS + 0.3 * fzS) * w : 0 };
		})
		.filter((x) => x.score > 0.01)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit);
}

/** 提取消息可搜索文本(text block + toolCall 参数;跳过图片等二进制块) */
function messageText(msg: any): string {
	const c = msg?.content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	let out = "";
	for (const b of c) {
		if (b?.type === "text" && typeof b.text === "string") out += b.text + "\n";
		else if (b?.type === "toolCall") out += JSON.stringify(b.arguments ?? {}) + "\n";
		else if (b && typeof b === "object") out += JSON.stringify(b).slice(0, 2000) + "\n";
	}
	return out;
}

function makePreview(text: string, query: string, len = 200): string {
	const lower = text.toLowerCase();
	const terms = query.toLowerCase().trim().split(/\s+/).filter((t) => t.length > 0);
	let hit = -1;
	for (const t of terms) {
		const i = lower.indexOf(t);
		if (i >= 0) {
			hit = i;
			break;
		}
	}
	if (hit < 0) return text.length > len ? text.slice(0, len - 1) + "…" : text;
	const half = Math.max(0, Math.floor(len / 2) - 10);
	const start = Math.max(0, hit - half);
	const end = Math.min(text.length, start + len);
	return (start > 0 ? "…" : "") + text.slice(start, end).trim() + (end < text.length ? "…" : "");
}

function formatTok(n?: number): string {
	if (!n || n <= 0) return "";
	return n < 1000 ? `${Math.round(n)}tok` : `${(n / 1000).toFixed(1)}Ktok`;
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

	// ---- 用量提示:自然边界标记(用户偏好:不要频繁 nudge,只在收尾点提示)----
	// 三个边界:agent 一轮对话完全结束 / todo 工具调用完成 / 硬限兕底(长自治 run 不会 settled)。
	// 标记 pending → 下一个 turn 的 context 事件里瞬态注入提示(不写入 session,不堆积)。
	const markIfOverSoft = (state: SessionState, ctx: ExtensionContext, reason: NudgeState["reason"]): void => {
		const usage = ctx.getContextUsage();
		const window = usage?.contextWindow ?? state.modelContextLimit ?? 0;
		if (!window || window <= 0) return;
		const tokens = usage?.tokens ?? 0;
		if (tokens <= 0) return;
		const limits = computeLimits(window);
		if (tokens < limits.soft) return;
		// 频控:提示过但模型未压缩,需用量再涨 REPEAT_GROWTH_RATIO 才重复提示(compress 成功会清零基线)
		if (state.nudge.lastNudgeUsage > 0 && tokens - state.nudge.lastNudgeUsage < window * REPEAT_GROWTH_RATIO) return;
		state.nudge.pending = true;
		state.nudge.reason = reason;
		state.nudge.markedAtUsage = tokens;
		saveState(state, pi);
	};

	pi.on("agent_settled", async (_event, ctx) => {
		// 模型结束一轮对话停下等用户:最自然的提示点
		markIfOverSoft(loadState(ctx), ctx, "run-settled");
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		// todo 完成是阶段性收尾点,此时压缩心智负担最小
		if (event.toolName !== "todo") return;
		markIfOverSoft(loadState(ctx), ctx, "todo-completed");
	});

	pi.on("turn_end", async (_event, ctx) => {
		const state = loadState(ctx);
		state.nudge.turnCounter++;
		// 硬限兕底:长自治 run(不 settled、无 todo)超硬限时强制标记,间隔 FORCED_NUDGE_TURN_GAP 防骚扰
		const usage = ctx.getContextUsage();
		const window = usage?.contextWindow ?? state.modelContextLimit ?? 0;
		if (window > 0 && (usage?.tokens ?? 0) >= Math.min(HARD_LIMIT_TOKENS, Math.round(window * HARD_LIMIT_RATIO))) {
			if (state.nudge.turnCounter - state.nudge.lastNudgeTurn >= FORCED_NUDGE_TURN_GAP) {
				state.nudge.pending = true;
				state.nudge.reason = "forced-high-usage";
				state.nudge.markedAtUsage = usage?.tokens ?? 0;
				// 仅状态实际变化时持久化(turnCounter 重启后可能陈旧,但兕底间隔容忍这点偏差,
				// 避免每 turn 写一条 acp-state entry 膨胀 session 文件)
				saveState(state, pi);
			}
		}
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
		const rows = getAlignmentRows(ctx);

		// 位置对应守卫:若不一致(pi 投影规则再变/异常情况),跳过 prune 保守处理,不注入标签
		const aligned = rows.length === msgs.length;

		// prune + 注入 acp-id 标签(单循环完成:先决定保留,保留则就地注入标签)
		const refByEntryId = buildRefMap(rows);
		const hasCompressed = Object.keys(state.prune.byMessageId).length > 0;
		// 锚点隐藏:被完全消费的 compress 调用(摘要已被高层块取代)整体移出上下文
		const hiddenEntryIds = computeHiddenAnchorEntries(state, rows);
		const firstUserMsgIdx = msgs.findIndex((m) => m?.role === "user");
		const retained: any[] = [];
		for (let i = 0; i < msgs.length; i++) {
			const msg = msgs[i];
			const entryId = aligned ? rows[i]?.entryId ?? undefined : undefined;
			let keep = true;
			if (aligned && entryId) {
				if (hasCompressed) {
					const pe = state.prune.byMessageId[entryId];
					if (pe && pe.activeBlockIds && pe.activeBlockIds.length > 0) keep = false;
				}
				if (keep && hiddenEntryIds.has(entryId)) keep = false;
			}
			if (i === firstUserMsgIdx) keep = true; // 强制保留第一条 user(provider API 要求至少一条 user)
			if (!keep) continue;
			const ref = entryId ? refByEntryId.get(entryId) : undefined;
			if (ref) injectIdTag(msg, ref); // 就地改 deep copy,安全;其他 handler 看到的是返回后的数组
			retained.push(msg);
		}

		// ---- 消费 pending 提示:瞬态 user 消息,仅本次请求可见,不写入 session、不堆积 ----
		if (state.nudge.pending) {
			state.nudge.pending = false;
			const usage = ctx.getContextUsage();
			const window = usage?.contextWindow ?? state.modelContextLimit ?? 0;
			const tokens = usage?.tokens ?? 0;
			if (window > 0) state.modelContextLimit = window;
			const limits = window > 0 ? computeLimits(window) : null;
			// 复核:标记时的超限仍成立才注入(模型可能已自行压缩过)
			if (limits && tokens >= limits.soft && state.nudge.markedAtUsage > 0) {
				retained.push({
					role: "user",
					content: [{ type: "text", text: nudgeText(tokens, limits, tierHintText(state)) }],
				} as any);
				state.nudge.lastNudgeUsage = tokens;
				state.nudge.lastNudgeTurn = state.nudge.turnCounter;
				if (process.env.ACP_DEBUG) {
					console.error(`[acp] injected nudge (reason=${state.nudge.reason}) at ${tokens} tokens, soft=${limits.soft}`);
				}
			}
			saveState(state, pi);
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
			"non-overlapping ranges in one call. Never compress the last few messages (still in active use). " +
			"Distillation: startId/endId may also be block refs (bN, both ends) — folds ALL blocks in the id range " +
			"(same tier, active) into ONE higher-tier block (tier-1→tier-2→tier-3; tier-3 is terminal). " +
			"Use it when old summaries pile up: progressively relax fidelity — priority goals > decisions+reasons > artifacts > conclusions > lessons.",
		promptGuidelines: [
			"Use compress to summarize COMPLETED conversation ranges (concluded topics, verbose exploration, " +
				"repetitive tool output) into concise summaries, freeing context. Specify boundaries with the mNNNNN " +
				"refs from <acp-id> tags and write a complete technical summary.",
			"When old compress blocks accumulate, distill them: compress with startId/endId as block refs (bN..bM) " +
				"replaces several old summaries with one higher-tier summary.",
		],
		parameters: Type.Object({
			content: Type.Array(
				Type.Object({
					topic: Type.Optional(Type.String({ description: "Short label (3-5 words) for this range" })),
					startId: Type.String({
						description: "Start ref: mNNNNN (message, from <acp-id> tag) or bN (block id, for tier distillation)",
					}),
					endId: Type.String({
						description: "End ref (inclusive): mNNNNN or bN. Must match startId's kind.",
					}),
					summary: Type.String({
						description:
							"Complete technical summary replacing all content in range. Keep conclusions, file paths, decisions, exact values.",
					}),
				}),
				{ description: "One or more non-overlapping ranges (message refs or block refs) to compress" },
			),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const state = loadState(ctx);
			const rows = getAlignmentRows(ctx);
			const refByEntryId = buildRefMap(rows);

			const runId = state.prune.nextRunId++;
			const results: string[] = [];
			const coveredEntryIds = new Set<string>();

			for (const item of params.content) {
				// 块范围蒸馏:startId/endId 均为 bN → 旧块折成更高层摘要(tier-1→2→3)
				const bsRef = BLOCK_REF_RE.exec(item.startId);
				const beRef = BLOCK_REF_RE.exec(item.endId);
				if (bsRef || beRef) {
					if (!bsRef || !beRef) {
						results.push(
							`✗ ${item.startId}–${item.endId}: mixed ref kinds — use both bN (block distillation) or both mNNNNN (message range)`,
						);
						continue;
					}
					results.push(
						distillBlocks(state.prune, parseInt(bsRef[1], 10), parseInt(beRef[1], 10), item, runId, toolCallId),
					);
					continue;
				}
				const startIdx = refToIndex(item.startId);
				const endIdx = refToIndex(item.endId);
				if (startIdx === null || endIdx === null) {
					results.push(`✗ ${item.startId}–${item.endId}: invalid ref (use mNNNNN from <acp-id> tags)`);
					continue;
				}
				if (startIdx >= rows.length || endIdx >= rows.length) {
					results.push(`✗ ${item.startId}–${item.endId}: ref out of range (max m${String(rows.length).padStart(REF_WIDTH, "0")})`);
					continue;
				}
				let s = Math.min(startIdx, endIdx);
				let e = Math.max(startIdx, endIdx);

				// 保护最近 N 条消息
				const minCompressable = rows.length - PROTECT_RECENT_N;
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
				const adj = adjustForToolPairs(rows.map((r) => r.msg), s, e);
				s = adj.start;
				e = adj.end;

				// 收集范围内的 entry id(有 entryId 的行才可压缩;compaction/branchSummary 行不可压)
				const rangeIds: string[] = [];
				let rangeTokens = 0;
				for (let i = s; i <= e; i++) {
					const id = rows[i]?.entryId ?? undefined;
					if (typeof id === "string") {
						rangeIds.push(id);
						rangeTokens += estimateMessageTokens(rows[i]?.msg);
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
					coveredTokens: Math.round(rangeTokens),
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

			// 压缩成功:重置提示频控基线,下次自然边界超限可再次提示
			if (results.some((r) => r.startsWith("✓"))) {
				state.nudge.lastNudgeUsage = 0;
				state.nudge.pending = false;
				state.nudge.reason = "";
			}

			saveState(state, pi);

			// 统计改为按块口径:活跃块覆盖原文 + 已消费块被取代的摘要锚点(避免 byMessageId 蒸馏后双计)
			const stats = compressionStats(state);
			return {
				content: [
					{
						type: "text",
						text:
							results.join("\n") +
							`\n\nTotal folded: ~${stats.totalTokens.toLocaleString()} tokens (active blocks: ` +
							(stats.activeByTier.map((n, i) => (n > 0 ? `${n}×T${i + 1}` : "")).filter(Boolean).join(", ") || "none") +
							`).`,
					},
				],
				details: { runId, blocks: state.prune.activeBlockIds.length },
			};
		},
	});

	// ---- decompress 工具:停用块;tier≥2 上翻一代(复活直接子块) ----
	pi.registerTool({
		name: "decompress",
		label: "Decompress Context",
		description:
			"Restore previously compressed conversation content by deactivating a compression block. " +
			"Tier-1 block (bN): its original messages return to context. Tier-2/3 block: its direct child blocks " +
			"are re-activated — their summaries become visible again, original messages stay folded (decompress a " +
			"child to go one generation further).",
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
				if (block.deactivatedBy === "consumed") {
					const consumer = Object.values(state.prune.blocksById).find(
						(b) => b.active && b.consumedBlockIds.includes(bid),
					);
					return {
						content: [
							{
								type: "text",
								text: `Block b${bid} is folded into ${consumer ? `active block b${consumer.blockId}` : "a higher-tier block"} — decompress that block instead.`,
							},
						],
						details: {},
					};
				}
				return { content: [{ type: "text", text: `Block b${bid} already inactive` }], details: {} };
			}
			// tier≥2:上翻一代 —— 复活直接子块(其摘要锚点重现),孙代原文仍折叠。
			// 不清子块的 byMessageId(子块 active 即覆盖其原文),谱系每层可再上翻。
			let restoredChildren = 0;
			for (const cid of block.consumedBlockIds) {
				const child = state.prune.blocksById[cid];
				if (child && !child.active) {
					child.active = true;
					child.deactivatedBy = undefined;
					state.prune.activeBlockIds.push(cid);
					restoredChildren++;
				}
			}
			// 停用本块:从 activeBlockIds 移除;tier-1 另需从其消息的 activeBlockIds 移除
			block.active = false;
			block.deactivatedBy = "decompress";
			state.prune.activeBlockIds = state.prune.activeBlockIds.filter((x) => x !== bid);
			for (const id of block.directMessageIds) {
				const pe = state.prune.byMessageId[id];
				if (pe) pe.activeBlockIds = pe.activeBlockIds.filter((x) => x !== bid);
			}
			saveState(state, pi);
			const text =
				block.consumedBlockIds.length > 0
					? `Decompressed b${bid} (tier ${block.tier}): ${restoredChildren} tier-${block.tier - 1} block(s) re-activated — their summaries are visible again; original messages stay folded. Decompress a child block to restore its original messages. `
					: `Decompressed b${bid}: ${block.directMessageIds.length} messages restored to context. `;
			return {
				content: [{ type: "text", text: text + `Active blocks remaining: ${state.prune.activeBlockIds.length}.` }],
				details: { deactivated: bid },
			};
		},
	});

	// ---- search_context 工具:零成本检索被折叠内容(不解压、不改状态) ----
	pi.registerTool({
		name: "search_context",
		label: "Search Context",
		description:
			"Search compressed block summaries AND original messages folded into blocks by keyword — without decompressing. " +
			"Use to cheaply locate detail before deciding to decompress. Returns ranked hits with ref, size, preview, " +
			"and the exact decompress command for full content. CJK-aware.",
		promptGuidelines: [
			"Search locates detail folded into summaries or past messages — cheaper than decompressing blind.",
			"Each hit shows a block/message ref, size, and the decompress command for full content; " +
				"message hits link to the owning block.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Keywords to locate (space-separated terms; CJK supported)" }),
			limit: Type.Optional(Type.Number({ description: "Max results (default 10, max 50)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = loadState(ctx);
			const blocks = Object.values(state.prune.blocksById).filter(Boolean) as CompressionBlock[];
			const rows = getAlignmentRows(ctx);
			const refByEntryId = buildRefMap(rows);
			// 消息归属:优先 active 块(其摘要是当前代表),否则最早的块覆盖
			const ownerByMsg = new Map<string, number>();
			for (const b of blocks) {
				if (!b.active) continue;
				for (const id of b.effectiveMessageIds) ownerByMsg.set(id, b.blockId);
			}
			for (const b of blocks) {
				if (b.active) continue;
				for (const id of b.effectiveMessageIds) if (!ownerByMsg.has(id)) ownerByMsg.set(id, b.blockId);
			}
			const docs: SearchDoc[] = blocks.map((b) => ({
				kind: "block",
				ref: `b${b.blockId}`,
				text: `${b.topic ?? ""}\n${b.summary}`,
				title: b.topic ?? `b${b.blockId}`,
				tier: b.tier,
				tokens: b.coveredTokens ?? 0,
				blockId: b.blockId,
				active: b.active,
			}));
			let msgCount = 0;
			for (const row of rows) {
				const id = row.entryId;
				if (!id || !ownerByMsg.has(id)) continue;
				const text = messageText(row.msg);
				if (!text || text.trim().length < 2) continue;
				const owner = ownerByMsg.get(id)!;
				const role: "user" | "assistant" | "tool" =
					row.msg?.role === "toolResult" ? "tool" : row.msg?.role === "user" ? "user" : "assistant";
				docs.push({
					kind: "message",
					ref: refByEntryId.get(id) ?? id,
					text,
					title: `${role}: ${text.trim().slice(0, 60)}`,
					role,
					tier: state.prune.blocksById[owner]?.tier,
					tokens: estimateMessageTokens(row.msg),
					blockId: owner,
				});
				msgCount++;
			}
			const limit =
				typeof params.limit === "number" && params.limit > 0 ? Math.min(Math.round(params.limit), 50) : 10;
			const hits = searchDocs(docs, params.query, limit);
			if (hits.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No matches for "${params.query}" across ${blocks.length} block(s) and ${msgCount} folded message(s).`,
						},
					],
					details: {},
				};
			}
			const lines = [
				`Found ${hits.length} match(es) for "${params.query}" (searched ${blocks.length} blocks + ${msgCount} folded messages):`,
			];
			for (const h of hits) {
				const d = h.doc;
				const meta = [
					d.kind === "block" ? `block ${d.ref}${d.active === false ? " [inactive]" : ""}` : `message ${d.ref}`,
					d.role ? `(${d.role})` : "",
					d.tier ? `T${d.tier}` : "",
					`score:${h.score.toFixed(2)}`,
					formatTok(d.tokens),
				]
					.filter(Boolean)
					.join(" ");
				lines.push("", `${meta}  "${d.title.slice(0, 50)}"`, `  ${makePreview(d.text, params.query)}`);
				lines.push(
					d.kind === "block"
						? `  → decompress({blockId:"${d.ref}"}) to restore this range`
						: `  → decompress({blockId:"b${d.blockId}"}) to restore the block containing ${d.ref}`,
				);
			}
			return { content: [{ type: "text", text: lines.join("\n") }], details: { hits: hits.length } };
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
