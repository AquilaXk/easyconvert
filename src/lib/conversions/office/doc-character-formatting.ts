import { isSymbolFontName } from '../symbol-font-map';
import type { CheckedReader } from './cfb-streams';
import { LegacyOfficeFormatError } from './legacy-office-errors';

/**
 * Character formatting of a Word 97-2003 binary document ([MS-DOC]), read for one purpose: which font a run of
 * characters uses, so the private-use characters of symbol fonts (Symbol, Wingdings, Webdings) can be mapped to the
 * Unicode characters their glyphs depict. Two sources give the font of a character, the first one that sets it wins:
 *   1. the Chpx of its run: ChpxFkp pages addressed by PlcBteChpx, setting sprmCRgFtc0, sprmCRgFtc1 and sprmCRgFtc2
 *      (the ASCII, East Asian and other font) or sprmCSymbol (a Symbol field character);
 *   2. the default character fonts of the style sheet (Stshif.rgftcStandardChpStsh).
 * Font indexes select an entry of SttbfFfn. Paragraph and character styles are not followed.
 * Every offset, count and length is checked before it is used; a violation is a LegacyOfficeFormatError.
 */

const LABEL = 'Word document';

/** Most FKP pages (512 bytes each) one PlcBteChpx may address: 16 MiB of formatting. */
export const DOC_MAX_CHPX_PAGES = 32_768;
/** Most runs one Chpx FKP page holds: 5 bytes of offsets per run (and 4 for the end) in the 511 bytes before the count. */
export const DOC_MAX_CHARACTER_RUNS_PER_PAGE = 101;

const FKP_BYTES = 512;
const FKP_RUN_COUNT_OFFSET = FKP_BYTES - 1;
const FC_BYTES = 4;
const PN_BYTES = 4;
const PN_MASK = 0x3fffff;
const CHPX_OFFSET_UNIT = 2;
const HEX_RADIX = 16;

// Sprm structure ([MS-DOC] 2.6.1): the operand size follows from spra, the top three bits of the opcode.
const SPRM_BYTES = 2;
const SPRA_SHIFT = 13;
const SPRA_ONE_BYTE_A = 0;
const SPRA_ONE_BYTE_B = 1;
const SPRA_TWO_BYTES_A = 2;
const SPRA_FOUR_BYTES = 3;
const SPRA_TWO_BYTES_B = 4;
const SPRA_TWO_BYTES_C = 5;
const SPRA_VARIABLE = 6;
const SPRA_THREE_BYTES = 7;
const SPRM_C_RG_FTC0 = 0x4a4f;
const SPRM_C_RG_FTC1 = 0x4a50;
const SPRM_C_RG_FTC2 = 0x4a51;
const SPRM_C_SYMBOL = 0x6a09;

// FFN: cbFfnM1, then 39 fixed bytes (ffid, wWeight, chs, ixchSzAlt, panose, fs), then xszFfn in UTF-16.
const FFN_NAME_OFFSET = 40;
const STTB_HEADER_BYTES = 4;
const UTF16_UNIT_BYTES = 2;

// STSH: cbStshi (2 bytes), then the Stshif; its rgftcStandardChpStsh follows 12 bytes of Stshif fields.
const STSH_HEADER_BYTES = 2;
const STSHIF_FONTS_OFFSET = 12;
const STSH_FONTS_END = STSH_HEADER_BYTES + STSHIF_FONTS_OFFSET + 3 * UTF16_UNIT_BYTES;

/** Font indexes of one run: undefined means the run does not set that font. */
interface FontSlots {
  ascii?: number;
  farEast?: number;
  other?: number;
}

interface CharacterRun {
  fcStart: number;
  fcEnd: number;
  slots: FontSlots;
  /** The font index and character code of a Symbol field (sprmCSymbol). */
  symbol?: { ftc: number; xchar: number };
}

/** Where a structure lies in the table stream: the (fc, lcb) pair of the FIB. */
export interface TableRange {
  fc: number;
  lcb: number;
}

export interface CharacterFormattingLocations {
  plcBteChpx: TableRange;
  sttbfFfn: TableRange;
  stsh: TableRange;
}

/** A Symbol field character: the font name (undefined when the font index names no font) and the code in it. */
export interface SymbolFieldCharacter {
  font: string | undefined;
  xchar: number;
}

function refuse(message: string): never {
  throw new LegacyOfficeFormatError(`${LABEL}: ${message}`);
}

function hex(value: number): string {
  return value.toString(HEX_RADIX);
}

function assertInTable(table: CheckedReader, range: TableRange, what: string): void {
  if (range.fc + range.lcb > table.length) refuse(`the ${what} lies outside the table stream.`);
}

/** Size of the operand of a sprm in a Chpx; the variable-size operand carries its own length in its first byte. */
function operandBytes(grpprl: Buffer, at: number, opcode: number): number {
  switch (opcode >> SPRA_SHIFT) {
    case SPRA_ONE_BYTE_A:
    case SPRA_ONE_BYTE_B:
      return 1;
    case SPRA_TWO_BYTES_A:
    case SPRA_TWO_BYTES_B:
    case SPRA_TWO_BYTES_C:
      return 2;
    case SPRA_FOUR_BYTES:
      return 4;
    case SPRA_THREE_BYTES:
      return 3;
    case SPRA_VARIABLE:
      if (at + SPRM_BYTES >= grpprl.length) refuse(`the property modifier 0x${hex(opcode)} has no operand length before the end of its Chpx.`);
      return 1 + grpprl[at + SPRM_BYTES];
    default:
      return refuse(`the property modifier 0x${hex(opcode)} has an unknown operand size.`);
  }
}

/** Reads the font sprms of one Chpx; every other property is stepped over. */
function readGrpprl(grpprl: Buffer): Pick<CharacterRun, 'slots' | 'symbol'> {
  const slots: FontSlots = {};
  let symbol: CharacterRun['symbol'];
  let at = 0;
  while (at < grpprl.length) {
    if (at + SPRM_BYTES > grpprl.length) refuse('a property modifier is cut off by the end of its Chpx.');
    const opcode = grpprl.readUInt16LE(at);
    const size = operandBytes(grpprl, at, opcode);
    if (at + SPRM_BYTES + size > grpprl.length) refuse(`the property modifier 0x${hex(opcode)} runs past the end of its Chpx.`);
    const operand = at + SPRM_BYTES;
    if (opcode === SPRM_C_RG_FTC0) slots.ascii = grpprl.readUInt16LE(operand);
    else if (opcode === SPRM_C_RG_FTC1) slots.farEast = grpprl.readUInt16LE(operand);
    else if (opcode === SPRM_C_RG_FTC2) slots.other = grpprl.readUInt16LE(operand);
    else if (opcode === SPRM_C_SYMBOL) symbol = { ftc: grpprl.readUInt16LE(operand), xchar: grpprl.readUInt16LE(operand + UTF16_UNIT_BYTES) };
    at += SPRM_BYTES + size;
  }
  return { slots, symbol };
}

function setsFont({ slots, symbol }: Pick<CharacterRun, 'slots' | 'symbol'>): boolean {
  return symbol !== undefined || slots.ascii !== undefined || slots.farEast !== undefined || slots.other !== undefined;
}

/** Reads the runs of one Chpx FKP page that set a font into `runs`; returns the file offset where the page ended. */
function readFkpPage(word: Buffer, pageNumber: number, previousEnd: number, runs: CharacterRun[]): number {
  const pageStart = pageNumber * FKP_BYTES;
  if (pageStart + FKP_BYTES > word.length) refuse(`the FKP page ${pageNumber} lies outside the WordDocument stream.`);
  const page = word.subarray(pageStart, pageStart + FKP_BYTES);
  const count = page[FKP_RUN_COUNT_OFFSET];
  if (count < 1 || count > DOC_MAX_CHARACTER_RUNS_PER_PAGE) {
    refuse(`the FKP page ${pageNumber} declares ${count} runs; a page holds 1 to ${DOC_MAX_CHARACTER_RUNS_PER_PAGE}.`);
  }
  const offsetsEnd = (count + 1) * FC_BYTES + count;
  let end = previousEnd;
  for (let i = 0; i < count; i++) {
    const fcStart = page.readUInt32LE(i * FC_BYTES);
    const fcEnd = page.readUInt32LE((i + 1) * FC_BYTES);
    if (fcStart < end || fcEnd < fcStart) refuse(`the file offsets of the FKP page ${pageNumber} are not in ascending order.`);
    end = fcEnd;
    const chpxAt = page[(count + 1) * FC_BYTES + i] * CHPX_OFFSET_UNIT;
    if (chpxAt === 0) continue;
    if (chpxAt < offsetsEnd || chpxAt >= FKP_RUN_COUNT_OFFSET) {
      refuse(`the Chpx at offset ${chpxAt} of the FKP page ${pageNumber} lies outside the space after its offset arrays.`);
    }
    const length = page[chpxAt];
    if (chpxAt + 1 + length > FKP_RUN_COUNT_OFFSET) refuse(`the Chpx at offset ${chpxAt} of the FKP page ${pageNumber} runs past the end of the page.`);
    const properties = readGrpprl(page.subarray(chpxAt + 1, chpxAt + 1 + length));
    if (setsFont(properties)) runs.push({ fcStart, fcEnd, ...properties });
  }
  return end;
}

function readRuns(word: Buffer, table: CheckedReader, range: TableRange): CharacterRun[] {
  if (range.lcb === 0) return [];
  assertInTable(table, range, 'character formatting table');
  const entryBytes = FC_BYTES + PN_BYTES;
  if (range.lcb < FC_BYTES || (range.lcb - FC_BYTES) % entryBytes !== 0) refuse(`the character formatting table size ${range.lcb} is not valid.`);
  const pages = (range.lcb - FC_BYTES) / entryBytes;
  if (pages > DOC_MAX_CHPX_PAGES) refuse(`the character formatting table addresses ${pages} pages, more than the ${DOC_MAX_CHPX_PAGES} limit.`);
  const plc = table.slice(range.fc, range.lcb);
  const pnBase = (pages + 1) * FC_BYTES;
  const runs: CharacterRun[] = [];
  let end = 0;
  for (let i = 0; i < pages; i++) {
    end = readFkpPage(word, plc.readUInt32LE(pnBase + i * PN_BYTES) & PN_MASK, end, runs);
  }
  return runs;
}

/** The font names of SttbfFfn in index order. */
function readFontNames(table: CheckedReader, range: TableRange): string[] {
  if (range.lcb === 0) return [];
  assertInTable(table, range, 'font table');
  if (range.lcb < STTB_HEADER_BYTES) refuse('the font table is too short for its header.');
  const sttb = table.slice(range.fc, range.lcb);
  // The 16-bit count bounds the loop, and every font consumes at least FFN_NAME_OFFSET bytes of the table or is refused.
  const count = sttb.readUInt16LE(0);
  const names: string[] = [];
  let at = STTB_HEADER_BYTES + sttb.readUInt16LE(UTF16_UNIT_BYTES);
  for (let i = 0; i < count; i++) {
    if (at >= sttb.length) refuse(`the font table ends before font ${i} of ${count}.`);
    const next = at + 1 + sttb[at];
    if (next > sttb.length || at + FFN_NAME_OFFSET > next) refuse(`font ${i} of the font table runs past the end of the table or is too short.`);
    const name = sttb.subarray(at + FFN_NAME_OFFSET, next - ((next - at - FFN_NAME_OFFSET) % UTF16_UNIT_BYTES)).toString('utf16le');
    const terminator = name.indexOf('\0');
    names.push(terminator === -1 ? name : name.slice(0, terminator));
    at = next;
  }
  return names;
}

function readStyleSheetFonts(table: CheckedReader, range: TableRange): FontSlots {
  if (range.lcb === 0) return {};
  assertInTable(table, range, 'style sheet');
  if (range.lcb < STSH_FONTS_END) refuse('the style sheet is too short for its default fonts.');
  const at = range.fc + STSH_HEADER_BYTES + STSHIF_FONTS_OFFSET;
  return { ascii: table.u16(at), farEast: table.u16(at + UTF16_UNIT_BYTES), other: table.u16(at + 2 * UTF16_UNIT_BYTES) };
}

/** Fonts of the characters of a Word document, by the file offset the character is stored at. */
export class CharacterFormatting {
  private constructor(
    private readonly fontNames: readonly string[],
    private readonly defaults: FontSlots,
    private readonly runs: readonly CharacterRun[]
  ) {}

  /** Reads the font table, the default fonts and the character runs of the document. */
  static read(word: Buffer, table: CheckedReader, locations: CharacterFormattingLocations): CharacterFormatting {
    const fontNames = readFontNames(table, locations.sttbfFfn);
    const defaults = readStyleSheetFonts(table, locations.stsh);
    return new CharacterFormatting(fontNames, defaults, readRuns(word, table, locations.plcBteChpx));
  }

  /** Whether any run carries a Symbol field character, so the placeholders of the text are worth looking up. */
  readonly hasSymbolFields: boolean = this.runs.some((run) => run.symbol !== undefined);

  private runAt(fc: number): CharacterRun | undefined {
    let low = 0;
    let high = this.runs.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const run = this.runs[middle];
      if (fc < run.fcStart) high = middle - 1;
      else if (fc >= run.fcEnd) low = middle + 1;
      else return run;
    }
    return undefined;
  }

  private nameOf(ftc: number | undefined): string | undefined {
    return ftc === undefined ? undefined : this.fontNames[ftc];
  }

  /**
   * The font that decides what a private-use character at file offset `fc` depicts: the first symbol font among the
   * run's other, ASCII and East Asian fonts (each falling back to the style sheet default), else the first font that
   * is named, else undefined.
   */
  privateUseFontAt(fc: number): string | undefined {
    const slots = this.runAt(fc)?.slots ?? {};
    const names = [slots.other ?? this.defaults.other, slots.ascii ?? this.defaults.ascii, slots.farEast ?? this.defaults.farEast]
      .map((ftc) => this.nameOf(ftc))
      .filter((name): name is string => name !== undefined);
    return names.find(isSymbolFontName) ?? names[0];
  }

  /** The Symbol field character of the run that holds file offset `fc`, if the run has one. */
  symbolFieldAt(fc: number): SymbolFieldCharacter | undefined {
    const symbol = this.runAt(fc)?.symbol;
    return symbol === undefined ? undefined : { font: this.nameOf(symbol.ftc), xchar: symbol.xchar };
  }
}
