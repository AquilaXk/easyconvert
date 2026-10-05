import { describe, expect, it } from 'vitest';
import { parseSvgFontDocument, SvgFontFormatError, type SvgFont } from '../src/lib/conversions/font-svg';
import { ConversionFailedError } from '../src/lib/types';

/**
 * SVG 1.1 font document reading (section 20) and XML 1.0 lexical rules for start tags, comments and
 * attributes. Expected values are written by hand from the markup in each test. Every hostile input
 * is about 1 MB: a reader whose cost grows with the square of the input needs minutes for it, so a
 * wall-clock budget well above the linear cost proves the scan is linear without being flaky.
 */

const HOSTILE_BYTES = 1_000_000;
const LINEAR_SCAN_BUDGET_MS = 500;

const wrap = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg"><defs><font horiz-adv-x="1000"><font-face units-per-em="1000" ascent="800" descent="200"/>${body}</font></defs></svg>`;

function timed<T>(run: () => T): { result: T | null; error: unknown; elapsed: number } {
  const started = performance.now();
  let result: T | null = null;
  let error: unknown = null;
  try {
    result = run();
  } catch (caught) {
    error = caught;
  }
  return { result, error, elapsed: performance.now() - started };
}

function expectFormatError(error: unknown, pattern: RegExp): void {
  expect(error).toBeInstanceOf(SvgFontFormatError);
  expect(error).toBeInstanceOf(ConversionFailedError);
  expect((error as Error).message).toMatch(pattern);
}

describe('SVG font document: start tags, comments and attributes are scanned in linear time', () => {
  it('rejects a megabyte of unterminated comment openers quickly', () => {
    const { error, elapsed } = timed(() => parseSvgFontDocument(wrap('<!--'.repeat(HOSTILE_BYTES / 4))));
    expectFormatError(error, /comment/i);
    expect(elapsed).toBeLessThan(LINEAR_SCAN_BUDGET_MS);
  });

  it('rejects a megabyte of glyph tag openers that never close quickly', () => {
    const { error, elapsed } = timed(() => parseSvgFontDocument(wrap('<glyph '.repeat(HOSTILE_BYTES / 7))));
    expectFormatError(error, /<glyph>.*'<'|inside/i);
    expect(elapsed).toBeLessThan(LINEAR_SCAN_BUDGET_MS);
  });

  it('rejects a megabyte of unterminated attribute quotes quickly', () => {
    const { error, elapsed } = timed(() => parseSvgFontDocument(wrap('<glyph d="'.repeat(HOSTILE_BYTES / 10))));
    expectFormatError(error, /<glyph>|quote|'<'/i);
    expect(elapsed).toBeLessThan(LINEAR_SCAN_BUDGET_MS);
  });

  it('reads a glyph whose attribute name is a megabyte of junk without time growing quadratically', () => {
    const { result, error, elapsed } = timed(() => parseSvgFontDocument(wrap(`<glyph ${'a'.repeat(HOSTILE_BYTES)} />`)));
    expect(error).toBeNull();
    expect((result as SvgFont).glyphs).toHaveLength(1);
    expect((result as SvgFont).glyphs[0].d).toBeNull();
    expect(elapsed).toBeLessThan(LINEAR_SCAN_BUDGET_MS);
  });

  it('reads a glyph followed by a megabyte of attribute names without values quickly', () => {
    const names = 'abc '.repeat(HOSTILE_BYTES / 4);
    const { result, error, elapsed } = timed(() => parseSvgFontDocument(wrap(`<glyph ${names}unicode="Q" d="M0 0 H1 V1 Z"/>`)));
    expect(error).toBeNull();
    expect((result as SvgFont).glyphs[0].codePoint).toBe(0x51);
    expect(elapsed).toBeLessThan(LINEAR_SCAN_BUDGET_MS);
  });

  it('rejects a tag that is never closed, however long it runs', () => {
    const { error, elapsed } = timed(() => parseSvgFontDocument(`<svg><font><glyph ${'a '.repeat(HOSTILE_BYTES / 2)}`));
    expectFormatError(error, /not closed|unterminated/i);
    expect(elapsed).toBeLessThan(LINEAR_SCAN_BUDGET_MS);
  });

  it('rejects a numeric attribute that is a megabyte of digits followed by junk quickly', () => {
    const { error, elapsed } = timed(() =>
      parseSvgFontDocument(`<svg><font><font-face units-per-em="${'1'.repeat(HOSTILE_BYTES)}x"/><glyph unicode="A" d="M0 0"/></font></svg>`)
    );
    expectFormatError(error, /units-per-em.*not a finite number/);
    expect(elapsed).toBeLessThan(LINEAR_SCAN_BUDGET_MS);
  });
});

describe('SVG font document: the linear scanner reads the same documents as before', () => {
  it('finds the attributes of tags written with single quotes, spacing around = and a ">" inside a value', () => {
    const font = parseSvgFontDocument(
      wrap(`<glyph unicode = 'A' glyph-name="a>b" horiz-adv-x = "321"
        d='M0 0 L1 1 Z'/>`)
    ) as SvgFont;
    expect(font.glyphs).toHaveLength(1);
    expect(font.glyphs[0].codePoint).toBe(0x41);
    expect(font.glyphs[0].glyphName).toBe('a>b');
    expect(font.glyphs[0].advance).toBe(321);
    expect(font.glyphs[0].d).toBe('M0 0 L1 1 Z');
  });

  it('ignores glyph-like markup inside comments, also when the comment holds ">" and quotes', () => {
    const font = parseSvgFontDocument(
      wrap(`<!-- <glyph unicode="X" d="M0 0 H9"/> --><glyph unicode="A" d="M0 0 H1 V1 Z"/><!-- "unbalanced > '-->`)
    ) as SvgFont;
    expect(font.glyphs.map((glyph) => glyph.codePoint)).toEqual([0x41]);
  });

  it('keeps the first value of a repeated attribute and skips quoted text that is not an attribute value', () => {
    const font = parseSvgFontDocument(wrap(`<glyph unicode="A" unicode="B" "d=zzz" d="M0 0 H1 V1 Z"/>`)) as SvgFont;
    expect(font.glyphs[0].codePoint).toBe(0x41);
    expect(font.glyphs[0].d).toBe('M0 0 H1 V1 Z');
  });

  it('does not take elements whose names only start with a known name for glyphs', () => {
    const font = parseSvgFontDocument(wrap(`<glyph-group><glyph unicode="A" d="M0 0 H1 V1 Z"/></glyph-group><glyphx unicode="B"/>`)) as SvgFont;
    expect(font.glyphs.map((glyph) => glyph.codePoint)).toEqual([0x41]);
  });

  it('rejects a start tag that contains "<" outside an attribute value', () => {
    const { error } = timed(() => parseSvgFontDocument(wrap(`<glyph unicode="A" <glyph d="M0 0"/>`)));
    expectFormatError(error, /'<'/);
  });

  it('rejects an attribute value whose closing quote is missing', () => {
    const { error } = timed(() => parseSvgFontDocument(`<svg><font><glyph unicode="A`));
    expectFormatError(error, /quote|not closed|unterminated/i);
  });

  it('rejects an unterminated comment', () => {
    const { error } = timed(() => parseSvgFontDocument(wrap(`<glyph unicode="A" d="M0 0 H1 V1 Z"/><!-- never closed`)));
    expectFormatError(error, /comment/i);
  });
});
