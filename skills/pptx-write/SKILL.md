---
name: pptx-write
description: "Create and modify .pptx PowerPoint presentations — slide creation, shapes, charts, tables, images, styling, visual QA, template editing, OOXML manipulation. Use for any .pptx creation or modification task. For read-only text extraction, use pptx-read instead. (recommended category: deep)"
---

# PowerPoint (.pptx) Skill

**Note**: This skill is for CREATING and MODIFYING presentations. To simply read/extract text from an existing .pptx file, use the **pptx-read** skill instead.

This skill provides comprehensive guidance for creating, editing, and validating PowerPoint presentations using the python-pptx library.

## Core Dependencies

- **python-pptx**: Primary library for PowerPoint manipulation
- **Pillow**: Image handling and thumbnail generation
- **LibreOffice**: Headless conversion for visual QA (requires `soffice` binary)
- **poppler-utils**: PDF to image conversion (requires `pdftoppm` binary)

Install dependencies:
```bash
pip install python-pptx Pillow defusedxml
```

For visual QA, ensure LibreOffice and poppler-utils are installed on your system.

## Basic Imports and Units

Always use these imports for consistency:

```python
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_AUTO_SHAPE_TYPE
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION, XL_LABEL_POSITION
from pptx.chart.data import CategoryChartData, XyChartData
```

**Units**:
- `Inches(value)`: Position and sizing (e.g., `Inches(1)`, `Inches(2.5)`)
- `Pt(value)`: Font sizes (e.g., `Pt(24)`, `Pt(36)`)
- `RGBColor(r, g, b)`: Colors with 0-255 range (e.g., `RGBColor(255, 0, 0)`)

## Presentation Management

### Creating New Presentations

```python
prs = Presentation()
prs.save('output.pptx')
```

### Opening Existing Presentations

```python
prs = Presentation('existing.pptx')
# Make modifications
prs.save('modified.pptx')
```

### Setting Presentation Size

```python
# 16:9 (widescreen) - default
prs = Presentation()  # or Presentation('template.pptx')

# 4:3 (standard)
prs.slide_width = Inches(10)
prs.slide_height = Inches(7.5)
```

### Presentation Metadata

```python
prs.core_properties.title = "Project Update"
prs.core_properties.author = "Team"
prs.core_properties.subject = "Monthly Report"
prs.core_properties.comments = "Created programmatically"
```

## Slide Management

### Slide Layouts

PowerPoint templates provide predefined layouts. Common indices:

- `0`: Title Slide (title + subtitle)
- `1`: Title and Content (title + body with placeholders)
- `2`: Section Header
- `3`: Two Content
- `4`: Comparison
- `5`: Title Only
- `6`: Blank

Always inspect available layouts first:

```python
for i, layout in enumerate(prs.slide_layouts):
    print(f"{i}: {layout.name}")
```

### Template Layout Variety Guidance

When using a template, avoid repeating the same layout type across consecutive slides. A visually monotonous deck loses audience attention quickly.

**Layout types to actively seek and utilize:**

| Layout Type | Best For | Key Characteristics |
|---|---|---|
| Multi-column | Comparisons, feature lists | 2-3 equal vertical zones |
| Image + Text mixed | Process steps, case studies | Image on one side, text on the other |
| Full-bleed image | Impact slides, section openers | Image fills entire slide, text overlaid |
| Quote / callout | Testimonials, key statements | Large quotation marks, centered text, ample whitespace |
| Section divider | Chapter transitions | Minimal content, bold title, accent color |
| Data / statistics | KPIs, metrics, achievements | Large numbers, small labels, grid arrangement |
| Icon grid | Capabilities, features, team | 3-6 equal cells with icon + short label |

**Content-to-layout matching rules:**
- Data with numbers → Data/statistics layout (big numbers, small labels)
- Process or flow → Image+text mixed layout (visual on one side, steps on the other)
- Testimonial or key quote → Quote/callout layout
- Feature comparison → Multi-column layout
- Chapter transition → Section divider layout
- Capability overview → Icon grid layout

**Handling template slot mismatch:**
When source content has fewer items than a template layout provides slots, **completely remove the excess placeholder shapes** rather than leaving them empty. Empty placeholders with faint borders or "Click to add" text are immediately visible and unprofessional:

```python
# Remove unused placeholder shapes from a template-based slide
for shape in list(slide.placeholders):
    # Keep only the placeholders we actually populate
    if shape.placeholder_idx not in used_placeholder_indices:
        sp = shape._element
        sp.getparent().remove(sp)
```

### Adding Slides

```python
# Add title slide
title_slide_layout = prs.slide_layouts[0]
slide = prs.slides.add_slide(title_slide_layout)

# Add bullet slide
bullet_layout = prs.slide_layouts[1]
slide = prs.slides.add_slide(bullet_layout)

# Add blank slide
blank_layout = prs.slide_layouts[6]
slide = prs.slides.add_slide(blank_layout)
```

### Populating Placeholder Content

```python
# Title slide
title = slide.shapes.title
title.text = "Presentation Title"

subtitle = slide.placeholders[1]
subtitle.text = "Subtitle text"

# Bullet slide
slide.shapes.title.text = "Agenda"

body = slide.placeholders[1]
tf = body.text_frame
tf.text = "First bullet point"

p = tf.add_paragraph()
p.text = "Second bullet point"
p.level = 0

p = tf.add_paragraph()
p.text = "Sub-bullet point"
p.level = 1
```

### Deleting Slides

```python
# WARNING: This uses internal/private python-pptx APIs (_sldIdLst, drop_rel).
# These may break across python-pptx versions. Use with caution.
# Delete slide at index 2
sldId = prs.slides._sldIdLst[2]
rId = sldId.rId
prs.part.drop_rel(rId)
prs.slides._sldIdLst.remove(sldId)
```

### Duplicating Slides

For complex duplication scenarios, use the custom helper script (located in our scripts folder, not part of python-pptx):

```bash
python scripts/add_slide.py unpacked/ slide3.xml
```

This duplicates `slide3.xml` and creates `slide4.xml`, returning the XML snippet to add to `presentation.xml`.

### Reordering Slides

```python
# WARNING: This uses internal/private python-pptx APIs (_sldIdLst).
# These may break across python-pptx versions. Use with caution.
# Move slide 3 to position 1
sldId = prs.slides._sldIdLst.pop(3)
prs.slides._sldIdLst.insert(1, sldId)
```

### Working with Slide Masters

```python
# Access slide master
master = prs.slide_master

# Access layout templates
for layout in master.slide_layouts:
    print(f"Layout: {layout.name}")
```

## Text and Typography

### Adding Text Boxes

```python
slide = prs.slides.add_slide(prs.slide_layouts[6])

# Add text box at position (1", 1") with size (4", 1.5")
left = Inches(1)
top = Inches(1)
width = Inches(4)
height = Inches(1.5)

txBox = slide.shapes.add_textbox(left, top, width, height)
tf = txBox.text_frame

tf.text = "This is the first paragraph"
```

### Multi-Paragraph Text

```python
tf.text = "First paragraph"

p = tf.add_paragraph()
p.text = "Second paragraph"

p = tf.add_paragraph()
p.text = "Third paragraph"
```

### Text Alignment

```python
# Left aligned (default)
paragraph.alignment = PP_ALIGN.LEFT

# Centered
paragraph.alignment = PP_ALIGN.CENTER

# Right aligned
paragraph.alignment = PP_ALIGN.RIGHT

# Justified
paragraph.alignment = PP_ALIGN.JUSTIFY
```

### Font Formatting

```python
p = tf.add_paragraph()
run = p.runs[0] if p.runs else p.add_run()

run.text = "Formatted text"
run.font.size = Pt(24)
run.font.bold = True
run.font.italic = True
run.font.underline = True

# Font color
run.font.color.rgb = RGBColor(255, 0, 0)  # Red
run.font.color.rgb = RGBColor(0, 100, 200)  # Custom blue

# Font family (use installed system fonts)
run.font.name = "Arial"
```

### Rich Text with Mixed Formatting

```python
p = tf.add_paragraph()

run = p.add_run()
run.text = "Bold "
run.font.bold = True
run.font.size = Pt(18)

run = p.add_run()
run.text = "and "
run.font.bold = False
run.font.size = Pt(14)

run = p.add_run()
run.text = "italic red text"
run.font.italic = True
run.font.color.rgb = RGBColor(255, 0, 0)
```

### Bullet Lists and Numbering

```python
tf = slide.shapes.title.text_frame
tf.text = "Agenda"

body = slide.shapes.placeholders[1]
tf = body.text_frame

# First level bullets
p = tf.add_paragraph()
p.text = "Introduction"
p.level = 0

p = tf.add_paragraph()
p.text = "Methodology"
p.level = 0

# Second level bullets
p = tf.add_paragraph()
p.text = "Data Collection"
p.level = 1

p = tf.add_paragraph()
p.text = "Analysis"
p.level = 1

# Back to first level
p = tf.add_paragraph()
p.text = "Results"
p.level = 0
```

### Text Frame Properties

```python
tf.word_wrap = True  # Enable text wrapping
tf.margin_left = Inches(0.1)
tf.margin_right = Inches(0.1)
tf.margin_top = Inches(0.05)
tf.margin_bottom = Inches(0.05)

# Vertical alignment
tf.anchor = MSO_ANCHOR.TOP  # TOP, MIDDLE, BOTTOM
```

## Shapes and Drawing

### Adding Shapes

```python
slide = prs.slides.add_slide(prs.slide_layouts[6])

# Rectangle
left = Inches(1)
top = Inches(2)
width = Inches(2)
height = Inches(1.5)
shape = slide.shapes.add_shape(MSO_AUTO_SHAPE_TYPE.ROUNDED_RECTANGLE, left, top, width, height)

# Oval
shape = slide.shapes.add_shape(MSO_AUTO_SHAPE_TYPE.OVAL, Inches(4), Inches(2), Inches(1.5), Inches(1.5))

# Line
shape = slide.shapes.add_shape(MSO_AUTO_SHAPE_TYPE.LINE, Inches(1), Inches(4), Inches(8), Inches(4))
```

### Shape Formatting

```python
# Fill color
fill = shape.fill
fill.solid()
fill.fore_color.rgb = RGBColor(100, 150, 200)

# Transparency (0-100000, where 100000 = 100%)
fill.fore_color.brightness = 20000  # 20% lighter

# No fill
fill.background()

# Border/Line
line = shape.line
line.color.rgb = RGBColor(50, 50, 50)
line.width = Pt(2)

# No border
line.fill.background()
```

### Adding Text to Shapes

```python
shape = slide.shapes.add_shape(MSO_AUTO_SHAPE_TYPE.ROUNDED_RECTANGLE, left, top, width, height)
text_frame = shape.text_frame
text_frame.text = "Click to edit"
text_frame.word_wrap = True

# Center text
paragraph = text_frame.paragraphs[0]
paragraph.alignment = PP_ALIGN.CENTER
```

### Drop Shadows

```python
# python-pptx only supports disabling shadow inheritance.
# Fine-grained shadow properties (blur, distance, angle, color, transparency)
# are not exposed in the public API.
shadow = shape.shadow
shadow.inherit = False
```

## Images

### Inserting Images

```python
slide = prs.slides.add_slide(prs.slide_layouts[6])

# Insert with position only (keeps original size)
pic = slide.shapes.add_picture('logo.png', Inches(1), Inches(1))

# Insert with position and height (maintains aspect ratio)
pic = slide.shapes.add_picture('photo.jpg', Inches(4), Inches(2), height=Inches(4))

# Insert with position, width, and height (may distort)
pic = slide.shapes.add_picture('image.png', Inches(1), Inches(5), width=Inches(3), height=Inches(2))
```

### Image Positioning

```python
pic = slide.shapes.add_picture('image.png', Inches(1), Inches(1), height=Inches(3))

# Access position
print(f"Left: {pic.left}, Top: {pic.top}")

# Move image
pic.left = Inches(2)
pic.top = Inches(1.5)

# Scale proportionally
original_width = pic.width  # EMU value
pic.width = Inches(4)
pic.height = int(pic.height * (Inches(4) / original_width))
```

## Tables

### Creating Tables

```python
slide = prs.slides.add_slide(prs.slide_layouts[5])
slide.shapes.title.text = "Sales Report"

rows = 4
cols = 3
left = Inches(1)
top = Inches(2)
width = Inches(8)
height = Inches(2)

table = slide.shapes.add_table(rows, cols, left, top, width, height).table
```

### Setting Column Widths

```python
table.columns[0].width = Inches(2)
table.columns[1].width = Inches(3)
table.columns[2].width = Inches(3)
```

### Populating Table Data

```python
# Header row
headers = ['Region', 'Q1 Sales', 'Q2 Sales']
for col_idx, header in enumerate(headers):
    cell = table.cell(0, col_idx)
    cell.text = header
    paragraph = cell.text_frame.paragraphs[0]
    run = paragraph.runs[0] if paragraph.runs else paragraph.add_run()
    run.font.bold = True
    run.font.size = Pt(14)

# Data rows
data = [
    ('East', '$125,000', '$142,000'),
    ('West', '$98,000', '$115,000'),
    ('Central', '$87,000', '$95,000'),
]

for row_idx, row_data in enumerate(data, start=1):
    for col_idx, value in enumerate(row_data):
        table.cell(row_idx, col_idx).text = value
```

### Cell Formatting

```python
cell = table.cell(1, 1)

# Background color
cell.fill.solid()
cell.fill.fore_color.rgb = RGBColor(200, 220, 240)

# Text alignment
paragraph = cell.text_frame.paragraphs[0]
paragraph.alignment = PP_ALIGN.CENTER

# Cell margins
cell.text_frame.margin_left = Inches(0.05)
cell.text_frame.margin_right = Inches(0.05)
```

### Merging Cells

```python
# Merge header cells (row 0, cols 0-1)
cell_0_0 = table.cell(0, 0)
cell_0_1 = table.cell(0, 1)
cell_0_0.merge(cell_0_1)
```

## Charts

### Column Charts

```python
slide = prs.slides.add_slide(prs.slide_layouts[5])
slide.shapes.title.text = "Quarterly Sales"

chart_data = CategoryChartData()
chart_data.categories = ['Q1', 'Q2', 'Q3', 'Q4']
chart_data.add_series('East', (19.2, 21.4, 16.7, 23.1))
chart_data.add_series('West', (22.3, 28.6, 15.2, 19.8))
chart_data.add_series('Central', (20.4, 26.3, 14.2, 18.5))

x, y, cx, cy = Inches(1), Inches(2), Inches(8), Inches(4.5)
graphic_frame = slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, x, y, cx, cy, chart_data)
chart = graphic_frame.chart

# Add legend
chart.has_legend = True
chart.legend.position = XL_LEGEND_POSITION.BOTTOM
chart.legend.include_in_layout = False
```

### Line Charts

```python
slide = prs.slides.add_slide(prs.slide_layouts[5])
slide.shapes.title.text = "Trend Analysis"

chart_data = CategoryChartData()
chart_data.categories = ['Jan', 'Feb', 'Mar', 'Apr', 'May']
chart_data.add_series('Product A', (10, 15, 13, 17, 20))
chart_data.add_series('Product B', (8, 12, 16, 14, 18))

chart = slide.shapes.add_chart(XL_CHART_TYPE.LINE, x, y, cx, cy, chart_data).chart

# Smooth lines
chart.series[0].smooth = True
```

### Pie Charts

```python
slide = prs.slides.add_slide(prs.slide_layouts[5])
slide.shapes.title.text = "Market Share"

chart_data = CategoryChartData()
chart_data.categories = ['Product A', 'Product B', 'Product C', 'Other']
chart_data.add_series('Market Share', (35.2, 28.7, 22.1, 14.0))

chart = slide.shapes.add_chart(XL_CHART_TYPE.PIE, x, y, cx, cy, chart_data).chart

chart.has_legend = True
chart.legend.position = XL_LEGEND_POSITION.RIGHT

# Add percentage labels
plot = chart.plots[0]
plot.has_data_labels = True
data_labels = plot.data_labels
data_labels.number_format = '0.0%'
```

### Scatter Charts

```python
slide = prs.slides.add_slide(prs.slide_layouts[5])
slide.shapes.title.text = "Performance Analysis"

chart_data = XyChartData()
series_1 = chart_data.add_series('Model A')
series_1.add_data_point(1.0, 2.5)
series_1.add_data_point(2.0, 4.2)
series_1.add_data_point(3.0, 3.8)
series_1.add_data_point(4.0, 5.1)

series_2 = chart_data.add_series('Model B')
series_2.add_data_point(1.2, 3.1)
series_2.add_data_point(2.3, 2.9)
series_2.add_data_point(3.1, 4.5)
series_2.add_data_point(4.2, 4.8)

chart = slide.shapes.add_chart(XL_CHART_TYPE.XY_SCATTER, x, y, cx, cy, chart_data).chart
chart.has_legend = True
```

### Chart Customization

```python
# Data labels
plot = chart.plots[0]
plot.has_data_labels = True
data_labels = plot.data_labels
data_labels.font.size = Pt(10)
data_labels.position = XL_LABEL_POSITION.OUTSIDE_END

# Chart title
chart.has_title = True
chart.chart_title.text_frame.text = "Custom Title"
chart.chart_title.text_frame.paragraphs[0].font.size = Pt(18)

# Value axis formatting
value_axis = chart.value_axis
value_axis.has_major_gridlines = True
value_axis.major_gridlines.format.line.color.rgb = RGBColor(200, 200, 200)
```

## Visual Quality Assurance

### Converting Slides to Images

Use the thumbnail helper script:

```bash
python scripts/thumbnail.py presentation.pptx
# Creates: thumbnails.jpg

python scripts/thumbnail.py presentation.pptx grid --cols 4
# Creates: grid.jpg (or grid-1.jpg, grid-2.jpg for large decks)
```

This requires:
- LibreOffice installed with `soffice` binary
- `pdftoppm` from poppler-utils

### Checking for Issues

Review the thumbnail images for:

1. **Text Overflow**: Text extending beyond box boundaries
2. **Overlapping Elements**: Shapes, images, or text overlapping inappropriately
3. **Alignment Problems**: Elements not properly aligned or centered
4. **Placeholder Remnants**: Text like "Click to add title" still visible
5. **Truncated Content**: Content cut off at slide edges

### Verification Loop Methodology

The first rendering of a programmatically generated presentation is almost never perfect. Expect to iterate through multiple generate-inspect-fix cycles before the result is acceptable.

**Core principle:** Generate → Convert to images → Inspect every slide → Record all issues → Fix → Re-verify. Repeat until no issues remain.

```
┌──────────┐     ┌──────────────┐     ┌────────────┐     ┌──────────┐
│ Generate │────▶│ Convert to   │────▶│ Inspect    │────▶│ Record   │
│ .pptx    │     │ images       │     │ each slide │     │ issues   │
└──────────┘     └──────────────┘     └────────────┘     └────┬─────┘
                                                             │
                        ┌──────────┐     ┌────────────┐      │
                        │ Re-verify│◀───│ Fix issues │◀─────┘
                        └──────────┘     └────────────┘
                             │
                       (repeat until clean)
```

**Per-slide inspection checklist (check every item on every slide):**

- [ ] **Text overflow**: No text extends beyond its containing shape
- [ ] **Text truncation**: No words are cut off at the bottom or right edge
- [ ] **Image distortion**: Images maintain correct aspect ratio (not stretched/squished)
- [ ] **Element overlap**: No unintended overlapping of shapes, text boxes, or images
- [ ] **Alignment**: All elements align to the intended grid or anchor points
- [ ] **Color consistency**: Colors match the defined palette across all slides
- [ ] **Font rendering**: All fonts render correctly (no fallback to unexpected fonts)
- [ ] **Spacing uniformity**: Margins and gaps are consistent within and across slides
- [ ] **Visual hierarchy**: Title > subtitle > body > caption distinction is clear
- [ ] **Contrast**: All text is readable against its background
- [ ] **Placeholder remnants**: No "Click to add" or template boilerplate remains
- [ ] **Chart readability**: Data labels, legends, and axes are legible and not overlapping

**Typical iteration count:** 2-4 cycles for a 10-slide deck. Do not skip iterations — "it looks fine in code" is not a valid assumption.

### Subagent Visual QA Guidance

Even for small decks (2-3 slides), delegate visual inspection to a sub-agent rather than self-checking. The generating agent is susceptible to confirmation bias — it will tend to "see" what it intended rather than what actually rendered.

**Why use a separate reviewer:**
- The author agent knows the intent and unconsciously fills in gaps
- A fresh pair of eyes catches alignment drift, overflow, and color mismatches that the author missed
- Sub-agents have no investment in the output being "already correct"

**Visual QA prompt template for sub-agent delegation:**

```
You are reviewing a rendered presentation image (thumbnail grid). 
Inspect EVERY slide and report ALL issues found.

Check these 12 aspects for each slide:

1. Text overflow / truncation: Is any text cut off or extending beyond its box?
2. Image distortion: Are any images stretched, squished, or pixelated?
3. Element overlap: Do any shapes, text boxes, or images overlap unintentionally?
4. Alignment drift: Are elements misaligned relative to each other or to the slide grid?
5. Color consistency: Do colors match across slides? Any accidental variations?
6. Font rendering: Do all text elements render in the intended font? Any fallback visible?
7. Spacing uniformity: Are margins and gaps consistent within and between slides?
8. Visual hierarchy: Can you clearly distinguish title → subtitle → body → caption?
9. Contrast: Is all text clearly readable against its background? Any low-contrast areas?
10. Placeholder text: Any "Click to add", "Title", or template boilerplate remaining?
11. Chart readability: Are chart labels, legends, and axes legible without overlap?
12. Overall professionalism: Does the slide look like a polished, deliverable output?

For each issue found, report:
- Slide number
- Issue category (from list above)
- Specific description of the problem
- Suggested fix

Format: A numbered list of issues. If no issues are found on a slide, state "Slide N: PASS".
```

**Workflow:**
1. Generate thumbnails: `python scripts/thumbnail.py presentation.pptx grid --cols 4`
2. Delegate the resulting image to a sub-agent using the prompt above
3. Fix every issue reported
4. Regenerate thumbnails and re-run the visual QA
5. Repeat until the sub-agent reports PASS on all slides

### Manual Verification Checklist

- [ ] All slides render correctly in LibreOffice
- [ ] Text is readable and properly sized
- [ ] Colors are as expected (RGB conversion correct)
- [ ] Images display without distortion
- [ ] Charts show all data points clearly
- [ ] No placeholder text remains
- [ ] Slide order is correct
- [ ] Layouts match template expectations

## Template Editing (XML Level)

For advanced modifications that python-pptx doesn't support, edit the XML directly.

### Unpack Presentation

```bash
python scripts/office/unpack.py presentation.pptx unpacked/
```

This extracts the ZIP archive and pretty-prints all XML files.

### Edit XML Files

Edit the relevant XML files in the unpacked directory:

- `ppt/presentation.xml`: Slide order and structure
- `ppt/slides/slideN.xml`: Individual slide content
- `ppt/slideLayouts/slideLayoutN.xml`: Layout templates
- `ppt/slideMasters/slideMaster1.xml`: Master slides
- `[Content_Types].xml`: Content type definitions

### Content Replacement

To replace text content throughout the presentation:

```python
import re
from pathlib import Path

def replace_text_in_xml(xml_path: Path, old_text: str, new_text: str) -> None:
    content = xml_path.read_text(encoding='utf-8')

    # Replace text in <a:t> tags (text runs)
    content = re.sub(
        r'(<a:t>)([^<]*' + re.escape(old_text) + r'[^<]*)(</a:t>)',
        lambda m: f"{m.group(1)}{m.group(2).replace(old_text, new_text)}{m.group(3)}",
        content
    )

    xml_path.write_text(content, encoding='utf-8')

# Apply to all slide XML files
unpacked_dir = Path('unpacked')
for slide_xml in (unpacked_dir / 'ppt' / 'slides').glob('slide*.xml'):
    replace_text_in_xml(slide_xml, 'Old Title', 'New Title')
```

### Orphan Cleanup

Use the clean helper script to remove unreferenced files:

```bash
python scripts/clean.py unpacked/
```

This removes:
- Orphaned slides not referenced in `sldIdLst`
- Unreferenced media, charts, diagrams
- Unreferenced relationship files
- [trash] directory
- Orphaned theme files

### Pack Presentation

```bash
python scripts/office/pack.py unpacked/ output.pptx --validate true
```

This validates the structure, condenses XML, and creates the PPTX file.

## Helper Scripts Reference

### scripts/add_slide.py

Add a new slide to an unpacked presentation directory.

```bash
# Duplicate existing slide
python scripts/add_slide.py unpacked/ slide3.xml

# Create from layout template
python scripts/add_slide.py unpacked/ slideLayout2.xml
```

### scripts/clean.py

Remove unreferenced files from unpacked presentation.

```bash
python scripts/clean.py unpacked/
```

### scripts/thumbnail.py

Create thumbnail grids for visual inspection.

```bash
python scripts/thumbnail.py presentation.pptx
python scripts/thumbnail.py presentation.pptx grid --cols 4
```

### scripts/office/unpack.py

Unpack PPTX file to editable directory.

```bash
python scripts/office/unpack.py presentation.pptx unpacked/
```

### scripts/office/pack.py

Pack directory back to PPTX file.

```bash
python scripts/office/pack.py unpacked/ output.pptx --validate true
```

## Design Best Practices

### Color Palettes

Use consistent color schemes across presentations:

**Corporate Blue**:
- Primary: `RGBColor(0, 80, 158)`
- Secondary: `RGBColor(100, 149, 237)`
- Accent: `RGBColor(255, 165, 0)`
- Text: `RGBColor(30, 30, 30)`
- Background: `RGBColor(245, 245, 245)`

**Modern Gradient**:
- Light: `RGBColor(230, 240, 255)`
- Medium: `RGBColor(100, 180, 255)`
- Dark: `RGBColor(0, 100, 200)`

**Warm Palette**:
- Primary: `RGBColor(200, 80, 60)`
- Secondary: `RGBColor(255, 150, 100)`
- Accent: `RGBColor(255, 200, 50)`

### Font Pairings

Choose complementary font combinations:

**Professional**:
- Headings: Arial or Calibri, Bold, Pt(32-40)
- Body: Arial or Calibri, Regular, Pt(18-24)

**Modern**:
- Headings: Helvetica or Segoe UI, Light/Bold, Pt(36-44)
- Body: Helvetica or Segoe UI, Regular, Pt(20-28)

**Classic**:
- Headings: Times New Roman, Bold, Pt(32-40)
- Body: Times New Roman or Georgia, Regular, Pt(18-24)

### Spacing Standards

Maintain consistent spacing:

**Margins**:
- Slide edges: `Inches(0.5)` to `Inches(1)`
- Between sections: `Inches(0.25)` to `Inches(0.5)`

**Element Spacing**:
- Between text boxes: `Inches(0.2)` to `Inches(0.3)`
- Between list items: `Inches(0.1)` to `Inches(0.15)`
- Table cell padding: `Inches(0.05)` to `Inches(0.1)`

**Layout Grid** (16:9 aspect ratio):
- Title area: Top 20%
- Content area: Middle 70%
- Footer area: Bottom 10%

### Common Mistakes to Avoid

The following anti-patterns are frequently observed in programmatically generated presentations. Check every slide against this list before delivery:

- **Repeating the same layout on every slide** — Each slide should have visual variety. Alternate between full-text, image-centric, chart-focused, and mixed layouts to maintain audience engagement.
- **Center-aligning body text** — Center alignment is acceptable for titles and cover slides only. Body text must be left-aligned (or right-aligned for RTL languages) for readability.
- **Insufficient font size contrast** — Title and body font sizes must differ by at least 2× (e.g., Pt(36) title vs. Pt(18) body). Close sizes create visual ambiguity about hierarchy.
- **Using default Office color schemes** — Always define a custom palette. Default blue/orange/green combinations signal "unmodified template" and undermine credibility.
- **Inconsistent spacing within a single presentation** — Margins, gaps between elements, and internal padding must be uniform across all slides. Even small inconsistencies (e.g., Inches(0.4) vs. Inches(0.5)) are noticeable.
- **Missing text box internal padding** — Every text box must have at least Inches(0.1) internal margin on all sides. Text jammed against shape edges looks unprofessional:
  ```python
  tf.margin_left = Inches(0.1)
  tf.margin_right = Inches(0.1)
  tf.margin_top = Inches(0.1)
  tf.margin_bottom = Inches(0.1)
  ```
- **Pure-text slides with no visual element** — Every slide needs at least one non-text visual element: a shape, icon placeholder, image, chart, colored accent bar, or decorative line. Walls of text exhaust readers.
- **Low-contrast text/background combinations** — Light gray text on white, or dark blue on black, fails accessibility standards and is hard to read. Verify all color pairs have sufficient contrast.
- **Missing visual separators under titles** — A thin horizontal line (1-2pt, accent color) between a slide title and body content provides clear visual structure:
  ```python
  separator = slide.shapes.add_shape(
      MSO_AUTO_SHAPE_TYPE.RECTANGLE,
      Inches(0.8), Inches(1.5), Inches(8.4), Pt(2)
  )
  separator.fill.solid()
  separator.fill.fore_color.rgb = RGBColor(0, 80, 158)  # accent color
  separator.line.fill.background()
  ```

## Common Patterns and Examples

### Complete Presentation Creation

```python
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN

prs = Presentation()

# Slide 1: Title
slide = prs.slides.add_slide(prs.slide_layouts[0])
slide.shapes.title.text = "Quarterly Review"
slide.placeholders[1].text = "Q4 2024"

# Slide 2: Agenda
slide = prs.slides.add_slide(prs.slide_layouts[1])
slide.shapes.title.text = "Agenda"

body = slide.placeholders[1]
tf = body.text_frame
tf.text = "Financial Overview"

p = tf.add_paragraph()
p.text = "Product Updates"
p.level = 0

p = tf.add_paragraph()
p.text = "New Features"
p.level = 1

p = tf.add_paragraph()
p.text = "Roadmap"
p.level = 0

# Slide 3: Key Metrics
slide = prs.slides.add_slide(prs.slide_layouts[5])
slide.shapes.title.text = "Key Metrics"

# Add text box with metrics
left = Inches(1)
top = Inches(2)
width = Inches(3)
height = Inches(1.5)
txBox = slide.shapes.add_textbox(left, top, width, height)
tf = txBox.text_frame

p = tf.add_paragraph()
p.text = "Revenue"
p.font.size = Pt(16)
p.font.color.rgb = RGBColor(100, 100, 100)

p = tf.add_paragraph()
p.text = "$12.5M"
p.font.size = Pt(32)
p.font.bold = True
p.font.color.rgb = RGBColor(0, 100, 200)

prs.save('quarterly_review.pptx')
```

### Adding Watermark

```python
# Add watermark to all slides
from pptx.enum.shapes import MSO_AUTO_SHAPE_TYPE

for slide in prs.slides:
    # Add large text box
    watermark = slide.shapes.add_textbox(
        Inches(3), Inches(2.5), Inches(4), Inches(2)
    )
    tf = watermark.text_frame
    tf.text = "DRAFT"
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    p.font.size = Pt(60)
    p.font.color.rgb = RGBColor(200, 200, 200)
    p.font.bold = True
    p.font.italic = True

    # Make transparent (through fill)
    watermark.fill.background()
    watermark.line.fill.background()
```

### Adding Page Numbers

```python
from pptx.enum.text import PP_ALIGN

for idx, slide in enumerate(prs.slides, start=1):
    # Add text box at bottom right
    left = Inches(8.5)
    top = Inches(7)
    width = Inches(1)
    height = Inches(0.3)

    txBox = slide.shapes.add_textbox(left, top, width, height)
    tf = txBox.text_frame
    tf.text = str(idx)
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.RIGHT
    p.font.size = Pt(12)
    p.font.color.rgb = RGBColor(100, 100, 100)
```

### Batch Text Replacement

```python
from pathlib import Path
import zipfile
import re

def replace_in_pptx(pptx_path: Path, replacements: dict) -> None:
    """Replace text in all text frames of a PPTX file."""
    with zipfile.ZipFile(pptx_path, 'r') as zf:
        # Read slide XML files
        slide_files = [f for f in zf.namelist() if f.startswith('ppt/slides/slide')]

        for file_path in slide_files:
            xml_content = zf.read(file_path).decode('utf-8')

            # Replace in <a:t> tags
            for old_text, new_text in replacements.items():
                xml_content = re.sub(
                    f'<a:t>[^<]*{re.escape(old_text)}[^<]*</a:t>',
                    lambda m: m.group(0).replace(old_text, new_text),
                    xml_content
                )

    # Use unpack/pack workflow for modifications
```

For comprehensive text replacement, use the unpack/edit/pack workflow instead.

## Chinese/CJK Support

### Font Configuration

python-pptx sets the Latin font via `run.font.name`. For East Asian text, you need XML-level access to set the East Asian font separately:

```python
from pptx.util import Pt
from pptx.dml.color import RGBColor

# Set font name on a run (sets Latin font)
run.font.name = "Microsoft YaHei"

# Set East Asian font via XML
from pptx.oxml.ns import qn
rPr = run._r.get_or_add_rPr()
rFonts = rPr.find(qn('a:rFonts'))
if rFonts is None:
    from lxml import etree
    rFonts = etree.SubElement(rPr, qn('a:rFonts'))
rFonts.set(qn('a:ea'), "Microsoft YaHei")
```

### Recommended Chinese Fonts

- **"Microsoft YaHei"** - Modern sans-serif (Windows built-in)
- **"SimHei"** - Bold sans-serif (Windows built-in)
- **"SimSun"** - Traditional serif (Windows built-in)
- **"KaiTi"** - Calligraphic/italic style
- **"SarasaMonoSC"** - Monospace for code snippets (nerd font, may need install)

### Chinese Text Best Practices

- Always set BOTH Latin and East Asian fonts to prevent fallback issues
- Use larger font sizes for Chinese text (18pt minimum for body, 28pt+ for titles)
- Set `text_frame.word_wrap = True` for Chinese paragraphs
- For mixed Chinese-English text, use fonts that cover both ranges well

### Example: Chinese Slide Template

```python
def create_chinese_title_slide(prs, title_text, subtitle_text=""):
    slide_layout = prs.slide_layouts[0]
    slide = prs.slides.add_slide(slide_layout)

    title = slide.shapes.title
    title.text = title_text
    for para in title.text_frame.paragraphs:
        for run in para.runs:
            run.font.name = "Microsoft YaHei"
            run.font.size = Pt(36)

    if subtitle_text:
        subtitle = slide.placeholders[1]
        subtitle.text = subtitle_text
        for para in subtitle.text_frame.paragraphs:
            for run in para.runs:
                run.font.name = "Microsoft YaHei"
                run.font.size = Pt(20)
```

## Troubleshooting

### Common Issues

**Font not displaying**:
- Ensure the font is installed on the system
- Use common fonts (Arial, Calibri, Segoe UI, Helvetica)
- Fallback to generic font families

**Colors appear wrong**:
- Remember RGB values are 0-255, not 0-1 or hex
- Check for brightness/transparency settings

**Images distorted**:
- Specify only height or width, not both, to maintain aspect ratio
- Check original image resolution

**Text truncated**:
- Enable `text_frame.word_wrap = True`
- Increase text box height
- Reduce font size

**Chart not rendering**:
- Ensure chart data matches chart type
- Check category and series data format
- Verify XL_CHART_TYPE is correct

### Debug Mode

Enable verbose output to diagnose issues:

```python
import logging
logging.basicConfig(level=logging.DEBUG)

prs = Presentation('presentation.pptx')
# Work will produce detailed debug output
```

## Performance Optimization

### Large Presentations

For presentations with many slides:

1. **Batch operations**: Group similar operations together
2. **Minimize slide count**: Delete unused slides before processing
3. **Optimize images**: Resize large images before insertion
4. **Reuse layouts**: Create custom layouts to avoid repeated formatting

### Memory Management

When processing many presentations:

```python
# Process one presentation at a time
for pptx_file in Path('directory').glob('*.pptx'):
    try:
        prs = Presentation(pptx_file)
        # Modify presentation
        prs.save(f'output/{pptx_file.name}')
        del prs  # Explicit cleanup
    except Exception as e:
        print(f"Error processing {pptx_file}: {e}")
```

## Validation

### Structure Validation

Use the pack script with validation:

```bash
python scripts/office/pack.py unpacked/ output.pptx --validate true
```

This checks:
- XML structure integrity
- Relationship consistency
- Content type definitions
- Required file presence

### Content Validation

Check for common issues:

```python
def validate_presentation(prs: Presentation) -> list[str]:
    issues = []

    # Check for empty slides
    for idx, slide in enumerate(prs.slides, start=1):
        if len(slide.shapes) == 0:
            issues.append(f"Slide {idx}: No shapes")

    # Check for placeholder text
    for slide in prs.slides:
        for shape in slide.shapes:
            if hasattr(shape, "text_frame"):
                text = shape.text_frame.text.lower()
                if "click to add" in text:
                    issues.append(f"Slide: Found placeholder text '{shape.text_frame.text}'")

    return issues
```

## Integration Examples

### Generating from Data

```python
import csv
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor

def create_presentation_from_data(csv_file: str, output: str) -> None:
    prs = Presentation()

    # Title slide
    slide = prs.slides.add_slide(prs.slide_layouts[0])
    slide.shapes.title.text = "Data Report"
    slide.placeholders[1].text = "Generated from CSV"

    with open(csv_file) as f:
        reader = csv.DictReader(f)
        data = list(reader)

        # Summary slide
        slide = prs.slides.add_slide(prs.slide_layouts[5])
        slide.shapes.title.text = "Summary"

        txBox = slide.shapes.add_textbox(Inches(1), Inches(2), Inches(8), Inches(1))
        tf = txBox.text_frame
        tf.text = f"Total Records: {len(data)}"

        # Detail slides
        for idx, row in enumerate(data[:10], start=1):  # Limit to 10 slides
            slide = prs.slides.add_slide(prs.slide_layouts[5])
            slide.shapes.title.text = f"Record {idx}"

            left = Inches(1)
            for key, value in row.items():
                txBox = slide.shapes.add_textbox(left, Inches(2), Inches(8), Inches(0.4))
                tf = txBox.text_frame
                tf.text = f"{key}: {value}"
                left += Inches(0.5)

    prs.save(output)
```

### Dashboard Template

```python
def create_dashboard_template(title: str, metrics: dict, output: str) -> None:
    prs = Presentation()

    # Title slide
    slide = prs.slides.add_slide(prs.slide_layouts[0])
    slide.shapes.title.text = title

    # Metrics slide
    slide = prs.slides.add_slide(prs.slide_layouts[5])
    slide.shapes.title.text = "Key Metrics"

    # Create 2x2 grid of metric boxes
    positions = [(Inches(0.5), Inches(1.5)), (Inches(4.5), Inches(1.5)),
                 (Inches(0.5), Inches(4)), (Inches(4.5), Inches(4))]

    for (metric_name, metric_value), (left, top) in zip(metrics.items(), positions):
        # Box
        shape = slide.shapes.add_shape(
            MSO_AUTO_SHAPE_TYPE.ROUNDED_RECTANGLE,
            left, top, Inches(4), Inches(2.5)
        )
        shape.fill.solid()
        shape.fill.fore_color.rgb = RGBColor(240, 245, 250)
        shape.line.color.rgb = RGBColor(150, 180, 220)

        # Title
        tf = shape.text_frame
        p = tf.add_paragraph()
        p.text = metric_name
        p.font.size = Pt(14)
        p.font.color.rgb = RGBColor(100, 100, 100)

        # Value
        p = tf.add_paragraph()
        p.text = str(metric_value)
        p.font.size = Pt(28)
        p.font.bold = True
        p.font.color.rgb = RGBColor(0, 100, 200)

    prs.save(output)

# Usage
create_dashboard_template(
    "Sales Dashboard",
    {"Revenue": "$12.5M", "Growth": "+15%", "Customers": "2,450", "Churn": "2.1%"},
    "dashboard.pptx"
)
```

## Summary Checklist

Before delivering a PowerPoint, verify:

**Content**:
- [ ] All slides are present and in correct order
- [ ] Text is accurate and free of typos
- [ ] Images display correctly and are appropriately sized
- [ ] Charts show correct data and labels
- [ ] No placeholder text remains

**Design**:
- [ ] Consistent color scheme throughout
- [ ] Font sizes are readable (minimum Pt(18) for body text)
- [ ] Sufficient white space between elements
- [ ] Alignment is consistent across slides
- [ ] Branding elements are present if required

**Technical**:
- [ ] File opens without errors in PowerPoint and LibreOffice
- [ ] No corruption warnings
- [ ] File size is reasonable (< 50MB typical)
- [ ] All hyperlinks work
- [ ] Embedded media is accessible

**Testing**:
- [ ] Visual QA completed (thumbnail review)
- [ ] Validation passed if using pack script
- [ ] Presentation tested on multiple platforms if critical
