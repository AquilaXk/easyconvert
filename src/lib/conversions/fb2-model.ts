import { SaxesParser } from 'saxes';
import { ConversionFailedError, DataParseError, PayloadLimitError } from '../types';
import type { DocumentModel } from './document-model/model';
import { safeHref } from './document-model/support';
import { HTML_MODEL_MAX_IMAGE_BYTES, HTML_MODEL_MAX_IMAGES, htmlToDocumentModel } from './html-model';
import { XML_TREE_MAX_DEPTH, XML_TREE_MAX_ELEMENTS } from './xml-tree';

/**
 * Reads a FictionBook 2 book into the document model with its structure: the nesting of `section` elements becomes
 * heading levels (a section's `title`, level 1 for a top-level section, one deeper for each nesting level, six at most),
 * poems, epigraphs, quotations, subtitles, tables and emphasis keep their meaning, the `binary` pictures the book names
 * (the cover page and the pictures in the text) are carried, and the note body is kept at the end with the links to it.
 * The book is streamed through an XML parser that expands no entity and has no DTD, bounded in elements, depth, text and
 * picture bytes, and turned into XHTML that the HTML reader of the document model understands.
 */

const FICTIONBOOK_ROOT = 'FictionBook';
/** Most characters of text one book may hold, and the most base64 characters of pictures (the picture bytes are limited again when decoded). */
const FB2_MAX_TEXT_CHARS = 256 * 1024 * 1024;
const FB2_MAX_BINARY_CHARS = Math.ceil((HTML_MODEL_MAX_IMAGE_BYTES * 4) / 3);
const FB2_MAX_BINARIES = HTML_MODEL_MAX_IMAGES * 2;
const MAX_HEADING_LEVEL = 6;
const NOTES_BODY_NAME = 'notes';
const COVER_SOURCE_PREFIX = 'fb2-binary:';

const INLINE_TAGS: ReadonlyMap<string, string> = new Map([
  ['emphasis', 'em'],
  ['strong', 'strong'],
  ['strikethrough', 's'],
  ['sub', 'sub'],
  ['sup', 'sup'],
  ['code', 'code'],
  ['style', 'span'],
]);
/** Elements whose character data is the book's text; whitespace between any other elements is layout of the file. */
const TEXT_ELEMENTS: ReadonlySet<string> = new Set(['p', 'v', 'subtitle', 'text-author', 'date', 'td', 'th']);
const QUOTE_ELEMENTS: ReadonlySet<string> = new Set(['epigraph', 'cite', 'annotation', 'poem']);
const SKIPPED_ELEMENTS: ReadonlySet<string> = new Set(['description', 'stylesheet', 'binary']);
const TABLE_ELEMENTS: ReadonlySet<string> = new Set(['table', 'tr', 'td', 'th']);
const TABLE_SPAN_ATTRIBUTES = ['colspan', 'rowspan'] as const;
const NAME_PARTS = ['first-name', 'middle-name', 'last-name'] as const;

const escapeText = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttribute = (text: string): string => escapeText(text).replace(/"/g, '&quot;');

interface Frame {
  local: string;
  /** The closing markup written for this element. */
  close: string;
  /** Depth of `section` elements at this element, in the body it is in. */
  sectionDepth: number;
}

interface Author {
  parts: Map<string, string>;
  nickname: string;
}

interface Metadata {
  title: string;
  authors: string[];
  language: string | undefined;
  coverId: string | undefined;
}

function hrefOf(attributes: Record<string, { local: string; value: string }>): string | undefined {
  for (const attribute of Object.values(attributes)) if (attribute.local === 'href') return attribute.value;
  return undefined;
}

/** The id a `#id` link names, or undefined for any other link. */
function fragmentId(href: string | undefined): string | undefined {
  return href !== undefined && href.startsWith('#') && href.length > 1 ? href.slice(1) : undefined;
}

class Fb2Translator {
  readonly html: string[] = [];
  readonly binaries = new Map<string, string>();
  readonly metadata: Metadata = { title: '', authors: [], language: undefined, coverId: undefined };
  private readonly stack: Frame[] = [];
  private binaryId: string | undefined;
  private binaryChars = 0;
  private textChars = 0;
  private elements = 0;
  private bodyIndex = -1;
  private inNotes = false;
  /** One more heading level under the book title, when the main body states one. */
  private levelOffset = 0;
  private sectionDepth = 0;
  private inTitleInfo = false;
  private author: Author | undefined;
  private capturing: string | undefined;
  private captured = '';
  /** Whether a title already holds text, so the next paragraph of it is separated by a space. */
  private headingHasText = false;
  /** The id of a section whose first block has not been written yet: the anchor the notes and links point to. */
  private pendingId: string | undefined;

  constructor(private readonly xml: string) {}

  translate(): void {
    const parser = new SaxesParser({ xmlns: true, position: true, defaultXMLVersion: '1.0', forceXMLVersion: true });
    parser.on('error', (error) => {
      throw new DataParseError(`Invalid FB2 book: not well-formed XML (${error.message}).`, { line: parser.line, column: parser.column + 1 });
    });
    parser.on('opentag', (tag) => this.open(tag.local, tag.attributes as Record<string, { local: string; value: string }>));
    parser.on('closetag', (tag) => this.close(tag.local));
    parser.on('text', (text) => this.text(text));
    parser.on('cdata', (text) => this.text(text));
    parser.write(this.xml).close();
    if (this.bodyIndex < 0) throw new ConversionFailedError('The FB2 file is not a FictionBook document with a body.');
  }

  private parent(): string {
    return this.stack.length > 1 ? this.stack[this.stack.length - 2].local : '';
  }

  private push(markup: string, close: string): void {
    this.html.push(markup);
    this.stack[this.stack.length - 1].close = close;
  }

  private open(local: string, attributes: Record<string, { local: string; value: string }>): void {
    this.elements += 1;
    if (this.elements > XML_TREE_MAX_ELEMENTS) throw new PayloadLimitError(`The FB2 book holds more than ${XML_TREE_MAX_ELEMENTS} elements.`);
    if (this.stack.length === 0) {
      if (local !== FICTIONBOOK_ROOT) throw new ConversionFailedError('The FB2 file is not a FictionBook document with a body.');
    }
    this.stack.push({ local, close: '', sectionDepth: this.sectionDepth });
    if (this.stack.length > XML_TREE_MAX_DEPTH) throw new PayloadLimitError(`The FB2 book nests elements deeper than ${XML_TREE_MAX_DEPTH} levels.`);
    const attr = (name: string): string | undefined => attributes[name]?.value;

    if (local === 'binary') {
      this.binaryId = attr('id');
      this.captured = '';
      return;
    }
    if (local === 'description') return;
    if (local === 'title-info' && this.stack.some((frame) => frame.local === 'description')) {
      this.inTitleInfo = true;
      return;
    }
    if (this.inTitleInfo) {
      this.openMetadata(local, attributes);
      return;
    }
    if (this.stack.some((frame) => SKIPPED_ELEMENTS.has(frame.local))) return;
    if (local === 'body') {
      this.bodyIndex += 1;
      this.inNotes = attr('name') === NOTES_BODY_NAME || this.bodyIndex > 0;
      this.sectionDepth = 0;
      if (this.bodyIndex === 0) this.levelOffset = 0;
      return;
    }
    if (this.bodyIndex < 0) return;
    this.openBody(local, attributes);
  }

  private openMetadata(local: string, attributes: Record<string, { local: string; value: string }>): void {
    if (local === 'author') {
      this.author = { parts: new Map(), nickname: '' };
      return;
    }
    if (local === 'image' && this.stack.some((frame) => frame.local === 'coverpage')) {
      const id = fragmentId(hrefOf(attributes));
      if (id !== undefined && this.metadata.coverId === undefined) this.metadata.coverId = id;
      return;
    }
    if (local === 'book-title' || local === 'lang') {
      this.capturing = local;
      this.captured = '';
    } else if (this.author && ((NAME_PARTS as readonly string[]).includes(local) || local === 'nickname')) {
      this.capturing = local;
      this.captured = '';
    }
  }

  private openBody(local: string, attributes: Record<string, { local: string; value: string }>): void {
    const attr = (name: string): string | undefined => attributes[name]?.value;
    const parent = this.parent();
    if (local === 'section') {
      this.sectionDepth += 1;
      this.pendingId = attr('id') ?? this.pendingId;
      this.push('<section>', '</section>');
      return;
    }
    const anchored = ['title', 'p', 'v', 'date', 'subtitle'].includes(local);
    const id = attr('id') ?? (anchored ? this.pendingId : undefined);
    if (anchored && !(local === 'p' && parent === 'title')) this.pendingId = undefined;
    const idAttribute = id === undefined ? '' : ` id="${escapeAttribute(id)}"`;
    if (local === 'title') {
      if (parent === 'body' && this.bodyIndex === 0) this.levelOffset = 1;
      const depth = this.stack[this.stack.length - 1].sectionDepth;
      const heading = (parent === 'section' || parent === 'body') && !(this.inNotes && parent === 'section');
      this.headingHasText = false;
      if (heading) {
        const level = Math.min(Math.max(parent === 'body' ? 1 : depth + this.levelOffset, 1), MAX_HEADING_LEVEL);
        this.push(`<h${level}${idAttribute}>`, `</h${level}>`);
      } else {
        this.push(`<p${idAttribute}><strong>`, '</strong></p>');
      }
      return;
    }
    const inline = INLINE_TAGS.get(local);
    if (inline !== undefined) {
      this.push(`<${inline}>`, `</${inline}>`);
      return;
    }
    if (local === 'a') {
      const href = hrefOf(attributes);
      const target = fragmentId(href) !== undefined ? href : safeHref(href);
      this.push(target === undefined ? '<span>' : `<a href="${escapeAttribute(target)}">`, target === undefined ? '</span>' : '</a>');
      return;
    }
    if (local === 'image') {
      const id = fragmentId(hrefOf(attributes));
      const alt = escapeAttribute(attr('alt') ?? attr('title') ?? '');
      const picture = id === undefined ? '' : `<img src="${COVER_SOURCE_PREFIX}${escapeAttribute(id)}" alt="${alt}"/>`;
      const inlineHost = TEXT_ELEMENTS.has(parent) || INLINE_TAGS.has(parent) || parent === 'a' || parent === 'title';
      this.html.push(inlineHost ? picture : `<p>${picture}</p>`);
      return;
    }
    if (QUOTE_ELEMENTS.has(local)) {
      this.push('<blockquote>', '</blockquote>');
      return;
    }
    if (local === 'p' || local === 'v' || local === 'date') {
      if (parent === 'title') {
        // Several lines of one title are one heading.
        if (this.headingHasText) this.html.push(' ');
        return;
      }
      this.push(`<p${idAttribute}>`, '</p>');
      return;
    }
    if (local === 'subtitle') {
      this.push(`<p${idAttribute}><strong>`, '</strong></p>');
      return;
    }
    if (local === 'text-author') {
      this.push('<p><em>', '</em></p>');
      return;
    }
    if (TABLE_ELEMENTS.has(local)) {
      const spans = local === 'td' || local === 'th' ? TABLE_SPAN_ATTRIBUTES.map((name) => (attr(name) ? ` ${name}="${escapeAttribute(attr(name) as string)}"` : '')).join('') : '';
      this.push(`<${local}${spans}>`, `</${local}>`);
    }
  }

  private text(text: string): void {
    this.textChars += text.length;
    if (this.textChars > FB2_MAX_TEXT_CHARS) throw new PayloadLimitError(`The FB2 book is longer than ${FB2_MAX_TEXT_CHARS} characters.`);
    const top = this.stack[this.stack.length - 1];
    if (top === undefined) return;
    if (this.stack.some((frame) => frame.local === 'binary')) {
      this.binaryChars += text.length;
      if (this.binaryChars > FB2_MAX_BINARY_CHARS) throw new PayloadLimitError(`The FB2 pictures hold more than ${HTML_MODEL_MAX_IMAGE_BYTES} bytes.`);
      this.captured += text;
      return;
    }
    if (this.inTitleInfo) {
      if (this.capturing !== undefined) this.captured += text;
      return;
    }
    if (this.bodyIndex < 0 || this.stack.some((frame) => SKIPPED_ELEMENTS.has(frame.local))) return;
    const inText = this.stack.some((frame) => TEXT_ELEMENTS.has(frame.local) || frame.local === 'title');
    if (!inText) return;
    if (this.stack.some((frame) => frame.local === 'title')) {
      const inHeadingLine = this.stack.some((frame) => frame.local === 'p' || frame.local === 'v');
      if (!inHeadingLine) return;
      if (text.trim() !== '') this.headingHasText = true;
    }
    this.html.push(escapeText(text));
  }

  private close(local: string): void {
    const frame = this.stack.pop();
    if (frame === undefined) return;
    if (local === 'binary') {
      const id = this.binaryId;
      this.binaryId = undefined;
      if (id !== undefined && !this.binaries.has(id)) {
        if (this.binaries.size >= FB2_MAX_BINARIES) throw new PayloadLimitError(`The FB2 book holds more than ${FB2_MAX_BINARIES} binary objects.`);
        this.binaries.set(id, this.captured);
      }
      this.captured = '';
      return;
    }
    if (this.inTitleInfo) {
      this.closeMetadata(local);
      return;
    }
    if (local === 'section') this.sectionDepth = Math.max(0, this.sectionDepth - 1);
    if (this.bodyIndex >= 0 && frame.close !== '') this.html.push(frame.close);
  }

  private closeMetadata(local: string): void {
    const value = this.captured.replace(/\s+/g, ' ').trim();
    if (local === 'title-info') {
      this.inTitleInfo = false;
      this.capturing = undefined;
    } else if (local === 'book-title') {
      this.metadata.title = value;
    } else if (local === 'lang') {
      this.metadata.language = value === '' ? undefined : value;
    } else if (local === 'author') {
      const parts = NAME_PARTS.map((name) => this.author?.parts.get(name) ?? '').filter((part) => part !== '');
      const name = parts.length > 0 ? parts.join(' ') : (this.author?.nickname ?? '');
      if (name !== '') this.metadata.authors.push(name);
      this.author = undefined;
    } else if (this.author && (NAME_PARTS as readonly string[]).includes(local)) {
      this.author.parts.set(local, value);
    } else if (this.author && local === 'nickname') {
      this.author.nickname = value;
    }
    if (local !== 'title-info') this.capturing = undefined;
  }
}

/**
 * The model of a FictionBook 2 book. A document that is not a FictionBook with a body, or whose XML is not well formed,
 * and a book beyond the limits of the reader, are refused with typed errors. A picture the book names but does not
 * hold, or that is not an image, is left out with a warning.
 */
export async function readFb2Model(xml: string, fallbackTitle: string): Promise<DocumentModel> {
  const translator = new Fb2Translator(xml);
  translator.translate();
  const { metadata, binaries } = translator;
  const decoded = new Map<string, Buffer>();
  const resolveImage = (src: string): Buffer | undefined => {
    if (!src.startsWith(COVER_SOURCE_PREFIX)) return undefined;
    const id = src.slice(COVER_SOURCE_PREFIX.length);
    const known = decoded.get(id);
    if (known !== undefined) return known;
    const base64 = binaries.get(id);
    if (base64 === undefined) return undefined;
    const bytes = Buffer.from(base64.replace(/\s+/g, ''), 'base64');
    decoded.set(id, bytes);
    return bytes;
  };
  const coverMarkup = metadata.coverId !== undefined && binaries.has(metadata.coverId) ? `<p><img src="${COVER_SOURCE_PREFIX}${escapeAttribute(metadata.coverId)}" alt="Cover"/></p>` : '';
  const html = `<html><body>${coverMarkup}${translator.html.join('')}</body></html>`;
  const model = await htmlToDocumentModel(html, {
    resolveImage,
    mapLink: (href) => (href.startsWith('#') ? href : safeHref(href)),
  });
  model.title = metadata.title !== '' ? metadata.title : fallbackTitle;
  if (metadata.authors.length > 0) model.author = metadata.authors.join(', ');
  if (metadata.language !== undefined) model.language = metadata.language;
  if (coverMarkup !== '') model.coverImageId = leadingImageId(model);
  return model;
}

/** The picture the book opens with, when its first block is one. */
function leadingImageId(model: DocumentModel): number | undefined {
  const first = model.sections[0]?.blocks[0];
  if (first?.type === 'image') return first.imageId;
  if (first?.type === 'paragraph') return first.runs.find((run) => run.image !== undefined)?.image?.imageId;
  return undefined;
}
