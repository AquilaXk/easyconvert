import zlib from 'node:zlib';
import { PDFArray, PDFDict, PDFName, PDFPage, PDFRawStream, PDFRef } from 'pdf-lib';
import { DecompressionLimitError } from '../types';

/**
 * Strips prior invisible OCR sandwich text blocks (`3 Tr`, ISO 32000-1 §9.3.6 `Neither fill nor
 * stroke text`) from a PDF page's content stream sequence before a fresh OCR text layer is written
 * (`ocrMode: 'redo'` / `'force'`), while keeping every visible text block (`0..2 Tr`), path,
 * clipping operation, XObject image, and graphics state transition intact.
 *
 * Behavioural reference: OCRmyPDF (`ocrmypdf/OCRmyPDF`, `--redo-ocr` invisible text replacement;
 * zero MPL code copied). Content-stream lexical rules follow ISO 32000-1 §7.8.2 (`BT`/`ET`, `q`/`Q`,
 * `Tr`, `Tj`/`TJ`/`'`/`"`, inline images `BI`..`ID`..`EI`, nested literal strings, hex strings).
 */

export const MAX_PAGE_CONTENT_DECOMPRESSED_BYTES = 32 * 1024 * 1024;
const INVISIBLE_RENDER_MODE = 3;
const TEXT_SHOW_OPS = new Set(['Tj', 'TJ', "'", '"']);

interface StreamSlot {
  ref: PDFRef | null;
  stream: PDFRawStream;
  decoded: Uint8Array;
}

interface LexToken {
  kind: 'op' | 'num' | 'other';
  value: string;
  numValue: number;
  start: number;
  end: number;
}

function isWhitespace(b: number): boolean {
  return b === 0 || b === 9 || b === 10 || b === 12 || b === 13 || b === 32;
}

function isDelimiter(b: number): boolean {
  return (
    b === 0x28 || b === 0x29 || b === 0x3c || b === 0x3e || b === 0x5b ||
    b === 0x5d || b === 0x7b || b === 0x7d || b === 0x2f || b === 0x25
  );
}

function skipParenString(bytes: Uint8Array, from: number): number {
  let depth = 1;
  let i = from;
  while (i < bytes.length && depth > 0) {
    const b = bytes[i];
    if (b === 0x5c) i += 2;
    else {
      if (b === 0x28) depth++;
      else if (b === 0x29) depth--;
      i++;
    }
  }
  return i;
}

function skipInlineImageData(bytes: Uint8Array, from: number): number {
  for (let i = from; i + 1 < bytes.length; i++) {
    const isEi = bytes[i] === 0x45 && bytes[i + 1] === 0x49 && i > from && isWhitespace(bytes[i - 1]);
    if (isEi && (i + 2 >= bytes.length || isWhitespace(bytes[i + 2]) || isDelimiter(bytes[i + 2]))) {
      return i + 2;
    }
  }
  return bytes.length;
}

function readNextToken(bytes: Uint8Array, start: number): LexToken | null {
  let i = start;
  while (i < bytes.length) {
    if (isWhitespace(bytes[i])) {
      i++;
      continue;
    }
    if (bytes[i] === 0x25) {
      while (i < bytes.length && bytes[i] !== 10 && bytes[i] !== 13) i++;
      continue;
    }
    break;
  }
  if (i >= bytes.length) return null;
  const b = bytes[i];
  if (b === 0x28) return { kind: 'other', value: '(', numValue: NaN, start: i, end: skipParenString(bytes, i + 1) };
  if (b === 0x3c && bytes[i + 1] !== 0x3c) {
    let end = i + 1;
    while (end < bytes.length && bytes[end] !== 0x3e) end++;
    return { kind: 'other', value: '<', numValue: NaN, start: i, end: Math.min(bytes.length, end + 1) };
  }
  if (b === 0x2f) {
    let end = i + 1;
    while (end < bytes.length && !isWhitespace(bytes[end]) && !isDelimiter(bytes[end])) end++;
    return { kind: 'other', value: '/', numValue: NaN, start: i, end };
  }
  if (isDelimiter(b)) {
    const pair = (b === 0x3c || b === 0x3e) && bytes[i + 1] === b ? 2 : 1;
    return { kind: 'other', value: String.fromCharCode(b), numValue: NaN, start: i, end: i + pair };
  }
  let end = i;
  while (end < bytes.length && !isWhitespace(bytes[end]) && !isDelimiter(bytes[end])) end++;
  const word = Buffer.from(bytes.subarray(i, end)).toString('latin1');
  if (word === 'ID') {
    return { kind: 'op', value: 'ID', numValue: NaN, start: i, end: skipInlineImageData(bytes, end + 1) };
  }
  const parsed = /^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(word) ? Number(word) : NaN;
  if (Number.isFinite(parsed)) {
    return { kind: 'num', value: word, numValue: parsed, start: i, end };
  }
  return { kind: 'op', value: word, numValue: NaN, start: i, end };
}

interface GraphicsState {
  tr: number;
  stack: number[];
}

function applyNonTextOp(tok: LexToken, prevNum: number, gs: GraphicsState): void {
  if (tok.value === 'q') gs.stack.push(gs.tr);
  else if (tok.value === 'Q' && gs.stack.length > 0) gs.tr = gs.stack.pop() as number;
  else if (tok.value === 'Tr' && Number.isFinite(prevNum)) gs.tr = prevNum;
}

interface ScannedBtBlock {
  endOffset: number;
  hadTextShow: boolean;
  hadVisibleText: boolean;
  endTr: number;
}

function scanBtBlock(bytes: Uint8Array, afterBt: number, startTr: number): ScannedBtBlock | null {
  let cursor = afterBt;
  let tr = startTr;
  const localStack: number[] = [];
  let prevNum = NaN;
  let hadTextShow = false;
  let hadVisibleText = false;
  for (;;) {
    const tok = readNextToken(bytes, cursor);
    if (!tok) return null; // Unclosed BT across stream boundary: keep stream untouched.
    cursor = tok.end;
    if (tok.kind === 'num') {
      prevNum = tok.numValue;
      continue;
    }
    if (tok.kind === 'op') {
      if (tok.value === 'ET') return { endOffset: tok.end, hadTextShow, hadVisibleText, endTr: tr };
      if (tok.value === 'q') localStack.push(tr);
      else if (tok.value === 'Q' && localStack.length > 0) tr = localStack.pop() as number;
      else if (tok.value === 'Tr' && Number.isFinite(prevNum)) tr = prevNum;
      else if (TEXT_SHOW_OPS.has(tok.value)) {
        hadTextShow = true;
        if (tr !== INVISIBLE_RENDER_MODE) hadVisibleText = true;
      }
    }
    prevNum = NaN;
  }
}

export interface StrippedStreamResult {
  bytes: Uint8Array;
  strippedInvisibleBlocks: number;
  visibleTextBlocks: number;
}

/** Strips `BT ... ET` blocks whose text-showing operators all execute under `3 Tr` from `bytes`. */
export function stripInvisibleTextBlocks(bytes: Uint8Array, gs: GraphicsState = { tr: 0, stack: [] }): StrippedStreamResult {
  const chunks: Uint8Array[] = [];
  let copyFrom = 0;
  let cursor = 0;
  let prevNum = NaN;
  let strippedInvisibleBlocks = 0;
  let visibleTextBlocks = 0;

  for (;;) {
    const tok = readNextToken(bytes, cursor);
    if (!tok) break;
    if (tok.kind === 'num') {
      prevNum = tok.numValue;
      cursor = tok.end;
      continue;
    }
    if (tok.kind === 'op' && tok.value === 'BT') {
      const entryTr = gs.tr;
      const bt = scanBtBlock(bytes, tok.end, entryTr);
      if (!bt) break;
      gs.tr = bt.endTr;
      if (bt.hadVisibleText) visibleTextBlocks++;
      if (bt.hadTextShow && !bt.hadVisibleText) {
        chunks.push(bytes.subarray(copyFrom, tok.start));
        if (bt.endTr !== entryTr) {
          chunks.push(Buffer.from(` ${bt.endTr} Tr `, 'latin1'));
        } else {
          chunks.push(Buffer.from(' ', 'latin1'));
        }
        copyFrom = bt.endOffset;
        strippedInvisibleBlocks++;
      }
      cursor = bt.endOffset;
      prevNum = NaN;
      continue;
    }
    if (tok.kind === 'op') applyNonTextOp(tok, prevNum, gs);
    prevNum = NaN;
    cursor = tok.end;
  }

  if (strippedInvisibleBlocks === 0) {
    return { bytes, strippedInvisibleBlocks: 0, visibleTextBlocks };
  }
  chunks.push(bytes.subarray(copyFrom));
  return { bytes: Buffer.concat(chunks), strippedInvisibleBlocks, visibleTextBlocks };
}

function readSingleFilterName(filterObj: unknown): string | null {
  if (filterObj instanceof PDFName) return filterObj.decodeText();
  if (filterObj instanceof PDFArray && filterObj.size() === 1) {
    const first = filterObj.get(0);
    if (first instanceof PDFName) return first.decodeText();
  }
  return null;
}

function decodeContentStream(stream: PDFRawStream, budgetRemaining: number): Uint8Array | null {
  if (stream.dict.get(PDFName.of('DecodeParms')) !== undefined) return null;
  const filterObj = stream.dict.get(PDFName.of('Filter'));
  const raw = stream.getContents();
  if (filterObj === undefined) {
    if (raw.byteLength > budgetRemaining) {
      throw new DecompressionLimitError('PDF content stream exceeds the 32 MiB decompression budget.');
    }
    return raw;
  }
  if (readSingleFilterName(filterObj) !== 'FlateDecode') return null;
  try {
    return zlib.inflateSync(raw, { maxOutputLength: budgetRemaining });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ERR_BUFFER_TOO_LARGE') {
      throw new DecompressionLimitError('PDF FlateDecode content stream exceeds the 32 MiB decompression budget.');
    }
    return null;
  }
}

function collectPageStreamSlots(page: PDFPage): StreamSlot[] | null {
  const contents = page.node.get(PDFName.of('Contents'));
  if (!contents) return [];
  const ctx = page.doc.context;
  const refsAndObjs: Array<{ ref: PDFRef | null; obj: unknown }> = [];
  if (contents instanceof PDFRef) {
    const looked = ctx.lookup(contents);
    if (looked instanceof PDFArray) {
      for (let i = 0; i < looked.size(); i++) {
        const item = looked.get(i);
        refsAndObjs.push({ ref: item instanceof PDFRef ? item : null, obj: item instanceof PDFRef ? ctx.lookup(item) : item });
      }
    } else {
      refsAndObjs.push({ ref: contents, obj: looked });
    }
  } else if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) {
      const item = contents.get(i);
      refsAndObjs.push({ ref: item instanceof PDFRef ? item : null, obj: item instanceof PDFRef ? ctx.lookup(item) : item });
    }
  } else {
    refsAndObjs.push({ ref: null, obj: contents });
  }

  let budget = MAX_PAGE_CONTENT_DECOMPRESSED_BYTES;
  const slots: StreamSlot[] = [];
  for (const { ref, obj } of refsAndObjs) {
    if (!(obj instanceof PDFRawStream) || !(obj.dict instanceof PDFDict)) return null;
    const decoded = decodeContentStream(obj, budget);
    if (decoded === null) return null;
    budget -= decoded.byteLength;
    slots.push({ ref, stream: obj, decoded });
  }
  return slots;
}

export interface PageInvisibleTextSummary {
  strippedInvisibleBlocks: number;
  visibleTextBlocks: number;
}

/**
 * Strips prior `3 Tr` invisible OCR text objects from `page` in place and reports how many
 * invisible vs visible (`0..2 Tr`) text blocks were encountered across the page's content streams.
 */
export function stripPageInvisibleOcrText(page: PDFPage): PageInvisibleTextSummary {
  const slots = collectPageStreamSlots(page);
  if (!slots || slots.length === 0) return { strippedInvisibleBlocks: 0, visibleTextBlocks: 0 };
  const gs: GraphicsState = { tr: 0, stack: [] };
  let totalStripped = 0;
  let totalVisible = 0;
  for (const slot of slots) {
    const res = stripInvisibleTextBlocks(slot.decoded, gs);
    totalStripped += res.strippedInvisibleBlocks;
    totalVisible += res.visibleTextBlocks;
    if (res.strippedInvisibleBlocks > 0) {
      const updated = page.doc.context.flateStream(res.bytes);
      if (slot.ref) {
        page.doc.context.assign(slot.ref, updated);
      } else {
        page.node.set(PDFName.of('Contents'), page.doc.context.register(updated));
      }
    }
  }
  return { strippedInvisibleBlocks: totalStripped, visibleTextBlocks: totalVisible };
}
