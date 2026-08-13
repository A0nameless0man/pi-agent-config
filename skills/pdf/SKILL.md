---
name: pdf
description: "Use this skill any time a PDF file is involved in any way — as input, output, or both. This includes: creating new PDF documents with text, tables, and images; reading or extracting text, tables, and form data from existing PDFs; merging, splitting, or rearranging PDF pages; filling in PDF form fields; adding watermarks, headers, or footers; converting between PDF and other formats. Trigger whenever the user mentions 'PDF,' 'form,' or references a .pdf filename, regardless of what they plan to do with the content afterward. If a .pdf file needs to be opened, created, or touched, use this skill. (recommended category: deep)"
---

# PDF Manipulation Skill

你是专业的 PDF 处理专家，使用三个核心库完成 PDF 创建、操作和提取任务。

## 核心原则

- **三库分工**：reportlab 创建 PDF，pypdf 操作 PDF，pdfplumber 提取内容
- **字体优先**：处理中文必须先注册中文字体（SimHei、Microsoft YaHei）
- **设计系统先行**：创建 PDF 前先定义样式系统
- **验证驱动**：填充表单后验证字段值，提取数据后验证完整性

## 依赖安装

```bash
pip install reportlab pypdf pdfplumber
# CLI 工具（可选）
# Ubuntu: sudo apt install poppler-utils qpdf
# macOS: brew install poppler qpdf
# Windows: choco install poppler qpdf
```

## 快速参考

### reportlab
```python
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib.colors import HexColor, black, white
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, Image
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
```

### pypdf
```python
from pypdf import PdfReader, PdfWriter, PdfMerger
```

### pdfplumber
```python
import pdfplumber
```

---

## 一、PDF 创建（reportlab）

### 1.1 文档结构

```python
from reportlab.lib.pagesizes import A4
from reportlab.platypus import SimpleDocTemplate

doc = SimpleDocTemplate(
    "output.pdf",
    pagesize=A4,
    leftMargin=25*mm,
    rightMargin=25*mm,
    topMargin=25*mm,
    bottomMargin=25*mm,
    title="文档标题"
)

story = []
story.append(Paragraph("文本内容", style))
story.append(Spacer(1, 12))
story.append(PageBreak())
story.append(Table(data, style=table_style))
doc.build(story)
```

### 1.2 字体注册

**必须**为中文注册字体，否则显示乱码。

```python
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

# 中文字体
pdfmetrics.registerFont(TTFont('SimHei', 'C:/Windows/Fonts/simhei.ttf'))
pdfmetrics.registerFont(TTFont('MicrosoftYaHei', 'C:/Windows/Fonts/msyh.ttc'))
pdfmetrics.registerFont(TTFont('SimSun', 'C:/Windows/Fonts/simsun.ttc'))
pdfmetrics.registerFont(TTFont('KaiTi', 'C:/Windows/Fonts/kaiti.ttf'))

# 英文字体
pdfmetrics.registerFont(TTFont('TimesNewRoman', 'C:/Windows/Fonts/times.ttf'))
pdfmetrics.registerFont(TTFont('Arial', 'C:/Windows/Fonts/arial.ttf'))
```

#### ⚠ registerFontFamily() 必须调用

**强制规则**：调用 `registerFont()` 后，**必须**紧接着调用 `registerFontFamily()` 才能启用 `<b>`、`<i>`、`<super>`、`<sub>` 等 inline 标签。

不调用 `registerFontFamily()` 的后果：粗体、斜体等标签不会生效，即使字体文件支持这些变体。

```python
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

# Register font
pdfmetrics.registerFont(TTFont('SimHei', 'C:/Windows/Fonts/simhei.ttf'))

# MUST ALSO register font family for inline tags to work
pdfmetrics.registerFontFamily(
    'SimHei',
    normal='SimHei',
    bold='SimHei',      # 如果没有粗体变体，用同字体代替
    italic='SimHei',
    boldItalic='SimHei'
)
```

- 对**每个**注册的字体都必须执行这一步，包括英文字体
- 如果有真正的粗体/斜体字体文件，应分别注册并指定（如 `bold='SimHeiBold'`）

### 1.3 ParagraphStyle 配置

```python
from reportlab.lib.styles import getSampleStyleSheet

styles = getSampleStyleSheet()

# 修改内置样式
styles['Normal'].fontName = 'MicrosoftYaHei'
styles['Normal'].fontSize = 12
styles['Normal'].leading = 18

# 创建自定义样式
title_style = ParagraphStyle(
    'CustomTitle',
    parent=styles['Heading1'],
    fontName='SimHei',
    fontSize=24,
    textColor=HexColor('#2c3e50'),
    alignment=TA_CENTER,
    spaceAfter=30,
    leading=32
)

# 完整样式系统
def create_styles():
    styles = getSampleStyleSheet()
    
    styles.add(ParagraphStyle(
        name='Heading1',
        fontName='SimHei',
        fontSize=22,
        textColor=HexColor('#2c3e50'),
        spaceBefore=30,
        spaceAfter=20,
        leading=28
    ))
    
    styles.add(ParagraphStyle(
        name='Heading2',
        fontName='SimHei',
        fontSize=18,
        textColor=HexColor('#34495e'),
        spaceBefore=24,
        spaceAfter=14,
        leading=24
    ))
    
    styles.add(ParagraphStyle(
        name='Normal',
        fontName='MicrosoftYaHei',
        fontSize=12,
        textColor=HexColor('#2d3748'),
        alignment=TA_JUSTIFY,
        leading=18,
        spaceAfter=12
    ))
    
    styles.add(ParagraphStyle(
        name='Caption',
        fontName='MicrosoftYaHei',
        fontSize=10,
        textColor=HexColor('#718096'),
        alignment=TA_CENTER,
        spaceBefore=6,
        spaceAfter=6
    ))
    
    return styles
```

### 1.4 XML 内联标签

```python
# 粗体、斜体
para = Paragraph("这是<b>粗体</b>和<i>斜体</i>", style)

# 上标下标
para = Paragraph("H<sub>2</sub>O 和 E=mc<sup>2</sup>", style)

# 字体切换
para = Paragraph("中文<font name='SimHei'>黑体</font>英文<font name='Arial'>Arial</font>", style)

# 颜色
para = Paragraph("<font color='red'>红色</font><font color='#0066cc'>蓝色</font>", style)

# 组合
para = Paragraph(
    "<b>标题</b>：<font name='SimHei' size='14' color='#2c3e50'>重要通知</font><br/>"
    "这是<i>斜体</i>和<b>粗体</b>的组合",
    style
)
```

### 1.4b 换行处理：`<br/>` vs `\n`

**关键警告**：reportlab 的 `Paragraph` **不把 `\n` 视为换行**。必须使用 `<br/>` 标签或拆分为多个 Paragraph 对象。

```python
# WRONG - \n does NOT create a line break in Paragraph
Paragraph("Line 1\nLine 2", style)  # renders as "Line 1Line 2"

# CORRECT - use <br/> tag
Paragraph("Line 1<br/>Line 2", style)

# CORRECT - split into separate Paragraphs
story.append(Paragraph("Line 1", style))
story.append(Paragraph("Line 2", style))
```

- 这个行为对短信模板、地址信息、诗歌等需要精确换行的内容尤其重要
- 在将外部文本（API 返回、文件读取）传入 Paragraph 前，应将 `\n` 替换为 `<br/>`：
  ```python
  safe_text = raw_text.replace('\n', '<br/>')
  Paragraph(safe_text, style)
  ```

### 1.5 表格创建与样式

```python
from reportlab.platypus import Table, TableStyle
from reportlab.lib import colors

data = [
    ['姓名', '年龄', '城市'],
    ['张三', '28', '北京'],
    ['李四', '32', '上海'],
    ['王五', '25', '广州']
]

table = Table(data, colWidths=[100, 60, 80])
table.setStyle(TableStyle([
    # 表头
    ('BACKGROUND', (0, 0), (-1, 0), HexColor('#3498db')),
    ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
    ('ALIGN', (0, 0), (-1, 0), 'CENTER'),
    ('FONTNAME', (0, 0), (-1, 0), 'SimHei'),
    ('FONTSIZE', (0, 0), (-1, 0), 12),
    ('BOTTOMPADDING', (0, 0), (-1, 0), 12),
    
    # 数据行
    ('FONTNAME', (0, 1), (-1, -1), 'MicrosoftYaHei'),
    ('FONTSIZE', (0, 1), (-1, -1), 11),
    ('ALIGN', (0, 1), (-1, -1), 'CENTER'),
    ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
    
    # 交替行
    ('BACKGROUND', (0, 1), (-1, 1), HexColor('#ecf0f1')),
    ('BACKGROUND', (0, 3), (-1, 3), HexColor('#ecf0f1')),
    
    # 边框
    ('GRID', (0, 0), (-1, -1), 1, HexColor('#bdc3c7')),
    ('LINEBELOW', (0, 0), (-1, 0), 2, HexColor('#2980b9')),
]))
```

#### ⚠ 表格单元格 Paragraph 包装规则（强制）

**强制规则**：表格单元格中的所有文本内容**必须**用 `Paragraph()` 对象包装。

唯一例外：`Image()` 对象可以直接放入单元格。

不包装的后果：`<b>`、`<super>`、`<sub>` 等 inline 标签不会渲染，字体设置可能失效。

```python
from reportlab.platypus import Table, Paragraph
from reportlab.lib.styles import getSampleStyleSheet

styles = getSampleStyleSheet()

# WRONG - plain string, no formatting possible
data = [['<b>Header</b>', 'Value']]  # tags won't render
table = Table(data)

# CORRECT - wrap in Paragraph
data = [
    [Paragraph('<b>Header</b>', styles['Normal']), 
     Paragraph('Value', styles['Normal'])]
]
table = Table(data)
```

- 即使不需要 inline 标签，也应使用 Paragraph 以确保字体、对齐等设置正确生效
- 可以在 Paragraph 样式中控制单元格内的文本对齐和字体

### 1.6 封面页

```python
def create_cover_page(story, styles, title, subtitle, author, date):
    story.append(Spacer(1, 80))
    
    title_style = ParagraphStyle(
        'CoverTitle',
        parent=styles['Heading1'],
        fontName='SimHei',
        fontSize=36,
        textColor=HexColor('#2c3e50'),
        alignment=TA_CENTER,
        spaceAfter=30
    )
    story.append(Paragraph(title, title_style))
    
    subtitle_style = ParagraphStyle(
        'CoverSubtitle',
        fontName='MicrosoftYaHei',
        fontSize=18,
        textColor=HexColor('#7f8c8d'),
        alignment=TA_CENTER,
        spaceAfter=60
    )
    story.append(Paragraph(subtitle, subtitle_style))
    
    story.append(Spacer(1, 100))
    
    author_style = ParagraphStyle(
        'CoverAuthor',
        fontName='MicrosoftYaHei',
        fontSize=14,
        textColor=HexColor('#34495e'),
        alignment=TA_CENTER,
        spaceAfter=10
    )
    story.append(Paragraph(f"作者：{author}", author_style))
    story.append(Paragraph(f"日期：{date}", author_style))
    
    story.append(PageBreak())
```

### 1.7 图像插入

```python
from reportlab.platypus import Image
from reportlab.lib.units import cm

img = Image("path/to/image.png", width=10*cm, height=6*cm)
story.append(img)
story.append(Paragraph("图 1：示例图像", styles['Caption']))
story.append(Spacer(1, 20))
```

### 1.8 自动生成目录（Table of Contents）

使用 `multiBuild()`（而非 `build()`）实现两遍渲染：第一遍收集页码，第二遍填充 TOC。

```python
from reportlab.platypus import SimpleDocTemplate, Paragraph, TableOfContents, PageBreak
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle

class TocDocTemplate(SimpleDocTemplate):
    """DocTemplate that supports auto-generated Table of Contents via multiBuild."""
    pass

styles = getSampleStyleSheet()

# 创建带 bookmark 的标题段落
def heading(text, level=0):
    style = styles['Heading1'] if level == 0 else styles['Heading2']
    p = Paragraph(text, style)
    p.bookmarkName = text.replace(' ', '_')
    p.bookmarkLevel = level  
    p.bookmarkText = text
    return p

# 构建 story
story = []

# 插入目录页
toc = TableOfContents()
toc.levelStyles = [
    ParagraphStyle('TOC1', fontName='SimHei', fontSize=14, leading=20, spaceBefore=6, spaceAfter=3, leftIndent=0),
    ParagraphStyle('TOC2', fontName='MicrosoftYaHei', fontSize=12, leading=18, spaceBefore=3, spaceAfter=2, leftIndent=20),
]
story.append(Paragraph('目录', styles['Heading1']))
story.append(toc)
story.append(PageBreak())

# 添加带 bookmark 的章节
story.append(heading('第一章 概述', level=0))
story.append(Paragraph('本章内容...', styles['Normal']))
story.append(heading('1.1 背景', level=1))
story.append(PageBreak())
story.append(heading('第二章 详细分析', level=0))

# 使用 multiBuild（两遍渲染：第一遍收集页码，第二遍填充 TOC）
doc = TocDocTemplate('output.pdf', pagesize=A4)
doc.multiBuild(story)
```

- **关键**：必须用 `multiBuild()` 而不是 `build()`，否则 TOC 页码全为 0
- 每个 heading 段落必须设置 `bookmarkName`、`bookmarkLevel`、`bookmarkText` 属性
- `TableOfContents.levelStyles` 列表的索引对应 `bookmarkLevel` 的值

### 1.9 完整示例

```python
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib.colors import HexColor, white
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

def create_report(output_path, data):
    # 注册字体
    pdfmetrics.registerFont(TTFont('SimHei', 'C:/Windows/Fonts/simhei.ttf'))
    pdfmetrics.registerFont(TTFont('MicrosoftYaHei', 'C:/Windows/Fonts/msyh.ttc'))
    
    # 创建文档
    doc = SimpleDocTemplate(output_path, pagesize=A4, leftMargin=25*mm, rightMargin=25*mm)
    
    # 创建样式
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(name='Title', fontName='SimHei', fontSize=24,
                              textColor=HexColor('#2c3e50'), alignment=TA_CENTER, spaceAfter=40))
    styles.add(ParagraphStyle(name='Heading1', fontName='SimHei', fontSize=18,
                              textColor=HexColor('#34495e'), spaceBefore=30, spaceAfter=15))
    styles.add(ParagraphStyle(name='Body', fontName='MicrosoftYaHei', fontSize=12,
                              textColor=HexColor('#2d3748'), alignment=TA_JUSTIFY, leading=18))
    
    story = []
    
    # 标题
    story.append(Spacer(1, 40))
    story.append(Paragraph(data['title'], styles['Title']))
    
    # 章节
    story.append(Paragraph("摘要", styles['Heading1']))
    story.append(Paragraph(data['summary'], styles['Body']))
    story.append(Spacer(1, 20))
    
    # 表格
    story.append(Paragraph("数据统计", styles['Heading1']))
    table_data = [['指标', '数值', '占比']] + [[m['name'], m['value'], m['percentage']] for m in data['metrics']]
    table = Table(table_data, colWidths=[120, 100, 80])
    table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), HexColor('#3498db')),
        ('TEXTCOLOR', (0, 0), (-1, 0), white),
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('FONTNAME', (0, 0), (-1, 0), 'SimHei'),
        ('FONTNAME', (0, 1), (-1, -1), 'MicrosoftYaHei'),
        ('FONTSIZE', (0, 0), (-1, -1), 11),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 10),
        ('GRID', (0, 0), (-1, -1), 1, HexColor('#bdc3c7')),
    ]))
    story.append(table)
    
    doc.build(story)

# 使用
data = {
    'title': '2024 年度销售报告',
    'summary': '本年度销售额同比增长 15%。',
    'metrics': [
        {'name': '总销售额', 'value': '¥12,500,000', 'percentage': '100%'},
        {'name': '线上销售', 'value': '¥7,500,000', 'percentage': '60%'},
    ]
}
create_report('report.pdf', data)
```

---

## 二、PDF 操作（pypdf）

### 2.1 读取 PDF

```python
from pypdf import PdfReader

reader = PdfReader("input.pdf")
print(f"页数：{len(reader.pages)}")

# 获取单页
page = reader.pages[0]

# 提取文本
text = page.extract_text()

# 获取元数据
metadata = reader.metadata
print(f"标题：{metadata.title}")
print(f"作者：{metadata.author}")
```

### 2.2 合并 PDF

```python
from pypdf import PdfMerger

merger = PdfMerger()
merger.append("file1.pdf")
merger.append("file2.pdf")
merger.append("file3.pdf")
merger.write("merged.pdf")
merger.close()
```

### 2.3 拆分 PDF

```python
from pypdf import PdfReader, PdfWriter

def split_pdf(input_path, output_prefix, pages_per_file=5):
    reader = PdfReader(input_path)
    num_pages = len(reader.pages)
    
    for i in range(0, num_pages, pages_per_file):
        writer = PdfWriter()
        end = min(i + pages_per_file, num_pages)
        for j in range(i, end):
            writer.add_page(reader.pages[j])
        
        output_path = f"{output_prefix}_{i//pages_per_file + 1}.pdf"
        with open(output_path, "wb") as f:
            writer.write(f)

split_pdf("large.pdf", "part", pages_per_file=5)
```

### 2.4 提取页码范围

```python
from pypdf import PdfReader, PdfWriter

def extract_pages(input_path, output_path, page_range):
    reader = PdfReader(input_path)
    writer = PdfWriter()
    
    if isinstance(page_range, tuple):
        start, end = page_range
        for i in range(start - 1, end):
            writer.add_page(reader.pages[i])
    else:
        for page_num in page_range:
            writer.add_page(reader.pages[page_num - 1])
    
    with open(output_path, "wb") as f:
        writer.write(f)

extract_pages("source.pdf", "extracted.pdf", (1, 10))
extract_pages("source.pdf", "selected.pdf", [1, 3, 5, 7])
```

### 2.5 旋转页面

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("input.pdf")
writer = PdfWriter()

for page in reader.pages:
    page.rotate(90)  # 顺时针 90 度
    writer.add_page(page)

with open("rotated.pdf", "wb") as f:
    writer.write(f)
```

### 2.6 添加水印

```python
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.lib.colors import gray

# 创建水印 PDF
def create_watermark(text, output_path):
    c = canvas.Canvas(output_path, pagesize=A4)
    width, height = A4
    c.saveState()
    c.translate(width/2, height/2)
    c.rotate(45)
    c.setFillColor(gray)
    c.setFont("Helvetica-Bold", 60)
    c.drawCentredString(0, 0, text)
    c.restoreState()
    c.save()

# 添加水印
def add_watermark(input_path, watermark_path, output_path):
    reader = PdfReader(input_path)
    writer = PdfWriter()
    watermark = PdfReader(watermark_path).pages[0]
    
    for page in reader.pages:
        page.merge_page(watermark)
        writer.add_page(page)
    
    with open(output_path, "wb") as f:
        writer.write(f)

create_watermark("机密", "watermark.pdf")
add_watermark("document.pdf", "watermark.pdf", "watermarked.pdf")
```

### 2.7 密码保护

```python
from pypdf import PdfReader, PdfWriter

# 添加密码
def protect_pdf(input_path, output_path, user_password, owner_password=None):
    reader = PdfReader(input_path)
    writer = PdfWriter()
    
    for page in reader.pages:
        writer.add_page(page)
    
    writer.encrypt(user_password=user_password, owner_password=owner_password or user_password)
    
    with open(output_path, "wb") as f:
        writer.write(f)

# 移除密码
def remove_password(input_path, output_path, password):
    reader = PdfReader(input_path, password=password)
    writer = PdfWriter()
    
    for page in reader.pages:
        writer.add_page(page)
    
    with open(output_path, "wb") as f:
        writer.write(f)

protect_pdf("document.pdf", "protected.pdf", "user123", "owner456")
remove_password("protected.pdf", "unlocked.pdf", "user123")
```

### 2.8 元数据操作

```python
from pypdf import PdfReader, PdfWriter
from pypdf.generic import TextStringObject

def set_metadata(input_path, output_path, metadata_dict):
    reader = PdfReader(input_path)
    writer = PdfWriter()
    
    for page in reader.pages:
        writer.add_page(page)
    
    writer.add_metadata({
        '/Title': TextStringObject(metadata_dict.get('title', '')),
        '/Author': TextStringObject(metadata_dict.get('author', '')),
        '/Subject': TextStringObject(metadata_dict.get('subject', '')),
        '/Keywords': TextStringObject(metadata_dict.get('keywords', '')),
    })
    
    with open(output_path, "wb") as f:
        writer.write(f)

set_metadata("input.pdf", "output.pdf", {
    'title': '年度报告',
    'author': '张三',
    'subject': '财务分析'
})
```

---

## 三、内容提取（pdfplumber）

### 3.1 文本提取

```python
import pdfplumber

with pdfplumber.open("document.pdf") as pdf:
    # 提取所有文本
    all_text = ""
    for page in pdf.pages:
        text = page.extract_text()
        all_text += text + "\n"
    print(all_text)
    
    # 提取特定页面
    first_page_text = pdf.pages[0].extract_text()
    
    # 提取页码范围
    range_text = "\n".join([p.extract_text() for p in pdf.pages[4:10]])
```

### 3.2 表格提取

```python
import pdfplumber
import csv

with pdfplumber.open("document.pdf") as pdf:
    page = pdf.pages[0]
    tables = page.extract_tables()
    
    for i, table in enumerate(tables):
        print(f"表格 {i+1}:")
        for row in table:
            print(row)

# 保存到 CSV
def extract_tables_to_csv(pdf_path, output_prefix):
    with pdfplumber.open(pdf_path) as pdf:
        for page_num, page in enumerate(pdf.pages):
            tables = page.extract_tables()
            for table_num, table in enumerate(tables):
                cleaned = [[cell.strip() if cell else '' for cell in row] for row in table]
                output_path = f"{output_prefix}_p{page_num+1}_t{table_num+1}.csv"
                with open(output_path, 'w', newline='', encoding='utf-8') as f:
                    writer = csv.writer(f)
                    writer.writerows(cleaned)

extract_tables_to_csv("report.pdf", "table")
```

### 3.3 元数据提取

```python
import pdfplumber

with pdfplumber.open("document.pdf") as pdf:
    metadata = pdf.metadata
    print(f"标题：{metadata.get('title', 'N/A')}")
    print(f"作者：{metadata.get('author', 'N/A')}")
    print(f"页数：{len(pdf.pages)}")
```

### 3.4 提取特定区域

```python
import pdfplumber

with pdfplumber.open("document.pdf") as pdf:
    page = pdf.pages[0]
    # 定义区域（左，上，右，下）
    cropped = page.crop((50, 100, 500, 300))
    text = cropped.extract_text()
```

---

## 四、表单处理

### 4.1 检测表单字段

```bash
python scripts/check_fillable_fields.py form.pdf
```

输出：
```
This PDF has fillable form fields
```
或
```
This PDF does not have fillable form fields
```

### 4.2 提取字段信息

```bash
python scripts/extract_form_field_info.py form.pdf fields.json
```

输出 JSON：
```json
[
  {
    "field_id": "name",
    "page": 1,
    "type": "text",
    "rect": [100, 700, 300, 720]
  },
  {
    "field_id": "subscribe",
    "page": 1,
    "type": "checkbox",
    "checked_value": "/Yes",
    "unchecked_value": "/Off"
  },
  {
    "field_id": "gender",
    "page": 1,
    "type": "radio_group",
    "radio_options": [
      {"value": "/Male", "rect": [100, 550, 120, 570]},
      {"value": "/Female", "rect": [100, 520, 120, 540]}
    ]
  },
  {
    "field_id": "country",
    "page": 1,
    "type": "choice",
    "choice_options": [
      {"value": "CN", "text": "中国"},
      {"value": "US", "text": "美国"}
    ]
  }
]
```

### 4.3 填充表单

```bash
python scripts/fill_fillable_fields.py form.pdf field_values.json filled.pdf
```

输入 JSON：
```json
[
  {"field_id": "name", "page": 1, "value": "张三"},
  {"field_id": "subscribe", "page": 1, "value": "/Yes"},
  {"field_id": "gender", "page": 1, "value": "/Male"},
  {"field_id": "country", "page": 1, "value": "CN"}
]
```

### 4.4 验证填充结果

```python
from pypdf import PdfReader

reader = PdfReader("filled.pdf")
fields = reader.get_fields()
for field_id, field in fields.items():
    value = field.get('/V')
    print(f"{field_id}: {value}")
```

### 4.5 边界框验证

```bash
python scripts/check_bounding_boxes.py fields.json
```

输出：
```
Read 10 fields
SUCCESS: All bounding boxes are valid
```

### 4.6 非可填表单填写工作流（Non-Fillable Form Filling）

当 PDF 没有 AcroForm 字段时（`check_fillable_fields.py` 报告 "does not have fillable form fields"），需要通过坐标定位覆盖文本来"填写"表单。

**完整工作流**：

1. **视觉分析**：用 `pdfplumber` 提取文本，识别表单结构（标签位置、输入区域）
2. **创建字段映射**：生成 `fields.json`，记录每个输入字段的坐标和尺寸：
   ```json
   [
     {"field_id": "name", "page": 1, "type": "text", "rect": [x1, y1, x2, y2], "label_rect": [lx1, ly1, lx2, ly2]}
   ]
   ```
3. **生成验证图**：使用 `scripts/create_validation_image.py` 在 PDF 上绘制红色矩形标注输入区域、蓝色矩形标注标签区域，用于验证定位
4. **验证定位**：检查验证图，确认红色矩形只覆盖输入区域、不覆盖标签文字（见 4.7 节）
5. **添加注释/覆盖层**：使用 `scripts/fill_pdf_form_with_annotations.py` 在指定坐标添加文本

**常见表单结构模式**：
- 标签在框内（删除线标签）：标签文字和输入区域重叠，`label_rect` 需精确区分
- 标签在线前（下划线输入）：标签后紧跟下划线区域
- 标签在线下：标签位于输入框下方
- 标签在线上：标签位于输入框上方
- 复选框（□ / ☑）：需要精确定位复选框符号的位置

```bash
# 步骤 3：生成验证图
python scripts/create_validation_image.py 1 fields.json page_1.png validated.png

# 步骤 5：填写表单
python scripts/fill_pdf_form_with_annotations.py input.pdf fields.json output.pdf
```

### 4.7 表单定位视觉检查（Bounding Box Visual Inspection）

生成验证图（validation image）后，**必须**进行视觉检查，确保定位准确。

**检查标准**：
- 🔴 **红色矩形**（输入区域）：必须只覆盖空白输入区，**不能**覆盖标签文字
- 🔵 **蓝色矩形**（标签区域）：应包含对应标签文字
- 矩形之间不能有严重重叠
- 输入区域的大小必须足以容纳预期文本（中文字符宽度约为字号值）

**迭代流程**：
1. 生成验证图 → 2. 检查定位 → 3. 调整 `fields.json` 中的坐标 → 4. 重新生成 → 重复直到准确

**自动化检查**：
```bash
# 自动检测边界框交叉和尺寸问题
python scripts/check_bounding_boxes.py fields.json

# 运行单元测试验证检测逻辑
python scripts/check_bounding_boxes_test.py
```

**坐标调整技巧**：
- PDF 坐标系原点在**左下角**（y 轴向上），与图片坐标系（y 轴向下）相反
- `rect` 格式为 `[x1, y1, x2, y2]`，其中 `(x1, y1)` 为左下角、`(x2, y2)` 为右上角
- 如果文本偏上，减小 `y1`；如果文本偏下，增大 `y1`

---

## 五、字体与排版

### 5.1 中文字体路径

```python
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

# Windows
FONT_PATHS = {
    'SimHei': 'C:/Windows/Fonts/simhei.ttf',
    'SimSun': 'C:/Windows/Fonts/simsun.ttc',
    'KaiTi': 'C:/Windows/Fonts/kaiti.ttf',
    'MicrosoftYaHei': 'C:/Windows/Fonts/msyh.ttc',
}

# macOS
# 'STHeiti': '/System/Library/Fonts/STHeiti Medium.ttc'
# 'Songti': '/System/Library/Fonts/Supplemental/Songti.ttc'

for name, path in FONT_PATHS.items():
    pdfmetrics.registerFont(TTFont(name, path))
```

### 5.2 混合语言处理

```python
import re

def create_mixed_paragraph(text, style):
    chinese_pattern = re.compile(r'[\u4e00-\u9fff]')
    if chinese_pattern.search(text):
        style.fontName = 'MicrosoftYaHei'
    else:
        style.fontName = 'Helvetica'
    return Paragraph(text, style)

# 内联切换
text = "<font name='MicrosoftYaHei'>中文</font><font name='Arial'>English</font>"
```

### 5.2b 中英混排 Inline 字体切换

当一段文本**同时包含中文和英文**时，必须按语言分段并用 `<font>` inline 标签切换字体。基本字体在 ParagraphStyle 中设置，其他语言的片段用 inline `<font name='...'>` 包裹。

```python
from reportlab.platypus import Paragraph
from reportlab.lib.styles import ParagraphStyle

# 设置中文为基础字体
cjk_style = ParagraphStyle(
    'CJK',
    fontName='SimHei',
    fontSize=12,
)

# 混排示例：中文基础 + 英文 inline 切换
text = '这是一段<font name="Helvetica">mixed English and Chinese</font>混合文本'
p = Paragraph(text, cjk_style)
```

- 反向（英文基础 + 中文 inline）也是可行的：`Paragraph('<font name="SimHei">中文</font> English text', english_style)`
- **不切换字体的后果**：CJK 字符可能用英文字体渲染导致方块（□）或乱码；反之英文字符用 CJK 字体渲染可能导致显示异常
- 需要用正则按语言边界拆分文本，然后在每个片段外包裹对应的 `<font>` 标签

### 5.3 CJK 排版规则

```python
# 合适的行高（1.5 倍）
style = ParagraphStyle(
    'CJKBody',
    fontName='MicrosoftYaHei',
    fontSize=12,
    leading=18,
    spaceAfter=12
)

# 字体大小层级
TYPOGRAPHY = {
    'h1': {'size': 24, 'leading': 32},
    'h2': {'size': 20, 'leading': 28},
    'h3': {'size': 16, 'leading': 24},
    'body': {'size': 12, 'leading': 18},
    'caption': {'size': 10, 'leading': 14},
}
```

---

## 六、CLI 工具

### 6.1 pdftotext

```bash
# 提取文本
pdftotext document.pdf output.txt

# 保持布局
pdftotext -layout document.pdf output.txt

# 提取特定页面
pdftotext -f 1 -l 5 document.pdf output.txt
```

### 6.2 qpdf

```bash
# 合并
qpdf --empty --pages file1.pdf file2.pdf -- output.pdf

# 拆分
qpdf input.pdf --pages . 1-10 -- output.pdf

# 旋转
qpdf --rotate=90 input.pdf output.pdf

# 解密
qpdf --decrypt --password=user123 protected.pdf unlocked.pdf

# 线性化（优化 Web 查看）
qpdf --linearize input.pdf output.pdf
```

---

## 七、样式标准

### 7.1 配色方案

```python
from reportlab.lib.colors import HexColor

COLORS = {
    'primary': HexColor('#2c3e50'),
    'secondary': HexColor('#3498db'),
    'accent': HexColor('#e74c3c'),
    'text_primary': HexColor('#2d3748'),
    'text_secondary': HexColor('#718096'),
    'border': HexColor('#e2e8f0'),
    'background_alt': HexColor('#f7fafc'),
    'header_bg': HexColor('#3498db'),
    'success': HexColor('#27ae60'),
    'warning': HexColor('#f39c12'),
    'error': HexColor('#c0392b'),
}
```

### 7.2 字体层级

```python
TYPOGRAPHY = {
    'h1': {'size': 24, 'leading': 32, 'space_before': 30, 'space_after': 20},
    'h2': {'size': 20, 'leading': 28, 'space_before': 25, 'space_after': 15},
    'h3': {'size': 16, 'leading': 24, 'space_before': 20, 'space_after': 12},
    'body': {'size': 12, 'leading': 18, 'space_after': 12},
    'caption': {'size': 10, 'leading': 14, 'space_before': 6, 'space_after': 6},
}
```

### 7.3 间距系统

```python
SPACING = {
    'xs': 4,
    'sm': 8,
    'md': 16,
    'lg': 24,
    'xl': 32,
}

story.append(Spacer(1, SPACING['md']))
```

---

## 八、常见工作流

### 8.1 创建报告

```python
def create_report(output_path, data):
    pdfmetrics.registerFont(TTFont('SimHei', 'C:/Windows/Fonts/simhei.ttf'))
    pdfmetrics.registerFont(TTFont('MicrosoftYaHei', 'C:/Windows/Fonts/msyh.ttc'))
    
    doc = SimpleDocTemplate(output_path, pagesize=A4)
    styles = getSampleStyleSheet()
    story = []
    
    story.append(Paragraph(data['title'], styles['Heading1']))
    story.append(Paragraph(data['summary'], styles['Normal']))
    
    doc.build(story)
```

### 8.2 提取文本

```python
def extract_text(pdf_path, output_path=None):
    import pdfplumber
    with pdfplumber.open(pdf_path) as pdf:
        text = '\n\n'.join([p.extract_text() for p in pdf.pages])
    if output_path:
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(text)
    return text
```

### 8.3 合并 PDF

```python
def merge_pdfs(pdf_list, output_path):
    from pypdf import PdfMerger
    merger = PdfMerger()
    for pdf in pdf_list:
        merger.append(pdf)
    merger.write(output_path)
    merger.close()
```

### 8.4 PDF 转图片

```python
def convert_to_images(pdf_path, output_dir, dpi=200):
    from pdf2image import convert_from_path
    import os
    os.makedirs(output_dir, exist_ok=True)
    images = convert_from_path(pdf_path, dpi=dpi)
    for i, img in enumerate(images):
        img.save(os.path.join(output_dir, f"page_{i+1}.png"), 'PNG')
```

---

## 九、Helper Scripts Reference

All helper scripts live in the `scripts/` directory. Run them from the skill root (i.e. `skills/pdf/`).

### scripts/check_fillable_fields.py
Detects whether a PDF contains fillable AcroForm fields. Outputs a single-line verdict.
```bash
python scripts/check_fillable_fields.py form.pdf
```

### scripts/extract_form_field_info.py
Extracts field metadata (id, page, type, rect, options) from a fillable PDF and writes it to JSON. See section 4.2 for output format.
```bash
python scripts/extract_form_field_info.py form.pdf fields.json
```

### scripts/fill_fillable_fields.py
Fills a PDF form using a field-values JSON file and writes the result to a new PDF. See section 4.3 for input format.
```bash
python scripts/fill_fillable_fields.py form.pdf field_values.json filled.pdf
```

### scripts/check_bounding_boxes.py
Validates bounding-box geometry in a fields JSON file: checks for intersections, overlaps, and entry-height adequacy.
```bash
python scripts/check_bounding_boxes.py fields.json
```

### scripts/convert_pdf_to_images.py
Converts each page of a PDF to a PNG image using the pdf2image library. Useful for visual QA before or after filling forms.
```bash
python scripts/convert_pdf_to_images.py input.pdf output_dir/
```

### scripts/fill_pdf_form_with_annotations.py
Fills a PDF by adding FreeText annotations defined in a fields.json file. Handles coordinate transformation from image space to PDF space. Use when the PDF has no native AcroForm fields and you need to overlay text at precise locations.
```bash
python scripts/fill_pdf_form_with_annotations.py input.pdf fields.json output.pdf
```

### scripts/create_validation_image.py
Creates a validation image with colored rectangles over bounding boxes (red=entry, blue=label). Use for visual QA of form field positions on a rendered page image.
```bash
python scripts/create_validation_image.py 1 fields.json page_1.png validated.png
```

### scripts/sanitize_code.py
Unicode sanitization pipeline for PDF generation code: restores escape sequences, converts superscript/subscript unicode characters to `<super>`/`<sub>` tags, and applies symbol fallbacks. Essential for CJK text that may contain non-ASCII characters incompatible with reportlab.
```bash
python scripts/sanitize_code.py target_script.py
```

### scripts/check_bounding_boxes_test.py
Unit tests for `check_bounding_boxes.py`. Covers intersection detection, page separation, height validation, edge-touching boxes, and error message limits. Not run in CI; use for manual verification.
```bash
python scripts/check_bounding_boxes_test.py
```

---

## 十、故障排除

### 中文乱码
**问题**：中文显示为方框
**解决**：注册中文字体
```python
pdfmetrics.registerFont(TTFont('SimHei', 'C:/Windows/Fonts/simhei.ttf'))
style.fontName = 'SimHei'
```

### 表格跨页断开
**问题**：表格在页面中间断开
**解决**：使用 KeepTogether
```python
from reportlab.platypus import KeepTogether
story.append(KeepTogether(table))
```

### 表单值不显示
**问题**：填充后某些阅读器不显示值
**解决**：
```python
writer.update_page_form_field_values(
    writer.pages[0],
    {"field_name": "value"},
    auto_regenerate=False,
)
```

### 表格提取错乱
**问题**：extract_tables() 格式不正确
**解决**：调整检测参数
```python
tables = page.extract_tables({
    'vertical_strategy': 'lines',
    'horizontal_strategy': 'lines',
    'snap_tolerance': 5,
})
```

---

## 十一、总结

本技能涵盖 PDF 操作的完整工作流：

1. **创建**：reportlab 从零创建专业 PDF
2. **操作**：pypdf 合并、拆分、旋转、加密
3. **提取**：pdfplumber 提取文本、表格、元数据
4. **表单**：使用脚本检测和填充表单字段
5. **字体**：正确处理中英文混合内容
6. **CLI**：pdftotext 和 qpdf 作为补充

遵循样式标准确保生成的 PDF 专业、一致、易读。
