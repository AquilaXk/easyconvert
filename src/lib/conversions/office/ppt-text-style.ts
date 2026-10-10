/**
 * Character runs of a PowerPoint 97-2003 StyleTextPropAtom ([MS-PPT] 2.9.43): which font each stretch of a text
 * block uses. The reader needs this for one purpose, to know which symbol font (Symbol, Wingdings, ...) the
 * private-use characters of a run belong to. The paragraph runs ahead of the character runs are walked only to
 * find where the character runs start.
 */

/** One stretch of characters with the font indexes its TextCFException sets (undefined when the run inherits them). */
export interface CharacterFontRun {
  start: number;
  end: number;
  /** Index into the FontCollection for characters outside the symbol range. */
  fontRef?: number;
  /** Index into the FontCollection for the symbol range (U+F000-U+F0FF) characters. */
  symbolFontRef?: number;
}

// TextPFException masks ([MS-PPT] 2.9.20): each set bit adds fields after the mask, in this order.
const PF_BULLET_FLAGS = 0x0000000f;
const PF_BULLET_FONT = 0x00000010;
const PF_BULLET_COLOR = 0x00000020;
const PF_BULLET_SIZE = 0x00000040;
const PF_BULLET_CHAR = 0x00000080;
const PF_LEFT_MARGIN = 0x00000100;
const PF_INDENT = 0x00000400;
const PF_ALIGN = 0x00000800;
const PF_LINE_SPACING = 0x00001000;
const PF_SPACE_BEFORE = 0x00002000;
const PF_SPACE_AFTER = 0x00004000;
const PF_DEFAULT_TAB = 0x00008000;
const PF_FONT_ALIGN = 0x00010000;
const PF_WRAP_FLAGS = 0x000e0000;
const PF_TAB_STOPS = 0x00100000;
const PF_TEXT_DIRECTION = 0x00200000;
/** Bits 22-26 (bullet picture and scheme) select behaviour but add no fields. */
const PF_KNOWN = 0x07ffffff;
const PF_U16_FIELDS: readonly number[] = [
  PF_BULLET_FONT,
  PF_BULLET_SIZE,
  PF_BULLET_CHAR,
  PF_LEFT_MARGIN,
  PF_INDENT,
  PF_ALIGN,
  PF_LINE_SPACING,
  PF_SPACE_BEFORE,
  PF_SPACE_AFTER,
  PF_DEFAULT_TAB,
  PF_FONT_ALIGN,
  PF_TEXT_DIRECTION,
];

// TextCFException masks ([MS-PPT] 2.9.12).
const CF_FONT_STYLE_BITS = 0x0000ffff;
const CF_TYPEFACE = 0x00010000;
const CF_SIZE = 0x00020000;
const CF_COLOR = 0x00040000;
const CF_POSITION = 0x00080000;
const CF_OLD_EA_TYPEFACE = 0x00200000;
const CF_ANSI_TYPEFACE = 0x00400000;
const CF_SYMBOL_TYPEFACE = 0x00800000;
/** Bit 20 (the PowerPoint 2002 extension flag) adds no field of its own. */
const CF_KNOWN = 0x00ffffff;

const U16_BYTES = 2;
const U32_BYTES = 4;
const TAB_STOP_BYTES = 4;
/** Most runs of one kind read from one atom; a larger table is not a real presentation. */
const MAX_RUNS = 1_000_000;

class Cursor {
  at = 0;
  constructor(private readonly data: Buffer) {}

  private take(size: number): number | null {
    if (this.at + size > this.data.length) return null;
    const start = this.at;
    this.at += size;
    return start;
  }

  u16(): number | null {
    const start = this.take(U16_BYTES);
    return start === null ? null : this.data.readUInt16LE(start);
  }

  u32(): number | null {
    const start = this.take(U32_BYTES);
    return start === null ? null : this.data.readUInt32LE(start);
  }

  skip(size: number): boolean {
    return this.take(size) !== null;
  }

  get done(): boolean {
    return this.at === this.data.length;
  }
}

/** Reads one TextPFException after its run header; false when the atom ends early or uses fields this reader does not know. */
function skipParagraphException(cursor: Cursor): boolean {
  const masks = cursor.u32();
  if (masks === null || (masks & ~PF_KNOWN) !== 0) return false;
  let size = 0;
  if ((masks & PF_BULLET_FLAGS) !== 0) size += U16_BYTES;
  for (const field of PF_U16_FIELDS) if ((masks & field) !== 0) size += U16_BYTES;
  if ((masks & PF_BULLET_COLOR) !== 0) size += U32_BYTES;
  if ((masks & PF_WRAP_FLAGS) !== 0) size += U16_BYTES;
  if (!cursor.skip(size)) return false;
  if ((masks & PF_TAB_STOPS) !== 0) {
    const stops = cursor.u16();
    return stops !== null && cursor.skip(stops * TAB_STOP_BYTES);
  }
  return true;
}

/**
 * The character runs of a StyleTextPropAtom body for a text of `textLength` characters, or null when the atom is
 * cut off, uses fields this reader does not know, or leaves bytes unread: the font of the text is then unknown.
 */
export function readCharacterFontRuns(body: Buffer, textLength: number): CharacterFontRun[] | null {
  const cursor = new Cursor(body);
  // Both run tables cover the text plus the paragraph mark the file adds after its last character.
  const covered = textLength + 1;
  let paragraphChars = 0;
  for (let runs = 0; paragraphChars < covered; runs++) {
    const count = cursor.u32();
    if (count === null || count === 0 || runs >= MAX_RUNS || cursor.u16() === null || !skipParagraphException(cursor)) return null;
    paragraphChars += count;
  }
  if (paragraphChars !== covered) return null;
  const result: CharacterFontRun[] = [];
  let characterChars = 0;
  for (let runs = 0; characterChars < covered; runs++) {
    const count = cursor.u32();
    const masks = cursor.u32();
    if (count === null || count === 0 || masks === null || runs >= MAX_RUNS || (masks & ~CF_KNOWN) !== 0) return null;
    if ((masks & CF_FONT_STYLE_BITS) !== 0 && cursor.u16() === null) return null;
    const fontRef = (masks & CF_TYPEFACE) !== 0 ? cursor.u16() : undefined;
    if (fontRef === null) return null;
    if ((masks & CF_OLD_EA_TYPEFACE) !== 0 && cursor.u16() === null) return null;
    if ((masks & CF_ANSI_TYPEFACE) !== 0 && cursor.u16() === null) return null;
    const symbolFontRef = (masks & CF_SYMBOL_TYPEFACE) !== 0 ? cursor.u16() : undefined;
    if (symbolFontRef === null) return null;
    if ((masks & CF_SIZE) !== 0 && cursor.u16() === null) return null;
    if ((masks & CF_COLOR) !== 0 && cursor.u32() === null) return null;
    if ((masks & CF_POSITION) !== 0 && cursor.u16() === null) return null;
    result.push({ start: characterChars, end: characterChars + count, fontRef, symbolFontRef });
    characterChars += count;
  }
  return characterChars === covered && cursor.done ? result : null;
}
