import type { HtmlElement } from './html-blocks';

/**
 * Policy and report for the resources an HTML document names but the converter never fetches. Network access is
 * never granted to a conversion, so an image that is not embedded as a data: URI cannot be drawn. By default it is
 * left out and reported as a warning in the result; with `requireResources` the conversion refuses instead.
 */

/** Longest reference a warning quotes, in characters. */
const MAX_REFERENCE_CHARS = 120;
/** Most omissions listed one by one; the rest are counted in a final warning. */
export const MAX_REPORTED_OMISSIONS = 50;
const CONTROL_CHARACTERS = /\p{Cc}/gu;

export interface HtmlResourcePolicy {
  /** Refuse a document with an external resource (400) instead of leaving the resource out. */
  requireResources?: boolean;
}

function quoted(reference: string): string {
  const text = [...reference.replaceAll(CONTROL_CHARACTERS, ' ').trim()];
  return text.length > MAX_REFERENCE_CHARS ? `${text.slice(0, MAX_REFERENCE_CHARS).join('')}…` : text.join('');
}

/** The external images one conversion left out, in document order. */
export class OmittedExternalImages {
  private readonly listed: string[] = [];
  private total = 0;

  add(reference: string): void {
    this.total++;
    if (this.listed.length < MAX_REPORTED_OMISSIONS) this.listed.push(quoted(reference));
  }

  get count(): number {
    return this.total;
  }

  /** One warning per listed image, then one for the images beyond the limit. */
  warnings(): string[] {
    const lines = this.listed.map((reference) => `Left out the image "${reference}": external resources are not fetched.`);
    const unlisted = this.total - this.listed.length;
    if (unlisted > 0) lines.push(`Left out ${unlisted} more external images: external resources are not fetched.`);
    return lines;
  }
}

/** C0 controls other than tab, line feed, form feed and carriage return, and DEL. */
const CONTROL_CHARACTERS_TO_STRIP = /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/g;
/** Tab and newlines, which URL parsers drop from anywhere inside a URL. */
const URL_IGNORED_CHARACTERS = /[\t\n\r]/g;
const LAST_C0_OR_SPACE = 0x20;
const DATA_URI_PREFIX = /^data:/i;
const FRAGMENT_PREFIX = '#';
const IMAGE_TAG = 'img';
const PICTURE_TAG = 'picture';
const SOURCE_TAG = 'source';
const SRC_ATTRIBUTE = 'src';
const SRCSET_ATTRIBUTE = 'srcset';

export function stripControls(text: string): string {
  return text.replace(CONTROL_CHARACTERS_TO_STRIP, '');
}

function isHtmlSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\f' || ch === '\r';
}

/** Strips leading and trailing C0 controls and spaces, as URL parsers do. */
export function trimUrl(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= LAST_C0_OR_SPACE) start++;
  while (end > start && value.charCodeAt(end - 1) <= LAST_C0_OR_SPACE) end--;
  return value.slice(start, end);
}

/** The URL a parser reads from an attribute value: no control characters, trimmed, without tabs or newlines. */
export function normalizeUrl(value: string): string {
  return trimUrl(stripControls(value)).replace(URL_IGNORED_CHARACTERS, '');
}

/** The URLs of a srcset: each candidate's URL, skipping its descriptors (data: URIs may contain commas). */
export function srcsetUrls(value: string): string[] {
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

/** Whether an `<img>`, or a `<source>` of a `<picture>`, names something other than an embedded data: image. */
function namesExternalImage(element: HtmlElement): boolean {
  const sources = [element.attrs.get(SRC_ATTRIBUTE), ...srcsetUrls(stripControls(element.attrs.get(SRCSET_ATTRIBUTE) ?? ''))];
  return sources.some((source) => {
    const url = source === undefined ? '' : normalizeUrl(source);
    return url.length > 0 && !DATA_URI_PREFIX.test(url) && !url.startsWith(FRAGMENT_PREFIX);
  });
}

/** An image element the document names without embedding it, and where it sits. */
export interface ExternalImage {
  readonly parent: HtmlElement;
  readonly index: number;
  /** The `src` of the element, else its `srcset`: what a warning quotes. */
  readonly reference: string;
}

/**
 * The `<img>` elements and `<picture>` sources of the tree that are not embedded, in document order. Both renderers
 * use this one definition, so the same page is left out, warned about or refused the same way on either route.
 */
export function findExternalImages(root: HtmlElement): ExternalImage[] {
  const found: ExternalImage[] = [];
  const visit = (parent: HtmlElement): void => {
    parent.children.forEach((child, index) => {
      if (typeof child === 'string') return;
      const isImage = child.tag === IMAGE_TAG;
      const isPictureSource = child.tag === SOURCE_TAG && parent.tag === PICTURE_TAG;
      if ((isImage || isPictureSource) && namesExternalImage(child)) {
        found.push({ parent, index, reference: child.attrs.get(SRC_ATTRIBUTE) ?? child.attrs.get(SRCSET_ATTRIBUTE) ?? '' });
      } else {
        visit(child);
      }
    });
  };
  visit(root);
  return found;
}

/** Removes the images from the tree and records each one; nothing in the document refers to them afterwards. */
export function leaveOutImages(images: readonly ExternalImage[], omitted: OmittedExternalImages): void {
  for (const image of images) {
    omitted.add(image.reference);
    image.parent.children[image.index] = '';
  }
}
