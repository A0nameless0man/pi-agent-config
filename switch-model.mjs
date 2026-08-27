#!/usr/bin/env node
/**
 * switch-model.mjs — 快速切换 pi 模型 provider profile,批量改写所有子 agent 定义。
 *
 * 模板机制(2026-08 重构):profile 影响的文件不再直接进 git,git 只跟踪 .example
 * 模板;实际文件(settings.json / agents/<role>.md)由本脚本从模板 + profile 派生,
 * 属于机器本地状态(gitignored)。这样各机器可持有不同 provider,同步模板不再冲突。
 *
 *   模板(tracked)             实际文件(untracked, gitignored)
 *   settings.json.example  →  settings.json
 *   agents/<role>.md.example → agents/<role>.md     (role ∈ profile.agents)
 *   models.json.example    →  models.json          (深合并:标准 provider 以模板为准,
 *                          本地独有 provider 如内网自建保留)
 *
 * 生成规则:
 *   agents/<role>.md   = 模板内容 + frontmatter 的 model:/thinking: 替换为 profile 值
 *   settings.json      = 模板为基底;保留实际文件中模板没有的键(如 lastChangelogVersion
 *                        等 pi 运行时写入的字段);再覆盖 defaultProvider/
 *                        defaultModel/defaultThinkingLevel 为 profile 值
 *   models.json        = 本地基底,模板各 provider 定义整体覆盖(新模型随模板传播),
 *                        仅本地独有 provider 保留。缺口背景:2026-08-27 irail
 *                        visual agent 读图失败——模板加了 glm-5.3-flash 但本地
 *                        models.json 停留在旧版,refresh 不覆盖导致模型未注册。
 *
 * 用法:
 *   node switch-model.mjs                     # 列出当前 + 可用 profile
 *   node switch-model.mjs <profile>           # 切换:从 .example 重新生成实际文件
 *   node switch-model.mjs refresh             # 检测当前激活 profile,从 .example 重新
 *                                             # 生成实际文件(同步模板改动用)
 *
 * 新机器引导:clone 后先运行 `bash switch-model.sh <profile>` 生成全部实际文件。
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const PROFILES_PATH = path.join(dir, "model-profiles.json");
const SETTINGS_EXAMPLE = path.join(dir, "settings.json.example");
const SETTINGS_PATH = path.join(dir, "settings.json");
const AGENTS_DIR = path.join(dir, "agents");
const MODELS_EXAMPLE = path.join(dir, "models.json.example");
const MODELS_PATH = path.join(dir, "models.json");

async function readJson(p) {
  return JSON.parse(await readFile(p, "utf8"));
}

async function readIfExists(p) {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
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

/** 实际 settings.json 是否存在 → 用于运行时字段保留与激活 profile 检测 */
async function readActualSettings() {
  const raw = await readIfExists(SETTINGS_PATH);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 按 provider+model 匹配唯一 profile;不匹配返回 null */
function detectActiveProfile(profiles, settings) {
  if (!settings) return null;
  const hits = Object.entries(profiles).filter(
    ([, p]) => p.provider === settings.defaultProvider && p.model === settings.defaultModel,
  );
  return hits.length === 1 ? hits[0][0] : null;
}

/**
 * models.json 深合并:本地基底 + 模板标准 provider 整体覆盖,本地独有 provider 保留。
 * 目的:模板新增/升级模型(如 glm-5.3-flash 多模态)随 refresh 传播到各机器,
 * 不再依赖人工拷贝。models.json 损坏时跳过并警告,不静默覆盖以防丢本地内容。
 */
async function syncModelsJson() {
  const exampleRaw = await readIfExists(MODELS_EXAMPLE);
  if (exampleRaw === null) return "  models.json: SKIP (缺少 models.json.example,请先 git pull)";
  const exampleProviders = JSON.parse(exampleRaw).providers ?? {};

  const actualRaw = await readIfExists(MODELS_PATH);
  let actual = null;
  if (actualRaw !== null) {
    try {
      actual = JSON.parse(actualRaw);
    } catch {
      return "  models.json: SKIP (本地文件 JSON 解析失败,请人工检查后重试)";
    }
  }

  // 展开顺序:本地在前 → 模板同者覆盖;本地独有 provider 自然保留
  const merged = { ...(actual ?? {}), providers: { ...(actual?.providers ?? {}), ...exampleProviders } };
  const next = `${JSON.stringify(merged, null, 2)}\n`;
  if (next === actualRaw) return "  models.json: SKIP (已与模板一致)";

  await writeFile(MODELS_PATH, next, "utf8");
  const exCount = Object.keys(exampleProviders).length;
  const localOnly = Object.keys(actual?.providers ?? {}).filter((p) => !(p in exampleProviders));
  const suffix = localOnly.length ? `,保留本地独有: ${localOnly.join(", ")}` : "";
  return `  models.json: 已同步 ${exCount} 个标准 provider${suffix}`;
}

/**
 * 核心:从 .example 模板 + profile 重新生成 settings.json 与 agents/<role>.md。
 * 实际文件是派生物——切换与 refresh 走同一条路径,保证语义一致。
 */
async function applyProfile(profiles, name) {
  const profile = profiles[name];
  if (!profile) {
    throw new Error(`profile not found: ${name}`);
  }

  // 模板必须存在(随 git 分发);缺失说明 clone 不完整
  const exampleRaw = await readIfExists(SETTINGS_EXAMPLE);
  if (exampleRaw === null) {
    throw new Error(`缺少模板 ${path.basename(SETTINGS_EXAMPLE)},请先 git pull`);
  }

  // 1) settings.json = 模板基底 + 实际文件独有的运行时键 + profile 字段
  const settings = JSON.parse(exampleRaw);
  const actual = await readActualSettings();
  if (actual) {
    for (const [k, v] of Object.entries(actual)) {
      if (!(k in settings)) settings[k] = v;
    }
  }
  settings.defaultProvider = profile.provider;
  settings.defaultModel = profile.model;
  if (profile.thinking) settings.defaultThinkingLevel = profile.thinking;
  const trailing = exampleRaw.endsWith("\n") ? "\n" : "";
  await writeFile(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}${trailing}`, "utf8");

  // 2) agents/<role>.md = 模板 + frontmatter model:/thinking: 替换
  const results = [];
  for (const [role, spec] of Object.entries(profile.agents ?? {})) {
    const keys = {};
    if (spec.model) keys.model = spec.model;
    if (spec.thinking) keys.thinking = spec.thinking;
    if (Object.keys(keys).length === 0) {
      results.push(`  ${role}: SKIP (profile 未定义 model/thinking)`);
      continue;
    }
    const examplePath = path.join(AGENTS_DIR, `${role}.md.example`);
    const md = await readIfExists(examplePath);
    if (md === null) {
      results.push(`  ${role}: SKIP (缺少 ${role}.md.example)`);
      continue;
    }
    const { md: next, changed } = setFrontmatterKeys(md, keys);
    if (!changed) {
      results.push(`  ${role}: SKIP (模板无 frontmatter)`);
      continue;
    }
    await writeFile(path.join(AGENTS_DIR, `${role}.md`), next, "utf8");
    results.push(`  ${role}: ${spec.model ?? "-"} (thinking: ${spec.thinking ?? "-"})`);
  }

  // 3) models.json 深合并(新模型随模板传播,本地独有 provider 保留)
  results.push(await syncModelsJson());

  return { results, actual };
}

async function main() {
  const profiles = await readJson(PROFILES_PATH);
  const target = process.argv[2];

  // 无参:列出当前默认 + 每个 profile 的完整角色映射,不修改任何文件
  if (!target) {
    const settings = await readActualSettings();
    if (!settings) {
      console.log("尚未生成 settings.json(新机器?先运行: bash switch-model.sh <profile>)");
    } else {
      console.log(
        `Current default: ${settings.defaultProvider}/${settings.defaultModel} (thinking: ${settings.defaultThinkingLevel ?? "?"})`,
      );
    }
    console.log("");
    console.log("Available profiles:");
    for (const [name, p] of Object.entries(profiles)) {
      const active =
        settings && p.provider === settings.defaultProvider && p.model === settings.defaultModel;
      console.log(`  ${name}${active ? " (active)" : ""}`);
      console.log(`    main: ${p.provider}/${p.model} (thinking: ${p.thinking ?? "?"})`);
      for (const [role, spec] of Object.entries(p.agents ?? {})) {
        console.log(`      ${role}: ${spec.model} (thinking: ${spec.thinking ?? "-"})`);
      }
    }
    console.log("");
    console.log("提示: 模板(.example)有更新后,运行 `switch-model.sh refresh` 重新生成实际文件。");
    return;
  }

  // refresh: 从实际 settings.json 检测激活 profile,再走统一生成路径
  let name = target;
  if (target === "refresh") {
    const settings = await readActualSettings();
    name = detectActiveProfile(profiles, settings);
    if (!name) {
      console.error("Error: 无法从 settings.json 唯一识别当前 profile(缺失或 provider/model 不匹配)");
      console.error("请显式指定: bash switch-model.sh <profile>");
      process.exitCode = 1;
      return;
    }
    console.log(`Detected active profile: ${name}`);
  } else if (!profiles[target]) {
    console.error(`Error: profile not found: ${target}`);
    console.error("");
    console.error("Available profiles:");
    for (const n of Object.keys(profiles)) console.error(`  ${n}`);
    process.exitCode = 1;
    return;
  }

  const profile = profiles[name];
  const { results } = await applyProfile(profiles, name);
  console.log(`${target === "refresh" ? "Refreshed" : "Switched to"}: ${name}`);
  console.log(`  default: ${profile.provider}/${profile.model} (thinking: ${profile.thinking ?? "-"})`);
  for (const r of results) console.log(r);
  console.log("Note: 对新会话 / 之后新 spawn 的子 agent 生效;当前会话立刻换用 /model。");
}

main().catch((e) => {
  console.error(`switch-model: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
});
