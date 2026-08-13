/**
 * Bocha extension smoke test.
 *
 * Loads index.ts through pi's own jiti loader (same alias map pi uses to
 * resolve @earendil-works/pi-* and typebox for extensions), registers the
 * web-search tool on a stub pi, then calls it with a real query and asserts:
 *   - isError === false
 *   - the returned text is rendered markdown (starts with the "## Bocha" header)
 *
 * Requires BOCHA_API_KEY to be set in the environment.
 *
 * Run: node smoke.mjs
 */

const ROOT = process.env.PI_ROOT ?? "C:/Users/hugua/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent";

// Dynamic import so the jiti location is derived from ROOT (extension dir has
// no node_modules of its own; this works from any cwd).
const { createJiti } = await import(`file:///${ROOT}/node_modules/jiti/lib/jiti-static.mjs`);

// Same alias map pi's dist/core/extensions/loader.js (getAliases) uses in
// built Node.js mode, so extension imports resolve identically.
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
const stub = { registerTool(t) { tools[t.name] = t; } };

const mod = await jiti.import("C:/Users/hugua/.pi/agent/extensions/bocha/index.ts", { default: true });
const init = mod.default ?? mod;
init(stub);

const names = Object.keys(tools);
if (names.length !== 1 || names[0] !== "bocha_web_search") {
	console.error(`FAIL: expected exactly one tool "bocha_web_search", got: ${JSON.stringify(names)}`);
	process.exit(1);
}

const res = await tools.bocha_web_search.execute("smoke-call", { query: "deepseek", count: 1 }, undefined);
const text = res.content?.[0]?.text ?? "";
const ok = res.isError === false && text.startsWith("## Bocha") && text.includes("http");
console.log(`PASS: isError=${res.isError}, markdown=${text.startsWith("## Bocha")}, has-url=${text.includes("http")}`);
console.log("--- rendered markdown (first 1200 chars) ---");
console.log(text.slice(0, 1200));

if (!ok) {
	console.error("\nBocha web-search smoke test failed.");
	process.exit(1);
}
console.log("\nBocha web-search smoke test passed.");
