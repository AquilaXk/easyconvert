import type { HtmlElement } from './html-blocks';

/**
 * Policy and report for the images an HTML document names without embedding them. They are fetched before rendering
 * (see html-image-loader.ts) and staged as data: URIs, so the renderers never touch the network. An image that cannot be
 * loaded is left out and reported as a warning in the result; with `requireResources` the conversion refuses instead.
 */

/** Longest reference a warning quotes, in characters. */
const MAX_REFERENCE_CHARS = 120;
/** Most omissions listed one by one; the rest are counted in a final warning. */
export const MAX_REPORTED_OMISSIONS = 50;
const CONTROL_CHARACTERS = /\p{Cc}/gu;
/** Most references one warning names one by one; the rest are counted. */
export const MAX_NAMED_REFERENCES = 10;

export interface HtmlResourcePolicy {
  /** Refuse a document with an image that cannot be loaded (400) instead of leaving the image out. */
  requireResources?: boolean;
  /** The job's signal: once it fires, no further image is fetched. */
  signal?: AbortSignal;
}

export function quoted(reference: string): string {
  const text = [...reference.replaceAll(CONTROL_CHARACTERS, ' ').trim()];
  return text.length > MAX_REFERENCE_CHARS ? `${text.slice(0, MAX_REFERENCE_CHARS).join('')}…` : text.join('');
}

/** The external images one conversion left out, in document order. */
export class OmittedExternalImages {
  private readonly listed: string[] = [];
  private total = 0;

  add(reference: string, reason: string): void {
    this.total++;
    if (this.listed.length < MAX_REPORTED_OMISSIONS) this.listed.push(`Left out the image "${quoted(reference)}": ${reason}.`);
  }

  get count(): number {
    return this.total;
  }

  /** One warning per listed image, then one for the images beyond the limit. */
  warnings(): string[] {
    const lines = [...this.listed];
    const unlisted = this.total - this.listed.length;
    if (unlisted > 0) lines.push(`Left out ${unlisted} more external images that could not be loaded.`);
    return lines;
  }
}

/**
 * The elements and references the staging for LibreOffice leaves out of a document, other than images (those are
 * OmittedExternalImages). Nothing named here is fetched: an element is not written, and a reference is dropped from
 * the link, style sheet, style attribute or background that held it. Two warnings report them, one for the elements
 * (counted by tag) and one for the references (each distinct one named, up to MAX_NAMED_REFERENCES).
 */
export class OmittedContent {
  private readonly elements = new Map<string, number>();
  private readonly references = new Map<string, string>();

  element(tag: string): void {
    this.elements.set(tag, (this.elements.get(tag) ?? 0) + 1);
  }

  /** A reference that was dropped, and where the document held it (`<a href>`, `background`, `style sheet`, ...). */
  reference(holder: string, reference: string): void {
    this.references.set(`${holder}\u0000${reference}`, `"${quoted(reference)}" (${holder})`);
  }

  /** The warning for the elements, then the one for the references; none for what was not met. */
  warnings(): string[] {
    return [this.elementsWarning(), this.referencesWarning()].filter((line): line is string => line !== null);
  }

  private elementsWarning(): string | null {
    if (this.elements.size === 0) return null;
    const total = [...this.elements.values()].reduce((sum, count) => sum + count, 0);
    const listing = [...this.elements].map(([tag, count]) => `<${tag}> x ${count}`).join(', ');
    return `Left out elements that cannot be drawn (${total}): ${listing}.`;
  }

  private referencesWarning(): string | null {
    if (this.references.size === 0) return null;
    const named = [...this.references.values()].slice(0, MAX_NAMED_REFERENCES);
    const unnamed = this.references.size - named.length;
    const rest = unnamed > 0 ? `, and ${unnamed} more` : '';
    return `Left out references that are not loaded or followed (${this.references.size}): ${named.join(', ')}${rest}.`;
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

/** One candidate of a srcset: its URL and the descriptor text after it ("2x", "480w", or empty). */
export interface SrcsetCandidate {
  readonly url: string;
  readonly descriptor: string;
}

function skipWhile(value: string, from: number, test: (character: string) => boolean): number {
  let i = from;
  while (i < value.length && test(value[i])) i++;
  return i;
}

/** The index of the comma that ends a descriptor; commas inside parentheses do not end it. */
function descriptorEnd(value: string, from: number): number {
  let depth = 0;
  let i = from;
  for (; i < value.length && (depth > 0 || value[i] !== ','); i++) {
    if (value[i] === '(') depth++;
    else if (value[i] === ')' && depth > 0) depth--;
  }
  return i;
}

/** The candidates of a srcset, skipping commas inside URLs and parentheses (data: URIs may contain commas). */
export function srcsetCandidates(value: string): SrcsetCandidate[] {
  const candidates: SrcsetCandidate[] = [];
  let i = 0;
  while (i < value.length) {
    i = skipWhile(value, i, (character) => isHtmlSpace(character) || character === ',');
    const start = i;
    i = skipWhile(value, i, (character) => !isHtmlSpace(character));
    let end = i;
    let descriptor = '';
    if (end > start && value[end - 1] === ',') {
      while (end > start && value[end - 1] === ',') end--;
    } else {
      const descriptorStart = i;
      i = descriptorEnd(value, i);
      descriptor = value.slice(descriptorStart, i).trim();
    }
    if (end > start) candidates.push({ url: value.slice(start, end), descriptor });
  }
  return candidates;
}

/** The URLs of a srcset: each candidate's URL, skipping its descriptors. */
export function srcsetUrls(value: string): string[] {
  return srcsetCandidates(value).map((candidate) => candidate.url);
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
