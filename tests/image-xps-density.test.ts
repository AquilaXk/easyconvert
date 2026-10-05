import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { convertImage } from '../src/lib/conversions/image';
import { buildOpenXpsPackage } from '../src/lib/conversions/openxps';
import { crc32, encodePng, rgbaImage, type PngImage } from './helpers/apng-builder';
import { SKIP_WITHOUT_MUPDF, renderXpsPoints } from './helpers/mupdf-render';
import { captureError } from './helpers/capture-error';

/**
 * An XPS image brush describes the picture in 1/96 inch units, so the viewbox of a picture stored at another
 * density is its pixel size times 96 / dpi. With the pixel size used as is, a 300 dpi picture covers only a
 * third of the viewport and a 72 dpi picture is cropped.
 *
 * Oracle: MuPDF renders the generated package; the picture is four flat quadrants and the viewport corners
 * must show the quadrant colours.
 */

const SIDE = 120;
const HALF = SIDE / 2;
const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const YELLOW = [255, 255, 0];
/** The fixed image viewport of the XPS page, in device-independent units: x 48..745, y 90..1070. */
const VIEWPORT = { left: 48, top: 90, right: 745, bottom: 1070 };
const INSET = 12;
const TOLERANCE = 12;
const PIXELS_PER_METRE = { 300: 11811, 96: 3780, 72: 2835 } as const;

const quadrants = (pixelsPerMetre?: number): PngImage => ({
  ...rgbaImage(SIDE, SIDE, (x, y) => {
    const colour = y < HALF ? (x < HALF ? RED : GREEN) : x < HALF ? BLUE : YELLOW;
    return [colour[0], colour[1], colour[2], 255];
  }),
  pixelsPerMetre,
});

const VIEWPORT_WIDTH = VIEWPORT.right - VIEWPORT.left;
const VIEWPORT_HEIGHT = VIEWPORT.bottom - VIEWPORT.top;
/** Just either side of the quadrant boundary a cropped or shrunken picture would move. */
const BEFORE_MIDDLE = 0.45;
const AFTER_MIDDLE = 0.55;
const NEAR_EDGE = 0.15;
const FAR_EDGE = 0.85;
const at = (fractionX: number, fractionY: number): [number, number] => [
  VIEWPORT.left + VIEWPORT_WIDTH * fractionX,
  VIEWPORT.top + VIEWPORT_HEIGHT * fractionY,
];

const CORNERS: Array<[string, [number, number], number[]]> = [
  ['top-left', [VIEWPORT.left + INSET, VIEWPORT.top + INSET], RED],
  ['top-right', [VIEWPORT.right - INSET, VIEWPORT.top + INSET], GREEN],
  ['bottom-left', [VIEWPORT.left + INSET, VIEWPORT.bottom - INSET], BLUE],
  ['bottom-right', [VIEWPORT.right - INSET, VIEWPORT.bottom - INSET], YELLOW],
  ['just left of the middle, top', at(BEFORE_MIDDLE, NEAR_EDGE), RED],
  ['just right of the middle, top', at(AFTER_MIDDLE, NEAR_EDGE), GREEN],
  ['just left of the middle, bottom', at(BEFORE_MIDDLE, FAR_EDGE), BLUE],
  ['just right of the middle, bottom', at(AFTER_MIDDLE, FAR_EDGE), YELLOW],
  ['just above the middle, left', at(NEAR_EDGE, BEFORE_MIDDLE), RED],
  ['just below the middle, left', at(NEAR_EDGE, AFTER_MIDDLE), BLUE],
];

describe('convertImage to xps keeps the picture whole at any stored density', () => {
  it.skipIf(SKIP_WITHOUT_MUPDF).each([
    ['300 dpi', PIXELS_PER_METRE[300]],
    ['72 dpi', PIXELS_PER_METRE[72]],
    ['96 dpi', PIXELS_PER_METRE[96]],
    ['no density', undefined],
  ])('%s picture', async (_label, pixelsPerMetre) => {
    for (const options of [{}, { stripMetadata: true }]) {
      const result = await convertImage(encodePng(quadrants(pixelsPerMetre)), 'xps', options, 'q.png', 'png');
      const render = renderXpsPoints(result.buffer, CORNERS.map(([, point]) => point));
      CORNERS.forEach(([name, , expected], index) => {
        const actual = render.pixels[index];
        expected.forEach((value, channel) => {
          expect(
            Math.abs(actual[channel] - value),
            `${JSON.stringify(options)} ${name} channel ${channel}: got ${actual[channel]}, expected ${value}`
          ).toBeLessThanOrEqual(TOLERANCE);
        });
      });
    }
  });
});

describe('buildOpenXpsPackage viewbox', () => {
  const page = (dpiX?: number, dpiY?: number) => ({
    title: 'p',
    image: { buffer: encodePng(quadrants()), format: 'png' as const, width: 300, height: 150, dpiX, dpiY },
  });
  const viewbox = async (xps: Buffer) => {
    const fpage = await (await JSZip.loadAsync(xps)).file('Documents/1/Pages/1.fpage')!.async('string');
    return /Viewbox="([^"]+)"/.exec(fpage)?.[1];
  };

  it.each([
    ['96 dpi', undefined, undefined, '0,0,300,150'],
    ['300 dpi', 300, 300, '0,0,96,48'],
    ['72 dpi', 72, 72, '0,0,400,200'],
    ['different density per axis', 300, 150, '0,0,96,96'],
  ])('%s', async (_label, dpiX, dpiY, expected) => {
    expect(await viewbox(await buildOpenXpsPackage([page(dpiX, dpiY)], 'doc'))).toBe(expected);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects a density of %s', async (dpi) => {
    const error = await captureError(() => buildOpenXpsPackage([page(dpi, dpi)], 'doc'));
    expect(error.name).toBe('ConversionFailedError');
    expect(error.message).toMatch(/XPS image on page 1 needs a positive density/);
  });
});

describe('convertImage to xps normalises the embedded picture to 96 dpi', () => {
  const embedded = async (xps: Buffer) => {
    const zip = await JSZip.loadAsync(xps);
    const fpage = await zip.file('Documents/1/Pages/1.fpage')!.async('string');
    const png = await zip.file('Documents/1/Resources/Images/image1.png')!.async('nodebuffer');
    return { viewbox: /Viewbox="([^"]+)"/.exec(fpage)?.[1], png };
  };
  const physicalSize = (png: Buffer): number[] | undefined => {
    const at = png.indexOf('pHYs', 0, 'latin1');
    return at < 0 ? undefined : [png.readUInt32BE(at + 4), png.readUInt32BE(at + 8), png[at + 12]];
  };

  it.each([
    ['300 dpi', PIXELS_PER_METRE[300]],
    ['72 dpi', PIXELS_PER_METRE[72]],
    ['no density', undefined],
  ])('%s source: pHYs says 96 dpi and the viewbox is the pixel size', async (_label, pixelsPerMetre) => {
    for (const options of [{}, { stripMetadata: true }]) {
      const result = await convertImage(encodePng(quadrants(pixelsPerMetre)), 'xps', options, 'q.png', 'png');
      const { viewbox, png } = await embedded(result.buffer);
      expect(viewbox, JSON.stringify(options)).toBe(`0,0,${SIDE},${SIDE}`);
      expect(physicalSize(png), JSON.stringify(options)).toEqual([PIXELS_PER_METRE[96], PIXELS_PER_METRE[96], 1]);
    }
  });

  it('keeps the picture intact: still a valid PNG ending in IEND with a correct pHYs CRC', async () => {
    const result = await convertImage(encodePng(quadrants(PIXELS_PER_METRE[300])), 'xps', {}, 'q.png', 'png');
    const { png } = await embedded(result.buffer);
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
    const at = png.indexOf('pHYs', 0, 'latin1');
    expect(png.readUInt32BE(at + 9 + 4)).toBe(crc32(png.subarray(at, at + 4 + 9)));
    expect(png.subarray(png.length - 8, png.length - 4).toString('latin1')).toBe('IEND');
  });
});
