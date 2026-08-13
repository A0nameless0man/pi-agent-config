---
name: init-deep
description: 初始化分层级 AGENTS.md 知识库(为 pi 项目)——并行 scout 发现 + 复杂度评分决定哪些子目录生成子 AGENTS.md,生成根级+子目录文档并去重评审。适用于新建项目或大型既有代码库需要让后续会话快速理解项目结构/约定/反模式时
---

# 初始化分层级 AGENTS.md 知识库

生成分层级 AGENTS.md 文件:根目录 + 按复杂度评分的子目录。

## 使用方式

pi skill 无命令行参数,开始时先确认(默认按以下假设执行):

- **模式**:默认"更新模式"——修改已有 + 仅在值得处新建;用户说"从零重建"时 → 先读全部已有 AGENTS.md(保留上下文)→ 删除全部 → 重新生成
- **深度**:默认 max-depth=3,即只在前 3 层目录中考虑生成子 AGENTS.md;大型项目可询问是否放宽

## pi 如何读取 AGENTS.md(无需任何配置)

pi 原生加载以下位置的 AGENTS.md,本 skill 生成的文档会被自动生效:

- 全局:`~/.pi/agent/AGENTS.md`
- 项目:`AGENTS.md`(项目根)与 `.pi/AGENTS.md`

分层级(根 + 子目录)AGENTS.md 的作用:pi 在对应子目录工作时加载对应文档;子文档永远不重复父文档内容。

---

## 工作流(高层)

1. **发现与分析**(并行)——立即并行派出 scout;主会话同时做 bash 结构分析 + grep 代码地图 + 读已有 AGENTS.md
2. **评分与决策**——根据合并发现确定 AGENTS.md 位置
3. **生成**——先根目录,再并行生成子目录
4. **评审**——去重、精简、校验

<critical>
维护一个四阶段进度清单(discovery/scoring/generate/review),实时标记 in_progress → completed(有 todo 工具用 todo 工具,没有就记在临时文件里)。
</critical>

---

## Phase 1: 发现与分析(并行)

**标记 discovery 为 in_progress。**

### 立即并行派出 scout(subagent 扩展)

不要等待——派出的同时主会话继续工作。每个 scout 用 grep/find/read 做结构化探索,**基于实际文件证据而非按惯例猜测**;发现的任何偏离标准模式之处都要 REPORT。

```
// subagent 并行模式一次派 6 个 scout(上限 8 任务/4 并发,6 个一浪放得下):
并行任务:
  1. scout: 项目结构——find 实际目录树、文件分布 → 报告偏离标准布局之处
  2. scout: 入口点——找 main/入口文件、包配置、导出点 → 报告非标准组织方式
  3. scout: 约定——找 .eslintrc / pyproject.toml / .editorconfig / .prettierrc 等配置文件 → 报告项目特有规则
  4. scout: 反模式——grep "DO NOT|NEVER|ALWAYS|DEPRECATED" 等注释 → 列出被禁止的写法
  5. scout: 构建/CI——找 .github/workflows、Makefile、CI 配置 → 报告非标准模式
  6. scout: 测试模式——找测试配置/目录结构;grep 测试引用,看核心模块覆盖情况 → 报告独特约定
```

<dynamic-agents>
**动态增加 scout**:bash 结构分析后,按项目规模追加 scout。subagent 并行模式每波最多 8 个任务、4 个并发——超出即分批(waves)依次派出。

| 因素 | 阈值 | 追加 scout |
|--------|-----------|-------------------|
| 总文件数 | >100 | 每 100 个文件 +1 |
| 总行数 | >10k | 每 10k 行 +1 |
| 目录深度 | ≥4 | +2(深模块探索) |
| 大文件(>500 行) | >10 个 | +1(复杂度热点) |
| Monorepo | 检测到 | 每个 package/workspace +1 |
| 多语言 | >1 | 每种语言 +1 |

```bash
# 先测项目规模(Git Bash)
total_files=$(find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' | wc -l)
total_lines=$(find . -type f \( -name "*.ts" -o -name "*.py" -o -name "*.go" \) -not -path '*/node_modules/*' -exec wc -l {} + 2>/dev/null | tail -1 | awk '{print $1}')
large_files=$(find . -type f \( -name "*.ts" -o -name "*.py" \) -not -path '*/node_modules/*' -exec wc -l {} + 2>/dev/null | awk '$1 > 500 {count++} END {print count+0}')
max_depth=$(find . -type d -not -path '*/node_modules/*' -not -path '*/.git/*' | awk -F/ '{print NF}' | sort -rn | head -1)
```

示例:500 文件、50k 行、深度 6、15 个大文件 → 追加 5+5+2+1 = 13 个 scout → 分 2 波:
```
// 第 1 波(8 个):大文件分析、深模块(depth 4+)、共享工具、跨切面关注点……
// 第 2 波(5 个):按计算结果补齐
```
</dynamic-agents>

### 主会话:并行分析

**scout 运行期间**,主会话做:

#### 1. bash 结构分析

```bash
# 目录深度分布
find . -type d -not -path '*/\..*' -not -path '*/node_modules/*' -not -path '*/venv/*' -not -path '*/dist/*' -not -path '*/build/*' | awk -F/ '{print NF-1}' | sort -n | uniq -c

# 每目录文件数(top 30)
find . -type f -not -path '*/\..*' -not -path '*/node_modules/*' | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn | head -30

# 各目录代码集中度(按扩展名)
find . -type f \( -name "*.py" -o -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.go" -o -name "*.rs" \) -not -path '*/node_modules/*' | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn | head -20

# 已有 AGENTS.md / CLAUDE.md
find . -type f \( -name "AGENTS.md" -o -name "CLAUDE.md" \) -not -path '*/node_modules/*' 2>/dev/null
```

#### 2. 读已有 AGENTS.md

```
对每个已找到的文件:
  read 全文
  提取:关键洞见、约定、反模式
  存入 EXISTING_AGENTS 映射
```

从零重建模式:先读全部(保留上下文)→ 删除 → 重新生成。

#### 3. 代码地图(grep 版,不要跳过)

用 grep 生成代码地图——这是 CODE MAP 与评分矩阵中"符号密度/导出数/引用中心度"三行的数据来源:

- **符号清单**:grep 定义模式(如 `^export (class|function|interface)`、`^def `、`^func `、`^type .* struct`)→ 每个模块的符号目录
- **导出计数**:统计每个模块的 export/公开符号数
- **引用中心度**:对顶级导出符号逐个 grep 引用计数 → 引用中心度(供评分矩阵)
- 项目 <10 文件或无代码文件:跳过本步,在 CODE MAP 标注"中心度未测量"

### 收集 scout 结果

全部 scout 结束后,汇总各任务输出(并行模式返回每个完成任务的最终输出,单任务上限 50KB)。

**合并:bash + grep 代码地图 + 已有 AGENTS.md + scout 发现。标记 discovery 完成。**

---

## Phase 2: 评分与位置决策

**标记 scoring 为 in_progress。**

### 评分矩阵

| 因素 | 权重 | 高分阈值 | 来源 |
|--------|--------|----------------|--------|
| 文件数 | 3x | >20 | bash |
| 子目录数 | 2x | >5 | bash |
| 代码占比 | 2x | >70% | bash |
| 独特模式 | 1x | 有自有配置 | scout |
| 模块边界 | 2x | 有 index.ts/__init__.py | bash |
| 符号密度 | 2x | >30 符号 | grep |
| 导出数 | 2x | >10 导出 | grep |
| 引用中心度 | 3x | >20 引用 | grep |

### 决策规则

| 分数 | 动作 |
|-------|--------|
| **根(.)** | 总是创建 |
| **>15** | 创建 AGENTS.md |
| **8-15** | 领域明确才创建 |
| **<8** | 跳过(父文档覆盖) |

### 输出

```
AGENTS_LOCATIONS = [
  { path: ".", type: "root" },
  { path: "src/hooks", score: 18, reason: "high complexity" },
  { path: "src/api", score: 12, reason: "distinct domain" }
]
```

**标记 scoring 完成。**

---

## Phase 3: 生成 AGENTS.md

**标记 generate 为 in_progress。**

<critical>
**文件写入规则**:目标路径已有 AGENTS.md → 用 `edit`;不存在 → 用 `write`。绝不 write 覆盖已有文件,先通过 read/发现结果确认存在性。
</critical>

### 根 AGENTS.md(完整处理)

```markdown
# PROJECT KNOWLEDGE BASE

**Generated:** {TIMESTAMP}
**Commit:** {SHORT_SHA}
**Branch:** {BRANCH}

## OVERVIEW
{1-2 句:项目是什么 + 核心技术栈}

## STRUCTURE
```
{root}/
├── {dir}/    # {仅注明非显而易见的作用}
└── {entry}
```

## WHERE TO LOOK
| 任务 | 位置 | 备注 |
|------|----------|-------|

## CODE MAP
{来自 grep 符号/引用分析——项目 <10 文件时跳过}

| 符号 | 类型 | 位置 | 引用数 | 角色 |
|--------|------|----------|------|------|

## CONVENTIONS
{仅写与标准不同的部分}

## ANTI-PATTERNS (THIS PROJECT)
{本项目明确禁止的写法}

## UNIQUE STYLES
{项目特有风格}

## COMMANDS
```bash
{dev/test/build}
```

## NOTES
{坑与注意事项}
```

**质量门**:50-150 行,无通用废话,无显而易见的内容。

### 子目录 AGENTS.md(并行)

为每个位置(除根外)并行派出生成任务:

```
for loc in AGENTS_LOCATIONS (根除外):
  并行 subagent(worker):
    为 ${loc.path} 生成 AGENTS.md
    - 原因:${loc.reason}
    - 30-80 行上限
    - 绝不重复父文档内容
    - 章节:OVERVIEW(1 行)、STRUCTURE(子目录 >5 时)、WHERE TO LOOK、CONVENTIONS(如与父不同)、ANTI-PATTERNS
```

子文档数量少(<4 个)时,主会话直接顺序 write 即可,不必派 subagent。

**全部完成后标记 generate 完成。**

---

## Phase 4: 评审与去重

**标记 review 为 in_progress。**

对每个生成的文件:
- 删除通用建议
- 删除与父文档重复内容
- 裁剪到行数上限
- 校验电报式风格

**标记 review 完成。**

---

## 最终报告

```
=== init-deep Complete ===

Mode: {更新 | 从零重建}

Files:
  [OK] ./AGENTS.md (root, {N} lines)
  [OK] ./src/hooks/AGENTS.md ({N} lines)

Dirs Analyzed: {N}
AGENTS.md Created: {N}
AGENTS.md Updated: {N}

Hierarchy:
  ./AGENTS.md
  └── src/hooks/AGENTS.md
```

---

## 反模式

- **静态 agent 数**:scout 数量必须随项目规模/深度变化
- **顺序执行**:必须并行(主会话 bash + grep 分析与 scout 并行)
- **忽略已有内容**:始终先读已有 AGENTS.md,从零重建也不例外
- **过度文档化**:不是每个目录都需要 AGENTS.md
- **冗余**:子文档绝不重复父文档
- **通用内容**:删掉对所有项目都适用的内容
- **冗长风格**:电报式,否则宁可不要

<!-- 移植自 opencode oh-my-openagent 的 init-deep skill:codegraph/LSP/task 工具替换为 pi 的 grep/find/read + subagent 扩展;评分矩阵与模板保持原样 -->
