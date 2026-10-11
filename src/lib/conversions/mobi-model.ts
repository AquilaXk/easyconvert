import { ConversionFailedError } from '../types';
import { DocumentContext } from './document-model/build';
import type { Block, DocumentModel } from './document-model/model';
import { safeHref } from './document-model/support';
import { htmlToDocumentModel } from './html-model';
import { decodeWindows1252 } from './office/windows-1252';
import { readMobiBook, type MobiBook } from './office/mobi-reader';

/**
 * Reads a MOBI or AZW book into the document model with its structure. The markup of a MOBI book is old HTML with no
 * heading elements (a chapter title is a bold `font` paragraph); the chapters are named by the table of contents the
 * book links to, a page of `<a filepos=N>` links where N is the byte offset of the chapter's first element in the markup.
 * The element each offset names becomes a heading, the table of contents page is left out (the writer builds a
 * navigation document), the pictures that `recindex` attributes number are carried, and the cover, title, authors and
 * language the headers name are kept. A book that names no table of contents is read as flat text and pictures.
 */

const ENCODING_UTF8 = 65001;
const MAX_TOC_ENTRIES = 100_000;
const MAX_TOC_LABEL_CHARS = 2000;
const MAX_ELEMENT_SCAN_CHARS = 1_000_000;
const IMAGE_SOURCE_PREFIX = 'mobi-image:';
const COVER_SOURCE = 'mobi-cover';
const HEADING_TAGS: ReadonlySet<string> = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div']);
const TOC_REFERENCE = /<reference\b[^>]*\btype\s*=\s*["']?toc["']?[^>]*>/i;
const FILEPOS = /\bfilepos\s*=\s*["']?0*(\d+)["']?/i;
const ANCHOR_WITH_FILEPOS = /<a\b[^>]*\bfilepos\s*=\s*["']?0*\d+["']?[^>]*>/gi;
const HEADING_LEVEL = 1;

interface Edit {
  start: number;
  end: number;
  replacement: string;
}

interface TocEntry {
  position: number;
  label: string;
}

const textOfMarkup = (markup: string): string => markup.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();

/** The table of contents page of a book: the links with a `filepos` at or after the position the guide gives for it. */
function tocEntries(markup: string): { start: number; entries: TocEntry[] } | undefined {
  const reference = TOC_REFERENCE.exec(markup.slice(0, markup.indexOf('</head>') >= 0 ? markup.indexOf('</head>') : markup.length));
  const start = reference ? Number(FILEPOS.exec(reference[0])?.[1] ?? Number.NaN) : Number.NaN;
  if (!Number.isInteger(start) || start <= 0 || start >= markup.length) return undefined;
  const entries: TocEntry[] = [];
  ANCHOR_WITH_FILEPOS.lastIndex = start;
  for (let match = ANCHOR_WITH_FILEPOS.exec(markup); match !== null && entries.length < MAX_TOC_ENTRIES; match = ANCHOR_WITH_FILEPOS.exec(markup)) {
    const position = Number(FILEPOS.exec(match[0])?.[1]);
    const labelStart = match.index + match[0].length;
    const close = markup.indexOf('</a>', labelStart);
    if (close < 0 || close - labelStart > MAX_TOC_LABEL_CHARS) continue;
    const label = textOfMarkup(markup.slice(labelStart, close));
    if (position < start && label !== '') entries.push({ position, label });
  }
  return { start, entries };
}

/** The element that starts at `position`, as the span `[position, end)` when it is a paragraph, heading or division. */
function elementAt(markup: string, lower: string, position: number): { end: number; inner: string } | undefined {
  if (markup.charAt(position) !== '<') return undefined;
  const tag = /^<([a-z][a-z0-9]*)\b[^>]*>/i.exec(markup.slice(position, position + 2000));
  if (!tag || !HEADING_TAGS.has(tag[1].toLowerCase())) return undefined;
  const closing = `</${tag[1].toLowerCase()}>`;
  const limit = Math.min(markup.length, position + MAX_ELEMENT_SCAN_CHARS);
  const close = lower.indexOf(closing, position + tag[0].length);
  if (close < 0 || close + closing.length > limit) return undefined;
  return { end: close + closing.length, inner: markup.slice(position + tag[0].length, close) };
}

/** The markup with a heading at each table of contents target and without the table of contents page. */
function withChapterHeadings(markup: string): string {
  const toc = tocEntries(markup);
  if (!toc || toc.entries.length === 0) return markup;
  const edits: Edit[] = [];
  const seen = new Set<number>();
  const lower = markup.toLowerCase();
  for (const entry of toc.entries) {
    if (seen.has(entry.position) || entry.position >= markup.length) continue;
    seen.add(entry.position);
    const element = elementAt(markup, lower, entry.position);
    if (element) edits.push({ start: entry.position, end: element.end, replacement: `<h${HEADING_LEVEL}>${element.inner}</h${HEADING_LEVEL}>` });
    else edits.push({ start: entry.position, end: entry.position, replacement: `<h${HEADING_LEVEL}>${entry.label.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</h${HEADING_LEVEL}>` });
  }
  // The page is dropped only when it holds nothing but the links: its text is the labels, in order.
  const page = markup.slice(toc.start);
  const body = page.indexOf('</body>') >= 0 ? page.slice(0, page.indexOf('</body>')) : page;
  const dropPage = textOfMarkup(body) === toc.entries.map((entry) => entry.label).join(' ');
  edits.sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const edit of edits) {
    if (edit.start < cursor || (dropPage && edit.start >= toc.start)) continue;
    out += markup.slice(cursor, edit.start) + edit.replacement;
    cursor = edit.end;
  }
  if (dropPage) {
    out += markup.slice(cursor, toc.start) + (page.indexOf('</body>') >= 0 ? page.slice(page.indexOf('</body>')) : '');
  } else {
    out += markup.slice(cursor);
  }
  return out;
}

/** Plain XHTML for the HTML reader: pictures named by `src`, the MOBI-only elements removed. */
function toHtml(markup: string): string {
  return markup
    .replace(/<img\b[^>]*>/gi, (tag) => tag.replace(/\brecindex\s*=\s*["']?0*(\d+)["']?/i, `src="${IMAGE_SOURCE_PREFIX}$1"`))
    .replace(/<\/?mbp:[^>]*>/gi, '');
}

function decodeMarkup(book: MobiBook, latin1: string): string {
  const bytes = Buffer.from(latin1, 'latin1');
  const text = book.encoding === ENCODING_UTF8 ? bytes.toString('utf-8') : decodeWindows1252(bytes);
  return text.replace(/\0/g, '');
}

/** The first picture of the book, when its first block is one. */
function leadingImageId(blocks: readonly Block[]): number | undefined {
  const first = blocks[0];
  if (first?.type === 'image') return first.imageId;
  if (first?.type === 'paragraph') return first.runs.find((run) => run.image !== undefined)?.image?.imageId;
  return undefined;
}

function usesImage(blocks: readonly Block[], imageId: number): boolean {
  return blocks.some((block) => (block.type === 'image' && block.imageId === imageId) || (block.type === 'paragraph' && block.runs.some((run) => run.image?.imageId === imageId)));
}

/**
 * The model of a MOBI or AZW book. A book that holds no text, that is protected by DRM or that uses a compression this
 * reader does not read is refused with a typed error (the container reader's); a picture the markup numbers but the book
 * does not hold is left out with a warning. A plain PalmDOC book has no markup, so it has no model (undefined).
 */
export async function readMobiModel(file: Buffer, fallbackTitle: string): Promise<DocumentModel | undefined> {
  const book = readMobiBook(file);
  if (!book.isMobi) return undefined;
  const markupLatin1 = book.bytes.toString('latin1');
  const html = decodeMarkup(book, toHtml(withChapterHeadings(markupLatin1)));
  const context = new DocumentContext();
  const resolveImage = (src: string): Buffer | undefined => {
    if (src === COVER_SOURCE) return book.coverIndex === undefined ? undefined : book.image(book.coverIndex + 1);
    return src.startsWith(IMAGE_SOURCE_PREFIX) ? book.image(Number(src.slice(IMAGE_SOURCE_PREFIX.length))) : undefined;
  };
  const model = await htmlToDocumentModel(html, { resolveImage, mapLink: (href) => (href.startsWith('#') ? href : safeHref(href)), context });
  if (model.sections.every((section) => section.blocks.length === 0)) throw new ConversionFailedError('The e-book holds no text.');

  // The cover is a page of its own unless the text already shows that picture; either way the package marks it.
  if (book.coverIndex !== undefined && book.image(book.coverIndex + 1) !== undefined) {
    const coverPage = await htmlToDocumentModel(`<p><img src="${COVER_SOURCE}" alt="Cover"/></p>`, { resolveImage, context });
    const coverId = leadingImageId(coverPage.sections[0].blocks);
    if (coverId !== undefined) {
      if (!model.sections.some((section) => usesImage(section.blocks, coverId))) model.sections[0].blocks.unshift(...coverPage.sections[0].blocks);
      model.coverImageId = coverId;
    }
  }
  model.title = book.title ?? fallbackTitle;
  if (book.authors.length > 0) model.author = book.authors.join(', ');
  if (book.language !== undefined) model.language = book.language;
  return model;
}
