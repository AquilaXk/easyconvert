import { describe, expect, it } from 'vitest';
import { parseSvgFontDocument, SvgFontFormatError, type SvgFont } from '../src/lib/conversions/font-svg';
import { ConversionFailedError } from '../src/lib/types';
import { expectLinearOnInputs, SCALING_FACTOR, SCALING_TEST_TIMEOUT_MS } from './helpers/timing';

/**
 * Timing-ratio checks moved out of font-svg-document.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 * The PR gate keeps a hang guard on the same hostile input in font-svg-document.test.ts.
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
