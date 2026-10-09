import { markerText } from './counters';
import type { Block, DocumentModel, Inline, ListBlock, TableBlock } from './model';
import { inlineText } from './text';

/**
 * Markdown (CommonMark) and the lighter "structured text" the other office writers read: headings as `#` lines, list
 * items with their markers and tables as pipe rows. Markdown escapes what CommonMark would otherwise read as markup;
 * the structured text does not, because its readers show text as it is.
 */

const MARKDOWN_SPECIAL = /([\\`*_[\]<>|])/g;
const LINE_START_MARKUP = /^(\s*)([#+\-]|\d+[.)])(\s|$)/;
const LIST_INDENT = '  ';
const MONO_FENCE = '`';

function escapeMarkdown(text: string): string {
  return text.replace(MARKDOWN_SPECIAL, '\\$1').replace(LINE_START_MARKUP, '$1\\$2$3');
}

function inlineMarkdown(runs: Inline[]): string {
  return runs
    .map((run) => {
      if (run.text.trim() === '') return run.text;
      const lead = run.text.match(/^\s*/)?.[0] ?? '';
      const trail = run.text.match(/\s*$/)?.[0] ?? '';
      const core = run.text.trim();
      let text = run.monospace ? `${MONO_FENCE}${core.replace(/`/g, '\\`')}${MONO_FENCE}` : escapeMarkdown(core);
      if (run.bold && run.italic) text = `***${text}***`;
      else if (run.bold) text = `**${text}**`;
      else if (run.italic) text = `*${text}*`;
      return `${lead}${text}${trail}`;
    })
    .join('');
}

function listMarkdown(list: ListBlock, markdown: boolean): string {
  const counters = new Map<number, number>();
  return list.items
    .map((item) => {
      const format = list.levels[item.level];
      const next = (counters.get(item.level) ?? item.value - 1) + 1;
      for (const key of [...counters.keys()]) if (key > item.level) counters.delete(key);
      counters.set(item.level, format.kind === 'bullet' ? 0 : next);
      // CommonMark knows "-" bullets and "1." counters; other counter styles are kept as text after a bullet.
      let marker = '-';
      if (format.kind === 'decimal') marker = `${next}.`;
      else if (format.kind !== 'bullet') marker = `- ${markerText(format.kind, next, format.punctuation, format.glyph)}`;
      const body = markdown ? inlineMarkdown(item.runs) : inlineText(item.runs);
      return `${LIST_INDENT.repeat(item.level)}${marker} ${body}`;
    })
    .join('\n');
}

/** Cell text on one line; Markdown text already escaped its pipes, plain text still needs them escaped. */
function cellMarkdown(runsText: string, markdown: boolean): string {
  const oneLine = runsText.replace(/\n/g, ' ');
  return markdown ? oneLine : oneLine.replace(/\|/g, '\\|');
}

function tableMarkdown(table: TableBlock, markdown: boolean): string {
  const columns = table.columnWidths.length;
  const rows = table.rows.map((row) => {
    const cells: string[] = [];
    for (const cell of row) {
      if (cell.continuation) {
        cells.push('');
      } else {
        const text = cell.paragraphs.map((paragraph) => (markdown ? inlineMarkdown(paragraph.runs) : inlineText(paragraph.runs))).join(' ');
        cells.push(cellMarkdown(text, markdown));
      }
      for (let i = 1; i < cell.colSpan; i++) cells.push('');
    }
    while (cells.length < columns) cells.push('');
    return `| ${cells.join(' | ')} |`;
  });
  if (rows.length === 0) return '';
  const separator = `| ${Array.from({ length: columns }, () => '---').join(' | ')} |`;
  return [rows[0], separator, ...rows.slice(1)].join('\n');
}

function blockMarkdown(block: Block, markdown: boolean): string {
  switch (block.type) {
    case 'heading': {
      const text = markdown ? inlineMarkdown(block.runs) : inlineText(block.runs);
      return `${'#'.repeat(block.level)} ${text.trim()}`;
    }
    case 'paragraph':
      return markdown ? inlineMarkdown(block.runs) : inlineText(block.runs);
    case 'list':
      return listMarkdown(block, markdown);
    case 'table':
      return tableMarkdown(block, markdown);
    default:
      return '';
  }
}

function render(model: DocumentModel, markdown: boolean): string {
  const parts: string[] = [];
  for (const section of model.sections) {
    for (const block of section.blocks) {
      const text = blockMarkdown(block, markdown);
      if (text.trim() !== '') parts.push(text);
    }
  }
  return parts.join('\n\n');
}

/** CommonMark of the document. */
export function documentToMarkdown(model: DocumentModel): string {
  return render(model, true);
}

/** The line-oriented text the Office, ebook and slide writers read: headings, list lines and pipe tables. */
export function documentToStructuredText(model: DocumentModel): string {
  return render(model, false);
}
