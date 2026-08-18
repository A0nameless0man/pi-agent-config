/**
 * Bocha direct HTTP client for pi.
 *
 * Talks straight to Bocha's Web Search REST API
 * (https://api.bochaai.com/v1/web-search) instead of bridging through a remote
 * RPC endpoint. One plain fetch per tool call, no session handshake, no
 * envelope/stream parsing.
 *
 * Transport facts (verified by live call on 2026-08-13):
 * - Web Search:  POST https://api.bochaai.com/v1/web-search
 * - Auth: `Authorization: Bearer $BOCHA_API_KEY`, `Content-Type: application/json`.
 * - Request body: `{ query, freshness, count, summary: true }` (`summary: true`
 *   keeps the long per-result summary text).
 * - Response is plain JSON: `{ code, data.webPages.value[] }`. `freshness`
 *   accepts the five enums (noLimit/oneDay/oneWeek/oneMonth/oneYear) AND
 *   absolute date ranges (e.g. "2025-01-01" or "2025-01-01..2025-06-30").
 *
 * The successful response is parsed and rendered as markdown (titles, URLs,
 * summaries) so the model reads a compact, readable summary instead of
 * lossless raw JSON.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { keyHint, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const BOCHA_API_BASE = "https://api.bochaai.com/v1";
const REQUEST_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Tool schema (matches Bocha's web-search API params)
// ---------------------------------------------------------------------------

const FRESHNESS_OPTIONS = ["noLimit", "oneYear", "oneMonth", "oneWeek", "oneDay"] as const;

const WebSearchParams = Type.Object({
	query: Type.String({ description: "Search query" }),
	freshness: Type.Optional(
		Type.Union([
			StringEnum(FRESHNESS_OPTIONS, {
				description: "The time range for the search results.",
			}),
			Type.String({
				pattern: "^\\d{4}-\\d{2}-\\d{2}(\\.\\.\\d{4}-\\d{2}-\\d{2})?$",
				description: "Absolute date or date range, e.g. 2025-01-01 or 2025-01-01..2025-06-30",
			}),
		]),
	),
	count: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 50, default: 10, description: "Number of results (1-50, default 10)" }),
	),
});

interface SearchParams {
	query: string;
	freshness?: string;
	count?: number;
}

/**
 * Extract a human-readable message from a non-2xx (or business-error) JSON
 * body: Bocha returns `{ code, msg }` on failures. Falls back to raw text.
 */
function extractApiError(body: string): string | null {
	try {
		const parsed: unknown = JSON.parse(body);
		if (typeof parsed === "object" && parsed !== null) {
			const record = parsed as Record<string, unknown>;
			if (typeof record.msg === "string" && record.msg) {
				return `${record.code ?? "?"}: ${record.msg}`;
			}
		}
	} catch {
		// not JSON — caller falls back to HTTP status + raw body
	}
	return null;
}

/** Like extractApiError but only for business-level `code !== 200` on a 2xx HTTP response. */
function extractApiErrorForBody(body: string): string | null {
	try {
		const parsed: unknown = JSON.parse(body);
		if (typeof parsed === "object" && parsed !== null) {
			const record = parsed as Record<string, unknown>;
			if (typeof record.code === "number" && record.code !== 200) {
				return typeof record.msg === "string" && record.msg ? `${record.code}: ${record.msg}` : `code ${record.code}`;
			}
		}
	} catch {
		// not JSON — treat as success (raw text returned verbatim)
	}
	return null;
}

async function executeSearch(params: SearchParams, signal: AbortSignal | undefined): Promise<AgentToolResult> {
	if (!process.env.BOCHA_API_KEY) {
		return {
			content: [
				{
					type: "text",
					text: "Error: BOCHA_API_KEY environment variable is not set. Please set it (e.g. `setx BOCHA_API_KEY <your-key>`) and restart pi.",
				},
			],
			isError: true,
		};
	}

	const query = params.query.trim();
	if (!query) {
		return { content: [{ type: "text", text: "Error: query is required and must not be empty." }], isError: true };
	}

	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, REQUEST_TIMEOUT_MS);
	const onExternalAbort = () => controller.abort();
	signal?.addEventListener("abort", onExternalAbort, { once: true });

	try {
		const body: Record<string, unknown> = {
			query,
			freshness: params.freshness ?? "noLimit",
			count: params.count ?? 10,
			// Keep the long per-result summary text.
			summary: true,
		};

		const res = await fetch(`${BOCHA_API_BASE}/web-search`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${process.env.BOCHA_API_KEY}`,
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});

		const text = await res.text();

		if (res.status < 200 || res.status >= 300) {
			const detail = extractApiError(text) ?? text.slice(0, 500);
			return {
				content: [
					{ type: "text", text: `Bocha web search failed: HTTP ${res.status}${detail ? `: ${detail}` : ""}` },
				],
				isError: true,
			};
		}

		// Bocha can return HTTP 200 with a business-level `code` field; surface
		// non-200 business codes as errors, otherwise render markdown.
		const businessError = extractApiErrorForBody(text);
		if (businessError) {
			return { content: [{ type: "text", text: `Bocha web search failed: ${businessError}` }], isError: true };
		}

		return { content: [{ type: "text", text: renderWebSearch(text) }], isError: false };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		let message = `Bocha web search failed: ${reason}`;
		if (timedOut) message = `Bocha web search request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`;
		else if (signal?.aborted) message = "Bocha web search aborted.";
		return { content: [{ type: "text", text: message }], isError: true };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onExternalAbort);
	}
}

// ---------------------------------------------------------------------------
// Markdown rendering — turn the raw JSON response into readable markdown for
// the model. Titles, URLs, and summaries become markdown links/lists, which
// are more token-efficient and easier to reason over than nested JSON.
// ---------------------------------------------------------------------------

/** Coerce an unknown value to a string ("" for null/undefined). */
function str(v: unknown): string {
	if (typeof v === "string") return v;
	if (v == null) return "";
	return String(v);
}

/** Slice an ISO date string down to its date part (YYYY-MM-DD). */
function shortDate(iso: unknown): string {
	const s = str(iso);
	return s.length >= 10 ? s.slice(0, 10) : s;
}

function renderWebSearch(body: string): string {
	let root: unknown;
	try {
		root = JSON.parse(body);
	} catch {
		// Defensive: if the body is somehow not JSON, return it verbatim.
		return body;
	}

	const data = (root as Record<string, unknown>).data as Record<string, unknown> | undefined;
	const webPages = data?.webPages as Record<string, unknown> | undefined;
	const value = (webPages?.value as Array<Record<string, unknown>> | undefined) ?? [];
	const total = webPages?.totalEstimatedMatches;

	const lines: string[] = [];
	lines.push(`## Bocha 网页搜索${typeof total === "number" ? ` · 约 ${total} 条结果` : ""}`);
	lines.push("");

	if (value.length === 0) {
		lines.push("_无结果_");
		return lines.join("\n").trim();
	}

	value.forEach((item, i) => {
		const name = str(item.name);
		const url = str(item.url);
		const siteName = str(item.siteName);
		const date = shortDate(item.datePublished);
		const summary = (str(item.summary) || str(item.snippet)).trim();

		lines.push(`### ${i + 1}. ${name || "(无标题)"}`);
		if (url) lines.push(`- URL: ${url}`);
		const meta = [siteName, date].filter(Boolean).join(" · ");
		if (meta) lines.push(`- 来源: ${meta}`);
		if (summary) {
			lines.push("");
			lines.push(summary);
		}
		lines.push("");
	});

	return lines.join("\n").trim();
}

// ---------------------------------------------------------------------------
// TUI rendering — bash-style collapsed result. Mirrors the built-in bash tool:
// collapsed view shows the tail N visual lines plus a "... (N earlier lines,
// ctrl+o to expand)" hint, expanded view (ctrl+o on the tool row) shows the
// full output, and a "Took X.Xs" footer records request duration. The LLM
// always receives the full markdown; this only changes what humans see.
// ---------------------------------------------------------------------------

const PREVIEW_LINES = 5;
const ELAPSED_UPDATE_MS = 1000;

/** Row-local state shared between renderCall and renderResult (context.state). */
interface RenderState {
	startedAt?: number;
	endedAt?: number;
	interval?: ReturnType<typeof setInterval>;
}

/** Width-keyed preview cache, cleared on invalidate (resize/theme change). */
interface PreviewCache {
	cachedWidth?: number;
	cachedLines?: string[];
	cachedSkipped?: number;
}

class BochaResultRenderComponent extends Container {
	public readonly cache: PreviewCache = {};
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

/** Pull the plain-text body out of an AgentToolResult (all text parts joined). */
function resultText(result: AgentToolResult): string {
	return result.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.filter(Boolean)
		.join("\n")
		.trim();
}

function rebuildResultComponent(
	component: BochaResultRenderComponent,
	result: AgentToolResult,
	options: ToolRenderResultOptions,
	theme: Theme,
	state: RenderState,
): void {
	const cache = component.cache;
	component.clear();

	const output = resultText(result);
	if (output) {
		const color = result.isError ? "error" : "toolOutput";
		const styled = output
			.split("\n")
			.map((line) => theme.fg(color, line))
			.join("\n");
		if (options.expanded) {
			component.addChild(new Text(`\n${styled}`, 0, 0));
		} else {
			// Anonymous component so the width-dependent preview is recomputed
			// lazily per render and invalidated on resize, exactly like bash.
			component.addChild({
				render: (width: number): string[] => {
					if (cache.cachedLines === undefined || cache.cachedWidth !== width) {
						const preview = truncateToVisualLines(styled, PREVIEW_LINES, width);
						cache.cachedLines = preview.visualLines;
						cache.cachedSkipped = preview.skippedCount;
						cache.cachedWidth = width;
					}
					if (cache.cachedSkipped && cache.cachedSkipped > 0) {
						const hint =
							theme.fg("muted", `... (${cache.cachedSkipped} earlier lines,)`) +
							` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
						return ["", hint, ...(cache.cachedLines ?? [])];
					}
					return ["", ...(cache.cachedLines ?? [])];
				},
				invalidate: () => {
					cache.cachedWidth = undefined;
					cache.cachedLines = undefined;
					cache.cachedSkipped = undefined;
				},
			});
		}
	}

	if (state.startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		const endTime = state.endedAt ?? Date.now();
		component.addChild(
			new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - state.startedAt)}`)}`, 0, 0),
		);
	}
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "bocha_web_search",
		label: "Bocha Web Search",
		description:
			"Search with Bocha Web Search and get enhanced search details from billions of web documents, including page titles, urls, summaries, site names, site icons, publication dates, image links, and more.",
		parameters: WebSearchParams,
		async execute(_toolCallId, params, signal) {
			return executeSearch(params, signal);
		},
		renderCall(args, theme, context) {
			const state = ((context.state ??= {}) as RenderState);
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const head = theme.fg("toolTitle", theme.bold("⌕ bocha"));
			const query = typeof args?.query === "string" ? args.query : "";
			const queryDisplay = query ? ` ${theme.fg("toolOutput", `"${query}"`)}` : "";
			const meta = [args?.freshness, args?.count ? `${args.count} results` : undefined]
				.filter(Boolean)
				.join(" · ");
			const metaDisplay = meta ? ` ${theme.fg("muted", `(${meta})`)}` : "";
			text.setText(head + queryDisplay + metaDisplay);
			return text;
		},
		renderResult(result, options, theme, context) {
			const state = ((context.state ??= {}) as RenderState);
			// While a partial result streams, refresh once per second so the
			// "Elapsed" footer ticks like bash does.
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), ELAPSED_UPDATE_MS);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const component =
				(context.lastComponent as BochaResultRenderComponent | undefined) ?? new BochaResultRenderComponent();
			rebuildResultComponent(component, result, options, theme, state);
			component.invalidate();
			return component;
		},
	});
}
