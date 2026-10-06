import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { convertImage, decodeLosslessJpegStrip } from '../src/lib/conversions/image';
import { InputPixelLimitError } from '../src/lib/conversions/image-input-limits';
import { InvalidRawSensorError } from '../src/lib/types';

const BYTES_PER_MIB = 1024 * 1024;
const MAX_RSS_GROWTH_BYTES = 100 * BYTES_PER_MIB;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const TAG_SIDE = 16;
/** 12000 x 12000 = 144 MP: over the input limit. */
const SIDE_OVER_INPUT_LIMIT = 12_000;
/** 7000 x 7000 = 49 MP: within every budget, yet far above the 16 x 16 strip the TIFF tags describe. */
const SIDE_OVER_STRIP = 7_000;

/** Lossless JPEG (ITU-T T.81 SOF3) whose frame header declares `width` x `height`, with one Huffman table and a short scan. */
function losslessJpeg(width: number, height: number): Buffer {
  const counts = new Array<number>(16).fill(0);
  counts[0] = 1;
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc3, 0, 11, 16, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0,
    0xff, 0xc4, 0, 2 + 1 + 16 + 1, 0, ...counts, 0,
    0xff, 0xda, 0, 8, 1, 1, 0, 1, 0, 0,
    ...new Array<number>(64).fill(0),
    0xff, 0xd9,
  ]);
}

interface Tag {
  tag: number;
  type: number;
  value: number;
}

/** Little-endian TIFF (a DNG-shaped container) whose single strip holds `strip`, with `compression` (7 JPEG, 8 deflate). */
function dngWithStrip(strip: Buffer, compression: number, side = TAG_SIDE): Buffer {
  const header = 8;
  const tags = (stripOffset: number): Tag[] => [
    { tag: 256, type: 4, value: side },
    { tag: 257, type: 4, value: side },
    { tag: 258, type: 3, value: 16 },
    { tag: 259, type: 3, value: compression },
    { tag: 273, type: 4, value: stripOffset },
    { tag: 278, type: 4, value: side },
    { tag: 279, type: 4, value: strip.length },
  ];
  const entryCount = tags(0).length;
  const stripOffset = header + 2 + entryCount * 12 + 4;
  const out = Buffer.alloc(stripOffset + strip.length);
  out.write('II', 0, 'ascii');
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(header, 4);
  out.writeUInt16LE(entryCount, header);
  tags(stripOffset).forEach(({ tag, type, value }, index) => {
    const at = header + 2 + index * 12;
    out.writeUInt16LE(tag, at);
    out.writeUInt16LE(type, at + 2);
    out.writeUInt32LE(1, at + 4);
    if (type === 3) out.writeUInt16LE(value, at + 8);
    else out.writeUInt32LE(value, at + 8);
  });
  strip.copy(out, stripOffset);
  return out;
}

describe('the lossless JPEG sensor strip is bounded before its samples are allocated', () => {
  it('refuses a SOF3 frame over the input limit when the strip is decoded directly', () => {
    const run = (): unknown => decodeLosslessJpegStrip(losslessJpeg(SIDE_OVER_INPUT_LIMIT, SIDE_OVER_INPUT_LIMIT));
    expect(run).toThrow(InputPixelLimitError);
    expect(run).toThrow(`${SIDE_OVER_INPUT_LIMIT}x${SIDE_OVER_INPUT_LIMIT}`);
  });

  it('refuses a SOF3 frame larger than the strip it sits in, though it is within every budget', () => {
    const run = (): unknown => decodeLosslessJpegStrip(losslessJpeg(SIDE_OVER_STRIP, SIDE_OVER_STRIP), { width: TAG_SIDE, height: TAG_SIDE });
    expect(run).toThrow(InvalidRawSensorError);
    expect(run).toThrow(/larger than the 16x16 strip/);
  });

  it('decodes a frame that fits the strip it sits in', () => {
    const decoded = decodeLosslessJpegStrip(losslessJpeg(TAG_SIDE, TAG_SIDE), { width: TAG_SIDE, height: TAG_SIDE });
    expect([decoded?.width, decoded?.height, decoded?.data.length]).toEqual([TAG_SIDE, TAG_SIDE, TAG_SIDE * TAG_SIDE]);
  });

  it('refuses a 211-byte DNG whose strip declares 144 MP in its SOF3, without allocating it', async () => {
    const dng = dngWithStrip(losslessJpeg(SIDE_OVER_INPUT_LIMIT, SIDE_OVER_INPUT_LIMIT), 7);
    expect(dng.length).toBeLessThan(300);
    const rssBefore = process.memoryUsage().rss;
    const run = convertImage(dng, 'png', {}, 'x.dng', 'dng');
    await expect(run).rejects.toBeInstanceOf(InputPixelLimitError);
    await expect(run).rejects.toMatchObject({ status: HTTP_PAYLOAD_TOO_LARGE });
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(MAX_RSS_GROWTH_BYTES);
  });

  it('refuses a DNG whose strip frame is larger than the 16 x 16 the TIFF tags declare', async () => {
    const dng = dngWithStrip(losslessJpeg(SIDE_OVER_STRIP, SIDE_OVER_STRIP), 7);
    const rssBefore = process.memoryUsage().rss;
    await expect(convertImage(dng, 'png', {}, 'x.dng', 'dng')).rejects.toBeInstanceOf(InvalidRawSensorError);
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(MAX_RSS_GROWTH_BYTES);
  });

  it('refuses a deflate strip that inflates to far more than the sensor holds', async () => {
    const inflated = deflateSync(Buffer.alloc(300 * BYTES_PER_MIB), { level: 9 });
    const dng = dngWithStrip(inflated, 8);
    const rssBefore = process.memoryUsage().rss;
    await expect(convertImage(dng, 'png', {}, 'x.dng', 'dng')).rejects.toBeInstanceOf(InvalidRawSensorError);
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(MAX_RSS_GROWTH_BYTES);
  });
});
