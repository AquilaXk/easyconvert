import { describe, expect, it } from 'vitest';
import { DEFAULT_PRINT_DENSITY, jfifDensity, pageSizePoints, storedDensity, uprightDensity, withinPdfPageLimit } from '../src/lib/conversions/image-print-density';

/**
 * The header reader of the resolution a picture states, on bytes laid out by hand from the format definitions (TIFF 6.0 section 2
 * and 8, PNG 1.2 pHYs, JFIF 1.02 APP0, Exif 2.32): the expected values are the arithmetic of those definitions, and every damaged
 * header must read as "no resolution", never throw.
 */

const TYPE_SHORT = 3;
const TYPE_RATIONAL = 5;
const TAG_X = 0x011a;
const TAG_Y = 0x011b;
const TAG_UNIT = 0x0128;
const HEADER_BYTES = 8;
const ENTRY_BYTES = 12;
const NEXT_BYTES = 4;
const RATIONAL_BYTES = 8;
const CM_PER_INCH = 2.54;

interface Entry {
  tag: number;
  type: number;
  /** A SHORT, or the numerator and denominator of a RATIONAL. */
  value: number | [number, number];
}

/** A classic TIFF of directories (each a list of entries), rationals after the last directory, in either byte order. */
function tiff(directories: Entry[][], little = true): Buffer {
  const u16 = (value: number): Buffer => {
    const bytes = Buffer.alloc(2);
    if (little) bytes.writeUInt16LE(value);
    else bytes.writeUInt16BE(value);
    return bytes;
  };
  const u32 = (value: number): Buffer => {
    const bytes = Buffer.alloc(4);
    if (little) bytes.writeUInt32LE(value);
    else bytes.writeUInt32BE(value);
    return bytes;
  };
  const sizes = directories.map((entries) => 2 + entries.length * ENTRY_BYTES + NEXT_BYTES);
  let valueAt = HEADER_BYTES + sizes.reduce((sum, size) => sum + size, 0);
  const values: Buffer[] = [];
  const parts: Buffer[] = [Buffer.from(little ? 'II' : 'MM', 'latin1'), u16(42), u32(HEADER_BYTES)];
  directories.forEach((entries, index) => {
    parts.push(u16(entries.length));
    for (const entry of entries) {
      parts.push(u16(entry.tag), u16(entry.type), u32(1));
      if (Array.isArray(entry.value)) {
        parts.push(u32(valueAt));
        values.push(u32(entry.value[0]), u32(entry.value[1]));
        valueAt += RATIONAL_BYTES;
      } else {
        parts.push(u16(entry.value), Buffer.alloc(2));
      }
    }
    parts.push(u32(index + 1 < directories.length ? HEADER_BYTES + sizes.slice(0, index + 1).reduce((sum, size) => sum + size, 0) : 0));
  });
  return Buffer.concat([...parts, ...values]);
}

const resolution = (x: [number, number], y: [number, number], unit?: number): Entry[] => [
  { tag: TAG_X, type: TYPE_RATIONAL, value: x },
  { tag: TAG_Y, type: TYPE_RATIONAL, value: y },
  ...(unit === undefined ? [] : [{ tag: TAG_UNIT, type: TYPE_SHORT, value: unit }]),
];

function pngChunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, Buffer.from(type, 'latin1'), body, Buffer.alloc(4)]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function phys(x: number, y: number, unit: number): Buffer {
  const body = Buffer.alloc(9);
  body.writeUInt32BE(x, 0);
  body.writeUInt32BE(y, 4);
  body[8] = unit;
  return pngChunk('pHYs', body);
}

function png(...chunks: Buffer[]): Buffer {
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', Buffer.alloc(13)), ...chunks, pngChunk('IDAT', Buffer.alloc(1)), pngChunk('IEND', Buffer.alloc(0))]);
}

function jfifBody(units: number, x: number, y: number): Buffer {
  const body = Buffer.alloc(14);
  body.write('JFIF\0', 0, 'latin1');
  body[7] = units;
  body.writeUInt16BE(x, 8);
  body.writeUInt16BE(y, 10);
  return body;
}

function segment(marker: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
}

function jpeg(...segments: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8]), ...segments, Buffer.from([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9])]);
}

const exifSegment = (directories: Entry[][]): Buffer => segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff(directories)]));

describe('the resolution a TIFF directory states', () => {
  it.each([true, false])('is the XResolution and YResolution in inches, in either byte order (little endian: %s)', (little) => {
    expect(storedDensity(tiff([resolution([300, 1], [150, 1], 2)], little), 0)).toEqual({ x: 300, y: 150 });
  });

  it('is in inches when the unit is absent (TIFF 6.0: the default of ResolutionUnit is 2)', () => {
    expect(storedDensity(tiff([resolution([200, 1], [200, 1])]), 0)).toEqual({ x: 200, y: 200 });
  });

  it('converts centimetres, and keeps a rational that is not whole to a tenth of a dpi', () => {
    const density = storedDensity(tiff([resolution([1000, 10], [5003, 100], 3)]), 0);
    expect(density?.x).toBeCloseTo(254, 9);
    expect(density?.y).toBeCloseTo(127.1, 9);
  });

  it('is that of the directory of the page asked for', () => {
    const document = tiff([resolution([200, 1], [200, 1], 2), resolution([100, 1], [50, 1], 2)]);
    expect([storedDensity(document, 0), storedDensity(document, 1)]).toEqual([{ x: 200, y: 200 }, { x: 100, y: 50 }]);
    expect(storedDensity(document, 2)).toBeNull();
  });

  it.each([
    ['a unit of none (1)', resolution([300, 1], [300, 1], 1)],
    ['an unknown unit (4)', resolution([300, 1], [300, 1], 4)],
    ['a zero denominator', resolution([300, 0], [300, 1], 2)],
    ['a zero resolution', resolution([0, 1], [300, 1], 2)],
    ['one axis only', [{ tag: TAG_X, type: TYPE_RATIONAL, value: [300, 1] as [number, number] }]],
    ['one pixel per millimetre, the placeholder of the image library', resolution([254, 10], [254, 10], 2)],
  ])('is nothing for %s', (_name, entries) => {
    expect(storedDensity(tiff([entries]), 0)).toBeNull();
  });

  it('is nothing for a directory, a value or a chain that runs past the end of the file', () => {
    const valid = tiff([resolution([300, 1], [300, 1], 2)]);
    for (let length = 0; length < valid.length; length += 1) {
      const density = storedDensity(valid.subarray(0, length), 0);
      expect(density === null || (density.x === 300 && density.y === 300), `a file cut to ${length} bytes`).toBe(true);
    }
  });
});

describe('the resolution a PNG states', () => {
  it('is pixels per metre x 0.0254 on each axis for unit 1, to a tenth of a dpi', () => {
    expect(storedDensity(png(phys(11811, 5906, 1)), 0)).toEqual({ x: 300, y: 150 });
    expect(storedDensity(png(phys(2835, 3780, 1)), 0)).toEqual({ x: 72, y: 96 });
  });

  it('keeps a density of which only one axis is one pixel per millimetre', () => {
    const density = storedDensity(png(phys(1000, 11811, 1)), 0);
    expect(density?.x).toBeCloseTo(25.4, 6);
    expect(density?.y).toBeCloseTo(300, 2);
  });

  it.each([
    ['unit 0 (an aspect ratio)', png(phys(3, 1, 0))],
    ['a pHYs of zero', png(phys(0, 11811, 1))],
    ['a pHYs after the image data', Buffer.concat([png(), phys(11811, 11811, 1)])],
    ['one pixel per millimetre, the placeholder of the image library', png(phys(1000, 1000, 1))],
    ['no pHYs', png()],
  ])('is nothing for %s', (_name, bytes) => {
    expect(storedDensity(bytes, 0)).toBeNull();
  });

  it('is nothing for a file cut anywhere', () => {
    const valid = png(phys(11811, 11811, 1));
    for (let length = 0; length < valid.length; length += 1) {
      const density = storedDensity(valid.subarray(0, length), 0);
      expect(density === null || Math.abs(density.x - 300) < 0.01, `a file cut to ${length} bytes`).toBe(true);
    }
  });
});

describe('the resolution a JPEG states', () => {
  it.each([
    ['dots per inch', 1, 300, 150, { x: 300, y: 150 }],
    ['dots per centimetre', 2, 100, 50, { x: 100 * CM_PER_INCH, y: 50 * CM_PER_INCH }],
  ])('is the JFIF density in %s', (_name, units, x, y, expected) => {
    expect(storedDensity(jpeg(segment(0xe0, jfifBody(units, x, y))), 0)).toEqual(expected);
    expect(jfifDensity(jfifBody(units, x, y))).toEqual(expected);
  });

  it.each([
    ['units 0 (an aspect ratio)', jfifBody(0, 2, 1)],
    ['a zero density', jfifBody(1, 0, 300)],
    ['an unknown unit', jfifBody(3, 300, 300)],
  ])('is nothing from JFIF with %s', (_name, body) => {
    expect(storedDensity(jpeg(segment(0xe0, body)), 0)).toBeNull();
  });

  it('is the Exif resolution when JFIF states none, and JFIF when it states one', () => {
    const exif = exifSegment([resolution([300, 1], [150, 1], 2)]);
    expect(storedDensity(jpeg(segment(0xe0, jfifBody(0, 1, 1)), exif), 0)).toEqual({ x: 300, y: 150 });
    expect(storedDensity(jpeg(exif), 0)).toEqual({ x: 300, y: 150 });
    expect(storedDensity(jpeg(segment(0xe0, jfifBody(1, 150, 150)), exif), 0)).toEqual({ x: 150, y: 150 });
  });

  it('is nothing for a file cut anywhere', () => {
    const valid = jpeg(segment(0xe0, jfifBody(1, 300, 300)), exifSegment([resolution([300, 1], [300, 1], 2)]));
    for (let length = 0; length < valid.length; length += 1) {
      const density = storedDensity(valid.subarray(0, length), 0);
      expect(density === null || (density.x === 300 && density.y === 300), `a file cut to ${length} bytes`).toBe(true);
    }
  });
});

describe('the resolution of a container read through the image library', () => {
  it('is that of its Exif buffer, with or without the Exif identifier', () => {
    const block = tiff([resolution([300, 1], [150, 1], 2)]);
    const expected = { x: 300, y: 150 };
    expect(storedDensity(Buffer.from('RIFF....WEBP'), 0, block)).toEqual(expected);
    expect(storedDensity(Buffer.from('....ftypavif'), 0, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), block]))).toEqual(expected);
    expect(storedDensity(Buffer.from('GIF89a'), 0)).toBeNull();
  });
});

describe('the page that follows from a density', () => {
  it('is pixels x 72 / dpi points on each axis', () => {
    expect(pageSizePoints(3307, 4677, { x: 400, y: 400 })).toEqual({ width: (3307 * 72) / 400, height: (4677 * 72) / 400 });
    expect(pageSizePoints(800, 400, DEFAULT_PRINT_DENSITY)).toEqual({ width: 800, height: 400 });
  });

  it('exchanges the axes for the orientations that turn the picture a quarter turn', () => {
    const density = { x: 200, y: 50 };
    for (const orientation of [undefined, 1, 2, 3, 4]) expect(uprightDensity(density, orientation)).toEqual(density);
    for (const orientation of [5, 6, 7, 8]) expect(uprightDensity(density, orientation)).toEqual({ x: 50, y: 200 });
  });

  it('is scaled evenly to 14,400 points on its longer side and left as it is below that', () => {
    expect(withinPdfPageLimit({ width: 28_800, height: 14_400 })).toEqual({ width: 14_400, height: 7_200 });
    expect(withinPdfPageLimit({ width: 600, height: 800 })).toEqual({ width: 600, height: 800 });
  });
});
