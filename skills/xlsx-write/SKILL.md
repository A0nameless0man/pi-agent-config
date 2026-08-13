---
name: xlsx-write
description: "Create and modify Excel spreadsheets — workbook creation, formulas, recalculation, styling, charts, conditional formatting, data validation, pivot tables, Excel tables. Use for any spreadsheet creation or modification task. For read-only data extraction, use xlsx-read instead. (recommended category: deep)"
---

# Excel Spreadsheet Operations with openpyxl

You are a spreadsheet specialist using openpyxl to create, read, modify, and analyze Excel files. Your role is to handle all Excel-related tasks including data manipulation, formula management, styling, visualization, and quality assurance.

## Core Principles

- **File Safety First**: Always verify file paths exist before reading. Create backup copies before modifying critical files.
- **Formula Validation**: Formulas written with openpyxl must be recalculated using LibreOffice headless mode to get computed values.
- **Efficient Processing**: Use read-only mode for large files, write-only mode for bulk data generation, and optimized modes for analysis.
- **Style Consistency**: Use named styles or reusable style objects instead of applying styles to individual cells repeatedly.
- **Error Detection**: Scan for formula errors after any write or modification operation.

> **Note**: This skill is for CREATING and MODIFYING spreadsheets. To simply read/extract data from an existing spreadsheet, use the **xlsx-read** skill instead.

## Query Decomposition Protocol

Before writing any spreadsheet code, analyze the user request to identify both explicit and implicit requirements:

### Explicit Requirements
- Deliverables: what files, sheets, or outputs are expected
- Formats: number formats, date formats, currency conventions
- Metrics and KPIs: specific calculations or indicators mentioned
- Data scope: time ranges, categories, filters

### Implicit Requirements
- **Business context**: industry conventions (e.g., financial models follow specific color-coding rules)
- **Target audience**: executive summaries need different formatting than operational reports
- **Interaction mode**: will the file be used for further editing, or is it read-only output?
- **Professional standards**: auditability requires formulas (not hardcoded values), proper error handling

### Multi-Part Requests

When a request contains multiple parts, analyze each part independently:

- **Example**: User says "make a sales report" → implicit needs include:
  - Time dimension (monthly/quarterly/yearly)
  - Comparison baseline (vs. prior period, vs. target)
  - Trend visualization (chart)
  - KPI summary section

Do not proceed with coding until all explicit and implicit requirements are mapped out.

## Workflow Patterns

### Pattern 1: Creating New Spreadsheets

Use this pattern when generating new Excel files from scratch:

```python
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Border, Side, Alignment

# Create workbook with specific sheet names
wb = Workbook()
ws = wb.active
ws.title = 'Data'

# Add additional sheets
summary = wb.create_sheet('Summary', 0)  # Position 0
details = wb.create_sheet('Details')

# Write headers with styling
header_fill = PatternFill(start_color='4472C4', end_color='4472C4', fill_type='solid')
header_font = Font(bold=True, color='FFFFFF', size=11)

for col_num, header in enumerate(['Name', 'Value', 'Date'], 1):
    cell = ws.cell(row=1, column=col_num, value=header)
    cell.fill = header_fill
    cell.font = header_font

# Add data
ws.append(['Item 1', 100, '2026-04-10'])
ws.append(['Item 2', 200, '2026-04-11'])

# Save the workbook
wb.save('new_file.xlsx')
```

### Pattern 2: Reading Existing Files

For reading existing files, use the **xlsx-read** skill. This skill focuses on creation and modification.

### Pattern 3: Bulk Data Import

Use this pattern for importing large datasets efficiently:

```python
from openpyxl import Workbook
from openpyxl.utils.dataframe import dataframe_to_rows
import pandas as pd

# Create from pandas DataFrame
df = pd.DataFrame({
    'Product': ['A', 'B', 'C'],
    'Price': [10.99, 25.50, 7.75],
    'Stock': [100, 50, 200]
})

wb = Workbook()
ws = wb.active

# Convert DataFrame to rows
for r_idx, row in enumerate(dataframe_to_rows(df, index=False, header=True), 1):
    for c_idx, value in enumerate(row, 1):
        cell = ws.cell(row=r_idx, column=c_idx, value=value)

        # Apply header styling
        if r_idx == 1:
            cell.font = Font(bold=True)
            cell.fill = PatternFill(start_color='D9E1F2', fill_type='solid')

        # Apply number format for currency
        if c_idx == 2 and r_idx > 1:
            cell.number_format = '#,##0.00'

# Auto-fit columns
for column in ws.columns:
    max_length = 0
    column_letter = get_column_letter(column[0].column)
    for cell in column:
        try:
            if len(str(cell.value)) > max_length:
                max_length = len(str(cell.value))
        except:
            pass
    adjusted_width = min(max_length + 2, 50)
    ws.column_dimensions[column_letter].width = adjusted_width

wb.save('imported_data.xlsx')
```

### Pattern 4: Formula Management with Recalculation

Use this pattern when working with formulas:

```python
from openpyxl import Workbook, load_workbook
from openpyxl.utils import get_column_letter
import subprocess
import json
import sys
import os

# Add skill directory to path for recalc import
skill_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, skill_dir)

# Create workbook with formulas
wb = Workbook()
ws = wb.active

# Write sample data
ws['A1'] = 'Product'
ws['B1'] = 'Quantity'
ws['C1'] = 'Price'
ws['D1'] = 'Total'

ws.append(['Widget A', 5, 10.99, '=B2*C2'])
ws.append(['Widget B', 3, 25.50, '=B3*C3'])
ws.append(['Widget C', 10, 7.75, '=B4*C4'])

# Add summary formula
ws['D5'] = '=SUM(D2:D4)'
ws['B5'] = 'Total'

# Save file
filename = 'formulas.xlsx'
wb.save(filename)
wb.close()

# Recalculate using LibreOffice headless
from recalc import recalc as recalc_formulas

result = recalc_formulas(filename)

print(f"Recalculation status: {result.get('status')}")
print(f"Total formulas: {result.get('total_formulas')}")
print(f"Total errors: {result.get('total_errors')}")

if result.get('error_summary'):
    print("Errors found:")
    for error_type, details in result['error_summary'].items():
        print(f"  {error_type}: {details['count']} occurrences")
        for location in details['locations'][:5]:
            print(f"    - {location}")

# Load back with data_only to get computed values
wb = load_workbook(filename, data_only=True)
ws = wb.active

print(f"Computed total: {ws['D5'].value}")
wb.close()
```

### Use Formulas, Not Hardcoded Values

**Core principle**: All calculated values must be expressed as formulas, never written as pre-computed numbers. This ensures the spreadsheet is auditable, modifiable, and self-consistent.

```python
# WRONG — hardcoded calculated value
ws['D2'] = 1500  # sum of A2:C2
ws['E2'] = 0.15  # growth rate: (1500-1304)/1304

# CORRECT — formulas express the calculation logic
ws['D2'] = '=SUM(A2:C2)'
ws['E2'] = '=(D2-B2)/B2'
```

```python
# WRONG — hardcoded average
ws['F2'] = 483.3  # average

# CORRECT — formula
ws['F2'] = '=AVERAGE(A2:C2)'
```

Even when the user provides pre-calculated values, trace back to the source and express them as formulas. If the source data is not available in the spreadsheet, add it to a dedicated assumptions or inputs section so all outputs remain formula-driven.

### Pattern 5: Styling and Formatting

Use this pattern for comprehensive styling:

```python
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill, Border, Side, Alignment, NamedStyle
from openpyxl.utils import get_column_letter

wb = Workbook()
ws = wb.active

# Define reusable styles
header_style = {
    'font': Font(bold=True, color='FFFFFF', size=11),
    'fill': PatternFill(start_color='4472C4', end_color='4472C4', fill_type='solid'),
    'alignment': Alignment(horizontal='center', vertical='center'),
    'border': Border(
        left=Side(style='thin', color='000000'),
        right=Side(style='thin', color='000000'),
        top=Side(style='thin', color='000000'),
        bottom=Side(style='thin', color='000000')
    )
}

# Create named style for data rows
data_style = NamedStyle(name='dataStyle')
data_style.font = Font(size=11)
data_style.border = Border(
    left=Side(style='thin', color='D9D9D9'),
    right=Side(style='thin', color='D9D9D9'),
    top=Side(style='thin', color='D9D9D9'),
    bottom=Side(style='thin', color='D9D9D9')
)
data_style.alignment = Alignment(vertical='center')

wb.add_named_style(data_style)

# Write and style headers
headers = ['ID', 'Name', 'Category', 'Value', 'Date']
for col_idx, header in enumerate(headers, 1):
    cell = ws.cell(row=1, column=col_idx, value=header)
    cell.font = header_style['font']
    cell.fill = header_style['fill']
    cell.alignment = header_style['alignment']
    cell.border = header_style['border']

# Write data rows with alternating colors
data = [
    [1, 'Item A', 'Category 1', 1500.75, '2026-04-01'],
    [2, 'Item B', 'Category 2', 2300.50, '2026-04-02'],
    [3, 'Item C', 'Category 1', 890.25, '2026-04-03'],
]

light_fill = PatternFill(start_color='FFFFFF', fill_type='solid')
medium_fill = PatternFill(start_color='F2F2F2', fill_type='solid')

for row_idx, row_data in enumerate(data, start=2):
    for col_idx, value in enumerate(row_data, start=1):
        cell = ws.cell(row=row_idx, column=col_idx, value=value)
        cell.style = data_style
        cell.fill = medium_fill if row_idx % 2 == 0 else light_fill

        # Apply number formats
        if col_idx == 4:  # Value column
            cell.number_format = '#,##0.00'

# Set column widths and row heights
ws.column_dimensions['A'].width = 8
ws.column_dimensions['B'].width = 20
ws.column_dimensions['C'].width = 15
ws.column_dimensions['D'].width = 15
ws.column_dimensions['E'].width = 12

ws.row_dimensions[1].height = 25

# Freeze header row
ws.freeze_panes = 'A2'

wb.save('styled.xlsx')
```

### Financial Modeling Color Coding Standards

Industry-standard color coding for financial models ensures auditability and clarity about the nature of each cell's content:

| Color | Meaning | Usage |
|-------|---------|-------|
| **Blue** (`0000FF`) | Hardcoded input values | Manually entered assumptions and inputs |
| **Black** (`000000`) | Calculated values (formulas) | Formula-driven results |
| **Green** (`008000`) | Internal links | References to cells within the same sheet |
| **Red** (`FF0000`) | External links | References to other sheets or external files |

Additionally, **key assumption cells** should use a yellow background highlight to draw attention.

```python
from openpyxl.styles import Font, PatternFill

# Input cells — blue font for hardcoded values
input_font = Font(color="0000FF")  # Blue
input_fill = PatternFill(start_color="FFFF00", end_color="FFFF00", fill_type="solid")  # Yellow highlight for key assumptions

# Formula cells — black font for calculated values
formula_font = Font(color="000000")  # Black

# Internal links — green font for same-sheet references
link_font = Font(color="008000")  # Green

# External links — red font for cross-sheet or cross-file references
external_font = Font(color="FF0000")  # Red

# Example: applying financial model color coding
ws['A1'] = 100000  # Revenue assumption (hardcoded input)
ws['A1'].font = input_font
ws['A1'].fill = input_fill  # Highlight as key assumption

ws['B1'] = '=A1*1.1'  # Projected revenue (formula)
ws['B1'].font = formula_font
```

### Pattern 6: Chart Creation

Use this pattern for adding visualizations:

```python
from openpyxl import Workbook
from openpyxl.chart import BarChart, LineChart, PieChart, ScatterChart, Reference
from openpyxl.chart.label import DataLabelList
from openpyxl.utils import get_column_letter

wb = Workbook()
ws = wb.active

# Prepare data
ws.append(['Quarter', 'Sales', 'Target', 'Expenses'])
ws.append(['Q1', 45000, 50000, 32000])
ws.append(['Q2', 52000, 55000, 35000])
ws.append(['Q3', 48000, 60000, 33000])
ws.append(['Q4', 61000, 65000, 38000])

# Create bar chart
bar_chart = BarChart()
bar_chart.type = "col"
bar_chart.style = 10
bar_chart.title = "Quarterly Performance"
bar_chart.y_axis.title = 'Amount ($)'
bar_chart.x_axis.title = 'Quarter'

data = Reference(ws, min_col=2, min_row=1, max_row=5, max_col=3)
cats = Reference(ws, min_col=1, min_row=2, max_row=5)

bar_chart.add_data(data, titles_from_data=True)
bar_chart.set_categories(cats)
bar_chart.shape = 4

ws.add_chart(bar_chart, "G2")

# Create line chart for expenses
line_chart = LineChart()
line_chart.style = 12
line_chart.title = "Expense Trend"
line_chart.y_axis.title = 'Amount ($)'
line_chart.x_axis.title = 'Quarter'

expense_data = Reference(ws, min_col=4, min_row=1, max_row=5)
line_chart.add_data(expense_data, titles_from_data=True)
line_chart.set_categories(cats)

# Add data labels
line_chart.dataLabels = DataLabelList()
line_chart.dataLabels.showVal = True

ws.add_chart(line_chart, "G20")

# Create pie chart for Q4 breakdown
pie_chart = PieChart()
pie_chart.title = "Q4 Revenue Breakdown"

labels = Reference(ws, min_col=1, min_row=2, max_row=5)
data = Reference(ws, min_col=2, min_row=2, max_row=5)

pie_chart.add_data(data)
pie_chart.set_categories(labels)

pie_chart.dataLabels = DataLabelList()
pie_chart.dataLabels.showPercent = True

ws.add_chart(pie_chart, "G40")

# Create scatter chart
scatter = ScatterChart()
scatter.title = "Sales vs Expenses"
scatter.x_axis.title = 'Sales'
scatter.y_axis.title = 'Expenses'

xvalues = Reference(ws, min_col=2, min_row=2, max_row=5)
yvalues = Reference(ws, min_col=4, min_row=2, max_row=5)

series = scatter.add_data(yvalues)
series.xvalues = xvalues

ws.add_chart(scatter, "G60")

wb.save('charts.xlsx')
```

### Chart Data Source Requirements

Charts in openpyxl have three critical technical requirements for data sources:

1. **Data must contain computed values, not formula strings** — always run `recalc.py` before creating charts if the source data includes formulas. A chart referencing uncomputed formula cells will display as blank.

2. **The first row of the data range must be text headers** — openpyxl uses the first row as series names. If the first row contains numbers, the chart will misinterpret the data structure and produce incorrect labels.

3. **Hidden rows in data range** — if auxiliary/helper rows are hidden, ensure the chart is not set to "plot visible cells only" or the chart will render as empty.

```python
# CORRECT workflow for charts with formula-based data
from openpyxl import load_workbook
from openpyxl.chart import BarChart, Reference
from recalc import recalc as recalc_formulas

# Step 1: Write data and formulas, then save
wb = Workbook()
ws = wb.active
ws.append(['Quarter', 'Revenue', 'Expenses'])
ws.append(['Q1', 45000, 32000])
ws.append(['Q2', '=B2*1.15', '=C2*1.1'])  # Formulas
wb.save('chart_data.xlsx')
wb.close()

# Step 2: Recalculate formulas to get actual values
recalc_formulas('chart_data.xlsx')

# Step 3: Reload and create chart — data now has computed values
wb = load_workbook('chart_data.xlsx')
ws = wb.active

chart = BarChart()
data = Reference(ws, min_col=2, min_row=1, max_row=3, max_col=3)
cats = Reference(ws, min_col=1, min_row=2, max_row=3)
chart.add_data(data, titles_from_data=True)
chart.set_categories(cats)
ws.add_chart(chart, "E2")

wb.save('chart_data.xlsx')
```

**Common pitfall**: Chart shows blank → the data source likely contains uncomputed formulas. Fix: save → run `recalc.py` → reload → create chart.

### Pattern 7: Excel Tables

Use this pattern for creating native Excel tables:

```python
from openpyxl import Workbook
from openpyxl.worksheet.table import Table, TableStyleInfo

wb = Workbook()
ws = wb.active

# Prepare data for table
data = [
    ['ID', 'Name', 'Department', 'Salary', 'Hire Date'],
    [101, 'John Smith', 'Engineering', 75000, '2020-01-15'],
    [102, 'Jane Doe', 'Marketing', 65000, '2019-06-01'],
    [103, 'Bob Johnson', 'Sales', 55000, '2021-03-22'],
    [104, 'Alice Brown', 'Engineering', 80000, '2018-11-30'],
    [105, 'Charlie Wilson', 'HR', 60000, '2020-08-10'],
]

for row in data:
    ws.append(row)

# Define table style
tab = Table(displayName="EmployeeData", ref="A1:E6")

# Add default style
style = TableStyleInfo(
    name="TableStyleMedium9",
    showFirstColumn=False,
    showLastColumn=False,
    showRowStripes=True,
    showColumnStripes=False
)
tab.tableStyleInfo = style

# Add table to worksheet
ws.add_table(tab)

# Table is now created with auto-filter enabled
# Data in the table can be referenced in formulas by table name
ws['A8'] = 'Total Salary'
ws['B8'] = '=SUM(EmployeeData[Salary])'

wb.save('tables.xlsx')
```

### Pattern 8: Conditional Formatting

Use this pattern for dynamic formatting based on values:

```python
from openpyxl import Workbook
from openpyxl.formatting.rule import ColorScaleRule, DataBarRule, CellIsRule, FormulaRule
from openpyxl.styles import PatternFill, Font, Border
from openpyxl.styles.differential import DifferentialStyle

wb = Workbook()
ws = wb.active

# Add sample data
headers = ['Product', 'Sales', 'Target', 'Achievement']
for col, header in enumerate(headers, 1):
    cell = ws.cell(row=1, column=col, value=header)
    cell.font = Font(bold=True)

data = [
    ['Product A', 45000, 50000, '=B2/C2'],
    ['Product B', 52000, 55000, '=B3/C3'],
    ['Product C', 38000, 40000, '=B4/C4'],
    ['Product D', 61000, 60000, '=B5/C5'],
    ['Product E', 29000, 30000, '=B6/C6'],
]

for row_data in data:
    ws.append(row_data)

# Color scale for sales values (gradient from red to green)
red_fill = PatternFill(start_color='FF0000', end_color='FF0000', fill_type='solid')
green_fill = PatternFill(start_color='00FF00', end_color='00FF00', fill_type='solid')

color_scale_rule = ColorScaleRule(
    start_type='min', start_color='FFC7CE',
    mid_type='percentile', mid_value=50, mid_color='FFEB9C',
    end_type='max', end_color='C6EFCE'
)
ws.conditional_formatting.add('B2:B6', color_scale_rule)

# Data bars for achievement column
data_bar_rule = DataBarRule(
    start_type='min', end_type='max',
    color='638EC6', showValue=True
)
ws.conditional_formatting.add('D2:D6', data_bar_rule)

# Highlight cells where target is not met (achievement < 1)
orange_fill = PatternFill(start_color='FFC000', end_color='FFC000', fill_type='solid')
achieve_rule = CellIsRule(
    operator='lessThan',
    formula=['1'],
    stopIfTrue=True,
    fill=orange_fill
)
ws.conditional_formatting.add('D2:D6', achieve_rule)

# Highlight top performer (max sales)
top_font = Font(bold=True, color='006100')
top_fill = PatternFill(start_color='C6EFCE', end_color='C6EFCE', fill_type='solid')

from openpyxl.formatting.rule import FormulaRule as FR

top_rule = FR(
    formula=['B2=MAX($B$2:$B$6)'],
    font=top_font,
    fill=top_fill
)
ws.conditional_formatting.add('B2:B6', top_rule)

# Highlight underperformers (achievement < 0.9)
low_font = Font(bold=True, color='9C0006')
low_fill = PatternFill(start_color='FFC7CE', end_color='FFC7CE', fill_type='solid')

low_rule = CellIsRule(
    operator='lessThan',
    formula=['0.9'],
    font=low_font,
    fill=low_fill
)
ws.conditional_formatting.add('D2:D6', low_rule)

wb.save('conditional_formatting.xlsx')
```

### Pattern 9: Data Validation

Use this pattern for enforcing data input rules:

```python
from openpyxl import Workbook
from openpyxl.worksheet.datavalidation import DataValidation

wb = Workbook()
ws = wb.active

# Headers
headers = ['Employee', 'Department', 'Salary', 'Hire Date', 'Email']
for col, header in enumerate(headers, 1):
    cell = ws.cell(row=1, column=col, value=header)
    cell.font = Font(bold=True)

# Sample data
ws.append(['John Smith', 'Engineering', 75000, '2020-01-15', 'john@example.com'])
ws.append(['Jane Doe', 'Marketing', 65000, '2019-06-01', 'jane@example.com'])

# Validation 1: Dropdown list for departments
dept_validation = DataValidation(
    type="list",
    formula1='"Engineering,Marketing,Sales,HR,Finance"',
    allow_blank=True
)
dept_validation.error = 'Please select a valid department'
dept_validation.errorTitle = 'Invalid Department'
dept_validation.prompt = 'Select department from the list'
dept_validation.promptTitle = 'Department Selection'
dept_validation.showDropDown = True

ws.add_data_validation(dept_validation)
dept_validation.add('B2:B100')  # Apply to range

# Validation 2: Salary must be between 30000 and 200000
salary_validation = DataValidation(
    type="whole",
    operator="between",
    formula1=30000,
    formula2=200000,
    allow_blank=False
)
salary_validation.error = 'Salary must be between $30,000 and $200,000'
salary_validation.errorTitle = 'Invalid Salary'
salary_validation.errorStyle = 'warning'

ws.add_data_validation(salary_validation)
salary_validation.add('C2:C100')

# Validation 3: Hire date must be valid date
date_validation = DataValidation(
    type="date",
    operator="greaterThanOrEqual",
    formula1='2000-01-01',
    allow_blank=False
)
date_validation.error = 'Hire date must be on or after January 1, 2000'
date_validation.errorTitle = 'Invalid Date'

ws.add_data_validation(date_validation)
date_validation.add('D2:D100')

# Validation 4: Email format validation
email_validation = DataValidation(
    type="custom",
    formula1='AND(ISNUMBER(FIND("@",E2)),ISNUMBER(FIND(".",E2)),FIND(".",E2)>FIND("@",E2))',
    allow_blank=False
)
email_validation.error = 'Please enter a valid email address'
email_validation.errorTitle = 'Invalid Email'

ws.add_data_validation(email_validation)
email_validation.add('E2:E100')

# Validation 5: Text length for employee name (must be at least 3 characters)
name_validation = DataValidation(
    type="textLength",
    operator="greaterThanOrEqual",
    formula1=3,
    allow_blank=False
)
name_validation.error = 'Employee name must be at least 3 characters long'
name_validation.errorTitle = 'Name Too Short'

ws.add_data_validation(name_validation)
name_validation.add('A2:A100')

wb.save('data_validation.xlsx')
```

### Pattern 10: Cell Merging and Advanced Operations

Use this pattern for complex cell operations:

```python
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill, Border, Side, Alignment
from openpyxl.utils import get_column_letter

wb = Workbook()
ws = wb.active

# Merge cells for title
ws.merge_cells('A1:E1')
title_cell = ws['A1']
title_cell.value = 'Q1 2026 Sales Report'
title_cell.font = Font(bold=True, size=16, color='FFFFFF')
title_cell.fill = PatternFill(start_color='1F4E78', end_color='1F4E78', fill_type='solid')
title_cell.alignment = Alignment(horizontal='center', vertical='center')
ws.row_dimensions[1].height = 30

# Merge subtitle cells
ws.merge_cells('A2:B2')
ws.merge_cells('D2:E2')
ws['A2'] = 'Generated: 2026-04-10'
ws['D2'] = 'Prepared by: Finance Dept'
ws['A2'].alignment = Alignment(horizontal='left')
ws['D2'].alignment = Alignment(horizontal='right')

# Insert columns and rows
ws.insert_cols(3)  # Insert new column at position 3
ws['C1'] = 'Region'  # New header

# Delete rows (for cleanup)
# ws.delete_rows(5)  # Delete row 5

# Add borders to merged area
thin_border = Border(
    left=Side(style='thin', color='000000'),
    right=Side(style='thin', color='000000'),
    top=Side(style='thin', color='000000'),
    bottom=Side(style='thin', color='000000')
)

title_cell.border = thin_border

# Add data
ws.append(['Product', 'Category', 'Region', 'Sales', 'Target'])
ws.append(['Widget A', 'Hardware', 'North', 45000, 50000])
ws.append(['Widget B', 'Software', 'South', 52000, 55000])
ws.append(['Widget C', 'Services', 'East', 38000, 40000])

# Unmerge cells if needed
# ws.unmerge_cells('A1:E1')

wb.save('merged_cells.xlsx')
```

## Zero Formula Errors Policy

**This is a hard quality gate, not a suggestion.** Every Excel model delivered must have zero formula errors.

### Common Error Types and Prevention

| Error | Cause | Prevention |
|-------|-------|------------|
| `#REF!` | Referenced a deleted cell/row/column | Avoid hardcoding cell positions; use structured references or named ranges |
| `#DIV/0!` | Division by zero | Wrap with `IFERROR()` or `IF(denominator=0, 0, numerator/denominator)` |
| `#VALUE!` | Type mismatch (e.g., text where number expected) | Validate data types before writing formulas |
| `#N/A` | VLOOKUP/INDEX-MATCH found no match | Use `IFNA()` to provide a fallback value |
| `#NAME?` | Misspelled function name or undefined name | Double-check formula syntax; see [#NAME? Error Prevention](#name-error-prevention) section |

### Delivery Checklist

Before delivering any spreadsheet:

1. Save the file
2. Run `recalc.py` to recompute all formulas
3. Check the recalc output for `total_errors` — must be **zero**
4. If errors are found, fix each one and re-run until the count is zero

This gate is non-negotiable. A spreadsheet with formula errors is an incomplete deliverable.

## Quality Assurance Pattern

Use this pattern to validate spreadsheet quality:

```python
from openpyxl import load_workbook
import sys
import os
from recalc import recalc as recalc_formulas

def validate_spreadsheet(filename):
    """Validate spreadsheet for common issues"""

    issues = []
    warnings = []

    # Check if file exists
    if not os.path.exists(filename):
        return {'status': 'error', 'message': f'File {filename} not found'}

    try:
        wb = load_workbook(filename, data_only=True)

        # 1. Check for empty sheets
        for sheet_name in wb.sheetnames:
            ws = wb[sheet_name]
            if ws.max_row <= 1:
                issues.append(f"Sheet '{sheet_name}' appears to be empty or has only headers")

        # 2. Recalculate and check for formula errors
        recalc_result = recalc_formulas(filename)

        if recalc_result.get('status') == 'errors_found':
            error_summary = recalc_result.get('error_summary', {})
            for error_type, details in error_summary.items():
                issues.append(f"Formula errors found ({error_type}): {details['count']} occurrences")

        # 3. Check for potential data issues
        for sheet_name in wb.sheetnames:
            ws = wb[sheet_name]

            # Check for merged cells that might cause issues
            merged_ranges = list(ws.merged_cells.ranges)
            if len(merged_ranges) > 20:
                warnings.append(f"Sheet '{sheet_name}' has {len(merged_ranges)} merged cells")

            # Check for very long formulas
            for row in ws.iter_rows():
                for cell in row:
                    if cell.value and isinstance(cell.value, str) and cell.value.startswith('='):
                        if len(cell.value) > 500:
                            warnings.append(f"Sheet '{sheet_name}' has very long formula at {cell.coordinate}")

        wb.close()

        status = 'success' if not issues else 'warning'
        return {
            'status': status,
            'issues': issues,
            'warnings': warnings,
            'formula_check': recalc_result
        }

    except Exception as e:
        return {'status': 'error', 'message': str(e)}

# Usage
result = validate_spreadsheet('output.xlsx')

if result['status'] == 'error':
    print(f"Validation failed: {result['message']}")
elif result['status'] == 'warning':
    print("Validation completed with warnings:")
    for issue in result['issues']:
        print(f"  - {issue}")
    for warning in result['warnings']:
        print(f"  - {warning}")
else:
    print("Spreadsheet validation passed")
```

### Formula Verification Checklist

Use this structured checklist to verify formula correctness after writing or modifying formulas:

#### Basic Verification

- [ ] **Cell reference accuracy**: Spot-check that cell references point to the intended targets (especially after inserting/deleting rows or columns)
- [ ] **Column mapping**: Confirm column indices are correct — column offset errors are the most common bug when generating spreadsheets programmatically
- [ ] **Row offset**: Check whether a header row causes a systematic off-by-one shift in all data references

#### Common Pitfalls

- **NaN / empty cell handling**: Wrap formulas with `IFERROR()` or `IF(ISBLANK(),...)` to handle blank cells gracefully
- **Far columns (Z, AA, AB...)**: Easy to overlook when generating column references programmatically — always verify the full range
- **Duplicate matches in SUMIF/VLOOKUP**: Multiple matching rows can return inflated sums or wrong values — verify with `COUNTIF` first
- **Division by zero**: Protect all division operations with `IF(denominator=0, 0, numerator/denominator)` or `IFERROR(numerator/denominator, 0)`
- **Cross-sheet references**: Sheet names containing spaces or special characters must be enclosed in single quotes (e.g., `='Q1 Data'!A1`)

#### Testing Strategy

For critical formulas, validate with known data:

```python
# Verify a SUMIF formula against manually computed results
expected = sum(row[1] for row in data if row[0] == 'Target')
actual = ws['Result'].value  # After recalc
assert abs(actual - expected) < 0.01, f"SUMIF mismatch: expected {expected}, got {actual}"
```

## Formula Error Reference

When working with formulas, watch for these common errors:

- **#VALUE!**: Wrong type of argument or operand
- **#DIV/0!**: Division by zero
- **#REF!**: Invalid cell reference
- **#NAME?**: Unrecognized text in formula
- **#NULL!**: Specified intersection does not exist
- **#NUM!**: Invalid numeric value
- **#N/A**: Value not available

Always use LibreOffice recalculation to verify formulas compute correctly before delivery.

## Formula Error Prevention Best Practices

Apply these preventive measures during formula creation to catch errors early:

### Before Writing Formulas

- **Validate cell references**: Verify the target cells exist and contain the expected data types
- **Check off-by-one errors**: Pay special attention to column offsets when generating formulas programmatically — verify the first and last formula manually
- **Ensure cross-period consistency**: When using fill/drag patterns, confirm that row references increment correctly and column references remain anchored where needed (use `$` for absolute references)

### Defensive Formula Patterns

```python
# Protect against division by zero
ws['D2'] = '=IFERROR(A2/B2, 0)'
# or explicit check
ws['D2'] = '=IF(B2=0, 0, A2/B2)'

# Protect against lookup failures
ws['E2'] = '=IFERROR(VLOOKUP(A2, LookupTable, 2, FALSE), "Not Found")'
# or IFNA for VLOOKUP specifically
ws['E2'] = '=IFNA(VLOOKUP(A2, LookupTable, 2, FALSE), "Not Found")'

# Handle empty cells explicitly
ws['F2'] = '=IF(ISBLANK(A2), "", A2*B2)'
```

### Testing Edge Cases

For every formula, consider these boundary conditions:

| Edge Case | Risk | Example |
|-----------|------|---------|
| Empty cell | `#VALUE!` or `0` | `IF(ISBLANK(A2), "", ...)` |
| Zero value | `#DIV/0!` | `IF(B2=0, 0, A2/B2)` |
| Very large numbers | Overflow or display issues | Test with `1e15`+ |
| Negative values | Sign reversal in logic | Verify ABS or sign-aware formulas |

### Circular Reference Check

After writing all formulas, confirm there are no circular references. A circular reference causes Excel to display a warning and may produce incorrect results or fail to calculate entirely.

For complex formulas, manually verify the calculation result with simple test data before applying to the full dataset.

### #NAME? Error Prevention

**Critical warning**: Never assign a plain text string that starts with `=` directly to a cell. Excel interprets any value starting with `=` as a formula, which will produce a `#NAME?` error if the text is not a valid formula.

```python
# WRONG — causes #NAME? error
ws['A1'] = '=Revenue Growth'   # Excel treats this as a formula
ws['B1'] = '=Q1 Target'        # Same problem

# CORRECT — remove the leading equals sign
ws['A1'] = 'Revenue Growth'
ws['B1'] = 'Q1 Target'

# If the equals sign is explicitly required in the displayed text,
# set text format first, then assign the value
from openpyxl.styles import numbers
ws['A1'].number_format = '@'  # Force text format before writing
ws['A1'] = '=Revenue Growth'
```

Common scenarios where this occurs: chart legend labels, description text, status labels, or any user-provided text that happens to start with `=`.

## Performance Optimization

For large files, follow these practices:

```python
# Use write-only mode for large file generation
from openpyxl import Workbook
wb = Workbook(write_only=True)
ws = wb.create_sheet()

for i in range(100000):
    ws.append([i, i*2, i*3])

wb.save('large_file.xlsx')

# Use read-only mode for large file analysis
from openpyxl import load_workbook
wb = load_workbook('large_file.xlsx', read_only=True)
ws = wb.active

for row in ws.iter_rows(values_only=True):
    process(row)  # Process each row

wb.close()
```

## Number Format Reference

Common number formats for openpyxl:

- `'General'`: Default format
- `'#,##0'`: Thousands separator
- `'#,##0.00'`: Two decimal places
- `'"$"#,##0.00'`: Currency
- `'"$"#,##0.00_);("$"#,##0.00)'`: Currency with negative in parentheses
- `'_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)'`: Accounting format
- `'0.00%'`: Percentage
- `'0.00"%"'`: Percentage with symbol
- `'mm/dd/yyyy'`: Date format
- `'h:mm AM/PM'`: Time format
- `'#,##0 ;(#,##0)'`: Negative numbers in parentheses

### Financial Number Formatting Rules

Industry-standard number formatting for financial models and reports:

| Data Type | Format | `number_format` Value | Notes |
|-----------|--------|----------------------|-------|
| Year | Text | `'@'` | Display "2024" not "2,024" — years are labels, not numbers |
| Currency (millions) | Header unit | N/A | Put unit in header: `"Revenue (USD M)"`, not in cells |
| Zero value | Dash | `'#,##0.00;(#,##0.00);"-"''` | Display `-` instead of `0` |
| Percentage | 1 decimal | `'0.0%'` | Standard for growth rates and margins |
| Valuation multiple | "x" suffix | `'0.0"x"'` | E.g., 12.5x EV/EBITDA |
| Negative number | Parentheses | `'#,##0;(#,##0)'` | `(1,234)` not `-1,234` |
| Thousands separator | Comma | `'#,##0'` | Standard integer format |

```python
# Year as text — prevent comma insertion
ws['A2'].number_format = '@'
ws['A2'] = '2024'

# Zero displayed as dash
ws['B2'].number_format = '#,##0.00;(#,##0.00);"-"'

# Percentage with one decimal
ws['C2'].number_format = '0.0%'

# Valuation multiple with "x" suffix
ws['D2'].number_format = '0.0"x"'

# Negative numbers in parentheses (standard financial convention)
ws['E2'].number_format = '#,##0;(#,##0)'
```

## Color Format Reference

Colors in openpyxl use hex strings with optional alpha prefix:

- `'FF0000'`: Red
- `'00FF00'`: Green
- `'0000FF'`: Blue
- `'FFFF00'`: Yellow
- `'FF00FF'`: Magenta
- `'00FFFF'`: Cyan
- `'000000'`: Black
- `'FFFFFF'`: White

For alpha transparency, use 8-character hex strings:
- `'FF4472C4'`: Blue with full opacity
- `'80FF0000'`: Red with 50% transparency

## Chart Style Reference

Built-in chart styles (1-48):
- Styles 1-8: Minimalist
- Styles 9-13: Standard business colors
- Styles 14-20: Colorful
- Styles 21-28: Monochrome
- Styles 29-48: Various themes

## Chinese/CJK Support

### Font Configuration for Chinese Text

openpyxl handles Chinese text natively — just set the font name to a CJK font. The font must be installed on the machine where the file is opened.

```python
from openpyxl.styles import Font, Alignment, PatternFill

# Chinese font - simply set the font name
chinese_font = Font(name='Microsoft YaHei', size=11)
chinese_header_font = Font(name='SimHei', size=14, bold=True)
chinese_title_font = Font(name='SimHei', size=18, bold=True, color='1F4E79')

# Apply to cell
ws['A1'].font = chinese_title_font
ws['A1'] = "销售数据报告"
```

### Recommended Chinese Fonts

| Font Name | Style | Best For |
|-----------|-------|----------|
| `Microsoft YaHei` | Modern sans-serif | Body text (Windows built-in) |
| `SimHei` | Bold sans-serif | Headers and titles (Windows built-in) |
| `SimSun` | Traditional serif | Body text (Windows built-in) |
| `KaiTi` | Calligraphic | Special emphasis |
| `SarasaMonoSC` | Monospace | Code/data alignment (nerd font) |
| `FangSong` | Official document | Government/formal documents |

### Chinese Text Alignment and Formatting

```python
# Chinese text alignment best practices
from openpyxl.styles import Alignment

# Body text: wrap text for long Chinese content
chinese_alignment = Alignment(
    horizontal='center',      # Chinese data often centered
    vertical='center',
    wrap_text=True,           # Essential for Chinese text
)

# Header alignment
header_alignment = Alignment(
    horizontal='center',
    vertical='center',
    wrap_text=True,
    shrink_to_fit=True,       # Auto-shrink if too wide
)

ws['A1'].alignment = chinese_alignment
```

### Column Width for Chinese Characters

Chinese characters are roughly 2x wider than Latin characters. Column widths must account for this.

```python
from openpyxl.utils import get_column_letter

# Manual column width for Chinese content
ws.column_dimensions['A'].width = 20   # ~10 Chinese characters
ws.column_dimensions['B'].width = 30   # ~15 Chinese characters

# Auto-fit approximation for Chinese text
def chinese_column_width(text, font_size=11):
    """Estimate column width for Chinese text."""
    # Chinese chars count as ~2 width units each
    latin_count = sum(1 for c in text if ord(c) < 128)
    cjk_count = len(text) - latin_count
    return max(8, (latin_count * font_size / 7) + (cjk_count * font_size / 3.5))

# Apply to header row
for col_idx, cell in enumerate(ws[1], 1):
    col_letter = get_column_letter(col_idx)
    ws.column_dimensions[col_letter].width = chinese_column_width(str(cell.value or ''))
```

### Number Format for Chinese Currency and Dates

```python
# Chinese Yuan currency format
ws['B2'].number_format = '¥#,##0.00'

# Chinese date format (YYYY年MM月DD日)
ws['C2'].number_format = 'yyyy"年"m"月"d"日"'

# Percentage with Chinese context
ws['D2'].number_format = '0.00%'
```

### Example: Chinese Financial Report Header

```python
from openpyxl.styles import Font, Alignment, PatternFill, Border, Side

def create_chinese_report_header(ws, title, period, department):
    """Create a styled Chinese report header row."""
    # Title row
    ws.merge_cells('A1:E1')
    ws['A1'] = title
    ws['A1'].font = Font(name='SimHei', size=18, bold=True, color='1F4E79')
    ws['A1'].alignment = Alignment(horizontal='center', vertical='center')
    ws.row_dimensions[1].height = 40

    # Subtitle row
    ws.merge_cells('A2:E2')
    ws['A2'] = f"报告期：{period}    部门：{department}"
    ws['A2'].font = Font(name='Microsoft YaHei', size=11, color='666666')
    ws['A2'].alignment = Alignment(horizontal='center', vertical='center')
    ws.row_dimensions[2].height = 25

    # Header row
    headers = ["序号", "项目名称", "金额（元）", "同比变化", "备注"]
    header_font = Font(name='SimHei', size=11, bold=True, color='FFFFFF')
    header_fill = PatternFill(start_color='1F4E79', end_color='1F4E79', fill_type='solid')
    header_alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
    thin_border = Border(
        left=Side(style='thin'),
        right=Side(style='thin'),
        top=Side(style='thin'),
        bottom=Side(style='thin'),
    )

    for col_idx, header in enumerate(headers, 1):
        cell = ws.cell(row=3, column=col_idx, value=header)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = header_alignment
        cell.border = thin_border

    ws.row_dimensions[3].height = 30
```

## Common Tasks Checklist

When creating spreadsheets, ensure:

- [ ] File saved in correct location with meaningful name
- [ ] All sheets have descriptive names
- [ ] Headers are properly styled and aligned
- [ ] Data types are correct (dates, numbers, text)
- [ ] Number formats applied appropriately
- [ ] Column widths set for readability
- [ ] Row heights set for headers
- [ ] Freeze panes set for large datasets
- [ ] Formulas validated and recalculated
- [ ] No formula errors present
- [ ] Data validation where appropriate
- [ ] Conditional formatting applied where helpful
- [ ] Charts added with proper titles and labels
- [ ] Tables created for structured data
- [ ] Document any special requirements or limitations

## File Safety Precautions

- Always create backups before modifying existing files
- Use try-except blocks when loading files
- Always close workbooks after use
- Verify file paths exist before operations
- Use meaningful file names with versioning
- Document any assumptions or limitations

## Dependencies

Required Python packages:
- openpyxl (primary library)
- pandas (optional, for DataFrame integration)

System requirements:
- LibreOffice (for formula recalculation)

Installation:
```bash
pip install openpyxl pandas
```

LibreOffice must be installed and accessible via `soffice` command for recalculation.
