import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { emfStretchDib, wmfStretchDib } from '../src/lib/conversions/metafile-bitmap';
import { isTooComplexToDraw, MAX_RASTER_REGIONS, pageSizeFromRoot, RasterRegions, refusalKindOf } from '../src/lib/conversions/svg-raster-regions';
import { parseSvgGeometries } from '../src/lib/conversions/svg-geometry';
import { encodeCgm, encodeEmf, readMetafilePage } from '../src/lib/conversions/vector-metafile';
import { cgmBinaryElements, cgmBinaryName } from './helpers/cgm-binary-oracle';
import { CadGeometryUnavailableError, UnsupportedOptionError } from '../src/lib/types';
import {
  MAX_REGION_PIXELS,
  RASTER_FALLBACK_DPI,
  RASTER_FALLBACK_MIN_DPI,
  RasterFallbackTooLargeError,
  rasterFallbackDpi,
  renderRegionBitmaps,
  writeMetafilePageWithPictures,
} from '../src/worker/metafile-raster-fallback';

/**
 * The parts of a page that the in-process EMF and WMF writers cannot draw (a gradient, a mask, a clip that cannot be measured exactly, a
 * pen the format lacks) are written as a bitmap record each, cut from Poppler's picture of the page, and the rest stays vector (entry 459).
 */

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNiAAAABgADNjd8qAAAAABJRU5ErkJggg==';
const GRADIENT = '<linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>';

function page(body: string, defs = GRADIENT): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="150pt" height="75pt" viewBox="0 0 150 75"><defs>${defs}</defs>${body}</svg>`;
}

const BACKGROUND = '<rect x="0" y="0" width="150" height="75" fill="#ffffff"/>';
const BLACK = '<rect x="110" y="10" width="20" height="20" fill="#000000"/>';
const SHADED = '<rect x="15" y="15" width="45" height="30" fill="url(#g)"/>';
const INSIDE = '<rect x="25" y="25" width="10" height="10" fill="#00ff00"/>';

/** The records of an EMF file, in order, each with its bytes. */
function emfRecords(file: Buffer): Buffer[] {
  const records: Buffer[] = [];
  for (let at = 0; at < file.length; at += file.readUInt32LE(at + 4)) records.push(file.subarray(at, at + file.readUInt32LE(at + 4)));
  return records;
}

/** The record types of an EMF file, in order. */
function emfRecordTypes(file: Buffer): number[] {
  const types: number[] = [];
  for (let at = 0; at < file.length; at += file.readUInt32LE(at + 4)) types.push(file.readUInt32LE(at));
  return types;
}

/** The record functions of a placeable WMF file, in order. */
function wmfRecordFunctions(file: Buffer): number[] {
  const functions: number[] = [];
  for (let at = 22 + 18; at + 6 <= file.length; at += file.readUInt32LE(at) * 2) functions.push(file.readUInt16LE(at + 4));
  return functions;
}

const EMR_POLYGON16 = 86;
const EMR_STRETCHDIBITS = 81;
const META_STRETCHDIB = 0x0f43;

/** A picture for each region, solid red, one pixel to a device pixel. */
function solidBitmaps(regions: ReadonlyArray<{ x0: number; y0: number; x1: number; y1: number }>) {
  return regions.map((rect) => {
    const width = rect.x1 - rect.x0;
    const height = rect.y1 - rect.y0;
    return { rect, width, height, rgb: Buffer.from(Array.from({ length: width * height }, () => [255, 0, 0]).flat()) };
  });
}

describe('a page with a part the writers cannot draw', () => {
  const svg = Buffer.from(page(`${BACKGROUND}${SHADED}${INSIDE}${BLACK}`));

  it('is still refused by the strict writer, as every other target of the geometry reader is', () => {
    expect(() => encodeEmf(svg)).toThrow(UnsupportedOptionError);
  });

  it('gives the extent of the gradient as one region, and leaves out the shape inside it', () => {
    const read = readMetafilePage(svg, 'emf');
    expect(read.kinds).toEqual(new Set(['paint-server']));
    expect(read.regions).toHaveLength(1);
    // 150 pt are 200 device pixels: the gradient's rectangle at (15, 15) of 45 by 30 is (20, 20) to (80, 60), with a pixel at each edge.
    expect(read.regions[0]).toEqual({ x0: 19, y0: 19, x1: 81, y1: 61 });
    const written = read.write(solidBitmaps(read.regions));
    // The background and the black square stay vector; the green square under the gradient's picture is not written.
    expect(emfRecordTypes(written).filter((type) => type === EMR_POLYGON16)).toHaveLength(2);
    expect(emfRecordTypes(written).filter((type) => type === EMR_STRETCHDIBITS)).toHaveLength(1);
  });

  it('writes the picture as EMR_STRETCHDIBITS last, with rows from the bottom up as BGR on the region', () => {
    const read = readMetafilePage(svg, 'emf');
    const { rect, width, height } = solidBitmaps(read.regions)[0];
    // More than 256 colours, so that the picture is written as 24 bits (a picture of fewer has a colour table, `metafile-bitmap-encodings.test.ts`).
    const rgb = Buffer.alloc(width * height * 3);
    for (let pixel = 1; pixel < width * height; pixel++) rgb.writeUIntBE(pixel % 1024, pixel * 3, 3);
    rgb.writeUIntBE(0x102030, 0, 3); // the first pixel, the top left one
    const written = read.write([{ rect, width, height, rgb }]);
    const record = emfRecords(written).at(-2) as Buffer; // the last record is EMR_EOF
    expect(record.readUInt32LE(0)).toBe(EMR_STRETCHDIBITS);
    expect(record.readUInt32LE(4)).toBe(record.length);
    // The file's logical unit is a fraction of a device pixel (16 to the pixel for a page this small): the rectangle is scaled with the polygons.
    const scale = record.readInt32LE(72) / width;
    expect(scale).toBeGreaterThanOrEqual(1);
    expect(record.readInt32LE(24)).toBe(rect.x0 * scale); // xDest
    expect(record.readInt32LE(28)).toBe(rect.y0 * scale); // yDest
    expect(record.readInt32LE(76)).toBe(height * scale); // cyDest
    expect(record.readUInt32LE(68)).toBe(0x00cc0020); // SRCCOPY
    const bits = record.readUInt32LE(56);
    const rowBytes = Math.ceil((width * 3) / 4) * 4;
    // The top row of the picture is the last row of the bits, and a pixel is blue, green, red.
    const firstPixel = bits + (height - 1) * rowBytes;
    expect([...record.subarray(firstPixel, firstPixel + 3)]).toEqual([0x30, 0x20, 0x10]);
  });

  it('writes META_STRETCHDIB with the rectangle fields in the order of MS-WMF', () => {
    const read = readMetafilePage(svg, 'wmf');
    const written = read.write(solidBitmaps(read.regions));
    expect(wmfRecordFunctions(written).filter((fn) => fn === META_STRETCHDIB)).toHaveLength(1);
    const bitmap = solidBitmaps(read.regions)[0];
    const record = wmfStretchDib(bitmap, 1);
    expect(record.length % 2).toBe(0);
    expect(record.readUInt32LE(0) * 2).toBe(record.length);
    expect(record.readUInt16LE(4)).toBe(META_STRETCHDIB);
    expect(record.readUInt32LE(6)).toBe(0x00cc0020);
    expect(record.readInt16LE(12)).toBe(bitmap.height); // SrcHeight
    expect(record.readInt16LE(14)).toBe(bitmap.width); // SrcWidth
    expect(record.readInt16LE(20)).toBe(bitmap.height); // DestHeight
    expect(record.readInt16LE(22)).toBe(bitmap.width); // DestWidth
    expect(record.readInt16LE(24)).toBe(bitmap.rect.y0); // yDst
    expect(record.readInt16LE(26)).toBe(bitmap.rect.x0); // xDst
  });

  it('is refused when the pictures given are not one for each region', () => {
    expect(() => readMetafilePage(svg, 'emf').write([])).toThrow(/1 regions to draw as pictures and was given 0/);
  });

  it('is refused when a picture does not hold the colour of its pixels', () => {
    const bitmap = { ...solidBitmaps([{ x0: 0, y0: 0, x1: 4, y1: 4 }])[0], rgb: Buffer.alloc(5) };
    expect(() => emfStretchDib(bitmap, 1)).toThrow(/holds 5 bytes of colour/);
    expect(() => wmfStretchDib(bitmap, 1)).toThrow(/holds 5 bytes of colour/);
  });

  it('keeps a page that is a bitmap font refused, as the office suite cannot draw it either', () => {
    const glyphs =
      `<defs><image id="s" x="0" y="0" width="1" height="1" xlink:href="${PIXEL}"/><mask id="m"><use xlink:href="#s"/></mask></defs>` +
      '<rect x="0" y="0" width="9" height="9" mask="url(#m)"/>';
    const bitmapFont = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="150pt" height="75pt" viewBox="0 0 150 75">${glyphs}</svg>`;
    expect(() => readMetafilePage(Buffer.from(bitmapFont), 'emf')).toThrow(/SVG bitmap glyph/);
  });
});

describe('the regions of a page', () => {
  it('are one for the shapes that touch and the least many for the shapes that do not', () => {
    const shapes = Array.from({ length: 60 }, (_, index) => `<rect x="${(index % 10) * 14}" y="${Math.floor(index / 10) * 12}" width="6" height="6" fill="url(#g)"/>`).join('');
    const read = readMetafilePage(Buffer.from(page(`${BACKGROUND}${shapes}`)), 'emf');
    expect(read.regions.length).toBeGreaterThan(0);
    expect(read.regions.length).toBeLessThanOrEqual(MAX_RASTER_REGIONS);
  });

  it('join the two that cost the least area when there are more than the bound', () => {
    const regions = new RasterRegions();
    regions.start({ width: 1000, height: 1000 });
    const refusal = new UnsupportedOptionError('SVG filter "url(#f)" is not supported by metafile encoders.');
    for (let index = 0; index < MAX_RASTER_REGIONS + 5; index++) regions.add({ x0: index * 30, y0: index * 30, x1: index * 30 + 10, y1: index * 30 + 10 }, refusal);
    expect(regions.rects).toHaveLength(MAX_RASTER_REGIONS);
    // Every refused rectangle is still inside a region.
    for (let index = 0; index < MAX_RASTER_REGIONS + 5; index++) {
      expect(regions.rects.some((r) => r.x0 <= index * 30 && r.y0 <= index * 30 && r.x1 >= index * 30 + 10 && r.y1 >= index * 30 + 10)).toBe(true);
    }
  });

  it('stand for the whole page when the extent of a refusal cannot be measured, and are cut to the page', () => {
    const regions = new RasterRegions();
    regions.start({ width: 200, height: 100 });
    const refusal = new UnsupportedOptionError('SVG mask "url(#m)" is not supported by metafile encoders.');
    regions.add(undefined, refusal);
    expect(regions.rects).toEqual([{ x0: 0, y0: 0, x1: 200, y1: 100 }]);
    regions.add({ x0: -50, y0: -50, x1: 500, y1: 500 }, refusal);
    expect(regions.rects).toEqual([{ x0: 0, y0: 0, x1: 200, y1: 100 }]);
  });
});

describe('the kind of a refusal', () => {
  const CASES: ReadonlyArray<readonly [string, string]> = [
    ['clip', `<g clip-path="url(#c)"><path d="M 0 0 L 90 0 L 90 40 Z" fill="#000"/></g>`],
    ['mask', '<g mask="url(#m)"><rect x="1" y="1" width="9" height="9" fill="#000"/></g>'],
    ['filter', '<rect x="1" y="1" width="9" height="9" filter="url(#f)"/>'],
    ['paint-server', SHADED],
    ['picture', `<image x="0" y="0" width="9" height="9" xlink:href="${PIXEL}"/>`],
    ['dash', '<path d="M 0 5 L 90 5" stroke="#000" stroke-dasharray="4 2"/>'],
  ];
  const DEFS = `${GRADIENT}<clipPath id="c" clipPathUnits="objectBoundingBox"><rect x="0" y="0" width="1" height="1"/></clipPath><mask id="m"><rect x="0" y="0" width="9" height="9" fill="#fff"/></mask><filter id="f"/>`;

  it.each(CASES)('%s is named from what the reader says', (kind, body) => {
    const regions = new RasterRegions();
    parseSvgGeometries(page(body, DEFS), { rasterRegions: regions });
    expect([...regions.kinds]).toEqual([kind]);
  });

  it.each(CASES)('%s is the refusal of the reader when no regions are asked for', (_kind, body) => {
    expect(() => parseSvgGeometries(page(body, DEFS))).toThrow(UnsupportedOptionError);
  });
});

describe('the density of the pictures', () => {
  const LETTER = { width: 816, height: 1056 };

  it('is the density of cairo fallback images for a region that fits the bound', () => {
    expect(rasterFallbackDpi([{ x0: 0, y0: 0, x1: 100, y1: 100 }], LETTER)).toBe(RASTER_FALLBACK_DPI);
    expect(rasterFallbackDpi([{ x0: 0, y0: 0, ...LETTER, x1: LETTER.width, y1: LETTER.height }], LETTER)).toBe(RASTER_FALLBACK_DPI);
  });

  it('falls with the area of the regions so a page never holds more than the bound of picture', () => {
    const poster = { width: 96 * 36, height: 96 * 36 };
    const dpi = rasterFallbackDpi([{ x0: 0, y0: 0, x1: poster.width, y1: poster.height }], poster);
    expect(dpi).toBeLessThan(RASTER_FALLBACK_DPI);
    expect(dpi).toBeGreaterThanOrEqual(RASTER_FALLBACK_MIN_DPI);
    expect(((poster.width * dpi) / 96) * ((poster.height * dpi) / 96)).toBeLessThanOrEqual(MAX_REGION_PIXELS);
  });

  it('is refused, with a typed error that is not the one the office suite is asked on, when it would be below the least density', () => {
    const huge = { width: 96 * 120, height: 96 * 120 };
    const refused = () => rasterFallbackDpi([{ x0: 0, y0: 0, x1: huge.width, y1: huge.height }], huge);
    expect(refused).toThrow(RasterFallbackTooLargeError);
    expect(refused).not.toThrow(UnsupportedOptionError);
  });
});

describe('the pictures cut from the render of a page', () => {
  /** A render of a 200 by 100 device pixel page at `dpi`: the left half red and the right half blue. */
  async function render(dpi: number): Promise<Buffer> {
    const width = Math.round((200 * dpi) / 96);
    const height = Math.round((100 * dpi) / 96);
    const raw = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set(x < width / 2 ? [255, 0, 0] : [0, 0, 255], (y * width + x) * 3);
    return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
  }

  it('hold the pixels of the region on the device rectangle of exactly those pixels', async () => {
    const draw = vi.fn(async (_page: number, dpi: number) => render(dpi));
    const [left, right] = await renderRegionBitmaps([{ x0: 10, y0: 10, x1: 50, y1: 30 }, { x0: 150, y0: 10, x1: 190, y1: 30 }], { width: 200, height: 100 }, 3, draw);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(draw.mock.calls[0][0]).toBe(3);
    expect([...left.rgb.subarray(0, 3)]).toEqual([255, 0, 0]);
    expect([...right.rgb.subarray(0, 3)]).toEqual([0, 0, 255]);
    expect(left.width * left.height * 3).toBe(left.rgb.length);
    // The render is 313 pixels across for 200 device pixels; the rectangle is the whole render pixels the picture holds.
    expect(left.rect.x1 - left.rect.x0).toBeCloseTo((left.width * 200) / 313, 6);
  });

  it('is asked at the density the area allows, and a page at the least density is refused before anything is drawn', async () => {
    const draw = vi.fn(async (_page: number, dpi: number) => render(dpi));
    await expect(renderRegionBitmaps([{ x0: 0, y0: 0, x1: 96 * 120, y1: 96 * 120 }], { width: 96 * 120, height: 96 * 120 }, 1, draw)).rejects.toBeInstanceOf(RasterFallbackTooLargeError);
    expect(draw).not.toHaveBeenCalled();
  });
});

describe('a page written with pictures for what the writer cannot draw', () => {
  const picture = (dpi: number): Promise<Buffer> => sharp({ create: { width: Math.round((200 * dpi) / 96), height: Math.round((100 * dpi) / 96), channels: 3, background: '#808080' } }).png().toBuffer();

  it('asks for the picture of the page once and writes a bitmap record', async () => {
    const draw = vi.fn(async (_page: number, dpi: number) => picture(dpi));
    const written = await writeMetafilePageWithPictures(Buffer.from(page(`${BACKGROUND}${SHADED}${BLACK}`)), 'emf', 2, draw);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(draw.mock.calls[0][0]).toBe(2);
    expect(emfRecordTypes(written)).toContain(EMR_STRETCHDIBITS);
  });

  it('does not ask for a picture of a page that is all vector', async () => {
    const draw = vi.fn(async () => Buffer.alloc(0));
    const written = await writeMetafilePageWithPictures(Buffer.from(page(`${BACKGROUND}${BLACK}`)), 'wmf', 1, draw);
    expect(draw).not.toHaveBeenCalled();
    expect(wmfRecordFunctions(written)).not.toContain(META_STRETCHDIB);
  });

  it('draws a picture, a dash and a pen as pictures too, the office suite being right for none of the kinds', async () => {
    const draw = vi.fn(async (_page: number, dpi: number) => picture(dpi));
    const withPicture = page(`${BACKGROUND}<image x="0" y="0" width="9" height="9" xlink:href="${PIXEL}"/>`);
    const withDash = page(`${BACKGROUND}<path d="M 0 5 L 90 5" stroke="#000" stroke-dasharray="4 2"/>`);
    for (const body of [withPicture, withDash]) {
      const written = await writeMetafilePageWithPictures(Buffer.from(body), 'emf', 1, draw);
      expect(emfRecordTypes(written)).toContain(EMR_STRETCHDIBITS);
    }
    expect(draw).toHaveBeenCalledTimes(2);
  });

  it('writes a cell array for a CGM, the pen of a dash and the part inside a gradient being pictures too', async () => {
    const draw = vi.fn(async (_page: number, dpi: number) => picture(dpi));
    const names = async (body: string) => cgmBinaryElements(await writeMetafilePageWithPictures(Buffer.from(body), 'cgm', 1, draw)).map(cgmBinaryName);
    expect(await names(page(`${BACKGROUND}${SHADED}${INSIDE}${BLACK}`))).toContain('CELLARRAY');
    expect(await names(page(`${BACKGROUND}<path d="M 0 5 L 90 5" stroke="#000" stroke-dasharray="4 2"/>`))).toContain('CELLARRAY');
    expect(await names(page(`${BACKGROUND}${BLACK}`))).not.toContain('CELLARRAY');
    expect(draw).toHaveBeenCalledTimes(2);
    expect(() => encodeCgm(Buffer.from(page(`${BACKGROUND}${SHADED}`)))).toThrow(UnsupportedOptionError);
  });

  it('draws a round cap and join as the line cap and line join of a CGM, which the pen of a metafile page keeps vector', async () => {
    const round = page(`${BACKGROUND}<path d="M 10 10 L 60 10 L 60 50" fill="none" stroke="#000" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`);
    const written = await writeMetafilePageWithPictures(Buffer.from(round), 'cgm', 1, vi.fn());
    const elements = cgmBinaryElements(written);
    const named = (name: string) => elements.find((element) => cgmBinaryName(element) === name)?.parameters;
    expect(Array.from(named('LINECAP') ?? [])).toEqual([0, 3, 0, 3]);
    expect(Array.from(named('LINEJOIN') ?? [])).toEqual([0, 3]);
    expect(elements.map(cgmBinaryName)).not.toContain('CELLARRAY');
  });

  it('draws every refused part of a page in one render of the page', async () => {
    const draw = vi.fn(async (_page: number, dpi: number) => picture(dpi));
    const mixed = page(`${BACKGROUND}${SHADED}<image x="100" y="40" width="9" height="9" xlink:href="${PIXEL}"/>`);
    const written = await writeMetafilePageWithPictures(Buffer.from(mixed), 'emf', 1, draw);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(emfRecordTypes(written).filter((type) => type === EMR_STRETCHDIBITS).length).toBeGreaterThan(0);
  });
});

describe('a page that is more than the vector writers hold', () => {
  const picture = (dpi: number): Promise<Buffer> => sharp({ create: { width: Math.round((200 * dpi) / 96), height: Math.round((100 * dpi) / 96), channels: 3, background: '#808080' } }).png().toBuffer();
  /** A page of 5.3 million characters, past the reader's limit of 5,242,880. */
  const OVERSIZE = Buffer.from(page(`${BACKGROUND}<!--${'x'.repeat(5_300_000)}-->`));

  it('is named by what the writers say, and a malformed page is not', () => {
    expect(() => encodeEmf(OVERSIZE)).toThrow(CadGeometryUnavailableError);
    let limit: Error | undefined;
    try {
      encodeEmf(OVERSIZE);
    } catch (error) {
      limit = error as Error;
    }
    expect(isTooComplexToDraw(limit as Error)).toBe(true);
    expect(isTooComplexToDraw(new CadGeometryUnavailableError('SVG viewBox "0 0 0 0" must be four finite numbers with positive width and height.'))).toBe(false);
    expect(isTooComplexToDraw(new CadGeometryUnavailableError('SVG expands to more than 500000 vertices; the drawing is too complex to encode.'))).toBe(true);
    expect(isTooComplexToDraw(new CadGeometryUnavailableError("EMF output would exceed 52428800 bytes; the drawing is too complex to encode."))).toBe(true);
    expect(isTooComplexToDraw(new CadGeometryUnavailableError('CGM output would exceed 52428800 bytes; the drawing is too complex to encode.'))).toBe(true);
  });

  it('is written as one picture of the whole page', async () => {
    const draw = vi.fn(async (_page: number, dpi: number) => picture(dpi));
    const written = await writeMetafilePageWithPictures(OVERSIZE, 'emf', 4, draw);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(draw.mock.calls[0][0]).toBe(4);
    expect(emfRecordTypes(written)).toContain(EMR_STRETCHDIBITS);
    expect(emfRecordTypes(written)).not.toContain(EMR_POLYGON16);
    const wmf = await writeMetafilePageWithPictures(OVERSIZE, 'wmf', 4, draw);
    expect(wmfRecordFunctions(wmf)).toContain(META_STRETCHDIB);
    const cgm = cgmBinaryElements(await writeMetafilePageWithPictures(OVERSIZE, 'cgm', 4, draw)).map(cgmBinaryName);
    expect(cgm).toContain('CELLARRAY');
    expect(cgm).not.toContain('POLYGON');
  });

  it('reads the size of the page from the root alone', () => {
    expect(pageSizeFromRoot(OVERSIZE)).toEqual({ width: 200, height: 100 });
    expect(pageSizeFromRoot(Buffer.from('<svg width="10" height="10"/>'))).toBeUndefined();
  });

  it('is refused as before when the root does not give the size', async () => {
    const unsized = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><!--${'x'.repeat(5_300_000)}--></svg>`);
    const draw = vi.fn();
    await expect(writeMetafilePageWithPictures(unsized, 'emf', 1, draw)).rejects.toBeInstanceOf(CadGeometryUnavailableError);
    expect(draw).not.toHaveBeenCalled();
  });
});
