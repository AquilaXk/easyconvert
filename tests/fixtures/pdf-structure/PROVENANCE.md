# PDF structure corpus

24 documents plus one merged-cell table, rendered by LibreOffice 24.2 (`soffice --convert-to pdf`) from sources written for
this repository by `scripts/generate-pdf-structure-fixtures.ts` (seeded generator, original words, no third-party text;
released under the repository licence). The sources are in `sources/`; `<name>.truth.json` lists what each document was
written from (headings with their level, paragraphs, bullet and numbered lists, tables, images, the number of columns),
never read back from a PDF.

| Documents | Source | Content |
|---|---|---|
| `doc-01` to `doc-18` | HTML, Liberation Sans 11 pt | one column: h1, h2 and sometimes h3 headings, paragraphs, bullet and numbered lists, and tables; every third document has a table without ruling lines, the others have ruled tables (`border="1"`); `doc-04` and `doc-13` carry a 240 x 140 JPEG (`photo-4.jpg`, `photo-13.jpg`, written by the generator with sharp) |
| `doc-19` to `doc-24` | flat OpenDocument XML | a one-column title above a two-column section of headings and paragraphs |
| `merged-table` | HTML | a ruled table with a column span and a row span |

LibreOffice re-encodes the JPEGs when it writes the PDF, so the byte-identity check compares the DOCX with the stream inside
the PDF (extracted with `pdfimages -j`), not with the source file.

Regenerate with `npx tsx scripts/generate-pdf-structure-fixtures.ts`.

Readers and references: `tests/helpers/docx-structure.ts` (an independent DOCX reader), `tests/helpers/teds.ts` (table
edit-distance similarity), LibreOffice's own PDF import to DOCX (`soffice --infilter=writer_pdf_import`, in `bench/`) and
a LibreOffice DOCX to PDF round trip read with `pdftotext -raw`.
