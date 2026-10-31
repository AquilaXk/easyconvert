import { describe, expect, it, vi } from 'vitest';
import { walkJpegStream } from '../src/lib/conversions/image-jpeg-stream';

/**
 * The walk over the entropy-coded data of a scan finds the first marker that is not a stuffed 0x00 or a restart marker. It must find
 * the same marker in data of any density of 0xFF bytes, and its search must not cost more per byte on data full of stuffed bytes than
 * on plain data: the cost is counted in calls of the native byte search, which does not depend on the speed of the machine.
 */

const START_OF_IMAGE = [0xff, 0xd8];
const START_OF_SCAN_HEADER = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00];
const END_OF_IMAGE = [0xff, 0xd9];
const PLAIN = 0x55;
const SCAN_AT = START_OF_IMAGE.length + START_OF_SCAN_HEADER.length;

/** `count` bytes of scan data in which every `period` bytes a stuffed `FF 00` pair starts; no pair for a period of 0. */
function scanData(count: number, period: number): Buffer {
  const data = Buffer.alloc(count, PLAIN);
  if (period > 0) {
    for (let at = 0; at + 1 < count; at += period) data.writeUInt16BE(0xff00, at);
  }
  return data;
}

const stream = (data: Buffer, tail: readonly number[] = END_OF_IMAGE): Buffer => Buffer.concat([Buffer.from(START_OF_IMAGE), Buffer.from(START_OF_SCAN_HEADER), data, Buffer.from(tail)]);

describe('the end of a JPEG stream whose scan holds stuffed bytes', () => {
  const MEBIBYTE = 1024 * 1024;

  it.each([
    ['no 0xFF at all', 0],
    ['an FF 00 pair every 256 bytes, as entropy-coded data of a photograph holds', 256],
    ['an FF 00 pair every 16 bytes', 16],
    ['an FF 00 pair every 4 bytes', 4],
    ['nothing but FF 00 pairs', 2],
  ])('is found after %s', (_name, period) => {
    const data = scanData(MEBIBYTE, period);
    const walk = walkJpegStream(stream(data), 0);
    expect(walk).toMatchObject({ scanStart: SCAN_AT, end: SCAN_AT + data.length + END_OF_IMAGE.length });
  });

  it('is found after a dense stretch that gives way to plain data and back, with a restart marker in each', () => {
    const restart = Buffer.from([0xff, 0xd3]);
    const data = Buffer.concat([scanData(50_000, 2), restart, scanData(70_000, 0), restart, scanData(30_000, 3), restart, scanData(90_000, 256)]);
    expect(walkJpegStream(stream(data), 0).end).toBe(SCAN_AT + data.length + END_OF_IMAGE.length);
  });

  it('stops at a marker inside a dense stretch, the stuffed pairs before it kept in the data', () => {
    const dense = scanData(10_000, 2);
    const data = Buffer.concat([dense, Buffer.from([0xff, 0xc4]), dense]);
    const walk = walkJpegStream(stream(data, []), 0);
    expect(walk.scanStart).toBe(SCAN_AT);
    expect(walk.end).toBe(-1);
  });

  it('ends at the buffer when the last byte is an 0xFF, in dense data and in plain data', () => {
    for (const period of [2, 0]) {
      const data = Buffer.concat([scanData(5000, period), Buffer.from([0xff])]);
      expect(walkJpegStream(stream(data, []), 0)).toMatchObject({ scanStart: SCAN_AT, end: -1 });
    }
  });

  it('calls the native byte search a bounded number of times for data full of stuffed bytes, not once for each pair', () => {
    const buffer = stream(scanData(4 * MEBIBYTE, 2));
    const search = vi.spyOn(buffer, 'indexOf');
    expect(walkJpegStream(buffer, 0).end).toBe(buffer.length);
    const stuffedPairs = (4 * MEBIBYTE) / 2;
    expect(search.mock.calls.length).toBeLessThan(stuffedPairs / 100);
  });

  it('bounds the searches for three close pairs and a far gap, repeated, which no run of close pairs alone reveals', () => {
    const unit = Buffer.concat([Buffer.from([0xff, 0x00, 0xff, 0x00, 0xff, 0x00]), Buffer.alloc(16, PLAIN)]);
    const data = Buffer.concat(Array.from({ length: Math.floor((4 * MEBIBYTE) / unit.length) }, () => unit));
    const buffer = stream(data);
    const search = vi.spyOn(buffer, 'indexOf');
    expect(walkJpegStream(buffer, 0).end).toBe(buffer.length);
    // One call per pair would be about 570,000 calls; the loop takes these stretches over.
    expect(search.mock.calls.length).toBeLessThan(data.length / 100);
  });

  it('finds a marker at every offset around the edge of a loop span', () => {
    for (let offset = 1018; offset <= 1030; offset += 1) {
      const data = Buffer.concat([scanData(4096, 2), Buffer.alloc(offset, PLAIN), Buffer.from([0xff, 0xc4]), scanData(64, 2)]);
      const walk = walkJpegStream(stream(data, []), 0);
      expect(walk.end, `offset ${offset}`).toBe(-1);
    }
    for (let offset = 1018; offset <= 1030; offset += 1) {
      const data = Buffer.concat([scanData(4096, 2), Buffer.alloc(offset, PLAIN), Buffer.from([0xff, 0xd0]), scanData(64, 2)]);
      expect(walkJpegStream(stream(data), 0).end, `restart at offset ${offset}`).toBe(SCAN_AT + data.length + END_OF_IMAGE.length);
    }
  });

  it('keeps the native search for data in which 0xFF is rare', () => {
    const buffer = stream(scanData(4 * MEBIBYTE, 4096));
    const search = vi.spyOn(buffer, 'indexOf');
    expect(walkJpegStream(buffer, 0).end).toBe(buffer.length);
    expect(search.mock.calls.length).toBeLessThanOrEqual((4 * MEBIBYTE) / 4096 + 1);
  });
});
