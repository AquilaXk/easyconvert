import type { DocxBlockElement, DocxParagraph } from './office';
import { BodySink, DocumentContext, assembleDocument } from './document-model/build';
import type { DocumentModel, Inline } from './document-model/model';

/** A block of the body of a document read by the drawing-aware reader: a run of text, or a table as its rows of cell text. */
type DocxBodyBlock = { kind: 'text'; text: string } | { kind: 'table'; rows: string[][] };

/**
 * The blocks of the body of a document read by the drawing-aware reader, in document order: a paragraph, a table, a chart
 * as its title and values, a shape as its text. Blocks with no text are left out.
 */
function docxBodyBlocks(paragraphs: DocxParagraph[], elements: DocxBlockElement[]): DocxBodyBlock[] {
  if (elements.length === 0) return paragraphs.map((p) => ({ kind: 'text' as const, text: p.text })).filter((block) => block.text !== '');
  const blocks: DocxBodyBlock[] = [];
  for (const el of elements) {
    if (el.type === 'paragraph') blocks.push({ kind: 'text', text: el.paragraph.text });
    else if (el.type === 'table') blocks.push({ kind: 'table', rows: el.table.rows });
    else if (el.chart) {
      blocks.push({ kind: 'text', text: `[Chart: ${el.chart.title || el.chart.type}] ${el.chart.categories.join(' ')} ${el.chart.series.map((s) => s.values.join(' ')).join(' ')}` });
    } else {
      blocks.push({ kind: 'text', text: (el.shapes || []).map((s) => s.text).filter(Boolean).join(' ') });
    }
  }
  return blocks.filter((block) => (block.kind === 'text' ? block.text !== '' : block.rows.length > 0));
}

const tableText = (rows: string[][]): string => rows.map((r) => r.join('\t')).join('\n');

/**
 * The text of the body of a document read by the drawing-aware reader, as the text export of a word processor gives it
 * (LibreOffice's filter, sw/source/filter/ascii): blocks in document order separated by a blank line, a table row on one
 * line with its cells separated by a tab, a chart as its title and values, a shape as its text. Paragraphs alone would
 * leave out the cells of tables.
 */
export function docxBodyText(paragraphs: DocxParagraph[], elements: DocxBlockElement[]): string {
  return docxBodyBlocks(paragraphs, elements)
    .map((block) => (block.kind === 'text' ? block.text : tableText(block.rows)))
    .filter(Boolean)
    .join('\n\n');
}

const plainRun = (text: string): Inline => ({ text, bold: false, italic: false, monospace: false });

/** The blocks of `docxBodyText` as a document model, tables kept as tables, for the model-based writers. */
export function docxBodyModel(paragraphs: DocxParagraph[], elements: DocxBlockElement[]): DocumentModel {
  const context = new DocumentContext();
  const sink = new BodySink(context);
  for (const block of docxBodyBlocks(paragraphs, elements)) {
    if (block.kind === 'text') {
      sink.paragraph([plainRun(block.text)]);
      continue;
    }
    const cellOf = (text: string) => {
      const cellSink = sink.nested();
      cellSink.paragraph([plainRun(text)]);
      return { blocks: cellSink.blocks, colSpan: 1, rowSpan: 1, header: false };
    };
    sink.table({ rows: block.rows.map((row) => row.map(cellOf)), columnCount: Math.max(...block.rows.map((row) => row.length)) });
  }
  return assembleDocument({ sections: sink.sections(1), context });
}
