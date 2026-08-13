---
name: docx-write
description: "Create and modify .docx Word documents — document generation, editing, tracked changes, OOXML manipulation, styling, tables, images, TOC, LaTeX equations, format conversion. Use for any .docx creation or modification task. For read-only text extraction, use docx-read instead."
---

# Word Document (.docx) Manipulation Skill

For reading/extracting text from existing documents, use the docx-read skill.

## Overview

> **Note**: This skill is for CREATING and MODIFYING documents. To simply read/extract text from an existing .docx file, use the **docx-read** skill instead.

This skill provides comprehensive capabilities for creating, reading, editing, and manipulating Microsoft Word (.docx) documents programmatically using Python. It leverages the `python-docx` library for high-level document operations and provides direct OOXML access for advanced scenarios requiring tracked changes, comments, and low-level XML manipulation.

### When to Use This Skill

Trigger this skill whenever any of the following conditions are met:

- **Document Creation**: User needs to generate new Word documents from scratch (reports, letters, contracts, forms)
- **Document Reading**: User needs to extract text, tables, images, or metadata from existing .docx files
- **Document Editing**: User needs to modify existing documents (search/replace, format changes, content updates)
- **Redlining/Review**: User needs to work with tracked changes, comments, or revision workflows
- **Document Conversion**: User needs to convert between DOCX and other formats (Markdown, PDF, HTML)
- **Template Processing**: User needs to populate document templates with dynamic content
- **Batch Operations**: User needs to process multiple documents with consistent transformations

### Dependencies

This skill requires the following dependencies:

```bash
# Core library - install via pip
pip install python-docx

# Image handling (for add_picture with format conversion)
pip install Pillow

# LaTeX equation support (writing equations into Word)
pip install latex2word

# LaTeX equation extraction (reading equations from Word)
pip install docxlatex

# Document conversion (DOCX ↔ Markdown/HTML)
# Option 1: pandoc (recommended)
# Install from: https://pandoc.org/installing.html
# Then: pip install pypandoc

# Option 2: LibreOffice (for PDF conversion)
# Install LibreOffice and use unoconv or direct CLI

# PDF to images (for PDF→image workflows)
# Install poppler-utils: apt install poppler-utils (Linux) or brew install poppler (macOS)
```

If you only need to read .docx files, use docx-read which only requires python-docx.

### Installation Verification

```python
# Verify python-docx installation
import docx
print(docx.__version__)  # Should print version number

# Verify Pillow for image handling
from PIL import Image
print(Image.__version__)

# Verify pandoc (optional)
try:
    import pypandoc
    print("Pandoc available:", pypandoc.get_pandoc_version())
except ImportError:
    print("Pandoc not installed")
```

---

## Quick Reference

### Essential Imports

```python
from docx import Document
from docx.shared import Pt, RGBColor, Inches, Cm, Emu, Twips
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING, WD_UNDERLINE
from docx.enum.style import WD_STYLE_TYPE
from docx.enum.section import WD_ORIENT, WD_SECTION_START
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
from docx.oxml.shared import parse_xml
```

### Common Operations Cheat Sheet

```python
# Create new document
doc = Document()

# Add heading
doc.add_heading("Document Title", level=1)

# Add paragraph with styling
p = doc.add_paragraph("Body text here")
p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY

# Format text runs
run = p.add_run("bold text")
run.bold = True
run.font.size = Pt(12)
run.font.color.rgb = RGBColor(0, 0, 255)  # Blue

# Add table
table = doc.add_table(rows=3, cols=3)
table.style = 'Table Grid'
cell = table.cell(0, 0)
cell.text = "Header"

# Add image
doc.add_picture("image.png", width=Inches(6.0))

# Add page break
doc.add_page_break()

# Set document properties
doc.core_properties.title = "Report Title"
doc.core_properties.author = "Author Name"

# Save document
doc.save("output.docx")
```

---

## Creating Documents

### Document Initialization

```python
from docx import Document

# Create blank document
doc = Document()

# Create from template
doc = Document("template.docx")

# Create from existing document (for editing)
doc = Document("existing.docx")
```

### Headings

Word provides built-in heading styles from level 1 to level 9:

```python
# Add headings at different levels
doc.add_heading("Document Title", level=0)  # Title style
doc.add_heading("Chapter Title", level=1)   # Heading 1
doc.add_heading("Section", level=2)         # Heading 2
doc.add_heading("Subsection", level=3)      # Heading 3
doc.add_heading("Paragraph Heading", level=4)  # Heading 4

# Headings level 5-9 for deep hierarchies
doc.add_heading("Minor Heading", level=5)
```

### Paragraphs and Text

```python
# Add simple paragraph
p = doc.add_paragraph("This is a paragraph of text.")

# Add paragraph with style
p = doc.add_paragraph("Styled paragraph", style="Intense Quote")

# Build paragraph incrementally
p = doc.add_paragraph()
p.add_run("First part of text. ")
run = p.add_run("Second part with different formatting.")
run.italic = True  # add_run() does not accept style param; apply formatting directly

# Set paragraph alignment
from docx.enum.text import WD_ALIGN_PARAGRAPH

p.alignment = WD_ALIGN_PARAGRAPH.LEFT      # Left aligned
p.alignment = WD_ALIGN_PARAGRAPH.CENTER    # Centered
p.alignment = WD_ALIGN_PARAGRAPH.RIGHT     # Right aligned
p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY   # Justified (both edges aligned)
p.alignment = WD_ALIGN_PARAGRAPH.DISTRIBUTE  # Distributed

# Paragraph spacing (in points)
p.paragraph_format.space_before = Pt(12)
p.paragraph_format.space_after = Pt(6)
p.paragraph_format.line_spacing = Pt(15)  # Fixed line spacing
```

### Font Formatting

```python
from docx.shared import Pt, RGBColor

run = p.add_run("Formatted text")
run.font.size = Pt(12)
run.bold = True
run.italic = True
run.underline = True
run.font.color.rgb = RGBColor(0, 0, 255)  # Blue
run.font.name = "Calibri"
# Underline: SINGLE, DOUBLE, THICK, DOTTED, DASH, WORDS
# Other: subscript, superscript, small_caps, all_caps, strike
```

---

## Tables

### Creating Tables

```python
# Create table with specified dimensions
table = doc.add_table(rows=5, cols=4)

# Create table with style
table = doc.add_table(rows=3, cols=3, style='Table Grid')

# Available built-in table styles:
# 'Table Grid', 'Light Shading', 'Light Shading Accent 1-6',
# 'Medium Shading 1', 'Medium Shading 2', 'Medium List 1', 'Medium List 2',
# 'Medium Grid 1', 'Medium Grid 2', 'Medium Grid 3',
# 'Dark List', 'Colorful Grid', 'Colorful List', 'Colorful Grid Accent 1-6'
```

### Cell Access and Manipulation

```python
# Access cell by row, column indices
cell = table.cell(0, 0)  # First row, first column
cell = table.cell(2, 3)  # Third row, fourth column

# Set cell content
cell.text = "Cell content"

# Access cell paragraphs
paragraphs = cell.paragraphs
first_para = cell.paragraphs[0]

# Add new paragraph to cell
new_para = cell.add_paragraph("Additional text in cell")

# Access cell runs for formatting
run = first_para.runs[0] if first_para.runs else first_para.add_run()
run.bold = True
run.font.size = Pt(11)

# Iterate through all cells
for row in table.rows:
    for cell in row.cells:
        print(cell.text)

# Access rows and columns
rows = table.rows
columns = table.columns

# Get cell dimensions
width = cell.width
height = cell._tc.get_or_add_tcPr().tcW.w if cell._tc.get_or_add_tcPr().tcW else None
```

### Cell Formatting

```python
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

tc_pr = cell._tc.get_or_add_tcPr()

# Set width
tc_w = OxmlElement('w:tcW') if tc_pr.tcW is None else tc_pr.tcW
tc_w.set(qn('w:w'), str(Inches(2).emu))
tc_w.set(qn('w:type'), 'dxa')
tc_pr.append(tc_w) if tc_pr.tcW is None else None

# Set shading (background)
shd = OxmlElement('w:shd')
shd.set(qn('w:fill'), '4472C4')  # Blue
shd.set(qn('w:val'), 'clear')
tc_pr.append(shd)
```

### Header Row

```python
for cell in table.rows[0].cells:
    for para in cell.paragraphs:
        for run in para.runs:
            run.bold = True
    # Add shading
    shd = OxmlElement('w:shd')
    shd.set(qn('w:fill'), '4472C4')
    cell._tc.get_or_add_tcPr().append(shd)
```

### Column Widths & Merging

```python
# Set column width
for cell in table.columns[0].cells:
    tc_pr = cell._tc.get_or_add_tcPr()
    tc_w = OxmlElement('w:tcW')
    tc_w.set(qn('w:w'), str(Inches(2).emu))
    tc_pr.append(tc_w)

# Merge cells
table.cell(1, 0).merge(table.cell(1, 2))  # Horizontal
table.cell(2, 0).merge(table.cell(4, 0))  # Vertical
```

### Alternating Rows

```python
for i, row in enumerate(table.rows):
    color = 'F2F2F2' if i % 2 == 0 else 'FFFFFF'
    for cell in row.cells:
        shd = OxmlElement('w:shd')
        shd.set(qn('w:fill'), color)
        cell._tc.get_or_add_tcPr().append(shd)
```

---

## Images & Lists

### Images

```python
from docx.shared import Inches, Cm

doc.add_picture("image.png", width=Inches(6.0))
doc.add_picture("image.png", width=Inches(6.0), height=Inches(4.0))

# With caption
p = doc.add_paragraph()
p.add_run().add_picture("image.png", width=Inches(6.0))
doc.add_paragraph("Figure 1: Description", style="Caption")

# Center image
p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
p.add_run().add_picture("image.png", width=Inches(6.0))
```

**Formats:** PNG, JPEG, GIF, BMP, TIFF, WMF, EMF

### Lists

```python
# Bulleted
for item in ["First", "Second", "Third"]:
    p = doc.add_paragraph(style="List Bullet")
    p.add_run(item)

# Numbered
for item in ["Step 1", "Step 2", "Step 3"]:
    p = doc.add_paragraph(style="List Number")
    p.add_run(item)

# Nested (level 2)
p = doc.add_paragraph(style="List Bullet 2")
p.add_run("Sub-item")
```
    
    num_fmt = OxmlElement('w:numFmt')
    num_fmt.set(qn('w:val'), 'bullet')  # or 'decimal', 'lowerLetter', etc.
    lvl.append(num_fmt)
    
    lvl_text = OxmlElement('w:lvlText')
    lvl_text.set(qn('w:val'), '')  # Bullet character
    lvl.append(lvl_text)
    
    abstract_num.append(lvl)
    numbering.append(abstract_num)
    
    # Numbering instance
    num = OxmlElement('w:num')
    num.set(qn('w:numId'), str(num_id + 100))
    
    abstract_num_id = OxmlElement('w:abstractNumId')
    abstract_num_id.set(qn('w:val'), str(num_id))
    num.append(abstract_num_id)
    
    numbering.append(num)
```

---

## LaTeX Equations (Math)

### Writing: Inserting LaTeX Equations into Word Documents

The `latex2word` library converts LaTeX math formulas to native Word equations (OMML format), producing editable Office Math objects rather than static images.

#### Dependencies

```bash
pip install latex2word python-docx
```

#### Basic Usage

```python
from docx import Document
from latex2word import LatexToWordElement

doc = Document()
paragraph = doc.add_paragraph("The quadratic formula is: ")
LatexToWordElement(r"x={-b \pm \sqrt{b^2-4ac}\over 2a}").add_latex_to_paragraph(paragraph)
doc.save('formula.docx')
```

#### API Reference

**`LatexToWordElement(latex: str)`** — Create a converter from a LaTeX formula string.

Methods:
- `element() -> lxml.etree._Element`: Returns the OMML XML element for manual insertion.
- `add_latex_to_paragraph(paragraph) -> None`: Appends the formula directly into a `python-docx` paragraph.

Conversion pipeline: LaTeX → MathML → OMML → lxml Element → Word paragraph.

#### Usage Patterns

```python
from docx import Document
from latex2word import LatexToWordElement

doc = Document()

# Inline formula with surrounding text
p = doc.add_paragraph()
p.add_run("The mass-energy equivalence is ")
LatexToWordElement(r"E = mc^2").add_latex_to_paragraph(p)
p.add_run(", where c is the speed of light.")

# Multiple formulas
formulas = [
    r"\int_{-\infty}^{\infty} e^{-x^2} dx = \sqrt{\pi}",
    r"\sum_{i=1}^{n} i = \frac{n(n+1)}{2}",
    r"e^{i\pi} + 1 = 0",
]
for latex_str in formulas:
    p = doc.add_paragraph()
    LatexToWordElement(latex_str).add_latex_to_paragraph(p)

# Manual element insertion (for advanced control over element placement)
formula = LatexToWordElement(r"\frac{d}{dx}\int_a^x f(t) dt = f(x)")
omml_elem = formula.element()
paragraph._element.append(omml_elem)

# Complex expressions: matrices, integrals, sums
p = doc.add_paragraph("Fourier Transform: ")
LatexToWordElement(
    r"\hat f(\xi) = \int_{-\infty}^{\infty} f(x) e^{-2\pi i x \xi} \, dx"
).add_latex_to_paragraph(p)

doc.save('equations.docx')
```

#### Limitations

- Depends on `latex2mathml` — not all LaTeX commands are supported; test complex formulas before bulk generation.
- Invalid LaTeX may raise exceptions from underlying converters; wrap in try-except for robustness.
- Font rendering: multiple formulas may share the last applied font setting.
- Requires Word 2010+ for native OMML support.

---

### Reading: Extracting LaTeX Equations from Word Documents

The `docxlatex` library extracts text and mathematical equations from existing .docx files, converting Word's OMML equations back to LaTeX format.

#### Dependencies

```bash
pip install docxlatex
```

#### Basic Usage

```python
from docxlatex import Document

doc = Document("existing.docx")
text = doc.get_text()
equations = doc.equations  # List of LaTeX equation strings

print(f"Found {len(equations)} equations:")
for i, eq in enumerate(equations, 1):
    print(f"  {i}. {eq}")
```

#### API Reference

**`Document(path: str, inline_delimiter="$", block_delimiter="$$")`** — Open a .docx file for equation extraction.

Attributes:
- `equations: list[str]` — Populated after calling `get_text()`. Contains LaTeX code for each equation found.

Methods:
- `get_text(linear_format=False, get_header_text=False, get_footer_text=False, image_dir=None, image_extensions=None) -> str` — Extracts full document text with equations wrapped in LaTeX delimiters.
- `get_xml() -> str` — Returns pretty-printed XML of the document body.
- `pprint_xml() -> None` — Prints document XML to stdout.

#### Usage Patterns

```python
from docxlatex import Document

# Custom delimiters
doc = Document("paper.docx", inline_delimiter="$", block_delimiter="$$")
text = doc.get_text()

# Include headers and footers
doc = Document("report.docx")
text = doc.get_text(get_header_text=True, get_footer_text=True)

# Linear format (Word's linear equation input mode)
doc = Document("linear.docx")
text = doc.get_text(linear_format=True)

# Extract images alongside text
doc = Document("illustrated.docx")
text = doc.get_text(image_dir="./extracted_images")

# Access equations list independently
doc = Document("math-paper.docx")
_ = doc.get_text()  # Triggers parsing; populates doc.equations
for eq in doc.equations:
    print(eq)  # Raw LaTeX without delimiters

# Batch processing
import os
for filename in os.listdir("documents"):
    if filename.endswith(".docx"):
        doc = Document(os.path.join("documents", filename))
        text = doc.get_text()
        output = filename.replace(".docx", ".txt")
        with open(os.path.join("output", output), "w", encoding="utf-8") as f:
            f.write(text)
```

#### Equation Format Notes

- Inline equations appear as `$ latex $` in the output text.
- Block/display equations (on their own line) automatically use `$$ latex $$`.
- The `equations` list contains raw LaTeX strings **without** delimiters.
- Delimiters are configurable: use `inline_delimiter="\\("` and `block_delimiter="\\["` for LaTeX-style markers.
- Supports 20 OMML tag types including fractions, radicals, matrices, n-ary operators, accents, and delimiters.

---

## Table of Contents

### Overview

The TOC in Word is a **field code** that Word evaluates to generate a clickable table from headings. python-docx can insert the field code and configure TOC entry styles, but **TOC content (entries + page numbers) is only populated when the document is opened in Word** or processed via LibreOffice.

This section covers:
1. **Inserting** a TOC field with custom switches
2. **Styling** TOC entries (font, indentation, tab leaders for each level)
3. **Auto-updating** the TOC so users don't need to manually press F9

### Inserting a TOC Field

```python
from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.oxml.shared import parse_xml

def insert_toc_field(paragraph, field_instruction=' TOC \\o "1-3" \\h \\z \\u '):
    """Insert a TOC field into a paragraph."""
    # Begin field char
    run_begin = OxmlElement('w:r')
    fldChar_begin = OxmlElement('w:fldChar')
    fldChar_begin.set(qn('w:fldCharType'), 'begin')
    run_begin.append(fldChar_begin)
    paragraph._p.append(run_begin)

    # Instruction text
    run_instr = OxmlElement('w:r')
    instrText = OxmlElement('w:instrText')
    instrText.set(qn('xml:space'), 'preserve')
    instrText.text = field_instruction
    run_instr.append(instrText)
    paragraph._p.append(run_instr)

    # Separator
    run_sep = OxmlElement('w:r')
    fldChar_sep = OxmlElement('w:fldChar')
    fldChar_sep.set(qn('w:fldCharType'), 'separate')
    run_sep.append(fldChar_sep)
    paragraph._p.append(run_sep)

    # Placeholder (Word replaces this on update)
    run_placeholder = OxmlElement('w:r')
    t_placeholder = OxmlElement('w:t')
    t_placeholder.text = 'Right-click and select "Update Field" to generate TOC'
    run_placeholder.append(t_placeholder)
    paragraph._p.append(run_placeholder)

    # End field char
    run_end = OxmlElement('w:r')
    fldChar_end = OxmlElement('w:fldChar')
    fldChar_end.set(qn('w:fldCharType'), 'end')
    run_end.append(fldChar_end)
    paragraph._p.append(run_end)


# Usage
doc = Document()
toc_para = doc.add_paragraph()
insert_toc_field(toc_para, ' TOC \\o "1-3" \\h \\z \\u ')
```

### TOC Field Switches — Complete Reference

| Switch | Description | Example |
|--------|-------------|---------|
| `\o "1-3"` | Build TOC from built-in Heading styles (levels 1-3) | `TOC \o "1-3"` |
| `\h` | Make TOC entries hyperlinks (Ctrl+Click to navigate) | `TOC \o "1-3" \h` |
| `\z` | Hide tab leader and page numbers in Web layout view | `TOC \o "1-3" \z` |
| `\u` | Use applied paragraph outline level | `TOC \o "1-3" \u` |
| `\n "1-3"` | Omit page numbers for specified levels | `TOC \o "1-3" \n "2-3"` |
| `\t "Style,level;..."` | Map custom styles to TOC levels | `TOC \t "MyH1,1;MyH2,2"` |
| `\b BookmarkName` | Build TOC only from a bookmarked range | `TOC \b Ch1 \o "1-3"` |
| `\c "SEQ id"` | Build from SEQ fields (for Table of Figures) | `TOC \c "Figure"` |
| `\p "sep"` | Separator between entry and page number | `TOC \o "1-3" \p " — "` |

**Most common combination:**
```
TOC \o "1-3" \h \z \u
```

**With custom style mapping:**
```
TOC \o "1-3" \t "ChapterTitle,1;SectionTitle,2" \h \z \u
```

### Styling TOC Entries (TOC 1, TOC 2, TOC 3...)

Each TOC level is rendered using a built-in paragraph style named **"TOC 1"**, **"TOC 2"**, etc. You can customize font, indentation, spacing, and tab stops for each level:

```python
from docx import Document
from docx.shared import Pt, Inches, RGBColor
from docx.enum.text import WD_TAB_ALIGNMENT, WD_TAB_LEADER
from docx.enum.style import WD_STYLE_TYPE

def configure_toc_styles(doc, page_width=Inches(6.0)):
    """
    Configure TOC 1/2/3 styles with custom font, indent, and dot-leader tab stops.
    Call BEFORE inserting the TOC field.
    """
    configs = {
        'TOC 1': {
            'font_name': 'SimHei',
            'font_size': Pt(14),
            'bold': True,
            'color': RGBColor(0, 51, 102),
            'left_indent': Inches(0),
            'space_before': Pt(6),
            'space_after': Pt(3),
        },
        'TOC 2': {
            'font_name': 'Microsoft YaHei',
            'font_size': Pt(12),
            'bold': False,
            'color': RGBColor(51, 51, 51),
            'left_indent': Inches(0.4),
            'space_before': Pt(3),
            'space_after': Pt(2),
        },
        'TOC 3': {
            'font_name': 'Microsoft YaHei',
            'font_size': Pt(10.5),
            'bold': False,
            'color': RGBColor(102, 102, 102),
            'left_indent': Inches(0.8),
            'space_before': Pt(2),
            'space_after': Pt(1),
        },
    }

    for style_name, cfg in configs.items():
        # Access or create the style
        try:
            style = doc.styles[style_name]
        except KeyError:
            style = doc.styles.add_style(style_name, WD_STYLE_TYPE.PARAGRAPH)

        # Font
        style.font.name = cfg['font_name']
        style.font.size = cfg['font_size']
        style.font.bold = cfg['bold']
        style.font.color.rgb = cfg['color']

        # Paragraph format
        style.paragraph_format.left_indent = cfg['left_indent']
        style.paragraph_format.space_before = cfg['space_before']
        style.paragraph_format.space_after = cfg['space_after']

        # Right-aligned tab stop with dot leader for page numbers
        tab_stops = style.paragraph_format.tab_stops
        tab_stops.add_tab_stop(
            page_width,
            WD_TAB_ALIGNMENT.RIGHT,
            WD_TAB_LEADER.DOTS
        )


# Usage
doc = Document()
configure_toc_styles(doc)
toc_para = doc.add_paragraph()
insert_toc_field(toc_para)
```

**Tab leader types** (`WD_TAB_LEADER`):
- `DOTS` — Dot leader (......1)
- `DASHES` — Dash leader (------1)
- `UNDERSCORE` — Underscore (______1)
- `SPACES` — No leader (default)

### Auto-Updating TOC (Avoid Manual F9)

python-docx **cannot** execute field updates — TOC entry text and page numbers require a layout engine (Word or LibreOffice). However, you can minimize manual intervention:

#### Method 1: `w:updateFields` in settings.xml (Cross-Platform)

Sets a flag so Word **automatically prompts** to update all fields (including TOC) on first open. This does NOT compute page numbers but eliminates the manual "Update Field" step:

```python
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

def enable_auto_update_fields(doc):
    """Add w:updateFields to settings.xml so Word prompts to update fields on open."""
    settings = doc.settings.element
    existing = settings.find(qn('w:updateFields'))
    if existing is not None:
        existing.set(qn('w:val'), 'true')
    else:
        update_fields = OxmlElement('w:updateFields')
        update_fields.set(qn('w:val'), 'true')
        settings.append(update_fields)

# Usage
doc = Document()
# ... build document ...
enable_auto_update_fields(doc)
doc.save('output.docx')
```

#### Method 2: win32com — Full TOC Update (Windows Only, MS Word required)

Actually updates all TOC entries with correct page numbers. Requires `pywin32` and Microsoft Word installed:

```python
import win32com.client

def update_toc_full(docx_path):
    """Open in Word, update all TOC fields, save, and close."""
    word = win32com.client.DispatchEx("Word.Application")
    word.Visible = False
    word.DisplayAlerts = False
    try:
        doc = word.Documents.Open(docx_path)
        for i in range(1, doc.TablesOfContents.Count + 1):
            doc.TablesOfContents(i).Update()
        doc.Fields.Update()
        doc.Close(SaveChanges=True)
    finally:
        word.Quit()
```

#### Method 3: LibreOffice Headless (Linux/macOS)

Uses LibreOffice to re-save the document, which forces field recalculation:

```bash
soffice --headless --convert-to docx --outdir ./output input.docx
```

Python wrapper:
```python
import subprocess
import os

def update_toc_libreoffice(docx_path):
    """Re-save via LibreOffice to force TOC recalculation."""
    out_dir = os.path.dirname(docx_path)
    subprocess.run([
        'soffice', '--headless',
        '--convert-to', 'docx',
        '--outdir', out_dir,
        docx_path
    ], check=True, timeout=120)
```

#### Recommended Combined Approach

```python
def prepare_document_with_toc(docx_path):
    """Set auto-update flag + platform-specific full update."""
    from docx import Document

    doc = Document(docx_path)
    enable_auto_update_fields(doc)
    doc.save(docx_path)

    # Then run platform-specific update:
    # Windows: update_toc_full(docx_path)
    # Linux/macOS: update_toc_libreoffice(docx_path)
```

This way the TOC is correct immediately AND will auto-update on future Word opens.

### Manual TOC Generation (Fallback)

For scenarios where Word/LibreOffice is unavailable, generate TOC content as plain text from headings:

```python
def generate_manual_toc(doc, max_level=3):
    """Generate a manual TOC as a table (no field code, no page numbers)."""
    doc.add_paragraph('Table of Contents').runs[0].bold = True

    toc_table = doc.add_table(rows=0, cols=2)
    toc_table.style = 'Table Grid'

    for para in doc.paragraphs:
        if para.style.name.startswith('Heading'):
            try:
                level = int(para.style.name.replace('Heading ', ''))
            except ValueError:
                continue
            if level <= max_level:
                row = toc_table.add_row()
                indent = '    ' * (level - 1)
                row.cells[0].text = f'{indent}{para.text}'
                row.cells[1].text = ''  # Page number unknown

    return toc_table
```


---

## Numbering

### Overview

Word's numbering system controls both **heading numbering** (1., 1.1, 1.1.1) and **paragraph list numbering** (a., i., ①). python-docx does NOT have a high-level API for custom multi-level numbering — you must work directly with OOXML elements in `numbering.xml`.

> **核心原则：禁止手动标题前缀**
>
> 所有标题编号必须由 OOXML numbering 系统自动管理。**严禁**在标题文本中手动写入数字、字母、章节号等前缀——如 `"1. 概述"`、`"A. 法律编号"`、`"第一章 项目背景"`。
>
> 正确做法：标题文本仅包含纯文字内容（如 `"概述"`、`"项目背景"`），编号由 `w:numPr` + `w:abstractNum` 自动生成。这样增删章节时编号自动调整，无需手动维护。
>
> **推荐：样式级编号 vs 段落级编号**
>
> 将 `<w:numPr>` 注入样式定义（`apply_numbering_to_style()`）优于逐段落调用 `apply_numbering()`：
> - **一次定义，全局生效** — 之后所有 `doc.add_heading()` 自动带编号
> - **零 per-paragraph 开销** — 不需要记住或重复调用
> - **更鲁棒** — 不会遗漏，不会因为忘记调用导致某段无编号
>
> `apply_numbering()` 保留用于一次性例外场景（如个别段落临时需要不同编号）。

The architecture:
```
numbering.xml
├── <w:abstractNum>   ← Template: defines format for each level
│   ├── <w:lvl w:ilvl="0">   Level 0: "1." or "第一章"
│   ├── <w:lvl w:ilvl="1">   Level 1: "1.1"
│   └── <w:lvl w:ilvl="2">   Level 2: "1.1.1"
└── <w:num w:numId="1">      ← Concrete instance
    └── <w:abstractNumId>    → links to abstractNum

Paragraph XML:
<w:pPr>
  <w:numPr>
    <w:ilvl w:val="0"/>      ← which level
    <w:numId w:val="1"/>     ← which numbering instance
  </w:numPr>
</w:pPr>
```

### Multi-Level Heading Numbering

#### Standard Legal Numbering (1., 1.1, 1.1.1)

```python
from docx import Document
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

def create_heading_numbering(doc, levels=3, start=1):
    """
    Create multi-level heading numbering: 1., 1.1, 1.1.1
    Returns the numId to use with apply_numbering().
    """
    numbering_part = doc.part.numbering_part
    numbering_elm = numbering_part._element

    # --- Create abstractNum (template) ---
    existing_abs = numbering_elm.xpath('./w:abstractNum/@w:abstractNumId')
    next_abs_id = max([int(x) for x in existing_abs], default=-1) + 1

    abstractNum = OxmlElement('w:abstractNum')
    abstractNum.set(qn('w:abstractNumId'), str(next_abs_id))

    multiLevelType = OxmlElement('w:multiLevelType')
    multiLevelType.set(qn('w:val'), 'multilevel')
    abstractNum.append(multiLevelType)

    for ilvl in range(levels):
        lvl = OxmlElement('w:lvl')
        lvl.set(qn('w:ilvl'), str(ilvl))

        # Start number
        start_el = OxmlElement('w:start')
        start_el.set(qn('w:val'), str(start))
        lvl.append(start_el)

        # Number format
        numFmt = OxmlElement('w:numFmt')
        numFmt.set(qn('w:val'), 'decimal')
        lvl.append(numFmt)

        # Level text: %1., %1.%2, %1.%2.%3
        lvlText = OxmlElement('w:lvlText')
        parts = ['%' + str(i + 1) for i in range(ilvl + 1)]
        lvlText.set(qn('w:val'), '.'.join(parts) + '.')
        lvl.append(lvlText)

        # Justification
        lvlJc = OxmlElement('w:lvlJc')
        lvlJc.set(qn('w:val'), 'left')
        lvl.append(lvlJc)

        # Paragraph properties — indentation
        pPr = OxmlElement('w:pPr')
        ind = OxmlElement('w:ind')
        ind.set(qn('w:left'), str(420 * (ilvl + 1)))
        ind.set(qn('w:hanging'), '420')
        pPr.append(ind)
        lvl.append(pPr)

        abstractNum.append(lvl)

    numbering_elm.insert(0, abstractNum)

    # --- Create num (concrete instance) ---
    existing_nums = numbering_elm.xpath('./w:num/@w:numId')
    next_num_id = max([int(x) for x in existing_nums], default=0) + 1

    num = OxmlElement('w:num')
    num.set(qn('w:numId'), str(next_num_id))

    abstractNumId = OxmlElement('w:abstractNumId')
    abstractNumId.set(qn('w:val'), str(next_abs_id))
    num.append(abstractNumId)

    numbering_elm.append(num)
    return next_num_id


def apply_numbering(paragraph, num_id, ilvl=0):
    """Apply a numbering instance to a paragraph."""
    pPr = paragraph._p.get_or_add_pPr()

    # Remove existing numPr
    existing = pPr.find(qn('w:numPr'))
    if existing is not None:
        pPr.remove(existing)

    numPr = OxmlElement('w:numPr')

    ilvl_el = OxmlElement('w:ilvl')
    ilvl_el.set(qn('w:val'), str(ilvl))
    numPr.append(ilvl_el)

    numId_el = OxmlElement('w:numId')
    numId_el.set(qn('w:val'), str(num_id))
    numPr.append(numId_el)

    pPr.insert(0, numPr)


def apply_numbering_to_style(doc, style_name, num_id, ilvl):
    """Inject numbering into a paragraph style definition (styles.xml).
    
    Once applied, ALL paragraphs using this style are auto-numbered — 
    no per-paragraph apply_numbering() calls needed.
    
    Args:
        doc: Document object.
        style_name: 'Heading 1', 'Heading 2', 'Heading 3', etc.
        num_id: Numbering instance ID from create_heading_numbering().
        ilvl: Level index (0=Heading 1, 1=Heading 2, etc.).
    """
    style = doc.styles[style_name]
    pPr = style.element.find(qn('w:pPr'))
    if pPr is None:
        pPr = OxmlElement('w:pPr')
        style.element.insert(0, pPr)
    
    # Remove existing numPr
    existing = pPr.find(qn('w:numPr'))
    if existing is not None:
        pPr.remove(existing)
    
    numPr = OxmlElement('w:numPr')
    ilvl_el = OxmlElement('w:ilvl')
    ilvl_el.set(qn('w:val'), str(ilvl))
    numPr.append(ilvl_el)
    numId_el = OxmlElement('w:numId')
    numId_el.set(qn('w:val'), str(num_id))
    numPr.append(numId_el)
    pPr.insert(0, numPr)


# ===== USAGE (Style-Based — Recommended) =====
doc = Document()
num_id = create_heading_numbering(doc, levels=3)

# Inject numbering into styles — once, globally
apply_numbering_to_style(doc, 'Heading 1', num_id, 0)
apply_numbering_to_style(doc, 'Heading 2', num_id, 1)
apply_numbering_to_style(doc, 'Heading 3', num_id, 2)

# All headings now auto-numbered — no per-paragraph work
doc.add_heading('Introduction', level=1)
doc.add_heading('Background', level=2)
doc.add_heading('Literature Review', level=3)
doc.add_heading('Methodology', level=1)
doc.add_heading('Data Collection', level=2)

doc.save('numbered.docx')
# Result:
# 1. Introduction
#   1.1 Background
#     1.1.1 Literature Review
# 2. Methodology
#   2.1 Data Collection
```

#### Chinese Chapter Numbering (第一章, 1.1, 1.1.1)

For Chinese documents with mixed chapter/section numbering:

> **关键技巧：`w:isLgl` 强制子级用阿拉伯数字**
>
> 默认情况下，子级的 `%1` 引用会**继承上级的 `numFmt`**。如果不加处理：
>
> | Level | `numFmt` | `lvlText` | 不加 isLgl | 加 isLgl |
> |-------|----------|-----------|-----------|----------|
> | 0 (H1) | `chineseCounting` | `第%1章` | 第一章 | 第一章 |
> | 1 (H2) | `decimal` | `%1.%2` | **一.1** ❌ | **1.1** ✅ |
> | 2 (H3) | `decimal` | `%1.%2.%3` | **一.1.1** ❌ | **1.1.1** ✅ |
>
> 子级添加 `<w:isLgl/>` 后，所有 `%N` 强制以 Arabic 数字渲染，实现混合格式。

```python
def create_chinese_heading_numbering(doc):
    """
    Creates: 第一章, 1.1, 1.1.1 (混合中英文编号)
    Uses isLgl to force Arabic numerals in sub-levels.
    """
    numbering_part = doc.part.numbering_part
    numbering_elm = numbering_part._element

    existing_abs = numbering_elm.xpath('./w:abstractNum/@w:abstractNumId')
    next_abs_id = max([int(x) for x in existing_abs], default=-1) + 1

    abstractNum = OxmlElement('w:abstractNum')
    abstractNum.set(qn('w:abstractNumId'), str(next_abs_id))

    multiLevelType = OxmlElement('w:multiLevelType')
    multiLevelType.set(qn('w:val'), 'multilevel')
    abstractNum.append(multiLevelType)

    # Level 0: 第一章, 第二章... (Chinese chapter names)
    lvl0 = OxmlElement('w:lvl')
    lvl0.set(qn('w:ilvl'), '0')

    start0 = OxmlElement('w:start')
    start0.set(qn('w:val'), '1')
    lvl0.append(start0)

    numFmt0 = OxmlElement('w:numFmt')
    numFmt0.set(qn('w:val'), 'chineseCountingThousand')  # 一, 二, 三...
    lvl0.append(numFmt0)

    lvlText0 = OxmlElement('w:lvlText')
    lvlText0.set(qn('w:val'), '第%1章')  # 第一章
    lvl0.append(lvlText0)

    lvlJc0 = OxmlElement('w:lvlJc')
    lvlJc0.set(qn('w:val'), 'left')
    lvl0.append(lvlJc0)

    pPr0 = OxmlElement('w:pPr')
    ind0 = OxmlElement('w:ind')
    ind0.set(qn('w:left'), '420')
    ind0.set(qn('w:hanging'), '420')
    pPr0.append(ind0)
    lvl0.append(pPr0)
    abstractNum.append(lvl0)

    # Level 1: 1.1, 1.2... (decimal)
    # isLgl: force %1 to render as Arabic, not Chinese 一
    lvl1 = OxmlElement('w:lvl')
    lvl1.set(qn('w:ilvl'), '1')
    lvl1.append(_make_start(1))
    lvl1.append(_make_numFmt('decimal'))
    lvl1.append(_make_lvlText('%1.%2'))
    lvl1.append(_make_isLgl())
    lvl1.append(_make_lvlJc())
    pPr1 = OxmlElement('w:pPr')
    ind1 = OxmlElement('w:ind')
    ind1.set(qn('w:left'), '840')
    ind1.set(qn('w:hanging'), '420')
    pPr1.append(ind1)
    lvl1.append(pPr1)
    abstractNum.append(lvl1)

    # Level 2: 1.1.1, 1.1.2... (decimal)
    # isLgl: force %1 and %2 to render as Arabic
    lvl2 = OxmlElement('w:lvl')
    lvl2.set(qn('w:ilvl'), '2')
    lvl2.append(_make_start(1))
    lvl2.append(_make_numFmt('decimal'))
    lvl2.append(_make_lvlText('%1.%2.%3'))
    lvl2.append(_make_isLgl())
    lvl2.append(_make_lvlJc())
    pPr2 = OxmlElement('w:pPr')
    ind2 = OxmlElement('w:ind')
    ind2.set(qn('w:left'), '1260')
    ind2.set(qn('w:hanging'), '420')
    pPr2.append(ind2)
    lvl2.append(pPr2)
    abstractNum.append(lvl2)

    numbering_elm.insert(0, abstractNum)

    # Create num instance
    existing_nums = numbering_elm.xpath('./w:num/@w:numId')
    next_num_id = max([int(x) for x in existing_nums], default=0) + 1

    num = OxmlElement('w:num')
    num.set(qn('w:numId'), str(next_num_id))

    abstractNumId = OxmlElement('w:abstractNumId')
    abstractNumId.set(qn('w:val'), str(next_abs_id))
    num.append(abstractNumId)

    numbering_elm.append(num)
    return next_num_id


# Helpers
def _make_start(val):
    el = OxmlElement('w:start')
    el.set(qn('w:val'), str(val))
    return el

def _make_numFmt(fmt):
    el = OxmlElement('w:numFmt')
    el.set(qn('w:val'), fmt)
    return el

def _make_lvlText(text):
    el = OxmlElement('w:lvlText')
    el.set(qn('w:val'), text)
    return el

def _make_lvlJc():
    el = OxmlElement('w:lvlJc')
    el.set(qn('w:val'), 'left')
    return el

def _make_isLgl():
    el = OxmlElement('w:isLgl')
    return el


# Usage (Style-Based)
doc = Document()
num_id = create_chinese_heading_numbering(doc)

apply_numbering_to_style(doc, 'Heading 1', num_id, 0)
apply_numbering_to_style(doc, 'Heading 2', num_id, 1)
apply_numbering_to_style(doc, 'Heading 3', num_id, 2)

doc.add_heading('项目背景', level=1)
doc.add_heading('市场分析', level=2)
doc.add_heading('竞争对手分析', level=3)
doc.add_heading('技术方案', level=1)
doc.add_heading('系统架构', level=2)

doc.save('chinese_numbered.docx')
# Result:
# 第一章 项目背景
#   1.1 市场分析
#     1.1.1 竞争对手分析
# 第二章 技术方案
#   2.1 系统架构
```

### Paragraph-Level Numbering (Non-Headings)

For numbered lists in body text (not linked to heading styles):

```python
def create_paragraph_numbering(doc, num_fmt='decimal', start=1):
    """
    Create a single-level numbered list for body paragraphs.
    """
    numbering_part = doc.part.numbering_part
    numbering_elm = numbering_part._element

    existing_abs = numbering_elm.xpath('./w:abstractNum/@w:abstractNumId')
    next_abs_id = max([int(x) for x in existing_abs], default=-1) + 1

    abstractNum = OxmlElement('w:abstractNum')
    abstractNum.set(qn('w:abstractNumId'), str(next_abs_id))

    # Number format
    numFmt = OxmlElement('w:numFmt')
    numFmt.set(qn('w:val'), num_fmt)
    abstractNum.append(numFmt)

    # Level text
    lvlText = OxmlElement('w:lvlText')
    lvlText.set(qn('w:val'), '%1.')
    abstractNum.append(lvlText)

    # Level definition
    lvl = OxmlElement('w:lvl')
    lvl.set(qn('w:ilvl'), '0')

    start_el = OxmlElement('w:start')
    start_el.set(qn('w:val'), str(start))
    lvl.append(start_el)

    numFmt_lvl = OxmlElement('w:numFmt')
    numFmt_lvl.set(qn('w:val'), num_fmt)
    lvl.append(numFmt_lvl)

    lvlText_lvl = OxmlElement('w:lvlText')
    lvlText_lvl.set(qn('w:val'), '%1.')
    lvl.append(lvlText_lvl)

    lvlJc = OxmlElement('w:lvlJc')
    lvlJc.set(qn('w:val'), 'left')
    lvl.append(lvlJc)

    abstractNum.append(lvl)
    numbering_elm.insert(0, abstractNum)

    # Create num instance
    existing_nums = numbering_elm.xpath('./w:num/@w:numId')
    next_num_id = max([int(x) for x in existing_nums], default=0) + 1

    num = OxmlElement('w:num')
    num.set(qn('w:numId'), str(next_num_id))

    abstractNumId = OxmlElement('w:abstractNumId')
    abstractNumId.set(qn('w:val'), str(next_abs_id))
    num.append(abstractNumId)

    numbering_elm.append(num)
    return next_num_id


# Usage: apply to body paragraphs
doc = Document()
num_id = create_paragraph_numbering(doc, num_fmt='decimal')

para1 = doc.add_paragraph('First ordered item')
apply_numbering(para1, num_id, ilvl=0)

para2 = doc.add_paragraph('Second ordered item')
apply_numbering(para2, num_id, ilvl=0)

doc.save('body_numbered.docx')
```

### Restarting Numbering (Independent Lists)

When a document contains multiple independent numbered lists, each list should restart from 1. If all lists share the same `numId`, they will continue counting sequentially — the second list starts where the first left off.

**OOXML mechanism**: Each independent list needs its own `<w:num>` instance referencing the same `<w:abstractNum>`. The `start` value in `w:lvl` controls the initial number, and separate `num` instances isolate the counters.

#### Method 1: Simple — Call `create_numbering()` per list

Each call creates a new abstractNum + num pair. Wasteful but trivial:

```python
# List 1
list1_num_id = create_numbering(doc, [
    {"ilvl": 0, "numFmt": "decimal", "lvlText": "%1)", "start": 1},
])
for item in ["任务A", "任务B", "任务C"]:
    p = doc.add_paragraph(item)
    apply_numbering(p, list1_num_id, 0)

# List 2 — new call, restarts at 1
list2_num_id = create_numbering(doc, [
    {"ilvl": 0, "numFmt": "decimal", "lvlText": "%1)", "start": 1},
])
for item in ["步骤1", "步骤2"]:
    p = doc.add_paragraph(item)
    apply_numbering(p, list2_num_id, 0)
```

#### Method 2: Precise — Share abstractNum, separate num instances

Create one abstractNum template, then spawn multiple num instances. This is the correct OOXML pattern:

```python
def create_num_instance(doc, abstract_num_id):
    """Create a new num instance referencing an existing abstractNum. Returns numId."""
    numbering_part = doc.part.numbering_part
    numbering_elm = numbering_part._element

    existing_nums = numbering_elm.xpath("./w:num/@w:numId")
    next_num_id = max([int(x) for x in existing_nums], default=0) + 1

    num_el = OxmlElement("w:num")
    num_el.set(qn("w:numId"), str(next_num_id))
    abstractNumId_el = OxmlElement("w:abstractNumId")
    abstractNumId_el.set(qn("w:val"), str(abstract_num_id))
    num_el.append(abstractNumId_el)
    numbering_elm.append(num_el)

    return next_num_id


# Usage: one abstractNum, multiple num instances
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

# Step 1: Create abstractNum (without auto-creating num)
numbering_part = doc.part.numbering_part
numbering_elm = numbering_part._element
existing_abs = numbering_elm.xpath("./w:abstractNum/@w:abstractNumId")
abstract_num_id = max([int(x) for x in existing_abs], default=-1) + 1

abstractNum = OxmlElement("w:abstractNum")
abstractNum.set(qn("w:abstractNumId"), str(abstract_num_id))
# ... build levels (same as create_numbering pattern) ...
numbering_elm.insert(0, abstractNum)

# Step 2: Spawn num instances for each independent list
list1_id = create_num_instance(doc, abstract_num_id)
list2_id = create_num_instance(doc, abstract_num_id)
list3_id = create_num_instance(doc, abstract_num_id)

# Each list restarts at 1
for item in ["第一组-A", "第一组-B"]:
    apply_numbering(doc.add_paragraph(item), list1_id, 0)
for item in ["第二组-A", "第二组-B"]:
    apply_numbering(doc.add_paragraph(item), list2_id, 0)
```

**Rule of thumb**: Use Method 1 unless you have many (>5) independent lists. Method 2 is the proper OOXML approach but requires manual abstractNum construction.

### Numbering Format Reference

| `w:numFmt` value | Display | Example |
|---|---|---|
| `decimal` | 1, 2, 3... | Standard Arabic numbers |
| `upperRoman` | I, II, III... | Uppercase Roman |
| `lowerRoman` | i, ii, iii... | Lowercase Roman |
| `upperLetter` | A, B, C... | Uppercase Latin |
| `lowerLetter` | a, b, c... | Lowercase Latin |
| `ordinal` | 1st, 2nd, 3rd... | Ordinal |
| `cardinalText` | One, Two, Three... | English word |
| `ordinalText` | First, Second, Third... | English ordinal word |
| `chineseCounting` | 一, 二, 三... | Chinese counting |
| `chineseCountingThousand` | 一, 二, 三... | Chinese (thousand scale) |
| `chineseLegalSimplified` | 壹, 贰, 叁... | Chinese legal (simplified) |
| `japaneseCounting` | 一, 二, 三... | Japanese counting |
| `bullet` | • | Bullet (no number) |
| `none` | (none) | No numbering |

> **重要**：`w:lvlText` 中的 `%N` 始终引用 abstractNum 中第 N 个层级的编号值，而非当前段落的 ilvl。
> - `%1` → 永远是 level 0 的编号
> - `%2` → 永远是 level 1 的编号
> - `%3` → 永远是 level 2 的编号
>
> 因此独立编号方案（如 I. / A. / 1. 各自独立）需要分别使用不同的 %N：
> ```python
> {"ilvl": 0, "lvlText": "%1."},   # I., II., III.
> {"ilvl": 1, "lvlText": "%2."},   # A., B., C.
> {"ilvl": 2, "lvlText": "%3."},   # 1., 2., 3.
> ```
> 而层级累积编号则引用上级：
> ```python
> {"ilvl": 0, "lvlText": "%1."},       # 1.
> {"ilvl": 1, "lvlText": "%1.%2"},     # 1.1
> {"ilvl": 2, "lvlText": "%1.%2.%3"}, # 1.1.1
> ```

**`w:lvlText` patterns:**
- `%1` — abstractNum level 0 的编号值
- `%2` — abstractNum level 1 的编号值
- `%3` — abstractNum level 2 的编号值
- `%1.%2` — level 0 + level 1 (e.g., 1.1)
- `%1.%2.%3` — three levels (e.g., 1.1.1)
- `第%1章` — Chinese chapter prefix
- `Chapter %1` — English chapter prefix
- `(%1)` — parenthesized
- `Article %1.` — with suffix

### Numbering + TOC Integration

When using custom numbering with TOC, the numbering takes effect via paragraph properties. The TOC picks up numbered headings automatically — no special TOC configuration needed:

```python
doc = Document()
num_id = create_heading_numbering(doc, levels=3)

# Inject numbering into heading styles globally
apply_numbering_to_style(doc, 'Heading 1', num_id, 0)
apply_numbering_to_style(doc, 'Heading 2', num_id, 1)
apply_numbering_to_style(doc, 'Heading 3', num_id, 2)

# Insert TOC FIRST
configure_toc_styles(doc)
toc_para = doc.add_paragraph()
insert_toc_field(toc_para)
enable_auto_update_fields(doc)

# Add numbered headings — auto-numbered via style
for ch in range(1, 3):
    doc.add_heading(f'Chapter {ch} Title', level=1)
    for sec in range(1, 3):
        doc.add_heading(f'Section {ch}.{sec} Topic', level=2)

doc.save('numbered_toc.docx')
```

---

## Styling

### Built-in Styles

```python
doc.add_paragraph("Normal", style="Normal")
doc.add_paragraph("Quote", style="Intense Quote")
doc.add_paragraph("List", style="List Paragraph")
run = p.add_run("Emphasis")
run.italic = True  # add_run() does not accept style param; apply formatting directly
```

### Custom Styles

```python
from docx.enum.style import WD_STYLE_TYPE

custom = doc.styles.add_style("Custom", WD_STYLE_TYPE.PARAGRAPH)
custom.font.name = "Georgia"
custom.font.size = Pt(16)
custom.font.bold = True
custom.paragraph_format.space_before = Pt(18)
custom.paragraph_format.space_after = Pt(6)
```

### Fonts & Spacing

```python
# Fonts
run.font.name = "Calibri"
run.font._element.rFonts.set(qn('w:eastAsia'), "Microsoft YaHei")  # Chinese

# Line spacing
from docx.enum.text import WD_LINE_SPACING
p.paragraph_format.line_spacing_rule = WD_LINE_SPACING.SINGLE
p.paragraph_format.line_spacing_rule = WD_LINE_SPACING.ONE_POINT_FIFTEEN
p.paragraph_format.line_spacing_rule = WD_LINE_SPACING.DOUBLE

# Indents
p.paragraph_format.first_line_indent = Twips(400)  # ~2 Chinese chars
p.paragraph_format.left_indent = Pt(20)
```

### Line Spacing 1.3x — MANDATORY

**All documents MUST use 1.3× line spacing throughout.** Single line spacing is too dense for readable documents, especially with CJK content. This is a non-negotiable formatting rule.

```python
from docx.shared import Pt, Twips
from docx.enum.text import WD_LINE_SPACING

def apply_global_line_spacing(doc):
    """Apply 1.3x line spacing to the entire document via default style."""
    style = doc.styles['Normal']
    pf = style.paragraph_format
    pf.line_spacing_rule = WD_LINE_SPACING.MULTIPLE
    pf.line_spacing = 1.3
    pf.space_after = Pt(6)

    # Also apply to all heading styles
    for i in range(1, 5):
        heading_style = doc.styles[f'Heading {i}']
        heading_style.paragraph_format.line_spacing_rule = WD_LINE_SPACING.MULTIPLE
        heading_style.paragraph_format.line_spacing = 1.3
```

Apply this to the **Normal** style (which all paragraphs inherit) plus heading styles. Do NOT set line spacing per-paragraph — set it at the style level so it propagates globally.
```

---

## Editing Existing Documents

### Search and Replace

```python
# Simple replacement (may lose formatting)
for para in doc.paragraphs:
    para.text = para.text.replace("old", "new")

# Preserve formatting - modify runs
for para in doc.paragraphs:
    for run in para.runs:
        run.text = run.text.replace("old", "new")
```

### Format Text

```python
from docx.shared import RGBColor

for para in doc.paragraphs:
    for run in para.runs:
        if "IMPORTANT" in run.text:
            run.bold = True
            run.font.color.rgb = RGBColor(255, 0, 0)
```

### Delete Paragraphs

```python
# Delete by content
for para in doc.paragraphs[:]:
    if "delete me" in para.text:
        para._element.getparent().remove(para._element)
        doc.paragraphs.remove(para)

# Delete empty paragraphs
for para in doc.paragraphs[:]:
    if not para.text.strip():
        para._element.getparent().remove(para._element)
        doc.paragraphs.remove(para)
```

### Update Tables

```python
# Update cell
table.cell(row, col).text = "new content"

# Add row
row = table.add_row()
for i, text in enumerate(["col1", "col2", "col3"]):
    row.cells[i].text = text
```

---

## OOXML Editing

### Understanding the OOXML Structure

A .docx file is a ZIP archive containing XML files:

```
document.docx/
├── [Content_Types].xml
├── _rels/
│   └── .rels
├── word/
│   ├── document.xml          # Main document content
│   ├── _rels/
│   │   └── document.xml.rels # Relationships
│   ├── styles.xml            # Style definitions
│   ├── numbering.xml         # List definitions
│   ├── header1.xml           # Headers
│   ├── footer1.xml           # Footers
│   ├── media/                # Embedded images
│   ├── comments.xml          # Comments
│   └── settings.xml          # Document settings
└── docProps/
    ├── core.xml              # Core properties
    └── app.xml               # Application properties
```

### Unpack/Pack Workflow

For complex edits requiring direct XML manipulation:

```python
import zipfile
import os
import shutil
from xml.dom import minidom

# Unpack DOCX
def unpack_docx(docx_path, output_dir):
    """Extract DOCX contents to directory."""
    os.makedirs(output_dir, exist_ok=True)
    with zipfile.ZipFile(docx_path, 'r') as zip_ref:
        zip_ref.extractall(output_dir)

# Pack DOCX
def pack_docx(input_dir, output_path):
    """Create DOCX from directory contents."""
    # Remove existing DOCX if present
    if os.path.exists(output_path):
        os.remove(output_path)
    
    with zipfile.ZipFile(output_path, 'w', zipfile.ZIP_DEFLATED) as zip_ref:
        for root, dirs, files in os.walk(input_dir):
            for file in files:
                file_path = os.path.join(root, file)
                arcname = os.path.relpath(file_path, input_dir)
                zip_ref.write(file_path, arcname)

# Usage
unpack_docx("original.docx", "unpacked_docx")
# Edit XML files in unpacked_docx/word/document.xml
pack_docx("unpacked_docx", "modified.docx")
```

### Using the Document Class for OOXML

The docx skill provides a specialized Document class for OOXML manipulation:

```python
# Import from docx skill
from scripts.document import Document, DocxXMLEditor

# Initialize with unpacked document
doc = Document('unpacked_docx')

# Access XML editor for specific file
editor = doc["word/document.xml"]

# Get node by text content
node = editor.get_node(tag="w:p", contains="specific text")

# Get node by line range
node = editor.get_node(tag="w:r", line_number=range(100, 150))

# Get node by attributes
node = editor.get_node(tag="w:del", attrs={"w:id": "1"})

# Replace node with new XML
editor.replace_node(node, "<w:p><w:r><w:t>New content</w:t></w:r></w:p>")

# Insert after existing node
editor.insert_after(node, "<w:p><w:r><w:t>Additional paragraph</w:t></w:r></w:p>")

# Save changes
doc.save()  # Validates automatically
```

## Helper Scripts Reference

### scripts/add_toc_placeholders.py

Adds placeholder TOC entries between 'separate' and 'end' field characters, so users see content on first open instead of an empty TOC. Detects TOC styles from styles.xml automatically.

```bash
# Basic usage - auto-detects TOC styles and adds placeholders
python scripts/add_toc_placeholders.py document.docx

# With explicit entries
python scripts/add_toc_placeholders.py document.docx --entries '[{"level":1,"text":"Introduction","page":"1"}]'
```

### scripts/utilities.py

Provides the `XMLEditor` class for manipulating OOXML XML files with line-number-based node finding and DOM manipulation. Uses defusedxml for security.

```python
from scripts.utilities import XMLEditor

# Initialize with an XML file from unpacked DOCX
editor = XMLEditor("document.xml")

# Get node by tag and text content
elem = editor.get_node(tag="w:p", contains="text")

# Replace, insert, or append nodes
editor.replace_node(elem, "<w:p><w:r><w:t>Replaced</w:t></w:r></w:p>")
editor.insert_after(elem, "<w:p><w:r><w:t>Inserted</w:t></w:r></w:p>")
editor.insert_before(elem, "<w:p><w:r><w:t>Before</w:t></w:r></w:p>")
editor.append_to("w:body", "<w:p><w:r><w:t>Appended</w:t></w:r></w:p>")

# Get next relationship ID and save
rid = editor.get_next_rid()
editor.save()
```

Key methods: `get_node()`, `replace_node()`, `insert_after()`, `insert_before()`, `append_to()`, `get_next_rid()`, `save()`.

### scripts/convert.py

Format conversion utilities (DOCX to PDF, legacy .doc to .docx, Markdown to DOCX, PDF to images). See the "Format Conversion" section below for usage.

### Direct XML Manipulation

```python
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
from docx.oxml.shared import parse_xml

# Create custom XML element
custom_para = parse_xml(r'''
<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:pPr>
    <w:pStyle w:val="Heading1"/>
    <w:jc w:val="center"/>
  </w:pPr>
  <w:r>
    <w:rPr>
      <w:b/>
      <w:sz w:val="32"/>
    </w:rPr>
    <w:t>Custom Heading</w:t>
  </w:r>
</w:p>
''')

# Insert into document
doc._body.append(custom_para)

# Modify existing element attributes
para = doc.paragraphs[0]._element
pPr = para.find(qn('w:pPr'))
if pPr is None:
    pPr = OxmlElement('w:pPr')
    para.insert(0, pPr)

jc = pPr.find(qn('w:jc'))
if jc is None:
    jc = OxmlElement('w:jc')
    pPr.append(jc)
jc.set(qn('w:val'), 'center')
```

### Working with Relationships

```python
# Access document relationships
rels = doc.part.rels

# Add new relationship (e.g., for external link)
from docx.opc.constants import RELATIONSHIP_TYPE as RT

# For images, hyperlinks, etc.
# Relationships are typically managed automatically by python-docx
```

### Content Types

```python
# Access content types
content_types = doc.part.content_types

# Add new content type (for custom parts)
# Typically handled automatically
```

---

## Tracked Changes & Comments

### Understanding Tracked Changes

Tracked changes (redlining) allow reviewers to see modifications:
- **Insertions**: New text marked with `<w:ins>`
- **Deletions**: Removed text marked with `<w:del>`
- **Formatting changes**: Can be tracked separately

### Enabling Track Changes

```python
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

# Enable track revisions in document settings
def enable_track_revisions(doc):
    """Enable track revisions mode."""
    settings = doc.part.settings_part.settings
    if settings is None:
        from docx.oxml import OxmlElement
        settings = OxmlElement('w:settings')
        doc.part.settings_part._settings = settings
    
    track_revisions = settings.find(qn('w:trackRevisions'))
    if track_revisions is None:
        track_revisions = OxmlElement('w:trackRevisions')
        settings.append(track_revisions)

enable_track_revisions(doc)
```

### Creating Tracked Insertions

```python
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
from datetime import datetime

def create_tracked_insertion(doc, paragraph, text, author="Reviewer"):
    """Create a tracked insertion."""
    # Create run with tracked insertion
    r = OxmlElement('w:r')
    
    # Create insertion mark
    ins = OxmlElement('w:ins')
    ins.set(qn('w:id'), '1')
    ins.set(qn('w:author'), author)
    ins.set(qn('w:date'), datetime.now().isoformat())
    
    # Add text
    t = OxmlElement('w:t')
    t.text = text
    r.append(t)
    
    ins.append(r)
    paragraph._element.append(ins)

# Using the Document class (recommended)
from scripts.document import Document

doc = Document('unpacked', author="Reviewer", initials="R")
node = doc["word/document.xml"].get_node(tag="w:r", contains="existing text")
doc["word/document.xml"].insert_after(node, '<w:ins><w:r><w:t>new text</w:t></w:r></w:ins>')
```

### Creating Tracked Deletions

```python
def create_tracked_deletion(doc, paragraph, text_to_delete, author="Reviewer"):
    """Create a tracked deletion."""
    from docx.oxml.ns import qn
    from docx.oxml import OxmlElement
    
    # Find run containing text
    for run in paragraph.runs:
        if text_to_delete in run.text:
            # Create deletion mark
            del_elem = OxmlElement('w:del')
            del_elem.set(qn('w:id'), '2')
            del_elem.set(qn('w:author'), author)
            
            # Create delText element
            del_text = OxmlElement('w:delText')
            del_text.text = text_to_delete
            
            # Modify original run
            run._element.clear()
            run._element.append(del_text)
            paragraph._element.append(del_elem)
            break

# Using Document class
doc = Document('unpacked', author="Reviewer", initials="R")
node = doc["word/document.xml"].get_node(tag="w:r", contains="text to delete")
doc["word/document.xml"].suggest_deletion(node)
```

### Minimal Edit Pattern

For precise tracked changes (changing only specific words):

```python
# Original: "The report is monthly"
# Change to: "The report is quarterly"

from scripts.document import Document

doc = Document('unpacked', author="Assistant", initials="A")
node = doc["word/document.xml"].get_node(tag="w:r", contains="The report is monthly")

# Get existing formatting
rpr_tags = node.getElementsByTagName("w:rPr")
rpr = rpr_tags[0].toxml() if rpr_tags else ""

# Create minimal edit - only mark changed word
replacement = f'''<w:r w:rsidR="00AB12CD">{rpr}<w:t>The report is </w:t></w:r>
<w:del w:id="1" w:author="Assistant">
  <w:r>{rpr}<w:delText>monthly</w:delText></w:r>
</w:del>
<w:ins w:id="2" w:author="Assistant">
  <w:r>{rpr}<w:t>quarterly</w:t></w:r>
</w:ins>'''

doc["word/document.xml"].replace_node(node, replacement)
doc.save()
```

### Adding Comments

```python
from scripts.document import Document

# Initialize with comment author
doc = Document('unpacked', author="Reviewer", initials="R")

# Add comment on text range
start_node = doc["word/document.xml"].get_node(tag="w:del", attrs={"w:id": "1"})
end_node = doc["word/document.xml"].get_node(tag="w:ins", attrs={"w:id": "2"})
doc.add_comment(start=start_node, end=end_node, text="Explanation of this change")

# Add comment on paragraph
para = doc["word/document.xml"].get_node(tag="w:p", contains="paragraph text")
doc.add_comment(start=para, end=para, text="Comment on this paragraph")

# Reply to existing comment
doc.reply_to_comment(parent_comment_id=0, text="I agree with this assessment")
```

### Rejecting Changes

```python
from scripts.document import Document

doc = Document('unpacked')

# Reject an insertion (delete the inserted content)
ins = doc["word/document.xml"].get_node(tag="w:ins", attrs={"w:id": "5"})
doc["word/document.xml"].revert_insertion(ins)

# Reject a deletion (restore the deleted content)
del_elem = doc["word/document.xml"].get_node(tag="w:del", attrs={"w:id": "3"})
doc["word/document.xml"].revert_deletion(del_elem)

# Reject all changes in paragraph
para = doc["word/document.xml"].get_node(tag="w:p", contains="paragraph text")
doc["word/document.xml"].revert_insertion(para)
doc["word/document.xml"].revert_deletion(para)
```

### Comment XML Structure

```xml
<!-- Comment in comments.xml -->
<w:comments>
  <w:comment w:id="0" w:author="Reviewer" w:initials="R" w:date="2025-01-15T10:00:00Z">
    <w:p>
      <w:r>
        <w:t>Comment text here</w:t>
      </w:r>
    </w:p>
  </w:comment>
</w:comments>

<!-- Comment reference in document.xml -->
<w:commentRangeStart w:id="0"/>
<w:p>
  <w:r><w:t>Commented text</w:t></w:r>
</w:p>
<w:commentRangeEnd w:id="0"/>
<w:r>
  <w:commentReference w:id="0"/>
</w:r>
```

---

## Document Conversion

### DOCX to Markdown

```python
import pypandoc

# Convert DOCX to Markdown
markdown = pypandoc.convert_file("document.docx", "markdown")

# Save to file
with open("output.md", "w", encoding="utf-8") as f:
    f.write(markdown)

# Convert with options
markdown = pypandoc.convert_file(
    "document.docx",
    "markdown",
    extra_args=["--wrap=preserve", "--reference-links"]
)
```

### DOCX to HTML

```python
import pypandoc

# Convert DOCX to HTML
html = pypandoc.convert_file("document.docx", "html")

# Convert with standalone HTML (includes CSS)
html = pypandoc.convert_file(
    "document.docx",
    "html",
    extra_args=["--standalone", "--css=styles.css"]
)

with open("output.html", "w", encoding="utf-8") as f:
    f.write(html)
```

### Format Conversion

A dedicated conversion script is available at `scripts/convert.py`:

```bash
# DOCX to PDF (requires LibreOffice)
python scripts/convert.py docx-to-pdf document.docx -o output_dir/

# Legacy .doc to .docx
python scripts/convert.py doc-to-docx document.docx -o document.docx

# Markdown to DOCX
python scripts/convert.py md-to-docx README.md -o output.docx

# Markdown to DOCX with style template
python scripts/convert.py md-to-docx README.md --template template.docx -o output.docx

# PDF pages to images
python scripts/convert.py pdf-to-images document.pdf -o images/ --dpi 200
```

For programmatic use:

```python
from scripts.convert import (
    docx_to_pdf_libreoffice, docx_to_pdf_unoconv, docx_to_pdf_pandoc,
    pdf_to_images, doc_to_docx, markdown_to_docx, markdown_to_docx_with_template,
)
```

---

## Chinese/CJK Support

### Font Configuration

```python
from docx.oxml.ns import qn

# Set Chinese font for runs
def set_chinese_font(run, font_name="Microsoft YaHei"):
    """Set East Asian font for Chinese text."""
    rFonts = run.font._element.rFonts
    rFonts.set(qn('w:eastAsia'), font_name)
    rFonts.set(qn('w:ascii'), font_name)
    rFonts.set(qn('w:hAnsi'), font_name)

# Common Chinese fonts
CHINESE_FONTS = {
    "simplified": ["Microsoft YaHei", "SimHei", "SimSun", "KaiTi"],
    "traditional": ["Microsoft JhengHei", "PMingLiU", "DFKai-SB"],
    "japanese": ["Meiryo", "MS Mincho", "Yu Gothic"],
    "korean": ["Malgun Gothic", "Gulim", "Batang"]
}

# Usage
run = p.add_run("中文文本")
set_chinese_font(run, "Microsoft YaHei")
```

### Justified Alignment with Indent

```python
from docx.shared import Pt, Twips

def create_chinese_paragraph(doc, text, indent_chars=2):
    """Create paragraph with Chinese formatting (justified + 2-char indent)."""
    p = doc.add_paragraph(text)
    
    # Justified alignment
    p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    
    # First line indent (2 Chinese characters ≈ 2em ≈ 400 twips)
    indent_twips = indent_chars * 200  # Approximate
    p.paragraph_format.first_line_indent = Twips(indent_twips)
    
    # Line spacing (1.3x for readability)
    p.paragraph_format.line_spacing_rule = WD_LINE_SPACING.MULTIPLE
    p.paragraph_format.line_spacing = 1.3
    
    # Set Chinese font
    for run in p.runs:
        set_chinese_font(run, "Microsoft YaHei")
    
    return p
```

### Unicode Escaping

```python
# Handle special Unicode characters
def escape_unicode_for_xml(text):
    """Escape special characters for XML."""
    replacements = {
        '"': '&#8220;',  # Left double quote
        '"': '&#8221;',  # Right double quote
        "'": '&#8217;',  # Right single quote
        '—': '&#8212;',  # Em dash
        '–': '&#8211;',  # En dash
        '…': '&#8230;',  # Ellipsis
    }
    
    for char, entity in replacements.items():
        text = text.replace(char, entity)
    
    return text

# Usage in OOXML
from docx.oxml.shared import parse_xml

text = escape_unicode_for_xml("Quote: "Hello"—she said")
xml_string = f'<w:t>{text}</w:t>'
element = parse_xml(xml_string)
```

### CJK Line Breaking

```python
# Prevent unwanted line breaks in CJK text
def set_no_line_break(run):
    """Prevent automatic line breaking within run."""
    from docx.oxml.ns import qn
    
    rPr = run.font._element.rPr
    if rPr is None:
        from docx.oxml import OxmlElement
        rPr = OxmlElement('w:rPr')
        run.font._element.insert(0, rPr)
    
    # Add noBreak hyphenation
    noBreak = OxmlElement('w:noProof')
    noBreak.set(qn('w:val'), '1')
    rPr.append(noBreak)
```

### Vertical Text (Traditional Chinese)

```python
def set_vertical_text(para):
    """Set paragraph to vertical text layout."""
    from docx.oxml.ns import qn
    from docx.oxml import OxmlElement
    
    pPr = para._element.pPr
    if pPr is None:
        pPr = OxmlElement('w:pPr')
        para._element.insert(0, pPr)
    
    # Set vertical orientation
    textDirection = OxmlElement('w:textDirection')
    textDirection.set(qn('w:val'), 'tbRl')  # Top-to-bottom, right-to-left
    pPr.append(textDirection)
```

---

## Design Guidance

**Color Palette:**
- Primary: Navy (0,51,102), Blue (0,102,204)
- Secondary: Green (0,153,76), Orange accent (255,102,0)
- Neutrals: Dark gray (64,64,64), Light gray (224,224,224)
- Semantic: Success (green), Warning (orange), Error (red), Info (blue)

**Typography:**
- Headings: H1=32pt, H2=24pt, H3=18pt, H4=16pt
- Body: 12pt with 1.15 line spacing
- Fonts: Professional (Calibri/Arial), Traditional (Times/Georgia), Chinese (Microsoft YaHei/SimHei)

**Spacing (8-pt grid):** xs=4pt, sm=8pt, md=16pt, lg=24pt, xl=32pt
- Paragraph: before=0, after=8pt (normal)

**Tables:**
- Styles: Table Grid (minimal), Medium Shading 1 (professional), Colorful Grid (accented)
- Widths: narrow=1", medium=2", wide=3.5", full=6.5"

### Proactive Design Philosophy

**Generic styling = mediocre delivery. Every document should be studio-quality.**

Do not wait for the user to explicitly request professional elements. When the document type implies certain structural needs, proactively include them:

- **Reports:** cover page, table of contents, headers & footers, page numbers
- **Contracts / Agreements:** signature blocks (Party A / Party B), date lines, clause numbering
- **Meeting Minutes:** attendee list, agenda numbering, resolution markers, action items with owners
- **Exam Papers:** point values per question, space for answers, grading columns
- **Resumes / CVs:** skill ratings, employment timeline, section dividers

The guiding principle: if a document type conventionally includes a feature, include it by default. Users can always remove elements they don't need, but missing elements represent a failure of professional judgment.

### Scene Completeness Guidance

Different document scenes carry implicit requirements. Identify the scene and ensure at minimum the following elements are present:

**Exam Papers (考试卷):**
1. Point allocation summary (总分分布)
2. Question type labels (选择题 / 填空题 / 简答题)
3. Adequate answer space between questions
4. Grading rubric or scoring column per section

**Contracts / Agreements (合同/协议):**
1. Signature blocks for all parties (甲方 / 乙方)
2. Date lines next to each signature
3. Sequential clause numbering (第一条, 第二条, …)
4. Perforated seal position indicator (骑缝章位置)

**Meeting Minutes (会议纪要):**
1. Attendee list with roles
2. Agenda item numbering
3. Resolution markers (决议 / 待定 / 需跟进)
4. Action items table with responsible person and deadline

**Technical Documentation (技术文档):**
1. Version number and revision history table
2. Glossary / terminology table
3. Cross-references between sections
4. Code block styling or monospace formatting

**Business Reports (商业报告):**
1. Executive summary section
2. Charts or data tables where numbers are discussed
3. Data source citations
4. Clear section hierarchy (H1 → H2 → H3)

---

## Common Workflows

### New Document Creation

```python
from docx import Document
from docx.shared import Pt, RGBColor, Inches
from docx.enum.text import WD_ALIGN_PARAGRAPH

doc = Document()

# Title page
doc.add_heading("Report Title", level=0).alignment = WD_ALIGN_PARAGRAPH.CENTER
doc.add_paragraph("By: Author Name").alignment = WD_ALIGN_PARAGRAPH.CENTER
doc.add_page_break()

# Content sections
doc.add_heading("Executive Summary", level=1)
doc.add_paragraph("Summary content...")

# Add table
table = doc.add_table(rows=3, cols=3, style='Table Grid')
for i, row_data in enumerate([["Header1", "Header2", "Header3"],
                               ["Data1", "Data2", "Data3"],
                               ["Data4", "Data5", "Data6"]]):
    for j, cell_text in enumerate(row_data):
        table.cell(i, j).text = cell_text

doc.save("report.docx")
```

### Page Break Restrictions

Page breaks must be used sparingly and only at structural boundaries. Body content should flow continuously — let Word handle automatic page overflow.

**Allowed page break locations:**
1. **After cover page** — separates cover from table of contents
2. **After table of contents** — separates TOC from main body
3. **Between major chapters** — only for long documents where chapter breaks aid navigation

**Forbidden:**
- Page breaks between regular paragraphs within a section
- Page breaks before/after individual tables or figures (use paragraph keep-with-next instead)
- Multiple consecutive page breaks

```python
from docx.enum.text import WD_BREAK

# ✅ CORRECT: Only at structural boundaries
# Cover page → page break → TOC → page break → Body content
cover_para.add_run().add_break(WD_BREAK.PAGE)
# ... TOC content ...
toc_end_para.add_run().add_break(WD_BREAK.PAGE)
# ... Body content flows naturally (no more page breaks) ...

# ❌ WRONG: Do NOT insert page breaks between body paragraphs
for section in sections:
    doc.add_heading(section.title, level=1)
    doc.add_paragraph(section.content)
    # Do NOT: doc.add_page_break()  ← removes this
```

For keeping related content together (e.g., a heading with its first paragraph, or a table with its caption), use paragraph-level keep-with-next instead of page breaks:

```python
# Keep heading with following paragraph
heading_para.paragraph_format.keep_with_next = True
# Keep paragraph on same page (prevent widow/orphan)
heading_para.paragraph_format.keep_lines_together = True
```

```python
from docx import Document
from docx.shared import RGBColor

doc = Document("original.docx")

# Search and replace text
for para in doc.paragraphs:
    if "2024" in para.text:
        para.text = para.text.replace("2024", "2025")

# Format specific text
for para in doc.paragraphs:
    for run in para.runs:
        if "IMPORTANT" in run.text:
            run.bold = True
            run.font.color.rgb = RGBColor(255, 0, 0)

# Add new section
doc.add_heading("New Section", level=1)
doc.add_paragraph("New content...")

doc.save("edited.docx")
```

### Redlining with Tracked Changes

```python
from scripts.document import Document

doc = Document('unpacked', author="Reviewer", initials="R")

# Suggest edit: "monthly" → "quarterly"
node = doc["word/document.xml"].get_node(tag="w:r", contains="monthly")
rpr = node.getElementsByTagName("w:rPr")[0].toxml() if node.getElementsByTagName("w:rPr") else ""

replacement = f'''<w:del w:id="1" w:author="Reviewer"><w:r>{rpr}<w:delText>monthly</w:delText></w:r></w:del>
<w:ins w:id="2" w:author="Reviewer"><w:r>{rpr}<w:t>quarterly</w:t></w:r></w:ins>'''

doc["word/document.xml"].replace_node(node, replacement)

# Add comment
doc.add_comment(
    start=doc["word/document.xml"].get_node(tag="w:del", attrs={"w:id": "1"}),
    end=doc["word/document.xml"].get_node(tag="w:ins", attrs={"w:id": "2"}),
    text="Changed per finance team request"
)

doc.save()
```

### Document Conversion

```python
import pypandoc

# DOCX to Markdown
md = pypandoc.convert_file("document.docx", "markdown")
with open("output.md", "w", encoding="utf-8") as f:
    f.write(md)

# DOCX to HTML
html = pypandoc.convert_file("document.docx", "html", extra_args=["--standalone"])

# DOCX to PDF (requires LaTeX or wkhtmltopdf)
pypandoc.convert_file("document.docx", "pdf", outputfile="output.pdf")

# Markdown to DOCX
pypandoc.convert_file("input.md", "docx", outputfile="output.docx")
```

### Batch Processing

```python
import glob
from docx import Document

for input_path in glob.glob("reports/*.docx"):
    doc = Document(input_path)
    # Apply transformations
    for para in doc.paragraphs:
        para.text = para.text.replace("OLD", "NEW")
    doc.save(input_path.replace(".docx", "_updated.docx"))
```

---

## Troubleshooting

**Document won't open:** Check for corrupted XML by opening the .docx as a ZIP file and inspecting `word/document.xml`. Use the custom Document class from `scripts/document.py` for automatic validation.

**Images not displaying:** Check format support (PNG, JPEG, GIF, BMP, TIFF), verify dimensions don't exceed page size.

**Formatting lost after replace:** Modify runs, not paragraph text: `for run in para.runs: run.text = run.text.replace("old", "new")`

**Chinese characters as boxes:** Set CJK font: `run.font._element.rFonts.set(qn('w:eastAsia'), 'Microsoft YaHei')`

**Table borders missing:** Use `table.style = 'Table Grid'` or configure borders via OOXML.

**Best Practices:**
1. Work on copies, never originals
2. Validate frequently
3. Test in Microsoft Word
4. Use templates for consistency
5. Save once at the end

### Delivery Quality Standards

**Mediocre styling = mediocre delivery.** Studio-quality documents require thoughtful content, functionality, and styling — not just correct data.

Before delivering any document, verify ALL of the following:

- **Clean layout:** no formatting artifacts, misaligned elements, or orphaned headings
- **Consistent fonts:** one font family for body, one for headings — no accidental defaults
- **Tables:** appropriate borders, cell padding, header row styling, column widths
- **Headers & Footers:** correct content (title, page numbers, date), no placeholder text
- **Table of Contents:** matches actual heading structure, no missing entries
- **No placeholder residue:** search for "Lorem ipsum", "TODO", "placeholder", "[Insert", "Click here" — remove all
- **Paragraph spacing:** uniform `space_after` across same-level elements
- **Page breaks:** only where structurally necessary (see Page Break Restrictions)

If any check fails, fix before delivery. A document with broken formatting reflects poorly regardless of content quality.

---

## Quick Reference: Units & Styles

**Units:** 1 inch = 72 pt = 1440 twips = 914400 EMUs
- `Twips(240)` = 12 pt, `Twips(400)` ≈ 2 Chinese character indent
- `Emu(914400)` = 1 inch (for images)

**Common Styles:**
- Paragraphs: Normal, Heading 1-9, Title, List Bullet, List Number, Caption
- Tables: Table Grid, Medium Shading 1, Colorful Grid

**Namespaces:** `qn('w:p')` for paragraph, `qn('w:tblPr')` for table properties

---

*End of Word Document Manipulation Skill*
