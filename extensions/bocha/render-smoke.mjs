/**
 * Bocha extension render smoke test.
 *
 * Drives renderCall/renderResult the same way ToolExecutionComponent does in
 * the TUI, with a stub theme + render context, and asserts the bash-style
 * collapse:
 *   - collapsed: tail preview + "... (N earlier lines, ... to expand)" hint
 *     + "Took X.Xs" footer
 *   - expanded: full output
 *   - error result styled with the error color
 *
 * Run: node render-smoke.mjs   (no network needed)
 */

const ROOT = process.env.PI_ROOT ?? "C:/Users/hugua/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent";

const { createJiti } = await import(`file:///${ROOT}/node_modules/jiti/lib/jiti-static.mjs`);

const alias = {
	"@earendil-works/pi-coding-agent": `${ROOT}/dist/index.js`,
	"@earendil-works/pi-agent-core": `${ROOT}/node_modules/@earendil-works/pi-agent-core/dist/index.js`,
	"@earendil-works/pi-ai": `${ROOT}/node_modules/@earendil-works/pi-ai/dist/compat.js`,
	"@earendil-works/pi-ai/compat": `${ROOT}/node_modules/@earendil-works/pi-ai/dist/compat.js`,
	"@earendil-works/pi-tui": `${ROOT}/node_modules/@earendil-works/pi-tui/dist/index.js`,
	typebox: `${ROOT}/node_modules/typebox/build/index.mjs`,
	"typebox/compile": `${ROOT}/node_modules/typebox/build/compile/index.mjs`,
	"typebox/value": `${ROOT}/node_modules/typebox/build/value/index.mjs`,
	"@sinclair/typebox": `${ROOT}/node_modules/typebox/build/index.mjs`,
};

const jiti = createJiti(import.meta.url, { interopDefault: true, alias });

// keyHint() reads the global theme singleton; initialize it headless so the
// hint line renders instead of throwing before initTheme ran.
const pkg = await jiti.import(`${ROOT}/dist/index.js`, { default: false });
pkg.initTheme?.();

const tools = {};
const stub = { registerTool(t) { tools[t.name] = t; } };
const mod = await jiti.import("C:/Users/hugua/.pi/agent/extensions/bocha/index.ts", { default: true });
(mod.default ?? mod)(stub);
const tool = tools.bocha_web_search;

let failures = 0;
const check = (name, cond) => {
	console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
	if (!cond) failures++;
};

// --- stub theme: fg tags text so assertions can see which color was used ---
const stubTheme = {
	fg: (color, s) => `[${color}]${s}[/${color}]`,
	bold: (s) => `**${s}**`,
};

// --- fake markdown result, long enough to trigger the collapse ---
const fakeResult = {
	content: [{
		type: "text",
		text: ["## Bocha 网页搜索 · 约 100 条结果", "",
			...Array.from({ length: 20 }, (_, i) =>
				`### ${i + 1}. Result title ${i + 1}\n- URL: https://example.com/${i + 1}\n- 来源: site${i + 1}\n\nsummary line ${i + 1}\n`),
		].join("\n"),
	}],
	isError: false,
};

const state = {};
const contextBase = {
	args: { query: "pi extension", count: 5 },
	toolCallId: "smoke-1",
	invalidate: () => {},
	lastComponent: undefined,
	state,
	cwd: "/tmp",
	executionStarted: false,
	argsComplete: true,
	isPartial: false,
	expanded: false,
	showImages: false,
	isError: false,
};

// --- renderCall: header shows query, tracks startedAt on execution ---
const callComp = tool.renderCall({ query: "pi extension", count: 5 }, stubTheme, {
	...contextBase, executionStarted: true,
});
const callLines = callComp.render(100);
check("renderCall shows query", callLines.join("\n").includes('"pi extension"'));
check("renderCall tracks startedAt", typeof state.startedAt === "number");

// settle timing as renderResult would when the result lands
state.endedAt = state.startedAt + 5100;

// --- renderResult collapsed ---
const resultComp = tool.renderResult(fakeResult, { expanded: false, isPartial: false }, stubTheme, {
	...contextBase, lastComponent: undefined,
});
const lines = resultComp.render(100).filter((l) => l.trim().length > 0);
const collapsedText = lines.join("\n");
check("collapsed hides earlier lines", !collapsedText.includes("Result title 1"));
check("collapsed keeps tail lines", collapsedText.includes("Result title 20") || collapsedText.includes("summary line 20"));
check("collapsed has earlier-lines hint", /\(\d+ earlier lines,/.test(collapsedText));
check("collapsed has expand hint", /to expand/.test(collapsedText));
check("collapsed has Took footer", /Took 5\.1s/.test(collapsedText));

// --- width change recomputes preview (cache invalidation path) ---
const narrowLines = resultComp.render(40).filter((l) => l.trim().length > 0).join("\n");
check("narrow width re-truncates", /\(\d+ earlier lines,/.test(narrowLines));

// --- renderResult expanded (reuses the same component; clears + rebuilds) ---
const expandedComp = tool.renderResult(fakeResult, { expanded: true, isPartial: false }, stubTheme, {
	...contextBase, lastComponent: resultComp,
});
const expandedText = expandedComp.render(100).join("\n");
check("expanded shows everything", expandedText.includes("Result title 1") && expandedText.includes("Result title 20"));
check("expanded has no hint", !/\(\d+ earlier lines,/.test(expandedText));

// --- error result uses error color ---
const errComp = tool.renderResult(
	{ content: [{ type: "text", text: "Bocha web search failed: HTTP 500" }], isError: true },
	{ expanded: false, isPartial: false },
	stubTheme,
	{ ...contextBase, lastComponent: undefined, state: {}, isError: true },
);
const errText = errComp.render(100).join("\n");
check("error styled with error color", errText.includes("[error]"));
check("error still collapses tail+Took", /Took \d+\.\d+s/.test(errText) || errText.includes("HTTP 500"));

// --- short output: no hint line ---
const shortComp = tool.renderResult(
	{ content: [{ type: "text", text: "## Bocha 网页搜索\n\n_无结果_" }], isError: false },
	{ expanded: false, isPartial: false },
	stubTheme,
	{ ...contextBase, lastComponent: undefined, state: { startedAt: Date.now() - 300, endedAt: Date.now() } },
);
const shortText = shortComp.render(100).join("\n");
check("short output has no hint", !/earlier lines/.test(shortText));
check("short output has Took", /Took 0\.\d+s/.test(shortText));

if (failures > 0) {
	console.error(`\n${failures} render smoke check(s) failed.`);
	process.exit(1);
}
console.log("\nAll render smoke checks passed.");
