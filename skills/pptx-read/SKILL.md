---
name: pptx-read
description: "Read-only .pptx content extraction — slide text, shapes, tables, notes, metadata. Use when the user only needs to view or extract text from a PowerPoint presentation without modifying it. For creating or editing .pptx files, use pptx-write instead."
---

## Overview

This skill is for READING .pptx files only. Uses python-pptx to extract slide text, tables, notes, metadata, chart data, and slide structure. For creating or editing presentations, use the pptx-write skill.

## Dependencies

```bash
pip install python-pptx
```

## Quick Reference

```python
from pptx import Presentation
from pptx.util import Inches, Pt
```

## Reading Presentations

### Basic Text Extraction

```python
from pptx import Presentation

prs = Presentation("presentation.pptx")

# Extract all text from all slides
for i, slide in enumerate(prs.slides, 1):
    print(f"\n=== Slide {i} ===")
    for shape in slide.shapes:
        if hasattr(shape, "text") and shape.text.strip():
            print(shape.text)
```

### Reading Slide-by-Slide

```python
from pptx import Presentation

prs = Presentation("presentation.pptx")

print(f"Total slides: {len(prs.slides)}")
print(f"Slide width: {prs.slide_width}, height: {prs.slide_height}")

for i, slide in enumerate(prs.slides, 1):
    print(f"\n--- Slide {i} ---")
    print(f"  Layout: {slide.slide_layout.name}")
    print(f"  Shapes: {len(slide.shapes)}")
```

### Reading with Shape Types

```python
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE

prs = Presentation("presentation.pptx")

for i, slide in enumerate(prs.slides, 1):
    print(f"\n=== Slide {i} ===")
    for shape in slide.shapes:
        shape_type = shape.shape_type
        print(f"  Type: {shape_type}, Name: {shape.name}")

        if hasattr(shape, "text"):
            print(f"    Text: {shape.text[:100]}...")

        if shape.has_table:
            table = shape.table
            print(f"    Table: {len(table.rows)}x{len(table.columns)}")
            for row in table.rows:
                row_text = [cell.text for cell in row.cells]
                print(f"      " + " | ".join(row_text))

        if shape_type == MSO_SHAPE_TYPE.PICTURE:
            print(f"    Image: {shape.image.content_type}, size: {len(shape.image.blob)} bytes")
```

### Reading Tables from Slides

```python
from pptx import Presentation

prs = Presentation("presentation.pptx")

for i, slide in enumerate(prs.slides, 1):
    for shape in slide.shapes:
        if shape.has_table:
            print(f"\n=== Slide {i} - Table ===")
            table = shape.table
            for row_idx, row in enumerate(table.rows):
                cells = [cell.text for cell in row.cells]
                print(" | ".join(cells))
```

### Reading Speaker Notes

```python
from pptx import Presentation

prs = Presentation("presentation.pptx")

for i, slide in enumerate(prs.slides, 1):
    notes_slide = slide.notes_slide
    if notes_slide:
        notes_text = notes_slide.notes_text_frame.text
        if notes_text.strip():
            print(f"\n=== Slide {i} Notes ===")
            print(notes_text)
```

### Reading Metadata

```python
from pptx import Presentation

prs = Presentation("presentation.pptx")
props = prs.core_properties

print(f"Title: {props.title}")
print(f"Author: {props.author}")
print(f"Subject: {props.subject}")
print(f"Created: {props.created}")
print(f"Modified: {props.modified}")
print(f"Last Modified By: {props.last_modified_by}")
print(f"Comments: {props.comments}")
```

### Reading Slide Layouts

```python
from pptx import Presentation

prs = Presentation("presentation.pptx")

# List all available layouts
for i, layout in enumerate(prs.slide_layouts):
    print(f"Layout {i}: {layout.name}")
    # Show placeholders
    for ph in layout.placeholders:
        print(f"  Placeholder {ph.placeholder_format.idx}: {ph.placeholder_format.type}")
```

### Reading All Text with Structure

```python
from pptx import Presentation

def extract_all_text(prs):
    """Extract text from presentation maintaining slide structure."""
    result = []
    for i, slide in enumerate(prs.slides, 1):
        slide_data = {"slide": i, "title": "", "content": [], "notes": ""}

        # Title placeholder
        if slide.shapes.title:
            slide_data["title"] = slide.shapes.title.text

        # Content
        for shape in slide.shapes:
            if hasattr(shape, "text_frame") and shape is not slide.shapes.title:
                for para in shape.text_frame.paragraphs:
                    if para.text.strip():
                        slide_data["content"].append(para.text.strip())

        # Notes
        try:
            notes = slide.notes_slide.notes_text_frame.text
            if notes.strip():
                slide_data["notes"] = notes.strip()
        except:
            pass

        result.append(slide_data)

    return result

prs = Presentation("presentation.pptx")
data = extract_all_text(prs)

for slide_data in data:
    print(f"\n=== Slide {slide_data['slide']} ===")
    if slide_data['title']:
        print(f"Title: {slide_data['title']}")
    for item in slide_data['content']:
        print(f"  \u2022 {item}")
    if slide_data['notes']:
        print(f"Notes: {slide_data['notes'][:200]}...")
```

### Reading Charts Data

```python
from pptx import Presentation

prs = Presentation("presentation.pptx")

for i, slide in enumerate(prs.slides, 1):
    for shape in slide.shapes:
        if shape.has_chart:
            chart = shape.chart
            print(f"\n=== Slide {i} - Chart: {chart.chart_type} ===")
            for series in chart.series:
                print(f"  Series: {series.name if hasattr(series, 'name') else 'unnamed'}")
                print(f"  Values: {series.values}")
```

## Batch Reading

```python
from pptx import Presentation
import glob

for path in glob.glob("presentations/*.pptx"):
    prs = Presentation(path)
    text = "\n".join([
        shape.text
        for slide in prs.slides
        for shape in slide.shapes
        if hasattr(shape, "text") and shape.text.strip()
    ])
    print(f"{path}: {len(prs.slides)} slides, {len(text)} chars")
```

## Chinese/CJK Support

python-pptx reads Chinese text natively. No special configuration needed for reading.

## Troubleshooting

- **Missing text**: Some text may be in grouped shapes -- check shape.shapes recursively
- **Empty slides**: Template slides with no content will have shapes but no text
- **Corrupted files**: Presentation() will raise on truly corrupted files; wrap in try/except
- **Large presentations**: python-pptx loads entire presentation into memory
