import { describe, expect, it, vi } from 'vitest';
import type { PdfContentItem } from '../src/lib/conversions/pdf-text-types';
import { encodeSvgPageToDxf, encodeSvgPageToDxfWithText } from '../src/lib/conversions/vector-dxf';
import { recoverUnmappedGlyphs } from '../src/lib/conversions/pdf-glyph-recovery';
import { readDxf, withoutGeometry, type DxfTextRecord } from './helpers/dxf-reader';

/**
 * A page set in a bitmap font (dvips Type 3 fonts of 1-bit pictures) reaches the DXF writer as the SVG Poppler draws with
 * cairo: every character is `<use href="#glyph-F-G" x y>` of a group that holds `<rect mask>`, the mask holding the picture.
 * DXF holds no pictures, so the writer replaces the characters with TEXT in a stock font, as pstoedit does by default
 * (doc/pstoedit.tex, RESTRICTIONS: a non-standard font is mapped to a default font sized so that each text fragment keeps
 * its width). The characters come from the PDF's text layer (one run of shown text per item), placed at the run's baseline
 * origin and fitted to its width (TEXT alignment 5, Fit); the height is the cap height, which is what DXF readers take the
 * TEXT height to be (ezdxf addons/drawing/text.py `_get_cap_height`), measured on the capital letters' pictures.
 */

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNiAAAABgADNjd8qAAAAABJRU5ErkJggg==';
const PICTURE = `<image id="source-0" x="0" y="0" width="1" height="1" xlink:href="${PIXEL}"/>`;

/** A page as Poppler 24 writes it, one SVG unit to the point; Poppler 26 writes the size in `pt` (see the scaling test). */
function page(defs: string, body: string, unit = ''): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${PAGE_WIDTH}${unit}" height="${PAGE_HEIGHT}${unit}" viewBox="0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}">` +
    `<defs>${defs}</defs>${body}</svg>`
  );
}

/** A glyph whose picture spans `top` points above the baseline to `depth` points below it, as cairo writes it (300 dpi pixels scaled by 0.24). */
function glyph(id: string, top: number, depth = 0, width = 6): string {
  const scale = 0.24;
  return (
    `<mask id="m-${id}"><use xlink:href="#source-0"/></mask>` +
    `<g id="${id}"><rect x="0" y="0" width="${width / scale}" height="${(top + depth) / scale}" mask="url(#m-${id})" transform="matrix(${scale}, 0, 0, ${scale}, 0, ${-top})"/></g>`
  );
}

const use = (id: string, x: number, y: number): string => `<use xlink:href="#${id}" x="${x}" y="${y}"/>`;
const RULE = '<path fill="none" stroke="rgb(0%, 0%, 0%)" d="M 72 100 L 540 100"/>';

function item(text: string, x: number, baseline: number, width: number, font = 0, extra: Partial<PdfContentItem> = {}): PdfContentItem {
  return { text, x, baseline, width, size: 0.24, font, rtl: false, angled: false, vertical: false, ...extra };
}

/** The text layer of the page, in points as the PDF reader gives it. */
const layer = (items: PdfContentItem[]) => async () => ({ width: PAGE_WIDTH, height: PAGE_HEIGHT, items });

async function written(svg: string, items: PdfContentItem[]): Promise<ReturnType<typeof readDxf>> {
  return readDxf((await encodeSvgPageToDxfWithText(Buffer.from(svg), layer(items))).toString('utf-8'));
}

/** Coordinates are written with six decimals; four are compared. */
const round = (value: number): number => Math.round(value * 1e4) / 1e4;

function placement(text: DxfTextRecord): [string, number, number, number, number, number] {
  return [text.value, round(text.insert.x), round(text.insert.y), round(text.alignment?.x ?? Number.NaN), round(text.height), text.horizontalAlignment];
}

/** "Hi x" on one line in font 0 (H 8 pt tall, i 7, x 5), "ab" in font 1 (no capital letter; a 5, b 7). */
const DEFS = `${PICTURE}${glyph('g-H', 8)}${glyph('g-i', 7)}${glyph('g-x', 5)}${glyph('g-a', 5)}${glyph('g-b', 7)}${glyph('g-y', 5, 2)}`;
const LINE = `${use('g-H', 72, 90)}${use('g-i', 80, 90)}${use('g-x', 90, 90)}${use('g-a', 72, 120)}${use('g-b', 78, 120)}`;
const LINE_ITEMS = [item('Hi', 72, 90, 12), item(' ', 84, 90, 6), item('x', 90, 90, 5), item('ab', 72, 120, 12, 1)];

describe('bitmap-font characters written as DXF TEXT', () => {
  it('writes each run of the text layer that covers glyph pictures as one fitted TEXT on its baseline, beside the geometry', async () => {
    const dxf = await written(page(DEFS, `${RULE}<g fill="rgb(0%, 0%, 0%)">${LINE}</g>`), LINE_ITEMS);
    expect(dxf.entities).toHaveLength(1);
    expect(dxf.texts.map(placement)).toEqual([
      ['Hi', 72, PAGE_HEIGHT - 90, 84, 8, 5],
      ['x', 90, PAGE_HEIGHT - 90, 95, 8, 5],
      ['ab', 72, PAGE_HEIGHT - 120, 84, 7, 5],
    ]);
    expect(dxf.texts.every((text) => text.alignment?.y === text.insert.y && text.style === 'STANDARD' && text.layer === '0')).toBe(true);
    expect(dxf.styles).toEqual([{ name: 'STANDARD', font: 'txt' }]);
    expect(dxf.extMax.y).toBeCloseTo(PAGE_HEIGHT - 90 + 8, 6);
  });

  it('takes the height of a font from its capital letters, and of a font without one from the tallest glyph of each run', async () => {
    const defs = `${PICTURE}${glyph('g-H', 8)}${glyph('g-I', 8)}${glyph('g-A', 8.3)}${glyph('g-o', 5)}${glyph('g-l', 8.4)}`;
    const body = `${use('g-o', 72, 90)}${use('g-H', 100, 90)}${use('g-I', 106, 90)}${use('g-A', 112, 90)}${use('g-o', 72, 120)}${use('g-l', 100, 120)}`;
    const dxf = await written(page(defs, body), [
      item('o', 72, 90, 5),
      item('HIA', 100, 90, 18),
      item('o', 72, 120, 5, 1),
      item('l', 100, 120, 3, 1),
    ]);
    expect(dxf.texts.map((text) => [text.value, text.height])).toEqual([
      ['o', 8],
      ['HIA', 8],
      ['o', 5],
      ['l', 8.4],
    ]);
  });

  it('leaves outline-font text, white space and runs over no glyph picture to the geometry they already are', async () => {
    const dxf = await written(page(`${PICTURE}${glyph('g-H', 8)}`, use('g-H', 72, 90)), [
      item('H', 72, 90, 6),
      item('outline', 200, 90, 30),
      item('  ', 78, 90, 4),
      item('H', 72, 300, 6),
    ]);
    expect(dxf.texts.map((text) => text.value)).toEqual(['H']);
  });

  it('never reads the text layer of a page without glyph pictures, and writes that page byte for byte as before', async () => {
    const svg = Buffer.from(page('', RULE));
    const readText = vi.fn(layer([item('H', 72, 90, 6)]));
    const withText = await encodeSvgPageToDxfWithText(svg, readText);
    expect(readText).not.toHaveBeenCalled();
    expect(withText.equals(encodeSvgPageToDxf(svg))).toBe(true);
  });

  it('places the text in the units of the drawing when Poppler writes the page size in points (4/3 of a pixel)', async () => {
    const px = (points: number): number => round((points * 4) / 3);
    const dxf = await written(page(DEFS, LINE, 'pt'), LINE_ITEMS);
    expect(dxf.texts.map(placement)).toEqual([
      ['Hi', px(72), px(PAGE_HEIGHT - 90), px(84), px(8), 5],
      ['x', px(90), px(PAGE_HEIGHT - 90), px(95), px(8), 5],
      ['ab', px(72), px(PAGE_HEIGHT - 120), px(84), px(7), 5],
    ]);
  });

  it('writes a page of nothing but bitmap-font text', async () => {
    const dxf = await written(page(DEFS, LINE), LINE_ITEMS);
    expect(dxf.entities).toHaveLength(0);
    expect(dxf.texts).toHaveLength(3);
  });

  it('encodes what a TEXT string cannot hold literally: percent and caret codes, characters past ASCII, and characters past the BMP', async () => {
    const dxf = await written(page(DEFS, use('g-H', 72, 90)), [item('50% ^é\\𝑥#', 72, 90, 40)]);
    expect(dxf.texts.map((text) => text.value)).toEqual(['50%%% ^ \\U+00E9\\U+005C##']);
  });

  it('writes a glyph picture that no run of the text layer holds, or only white space does, as # over the picture', async () => {
    const withoutX = LINE_ITEMS.filter((candidate) => candidate.text !== 'x');
    expect((await written(page(DEFS, LINE), withoutX)).texts.map(placement)).toEqual([
      ['Hi', 72, PAGE_HEIGHT - 90, 84, 8, 5],
      ['ab', 72, PAGE_HEIGHT - 120, 84, 7, 5],
      ['#', 90, PAGE_HEIGHT - 90, 96, 5, 5],
    ]);
    const blankX = [...withoutX, item(' ', 90, 90, 5)];
    expect((await written(page(DEFS, LINE), blankX)).texts.map((text) => text.value)).toEqual(['Hi', 'ab', '#']);
  });

  it('keeps a glyph that has no Unicode value as #, the mark pstoedit writes for a character it cannot map', () => {
    expect(recoverUnmappedGlyphs('a\u0001b�c', null, Number.POSITIVE_INFINITY, '#')).toEqual({ text: 'a#b#c', unmapped: 2 });
    expect(recoverUnmappedGlyphs('a\u0001b', null)).toEqual({ text: 'ab', unmapped: 1 });
  });
});

describe('the copy of a page that an independent reader audits for its text', () => {
  it('drops the LINE and POLYLINE records with their vertices and keeps the header, the styles and every TEXT', async () => {
    const glyphLine = '<path fill="none" stroke="rgb(0%, 0%, 0%)" d="M 10 10 L 50 10"/>';
    const outline = '<path fill="rgb(0%, 0%, 0%)" d="M 20 200 L 30 200 L 30 210 L 20 210 Z"/>';
    const text = (await encodeSvgPageToDxfWithText(Buffer.from(page(DEFS, `${RULE}${glyphLine}${outline}${LINE}`)), layer(LINE_ITEMS))).toString('utf-8');
    const whole = readDxf(text);
    expect(whole.entities.length).toBeGreaterThan(1);
    const stripped = withoutGeometry(text);
    expect(stripped).not.toMatch(/^(LINE|POLYLINE|VERTEX|SEQEND)$/m);
    expect(stripped.length).toBeLessThan(text.length);
    expect(readDxf(stripped)).toEqual({ ...whole, entities: [] });
  });
});

describe('bitmap-font pages that stay refused for DXF', () => {
  const refused = (items: PdfContentItem[], svg = page(DEFS, LINE)): Promise<Buffer> => encodeSvgPageToDxfWithText(Buffer.from(svg), layer(items));

  it('a page whose text layer has no text for most of its glyph pictures, the rule of the PDF text reader', async () => {
    await expect(refused([])).rejects.toThrow(
      /^The page cannot be written as DXF: the PDF text layer has no text for most of its bitmap-font characters \(drawn as pictures\)\.$/
    );
    await expect(refused([item('  ', 72, 90, 30), ...LINE_ITEMS.slice(3)])).rejects.toThrow(/has no text for most of its bitmap-font characters/);
    await expect(refused([item('Hi', 72, 90, 12), item('x', 90, 90, 5), item('  ', 72, 120, 12, 1)])).resolves.toBeInstanceOf(Buffer);
  });

  it('bitmap-font text that is not horizontal', async () => {
    await expect(refused(LINE_ITEMS.map((candidate) => ({ ...candidate, angled: candidate.text === 'Hi' })))).rejects.toThrow(
      /^The page cannot be written as DXF: bitmap-font text that is not horizontal is not supported\.$/
    );
    await expect(refused(LINE_ITEMS.map((candidate) => ({ ...candidate, vertical: candidate.text === 'ab' })))).rejects.toThrow(/not horizontal/);
  });

  it('a run longer than the 255 characters an R12 TEXT holds', async () => {
    await expect(refused([item('H'.repeat(250), 72, 90, 12), ...LINE_ITEMS.slice(2)])).resolves.toBeInstanceOf(Buffer);
    await expect(refused([item(`H${'%'.repeat(85)}`, 72, 90, 12), ...LINE_ITEMS.slice(2)])).rejects.toThrow(
      /^The page cannot be written as DXF: a run of bitmap-font text is longer than the 255 characters a TEXT entity holds\.$/
    );
  });
});

describe('hostile bitmap-font pages', () => {
  it('refuses a run whose width is not finite instead of writing it, as a Type 3 font with zero widths gives', async () => {
    const page1 = page(DEFS, LINE);
    const infinite = [item('Hi', 72, 90, Number.POSITIVE_INFINITY), ...LINE_ITEMS.slice(1)];
    await expect(encodeSvgPageToDxfWithText(Buffer.from(page1), layer(infinite))).rejects.toThrow(
      /^The page cannot be written as DXF: bitmap-font text with a position or size that is not a finite number is not supported\.$/
    );
  });

  const MANY_PICTURES = 30_000;
  const pictures = (count: number): string => Array.from({ length: count }, () => '<use xlink:href="#source-0"/>').join('');

  it('reads a mask of 30,000 pictures once for 30,000 uses of its glyph, and writes one TEXT per run', async () => {
    const defs = `${PICTURE}<mask id="big">${pictures(MANY_PICTURES)}</mask><g id="g"><rect x="0" y="-8" width="5" height="8" mask="url(#big)"/></g>`;
    const uses = Array.from({ length: MANY_PICTURES }, (_, i) => use('g', i * 6, 90)).join('');
    const items = Array.from({ length: MANY_PICTURES }, (_, i) => item('H', i * 6, 90, 6));
    const started = Date.now();
    const dxf = await written(page(defs, uses), items);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(dxf.texts).toHaveLength(MANY_PICTURES);
  });

  it('refuses a page whose glyph uses pass the rendered-element budget before reading its text layer', async () => {
    const uses = Array.from({ length: 34_000 }, (_, i) => use('g-H', i % 600, 90 + Math.floor(i / 600))).join('');
    const readText = vi.fn(layer([]));
    await expect(encodeSvgPageToDxfWithText(Buffer.from(page(DEFS, uses)), readText)).rejects.toThrow(/more than 100000 rendered elements/);
    expect(readText).not.toHaveBeenCalled();
  });

  it('matches glyphs against a text layer of 200,000 runs on one baseline without comparing every pair', async () => {
    const items = Array.from({ length: 200_000 }, (_, i) => item('H', 1000 + i * 0.1, 90, 0.1));
    const glyphs = Array.from({ length: 5_000 }, (_, i) => use('g-H', 1000 + i * 0.4, 90)).join('');
    const started = Date.now();
    const dxf = await written(page(DEFS, glyphs), items);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(dxf.texts).toHaveLength(5_000);
  });
});
