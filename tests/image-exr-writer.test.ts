import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { float16ToFloat32, float32ToFloat16 } from '../src/lib/conversions/float16';
import { decodeOpenExr } from '../src/lib/conversions/openexr-decode';
import { encodeOpenExr, encodeOpenExrAsync, type ExrCompression } from '../src/lib/conversions/raw-hdr';
import { ConversionFailedError } from '../src/lib/types';
import { decodeExrWithFfmpeg, HAS_FFMPEG_EXR } from './helpers/ffmpeg-exr';
import { skipUnless } from './helpers/strict-skip';

/**
 * The EXR writer. Half conversion is checked against numpy's astype(float16) (tests/helpers/half_oracle.py) on a
 * set of edge cases and 200000 random bit patterns; the files are decoded by FFmpeg's exr decoder, which is
 * independent of this project's reader; the header and chunk table are walked by hand from the OpenEXR file
 * layout specification.
 */

const WORK = mkdtempSync(path.join(os.tmpdir(), 'exr-writer-'));
const ORACLE_SCRIPT = path.join(__dirname, 'helpers', 'half_oracle.py');
const numpyAvailable = spawnSync('python3', ['-I', '-c', 'import numpy'], { encoding: 'utf-8' }).status === 0;
const RANDOM_VECTORS = 200_000;
const HALF_BYTES = 2;
const RGB = 3;

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

function numpyHalfBits(values: Float32Array): Uint16Array {
  const file = path.join(WORK, 'vectors.f32');
  writeFileSync(file, Buffer.from(values.buffer, values.byteOffset, values.byteLength));
  const out = execFileSync('python3', ['-I', ORACLE_SCRIPT, file], { maxBuffer: 1 << 28 });
  return new Uint16Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
}

function edgeVectors(): number[] {
  const two = (e: number): number => Math.pow(2, e);
  return [
    0, -0, 1, -1, 0.5, 65504, 65519.99, 65520, 65535, 1e9, -65520, Infinity, -Infinity, NaN,
    1 + 0.75 * two(-10), // between 1 + 2^-10 and 1 + 2^-9: rounds to 0x3C01
    1 + two(-11), // a tie: rounds to even (1.0)
    1 + 3 * two(-11), // a tie: rounds to even (1 + 2^-9)
    1 + two(-11) + two(-20), // just over a tie
    two(-14), two(-14) - two(-24), two(-14) - two(-25), // smallest normal, largest subnormal, a tie below it
    two(-24), two(-25), two(-25) + two(-40), two(-26), 1.5 * two(-24), 2.5 * two(-24), two(-149), two(-126),
    3.3333333, -0.1, 100.123, 1e-5, 6.1e-5, 5.96e-8,
  ];
}

beforeAll(() => undefined);
afterAll(() => {
  rmSync(WORK, { recursive: true, force: true });
});

describe.skipIf(skipUnless('python3 with numpy', numpyAvailable))('float32 to half conversion', () => {
  it('matches numpy float16 on the edge cases, including 1 + 0.75 x 2^-10 as 0x3C01', () => {
    const values = Float32Array.from(edgeVectors());
    const expected = numpyHalfBits(values);
    values.forEach((value, i) => {
      if (Number.isNaN(value)) {
        expect(float32ToFloat16(value) & 0x7c00, 'NaN exponent').toBe(0x7c00);
        expect(float32ToFloat16(value) & 0x03ff, 'NaN payload').not.toBe(0);
      } else {
        expect(float32ToFloat16(value), `input ${value}`).toBe(expected[i]);
      }
    });
    expect(float32ToFloat16(1 + 0.75 * Math.pow(2, -10))).toBe(0x3c01);
  });

  it(`matches numpy float16 on ${RANDOM_VECTORS} random bit patterns`, () => {
    const next = lcg(20240601);
    const bits = new Uint32Array(RANDOM_VECTORS);
    for (let i = 0; i < bits.length; i += 1) bits[i] = next();
    const values = new Float32Array(bits.buffer);
    const expected = numpyHalfBits(values);
    let mismatches = 0;
    let firstBad = '';
    for (let i = 0; i < values.length; i += 1) {
      if (Number.isNaN(values[i])) {
        if ((float32ToFloat16(values[i]) & 0x7c00) !== 0x7c00) mismatches += 1;
        continue;
      }
      if (float32ToFloat16(values[i]) !== expected[i]) {
        mismatches += 1;
        if (!firstBad) firstBad = `bits 0x${bits[i].toString(16)}`;
      }
    }
    expect(mismatches, firstBad).toBe(0);
  });

  it('covers every half: a half converted up and down again is itself', () => {
    for (let h = 0; h < 0x10000; h += 1) {
      const exponent = (h >> 10) & 0x1f;
      if (exponent === 0x1f && (h & 0x3ff) !== 0) continue; // NaN payloads are not preserved
      expect(float32ToFloat16(float16ToFloat32(h))).toBe(h);
    }
  });
});

describe('OpenEXR file structure', () => {
  const width = 37;
  const height = 21;
  const pixels = new Float32Array(width * height * RGB);
  const next = lcg(7);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = ((next() >>> 8) / 0x1000000) * 4;

  /** Walks the header: returns the attribute map, the offset table and the byte after the table. */
  function parse(file: Buffer): { attributes: Map<string, Buffer>; offsets: number[]; chunksAt: number } {
    expect([...file.subarray(0, 8)]).toEqual([0x76, 0x2f, 0x31, 0x01, 0x02, 0, 0, 0]);
    const attributes = new Map<string, Buffer>();
    let at = 8;
    while (file[at] !== 0) {
      const nameEnd = file.indexOf(0, at);
      const name = file.toString('ascii', at, nameEnd);
      const typeEnd = file.indexOf(0, nameEnd + 1);
      const size = file.readUInt32LE(typeEnd + 1);
      attributes.set(name, file.subarray(typeEnd + 5, typeEnd + 5 + size));
      at = typeEnd + 5 + size;
    }
    at += 1;
    const dataWindow = attributes.get('dataWindow') as Buffer;
    const lines = dataWindow.readInt32LE(12) - dataWindow.readInt32LE(4) + 1;
    const perChunk = ({ 0: 1, 2: 1, 3: 16 } as Record<number, number>)[(attributes.get('compression') as Buffer)[0]];
    const count = Math.ceil(lines / perChunk);
    const offsets: number[] = [];
    for (let i = 0; i < count; i += 1) offsets.push(file.readUInt32LE(at + i * 8) + file.readUInt32LE(at + i * 8 + 4) * 0x100000000);
    return { attributes, offsets, chunksAt: at + count * 8 };
  }

  it.each([
    ['zip', 3, 16],
    ['zips', 2, 1],
    ['none', 0, 1],
  ] as Array<[ExrCompression, number, number]>)('%s: the compression attribute and chunk table follow the specification', (compression, code, perChunk) => {
    const file = encodeOpenExr(pixels, width, height, true, compression);
    const { attributes, offsets, chunksAt } = parse(file);
    expect(attributes.get('compression')?.[0]).toBe(code);
    expect(offsets).toHaveLength(Math.ceil(height / perChunk));
    expect(offsets[0]).toBe(chunksAt);
    offsets.forEach((offset, i) => {
      expect(file.readInt32LE(offset)).toBe(i * perChunk);
      const size = file.readUInt32LE(offset + 4);
      const rowsHere = Math.min(perChunk, height - i * perChunk);
      const rawSize = rowsHere * RGB * width * HALF_BYTES;
      if (compression === 'none') expect(size).toBe(rawSize);
      else expect(size).toBeLessThanOrEqual(rawSize);
      if (i + 1 < offsets.length) expect(offsets[i + 1]).toBe(offset + 8 + size);
      else expect(offset + 8 + size).toBe(file.length);
    });
  });

  it('the asynchronous writer produces the same bytes as the synchronous one', async () => {
    for (const compression of ['zip', 'zips', 'none'] as const) {
      for (const isHalf of [true, false]) {
        const sync = encodeOpenExr(pixels, width, height, isHalf, compression);
        const async = await encodeOpenExrAsync(pixels, width, height, isHalf, compression);
        expect(Buffer.compare(sync, async), `${compression} ${isHalf ? 'half' : 'float'}`).toBe(0);
      }
    }
  });

  it('refuses a size that is not positive and samples that do not fit', () => {
    expect(() => encodeOpenExr(pixels, 0, height)).toThrow(ConversionFailedError);
    expect(() => encodeOpenExr(pixels, width + 1, height)).toThrow(/linear samples/);
    expect(() => encodeOpenExr(pixels, 70_000, 1)).toThrow(/pixels on a side/);
    expect(() => encodeOpenExr(pixels, width, height, true, 'rle' as ExrCompression)).toThrow(/not supported/);
  });
});

describe.skipIf(skipUnless('ffmpeg with the exr decoder', HAS_FFMPEG_EXR))('FFmpeg reads what the writer wrote', () => {
  const width = 53;
  const height = 35; // not a multiple of 16: the last ZIP chunk is short
  const pixels = new Float32Array(width * height * RGB);
  const next = lcg(11);
  for (let i = 0; i < pixels.length; i += 1) {
    // Radiance from deep shadow to above diffuse white, as a raw bit-pattern mix so subnormal halves occur too.
    pixels[i] = i % 17 === 0 ? ((next() >>> 8) / 0x1000000) * 1e-6 : ((next() >>> 8) / 0x1000000) * 8;
  }

  it.each(['zip', 'zips', 'none'] as ExrCompression[])('%s HALF: bit-exact with the half values numpy computes', (compression) => {
    const file = encodeOpenExr(pixels, width, height, true, compression);
    const decoded = decodeExrWithFfmpeg(file);
    expect({ width: decoded.width, height: decoded.height }).toEqual({ width, height });
    const expected = numpyHalfBits(pixels);
    for (let i = 0; i < pixels.length; i += 1) expect(decoded.rgb[i], `sample ${i}`).toBe(float16ToFloat32(expected[i]));
  });

  it.each(['zip', 'zips', 'none'] as ExrCompression[])('%s FLOAT: bit-exact', (compression) => {
    const file = encodeOpenExr(pixels, width, height, false, compression);
    const decoded = decodeExrWithFfmpeg(file);
    for (let i = 0; i < pixels.length; i += 1) expect(decoded.rgb[i], `sample ${i}`).toBe(pixels[i]);
  });

  it('the project reader agrees on a ZIP file', () => {
    const file = encodeOpenExr(pixels, width, height, true, 'zip');
    const ours = decodeOpenExr(file);
    const reference = decodeExrWithFfmpeg(file);
    expect(Array.from(ours.rgb.subarray(0, 300))).toEqual(Array.from(reference.rgb.subarray(0, 300)));
  });
});

