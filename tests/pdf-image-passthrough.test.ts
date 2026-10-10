import { describe, expect, it } from 'vitest';
import zlib from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { CorruptStreamError } from '../src/lib/types';
import { InputPixelLimitError } from '../src/lib/conversions/image-input-limits';
import { planPngPassthrough } from '../src/lib/conversions/pdf-image-passthrough';
import { embedImagePlan } from '../src/lib/conversions/pdf-image-xobject';

/**
 * Hostile and unusual PNGs at the passthrough boundary. The files are assembled here chunk by chunk from the PNG
 * specification (signature, length, type, data, CRC-32 of type and data); the CRC is the one in node:zlib.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WIDTH = 8;
const HEIGHT = 4;
const RGB_CHANNELS = 3;
const COLOR_GRAY = 0;
const COLOR_RGB = 2;
const COLOR_PALETTE = 3;
const COLOR_RGBA = 6;
const HTTP_BAD_REQUEST = 400;
const HTTP_PAYLOAD_TOO_LARGE = 413;

function chunk(type: string, body: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  const typeAndBody = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(typeAndBody));
  return Buffer.concat([head, typeAndBody, crc]);
}

function ihdrBody(width: number, height: number, depth: number, colorType: number, interlace = 0): Buffer {
  const body = Buffer.alloc(13);
  body.writeUInt32BE(width, 0);
  body.writeUInt32BE(height, 4);
  body[8] = depth;
  body[9] = colorType;
  body[12] = interlace;
  return body;
}

function ihdr(width: number, height: number, depth: number, colorType: number, interlace = 0): Buffer {
  return chunk('IHDR', ihdrBody(width, height, depth, colorType, interlace));
}

/** Rows of `rowBytes` bytes, each with a filter byte first. */
function scanlines(rowBytes: number, rows: number, filter = 0): Buffer {
  const out = Buffer.alloc((rowBytes + 1) * rows);
  for (let y = 0; y < rows; y++) {
    out[y * (rowBytes + 1)] = filter;
    for (let x = 0; x < rowBytes; x++) out[y * (rowBytes + 1) + 1 + x] = (x * 31 + y * 7) & 0xff;
  }
  return out;
}

function png(parts: Buffer[]): Buffer {
  return Buffer.concat([SIGNATURE, ...parts]);
}

function validRgb(): Buffer {
  return png([
    ihdr(WIDTH, HEIGHT, 8, COLOR_RGB),
    chunk('IDAT', zlib.deflateSync(scanlines(WIDTH * RGB_CHANNELS, HEIGHT))),
    chunk('IEND'),
  ]);
}

describe('planPngPassthrough on a well-formed PNG', () => {
  it('describes an RGB page: its size, colour model and the unchanged IDAT bytes', () => {
    const idat = zlib.deflateSync(scanlines(WIDTH * RGB_CHANNELS, HEIGHT));
    const plan = planPngPassthrough(png([ihdr(WIDTH, HEIGHT, 8, COLOR_RGB), chunk('IDAT', idat), chunk('IEND')]));
    expect(plan).toMatchObject({
      encoding: 'flate-predictor',
      width: WIDTH,
      height: HEIGHT,
      bitsPerComponent: 8,
      colors: RGB_CHANNELS,
      colorSpace: { kind: 'rgb' },
    });
    expect(Buffer.from((plan as { data: Uint8Array }).data).equals(idat)).toBe(true);
  });

  it('joins IDAT chunks that split one stream', () => {
    const idat = zlib.deflateSync(scanlines(WIDTH * RGB_CHANNELS, HEIGHT));
    const cut = Math.floor(idat.length / 2);
    const plan = planPngPassthrough(
      png([
        ihdr(WIDTH, HEIGHT, 8, COLOR_RGB),
        chunk('IDAT', idat.subarray(0, cut)),
        chunk('IDAT', idat.subarray(cut)),
        chunk('IEND'),
      ])
    );
    expect(Buffer.from((plan as { data: Uint8Array }).data).equals(idat)).toBe(true);
  });

  it('writes an image XObject whose stream is those bytes and whose parameters name the predictor', async () => {
    const idat = zlib.deflateSync(scanlines(WIDTH * RGB_CHANNELS, HEIGHT));
    const plan = planPngPassthrough(png([ihdr(WIDTH, HEIGHT, 8, COLOR_RGB), chunk('IDAT', idat), chunk('IEND')]));
    const doc = await PDFDocument.create();
    const ref = embedImagePlan(doc, plan as NonNullable<typeof plan>);
    const stream = doc.context.lookup(ref) as unknown as { dict: { toString(): string }; contents: Uint8Array };
    const dictionary = stream.dict.toString().replace(/\s+/g, ' ');
    for (const entry of ['/Subtype /Image', '/Width 8', '/Height 4', '/ColorSpace /DeviceRGB', '/Filter /FlateDecode', '/Predictor 15', '/Colors 3', '/Columns 8']) {
      expect(dictionary).toContain(entry);
    }
    expect(Buffer.from(stream.contents).equals(idat)).toBe(true);
  });

  it('leaves interlaced, alpha and transparent pages to the decoding path', () => {
    const rows = (rowBytes: number) => chunk('IDAT', zlib.deflateSync(scanlines(rowBytes, HEIGHT)));
    expect(planPngPassthrough(png([ihdr(WIDTH, HEIGHT, 8, COLOR_RGB, 1), rows(WIDTH * RGB_CHANNELS), chunk('IEND')]))).toBeNull();
    expect(planPngPassthrough(png([ihdr(WIDTH, HEIGHT, 8, COLOR_RGBA), rows(WIDTH * 4), chunk('IEND')]))).toBeNull();
    expect(planPngPassthrough(png([ihdr(WIDTH, HEIGHT, 8, 4), rows(WIDTH * 2), chunk('IEND')]))).toBeNull();
    const withKey = png([ihdr(WIDTH, HEIGHT, 8, COLOR_GRAY), chunk('tRNS', Buffer.from([0, 0])), rows(WIDTH), chunk('IEND')]);
    expect(planPngPassthrough(withKey)).toBeNull();
  });
});

describe('planPngPassthrough on a malformed PNG', () => {
  function expectCorrupt(file: Buffer, message: RegExp): void {
    let thrown: unknown;
    try {
      planPngPassthrough(file);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CorruptStreamError);
    expect((thrown as CorruptStreamError).status).toBe(HTTP_BAD_REQUEST);
    expect((thrown as CorruptStreamError).message).toMatch(message);
  }

  it('refuses a file without the PNG signature', () => {
    expectCorrupt(Buffer.concat([Buffer.from('GIF89a'), validRgb()]), /PNG signature is missing/);
  });

  it('refuses a file cut inside a chunk, and one cut before IEND', () => {
    const file = validRgb();
    expectCorrupt(file.subarray(0, file.length - 20), /runs past the end of the file|ends before IEND|ends inside a chunk header/);
    expectCorrupt(file.subarray(0, file.length - 12), /ends before IEND/);
  });

  it('refuses a chunk whose declared length runs past the file', () => {
    const file = validRgb();
    const idatAt = SIGNATURE.length + 25;
    file.writeUInt32BE(0x7fffffff, idatAt);
    expectCorrupt(file, /IDAT chunk of 2147483647 bytes runs past the end of the file/);
  });

  it('refuses a chunk with a wrong CRC', () => {
    const file = validRgb();
    file[file.length - 17] ^= 0xff;
    expectCorrupt(file, /CRC mismatch in IDAT chunk/);
  });

  it('refuses image data that inflates to fewer or more rows than the header declares', () => {
    const rowBytes = WIDTH * RGB_CHANNELS;
    const header = ihdr(WIDTH, HEIGHT, 8, COLOR_RGB);
    const expected = (rowBytes + 1) * HEIGHT;
    expectCorrupt(
      png([header, chunk('IDAT', zlib.deflateSync(scanlines(rowBytes, HEIGHT - 1))), chunk('IEND')]),
      new RegExp(`PNG image data decodes to ${expected - rowBytes - 1} bytes but declares ${expected}`)
    );
    expectCorrupt(
      png([header, chunk('IDAT', zlib.deflateSync(scanlines(rowBytes, HEIGHT + 1))), chunk('IEND')]),
      new RegExp(`PNG image data decodes to more than the ${expected} bytes it declares`)
    );
  });

  it('refuses image data that is not a zlib stream', () => {
    expectCorrupt(
      png([ihdr(WIDTH, HEIGHT, 8, COLOR_RGB), chunk('IDAT', Buffer.from('not a zlib stream at all')), chunk('IEND')]),
      /PNG image data is not a valid compressed stream/
    );
  });

  it('refuses a row with a filter type PNG does not define', () => {
    const rows = scanlines(WIDTH * RGB_CHANNELS, HEIGHT);
    rows[(WIDTH * RGB_CHANNELS + 1) * 2] = 5;
    expectCorrupt(png([ihdr(WIDTH, HEIGHT, 8, COLOR_RGB), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND')]), /row 2 has filter type 5/);
  });

  it('refuses a header with an impossible bit depth, canvas or method', () => {
    const idat = chunk('IDAT', zlib.deflateSync(scanlines(WIDTH, HEIGHT)));
    expectCorrupt(png([ihdr(WIDTH, HEIGHT, 3, COLOR_GRAY), idat, chunk('IEND')]), /colour type 0 cannot have bit depth 3/);
    expectCorrupt(png([ihdr(WIDTH, HEIGHT, 4, COLOR_RGB), idat, chunk('IEND')]), /colour type 2 cannot have bit depth 4/);
    expectCorrupt(png([ihdr(0, HEIGHT, 8, COLOR_GRAY), idat, chunk('IEND')]), /the canvas is 0x4/);
    expectCorrupt(png([ihdr(WIDTH, HEIGHT, 8, COLOR_GRAY, 2), idat, chunk('IEND')]), /interlace method 2 is not defined/);
    const oddMethod = ihdrBody(WIDTH, HEIGHT, 8, COLOR_GRAY);
    oddMethod[10] = 1;
    expectCorrupt(png([chunk('IHDR', oddMethod), idat, chunk('IEND')]), /compression method 1 and filter method 0 are not defined/);
  });

  it('refuses chunks in an order the specification forbids', () => {
    const header = ihdr(WIDTH, HEIGHT, 8, COLOR_RGB);
    const stream = zlib.deflateSync(scanlines(WIDTH * RGB_CHANNELS, HEIGHT));
    const half = Math.floor(stream.length / 2);
    expectCorrupt(png([chunk('IDAT', stream), header, chunk('IEND')]), /the first chunk is not IHDR/);
    expectCorrupt(png([header, header, chunk('IDAT', stream), chunk('IEND')]), /IHDR is repeated/);
    expectCorrupt(
      png([header, chunk('IDAT', stream.subarray(0, half)), chunk('tEXt', Buffer.from('a\0b')), chunk('IDAT', stream.subarray(half)), chunk('IEND')]),
      /IDAT chunks are not contiguous/
    );
    expectCorrupt(png([header, chunk('IEND')]), /the image has no IDAT data/);
    expectCorrupt(png([header, chunk('IDAT', stream), chunk('PLTE', Buffer.from([0, 0, 0])), chunk('IEND')]), /PLTE is repeated or after the image data/);
  });

  it('refuses a palette image without a usable palette', () => {
    const header = ihdr(WIDTH, HEIGHT, 8, COLOR_PALETTE);
    const stream = chunk('IDAT', zlib.deflateSync(scanlines(WIDTH, HEIGHT)));
    expectCorrupt(png([header, stream, chunk('IEND')]), /a palette image needs a PLTE chunk of whole entries/);
    expectCorrupt(png([header, chunk('PLTE', Buffer.from([1, 2])), stream, chunk('IEND')]), /a palette image needs a PLTE chunk of whole entries/);
    const tooMany = ihdr(WIDTH, HEIGHT, 1, COLOR_PALETTE);
    expectCorrupt(
      png([tooMany, chunk('PLTE', Buffer.alloc(9)), chunk('IDAT', zlib.deflateSync(scanlines(1, HEIGHT))), chunk('IEND')]),
      /more entries than the bit depth can index/
    );
  });

  it('refuses an ICC profile whose size field does not match the profile', () => {
    const profile = Buffer.alloc(200);
    profile.writeUInt32BE(100, 0);
    profile.write('RGB ', 16, 'latin1');
    const iccp = chunk('iCCP', Buffer.concat([Buffer.from('bad\0\0', 'latin1'), zlib.deflateSync(profile)]));
    expectCorrupt(
      png([ihdr(WIDTH, HEIGHT, 8, COLOR_RGB), iccp, chunk('IDAT', zlib.deflateSync(scanlines(WIDTH * RGB_CHANNELS, HEIGHT))), chunk('IEND')]),
      /the iCCP profile does not match the size in its header/
    );
  });

  it('does not expand an ICC profile past its limit', () => {
    const bomb = zlib.deflateSync(Buffer.alloc(8 * 1024 * 1024));
    const iccp = chunk('iCCP', Buffer.concat([Buffer.from('big\0\0', 'latin1'), bomb]));
    let thrown: unknown;
    try {
      planPngPassthrough(
        png([ihdr(WIDTH, HEIGHT, 8, COLOR_RGB), iccp, chunk('IDAT', zlib.deflateSync(scanlines(WIDTH * RGB_CHANNELS, HEIGHT))), chunk('IEND')])
      );
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { status?: number }).status).toBe(HTTP_PAYLOAD_TOO_LARGE);
    expect((thrown as Error).message).toMatch(/PNG iCCP profile decodes to more than the limit of 4194304 bytes/);
  });

  it('answers a canvas over the pixel limit with HTTP 413 before inflating anything', () => {
    // A 100000 x 100000 canvas is 10^10 pixels; its few bytes of image data are never inflated.
    const huge = png([ihdr(100_000, 100_000, 8, COLOR_RGB), chunk('IDAT', zlib.deflateSync(Buffer.alloc(16))), chunk('IEND')]);
    let thrown: unknown;
    try {
      planPngPassthrough(huge);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InputPixelLimitError);
    expect((thrown as InputPixelLimitError).status).toBe(HTTP_PAYLOAD_TOO_LARGE);
  });

  it('does not inflate a stream that would pass the declared size (decompression bomb)', () => {
    const bomb = zlib.deflateSync(Buffer.alloc(16 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(64 * 1024);
    expectCorrupt(
      png([ihdr(WIDTH, HEIGHT, 8, COLOR_RGB), chunk('IDAT', bomb), chunk('IEND')]),
      new RegExp(`PNG image data decodes to more than the ${(WIDTH * RGB_CHANNELS + 1) * HEIGHT} bytes it declares`)
    );
  });
});
