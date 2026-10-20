/**
 * Web search extension for pi — DeepSeek Search backend.
 *
 * Talks straight to DeepSeek's Search REST API
 * (https://api.deepseek.com/v1/tools/search). One plain fetch per tool call,
 * no session handshake, no envelope/stream parsing.
 *
 * API facts (per official docs, https://api-docs.deepseek.com/zh-cn/guides/search):
 * - Auth: `Authorization: Bearer $DEEPSEEK_API_KEY` — same key as the DeepSeek
 *   chat models in pi's auth.json (falls back to it when the env var is unset).
 * - Request body: `{ query, count, need_content? }`. `query` is hard-capped at
 *   128 Unicode chars; time/site/language filters are expressed as inline
 *   search operators inside the query (site:/-site:/-"..."/"..."/lang:/after:/before:),
 *   NOT as separate params — Bocha-style freshness/include/exclude do not exist.
 * - Response is plain JSON: `{ results: [{ rerank_score, title, url, snippet,
 *   summary, content, site_name, site_icon, date, authority }] }`. `summary`
 *   (600-800 chars, model-facing) is a superset of `snippet` (100-200 chars);
 *   `content` carries page text only when `need_content: true`.
 * - Errors use the OpenAI-compatible shape `{ error: { message, type, code } }`.
 * - Rate limit is a generous account-level 100 QPS for Search — no client-side
 *   limiter needed (the old Bocha extension needed one at 10 req/min).
 *
 * The response is parsed and rendered as markdown (titles, URLs, summaries)
 * so the model reads a compact, readable summary instead of raw JSON.
 * Provider-agnostic wording throughout (tool name, description, rendered
 * header) so a future backend swap does not re-brand the LLM-facing surface.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { keyHint, readStoredCredential, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const DEEPSEEK_API_BASE = "https://api.deepseek.com/v1/tools/search";
const REQUEST_TIMEOUT_MS = 30_000;

// DeepSeek hard limit per official docs (fail fast with an actionable message
// instead of a round trip that 400s).
const QUERY_MAX = 128;

// Params natively understood by the DeepSeek API. Anything else the model
// sends (e.g. Bocha-habit freshness/include/exclude/summary) is NOT forwarded
// — the upstream API would silently ignore it and the filtering intent would
// be lost — instead we surface it in a trailing callout so the model can
// re-express the filter via query operators.
const NATIVE_PARAMS = new Set(["query", "count", "need_content"]);

// Per-result caps — content is page-length, summary is already model-sized.
// Mirrors the agent-v2 DeepSeekWebSearchTool values so behaviour stays
// comparable across the two platforms.
const CONTENT_CAP = 1500;
const SUMMARY_CAP = 800;

// Global cap on the rendered markdown handed to the model. need_content=true
// with a high count can otherwise balloon into tens of thousands of chars.
const MAX_RESULT_CHARS = 30_000;

// ---------------------------------------------------------------------------
// Tool schema (matches DeepSeek's search API params)
// ---------------------------------------------------------------------------

const WebSearchParams = Type.Object({
	query: Type.String({
		description:
			`Search query (max ${QUERY_MAX} chars). Supports inline search operators: ` +
			`site:example.com (restrict to site; multiple sites joined with OR), ` +
			`-site:example.com (exclude site), -keyword / -"phrase" (exclude pages containing them), ` +
			`"exact phrase" (exact match), lang:zh,en (restrict languages), ` +
			`after:2025 / after:2025-01-01 (published after), before:2026 / before:2026-06-01 (published before). ` +
			`Example: "财政部 税务总局公告2026年第13号 site:gov.cn lang:zh"`,
	}),
	count: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 50, default: 10, description: "Number of results (1-50, default 10)" }),
	),
	need_content: Type.Optional(
		Type.Boolean({
			default: false,
			description:
				"Include a truncated excerpt of each page's full text in the results (results get much larger). " +
				"Use when you need to read page content rather than summaries; can save a separate web_fetch.",
		}),
	),
});

interface SearchParams {
	query: string;
	count?: number;
	need_content?: boolean;
}

/** API key resolution: explicit env var wins; fall back to pi's own
 * credential store via the official one-off reader — the Search API shares
 * the Bearer key already configured for DeepSeek chat models, so every
 * machine with a working deepseek provider needs zero extra setup. Reading
 * through readStoredCredential (not hand-rolled fs parsing) means format
 * drift (BOM, future storage changes) is handled by pi itself. */
function resolveApiKey(): string | null {
	const fromEnv = process.env.DEEPSEEK_API_KEY;
	if (fromEnv) return fromEnv;
	const cred = readStoredCredential("deepseek");
	const key = cred?.key;
	return typeof key === "string" && key ? key : null;
}

/** Extract the message from DeepSeek's OpenAI-compatible error body
 * `{ error: { message, type, code } }`. Falls back to raw text. */
function extractApiError(body: string): string | null {
	try {
		const parsed: unknown = JSON.parse(body);
		if (typeof parsed === "object" && parsed !== null) {
			const message = (parsed as Record<string, Record<string, unknown>>).error?.message;
			if (typeof message === "string" && message) return message;
		}
	} catch {
		// not JSON — caller falls back to HTTP status + raw body
	}
	return null;
}

/** Human-readable hint for status codes with distinct remediation semantics. */
function statusHint(status: number): string | null {
	if (status === 401) return "API key is missing or invalid.";
	if (status === 402) return "Account balance insufficient — top up at platform.deepseek.com.";
	if (status === 429) return "Rate limited (account-level QPS). Wait a moment and retry.";
	if (status === 408 || status >= 500) return "Transient upstream error — safe to retry.";
	return null;
}

async function executeSearch(params: SearchParams, signal: AbortSignal | undefined): Promise<AgentToolResult> {
	const apiKey = resolveApiKey();
	if (!apiKey) {
		return {
			content: [
				{
					type: "text",
					text: "Error: no DeepSeek API key found. Set the DEEPSEEK_API_KEY environment variable, or configure the 'deepseek' provider in ~/.pi/agent/auth.json, then restart pi.",
				},
			],
			isError: true,
		};
	}

	const query = params.query.trim();
	if (!query) {
		return { content: [{ type: "text", text: "Error: query is required and must not be empty." }], isError: true };
	}
	if (query.length > QUERY_MAX) {
		return {
			content: [
				{
					type: "text",
					text: `Error: query exceeds the ${QUERY_MAX}-char limit (got ${query.length}). Shorten it and retry.`,
				},
			],
			isError: true,
		};
	}

	// Whitelist-check BEFORE dropping: unknown keys survive the typebox schema
	// passthrough, so detect them here rather than trusting validation.
	const ignored = Object.keys(params)
		.filter((k) => !NATIVE_PARAMS.has(k))
		.sort();

	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, REQUEST_TIMEOUT_MS);
	const onExternalAbort = () => controller.abort();
	signal?.addEventListener("abort", onExternalAbort, { once: true });

	try {
		const body: Record<string, unknown> = { query, count: params.count ?? 10 };
		if (params.need_content) body.need_content = true;

		const res = await fetch(DEEPSEEK_API_BASE, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});

		const text = await res.text();

		if (res.status < 200 || res.status >= 300) {
			const detail = extractApiError(text) ?? text.slice(0, 500);
			const hint = statusHint(res.status);
			return {
				content: [
					{
						type: "text",
						text: `Web search failed: HTTP ${res.status}${detail ? `: ${detail}` : ""}${hint ? ` (${hint})` : ""}`,
					},
				],
				isError: true,
			};
		}

		return {
			content: [{ type: "text", text: renderSearchResults(text, ignored) }],
			isError: false,
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		let message = `Web search failed: ${reason}`;
		if (timedOut) message = `Web search request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`;
		else if (signal?.aborted) message = "Web search aborted.";
		return { content: [{ type: "text", text: message }], isError: true };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onExternalAbort);
	}
}

// ---------------------------------------------------------------------------
// Markdown rendering — turn the raw JSON response into readable markdown for
// the model. content/summary/snippet are rendered exclusively (official docs:
// summary is a model-facing superset of snippet), with quality signals
// (authority/date/site_name) in the meta line.
// ---------------------------------------------------------------------------

/** Coerce an unknown value to a string ("" for null/undefined). */
function str(v: unknown): string {
	if (typeof v === "string") return v;
	if (v == null) return "";
	return String(v);
}

/** Slice an ISO/RFC 3339 date string down to its date part (YYYY-MM-DD). */
function shortDate(iso: unknown): string {
	const s = str(iso);
	return s.length >= 10 ? s.slice(0, 10) : s;
}

/** Trailing callout for parameters that were dropped instead of forwarded. */
function ignoredParamsNote(ignored: string[]): string {
	if (ignored.length === 0) return "";
	return (
		`\n\n> 注意: 参数 ${ignored.join(", ")} 不被当前搜索引擎支持,已被忽略(过滤意图未生效)。` +
		"时间/站点/语言过滤请改用 query 内搜索语法(after:/before:/site:/-site:/lang:)。"
	);
}

function renderSearchResults(body: string, ignored: string[]): string {
	let root: unknown;
	try {
		root = JSON.parse(body);
	} catch {
		// Defensive: if the body is somehow not JSON, return it verbatim.
		return body;
	}

	const results = (root as Record<string, unknown>).results as Array<Record<string, unknown>> | undefined;
	const note = ignoredParamsNote(ignored);

	const lines: string[] = [];
	if (!Array.isArray(results) || results.length === 0) {
		lines.push("## 网页搜索 · 0 条结果", "", "_无结果_", note.trim());
		return lines.join("\n").trim();
	}

	lines.push(`## 网页搜索 · ${results.length} 条结果`);
	// Official threshold decoded once here instead of per-result noise:
	// authority 0-4 (-1 unknown), >=3 is highly authoritative; rerank_score is
	// the engine's internal ordering signal and is already implied by numbering.
	lines.push("");
	lines.push("(评分说明: auth 0~4,-1 未知,≥3 为极权威站点)");
	lines.push("");

	results.forEach((item, i) => {
		const title = str(item.title);
		const url = str(item.url);
		const siteName = item.site_name == null ? "" : str(item.site_name);
		const date = shortDate(item.date);
		const authority = item.authority;

		lines.push(`### ${i + 1}. ${title || "(无标题)"}`);
		if (url) lines.push(`- URL: ${url}`);
		const meta = [siteName, date, authority !== undefined && authority !== null ? `auth=${authority}` : ""]
			.filter(Boolean)
			.join(" · ");
		if (meta) lines.push(`- 来源: ${meta}`);

		// Exclusive body rendering: content (page text) > summary (long,
		// model-facing) > snippet (short). Docs: summary is a superset of
		// snippet, so falling back to snippet only when summary is missing
		// avoids duplication.
		const content = str(item.content).trim();
		const summary = str(item.summary).trim();
		const snippet = str(item.snippet).trim();
		let bodyLine = "";
		if (content) {
			bodyLine = "正文节选: " + content.slice(0, CONTENT_CAP) + (content.length > CONTENT_CAP ? "…[正文截断]" : "");
		} else if (summary) {
			bodyLine = summary.slice(0, SUMMARY_CAP) + (summary.length > SUMMARY_CAP ? "…" : "");
		} else if (snippet) {
			bodyLine = snippet;
		}
		if (bodyLine) {
			lines.push("");
			lines.push(bodyLine);
		}
		lines.push("");
	});

	lines.push(note.trim());
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

class SearchResultRenderComponent extends Container {
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
	component: SearchResultRenderComponent,
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
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web and get structured results: page titles, urls, model-facing summaries, " +
			"relevance/authority scores, publication dates, and site names. " +
			`Query is capped at ${QUERY_MAX} chars; time-range, site restrict/exclude, and language ` +
			"filters are expressed via inline query operators (see the query parameter description), " +
			"not as separate parameters.",
		parameters: WebSearchParams,
		async execute(_toolCallId, params, signal) {
			const result = await executeSearch(params as SearchParams, signal);
			// Global cap: need_content=true with a high count can balloon the
			// rendered markdown; trim with a dropped-size callout and actionable
			// advice instead of a bare "[...truncated]".
			const part = result.content[0];
			if (part.type === "text" && part.text.length > MAX_RESULT_CHARS) {
				const dropped = part.text.length - MAX_RESULT_CHARS;
				part.text =
					part.text.slice(0, MAX_RESULT_CHARS) +
					`\n\n[内容超长已截断,丢弃约 ${dropped} 字符,结尾若干结果未展示;` +
					"如需完整结果请减小 count 或不传 need_content 后重新搜索]";
			}
			return result;
		},
		renderCall(args, theme, context) {
			const state = ((context.state ??= {}) as RenderState);
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const head = theme.fg("toolTitle", theme.bold("⌕ web"));
			const query = typeof args?.query === "string" ? args.query : "";
			const queryDisplay = query ? ` ${theme.fg("toolOutput", `"${query}"`)}` : "";
			const meta = [
				args?.count ? `${args.count} results` : undefined,
				args?.need_content ? "content" : undefined,
			]
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
				(context.lastComponent as SearchResultRenderComponent | undefined) ?? new SearchResultRenderComponent();
			rebuildResultComponent(component, result, options, theme, state);
			component.invalidate();
			return component;
		},
	});
}
