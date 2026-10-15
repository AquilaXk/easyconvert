import { reportConversionWarning } from '../conversion-warnings';
import { isSymbolFontName, isSymbolFontPrivateUse, mapSymbolFontCharacter, SYMBOL_FONT_PRIVATE_USE_BASE, symbolReplacementWarning, undrawableSymbolWarning } from '../symbol-font-map';
import { CheckedReader, readCfbStreams, requireCfbStream } from './cfb-streams';
import { CharacterFormatting, type CharacterFormattingLocations } from './doc-character-formatting';
import { EncryptedOfficeDocumentError, LegacyOfficeFormatError } from './legacy-office-errors';
import { decodeWindows1252 } from './windows-1252';

/**
 * Text reader for Word 97-2003 binary documents ([MS-DOC] 2.5 FIB, 2.9.38 Clx, 2.9.177 PlcPcd).
 * It reads the main document story through the CLX piece table. The only formatting it interprets is the font of a
 * character (doc-character-formatting.ts), to map the private-use characters of symbol fonts to Unicode.
 */

const LABEL = 'Word document';
const WORD_DOCUMENT_STREAM = 'WordDocument';

/** Largest number of pieces one piece table may declare. */
export const DOC_MAX_PIECES = 262_144;
/** Largest number of characters the main document story may hold. */
export const DOC_MAX_TEXT_CHARS = 64 * 1024 * 1024;
/** Deepest nesting of fields (0x13 ... 0x15) that is followed. */
export const DOC_MAX_FIELD_NESTING = 256;

// FibBase ([MS-DOC] 2.5.2).
const FIB_WIDENT = 0xa5ec;
const FIB_WIDENT_OFFSET = 0;
const FIB_NFIB_OFFSET = 2;
const FIB_FLAGS_OFFSET = 10;
const FIB_FLAG_ENCRYPTED = 0x0100;
const FIB_FLAG_WHICH_TABLE_STREAM = 0x0200;
/** nFib of Word 97, the oldest layout with the piece-table FIB used here. */
const FIB_MIN_NFIB = 0x00c1;
// FibRgW97 and FibRgLw97 sizes are fixed by csw and cslw.
const FIB_CSW_OFFSET = 32;
const FIB_CSW_VALUE = 14;
const FIB_CSLW_OFFSET = 62;
const FIB_CSLW_VALUE = 22;
const FIB_CCP_TEXT_OFFSET = 76;
const FIB_CB_RG_FC_LCB_OFFSET = 152;
const FIB_RG_FC_LCB_OFFSET = 154;
const FC_LCB_PAIR_BYTES = 8;
/** Index of the (fcClx, lcbClx) pair in FibRgFcLcb97. */
const FC_LCB_CLX_INDEX = 33;
/** Indexes of the (fc, lcb) pairs of the style sheet, the character formatting table and the font table in FibRgFcLcb97. */
const FC_LCB_STSH_INDEX = 1;
const FC_LCB_PLC_BTE_CHPX_INDEX = 12;
const FC_LCB_STTB_FFN_INDEX = 15;

// Clx ([MS-DOC] 2.9.38).
const CLX_PRC = 0x01;
const CLX_PCDT = 0x02;
const PRC_HEADER_BYTES = 3;
const PCDT_HEADER_BYTES = 5;
// PlcPcd: (n + 1) character positions of 4 bytes, then n Pcd structures of 8 bytes.
const CP_BYTES = 4;
const PCD_BYTES = 8;
const PCD_FC_OFFSET = 2;
const FC_COMPRESSED_FLAG = 0x40000000;
const FC_OFFSET_MASK = 0x3fffffff;
const COMPRESSED_BYTES_PER_CHAR = 1;
const UNICODE_BYTES_PER_CHAR = 2;

// Special characters of the main story ([MS-DOC] 2.4.? Special Characters).
const CH_CELL_OR_ROW_END = 0x07;
const CH_TAB = 0x09;
const CH_VERTICAL_TAB = 0x0b;
const CH_PAGE_OR_SECTION_BREAK = 0x0c;
const CH_PARAGRAPH_END = 0x0d;
const CH_FIELD_BEGIN = 0x13;
const CH_FIELD_SEPARATOR = 0x14;
const CH_FIELD_END = 0x15;
const CH_NON_BREAKING_HYPHEN = 0x1e;
const CH_OPTIONAL_HYPHEN = 0x1f;
/** The placeholder a Symbol field character (sprmCSymbol) stands for in the text. */
const CH_SYMBOL_PLACEHOLDER = 0x28;
const REPLACEMENT_CHARACTER = '\uFFFD';
const SYMBOL_FONT_LAST_BYTE = 0xff;
const SURROGATE_FIRST = 0xd800;
const SURROGATE_LAST = 0xdfff;
const FIRST_PRINTABLE = 0x20;
const FIRST_C1_CONTROL = 0x80;
const LAST_C1_CONTROL = 0x9f;
const NEWLINE_CODE = 0x0a;

interface Piece {
  cpStart: number;
  cpEnd: number;
  byteOffset: number;
  compressed: boolean;
}

interface FibInfo {
  ccpText: number;
  tableStream: string;
  fcClx: number;
  lcbClx: number;
  formatting: CharacterFormattingLocations;
}

function readFib(word: CheckedReader): FibInfo {
  if (word.u16(FIB_WIDENT_OFFSET) !== FIB_WIDENT) {
    throw new LegacyOfficeFormatError(`${LABEL}: the WordDocument stream has no Word binary signature.`);
  }
  if (word.u16(FIB_NFIB_OFFSET) < FIB_MIN_NFIB) {
    throw new LegacyOfficeFormatError(`${LABEL}: documents older than Word 97 are not supported.`);
  }
  const flags = word.u16(FIB_FLAGS_OFFSET);
  if (flags & FIB_FLAG_ENCRYPTED) {
    throw new EncryptedOfficeDocumentError(`${LABEL}: the document is encrypted or password protected.`);
  }
  if (word.u16(FIB_CSW_OFFSET) !== FIB_CSW_VALUE || word.u16(FIB_CSLW_OFFSET) !== FIB_CSLW_VALUE) {
    throw new LegacyOfficeFormatError(`${LABEL}: the file information block has an unexpected layout.`);
  }
  const pairCount = word.u16(FIB_CB_RG_FC_LCB_OFFSET);
  if (pairCount <= FC_LCB_CLX_INDEX) {
    throw new LegacyOfficeFormatError(`${LABEL}: the file information block has no piece table entry.`);
  }
  const clxAt = FIB_RG_FC_LCB_OFFSET + FC_LCB_CLX_INDEX * FC_LCB_PAIR_BYTES;
  const pairAt = (index: number): { fc: number; lcb: number } => {
    const at = FIB_RG_FC_LCB_OFFSET + index * FC_LCB_PAIR_BYTES;
    return { fc: word.u32(at), lcb: word.u32(at + CP_BYTES) };
  };
  return {
    ccpText: word.u32(FIB_CCP_TEXT_OFFSET),
    tableStream: flags & FIB_FLAG_WHICH_TABLE_STREAM ? '1Table' : '0Table',
    fcClx: word.u32(clxAt),
    lcbClx: word.u32(clxAt + CP_BYTES),
    formatting: { stsh: pairAt(FC_LCB_STSH_INDEX), plcBteChpx: pairAt(FC_LCB_PLC_BTE_CHPX_INDEX), sttbfFfn: pairAt(FC_LCB_STTB_FFN_INDEX) },
  };
}

/** Finds the PlcPcd inside the CLX: skips the Prc entries, then reads the single Pcdt. */
function locatePlcPcd(table: CheckedReader, fib: FibInfo): Buffer {
  const end = fib.fcClx + fib.lcbClx;
  let at = fib.fcClx;
  while (at < end) {
    const clxt = table.u8(at);
    if (clxt === CLX_PRC) {
      at += PRC_HEADER_BYTES + table.u16(at + 1);
    } else if (clxt === CLX_PCDT) {
      const size = table.u32(at + 1);
      if (at + PCDT_HEADER_BYTES + size > end) {
        throw new LegacyOfficeFormatError(`${LABEL}: the piece table runs past the end of the CLX.`);
      }
      return table.slice(at + PCDT_HEADER_BYTES, size);
    } else {
      throw new LegacyOfficeFormatError(`${LABEL}: the CLX holds an unknown entry type 0x${clxt.toString(16)}.`);
    }
  }
  throw new LegacyOfficeFormatError(`${LABEL}: the CLX holds no piece table.`);
}

function parsePieces(plcPcd: Buffer): Piece[] {
  if (plcPcd.length < CP_BYTES || (plcPcd.length - CP_BYTES) % (CP_BYTES + PCD_BYTES) !== 0) {
    throw new LegacyOfficeFormatError(`${LABEL}: the piece table size ${plcPcd.length} is not valid.`);
  }
  const count = (plcPcd.length - CP_BYTES) / (CP_BYTES + PCD_BYTES);
  if (count > DOC_MAX_PIECES) {
    throw new LegacyOfficeFormatError(`${LABEL}: the piece table holds ${count} pieces, more than the ${DOC_MAX_PIECES} limit.`);
  }
  const pcdBase = (count + 1) * CP_BYTES;
  const pieces: Piece[] = [];
  for (let i = 0; i < count; i++) {
    const fc = plcPcd.readUInt32LE(pcdBase + i * PCD_BYTES + PCD_FC_OFFSET);
    const compressed = (fc & FC_COMPRESSED_FLAG) !== 0;
    const offset = fc & FC_OFFSET_MASK;
    pieces.push({
      cpStart: plcPcd.readUInt32LE(i * CP_BYTES),
      cpEnd: plcPcd.readUInt32LE((i + 1) * CP_BYTES),
      // A compressed piece stores its byte offset doubled so that the low bit stays free.
      byteOffset: compressed ? Math.floor(offset / 2) : offset,
      compressed,
    });
  }
  return pieces;
}

/** Concatenates the main story of the piece table: ccpText characters from the pieces in character order. */
function readMainStory(word: Buffer, pieces: Piece[], ccpText: number): string {
  if (ccpText > DOC_MAX_TEXT_CHARS) {
    throw new LegacyOfficeFormatError(`${LABEL}: the main story holds ${ccpText} characters, more than the ${DOC_MAX_TEXT_CHARS} limit.`);
  }
  const parts: string[] = [];
  let covered = 0;
  for (const piece of pieces) {
    if (piece.cpEnd < piece.cpStart || piece.cpStart !== covered) {
      throw new LegacyOfficeFormatError(`${LABEL}: the piece table character positions are not contiguous.`);
    }
    if (covered >= ccpText) break;
    const length = Math.min(piece.cpEnd, ccpText) - piece.cpStart;
    const bytesPerChar = piece.compressed ? COMPRESSED_BYTES_PER_CHAR : UNICODE_BYTES_PER_CHAR;
    const byteLength = length * bytesPerChar;
    if (piece.byteOffset + byteLength > word.length) {
      throw new LegacyOfficeFormatError(`${LABEL}: a text piece lies outside the WordDocument stream.`);
    }
    const bytes = word.subarray(piece.byteOffset, piece.byteOffset + byteLength);
    parts.push(piece.compressed ? decodeWindows1252(bytes) : bytes.toString('utf16le'));
    covered += length;
  }
  if (covered !== ccpText) {
    throw new LegacyOfficeFormatError(`${LABEL}: the piece table covers ${covered} of the ${ccpText} main story characters.`);
  }
  return parts.join('');
}

/** Where a character of the main story is stored and which font its run uses, to read symbol-font characters. */
interface StoryFonts {
  formatting: CharacterFormatting;
  /** Whether the output can draw a character; a mapped symbol character it cannot draw becomes U+FFFD. Absent: every character can be drawn. */
  canDraw?: (character: string) => boolean;
  /** The file offset of the character at a character position; positions must be asked for in ascending order. */
  fileOffsetOf: (cp: number) => number;
}

/** The U+FFFD a character with no Unicode counterpart becomes, reported once per font and code. */
function replaceSymbolCharacter(font: string | undefined, code: number): string {
  reportConversionWarning(symbolReplacementWarning(font, code));
  return REPLACEMENT_CHARACTER;
}

/** The mapped character of a symbol-font code, U+FFFD when the font has none or the output cannot draw it. */
function drawableSymbol(fonts: StoryFonts, font: string | undefined, code: number, mapped: string | undefined): string {
  if (mapped === undefined) return replaceSymbolCharacter(font, code);
  if (fonts.canDraw === undefined || fonts.canDraw(mapped)) return mapped;
  reportConversionWarning(undrawableSymbolWarning(font, code, mapped));
  return REPLACEMENT_CHARACTER;
}

/** The character a private-use code point depicts in the font of its run. */
function mapPrivateUse(fonts: StoryFonts, cp: number, code: number): string {
  const font = fonts.formatting.privateUseFontAt(fonts.fileOffsetOf(cp));
  return drawableSymbol(fonts, font, code, font === undefined ? undefined : mapSymbolFontCharacter(font, code));
}

function isSurrogate(code: number): boolean {
  return code >= SURROGATE_FIRST && code <= SURROGATE_LAST;
}

/**
 * The character a Symbol field stands for, or undefined when the placeholder at `cp` carries none. In a symbol font the
 * code is a glyph of that font (stored as the byte or at U+F000 + byte); in any other font it is the Unicode character.
 */
function symbolFieldCharacter(fonts: StoryFonts, cp: number): string | undefined {
  const field = fonts.formatting.symbolFieldAt(fonts.fileOffsetOf(cp));
  if (field === undefined) return undefined;
  if (field.font !== undefined && isSymbolFontName(field.font)) {
    const code = field.xchar <= SYMBOL_FONT_LAST_BYTE ? SYMBOL_FONT_PRIVATE_USE_BASE + field.xchar : field.xchar;
    return drawableSymbol(fonts, field.font, code, mapSymbolFontCharacter(field.font, code));
  }
  const control = field.xchar < FIRST_PRINTABLE || (field.xchar >= FIRST_C1_CONTROL && field.xchar <= LAST_C1_CONTROL);
  if (control || isSymbolFontPrivateUse(field.xchar) || isSurrogate(field.xchar)) return replaceSymbolCharacter(field.font, field.xchar);
  return String.fromCharCode(field.xchar);
}

/**
 * Maps the special characters of the main story to plain text: paragraph ends and line breaks become
 * newlines, cell marks become tabs (a doubled mark ends the row), field instructions are dropped while
 * field results are kept, drawing, picture and reference placeholders disappear, and the private-use
 * characters of symbol fonts become the characters their glyphs depict.
 */
function renderStory(story: string, fonts: StoryFonts): string {
  const out: string[] = [];
  const openFields: boolean[] = []; // true once the field reached its result part
  let codeDepth = 0;
  let previousWasCellMark = false;
  for (let i = 0; i < story.length; i++) {
    const code = story.charCodeAt(i);
    const wasCellMark = previousWasCellMark;
    previousWasCellMark = false;
    if (code === CH_FIELD_BEGIN) {
      if (openFields.length >= DOC_MAX_FIELD_NESTING) {
        throw new LegacyOfficeFormatError(`${LABEL}: fields are nested deeper than ${DOC_MAX_FIELD_NESTING} levels.`);
      }
      openFields.push(false);
      codeDepth++;
      continue;
    }
    if (code === CH_FIELD_SEPARATOR) {
      if (openFields.length > 0 && !openFields[openFields.length - 1]) {
        openFields[openFields.length - 1] = true;
        codeDepth--;
      }
      continue;
    }
    if (code === CH_FIELD_END) {
      const reachedResult = openFields.pop();
      if (reachedResult === false) codeDepth--;
      continue;
    }
    if (codeDepth > 0) continue;
    if (code === CH_CELL_OR_ROW_END) {
      if (wasCellMark) {
        out[out.length - 1] = '\n';
      } else {
        out.push('\t');
        previousWasCellMark = true;
      }
    } else if (code === CH_PARAGRAPH_END || code === CH_VERTICAL_TAB || code === CH_PAGE_OR_SECTION_BREAK) {
      out.push('\n');
    } else if (code === CH_TAB) {
      out.push('\t');
    } else if (code === CH_NON_BREAKING_HYPHEN) {
      out.push('-');
    } else if (code === CH_OPTIONAL_HYPHEN) {
      continue;
    } else if (code < FIRST_PRINTABLE || (code >= FIRST_C1_CONTROL && code <= LAST_C1_CONTROL)) {
      continue;
    } else if (isSymbolFontPrivateUse(code)) {
      out.push(mapPrivateUse(fonts, i, code));
    } else if (code === CH_SYMBOL_PLACEHOLDER && fonts.formatting.hasSymbolFields) {
      out.push(symbolFieldCharacter(fonts, i) ?? story[i]);
    } else {
      out.push(story[i]);
    }
  }
  if (codeDepth > 0 || openFields.length > 0) {
    throw new LegacyOfficeFormatError(`${LABEL}: a field is not closed before the end of the main story.`);
  }
  return out.join('');
}

/**
 * A function from character position to the file offset the character is stored at: pieces start at `byteOffset` and
 * advance one byte per character when compressed, two otherwise. Positions are asked for in ascending order.
 */
function fileOffsetLocator(pieces: readonly Piece[]): (cp: number) => number {
  let index = 0;
  return (cp: number): number => {
    if (cp < pieces[index].cpStart) index = 0;
    while (index < pieces.length - 1 && cp >= pieces[index].cpEnd) index++;
    const piece = pieces[index];
    return piece.byteOffset + (cp - piece.cpStart) * (piece.compressed ? COMPRESSED_BYTES_PER_CHAR : UNICODE_BYTES_PER_CHAR);
  };
}

/**
 * Extracts the text of the main story of a Word 97-2003 document. Throws a LegacyOfficeFormatError for
 * malformed or empty documents and an EncryptedOfficeDocumentError for encrypted ones. A symbol-font character with no
 * Unicode counterpart becomes U+FFFD and is reported to the running conversion's warnings; so does one whose
 * counterpart `canDraw` (the output's glyph coverage, when it has a limit) rejects.
 */
export function readDocText(buffer: Buffer, canDraw?: (character: string) => boolean): string {
  const streams = readCfbStreams(buffer, LABEL);
  const wordStream = requireCfbStream(streams, WORD_DOCUMENT_STREAM, LABEL);
  const fib = readFib(new CheckedReader(wordStream, LABEL));
  const table = new CheckedReader(requireCfbStream(streams, fib.tableStream, LABEL), LABEL);
  if (fib.fcClx + fib.lcbClx > table.length) {
    throw new LegacyOfficeFormatError(`${LABEL}: the CLX lies outside the ${fib.tableStream} stream.`);
  }
  const pieces = parsePieces(locatePlcPcd(table, fib));
  const formatting = CharacterFormatting.read(wordStream, table, fib.formatting);
  const rendered = renderStory(readMainStory(wordStream, pieces, fib.ccpText), { formatting, canDraw, fileOffsetOf: fileOffsetLocator(pieces) });
  let end = rendered.length;
  while (end > 0 && rendered.charCodeAt(end - 1) === NEWLINE_CODE) end--;
  const text = rendered.slice(0, end);
  if (text.trim().length === 0) {
    throw new LegacyOfficeFormatError(`${LABEL}: the document holds no text.`);
  }
  return text;
}
