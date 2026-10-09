import { markerText } from './counters';
import type { Block, DocumentImage, DocumentModel, Inline, ListBlock, NoteDefinition, TableBlock } from './model';
import { IMAGE_MIME, cellBlocks, imagesById } from './support';
import { inlineText } from './text';

/**
 * Markdown (CommonMark with GitHub-style tables, strikethrough and footnotes) and the lighter "structured text" the
 * other office writers read: headings as `#` lines, list items with their markers and tables as pipe rows. Markdown
 * escapes what CommonMark would otherwise read as markup and keeps links, emphasis, pictures (as data: URIs holding
 * the original bytes) and notes; the structured text does not, because its readers show text as it is.
 */

const MARKDOWN_SPECIAL = /([\\`*_[\]<>|])/g;
const LINE_START_MARKUP = /^(\s*)([#+\-]|\d+[.)])(\s|$)/;
const LEADING_BLOCK_MARKER = /^(\s*)(#{1,6}\s|[-+]\s|\d+[.)]\s|>)/;
const NEWLINE = /\n/g;
const HARD_BREAK = '  \n';
/** Width of a bullet marker with its space, and of a marker whose width the list does not give. */
const DEFAULT_MARKER_WIDTH = 2;
const MONO_FENCE = '`';
const LIST_SEPARATOR_COMMENT = '<!-- -->';
const CELL_SEPARATOR_REPLACEMENT = ' ';
const HEADING_MARKER = '#';
const MAX_MARKDOWN_HEADING = 6;

function escapeMarkdown(text: string): string {
  return text.replace(MARKDOWN_SPECIAL, '\\$1').replace(LINE_START_MARKUP, '$1\\$2$3');
}

interface Renderer {
  markdown: boolean;
  images: ReadonlyMap<number, DocumentImage>;
}

function dataUri(image: DocumentImage): string {
  return `data:${IMAGE_MIME[image.format]};base64,${Buffer.from(image.data).toString('base64')}`;
}

function textMarkdown(run: Inline): string {
  if (run.text.trim() === '') return run.text.replace(NEWLINE, HARD_BREAK);
  // Linear in the run: an anchored \s*$ pattern would retry from every position of a long run without spaces.
  const lead = run.text.slice(0, run.text.length - run.text.trimStart().length);
  const trail = run.text.slice(run.text.trimEnd().length);
  const core = run.text.trim();
  let text = run.monospace ? `${MONO_FENCE}${core.replace(/`/g, '\\`')}${MONO_FENCE}` : escapeMarkdown(core).replace(NEWLINE, HARD_BREAK);
  if (run.strike) text = `~~${text}~~`;
  if (run.bold && run.italic) text = `***${text}***`;
  else if (run.bold) text = `**${text}**`;
  else if (run.italic) text = `*${text}*`;
  return `${lead}${text}${trail}`.replace(NEWLINE, HARD_BREAK);
}

function linkTarget(href: string): string {
  return href.replace(/[()\s]/g, (character) => encodeURIComponent(character));
}

function inlineMarkdown(runs: Inline[], renderer: Renderer): string {
  if (!renderer.markdown) return inlineText(runs);
  let out = '';
  let index = 0;
  while (index < runs.length) {
    const run = runs[index];
    if (run.href !== undefined && run.image === undefined && run.note === undefined && run.anchor === undefined) {
      const { href } = run;
      let label = '';
      while (index < runs.length && runs[index].href === href && runs[index].image === undefined) {
        label += textMarkdown(runs[index]);
        index += 1;
      }
      out += label.trim() === '' ? label : `[${label}](${linkTarget(href)})`;
      continue;
    }
    index += 1;
    if (run.image) {
      const image = renderer.images.get(run.image.imageId);
      if (image) out += `![${escapeMarkdown(run.image.alt)}](${dataUri(image)})`;
    } else if (run.note) {
      out += `[^${run.note.kind === 'footnote' ? '' : 'e'}${run.note.id}]`;
    } else if (run.anchor === undefined) {
      out += textMarkdown(run);
    }
  }
  return out;
}

/** The rows of a list item at `level`, indented so a nested list sits inside its parent's content (CommonMark 5.2). */
function listMarkdown(list: ListBlock, renderer: Renderer): string {
  const counters = new Map<number, number>();
  const widths: number[] = [];
  return list.items
    .map((item) => {
      const format = list.levels[item.level];
      const next = (counters.get(item.level) ?? item.value - 1) + 1;
      for (const key of [...counters.keys()]) if (key > item.level) counters.delete(key);
      counters.set(item.level, format.kind === 'bullet' ? 0 : next);
      // CommonMark knows "-" bullets and "1." counters; other counter styles are kept as text after a bullet.
      let marker = '-';
      if (format.kind === 'decimal') marker = `${next}.`;
      else if (format.kind !== 'bullet') marker = `- ${item.marker ?? markerText(format.kind, next, format.punctuation, format.glyph)}`;
      widths.length = item.level + 1;
      widths[item.level] = `${format.kind === 'decimal' ? marker : '-'} `.length;
      let indent = 0;
      for (let level = 0; level < item.level; level += 1) indent += widths[level] ?? DEFAULT_MARKER_WIDTH;
      return `${' '.repeat(indent)}${marker} ${inlineMarkdown(item.runs, renderer)}`;
    })
    .join('\n');
}

/** Cell text on one line; Markdown text already escaped its pipes, plain text still needs them escaped. */
function cellMarkdown(cell: TableBlock['rows'][number][number], renderer: Renderer): string {
  const text = cellBlocks(cell)
    .map((block) => (block.type === 'paragraph' || block.type === 'heading' ? inlineMarkdown(block.runs, renderer) : blockMarkdown(block, renderer)))
    .filter((part) => part !== '')
    .join(CELL_SEPARATOR_REPLACEMENT);
  const oneLine = text.replace(/\s*\n\s*/g, ' ');
  return renderer.markdown ? oneLine : oneLine.replace(/\|/g, '\\|');
}

function tableMarkdown(table: TableBlock, renderer: Renderer): string {
  const columns = table.columnWidths.length;
  const rows = table.rows.map((row) => {
    const cells: string[] = [];
    for (const cell of row) {
      cells.push(cell.continuation ? '' : cellMarkdown(cell, renderer));
      for (let i = 1; i < cell.colSpan; i++) cells.push('');
    }
    while (cells.length < columns) cells.push('');
    return `| ${cells.join(' | ')} |`;
  });
  if (rows.length === 0) return '';
  const separator = `| ${Array.from({ length: columns }, () => '---').join(' | ')} |`;
  return [rows[0], separator, ...rows.slice(1)].join('\n');
}

/** A paragraph's text with a leading character that would start another block escaped. */
function paragraphMarkdown(runs: Inline[], renderer: Renderer): string {
  const text = inlineMarkdown(runs, renderer);
  if (!renderer.markdown) return text;
  return text.replace(LEADING_BLOCK_MARKER, (_match, space: string, marker: string) => `${space}${marker.replace(/^(\d+)([.)])/, '$1\\$2').replace(/^([#>+-])/, '\\$1')}`);
}

function blockMarkdown(block: Block, renderer: Renderer): string {
  switch (block.type) {
    case 'heading': {
      const text = inlineMarkdown(block.runs, renderer);
      return `${HEADING_MARKER.repeat(Math.min(block.level, MAX_MARKDOWN_HEADING))} ${text.replace(/\s*\n\s*/g, ' ').trim()}`;
    }
    case 'paragraph':
      return paragraphMarkdown(block.runs, renderer);
    case 'list':
      return listMarkdown(block, renderer);
    case 'table':
      return tableMarkdown(block, renderer);
    case 'code':
      return renderer.markdown ? `\`\`\`\n${block.text}\n\`\`\`` : block.text;
    case 'quote':
      return blocksMarkdown(block.blocks, renderer)
        .split('\n')
        .map((line) => (renderer.markdown ? `> ${line}` : line))
        .join('\n');
    case 'rule':
      return renderer.markdown ? '---' : '';
    case 'image': {
      const image = renderer.images.get(block.imageId);
      return renderer.markdown && image ? `![${escapeMarkdown(block.alt ?? '')}](${dataUri(image)})` : '';
    }
    default:
      return '';
  }
}

function blocksMarkdown(blocks: readonly Block[], renderer: Renderer): string {
  const parts: string[] = [];
  let previousWasList = false;
  for (const block of blocks) {
    const text = blockMarkdown(block, renderer);
    if (text.trim() === '') continue;
    // Two lists in a row would read as one loose list without a comment between them.
    if (renderer.markdown && block.type === 'list' && previousWasList) parts.push(LIST_SEPARATOR_COMMENT);
    parts.push(text);
    previousWasList = block.type === 'list';
  }
  return parts.join('\n\n');
}

/** Running header or footer lines: italic in Markdown, plain in the structured text. */
function furnitureMarkdown(lines: Inline[][] | undefined, renderer: Renderer): string[] {
  if (!lines) return [];
  return lines
    .map((runs) => (renderer.markdown ? inlineMarkdown(runs.map((run) => ({ ...run, italic: true })), renderer) : inlineText(runs)))
    .filter((text) => text.trim() !== '');
}

function notesMarkdown(notes: readonly NoteDefinition[], prefix: string, renderer: Renderer): string[] {
  return notes.map((note) => {
    const text = note.blocks
      .map((block) => blockMarkdown(block, renderer))
      .filter((paragraph) => paragraph !== '')
      .join('\n\n    ');
    return `[^${prefix}${note.id}]: ${text}`;
  });
}

function render(model: DocumentModel, markdown: boolean): string {
  const renderer: Renderer = { markdown, images: imagesById(model) };
  const parts: string[] = [...furnitureMarkdown(model.pageHeader, renderer)];
  const body = blocksMarkdown(
    model.sections.flatMap((section) => section.blocks),
    renderer
  );
  if (body !== '') parts.push(body);
  parts.push(...furnitureMarkdown(model.pageFooter, renderer));
  if (markdown) parts.push(...notesMarkdown(model.footnotes ?? [], '', renderer), ...notesMarkdown(model.endnotes ?? [], 'e', renderer));
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
