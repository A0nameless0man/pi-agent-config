/**
 * tps-stats — per-response TTFT / TPS latency stats.
 *
 * No existing pi plugin provides this (checked: pi core, official examples,
 * npm, installed extensions). Computed from the extension event stream:
 *
 *   TTFT          = before_provider_request → first message_update (first streamed chunk)
 *   duration      = before_provider_request → message_end
 *   decode TPS    = usage.output / (end - firstChunk)   steady-state generation speed
 *
 * NOTE: do NOT anchor TTFT on message_start(assistant) — it fires only when the
 * first stream chunk arrives (measured: constant 1-2ms before message_update),
 * so it excludes the actual time-to-first-token. before_provider_request fires
 * before the HTTP call, giving the true end-to-end TTFT (incl. queueing).
 *
 * UI: status bar shows the last response; /tps dumps session aggregates.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface TurnStats {
	ttftMs: number;
	totalMs: number;
	outputTokens: number;
	reasoningTokens?: number;
}

export default function (pi: ExtensionAPI) {
	// LLM calls are serial within a session, so single variables suffice.
	// Retries re-fire before_provider_request, which naturally re-anchors t0
	// to the latest attempt.
	let requestSentAt = 0;
	let firstChunkAt = 0;
	const history: TurnStats[] = [];

	pi.on("before_provider_request", async () => {
		requestSentAt = Date.now();
		firstChunkAt = 0;
	});

	pi.on("message_update", async (event) => {
		// hottest handler in pi (fires per stream chunk) — bail out fast
		if (!requestSentAt || firstChunkAt) return;
		if (event.message.role !== "assistant") return;
		firstChunkAt = Date.now();
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const endedAt = Date.now();
		if (!requestSentAt) return;

		const usage = event.message.usage;
		const out = usage?.output ?? 0;
		const ttft = firstChunkAt ? firstChunkAt - requestSentAt : 0;
		const total = endedAt - requestSentAt;

		if (out > 0 && total > 0) {
			history.push({
				ttftMs: ttft,
				totalMs: total,
				outputTokens: out,
				reasoningTokens: usage?.reasoning,
			});

			const decodeMs = firstChunkAt ? endedAt - firstChunkAt : total;
			const tps = out / (decodeMs / 1000);
			ctx.ui.setStatus("tps", `⚡${tps.toFixed(1)} tok/s · TTFT ${(ttft / 1000).toFixed(2)}s`);
		}
		requestSentAt = 0;
	});

	pi.registerCommand("tps", {
		description: "Show TTFT/TPS stats for this session",
		handler: async (_args, ctx) => {
			if (history.length === 0) {
				ctx.ui.notify("No assistant responses measured yet.", "info");
				return;
			}
			const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
			const pct = (xs: number[], p: number) => {
				const s = [...xs].sort((a, b) => a - b);
				return s[Math.min(s.length - 1, Math.floor(p * s.length))];
			};

			const ttfts = history.map((h) => h.ttftMs).filter((x) => x > 0);
			const tpsAll = history.map((h) => h.outputTokens / (Math.max(1, h.totalMs - h.ttftMs) / 1000));
			const totalOut = history.reduce((a, h) => a + h.outputTokens, 0);
			const totalReasoning = history.reduce((a, h) => a + (h.reasoningTokens ?? 0), 0);

			const lines = [
				`responses: ${history.length} · output: ${totalOut} tok` +
					(totalReasoning ? ` (incl. ${totalReasoning} reasoning)` : ""),
			];
			if (ttfts.length > 0) {
				lines.push(
					`TTFT  avg ${(avg(ttfts) / 1000).toFixed(2)}s · p50 ${(pct(ttfts, 0.5) / 1000).toFixed(2)}s · p95 ${(pct(ttfts, 0.95) / 1000).toFixed(2)}s`,
				);
			}
			lines.push(
				`TPS   avg ${avg(tpsAll).toFixed(1)} · p50 ${pct(tpsAll, 0.5).toFixed(1)} · min ${Math.min(...tpsAll).toFixed(1)} · max ${Math.max(...tpsAll).toFixed(1)}`,
			);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
