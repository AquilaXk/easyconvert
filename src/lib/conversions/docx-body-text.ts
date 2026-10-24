import type { DocxBlockElement, DocxParagraph } from './office';

/**
 * The text of the body of a document read by the drawing-aware reader, as the text export of a word processor gives it
 * (LibreOffice's filter, sw/source/filter/ascii): blocks in document order separated by a blank line, a table row on one
 * line with its cells separated by a tab, a chart as its title and values, a shape as its text. Paragraphs alone would
 * leave out the cells of tables.
 */
export function docxBodyText(paragraphs: DocxParagraph[], elements: DocxBlockElement[]): string {
  if (elements.length === 0) return paragraphs.map((p) => p.text).join('\n\n');
  return elements
    .map((el) => {
      if (el.type === 'paragraph') return el.paragraph.text;
      if (el.type === 'table') return el.table.rows.map((r) => r.join('\t')).join('\n');
      if (el.type === 'drawing') {
        if (el.chart) {
          return `[Chart: ${el.chart.title || el.chart.type}] ${el.chart.categories.join(' ')} ${el.chart.series.map((s) => s.values.join(' ')).join(' ')}`;
        }
        return (el.shapes || []).map((s) => s.text).filter(Boolean).join(' ');
      }
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}
