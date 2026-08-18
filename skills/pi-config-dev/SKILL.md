---
name: pi-config-dev
description: 维护 ~/.pi/agent 多机配置仓库（pi-agent-config）时使用——修改共享配置/settings/packages、profile 切换、多机同步、新机器冷启动、key 分发。触发词：改 .example、switch-model、refresh、同步到某机器、新机器装 pi、配置仓库提交、install.sh
---

# pi-agent-config 仓库维护

`~/.pi/agent` 是 git clone 的多机同步配置仓库（A0nameless0man/pi-agent-config）。
机器清单、各机 profile、内网 endpoint 等敏感细节见 openviking 记忆
`viking://user/hugua/memories/entities/irail_pi_deployment.md`（本 skill 是公开仓库文件，不放 IP/key）。

## 仓库结构：模板与派生文件

git 只跟踪**模板与源码**；实际生效文件是**机器本地派生物，gitignored**：

| git 跟踪 | 本地生成（不入库） |
|---|---|
| `settings.json.example` | `settings.json`（switch-model 生成） |
| `agents/{planner,reviewer,scout,worker}.md.example` | `agents/<role>.md`（switch-model 生成） |
| `models.json.example`（仅公开标准 provider） | `models.json`（可含内网自建 provider） |
| `skills/`、`extensions/`、`install.sh`、`switch-model.*` | `auth.json`、`extensions/openviking-memory/openviking-config.json`、`skills/glm-plan-usage/team.json` |

**核心规则：持久改动必须写 `.example` 模板**。直接编辑实际文件（settings.json、agents/*.md）
会在下次 switch-model / refresh 时被模板覆盖。

## 同步工作流（日常）

```
Windows（改模板/加 skill/插件源码）
  → git push（commit 规范见 AGENTS.md；公开仓库严禁 key/IP）
  → 各 Linux 机器: cd ~/.pi/agent && git pull && bash switch-model.sh refresh
```

- refresh 自动检测激活 profile 并从模板重新生成实际文件
- packages 新增（如 `npm:pi-sessions`）要写进 `settings.json.example` 的 packages 数组，
  各机 pull + refresh 后 pi 启动时自动安装（或手动 `pi install npm:<pkg>`）
- github.com:443 在部分内网机器**间歇性阻断**：pull 失败静默重试 2-3 轮（GnuTLS -110 /
  超时属预期）；install.sh HTTPS 克隆失败会自动退试 SSH remote，也可 `PI_AGENT_REPO_URL` 覆盖

## 新机器冷启动

install.sh 幂等，完成 preflight → 装 pi → 克隆 → auth.json → models.json →
switch-model → openviking → 冒烟：

```bash
curl -fsSL https://raw.githubusercontent.com/A0nameless0man/pi-agent-config/main/install.sh | bash -s -- <profile> --key <KEY> --ov-endpoint <URL> --ov-key <OVKEY>
```

从另一台已配置机器远程喂（本地已有仓库时 `cat install.sh | ssh host 'bash -s -- ...'`）。

**key 安全中转模式**（key 不得出现在命令行参数/会话输出/中间落盘）：

```bash
# 1) 从权威机器读出，经 stdin 写入远端受保护临时文件
printf '%s\n%s\n' "$ZKEY" "$OVK" | ssh <host> 'umask 077; cat > /tmp/.pi-sync-keys'
# 2) 远端解包成变量、组装 argv、立即删除
ssh <host> 'ZKEY=$(sed -n 1p /tmp/.pi-sync-keys); OVK=$(sed -n 2p /tmp/.pi-sync-keys); rm -f /tmp/.pi-sync-keys; bash -s -- <profile> --key "$ZKEY" ...'
```

## 已知坑

- **auth.json 格式**：value 必须是对象 `{"key":"...","type":"api_key"}`，裸 string 会导致
  "No models available"
- **settings.json 不配 shellPath**：显式 Windows 路径会随 git 同步到 Linux 导致 bash 工具失效
- **环境变量类 key**（如 BOCHA_API_KEY）：各机 `~/.bashrc` 追加 export 并 `chmod 600`，
  传输同上节中转模式
- **gitignored 的本地配置文件**（team.json / openviking-config.json / auth.json）不在
  install.sh 覆盖范围内，冷启动后需单独分发
- Windows 无 tmux：pi-sessions 需 `sessions.subagents.enable:false`（本地 settings.json 覆盖，
  不进模板）；Linux 机器全功能

## 提交规范

本仓库 commit 遵循全局 AGENTS.md 的 git 节（conventional + 中文 + Co-Authored-By 双 trailer）。
注意这是公开仓库：提交前自查 diff 无 key、内网 IP、域名拓扑。
