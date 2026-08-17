# pi 配置仓库

个人 [pi](https://github.com/earendil-works/pi-coding-agent) coding agent 的配置集合，包含：

- `AGENTS.md` — 全局行为规则与多 Agent 协作策略
- `agents/` — 自定义 subagent 角色定义
- `skills/` — 可复用技能（bug 修复、文档处理、TDD 等）
- `extensions/` — 扩展（codegraph、openviking-memory、plan-mode 等）
- `settings.json` — pi 设置
- `bin/switch-model.sh` — 快速切换默认模型集合的脚本

## 安装

### 全新机器一行冷启动

```bash
curl -fsSL https://raw.githubusercontent.com/A0nameless0man/pi-agent-config/main/install.sh \
  | bash -s -- <profile> --key <API-KEY>
```

脚本自动完成:检查 git/Node≥20 → 克隆本仓库到 `~/.pi/agent` → 安装 pi
(npm 全局,Linux 无权限时自动 sudo)→ 生成 `auth.json`(按 provider 合并)
→ 从 `models.json.example` 生成 `models.json`(保留本机额外 provider)→
`switch-model.sh <profile>` 生成派生文件 → 可选配置 openviking → 冒烟测试。

profile 取值: `deepseek` / `zhipu` / `zhipu-coding-personal` / `zhipu-coding-company`
(见 `model-profiles.json`)。交互环境也可省略参数由菜单引导:

```bash
git clone https://github.com/A0nameless0man/pi-agent-config.git ~/.pi/agent
bash ~/.pi/agent/install.sh
```

幂等:已有机器可重复运行(拉取更新、保留本机已有 key / 内网 provider);
更多选项见 `bash install.sh --help`。

### 手动安装(不推荐)

克隆到 `~/.pi/agent/` 后手动复制各 `.example` 并填值,再跑
`bash switch-model.sh <profile>`。

## 配置密钥

仓库**不含任何真实密钥**。`install.sh` 会按需生成以下文件;手动操作则复制
示例并填入真实值:

```bash
cp auth.json.example auth.json
cp models.json.example models.json
cp extensions/openviking-memory/openviking-config.example.json \
   extensions/openviking-memory/openviking-config.json
```

`models.json.example` 仅含 4 个标准 provider(公开 API 地址,无 key);
内网自建 provider(如 `bjf-local`)不进模板,各机器自行维护。

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
