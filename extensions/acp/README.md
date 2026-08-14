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
| `decompress` 工具 | 停用块 → 消息重现 |
| 状态持久化 | `pi.appendEntry("acp-state", ...)`,跨进程 session_start 恢复 |
| 用量告知(简化) | 用量每增长 15% 告知现状,**不催促**,模型自行决定是否调 compress |

## 用法

无需配置。扩展自动加载。模型在上下文紧张时自主调用 `compress`(系统提示里的工具描述会引导它)。也可手动提示模型:"用 compress 压缩前面的 XX 部分"。

## MVP 范围(已完成并验证)

✅ compress / decompress 工具 · ✅ prune · ✅ mNNNNN 标签 · ✅ 配对保护 · ✅ 持久化与恢复 · ✅ 简化用量告知

## 二期遗留(非核心闭环,按需补)

- **GC old-gen 合并**:长会话旧块过多时自动合并截断(当前:块永远 young)
- **质量门控**:压缩前 ROUGE 校验摘要质量(当前:无校验,信任模型)
- **tier 2/3 蒸馏**:把多个旧压缩块再蒸馏成更高层摘要(当前:只 tier 1 压缩原始消息)
- **hideConsumedCompressCalls**:tier2+ 消费旧块后隐藏旧 compress 调用(当前:tier1 不适用,compress 调用需保留承载 summary)
- **KEEP/REF 标记**:summary 里 `[[KEEP:mNNNNN]]` 内联原文、`[[REF:mNNNNN]]` 紧凑链接
- **完整四类保护**:当前只做"最近 N 条 + 配对";缺 protectedTools / 最后一条 user 强制 / `<protect>` 标签
- **辅助工具**:search_context / acp_status / acp_context_recap
- **`/acp` 命令**:context/stats/decompress 子命令

## 设计文档

完整移植设计见 `C:\Users\hugua\project-codes\experiment\opencode-acp\PORT_TO_PI_DESIGN.md`。

## 已知限制

1. **context 事件执行顺序**:依赖 acp 在其他会 filter 消息的扩展之前执行(按文件名字母序,`acp` 通常靠前)。若某个 `_*` 或 `a*` 前缀扩展先 filter 消息,会触发 `aligned=false` 保守跳过 prune。
2. **pi 原生 compaction 交互**:pi 的 `/compact` 或自动 compaction 会删除旧消息 entry,导致 ACP 块状态失效 → 监听 `session_compact` 重置 ACP 状态重新开始(已处理)。
3. **continue 边界**:跨进程 `-c continue` 恢复后,偶发首次 prune 后状态显示波动(已验证恢复本身正确,边界待长期观察)。

## 许可证

AGPL-3.0-or-later(继承自 opencode-acp)。源自 https://github.com/ranxianglei/opencode-acp ,作者 ranxianglei。
