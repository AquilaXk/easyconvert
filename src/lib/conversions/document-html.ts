import {
  escapeXmlAttribute,
  escapeXmlText,
  stripXmlForbidden,
  type DocBlock,
  type DocImage,
  type DocInline,
  type DocModel,
  type DocNote,
  type DocTableCell,
  type DocTextInline,
} from './document-model';

/**
 * Writes the block model as well-formed XHTML (also valid HTML5): headings, paragraphs, nested ordered and
 * unordered lists with their start values, tables with merged cells, links, images, and footnotes and endnotes as
 * back-linked lists. The same fragments serve the HTML target and the EPUB content documents.
 */

const PX_PER_POINT = 4 / 3;
/** Value of `type` on `<ol>` for the numbering formats HTML can show natively. */
const ORDERED_LIST_TYPES: ReadonlyMap<string, string> = new Map([
  ['lowerLetter', 'a'],
  ['upperLetter', 'A'],
  ['lowerRoman', 'i'],
  ['upperRoman', 'I'],
]);
const FIRST_LIST_NUMBER = 1;

export interface HtmlRenderOptions {
  /** `src` for an image; defaults to a data: URI holding the original bytes. */
  imageSource?: (image: DocImage) => string;
  /** Rewrites an in-document link target (`#name`), for packages whose content spans several files. */
  anchorHref?: (anchor: string) => string;
  /** Gives every heading an `id` of this prefix and its running number, so a table of contents can link to it. */
  headingIdPrefix?: string;
  /** Prefix of the ids and links of notes, to keep several documents of one package apart. */
  noteIdPrefix?: string;
}

export function dataUri(image: DocImage): string {
  return `data:${image.mime};base64,${image.data.toString('base64')}`;
}

class HtmlWriter {
  headingCount = 0;

  constructor(private readonly options: HtmlRenderOptions) {}

  private imageSource(image: DocImage): string {
    return (this.options.imageSource ?? dataUri)(image);
  }

  private href(target: string): string {
    if (target.startsWith('#') && this.options.anchorHref) return this.options.anchorHref(target.slice(1));
    return target;
  }

  private noteId(kind: string, id: string): string {
    return `${this.options.noteIdPrefix ?? ''}${kind}-${id}`;
  }

  textInline(inline: DocTextInline): string {
    let html = escapeXmlText(stripXmlForbidden(inline.text));
    if (inline.code) html = `<code>${html}</code>`;
    if (inline.bold) html = `<strong>${html}</strong>`;
    if (inline.italic) html = `<em>${html}</em>`;
    if (inline.underline) html = `<u>${html}</u>`;
    if (inline.strike) html = `<del>${html}</del>`;
    if (inline.superscript) html = `<sup>${html}</sup>`;
    if (inline.subscript) html = `<sub>${html}</sub>`;
    const styles: string[] = [];
    if (inline.color) styles.push(`color:#${inline.color}`);
    if (inline.sizePt) styles.push(`font-size:${inline.sizePt}pt`);
    if (styles.length > 0) html = `<span style="${styles.join(';')}">${html}</span>`;
    return html;
  }

  inlines(inlines: readonly DocInline[]): string {
    let html = '';
    let openHref: string | undefined;
    const closeLink = (): void => {
      if (openHref !== undefined) html += '</a>';
      openHref = undefined;
    };
    for (const inline of inlines) {
      if (inline.kind === 'text' && inline.href !== undefined) {
        if (openHref !== inline.href) {
          closeLink();
          html += `<a href="${escapeXmlAttribute(this.href(inline.href))}">`;
          openHref = inline.href;
        }
        html += this.textInline(inline);
        continue;
      }
      closeLink();
      switch (inline.kind) {
        case 'text':
          html += this.textInline(inline);
          break;
        case 'break':
          html += '<br/>';
          break;
        case 'image': {
          const { image } = inline;
          const size =
            image.widthPt && image.heightPt
              ? ` width="${Math.round(image.widthPt * PX_PER_POINT)}" height="${Math.round(image.heightPt * PX_PER_POINT)}"`
              : '';
          html += `<img src="${escapeXmlAttribute(this.imageSource(image))}" alt="${escapeXmlAttribute(image.alt)}"${size}/>`;
          break;
        }
        case 'noteRef': {
          const id = this.noteId(inline.noteKind, String(inline.id));
          html += `<sup><a id="${id}-ref" href="#${id}" epub:type="noteref">${escapeXmlText(inline.label)}</a></sup>`;
          break;
        }
        case 'anchor':
          html += `<a id="${escapeXmlAttribute(inline.name)}"></a>`;
          break;
      }
    }
    closeLink();
    return html;
  }

  private cell(cell: DocTableCell): string {
    const tag = cell.header ? 'th' : 'td';
    const attributes =
      (cell.colSpan > 1 ? ` colspan="${cell.colSpan}"` : '') +
      (cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : '') +
      (cell.shading ? ` style="background-color:#${cell.shading}"` : '');
    const only = cell.blocks.length === 1 ? cell.blocks[0] : undefined;
    const inner = only && only.kind === 'paragraph' ? this.inlines(only.inlines) : this.blocks(cell.blocks);
    return `<${tag}${attributes}>${inner}</${tag}>`;
  }

  private table(block: Extract<DocBlock, { kind: 'table' }>): string {
    const headerRows = block.rows.filter((row) => row.header);
    const bodyRows = block.rows.filter((row) => !row.header);
    const renderRows = (rows: typeof block.rows): string => rows.map((row) => `<tr>${row.cells.map((cell) => this.cell(cell)).join('')}</tr>`).join('\n');
    // Header rows lead the table; a header row after body rows stays where it is.
    const leading = block.rows.findIndex((row) => !row.header);
    const headerIsLeading = headerRows.length > 0 && (leading === -1 || block.rows.slice(leading).every((row) => !row.header));
    if (headerIsLeading) {
      const thead = `<thead>\n${renderRows(headerRows)}\n</thead>\n`;
      const tbody = bodyRows.length > 0 ? `<tbody>\n${renderRows(bodyRows)}\n</tbody>\n` : '';
      return `<table>\n${thead}${tbody}</table>`;
    }
    return `<table>\n<tbody>\n${renderRows(block.rows)}\n</tbody>\n</table>`;
  }

  /** Renders `blocks`; consecutive list items become nested lists. */
  blocks(blocks: readonly DocBlock[]): string {
    const parts: string[] = [];
    let index = 0;
    while (index < blocks.length) {
      const block = blocks[index];
      if (block.kind === 'listItem') {
        let end = index;
        while (end < blocks.length && blocks[end].kind === 'listItem') end += 1;
        parts.push(this.list(blocks.slice(index, end) as Extract<DocBlock, { kind: 'listItem' }>[]));
        index = end;
        continue;
      }
      parts.push(this.block(block));
      index += 1;
    }
    return parts.filter((part) => part !== '').join('\n');
  }

  private list(items: readonly Extract<DocBlock, { kind: 'listItem' }>[]): string {
    interface Open {
      ordered: boolean;
      listId: number;
      itemOpen: boolean;
    }
    const stack: Open[] = [];
    let html = '';
    const closeList = (): void => {
      const top = stack.pop() as Open;
      html += `${top.itemOpen ? '</li>' : ''}</${top.ordered ? 'ol' : 'ul'}>`;
    };
    for (const item of items) {
      // A list nests at most one level below the open one.
      const level = Math.min(item.level, stack.length);
      while (stack.length > level + 1) closeList();
      const same = stack.length === level + 1 && stack[level].ordered === item.ordered && stack[level].listId === item.listId;
      if (stack.length === level + 1 && !same) closeList();
      if (stack.length === level + 1) {
        html += stack[level].itemOpen ? '</li>' : '';
        stack[level].itemOpen = false;
      } else {
        const type = ORDERED_LIST_TYPES.get(item.format);
        const attributes = item.ordered
          ? (item.number !== FIRST_LIST_NUMBER ? ` start="${item.number}"` : '') + (type ? ` type="${type}"` : '')
          : '';
        html += `<${item.ordered ? 'ol' : 'ul'}${attributes}>`;
        stack.push({ ordered: item.ordered, listId: item.listId, itemOpen: false });
      }
      html += `<li>${this.inlines(item.inlines)}`;
      stack[stack.length - 1].itemOpen = true;
    }
    while (stack.length > 0) closeList();
    return html;
  }

  block(block: DocBlock): string {
    switch (block.kind) {
      case 'heading': {
        this.headingCount += 1;
        const level = Math.min(Math.max(block.level, 1), 6);
        const id = this.options.headingIdPrefix === undefined ? '' : ` id="${this.options.headingIdPrefix}${this.headingCount}"`;
        return `<h${level}${id}>${this.inlines(block.inlines)}</h${level}>`;
      }
      case 'paragraph': {
        const style = block.align && block.align !== 'left' ? ` style="text-align:${block.align}"` : '';
        return `<p${style}>${this.inlines(block.inlines)}</p>`;
      }
      case 'listItem':
        return this.list([block]);
      case 'table':
        return this.table(block);
      case 'code':
        return `<pre>${escapeXmlText(stripXmlForbidden(block.text))}</pre>`;
      case 'quote':
        return `<blockquote>${this.blocks(block.blocks)}</blockquote>`;
      case 'rule':
        return '<hr/>';
      case 'pageBreak':
        return '<div class="page-break" style="break-after:page"></div>';
      case 'sectionBreak':
        return '';
    }
  }

  notes(kind: 'footnote' | 'endnote', notes: readonly DocNote[]): string {
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
export function renderModelBodyHtml(model: DocModel, options: HtmlRenderOptions = {}): string {
  const writer = new HtmlWriter(options);
  return [writer.blocks(model.blocks), writer.notes('footnote', model.footnotes), writer.notes('endnote', model.endnotes)]
    .filter((part) => part !== '')
    .join('\n');
}

/** Renders `blocks` alone, with no notes (a chapter of a longer book). */
export function renderBlocksHtml(blocks: readonly DocBlock[], options: HtmlRenderOptions = {}, headingOffset = 0): string {
  const writer = new HtmlWriter(options);
  writer.headingCount = headingOffset;
  return writer.blocks(blocks);
}

export function renderNotesHtml(kind: 'footnote' | 'endnote', notes: readonly DocNote[], options: HtmlRenderOptions = {}): string {
  return new HtmlWriter(options).notes(kind, notes);
}

const HTML_STYLE =
  'body{font-family:system-ui,-apple-system,sans-serif;line-height:1.6;max-width:850px;margin:2rem auto;padding:0 1.5rem}' +
  'table{border-collapse:collapse;margin:1rem 0}th,td{border:1px solid #bbb;padding:4px 8px;vertical-align:top}' +
  'img{max-width:100%;height:auto}.footnotes,.endnotes{font-size:.9em;border-top:1px solid #bbb;margin-top:2rem}';

/** A complete HTML document for `model`. The title is document metadata, not an added heading. */
export function renderModelHtml(model: DocModel, title: string): string {
  const language = model.language ? ` lang="${escapeXmlAttribute(model.language)}"` : '';
  const body = renderModelBodyHtml(model);
  const documentTitle = model.title ?? title;
  return (
    `<!DOCTYPE html>\n<html${language} xmlns:epub="http://www.idpf.org/2007/ops"><head><meta charset="utf-8"/>` +
    `<title>${escapeXmlText(stripXmlForbidden(documentTitle))}</title><style>${HTML_STYLE}</style></head>\n<body>\n${body}\n</body></html>\n`
  );
}
