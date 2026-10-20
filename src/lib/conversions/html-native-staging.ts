import sharp, { type Metadata } from 'sharp';
import { ConversionFailedError } from '../types';
import { scanCss } from './css-references';
import {
  HTML_IMAGE_CAPS,
  MAX_DOCUMENT_IMAGE_PIXELS,
  MAX_IMAGE_PIXELS,
  MAX_IMAGES_PER_DOCUMENT,
  parseHtmlTree,
  type HtmlElement,
  type HtmlNode,
} from './html-blocks';
import { loadExternalImages } from './html-image-loader';
import {
  asciiLowerCase,
  isUndrawable,
  NEVER_DRAWN_ELEMENTS,
  normalizeUrl,
  OmittedContent,
  OmittedExternalImages,
  stripControls,
  type HtmlResourcePolicy,
} from './html-omitted-resources';

/**
 * Rebuilds HTML bound for LibreOffice from the parsed tree, so LibreOffice reads exactly what was
 * checked instead of raw bytes it may parse differently (control characters inside names, comment
 * and raw-text edge cases, CSS escapes). Only allowlisted elements and attributes are written;
 * comments, doctypes, processing instructions and CDATA never are; every text node and attribute
 * value is escaped. What the written document can reach is limited to three places, each checked
 * as it is written: an `<a href>` (http, https, mailto or a `#fragment`), an `<img src>` (base64 PNG,
 * JPEG or GIF data that decodes) and CSS (embedded raster images and fragments only).
 *
 * A reference to anything else is left out and reported, never fetched and never refused: a link
 * that is relative, javascript:, file: or ftp:, a style sheet, a background picture, and CSS that
 * names a file or an import. The same goes for content LibreOffice would not draw here (embedded
 * media, frames, SVG, form controls, objects), which is left out with its fallback content. Both are reported in
 * two warnings (see OmittedContent). Data that claims to be an image or a style sheet but is not
 * valid is still a 400, and so is CSS the scanner cannot vouch for (escapes, a stray "<", non-ASCII
 * outside strings). An `<img>` that is not embedded is fetched and embedded first (see html-image-loader.ts),
 * and one that cannot be loaded is left out and reported, unless the caller requires every resource.
 * Elements that render nothing (scripts, templates, fallbacks, head metadata) are left out silently.
 */

const BYTE_ORDER_MARK = /^﻿/;

/** Elements written with their tag; any other element is unwrapped (only its content is written) or dropped. */
const WRITTEN_ELEMENTS: ReadonlySet<string> = new Set([
  'a', 'abbr', 'acronym', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'br', 'caption',
  'center', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'dir', 'div', 'dl', 'dt', 'em',
  'fieldset', 'figcaption', 'figure', 'font', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr',
  'i', 'img', 'ins', 'kbd', 'label', 'legend', 'li', 'main', 'mark', 'menu', 'nav', 'ol', 'p', 'pre', 'q', 'rp', 'rt',
  'ruby', 's', 'samp', 'section', 'small', 'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody',
  'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'tt', 'u', 'ul', 'var', 'wbr',
]);
const WRITTEN_VOID_ELEMENTS: ReadonlySet<string> = new Set(['br', 'col', 'hr', 'img', 'wbr']);
/**
 * Written elements whose `id` LibreOffice does not make a link target (measured on 24.2 and 26.8: it does for paragraphs,
 * headings, lists, items, tables, rows, cells, preformatted text, rules, pictures and inline elements). Each is given a
 * named anchor at its start, which LibreOffice does make one.
 */
const ELEMENTS_WITHOUT_TARGET: ReadonlySet<string> = new Set([
  'article', 'aside', 'caption', 'center', 'details', 'div', 'fieldset', 'figcaption', 'figure', 'footer', 'header', 'hgroup',
  'label', 'legend', 'main', 'nav', 'section', 'summary',
]);
/** Elements that render nothing, dropped with their content: scripts, templates, fallbacks and head metadata. */
const DROPPED_ELEMENTS: ReadonlySet<string> = new Set([
  ...NEVER_DRAWN_ELEMENTS, 'source', 'track', 'link', 'meta', 'base', 'param', 'datalist', 'area', 'bgsound', 'title',
]);
/** Raw-text elements whose content is written as escaped preformatted text. */
const PREFORMATTED_TEXT_ELEMENTS: ReadonlySet<string> = new Set(['xmp']);
const DOCUMENT_ELEMENT = 'html';
const BODY_ELEMENT = 'body';
const STYLE_ELEMENT = 'style';
/** Attributes written as they are (after escaping); style, href and src are checked first. */
const WRITTEN_ATTRIBUTES: ReadonlySet<string> = new Set([
  'abbr', 'align', 'alink', 'alt', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'char', 'charoff', 'class',
  'clear', 'color', 'colspan', 'compact', 'datetime', 'dir', 'face', 'frame', 'headers', 'height', 'hspace', 'id',
  'lang', 'link', 'name', 'noshade', 'nowrap', 'open', 'reversed', 'rowspan', 'rules', 'scope', 'size', 'span',
  'start', 'summary', 'text', 'title', 'type', 'valign', 'value', 'vlink', 'vspace', 'width',
]);

const ANCHOR_ELEMENT = 'a';
const LINK_ELEMENT = 'link';
const HREF_ATTRIBUTE = 'href';
const ID_ATTRIBUTE = 'id';
const SRC_ATTRIBUTE = 'src';
const BACKGROUND_ATTRIBUTE = 'background';
const IMAGE_ELEMENT = 'img';
const STYLE_ATTRIBUTE = 'style';
const STYLESHEET_RELATION = 'stylesheet';
/** What a warning says held a reference that was left out. */
const ANCHOR_HOLDER = '<a href>';
const LINK_HOLDER = '<link href>';
const STYLE_SHEET_HOLDER = 'style sheet';
const STYLE_ATTRIBUTE_HOLDER = 'style attribute';
const DATA_URI_PREFIX = /^data:/i;
const FRAGMENT_PREFIX = '#';
/** Schemes an `<a href>` may link to outside the document; LibreOffice keeps them as links and loads nothing. */
const ANCHOR_SCHEME = /^(?:https?|mailto):/i;
const ASCII_WHITESPACE = /[ \t\n\f\r]+/g;

/** Image data: base64 PNG, JPEG or GIF; the decoded bytes must start with that format's signature. */
const IMAGE_DATA_URI = /^data:image\/(png|jpeg|gif);base64,/i;
const BASE64_PAYLOAD = /^[A-Za-z0-9+/]*={0,2}$/;
/** Base64 characters enough for the longest signature (16 characters decode to 12 bytes). */
const SIGNATURE_BASE64_LENGTH = 16;
const IMAGE_SIGNATURES: ReadonlyMap<string, readonly Buffer[]> = new Map([
  ['png', [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]],
  ['jpeg', [Buffer.from([0xff, 0xd8, 0xff])]],
  ['gif', [Buffer.from('GIF87a', 'latin1'), Buffer.from('GIF89a', 'latin1')]],
]);
const MAX_REFERENCE_PREVIEW = 80;

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Base64 PNG, JPEG or GIF data whose decoded bytes start with the declared format's signature. */
function isEmbeddedRasterImage(url: string): boolean {
  const match = IMAGE_DATA_URI.exec(url);
  if (!match) return false;
  const payload = url.slice(match[0].length).replace(ASCII_WHITESPACE, '');
  if (!BASE64_PAYLOAD.test(payload)) return false;
  const head = Buffer.from(payload.slice(0, SIGNATURE_BASE64_LENGTH), 'base64');
  const signatures = IMAGE_SIGNATURES.get(asciiLowerCase(match[1])) ?? [];
  return signatures.some((signature) => head.subarray(0, signature.length).equals(signature));
}

/** Whether an `<a href>` target stays a link: the document itself, a fragment, or an http, https or mailto address. */
function isAllowedAnchor(url: string): boolean {
  return url.startsWith(FRAGMENT_PREFIX) || ANCHOR_SCHEME.test(url);
}

/** CSS may name fragments (SVG paint servers) and embedded raster images only; the images are collected. */
function isAllowedCssUrl(url: string, images: Set<string>): boolean {
  const normalized = normalizeUrl(url);
  if (normalized.length === 0 || normalized.startsWith(FRAGMENT_PREFIX)) return true;
  if (!isEmbeddedRasterImage(normalized)) return false;
  images.add(normalized);
  return true;
}

function preview(reference: string): string {
  return reference.length > MAX_REFERENCE_PREVIEW ? `${reference.slice(0, MAX_REFERENCE_PREVIEW)}…` : reference;
}

/** The typed 400 for image data that is not embedded base64 PNG, JPEG or GIF. */
function refusal(reference: string): ConversionFailedError {
  return new ConversionFailedError(`HTML image "${preview(reference)}" is not embedded base64 PNG, JPEG or GIF data`);
}

/**
 * Checks CSS and returns the text that was checked, collecting the images it embeds. CSS that names a reference to
 * somewhere else (a file, an import, a picture by address) is not passed on: it is left out, reported as held by
 * `holder`, and null is returned. CSS that names a data: URI that is no embedded raster image is refused, as is
 * CSS the scanner cannot vouch for (it throws).
 */
function checkedCss(css: string, holder: string, omitted: OmittedContent, images: Set<string>): string | null {
  const embedded = new Set<string>();
  const scan = scanCss(css, (url) => isAllowedCssUrl(url, embedded));
  if (scan.reference !== null) {
    if (DATA_URI_PREFIX.test(normalizeUrl(scan.reference))) throw refusal(scan.reference);
    omitted.reference(holder, scan.reference);
    return null;
  }
  for (const url of embedded) images.add(url);
  return scan.css;
}

function textContent(element: HtmlElement): string {
  return element.children.filter((child): child is string => typeof child === 'string').join('');
}

/** A `<style>` element's CSS, checked, or null when it is left out. Character references are refused: readers disagree on decoding them there. */
function checkedStyleSheet(element: HtmlElement, omitted: OmittedContent, images: Set<string>): string | null {
  const css = stripControls(textContent(element));
  if (css.includes('&')) throw new ConversionFailedError('HTML style sheets may not contain "&" (character references)');
  return checkedCss(css, STYLE_SHEET_HOLDER, omitted, images);
}

/** The bytes and declared format of a checked image data: URI. */
function imageData(url: string): { bytes: Buffer; format: string } {
  const match = IMAGE_DATA_URI.exec(url) as RegExpExecArray;
  return { bytes: Buffer.from(url.slice(match[0].length).replace(ASCII_WHITESPACE, ''), 'base64'), format: asciiLowerCase(match[1]) };
}

/**
 * Proves every image LibreOffice will read decodes as the format it declares, within the
 * in-process renderer's limits: headers first (format, size, pixel budget), then one full decode.
 */
async function verifyEmbeddedImages(urls: ReadonlySet<string>): Promise<void> {
  if (urls.size > MAX_IMAGES_PER_DOCUMENT) {
    throw new ConversionFailedError(`HTML embeds ${urls.size} images; at most ${MAX_IMAGES_PER_DOCUMENT} per document are converted`);
  }
  const images = Array.from(urls, imageData);
  let totalPixels = 0;
  for (const { bytes, format } of images) {
    let metadata: Metadata;
    try {
      metadata = await sharp(bytes, { limitInputPixels: false }).metadata();
    } catch (err) {
      throw new ConversionFailedError(`HTML embedded image could not be read: ${(err as Error).message}`);
    }
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (metadata.format !== format || width <= 0 || height <= 0) {
      throw new ConversionFailedError(`HTML embedded image is not a valid ${format.toUpperCase()} image`);
    }
    if (width * height > MAX_IMAGE_PIXELS) {
      throw new ConversionFailedError(`HTML embedded image is ${width}x${height} pixels, above the ${MAX_IMAGE_PIXELS}-pixel limit`);
    }
    totalPixels += width * height;
  }
  if (totalPixels > MAX_DOCUMENT_IMAGE_PIXELS) {
    throw new ConversionFailedError(`HTML embeds images totalling ${totalPixels} pixels, above the ${MAX_DOCUMENT_IMAGE_PIXELS}-pixel limit per document`);
  }
  for (const { bytes } of images) {
    try {
      await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS }).raw().toBuffer();
    } catch (err) {
      throw new ConversionFailedError(`HTML embedded image could not be decoded: ${(err as Error).message}`);
    }
  }
}

/** The staged document and the warnings for what was left out of it: images one by one, then elements and references. */
export interface StagedHtml {
  html: string;
  warnings: string[];
}

/** Writes the allowlisted part of a checked tree as escaped HTML. */
class StagedHtmlWriter {
  /** The image data: URIs the written document embeds. */
  readonly images = new Set<string>();
  /** The elements and references left out of the written document. */
  readonly omitted = new OmittedContent();
  private readonly body: string[] = [];
  private readonly styles: string[] = [];
  private documentAttributes: string | undefined;
  private bodyAttributes: string | undefined;

  constructor(private readonly title: string | undefined) {}

  write(root: HtmlElement): string {
    this.children(root.children);
    const title = this.title ? `<title>${escapeHtml(stripControls(this.title))}</title>` : '';
    const styles = this.styles.map((css) => `<style>${css}</style>`).join('');
    return (
      `<html${this.documentAttributes ?? ''}><head><meta charset="utf-8">${title}${styles}</head>` +
      `<body${this.bodyAttributes ?? ''}>${this.body.join('')}</body></html>`
    );
  }

  private children(nodes: readonly HtmlNode[]): void {
    for (const node of nodes) this.node(node);
  }

  private node(node: HtmlNode): void {
    if (typeof node === 'string') {
      this.body.push(escapeHtml(stripControls(node)));
      return;
    }
    const tag = node.tag;
    if (isUndrawable(node)) {
      this.omitted.element(tag);
      return;
    }
    if (DROPPED_ELEMENTS.has(tag)) {
      this.reportStylesheetLink(node);
      return;
    }
    if (tag === STYLE_ELEMENT) {
      const css = checkedStyleSheet(node, this.omitted, this.images);
      if (css !== null) this.styles.push(css);
      return;
    }
    if (PREFORMATTED_TEXT_ELEMENTS.has(tag)) {
      this.body.push(`<pre>${escapeHtml(stripControls(textContent(node)))}</pre>`);
      return;
    }
    if (tag === DOCUMENT_ELEMENT && this.documentAttributes === undefined) this.documentAttributes = this.attributes(node);
    if (tag === BODY_ELEMENT && this.bodyAttributes === undefined) this.bodyAttributes = this.attributes(node);
    if (!WRITTEN_ELEMENTS.has(tag)) {
      if (tag !== DOCUMENT_ELEMENT && tag !== BODY_ELEMENT) this.targetAtStart(node);
      this.children(node.children);
      return;
    }
    this.body.push(`<${tag}${this.attributes(node)}>`);
    if (WRITTEN_VOID_ELEMENTS.has(tag)) return;
    if (ELEMENTS_WITHOUT_TARGET.has(tag)) this.targetAtStart(node);
    this.children(node.children);
    this.body.push(`</${tag}>`);
  }

  /** The link target of an element that is not written with its `id`, or is written with one LibreOffice ignores: a named anchor, written where the element starts. */
  private targetAtStart(element: HtmlElement): void {
    const id = stripControls(element.attrs.get(ID_ATTRIBUTE) ?? '');
    if (id !== '') this.body.push(`<a name="${escapeHtml(id)}"></a>`);
  }

  /** A `<link rel="stylesheet">` is dropped like the rest of the head, but its style sheet is a loss worth reporting. */
  private reportStylesheetLink(element: HtmlElement): void {
    if (element.tag !== LINK_ELEMENT) return;
    const relations = asciiLowerCase(element.attrs.get('rel') ?? '').split(ASCII_WHITESPACE);
    const href = normalizeUrl(element.attrs.get(HREF_ATTRIBUTE) ?? '');
    if (relations.includes(STYLESHEET_RELATION) && href.length > 0) this.omitted.reference(LINK_HOLDER, href);
  }

  private attributes(element: HtmlElement): string {
    let written = '';
    for (const [name, value] of element.attrs) {
      const kept = this.attributeValue(element, name, value);
      if (kept !== null) written += ` ${name}="${escapeHtml(kept)}"`;
    }
    return written;
  }

  /** The value written for an attribute, or null when it is not written. */
  private attributeValue(element: HtmlElement, name: string, value: string): string | null {
    if (name === STYLE_ATTRIBUTE) return checkedCss(value, STYLE_ATTRIBUTE_HOLDER, this.omitted, this.images);
    if (name === HREF_ATTRIBUTE && element.tag === ANCHOR_ELEMENT) return this.anchorTarget(value);
    if (name === SRC_ATTRIBUTE && element.tag === IMAGE_ELEMENT) return this.embeddedImage(value);
    if (name === BACKGROUND_ATTRIBUTE) {
      this.reportBackground(value);
      return null;
    }
    return WRITTEN_ATTRIBUTES.has(name) ? stripControls(value) : null;
  }

  /** The target of a link that stays one, or null for a link to anywhere else, which is left out and reported. */
  private anchorTarget(value: string): string | null {
    const url = normalizeUrl(value);
    if (url.length === 0) return null;
    if (isAllowedAnchor(url)) return url;
    this.omitted.reference(ANCHOR_HOLDER, url);
    return null;
  }

  private embeddedImage(value: string): string | null {
    const url = normalizeUrl(value);
    if (url.length === 0) return null;
    if (!isEmbeddedRasterImage(url)) throw refusal(url);
    this.images.add(url);
    return url;
  }

  private reportBackground(value: string): void {
    const url = normalizeUrl(value);
    if (url.length > 0) this.omitted.reference(BACKGROUND_ATTRIBUTE, url);
  }
}

/**
 * Checks HTML bound for LibreOffice and rebuilds it from the parsed tree as UTF-8 HTML. Throws
 * ConversionFailedError (400) for image data that does not decode or is no PNG, JPEG or GIF, for CSS that is not
 * allowed (escapes, non-ASCII outside strings, a stray "<", a data: URI that is no image) and for documents nested
 * too deeply. Everything else the document names or embeds that the PDF cannot carry is left out and reported in
 * `warnings`.
 */
export async function stageHtmlForNativeEngine(html: string, policy: HtmlResourcePolicy = {}): Promise<StagedHtml> {
  const document = parseHtmlTree(stripControls(html.replace(BYTE_ORDER_MARK, '')));
  const omitted = new OmittedExternalImages();
  await loadExternalImages(document.root, policy, omitted, HTML_IMAGE_CAPS);
  const writer = new StagedHtmlWriter(document.title);
  const staged = writer.write(document.root);
  await verifyEmbeddedImages(writer.images);
  return { html: staged, warnings: [...omitted.warnings(), ...writer.omitted.warnings()] };
}
