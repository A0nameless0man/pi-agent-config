---
name: docx-read
description: "Read-only .docx content extraction — paragraphs, tables, metadata, runs. Use when the user only needs to view or extract text from a Word document without modifying it. For creating or editing .docx files, use docx-write instead."
---

# docx-read Skill

## Overview

Read-only skill for extracting text and content from .docx files. Uses python-docx for core functionality. No creation, no editing, no OOXML manipulation. For creating or modifying documents, use the docx-write skill instead.

## Dependencies

```bash
pip install python-docx
```

Optional extras:

```bash
pip install pypandoc        # Alternative extraction via Pandoc
pip install docxlatex        # LaTeX equation reading
```

## Quick Reference

```python
from docx import Document
```

That's the only import you need for most tasks.

## Reading Documents

### Basic Text Extraction

```python
from docx import Document

doc = Document("document.docx")

# Extract all paragraph text
text = '\n'.join([para.text for para in doc.paragraphs])

# Extract with style info
for para in doc.paragraphs:
    print(f"[{para.style.name}] {para.text}")

# All text as single string, skipping empty paragraphs
full_text = '\n\n'.join([para.text for para in doc.paragraphs if para.text.strip()])
```

### Reading Tables

```python
from docx import Document

doc = Document("document.docx")

# Extract all tables
for i, table in enumerate(doc.tables):
    print(f"\n=== Table {i+1} ===")
    for row in table.rows:
        row_data = [cell.text for cell in row.cells]
        print(" | ".join(row_data))

# Extract as list of lists
all_tables = []
for table in doc.tables:
    table_data = []
    for row in table.rows:
        row_data = [cell.text for cell in row.cells]
        table_data.append(row_data)
    all_tables.append(table_data)
```

### Reading with Formatting Information

```python
from docx import Document

doc = Document("document.docx")

# Extract runs with formatting
for para in doc.paragraphs:
    for run in para.runs:
        print(f"Text: {run.text}")
        print(f"  Bold: {run.bold}, Italic: {run.italic}")
        print(f"  Font: {run.font.name}, Size: {run.font.size}")
        if run.font.color and run.font.color.rgb:
            print(f"  Color: {run.font.color.rgb}")
```

### Reading Metadata

```python
from docx import Document

doc = Document("document.docx")
props = doc.core_properties

print(f"Title: {props.title}")
print(f"Author: {props.author}")
print(f"Created: {props.created}")
print(f"Modified: {props.modified}")
print(f"Last Modified By: {props.last_modified_by}")
print(f"Revision: {props.revision}")
print(f"Subject: {props.subject}")
print(f"Category: {props.category}")
```

### Extracting Images (DOCX is ZIP)

```python
import zipfile

with zipfile.ZipFile("document.docx", 'r') as z:
    # List all media files
    media_files = [f for f in z.namelist() if f.startswith('word/media/')]
    print(f"Found {len(media_files)} images")
    for f in media_files:
        print(f"  {f}")

    # Extract images
    for f in media_files:
        z.extract(f, "extracted_images/")
```

### Using Pandoc (Alternative)

```python
import pypandoc

# Extract plain text
text = pypandoc.convert_file("document.docx", "plain")

# Extract as markdown (preserves structure)
markdown = pypandoc.convert_file("document.docx", "markdown")

# Extract as HTML
html = pypandoc.convert_file("document.docx", "html")
```

### Reading Headings/Structure

```python
from docx import Document

doc = Document("document.docx")

# Extract document structure (headings only)
for para in doc.paragraphs:
    if para.style.name.startswith('Heading'):
        level = int(para.style.name.split()[-1])
        indent = "  " * (level - 1)
        print(f"{indent}[H{level}] {para.text}")
```

### Reading Sections and Headers/Footers

```python
from docx import Document

doc = Document("document.docx")

# Check sections
for i, section in enumerate(doc.sections):
    print(f"Section {i+1}: {section.page_width}x{section.page_height}")

    # Header/footer text (separate from body paragraphs)
    header = section.header
    if header:
        for para in header.paragraphs:
            print(f"  Header: {para.text}")
    footer = section.footer
    if footer:
        for para in footer.paragraphs:
            print(f"  Footer: {para.text}")
```

### Reading LaTeX Equations (optional)

```bash
pip install docxlatex
```

```python
from docxlatex import Document

doc = Document("math-paper.docx")
text = doc.get_text()  # Triggers parsing

print(f"Found {len(doc.equations)} equations:")
for i, eq in enumerate(doc.equations, 1):
    print(f"  {i}. {eq}")
```

## Batch Reading Pattern

```python
import glob
from docx import Document

for path in glob.glob("documents/*.docx"):
    doc = Document(path)
    text = '\n'.join([p.text for p in doc.paragraphs])
    # Process text...
    print(f"{path}: {len(doc.paragraphs)} paragraphs, {len(doc.tables)} tables")
```

## Chinese/CJK Support

python-docx reads Chinese text natively. No special configuration needed for reading.

## Troubleshooting

- **Empty paragraphs**: Some paragraphs may appear empty due to whitespace-only content. Filter with `if para.text.strip()`.
- **Tables in headers/footers**: These are NOT in `doc.tables`. Access them via `section.header.tables` instead.
- **Tracked changes**: python-docx does NOT read tracked changes. For that, use the docx-write skill's OOXML approach.
- **Large files**: python-docx loads the entire document into memory. Plan accordingly for very large files.
