/**
 * glm-quota — GLM Coding Plan 用量状态栏(pi extension)。
 *
 * 展示规则(按当前激活 provider 所属套餐):
 * - 个人 coding plan(zhipu-coding-personal 等):GET /api/monitor/usage/quota/limit
 *   → TOKENS_LIMIT,只有百分比。5h 窗口(number=5)+ 周窗口(unit=6,语义由
 *   customer-package-reset/list 的 weekResets 确认)。
 * - 公司/团队 coding plan(provider 名含 company/team):同端点 ?type=2
 *   + bigmodel-organization/bigmodel-project 头 → CREDIT_LIMIT 积分制,
 *   有 currentValue/usage 绝对值。
 * - 非智谱 provider(deepseek、本地模型等):清空状态,不发请求。
 *
 * 数据源为逆向 bigmodel.cn 控制台的非公开 API,鉴权用裸 API key(非 Bearer),
 * 接口形状随时可能变——解析失败时只显示灰色占位,不影响 pi 本体。
 *
 * 刷新触发点(why):
 * - session_start:初次渲染(含 /new /resume /reload)
 * - model_select:切换 provider 后套餐维度随之改变
 * - agent_settled:一轮对话结束、5h 窗口用量刚变化;agent_end 后还可能有
 *   retry/follow-up,settled 才是真正静止点
 * - 定时器(5min):5h 滚动窗口不对话也会因旧用量滑出而变化
 * 事件触发的刷新有 60s 最小间距,避免连发追问时打接口。
 *
 * org/project 头来源:GLM_ORG_ID/GLM_PROJECT_ID 环境变量 > 本目录 team.json
 * > ~/.pi/agent/skills/glm-plan-usage/team.json(与查询 skill 共享同一份配置)。
 * 无法从 API key 自动发现组织(getCustomerInfo 对 key 返回 403 "APIKey not allow
 * access",仅限 web JWT;monitor 命名空间无组织发现端点),故需一次性手工配置,
 * org/project 可从 bigmodel.cn F12 网络面板任一请求头中拿。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const STATUS_ID = "glm-quota";
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const MIN_FETCH_SPACING_MS = 60 * 1000;
const DEBUG = !!process.env.GLM_QUOTA_DEBUG;

// ---------------------------------------------------------------- 类型

interface QuotaEntry {
	type?: string;
	unit?: number;
	number?: number;
	usage?: number;
	currentValue?: number;
	percentage?: number;
}
interface QuotaData {
	limits?: QuotaEntry[];
}

interface ProviderTarget {
	base: string;
	provider: string;
	isTeam: boolean;
}

// ---------------------------------------------------------------- 模块级状态
// 定时器与 latestCtx 跨事件存活;/new /resume 会先 session_shutdown 再
// session_start,所以只需要"启动前清旧的"这一层幂等。

let timer: ReturnType<typeof setInterval> | undefined;
let latestCtx: ExtensionContext | undefined;
let lastFetchAt = 0;
let fetching = false;

// ---------------------------------------------------------------- 套餐解析

function resolveProviderTarget(ctx: ExtensionContext): ProviderTarget | null {
	const providerId = ctx.model?.provider;
	if (!providerId) return null;
	const baseUrl = ctx.modelRegistry.getProvider(providerId)?.baseUrl || "";
	if (baseUrl.includes("bigmodel.cn")) {
		return { base: new URL(baseUrl).origin, provider: providerId, isTeam: /company|team/i.test(providerId) };
	}
	if (baseUrl.includes("api.z.ai")) {
		return { base: "https://api.z.ai", provider: providerId, isTeam: /company|team/i.test(providerId) };
	}
	return null;
}

function resolveTeamConfig(): { org: string; project: string } | null {
	const org = process.env.GLM_ORG_ID;
	const project = process.env.GLM_PROJECT_ID;
	if (org && project) return { org, project };

	const extDir = path.dirname(fileURLToPath(import.meta.url));
	const candidates = [
		path.join(extDir, "team.json"),
		path.join(os.homedir(), ".pi", "agent", "skills", "glm-plan-usage", "team.json"),
	];
	for (const p of candidates) {
		try {
			const cfg = JSON.parse(readFileSync(p, "utf8")) as { organization?: string; project?: string };
			if (cfg.organization && cfg.project) return { org: cfg.organization, project: cfg.project };
		} catch {
			// 文件不存在/损坏 → 试下一个来源
		}
	}
	return null;
}

// ---------------------------------------------------------------- 接口

async function fetchQuota(
	base: string,
	key: string,
	team: { org: string; project: string } | null,
): Promise<QuotaData | null> {
	const url = `${base}/api/monitor/usage/quota/limit${team ? "?type=2" : ""}`;
	const res = await fetch(url, {
		headers: {
			Authorization: key, // 裸 token,该监控 API 不用 Bearer
			"Accept-Language": "en-US,en",
			...(team ? { "bigmodel-organization": team.org, "bigmodel-project": team.project } : {}),
		},
	});
	if (!res.ok) return null;
	const json = (await res.json()) as { success?: boolean; data?: QuotaData };
	if (json.success === false) return null;
	// 无团队归属/无套餐时返回空 data:{},limits 为 undefined
	return json.data ?? null;
}

/** 从 limits 里挑 5h(number=5)与周(unit=6)两个窗口。 */
function pickWindows(data: QuotaData | null): { fiveHour?: QuotaEntry; weekly?: QuotaEntry } {
	const limits = (data?.limits ?? []).filter(
		(l) => l.type === "TOKENS_LIMIT" || l.type === "CREDIT_LIMIT",
	);
	return {
		fiveHour: limits.find((l) => l.number === 5),
		weekly: limits.find((l) => l.unit === 6),
	};
}

// ---------------------------------------------------------------- 渲染

function pctColor(theme: ExtensionContext["ui"]["theme"], pct: number): (s: string) => string {
	if (pct >= 85) return (s) => theme.fg("error", s);
	if (pct >= 60) return (s) => theme.fg("warning", s);
	return (s) => theme.fg("success", s);
}

function fmtCredits(n: number): string {
	return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

function renderStatus(
	theme: ExtensionContext["ui"]["theme"],
	isTeam: boolean,
	{ fiveHour, weekly }: { fiveHour?: QuotaEntry; weekly?: QuotaEntry },
): string {
	const label = theme.fg("dim", isTeam ? "GLM·T " : "GLM ");
	const sep = theme.fg("dim", "│");
	if (!fiveHour && !weekly) return theme.fg("dim", `${isTeam ? "GLM·T" : "GLM"} 无配额数据`);

	const parts: string[] = [];
	if (fiveHour) {
		if (isTeam && typeof fiveHour.currentValue === "number" && typeof fiveHour.usage === "number") {
			const pct = fiveHour.percentage ?? 0;
			parts.push(
				theme.fg("dim", "5h ") + pctColor(theme, pct)(`${fmtCredits(fiveHour.currentValue)}/${fmtCredits(fiveHour.usage)}`),
			);
		} else {
			const pct = fiveHour.percentage ?? 0;
			parts.push(theme.fg("dim", "5h ") + pctColor(theme, pct)(`${pct}%`));
		}
	}
	if (weekly) {
		if (isTeam && typeof weekly.currentValue === "number" && typeof weekly.usage === "number") {
			const pct = weekly.percentage ?? 0;
			parts.push(
				theme.fg("dim", "周 ") + pctColor(theme, pct)(`${fmtCredits(weekly.currentValue)}/${fmtCredits(weekly.usage)}`),
			);
		} else {
			const pct = weekly.percentage ?? 0;
			parts.push(theme.fg("dim", "周 ") + pctColor(theme, pct)(`${pct}%`));
		}
	}
	return label + parts.join(sep);
}

// ---------------------------------------------------------------- 刷新

async function refresh(ctx: ExtensionContext): Promise<void> {
	if (fetching) return;
	const now = Date.now();
	if (now - lastFetchAt < MIN_FETCH_SPACING_MS) return;
	fetching = true;
	try {
		const target = resolveProviderTarget(ctx);
		if (!target || !ctx.hasUI) {
			// 非智谱 provider(或无 UI 模式)不显示、不发请求
			ctx.ui.setStatus(STATUS_ID, undefined);
			return;
		}
		const theme = ctx.ui.theme;
		const key = await ctx.modelRegistry.getApiKeyForProvider(target.provider);
		if (!key) {
			ctx.ui.setStatus(STATUS_ID, theme.fg("dim", "GLM 无key"));
			return;
		}
		const team = target.isTeam ? resolveTeamConfig() : null;
		if (target.isTeam && !team) {
			ctx.ui.setStatus(STATUS_ID, theme.fg("dim", "GLM·T 未配置org/project"));
			return;
		}
		const data = await fetchQuota(target.base, key, team);
		lastFetchAt = now;
		const text = renderStatus(theme, target.isTeam, pickWindows(data));
		ctx.ui.setStatus(STATUS_ID, text);
		if (DEBUG) console.error(`[glm-quota] ${target.provider} team=${target.isTeam}: ${text.replace(/\u001b\[[0-9;]*m/g, "")}`);
	} catch (e) {
		// 非公开接口,失败属预期内:显示灰色占位,不抛出不打扰
		try {
			ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("dim", "GLM n/a"));
		} catch { /* ignore */ }
		if (DEBUG) console.error(`[glm-quota] refresh failed: ${e}`);
	} finally {
		fetching = false;
	}
}

// ---------------------------------------------------------------- 入口

export default function (pi: ExtensionAPI) {
	const startTimer = () => {
		if (timer) clearInterval(timer);
		timer = setInterval(() => {
			if (latestCtx) void refresh(latestCtx);
		}, REFRESH_INTERVAL_MS);
		// unref:print/json 等一次性模式下,定时器不得阻止进程退出
		timer.unref?.();
	};
	const stopTimer = () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	};

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		lastFetchAt = 0; // 新会话立即允许一次拉取
		await refresh(ctx);
		startTimer();
	});
	pi.on("model_select", async (_event, ctx) => {
		latestCtx = ctx;
		lastFetchAt = 0; // 套餐维度变了,强制刷新
		await refresh(ctx);
	});
	pi.on("agent_settled", async (_event, ctx) => {
		latestCtx = ctx;
		void refresh(ctx); // 受 60s 间距约束
	});
	pi.on("session_shutdown", () => {
		stopTimer();
	});
}
