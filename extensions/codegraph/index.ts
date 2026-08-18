/**
 * codegraph extension for pi — a minimal MCP stdio bridge to @colbymchenry/codegraph.
 *
 * Why this file exists: pi has no built-in MCP client, and its extension loader
 * (jiti) cannot resolve arbitrary npm packages (the module resolution paths do
 * not include global npm). So this extension hand-writes the MCP stdio
 * transport using ONLY node builtins: line-delimited JSON-RPC 2.0 over a
 * spawned child process.
 *
 * Design decisions (see the handshake probing that produced them):
 * - The server is launched with `codegraph serve --mcp`. On Windows the npm
 *   `codegraph` shim cannot be spawned directly (Node refuses .cmd with EINVAL
 *   on Node >= 22 / CVE-2024-27980 hardening), so we resolve the bundled
 *   per-platform package the same way npm-shim.js does and spawn its bundled
 *   node.exe directly. Spawning the real server process (not the shim) also
 *   keeps process ownership clean: killing our child kills the server.
 * - The shim is the fallback when the platform bundle is missing from the
 *   registry (it self-heals by downloading); in that case cleanup needs a
 *   process-tree kill (taskkill /T on Windows).
 * - Only `codegraph_explore` is listed by the server by default, so we set
 *   CODEGRAPH_MCP_TOOLS=explore,node,search,callers. CODEGRAPH_NO_DAEMON=1
 *   pins one server per pi session so session_shutdown can kill it
 *   deterministically. CODEGRAPH_HOST_PPID makes the server's orphan watchdog
 *   follow pi's own pid.
 * - Tiny-repo gating: the server omits codegraph_callers from tools/list on
 *   projects under its file threshold, but still EXECUTES it on tools/call
 *   (verified by handshake probe). We register all 4 tools statically.
 * - Tool schemas below are transcribed verbatim from the server's real
 *   tools/list output (and the tools.js source for codegraph_callers, which
 *   was gated out of the probe's tools/list).
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** MCP stdio server launch arguments (everything after the `codegraph` bin). */
const SERVER_ARGS = ["serve", "--mcp"];
/** Short-name allowlist so the server lists/accepts all 4 bridged tools. */
const CODEGRAPH_MCP_TOOLS = "explore,node,search,callers";
/** Per-tool-call timeout. The task contract requires 30s; return an error past it. */
const TOOL_TIMEOUT_MS = 30_000;
/** Handshake (initialize) timeout — includes server startup + connect-time catch-up. */
const HANDSHAKE_TIMEOUT_MS = 60_000;
/** Grace period between closing stdin (graceful teardown) and a hard kill. */
const KILL_GRACE_MS = 1_500;
/** npm global prefix candidates are computed once per process. */
const MCP_PROTOCOL_VERSION = "2024-11-05";

// ---------------------------------------------------------------------------
// Minimal JSON-RPC 2.0 types (no npm deps — hand-rolled per the MCP spec)
// ---------------------------------------------------------------------------

interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

interface JsonRpcMessage {
	jsonrpc: string;
	id?: number;
	method?: string;
	result?: unknown;
	error?: JsonRpcError;
	params?: unknown;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout;
	signal: AbortSignal | undefined;
	onAbort: () => void;
}

function formatJsonRpcError(error: JsonRpcError): string {
	const data = error.data !== undefined ? ` (${typeof error.data === "string" ? error.data : JSON.stringify(error.data)})` : "";
	return `MCP error ${error.code}: ${error.message}${data}`;
}

// ---------------------------------------------------------------------------
// Server binary resolution (mirrors the logic inside npm-shim.js, but with
// direct process ownership instead of spawnSync inherit)
// ---------------------------------------------------------------------------

interface ServerLaunch {
	command: string;
	args: string[];
	/** true = launched via npm-shim.js (needs process-tree kill on cleanup). */
	viaShim: boolean;
}

let cachedNpmDirs: string[] | null = null;

/** Collect candidate npm global prefix dirs: PATH scan + Windows default + `npm root -g`. */
function npmGlobalDirs(): string[] {
	if (cachedNpmDirs) return cachedNpmDirs;
	const dirs: string[] = [];
	const seen = new Set<string>();
	const push = (dir: string) => {
		if (!dir) return;
		const normalized = path.resolve(dir);
		if (seen.has(normalized)) return;
		seen.add(normalized);
		dirs.push(normalized);
	};

	// 用户态自愈安装位(见 resolveServerLaunchWithSelfHeal):npm --prefix 装在这里,
	// 包结构(<prefix>/node_modules/@colbymchenry/...)与全局扫描路径同构,免 sudo
	const agentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
	push(path.join(agentDir, "codegraph-cli"));

	const isWin = process.platform === "win32";
	const pathEnv = process.env.PATH ?? "";
	for (const raw of pathEnv.split(isWin ? ";" : ":")) {
		const dir = raw.replace(/^"(.*)"$/, "$1").trim();
		if (!dir) continue;
		// npm bin dirs carry the `codegraph` shim (codegraph.cmd/.ps1 on Windows)
		if (
			fs.existsSync(path.join(dir, "codegraph")) ||
			(isWin && (fs.existsSync(path.join(dir, "codegraph.cmd")) || fs.existsSync(path.join(dir, "codegraph.ps1"))))
		) {
			push(dir);
		}
	}
	if (isWin && process.env.APPDATA) push(path.join(process.env.APPDATA, "npm"));
	try {
		const result = spawnSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
		if (result.status === 0 && result.stdout) push(result.stdout.trim());
	} catch {
		/* npm not on PATH — PATH scan above is the only source */
	}

	cachedNpmDirs = dirs;
	return dirs;
}

function resolveServerLaunch(): ServerLaunch | null {
	const platformPkg = `@colbymchenry/codegraph-${process.platform}-${process.arch}`;
	const isWin = process.platform === "win32";

	for (const npmDir of npmGlobalDirs()) {
		// The per-platform bundle may be hoisted to the npm root, or (when the
		// registry skipped the optionalDependency) nested under the main package.
		const bundleDirs = [
			path.join(npmDir, "node_modules", platformPkg),
			path.join(npmDir, "node_modules", "@colbymchenry", "codegraph", "node_modules", platformPkg),
		];
		for (const bundleDir of bundleDirs) {
			if (isWin) {
				const nodeExe = path.join(bundleDir, "node.exe");
				const entry = path.join(bundleDir, "lib", "dist", "bin", "codegraph.js");
				if (fs.existsSync(nodeExe) && fs.existsSync(entry)) {
					// Flags mirror npm-shim.js liftoff(): keep tree-sitter WASM off
					// V8 turboshaft and mute node:sqlite's experimental warning.
					return {
						command: nodeExe,
						args: ["--liftoff-only", "--disable-warning=ExperimentalWarning", entry, ...SERVER_ARGS],
						viaShim: false,
					};
				}
			} else {
				const bin = path.join(bundleDir, "bin", "codegraph");
				if (fs.existsSync(bin)) return { command: bin, args: [...SERVER_ARGS], viaShim: false };
			}
		}
		// Fallback: the npm shim, run by pi's own node. It locates the bundle and
		// self-heals missing optionalDependencies by downloading from GitHub.
		const shim = path.join(npmDir, "node_modules", "@colbymchenry", "codegraph", "npm-shim.js");
		if (fs.existsSync(shim)) return { command: process.execPath, args: [shim, ...SERVER_ARGS], viaShim: true };
	}
	return null;
}

// ---------------------------------------------------------------------------
// 自愈安装:解析失败时,用 npm --prefix 装到 agent 目录下的用户态前缀(免 sudo),
// 然后重扫。每会话只试一次,避免每次工具调用都重复下载。
// ---------------------------------------------------------------------------

let selfHealAttempted = false;

function resolveServerLaunchWithSelfHeal(): ServerLaunch | null {
	let launch = resolveServerLaunch();
	if (launch || selfHealAttempted) return launch;
	selfHealAttempted = true;

	const agentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
	const prefix = path.join(agentDir, "codegraph-cli");
	// Windows 上 spawn("npm") 命中 .cmd 的 EINVAL 硬化,需 shell;Linux 直接跑
	const result = spawnSync(
		"npm",
		["install", "--prefix", prefix, "--no-fund", "--no-audit", "@colbymchenry/codegraph@latest"],
		{
			encoding: "utf8",
			timeout: 180_000,
			windowsHide: true,
			shell: process.platform === "win32",
		},
	);
	if (result.status !== 0) return null;
	cachedNpmDirs = null; // 重扫,把新装的 prefix 纳入候选
	return resolveServerLaunch();
}

// ---------------------------------------------------------------------------
// MCP stdio session: one spawned server, line-delimited JSON-RPC, id-matched
// pending map, lazy initialize handshake, 30s per-call timeout, abort support
// ---------------------------------------------------------------------------

class McpSession {
	readonly cwd: string;

	private child: ChildProcess | null = null;
	private viaShim = false;
	private nextId = 1;
	private pending = new Map<number, PendingRequest>();
	private buffer = "";
	private ready: Promise<void> | null = null;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	/** Idempotent startup: spawn + initialize handshake, reused by later calls. */
	start(): Promise<void> {
		if (this.ready) return this.ready;
		this.ready = this.connect().catch((err) => {
			// Clear state so a later call can retry the connection.
			this.teardown();
			this.ready = null;
			throw err;
		});
		return this.ready;
	}

	/** Run one tools/call and return the aggregated text content. */
	async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
		await this.start();
		const result = await this.request("tools/call", { name, arguments: args }, TOOL_TIMEOUT_MS, signal);

		const parts: string[] = [];
		let isError = false;
		const parsed = result as { content?: unknown; isError?: unknown };
		if (Array.isArray(parsed.content)) {
			for (const item of parsed.content) {
				if (
					typeof item === "object" &&
					item !== null &&
					(item as { type?: unknown }).type === "text" &&
					typeof (item as { text?: unknown }).text === "string"
				) {
					parts.push((item as { text: string }).text);
				}
			}
		}
		if (parsed.isError === true) isError = true;
		const text = parts.join("\n");
		if (isError) throw new Error(text || "codegraph MCP tool reported an error");
		return text || "(empty response from codegraph MCP server)";
	}

	/** Tear down the child: close stdin first (the server treats EOF as
	 *  graceful teardown), then hard-kill after a grace period. */
	dispose(): void {
		this.teardown();
		this.rejectAllPending(new Error("codegraph MCP session closed"));
	}

	// --- internals ---------------------------------------------------------

	private teardown(): void {
		const child = this.child;
		this.child = null;
		if (!child) return;
		const pid = child.pid;
		try {
			child.stdin?.end();
		} catch {
			/* stdin already gone */
		}
		const killer = setTimeout(() => {
			if (this.viaShim && process.platform === "win32" && pid !== undefined) {
				// The shim is a wrapper; kill its whole tree (shim + bundled server).
				try {
					spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
				} catch {
					try { child.kill("SIGKILL"); } catch { /* already dead */ }
				}
			} else {
				try {
					child.kill("SIGKILL");
				} catch {
					/* already dead */
				}
			}
		}, KILL_GRACE_MS);
		killer.unref();
	}

	private rejectAllPending(err: Error): void {
		for (const [id, req] of this.pending) {
			this.pending.delete(id);
			clearTimeout(req.timer);
			req.signal?.removeEventListener("abort", req.onAbort);
			req.reject(err);
		}
	}

	private connect(): Promise<void> {
		const launch = resolveServerLaunchWithSelfHeal();
		if (!launch) {
			return Promise.reject(
				new Error(
					"codegraph MCP server not found — self-install into ~/.pi/agent/codegraph-cli failed too; " +
						"install it manually: npm i -g @colbymchenry/codegraph" +
						" (the bundled platform package or npm-shim.js could not be located in any npm global prefix)",
				),
			);
		}
		this.viaShim = launch.viaShim;

		const env: NodeJS.ProcessEnv = {
			...process.env,
			CODEGRAPH_MCP_TOOLS,
			// One server per pi session — required for deterministic kill on shutdown.
			CODEGRAPH_NO_DAEMON: "1",
			// Orphan watchdog: if pi dies unexpectedly, the server follows it.
			CODEGRAPH_HOST_PPID: String(process.pid),
		};

		return new Promise<void>((resolve, reject) => {
			let child: ChildProcess;
			try {
				child = spawn(launch.command, launch.args, {
					cwd: this.cwd,
					stdio: ["pipe", "pipe", "inherit"],
					env,
					windowsHide: true,
				});
			} catch (err) {
				reject(err instanceof Error ? err : new Error(String(err)));
				return;
			}
			this.child = child;

			let settled = false;
			const fail = (err: Error) => {
				if (settled) return;
				settled = true;
				this.child = null;
				reject(err);
			};

			child.on("error", (err) => fail(new Error(`failed to spawn codegraph MCP server: ${err.message}`)));
			child.on("exit", (code, signal) => {
				if (this.child !== child) return; // stale exit from a replaced child
				this.child = null;
				this.ready = null;
				const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
				this.rejectAllPending(new Error(`codegraph MCP server exited unexpectedly (${detail})`));
				if (!settled) fail(new Error(`codegraph MCP server exited during startup (${detail})`));
			});

			child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));

			// initialize → await response → notify initialized → ready
			this.request("initialize", {
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "pi-codegraph-bridge", version: "1.0.0" },
			}, HANDSHAKE_TIMEOUT_MS)
				.then(() => {
					this.sendNotification("notifications/initialized");
					if (settled) return;
					settled = true;
					resolve();
				})
				.catch((err: unknown) => {
					const message = err instanceof Error ? err.message : String(err);
					fail(new Error(`codegraph MCP handshake failed: ${message}`));
				});
		});
	}

	private onStdout(chunk: Buffer): void {
		this.buffer += chunk.toString("utf8");
		let idx: number;
		while ((idx = this.buffer.indexOf("\n")) !== -1) {
			const line = this.buffer.slice(0, idx).trim();
			this.buffer = this.buffer.slice(idx + 1);
			if (line) this.onLine(line);
		}
	}

	private onLine(line: string): void {
		let msg: JsonRpcMessage;
		try {
			msg = JSON.parse(line) as JsonRpcMessage;
		} catch {
			return; // non-JSON line (defensive) — ignore
		}
		if (typeof msg !== "object" || msg === null || typeof msg.id !== "number") {
			// Notifications (no id) — the server emits log/ping notifications; ignore.
			return;
		}
		if (msg.method !== undefined) {
			// Server→client request (e.g. `ping`): answer with an empty result.
			this.sendRaw({ jsonrpc: "2.0", id: msg.id, result: {} });
			return;
		}
		const req = this.pending.get(msg.id);
		if (!req) return; // late response for a timed-out/aborted request
		this.pending.delete(msg.id);
		clearTimeout(req.timer);
		req.signal?.removeEventListener("abort", req.onAbort);
		if (msg.error) req.reject(new Error(formatJsonRpcError(msg.error)));
		else req.resolve(msg.result);
	}

	private request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
		const child = this.child;
		if (!child || !child.stdin?.writable) {
			return Promise.reject(new Error("codegraph MCP server is not running"));
		}
		const id = this.nextId++;
		return new Promise<unknown>((resolve, reject) => {
			const settle = (fn: () => void) => {
				const req = this.pending.get(id);
				if (!req) return;
				this.pending.delete(id);
				clearTimeout(req.timer);
				req.signal?.removeEventListener("abort", req.onAbort);
				fn();
			};
			const onAbort = () => settle(() => reject(new Error("aborted")));
			if (signal) {
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			}
			const timer = setTimeout(() => {
				settle(() =>
					reject(
						new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for the codegraph MCP server`),
					),
				);
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer, signal, onAbort });
			try {
				child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
			} catch (err) {
				settle(() => reject(err instanceof Error ? err : new Error(String(err))));
			}
		});
	}

	private sendNotification(method: string): void {
		this.sendRaw({ jsonrpc: "2.0", method });
	}

	private sendRaw(message: JsonRpcMessage): void {
		const child = this.child;
		if (!child || !child.stdin?.writable) return;
		try {
			child.stdin.write(JSON.stringify(message) + "\n");
		} catch {
			/* child died between the writable check and the write — exit handler cleans up */
		}
	}
}

// ---------------------------------------------------------------------------
// Bridge state: one server per pi working directory, lazy-spawned on first
// tool call, disposed on session_shutdown
// ---------------------------------------------------------------------------

let session: McpSession | null = null;
let sessionCwd: string | null = null;

async function getSession(cwd: string): Promise<McpSession> {
	if (session && sessionCwd === cwd) return session;
	if (session) {
		session.dispose();
		session = null;
		sessionCwd = null;
	}
	const next = new McpSession(cwd);
	session = next;
	sessionCwd = cwd;
	await next.start();
	return next;
}

// ---------------------------------------------------------------------------
// Tool schemas — transcribed from the real tools/list inputSchema of
// CodeGraph MCP 1.5.0 (codegraph_callers from the server's tools.js source,
// since tiny-repo gating hides it from tools/list; verified executable)
// ---------------------------------------------------------------------------

const PROJECT_PATH_DESCRIPTION =
	"Absolute path to the project to query (or any directory inside it) — codegraph uses the nearest " +
	".codegraph/ index at or above that path. Omit to use this session's default project. Pass it to " +
	"query a second codebase, or when the server root has no index of its own (e.g. a monorepo where " +
	"only sub-projects are indexed, so there is no default project).";

const ProjectPath = Type.Optional(Type.String({ description: PROJECT_PATH_DESCRIPTION }));

const ExploreParams = Type.Object({
	query: Type.String({
		description:
			'Symbol names, file names, or short code terms to explore (e.g., "AuthService loginUser session-manager", ' +
			'"GraphTraverser BFS impact traversal.ts"). For a flow question, name the symbols spanning the flow ' +
			'(e.g. "mutateElement renderScene"). A natural-language question works too — no prior codegraph_search needed.',
	}),
	maxFiles: Type.Optional(
		Type.Number({ description: "Maximum number of files to include source code from (default: 12)", default: 12 }),
	),
	projectPath: ProjectPath,
});

const NodeParams = Type.Object({
	symbol: Type.Optional(
		Type.String({
			description: "Name of the symbol to read (symbol mode). Omit it and pass `file` alone to read a whole file like Read.",
		}),
	),
	includeCode: Type.Optional(
		Type.Boolean({
			description:
				"Symbol mode: include the symbol's full body (default: false). Ignored in file mode, which always " +
				"returns source unless `symbolsOnly` is set.",
			default: false,
		}),
	),
	file: Type.Optional(
		Type.String({
			description:
				'A file path or basename (e.g. "harness.rs", "src/auth/session.ts"). Pass it ALONE (no symbol) to READ ' +
				"the file like the Read tool — its full source with line numbers + which files depend on it. Or pass it " +
				"WITH a symbol to disambiguate an overloaded name to the definition in this file.",
		}),
	),
	offset: Type.Optional(
		Type.Number({ description: "File mode: 1-based line to start reading from, exactly like Read's offset. Defaults to the start of the file." }),
	),
	limit: Type.Optional(
		Type.Number({
			description: "File mode: maximum number of lines to return, exactly like Read's limit. Defaults to the whole file (capped at 2000 lines, like Read).",
		}),
	),
	symbolsOnly: Type.Optional(
		Type.Boolean({
			description: "File mode: return just the file's symbol map + dependents (a cheap structural overview) instead of its source.",
			default: false,
		}),
	),
	line: Type.Optional(
		Type.Number({ description: "Symbol mode only: disambiguate to the definition at/around this line (use with the file:line a trail showed you)." }),
	),
	projectPath: ProjectPath,
});

const SearchParams = Type.Object({
	query: Type.String({
		description: 'Symbol name or partial name (e.g., "auth", "signIn", "UserService")',
	}),
	kind: Type.Optional(
		Type.Union(
			[
				Type.Literal("function"),
				Type.Literal("method"),
				Type.Literal("class"),
				Type.Literal("interface"),
				Type.Literal("type"),
				Type.Literal("variable"),
				Type.Literal("route"),
				Type.Literal("component"),
			],
			{ description: "Filter by node kind" },
		),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum results (default: 10)", default: 10 })),
	projectPath: ProjectPath,
});

const CallersParams = Type.Object({
	symbol: Type.String({ description: "Name of the function, method, or class to find callers for" }),
	file: Type.Optional(
		Type.String({
			description:
				"Narrow to the definition in this file (path or suffix) when several same-named symbols exist " +
				"(e.g. one UserService per app in a monorepo)",
		}),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of callers to return (default: 20)", default: 20 })),
	projectPath: ProjectPath,
});

const EXPLORE_DESCRIPTION =
	"PRIMARY TOOL — call FIRST for almost any question OR before an edit: how does X work, architecture, a bug, " +
	"where/what is X, surveying an area, or the symbols you are about to change. Returns the verbatim source of the " +
	"relevant symbols grouped by file in ONE capped call (Read-equivalent — treat the shown source as already Read; " +
	"do NOT re-open those files), plus the call path among them. Query can be a natural-language question OR a bag of " +
	"symbol/file names. Usually the ONLY call you need — more accurate context, in far fewer tokens and round-trips " +
	"than a search/Read/Grep loop.";

const NODE_DESCRIPTION =
	"Two modes. (1) READ A FILE — use INSTEAD of the Read tool: pass `file` (a path or basename) with no `symbol` and " +
	"it returns that file's current on-disk source with line numbers, exactly the shape Read gives you (`<n>\\t<line>`, " +
	"safe to Edit from), narrowable with `offset`/`limit` just like Read — PLUS a one-line note of which files depend " +
	"on it. Same bytes as Read, faster (served from the index), with the blast radius attached. Use it whenever you " +
	"would Read a source file. (2) ONE SYMBOL you can name — its location, signature, verbatim source (includeCode=true) " +
	"and caller/callee trail in one call, so before changing it you see what calls it and what your edit would break. " +
	"For an AMBIGUOUS name it returns EVERY matching definition's body in one call (so you never Read a file to find " +
	"the right overload); pass `file`/`line` to pin one. Use codegraph_explore for several related symbols or the full flow.";

const SEARCH_DESCRIPTION =
	"Quick symbol search by name. Returns locations only (no code). Use codegraph_explore instead to get the actual " +
	"source / understand an area in one call.";

const CALLERS_DESCRIPTION =
	"List functions that call <symbol> — the complete call-site list with file:line, including where a function is " +
	"registered as a callback (passed as an argument, assigned to a field, listed in a handler table; labeled " +
	"'via callback registration') — so a function with no direct calls is NOT dead if it's wired up somewhere. When " +
	"several UNRELATED symbols share a name, it reports one section per definition; pass `file` to focus the definition " +
	"you mean. For the full flow, use codegraph_explore.";

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

interface ToolContext {
	cwd?: string;
}

function makeExecute(toolName: string) {
	return async function execute(
		_toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		_onUpdate: unknown,
		ctx: ToolContext,
	): Promise<AgentToolResult> {
		const cwd = ctx.cwd && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
		const start = Date.now();

		// Pass through only the fields the model actually provided; the server
		// applies its own defaults for omitted optional fields.
		const args: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined && value !== null) args[key] = value;
		}

		try {
			const client = await getSession(cwd);
			const text = await client.callTool(toolName, args, signal);
			return {
				content: [{ type: "text", text }],
				details: { tool: toolName, cwd, elapsedMs: Date.now() - start },
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [{ type: "text", text: `codegraph ${toolName} failed: ${message}` }],
				details: { tool: toolName, cwd, elapsedMs: Date.now() - start },
				isError: true,
			};
		}
	};
}

export default function codegraphExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "codegraph_explore",
		label: "Codegraph Explore",
		description: EXPLORE_DESCRIPTION,
		parameters: ExploreParams,
		execute: makeExecute("codegraph_explore"),
	});

	pi.registerTool({
		name: "codegraph_node",
		label: "Codegraph Node",
		description: NODE_DESCRIPTION,
		parameters: NodeParams,
		execute: makeExecute("codegraph_node"),
	});

	pi.registerTool({
		name: "codegraph_search",
		label: "Codegraph Search",
		description: SEARCH_DESCRIPTION,
		parameters: SearchParams,
		execute: makeExecute("codegraph_search"),
	});

	pi.registerTool({
		name: "codegraph_callers",
		label: "Codegraph Callers",
		description: CALLERS_DESCRIPTION,
		parameters: CallersParams,
		execute: makeExecute("codegraph_callers"),
	});

	// pi tears down the extension runtime on quit, reload, and session
	// replacement — this is where the spawned MCP server gets killed.
	pi.on("session_shutdown", () => {
		const current = session;
		session = null;
		sessionCwd = null;
		current?.dispose();
	});
}
