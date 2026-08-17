#!/usr/bin/env node
/**
 * GLM Coding Plan 用量查询(pi 版)
 *
 * 移植自 https://github.com/zai-org/zai-coding-plugins (plugins/glm-plan-usage),Apache-2.0。
 * 相对上游的增强:自动读取 pi 的 settings.json/models.json/auth.json 定位当前 provider 的
 * key 与平台,无需手工设置环境变量;支持 --provider 切换账号;输出人类可读摘要。
 *
 * 端点(均为 GET,鉴权头为裸 token,非 Bearer):
 *   {base}/api/monitor/usage/model-usage?startTime=..&endTime=..
 *   {base}/api/monitor/usage/tool-usage?startTime=..&endTime=..
 *   {base}/api/monitor/usage/quota/limit
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};
const rawJson = args.includes('--json');
const hours = parseInt(flagValue('--hours') || '24', 10);
const noTeam = args.includes('--no-team');

const die = (msg) => {
  console.error(msg);
  process.exit(1);
};

// ---------- 1. key 与平台解析 ----------
const piDir = path.join(os.homedir(), '.pi', 'agent');
const readJsonSafe = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
};

const settings = readJsonSafe(path.join(piDir, 'settings.json')) || {};
const modelsCfg = readJsonSafe(path.join(piDir, 'models.json')) || {};
const authCfg = readJsonSafe(path.join(piDir, 'auth.json')) || {};
// 团队积分查询(type=2)所需的组织/项目头,来源:--org/--project > 环境变量 > skill 目录下 team.json(gitignore)
const skillDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const teamCfg = readJsonSafe(path.join(skillDir, 'team.json')) || {};

// key 优先级: --key > GLM_USAGE_KEY > ANTHROPIC_AUTH_TOKEN > auth.json[provider]
const provider = flagValue('--provider') || settings.defaultProvider || '';
const authEntry = authCfg[provider];
const authKeyFromStore =
  authEntry && typeof authEntry === 'object' ? authEntry.key :
  typeof authEntry === 'string' ? authEntry : null; // 兼容裸 string 格式

const key =
  flagValue('--key') ||
  process.env.GLM_USAGE_KEY ||
  process.env.ANTHROPIC_AUTH_TOKEN ||
  authKeyFromStore;

if (!key) {
  die(`Error: 未找到 key。provider="${provider}" 在 ${path.join(piDir, 'auth.json')} 中没有条目。
可选方案:
  node query-usage.mjs --provider zhipu-coding-personal
  node query-usage.mjs --key <your-key>
  export ANTHROPIC_AUTH_TOKEN=<your-key>`);
}

// baseUrl 优先级: GLM_USAGE_BASE_URL > ANTHROPIC_BASE_URL > models.json[provider].baseUrl > 按名字猜测
const providerBaseUrl =
  modelsCfg.providers && modelsCfg.providers[provider] && modelsCfg.providers[provider].baseUrl;
const baseUrl = process.env.GLM_USAGE_BASE_URL || process.env.ANTHROPIC_BASE_URL || providerBaseUrl || '';

let platform, monitorBase;
if (baseUrl.includes('api.z.ai')) {
  platform = 'ZAI';
  monitorBase = 'https://api.z.ai';
} else if (baseUrl.includes('bigmodel.cn')) {
  platform = 'ZHIPU';
  const u = new URL(baseUrl);
  monitorBase = `${u.protocol}//${u.host}`; // open. / dev. 均可
} else {
  // 未知 baseUrl:zhipu 系 provider 名回落到 open.bigmodel.cn,其余报错
  if (/zhipu|glm|bigmodel/i.test(provider)) {
    platform = 'ZHIPU';
    monitorBase = 'https://open.bigmodel.cn';
  } else {
    die(`Error: 无法识别平台。provider="${provider}" baseUrl="${baseUrl}" 不含 api.z.ai / bigmodel.cn。
请用 --key <key> 并设置 GLM_USAGE_BASE_URL=https://open.bigmodel.cn 或 https://api.z.ai`);
  }
}

// ---------- 2. 时间窗口:最近 N 小时(整点对齐,与上游一致) ----------
const now = new Date();
const end = new Date(now);
end.setMinutes(59, 59, 999);
const start = new Date(now.getTime() - hours * 3600 * 1000);
start.setMinutes(0, 0, 0);
const fmt = (d) => {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const get = (url, extraHeaders = null) =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          Authorization: key, // 裸 token,与上游一致,非 Bearer
          'Accept-Language': 'en-US,en',
          'Content-Type': 'application/json',
          ...(extraHeaders || {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch { /* 保持 null */ }
          // 注意:该 API 鉴权失败也返回 HTTP 200,需按业务码判断
          if (json && json.success === false) {
            reject(new Error(`业务错误 code=${json.code}: ${json.msg}`));
          } else {
            resolve(json ? json.data ?? json : data);
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });

const q = `?startTime=${encodeURIComponent(fmt(start))}&endTime=${encodeURIComponent(fmt(end))}`;
const msToLocal = (ms) => new Date(ms).toLocaleString();

const orgId = flagValue('--org') || process.env.GLM_ORG_ID || teamCfg.organization || '';
const projectId = flagValue('--project') || process.env.GLM_PROJECT_ID || teamCfg.project || '';
const teamHeaders =
  orgId && projectId
    ? { 'bigmodel-organization': orgId, 'bigmodel-project': projectId }
    : null;

// ---------- 3. 请求 + 摘要 ----------
const summarizeQuota = (data) => {
  const lines = [];
  for (const item of data.limits || []) {
    const pct = item.percentage ?? 0;
    const barLen = 20;
    const filled = Math.round((pct / 100) * barLen);
    const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);
    const reset = item.nextResetTime ? `重置于 ${msToLocal(item.nextResetTime)}` : '';
    if (item.type === 'TOKENS_LIMIT') {
      // unit=3(number=5) 为 5 小时窗口;unit=6(number=1) 为周窗口(语义由 customer-package-reset/list 的 weekResets 确认)
      const label = item.number === 5 ? 'Token 用量(5小时窗口)' : item.unit === 6 ? 'Token 用量(周窗口)' : `Token 用量(unit=${item.unit}, ${item.number})`;
      lines.push(`${label} ${bar} ${pct}%  ${reset}`);
    } else if (item.type === 'TIME_LIMIT') {
      lines.push(`MCP/工具用量(月度)    ${bar} ${pct}%  已用 ${item.currentValue ?? item.usage ?? 0}/${item.usage ?? '?'}  ${reset}`);
      for (const d of item.usageDetails || []) {
        lines.push(`  · ${d.modelCode}: ${d.usage}`);
      }
    } else {
      lines.push(`${item.type}: ${pct}% ${reset}`);
    }
  }
  if (data.level) lines.push(`档位 level: ${data.level}`);
  return lines.join('\n');
};

// type=2: 团队积分池(CREDIT_LIMIT)。必须带 bigmodel-organization + bigmodel-project 头,
// 任意组织成员的 API key 均可鉴权(非成员 key 或假 org 返回空 data)。缺任一头也返回空。
const summarizeTeamQuota = (data) => {
  const lines = [];
  if (!data || !data.limits || data.limits.length === 0) {
    return ['(无团队积分数据:检查 team.json 中 organization/project 是否有效、key 所属账号是否为组织成员)'];
  }
  for (const item of data.limits) {
    const pct = item.percentage ?? 0;
    const barLen = 20;
    const filled = Math.round((pct / 100) * barLen);
    const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);
    const reset = item.nextResetTime ? `重置于 ${msToLocal(item.nextResetTime)}` : '';
    const label = item.number === 5 ? '团队积分(5小时窗口)' : item.unit === 6 ? '团队积分(周窗口)' : `团队积分(unit=${item.unit}, ${item.number})`;
    lines.push(
      `${label} ${bar} ${pct}%  已用 ${item.currentValue ?? '?'} / ${item.usage ?? '?'}  ${reset}`
    );
  }
  if (data.level) lines.push(`档位 level: ${data.level}`);
  return lines.join('\n');
};

try {
  if (!rawJson) {
    console.log(`平台: ${platform}  provider: ${provider || '(env)'}  基址: ${monitorBase}`);
    console.log(`统计窗口: ${fmt(start)} ~ ${fmt(end)}(最近 ${hours}h,整点对齐)`);
    console.log('');
  }

  const [modelUsage, toolUsage, quota, teamQuota] = await Promise.all([
    get(`${monitorBase}/api/monitor/usage/model-usage${q}`),
    get(`${monitorBase}/api/monitor/usage/tool-usage${q}`),
    get(`${monitorBase}/api/monitor/usage/quota/limit`),
    // 团队积分池:--no-team 或未配置 org/project 时跳过
    noTeam || !teamHeaders
      ? Promise.resolve(null)
      : get(`${monitorBase}/api/monitor/usage/quota/limit?type=2`, teamHeaders),
  ]);

  if (rawJson) {
    console.log(JSON.stringify({ modelUsage, toolUsage, quota, teamQuota }, null, 2));
  } else {
    const t = modelUsage.totalUsage || {};
    console.log('—— 模型用量 ——');
    console.log(`总调用 ${t.totalModelCallCount ?? '?'} 次 / 总 tokens ${(t.totalTokensUsage ?? 0).toLocaleString()}`);
    for (const m of t.modelSummaryList || []) {
      console.log(`  · ${m.modelName}: ${(m.totalTokens ?? 0).toLocaleString()} tokens`);
    }
    console.log('');
    console.log('—— 工具用量 ——');
    const tu = toolUsage.totalUsage || {};
    console.log(`联网搜索 ${tu.totalNetworkSearchCount ?? 0} · web-reader ${tu.totalWebReadMcpCount ?? 0} · zread ${tu.totalZreadMcpCount ?? 0}`);
    for (const d of tu.toolDetails || []) console.log(`  · ${JSON.stringify(d)}`);
    console.log('');
    console.log('—— 配额 ——');
    console.log(summarizeQuota(quota));
    if (!noTeam) {
      if (teamHeaders) {
        console.log('');
        console.log('—— 团队积分(type=2,CREDIT_LIMIT)——');
        console.log(summarizeTeamQuota(teamQuota));
      } else {
        console.log('');
        console.log('(未配置团队 org/project,跳过团队积分查询;配置方法见 SKILL.md)');
      }
    }
  }
} catch (e) {
  die(`查询失败: ${e.message}`);
}
