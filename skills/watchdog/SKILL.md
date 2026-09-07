---
name: watchdog
description: 长时间任务（大型编译、机器学习训练、自动消融实验等十几分钟到数天任务）的分级看门狗监视。阻塞式 bash 调度框架按"开始密、后续宽"的曲线定期执行三类可插拔检查——内建机械探针（进程存活/完成失败信号/输出停滞/资源/指标平台期）、自定义机械脚本（--check-cmd）、智能巡检（--ai-cmd 直接调 pi -p），任一异常立即退出报警。跑长任务需要盯进度、过夜实验、批量实验编排、任务卡死检测时使用。
---

# Watchdog：长任务分级监视

## 本质：一个定期执行若干脚本的调度框架

`scripts/watchdog.sh loop` 是一个**阻塞式 bash 调用**：按调度曲线（开始密、后续宽、超时嫌疑重新加密）定期执行三类可插拔检查项，**任一检查发现异常立即输出报警并退出**（退出码区分异常类型）。正常时永不退出，所以工具调用返回即事件。

| 检查项 | 挂载方式 | 成本 | 判定异常的方式 |
|---|---|---|---|
| 内建机械探针 | init 时配置（存活/正则/停滞/指标） | 零 AI token | 状态机（见退出码表） |
| 自定义机械脚本 | `--check-cmd '<bash>'` | 零 AI token | 脚本非零退出码 |
| 智能巡检 agent | `--ai-cmd '<pi -p ...>'` + `--ai-interval-sec S` | 每 S 秒一次调用 | 命令非零退出，或输出命中 `VERDICT: ABNORMAL/FAIL/ANOMALY`（`--ai-fail-re` 可改） |

机械探针每轮都跑；智能巡检按 `--ai-interval-sec`（一刻钟到几小时量级）到点才跑，且只在任务尚健康时执行。智能巡检的推荐形态是 headless 单次调用：

```bash
--ai-cmd 'pi -p --no-session "读取 /tmp/exp1/train.log 尾部 200 行与 /tmp/exp1/metrics.jsonl 的 loss 走势，对照预期（loss 应在 0.4~0.6 间平滑下降）。若出现 NaN/爆炸/原地震荡/数据耗尽/与预期不符，第一行输出 VERDICT: ABNORMAL: 原因；正常则第一行输出 VERDICT: OK。"'
--ai-interval-sec 900
```

巡检 prompt 必须给出：读什么文件、预期是什么、输出约定（第一行 VERDICT）。框架只认退出码和 VERDICT 正则，其余输出进 `ai_history.txt` 供人回看。

## 编排拓扑

**单实验**（主对话自己盯）：

```
主对话 ──bash(阻塞, timeout=expect×1.5)──> watchdog.sh loop
                                              ├─ 每轮: 内建探针 + check-cmd
                                              └─ 到点: pi -p 巡检agent ──异常──> loop 退出报警 ──> 主对话收到返回
```

**多实验**（批量消融/网格）：主对话把"搭建+运行+盯"整体交给实验子 agent，每子 agent 一个实验一个 loop，互不阻塞；子 agent 返回值即该实验的最终报告。

```
主对话 ──派N个实验子agent──> 子agent i: 搭实验 → 起任务 → watchdog.sh loop（阻塞） ──报警/完成──> 子agent 返回报告
```

主对话侧约定：所有实验子 agent 并行派发（一条消息多个 Agent 调用），收齐后汇总对比。

## 子 agent 内的标准调用序列

```bash
W=~/.pi/agent/skills/watchdog/scripts/watchdog.sh

# 1. 启动任务为分离进程（stdout/stderr 全重定向到日志），记录 PID
nohup bash train.sh > /tmp/exp1/train.log 2>&1 < /dev/null &
PID=$!

# 2. 登记监视档案
bash "$W" init --label exp1 --pid $PID --log /tmp/exp1/train.log \
  --expect-min 90 --stall-sec 600 \
  --done-re 'Training complete|saved final' \
  --fail-re 'Traceback \(most recent call last\)|CUDA out of memory|FATAL' \
  --metric-cmd 'tail -n1 /tmp/exp1/metrics.jsonl | jq -r .loss' \
  --ai-cmd 'pi -p --no-session "<巡检提示词，见上>"' --ai-interval-sec 900

# 3. 阻塞监视（异常即退出报警；此调用放在超时足够长的 bash 调用里）
bash "$W" loop exp1
```

`loop` 退出后：子 agent 视退出码决定动作——`done`(10) 读结果收尾；`failed`(11)/`dead`(13) 附上 `report` 材料包的日志尾部如实报告，**不自动重试**；`stalled`/`slow`/`plateau`/`ai_alert`(12/14/15/16) 把 `report` 材料包带回主对话由人裁决。处理完告警用 `ack exp1` 清除。

## 退出码与状态

| code | 状态 | 含义 | 动作分级 |
|---|---|---|---|
| 0 | running | 一切正常（loop 永不以此退出） | 继续等 |
| 10 | done | 命中完成信号 | 汇报成果 |
| 11 | failed | 命中失败信号 | 附日志尾部报告，勿自动重试 |
| 12 | stalled | 日志超过 stall-sec 未更新 | ADVISORY：查资源/挂载/死锁 |
| 13 | dead | 进程消失且无完成/失败信号 | 附日志尾部报告 |
| 14 | slow | 超期望时长 1.2×（加密观察）/ 2×（timeout_2x） | ADVISORY：确认加时长还是该杀 |
| 15 | plateau | 指标最近 10 个点相对变化 < 0.1% | ADVISORY：考虑早停 |
| 16 | ai_alert | 智能巡检（pi -p）报告异常 | 附 ai_history 与巡检结论报告 |
| 17 | check_failed | 自定义 check-cmd 非零退出 | 附 custom_check.last_error 报告 |

其它命令：`check`（单轮机械探针，退出码同表）、`ai-check`（单次智能巡检）、`status`（概览）、`report <label>`（巡检材料包：档案+流水+指标+资源+日志尾部）、`ack` / `stop` / `forget`。

状态目录 `${WATCHDOG_HOME:-~/.pi/watchdog}/<label>/`：task.json（档案）、timeline.jsonl（逐轮流水）、samples.txt（资源采样）、metric_history.txt（指标序列）、ai_history.txt（巡检记录）、custom_check.log、ALERT（存在即未确认告警）。

## 调度曲线

间隔按期望时长分档，起始基数每轮健康检查后 ×1.5 放宽至封顶；超过期望 1.2× 后回落基数（重新加密）：

| 期望时长 | 起始间隔 | 上限 |
|---|---|---|
| < 30 min | 60 s | 5 min |
| 30 min ~ 4 h | 2 min | 15 min |
| 4 ~ 24 h | 10 min | 1 h |
| > 24 h | 15 min | 2 h |

L2 检查点（期望时长的 20/50/80/110/150%）会在 timeline 中标记 `l2_due`，供外部编排参考；使用 `--ai-cmd` 时智能巡检本身按时间间隔独立触发。

## 边界与注意

- **观察不调度**：永不主动杀进程；SIGTERM/SIGKILL 留给子 agent 或人，且须给出证据（日志尾部+资源采样）。
- 子 agent 的 bash 工具 `timeout` 必须给足：建议 `expect_min × 60 × 1.5 + 300` 秒；loop 在任何异常/终态都会退出，不会空耗。
- `--fail-re` 宁缺毋滥：优先 Traceback / OOM / FATAL 这类强信号，避免日志里普通 "error" 误报。
- 巡检 prompt 与日志可能含敏感内容经 `pi -p` 外发模型：内网敏感实验自行权衡；`--ai-cmd` 也可换成任何本地判定命令。
- 值本身含双引号的正则不支持（task.json 存储转义限制）；含反斜杠的正则已正确保留。
- 资源采样（CPU/RSS）在 Windows Git Bash 下尽力而为（MSYS ps 受限），进度信号以日志增长与新鲜度为准；Linux 完整可用。
- 完成物契约：终态报告必须基于 `report` 材料包真实内容，禁止只转述"完成了"。
