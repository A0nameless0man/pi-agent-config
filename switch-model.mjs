#!/usr/bin/env node
/**
 * switch-model.mjs — 快速切换 pi 模型 provider profile,批量改写所有子 agent 定义。
 *
 * 一条命令改:
 *   1. settings.json: defaultProvider / defaultModel / defaultThinkingLevel
 *   2. agents/<role>.md: 每个角色的 model: 与 thinking: 行(缺失则新增)
 *
 * 用法:
 *   node switch-model.mjs            # 列出当前 + 可用 profile
 *   node switch-model.mjs <profile>  # 切换
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const PROFILES_PATH = path.join(dir, "model-profiles.json");
const SETTINGS_PATH = path.join(dir, "settings.json");
const AGENTS_DIR = path.join(dir, "agents");

async function readJson(p) {
  return JSON.parse(await readFile(p, "utf8"));
}

/**
 * 在 markdown 的 YAML frontmatter 里替换/新增若干 key: value 行,保留原行尾
 * (CRLF/LF) 与其余内容。若文件没有 frontmatter(前后两个 ---),返回 changed=false。
 */
function setFrontmatterKeys(md, keys) {
  const eol = md.includes("\r\n") ? "\r\n" : "\n";
  const lines = md.split(/\r?\n/);
  const open = lines.findIndex((l) => l === "---");
  if (open === -1) return { md, changed: false };
  const close = lines.findIndex((l, i) => i > open && l === "---");
  if (close === -1) return { md, changed: false };

  const fm = lines.slice(open + 1, close);
  const seen = new Set();
  const body = [];
  for (const line of fm) {
    const m = line.match(/^([A-Za-z0-9_-]+):/);
    if (m && m[1] in keys) {
      seen.add(m[1]);
      body.push(`${m[1]}: ${keys[m[1]]}`);
    } else {
      body.push(line);
    }
  }
  for (const [k, v] of Object.entries(keys)) {
    if (!seen.has(k)) body.push(`${k}: ${v}`);
  }

  const out = [...lines.slice(0, open + 1), ...body, ...lines.slice(close)];
  return { md: out.join(eol), changed: true };
}

async function main() {
  const profiles = await readJson(PROFILES_PATH);
  const target = process.argv[2];

  // 无参:列出当前默认 + 每个 profile 的完整角色映射,不修改任何文件
  if (!target) {
    const settings = await readJson(SETTINGS_PATH);
    console.log(`Current default: ${settings.defaultProvider}/${settings.defaultModel} (thinking: ${settings.defaultThinkingLevel ?? "?"})`);
    console.log("");
    console.log("Available profiles:");
    for (const [name, p] of Object.entries(profiles)) {
      const active = p.provider === settings.defaultProvider && p.model === settings.defaultModel;
      console.log(`  ${name}${active ? " (active)" : ""}`);
      console.log(`    main: ${p.provider}/${p.model} (thinking: ${p.thinking ?? "?"})`);
      for (const [role, spec] of Object.entries(p.agents ?? {})) {
        console.log(`      ${role}: ${spec.model} (thinking: ${spec.thinking ?? "-"})`);
      }
    }
    return;
  }

  const profile = profiles[target];
  if (!profile) {
    console.error(`Error: profile not found: ${target}`);
    console.error("");
    console.error("Available profiles:");
    for (const name of Object.keys(profiles)) console.error(`  ${name}`);
    process.exitCode = 1;
    return;
  }

  // 1) settings.json — 只改默认 provider/model/thinking,保留其余字段与末尾换行状态
  const settingsRaw = await readFile(SETTINGS_PATH, "utf8");
  const settings = JSON.parse(settingsRaw);
  settings.defaultProvider = profile.provider;
  settings.defaultModel = profile.model;
  if (profile.thinking) settings.defaultThinkingLevel = profile.thinking;
  const trailing = settingsRaw.endsWith("\n") ? "\n" : "";
  await writeFile(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}${trailing}`, "utf8");

  // 2) 批量改写每个角色的 model: 与 thinking: 行
  const results = [];
  for (const [role, spec] of Object.entries(profile.agents ?? {})) {
    const keys = {};
    if (spec.model) keys.model = spec.model;
    if (spec.thinking) keys.thinking = spec.thinking;
    if (Object.keys(keys).length === 0) {
      results.push(`  ${role}: SKIP (no model/thinking)`);
      continue;
    }
    const file = path.join(AGENTS_DIR, `${role}.md`);
    let md;
    try {
      md = await readFile(file, "utf8");
    } catch {
      results.push(`  ${role}: SKIP (no ${role}.md)`);
      continue;
    }
    const { md: next, changed } = setFrontmatterKeys(md, keys);
    if (!changed) {
      results.push(`  ${role}: SKIP (no frontmatter)`);
      continue;
    }
    await writeFile(file, next, "utf8");
    results.push(`  ${role}: ${spec.model ?? "-"} (thinking: ${spec.thinking ?? "-"})`);
  }

  console.log(`Switched to: ${target}`);
  console.log(`  default: ${profile.provider}/${profile.model} (thinking: ${profile.thinking ?? "-"})`);
  for (const r of results) console.log(r);
  console.log("Note: 对新会话 / 之后新 spawn 的子 agent 生效;当前会话立刻换用 /model。");
}

main().catch((e) => {
  console.error(`switch-model: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
});
