/** Reading the header and the member spans of an object stream (ISO 32000-1 section 7.5.7). */
import { MAX_OBJECT_NUMBER_DIGITS, isDigit, isRegular, skipWhite } from './pdf-values';

/** Bytes one object stored in an object stream may span, whatever the offsets that follow it say. */
export const MAX_PDF_OBJSTM_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_LENGTH_DIGITS = 12;

/** Integer at the start of an object's body, or null when the body is not a plain non-negative integer. */
export function leadingInteger(src: string, from: number): number | null {
  const start = skipWhite(src, from);
  let end = start;
  while (isDigit(src.charCodeAt(end)) && end - start < MAX_LENGTH_DIGITS) end++;
  if (end === start || isRegular(src.charCodeAt(end))) return null;
  return Number(src.slice(start, end));
}

/** Reads up to `count` "<object number> <offset>" pairs from the first `first` characters of an object stream. */
export function readObjectStreamHeader(decoded: string, first: number, count: number): Array<{ num: number; offset: number }> {
  const members: Array<{ num: number; offset: number }> = [];
  let pos = 0;
  const nextInteger = (): number | null => {
    pos = skipWhite(decoded, pos);
    if (pos >= first) return null;
    const start = pos;
    while (isDigit(decoded.charCodeAt(pos)) && pos - start < MAX_OBJECT_NUMBER_DIGITS) pos++;
    if (pos === start || isRegular(decoded.charCodeAt(pos))) return null;
    return Number(decoded.slice(start, pos));
  };
  while (members.length < count) {
    const num = nextInteger();
    const offset = num === null ? null : nextInteger();
    if (num === null || offset === null) break;
    members.push({ num, offset });
  }
  return members;
}

/** An object stream read: its decoded text, /First, the "number offset" pairs of its header, and the span of each object. */
export interface ObjectStreamContents {
  decoded: string;
  first: number;
  members: Array<{ num: number; offset: number }>;
  spans: Map<number, MemberSpan>;
}

/** Where an object stored in an object stream begins and ends in the decoded text of the stream. */
export interface MemberSpan {
  start: number;
  end: number;
}

/**
 * The span of the object stored at each of `offsets` (distinct, ascending, inside `decoded`). An object ends where the next
 * higher offset begins, so spans never overlap and one pass covers them all, and it begins at its first token: the white
 * space and comments in front of it are skipped as the lexer of pdf.js (`Lexer.getObj`) and the tokenizers of qpdf and PDFBox
 * skip them, inside the span only, so that a comment with no line end ends with its object.
 */
export function memberSpans(decoded: string, offsets: number[]): Map<number, MemberSpan> {
  const spans = new Map<number, MemberSpan>();
  offsets.forEach((offset, index) => {
    const end = Math.min(offsets[index + 1] ?? decoded.length, offset + MAX_PDF_OBJSTM_ENTRY_BYTES);
    spans.set(offset, { start: skipWhite(decoded, offset, end), end });
  });
  return spans;
}
