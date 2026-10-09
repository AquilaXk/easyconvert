import { markerText } from './counters';
import type { Block, DocumentModel, Inline, ListBlock, TableBlock } from './model';

/**
 * Plain text of a document: blocks separated by blank lines, list items on their own lines with their markers, table
 * rows on one line with the cells separated by a tab.
 */

const CELL_SEPARATOR = '\t';
const INDENT = '  ';

export function inlineText(runs: Inline[]): string {
  return runs.map((run) => run.text).join('');
}

function listText(list: ListBlock): string {
  const counters = new Map<number, number>();
  const lines: string[] = [];
  for (const item of list.items) {
    const format = list.levels[item.level];
    // The counter shown is the one the PDF showed when it was a number, else counted from the list's first item.
    const next = (counters.get(item.level) ?? item.value - 1) + 1;
    for (const key of [...counters.keys()]) if (key > item.level) counters.delete(key);
    counters.set(item.level, format.kind === 'bullet' ? 0 : next);
    const marker = markerText(format.kind, format.kind === 'bullet' ? 0 : next, format.punctuation, format.glyph);
    lines.push(`${INDENT.repeat(item.level)}${marker} ${inlineText(item.runs)}`);
  }
  return lines.join('\n');
}

function tableText(table: TableBlock): string {
  return table.rows
    .map((row) =>
      row
        .filter((cell) => !cell.continuation)
        .map((cell) => cell.paragraphs.map((paragraph) => inlineText(paragraph.runs)).join(' '))
        .join(CELL_SEPARATOR)
    )
    .join('\n');
}

export function blockText(block: Block): string {
  switch (block.type) {
    case 'paragraph':
    case 'heading':
      return inlineText(block.runs);
    case 'list':
      return listText(block);
    case 'table':
      return tableText(block);
    default:
      return '';
  }
}

export function documentToText(model: DocumentModel): string {
  const furniture = (lines: Inline[][] | undefined): string[] => (lines ?? []).map((runs) => inlineText(runs)).filter((text) => text.trim() !== '');
  const parts: string[] = [...furniture(model.pageHeader)];
  for (const section of model.sections) {
    for (const block of section.blocks) {
      const text = blockText(block);
      if (text.trim() !== '') parts.push(text);
    }
  }
  parts.push(...furniture(model.pageFooter));
  return parts.join('\n\n');
}
