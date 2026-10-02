# acp — Active Context Pruning for pi

模型驱动的选择性上下文压缩扩展。移植自 [opencode-acp](https://github.com/ranxianglei/opencode-acp) (AGPL-3.0-or-later)。

## 它做什么

让 AI 模型**主动、选择性地**压缩上下文窗口:模型调用 `compress` 工具指定一段对话范围并附上自己写的摘要,扩展记录状态;之后每次发给 LLM 前,自动把被压缩的原始消息从上下文里删掉。摘要靠 compress 工具调用那条消息(toolCall 参数)天然留在上下文,LLM 照常能读到。

与 pi 原生 compaction(全量、阈值触发、不可选)的区别:**范围可选、模型自主决定何时压缩什么、原始内容可 decompress 恢复**。

## 核心机制(已验证)

| 机制 | 实现 |
|---|---|
| `compress` 工具 | 模型传 `{content[]{startId,endId,summary}}`,扩展解析范围+建块,无独立 LLM 调用 |
| prune | `context` 事件里删除被压缩消息,保留第一条 user |
| mNNNNN 标识 | 按 entry 顺序确定性分配,注入 `<acp-id>mNNNNN</acp-id>` 标签 |
| toolCall 配对保护 | 压缩范围边界自动调整,不拆散 assistant(toolCall)↔ toolResult 对 |
| `decompress` 工具 | 停用块 → 消息重现;tier≥2 上翻一代（复活直接子块，其摘要重现，孙代仍折叠） |
| **tier 2/3 蒸馏（二期 2026-10-02）** | compress 的 startId/endId 也接受块引用 `bN..bM`（端点须活跃，中段对 inactive 透明）：同层旧块折成 ONE 高层块（T1→T2→T3，T3 终态拒收防环），`effectiveMessageIds` 传递闭包保谱系 |
| **锚点隐藏（二期）** | 被完全消费的 compress 调用（摘要已被高层块取代）其 assistant toolCall 消息 + toolResult 一起移出上下文；decompress 自动恢复；派生规则不落盘 |
| **`search_context` 工具（二期）** | 块摘要 + 被折叠原文的零成本关键词召回（不解压、不改状态）：hybrid 0.7×BM25(stem+CJK 分词)+0.3×char-bigram，角色权重 user 1.5/assistant 1/tool 0.6；命中给 mNNNNN/bN + owner 块 + decompress 指令 |
| 状态持久化 | `pi.appendEntry("acp-state", ...)`,跨进程 session_start 恢复 |
| 用量提示（自然边界触发） | 控制带 180K~250K；`agent_settled`（随用户下一条消息触发）/ todo 完成 / 硬限兕底（≥8 turn 间隔）；`context` 瞬态注入，不落盘、不堆积 |

### 用量提示机制（区别于上游的频繁 nudge）

上游默认 15% 起步、55% 上限持续催压；本移植版按用户偏好改为**只在自然边界提示**：

- **软限 250K**（`ACP_SOFT_LIMIT_TOKENS`，小窗口按 25% 比例收敛）：超过后仅在 agent 一轮完全结束（`agent_settled`，用户不再回应则永不提示）或 todo 工具完成时标记，随下一 turn 瞬态注入
- **目标 180K**（`ACP_TARGET_TOKENS`）：提示文案中让模型压向该值
- **硬限 320K**（`ACP_HARD_LIMIT_TOKENS`）：长自治 run（永不 settled）的兕底，每 ≥8 turn 最多提示一次
- **频控**：提示后未压缩，需用量再涨 10% 才允许重复；compress 成功即重置基线
- 全部阈值可用 `ACP_TARGET_TOKENS` / `ACP_SOFT_LIMIT_TOKENS` / `ACP_HARD_LIMIT_TOKENS` 环境变量覆盖；`ACP_DEBUG=1` 可在 stderr 观察注入

## 用法

无需配置。扩展自动加载。模型在上下文紧张时自主调用 `compress`(系统提示里的工具描述会引导它)。也可手动提示模型:"用 compress 压缩前面的 XX 部分"。

## MVP 范围(已完成并验证)

✅ compress / decompress 工具 · ✅ prune · ✅ mNNNNN 标签 · ✅ 配对保护 · ✅ 持久化与恢复 · ✅ 自然边界用量提示

## pi ≥0.99 兼容性修复(2026-09-30)

pi 0.99 起把 system prompt 也存为 `type=message, role=system` 的 session entry,且
compaction/branch_summary entry 会展开出 compactionSummary/branchSummary 消息;
context 事件的 `event.messages` 过滤了 system 消息。旧的“entry 列表与 messages 1:1”
假设失效,aligned 守卫恒为 false,`<acp-id>` 标签整体不注入(模型看不到消息 id)。
修复:`getAlignmentRows()` 复刻 pi 投影规则做对齐(message 非 system 占行、
custom_message 占行、compaction/branchSummary 的 summary 占行但 entryId=null 不可压,
system 跳过),context 注入与 compress 解析共用同一对齐序列。已验证:普通会话、
多轮+toolCall/toolResult、compress 全链路(引用解析/保护/prune/摘要保留)、
含 compaction entry 的会话四种场景。

## 二期实现（2026-10-02）：三层蒸馏 + search_context

以 billion-context-pi 及其论文《Model-Driven Incremental Hierarchical Compression》
（仓库 `paper/` 目录，MIT）为设计参考，对齐 acp-kernel 的块生命周期语义，但在 acp 的
"摘要 in-band 承载"架构下自实现（约 +590 行，不引入任何依赖）：

- **数据模型**：block 增加 `coveredTokens`（被覆盖原文 token 估算）、`deactivatedBy: "consumed"|"decompress"`（停用原因，锚点可见性的判据）；旧状态缺字段时按 decompress 语义兼容
- **蒸馏**：compress 接受 bN 范围 → 新块 tier = min(3, 源层+1)，children 置 inactive-consumed 但**不清 byMessageId**（原文仍隐藏，由新块覆盖）；`effectiveMessageIds` 取 children 传递闭包；端点必须存在且活跃（捕获 stale-ref），区间中段对 inactive id 透明
- **防环**：T3 终态拒收（对齐 dog/billion-context-pi#3）；蒸馏建议只挂在已超软限的 nudge 里（T1≥4 / T2≥3），不做独立触发——对齐论文"块数不是需求信号，tier-2 是安全阀而非常规路径"（生产中 tier-2 仅 3.5%）
- **锚点可见性**：某次 compress 调用锚定的块全部 inactive-consumed → 其 assistant 消息（须无兄弟 toolCall）+ toolResult 隐藏；纯派生规则，每轮由状态重算，decompress 复活子块时自动恢复
- **decompress 谱系**：T2/T3 停用本块 + 复活直接 children（上翻一代，对齐内核 full=false）；对已消费块直接 decompress 会指路到活跃的高层块
- **search_context**：文档集 = 全部块（含 inactive，谱系可搜，标 `[inactive]`）+ 被任一块 effective 覆盖的原始消息（session 里仍存全文）；未压缩消息不进索引；噪声门要求 BM25 词级命中或 bigram 覆盖率 ≥1/3（防长 token 随机命中）
- **统计**：compress 结果改为按块口径（活跃块 coveredTokens + 已消费块被取代的摘要锦点），避免蒸馏后双计

验证：mock 单测 35 项全绿（T1→T2→T3 全链路、防环、stale-ref 拒收、CJK 检索、
legacy 状态恢复）；真实 pi headless e2e（`-ne -e` + 观测扩展）验证蒸馏后锚点隐藏、
decompress 上翻一代锚点重现、search_context 跨层命中。

## 三期遗留(非核心闭环,按需补)

- **GC old-gen 合并**:长会话旧块过多时自动合并截断(当前:块永远 young)
- **质量门控**:压缩前 ROUGE 校验摘要质量(当前:无校验,信任模型)
- **KEEP/REF 标记**:summary 里 `[[KEEP:mNNNNN]]` 内联原文、`[[REF:mNNNNN]]` 紧凑链接
- **完整四类保护**:当前只做"最近 N 条 + 配对";缺 protectedTools / 最后一条 user 强制 / `<protect>` 标签
- **辅助工具**:acp_status / acp_context_recap
- **`/acp` 命令**:context/stats/decompress 子命令

## 设计文档

完整移植设计见 `C:\Users\hugua\project-codes\experiment\opencode-acp\PORT_TO_PI_DESIGN.md`。

## 已知限制

1. **context 事件执行顺序**:依赖 acp 在其他会 filter 消息的扩展之前执行(按文件名字母序,`acp` 通常靠前)。若某个 `_*` 或 `a*` 前缀扩展先 filter 消息,会触发 `aligned=false` 保守跳过 prune。
2. **pi 原生 compaction 交互**:pi 的 `/compact` 或自动 compaction 会删除旧消息 entry,导致 ACP 块状态失效 → 监听 `session_compact` 重置 ACP 状态重新开始(已处理)。
3. **continue 边界**:跨进程 `-c continue` 恢复后,偶发首次 prune 后状态显示波动(已验证恢复本身正确,边界待长期观察)。

## 许可证

AGPL-3.0-or-later(继承自 opencode-acp)。源自 https://github.com/ranxianglei/opencode-acp ,作者 ranxianglei。
