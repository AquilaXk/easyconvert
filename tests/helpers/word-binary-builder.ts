import { buildCompoundFile } from './cfb-craft';

/**
 * Hand-written Word 97-2003 binary documents, authored from [MS-DOC]: a FIB with the piece-table
 * entry (fcClx, lcbClx), a table stream holding the CLX, and text pieces placed in the WordDocument
 * stream in an order the test chooses. It shares no code with the reader under test.
 */

const FIB_BYTES = 900;
const TEXT_AREA_START = 4096;
const W_IDENT = 0xa5ec;
const N_FIB_WORD97 = 0x00c1;
const FLAG_ENCRYPTED = 0x0100;
const FLAG_TABLE_1 = 0x0200;
const CSW = 14;
const CSLW = 22;
const FC_LCB_PAIRS = 93;
const CLX_FC_LCB_INDEX = 33;
const STSH_FC_LCB_INDEX = 1;
const CHPX_BTE_FC_LCB_INDEX = 12;
const FFN_FC_LCB_INDEX = 15;
const FKP_BYTES = 512;
const FKP_MAX_RUNS = 101;
const SPRM_C_RG_FTC0 = 0x4a4f;
const SPRM_C_RG_FTC1 = 0x4a50;
const SPRM_C_RG_FTC2 = 0x4a51;
const SPRM_C_SYMBOL = 0x6a09;
const SPRM_C_F_SPEC = 0x0855;
const FFN_FIXED_BYTES = 39;
const FC_COMPRESSED = 0x40000000;

/** Windows-1252 bytes of the characters the tests use above U+007F; written out by hand from the code page chart. */
const CP1252_EXTRA: Readonly<Record<string, number>> = {
  '€': 0x80,
  '…': 0x85,
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '–': 0x96,
  '—': 0x97,
  '™': 0x99,
};

export interface WordPiece {
  text: string;
  /** Stored as one byte per character (windows-1252) instead of UTF-16LE. */
  compressed: boolean;
}

/** Character formatting of the next `chars` characters of the main story ([MS-DOC] 2.9.? Chpx): font indexes into the font table. */
export interface WordRun {
  chars: number;
  ftcAscii?: number;
  ftcFarEast?: number;
  ftcOther?: number;
  /** A Symbol field character: the placeholder 0x28 in the text plus sprmCSymbol (font, character). */
  symbol?: { ftc: number; xchar: number };
}

export interface WordBuildOptions {
  pieces: readonly WordPiece[];
  /** Places the pieces in the WordDocument stream in reverse order, so the stream is not in text order. */
  reversePhysicalOrder?: boolean;
  /** Writes the CLX to 0Table instead of 1Table. */
  tableStream0?: boolean;
  encrypted?: boolean;
  /** A story after the main text (footnotes); it must not appear in the extracted text. */
  footnote?: string;
  /** Adds this many bytes to every piece offset, pushing the pieces past the end of the stream. */
  fcShift?: number;
  /** Leading Prc entry with this many property bytes, which the CLX reader has to skip. */
  prcBytes?: number;
  /** Font names of the SttbfFfn font table; a run's font index selects one. */
  fonts?: readonly string[];
  /** The default character fonts of the style sheet (rgftcStandardChpStsh): ASCII, East Asian, other. */
  styleFonts?: { ascii: number; farEast: number; other: number };
  /** Character formatting of the main story, in character order; characters past the last run carry none. */
  runs?: readonly WordRun[];
}

/** Where the builder placed the structures, so a test can corrupt exactly one of them. */
export interface WordBinaryLayout {
  /** Offset in the table stream of the PlcBteChpx and its length. */
  plcBteChpx: { offset: number; length: number };
  fonts: { offset: number; length: number };
  styleSheet: { offset: number; length: number };
  /** Offsets in the WordDocument stream of the FKP pages, in PlcBteChpx order. */
  fkpPages: number[];
  /** Offset in the WordDocument stream of the FIB (FibRgFcLcb97) pair for an index. */
  pairOffset: (index: number) => number;
}

export interface WordBinaryParts {
  word: Buffer;
  table: Buffer;
  layout: WordBinaryLayout;
}

function encodeCompressed(text: string): Buffer {
  const out = Buffer.alloc(text.length);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = text.charCodeAt(i);
    const mapped = CP1252_EXTRA[ch];
    if (mapped !== undefined) {
      out[i] = mapped;
    } else if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) {
      out[i] = code;
    } else {
      throw new Error(`U+${code.toString(16)} cannot be stored in a compressed Word piece`);
    }
  }
  return out;
}

function sprm(opcode: number, ...operand: number[]): Buffer {
  const out = Buffer.alloc(2 + operand.length * 2);
  out.writeUInt16LE(opcode, 0);
  operand.forEach((value, i) => out.writeUInt16LE(value, 2 + i * 2));
  return out;
}

function chpxOf(run: WordRun): Buffer {
  const sprms: Buffer[] = [];
  if (run.ftcAscii !== undefined) sprms.push(sprm(SPRM_C_RG_FTC0, run.ftcAscii));
  if (run.ftcFarEast !== undefined) sprms.push(sprm(SPRM_C_RG_FTC1, run.ftcFarEast));
  if (run.ftcOther !== undefined) sprms.push(sprm(SPRM_C_RG_FTC2, run.ftcOther));
  if (run.symbol !== undefined) {
    sprms.push(Buffer.from([SPRM_C_F_SPEC & 0xff, SPRM_C_F_SPEC >> 8, 1]));
    sprms.push(sprm(SPRM_C_SYMBOL, run.symbol.ftc, run.symbol.xchar));
  }
  const grpprl = Buffer.concat(sprms);
  return Buffer.concat([Buffer.from([grpprl.length]), grpprl]);
}

/** One FKP page ([MS-DOC] 2.9.? ChpxFkp): rgfc, rgb of word offsets, the Chpx structures, crun in the last byte. */
function fkpPage(boundaries: readonly number[], chpx: readonly (Buffer | null)[]): Buffer {
  const page = Buffer.alloc(FKP_BYTES);
  const count = chpx.length;
  boundaries.forEach((fc, i) => page.writeUInt32LE(fc, i * 4));
  let cursor = (count + 1) * 4 + count;
  cursor += cursor % 2;
  chpx.forEach((bytes, i) => {
    if (bytes === null) return;
    page[(count + 1) * 4 + i] = cursor / 2;
    bytes.copy(page, cursor);
    cursor += bytes.length + (bytes.length % 2);
  });
  page[FKP_BYTES - 1] = count;
  return page;
}

function fontTable(names: readonly string[]): Buffer {
  const entries = names.map((name) => {
    const text = Buffer.from(`${name}\0`, 'utf16le');
    const entry = Buffer.alloc(1 + FFN_FIXED_BYTES + text.length);
    entry[0] = FFN_FIXED_BYTES + text.length;
    text.copy(entry, 1 + FFN_FIXED_BYTES);
    return entry;
  });
  return Buffer.concat([uint16(names.length), uint16(0), ...entries]);
}

/** The STSH: cbStshi, then the Stshif with the default character fonts, no styles. */
function styleSheet(fonts: { ascii: number; farEast: number; other: number }): Buffer {
  const stshi = Buffer.alloc(20);
  stshi.writeUInt16LE(fonts.ascii, 12);
  stshi.writeUInt16LE(fonts.farEast, 14);
  stshi.writeUInt16LE(fonts.other, 16);
  return Buffer.concat([uint16(stshi.length), stshi]);
}

export function buildWordBinary(options: WordBuildOptions): Buffer {
  const parts = buildWordBinaryParts(options);
  return buildCompoundFile([
    { name: 'WordDocument', data: parts.word },
    { name: options.tableStream0 ? '0Table' : '1Table', data: parts.table },
  ]);
}

export function buildWordBinaryParts(options: WordBuildOptions): WordBinaryParts {
  const pieces: WordPiece[] = [...options.pieces];
  const mainChars = pieces.reduce((sum, piece) => sum + piece.text.length, 0);
  if (options.footnote !== undefined) pieces.push({ text: options.footnote, compressed: false });
  const footnoteChars = options.footnote?.length ?? 0;

  const encoded = pieces.map((piece) => (piece.compressed ? encodeCompressed(piece.text) : Buffer.from(piece.text, 'utf16le')));
  const physicalOrder = encoded.map((_, i) => i);
  if (options.reversePhysicalOrder) physicalOrder.reverse();
  const offsets = new Array<number>(encoded.length);
  let cursor = TEXT_AREA_START;
  for (const index of physicalOrder) {
    offsets[index] = cursor;
    cursor += encoded[index].length;
  }

  // The character runs become FKP pages placed after the text on 512-byte boundaries, ascending by file offset.
  const pieceStartCp: number[] = [];
  let cpCursor = 0;
  pieces.forEach((piece) => {
    pieceStartCp.push(cpCursor);
    cpCursor += piece.text.length;
  });
  const segments: Array<{ fcStart: number; fcEnd: number; chpx: Buffer | null }> = [];
  const runs = options.runs ?? [];
  let runIndex = 0;
  let runLeft = runs.length > 0 ? runs[0].chars : 0;
  pieces.forEach((piece, pieceIndex) => {
    const bytesPerChar = piece.compressed ? 1 : 2;
    let fc = offsets[pieceIndex];
    let left = piece.text.length;
    const inMain = pieceIndex < options.pieces.length;
    while (left > 0) {
      while (inMain && runIndex < runs.length && runLeft === 0) {
        runIndex++;
        runLeft = runIndex < runs.length ? runs[runIndex].chars : 0;
      }
      const run = inMain && runIndex < runs.length ? runs[runIndex] : undefined;
      const take = run === undefined ? left : Math.min(left, runLeft);
      segments.push({ fcStart: fc, fcEnd: fc + take * bytesPerChar, chpx: run === undefined ? null : chpxOf(run) });
      fc += take * bytesPerChar;
      left -= take;
      if (run !== undefined) runLeft -= take;
    }
  });
  segments.sort((a, b) => a.fcStart - b.fcStart);
  const fkpPages: Buffer[] = [];
  const fkpBoundaries: number[] = [];
  if (options.runs !== undefined) {
    // A page holds as many runs as fit: 4 bytes of file offset and 1 byte of Chpx offset per run, the final offset, the Chpx structures.
    for (let at = 0; at < segments.length; ) {
      let size = 4 + 1;
      let end = at;
      while (end < segments.length && end - at < FKP_MAX_RUNS) {
        const chpxSize = segments[end].chpx === null ? 0 : segments[end].chpx!.length + (segments[end].chpx!.length % 2);
        if (size + 5 + chpxSize + 1 > FKP_BYTES - 1) break;
        size += 5 + chpxSize;
        end++;
      }
      const slice = segments.slice(at, end);
      fkpBoundaries.push(slice[0].fcStart);
      fkpPages.push(fkpPage([...slice.map((segment) => segment.fcStart), slice[slice.length - 1].fcEnd], slice.map((segment) => segment.chpx)));
      at = end;
    }
    fkpBoundaries.push(segments[segments.length - 1].fcEnd);
  }
  const fkpStart = Math.ceil(cursor / FKP_BYTES) * FKP_BYTES;
  const wordLength = options.runs === undefined ? cursor : fkpStart + fkpPages.length * FKP_BYTES;

  const word = Buffer.alloc(wordLength);
  word.writeUInt16LE(W_IDENT, 0);
  word.writeUInt16LE(N_FIB_WORD97, 2);
  word.writeUInt16LE((options.encrypted ? FLAG_ENCRYPTED : 0) | (options.tableStream0 ? 0 : FLAG_TABLE_1), 10);
  word.writeUInt16LE(CSW, 32);
  word.writeUInt16LE(CSLW, 62);
  word.writeUInt32LE(mainChars, 76);
  word.writeUInt32LE(footnoteChars, 80);
  word.writeUInt16LE(FC_LCB_PAIRS, 152);
  encoded.forEach((bytes, i) => bytes.copy(word, offsets[i]));

  const prc = options.prcBytes === undefined ? Buffer.alloc(0) : Buffer.concat([Buffer.from([0x01]), uint16(options.prcBytes), Buffer.alloc(options.prcBytes, 0xaa)]);
  const plcPcd = Buffer.alloc((pieces.length + 1) * 4 + pieces.length * 8);
  let cp = 0;
  pieces.forEach((piece, i) => {
    plcPcd.writeUInt32LE(cp, i * 4);
    const shifted = offsets[i] + (options.fcShift ?? 0);
    const fcBase = pieces[i].compressed ? shifted * 2 : shifted;
    plcPcd.writeUInt32LE((pieces[i].compressed ? FC_COMPRESSED | fcBase : fcBase) >>> 0, (pieces.length + 1) * 4 + i * 8 + 2);
    cp += piece.text.length;
  });
  plcPcd.writeUInt32LE(cp + 1, pieces.length * 4);
  const pcdt = Buffer.concat([Buffer.from([0x02]), uint32(plcPcd.length), plcPcd]);
  const clx = Buffer.concat([prc, pcdt]);

  const tableParts: Buffer[] = [clx];
  let tableCursor = clx.length;
  const place = (bytes: Buffer, pairIndex: number): { offset: number; length: number } => {
    const offset = tableCursor + (tableCursor % 4);
    tableParts.push(Buffer.alloc(offset - tableCursor), bytes);
    tableCursor = offset + bytes.length;
    const pair = 154 + pairIndex * 8;
    word.writeUInt32LE(offset, pair);
    word.writeUInt32LE(bytes.length, pair + 4);
    return { offset, length: bytes.length };
  };
  const clxPair = 154 + CLX_FC_LCB_INDEX * 8;
  word.writeUInt32LE(0, clxPair);
  word.writeUInt32LE(clx.length, clxPair + 4);

  const unplaced = { offset: 0, length: 0 };
  const fonts = options.fonts === undefined ? unplaced : place(fontTable(options.fonts), FFN_FC_LCB_INDEX);
  const styles = options.styleFonts === undefined ? unplaced : place(styleSheet(options.styleFonts), STSH_FC_LCB_INDEX);
  let plcBteChpx = unplaced;
  if (options.runs !== undefined) {
    const plc = Buffer.alloc(fkpBoundaries.length * 4 + fkpPages.length * 4);
    fkpBoundaries.forEach((fc, i) => plc.writeUInt32LE(fc, i * 4));
    fkpPages.forEach((_, i) => plc.writeUInt32LE((fkpStart + i * FKP_BYTES) / FKP_BYTES, fkpBoundaries.length * 4 + i * 4));
    plcBteChpx = place(plc, CHPX_BTE_FC_LCB_INDEX);
    fkpPages.forEach((page, i) => page.copy(word, fkpStart + i * FKP_BYTES));
  }
  const table = Buffer.concat([...tableParts, Buffer.alloc(Math.max(0, TEXT_AREA_START - tableCursor))]);

  const padded = word.length < FIB_BYTES ? Buffer.concat([word, Buffer.alloc(FIB_BYTES - word.length)]) : word;
  return {
    word: padded,
    table,
    layout: {
      plcBteChpx,
      fonts,
      styleSheet: styles,
      fkpPages: fkpPages.map((_, i) => fkpStart + i * FKP_BYTES),
      pairOffset: (index: number) => 154 + index * 8,
    },
  };
}

function uint16(value: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value);
  return b;
}

function uint32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);
  return b;
}
