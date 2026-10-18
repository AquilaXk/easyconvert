import { describe, expect, it } from 'vitest';
import { convertFont } from '../src/lib/conversions/font';
import { readType1Font } from '../src/lib/conversions/font-type1';
import { type1ToOpenType } from '../src/lib/conversions/font-fontforge';
import { UnprocessableFontInputError } from '../src/lib/types';
import { expectSameOutlines, readFontFacts, type OutlineTolerance } from './helpers/font-outline-oracle';
import { haveType1Oracles } from './helpers/fontforge-tool';
import { requireRealworldSample } from './helpers/realworld-sample';
import { buildPfa, buildPfb, circleGlyph, rectangleGlyph, type Type1Glyph } from './helpers/type1-builder';

/**
 * PostScript Type 1 fonts converted by the real FontForge. fontTools, which shares no code with the converter, reads the Type 1 source and
 * every result: the glyph count, the family name and each glyph's advance, outline area and bounding box must survive. Without FontForge
 * or fontTools a run that is not strict skips; ORACLE_STRICT_MODE=1 fails, so CI cannot pass without having converted a Type 1 font.
 */

const SAMPLES = ['ft-testt1-regular.pfa', 'ft-testt1-ellipsis-hinted.pfa', 'ft-testt1-regular.pfb'] as const;
/** OpenType keeps the cubic outlines FontForge reads: the rounding of its integer coordinates is all that may differ. */
const OTF_TOLERANCE: OutlineTolerance = { area: 0.0005, units: 1 };
/** TrueType outlines are quadratic: a curve is approximated, and the coordinates round to integers. */
const TTF_TOLERANCE: OutlineTolerance = { area: 0.01, units: 2 };
const SFNT_TRUETYPE = '\u0000\u0001\u0000\u0000';
const SFNT_CFF = 'OTTO';
const TIMEOUT_MS = 60_000;

/** A font with curves and a font whose private dictionary is spelled the way FontForge reads only with LF line endings. */
const BUILT_GLYPHS: Type1Glyph[] = [rectangleGlyph('.notdef', 500, 50, 400, 700), rectangleGlyph('A', 600, 40, 300, 650), circleGlyph('O', 700, 300), { name: 'space', width: 250, steps: [] }];

describe.skipIf(!haveType1Oracles)('Type 1 fonts converted through FontForge', () => {
  for (const id of SAMPLES) {
    describe(`real sample ${id}`, () => {
      for (const [target, flavor, tolerance] of [
        ['otf', SFNT_CFF, OTF_TOLERANCE],
        ['ttf', SFNT_TRUETYPE, TTF_TOLERANCE],
      ] as const) {
        it(`converts to ${target} with the glyphs, the family name and the outlines of the source`, { timeout: TIMEOUT_MS }, async (ctx) => {
          const sample = await requireRealworldSample(ctx, id);
          const truth = readFontFacts('type1', sample.bytes, sample.format);
          const result = await convertFont(sample.bytes, sample.format, target, {}, id);
          const facts = readFontFacts('sfnt', result.buffer, target);
          expect(result.filename).toBe(`${id.replace(/\.[^.]+$/, '')}.${target}`);
          expect(facts.flavor).toBe(flavor);
          expect(facts.familyName).toBe(truth.familyName);
          expect(truth.glyphCount).toBe(6);
          expectSameOutlines(facts, truth, tolerance);
        });
      }
    });
  }

  describe('built fonts, with curves', () => {
    const built = [
      ['PFA, symbol procedures, CRLF (the spelling FontForge reads as an empty font)', buildPfa(BUILT_GLYPHS, { lineEnding: '\r\n' }), 'pfa'],
      ['PFA, RD ND NP, CR', buildPfa(BUILT_GLYPHS, { procedures: 'words', lineEnding: '\r' }), 'pfa'],
      ['PFB, symbol procedures, CRLF', buildPfb(BUILT_GLYPHS, { lineEnding: '\r\n' }), 'pfb'],
      ['PFB, binary data in segments', buildPfb(BUILT_GLYPHS, { binarySegmentBytes: 100 }), 'pfb'],
    ] as const;

    it.each(built)('%s converts to otf and ttf with every glyph', { timeout: TIMEOUT_MS }, async (_label, bytes, format) => {
      const truth = readFontFacts('type1', buildPfb(BUILT_GLYPHS), 'pfb');
      for (const [target, tolerance] of [['otf', OTF_TOLERANCE], ['ttf', TTF_TOLERANCE]] as const) {
        const result = await convertFont(bytes, format, target, {}, 'built');
        const facts = readFontFacts('sfnt', result.buffer, target);
        expect(facts.familyName, target).toBe('Built T1');
        expectSameOutlines(facts, truth, tolerance);
      }
    });

    it('converts to woff and woff2 through the same SFNT: the same glyphs and outlines', { timeout: TIMEOUT_MS }, async () => {
      const truth = readFontFacts('type1', buildPfb(BUILT_GLYPHS), 'pfb');
      for (const target of ['woff', 'woff2'] as const) {
        const result = await convertFont(buildPfa(BUILT_GLYPHS), 'pfa', target, {}, 'built');
        expectSameOutlines(readFontFacts('sfnt', result.buffer, target), truth, OTF_TOLERANCE);
      }
    });

    it('never lets the name of the uploaded file reach FontForge', { timeout: TIMEOUT_MS }, async () => {
      const result = await convertFont(buildPfa(BUILT_GLYPHS), 'pfa', 'otf', {}, 'a b\';Quit();"$(id).pfa');
      expect(result.filename).toBe('a b\';Quit();"$(id).otf');
      expect(readFontFacts('sfnt', result.buffer, 'otf').glyphCount).toBe(BUILT_GLYPHS.length);
    });
  });

  it('refuses to hand back a font from which FontForge dropped glyphs: the raw CRLF file reads as one empty glyph', { timeout: TIMEOUT_MS }, async () => {
    const raw = buildPfa(BUILT_GLYPHS, { lineEnding: '\r\n' });
    const failure = await type1ToOpenType({ glyphCount: readType1Font(raw).glyphCount, fontFile: raw }).catch((error: unknown) => error as Error);
    expect(failure).toBeInstanceOf(UnprocessableFontInputError);
    expect((failure as Error).message).toBe('FontForge read 1 of the 4 glyphs of this font, so the result would lose glyphs.');
  });
});
