---
name: glm-plan-usage
description: 查询 GLM Coding Plan 的配额与用量统计(5小时窗口/月度token额度/MCP工具额度/模型用量)。当用户询问"GLM 用量/配额/余额/还剩多少/coding plan usage/quota"时使用。支持个人版与团队版 key(--provider 可指定)。
---

# GLM Plan Usage

查询当前 GLM Coding Plan 账号的用量与配额。移植自 zai-org/zai-coding-plugins 的 glm-plan-usage 插件,适配 pi 配置体系。

## 使用方式

```bash
# 默认:自动使用 settings.json 的 defaultProvider 对应 key
node <skill目录>/scripts/query-usage.mjs

# 指定 provider(从 auth.json 取该 provider 的 key)
node <skill目录>/scripts/query-usage.mjs --provider zhipu-coding-company

# 环境变量覆盖(与上游 Claude Code 插件兼容)
ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic ANTHROPIC_AUTH_TOKEN=<key> node <skill目录>/scripts/query-usage.mjs
```

## 约束

- **只查询一次**,无论成败立即返回结果,不重试
- key 解析优先级:`--key` > 环境变量(`GLM_USAGE_KEY`/`ANTHROPIC_AUTH_TOKEN`) > `~/.pi/agent/auth.json` 中 `--provider`(默认取 settings.json 的 defaultProvider)的 key
- 平台识别:baseUrl 含 `api.z.ai` → ZAI;含 `bigmodel.cn` → ZHIPU(open/dev 均可)
- 输出中文摘要;`--json` 输出原始 JSON;`--hours N` 自定义统计窗口(默认 24)

## 团队积分查询(逆向发现)

个人/成员配额(默认 type=1)是 TOKENS_LIMIT;团队版真正的计费池是**积分制**,在 `type=2`(CREDIT_LIMIT,如 5h 窗口 35000 分/周窗口 155000 分)。该查询必须携带两个头:

```
bigmodel-organization: org-xxxxx
bigmodel-project: proj_xxxxx
```

来源优先级:`--org`/`--project` 参数 > `GLM_ORG_ID`/`GLM_PROJECT_ID` 环境变量 > skill 目录下 `team.json`(已被 .gitignore 排除,格式 `{"organization":"org-..","project":"proj_.."}`)。ID 从 bigmodel.cn 控制台团队页(F12 网络面板)获取。任意组织成员账号的 API key 均可鉴权;非成员 key 或假 org 返回空 `data:{}`。`--no-team` 可跳过。

注:官方插件只查 type=1(个人 token 配额),这就是"仅适用个人版"的由来;type=2 用 key+头即可查,无需浏览器 JWT。

## 其他已逆向端点(均可用裸 API key)

| 端点 | 说明 | 鉴权/参数 |
|---|---|---|
| `GET /api/monitor/credit-usage/usage-detail` | 积分维度模型用量(含缓存命中率、cached/uncached tokens 分解) | startTime/endTime/usageType=MODEL\|MCP/type=1;无需 org 头 |
| `GET /api/monitor/credit-usage/activity` | 日粒度活跃度(tokens/时长/连活天数) | startTime/endTime + 分页 |
| `GET /api/monitor/credit-usage/sub-account-rank` | 团队成员用量排行 | 需 org+proj 头;仅主账号可访问(成员 500 "仅企业主账号可访问成员排行榜") |
| `GET /api/biz/subscription/enterprise/v2/balance` | 团队现金/赠送余额 | 需 org+proj 头 |
| `GET /api/biz/customer-package-reset/list` | 5h/周限额重置历史(触发过限额才有记录;其字段名 fiveHourResets/weekResets 确认 unit=6=周) | targetType=TEAM\|PERSONAL;TEAM 需 org 头 |
| `GET /api/biz/customer/getCustomerInfo` | 账号信息+完整组织树(org/project ID 在此) | **仅 web JWT,API key 403** |

前端真相(bigmodel.cn bundle 逆向):org/project 头由 axios 拦截器从 localStorage(`Organizations`/`Proj...`)注入,纯客户端选择;不存在 key→组织 的服务端自动解析。同一账号的任意 key 均可查其所属组织的 type=2 积分。
