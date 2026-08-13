/**
 * context-usage — per-turn factual context accounting for the MODEL (not the TUI).
 *
 * Replaces the old opencode "ACP" plugin. Lessons learned from ACP, honored here:
 * - NEVER growth-based nudging. The old plugin fired nudges at very low usage and
 *   was generally buggy. This extension never urges the model to compact; it only
 *   states the current usage once per turn, factually.
 * - NEVER trust stale provider-reported token counts alone. Usage is computed from
 *   the ACTUAL outgoing entries via `estimateTokens` over real content, and
 *   provider-reported usage is accepted only when it postdates the latest
 *   compaction (same staleness rule pi itself uses internally).
 * - Model-only channel: injected via `before_agent_start` message with
 *   `display: false`, so the line is part of the model's context but never shown
 *   in the TUI. No setStatus/setWidget — the user explicitly does not want
 *   user-visible output.
 *
 * "Basic compress capability": the `compact_context` tool triggers pi's full
 * compaction (ctx.compact). pi has NO block/range compaction mechanism, so no
 * range selection is offered — that limitation is deliberate.
 */

import {
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
	calculateContextTokens,
	estimateTokens,
	getLatestCompactionEntry,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Fallback context window when the active model cannot be resolved from ctx.
// deepseek-v4-pro (1,048,576) is the largest window in use and therefore the
// conservative default; the exact window is resolved per turn when possible.
const DEFAULT_CONTEXT_WINDOW = 1_048_576;

// Known 1M-window models, used when ctx.model / ctx.getContextUsage() are both
// unavailable (e.g. very early in session startup).
const KNOWN_WINDOWS: Record<string, number> = {
	"deepseek-v4-pro": 1_048_576,
	"glm-5.2": 1_000_000,
};

// Stable prefix of every injected line, used to deduplicate older lines.
const USAGE_PREFIX = "Context usage:";

// Idempotency guard: pi re-fires before_agent_start with the same prompt on
// compaction retries and follow-ups. Within this window the same prompt gets
// at most one injection, so the session file does not accumulate duplicates.
const INJECTION_THROTTLE_MS = 60_000;

// Module-level guard state (survives turns; reset by session_compact).
let lastPrompt = "";
let lastInjectedAt = 0;

// ---------------------------------------------------------------------------
// Context window resolution
// ---------------------------------------------------------------------------

function resolveContextWindow(ctx: ExtensionContext): number {
	// 1) Active model metadata (authoritative).
	const modelWindow = ctx.model?.contextWindow;
	if (typeof modelWindow === "number" && modelWindow > 0) return modelWindow;

	// 2) pi's own usage object carries contextWindow even when tokens are unknown.
	const usage = ctx.getContextUsage();
	if (usage && usage.contextWindow > 0) return usage.contextWindow;

	// 3) Known-model table.
	const modelId = ctx.model?.id;
	if (modelId && KNOWN_WINDOWS[modelId]) return KNOWN_WINDOWS[modelId];

	// 4) Conservative default.
	return DEFAULT_CONTEXT_WINDOW;
}

// ---------------------------------------------------------------------------
// True context usage computation
// ---------------------------------------------------------------------------

/** Loose view of an assistant message for the usage/staleness checks. */
type AssistantUsageView = {
	stopReason?: string;
	usage?: Parameters<typeof calculateContextTokens>[0];
};

/**
 * Compute context tokens from the entries that actually go to the provider.
 *
 * Algorithm (mirrors pi's own getContextUsage in core/agent-session, but over
 * `buildContextEntries` output so it counts exactly what will be sent):
 * - Build the compaction-aware entry list (latest compaction summary + kept
 *   entries; older summarized entries are omitted).
 * - Anchor on the last assistant usage that postdates the latest compaction
 *   (pre-compaction usage is stale — the ACP bug we are avoiding). Add an
 *   estimate for every message after the anchor.
 * - If no such anchor exists (fresh session or right after compaction),
 *   estimate everything with the chars/4 heuristic, including the system
 *   prompt (which provider usage would otherwise have covered).
 *
 * Returns undefined only when the entry list is empty AND the system prompt
 * is empty (nothing in context at all).
 */
function computeContextTokens(
	ctx: ExtensionContext,
	systemPrompt: string,
): { tokens: number; source: string } | undefined {
	const entries: SessionEntry[] = ctx.sessionManager.buildContextEntries();
	const messages = entries.flatMap((e) => sessionEntryToContextMessages(e));

	const latestCompaction = getLatestCompactionEntry(entries);
	const compIndex = latestCompaction ? entries.lastIndexOf(latestCompaction) : -1;

	// Scan backwards for the newest trustworthy assistant usage.
	let anchorIndex = -1; // index into `messages`
	let usageTokens = 0;
	let messageCursor = messages.length;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (compIndex !== -1 && i <= compIndex) break; // stale: usage predates compaction
		const entry = entries[i];
		messageCursor -= sessionEntryToContextMessages(entry).length;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const msg = entry.message as AssistantUsageView;
		if (msg.stopReason === "aborted" || msg.stopReason === "error") continue;
		if (!msg.usage) continue;
		const t = calculateContextTokens(msg.usage);
		if (t <= 0) continue;
		usageTokens = t;
		anchorIndex = messageCursor;
		break;
	}

	if (anchorIndex >= 0) {
		let trailing = 0;
		for (let j = anchorIndex + 1; j < messages.length; j++) trailing += estimateTokens(messages[j]);
		return {
			tokens: usageTokens + trailing,
			source: "provider usage + trailing estimate",
		};
	}

	// No trustworthy anchor: pure estimate over everything that goes out.
	let estimated = Math.ceil(systemPrompt.length / 4);
	for (const message of messages) estimated += estimateTokens(message);
	if (estimated === 0) return undefined;
	return { tokens: estimated, source: "chars/4 estimate (incl. system prompt)" };
}

// ---------------------------------------------------------------------------
// Injected-line helpers
// ---------------------------------------------------------------------------

/** Does this message carry one of our injected usage lines? */
function isUsageLine(msg: { role?: string; customType?: string; content?: unknown }): boolean {
	if (msg.role !== "user") return false;
	if (msg.customType === "context-usage") return true;
	const content = msg.content;
	if (typeof content === "string") return content.startsWith(USAGE_PREFIX);
	if (Array.isArray(content)) {
		return content.some(
			(block) =>
				block &&
				typeof block === "object" &&
				(block as { type?: string }).type === "text" &&
				((block as { text?: string }).text ?? "").startsWith(USAGE_PREFIX),
		);
	}
	return false;
}

/** Build the single factual line injected for this turn. */
function buildUsageLine(tokens: number, source: string, window: number): string {
	const pct = (tokens / window) * 100;
	let line =
		`${USAGE_PREFIX} ${tokens.toLocaleString()} tokens (${pct.toFixed(1)}%) ` +
		`of ${window.toLocaleString()}-token window (source: ${source}).`;
	// Informational only: name the capability, never urge its use.
	if (pct > 50) {
		line += " Full compaction available via /compact.";
	}
	return line;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function contextUsageExtension(pi: ExtensionAPI): void {
	// Inject ONE factual usage line per turn, model-only (display: false).
	pi.on("before_agent_start", async (event, ctx) => {
		try {
			// Idempotency guard: survive compaction retries / follow-ups that
			// re-fire this event with the same prompt.
			if (event.prompt === lastPrompt && Date.now() - lastInjectedAt < INJECTION_THROTTLE_MS) {
				return;
			}

			const window = resolveContextWindow(ctx);
			const computed = computeContextTokens(ctx, event.systemPrompt);

			let content: string;
			if (computed) {
				content = buildUsageLine(computed.tokens, computed.source, window);
			} else {
				content =
					`${USAGE_PREFIX} unavailable (no context entries yet). ` +
					`Context window: ${window.toLocaleString()} tokens.`;
			}

			lastPrompt = event.prompt;
			lastInjectedAt = Date.now();

			return {
				message: {
					customType: "context-usage",
					content,
					display: false, // model-only: never rendered in the TUI
				},
			};
		} catch {
			// Degrade gracefully: a broken accounting line must never block a turn.
			return;
		}
	});

	// Keep only the most recent usage line in the outgoing messages. Historical
	// lines show outdated numbers, which would mislead the model — exactly the
	// staleness problem the old ACP plugin had.
	pi.on("context", async (event) => {
		try {
			let lastIndex = -1;
			event.messages.forEach((m, i) => {
				if (isUsageLine(m as { role?: string; customType?: string; content?: unknown })) lastIndex = i;
			});
			if (lastIndex === -1) return;

			const filtered = event.messages.filter((m, i) => {
				if (!isUsageLine(m as { role?: string; customType?: string; content?: unknown })) return true;
				return i === lastIndex;
			});
			if (filtered.length === event.messages.length) return;
			return { messages: filtered };
		} catch {
			return;
		}
	});

	// After compaction the old injected line reflects pre-compaction numbers.
	// Reset the guard so the (same) retried prompt gets a FRESH correct line
	// instead of a stale one or a duplicate. The dedup filter above guarantees
	// only one usage line is ever visible to the model.
	pi.on("session_compact", () => {
		lastPrompt = "";
		lastInjectedAt = 0;
	});

	// Basic compress capability: full compaction, fire-and-forget.
	// pi has no block/range compaction mechanism, so no range selection here.
	pi.registerTool({
		name: "compact_context",
		label: "Compact Context",
		description:
			"Trigger pi's full context compaction: summarizes the session history up to a cut point " +
			"and replaces it with a summary. No range selection.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			try {
				ctx.compact();
				return {
					content: [
						{
							type: "text",
							text: "Compaction triggered (runs asynchronously). Context usage will be recomputed on the next turn.",
						},
					],
					details: {},
				};
			} catch {
				return {
					content: [{ type: "text", text: "Compaction could not be triggered." }],
					details: {},
				};
			}
		},
	});
}
