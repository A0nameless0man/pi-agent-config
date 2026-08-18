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
 * - agent_settled → 延迟 10s:一轮对话结束、5h 窗口用量刚变化;延迟是给后端
 *   计量落地留时间(立即查常常还是旧值);连发追问/retry 时去抖,只在最后一次
 *   settled 后 10s 拉一次
 * - 周期刷新(动态间隔):空闲 5min;turn_start → agent_settled 之间视为活跃,
 *   降到 60s——长时间连续 LLM 调用中 5h 窗口持续滚动,状态栏也要跟得上。
 *   活跃档间隔即取 MIN_FETCH_SPACING_MS,不多打接口
 * 事件触发的刷新有 60s 最小间距(在拉取时刻衡量),避免连发追问时打接口。
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
// 活跃期(LLM 调用进行中)的快周期:取最小间距值,不加请求密度
const ACTIVE_REFRESH_INTERVAL_MS = MIN_FETCH_SPACING_MS;
// LLM 调用结束后延迟拉取:后端计量异步落地,立即查常拿到旧值
const POST_SETTLE_DELAY_MS = 10_000;
const DEBUG = !!process.env.GLM_QUOTA_DEBUG;

// ---------------------------------------------------------------- 类型

interface QuotaEntry {
	type?: string;
	unit?: number;
	number?: number;
	usage?: number;
	currentValue?: number;
	percentage?: number;
	nextResetTime?: number;
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

let timer: ReturnType<typeof setTimeout> | undefined;
let settleTimer: ReturnType<typeof setTimeout> | undefined;
let latestCtx: ExtensionContext | undefined;
let lastFetchAt = 0;
let fetching = false;
// turn_start → agent_settled 之间为 true;决定周期刷新用快档还是慢档
let agentActive = false;

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

/**
 * 重置时间展示:5h 窗口只会是几小时内 → 只出 HH:MM;
 * 周窗口可能是几天后 → 完整 YYYY-MM-DD HH:MM(用户指定格式)。
 */
function fmtResetTime(ms: number, short: boolean): string {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
	if (short) return hm;
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}

function renderStatus(
	theme: ExtensionContext["ui"]["theme"],
	isTeam: boolean,
	{ fiveHour, weekly }: { fiveHour?: QuotaEntry; weekly?: QuotaEntry },
): string {
	const label = theme.fg("dim", isTeam ? "GLM·T " : "GLM ");
	const sep = theme.fg("dim", "│");
	if (!fiveHour && !weekly) return theme.fg("dim", `${isTeam ? "GLM·T" : "GLM"} 无配额数据`);

	// 重置时间用弱色缀在百分比后:5h → HH:MM,周 → YYYY-MM-DD HH:MM
	const resetHint = (item: QuotaEntry, short: boolean): string => {
		if (!item.nextResetTime) return "";
		return theme.fg("dim", ` ${fmtResetTime(item.nextResetTime, short)}`);
	};

	const parts: string[] = [];
	if (fiveHour) {
		if (isTeam && typeof fiveHour.currentValue === "number" && typeof fiveHour.usage === "number") {
			const pct = fiveHour.percentage ?? 0;
			parts.push(
				theme.fg("dim", "5h ") +
					pctColor(theme, pct)(`${fmtCredits(fiveHour.currentValue)}/${fmtCredits(fiveHour.usage)}`) +
					resetHint(fiveHour, true),
			);
		} else {
			const pct = fiveHour.percentage ?? 0;
			parts.push(theme.fg("dim", "5h ") + pctColor(theme, pct)(`${pct}%`) + resetHint(fiveHour, true));
		}
	}
	if (weekly) {
		if (isTeam && typeof weekly.currentValue === "number" && typeof weekly.usage === "number") {
			const pct = weekly.percentage ?? 0;
			parts.push(
				theme.fg("dim", "周 ") +
					pctColor(theme, pct)(`${fmtCredits(weekly.currentValue)}/${fmtCredits(weekly.usage)}`) +
					resetHint(weekly, false),
			);
		} else {
			const pct = weekly.percentage ?? 0;
			parts.push(theme.fg("dim", "周 ") + pctColor(theme, pct)(`${pct}%`) + resetHint(weekly, false));
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
	// setTimeout 自调度链而非 setInterval:间隔每次重算,活跃期(LLM 连续调用/
	// 多轮工具循环)用 60s 快档,空闲回落 5min;refresh 内部的 MIN_FETCH_SPACING_MS
	// 兑底,保证无论事件怎么触发都不密于 60s
	const scheduleNext = () => {
		if (timer) clearTimeout(timer);
		const interval = agentActive ? ACTIVE_REFRESH_INTERVAL_MS : REFRESH_INTERVAL_MS;
		timer = setTimeout(() => {
			timer = undefined;
			if (latestCtx) void refresh(latestCtx).finally(scheduleNext);
		}, interval);
		// unref:print/json 等一次性模式下,定时器不得阻止进程退出
		timer.unref?.();
	};
	const startTimer = () => {
		if (timer === undefined) scheduleNext();
	};
	const stopTimer = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
	};

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		lastFetchAt = 0; // 新会话立即允许一次拉取
		agentActive = false; // 上会话可能在活跃期被中断,新会话从空闲档起步
		await refresh(ctx);
		startTimer();
	});
	pi.on("model_select", async (_event, ctx) => {
		latestCtx = ctx;
		lastFetchAt = 0; // 套餐维度变了,强制刷新
		await refresh(ctx);
	});
	pi.on("turn_start", async (_event, ctx) => {
		latestCtx = ctx;
		agentActive = true; // 进入活跃期:快档周期刷新接管,长时间连续调用也能看到滚动
	});
	pi.on("agent_settled", async (_event, ctx) => {
		latestCtx = ctx;
		agentActive = false; // 回到空闲档
		// 去抖:新一轮 settled 到来时重置计时,只在最后一次对话结束后 10s 拉一次;
		// 拉取时仍受 MIN_FETCH_SPACING_MS 约束(间距在 fetch 时刻衡量,非调度时刻)
		if (settleTimer) clearTimeout(settleTimer);
		settleTimer = setTimeout(() => {
			settleTimer = undefined;
			if (latestCtx) void refresh(latestCtx);
		}, POST_SETTLE_DELAY_MS);
		settleTimer.unref?.(); // print/json 一次性模式下不得阻止进程退出
	});
	pi.on("session_shutdown", () => {
		stopTimer();
		// 清掉待触发的延迟刷新,避免跨会话(/new)后在无 UI 上下文里空拉
		if (settleTimer) clearTimeout(settleTimer);
		settleTimer = undefined;
	});
}
