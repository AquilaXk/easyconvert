import { describe, expect, it } from 'vitest';
import { convertFontToOpenTypeCff } from '../src/lib/conversions/font';
import { ConversionFailedError } from '../src/lib/types';
import { buildGlyfFont, type GlyfGlyphSpec } from './helpers/glyf-font-builder';
import { expectSizeIndependentOnInputs, SCALING_TEST_TIMEOUT_MS, settle } from './helpers/timing';

/**
 * Timing-ratio checks moved out of font-glyf-to-cff.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 * The PR gate keeps a hang guard on the same hostile input in font-glyf-to-cff.test.ts.
 */

describe('TrueType to CFF: composite expansion is bounded across the whole font', () => {
  const RING_POINTS = 32;

  const RING_RADIUS = 100;

  const FULL_TURN = 2 * Math.PI;

  const SHARED_COMPONENTS = 1000;

  const COMPOSITE_GLYPHS = 1000;

  const EXPANSION_FACTOR = 6;

  const RSS_GROWTH_LIMIT_BYTES = 400 * 1024 * 1024;

  const BYTES_PER_MB = 1024 * 1024;

  const SMALL_FONT_BYTES = 100 * 1024;

  const ring = Array.from({ length: RING_POINTS }, (_, i) => ({
    x: Math.round(RING_RADIUS * Math.cos((i / RING_POINTS) * FULL_TURN)),
    y: Math.round(RING_RADIUS * Math.sin((i / RING_POINTS) * FULL_TURN)),
  }));

  /** Glyph 1 is a ring, glyph 2 places it `shared` times, and every later glyph places glyph 2 once. */
  function amplifierFont(shared: number, composites: number): Buffer {
    const glyphs: GlyfGlyphSpec[] = [
      { codePoint: 0x41, advance: 500, contours: [ring] },
      { codePoint: 0x42, advance: 500, components: Array.from({ length: shared }, () => ({ glyphIndex: 1, dx: 0, dy: 0 })) },
    ];
    for (let i = 0; i < composites; i++) glyphs.push({ advance: 500, components: [{ glyphIndex: 2, dx: 0, dy: 0 }] });
    return buildGlyfFont({ family: 'Amplifier', glyphs });
  }

  it('rejects a small font whose composites expand to tens of millions of points, quickly and without large allocations', async () => {
    // The same number of glyphs, claiming 32 million points in one font and six times as many in the other: the
    // amplification guard refuses both after reading the glyphs, so the time must not follow the claimed expansion
    // (tests/helpers/timing.ts). Growing the glyph count as well would grow the reading, which is legitimate work.
    const modest = amplifierFont(SHARED_COMPONENTS, COMPOSITE_GLYPHS);
    const huge = amplifierFont(SHARED_COMPONENTS * EXPANSION_FACTOR, COMPOSITE_GLYPHS);
    expect(modest.length).toBeLessThan(SMALL_FONT_BYTES);
    expect(huge.length).toBeLessThan(SMALL_FONT_BYTES);
    const rssBefore = process.memoryUsage().rss;
    const { largeResult } = await expectSizeIndependentOnInputs(
      'composite amplification',
      (font: Buffer) => settle(() => convertFontToOpenTypeCff(font)),
      { modest, huge }
    );
    const rssGrowth = process.memoryUsage().rss - rssBefore;
    if (largeResult.ok) throw new Error('the amplifying font was converted instead of rejected');
    expect(largeResult.error, 'conversion must throw').toBeInstanceOf(ConversionFailedError);
    expect((largeResult.error as Error).message).toMatch(/points|expand/i);
    expect(rssGrowth, `rss grew by ${Math.round(rssGrowth / BYTES_PER_MB)} MB`).toBeLessThan(RSS_GROWTH_LIMIT_BYTES);
  }, SCALING_TEST_TIMEOUT_MS);
});
