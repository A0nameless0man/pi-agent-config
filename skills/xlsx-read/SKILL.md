---
name: xlsx-read
description: "Read-only spreadsheet data extraction — cell values, row/column iteration, sheet listing, formula results. Use when the user only needs to view or extract data from an Excel/spreadsheet file without modifying it. For creating or editing spreadsheets, use xlsx-write instead."
---

## Overview
This skill is for READING spreadsheet files only. Uses openpyxl. For creation, editing, formulas, or styling, use xlsx-write.

## Dependencies

```bash
pip install openpyxl
```

Optional: `pip install pandas` for DataFrame integration.

## Quick Reference

```python
from openpyxl import load_workbook
```

## Reading Spreadsheets

### Loading a Workbook

```python
from openpyxl import load_workbook

# Load with computed formula values (recommended for reading)
wb = load_workbook('spreadsheet.xlsx', data_only=True)

# Load with formulas (if you need to see the formulas)
wb = load_workbook('spreadsheet.xlsx', data_only=False)

# Load read-only for large files
wb = load_workbook('spreadsheet.xlsx', read_only=True, data_only=True)
```

### Sheet Information

```python
from openpyxl import load_workbook

wb = load_workbook('spreadsheet.xlsx', data_only=True)

# List sheet names
print(f"Sheets: {wb.sheetnames}")

# Get active sheet
ws = wb.active
print(f"Active sheet: {ws.title}")

# Access by name
ws = wb['Sheet1']

# Get dimensions
print(f"Data range: {ws.dimensions}")
print(f"Max row: {ws.max_row}, Max column: {ws.max_column}")
print(f"Min row: {ws.min_row}, Min column: {ws.min_column}")

# Cell count
print(f"Estimated cells with data: {(ws.max_row - ws.min_row + 1) * (ws.max_column - ws.min_column + 1)}")

wb.close()
```

### Reading Specific Cells

```python
from openpyxl import load_workbook

wb = load_workbook('spreadsheet.xlsx', data_only=True)
ws = wb.active

# By coordinate
value = ws['A1'].value
print(f"A1: {value}")

# By row/column index
value = ws.cell(row=1, column=2).value
print(f"B1: {value}")

# Check if cell is empty
if ws['C5'].value is None:
    print("C5 is empty")

wb.close()
```

### Iterating Rows

```python
from openpyxl import load_workbook

wb = load_workbook('spreadsheet.xlsx', data_only=True)
ws = wb.active

# Iterate all rows with values
for row in ws.iter_rows(min_row=1, values_only=True):
    print(row)  # Tuple of cell values

# Skip header row
header = next(ws.iter_rows(min_row=1, max_row=1, values_only=True))
print(f"Headers: {header}")

for row in ws.iter_rows(min_row=2, values_only=True):
    print(row)

# With cell objects (for accessing formatting)
for row in ws.iter_rows(min_row=1, max_row=1):
    for cell in row:
        print(f"{cell.coordinate}: value={cell.value}, font={cell.font}")

wb.close()
```

### Iterating Columns

```python
from openpyxl import load_workbook

wb = load_workbook('spreadsheet.xlsx', data_only=True)
ws = wb.active

# Read specific columns
for col in ws.iter_cols(min_col=1, max_col=3, values_only=True):
    print(col)

wb.close()
```

### Reading as Dictionary

```python
from openpyxl import load_workbook

wb = load_workbook('spreadsheet.xlsx', data_only=True)
ws = wb.active

# Get headers from first row
headers = [cell.value for cell in ws[1]]

# Read data rows as dictionaries
data = []
for row in ws.iter_rows(min_row=2, values_only=True):
    row_dict = dict(zip(headers, row))
    data.append(row_dict)

# Print first 3 records
for record in data[:3]:
    print(record)

wb.close()
```

### Reading with pandas (Alternative)

```python
import pandas as pd

# Read entire sheet
df = pd.read_excel('spreadsheet.xlsx', sheet_name='Sheet1')
print(df.head())
print(df.describe())

# Read specific sheet
df = pd.read_excel('spreadsheet.xlsx', sheet_name=0)  # First sheet

# Read all sheets
all_sheets = pd.read_excel('spreadsheet.xlsx', sheet_name=None)
for name, df in all_sheets.items():
    print(f"\n=== {name} ===")
    print(f"Rows: {len(df)}, Columns: {len(df.columns)}")
    print(df.head(3))
```

### Reading CSV/TSV Files

```python
import csv

# Read CSV
with open('data.csv', 'r', encoding='utf-8') as f:
    reader = csv.DictReader(f)
    for row in reader:
        print(row)

# With pandas
import pandas as pd
df = pd.read_csv('data.csv')
df = pd.read_csv('data.tsv', sep='\t')
```

### Reading with pandas — SQL-style Queries

```python
import pandas as pd

df = pd.read_excel('sales.xlsx')

# Filter
high_value = df[df['Amount'] > 10000]

# Group and aggregate
by_region = df.groupby('Region')['Amount'].sum()

# Sort
top_sales = df.nlargest(10, 'Amount')
```

### Checking for Formula Errors

```python
from openpyxl import load_workbook

wb = load_workbook('spreadsheet.xlsx', data_only=True)
ws = wb.active

# After loading with data_only=True, cells with errors will show None
# To see formulas and detect potential errors:
wb_formula = load_workbook('spreadsheet.xlsx', data_only=False)
ws_f = wb_formula.active

for row in ws_f.iter_rows():
    for cell in row:
        if cell.value and isinstance(cell.value, str) and cell.value.startswith('='):
            computed = ws[cell.coordinate].value
            if computed is None or str(computed).startswith('#'):
                print(f"{cell.coordinate}: {cell.value} \u2192 {computed} (POSSIBLE ERROR)")

wb.close()
wb_formula.close()
```

### Reading Merged Cells

```python
from openpyxl import load_workbook

wb = load_workbook('spreadsheet.xlsx', data_only=True)
ws = wb.active

# List all merged cell ranges
for merged_range in ws.merged_cells.ranges:
    print(f"Merged: {merged_range}")
    # Value is in the top-left cell
    top_left = str(merged_range).split(':')[0]
    print(f"  Value: {ws[top_left].value}")

wb.close()
```

### Reading Chart Information

```python
from openpyxl import load_workbook

wb = load_workbook('spreadsheet.xlsx', data_only=True)
ws = wb.active

for chart in ws._charts:
    print(f"Chart: {chart.title}")
    # Chart dimensions
    print(f"  Anchor: {chart.anchor}")

wb.close()
```

## Performance Tips
- Use `read_only=True` for large files (>10MB) to reduce memory usage
- Use `data_only=True` to get computed values instead of formulas
- Use `values_only=True` with `iter_rows()` to avoid loading cell objects
- Always `wb.close()` when done
- For huge files, consider `pandas.read_excel()` which can be faster

## Chinese/CJK Support
openpyxl reads Chinese text natively. No special configuration needed for reading.

## Troubleshooting
- **None values**: `data_only=True` may return None for cells with uncalculated formulas. Open in Excel first to compute.
- **Slow loading**: Use `read_only=True` for large files
- **File not found**: Use absolute paths or verify working directory
- **Password-protected files**: openpyxl cannot open encrypted files
