import { describe, expect, it } from 'vitest';
import { extractTextFromDoc } from '../src/lib/conversions/office';
import { CheckedReader } from '../src/lib/conversions/office/cfb-streams';
import { DOC_MAX_STYLE_CHAIN, DOC_MAX_STYLES, StyleSheet } from '../src/lib/conversions/office/doc-style-sheet';
import { LegacyOfficeFormatError } from '../src/lib/conversions/office/legacy-office-errors';
import { buildCompoundFile } from './helpers/cfb-craft';
import { buildWordBinary, buildWordBinaryParts, type WordBinaryParts, type WordBuildOptions, type WordStyle } from './helpers/word-binary-builder';

/**
 * The font a Word 97-2003 run takes from its styles (#760, follow-up to #726). A run with no font of its own uses the
 * font of its character style (sprmCIstd in its Chpx), else the font of its paragraph style (the istd of its PapxFkp
 * entry), each followed up the istdBase chain of the style sheet, else the default character fonts. The documents are
 * written by hand from [MS-DOC] (Stshi, LPStd, Std, UpxChpx, PlcBtePapx, PapxFkp) by tests/helpers/word-binary-builder.ts;
 * the expected characters come from the Unicode Wingdings and Symbol charts, not from the reader.
 */

const HTTP_BAD_REQUEST = 400;

const FONTS = ['Times New Roman', 'Symbol', 'Wingdings', 'Arial', 'Webdings'] as const;
const F_TIMES = 0;
const F_SYMBOL = 1;
const F_WINGDINGS = 2;
const F_ARIAL = 3;
const F_WEBDINGS = 4;
const ISTD_NORMAL = 0;

/** Wingdings 0xFC is a check mark, Symbol 0xB7 a bullet, Webdings 0x61 a heavy check mark; written out from the charts. */
const WINGDINGS_CHECK = '';
const SYMBOL_BULLET = '';
const CHECK = '✓';
const BULLET = '•';

const NORMAL: WordStyle = { kind: 'paragraph', name: 'Normal', ftcAscii: F_TIMES, ftcFarEast: F_TIMES, ftcOther: F_TIMES };

function wingdingsStyle(basedOn?: number): WordStyle {
  return { kind: 'paragraph', name: 'Checks', basedOn, ftcAscii: F_WINGDINGS, ftcFarEast: F_WINGDINGS, ftcOther: F_WINGDINGS };
}

function inherit(kind: WordStyle['kind'], basedOn: number): WordStyle {
  return { kind, name: `Based on ${basedOn}`, basedOn, noCharacterProperties: true };
}

function build(text: string, options: Partial<WordBuildOptions>): Buffer {
  return buildWordBinary({ pieces: [{ text, compressed: false }], fonts: FONTS, styleFonts: { ascii: F_TIMES, farEast: F_TIMES, other: F_TIMES }, ...options });
}

function wrap(parts: WordBinaryParts): Buffer {
  return buildCompoundFile([
    { name: 'WordDocument', data: parts.word },
    { name: '1Table', data: parts.table },
  ]);
}

describe('Word 97-2003 fonts from paragraph styles', () => {
  it('maps a symbol character by the font its paragraph style sets', () => {
    const doc = build(`go ${WINGDINGS_CHECK}\r`, { styles: [NORMAL, wingdingsStyle()], paragraphs: [{ chars: 5, istd: 1 }] });
    expect(extractTextFromDoc(doc)).toBe(`go ${CHECK}`);
  });

  it('reads the paragraph style from the PapxInFkp form with a non-zero cb as well as the one with a zero cb', () => {
    const doc = build(`${WINGDINGS_CHECK}\r${WINGDINGS_CHECK}\r`, {
      styles: [NORMAL, wingdingsStyle()],
      paragraphs: [
        { chars: 2, istd: 1, withProperty: true },
        { chars: 2, istd: 1 },
      ],
    });
    expect(extractTextFromDoc(doc)).toBe(`${CHECK}\n${CHECK}`);
  });

  it('maps each paragraph by its own style', () => {
    const doc = build(`${SYMBOL_BULLET}\r${SYMBOL_BULLET}\r${SYMBOL_BULLET}\r`, {
      styles: [NORMAL, wingdingsStyle(), { kind: 'paragraph', name: 'Bullets', ftcAscii: F_SYMBOL, ftcFarEast: F_SYMBOL, ftcOther: F_SYMBOL }],
      paragraphs: [
        { chars: 2, istd: 2 },
        { chars: 2, istd: 1 },
        { chars: 2, istd: 2 },
      ],
    });
    // Wingdings 0xB7 is a clock face (U+1F550); Symbol 0xB7 is a bullet.
    expect(extractTextFromDoc(doc)).toBe(`${BULLET}\n\u{1F550}\n${BULLET}`);
  });

  it('follows the based-on chain to the first style that sets a font', () => {
    const doc = build(`${WINGDINGS_CHECK}\r`, {
      styles: [NORMAL, wingdingsStyle(), inherit('paragraph', 1), inherit('paragraph', 2), inherit('paragraph', 3)],
      paragraphs: [{ chars: 2, istd: 4 }],
    });
    expect(extractTextFromDoc(doc)).toBe(CHECK);
  });

  it('lets a derived style override the font of the style it is based on', () => {
    const doc = build(`${SYMBOL_BULLET}\r`, {
      styles: [NORMAL, wingdingsStyle(), { kind: 'paragraph', name: 'Own', basedOn: 1, ftcAscii: F_SYMBOL, ftcFarEast: F_SYMBOL, ftcOther: F_SYMBOL }],
      paragraphs: [{ chars: 2, istd: 2 }],
    });
    expect(extractTextFromDoc(doc)).toBe(BULLET);
  });

  it('resolves each font slot along the chain on its own', () => {
    // The derived style sets only the ASCII font (Arial); the other font still comes from the base (Wingdings).
    const doc = build(`${WINGDINGS_CHECK}\r`, {
      styles: [NORMAL, { kind: 'paragraph', name: 'Base', ftcOther: F_WINGDINGS }, { kind: 'paragraph', name: 'Derived', basedOn: 1, ftcAscii: F_ARIAL }],
      paragraphs: [{ chars: 2, istd: 2 }],
    });
    expect(extractTextFromDoc(doc)).toBe(CHECK);
  });

  it('takes the font of the Normal style for text without a paragraph entry', () => {
    const doc = build(`${WINGDINGS_CHECK}\r`, { styles: [{ ...NORMAL, ftcAscii: F_WINGDINGS, ftcFarEast: F_WINGDINGS, ftcOther: F_WINGDINGS }] });
    expect(extractTextFromDoc(doc)).toBe(CHECK);
  });

  it('falls back to the default character fonts of the style sheet when no style in the chain sets a font', () => {
    const doc = build(`${WINGDINGS_CHECK}\r`, {
      styleFonts: { ascii: F_WINGDINGS, farEast: F_WINGDINGS, other: F_WINGDINGS },
      styles: [{ ...NORMAL, noCharacterProperties: true }, inherit('paragraph', 0)],
      paragraphs: [{ chars: 2, istd: 1 }],
    });
    expect(extractTextFromDoc(doc)).toBe(CHECK);
  });

  it('leaves a character whose styles name no symbol font as the replacement mark', () => {
    const doc = build(`${WINGDINGS_CHECK}\r`, { styles: [NORMAL, inherit('paragraph', 0)], paragraphs: [{ chars: 2, istd: 1 }] });
    expect(extractTextFromDoc(doc)).toBe('�');
  });
});

describe('Word 97-2003 fonts from character styles and direct formatting', () => {
  const STYLES: WordStyle[] = [
    NORMAL,
    wingdingsStyle(),
    { kind: 'character', name: 'Bullets', ftcAscii: F_SYMBOL, ftcFarEast: F_SYMBOL, ftcOther: F_SYMBOL },
    inherit('character', 2),
  ];

  it('maps a symbol character by the font of its character style', () => {
    const doc = build(`${SYMBOL_BULLET}\r`, { styles: STYLES, runs: [{ chars: 1, istd: 2 }, { chars: 1 }] });
    expect(extractTextFromDoc(doc)).toBe(BULLET);
  });

  it('follows the based-on chain of a character style', () => {
    const doc = build(`${SYMBOL_BULLET}\r`, { styles: STYLES, runs: [{ chars: 1, istd: 3 }, { chars: 1 }] });
    expect(extractTextFromDoc(doc)).toBe(BULLET);
  });

  it('prefers the character style over the paragraph style', () => {
    const doc = build(`${SYMBOL_BULLET}\r`, { styles: STYLES, paragraphs: [{ chars: 2, istd: 1 }], runs: [{ chars: 1, istd: 2 }, { chars: 1 }] });
    expect(extractTextFromDoc(doc)).toBe(BULLET);
  });

  it('prefers the font set on the run over both styles', () => {
    const doc = build(`${WINGDINGS_CHECK}\r`, {
      styles: STYLES,
      paragraphs: [{ chars: 2, istd: 1 }],
      runs: [{ chars: 1, istd: 2, ftcAscii: F_WEBDINGS, ftcFarEast: F_WEBDINGS, ftcOther: F_WEBDINGS }, { chars: 1 }],
    });
    // Webdings 0xFC is a globe (U+1F30D); the run's own font wins over the Symbol character style and the Wingdings paragraph style.
    expect(extractTextFromDoc(doc)).toBe('\u{1F30D}');
  });

  it('uses the paragraph style for the characters of a run that sets no character style', () => {
    const doc = build(`a${WINGDINGS_CHECK}\r`, { styles: STYLES, paragraphs: [{ chars: 3, istd: 1 }], runs: [{ chars: 1, istd: 2 }, { chars: 2, ftcAscii: F_ARIAL }] });
    expect(extractTextFromDoc(doc)).toBe(`a${CHECK}`);
  });

  it('keeps a run whose only formatting is its character style', () => {
    const doc = build(`${SYMBOL_BULLET}${SYMBOL_BULLET}\r`, { styles: STYLES, runs: [{ chars: 1 }, { chars: 1, istd: 2 }, { chars: 1 }] });
    expect(extractTextFromDoc(doc)).toBe(`�${BULLET}`);
  });
});

describe('Word 97-2003 style sheet', () => {
  function read(parts: WordBinaryParts): StyleSheet {
    return StyleSheet.read(new CheckedReader(parts.table, 'Word document'), { fc: parts.layout.styleSheet.offset, lcb: parts.layout.styleSheet.length });
  }

  it('resolves a style once and hands out the same result for every later lookup', () => {
    const parts = buildWordBinaryParts({
      pieces: [{ text: 'x\r', compressed: false }],
      fonts: FONTS,
      styles: [NORMAL, wingdingsStyle(), inherit('paragraph', 1)],
    });
    const sheet = read(parts);
    expect(sheet.fontsOf(2)).toBe(sheet.fontsOf(2));
    expect(sheet.fontsOf(2)).toEqual({ ascii: F_WINGDINGS, farEast: F_WINGDINGS, other: F_WINGDINGS });
    expect(sheet.fontsOf(0)).toEqual({ ascii: F_TIMES, farEast: F_TIMES, other: F_TIMES });
  });

  it('reads a style sheet whose recorded length is shorter than the styles it holds', () => {
    // Some writers record only the head of the style sheet in the FIB; the styles still lie inside the table stream.
    const parts = buildWordBinaryParts({ pieces: [{ text: `${WINGDINGS_CHECK}\r`, compressed: false }], fonts: FONTS, styles: [NORMAL, wingdingsStyle()], paragraphs: [{ chars: 2, istd: 1 }] });
    const headOnly = 2 + 20; // cbStshi and the 20-byte Stshi
    parts.word.writeUInt32LE(headOnly, parts.layout.pairOffset(1) + 4);
    expect(extractTextFromDoc(wrap(parts))).toBe(CHECK);
  });
});

describe('Word 97-2003 malformed style sheets and style references', () => {
  function expectRefused(parts: WordBinaryParts, message: RegExp): void {
    let thrown: unknown;
    try {
      extractTextFromDoc(wrap(parts));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LegacyOfficeFormatError);
    expect((thrown as LegacyOfficeFormatError).status).toBe(HTTP_BAD_REQUEST);
    expect((thrown as LegacyOfficeFormatError).message).toMatch(message);
  }

  /** A document with one symbol character in a paragraph of style `istd`. */
  function document(styles: WordStyle[], istd: number, extra: Partial<WordBuildOptions> = {}): WordBinaryParts {
    return buildWordBinaryParts({
      pieces: [{ text: `${WINGDINGS_CHECK}\r`, compressed: false }],
      fonts: FONTS,
      styleFonts: { ascii: F_TIMES, farEast: F_TIMES, other: F_TIMES },
      styles,
      paragraphs: [{ chars: 2, istd }],
      ...extra,
    });
  }

  function chain(length: number): WordStyle[] {
    const styles: WordStyle[] = [NORMAL, wingdingsStyle()];
    while (styles.length < length) styles.push(inherit('paragraph', styles.length - 1));
    return styles;
  }

  it('accepts the unmodified document', () => {
    expect(extractTextFromDoc(wrap(document([NORMAL, wingdingsStyle()], 1)))).toBe(CHECK);
  });

  it('refuses styles that are based on each other', () => {
    const styles = [NORMAL, inherit('paragraph', 2), inherit('paragraph', 1)];
    expectRefused(document(styles, 1), /based on each other|cycle/);
  });

  it('refuses a style that is based on itself', () => {
    expectRefused(document([NORMAL, inherit('paragraph', 1)], 1), /based on each other|cycle/);
  });

  it('follows a chain of the greatest length and refuses a longer one', () => {
    // chain(n) holds Normal, the Wingdings style and n - 2 styles each based on the one before: the last passes through n - 1 styles.
    expect(extractTextFromDoc(wrap(document(chain(DOC_MAX_STYLE_CHAIN + 1), DOC_MAX_STYLE_CHAIN)))).toBe(CHECK);
    expectRefused(document(chain(DOC_MAX_STYLE_CHAIN + 2), DOC_MAX_STYLE_CHAIN + 1), new RegExp(`more than ${DOC_MAX_STYLE_CHAIN} styles`));
  });

  it('refuses a style based on a style the sheet does not hold', () => {
    expectRefused(document([NORMAL, inherit('paragraph', 99)], 1), /style 99 .*not in the style sheet|out of range/);
  });

  it('refuses a paragraph whose style the sheet does not hold', () => {
    expectRefused(document([NORMAL, wingdingsStyle()], 7), /style 7 .*not in the style sheet|out of range/);
  });

  it('refuses a character style the sheet does not hold', () => {
    const parts = buildWordBinaryParts({
      pieces: [{ text: `${WINGDINGS_CHECK}\r`, compressed: false }],
      fonts: FONTS,
      styles: [NORMAL, wingdingsStyle()],
      runs: [{ chars: 1, istd: 40 }, { chars: 1 }],
    });
    expectRefused(parts, /style 40 .*not in the style sheet|out of range/);
  });

  it('refuses a style sheet that declares more styles than an istd can name', () => {
    const parts = document([NORMAL, wingdingsStyle()], 1);
    parts.table.writeUInt16LE(DOC_MAX_STYLES + 1, parts.layout.styleSheet.offset + 2);
    expectRefused(parts, new RegExp(`more than ${DOC_MAX_STYLES} styles`));
  });

  it('refuses a style sheet that declares more styles than it holds', () => {
    const parts = document([NORMAL, wingdingsStyle()], 1);
    // 4095 styles of at least two bytes each cannot fit the few kilobytes of the table stream.
    parts.table.writeUInt16LE(DOC_MAX_STYLES, parts.layout.styleSheet.offset + 2);
    // The styles it declares past the two it holds are read from the structures that follow it in the table stream.
    expectRefused(parts, /style sheet ends before style|style \d+ runs past the end of the table stream/);
  });

  it('refuses a style whose size runs past the end of the table stream', () => {
    const parts = document([NORMAL, wingdingsStyle()], 1);
    parts.table.writeUInt16LE(0xffff, parts.layout.stdOffsets[1] - 2);
    expectRefused(parts, /style 1 .*(past|outside)/);
  });

  it('refuses a style whose property blocks run past the style', () => {
    const parts = document([NORMAL, wingdingsStyle()], 1);
    // The first UPX of a paragraph style starts after the 10-byte StdfBase and the Xstz name ("Checks" + terminator).
    const upxAt = parts.layout.stdOffsets[1] + 10 + 2 + ('Checks'.length + 1) * 2;
    parts.table.writeUInt16LE(0x7fff, upxAt);
    expectRefused(parts, /style 1 .*(past|outside)/);
  });

  it('refuses a style whose name runs past the style', () => {
    const parts = document([NORMAL, wingdingsStyle()], 1);
    parts.table.writeUInt16LE(0x7fff, parts.layout.stdOffsets[1] + 10);
    expectRefused(parts, /style 1 .*(past|outside)/);
  });

  it('refuses a PlcBtePapx whose size is not 4 + 8n', () => {
    const parts = document([NORMAL, wingdingsStyle()], 1);
    parts.word.writeUInt32LE(parts.layout.plcBtePapx.length + 1, parts.layout.pairOffset(13) + 4);
    expectRefused(parts, /paragraph formatting table size/);
  });

  it('refuses a PlcBtePapx that lies outside the table stream', () => {
    const parts = document([NORMAL, wingdingsStyle()], 1);
    parts.word.writeUInt32LE(parts.table.length + 4096, parts.layout.pairOffset(13));
    expectRefused(parts, /paragraph formatting table lies outside/);
  });

  it('refuses a PapxFkp that lies outside the WordDocument stream', () => {
    const parts = document([NORMAL, wingdingsStyle()], 1);
    parts.table.writeUInt32LE(0x3fffff, parts.layout.plcBtePapx.offset + 8);
    expectRefused(parts, /FKP page .* outside the WordDocument stream/);
  });

  it('refuses a PapxFkp with no entries or with more than a page can hold', () => {
    for (const count of [0, 30, 255]) {
      const parts = document([NORMAL, wingdingsStyle()], 1);
      parts.word[parts.layout.papxPages[0] + 511] = count;
      expectRefused(parts, /FKP page .* (holds|declares) .* paragraphs/);
    }
  });

  it('refuses a PapxFkp whose paragraph properties lie outside the page', () => {
    const parts = document([NORMAL, wingdingsStyle()], 1);
    // BxPap of the first paragraph: bOffset is its first byte, right after the offsets (crun is 1: 2 offsets of 4 bytes).
    parts.word[parts.layout.papxPages[0] + 8] = 255;
    expectRefused(parts, /paragraph properties .* outside/);
  });

  it('refuses a PapxFkp whose offsets are not in ascending order', () => {
    const parts = document([NORMAL, wingdingsStyle()], 1);
    parts.word.writeUInt32LE(0, parts.layout.papxPages[0] + 4);
    expectRefused(parts, /file offsets of the FKP page .* not in ascending order/);
  });

  it('refuses a PlcBtePapx that addresses one FKP page twice', () => {
    const parts = document([NORMAL, wingdingsStyle()], 1);
    const plc = parts.table.subarray(parts.layout.plcBtePapx.offset, parts.layout.plcBtePapx.offset + parts.layout.plcBtePapx.length);
    const doubled = Buffer.alloc(4 + 2 * 8);
    doubled.writeUInt32LE(plc.readUInt32LE(0), 0);
    doubled.writeUInt32LE(plc.readUInt32LE(4), 4);
    doubled.writeUInt32LE(plc.readUInt32LE(4), 8);
    doubled.writeUInt32LE(plc.readUInt32LE(8), 12);
    doubled.writeUInt32LE(plc.readUInt32LE(8), 16);
    parts.word.writeUInt32LE(parts.table.length, parts.layout.pairOffset(13));
    parts.word.writeUInt32LE(doubled.length, parts.layout.pairOffset(13) + 4);
    parts.table = Buffer.concat([parts.table, doubled]);
    expectRefused(parts, /FKP page .* addressed more than once/);
  });

  it('leaves a document without symbol characters untouched even when its style chain is cyclic', () => {
    const parts = buildWordBinaryParts({
      pieces: [{ text: 'Plain text only\r', compressed: false }],
      fonts: FONTS,
      styles: [NORMAL, inherit('paragraph', 2), inherit('paragraph', 1)],
      paragraphs: [{ chars: 16, istd: 1 }],
    });
    expect(extractTextFromDoc(wrap(parts))).toBe('Plain text only');
  });
});
