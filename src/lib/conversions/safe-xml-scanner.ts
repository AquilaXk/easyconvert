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

export interface SafeXmlScannerOptions {
  maxDepth?: number;
  maxElements?: number;
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
function withScannerDefaults(options: SafeXmlScannerOptions): Required<Pick<SafeXmlScannerOptions, 'maxElements' | 'maxDepth'>> & Pick<SafeXmlScannerOptions, 'onElement'> {
  return {
    maxElements: options.maxElements ?? SAFE_XML_SCANNER_DEFAULTS.maxElements,
    maxDepth: options.maxDepth ?? SAFE_XML_SCANNER_DEFAULTS.maxDepth,
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
  private readonly closeTag: string;

  constructor(private readonly xml: string, tag: string) {
    this.startTag = '<' + tag;
    this.closeTag = '</' + tag;
    this.nextOpening = new ForwardSearch((from) => xml.indexOf(this.startTag, from));
    this.nextClosing = new ForwardSearch((from) => this.searchClosing(from));
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

/** Whether a name is one of the wanted ones: a wanted name with a prefix must match whole, one without matches the local part. */
function matchesTarget(specs: TargetSpec[], tag: string, local: string): boolean {
  return specs.some((spec) => (spec.prefix ? tag === spec.name : local === spec.local));
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

/** The position after a comment or a CDATA section that starts at `at`, or -1 when none does. */
function skipCommentOrCdata(xml: string, at: number): number {
  if (xml.startsWith('<!--', at)) return afterMarker(xml, '-->', at + 4);
  if (xml.startsWith('<![CDATA[', at)) return afterMarker(xml, ']]>', at + 9);
  return NOT_FOUND;
}

/**
 * The `>` of the opening of the same tag at `open` that an element holds, or -1 when the text there is not such an opening
 * (the name goes on, as in `<rowx`, or the header never ends).
 */
function nestedOpeningClose(xml: string, open: number, startTagLength: number): number {
  const code = xml.charCodeAt(open + startTagLength);
  if (!(code === CHAR_GT || code === CHAR_SLASH || code <= 32)) return NOT_FOUND;
  return xml.indexOf('>', open);
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
    const skipped = skipCommentOrCdata(xml, searchPos);
    if (skipped !== NOT_FOUND) {
      searchPos = skipped;
      continue;
    }
    const closing = tag.nextClosing.next(searchPos);
    if (closing === NOT_FOUND) return null;

    const opening = tag.nextOpening.next(searchPos);
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
  const { maxElements, maxDepth, onElement } = withScannerDefaults(options);
  let found = 0;
  const take = onElement ?? ((element: SafeXmlElement): void => void results.push(element));
  const specs = targetSpecs(tagName);
  const searches = new Map<string, TagSearch>();

  let pos = 0;
  while (pos < xml.length && found < maxElements) {
    const lt = xml.indexOf('<', pos);
    if (lt === NOT_FOUND) break;
    const skipped = skipNonElement(xml, lt);
    if (skipped !== NOT_FOUND) {
      pos = skipped;
      continue;
    }

    const tagEnd = tagNameEnd(xml, lt);
    const currentTag = xml.slice(lt + 1, tagEnd);
    const { local, prefix } = splitName(currentTag);
    const headerClose = headerCloseFrom(xml, tagEnd);
    if (headerClose >= xml.length) break;
    if (!matchesTarget(specs, currentTag, local)) {
      pos = headerClose + 1;
      continue;
    }

    const slash = selfClosingSlash(xml, lt, headerClose);
    let end = headerClose + 1;
    let contentEnd = lt;
    if (slash === NOT_FOUND) {
      let tag = searches.get(currentTag);
      if (!tag) searches.set(currentTag, (tag = new TagSearch(xml, currentTag)));
      const element = findElementEnd(xml, tag, headerClose, maxDepth);
      if (element === TOO_DEEP) return results;
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

/**
 * Linearly decodes standard XML entities and strips tags safely in O(N) time.
 */
export function safeDecodeXmlEntities(str: string): string {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = parseInt(hex, 16);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
    });
}
