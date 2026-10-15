import { describe, expect, it } from 'vitest';
import { convertFont, FontOutlinesMissingError } from '../src/lib/conversions/font';
import { MAX_SVG_PATH_COMMANDS_PER_GLYPH } from '../src/lib/conversions/font-svg-path';
import { ConversionFailedError } from '../src/lib/types';
import { expectSizeIndependentOnInputs, SCALING_FACTOR, SCALING_TEST_TIMEOUT_MS } from './helpers/timing';

/**
 * Timing-ratio checks moved out of font-svg-glyph-outlines.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 * The PR gate keeps a hang guard on the same hostile input in font-svg-glyph-outlines.test.ts.
 */

const UNITS_PER_EM = 2048;
const ASCENT = 1600;
const DESCENT = -448;
const FONT_ADVANCE = 1200;

const FIXTURE_SVG = `<?xml version="1.0" standalone="no"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg">
  <defs>
    <font id="svgprobe" horiz-adv-x="${FONT_ADVANCE}">
      <font-face font-family="Svg Probe" units-per-em="${UNITS_PER_EM}" ascent="${ASCENT}" descent="${DESCENT}" />
      <missing-glyph horiz-adv-x="900" d="M100 0 H800 V1400 H100 Z" />
      <!-- 1 --><glyph unicode="A" glyph-name="A" horiz-adv-x="1300" d="M0 0 L650 1400 L1300 0 Z" />
      <!-- 2 --><glyph unicode="B" glyph-name="uni0042" d="M200 0 L200 1400 Q1000 1400 1000 700 Q1000 0 200 0 Z" />
      <!-- 3 --><glyph unicode="C" d="m0 0c0 1000 1000 1000 1000 0z" />
      <!-- 4 --><glyph unicode="D" d="M0 700 A700 700 0 1 1 1400 700 A700 700 0 1 1 0 700 Z" />
      <!-- 5 --><glyph unicode=" " horiz-adv-x="500" />
      <!-- 6 --><glyph unicode="ff" glyph-name="f_f" horiz-adv-x="700" d="M0 0 H600 V700 H0 Z" />
      <!-- 7 --><glyph glyph-name="alt.one" horiz-adv-x="1000" d="M0 0 H100 V100 Z" />
      <!-- 8 --><glyph unicode="&#x1F600;" horiz-adv-x="800" d="M100 100 H700 V700 H100 Z" />
      <!-- 9 --><glyph unicode="&amp;" horiz-adv-x="650" d="M0 0 H500 V500 Z" />
      <!-- 10 --><glyph unicode="A" arabic-form="final" horiz-adv-x="1111" d="M0 0 H100 V100 H0 Z" />
      <glyph unicode="V" orientation="v" horiz-adv-x="333" d="M0 0 H1 V1 Z" />
    </font>
  </defs>
</svg>`;

const svgBuffer = (text: string = FIXTURE_SVG): Buffer => Buffer.from(text, 'utf8');

async function convertSvg(target: string, text?: string): Promise<Buffer> {
  return (await convertFont(svgBuffer(text), 'svg', target, {}, 'probe.svg')).buffer;
}

function svgWith(glyphs: string, fontFace = `units-per-em="1000" ascent="800" descent="-200"`): string {
  return `<svg xmlns="http://www.w3.org/2000/svg"><defs><font horiz-adv-x="700">
    <font-face font-family="Variant" ${fontFace} />${glyphs}</font></defs></svg>`;
}

// ---------------------------------------------------------------------------
// Fail closed
// ---------------------------------------------------------------------------
async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error
  );
}

describe('SVG font: output point counts are bounded while paths are converted', () => {
  const AMPLIFIED_GLYPHS = 100;
  const ARC_REPEATS = MAX_SVG_PATH_COMMANDS_PER_GLYPH - 1;
  const TRUETYPE_POINT_LIMIT = 0xffff;
  const CUBIC_REPEATS = MAX_SVG_PATH_COMMANDS_PER_GLYPH - 1;
  const CUBIC_GLYPHS = 30;
  const BUDGET_GLYPHS = 70;
  const BUDGET_CUBICS = 1100;
  // Each of these cubics needs about 27 quadratic pieces, so a few dozen of them already exceed 65,535 points.
  const WIDE_CUBIC = 'C32000 0 -32000 0 0 0';
  const BIG_ARC = 'a12000 12000 0 1 1 1 0';

  /** `count` glyphs from number `first` on, each carrying the same path under the attribute `attribute`. */
  function glyphsWithPath(count: number, path: string, repeats: number, first = 0, attribute = 'd'): string {
    const d = `M0 0${` ${path}`.repeat(repeats)}`;
    return Array.from(
      { length: count },
      (_, i) => `<glyph unicode="&#x${(0x4e00 + first + i).toString(16)};" horiz-adv-x="500" ${attribute}="${d}"/>`
    ).join('');
  }

  /**
   * "Without converting them all": a font with four times as many hostile glyphs must be refused after about the same
   * work as the small one, because the conversion stops at the first glyph or shared budget that is exceeded
   * (tests/helpers/timing.ts). Converting every glyph would make the larger font take about 4x.
   *
   * The reader scans the whole document before it converts a glyph, so the two fonts have the same length: the glyphs
   * the smaller font lacks follow its hostile ones as inert glyphs, with the same path text under an attribute
   * that no one reads (`e` for `d`). Only the conversion of the hostile glyphs can then differ.
   */
  async function expectEarlyRejection(label: string, hostileGlyphs: number, path: string, repeats: number): Promise<unknown> {
    const hugeGlyphs = hostileGlyphs * SCALING_FACTOR;
    const modest = svgWith(
      glyphsWithPath(hostileGlyphs, path, repeats) + glyphsWithPath(hugeGlyphs - hostileGlyphs, path, repeats, hostileGlyphs, 'e')
    );
    const huge = svgWith(glyphsWithPath(hugeGlyphs, path, repeats));
    expect(modest.length).toBe(huge.length);
    // The smaller font must be refused too: one that is converted whole would be slower, not faster, and pass.
    expect(await failureOf(convertSvg('ttf', modest))).toBeInstanceOf(ConversionFailedError);
    const { largeResult } = await expectSizeIndependentOnInputs(label, (svg: string) => failureOf(convertSvg('ttf', svg)), {
      modest,
      huge,
    });
    return largeResult;
  }

  it('rejects glyphs whose arcs expand into far more curve pieces than the path allows, without converting them all', async () => {
    const failure = await expectEarlyRejection('arc amplification', AMPLIFIED_GLYPHS, BIG_ARC, ARC_REPEATS);
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect(failure).not.toBeInstanceOf(FontOutlinesMissingError);
    expect((failure as Error).message).toMatch(/more than \d+ points|too many segments/i);
  }, SCALING_TEST_TIMEOUT_MS);

  it('stops converting once the glyphs of the font together pass the shared point budget', async () => {
    // About 59,000 points per glyph (below the per-glyph limit): 70 of them pass the 4,000,000 point budget.
    const failure = await expectEarlyRejection('shared point budget', BUDGET_GLYPHS, WIDE_CUBIC, BUDGET_CUBICS);
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect(failure).not.toBeInstanceOf(FontOutlinesMissingError);
    expect((failure as Error).message).toMatch(/points together/);
  }, SCALING_TEST_TIMEOUT_MS);

  it('stops converting a glyph as soon as it passes the 65,535 points of the glyf format', async () => {
    const failure = await expectEarlyRejection('per-glyph point limit', CUBIC_GLYPHS, WIDE_CUBIC, CUBIC_REPEATS);
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect(failure).not.toBeInstanceOf(FontOutlinesMissingError);
    expect((failure as Error).message).toMatch(new RegExp(`more than ${TRUETYPE_POINT_LIMIT} points`));
  }, SCALING_TEST_TIMEOUT_MS);
});
