# pi 配置仓库

个人 [pi](https://github.com/earendil-works/pi-coding-agent) coding agent 的配置集合，包含：

- `AGENTS.md` — 全局行为规则与多 Agent 协作策略
- `agents/` — 自定义 subagent 角色定义
- `skills/` — 可复用技能（bug 修复、文档处理、TDD 等）
- `extensions/` — 扩展（codegraph、openviking-memory、plan-mode 等）
- `settings.json` — pi 设置
- `bin/switch-model.sh` — 快速切换默认模型集合的脚本

## 安装

克隆到本地后，将仓库内容放入 `~/.pi/agent/`（全局配置）或项目的
`.pi/agent/` 目录。

## 配置密钥

仓库**不含任何真实密钥**。按需复制示例文件并填入真实值：

```bash
cp auth.json.example auth.json
cp extensions/openviking-memory/openviking-config.example.json \
   extensions/openviking-memory/openviking-config.json
```

模型定义同样被排除（`models.json` / `models-store.json`），
因为其中可能包含内网地址与公司信息。若需共享，请自行脱敏后添加。

## 安全约定

以下内容通过 `.gitignore` 排除，**永不提交**：

| 文件 / 目录 | 原因 |
| --- | --- |
| `auth.json` | API 密钥 |
| `models.json` / `models-store.json` | 内网地址、公司信息 |
| `extensions/openviking-memory/openviking-config.json` | API 密钥 + 内网地址 |
| `sessions/` | 会话记录（含隐私） |
| `backup/`、`.codegraph/`、`.pi-glla/` | 本地运行时状态 |
| `npm/`、`git/` | 第三方依赖与克隆仓库 |
| `bin/fd.exe` | 第三方二进制 |

提交前请确认没有意外加入敏感文件：

```bash
git status --short
git diff --cached --name-only
```

## 许可

[MIT](./LICENSE)
