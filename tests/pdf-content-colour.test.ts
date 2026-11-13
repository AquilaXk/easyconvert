import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { GlyphColours, ItemColours } from '../src/lib/conversions/pdf-content-colours';
import { analyzePdfPagesInProcess } from '../src/lib/conversions/pdf-text-geometry';
import type { PdfPageContent } from '../src/lib/conversions/pdf-text-types';

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
    // The thin pieces of the cut are part of the rectangle, so they are not drawn again as rules.
    expect(page.rules.filter((rule) => rule.inShape === true).length).toBeGreaterThan(0);
  });

  it('gives rules their colour and paints bars, a triangle and an ellipse as shapes in paint order', async () => {
    const page = await pageOf('shapes-chart', true);
    const rects = (page.shapes ?? []).filter((shape) => shape.kind === 'rect');
    expect(rects.map((shape) => hex(shape.fill))).toEqual(['0d47a1', '1976d2', 'e53935', '43a047', 'fb8c00']);
    const paths = (page.shapes ?? []).filter((shape) => shape.kind === 'path');
    // The triangle is filled and stroked by one operator; the ellipse is filled by one and stroked by the next, which is one shape.
    expect(paths.map((shape) => [hex(shape.fill), hex(shape.stroke)])).toEqual([
      ['ce93d8', '4a148c'],
      ['80deea', '006064'],
    ]);
    // The ellipse is made of curves.
    expect(paths[1].path).toContain(2);
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
