import type { CheckedReader } from './cfb-streams';
import { assertInTable, readCharacterProperties, refuse, type FontSlots, type TableRange } from './doc-properties';

/**
 * The style sheet of a Word 97-2003 binary document ([MS-DOC] 2.9.271 STSH), read for the fonts its styles set. A style
 * is an Std: a StdfBase with its kind (sgc) and the style it is based on (istdBase), the name, and the property blocks
 * (UPX) of its kind. The character properties of a style are one of those blocks: the last of a paragraph style (cupx 2:
 * paragraph, character), the only one of a character style, the last of a table style. A style takes the font a slot
 * sets in its own character properties, else the font of the style it is based on, and so on up the chain.
 * The default character fonts of the document (Stshif.rgftcStandardChpStsh) apply when no style in the chain sets a slot.
 *
 * The array of LPStd is walked once when the sheet is read, to find where each style lies. A style is decoded when a
 * character asks for it, and its resolved fonts are kept: every later lookup of that style is a map read.
 */

/** Most styles a style sheet may hold: a style is named by a 12-bit istd and 0x0FFF means "no style". */
export const DOC_MAX_STYLES = 0x0fff;
/** Most styles one based-on chain may pass through; Word's own style nesting is a handful of levels. */
export const DOC_MAX_STYLE_CHAIN = 32;

const STSH_HEADER_BYTES = 2; // cbStshi
const STSHI_CSTD_OFFSET = 0;
const STSHI_CB_STD_BASE_OFFSET = 2;
/** rgftcStandardChpStsh (ASCII, East Asian, other) follows 12 bytes of Stshif fields. */
const STSHI_FONTS_OFFSET = 12;
const UTF16_UNIT_BYTES = 2;
const STSHI_FONTS_END = STSHI_FONTS_OFFSET + 3 * UTF16_UNIT_BYTES;
const LPSTD_HEADER_BYTES = 2; // cbStd

// Std: StdfBase (10 bytes; later versions append StdfPost2000, cbSTDBaseInFile in all), the Xstz name, the UPX blocks.
const STDF_BASE_BYTES = 10;
const STDF_SGC_OFFSET = 2; // sgc in the low 4 bits, istdBase in the high 12
const STDF_CUPX_OFFSET = 4; // cupx in the low 4 bits, istdNext in the high 12
const NIBBLE_BITS = 4;
const NIBBLE_MASK = 0xf;
const ISTD_NONE = 0x0fff;
const UPX_HEADER_BYTES = 2; // cbUpx

const SGC_PARAGRAPH = 1;
const SGC_CHARACTER = 2;
const SGC_TABLE = 3;
/** Index of the character-properties block among the UPX blocks of a style kind. */
const CHPX_BLOCK_INDEX = new Map<number, number>([
  [SGC_PARAGRAPH, 1],
  [SGC_CHARACTER, 0],
  [SGC_TABLE, 2],
]);

interface StdLocation {
  offset: number;
  length: number;
}

const NO_FONTS: FontSlots = Object.freeze({});

export class StyleSheet {
  private readonly resolved = new Map<number, FontSlots>();

  private constructor(
    private readonly table: CheckedReader,
    private readonly stdfBytes: number,
    private readonly styles: readonly StdLocation[],
    /** The default character fonts of the document: used where no style sets a slot. */
    readonly defaults: FontSlots
  ) {}

  /** Reads the header and locates the styles of the STSH. A document without a style sheet gets an empty one. */
  static read(table: CheckedReader, range: TableRange): StyleSheet {
    if (range.lcb === 0) return new StyleSheet(table, STDF_BASE_BYTES, [], NO_FONTS);
    assertInTable(table, range, 'style sheet');
    const stshiAt = range.fc + STSH_HEADER_BYTES;
    if (range.lcb < STSH_HEADER_BYTES + STSHI_FONTS_END) refuse('the style sheet is too short for its default fonts.');
    const cbStshi = table.u16(range.fc);
    if (cbStshi < STSHI_FONTS_END) refuse(`the style sheet header of ${cbStshi} bytes is too short for its default fonts.`);
    const defaults: FontSlots = {
      ascii: table.u16(stshiAt + STSHI_FONTS_OFFSET),
      farEast: table.u16(stshiAt + STSHI_FONTS_OFFSET + UTF16_UNIT_BYTES),
      other: table.u16(stshiAt + STSHI_FONTS_OFFSET + 2 * UTF16_UNIT_BYTES),
    };
    const count = table.u16(stshiAt + STSHI_CSTD_OFFSET);
    if (count > DOC_MAX_STYLES) refuse(`the style sheet declares more than ${DOC_MAX_STYLES} styles (${count}).`);
    const stdfBytes = table.u16(stshiAt + STSHI_CB_STD_BASE_OFFSET);
    if (count > 0 && stdfBytes < STDF_BASE_BYTES) refuse(`the style sheet declares a style header of ${stdfBytes} bytes, less than the ${STDF_BASE_BYTES} the format needs.`);
    // Some writers record a length for the style sheet that ends before its styles; the styles lie inside the table stream.
    const styles: StdLocation[] = [];
    let at = stshiAt + cbStshi;
    for (let istd = 0; istd < count; istd++) {
      if (at + LPSTD_HEADER_BYTES > table.length) refuse(`the style sheet ends before style ${istd} of ${count}.`);
      const length = table.u16(at);
      const offset = at + LPSTD_HEADER_BYTES;
      if (offset + length > table.length) refuse(`style ${istd} runs past the end of the table stream.`);
      styles.push({ offset, length });
      at = offset + length;
    }
    return new StyleSheet(table, stdfBytes, styles, defaults);
  }

  /** The fonts of the Normal style (istd 0), or none for a document without styles. */
  get normalFonts(): FontSlots {
    return this.styles.length === 0 ? NO_FONTS : this.fontsOf(0);
  }

  /**
   * The font slots a style sets, itself or through the styles it is based on. The result is computed once per style.
   * An istd the sheet does not hold, a chain longer than DOC_MAX_STYLE_CHAIN and styles based on each other are refused.
   */
  fontsOf(istd: number): FontSlots {
    const known = this.resolved.get(istd);
    if (known !== undefined) return known;
    const chain = this.chainOf(istd);
    // Resolve from the root of the chain down, keeping each step: the styles it is based on were resolved on the way.
    let base: FontSlots = NO_FONTS;
    for (let i = chain.length - 1; i >= 0; i--) {
      const cached = this.resolved.get(chain[i].istd);
      if (cached !== undefined) {
        base = cached;
        continue;
      }
      const own = chain[i].fonts;
      base = Object.freeze({ ascii: own.ascii ?? base.ascii, farEast: own.farEast ?? base.farEast, other: own.other ?? base.other });
      this.resolved.set(chain[i].istd, base);
    }
    return base;
  }

  /** The style and the styles it is based on, nearest first, each with the fonts it sets itself. */
  private chainOf(istd: number): Array<{ istd: number; fonts: FontSlots }> {
    const chain: Array<{ istd: number; fonts: FontSlots }> = [];
    const visited = new Set<number>();
    let current = istd;
    while (current !== ISTD_NONE) {
      if (current >= this.styles.length) refuse(`style ${current} is not in the style sheet (it holds ${this.styles.length}).`);
      if (visited.has(current)) refuse(`styles are based on each other: style ${current} is its own ancestor.`);
      if (chain.length >= DOC_MAX_STYLE_CHAIN) refuse(`style ${istd} is based on more than ${DOC_MAX_STYLE_CHAIN} styles.`);
      visited.add(current);
      const decoded = this.decode(current);
      chain.push({ istd: current, fonts: decoded.fonts });
      if (this.resolved.has(current)) break;
      current = decoded.base;
    }
    return chain;
  }

  /** Decodes one Std: the style it is based on and the fonts its character properties set. */
  private decode(istd: number): { base: number; fonts: FontSlots } {
    const { offset, length } = this.styles[istd];
    if (length === 0) return { base: ISTD_NONE, fonts: NO_FONTS }; // an empty slot of the array: the style was deleted
    if (length < STDF_BASE_BYTES || length < this.stdfBytes) refuse(`style ${istd} is shorter than its ${this.stdfBytes}-byte header.`);
    const std = this.table.slice(offset, length);
    const sgcAndBase = std.readUInt16LE(STDF_SGC_OFFSET);
    const sgc = sgcAndBase & NIBBLE_MASK;
    const base = sgcAndBase >> NIBBLE_BITS;
    const cupx = std.readUInt16LE(STDF_CUPX_OFFSET) & NIBBLE_MASK;
    // The Xstz name: a 16-bit character count, the characters and a terminating null.
    const nameChars = this.stdfBytes + UTF16_UNIT_BYTES > length ? 0 : std.readUInt16LE(this.stdfBytes);
    let at = this.stdfBytes + UTF16_UNIT_BYTES + (nameChars + 1) * UTF16_UNIT_BYTES;
    if (at > length) refuse(`style ${istd} has a name that runs past the style.`);
    const chpxIndex = CHPX_BLOCK_INDEX.get(sgc);
    let fonts: FontSlots = NO_FONTS;
    for (let block = 0; block < cupx; block++) {
      if (at + UPX_HEADER_BYTES > length) refuse(`style ${istd} has property blocks that run past the style.`);
      const size = std.readUInt16LE(at);
      const blockStart = at + UPX_HEADER_BYTES;
      if (blockStart + size > length) refuse(`style ${istd} has property blocks that run past the style.`);
      if (block === chpxIndex) fonts = readCharacterProperties(std.subarray(blockStart, blockStart + size)).slots;
      at = blockStart + size + (size % 2); // each block starts on a word boundary
    }
    return { base, fonts };
  }
}
