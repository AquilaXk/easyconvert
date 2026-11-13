# PDF colour corpus

Five one-page documents with coloured text, filled and ruled areas and vector shapes, written for this repository by
`scripts/generate-pdf-colour-fixtures.ts` (original text, released under the repository licence). The sources are in `sources/`.
Three PDFs come from LibreOffice 24.2 (`soffice --convert-to pdf`), one from its drawing module and one from Cairo
(`rsvg-convert -f pdf`, librsvg), so the corpus has two PDF producers with different ways of writing rectangles and paths.

| Document | Source | What it holds |
|---|---|---|
| `colour-text` | HTML | headings and words in red, blue, green, orange, purple and raspberry; white on charcoal, black on yellow and white on blue runs (a fill behind the text); grey small print |
| `colour-table` | HTML | a table ruled in dark blue with a shaded header row (white text) and alternate shaded rows, red and green numbers; a second table with three shaded cells and no rules |
| `colour-boxes` | HTML | a dark band with white text, a bordered and shaded call-out, a shaded paragraph with a thick orange left bar, ruled paragraphs |
| `shapes-chart` | flat OpenDocument drawing | a title band, four filled bars (one with an outline), grid lines and axes, a triangle and an ellipse with fill and outline, labels in two colours |
| `diagram` | SVG | a title band, three labelled boxes in three colours joined by lines, a stepped red polyline with an arrow head, a green curve with end points, a note swatch |

The words and the colours are those written in the sources. Nothing here is read back from a PDF: `bench/pdf-colour-metrics.py`
reads the source PDF and the converted document printed to PDF with the same reader and compares them (see `bench/README.md`).

Regenerate with `npx tsx scripts/generate-pdf-colour-fixtures.ts` (needs LibreOffice and `rsvg-convert`).
