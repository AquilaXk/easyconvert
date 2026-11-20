import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { readFontFacts } from './helpers/font-outline-oracle';
import { pythonModuleAvailable } from './helpers/python-oracle';
import { skipUnless } from './helpers/strict-skip';

/**
 * The horizontal metrics of a font converted from an SVG font. hhea declares the number of long metrics (advance and left side
 * bearing) and every glyph after them repeats the last advance with a left side bearing only, so a font whose last glyphs share an
 * advance writes the shortest list. fontTools reads a WOFF2 file only when hhea declares that shortest list: it compiles the
 * reconstructed hmtx in that form and then finds hhea declaring more metrics than the table holds ("not enough 'hmtx' table
 * data"). The structure is read here from the bytes of the TTF; the independent oracle is fontTools, which opens the TTF, WOFF and WOFF2.
 */

const SFNT_RECORD_BYTES = 16;
const SFNT_HEADER_BYTES = 12;
const HHEA_NUMBER_OF_HMETRICS_AT = 34;

const font = (glyphs: string): string =>
  `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><defs><font id="Probe" horiz-adv-x="500"><font-face font-family="Probe" units-per-em="1000" ascent="800" descent="-200"/>${glyphs}</font></defs></svg>`;

const FONTS: Record<string, { svg: string; advances: number[]; longMetrics: number }> = {
  'every glyph has the default advance': {
    svg: font('<glyph unicode="A" d="M0 0L300 700L600 0z"/><glyph unicode="B" d="M0 0h500v700h-500z"/>'),
    advances: [500, 500, 500],
    longMetrics: 1,
  },
  'the last glyphs share an advance': {
    svg: font('<glyph unicode="A" horiz-adv-x="700" d="M10 0L300 700L600 0z"/><glyph unicode="B" d="M20 0h400v700h-400z"/><glyph unicode="C" d="M30 0h400v700h-400z"/>'),
    advances: [500, 700, 500, 500],
    longMetrics: 3,
  },
  'every advance differs': {
    svg: font('<glyph unicode="A" horiz-adv-x="610" d="M0 0L300 700L600 0z"/><glyph unicode="B" horiz-adv-x="620" d="M0 0h500v700h-500z"/>'),
    advances: [500, 610, 620],
    longMetrics: 3,
  },
};

function tableOf(sfnt: Buffer, tag: string): Buffer {
  const count = sfnt.readUInt16BE(4);
  for (let i = 0; i < count; i++) {
    const record = SFNT_HEADER_BYTES + i * SFNT_RECORD_BYTES;
    if (sfnt.toString('latin1', record, record + 4) === tag) return sfnt.subarray(sfnt.readUInt32BE(record + 8), sfnt.readUInt32BE(record + 8) + sfnt.readUInt32BE(record + 12));
  }
  throw new Error(`no ${tag} table`);
}

const convert = async (svg: string, target: string): Promise<Buffer> => (await convertFile(Buffer.from(svg), 'svgfont', target, {}, 'font.svg')).buffer;

describe.each(Object.entries(FONTS))('an SVG font where %s', (_name, probe) => {
  it('declares the shortest list of long metrics and an hmtx table of exactly that size', async () => {
    const ttf = await convert(probe.svg, 'ttf');
    const declared = tableOf(ttf, 'hhea').readUInt16BE(HHEA_NUMBER_OF_HMETRICS_AT);
    const hmtx = tableOf(ttf, 'hmtx');
    expect(declared).toBe(probe.longMetrics);
    expect(hmtx.length).toBe(declared * 4 + (probe.advances.length - declared) * 2);
    expect(Array.from({ length: probe.advances.length }, (_unused, glyph) => hmtx.readUInt16BE(Math.min(glyph, declared - 1) * 4))).toEqual(probe.advances);
  });

  describe.skipIf(skipUnless('fontTools and brotli for Python', pythonModuleAvailable('fontTools') && pythonModuleAvailable('brotli')))('read by fontTools', () => {
    it.each(['ttf', 'woff', 'woff2'])('opens the %s with every advance', async (target) => {
      const facts = readFontFacts('sfnt', await convert(probe.svg, target), target);
      expect(facts.glyphCount).toBe(probe.advances.length);
      expect(facts.glyphs.map((glyph) => glyph.width)).toEqual(probe.advances);
    });
  });
});
