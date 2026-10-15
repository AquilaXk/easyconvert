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

export function buildWordBinary(options: WordBuildOptions): Buffer {
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

  const word = Buffer.alloc(cursor);
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

  const table = Buffer.alloc(TEXT_AREA_START);
  clx.copy(table, 0);
  const clxPair = 154 + CLX_FC_LCB_INDEX * 8;
  word.writeUInt32LE(0, clxPair);
  word.writeUInt32LE(clx.length, clxPair + 4);

  const padded = word.length < FIB_BYTES ? Buffer.concat([word, Buffer.alloc(FIB_BYTES - word.length)]) : word;
  return buildCompoundFile([
    { name: 'WordDocument', data: padded },
    { name: options.tableStream0 ? '0Table' : '1Table', data: table },
  ]);
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
