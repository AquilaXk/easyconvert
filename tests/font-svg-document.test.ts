import { describe, expect, it } from 'vitest';
import { parseSvgFontDocument, SvgFontFormatError, type SvgFont } from '../src/lib/conversions/font-svg';
import { ConversionFailedError } from '../src/lib/types';
import { expectLinearOnInputs, expectNoHang, SCALING_FACTOR, SCALING_TEST_TIMEOUT_MS } from './helpers/timing';

/**
 * SVG 1.1 font document reading (section 20) and XML 1.0 lexical rules for start tags, comments and
 * attributes. Expected values are written by hand from the markup in each test. Each hostile input is
 * built at 1 MB and at 4 MB; a reader whose cost grows with the square of the input takes 16x as long on
 * the larger one, a linear scan about 4x (tests/helpers/timing.ts), whatever the runner's speed.
 */

const HOSTILE_BYTES = 1_000_000;
/** The unterminated-quote scan is fast enough that 1 MB runs in under a millisecond. */
const ATTRIBUTE_QUOTE_BASE_BYTES = 4 * HOSTILE_BYTES;

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

type Scan = { result: SvgFont | null; error: unknown };

/** Parses `build(HOSTILE_BYTES)` and `build(4 * HOSTILE_BYTES)`, asserts linear growth, returns the large outcome. */
async function expectLinearScan(label: string, build: (bytes: number) => string, baseBytes: number = HOSTILE_BYTES): Promise<Scan> {
  const { largeResult } = await expectLinearOnInputs(label, scan, { small: build(baseBytes), large: build(baseBytes * SCALING_FACTOR) });
  return largeResult;
}

function scan(document: string): Scan {
  const { result, error } = timed(() => parseSvgFontDocument(document));
  return { result, error };
}

/**
 * For hostile inputs the scanner finishes in a fraction of a millisecond even at 1 MB (one pass of `indexOf`),
 * so two sizes cannot be compared; a quadratic scan of the same input needs minutes, which the hang guard catches.
 */
async function expectScanDoesNotHang(label: string, document: string): Promise<Scan> {
  return expectNoHang(label, () => scan(document));
}

function expectFormatError(error: unknown, pattern: RegExp): void {
  expect(error).toBeInstanceOf(SvgFontFormatError);
  expect(error).toBeInstanceOf(ConversionFailedError);
  expect((error as Error).message).toMatch(pattern);
}

describe('SVG font document: start tags, comments and attributes are scanned in linear time', () => {
  it('rejects a megabyte of unterminated comment openers in linear time', async () => {
    const { error } = await expectLinearScan('comment openers', (bytes) => wrap('<!--'.repeat(bytes / 4)));
    expectFormatError(error, /comment/i);
  }, SCALING_TEST_TIMEOUT_MS);

  it('rejects a megabyte of glyph tag openers that never close in linear time', async () => {
    const { error } = await expectLinearScan('glyph openers', (bytes) => wrap('<glyph '.repeat(bytes / 7)));
    expectFormatError(error, /<glyph>.*'<'|inside/i);
  }, SCALING_TEST_TIMEOUT_MS);

  it('rejects a megabyte of unterminated attribute quotes in linear time', async () => {
    const { error } = await expectLinearScan('attribute quotes', (bytes) => wrap('<glyph d="'.repeat(bytes / 10)), ATTRIBUTE_QUOTE_BASE_BYTES);
    expectFormatError(error, /<glyph>|quote|'<'/i);
  }, SCALING_TEST_TIMEOUT_MS);

  it('reads a glyph whose attribute name is a megabyte of junk without time growing quadratically', async () => {
    const { result, error } = await expectLinearScan('junk attribute name', (bytes) => wrap(`<glyph ${'a'.repeat(bytes)} />`));
    expect(error).toBeNull();
    expect((result as SvgFont).glyphs).toHaveLength(1);
    expect((result as SvgFont).glyphs[0].d).toBeNull();
  }, SCALING_TEST_TIMEOUT_MS);

  it('reads a glyph followed by a megabyte of attribute names without values in linear time', async () => {
    const { result, error } = await expectLinearScan('valueless attribute names', (bytes) =>
      wrap(`<glyph ${'abc '.repeat(bytes / 4)}unicode="Q" d="M0 0 H1 V1 Z"/>`)
    );
    expect(error).toBeNull();
    expect((result as SvgFont).glyphs[0].codePoint).toBe(0x51);
  }, SCALING_TEST_TIMEOUT_MS);

  it('rejects a tag that is never closed, however long it runs', async () => {
    const { error } = await expectLinearScan('unclosed tag', (bytes) => `<svg><font><glyph ${'a '.repeat(bytes / 2)}`);
    expectFormatError(error, /not closed|unterminated/i);
  }, SCALING_TEST_TIMEOUT_MS);

  it('rejects a numeric attribute that is a megabyte of digits followed by junk in linear time', async () => {
    const { error } = await expectLinearScan(
      'digit run',
      (bytes) => `<svg><font><font-face units-per-em="${'1'.repeat(bytes)}x"/><glyph unicode="A" d="M0 0"/></font></svg>`
    );
    expectFormatError(error, /units-per-em.*not a finite number/);
  }, SCALING_TEST_TIMEOUT_MS);
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

describe('SVG font document: CDATA sections and the DOCTYPE are skipped, not read as markup', () => {
  const GLYPH = '<glyph unicode="A" d="M0 0 H1 V1 Z"/>';
  const codePoints = (font: SvgFont | null): Array<number | null> => (font as SvgFont).glyphs.map((glyph) => glyph.codePoint);

  it('parses a document whose CDATA section contains a comment opener', () => {
    const font = parseSvgFontDocument(`<svg><style><![CDATA[ /* <!-- */ ]]></style><defs><font><font-face units-per-em="1000"/>${GLYPH}</font></defs></svg>`);
    expect(codePoints(font)).toEqual([0x41]);
  });

  it('parses a document whose DOCTYPE internal subset has a comment opener in an entity literal', () => {
    const font = parseSvgFontDocument(`<!DOCTYPE svg [ <!ENTITY c "<!--"> ]><svg><defs><font><font-face units-per-em="1000"/>${GLYPH}</font></defs></svg>`);
    expect(codePoints(font)).toEqual([0x41]);
  });

  it('parses a DOCTYPE with public and system identifiers and a subset holding a comment and a single-quoted literal', () => {
    const doctype = `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://example.invalid/svg11.dtd" [ <!-- ] > --> <!ENTITY q '"<font>'> ]>`;
    const font = parseSvgFontDocument(`<?xml version="1.0"?>${doctype}<svg><font><font-face units-per-em="1000"/>${GLYPH}</font></svg>`);
    expect(codePoints(font)).toEqual([0x41]);
  });

  it('does not read glyph, font or comment markup inside CDATA as elements', () => {
    const cdata = '<![CDATA[ <font><glyph unicode="X" d="M0 0 H9"/></font> <!-- ]]>';
    const font = parseSvgFontDocument(`<svg><desc>${cdata}</desc><font><font-face units-per-em="1000"/>${cdata}${GLYPH}</font></svg>`);
    expect(codePoints(font)).toEqual([0x41]);
  });

  it('rejects a CDATA section that is never closed', () => {
    const { error } = timed(() => parseSvgFontDocument(wrap('<![CDATA[ <glyph unicode="A" d="M0 0"/>')));
    expectFormatError(error, /CDATA/);
  });

  it.each([
    ['a subset that is never closed', '<!DOCTYPE svg [ <!ENTITY a "x">'],
    ['a literal that is never closed', '<!DOCTYPE svg [ <!ENTITY a "x> ]>'],
    ['a DOCTYPE without its closing >', '<!DOCTYPE svg PUBLIC "a" "b"'],
    ['a comment inside the subset that is never closed', '<!DOCTYPE svg [ <!-- x ]>'],
  ])('rejects %s', (_name, doctype) => {
    const { error } = timed(() => parseSvgFontDocument(doctype));
    expectFormatError(error, /DOCTYPE|comment/i);
  });

  it('rejects a megabyte of CDATA openers, DOCTYPE openers and subset declarations without hanging', async () => {
    const shapes: Array<[string, string]> = [
      ['CDATA openers', wrap('<![CDATA['.repeat(HOSTILE_BYTES / 9))],
      ['DOCTYPE openers', '<!DOCTYPE '.repeat(HOSTILE_BYTES / 10)],
      ['entity declarations', wrap(`<!DOCTYPE svg [${'<!ENTITY a "x"> '.repeat(HOSTILE_BYTES / 16)}`)],
      ['subset quotes', wrap(`<!DOCTYPE svg [${'"'.repeat(HOSTILE_BYTES)}`)],
    ];
    for (const [label, document] of shapes) {
      const { error } = await expectScanDoesNotHang(label, document);
      expectFormatError(error, /CDATA|DOCTYPE|comment/i);
    }
  }, SCALING_TEST_TIMEOUT_MS);

  it('reads a megabyte of CDATA and of DOCTYPE subset full of comment openers without hanging', async () => {
    const cdata = `<![CDATA[${'<!-- <glyph '.repeat(HOSTILE_BYTES / 12)}]]>`;
    const subset = `<!DOCTYPE svg [ <!ENTITY c "${'<!--'.repeat(HOSTILE_BYTES / 4)}"> ]>`;
    const { result, error } = await expectScanDoesNotHang(
      'CDATA and subset comment openers',
      `${subset}<svg>${cdata}<font><font-face units-per-em="1000"/>${GLYPH}${cdata}</font></svg>`
    );
    expect(error).toBeNull();
    expect(codePoints(result)).toEqual([0x41]);
  }, SCALING_TEST_TIMEOUT_MS);
});
