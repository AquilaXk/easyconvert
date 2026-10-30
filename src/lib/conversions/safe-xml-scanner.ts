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

/**
 * Linearly extracts XML attributes from an opening tag header in O(N) time with zero regex backtracking.
 */
export function safeExtractXmlAttributes(tagHeader: string): SafeXmlAttributeMap {
  const attrs: SafeXmlAttributeMap = {};
  let i = 0;
  if (i < tagHeader.length && tagHeader[i] === '<') i++;
  // Skip tag name
  while (i < tagHeader.length && tagHeader.charCodeAt(i) > 32 && tagHeader[i] !== '/' && tagHeader[i] !== '>') i++;

  while (i < tagHeader.length) {
    // Skip whitespace
    while (i < tagHeader.length && tagHeader.charCodeAt(i) <= 32) i++;
    if (i >= tagHeader.length || tagHeader[i] === '/' || tagHeader[i] === '>') break;

    const keyStart = i;
    while (
      i < tagHeader.length &&
      tagHeader[i] !== '=' &&
      tagHeader.charCodeAt(i) > 32 &&
      tagHeader[i] !== '/' &&
      tagHeader[i] !== '>'
    ) {
      i++;
    }
    const key = tagHeader.slice(keyStart, i).trim();
    while (i < tagHeader.length && tagHeader.charCodeAt(i) <= 32) i++;

    if (i < tagHeader.length && tagHeader[i] === '=') {
      i++;
      while (i < tagHeader.length && tagHeader.charCodeAt(i) <= 32) i++;
      if (i < tagHeader.length && (tagHeader[i] === '"' || tagHeader[i] === "'")) {
        const quote = tagHeader[i++];
        const valStart = i;
        while (i < tagHeader.length && tagHeader[i] !== quote) i++;
        attrs[key] = safeDecodeXmlEntities(tagHeader.slice(valStart, i));
        if (i < tagHeader.length) i++; // skip closing quote
      } else {
        const valStart = i;
        while (
          i < tagHeader.length &&
          tagHeader.charCodeAt(i) > 32 &&
          tagHeader[i] !== '>' &&
          tagHeader[i] !== '/'
        ) {
          i++;
        }
        attrs[key] = safeDecodeXmlEntities(tagHeader.slice(valStart, i));
      }
    } else if (key) {
      attrs[key] = 'true';
    }
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

  const tagList = Array.isArray(tagName) ? tagName : [tagName];
  const targetMap = new Map<string, { targetLocal: string; targetPrefix: string | null }>();
  for (const t of tagList) {
    targetMap.set(t, {
      targetLocal: t.includes(':') ? t.split(':')[1] : t,
      targetPrefix: t.includes(':') ? t.split(':')[0] : null,
    });
  }

  const closingTagPresentMap = new Map<string, boolean>();
  let pos = 0;
  while (pos < xml.length && found < maxElements) {
    const nextLt = xml.indexOf('<', pos);
    if (nextLt === -1) break;

    // Skip comments <!-- ... -->
    if (xml.startsWith('<!--', nextLt)) {
      const endComment = xml.indexOf('-->', nextLt + 4);
      pos = endComment === -1 ? xml.length : endComment + 3;
      continue;
    }
    // Skip CDATA <![CDATA[ ... ]]>
    if (xml.startsWith('<![CDATA[', nextLt)) {
      const endCdata = xml.indexOf(']]>', nextLt + 9);
      pos = endCdata === -1 ? xml.length : endCdata + 3;
      continue;
    }
    // Skip processing instructions <? ... ?> or <! ... >
    if (xml[nextLt + 1] === '?' || xml[nextLt + 1] === '!') {
      const endPi = xml.indexOf('>', nextLt + 2);
      pos = endPi === -1 ? xml.length : endPi + 1;
      continue;
    }
    // Skip closing tags
    if (xml[nextLt + 1] === '/') {
      const endClose = xml.indexOf('>', nextLt + 2);
      pos = endClose === -1 ? xml.length : endClose + 1;
      continue;
    }

    // Read current opening tag name
    let tagEnd = nextLt + 1;
    while (
      tagEnd < xml.length &&
      xml.charCodeAt(tagEnd) > 32 &&
      xml[tagEnd] !== '>' &&
      xml[tagEnd] !== '/'
    ) {
      tagEnd++;
    }
    const currentTag = xml.slice(nextLt + 1, tagEnd);
    const currLocal = currentTag.includes(':') ? currentTag.split(':')[1] : currentTag;
    const currPrefix = currentTag.includes(':') ? currentTag.split(':')[0] : undefined;

    let isMatch = false;
    for (const [tName, spec] of targetMap) {
      if (spec.targetPrefix ? currentTag === tName : currLocal === spec.targetLocal) {
        isMatch = true;
        break;
      }
    }

    // Find the end of this tag's header '>' taking quotes into account
    let headerClose = tagEnd;
    let inQuote = false;
    let quoteChar = '';
    while (headerClose < xml.length) {
      const ch = xml[headerClose];
      if (inQuote) {
        if (ch === quoteChar) inQuote = false;
      } else if (ch === '"' || ch === "'") {
        inQuote = true;
        quoteChar = ch;
      } else if (ch === '>') {
        break;
      }
      headerClose++;
    }
    if (headerClose >= xml.length) break;

    let checkIdx = headerClose - 1;
    while (checkIdx > nextLt && xml.charCodeAt(checkIdx) <= 32) checkIdx--;
    const isSelfClosing = checkIdx > nextLt && xml[checkIdx] === '/';

    if (!isMatch) {
      pos = headerClose + 1;
      continue;
    }

    const attrs = safeExtractXmlAttributes(
      xml.slice(nextLt + 1, isSelfClosing ? checkIdx : headerClose)
    );

    if (isSelfClosing) {
      found++;
      take({
        tag: currentTag,
        localName: currLocal,
        prefix: currPrefix,
        raw: xml.slice(nextLt, headerClose + 1),
        attrs,
        content: '',
        startIndex: nextLt,
        endIndex: headerClose + 1,
      });
      pos = headerClose + 1;
      continue;
    }

    // If document has no closing tags for this element, skip to avoid search
    let hasClosing = closingTagPresentMap.get(currentTag);
    if (hasClosing === undefined) {
      hasClosing = xml.indexOf('</' + currLocal) !== -1 || xml.indexOf('</' + currentTag) !== -1;
      closingTagPresentMap.set(currentTag, hasClosing);
    }
    if (!hasClosing) {
      pos = headerClose + 1;
      continue;
    }

    // Helper to find the next matching closing tag allowing optional whitespace before '>' (W3C XML 1.0 §3.1)
    const findNextClosingTag = (fromIndex: number): { index: number; end: number } | null => {
      let p = fromIndex;
      const targetClose = '</' + currentTag;
      while (p < xml.length) {
        const idx = xml.indexOf(targetClose, p);
        if (idx === -1) return null;
        let c = idx + targetClose.length;
        while (c < xml.length && xml.charCodeAt(c) <= 32) c++;
        if (c < xml.length && xml[c] === '>') {
          return { index: idx, end: c + 1 };
        }
        p = idx + targetClose.length;
      }
      return null;
    };

    // Scan for matching closing tag with depth tracking
    const startTag = '<' + currentTag;
    let depth = 0;
    let searchPos = headerClose + 1;
    let matchedEnd = -1;
    let contentEnd = -1;

    while (searchPos < xml.length) {
      // Skip inner comments or CDATA
      if (xml.startsWith('<!--', searchPos)) {
        const endC = xml.indexOf('-->', searchPos + 4);
        searchPos = endC === -1 ? xml.length : endC + 3;
        continue;
      }
      if (xml.startsWith('<![CDATA[', searchPos)) {
        const endCd = xml.indexOf(']]>', searchPos + 9);
        searchPos = endCd === -1 ? xml.length : endCd + 3;
        continue;
      }

      const nextOpen = xml.indexOf(startTag, searchPos);
      const closeInfo = findNextClosingTag(searchPos);

      if (!closeInfo) break; // Unclosed tag, abort gracefully

      if (nextOpen !== -1 && nextOpen < closeInfo.index) {
        const charAfter = xml[nextOpen + startTag.length];
        if (charAfter === '>' || charAfter === '/' || charAfter <= ' ') {
          // Check if self-closing
          const nextHeaderClose = xml.indexOf('>', nextOpen);
          if (nextHeaderClose !== -1) {
            let slashIdx = nextHeaderClose - 1;
            while (slashIdx > nextOpen && xml.charCodeAt(slashIdx) <= 32) slashIdx--;
            if (slashIdx > nextOpen && xml[slashIdx] === '/') {
              // Self closing nested tag, does not increase depth
            } else {
              depth++;
              // Every later opening of the same name would walk as far for its own close: a nest this deep ends the scan, which keeps the
              // elements found before it and is linear in the input where going on was quadratic.
              if (depth > maxDepth) return results;
            }
            searchPos = nextHeaderClose + 1;
            continue;
          }
        }
        searchPos = nextOpen + startTag.length;
      } else {
        if (depth === 0) {
          contentEnd = closeInfo.index;
          matchedEnd = closeInfo.end;
          break;
        } else {
          depth--;
          searchPos = closeInfo.end;
        }
      }
    }

    if (matchedEnd !== -1) {
      found++;
      take({
        tag: currentTag,
        localName: currLocal,
        prefix: currPrefix,
        raw: xml.slice(nextLt, matchedEnd),
        attrs,
        content: xml.slice(headerClose + 1, contentEnd),
        startIndex: nextLt,
        endIndex: matchedEnd,
      });
      pos = matchedEnd;
    } else {
      pos = headerClose + 1;
    }
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
