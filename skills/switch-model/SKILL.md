---
name: switch-model
description: 快速切换 pi 模型 provider profile(deepseek / zhipu / zhipu-coding-personal / zhipu-coding-company),一条命令批量改写 settings.json 默认模型/推理强度 + agents/ 下 scout/planner/reviewer/worker 的 model 和 thinking 定义。当用户说"切换模型""换模型""切到 xxx""用 xxx 跑""调推理强度"时使用。
---

# 切换模型 profile

脚本 `~/.pi/agent/switch-model.sh` 一条命令改两类:
1. `settings.json` 的 `defaultProvider` + `defaultModel` + `defaultThinkingLevel`
2. `agents/*.md` 每个角色的 `model:` 和 `thinking:` 行(profile.agents 列出的所有角色,缺失则新增)

## 模板机制(重要)

profile 影响的文件是**机器本地派生物,不进 git**:

| git 跟踪(模板) | 本地生成(实际,gitignored) |
|---|---|
| `settings.json.example` | `settings.json` |
| `agents/<role>.md.example` | `agents/<role>.md` |

- 脚本始终从 `.example` 模板生成实际文件:模板基底 + profile 字段;settings 额外保留实际文件中模板没有的运行时键(如 `lastChangelogVersion`)
- 各机器可持有不同 provider,模板同步不再冲突(irail=公司 plan,Windows=个人 plan)
- **改共享配置(角色 prompt / packages / theme)→ 改 `.example` 文件**,commit 后各机器 `git pull && switch-model.sh refresh` 同步
- **新机器引导**:clone 后先跑 `bash switch-model.sh <profile>` 生成全部实际文件

## 用法

```bash
bash ~/.pi/agent/switch-model.sh                      # 列出当前 + 所有 profile 的角色映射
bash ~/.pi/agent/switch-model.sh deepseek             # 切到 deepseek
bash ~/.pi/agent/switch-model.sh zhipu                # 切到 zhipu
bash ~/.pi/agent/switch-model.sh zhipu-coding-personal
bash ~/.pi/agent/switch-model.sh zhipu-coding-company
bash ~/.pi/agent/switch-model.sh refresh              # 检测当前 profile,从 .example 重新生成实际文件
```

## profile 定义(~/.pi/agent/model-profiles.json)

每个 profile 含:
- `provider` / `model` / `thinking` → 写入 settings.json 默认 provider/模型/推理强度
- `agents` → 角色到 `{ model, thinking }` 的映射,写入对应 `agents/<role>.md` 的 frontmatter

| profile | 主力(pro / thinking) | 快速(flash / thinking) |
|---------|----------------------|------------------------|
| deepseek | deepseek/deepseek-v4-pro / high | deepseek/deepseek-v4-flash / low |
| zhipu | zhipu/glm-5.2 / high | zhipu/glm-4.7 / low |
| zhipu-coding-personal | zhipu-coding-personal/glm-5.2 / high | zhipu-coding-personal/glm-4.7 / low |
| zhipu-coding-company | zhipu-coding-company/glm-5.2 / high | zhipu-coding-company/glm-4.7 / low |

角色分工(默认):`scout` 用快速档(low),`planner`(medium)/ `reviewer` / `worker`(high)用主力档。`Explore` 不在 profile 里,由 glla 管理(继承父模型)。

thinking 合法取值:off / minimal / low / medium / high / xhigh / max。

## 注意事项

- 脚本改的是**默认值**:对新会话、之后新 spawn 的子 agent 生效。
- **当前正在跑的会话不会自动切**,要立刻换模型/推理强度用 `/model`。
- 切换会显式给 planner / reviewer / worker 写死 `model:` 和 `thinking:`(不再继承父模型);若某角色想保持继承,把该角色从 `profile.agents` 里删掉即可。
- `Explore.md` 由 pi-goal-list-loop-audit 管理,已从 profile 移除;switch 不碰它,Explore 继承父模型。若想显式控制 Explore,在 `/glla` 把 subagent strategy 调成 agent-default 并手动加回 profile。
- 只调某个角色的推理强度而不换模型:直接改 `model-profiles.json` 里该角色的 `thinking`,再切一次(幂等)。
- 直接编辑 `agents/<role>.md` 的改动会在下次切换/refresh 时被模板覆盖——持久改动必须写进 `.example`。
- 用户只说"切到 zhipu"没给全名时,先无参列出,再按意图选。
- 切换幂等,重复切同一 profile 无副作用。
