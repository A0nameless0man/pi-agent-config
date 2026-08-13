---
name: switch-model
description: 快速切换 pi 模型 provider profile(deepseek / zhipu / zhipu-coding-personal / zhipu-coding-company),一条命令批量改写 settings.json 默认模型/推理强度 + agents/ 下所有子 agent 的 model 和 thinking 定义。当用户说"切换模型""换模型""切到 xxx""用 xxx 跑""调推理强度"时使用。
---

# 切换模型 profile

脚本 `~/.pi/agent/switch-model.sh` 一条命令改两类:
1. `settings.json` 的 `defaultProvider` + `defaultModel` + `defaultThinkingLevel`
2. `agents/*.md` 每个角色的 `model:` 和 `thinking:` 行(profile.agents 列出的所有角色,缺失则新增)

## 用法

```bash
bash ~/.pi/agent/switch-model.sh                      # 列出当前 + 所有 profile 的角色映射
bash ~/.pi/agent/switch-model.sh deepseek             # 切到 deepseek
bash ~/.pi/agent/switch-model.sh zhipu                # 切到 zhipu
bash ~/.pi/agent/switch-model.sh zhipu-coding-personal
bash ~/.pi/agent/switch-model.sh zhipu-coding-company
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

角色分工(默认):`scout` / `Explore` 用快速档(low),`planner`(medium)/ `reviewer` / `worker`(high)用主力档。

thinking 合法取值:off / minimal / low / medium / high / xhigh / max。

## 注意事项

- 脚本改的是**默认值**:对新会话、之后新 spawn 的子 agent 生效。
- **当前正在跑的会话不会自动切**,要立刻换模型/推理强度用 `/model`。
- 切换会显式给 planner / reviewer / worker 写死 `model:` 和 `thinking:`(不再继承父模型);若某角色想保持继承,把该角色从 `profile.agents` 里删掉即可。
- `Explore.md` 是 pi-goal-list-loop-audit 管理的;若 glla 之后重新同步覆盖了它,在 `/glla` 把 subagent strategy 调成 agent-default,或把 Explore 从 profile 里删掉。
- 只调某个角色的推理强度而不换模型:直接改 `model-profiles.json` 里该角色的 `thinking`,再切一次(幂等),或直接编辑对应 `agents/<role>.md` 的 `thinking:` 行。
- 用户只说"切到 zhipu"没给全名时,先无参列出,再按意图选。
- 切换幂等,重复切同一 profile 无副作用。
