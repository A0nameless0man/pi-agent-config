---
name: downloading-documents
description: "Use when downloading documents (PDF/DOCX/ZIP) or extracting full-text content from official institution websites. Triggered by: 从网站批量下载文档、抓取官方档案、收集历史文献、网页全文提取、government portal scraping、archive digitization、批量下载 PDF、监管机构文档采集. 适用于政府/监管/档案/学术机构官方网站的文档获取任务。"
---

# 下载文档技能

## 核心原则

**始终从相关机构的官方网站出发，防御性下载，逐级提取链接，永不假设 URL 规律。**

文档采集不是脚本批处理任务——它是一个需要在每个层级验证假设、暴露失败、补偿异常的工程。漏掉一份关键文档往往比下载到错误内容更难发现。

## When to Use

**适用：**
- 从政府/监管/档案/学术机构官方网站下载文档
- 批量抓取文档列表（PDF、DOCX、ZIP 或全文网页）
- 提取全文网页内容（保留样式、嵌入图片、剔除导航）
- 处理时间跨度大、可能经历网站改版的历史文档集合
- 任何需要从官方源采集附件、多版本、多格式文档的任务

**不适用：**
- 单个文件直链下载（普通 HTTP 请求即可）
- 已知稳定 API 的数据获取（直接调 API）
- 用户已提供完整下载清单的受控任务

## 源站点探索

### 官方网站优先级（硬性规则）

1. **首选官方网站**：监管机构、政府部门、行业协会、学术机构的官方门户
2. **核实域名归属**：开始抓取前确认域名属于目标机构
3. **避免第三方聚合站**：除非官方源已永久不可得，否则不依赖第三方

### 使用 Playwright 探索（必做）

**为什么必须用 Playwright 而非 HTTP 抓取：**
- 文档链接经常由 JS 动态加载（`fetch`、SPA 路由）
- 列表页可能有翻页/折叠/"加载更多"交互
- 详情页的附件标签页可能需要点击才显示
- User-Agent / Referer 检查可能屏蔽非浏览器请求

**探索流程：**
1. 用 `playwright-cli open <url>` 打开官方首页，**实际渲染页面**（详见 `playwright-cli` skill）
2. 浏览导航结构，定位文档发布区域（"信息公开"、"政策法规"、"资料下载"等）
3. 在文档列表页**完整枚举所有链接**——不要看到前几个就停止
4. 翻完所有分页（验证"下一步"按钮是否真的禁用，而非只是不可见）
5. 记录每个文档的标题、发布日期、下载链接、附件信息

### 链接发现的四种渠道（必须全部覆盖）

**只盯页面上的 `<a>` 标签会漏链接。** 完整的链接发现必须覆盖以下四个渠道：

#### 1. 页面渲染后的 `<a>` 链接

最常见的渠道，但**不能只靠这一种**。用 `playwright-cli snapshot`（输出含元素 ref 的可读树，后续 click/fill 用 ref 定位）或 `playwright-cli --raw eval "JSON.stringify([...document.querySelectorAll('a')].map(a=>a.href))"` 直接取 href 数组。

#### 2. 目录页 / 站点地图（目录 listing）

- `/sitemap.xml`、`/robots.txt` 中暴露的目录结构
- 站内"网站地图"、"内容索引"、"档案目录"页面
- Apache/IIS 风格的目录列表（`Index of /`）
- 政府站点常见的"按年份"、"按文号"、"按主题"分类树

**必查动作**：访问 `/sitemap.xml`、`/robots.txt`、`/archive`、`/sitemap.html` 等常见路径。

#### 3. 下拉框 / 表单控件

很多政府/档案站点的文档列表不在页面 DOM 里，而是通过下拉框选择后**异步加载**：

- 年份下拉框（选不同年份加载不同文档集）
- 文号/分类下拉框
- 机构/部门选择器
- 搜索框（即使没有显式列表，关键词搜索可能返回隐藏文档）

**必做：**
- 枚举每个 `<select>` 的所有 `<option>`，逐一选择并等待内容加载
- 先 `playwright-cli snapshot` 拿到 `<select>` 的 ref（如 `e9`），再用 `playwright-cli select e9 "option-value"` 切换，切换后再次 `playwright-cli snapshot` 抓取新内容
- **不要**只看默认选中的 option——其他选项可能对应完全独立的文档集

#### 4. 浏览器请求抓包（XHR / fetch 抓包）

很多站点的文档列表通过 AJAX 加载，**实际下载链接只在 API 响应里出现**，DOM 上只显示标题。

**必做：**
- 用 `playwright-cli requests` 列出页面加载和交互时的所有请求（含索引号）
- 用 `grep`/`rg` 过滤 XHR/fetch 类型（`playwright-cli requests | grep -E '/api/|/list|/search|\.json'`）
- 用 `playwright-cli request <索引号>` 检查响应体——JSON 中常包含 `downloadUrl`、`fileUrl`、`attachmentUrl` 字段，DOM 上根本看不到
- 切换分页、下拉框、搜索时再次抓包，对比新增的请求

**示例：**
```bash
# 打开列表页，翻页触发 XHR，再抓包
playwright-cli goto "$list_page"
playwright-cli snapshot                       # 拿到 #next-page 对应的 ref，如 e21
playwright-cli click e21                      # 翻页触发 XHR
playwright-cli requests | grep '/api/docs'    # 定位目标 XHR 的索引号，如 [5]
playwright-cli request 5                      # 查看响应体
# JSON 响应中可能有 DOM 上看不到的 downloadUrl
```

### 时间跨度意识

**当文档时间跨度大于 2 年时，必须假设：**

- 网站经历过改版，URL 结构可能变化
- 老文档可能存储在归档系统（不同子域、不同路径，如 `archive.xxx.gov` vs `www.xxx.gov`）
- 部分链接可能 404，需要从网站地图、Wayback Machine、或站内搜索重新定位
- 文件命名规则可能随时间变化（早期 `2003_report.doc`，近期 `2023_annual_report_v2.pdf`）
- 老文档可能是 `.doc` 而非 `.docx`，可能是扫描版 PDF 而非文字版

## 文档类型分流策略

### 二进制文件：PDF / DOCX / ZIP / XLSX

**策略：原样下载，不做转换。**

- HTTP 流式下载到本地（不要在内存中处理，避免大文件 OOM）
- 保留原始文件名和扩展名（不要"优化"命名）
- 记录 HTTP 响应头中的 `Content-Type`、`Content-Length`、`Last-Modified`
- 校验下载大小与 `Content-Length` 一致
- ZIP 文件下载后**不要自动解压**——先存档，由后续流程决定如何处理（避免解压炸弹、避免破坏证据链）

### 全文网页：HTML 内容提取

**策略：提取干净内容，保留语义结构，嵌入图片，剔除导航。**

**必须保留：**
- 正文文本（按段落、标题层级组织）
- 内联图片（**下载并嵌入**，绝不保留远程 URL）
- 表格内容（保留行列结构）
- 文档元数据（标题、作者、发布日期、原文 URL）

**必须剔除：**
- 站点导航、面包屑、侧边栏、页眉页脚
- 版权声明、广告、"相关推荐"、"分享到"等运营模块
- Cookie 提示、登录弹窗、评论区

### 🚨 禁令：永远不要使用 Playwright `page.pdf()`

`page.pdf()` 只是网页**截图**，不是文档下载。它产生的是伪装成 PDF 的图片，存在以下问题：

- 丢失真实文本层（无法选中、搜索、复制）
- 丢失超链接
- 丢失可访问性（屏幕阅读器无法识别）
- 分页错误（网页布局不是为 A4 设计的）
- 图片可能因加载时序而缺失

**需要 PDF 时的正确做法：**
- 源站提供 PDF 下载链接 → 下载原始 PDF
- 只有网页全文 → 提取 HTML 内容后，用专用工具（参考 `pdf` skill，使用 reportlab）**重建**结构化 PDF

## 防御性下载模式

### 永远不要假设 URL 规律（硬性规则）

**❌ 错误做法：** 看到几个链接就推测编号规律
```python
# 危险：URL 编号规律经常不连续
for i in range(1, 100):
    url = f"https://example.gov/docs/{i:04d}.pdf"
    download(url)
```

URL 编号规律**经常不连续**（删除、草稿、内部编号、分类前缀、跳号）。推测会导致：
- 漏掉真实存在的文档（最严重）
- 抓取大量 404（浪费时间）
- 抓到不属于本次任务的内部文档（污染数据集）

**✅ 正确做法：** 从网页中一级一级获取链接和下载地址

链接发现必须覆盖上文**四种渠道全部**（`<a>` 标签 + 目录页 + 下拉框 + XHR 抓包），任何一种单独使用都会漏链接。

```python
# 从所有渠道汇总实际链接，不推测任何规律
all_links = set()

# 渠道 1: 页面 <a> 标签
all_links.update(extract_anchor_links_from_rendered_pages(list_pages))

# 渠道 2: 目录页 / sitemap
all_links.update(extract_links_from_sitemap_and_directories(site))

# 渠道 3: 下拉框枚举
for select_elem in find_all_selects(list_pages):
    for option in enumerate_options(select_elem):
        all_links.update(extract_links_after_selecting(select_elem, option))

# 渠道 4: XHR 抓包
all_links.update(extract_download_urls_from_xhr_responses(list_pages))

log.info(f"四渠道汇总: 共发现 {len(all_links)} 个候选下载链接")
```

### 一页可能包含多个下载链接（必查）

**必须警惕以下情况：**

- 主文档 + 附录 + 附表 + 修订说明 + 勘误
- 中英文双语版本
- 不同格式（PDF / DOCX / XLSX）的同一文档
- 历史版本归档（"2023 版"、"2022 修订版"）
- 配套数据集、附件包

**实施：**
- 在每个详情页枚举**所有** `<a>` 标签的 href
- 过滤掉明显的导航链接（首页、登录、关于我们、联系我们）后，剩余全部作为候选下载链接
- 用文件类型 + 链接文本判断归属，**不删除任何候选**——宁可多下载再人工筛选，不可遗漏

### 暴露失败而非吞掉失败

**每个下载必须记录：**
- URL、目标路径、HTTP 状态码、最终大小、耗时
- 失败原因（超时、404、403、证书错误、`Content-Type` 不匹配、大小为 0）

**失败处理原则：**
```python
result = try_download(url)
if not result.ok:
    # 不要 silent retry 直到"成功"——可能"成功"下载了错误页面（如登录页 HTML）
    failures.append({
        "url": url,
        "status": result.status,
        "reason": result.error,
        "source_page": source_page_url,  # 哪个列表页发现的这个链接
        "expected_type": expected_content_type,
        "actual_type": result.content_type,
    })
    continue  # 继续下一个，最后汇总报告
```

**最终必须输出失败清单**，由人工或后续 agent 补偿。**禁止**把失败计数当成"无所谓的小问题"。

### 下载速度自适应控制（按技术栈，不按机构）

**关键区分**：速度等级由**网站的技术实现水平**决定，**不是**由"政府/企业/学术"等机构类型决定。一个用 Cloudflare + 现代 CDN 的市政府门户可以承受高并发；一个裸 Apache + 自建机房的世界 500 强内网可能一压就崩。

#### 技术水平评估（下载前必做）

通过首次探索请求采集以下信号：

| 信号 | 低技术水平 | 高技术水平 |
|---|---|---|
| `Server` 头 | `Apache/2.2`、`IIS 6.0`、`nginx/1.10`（陈旧版本） | `nginx/1.24+`、`cloudflare`、无暴露 |
| CDN | 无 | `Cloudflare`、`Akamai`、`Fastly`、阿里云 CDN |
| HTTP 协议 | HTTP/1.0、HTTP/1.1 | HTTP/2、HTTP/3 |
| TLS | TLS 1.0/1.1、证书过期 | TLS 1.3、HSTS、现代 cipher suite |
| 响应头 | 缺失 `X-` 安全头、`X-Powered-By: PHP/5.3` | 完整安全头、无版本暴露 |
| 框架特征 | 裸 HTML、`asp?`、`jsp;jsessionid=` | React/Vue SSR、REST API、JSON 响应 |
| 静态资源 | 同源、无缓存头 | 独立 CDN 域名、`Cache-Control: immutable` |

#### 速度等级与默认值

| 等级 | 触发条件（任一） | 并发数 | 单域名 QPS | 单文件下载间隔 |
|---|---|---|---|---|
| **L1 极保守** | 陈旧 Server 头 + 无 CDN；`.gov.cn`/`.edu.cn` 老旧子域；探索时遇到 5xx | 1 | 0.5（2 秒/请求） | 3-5 秒 |
| **L2 保守**（默认） | 现代框架但无 CDN；或不确定技术栈 | 2 | 1 | 1-2 秒 |
| **L3 适中** | 现代框架 + 主流 CDN；HTTP/2 | 4 | 3 | 0.3-0.5 秒 |
| **L4 开放** | 明确企业级 SaaS（如已发布公共 API）；多区域负载均衡 | 6-8 | 5+ | 无强制间隔 |

**默认值：L2 保守**——除非探索阶段已明确证据升级到 L3/L4。

#### 动态降级（必做）

无论初始等级如何，**必须监控并动态降级**：

```python
class SpeedController:
    def __init__(self, initial_level="L2"):
        self.level = initial_level
        self.consecutive_errors = 0
        self.consecutive_successes = 0

    def record(self, success: bool, status_code: int = None):
        if not success or status_code in (429, 503, 502):
            self.consecutive_errors += 1
            self.consecutive_successes = 0
            if self.consecutive_errors >= 3:
                self.downgrade()
        else:
            self.consecutive_successes += 1
            self.consecutive_errors = 0
            # 连续 50 次成功才考虑升级（保守）
            if self.consecutive_successes >= 50 and self.level != "L4":
                self.maybe_upgrade()

    def downgrade(self):
        order = ["L4", "L3", "L2", "L1"]
        idx = order.index(self.level)
        if idx < len(order) - 1:
            self.level = order[idx + 1]
            self.consecutive_errors = 0
            log.warning(f"降级到 {self.level}，新增间隔")
```

**触发降级的具体信号：**
- HTTP 429（Too Many Requests）→ 立即降级 + 等待 `Retry-After` 头
- HTTP 503/502 连续出现 → 降级 + 指数退避
- 响应时间突然增长 > 3x → 降级
- TCP 连接被重置（connection reset）→ 降级 + 增加间隔
- 下载到的文件大小明显小于 `Content-Length` → 降级

#### User-Agent 与请求头礼貌

无论等级，**始终**：
- 设置真实合理的 `User-Agent`（不要用默认 `python-requests/2.x`）
- 带 `Referer`（指向发现的来源页面）
- 尊重 `robots.txt`（即使法律上不强制，技术上也避免被屏蔽）
- 接受 `Retry-After` 响应头并等待

### 检查嵌入资源（必做）

**文档下载后必须验证嵌入资源完整性：**

- **PDF**：用 `pdfplumber` 检查每页 image count，与源页面预期对比
- **DOCX**：用 `python-docx` 检查 `inline_shapes` 和表格数量
- **HTML 提取**：所有 `<img>` 必须已下载到本地，`src` 已替换为本地路径
- **表格**：验证行列结构正确解析，不是空单元格或合并失败

**遗漏嵌入资源 = 文档实质缺失，等同下载失败。**

## 质量保证（批量下载必做）

### 抽样比例（硬性规则）

**批量下载（>10 个文档）必须抽查至少 10%。**

- **随机选择**，不要只抽查前几个或最后几个
- 抽查结果必须**留存证据**（截图文件、提取文本片段）
- 抽查覆盖率 = `max(1, floor(总数 × 0.1))`

### 必查页面（硬性规则）

**被抽查的每个文档，以下页面必须送多模态 agent 审核：**

| 页面类型 | 原因 |
|---|---|
| **第一页**（封面/首页） | 验证文档归属、版本、发布机构、发布日期 |
| **正文第一页** | 验证内容提取正确，不是前言/目录/版权页 |
| **最后一页** | 验证文档完整，未被截断，含签署/发布信息 |

**审核要点：**
- 文档标题与下载源页面标题是否一致
- 内容是否完整（没有"加载失败"、"图片缺失"、"订阅后查看"）
- 是否包含预期结构（标题层级、表格、签名、印章）
- 是否为扫描版（OCR 质量评估）

### 多模态审核流程

```python
sample_size = max(1, len(downloaded_docs) // 10)
sampled = random.sample(downloaded_docs, sample_size)

qa_failures = []
for doc in sampled:
    pages_to_check = [doc.first_page, doc.body_first_page, doc.last_page]
    for page in pages_to_check:
        screenshot = render_page_to_image(doc, page)
        review = multimodal_agent.review(
            image=screenshot,
            prompt=f"""检查这是否是完整文档页面：
            - 标题应为: {doc.expected_title}
            - 是否包含加载失败/图片缺失/截断迹象？
            - 是否包含预期结构（表格/签名/印章）？
            返回 PASS/FAIL + 具体问题。"""
        )
        if not review.passes:
            qa_failures.append({
                "doc": doc.filename,
                "page": page,
                "issues": review.issues,
            })

# qa_failures 必须在最终交付报告中体现
```

## Red Flags - 立即停止

**看到以下信号立即停止当前方法，重新设计流程：**

| 信号 | 问题 |
|---|---|
| 看到 `<a>` 链接就推测 `id=001` 到 `id=999` 的编号规律 | URL 经常不连续，会漏文档 |
| 用 `page.pdf()` "下载"网页 | 是截图，不是 PDF，丢失文本层 |
| 下载脚本中所有异常被 `try/except: pass` 吞掉 | 失败被掩盖，无法补偿 |
| 抓到 10 个文档就停止，不验证是否还有更多 | 列表未穷举 |
| HTML 提取后图片仍是远程 URL | 嵌入资源缺失，文档不完整 |
| 批量下载后没有 QA 抽查就直接交付 | 质量未验证 |
| 抽查只看第一个文档（不随机） | 抽查偏倚，无法代表整体 |
| 一页有多个下载链接，只取第一个 | 漏附件、漏多版本、漏多格式 |
| 看到详情页就立即下载，不枚举页面所有 `<a>` | 漏隐藏附件 |
| 只看页面 `<a>` 标签，忽略目录页/下拉框/XHR 抓包 | 漏 AJAX 加载的隐藏文档集 |
| 用 `requests.get` 抓 JS 渲染的列表页 | 拿到的是空壳 HTML |
| 把 ZIP 自动解压覆盖原始下载 | 破坏证据链，无法回溯 |

**遇到以上任意一条：暂停，回到上一层级重新设计。**

## 工具集成

### 主要工具

| 工具 | 用途 |
|---|---|
| **playwright-cli** | 官网探索、动态页面渲染、复杂交互（首选，详见 `playwright-cli` skill） |
| HTTP 客户端（`httpx` / `requests`） | 二进制文件流式下载 |
| `pdfplumber` / `pypdf` | PDF 完整性验证（参考 `pdf` skill） |
| `python-docx` | DOCX 完整性验证（参考 `docx-read` skill） |
| `openpyxl` | XLSX 完整性验证（参考 `xlsx-read` skill） |
| **multimodal agent** | 抽样页面视觉审核（必做） |

### 与其他 skill 协作

- **下载后处理 PDF** → 使用 `pdf` skill
- **下载后读取 DOCX** → 使用 `docx-read` skill
- **下载后读取 XLSX** → 使用 `xlsx-read` skill
- **遇到反爬/WAF/JS-only 站点阻塞** → 考虑 `ultimate-browsing` skill

## 工作目录组织（统一存放，禁止散落）

**核心规则：下载过程中产生的所有脚本、临时文件、日志、下载产物统一存放在当前工作目录（pwd）下的单一根目录中，禁止使用系统临时目录（`%TEMP%`、`/tmp`）、禁止散落在 home 目录。**

### 标准目录布局

每次下载任务启动时，在工作目录下创建以下结构（命名与任务相关）：

```
./{task-name}_download/           # 任务根目录，如 csrc_annual_reports_download/
├── downloads/                    # 原始下载文件（PDF/DOCX/ZIP/HTML）
│   ├── pdfs/
│   ├── docx/
│   ├── xlsx/
│   ├── zip/
│   └── html/                     # 全文网页提取的 HTML（含本地化图片）
├── scripts/                      # 下载脚本、解析脚本（可重跑、可审计）
│   ├── 01_discover_links.py
│   ├── 02_download_files.py
│   └── 03_extract_fulltext.py
├── logs/                         # 运行日志（按时间或阶段命名）
│   ├── discovery.log             # 链接发现阶段
│   ├── download.log              # 下载阶段（含速度、状态码、失败原因）
│   └── qa.log                    # QA 抽查日志
├── tmp/                          # 中间产物（可清理，不影响最终交付）
│   ├── page_snapshots/           # Playwright 页面快照（探索期）
│   ├── xhr_captures/             # XHR 抓包 JSON
│   └── partial_downloads/        # 断点续传的临时文件
├── qa/                           # QA 证据（必须保留，不可清理）
│   ├── screenshots/              # 抽查页面截图（送多模态审核）
│   ├── multimodal_reviews/       # 多模态 agent 审核结果 JSON
│   └── integrity_reports/        # 嵌入资源完整性检查
└── reports/                      # 最终交付的清单与报告
    ├── download_manifest.csv     # 下载清单（URL/文件名/大小/状态）
    ├── failures.csv              # 失败清单（用于补偿）
    └── source_structure.md       # 源站点结构说明
```

### 命名规范

| 类型 | 命名规则 | 示例 |
|---|---|---|
| 任务根目录 | `{主题}_{任务类型}_download/` | `csrc_annual_reports_download/` |
| 脚本 | `{阶段序号}_{动词}_{对象}.py` | `01_discover_links.py` |
| 日志 | `{阶段名}.log` 或 `{阶段名}_{YYYYMMDD}.log` | `discovery.log`、`download_20260629.log` |
| 下载文件 | **保留源文件名**，不重命名 | `2023_annual_report.pdf`（原样） |
| 临时文件 | `{进程id}_{随机}.tmp` 或描述性前缀 | `7382_xhr_capture.tmp` |

### 禁止事项

| ❌ 禁止 | ✅ 应当 |
|---|---|
| 写入 `$env:TEMP`、`/tmp`、`C:\Windows\Temp` | 写入任务根目录下的 `tmp/` |
| 在工作目录根直接散落 `.py`、`.log` | 放入 `scripts/`、`logs/` |
| 下载文件名加随机后缀（`report_abc123.pdf`） | 保留源文件原名 |
| 多任务共用同一 `tmp/` 目录 | 每任务独立根目录 |
| 清理 `qa/` 目录 | QA 证据必须永久保留至任务验收 |
| 日志覆盖（`>` 重定向） | 日志轮转或追加（`>>`，按日期分文件） |

### 路径管理（脚本中必做）

所有脚本通过单一配置管理路径，禁止硬编码：

```python
from pathlib import Path

class TaskPaths:
    def __init__(self, task_name: str, base_dir: Path = None):
        # base_dir 默认为当前工作目录，不使用系统 temp
        self.root = (base_dir or Path.cwd()) / f"{task_name}_download"
        self.downloads = self.root / "downloads"
        self.pdfs = self.downloads / "pdfs"
        self.docx = self.downloads / "docx"
        self.xlsx = self.downloads / "xlsx"
        self.zip = self.downloads / "zip"
        self.html = self.downloads / "html"
        self.scripts = self.root / "scripts"
        self.logs = self.root / "logs"
        self.tmp = self.root / "tmp"
        self.qa = self.root / "qa"
        self.reports = self.root / "reports"

        # 启动时一次性创建所有子目录
        for p in [self.downloads, self.pdfs, self.docx, self.xlsx,
                  self.zip, self.html, self.scripts, self.logs,
                  self.tmp, self.qa, self.reports]:
            p.mkdir(parents=True, exist_ok=True)

# 用法：所有路径通过 paths 对象引用，禁止字符串拼接
paths = TaskPaths("csrc_annual_reports")
download_to = paths.pdfs / source_filename     # ✓
download_to = Path.cwd() / "x.pdf"             # ✗ 散落在根目录
download_to = Path("/tmp/x.pdf")               # ✗ 系统 temp
```

### 清理策略

| 目录 | 清理时机 |
|---|---|
| `tmp/` | 任务完成且 QA 通过后**可**清理（建议保留至最终交付，便于复现） |
| `logs/` | **永久保留**（审计与问题排查依据） |
| `qa/` | **永久保留**（验收证据） |
| `scripts/` | **永久保留**（可重跑、可演进） |
| `downloads/` | **永久保留**（原始证据链） |
| `reports/` | **永久保留**（交付物） |



**完整的文档下载任务交付时必须包含以下全部产物（统一存放在 `./{task}_download/` 树下）：**

- [ ] **原始文件**（`downloads/`）：所有文档的原始文件（PDF/DOCX/ZIP/HTML），未修改、未重命名
- [ ] **下载清单 CSV**（`reports/download_manifest.csv`）：URL、文件名、大小、HTTP 状态、Content-Type、来源页面、下载时间
- [ ] **失败清单**（`reports/failures.csv`）：哪些链接下载失败、失败原因、来源页面（用于人工/agent 补偿）
- [ ] **嵌入资源检查报告**（`qa/integrity_reports/`）：图片数量、表格数量、是否有远程未本地化资源
- [ ] **QA 抽查报告**（`qa/`）：抽样编号、必查页面截图、多模态审核结论
- [ ] **源站点结构说明**（`reports/source_structure.md`）：发现的列表页 URL、详情页 URL 模式、翻页机制
- [ ] **下载脚本**（`scripts/`）：可重跑、可审计的发现/下载/QA 脚本
- [ ] **运行日志**（`logs/`）：含速度等级变化、降级事件、失败重试记录

**缺少以上任何一项，任务不算完成。**

## 常见错误与修正

| 错误 | 后果 | 修正 |
|---|---|---|
| 推测 URL 编号规律 | 漏文档（最严重） | 从渲染后的列表页逐级提取 |
| 只下载主文档，忽略附件 | 内容缺失 | 详情页枚举所有 `<a>` |
| 用 `page.pdf()` 保存全文 | 假 PDF，丢失文本层 | 提取 HTML 后用 reportlab 重建 |
| 异常被 `except: pass` 吞掉 | 失败不可见 | 记录到 failures 清单 |
| 批量下载无 QA | 静默错误流入下游 | 10% 抽样 + 多模态审核 |
| ZIP 自动解压覆盖原文件 | 证据链断裂 | 原始 ZIP 保留，解压到独立目录 |
| 假设老链接仍有效 | 404 大量出现 | 时间跨度 > 2 年时检查 Wayback Machine |
| HTML 中保留远程图片 URL | 离线后图片消失 | 所有 `<img>` 下载并替换 src |
| 按"政府/企业"机构类型预设下载速度 | 老旧内网被压垮，或现代 CDN 被无谓限速 | 按技术栈信号（Server/CDN/HTTP 版本）评估 |
| 一次性高速下载，无动态降级 | 触发封禁、对方服务崩溃 | 监控 429/503，自动降级 + 退避 |
| 脚本/日志/临时文件散落系统 temp 或工作目录根 | 难审计、难复现、易丢失 | 统一存放在 `./{task}_download/` 树下 |
| 下载文件被重命名加随机后缀 | 源文件名信息丢失，破坏证据链 | 保留源文件原名 |
