/**
 * footer-split — 按分组把扩展状态栏拆成多行。
 *
 * 背景:pi 默认 footer 把所有 ctx.ui.setStatus() 条目按 key 字母序拼成
 * 同一行(footer.js: sortedStatuses.join(" ")),且 sanitizeStatusText 强制
 * 单行——setStatus 无法换行。glm-quota / tps 与 pi-glla 混行且样式互扰。
 *
 * 方案:ctx.ui.setFooter() 接管整个 footer,忠实复现默认 footer 的 pwd 行与
 * token 统计行(逻辑对照 dist/modes/interactive/components/footer.js 移植),
 * 再按本目录 groups.json 分组渲染状态行:
 *   - groups: 二维名单,每个数组 = 共享一行的插件 key 集合,顺序即行序
 *   - 不在任何组里的 key:各自单独一行(按字母序)
 *   - autoWrap: true 时超宽按条目换行(条目为原子单元,不拆内部 ANSI 色码);
 *     false 时整行截断加省略号
 * 改 groups.json 后 /reload 生效。
 *
 * 已知取舍(相对默认 footer 的微小差异,均为内部 API 无法触达):
 * - 无 "(auto)" 自动压缩指示(内部 autoCompactEnabled 状态)
 * - "(sub)" 订阅标记仅覆盖 kimi-coding(OAuth+isSubscription 判定是内部
 *   modelRuntime API;GLM coding plan 走 API key,本就不显示)
 * - 无实验特性 "xp" 标记
 *
 * 逃生口:/footer-split 可切换回默认 footer。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_PATH = fileURLToPath(new URL("./groups.json", import.meta.url));

function loadConfig(): { groups: string[][]; autoWrap: boolean } {
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		return {
			groups: Array.isArray(raw.groups) ? raw.groups.filter(Array.isArray) : [],
			autoWrap: raw.autoWrap !== false,
		};
	} catch {
		// 无/坏配置:退化为所有状态各自一行
		return { groups: [], autoWrap: true };
	}
}

export default function (pi: ExtensionAPI) {
	// 默认启用;/footer-split 可随时切回默认 footer。配置每次加载(含 /reload)时重读
	const { groups, autoWrap } = loadConfig();
	let enabled = true;

	// ---- 以下为 pi 默认 footer 逻辑的忠实移植 ----

	/** 单行状态净化(对照 footer.js sanitizeStatusText) */
	function sanitize(text: string): string {
		return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
	}

	/** 紧凑 token 格式(对照 footer.js formatTokens) */
	function fmtTokens(n: number): string {
		if (n < 1000) return `${n}`;
		if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
		if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
		if (n < 10_000_000) return `${(n / 1e6).toFixed(1)}M`;
		return `${Math.round(n / 1e6)}M`;
	}

	/** home 缩写为 ~(对照 footer.js formatCwdForFooter) */
	function fmtCwd(cwd: string, home: string | undefined): string {
		if (!home) return cwd;
		const rc = resolve(cwd);
		const rh = resolve(home);
		const rel = relative(rh, rc);
		const inside =
			rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
		if (!inside) return cwd;
		return rel === "" ? "~" : `~${sep}${rel}`;
	}

	function install(ctx: import("@earendil-works/pi-coding-agent").ExtensionContext) {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					// --- 会话累计 usage(含 toolResult 嵌套与 compaction/branch_summary) ---
					let inT = 0,
						outT = 0,
						cr = 0,
						cw = 0,
						cost = 0,
						lastHit: number | undefined;
					for (const e of ctx.sessionManager.getEntries()) {
						const entry = e as Record<string, unknown>;
						let usage: Record<string, any> | undefined;
						if (entry.type === "message") {
							const msg = entry.message as Record<string, any>;
							if (msg.role === "assistant") usage = msg.usage;
							else if (msg.role === "toolResult") usage = msg.usage;
						} else if (entry.type === "branch_summary" || entry.type === "compaction") {
							usage = entry.usage as Record<string, any> | undefined;
						}
						if (!usage?.input && !usage?.output) continue;
						inT += usage.input ?? 0;
						outT += usage.output ?? 0;
						cr += usage.cacheRead ?? 0;
						cw += usage.cacheWrite ?? 0;
						cost += usage.cost?.total ?? 0;
						if (entry.type === "message" && (entry.message as any).role === "assistant") {
							const p = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
							if (p > 0) lastHit = ((usage.cacheRead ?? 0) / p) * 100;
						}
					}

					// --- 第 1 行:pwd + 分支 + 会话名 ---
					let pwd = fmtCwd(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;
					const name = ctx.sessionManager.getSessionName();
					if (name) pwd = `${pwd} • ${name}`;
					const lines = [truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."))];

					// --- 第 2 行:token 统计(左) + 模型/思考档(右) ---
					const parts: string[] = [];
					if (inT) parts.push(`↑${fmtTokens(inT)}`);
					if (outT) parts.push(`↓${fmtTokens(outT)}`);
					if (cr) parts.push(`R${fmtTokens(cr)}`);
					if (cw) parts.push(`W${fmtTokens(cw)}`);
					if ((cr > 0 || cw > 0) && lastHit !== undefined)
						parts.push(`CH${lastHit.toFixed(1)}%`);
					const usingSub = ctx.model?.provider === "kimi-coding";
					if (cost || usingSub)
						parts.push(`$${cost.toFixed(3)}${usingSub ? " (sub)" : ""}`);

					const cu = ctx.getContextUsage();
					const ctxWin = cu?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const pct = cu?.percent ?? null;
					const pctDisp =
						pct === null ? `?/${fmtTokens(ctxWin)}` : `${pct.toFixed(1)}%/${fmtTokens(ctxWin)}`;
					if (pct !== null && pct > 90) parts.push(theme.fg("error", pctDisp));
					else if (pct !== null && pct > 70) parts.push(theme.fg("warning", pctDisp));
					else parts.push(pctDisp);

					let statsLeft = parts.join(" ");
					const model = ctx.model;
					const modelName = model?.id || "no-model";
					let rightNoProv = modelName;
					if (model?.reasoning) {
						const lvl = ctx.thinkingLevel || "off";
						rightNoProv = lvl === "off" ? `${modelName} • thinking off` : `${modelName} • ${lvl}`;
					}
					let right = rightNoProv;
					if (footerData.getAvailableProviderCount() > 1 && model) {
						const cand = `(${model.provider}) ${rightNoProv}`;
						if (visibleWidth(statsLeft) + 2 + visibleWidth(cand) <= width) right = cand;
					}
					// 对照默认 footer:statsLeft 含色彩码,需分别 dim 再拼接
					let lw = visibleWidth(statsLeft);
					if (lw > width) {
						statsLeft = truncateToWidth(statsLeft, width, "...");
						lw = visibleWidth(statsLeft);
					}
					const rw = visibleWidth(right);
					let statsLine: string;
					if (lw + 2 + rw <= width) {
						statsLine = theme.fg("dim", statsLeft) + " ".repeat(width - lw - rw) + theme.fg("dim", right);
					} else {
						const avail = width - lw - 2;
						statsLine =
							avail > 0
								? theme.fg("dim", statsLeft) +
									" ".repeat(Math.max(0, width - lw - visibleWidth(truncateToWidth(right, avail, "")))) +
									theme.fg("dim", truncateToWidth(right, avail, ""))
								: theme.fg("dim", statsLeft);
					}
					lines.push(statsLine);

					// --- 状态行:按 groups 分组;组内共行,未分组各自一行 ---
					const sorted = [...footerData.getExtensionStatuses().entries()].sort(([a], [b]) =>
						a.localeCompare(b),
					);
					const claimed = new Set<string>();
					const rows: string[][] = [];
					for (const group of groups) {
						const row: string[] = [];
						for (const [key, text] of sorted) {
							if (!claimed.has(key) && group.includes(key)) {
								claimed.add(key);
								row.push(sanitize(text));
							}
						}
						if (row.length) rows.push(row);
					}
					for (const [key, text] of sorted) {
						if (!claimed.has(key)) rows.push([sanitize(text)]);
					}
					for (const row of rows) {
						if (!autoWrap) {
							lines.push(truncateToWidth(row.join(" "), width, theme.fg("dim", "...")));
							continue;
						}
						// 逐条目换行:条目为原子单元(含 ANSI 色码,不拆内部,避免色码跨行泄漏)
						let cur = "";
						for (const entry of row) {
							const cand = cur ? `${cur} ${entry}` : entry;
							if (visibleWidth(cand) <= width) {
								cur = cand;
							} else {
								if (cur) lines.push(cur);
								cur = truncateToWidth(entry, width, "...");
							}
						}
						if (cur) lines.push(cur);
					}
					return lines;
				},
			};
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!enabled || !ctx.hasUI) return;
		install(ctx); // 每次 session_start 重装:闭包捕获最新 ctx(/new、/resume 后仍正确)
	});

	pi.registerCommand("footer-split", {
		description: "按 groups.json 分组分行显示扩展状态栏(再执行恢复默认)",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled) {
				install(ctx);
				ctx.ui.notify("footer-split 已启用", "info");
			} else {
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("footer-split 已关闭,恢复默认 footer", "info");
			}
		},
	});
}
