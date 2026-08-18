/**
 * codegraph extension smoke test.
 *
 * Loads index.ts through pi's jiti loader (same alias map as bocha smoke),
 * registers the 4 bridged tools on a stub pi, then executes codegraph_search
 * in a temp git repo WITHOUT a .codegraph index — the server's documented
 * behavior for a fresh cwd is to index on first use or answer from a trivial
 * graph; either way a successful (non-error) result proves the whole chain:
 * prefix-dir scan -> binary resolution -> MCP handshake -> tools/call.
 *
 * The self-heal path itself is exercised implicitly when no global install
 * exists: resolution falls through PATH/npm-root candidates to the
 * ~/.pi/agent/codegraph-cli prefix. On this machine the prefix was installed
 * by `npm install --prefix ./codegraph-cli` beforehand.
 *
 * Run: node smoke.mjs
 */

const ROOT = process.env.PI_ROOT ?? "C:/Users/hugua/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent";

const { createJiti } = await import(`file:///${ROOT}/node_modules/jiti/lib/jiti-static.mjs`);

const alias = {
	"@earendil-works/pi-coding-agent": `${ROOT}/dist/index.js`,
	"@earendil-works/pi-agent-core": `${ROOT}/node_modules/@earendil-works/pi-agent-core/dist/index.js`,
	"@earendil-works/pi-ai": `${ROOT}/node_modules/@earendil-works/pi-ai/dist/compat.js`,
	"@earendil-works/pi-ai/compat": `${ROOT}/node_modules/@earendil-works/pi-ai/dist/compat.js`,
	typebox: `${ROOT}/node_modules/typebox/build/index.mjs`,
	"typebox/compile": `${ROOT}/node_modules/typebox/build/compile/index.mjs`,
	"typebox/value": `${ROOT}/node_modules/typebox/build/value/index.mjs`,
	"@sinclair/typebox": `${ROOT}/node_modules/typebox/build/index.mjs`,
};

const jiti = createJiti(import.meta.url, { interopDefault: true, alias });

const tools = {};
const stub = { registerTool(t) { tools[t.name] = t; }, on() {} };
const mod = await jiti.import("C:/Users/hugua/.pi/agent/extensions/codegraph/index.ts", { default: true });
(mod.default ?? mod)(stub);

const expected = ["codegraph_explore", "codegraph_node", "codegraph_search", "codegraph_callers"];
const names = Object.keys(tools);
const missing = expected.filter((n) => !names.includes(n));
if (missing.length > 0) {
	console.error(`FAIL: missing tools: ${missing.join(", ")}`);
	process.exit(1);
}
console.log(`PASS: 4 tools registered (${names.join(", ")})`);

// Fresh temp repo: forces the server to work without a prebuilt index.
const { mkdtempSync } = await import("node:fs");
const { join } = await import("node:path");
const { tmpdir } = await import("node:os");
const cwd = mkdtempSync(join(tmpdir(), "cg-smoke-"));

const res = await tools.codegraph_search.execute(
	"smoke-1",
	{ query: "resolveServerLaunch" },
	undefined,
	undefined,
	{ cwd },
);

const text = res.content?.map((p) => p.text ?? "").join("\n") ?? "";
console.log(`isError=${res.isError}`);
console.log("--- result head ---");
console.log(text.slice(0, 400));

if (res.isError) {
	console.error("\ncodegraph smoke failed (error result).");
	process.exit(1);
}
console.log("\ncodegraph smoke passed.");
