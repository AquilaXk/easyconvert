import { describe, expect, it, vi } from 'vitest';
import { PdfTextGeometryError } from '../src/lib/conversions/pdf-text-types';

/**
 * The work and the size of the text that glyph names can cause. The name parser is wrapped to count its calls: the
 * count is the bound under test, so no wall-clock time is measured.
 */

const parsed = vi.hoisted(() => ({ names: [] as string[] }));

vi.mock('../src/lib/conversions/pdf-glyph-names', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/conversions/pdf-glyph-names')>();
  return {
    ...original,
    glyphNameToText: (name: string, options?: { dingbats?: boolean }) => {
      parsed.names.push(name);
      return original.glyphNameToText(name, options);
    },
  };
});

const { recoverUnmappedGlyphs } = await import('../src/lib/conversions/pdf-glyph-recovery');

const ITEM_CHARACTERS = 1_048_576;
const SINGLE_BYTE_CODES = 256;
const LONG_NAME_LENGTH = 100 * 1024;
/** 64 letters joined by underscores: the longest ligature name a PDF can hold. */
const LONGEST_LIGATURE = Array.from({ length: 64 }, () => 'f').join('_');

describe('recovering the glyphs of a simple font', () => {
  it('parses the name of a code once, however many times the code is shown', () => {
    parsed.names.length = 0;
    const font = { name: 'Garamond', differences: ['', 'f_f_i'] };
    const result = recoverUnmappedGlyphs('\u0001'.repeat(ITEM_CHARACTERS), font);
    expect(result.text).toBe('ffi'.repeat(ITEM_CHARACTERS));
    expect(parsed.names).toEqual(['f_f_i']);
  });

  it('parses at most one name per code of a font, and a name that maps to nothing once too', () => {
    parsed.names.length = 0;
    const font = { name: 'Garamond', differences: ['', 'zzz'] };
    const result = recoverUnmappedGlyphs('\u0001\u0002'.repeat(ITEM_CHARACTERS / 2), font);
    expect(result).toEqual({ text: '', unmapped: ITEM_CHARACTERS });
    expect(parsed.names.length).toBeLessThanOrEqual(SINGLE_BYTE_CODES);
  });

  it('leaves out the glyphs of a 100 KB name without reading its components', () => {
    parsed.names.length = 0;
    const font = { name: 'Garamond', differences: ['', 'f_'.repeat(LONG_NAME_LENGTH / 2)] };
    const result = recoverUnmappedGlyphs('\u0001'.repeat(ITEM_CHARACTERS), font);
    expect(result).toEqual({ text: '', unmapped: ITEM_CHARACTERS });
    expect(parsed.names).toHaveLength(1);
  });

  it('refuses a text that grows past the characters it may hold, with the error of the text limits', () => {
    const font = { name: 'Garamond', differences: ['', LONGEST_LIGATURE] };
    const budget = 1_000;
    const fits = recoverUnmappedGlyphs('\u0001'.repeat(budget / 64), font, budget);
    expect(fits.text).toHaveLength(Math.floor(budget / 64) * 64);
    const error = (() => {
      try {
        recoverUnmappedGlyphs('\u0001'.repeat(ITEM_CHARACTERS), font, budget);
      } catch (thrown) {
        return thrown;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(PdfTextGeometryError);
    expect((error as PdfTextGeometryError).status).toBe(400);
  });
});
