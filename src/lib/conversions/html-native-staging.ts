import sharp, { type Metadata } from 'sharp';
import { ConversionFailedError, EngineUnavailableError } from '../types';
import { scanCss } from './css-references';
import {
  asciiLowerCase,
  MAX_DOCUMENT_IMAGE_PIXELS,
  MAX_IMAGE_PIXELS,
  MAX_IMAGES_PER_DOCUMENT,
  parseHtmlTree,
  type HtmlElement,
  type HtmlNode,
} from './html-blocks';
import { OmittedExternalImages, type HtmlResourcePolicy } from './html-omitted-resources';

/**
 * Rebuilds HTML bound for LibreOffice from the parsed tree, so LibreOffice reads exactly what was
 * checked instead of raw bytes it may parse differently (control characters inside names, comment
 * and raw-text edge cases, CSS escapes). Only allowlisted elements and attributes are written;
 * comments, doctypes, processing instructions and CDATA never are; every text node and attribute
 * value is escaped. Any URL that leaves the document is refused with a typed 400 first: on every
 * element (inline SVG included) URL attributes must be data: URIs or `#fragment`s, image sources
 * must be base64 PNG, JPEG or GIF data that decodes, and only `<a href>` may link to http, https
 * or mailto. The exception is an `<img>` that is not embedded: resources are never fetched, so it is left out of
 * the staged document and reported, unless the caller requires every resource. Content LibreOffice would not draw here (embedded media, frames with content, SVG,
 * form controls) is refused with EngineUnavailableError rather than dropped; only elements that
 * render nothing (scripts, templates, fallbacks, head metadata) are left out silently.
 */

/** C0 controls other than tab, line feed, form feed and carriage return, and DEL. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/g;
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
/** Elements that render nothing, dropped with their content: scripts, templates, fallbacks and head metadata. */
const DROPPED_ELEMENTS: ReadonlySet<string> = new Set([
  'script', 'noscript', 'template', 'noembed', 'noframes', 'source', 'track', 'link', 'meta', 'base', 'param',
  'datalist', 'area', 'bgsound', 'title',
]);
/** Elements whose content would be lost: refused, as the in-process renderer refuses them. */
const UNRENDERED_ELEMENTS: ReadonlySet<string> = new Set([
  'svg', 'canvas', 'video', 'audio', 'applet', 'frame', 'frameset', 'select', 'textarea',
]);
/** Frames, refused when they have a source or inline document. */
const FRAME_ELEMENTS: ReadonlySet<string> = new Set(['iframe', 'portal']);
const INPUT_ELEMENT = 'input';
const HIDDEN_INPUT_TYPE = 'hidden';
const EMBED_ELEMENT = 'embed';
const OBJECT_ELEMENT = 'object';
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

/**
 * Attributes whose value is a URL the document may load, submit to or navigate to. Namespaced
 * `*:href` (SVG `xlink:href` under any prefix) counts too.
 */
const URL_ATTRIBUTES: ReadonlySet<string> = new Set([
  'src', 'srcset', 'imagesrcset', 'href', 'background', 'poster', 'data', 'codebase', 'action', 'formaction', 'cite',
  'longdesc', 'lowsrc', 'dynsrc', 'manifest', 'ping', 'archive', 'classid', 'profile', 'usemap', 'icon',
]);
/** URL attributes holding a srcset (comma-separated candidates with descriptors). */
const SRCSET_ATTRIBUTES: ReadonlySet<string> = new Set(['srcset', 'imagesrcset']);
/** URL attributes holding a whitespace-separated list of URLs. */
const URL_LIST_ATTRIBUTES: ReadonlySet<string> = new Set(['ping', 'archive', 'profile']);
/** Attributes that name an image on any element. */
const IMAGE_ATTRIBUTES: ReadonlySet<string> = new Set(['srcset', 'imagesrcset', 'lowsrc', 'dynsrc', 'poster', 'background']);
/** Elements whose src or href names an image: HTML images and image inputs, SVG image and feImage. */
const IMAGE_ELEMENTS: ReadonlySet<string> = new Set(['img', 'input', 'image', 'feimage']);
/** SVG presentation attributes whose value may be a CSS `url()` paint, filter, mask, marker or cursor reference. */
const PRESENTATION_URL_ATTRIBUTES: ReadonlySet<string> = new Set([
  'fill', 'stroke', 'filter', 'clip-path', 'mask', 'marker-start', 'marker-mid', 'marker-end', 'cursor',
]);
/** SVG animation elements, which write their to/from/by/values into the attribute they target. */
const ANIMATION_ELEMENTS: ReadonlySet<string> = new Set(['set', 'animate', 'animatetransform', 'animatemotion']);
const ANIMATION_VALUE_ATTRIBUTES = ['to', 'from', 'by', 'values'] as const;
const ANIMATION_VALUE_SEPARATOR = ';';
const ANCHOR_ELEMENT = 'a';
const HREF_ATTRIBUTE = 'href';
const SRC_ATTRIBUTE = 'src';
const SRCSET_ATTRIBUTE = 'srcset';
const IMAGE_ELEMENT = 'img';
const NAMESPACED_HREF_SUFFIX = ':href';
const META_ELEMENT = 'meta';
const REFRESH_PRAGMA = 'refresh';
/** The delay and optional `url=` label before the target of a `<meta http-equiv="refresh">`. */
const REFRESH_TARGET_PREFIX = /^[\s\d.]*[;,]?\s*(?:url\s*=\s*)?/i;
const QUOTE_CHARACTERS = /^['"]|['"]$/g;
const STYLE_ATTRIBUTE = 'style';
const DATA_URI_PREFIX = /^data:/i;
const FRAGMENT_PREFIX = '#';
/** Schemes an `<a href>` may link to outside the document; LibreOffice keeps them as links and loads nothing. */
const ANCHOR_SCHEME = /^(?:https?|mailto):/i;
/** Tab and newlines, which URL parsers drop from anywhere inside a URL. */
const URL_IGNORED_CHARACTERS = /[\t\n\r]/g;
const LAST_C0_OR_SPACE = 0x20;
const URL_LIST_SEPARATOR = /[ \t\n\f\r]+/;
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

type UrlKind = 'anchor' | 'image' | 'other';

function stripControls(text: string): string {
  return text.replace(CONTROL_CHARACTERS, '');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function isHtmlSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\f' || ch === '\r';
}

/** Strips leading and trailing C0 controls and spaces, as URL parsers do. */
function trimUrl(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= LAST_C0_OR_SPACE) start++;
  while (end > start && value.charCodeAt(end - 1) <= LAST_C0_OR_SPACE) end--;
  return value.slice(start, end);
}

/** The URL a parser reads from an attribute value: no control characters, trimmed, without tabs or newlines. */
function normalizeUrl(value: string): string {
  return trimUrl(stripControls(value)).replace(URL_IGNORED_CHARACTERS, '');
}

/** The URLs of a srcset: each candidate's URL, skipping its descriptors (data: URIs may contain commas). */
function srcsetUrls(value: string): string[] {
  const urls: string[] = [];
  const length = value.length;
  let i = 0;
  while (i < length) {
    while (i < length && (isHtmlSpace(value[i]) || value[i] === ',')) i++;
    const start = i;
    while (i < length && !isHtmlSpace(value[i])) i++;
    let end = i;
    if (end > start && value[end - 1] === ',') {
      while (end > start && value[end - 1] === ',') end--;
    } else {
      let depth = 0;
      for (; i < length && (depth > 0 || value[i] !== ','); i++) {
        if (value[i] === '(') depth++;
        else if (value[i] === ')' && depth > 0) depth--;
      }
    }
    if (end > start) urls.push(value.slice(start, end));
  }
  return urls;
}

function isUrlAttribute(name: string): boolean {
  return URL_ATTRIBUTES.has(name) || name.endsWith(NAMESPACED_HREF_SUFFIX);
}

function isHrefAttribute(name: string): boolean {
  return name === HREF_ATTRIBUTE || name.endsWith(NAMESPACED_HREF_SUFFIX);
}

/** URLs an attribute names: each srcset candidate, each entry of a URL list, or the single URL. */
function attributeUrls(name: string, value: string): string[] {
  const cleaned = stripControls(value);
  if (SRCSET_ATTRIBUTES.has(name)) return srcsetUrls(cleaned);
  if (URL_LIST_ATTRIBUTES.has(name)) return cleaned.split(URL_LIST_SEPARATOR).filter((url) => url.length > 0);
  return [cleaned];
}

function urlKind(tag: string, name: string): UrlKind {
  if (tag === ANCHOR_ELEMENT && isHrefAttribute(name)) return 'anchor';
  if (IMAGE_ATTRIBUTES.has(name)) return 'image';
  if (IMAGE_ELEMENTS.has(tag) && (name === SRC_ATTRIBUTE || isHrefAttribute(name))) return 'image';
  return 'other';
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

/** Whether a normalized URL is allowed: empty (the document itself) or a fragment, then by kind. */
function isAllowedUrl(url: string, kind: UrlKind): boolean {
  if (url.length === 0) return true;
  if (kind === 'image') return isEmbeddedRasterImage(url);
  if (url.startsWith(FRAGMENT_PREFIX)) return true;
  return kind === 'anchor' ? ANCHOR_SCHEME.test(url) : DATA_URI_PREFIX.test(url);
}

/** CSS may name fragments (SVG paint servers) and embedded raster images only; the images are collected. */
function isAllowedCssUrl(url: string, images?: Set<string>): boolean {
  const normalized = normalizeUrl(url);
  if (normalized.length === 0 || normalized.startsWith(FRAGMENT_PREFIX)) return true;
  if (!isEmbeddedRasterImage(normalized)) return false;
  images?.add(normalized);
  return true;
}

function preview(reference: string): string {
  return reference.length > MAX_REFERENCE_PREVIEW ? `${reference.slice(0, MAX_REFERENCE_PREVIEW)}…` : reference;
}

/** The typed 400 for a reference that is not allowed. */
function refusal(reference: string): ConversionFailedError {
  const normalized = reference.replace(URL_IGNORED_CHARACTERS, '');
  if (DATA_URI_PREFIX.test(normalized) || normalized.startsWith(FRAGMENT_PREFIX)) {
    return new ConversionFailedError(`HTML image "${preview(reference)}" is not embedded base64 PNG, JPEG or GIF data`);
  }
  return new ConversionFailedError(
    `HTML resource "${preview(reference)}" is an external reference; external resources are not fetched, so embed it as a data: URI ` +
      '(only <a href> may link to http, https or mailto)'
  );
}

function assertUrlsAllowed(urls: readonly string[], kind: UrlKind): void {
  for (const url of urls) {
    const reported = trimUrl(url);
    if (!isAllowedUrl(reported.replace(URL_IGNORED_CHARACTERS, ''), kind)) throw refusal(reported);
  }
}

/** Checks CSS and returns the text that was checked, collecting the images it embeds. */
function checkedCss(css: string, images?: Set<string>): string {
  const scan = scanCss(css, (url) => isAllowedCssUrl(url, images));
  if (scan.reference !== null) throw refusal(scan.reference);
  return scan.css;
}

function textContent(element: HtmlElement): string {
  return element.children.filter((child): child is string => typeof child === 'string').join('');
}

/** A `<style>` element's CSS, checked. Character references are refused: readers disagree on decoding them there. */
function checkedStyleSheet(element: HtmlElement, images?: Set<string>): string {
  const css = stripControls(textContent(element));
  if (css.includes('&')) throw new ConversionFailedError('HTML style sheets may not contain "&" (character references)');
  return checkedCss(css, images);
}

function hasValue(element: HtmlElement, name: string): boolean {
  return trimUrl(element.attrs.get(name) ?? '').length > 0;
}

/** Whether an element has content of its own: a child element or text other than whitespace. */
function hasContent(element: HtmlElement): boolean {
  return element.children.some((child) => typeof child !== 'string' || child.trim().length > 0);
}

/** Whether staging would lose what the element draws: media, SVG, form controls, frames and objects with content. */
function isUnrendered(element: HtmlElement): boolean {
  const tag = element.tag;
  if (UNRENDERED_ELEMENTS.has(tag)) return true;
  if (tag === INPUT_ELEMENT) return asciiLowerCase(trimUrl(element.attrs.get('type') ?? '')) !== HIDDEN_INPUT_TYPE;
  if (FRAME_ELEMENTS.has(tag)) return hasValue(element, 'src') || hasValue(element, 'srcdoc');
  if (tag === EMBED_ELEMENT) return hasValue(element, 'src');
  if (tag === OBJECT_ELEMENT) return hasValue(element, 'data') || hasContent(element);
  return false;
}

function unrendered(tag: string): EngineUnavailableError {
  return new EngineUnavailableError(
    'soffice',
    `HTML <${tag}> cannot be drawn on the native LibreOffice route; embedded media, frames, SVG and form controls are not converted`
  );
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

/** The target of `<meta http-equiv="refresh" content="5; url=...">`, or null for any other element. */
function refreshTarget(element: HtmlElement): string | null {
  if (element.tag !== META_ELEMENT) return null;
  if (asciiLowerCase(trimUrl(element.attrs.get('http-equiv') ?? '')) !== REFRESH_PRAGMA) return null;
  const content = stripControls(element.attrs.get('content') ?? '');
  return trimUrl(content.replace(REFRESH_TARGET_PREFIX, '')).replace(QUOTE_CHARACTERS, '');
}

/** Refuses a URL an SVG animation would write into a URL or presentation attribute. */
function assertAnimationAllowed(element: HtmlElement): void {
  const target = asciiLowerCase(trimUrl(element.attrs.get('attributename') ?? ''));
  const writesUrl = isUrlAttribute(target);
  if (!writesUrl && !PRESENTATION_URL_ATTRIBUTES.has(target)) return;
  for (const attribute of ANIMATION_VALUE_ATTRIBUTES) {
    for (const value of (element.attrs.get(attribute) ?? '').split(ANIMATION_VALUE_SEPARATOR)) {
      if (writesUrl) assertUrlsAllowed(attributeUrls(target, value), 'other');
      else checkedCss(value);
    }
  }
}

/** Refuses any reference an element makes to something outside the document. */
function assertElementStaysInDocument(element: HtmlElement): void {
  for (const [name, value] of element.attrs) {
    if (isUrlAttribute(name)) assertUrlsAllowed(attributeUrls(name, value), urlKind(element.tag, name));
    else if (name === STYLE_ATTRIBUTE || PRESENTATION_URL_ATTRIBUTES.has(name)) checkedCss(value);
  }
  const refresh = refreshTarget(element);
  if (refresh !== null) assertUrlsAllowed([refresh], 'other');
  if (ANIMATION_ELEMENTS.has(element.tag)) assertAnimationAllowed(element);
  if (element.tag === STYLE_ELEMENT) checkedStyleSheet(element);
}

/** The staged document and one warning per external image that was left out of it. */
export interface StagedHtml {
  html: string;
  warnings: string[];
}

/** Whether an `<img>` names something other than an embedded data: image, in `src` or `srcset`. */
function isExternalImage(element: HtmlElement): boolean {
  const sources = [element.attrs.get(SRC_ATTRIBUTE), ...attributeUrls(SRCSET_ATTRIBUTE, element.attrs.get(SRCSET_ATTRIBUTE) ?? '')];
  return sources.some((source) => {
    const url = source === undefined ? '' : normalizeUrl(source);
    return url.length > 0 && !DATA_URI_PREFIX.test(url) && !url.startsWith(FRAGMENT_PREFIX);
  });
}

/**
 * Removes every `<img>` that is not embedded from the tree, with its content (an image has none), and records it.
 * Nothing is fetched for them, so LibreOffice never sees the reference; the rest of the page is kept.
 */
function leaveOutExternalImages(root: HtmlElement, omitted: OmittedExternalImages): void {
  const pending: HtmlElement[] = [root];
  while (pending.length > 0) {
    const parent = pending.pop() as HtmlElement;
    parent.children.forEach((child, index) => {
      if (typeof child === 'string') return;
      if (child.tag === IMAGE_ELEMENT && isExternalImage(child)) {
        omitted.add(child.attrs.get(SRC_ATTRIBUTE) ?? child.attrs.get(SRCSET_ATTRIBUTE) ?? '');
        parent.children[index] = '';
      } else {
        pending.push(child);
      }
    });
  }
}

/** Checks every element of the tree, written or not, so a refused reference is a 400 wherever it is. */
function assertTreeStaysInDocument(root: HtmlElement): void {
  const pending: HtmlNode[] = [...root.children];
  while (pending.length > 0) {
    const node = pending.pop() as HtmlNode;
    if (typeof node === 'string') continue;
    assertElementStaysInDocument(node);
    for (const child of node.children) pending.push(child);
  }
}

/** Writes the allowlisted part of a checked tree as escaped HTML. */
class StagedHtmlWriter {
  /** The image data: URIs the written document embeds. */
  readonly images = new Set<string>();
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
    if (isUnrendered(node)) throw unrendered(tag);
    if (DROPPED_ELEMENTS.has(tag)) return;
    if (tag === STYLE_ELEMENT) {
      this.styles.push(checkedStyleSheet(node, this.images));
      return;
    }
    if (PREFORMATTED_TEXT_ELEMENTS.has(tag)) {
      this.body.push(`<pre>${escapeHtml(stripControls(textContent(node)))}</pre>`);
      return;
    }
    if (tag === DOCUMENT_ELEMENT && this.documentAttributes === undefined) this.documentAttributes = this.attributes(node);
    if (tag === BODY_ELEMENT && this.bodyAttributes === undefined) this.bodyAttributes = this.attributes(node);
    if (!WRITTEN_ELEMENTS.has(tag)) {
      this.children(node.children);
      return;
    }
    this.body.push(`<${tag}${this.attributes(node)}>`);
    if (WRITTEN_VOID_ELEMENTS.has(tag)) return;
    this.children(node.children);
    this.body.push(`</${tag}>`);
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
    if (name === STYLE_ATTRIBUTE) return checkedCss(value, this.images);
    const linksOut = name === HREF_ATTRIBUTE && element.tag === ANCHOR_ELEMENT;
    const embedsImage = name === SRC_ATTRIBUTE && element.tag === IMAGE_ELEMENT;
    if (linksOut || embedsImage) {
      const url = normalizeUrl(value);
      if (url.length === 0) return null;
      const kind: UrlKind = linksOut ? 'anchor' : 'image';
      if (!isAllowedUrl(url, kind)) throw refusal(url);
      if (embedsImage) this.images.add(url);
      return url;
    }
    return WRITTEN_ATTRIBUTES.has(name) ? stripControls(value) : null;
  }
}

/**
 * Checks HTML bound for LibreOffice and rebuilds it from the parsed tree as UTF-8 HTML. Throws
 * ConversionFailedError (400) for any reference outside the document, for CSS that is not allowed
 * (escapes, imports, non-ASCII outside strings, a stray "<"), for images that do not decode and
 * for documents nested too deeply; EngineUnavailableError for content it would have to drop.
 */
export async function stageHtmlForNativeEngine(html: string, policy: HtmlResourcePolicy = {}): Promise<StagedHtml> {
  const document = parseHtmlTree(stripControls(html.replace(BYTE_ORDER_MARK, '')));
  const omitted = new OmittedExternalImages();
  if (!policy.requireResources) leaveOutExternalImages(document.root, omitted);
  assertTreeStaysInDocument(document.root);
  const writer = new StagedHtmlWriter(document.title);
  const staged = writer.write(document.root);
  await verifyEmbeddedImages(writer.images);
  return { html: staged, warnings: omitted.warnings() };
}
