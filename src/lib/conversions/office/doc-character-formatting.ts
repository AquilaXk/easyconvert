import { isSymbolFontName } from '../symbol-font-map';
import type { CheckedReader } from './cfb-streams';
import { ParagraphRuns } from './doc-paragraph-formatting';
import {
  assertInTable,
  DOC_MAX_FKP_PAGES,
  FKP_FC_BYTES,
  FKP_RUN_COUNT_OFFSET,
  fkpPageAt,
  readCharacterProperties,
  readFkpPageNumbers,
  refuse,
  setsFontOrStyle,
  type CharacterProperties,
  type FontSlots,
  type TableRange,
} from './doc-properties';
import { StyleSheet } from './doc-style-sheet';

/**
 * Character formatting of a Word 97-2003 binary document ([MS-DOC]), read for one purpose: which font a run of
 * characters uses, so the private-use characters of symbol fonts (Symbol, Wingdings, Webdings) can be mapped to the
 * Unicode characters their glyphs depict. A font slot (the ASCII, East Asian and other font) of a character comes from
 * the first of these that sets it:
 *   1. the Chpx of its run: ChpxFkp pages addressed by PlcBteChpx, setting sprmCRgFtc0, sprmCRgFtc1 and sprmCRgFtc2
 *      (or sprmCSymbol, a Symbol field character);
 *   2. the character style of the run (sprmCIstd in the Chpx), then the styles it is based on;
 *   3. the paragraph style of its paragraph (the istd of its PapxFkp entry, Normal when it has none), then the styles
 *      it is based on;
 *   4. the default character fonts of the style sheet (Stshif.rgftcStandardChpStsh).
 * Font indexes select an entry of SttbfFfn. Every offset, count and length is checked before it is used; a violation is
 * a LegacyOfficeFormatError.
 */

/** Most FKP pages (512 bytes each) one PlcBteChpx may address: 16 MiB of formatting. */
export const DOC_MAX_CHPX_PAGES = DOC_MAX_FKP_PAGES;
/** Most runs one Chpx FKP page holds: 5 bytes of offsets per run (and 4 for the end) in the 511 bytes before the count. */
export const DOC_MAX_CHARACTER_RUNS_PER_PAGE = 101;
/** Most font-setting runs one document may carry, whatever its text length claims. */
export const DOC_MAX_CHARACTER_RUNS = 1_048_576;

const CHPX_OFFSET_UNIT = 2;

// FFN: cbFfnM1, then 39 fixed bytes (ffid, wWeight, chs, ixchSzAlt, panose, fs), then xszFfn in UTF-16.
const FFN_NAME_OFFSET = 40;
const STTB_HEADER_BYTES = 4;
const UTF16_UNIT_BYTES = 2;

interface CharacterRun extends CharacterProperties {
  fcStart: number;
  fcEnd: number;
}

export type { TableRange };

export interface CharacterFormattingLocations {
  plcBteChpx: TableRange;
  plcBtePapx: TableRange;
  sttbfFfn: TableRange;
  stsh: TableRange;
  /** Characters of all stories of the document (the FIB ccp fields): a run covers at least one of them. */
  textChars: number;
}

/** A Symbol field character: the font name (undefined when the font index names no font) and the code in it. */
export interface SymbolFieldCharacter {
  font: string | undefined;
  xchar: number;
}

/** Reads the runs of one Chpx FKP page that set a font or a style into `runs`; returns the file offset where the page ended. */
function readFkpPage(word: Buffer, pageNumber: number, previousEnd: number, runs: CharacterRun[], maxRuns: number): number {
  const page = fkpPageAt(word, pageNumber);
  const count = page[FKP_RUN_COUNT_OFFSET];
  if (count < 1 || count > DOC_MAX_CHARACTER_RUNS_PER_PAGE) {
    refuse(`the FKP page ${pageNumber} declares ${count} runs; a page holds 1 to ${DOC_MAX_CHARACTER_RUNS_PER_PAGE}.`);
  }
  const offsetsEnd = (count + 1) * FKP_FC_BYTES + count;
  let end = previousEnd;
  for (let i = 0; i < count; i++) {
    const fcStart = page.readUInt32LE(i * FKP_FC_BYTES);
    const fcEnd = page.readUInt32LE((i + 1) * FKP_FC_BYTES);
    if (fcStart < end || fcEnd < fcStart) refuse(`the file offsets of the FKP page ${pageNumber} are not in ascending order.`);
    end = fcEnd;
    const chpxAt = page[(count + 1) * FKP_FC_BYTES + i] * CHPX_OFFSET_UNIT;
    if (chpxAt === 0) continue;
    if (chpxAt < offsetsEnd || chpxAt >= FKP_RUN_COUNT_OFFSET) {
      refuse(`the Chpx at offset ${chpxAt} of the FKP page ${pageNumber} lies outside the space after its offset arrays.`);
    }
    const length = page[chpxAt];
    if (chpxAt + 1 + length > FKP_RUN_COUNT_OFFSET) refuse(`the Chpx at offset ${chpxAt} of the FKP page ${pageNumber} runs past the end of the page.`);
    const properties = readCharacterProperties(page.subarray(chpxAt + 1, chpxAt + 1 + length));
    if (fcEnd === fcStart || !setsFontOrStyle(properties)) continue;
    if (runs.length >= maxRuns) refuse(`the document has more character runs than its text can hold (limit ${maxRuns}).`);
    runs.push({ fcStart, fcEnd, ...properties });
  }
  return end;
}

function readRuns(word: Buffer, table: CheckedReader, range: TableRange, textChars: number): CharacterRun[] {
  const pageNumbers = readFkpPageNumbers(table, range, 'character');
  // A run covers at least one character and file offsets ascend strictly, so runs cannot outnumber characters plus pages.
  const maxRuns = Math.min(textChars + pageNumbers.length, DOC_MAX_CHARACTER_RUNS);
  const runs: CharacterRun[] = [];
  let end = 0;
  for (const pageNumber of pageNumbers) end = readFkpPage(word, pageNumber, end, runs, maxRuns);
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

/** Fonts of the characters of a Word document, by the file offset the character is stored at. */
export class CharacterFormatting {
  private constructor(
    private readonly fontNames: readonly string[],
    private readonly styles: StyleSheet,
    private readonly paragraphs: ParagraphRuns,
    private readonly runs: readonly CharacterRun[]
  ) {}

  /** Reads the font table, the style sheet, the paragraph styles and the character runs of the document. */
  static read(word: Buffer, table: CheckedReader, locations: CharacterFormattingLocations): CharacterFormatting {
    const fontNames = readFontNames(table, locations.sttbfFfn);
    const styles = StyleSheet.read(table, locations.stsh);
    const paragraphs = ParagraphRuns.read(word, table, locations.plcBtePapx, locations.textChars);
    return new CharacterFormatting(fontNames, styles, paragraphs, readRuns(word, table, locations.plcBteChpx, locations.textChars));
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
   * The font indexes of the character at file offset `fc`: per slot the font of its run, else of its character style,
   * else of its paragraph style, else the default of the style sheet.
   */
  private slotsAt(fc: number): FontSlots {
    const run = this.runAt(fc);
    const direct = run?.slots ?? {};
    const characterStyle = run?.istd === undefined ? {} : this.styles.fontsOf(run.istd);
    const paragraphIstd = this.paragraphs.istdAt(fc);
    const paragraphStyle = paragraphIstd === undefined ? this.styles.normalFonts : this.styles.fontsOf(paragraphIstd);
    const defaults = this.styles.defaults;
    return {
      ascii: direct.ascii ?? characterStyle.ascii ?? paragraphStyle.ascii ?? defaults.ascii,
      farEast: direct.farEast ?? characterStyle.farEast ?? paragraphStyle.farEast ?? defaults.farEast,
      other: direct.other ?? characterStyle.other ?? paragraphStyle.other ?? defaults.other,
    };
  }

  /**
   * The font that decides what a private-use character at file offset `fc` depicts: the first symbol font among the
   * other, ASCII and East Asian fonts of the character, else the first font that is named, else undefined.
   */
  privateUseFontAt(fc: number): string | undefined {
    const slots = this.slotsAt(fc);
    const names = [slots.other, slots.ascii, slots.farEast].map((ftc) => this.nameOf(ftc)).filter((name): name is string => name !== undefined);
    return names.find(isSymbolFontName) ?? names[0];
  }

  /** The Symbol field character of the run that holds file offset `fc`, if the run has one. */
  symbolFieldAt(fc: number): SymbolFieldCharacter | undefined {
    const symbol = this.runAt(fc)?.symbol;
    return symbol === undefined ? undefined : { font: this.nameOf(symbol.ftc), xchar: symbol.xchar };
  }
}
