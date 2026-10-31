import { describe, expect, it } from 'vitest';
import { MAX_PFB_SEGMENTS, MAX_TYPE1_CHARSTRING_ENTRIES, MAX_TYPE1_FILE_BYTES, readType1Font } from '../src/lib/conversions/font-type1';
import { CorruptStreamError, PayloadLimitError, UnprocessableFontInputError } from '../src/lib/types';
import { expectSameOutlines, readFontFacts } from './helpers/font-outline-oracle';
import { haveFontTools } from './helpers/fontforge-tool';
import {
  buildPfa,
  buildPfb,
  charstringCipher,
  circleGlyph,
  pfaWithGarbageRun,
  pfaWithHexRun,
  pfbWithPrivateDictionary,
  pfbWithZeroLengthSegments,
  pfaWithoutPrivateDictionary,
  rectangleGlyph,
  type Type1Glyph,
} from './helpers/type1-builder';
import { DEFAULT_HANG_GUARD_MS, expectWithinHangGuard } from './helpers/timing';

/**
 * The reader of PostScript Type 1 fonts (src/lib/conversions/font-type1.ts), which checks a file before FontForge sees it and rewrites it
 * as the one container FontForge reads in full: LF line endings in the text, a binary encrypted segment. The fonts are built by an
 * independent writer (tests/helpers/type1-builder.ts) and fontTools, which shares no code with the reader, says what is inside them.
 */

const GLYPHS: Type1Glyph[] = [
  rectangleGlyph('.notdef', 500, 50, 400, 700),
  rectangleGlyph('A', 600, 40, 300, 650),
  circleGlyph('O', 700, 300),
  { name: 'space', width: 250, steps: [] },
];

/** Every spelling of the same four-glyph font: the clear text, the container and the private dictionary differ, the glyphs do not. */
const SPELLINGS: Array<{ label: string; build: () => Buffer; extension: 'pfa' | 'pfb'; truth?: () => Buffer }> = [
  { label: 'PFA, LF', extension: 'pfa', build: () => buildPfa(GLYPHS) },
  { label: 'PFA, CRLF', extension: 'pfa', build: () => buildPfa(GLYPHS, { lineEnding: '\r\n' }) },
  { label: 'PFA, CR', extension: 'pfa', build: () => buildPfa(GLYPHS, { lineEnding: '\r' }) },
  { label: 'PFA, RD ND NP', extension: 'pfa', build: () => buildPfa(GLYPHS, { procedures: 'words', lineEnding: '\r\n' }) },
  { label: 'PFB, LF', extension: 'pfb', build: () => buildPfb(GLYPHS) },
  { label: 'PFB, CRLF', extension: 'pfb', build: () => buildPfb(GLYPHS, { lineEnding: '\r\n' }), truth: () => buildPfb(GLYPHS) },
  // fontTools reads neither a PFB with CRLF text nor one with several binary segments, so the truth for those is the same font in the plain spelling.
  { label: 'PFB, binary data in segments of 100 bytes', extension: 'pfb', build: () => buildPfb(GLYPHS, { binarySegmentBytes: 100 }), truth: () => buildPfb(GLYPHS) },
];

const PFB_MARKER = 0x80;
const PFB_ASCII = 1;
const PFB_BINARY = 2;
const PFB_END = 3;

function failureOf(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the reader to fail');
}

/** The segments of a PFB file, read from the Technical Note 5040 layout: marker, type, little-endian length, data. */
function pfbSegments(file: Buffer): Array<{ type: number; data: Buffer }> {
  const segments: Array<{ type: number; data: Buffer }> = [];
  let at = 0;
  while (file[at] === PFB_MARKER && file[at + 1] !== PFB_END) {
    const length = file.readUInt32LE(at + 2);
    segments.push({ type: file[at + 1], data: file.subarray(at + 6, at + 6 + length) });
    at += 6 + length;
  }
  expect(file.subarray(at)).toEqual(Buffer.from([PFB_MARKER, PFB_END]));
  return segments;
}

describe('readType1Font', () => {
  it.each(SPELLINGS)('counts the four glyphs of a $label font', ({ build }) => {
    expect(readType1Font(build()).glyphCount).toBe(GLYPHS.length);
  });

  it('is not confused by the word eexec in the name of the font: the encrypted part starts at currentfile eexec', () => {
    expect(readType1Font(buildPfa(GLYPHS, { fontName: 'eexec-Test' })).glyphCount).toBe(GLYPHS.length);
  });

  it('returns a PFB of an ASCII segment, one binary segment and an ASCII trailer, whatever the file was', () => {
    for (const { label, build } of SPELLINGS) {
      const segments = pfbSegments(readType1Font(build()).fontFile);
      expect(
        segments.map((segment) => segment.type),
        label,
      ).toEqual([PFB_ASCII, PFB_BINARY, PFB_ASCII]);
      expect(segments[0].data.toString('latin1'), label).not.toContain('\r');
      expect(segments[0].data.toString('latin1'), label).toMatch(/currentfile eexec\n$/);
      expect(segments[2].data.toString('latin1'), label).toMatch(/cleartomark\n$/);
    }
  });

  it('rewrites the spellings of one font that differ only in line endings and container to the same bytes', () => {
    const reference = readType1Font(buildPfb(GLYPHS)).fontFile;
    // The RD ND NP spelling is a different private dictionary text, not a different line ending.
    for (const { label, build } of SPELLINGS.filter((spelling) => !spelling.label.includes('RD ND NP'))) {
      expect(readType1Font(build()).fontFile.equals(reference), label).toBe(true);
    }
  });

  describe.skipIf(!haveFontTools)('read back by fontTools', () => {
    it.each(SPELLINGS)('keeps every glyph of a $label font: names, advances, outlines', ({ build, extension, truth }) => {
      const original = build();
      const expected = readFontFacts('type1', truth === undefined ? original : truth(), extension);
      const rewritten = readFontFacts('type1', readType1Font(original).fontFile, 'pfb');
      expect(rewritten.familyName).toBe(expected.familyName);
      expect(rewritten.glyphs.map((glyph) => glyph.name).sort()).toEqual(expected.glyphs.map((glyph) => glyph.name).sort());
      expectSameOutlines(rewritten, expected, { area: 0, units: 0 });
    });

    it('does not touch the bytes of a charstring that holds a CR, an LF or a CRLF', () => {
      // Search for glyph widths whose encrypted charstrings carry each line ending as data, then build a font of them: a reader that
      // normalised line endings over the whole private dictionary would change those charstrings.
      const holding = { crlf: [] as Type1Glyph[], cr: [] as Type1Glyph[], lf: [] as Type1Glyph[] };
      for (let width = 1; width < 20000 && (holding.crlf.length < 2 || holding.cr.length < 2 || holding.lf.length < 2); width++) {
        const glyph = rectangleGlyph(`g${width}`, width, 10, 100, 100);
        const cipher = charstringCipher(glyph);
        if (cipher.includes(Buffer.from('\r\n'))) holding.crlf.push(glyph);
        else if (cipher.includes(0x0d)) holding.cr.push(glyph);
        else if (cipher.includes(0x0a)) holding.lf.push(glyph);
      }
      const glyphs = [rectangleGlyph('.notdef', 500, 50, 400, 700), ...holding.crlf.slice(0, 2), ...holding.cr.slice(0, 2), ...holding.lf.slice(0, 2)];
      expect(glyphs.length, 'glyphs found whose charstrings hold CRLF, CR and LF').toBe(7);
      const original = buildPfb(glyphs, { lineEnding: '\r\n' });
      const rewritten = readFontFacts('type1', readType1Font(original).fontFile, 'pfb');
      expectSameOutlines(rewritten, readFontFacts('type1', buildPfb(glyphs), 'pfb'), { area: 0, units: 0 });
    });
  });
});

describe('readType1Font on files that are not Type 1 fonts', () => {
  it('answers a typed 400 for bytes that are neither a PFA nor a PFB', () => {
    const error = failureOf(() => readType1Font(Buffer.from('this is not a font at all')));
    expect(error).toBeInstanceOf(CorruptStreamError);
    expect((error as CorruptStreamError).status).toBe(400);
    expect(error.message).toMatch(/starts with neither/);
  });

  it('answers a typed 400 for an OpenType file named .pfa', () => {
    const error = failureOf(() => readType1Font(Buffer.concat([Buffer.from('OTTO'), Buffer.alloc(64)])));
    expect(error).toBeInstanceOf(CorruptStreamError);
    expect(error.message).toMatch(/starts with neither/);
  });

  it('answers a typed 400 for a PFB whose segment is longer than the file', () => {
    const file = buildPfb(GLYPHS);
    const error = failureOf(() => readType1Font(file.subarray(0, file.length - 40)));
    expect(error).toBeInstanceOf(CorruptStreamError);
    expect(error.message).toMatch(/segment/);
  });

  it('answers a typed 400 for a PFB segment of an unknown type', () => {
    const file = Buffer.from(buildPfb(GLYPHS));
    file[1] = 9;
    const error = failureOf(() => readType1Font(file));
    expect(error).toBeInstanceOf(CorruptStreamError);
    expect((error as CorruptStreamError).status).toBe(400);
    expect(error.message).toMatch(/unknown type 9/);
  });

  it('answers a typed 400 for a PFB without its end marker', () => {
    const file = buildPfb(GLYPHS);
    const error = failureOf(() => readType1Font(file.subarray(0, file.length - 2)));
    expect(error).toBeInstanceOf(CorruptStreamError);
    expect((error as CorruptStreamError).status).toBe(400);
    expect(error.message).toMatch(/end marker/);
  });

  it('answers a typed 400 for a PFB whose first segment is not PostScript', () => {
    const body = Buffer.from('plain text, no font here');
    const header = Buffer.from([PFB_MARKER, PFB_ASCII, body.length, 0, 0, 0]);
    const error = failureOf(() => readType1Font(Buffer.concat([header, body, Buffer.from([PFB_MARKER, PFB_END])])));
    expect(error).toBeInstanceOf(CorruptStreamError);
    expect((error as CorruptStreamError).status).toBe(400);
    expect(error.message).toMatch(/%!PS-AdobeFont or %!FontType1/);
  });

  it('answers a typed 400 for a PFA that has no encrypted part', () => {
    const error = failureOf(() => readType1Font(pfaWithoutPrivateDictionary()));
    expect(error).toBeInstanceOf(CorruptStreamError);
    expect(error.message).toMatch(/eexec/);
  });

  it('answers a typed 422 that names the reason for a font whose CharStrings dictionary is empty', () => {
    const error = failureOf(() => readType1Font(buildPfa([])));
    expect(error).toBeInstanceOf(UnprocessableFontInputError);
    expect((error as UnprocessableFontInputError).status).toBe(422);
    expect(error.message).toMatch(/CharStrings/);
  });

  it('answers a typed 422 for an encrypted run that holds no private dictionary', () => {
    const error = failureOf(() => readType1Font(pfaWithGarbageRun()));
    expect(error).toBeInstanceOf(UnprocessableFontInputError);
    expect(error.message).toMatch(/charstring/);
  });

  it('answers a typed 422 for a private dictionary whose charstring runs past its end', () => {
    const truncated = buildPfb([rectangleGlyph('.notdef', 500, 50, 400, 700), rectangleGlyph('A', 600, 40, 300, 650)]);
    // Cut the encrypted segment short and close the file properly: the container is intact, the dictionary inside is not.
    const segments = pfbSegments(truncated);
    const cut = segments[1].data.subarray(0, segments[1].data.length - 60);
    const header = (type: number, length: number) => Buffer.from([PFB_MARKER, type, length & 0xff, (length >> 8) & 0xff, 0, 0]);
    const file = Buffer.concat([header(PFB_ASCII, segments[0].data.length), segments[0].data, header(PFB_BINARY, cut.length), cut, header(PFB_ASCII, segments[2].data.length), segments[2].data, Buffer.from([PFB_MARKER, PFB_END])]);
    const error = failureOf(() => readType1Font(file));
    expect(error).toBeInstanceOf(UnprocessableFontInputError);
    expect((error as UnprocessableFontInputError).status).toBe(422);
    expect(error.message).toMatch(/cut short/);
  });
});

describe('readType1Font on files crafted to cost more than a font does', () => {
  /** A private dictionary of `count` charstrings of no bytes each: five bytes of file per entry. */
  const entryFlood = (count: number) =>
    pfbWithPrivateDictionary(Buffer.concat([Buffer.from('/RD {string currentfile exch readstring pop} def\n/CharStrings 1 dict dup begin\n'), Buffer.from('0 RD '.repeat(count)), Buffer.from('end currentfile closefile\n')]));
  /** The cases take up to 0.35 s on a fast core; the guard stops a reader that walks a flood of entries or segments more than once. */
  const HOSTILE_GUARD = { guardMs: DEFAULT_HANG_GUARD_MS, expectedLocalMs: 350 };
  const MAX_HEAP_GROWTH_BYTES = 256 * 1024 * 1024;

  /** Runs the reader on `file` and returns its failure with the milliseconds it took and the heap it left behind. */
  function refusal(file: Buffer): { error: Error; ms: number; heapBytes: number } {
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    const error = failureOf(() => readType1Font(file));
    return { error, ms: performance.now() - started, heapBytes: process.memoryUsage().heapUsed - heapBefore };
  }

  it('refuses a file over the size limit with a typed 413 that names the limit, before reading it', () => {
    const { error, ms } = refusal(Buffer.alloc(MAX_TYPE1_FILE_BYTES + 1, '%'));
    expect(error).toBeInstanceOf(PayloadLimitError);
    expect((error as PayloadLimitError).status).toBe(413);
    expect(error.message).toContain('16 MiB');
    expectWithinHangGuard('hostile Type 1 font', ms, HOSTILE_GUARD);
  });

  it('does not refuse a file of exactly the size limit for its size', () => {
    const file = Buffer.alloc(MAX_TYPE1_FILE_BYTES, ' ');
    file.write('%!FontType1-1.0', 0, 'latin1');
    const error = failureOf(() => readType1Font(file));
    expect(error).toBeInstanceOf(CorruptStreamError);
    expect(error.message).toMatch(/eexec/);
  });

  it('refuses a private dictionary of millions of empty charstrings, inside the size limit, fast and without holding them', () => {
    const { error, ms, heapBytes } = refusal(entryFlood(3_000_000));
    expect(error).toBeInstanceOf(PayloadLimitError);
    expect(error.message).toContain(`${MAX_TYPE1_CHARSTRING_ENTRIES}`);
    expectWithinHangGuard('hostile Type 1 font', ms, HOSTILE_GUARD);
    expect(heapBytes).toBeLessThan(MAX_HEAP_GROWTH_BYTES);
  });

  it('reads as many charstrings as a font can hold and refuses one more', () => {
    expect(readType1Font(entryFlood(MAX_TYPE1_CHARSTRING_ENTRIES)).glyphCount).toBe(MAX_TYPE1_CHARSTRING_ENTRIES);
    expect(failureOf(() => readType1Font(entryFlood(MAX_TYPE1_CHARSTRING_ENTRIES + 1)))).toBeInstanceOf(PayloadLimitError);
  });

  it('refuses a PFB of millions of empty segments, inside the size limit, fast', () => {
    const { error, ms, heapBytes } = refusal(pfbWithZeroLengthSegments(2_500_000));
    expect(error).toBeInstanceOf(PayloadLimitError);
    expect(error.message).toContain(`${MAX_PFB_SEGMENTS}`);
    expectWithinHangGuard('hostile Type 1 font', ms, HOSTILE_GUARD);
    expect(heapBytes).toBeLessThan(MAX_HEAP_GROWTH_BYTES);
  });

  it('counts the segments of a PFB: the limit itself is read, one more is refused', () => {
    // pfbWithZeroLengthSegments writes the text segment and then `count` empty binary ones; the file holds no font, so the one that is read is refused as a font.
    const atLimit = failureOf(() => readType1Font(pfbWithZeroLengthSegments(MAX_PFB_SEGMENTS - 1)));
    expect(atLimit).toBeInstanceOf(UnprocessableFontInputError);
    expect((atLimit as UnprocessableFontInputError).status).toBe(422);
    const overLimit = failureOf(() => readType1Font(pfbWithZeroLengthSegments(MAX_PFB_SEGMENTS)));
    expect(overLimit).toBeInstanceOf(PayloadLimitError);
    expect((overLimit as PayloadLimitError).status).toBe(413);
  });

  it('decodes a hexadecimal run of the size limit in a buffer of its own size: refused as a font, in bounded time and heap', () => {
    const { error, ms, heapBytes } = refusal(pfaWithHexRun(MAX_TYPE1_FILE_BYTES - 1024));
    expect(error).toBeInstanceOf(UnprocessableFontInputError);
    expectWithinHangGuard('hostile Type 1 font', ms, HOSTILE_GUARD);
    expect(heapBytes).toBeLessThan(MAX_HEAP_GROWTH_BYTES);
  });
});
