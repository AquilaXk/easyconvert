import { escapeXmlText } from './xml-text';
import type { Block, DocumentImage, DocumentModel, Inline, ListBlock, NoteDefinition, TableBlock, TableCellBlock } from './model';
import { IMAGE_MIME, bodyBlocks, cellBlocks, imagesById } from './support';

/**
 * HTML of the document with its structure: `h1` to `h6`, `p`, nested `ul`/`ol` with their start values and types,
 * `table` with `colspan` and `rowspan` (`thead` for header rows), links, pictures (data URIs holding the original bytes
 * unless the caller places them elsewhere), footnotes and endnotes as back-linked lists, and `dir="rtl"` for
 * right-to-left paragraphs. Text is escaped with the XML rules, so the page is also well-formed XML apart from void
 * elements, and the same fragments serve the HTML target and the content documents of an EPUB.
 */

const RTL_ATTRIBUTE = ' dir="rtl"';
const PX_PER_POINT = 4 / 3;
const OL_TYPES: Record<string, string> = { decimal: '1', lowerLetter: 'a', upperLetter: 'A', lowerRoman: 'i', upperRoman: 'I' };
const FIRST_LIST_NUMBER = 1;

export interface HtmlRenderOptions {
  /** `src` for a picture; defaults to a data: URI holding the original bytes. */
  imageSource?: (image: DocumentImage) => string;
  /** Rewrites an in-document link target (`#name`) for packages whose content spans several files; undefined drops the link. */
  anchorHref?: (anchor: string) => string | undefined;
  /** Gives every heading an `id` of this prefix and its running number, so a table of contents can link to it. */
  headingIdPrefix?: string;
  /** Prefix of the ids and links of notes, to keep several documents of one package apart. */
  noteIdPrefix?: string;
}

export function dataUri(image: DocumentImage): string {
  return `data:${IMAGE_MIME[image.format]};base64,${Buffer.from(image.data).toString('base64')}`;
}

function attribute(value: string): string {
  return escapeXmlText(value);
}

export class HtmlWriter {
  headingCount = 0;

  constructor(
    private readonly images: ReadonlyMap<number, DocumentImage>,
    private readonly options: HtmlRenderOptions = {}
  ) {}

  private imageSource(image: DocumentImage): string {
    return (this.options.imageSource ?? dataUri)(image);
  }

  private href(target: string): string | undefined {
    if (target.startsWith('#') && this.options.anchorHref) return this.options.anchorHref(target.slice(1));
    return target;
  }

  private noteId(kind: string, id: string): string {
    return `${this.options.noteIdPrefix ?? ''}${kind}-${id}`;
  }

  private textRun(run: Inline): string {
    let html = escapeXmlText(run.text).replace(/\n/g, '<br/>');
    if (run.monospace) html = `<code>${html}</code>`;
    if (run.italic) html = `<em>${html}</em>`;
    if (run.bold) html = `<strong>${html}</strong>`;
    if (run.underline) html = `<u>${html}</u>`;
    if (run.strike) html = `<del>${html}</del>`;
    if (run.superscript) html = `<sup>${html}</sup>`;
    if (run.subscript) html = `<sub>${html}</sub>`;
    const styles: string[] = [];
    if (run.color) styles.push(`color:#${run.color}`);
    if (run.sizePt) styles.push(`font-size:${run.sizePt}pt`);
    if (styles.length > 0) html = `<span style="${styles.join(';')}">${html}</span>`;
    return html;
  }

  private objectRun(run: Inline): string {
    if (run.image) {
      const image = this.images.get(run.image.imageId);
      if (!image) return '';
      const { widthPt, heightPt } = run.image;
      const size = widthPt && heightPt ? ` width="${Math.round(widthPt * PX_PER_POINT)}" height="${Math.round(heightPt * PX_PER_POINT)}"` : '';
      return `<img src="${attribute(this.imageSource(image))}" alt="${attribute(run.image.alt)}"${size}/>`;
    }
    if (run.note) {
      const id = this.noteId(run.note.kind, String(run.note.id));
      return `<sup><a id="${id}-ref" href="#${id}" epub:type="noteref">${escapeXmlText(run.note.label)}</a></sup>`;
    }
    if (run.anchor !== undefined) return `<a id="${attribute(run.anchor)}"></a>`;
    return '';
  }

  inlines(runs: readonly Inline[]): string {
    let html = '';
    let openHref: string | undefined;
    const closeLink = (): void => {
      if (openHref !== undefined) html += '</a>';
      openHref = undefined;
    };
    for (const run of runs) {
      const isObject = run.image !== undefined || run.note !== undefined || run.anchor !== undefined;
      const target = !isObject && run.href !== undefined ? this.href(run.href) : undefined;
      if (target !== undefined) {
        if (openHref !== target) {
          closeLink();
          html += `<a href="${attribute(target)}">`;
          openHref = target;
        }
        html += this.textRun(run);
        continue;
      }
      closeLink();
      html += isObject ? this.objectRun(run) : this.textRun(run);
    }
    closeLink();
    return html;
  }

  private cell(cell: TableCellBlock, header: boolean): string {
    const tag = header ? 'th' : 'td';
    const attributes =
      (cell.colSpan > 1 ? ` colspan="${cell.colSpan}"` : '') +
      (cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : '') +
      (cell.shading ? ` style="background-color:#${cell.shading}"` : '');
    const content = cellBlocks(cell);
    const onlyParagraphs = content.every((block) => block.type === 'paragraph');
    // A line feed after each break keeps the paragraphs apart for readers that take only the text.
    const inner = onlyParagraphs ? content.map((block) => this.inlines((block as { runs: Inline[] }).runs)).join('<br/>\n') : this.blocks(content);
    return `<${tag}${attributes}>${inner}</${tag}>`;
  }

  private table(table: TableBlock): string {
    const border = table.bordered ? ' border="1"' : '';
    const headerRows = table.rows.findIndex((row) => !row.some((cell) => cell.header));
    const headerCount = headerRows < 0 ? table.rows.length : headerRows;
    const rowHtml = (row: TableCellBlock[], header: boolean): string => {
      const cells = row
        .filter((cell) => !cell.continuation)
        .map((cell) => this.cell(cell, header))
        .join('');
      return `<tr>${cells}</tr>`;
    };
    const head = headerCount > 0 ? `<thead>${table.rows.slice(0, headerCount).map((row) => rowHtml(row, true)).join('')}</thead>` : '';
    const body = `<tbody>${table.rows.slice(headerCount).map((row) => rowHtml(row, false)).join('')}</tbody>`;
    return `<table${border}>${head}${body}</table>`;
  }

  private listOpening(list: ListBlock, level: number, startAt: number | null): { open: string; close: string } {
    const format = list.levels[level];
    if (format.kind === 'bullet') return { open: '<ul>', close: '</ul>' };
    const start = startAt !== null && startAt > FIRST_LIST_NUMBER ? ` start="${startAt}"` : '';
    return { open: `<ol type="${OL_TYPES[format.kind]}"${start}>`, close: '</ol>' };
  }

  /** Nested lists from the flat items: a deeper item opens a list inside the open item, a shallower one closes lists. */
  private list(list: ListBlock): string {
    let html = '';
    const closers: string[] = [];
    for (const item of list.items) {
      while (closers.length > item.level + 1) html += `</li>${closers.pop()}`;
      if (closers.length === item.level + 1) html += '</li>';
      while (closers.length < item.level + 1) {
        const opening = this.listOpening(list, closers.length, closers.length === item.level ? item.value : null);
        html += opening.open;
        closers.push(opening.close);
        if (closers.length < item.level + 1) html += '<li>';
      }
      html += `<li${item.rtl ? RTL_ATTRIBUTE : ''}>${this.inlines(item.runs)}`;
    }
    while (closers.length > 0) html += `</li>${closers.pop()}`;
    return html;
  }

  blocks(blocks: readonly Block[]): string {
    return blocks
      .map((block) => this.block(block))
      .filter((html) => html !== '')
      .join('\n');
  }

  block(block: Block): string {
    switch (block.type) {
      case 'heading': {
        this.headingCount += 1;
        const id = this.options.headingIdPrefix === undefined ? '' : ` id="${this.options.headingIdPrefix}${this.headingCount}"`;
        return `<h${block.level}${id}${block.rtl ? RTL_ATTRIBUTE : ''}>${this.inlines(block.runs)}</h${block.level}>`;
      }
      case 'paragraph': {
        const align = block.align !== 'left' ? ` style="text-align:${block.align}"` : '';
        return `<p${block.rtl ? RTL_ATTRIBUTE : ''}${align}>${this.inlines(block.runs)}</p>`;
      }
      case 'list':
        return this.list(block);
      case 'table':
        return this.table(block);
      case 'image': {
        const image = this.images.get(block.imageId);
        if (!image) return '';
        return `<p><img src="${attribute(this.imageSource(image))}" width="${Math.round(block.widthPt)}" height="${Math.round(block.heightPt)}" alt="${attribute(block.alt ?? '')}"/></p>`;
      }
      case 'code':
        return `<pre>${escapeXmlText(block.text)}</pre>`;
      case 'quote':
        return `<blockquote>${this.blocks(block.blocks)}</blockquote>`;
      case 'rule':
        return '<hr/>';
      case 'pageBreak':
        return '<div class="page-break" style="break-after:page"></div>';
    }
  }

  notes(kind: 'footnote' | 'endnote', notes: readonly NoteDefinition[]): string {
    if (notes.length === 0) return '';
    const items = notes
      .map((note) => {
        const id = this.noteId(kind, String(note.id));
        const body = this.blocks(note.blocks);
        const back = `<a href="#${id}-ref" epub:type="backlink">↩</a>`;
        const merged = body.endsWith('</p>') ? `${body.slice(0, -'</p>'.length)} ${back}</p>` : `${body}<p>${back}</p>`;
        return `<li id="${id}" epub:type="${kind}">${merged}</li>`;
      })
      .join('\n');
    return `<aside epub:type="${kind}s" class="${kind}s"><ol>\n${items}\n</ol></aside>`;
  }
}

/** The body markup of `model`: every block, then the footnotes and endnotes. */
export function documentBodyHtml(model: DocumentModel, options: HtmlRenderOptions = {}): string {
  const writer = new HtmlWriter(imagesById(model), options);
  return [writer.blocks(bodyBlocks(model)), writer.notes('footnote', model.footnotes ?? []), writer.notes('endnote', model.endnotes ?? [])]
    .filter((part) => part !== '')
    .join('\n');
}

const STYLE =
  'body{font-family:system-ui,-apple-system,sans-serif;line-height:1.6;padding:2rem;max-width:800px;margin:0 auto}' +
  'table{border-collapse:collapse;margin:0 0 1rem}td,th{padding:4px 8px;vertical-align:top}th{text-align:left}img{max-width:100%;height:auto}' +
  '.footnotes,.endnotes{font-size:.9em;border-top:1px solid #bbb;margin-top:2rem}';

/** A complete HTML page. `title` is escaped; a title the document states takes its place. */
export function documentToHtml(model: DocumentModel, title: string): string {
  const writer = new HtmlWriter(imagesById(model));
  const body = bodyBlocks(model)
    .map((block) => writer.block(block))
    .filter((html) => html !== '');
  const furniture = (tag: 'header' | 'footer', lines: Inline[][] | undefined): string[] =>
    lines && lines.length > 0 ? [`<${tag}>${lines.map((runs) => `<p>${writer.inlines(runs)}</p>`).join('')}</${tag}>`] : [];
  body.unshift(...furniture('header', model.pageHeader));
  const notes = [writer.notes('footnote', model.footnotes ?? []), writer.notes('endnote', model.endnotes ?? [])].filter((part) => part !== '');
  body.push(...notes);
  body.push(...furniture('footer', model.pageFooter));
  const language = model.language ? ` lang="${attribute(model.language)}"` : '';
  return `<!DOCTYPE html><html${language} xmlns:epub="http://www.idpf.org/2007/ops"><head><meta charset="utf-8"><title>${escapeXmlText(model.title ?? title)}</title><style>${STYLE}</style></head><body>${body.join('\n')}</body></html>`;
}
