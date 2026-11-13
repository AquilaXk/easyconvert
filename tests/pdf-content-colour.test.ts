import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { GlyphColours, ItemColours } from '../src/lib/conversions/pdf-content-colours';
import { analyzePdfPagesInProcess } from '../src/lib/conversions/pdf-text-geometry';
import { FillIndex } from '../src/lib/conversions/pdf-content-shapes';
import { dominantRuleInk, PageInk, readableRuns } from '../src/lib/conversions/pdf-layout/ink';
import type { PdfContentRule, PdfContentShape, PdfPageContent } from '../src/lib/conversions/pdf-text-types';

/**
 * The colour of text, rules and painted shapes read from the operator list of a PDF page (src/lib/conversions/pdf-content-colours.ts,
 * pdf-content-shapes.ts). The documents are the ones of tests/fixtures/pdf-colour, whose colours are those written in the sources.
 */

const FIXTURES = path.join(__dirname, 'fixtures', 'pdf-colour');

async function pageOf(name: string, colour: boolean): Promise<PdfPageContent> {
  const pdf = fs.readFileSync(path.join(FIXTURES, `${name}.pdf`));
  const result = await analyzePdfPagesInProcess(pdf, { geometry: 'none', content: true, colour });
  return result.content[0];
}

const hex = (color: number | undefined): string | undefined => (color === undefined ? undefined : color.toString(16).padStart(6, '0'));

function glyphs(...stretches: [string, number][]): GlyphColours {
  const recorded = new GlyphColours();
  for (const [text, color] of stretches) recorded.show([...text].map((unicode) => ({ unicode })), color, 0, 0);
  return recorded;
}

describe('colour of the text items', () => {
  it('gives the colour of each stretch of an item and nothing for black text', () => {
    const items = new ItemColours(glyphs(['A red ', 0xd32f2f], ['word', 0x1565c0], [' and plain', 0]).glyphs);
    expect(items.of('A red word and plain')).toEqual([
      { end: 6, color: 0xd32f2f },
      { end: 10, color: 0x1565c0 },
      { end: 20, color: 0 },
    ]);
    expect(new ItemColours(glyphs(['black', 0]).glyphs).of('black')).toBeUndefined();
  });

  it('follows the items in drawing order, spells ligatures in compatibility form and skips a space pdf.js added', () => {
    const items = new ItemColours(glyphs(['of', 0xff0000], ['ﬁ', 0x00ff00], ['sh', 0x00ff00], ['tail', 0x0000ff]).glyphs);
    expect(items.of('of')).toEqual([{ end: 2, color: 0xff0000 }]);
    // The space between the words takes the colour of the word before it.
    expect(items.of('fish tail')).toEqual([
      { end: 5, color: 0x00ff00 },
      { end: 9, color: 0x0000ff },
    ]);
  });

  it('finds an item again after glyphs that no item spells, and gives up on text the glyphs never show', () => {
    const items = new ItemColours(glyphs(['annotation', 0x123456], ['body', 0xabcdef]).glyphs);
    expect(items.of('body')).toEqual([{ end: 4, color: 0xabcdef }]);
    expect(items.of('absent')).toBeUndefined();
  });

  it('paints text that is only stroked with the stroke colour', () => {
    const recorded = new GlyphColours();
    recorded.show([{ unicode: 'o' }], 0xff0000, 0x00ff00, 1);
    expect(new ItemColours(recorded.glyphs).of('o')).toEqual([{ end: 1, color: 0x00ff00 }]);
  });
});

describe('the content of a page read with colour', () => {
  it('reads no colour, shapes or paint order when the job does not ask for them', async () => {
    const page = await pageOf('colour-text', false);
    expect(page.shapes).toBeUndefined();
    expect(page.items.every((item) => item.colors === undefined)).toBe(true);
    expect(page.rules.every((rule) => rule.color === undefined && rule.z === undefined)).toBe(true);
  });

  it('colours the words of a paragraph and keeps the rest black', async () => {
    const page = await pageOf('colour-text', true);
    const colourOf = (text: string): string | undefined => hex(page.items.find((item) => item.text === text)?.colors?.[0].color);
    expect(colourOf('red lantern')).toBe('d32f2f');
    expect(colourOf('blue lantern')).toBe('1565c0');
    expect(colourOf('bright orange flare')).toBe('e65100');
    expect(colourOf('White on charcoal')).toBe('ffffff');
    expect(colourOf('Closing remark in the default colour.')).toBeUndefined();
  });

  it('reads a fill behind the text as one rectangle even when the producer cut it at every font change', async () => {
    const page = await pageOf('colour-text', true);
    const fills = (page.shapes ?? []).filter((shape) => shape.kind === 'rect').map((shape) => hex(shape.fill));
    expect(fills).toEqual(['212121', 'ffeb3b', '1565c0']);
    const charcoal = page.shapes?.[0];
    const text = page.items.find((item) => item.text === 'White on charcoal');
    expect(text && charcoal && text.x >= charcoal.x0 - 1 && text.x + text.width <= charcoal.x1 + 1).toBe(true);
    // The run of light text on a fill says which fill.
    expect(hex(text?.fill)).toBe('212121');
    expect(page.items.find((item) => item.text === 'Black on yellow')?.fill).toBeUndefined();
    // A band that holds more than the run is no highlight of it.
    const chart = await pageOf('shapes-chart', true);
    expect(chart.items.find((item) => item.text === 'Harbour traffic by quarter')?.fill).toBeUndefined();
    // The thin pieces of the cut are part of the rectangle, so they are not drawn again as rules.
    expect(page.rules.filter((rule) => rule.inShape === true).length).toBeGreaterThan(0);
  });

  it('gives rules their colour and paints bars, a triangle and an ellipse as shapes in paint order', async () => {
    const page = await pageOf('shapes-chart', true);
    // The bars of the chart start half way along their base and so have six segments, which `paint_path` of pdfminer.six takes for curves.
    expect((page.shapes ?? []).filter((shape) => shape.kind === 'rect')).toEqual([]);
    const paths = (page.shapes ?? []).filter((shape) => shape.kind === 'path');
    // The triangle is filled and stroked by one operator; the ellipse is filled by one and stroked by the next, which is one shape.
    expect(paths.map((shape) => [hex(shape.fill), hex(shape.stroke)])).toEqual([
      ['0d47a1', undefined],
      ['1976d2', undefined],
      ['e53935', undefined],
      ['43a047', undefined],
      ['fb8c00', undefined],
      ['ce93d8', '4a148c'],
      ['80deea', '006064'],
    ]);
    // The ellipse is made of curves.
    expect(paths[6].path).toContain(2);
    const zs = [...(page.shapes ?? []).map((shape) => shape.z), ...page.rules.map((rule) => rule.z ?? -1)];
    expect(zs.every((z) => z >= 0)).toBe(true);
    // The base of the triangle is a rule its shape draws.
    expect(new Set(page.rules.filter((rule) => rule.inShape !== true).map((rule) => hex(rule.color)))).toEqual(new Set(['b0bec5', '8e0000', '37474f']));
  });

  it('leaves a stepped polyline to the rules and draws a curve as a stroked shape', async () => {
    const page = await pageOf('diagram', true);
    const strokedPaths = (page.shapes ?? []).filter((shape) => shape.stroke !== undefined);
    expect(strokedPaths.map((shape) => hex(shape.stroke))).toEqual(['00897b']);
    expect(page.rules.some((rule) => hex(rule.color) === 'c62828' && rule.inShape !== true)).toBe(true);
  });
});

describe('the fills and rules a layout looks up (src/lib/conversions/pdf-layout/ink.ts)', () => {
  const rect = (x0: number, y0: number, x1: number, y1: number, fill: number, z: number, alpha?: number): PdfContentShape => ({ kind: 'rect', x0, y0, x1, y1, fill, z, ...(alpha === undefined ? {} : { alpha }) });
  const box = { x0: 20, y0: 20, x1: 60, y1: 32 };

  it('finds the smallest rectangle that holds a box of text and notes it as carried', () => {
    const band = rect(0, 0, 600, 100, 0x0d47a1, 1);
    const badge = rect(10, 15, 80, 40, 0xffeb3b, 2);
    const index = new FillIndex([band, badge]);
    expect(index.behind(box)).toBe(0xffeb3b);
    expect(index.used.has(badge)).toBe(true);
    expect(index.used.has(band)).toBe(false);
    expect(index.behind({ x0: 20, y0: 70, x1: 60, y1: 82 })).toBe(0x0d47a1);
    expect(index.behind({ x0: 20, y0: 150, x1: 60, y1: 162 })).toBeUndefined();
  });

  it('takes no tint, no light fill and no rectangle that stops short of the text as the fill behind it', () => {
    expect(new FillIndex([rect(0, 0, 600, 100, 0xff0000, 1, 0.4)]).behind(box)).toBeUndefined();
    const paper = new PageInk([{ pageNumber: 1, width: 600, height: 800, items: [], rules: [], images: [], shapes: [rect(0, 0, 600, 100, 0xf8f8f8, 1)], unmappedGlyphs: 0, operatorsSkipped: false, rulesTruncated: false }]);
    expect(paper.fillBehind(1, box)).toBeUndefined();
    expect(new FillIndex([rect(30, 0, 600, 100, 0x00ff00, 1)]).behind(box)).toBeUndefined();
  });

  it('leaves light text light only where a fill is carried, and drops the run fill a paragraph or cell carries already', () => {
    const runs = [
      { text: 'white', bold: false, italic: false, monospace: false, color: 'FFFFFF' },
      { text: 'badge', bold: false, italic: false, monospace: false, color: 'F8F8F8', shading: '212121' },
      { text: 'red', bold: false, italic: false, monospace: false, color: 'D32F2F' },
    ];
    const carried = readableRuns(runs, true);
    expect(carried.map((run) => run.color)).toEqual(['FFFFFF', 'F8F8F8', 'D32F2F']);
    expect(carried.map((run) => run.shading)).toEqual([undefined, undefined, undefined]);
    const plain = readableRuns(runs, false);
    expect(plain[0].color).toBeUndefined();
    expect(plain[1].color).toBe('F8F8F8');
    expect(plain[1].shading).toBe('212121');
    expect(plain[2].color).toBe('D32F2F');
  });

  it('reads the colour that most of the length of a table\'s rules has, and says how much that is', () => {
    const rule = (x0: number, y0: number, x1: number, y1: number, color?: number): PdfContentRule => ({ x0, y0, x1, y1, thickness: 0.5, ...(color === undefined ? {} : { color }) });
    const table = { x0: 0, y0: 0, x1: 100, y1: 50 };
    const grey = dominantRuleInk([rule(0, 10, 100, 10, 0x808080), rule(0, 30, 100, 30, 0x808080), rule(50, 0, 50, 50, 0x808080), rule(0, 60, 100, 60, 0xff0000)], table);
    expect(grey).toEqual({ color: 0x808080, width: 0.5, share: 1 });
    const mixed = dominantRuleInk([rule(0, 10, 100, 10, 0x1565c0), rule(0, 30, 100, 30, 0xef6c00)], table);
    expect(mixed?.share).toBe(0.5);
    expect(dominantRuleInk([], table)).toBeNull();
  });
});
