import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { CGM_MAX_PARAMETER_BYTES } from '../src/lib/conversions/cgm-binary';
import { cgmCellArrays, stretchDibRecordBytes, type RegionBitmap } from '../src/lib/conversions/metafile-bitmap';
import { readMetafilePage } from '../src/lib/conversions/vector-metafile';
import { cgmBinaryCellArray, cgmBinaryElements, cgmBinaryName, type BinaryCellArray } from './helpers/cgm-binary-oracle';
import { officeSuitePicture } from './helpers/metafile-fidelity';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * Entry 468: the parts of a page that the CGM writer cannot draw are cell arrays cut from Poppler's picture of the page, as the WMF writer writes a
 * bitmap record for them. A cell array is one element of at most 32,766 octets, since the office suite's reader takes the partition bit of the
 * length word as part of the length, so a bitmap is strips of whole rows that the reader joins.
 */

const RED: [number, number, number] = [255, 0, 0];
const GREEN: [number, number, number] = [0, 255, 0];
const BLUE: [number, number, number] = [0, 0, 255];
const YELLOW: [number, number, number] = [255, 255, 0];

/** A bitmap of four quadrants, red and green above, blue and yellow below, on the rectangle `rect`. */
function quadrants(width: number, height: number, rect: RegionBitmap['rect']): RegionBitmap {
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const colour = y < height / 2 ? (x < width / 2 ? RED : GREEN) : x < width / 2 ? BLUE : YELLOW;
      rgb.set(colour, (y * width + x) * 3);
    }
  }
  return { rect, width, height, rgb };
}

/** Every cell of the arrays, placed by the corner points they give, as rows of the whole bitmap. */
function stitched(arrays: BinaryCellArray[], bitmap: RegionBitmap, scale: number): [number, number, number][][] {
  const whole: [number, number, number][][] = Array.from({ length: bitmap.height }, () => []);
  const rowOf = (y: number) => Math.round(((y / scale - bitmap.rect.y0) * bitmap.height) / (bitmap.rect.y1 - bitmap.rect.y0));
  for (const array of arrays) {
    const top = rowOf(array.p.y);
    expect(rowOf(array.q.y), 'the rows of a strip end where its corner points say').toBe(top + array.rows);
    expect(array.r).toEqual({ x: array.q.x, y: array.p.y });
    array.cells.forEach((row, i) => whole[top + i].push(...row));
  }
  return whole;
}

describe('cell arrays of a CGM', () => {
  it('writes a bitmap with the corners P (top left), Q (bottom right) and R (top right) and rows from the top, each padded to a word', () => {
    const bitmap = quadrants(7, 5, { x0: 10, y0: 20, x1: 80, y1: 70 });
    const arrays = cgmCellArrays(bitmap, 1);
    expect(arrays).toHaveLength(1);
    const [element] = cgmBinaryElements(arrays[0]);
    expect(cgmBinaryName(element)).toBe('CELLARRAY');
    const cellArray = cgmBinaryCellArray(element.parameters);
    expect(cellArray).toMatchObject({ p: { x: 10, y: 20 }, q: { x: 80, y: 70 }, r: { x: 80, y: 20 }, columns: 7, rows: 5, precision: 24, mode: 1 });
    expect(cellArray.cells[0][0]).toEqual(RED);
    expect(cellArray.cells[0][6]).toEqual(GREEN);
    expect(cellArray.cells[4][0]).toEqual(BLUE);
    expect(cellArray.cells[4][6]).toEqual(YELLOW);
    // 7 cells of 3 octets are 21 octets, padded to 22
    expect(element.parameters.length).toBe(20 + 22 * 5);
  });

  it('scales the corners into the logical space of the file', () => {
    const [element] = cgmBinaryElements(cgmCellArrays(quadrants(4, 4, { x0: 10, y0: 20, x1: 30, y1: 60 }), 2)[0]);
    expect(cgmBinaryCellArray(element.parameters)).toMatchObject({ p: { x: 20, y: 40 }, q: { x: 60, y: 120 } });
  });

  it.each([
    [701, 81],
    [40, 900],
    [10_950, 3],
  ])('cuts a bitmap of %i by %i cells into elements that each fit one length word and lose no cell', (width, height) => {
    const bitmap = quadrants(width, height, { x0: 0, y0: 0, x1: width, y1: height });
    const arrays = cgmCellArrays(bitmap, 1);
    expect(arrays.length).toBeGreaterThan(1);
    const elements = arrays.map((array) => cgmBinaryElements(array)[0]);
    for (const element of elements) expect(element.parameters.length).toBeLessThanOrEqual(CGM_MAX_PARAMETER_BYTES);
    const cut = elements.map((element) => cgmBinaryCellArray(element.parameters));
    if (width > 10_000) {
      // wider than a row of an element: columns of strips, each a column apart
      expect(new Set(cut.map((array) => array.p.x)).size).toBe(2);
      expect(cut.reduce((sum, array) => sum + array.columns * array.rows, 0)).toBe(width * height);
      return;
    }
    const whole = stitched(cut, bitmap, 1);
    expect(whole.map((row) => row.length)).toEqual(Array.from({ length: height }, () => width));
    expect(whole[0][0]).toEqual(RED);
    expect(whole[0][width - 1]).toEqual(GREEN);
    expect(whole[height - 1][0]).toEqual(BLUE);
    expect(whole[height - 1][width - 1]).toEqual(YELLOW);
    expect(Buffer.from(whole.flat(2)).equals(bitmap.rgb)).toBe(true);
  });

  it('bounds the size a bitmap takes before any element is built', () => {
    for (const [width, height] of [[7, 5], [701, 81], [10_950, 3], [3000, 2000]]) {
      const bitmap = quadrants(width, height, { x0: 0, y0: 0, x1: width, y1: height });
      expect(stretchDibRecordBytes(bitmap, 'cgm')).toBeGreaterThanOrEqual(cgmCellArrays(bitmap, 1).reduce((sum, array) => sum + array.length, 0));
    }
  });

  it('gives a region of a page that the writer cannot draw a cell array in the place of the region, after the vector elements', () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="400" height="200"><rect x="5" y="5" width="30" height="30" fill="#ff0000"/><image x="100" y="60" width="200" height="100" xlink:href="${png}"/></svg>`
    );
    const page = readMetafilePage(svg, 'cgm');
    expect(page.regions).toHaveLength(1);
    const cgm = page.write([quadrants(40, 20, page.regions[0])]);
    const names = cgmBinaryElements(cgm).map(cgmBinaryName);
    expect(names.filter((name) => name === 'CELLARRAY')).toHaveLength(1);
    expect(names.indexOf('POLYGON')).toBeLessThan(names.indexOf('CELLARRAY'));
    expect(() => page.write([])).toThrow(/1 regions/);
  });
});

describe.skipIf(skipWithoutTools('soffice'))('cell arrays drawn by the office suite', () => {
  /** The suite draws a 400 by 200 picture over the 28 cm width of its slide: 1058 pixels, 2.645 to a unit. */
  const SLIDE_PIXELS_PER_UNIT = 1058 / 400;

  async function pixelAt(picture: Buffer, x: number, y: number): Promise<number[]> {
    const { data, info } = await sharp(picture).flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const at = (Math.round(y * SLIDE_PIXELS_PER_UNIT) * info.width + Math.round(x * SLIDE_PIXELS_PER_UNIT)) * 3;
    return [data[at], data[at + 1], data[at + 2]];
  }

  it.each([
    [40, 20],
    [701, 81],
  ])('draws a bitmap of %i by %i cells in the four colours of its quadrants where the region is', async (width, height) => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="400" height="200"><image x="100" y="60" width="200" height="100" xlink:href="${png}"/></svg>`
    );
    const page = readMetafilePage(svg, 'cgm');
    const region = page.regions[0];
    const picture = officeSuitePicture(page.write([quadrants(width, height, region)]), 'cgm');
    expect(picture, 'the office suite reads the file').toBeDefined();
    const left = region.x0 + (region.x1 - region.x0) * 0.25;
    const right = region.x0 + (region.x1 - region.x0) * 0.75;
    const top = region.y0 + (region.y1 - region.y0) * 0.25;
    const bottom = region.y0 + (region.y1 - region.y0) * 0.75;
    for (const [x, y, colour] of [[left, top, RED], [right, top, GREEN], [left, bottom, BLUE], [right, bottom, YELLOW]] as const) {
      const [r, g, b] = await pixelAt(picture as Buffer, x, y);
      expect([r, g, b], `the quadrant at (${Math.round(x)}, ${Math.round(y)})`).toEqual([...colour]);
    }
    expect(await pixelAt(picture as Buffer, 20, 20), 'outside the region the page is white').toEqual([255, 255, 255]);
  });
});
