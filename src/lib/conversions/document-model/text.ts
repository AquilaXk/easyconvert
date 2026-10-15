import { markerText } from './counters';
import type { Block, DocumentModel, Inline, ListBlock, NoteDefinition, TableBlock } from './model';
import { cellBlocks } from './support';

/**
 * Plain text of a document: blocks separated by blank lines, list items on their own lines with their markers, table
 * rows on one line with the cells separated by a tab, then the footnotes and endnotes with their marks.
 */

const CELL_SEPARATOR = '\t';
const INDENT = '  ';
const LINE_BREAK_AND_SPACE = /\s*\n\s*/g;

export function inlineText(runs: Inline[]): string {
  return runs.map((run) => run.text).join('');
}

/** The marker one item of `list` shows, and the counters the list keeps as it goes. */
export function listMarkers(list: ListBlock): string[] {
  const counters = new Map<number, number>();
  return list.items.map((item) => {
    const format = list.levels[item.level];
    // The counter shown is the one the source showed when it was a number, else counted from the list's first item.
    const next = (counters.get(item.level) ?? item.value - 1) + 1;
    for (const key of [...counters.keys()]) if (key > item.level) counters.delete(key);
    counters.set(item.level, format.kind === 'bullet' ? 0 : next);
    return item.marker ?? markerText(format.kind, format.kind === 'bullet' ? 0 : next, format.punctuation, format.glyph);
  });
}

function listText(list: ListBlock): string {
  const markers = listMarkers(list);
  return list.items.map((item, index) => `${INDENT.repeat(item.level)}${markers[index]} ${inlineText(item.runs)}`).join('\n');
}

/** The text of a table cell on one line. */
export function cellText(cell: TableBlock['rows'][number][number]): string {
  return cellBlocks(cell)
    .map(blockText)
    .filter((text) => text !== '')
    .join(' ')
    .replace(LINE_BREAK_AND_SPACE, ' ');
}

function tableText(table: TableBlock): string {
  return table.rows.map((row) => row.filter((cell) => !cell.continuation).map(cellText).join(CELL_SEPARATOR)).join('\n');
}

export function blockText(block: Block): string {
  switch (block.type) {
    case 'paragraph':
      return inlineText(block.runs);
    case 'heading':
      return block.label ? `${block.label} ${inlineText(block.runs)}` : inlineText(block.runs);
    case 'list':
      return listText(block);
    case 'table':
      return tableText(block);
    case 'code':
      return block.text;
    case 'quote':
      return block.blocks
        .map(blockText)
        .filter((text) => text.trim() !== '')
        .join('\n\n');
    default:
      return '';
  }
}

function noteText(note: NoteDefinition): string {
  return `${note.label} ${note.blocks
    .map(blockText)
    .filter((text) => text !== '')
    .join(' ')}`;
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
  for (const note of [...(model.footnotes ?? []), ...(model.endnotes ?? [])]) parts.push(noteText(note));
  return parts.join('\n\n');
}
