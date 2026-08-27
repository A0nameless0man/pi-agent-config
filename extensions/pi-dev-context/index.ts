/**
 * pi-dev-context — 仅当 cwd 位于 ~/.pi/agent 内时注入配置维护专属指令
 *
 * 动机: pi 配置目录自身的维护说明(openviking 补丁、profile 派生规则等)若放在
 * 全局 AGENTS.md,会在所有项目的会话中占用上下文。本扩展把这些内容隔离到
 * PI-DEV.md,只在真正维护配置目录时附加到 system prompt。
 *
 * 为什么用 before_agent_start 而非 ~/.pi/AGENTS.md(向上遍历也能命中):
 * 内容随本仓库 git 同步,多机无需额外 cp 步骤。
 *
 * stale-ctx 防护(参考 openviking 扩展补丁教训): handler 全程同步
 * (readFileSync + 字符串拼接,无任何 await),不存在 session replacement
 * 后访问 stale ctx 的窗口。请勿在本 handler 中引入 await 后再访问 ctx。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
// 扩展位于 <agentDir>/extensions/pi-dev-context/,向上两级即配置根目录,
// 不硬编码 ~/.pi/agent —— 多机路径与重命名自动适配
const AGENT_DIR = dirname(dirname(EXT_DIR));
const CONTENT_FILE = join(EXT_DIR, "PI-DEV.md");

const DEBUG = process.env.PI_DEV_CONTEXT_DEBUG === "1";

function cwdInsideAgentDir(cwd: string): boolean {
  // path.win32.relative 大小写不敏感(实测),posix 本身路径敏感,无需额外归一化
  const rel = relative(AGENT_DIR, cwd);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function loadContent(): string | null {
  try {
    const content = readFileSync(CONTENT_FILE, "utf-8").trim();
    return content.length > 0 ? content : null;
  } catch {
    return null; // 文件缺失或不可读时静默跳过,fail-soft 不阻断会话
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event, ctx) => {
    const inside = cwdInsideAgentDir(ctx.cwd);
    const content = inside ? loadContent() : null;

    if (DEBUG) {
      console.error(
        `[pi-dev-context] EXT_DIR=${EXT_DIR} AGENT_DIR=${AGENT_DIR} cwd=${ctx.cwd} inside=${cwdInsideAgentDir(ctx.cwd)} injected=${content !== null}`,
      );
    }

    if (!content) return;

    // 复用 pi 内置 context file 的 <project_instructions> 呈现格式,
    // 让模型以同等权重对待(见 dist/core/system-prompt.js buildSystemPrompt)
    const extra =
      `\n\n<project_context>\n\n` +
      `Project-specific instructions and guidelines for the pi configuration directory ` +
      `(loaded only when working inside ${AGENT_DIR}):\n\n` +
      `<project_instructions path="${CONTENT_FILE}">\n${content}\n</project_instructions>\n\n` +
      `</project_context>\n`;

    return { systemPrompt: event.systemPrompt + extra };
  });
}
