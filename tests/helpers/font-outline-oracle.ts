import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'vitest';
import { runPythonHelper } from './python-oracle';

/**
 * Facts of a font file read by fontTools (tests/helpers/python/font_outline_facts.py): glyph count, family name and, per glyph, advance
 * width, outline area and bounding box in 1000-unit em coordinates. Nothing here imports from src/.
 */

export interface GlyphFacts {
  name: string;
  width: number;
  area: number;
  bbox: [number, number, number, number] | null;
}

export interface FontFacts {
  familyName: string;
  glyphCount: number;
  glyphs: GlyphFacts[];
  /** Type 1 only. */
  fontName?: string;
  /** SFNT only: 'OTTO' or '\0\1\0\0', and the table tags. */
  flavor?: string;
  tables?: string[];
}

/** Reads `bytes` as a font of `kind` ('type1' for a PFA or PFB file, 'sfnt' for TTF, OTF, WOFF and WOFF2) through fontTools. */
export function readFontFacts(kind: 'type1' | 'sfnt', bytes: Buffer, extension: string): FontFacts {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'font-facts-'));
  try {
    const file = path.join(directory, `font.${extension}`);
    fs.writeFileSync(file, bytes);
    return runPythonHelper<FontFacts>('font_outline_facts.py', [kind, file]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** Glyphs in an order that does not depend on the file's glyph order: converters rename and reorder glyphs, and the outlines are what must survive. */
function byOutline(glyphs: GlyphFacts[]): GlyphFacts[] {
  return [...glyphs].sort((a, b) => a.width - b.width || (a.bbox?.[0] ?? 0) - (b.bbox?.[0] ?? 0) || a.area - b.area);
}

export interface OutlineTolerance {
  /** Share of a glyph's area its converted area may differ by. */
  area: number;
  /** Em units (of 1000) a bounding-box edge and an advance width may differ by. */
  units: number;
}

/** Every glyph of `truth` has a glyph in `actual` with the same advance, outline area and bounding box, within `tolerance`. */
export function expectSameOutlines(actual: FontFacts, truth: FontFacts, tolerance: OutlineTolerance): void {
  expect(actual.glyphCount, 'glyph count').toBe(truth.glyphCount);
  const got = byOutline(actual.glyphs);
  const want = byOutline(truth.glyphs);
  expect(got).toHaveLength(want.length);
  want.forEach((glyph, index) => {
    const found = got[index];
    const label = `glyph ${glyph.name} (found ${found.name})`;
    expect(Math.abs(found.width - glyph.width), `${label} advance`).toBeLessThanOrEqual(tolerance.units);
    expect(Math.abs(found.area - glyph.area), `${label} area`).toBeLessThanOrEqual(glyph.area * tolerance.area);
    expect(found.bbox === null, `${label} is ${glyph.bbox === null ? 'empty' : 'drawn'}`).toBe(glyph.bbox === null);
    if (glyph.bbox !== null && found.bbox !== null) {
      glyph.bbox.forEach((edge, axis) => expect(Math.abs(found.bbox![axis] - edge), `${label} bbox[${axis}]`).toBeLessThanOrEqual(tolerance.units));
    }
  });
}
