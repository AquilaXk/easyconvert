import { type ContentVisitor, PdfDocument, PdfStructureError } from './pdf-document';
import { PDF_CONTENT_MAX_STATE_DEPTH } from './pdf-text-types';

/**
 * A bounded look at the streams a PDF's text depends on, before pdfjs reads it. pdfjs inflates a stream to the end
 * whatever its size, so a few kilobytes that expand to gigabytes would cost it seconds and memory the thread's heap
 * limit does not count (buffers live outside the heap). Here every content stream the page tree draws, and every
 * ToUnicode map, is decoded under the per-stream and per-document byte budgets of bounded-inflate.ts, and the
 * structure walk is bounded by the object, page and nesting limits of pdf-document.ts.
 * @throws DecompressionLimitError (413) when a stream or the document would decode past its budget.
 * @throws PdfStructureError (400) when the object graph exceeds a structural limit.
 * A stream with a filter this reader does not decode is left to pdfjs.
 * Content streams are also scanned for graphics-state nesting (`q`): pdfjs copies the state at every `q`, so a stream
 * of tens of thousands of unclosed `q` operators costs it quadratic time. Real documents nest a few dozen levels.
 * @throws CorruptStreamError (400) when a stream's compressed data is malformed.
 * `visitContent`, when given, is called with each content stream as well, so a caller that reads them does not decode them again.
 * @returns the document read, so the caller can read more of it without indexing the file again.
 */
export function assertPdfStreamsWithinLimits(pdf: Buffer, visitContent?: ContentVisitor): PdfDocument {
  const document = new PdfDocument(pdf, undefined, true);
  document.contentStreams((content, pageIndex) => {
    assertStateDepthWithinLimit(content);
    visitContent?.(content, pageIndex);
  });
  document.toUnicodeStreams(() => undefined);
  return document;
}

/**
 * The part of `assertPdfStreamsWithinLimits` for a job that reads the page content as pdfjs gives it but has pdfjs build
 * the annotations: the annotation count, and every appearance stream and the forms it draws, under the same budgets.
 * @throws the errors of `assertPdfStreamsWithinLimits`.
 */
export function assertPdfAnnotationStreamsWithinLimits(pdf: Buffer): void {
  new PdfDocument(pdf, undefined, true).annotationAppearanceStreams(assertStateDepthWithinLimit);
}

function assertStateDepthWithinLimit(content: string): void {
  if (graphicsStateDepth(content, PDF_CONTENT_MAX_STATE_DEPTH) > PDF_CONTENT_MAX_STATE_DEPTH) {
    throw new PdfStructureError(`A content stream nests the graphics state deeper than ${PDF_CONTENT_MAX_STATE_DEPTH} levels`);
  }
}

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const CHAR_OPEN_PAREN = 0x28;
const CHAR_CLOSE_PAREN = 0x29;
const CHAR_BACKSLASH = 0x5c;
const CHAR_LESS = 0x3c;
const CHAR_SLASH = 0x2f;
const CHAR_PERCENT = 0x25;
const CHAR_LINE_FEED = 0x0a;
const CHAR_CARRIAGE_RETURN = 0x0d;

/** Index just past a literal string that starts at `start` (ISO 32000-1 section 7.3.4.2: nested parentheses, escapes). */
function skipLiteralString(content: string, start: number): number {
  let depth = 0;
  for (let index = start; index < content.length; index++) {
    const code = content.charCodeAt(index);
    if (code === CHAR_BACKSLASH) index++;
    else if (code === CHAR_OPEN_PAREN) depth++;
    else if (code === CHAR_CLOSE_PAREN && --depth === 0) return index + 1;
  }
  return content.length;
}

/** Index just past the inline image data that follows an ID operator: up to a delimited EI. */
function skipInlineImage(content: string, start: number): number {
  const end = /[\0\t\n\f\r ]EI(?=[\0\t\n\f\r ]|$)/g;
  end.lastIndex = start;
  const match = end.exec(content);
  return match === null ? content.length : match.index + match[0].length;
}

/**
 * Calls `onToken` with every regular token of a content stream (operators and numeric operands) and where it ends, in one
 * lexical pass: strings, hex strings, names, comments and inline image data are skipped, so a token inside them does not count.
 * For an `ID` operator the end given is that of its inline image data, up to a delimited EI. Linear in the stream length; the
 * pass stops when `onToken` returns true.
 */
export function forEachContentToken(content: string, onToken: (token: string, start: number, end: number) => boolean | void): void {
  let index = 0;
  while (index < content.length) {
    const code = content.charCodeAt(index);
    if (WHITESPACE.has(code)) {
      index++;
    } else if (code === CHAR_PERCENT) {
      while (index < content.length && content.charCodeAt(index) !== CHAR_LINE_FEED && content.charCodeAt(index) !== CHAR_CARRIAGE_RETURN) index++;
    } else if (code === CHAR_OPEN_PAREN) {
      index = skipLiteralString(content, index);
    } else if (code === CHAR_LESS && content.charCodeAt(index + 1) !== CHAR_LESS) {
      const close = content.indexOf('>', index);
      index = close < 0 ? content.length : close + 1;
    } else if (DELIMITERS.has(code)) {
      index++;
      if (code === CHAR_SLASH) {
        while (index < content.length && !WHITESPACE.has(content.charCodeAt(index)) && !DELIMITERS.has(content.charCodeAt(index))) index++;
      }
    } else {
      const start = index;
      while (index < content.length && !WHITESPACE.has(content.charCodeAt(index)) && !DELIMITERS.has(content.charCodeAt(index))) index++;
      const token = content.slice(start, index);
      if (token === 'ID') index = skipInlineImage(content, index);
      if (onToken(token, start, index) === true) return;
    }
  }
}

/**
 * Deepest nesting of q operators in a content stream, found with `forEachContentToken`. Linear in the stream length; the scan
 * stops as soon as the depth passes `stopAbove`.
 */
export function graphicsStateDepth(content: string, stopAbove = Number.POSITIVE_INFINITY): number {
  let depth = 0;
  let deepest = 0;
  forEachContentToken(content, (token) => {
    if (token === 'q') {
      depth++;
      deepest = Math.max(deepest, depth);
      return deepest > stopAbove;
    }
    if (token === 'Q') depth = Math.max(0, depth - 1);
    return false;
  });
  return deepest;
}
