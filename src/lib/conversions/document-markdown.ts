import { dataUri } from './document-html';
import {
  blockText,
  expandTableGrid,
  inlinesToText,
  stripXmlForbidden,
  type DocBlock,
  type DocInline,
  type DocModel,
  type DocNote,
  type DocTextInline,
} from './document-model';

/**
 * Writes the block model as CommonMark with GitHub-style tables, strikethrough and footnotes: ATX headings, nested
 * lists, pipe tables (a merged cell leaves its covered positions empty), links, images as data: URIs holding the
 * original bytes, and footnote definitions after the body.
 */

const LIST_INDENT = '    ';
const MARKDOWN_SPECIALS = /([\\`*_[\]<>|])/g;
const LEADING_BLOCK_MARKER = /^(\s*)(#{1,6}\s|[-+]\s|\d+[.)]\s|>)/;
const HEADING_MARKER = '#';
const TABLE_CELL_SEPARATOR = ' <br> ';
const LIST_SEPARATOR_COMMENT = '<!-- -->';

function escapeText(text: string): string {
  return stripXmlForbidden(text).replace(MARKDOWN_SPECIALS, '\\$1');
}

/** Moves the whitespace at the ends of `text` outside emphasis delimiters, which CommonMark requires. */
function delimit(text: string, marker: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text) as RegExpExecArray;
  return match[2] === '' ? text : `${match[1]}${marker}${match[2]}${marker}${match[3]}`;
}

function inlineText(inline: DocTextInline): string {
  if (inline.code) {
    const body = stripXmlForbidden(inline.text);
    const fence = body.includes('`') ? '``' : '`';
    return body.trim() === '' ? body : `${fence}${body.trim()}${fence}`;
  }
  let out = escapeText(inline.text);
  if (inline.strike) out = delimit(out, '~~');
  if (inline.italic) out = delimit(out, '*');
  if (inline.bold) out = delimit(out, '**');
  return out;
}

function renderInlines(inlines: readonly DocInline[]): string {
  let out = '';
  let index = 0;
  while (index < inlines.length) {
    const inline = inlines[index];
    if (inline.kind === 'text' && inline.href !== undefined) {
      const href = inline.href;
      let label = '';
      while (index < inlines.length) {
        const next = inlines[index];
        if (next.kind !== 'text' || next.href !== href) break;
        label += inlineText(next);
        index += 1;
      }
      const target = href.replace(/[()\s]/g, (character) => encodeURIComponent(character));
      out += label.trim() === '' ? label : `[${label}](${target})`;
      continue;
    }
    switch (inline.kind) {
      case 'text':
        out += inlineText(inline);
        break;
      case 'break':
        out += '  \n';
        break;
      case 'image':
        out += `![${escapeText(inline.image.alt)}](${dataUri(inline.image)})`;
        break;
      case 'noteRef':
        out += `[^${inline.noteKind === 'footnote' ? '' : 'e'}${inline.id}]`;
        break;
      case 'anchor':
        break;
    }
    index += 1;
  }
  return out;
}

/** A paragraph's text with a leading character that would start another block escaped. */
function paragraphText(inlines: readonly DocInline[]): string {
  const text = renderInlines(inlines);
  return text.replace(LEADING_BLOCK_MARKER, (_match, space: string, marker: string) => `${space}${marker.replace(/^(\d+)([.)])/, '$1\\$2').replace(/^([#>+-])/, '\\$1')}`);
}

function renderTable(block: Extract<DocBlock, { kind: 'table' }>): string {
  const grid = expandTableGrid(block);
  if (grid.length === 0 || block.columnCount === 0) return '';
  const lines = grid.map((row) => {
    const cells = row.map((cell) => (cell ? cell.blocks.map(blockText).filter((text) => text !== '').map((text) => escapeText(text).replace(/\n/g, ' ')).join(TABLE_CELL_SEPARATOR) : ''));
    return `| ${cells.join(' | ')} |`;
  });
  const separator = `| ${Array.from({ length: block.columnCount }, () => '---').join(' | ')} |`;
  return [lines[0], separator, ...lines.slice(1)].join('\n');
}

function renderBlocks(blocks: readonly DocBlock[]): string {
  const parts: string[] = [];
  let previousList: number | undefined;
  for (const block of blocks) {
    if (block.kind === 'listItem') {
      const body = renderInlines(block.inlines);
      const marker = block.ordered ? `${block.number}.` : '-';
      const line = `${LIST_INDENT.repeat(block.level)}${marker} ${body}`;
      const separate = previousList !== undefined && previousList !== block.listId && block.level === 0;
      const last = parts[parts.length - 1];
      if (last !== undefined && last.startsWith('\u0000list') && !separate) parts[parts.length - 1] = `${last}\n${line}`;
      else parts.push(`\u0000list${separate ? `\n${LIST_SEPARATOR_COMMENT}\n\n` : ''}${line}`);
      previousList = block.listId;
      continue;
    }
    previousList = undefined;
    switch (block.kind) {
      case 'heading':
        parts.push(`${HEADING_MARKER.repeat(Math.min(block.level, 6))} ${renderInlines(block.inlines).replace(/\s*\n\s*/g, ' ')}`);
        break;
      case 'paragraph': {
        const text = paragraphText(block.inlines);
        if (text.trim() !== '') parts.push(text);
        break;
      }
      case 'table': {
        const table = renderTable(block);
        if (table !== '') parts.push(table);
        break;
      }
      case 'code':
        parts.push(`\`\`\`\n${stripXmlForbidden(block.text)}\n\`\`\``);
        break;
      case 'quote':
        parts.push(
          renderBlocks(block.blocks)
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n')
        );
        break;
      case 'rule':
        parts.push('---');
        break;
      default:
        break;
    }
  }
  return parts.map((part) => part.replace(/^\u0000list/, '')).join('\n\n');
}

function renderNotes(notes: readonly DocNote[], prefix: string): string[] {
  return notes.map((note) => {
    const text = note.blocks
      .map((block) => (block.kind === 'paragraph' ? paragraphText(block.inlines) : blockText(block)))
      .filter((paragraph) => paragraph !== '')
      .join('\n\n    ');
    return `[^${prefix}${note.id}]: ${text}`;
  });
}

export function renderModelMarkdown(model: DocModel): string {
  const body = renderBlocks(model.blocks);
  const notes = [...renderNotes(model.footnotes, ''), ...renderNotes(model.endnotes, 'e')];
  return [body, notes.join('\n\n')].filter((part) => part !== '').join('\n\n') + '\n';
}

/** Plain text of the model: blocks separated by blank lines, list markers as the document shows them, tables tab separated. */
export function renderModelText(model: DocModel): string {
  const lines: string[] = [];
  const addBlocks = (blocks: readonly DocBlock[]): void => {
    for (const block of blocks) {
      switch (block.kind) {
        case 'heading': {
          const text = inlinesToText(block.inlines);
          lines.push(block.label ? `${block.label} ${text}` : text);
          break;
        }
        case 'paragraph':
          lines.push(inlinesToText(block.inlines));
          break;
        case 'listItem':
          lines.push(`${'  '.repeat(block.level)}${block.marker} ${inlinesToText(block.inlines)}`.trimEnd());
          break;
        case 'table':
          lines.push(
            expandTableGrid(block)
              .map((row) => row.map((cell) => (cell ? cell.blocks.map(blockText).filter((text) => text !== '').join(' ').replace(/\s*\n\s*/g, ' ') : '')).join('\t'))
              .join('\n')
          );
          break;
        case 'code':
          lines.push(block.text);
          break;
        case 'quote':
          addBlocks(block.blocks);
          break;
        default:
          break;
      }
    }
  };
  addBlocks(model.blocks);
  for (const note of [...model.footnotes, ...model.endnotes]) {
    lines.push(`${note.label} ${note.blocks.map(blockText).filter((text) => text !== '').join(' ')}`);
  }
  return lines.filter((line) => line.trim() !== '').join('\n\n');
}
