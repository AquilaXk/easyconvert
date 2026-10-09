import { escapeXmlText } from './xml-text';
import type { Block, DocumentModel, Inline, ListBlock, TableBlock } from './model';

/**
 * HTML of the document with its structure: `h1` to `h4`, `p`, nested `ul`/`ol`, `table` with `colspan` and `rowspan`
 * (`thead` for header rows), images embedded as data URIs so the page is one file, and `dir="rtl"` for right-to-left
 * paragraphs. Text is escaped with the XML rules, so the page is also well-formed XML apart from void elements.
 */

const RTL_ATTRIBUTE = ' dir="rtl"';

function inlineHtml(runs: Inline[]): string {
  return runs
    .map((run) => {
      let html = escapeXmlText(run.text);
      if (run.monospace) html = `<code>${html}</code>`;
      if (run.italic) html = `<em>${html}</em>`;
      if (run.bold) html = `<strong>${html}</strong>`;
      return html;
    })
    .join('');
}

const OL_TYPES: Record<string, string> = { decimal: '1', lowerLetter: 'a', upperLetter: 'A', lowerRoman: 'i', upperRoman: 'I' };

function listOpening(list: ListBlock, level: number, startAt: number | null): { open: string; close: string } {
  const format = list.levels[level];
  if (format.kind === 'bullet') return { open: '<ul>', close: '</ul>' };
  const start = startAt !== null && startAt > 1 ? ` start="${startAt}"` : '';
  return { open: `<ol type="${OL_TYPES[format.kind]}"${start}>`, close: '</ol>' };
}

/** Nested lists from the flat items: a deeper item opens a list inside the open item, a shallower one closes lists. */
function listHtml(list: ListBlock): string {
  let html = '';
  const closers: string[] = [];
  for (const item of list.items) {
    while (closers.length > item.level + 1) html += `</li>${closers.pop()}`;
    if (closers.length === item.level + 1) html += '</li>';
    while (closers.length < item.level + 1) {
      const opening = listOpening(list, closers.length, closers.length === item.level ? item.value : null);
      html += opening.open;
      closers.push(opening.close);
      if (closers.length < item.level + 1) html += '<li>';
    }
    html += `<li${item.rtl ? RTL_ATTRIBUTE : ''}>${inlineHtml(item.runs)}`;
  }
  while (closers.length > 0) html += `</li>${closers.pop()}`;
  return html;
}

function tableHtml(table: TableBlock): string {
  const border = table.bordered ? ' border="1"' : '';
  const headerRows = table.rows.findIndex((row) => !row.some((cell) => cell.header));
  const headerCount = headerRows < 0 ? table.rows.length : headerRows;
  const rowHtml = (row: TableBlock['rows'][number], header: boolean): string => {
    const cells = row
      .filter((cell) => !cell.continuation)
      .map((cell) => {
        const tag = header ? 'th' : 'td';
        const span = `${cell.colSpan > 1 ? ` colspan="${cell.colSpan}"` : ''}${cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : ''}`;
        const content = cell.paragraphs.map((paragraph) => inlineHtml(paragraph.runs)).join('<br/>');
        return `<${tag}${span}>${content}</${tag}>`;
      })
      .join('');
    return `<tr>${cells}</tr>`;
  };
  const head = headerCount > 0 ? `<thead>${table.rows.slice(0, headerCount).map((row) => rowHtml(row, true)).join('')}</thead>` : '';
  const body = `<tbody>${table.rows.slice(headerCount).map((row) => rowHtml(row, false)).join('')}</tbody>`;
  return `<table${border}>${head}${body}</table>`;
}

function imageHtml(model: DocumentModel, block: Extract<Block, { type: 'image' }>): string {
  const image = model.images.find((candidate) => candidate.id === block.imageId);
  if (!image) return '';
  const mime = image.format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const data = Buffer.from(image.data).toString('base64');
  return `<p><img src="data:${mime};base64,${data}" width="${Math.round(block.widthPt)}" height="${Math.round(block.heightPt)}" alt=""/></p>`;
}

function blockHtml(model: DocumentModel, block: Block): string {
  switch (block.type) {
    case 'heading':
      return `<h${block.level}${block.rtl ? RTL_ATTRIBUTE : ''}>${inlineHtml(block.runs)}</h${block.level}>`;
    case 'paragraph':
      return `<p${block.rtl ? RTL_ATTRIBUTE : ''}>${inlineHtml(block.runs)}</p>`;
    case 'list':
      return listHtml(block);
    case 'table':
      return tableHtml(block);
    case 'image':
      return imageHtml(model, block);
    default:
      return '';
  }
}

const STYLE =
  'body{font-family:system-ui,-apple-system,sans-serif;line-height:1.6;padding:2rem;max-width:800px;margin:0 auto}' +
  'table{border-collapse:collapse;margin:0 0 1rem}td,th{padding:4px 8px;vertical-align:top}th{text-align:left}img{max-width:100%;height:auto}';

/** A complete HTML page. `title` is escaped. */
export function documentToHtml(model: DocumentModel, title: string): string {
  const body = model.sections.flatMap((section) => section.blocks.map((block) => blockHtml(model, block))).filter((html) => html !== '');
  const furniture = (tag: 'header' | 'footer', lines: Inline[][] | undefined): string[] =>
    lines && lines.length > 0 ? [`<${tag}>${lines.map((runs) => `<p>${inlineHtml(runs)}</p>`).join('')}</${tag}>`] : [];
  body.unshift(...furniture('header', model.pageHeader));
  body.push(...furniture('footer', model.pageFooter));
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeXmlText(title)}</title><style>${STYLE}</style></head><body>${body.join('\n')}</body></html>`;
}
