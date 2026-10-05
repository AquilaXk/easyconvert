import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { convertImage } from '../src/lib/conversions/image';
import { buildOpenXpsPackage, withPngDensity96 } from '../src/lib/conversions/openxps';
import { crc32, encodePng, rgbaImage, serializeChunks, type Chunk, type PngImage } from './helpers/apng-builder';
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

describe('withPngDensity96 does not leave a second, stale density in the picture', () => {
  const PNG_SIGNATURE_BYTES = 8;
  const CHUNK_OVERHEAD = 12;
  const TIFF_HEADER_BYTES = 8;
  const IFD_ENTRY_BYTES = 12;
  const TAG_X_RESOLUTION = 282;
  const TAG_Y_RESOLUTION = 283;
  const TAG_RESOLUTION_UNIT = 296;
  const TYPE_SHORT = 3;
  const TYPE_RATIONAL = 5;
  const INCHES = 2;
  const STALE_DPI = 300;
  const ENTRY_COUNT = 3;
  const RATIONAL_BYTES = 8;

  /** Little-endian TIFF/EXIF block that says the picture is 300 dpi (XResolution, YResolution, ResolutionUnit = inch). */
  function exifAt300Dpi(): Buffer {
    const ifdBytes = 2 + ENTRY_COUNT * IFD_ENTRY_BYTES + 4;
    const rationalsAt = TIFF_HEADER_BYTES + ifdBytes;
    const block = Buffer.alloc(rationalsAt + 2 * RATIONAL_BYTES);
    block.write('II', 0, 'latin1');
    block.writeUInt16LE(42, 2);
    block.writeUInt32LE(TIFF_HEADER_BYTES, 4);
    block.writeUInt16LE(ENTRY_COUNT, TIFF_HEADER_BYTES);
    const entry = (index: number, tag: number, type: number, value: number) => {
      const at = TIFF_HEADER_BYTES + 2 + index * IFD_ENTRY_BYTES;
      block.writeUInt16LE(tag, at);
      block.writeUInt16LE(type, at + 2);
      block.writeUInt32LE(1, at + 4);
      block.writeUInt32LE(value, at + 8);
    };
    entry(0, TAG_X_RESOLUTION, TYPE_RATIONAL, rationalsAt);
    entry(1, TAG_Y_RESOLUTION, TYPE_RATIONAL, rationalsAt + RATIONAL_BYTES);
    entry(2, TAG_RESOLUTION_UNIT, TYPE_SHORT, INCHES);
    [0, 1].forEach((index) => {
      block.writeUInt32LE(STALE_DPI, rationalsAt + index * RATIONAL_BYTES);
      block.writeUInt32LE(1, rationalsAt + index * RATIONAL_BYTES + 4);
    });
    return block;
  }

  function readChunks(png: Buffer): Chunk[] {
    const chunks: Chunk[] = [];
    let pos = PNG_SIGNATURE_BYTES;
    while (pos + CHUNK_OVERHEAD <= png.length) {
      const length = png.readUInt32BE(pos);
      chunks.push({ type: png.toString('latin1', pos + 4, pos + 8), data: png.subarray(pos + 8, pos + 8 + length) });
      pos += CHUNK_OVERHEAD + length;
    }
    return chunks;
  }

  const png300WithExif = (): Buffer => {
    const chunks = readChunks(encodePng(quadrants(PIXELS_PER_METRE[300])));
    chunks.splice(1, 0, { type: 'eXIf', data: exifAt300Dpi() });
    return serializeChunks(chunks);
  };

  it('drops the EXIF block whose resolution would contradict the 96 dpi chunk', () => {
    const source = png300WithExif();
    expect(readChunks(source).map((chunk) => chunk.type)).toEqual(['IHDR', 'eXIf', 'pHYs', 'IDAT', 'IEND']);
    const chunks = readChunks(withPngDensity96(source));
    expect(chunks.map((chunk) => chunk.type)).toEqual(['IHDR', 'pHYs', 'IDAT', 'IEND']);
    const physical = chunks[1].data;
    expect([physical.readUInt32BE(0), physical.readUInt32BE(4), physical[8]]).toEqual([PIXELS_PER_METRE[96], PIXELS_PER_METRE[96], 1]);
  });

  it('leaves the image data untouched', () => {
    const before = readChunks(png300WithExif()).find((chunk) => chunk.type === 'IDAT')!;
    const after = readChunks(withPngDensity96(png300WithExif())).find((chunk) => chunk.type === 'IDAT')!;
    expect(after.data.toString('hex')).toBe(before.data.toString('hex'));
  });
});
