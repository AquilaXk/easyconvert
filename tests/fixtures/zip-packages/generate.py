"""Writes the ZIP packages of tests/zip-package-sniffing.test.ts with Python's zipfile and the Info-ZIP `zip` tool, so that
no byte of a fixture comes from this repository's own ZIP encoder.

Run from this directory: python3 -I generate.py
"""
import io
import os
import subprocess
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
# Text that names the main-part folders of the other packages. Level 0 deflate keeps it as literal bytes in the file.
OFFICE_FOLDERS = "word/document.xml xl/workbook.xml ppt/presentation.xml [Content_Types].xml " * 40
CONTAINER = '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="c.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'


class Unseekable(io.RawIOBase):
    """A write-only stream: zipfile then writes sizes after the data, in a data descriptor (APPNOTE 4.3.9)."""

    def __init__(self):
        self.parts = []

    def writable(self):
        return True

    def write(self, data):
        self.parts.append(bytes(data))
        return len(data)


def write_zip(name, entries, unseekable=False):
    """entries: (name, content, compression, level) in order."""
    target = Unseekable() if unseekable else io.BytesIO()
    with zipfile.ZipFile(target, "w") as archive:
        for entry_name, content, compression, level in entries:
            archive.writestr(zipfile.ZipInfo(entry_name, (2026, 1, 1, 0, 0, 0)), content, compress_type=compression, compresslevel=level)
    data = b"".join(target.parts) if unseekable else target.getvalue()
    with open(os.path.join(HERE, name), "wb") as out:
        out.write(data)


STORED = zipfile.ZIP_STORED
LITERAL = zipfile.ZIP_DEFLATED


def odf(name, media_type):
    write_zip(name, [
        ("mimetype", media_type, STORED, None),
        ("content.xml", "<office:document-content>" + OFFICE_FOLDERS + "</office:document-content>", LITERAL, 0),
        ("META-INF/manifest.xml", "<manifest:manifest/>", LITERAL, 6),
    ])


write_zip("epub-chapter-names-office-folders.epub", [
    ("mimetype", "application/epub+zip", STORED, None),
    ("META-INF/container.xml", CONTAINER, LITERAL, 0),
    ("chapter1.xhtml", "<html><body><p>" + OFFICE_FOLDERS + "</p></body></html>", LITERAL, 0),
])
odf("odt-content-names-office-folders.odt", "application/vnd.oasis.opendocument.text")
odf("ods-content-names-office-folders.ods", "application/vnd.oasis.opendocument.spreadsheet")
odf("odp-content-names-office-folders.odp", "application/vnd.oasis.opendocument.presentation")
odf("ott-content-names-office-folders.ott", "application/vnd.oasis.opendocument.text-template")
odf("odg-content-names-office-folders.odg", "application/vnd.oasis.opendocument.graphics")

write_zip("docx-content-types-not-first.docx", [
    ("docProps/core.xml", "<cp:coreProperties/>", LITERAL, 6),
    ("customXml/item1.xml", "<x/>", LITERAL, 6),
    ("[Content_Types].xml", "<Types/>", LITERAL, 6),
    ("_rels/.rels", "<Relationships/>", LITERAL, 6),
    ("word/document.xml", "<w:document/>", LITERAL, 6),
])
write_zip("xlsx-names-only.xlsx", [
    ("[Content_Types].xml", "<Types/>", LITERAL, 6),
    ("_rels/.rels", "<Relationships/>", LITERAL, 6),
    ("xl/workbook.xml", "<workbook/>", LITERAL, 6),
])
write_zip("pptx-names-only.pptx", [
    ("[Content_Types].xml", "<Types/>", LITERAL, 6),
    ("_rels/.rels", "<Relationships/>", LITERAL, 6),
    ("ppt/presentation.xml", "<p:presentation/>", LITERAL, 6),
])
write_zip("plain-text-names-office-folders.zip", [
    ("readme.txt", OFFICE_FOLDERS, LITERAL, 0),
    ("data.csv", "a,b\n1,2\n", LITERAL, 6),
])

# Sizes follow the data in a data descriptor (general purpose bit 3), so the local header holds zeros.
write_zip("epub-data-descriptor.epub", [
    ("mimetype", "application/epub+zip", STORED, None),
    ("META-INF/container.xml", CONTAINER, LITERAL, 6),
    ("chapter1.xhtml", "<html><body><p>" + OFFICE_FOLDERS + "</p></body></html>", LITERAL, 0),
], unseekable=True)
write_zip("docx-data-descriptor.docx", [
    ("[Content_Types].xml", "<Types/>", LITERAL, 6),
    ("_rels/.rels", "<Relationships/>", LITERAL, 6),
    ("word/document.xml", "<w:document/>", LITERAL, 6),
], unseekable=True)

# Info-ZIP: with -X no extra fields are written, without it every entry carries the extended timestamp field.
with tempfile.TemporaryDirectory() as work:
    os.makedirs(os.path.join(work, "META-INF"))
    for rel, content in (("mimetype", "application/epub+zip"), ("META-INF/container.xml", CONTAINER), ("chapter1.xhtml", "<html><body><p>" + OFFICE_FOLDERS + "</p></body></html>")):
        with open(os.path.join(work, rel), "w") as handle:
            handle.write(content)
    for name, flags in (("epub-info-zip.epub", "-X"), ("epub-info-zip-extra-fields.epub", "")):
        out = os.path.join(HERE, name)
        if os.path.exists(out):
            os.remove(out)
        # The media type is the first entry, stored; the rest is compressed (the layout the container specification asks for).
        subprocess.run(["zip", "-q", "-0"] + ([flags] if flags else []) + [out, "mimetype"], cwd=work, check=True)
        subprocess.run(["zip", "-q", "-9", "-r"] + ([flags] if flags else []) + [out, "META-INF", "chapter1.xhtml"], cwd=work, check=True)
