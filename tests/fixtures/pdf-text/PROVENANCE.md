# PDF text golden set

Every PDF here is rendered by LibreOffice 24.2 (`soffice --convert-to pdf`) from a source written for this repository by
`scripts/generate-pdf-text-fixtures.ts` (original prose, no third-party text; released under the repository licence).
The sources are in `sources/` (HTML, or flat OpenDocument XML where columns, soft hyphens or vertical writing are needed).
`<name>.truth.txt` is the expected text, written from the same strings in the generator, never read back from a PDF.
The PDFs embed their fonts (Noto Sans CJK, Noto Naskh Arabic, Noto Sans Hebrew, DejaVu Serif), so tests need none of them.

| Fixture | Source | What it exercises |
|---|---|---|
| `latin` | `latin.html` | a heading, the word "ET", ligature glyphs mapped by ToUnicode to several letters, `8:30`, `12.5%`, curly quotes |
| `cjk` | `cjk.html` | Korean, Japanese and Chinese paragraphs (Identity-H fonts); a break after a Hangul word takes a space, a break inside Han and kana does not |
| `rtl` | `rtl.html` | Arabic and Hebrew paragraphs, and an Arabic sentence with a number and a Latin word; the text layer is in visual order |
| `two-column` | `two-column.fodt` | 40 numbered paragraphs in two section columns over two pages |
| `hyphenated` | `hyphenated.fodt` | narrow justified columns with soft hyphens, so words are broken with a hyphen at line ends |
| `multipage` | `multipage.html` | three pages in order |
| `vertical` | `vertical.fodt` | Japanese vertical writing (one glyph per run, lines from right to left) |
| `cjk-unmapped` | derived from `cjk.pdf` | the `/ToUnicode` entries removed with `qpdf --qdf` and `fix-qdf`: glyphs without a Unicode mapping |
| `latin-unmapped` | derived from `latin.pdf` | the same for Latin text, so the OCR path can recognize the page |

Regenerate with `npx tsx scripts/generate-pdf-text-fixtures.ts` (LibreOffice and the fonts must be installed); the two
`-unmapped` files are derived by hand from the generated `cjk.pdf` and `latin.pdf`:

```
qpdf --qdf --object-streams=disable cjk.pdf cjk.qdf
sed '/\/ToUnicode/d' cjk.qdf > cjk-stripped.qdf
fix-qdf cjk-stripped.qdf > cjk-fixed.qdf && qpdf cjk-fixed.qdf cjk-unmapped.pdf
```

Independent readers: Poppler `pdftotext -raw` (`tests/pdf-text-content-extraction.test.ts`) and the sources' own text.
