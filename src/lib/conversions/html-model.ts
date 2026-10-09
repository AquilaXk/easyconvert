import { PayloadLimitError } from '../types';
import { assertEmbeddableImageWithinLimit } from './image-input-limits';
import { parseHtmlTree, type HtmlElement, type HtmlNode } from './html-blocks';
import { formatListNumber } from './docx-numbering';
import { BlockSink, DocumentContext, assembleDocument, listFormatOf, type TableDraftCell } from './document-model/build';
import { MAX_LIST_LEVELS, type DocumentModel, type Inline } from './document-model/model';
import { anchorRun, imageRun, isTextRun, safeHref, sameRunFormat, sniffImageFormat, textRun } from './document-model/support';

/**
 * Reads HTML and XHTML (an HTML file, rendered Markdown, an EPUB content document) into the document model: headings,
 * paragraphs, nested lists with numbering and start values, tables with merged cells, preformatted text, quotes,
 * links, images (data: URIs and package resources the caller resolves) and character formatting.
 */

/** Most blocks one document may produce. */
export const HTML_MODEL_MAX_BLOCKS = 2_000_000;
/** Deepest table-in-table nesting kept as tables; deeper ones are flattened to text. */
export const HTML_MODEL_MAX_TABLE_DEPTH = 16;
/** Most images one document may carry and the most bytes they may hold together. */
export const HTML_MODEL_MAX_IMAGES = 2000;
export const HTML_MODEL_MAX_IMAGE_BYTES = 256 * 1024 * 1024;
const MAX_COLUMN_SPAN = 1000;
const MAX_ROW_SPAN = 65_534;
const PT_PER_PX = 0.75;
const BULLETS: readonly string[] = ['•', '◦', '▪'];
const DEFAULT_LIST_START = 1;

const HEADING_LEVELS: ReadonlyMap<string, number> = new Map([['h1', 1], ['h2', 2], ['h3', 3], ['h4', 4], ['h5', 5], ['h6', 6]]);
const SKIPPED: ReadonlySet<string> = new Set(['head', 'script', 'style', 'template', 'noscript', 'title', 'meta', 'link', 'base']);
const DROPPED_WITH_WARNING: ReadonlySet<string> = new Set(['svg', 'math', 'object', 'embed', 'iframe', 'video', 'audio', 'canvas']);
const CONTAINERS: ReadonlySet<string> = new Set([
  'html', 'body', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'nav', 'figure', 'form', 'fieldset', 'center',
  'details', 'dl', 'dd', 'dt', 'hgroup',
]);
const PARAGRAPHS: ReadonlySet<string> = new Set(['p', 'address', 'figcaption', 'summary', 'legend', 'caption']);
const LISTS: ReadonlySet<string> = new Set(['ul', 'ol', 'menu', 'dir']);
const BOLD: ReadonlySet<string> = new Set(['strong', 'b']);
const ITALIC: ReadonlySet<string> = new Set(['em', 'i', 'cite', 'dfn', 'var']);
const UNDERLINE: ReadonlySet<string> = new Set(['u', 'ins']);
const STRIKE: ReadonlySet<string> = new Set(['s', 'strike', 'del']);
const CODE: ReadonlySet<string> = new Set(['code', 'kbd', 'samp', 'tt']);
const INLINE_BLOCK_BREAKERS: ReadonlySet<string> = new Set([
  ...HEADING_LEVELS.keys(), ...PARAGRAPHS, ...CONTAINERS, ...LISTS, 'table', 'pre', 'blockquote', 'hr', 'li', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot',
]);
const ORDERED_TYPES: ReadonlyMap<string, string> = new Map([['1', 'decimal'], ['a', 'lowerLetter'], ['A', 'upperLetter'], ['i', 'lowerRoman'], ['I', 'upperRoman']]);
const DATA_URI = /^data:([^,]*?)(;base64)?,(.*)$/is;
const COLOR_HEX = /^#([0-9a-f]{6})$/i;
const COLOR_SHORT_HEX = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const COLOR_RGB = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i;
const BYTE_MAX = 255;
const HEX_RADIX = 16;
const DECIMAL_RADIX = 10;

export interface HtmlModelOptions {
  /** Bytes of an image whose `src` is not a data: URI (a resource of the package the HTML came from). */
  resolveImage?: (src: string) => Buffer | undefined;
  /** Maps a link target to the target the model keeps; undefined drops the link. Defaults to `safeHref`. */
  mapLink?: (href: string) => string | undefined;
  /** Registers pictures and warnings in this context, so several documents (the chapters of a book) share one set. */
  context?: DocumentContext;
}

interface Format {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  superscript?: boolean;
  subscript?: boolean;
  href?: string;
  color?: string;
}

interface OpenCell {
  cell: TableDraftCell;
  rowsLeft: number;
}

/** The run style a format stands for. */
function runStyle(format: Format): Partial<Omit<Inline, 'text'>> {
  const style: Partial<Omit<Inline, 'text'>> = {};
  if (format.bold) style.bold = true;
  if (format.italic) style.italic = true;
  if (format.code) style.monospace = true;
  if (format.underline) style.underline = true;
  if (format.strike) style.strike = true;
  if (format.superscript) style.superscript = true;
  if (format.subscript) style.subscript = true;
  if (format.href !== undefined) style.href = format.href;
  if (format.color !== undefined) style.color = format.color;
  return style;
}

function parseColor(value: string): string | undefined {
  const text = value.trim();
  const hex = COLOR_HEX.exec(text);
  if (hex) return hex[1].toUpperCase();
  const short = COLOR_SHORT_HEX.exec(text);
  if (short) return `${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toUpperCase();
  const rgb = COLOR_RGB.exec(text);
  if (!rgb) return undefined;
  const channels = [rgb[1], rgb[2], rgb[3]].map((channel) => Math.min(Number.parseInt(channel, DECIMAL_RADIX), BYTE_MAX));
  return channels.map((channel) => channel.toString(HEX_RADIX).padStart(2, '0')).join('').toUpperCase();
}

function styleProperties(style: string | undefined): Map<string, string> {
  const properties = new Map<string, string>();
  for (const declaration of (style ?? '').split(';')) {
    const colon = declaration.indexOf(':');
    if (colon > 0) properties.set(declaration.slice(0, colon).trim().toLowerCase(), declaration.slice(colon + 1).trim().toLowerCase());
  }
  return properties;
}

function preformattedText(run: Inline): string {
  return isTextRun(run) ? run.text : '';
}

function positiveInt(value: string | undefined, max: number): number {
  const parsed = Number.parseInt(value ?? '', DECIMAL_RADIX);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(parsed, max);
}

/** Merges adjacent runs of one format, collapses spaces across run boundaries and trims the ends of the paragraph. */
function finishInlines(runs: Inline[]): Inline[] {
  const merged: Inline[] = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (isTextRun(run)) {
      let text = run.text;
      const previousText = last && isTextRun(last) ? last.text : '';
      if ((previousText === '' || /\s$/.test(previousText)) && !run.monospace) text = text.replace(/^ +/, '');
      if (text === '') continue;
      if (last && sameRunFormat(last, run)) {
        merged[merged.length - 1] = { ...last, text: last.text + text };
        continue;
      }
      merged.push({ ...run, text });
    } else {
      merged.push(run);
    }
  }
  while (merged.length > 0) {
    const tail = merged[merged.length - 1];
    if (!isTextRun(tail)) break;
    const trimmed = tail.text.replace(/\s+$/, '');
    if (trimmed === '') {
      merged.pop();
    } else {
      merged[merged.length - 1] = { ...tail, text: trimmed };
      break;
    }
  }
  return merged.every((run) => run.anchor !== undefined) ? [] : merged;
}

class HtmlModelBuilder {
  private blockCount = 0;
  private imageCount = 0;
  private imageBytes = 0;
  private listId = 0;
  readonly checks: Buffer[] = [];

  constructor(
    private readonly options: HtmlModelOptions,
    readonly context: DocumentContext
  ) {}

  private get warnings(): string[] {
    return this.context.warnings;
  }

  private countBlock(): void {
    this.blockCount += 1;
    if (this.blockCount > HTML_MODEL_MAX_BLOCKS) throw new PayloadLimitError(`The document holds more than ${HTML_MODEL_MAX_BLOCKS} blocks.`);
  }

  private image(element: HtmlElement): Inline | undefined {
    const src = (element.attrs.get('src') ?? '').trim();
    let data: Buffer | undefined;
    const uri = DATA_URI.exec(src);
    if (uri) {
      if (uri[2] === undefined) {
        this.warnings.push('A data: image that is not base64 was left out.');
        return undefined;
      }
      data = Buffer.from(uri[3].replace(/\s+/g, ''), 'base64');
    } else {
      data = this.options.resolveImage?.(src);
    }
    if (!data || data.length === 0) {
      this.warnings.push(`The image "${src.slice(0, 80)}" could not be loaded and was left out.`);
      return undefined;
    }
    const format = sniffImageFormat(data);
    if (format === null) {
      this.warnings.push(`The image "${src.slice(0, 80)}" is not PNG, JPEG, GIF, BMP, TIFF or SVG and was left out.`);
      return undefined;
    }
    this.imageCount += 1;
    this.imageBytes += data.length;
    if (this.imageCount > HTML_MODEL_MAX_IMAGES) throw new PayloadLimitError(`The document embeds more than ${HTML_MODEL_MAX_IMAGES} images.`);
    if (this.imageBytes > HTML_MODEL_MAX_IMAGE_BYTES) throw new PayloadLimitError(`The document embeds more than ${HTML_MODEL_MAX_IMAGE_BYTES} bytes of images.`);
    this.checks.push(data);
    const width = Number.parseFloat(element.attrs.get('width') ?? '');
    const height = Number.parseFloat(element.attrs.get('height') ?? '');
    const sized = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
    return imageRun({
      imageId: this.context.addImage(data, format),
      alt: element.attrs.get('alt') ?? '',
      widthPt: sized ? width * PT_PER_PX : undefined,
      heightPt: sized ? height * PT_PER_PX : undefined,
    });
  }

  private formatOf(element: HtmlElement, format: Format): Format {
    const next: Format = { ...format };
    const tag = element.tag;
    if (BOLD.has(tag)) next.bold = true;
    if (ITALIC.has(tag)) next.italic = true;
    if (UNDERLINE.has(tag)) next.underline = true;
    if (STRIKE.has(tag)) next.strike = true;
    if (CODE.has(tag)) next.code = true;
    if (tag === 'sup') next.superscript = true;
    if (tag === 'sub') next.subscript = true;
    if (tag === 'a') {
      const target = element.attrs.get('href');
      if (target !== undefined) {
        const mapped = (this.options.mapLink ?? safeHref)(target);
        if (mapped !== undefined) next.href = mapped;
      }
    }
    const style = element.attrs.get('style');
    if (style) {
      const properties = styleProperties(style);
      const weight = properties.get('font-weight');
      if (weight === 'bold' || weight === 'bolder' || (weight !== undefined && Number(weight) >= 600)) next.bold = true;
      if (properties.get('font-style') === 'italic') next.italic = true;
      const decoration = properties.get('text-decoration') ?? properties.get('text-decoration-line') ?? '';
      if (decoration.includes('underline')) next.underline = true;
      if (decoration.includes('line-through')) next.strike = true;
      const color = properties.get('color');
      if (color !== undefined) next.color = parseColor(color) ?? next.color;
    }
    return next;
  }

  /** Inline content of `nodes` with `format` applied. */
  inlines(nodes: readonly HtmlNode[], format: Format, out: Inline[], preformatted = false): void {
    for (const node of nodes) {
      if (typeof node === 'string') {
        const text = preformatted ? node : node.replace(/[ \t\n\f\r]+/g, ' ');
        if (text === '') continue;
        out.push(textRun(text, runStyle(format)));
        continue;
      }
      if (SKIPPED.has(node.tag)) continue;
      if (DROPPED_WITH_WARNING.has(node.tag)) {
        this.warnings.push(`A <${node.tag}> element cannot be carried and was left out.`);
        continue;
      }
      if (node.tag === 'br') {
        out.push(textRun('\n'));
        continue;
      }
      if (node.tag === 'img') {
        const image = this.image(node);
        if (image) out.push(image);
        continue;
      }
      const id = node.attrs.get('id') ?? (node.tag === 'a' ? node.attrs.get('name') : undefined);
      if (id) out.push(anchorRun(id));
      this.inlines(node.children, this.formatOf(node, format), out, preformatted);
    }
  }

  private paragraphFrom(nodes: readonly HtmlNode[], out: BlockSink, anchorId?: string): void {
    const runs: Inline[] = [];
    if (anchorId) runs.push(anchorRun(anchorId));
    this.inlines(nodes, {}, runs);
    const finished = finishInlines(runs);
    if (finished.length === 0) return;
    this.countBlock();
    out.paragraph(finished);
  }

  /** Reads the block-level content of `nodes`; loose inline content becomes paragraphs. */
  blocks(nodes: readonly HtmlNode[], out: BlockSink, listDepth: number, tableDepth: number): void {
    let run: HtmlNode[] = [];
    const flush = (): void => {
      if (run.length > 0) this.paragraphFrom(run, out);
      run = [];
    };
    for (const node of nodes) {
      if (typeof node === 'string' || !(INLINE_BLOCK_BREAKERS.has(node.tag) || SKIPPED.has(node.tag) || DROPPED_WITH_WARNING.has(node.tag))) {
        run.push(node);
        continue;
      }
      flush();
      this.block(node, out, listDepth, tableDepth);
    }
    flush();
  }

  private block(element: HtmlElement, out: BlockSink, listDepth: number, tableDepth: number): void {
    const tag = element.tag;
    if (SKIPPED.has(tag)) return;
    if (DROPPED_WITH_WARNING.has(tag)) {
      this.warnings.push(`A <${tag}> element cannot be carried and was left out.`);
      return;
    }
    const level = HEADING_LEVELS.get(tag);
    if (level !== undefined) {
      const runs: Inline[] = [];
      const id = element.attrs.get('id');
      if (id) runs.push(anchorRun(id));
      this.inlines(element.children, {}, runs);
      const finished = finishInlines(runs);
      if (finished.length > 0) {
        this.countBlock();
        out.heading(level, finished);
      }
      return;
    }
    if (PARAGRAPHS.has(tag)) {
      this.paragraphFrom(element.children, out, element.attrs.get('id'));
      return;
    }
    if (LISTS.has(tag)) {
      this.list(element, out, listDepth, tableDepth);
      return;
    }
    switch (tag) {
      case 'table':
        this.table(element, out, listDepth, tableDepth);
        return;
      case 'pre': {
        const runs: Inline[] = [];
        this.inlines(element.children, {}, runs, true);
        const text = runs.map(preformattedText).join('').replace(/^\n/, '');
        if (text.trim() !== '') {
          this.countBlock();
          out.code(text.replace(/\n$/, ''));
        }
        return;
      }
      case 'blockquote': {
        const inner = out.nested();
        this.blocks(element.children, inner, listDepth, tableDepth);
        if (inner.blocks.length > 0) {
          this.countBlock();
          out.quote(inner.blocks);
        }
        return;
      }
      case 'hr':
        this.countBlock();
        out.rule();
        return;
      default:
        break;
    }
    if (CONTAINERS.has(tag)) {
      // A table of contents the package generates is navigation, not content.
      const kind = element.attrs.get('epub:type') ?? element.attrs.get('role') ?? '';
      if (tag === 'nav' && /\btoc\b|doc-toc/.test(kind)) return;
      this.blocks(element.children, out, listDepth, tableDepth);
      return;
    }
    // li, tr, td and friends outside their parents: read their content as ordinary blocks.
    this.blocks(element.children, out, listDepth, tableDepth);
  }

  private list(element: HtmlElement, out: BlockSink, listDepth: number, tableDepth: number): void {
    const ordered = element.tag === 'ol';
    this.listId += 1;
    const listId = this.listId;
    const level = Math.min(listDepth, MAX_LIST_LEVELS - 1);
    const start = ordered ? (Number.parseInt(element.attrs.get('start') ?? '', DECIMAL_RADIX) || DEFAULT_LIST_START) : DEFAULT_LIST_START;
    const format = ORDERED_TYPES.get(element.attrs.get('type') ?? '1') ?? 'decimal';
    let number = start;
    for (const child of element.children) {
      if (typeof child === 'string' || child.tag !== 'li') continue;
      const content = out.nested();
      this.blocks(child.children, content, listDepth + 1, tableDepth);
      const first = content.blocks[0];
      const id = child.attrs.get('id');
      if (first && first.type === 'paragraph') {
        const marker = ordered ? `${formatListNumber(number, format)}.` : BULLETS[level % BULLETS.length];
        out.listItem({
          sourceId: listId,
          level,
          ...listFormatOf(ordered, ordered ? format : 'bullet', marker),
          value: number,
          marker,
          runs: id ? [anchorRun(id), ...first.runs] : first.runs,
        });
        out.appendAll(content.blocks.slice(1));
      } else {
        out.appendAll(content.blocks);
      }
      number += 1;
    }
  }

  private flatten(element: HtmlElement, out: BlockSink): void {
    this.warnings.push(`Tables nested deeper than ${HTML_MODEL_MAX_TABLE_DEPTH} levels were flattened to text.`);
    const runs: Inline[] = [];
    this.inlines(element.children, {}, runs);
    const finished = finishInlines(runs);
    if (finished.length > 0) {
      this.countBlock();
      out.paragraph(finished);
    }
  }

  private table(element: HtmlElement, out: BlockSink, listDepth: number, tableDepth: number): void {
    if (tableDepth >= HTML_MODEL_MAX_TABLE_DEPTH) {
      this.flatten(element, out);
      return;
    }
    const rows: HtmlElement[] = [];
    const inHead = new Set<HtmlElement>();
    const caption: HtmlNode[] = [];
    const collect = (parent: HtmlElement, head: boolean): void => {
      for (const child of parent.children) {
        if (typeof child === 'string') continue;
        if (child.tag === 'tr') {
          rows.push(child);
          if (head) inHead.add(child);
        } else if (child.tag === 'thead' || child.tag === 'tbody' || child.tag === 'tfoot') {
          collect(child, child.tag === 'thead');
        } else if (child.tag === 'caption') {
          caption.push(...child.children);
        }
      }
    };
    collect(element, false);
    if (caption.length > 0) this.paragraphFrom(caption, out);

    const draftRows: TableDraftCell[][] = [];
    const covering = new Map<number, OpenCell>();
    let columnCount = 0;
    for (const tr of rows) {
      const cells: TableDraftCell[] = [];
      let column = 0;
      const skipCovered = (): void => {
        for (let held = covering.get(column); held && held.rowsLeft > 0; held = covering.get(column)) {
          held.rowsLeft -= 1;
          column += 1;
        }
      };
      let allHeaders = true;
      let any = false;
      for (const td of tr.children) {
        if (typeof td === 'string' || (td.tag !== 'td' && td.tag !== 'th')) continue;
        skipCovered();
        const colSpan = positiveInt(td.attrs.get('colspan'), MAX_COLUMN_SPAN);
        const rowSpan = positiveInt(td.attrs.get('rowspan'), MAX_ROW_SPAN);
        const content = out.nested();
        this.blocks(td.children, content, listDepth, tableDepth + 1);
        const background = styleProperties(td.attrs.get('style')).get('background-color');
        const cell: TableDraftCell = { blocks: content.blocks, colSpan, rowSpan, header: td.tag === 'th', shading: background ? parseColor(background) : undefined };
        cells.push(cell);
        any = true;
        if (td.tag !== 'th') allHeaders = false;
        for (let offset = 0; offset < colSpan; offset += 1) {
          if (rowSpan > 1) covering.set(column + offset, { cell, rowsLeft: rowSpan - 1 });
          else covering.delete(column + offset);
        }
        column += colSpan;
      }
      skipCovered();
      columnCount = Math.max(columnCount, column);
      if (any || cells.length > 0) {
        const header = inHead.has(tr) || (any && allHeaders);
        for (const cell of cells) cell.header = header;
        draftRows.push(cells);
      }
    }
    if (draftRows.length === 0) return;
    this.countBlock();
    out.table({ rows: draftRows, columnCount });
  }
}

/**
 * Reads `html` into the document model. The language comes from the `lang` attribute of the root element and the
 * title from `<title>`. Images over the pixel limit are refused with a typed error.
 */
export async function htmlToDocumentModel(html: string, options: HtmlModelOptions = {}): Promise<DocumentModel> {
  const tree = parseHtmlTree(html.replace(/^﻿/, ''));
  const context = options.context ?? new DocumentContext();
  const builder = new HtmlModelBuilder(options, context);
  const sink = new BlockSink(context);
  builder.blocks(tree.root.children, sink, 0, 0);
  for (const bytes of builder.checks) await assertEmbeddableImageWithinLimit(bytes);
  const root = findRoot(tree.root);
  const language = root?.attrs.get('lang') ?? root?.attrs.get('xml:lang');
  return assembleDocument({ sections: [{ columns: 1, blocks: sink.blocks }], context, language: language || undefined, title: tree.title || undefined });
}

function findRoot(node: HtmlElement): HtmlElement | undefined {
  for (const child of node.children) {
    if (typeof child !== 'string' && child.tag === 'html') return child;
  }
  return undefined;
}
