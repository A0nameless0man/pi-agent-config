#!/usr/bin/env python3
"""
Document format conversion utilities.

Converts between DOCX, PDF, Markdown, and legacy .doc formats.
Requires: LibreOffice (for docx_to_pdf, doc_to_docx), pypandoc (for markdown_to_docx)
"""

import os
import shutil
import subprocess


def docx_to_pdf_libreoffice(docx_path, output_dir="."):
    """Convert DOCX to PDF using LibreOffice headless mode."""
    cmd = [
        "libreoffice",
        "--headless",
        "--convert-to",
        "pdf",
        "--outdir",
        output_dir,
        docx_path,
    ]
    subprocess.run(cmd, check=True)


def docx_to_pdf_unoconv(docx_path, output_path=None):
    """Convert DOCX to PDF using unoconv (requires LibreOffice running)."""
    cmd = ["unoconv", "-f", "pdf"]
    if output_path:
        cmd.extend(["-o", output_path])
    cmd.append(docx_path)
    subprocess.run(cmd, check=True)


def docx_to_pdf_pandoc(docx_path, output_path="output.pdf"):
    """Convert DOCX to PDF using pandoc with XeLaTeX engine."""
    import pypandoc

    pypandoc.convert_file(
        docx_path, "pdf", outputfile=output_path, extra_args=["--pdf-engine=xelatex"]
    )


def pdf_to_images(pdf_path, output_dir="images", dpi=200):
    """Convert PDF pages to PNG images using pdftoppm."""
    os.makedirs(output_dir, exist_ok=True)

    cmd = [
        "pdftoppm",
        "-r",
        str(dpi),
        "-png",
        pdf_path,
        os.path.join(output_dir, "page"),
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"pdftoppm failed: {result.stderr}")

    images = sorted(f for f in os.listdir(output_dir) if f.startswith("page"))
    return images


def doc_to_docx(doc_path, output_path=None):
    """Convert legacy .doc to .docx using LibreOffice."""
    if output_path is None:
        output_path = os.path.splitext(doc_path)[0] + ".docx"

    cmd = ["libreoffice", "--headless", "--convert-to", "docx", doc_path]

    subprocess.run(cmd, check=True)

    expected_output = os.path.basename(os.path.splitext(doc_path)[0]) + ".docx"
    if os.path.exists(expected_output):
        shutil.move(expected_output, output_path)

    return output_path


def markdown_to_docx(md_path, output_path="output.docx"):
    """Convert Markdown to DOCX."""
    import pypandoc

    pypandoc.convert_file(md_path, "docx", outputfile=output_path)


def markdown_to_docx_with_template(md_path, template_docx, output_path="output.docx"):
    """Convert Markdown to DOCX using a reference document for styles."""
    import pypandoc

    pypandoc.convert_file(
        md_path,
        "docx",
        outputfile=output_path,
        extra_args=["--reference-doc", template_docx],
    )


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Document format conversion utilities")
    parser.add_argument(
        "command", choices=["docx-to-pdf", "doc-to-docx", "md-to-docx", "pdf-to-images"]
    )
    parser.add_argument("input", help="Input file path")
    parser.add_argument("-o", "--output", help="Output file/directory path")
    parser.add_argument("--template", help="Reference DOCX template for md-to-docx")
    parser.add_argument("--dpi", type=int, default=200, help="DPI for pdf-to-images")
    args = parser.parse_args()

    if args.command == "docx-to-pdf":
        docx_to_pdf_libreoffice(args.input, args.output or ".")
    elif args.command == "doc-to-docx":
        doc_to_docx(args.input, args.output)
    elif args.command == "md-to-docx":
        if args.template:
            markdown_to_docx_with_template(
                args.input, args.template, args.output or "output.docx"
            )
        else:
            markdown_to_docx(args.input, args.output or "output.docx")
    elif args.command == "pdf-to-images":
        pdf_to_images(args.input, args.output or "images", args.dpi)
