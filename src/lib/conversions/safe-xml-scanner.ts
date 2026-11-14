/** The bounded, linear-time XML element scanner that the Office readers share, kept apart from the readers so that a part reader can use it without importing them. */

export interface SafeXmlAttributeMap {
  [key: string]: string;
}

export interface SafeXmlElement {
  tag: string;
  localName: string;
  prefix?: string;
  raw: string;
  attrs: SafeXmlAttributeMap;
  content: string;
  startIndex: number;
  endIndex: number;
}

export class SafeXmlDepthExceededError extends Error {
  constructor(maxDepth: number) {
    super(`XML nesting depth exceeds maximum allowed depth of ${maxDepth}.`);
    this.name = 'SafeXmlDepthExceededError';
  }
}

export interface SafeXmlScannerOptions {
  maxDepth?: number;
  maxElements?: number;
  /** When true, throws SafeXmlDepthExceededError instead of truncating when XML nesting exceeds maxDepth. */
  failOnMaxDepth?: boolean;
  /** Takes each element as it is found, in place of the returned list (which is then empty), so that a long list is not held. */
  onElement?: (element: SafeXmlElement) => void;
}

const NOT_FOUND = -1;
const CHAR_SLASH = 47;
const CHAR_GT = 62;

function skipBlanks(text: string, from: number): number {
  let i = from;
  while (i < text.length && text.charCodeAt(i) <= 32) i++;
  return i;
}

/** The end of a name or a bare value: the first blank, `/` or `>` (and `=` too when `stopAtEquals`). */
function wordEnd(text: string, from: number, stopAtEquals: boolean): number {
  let i = from;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code <= 32 || code === CHAR_SLASH || code === CHAR_GT || (stopAtEquals && code === 61)) break;
    i++;
  }
  return i;
}

/** The end of a quoted value, or of the text when the quote is never closed. */
function quotedValueEnd(text: string, from: number, quote: string): number {
  const close = text.indexOf(quote, from);
  return close === NOT_FOUND ? text.length : close;
}

/**
 * Linearly extracts XML attributes from an opening tag header in O(N) time with zero regex backtracking.
 */
export function safeExtractXmlAttributes(tagHeader: string): SafeXmlAttributeMap {
  const attrs: SafeXmlAttributeMap = {};
  let i = wordEnd(tagHeader, tagHeader.startsWith('<') ? 1 : 0, false);

  while (i < tagHeader.length) {
    i = skipBlanks(tagHeader, i);
    if (i >= tagHeader.length || tagHeader[i] === '/' || tagHeader[i] === '>') break;

    const keyEnd = wordEnd(tagHeader, i, true);
    const key = tagHeader.slice(i, keyEnd).trim();
    i = skipBlanks(tagHeader, keyEnd);

    if (tagHeader[i] !== '=') {
      if (key) attrs[key] = 'true';
      continue;
    }
    i = skipBlanks(tagHeader, i + 1);
    const quote = tagHeader[i] === '"' || tagHeader[i] === "'" ? tagHeader[i] : '';
    const valueStart = quote ? i + 1 : i;
    const valueEnd = quote ? quotedValueEnd(tagHeader, valueStart, quote) : wordEnd(tagHeader, valueStart, false);
    attrs[key] = safeDecodeXmlEntities(tagHeader.slice(valueStart, valueEnd));
    i = quote && valueEnd < tagHeader.length ? valueEnd + 1 : valueEnd;
  }
  return attrs;
}

const SAFE_XML_SCANNER_DEFAULTS = { maxElements: 50_000, maxDepth: 64 } as const;

/** The options of a scan with each default kept for an option that is absent or explicitly `undefined`. */
function withScannerDefaults(
  options: SafeXmlScannerOptions,
): Required<Pick<SafeXmlScannerOptions, 'maxElements' | 'maxDepth'>> & Pick<SafeXmlScannerOptions, 'onElement' | 'failOnMaxDepth'> {
  return {
    maxElements: options.maxElements ?? SAFE_XML_SCANNER_DEFAULTS.maxElements,
    maxDepth: options.maxDepth ?? SAFE_XML_SCANNER_DEFAULTS.maxDepth,
    failOnMaxDepth: options.failOnMaxDepth,
    onElement: options.onElement,
  };
}

/**
 * A search for the first match at or after a position, asked for positions that mostly only grow. The last match answers
 * every position up to it, and a miss answers every position after it, so a scan that asks again for each opening of a tag
 * walks the text once, where a fresh search for each walked it to the next match (or to the end) every time.
 */
class ForwardSearch {
  private from = 0;
  private found = NOT_FOUND;
  private missFrom = Infinity;

  constructor(private readonly search: (from: number) => number) {}

  next(from: number): number {
    if (from >= this.missFrom) return NOT_FOUND;
    if (this.found !== NOT_FOUND && from >= this.from && from <= this.found) return this.found;
    const found = this.search(from);
    if (found === NOT_FOUND) {
      this.missFrom = from;
      return NOT_FOUND;
    }
    this.from = from;
    this.found = found;
    return found;
  }
}

/** The searches that the scan of one tag name shares between its openings. */
class TagSearch {
  readonly startTag: string;
  readonly nextOpening: ForwardSearch;
  readonly nextClosing: ForwardSearch;
  readonly nextComment: ForwardSearch;
  readonly nextCdata: ForwardSearch;
  private readonly closeTag: string;

  constructor(
    private readonly xml: string,
    tag: string,
    nextComment: ForwardSearch,
    nextCdata: ForwardSearch,
  ) {
    this.startTag = '<' + tag;
    this.closeTag = '</' + tag;
    this.nextOpening = new ForwardSearch((from) => xml.indexOf(this.startTag, from));
    this.nextClosing = new ForwardSearch((from) => this.searchClosing(from));
    this.nextComment = nextComment;
    this.nextCdata = nextCdata;
  }

  /** The end of the closing tag that starts at `index`, past any blanks before its `>` (W3C XML 1.0 section 3.1). */
  closingEnd(index: number): number {
    return skipBlanks(this.xml, index + this.closeTag.length) + 1;
  }

  private searchClosing(from: number): number {
    let p = from;
    while (p < this.xml.length) {
      const index = this.xml.indexOf(this.closeTag, p);
      if (index === NOT_FOUND) return NOT_FOUND;
      const gt = skipBlanks(this.xml, index + this.closeTag.length);
      if (this.xml[gt] === '>') return index;
      p = index + this.closeTag.length;
    }
    return NOT_FOUND;
  }
}

interface TargetSpec {
  name: string;
  local: string;
  prefix?: string;
}

function splitName(name: string): { local: string; prefix?: string } {
  if (!name.includes(':')) return { local: name };
  const parts = name.split(':');
  return { local: parts[1], prefix: parts[0] };
}

function targetSpecs(tagName: string | string[]): TargetSpec[] {
  return (Array.isArray(tagName) ? tagName : [tagName]).map((name) => ({ name, ...splitName(name) }));
}

const CHAR_COLON = 58;

function spanEquals(xml: string, start: number, end: number, target: string): boolean {
  if (end - start !== target.length) return false;
  return xml.startsWith(target, start);
}

/** Zero-allocation check whether `xml[nameStart..nameEnd)` matches any TargetSpec before slicing tag strings. */
function matchesTargetSpan(specs: readonly TargetSpec[], xml: string, nameStart: number, nameEnd: number): boolean {
  let colon = NOT_FOUND;
  for (let i = nameStart; i < nameEnd; i++) {
    if (xml.charCodeAt(i) === CHAR_COLON) {
      colon = i;
      break;
    }
  }
  const localStart = colon === NOT_FOUND ? nameStart : colon + 1;
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    if (spec.prefix ? spanEquals(xml, nameStart, nameEnd, spec.name) : spanEquals(xml, localStart, nameEnd, spec.local)) {
      return true;
    }
  }
  return false;
}

/** The index that ends the name of the opening tag at `lt`. */
function tagNameEnd(xml: string, lt: number): number {
  let end = lt + 1;
  while (end < xml.length && xml.charCodeAt(end) > 32 && xml[end] !== '>' && xml[end] !== '/') end++;
  return end;
}

/** The `>` that closes the header of the tag whose name ends at `from`, with the quotes of its attributes skipped. */
function headerCloseFrom(xml: string, from: number): number {
  let i = from;
  let quote = '';
  while (i < xml.length) {
    const ch = xml[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      break;
    }
    i++;
  }
  return i;
}

/** The index of the `/` that ends a self-closing header, or -1 when the header is not self-closing. */
function selfClosingSlash(xml: string, lt: number, headerClose: number): number {
  let i = headerClose - 1;
  while (i > lt && xml.charCodeAt(i) <= 32) i--;
  return i > lt && xml[i] === '/' ? i : NOT_FOUND;
}

/** The position after a comment, a CDATA section, a processing instruction, a declaration or a closing tag at `lt`, or -1 for none of them. */
function skipNonElement(xml: string, lt: number): number {
  if (xml.startsWith('<!--', lt)) return afterMarker(xml, '-->', lt + 4);
  if (xml.startsWith('<![CDATA[', lt)) return afterMarker(xml, ']]>', lt + 9);
  const next = xml[lt + 1];
  if (next === '?' || next === '!' || next === '/') return afterMarker(xml, '>', lt + 2);
  return NOT_FOUND;
}

function afterMarker(xml: string, marker: string, from: number): number {
  const at = xml.indexOf(marker, from);
  return at === NOT_FOUND ? xml.length : at + marker.length;
}

function earliestOf(a: number, b: number): number {
  if (a === NOT_FOUND) return b;
  if (b === NOT_FOUND) return a;
  return Math.min(a, b);
}

/**
 * The `>` of the opening of the same tag at `open` that an element holds, or -1 when the text there is not such an opening
 * (the name goes on, as in `<rowx`, or the header never ends).
 */
function nestedOpeningClose(xml: string, open: number, startTagLength: number): number {
  const code = xml.charCodeAt(open + startTagLength);
  if (!(code === CHAR_GT || code === CHAR_SLASH || code <= 32)) return NOT_FOUND;
  const close = headerCloseFrom(xml, open + startTagLength);
  return close < xml.length ? close : NOT_FOUND;
}

interface ElementEnd {
  contentEnd: number;
  end: number;
}

const TOO_DEEP = Symbol('too deep');

/**
 * Walks from the end of an opening header to the closing tag that matches it, counting the openings of the same name between.
 * It is `null` when the element is never closed, and `TOO_DEEP` when the nest passes the bound: every later opening of the
 * same name would walk as far for its own close, so the caller ends the scan, which keeps the elements found before it
 * and is linear in the input where going on was quadratic.
 */
function findElementEnd(xml: string, tag: TagSearch, headerClose: number, maxDepth: number): ElementEnd | null | typeof TOO_DEEP {
  let depth = 0;
  let searchPos = headerClose + 1;
  while (searchPos < xml.length) {
    const comment = tag.nextComment.next(searchPos);
    const cdata = tag.nextCdata.next(searchPos);
    const earliestNonCode = earliestOf(comment, cdata);

    const closing = tag.nextClosing.next(searchPos);
    if (closing === NOT_FOUND) return null;

    const opening = tag.nextOpening.next(searchPos);
    const earliestTag = opening === NOT_FOUND ? closing : Math.min(opening, closing);
    if (earliestNonCode !== NOT_FOUND && earliestNonCode < earliestTag) {
      searchPos =
        earliestNonCode === comment
          ? afterMarker(xml, '-->', earliestNonCode + 4)
          : afterMarker(xml, ']]>', earliestNonCode + 9);
      continue;
    }

    if (opening === NOT_FOUND || opening >= closing) {
      if (depth === 0) return { contentEnd: closing, end: tag.closingEnd(closing) };
      depth--;
      searchPos = tag.closingEnd(closing);
      continue;
    }
    const openingClose = nestedOpeningClose(xml, opening, tag.startTag.length);
    if (openingClose === NOT_FOUND) {
      searchPos = opening + tag.startTag.length;
      continue;
    }
    if (selfClosingSlash(xml, opening, openingClose) === NOT_FOUND) {
      depth++;
      if (depth > maxDepth) return TOO_DEEP;
    }
    searchPos = openingClose + 1;
  }
  return null;
}

/**
 * Safely extracts XML elements in linear O(N) time without ReDoS backtracking.
 * Accurately tracks nested elements of the same tag name and enforces strict depth bounds.
 */
export function safeExtractXmlElements(
  xml: string,
  tagName: string | string[],
  options: SafeXmlScannerOptions = {}
): SafeXmlElement[] {
  const results: SafeXmlElement[] = [];
  const { maxElements, maxDepth, failOnMaxDepth, onElement } = withScannerDefaults(options);
  let found = 0;
  const take = onElement ?? ((element: SafeXmlElement): void => void results.push(element));
  const specs = targetSpecs(tagName);
  const searches = new Map<string, TagSearch>();
  const sharedComments = new ForwardSearch((from) => xml.indexOf('<!--', from));
  const sharedCdata = new ForwardSearch((from) => xml.indexOf('<![CDATA[', from));
  let outerDepth = 0;

  let pos = 0;
  while (pos < xml.length && found < maxElements) {
    const lt = xml.indexOf('<', pos);
    if (lt === NOT_FOUND) break;
    const skipped = skipNonElement(xml, lt);
    if (skipped !== NOT_FOUND) {
      if (failOnMaxDepth && xml.charCodeAt(lt + 1) === CHAR_SLASH && outerDepth > 0) {
        outerDepth--;
      }
      pos = skipped;
      continue;
    }

    const tagEnd = tagNameEnd(xml, lt);
    const headerClose = headerCloseFrom(xml, tagEnd);
    if (headerClose >= xml.length) break;
    const slash = selfClosingSlash(xml, lt, headerClose);
    if (!matchesTargetSpan(specs, xml, lt + 1, tagEnd)) {
      if (failOnMaxDepth && slash === NOT_FOUND) {
        outerDepth++;
        if (outerDepth > maxDepth) throw new SafeXmlDepthExceededError(maxDepth);
      }
      pos = headerClose + 1;
      continue;
    }

    const currentTag = xml.slice(lt + 1, tagEnd);
    const { local, prefix } = splitName(currentTag);
    let end = headerClose + 1;
    let contentEnd = lt;
    if (slash === NOT_FOUND) {
      let tag = searches.get(currentTag);
      if (!tag) searches.set(currentTag, (tag = new TagSearch(xml, currentTag, sharedComments, sharedCdata)));
      const remainingDepth = failOnMaxDepth ? Math.max(0, maxDepth - outerDepth) : maxDepth;
      const element = findElementEnd(xml, tag, headerClose, remainingDepth);
      if (element === TOO_DEEP) {
        if (failOnMaxDepth) throw new SafeXmlDepthExceededError(maxDepth);
        return results;
      }
      if (element === null) {
        pos = headerClose + 1;
        continue;
      }
      end = element.end;
      contentEnd = element.contentEnd;
    }
    found++;
    take({
      tag: currentTag,
      localName: local,
      prefix,
      raw: xml.slice(lt, end),
      attrs: safeExtractXmlAttributes(xml.slice(lt + 1, slash === NOT_FOUND ? headerClose : slash)),
      content: slash === NOT_FOUND ? xml.slice(headerClose + 1, contentEnd) : '',
      startIndex: lt,
      endIndex: end,
    });
    pos = end;
  }

  return results;
}

const XML_ENTITY_RE = /&(?:amp|lt|gt|quot|apos|#(\d+)|#x([0-9a-fA-F]+));/g;

/**
 * Linearly decodes standard XML entities in a single pass (W3C XML 1.0 §4.6).
 */
export function safeDecodeXmlEntities(str: string): string {
  if (!str || !str.includes('&')) return str || '';
  return str.replace(XML_ENTITY_RE, (match, dec: string | undefined, hex: string | undefined) => {
    if (dec !== undefined) {
      const cp = parseInt(dec, 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    if (hex !== undefined) {
      const cp = parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    switch (match) {
      case '&amp;':
        return '&';
      case '&lt;':
        return '<';
      case '&gt;':
        return '>';
      case '&quot;':
        return '"';
      case '&apos;':
        return "'";
      default:
        return match;
    }
  });
}

