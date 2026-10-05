import { describe, it, expect } from 'vitest';
import {
  DEMOSAIC_MAX_TILE,
  DEMOSAIC_MIN_TILE,
  demosaicAhdBayerCfa,
  demosaicAmazeBayerCfa,
  medianOf25,
} from '../src/lib/conversions/raw-demosaic';
import { ConversionFailedError, InvalidRawSensorError } from '../src/lib/types';
import { mulberry32 } from './raw-demosaic/inputs';

const ENGINES = [
  ['amaze', demosaicAmazeBayerCfa],
  ['ahd', demosaicAhdBayerCfa],
] as const;

const BYTE_LEVELS = 256;
const FLAT_SIDE = 4;
const MEDIAN_TRIALS = 3000;
const MEDIAN_WINDOW = 25;
const MEDIAN_INDEX = 12;
const FLOAT_TOLERANCE = 1e-6;
const OVER_LIMIT_SIDE = 20000;

/** IEC 61966-2-1 sRGB encoding, written out from the standard (not taken from the module under test). */
function srgbEncode(linear: number): number {
  return linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
}

describe.each(ENGINES)('%s demosaic fails closed on malformed sensors', (_name, demosaic) => {
  const base = { width: 4, height: 4, pattern: 'RGGB' as const, data: new Uint8Array(16) };

  it('rejects dimensions below 2x2 and non-integers with a typed client error', () => {
    for (const [width, height] of [[0, 4], [4, 1], [4.5, 4], [Number.NaN, 4]]) {
      const run = () => demosaic({ ...base, width, height });
      expect(run).toThrow(InvalidRawSensorError);
      expect(run).toThrow(/Invalid sensor dimensions/);
    }
  });

  it('rejects an unknown CFA pattern', () => {
    const run = () => demosaic({ ...base, pattern: 'RGBG' as never });
    expect(run).toThrow(InvalidRawSensorError);
    expect(run).toThrow(/Unsupported Bayer CFA pattern: 'RGBG'/);
  });

  it('rejects a sample buffer shorter than width x height', () => {
    const run = () => demosaic({ ...base, data: new Uint8Array(10) });
    expect(run).toThrow(InvalidRawSensorError);
    expect(run).toThrow(/underflow|empty/);
  });

  it('rejects a frame above the pixel limit before reading or allocating anything', () => {
    const run = () => demosaic({ ...base, width: OVER_LIMIT_SIDE, height: OVER_LIMIT_SIDE });
    expect(run).toThrow(InvalidRawSensorError);
    expect(run).toThrow(/exceeds the 150000000 pixel demosaic limit/);
  });

  it.each([DEMOSAIC_MIN_TILE - 2, DEMOSAIC_MIN_TILE + 1, DEMOSAIC_MAX_TILE + 2, 0, Number.NaN, 31.5])(
    'rejects tile size %s',
    (tileSize) => {
      const run = () => demosaic(base, { tileSize });
      expect(run).toThrow(InvalidRawSensorError);
      expect(run).toThrow(/Invalid demosaic tile size/);
    }
  );

  it('keeps rejecting an inverted calibration (white level not above black level)', () => {
    expect(() => demosaic({ ...base, blackLevel: 500, whiteLevel: 200 })).toThrow(
      /whiteLevel \(200\) must be strictly greater than blackLevel \(500\)/
    );
  });

  it('is a ConversionFailedError so the API answers 400', () => {
    try {
      demosaic({ ...base, data: new Uint8Array(3) });
      expect.unreachable('a short buffer must throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConversionFailedError);
      expect((err as Error).name).toBe('InvalidRawSensorError');
    }
  });
});

describe('AHD specific input handling', () => {
  it('rejects an empty buffer', () => {
    expect(() => demosaicAhdBayerCfa({ width: 4, height: 4, pattern: 'RGGB', data: new Uint8Array(0) })).toThrow(
      /Bayer sensor buffer empty or undefined/
    );
  });

  it('rejects a 16-bit byte buffer holding fewer than two bytes per sample', () => {
    const run = () => demosaicAhdBayerCfa({ width: 4, height: 4, pattern: 'RGGB', data: Buffer.alloc(16), bitsPerSample: 12 });
    expect(run).toThrow(InvalidRawSensorError);
    expect(run).toThrow(/expected at least 32 samples, got 16/);
  });

  it('reads little-endian 16-bit bytes: a flat 0x0FFF frame at 12 bits is full scale', () => {
    const data = Buffer.alloc(FLAT_SIDE * FLAT_SIDE * 2);
    for (let i = 0; i < FLAT_SIDE * FLAT_SIDE; i += 1) data.writeUInt16LE(0x0fff, i * 2);
    const result = demosaicAhdBayerCfa({ width: FLAT_SIDE, height: FLAT_SIDE, pattern: 'GRBG', data, bitsPerSample: 12, applySrgbGamma: false });
    expect(Array.from(result.floatData.subarray(0, 3))).toEqual([1, 1, 1]);
    expect(Array.from(result.data.subarray(0, 3))).toEqual([255, 255, 255]);
  });
});

describe.each(ENGINES)('%s flat frames reproduce their level', (_name, demosaic) => {
  it('maps every 8-bit level to the sRGB code of the IEC 61966-2-1 encoding and to level/255 in float', () => {
    for (let level = 0; level < BYTE_LEVELS; level += 1) {
      const data = new Uint8Array(FLAT_SIDE * FLAT_SIDE).fill(level);
      const result = demosaic({ width: FLAT_SIDE, height: FLAT_SIDE, pattern: 'RGGB', data, bitsPerSample: 8, applySrgbGamma: true });
      const expectedCode = Math.round(255 * srgbEncode(level / 255));
      const last = (FLAT_SIDE * FLAT_SIDE - 1) * 3;
      for (const at of [0, last]) {
        for (let c = 0; c < 3; c += 1) {
          expect(result.data[at + c]).toBe(expectedCode);
          expect(Math.abs(result.floatData[at + c] - level / 255)).toBeLessThan(FLOAT_TOLERANCE);
        }
      }
    }
  });

  it('skips the 8-bit buffer on request and leaves the float output unchanged', () => {
    const data = Uint8Array.from({ length: 64 }, (_v, i) => (i * 37) % 251);
    const sensor = { width: 8, height: 8, pattern: 'BGGR' as const, data, bitsPerSample: 8, applySrgbGamma: true };
    const full = demosaic(sensor);
    const floatOnly = demosaic(sensor, { buildRgb8: false });
    expect(floatOnly.data.length).toBe(0);
    expect(full.data.length).toBe(8 * 8 * 3);
    expect(Buffer.compare(Buffer.from(floatOnly.floatData.buffer), Buffer.from(full.floatData.buffer))).toBe(0);
  });
});

describe('medianOf25 equals the middle element of a sort', () => {
  it('holds for random windows with ties, negatives and repeated values', () => {
    const rand = mulberry32(2025);
    for (let trial = 0; trial < MEDIAN_TRIALS; trial += 1) {
      const window = new Float32Array(MEDIAN_WINDOW);
      const levels = 2 + Math.floor(rand() * 30);
      for (let k = 0; k < MEDIAN_WINDOW; k += 1) window[k] = Math.floor(rand() * levels) - levels / 3 + (trial % 2 === 0 ? 0 : rand());
      const expected = Float32Array.from(window).sort()[MEDIAN_INDEX];
      expect(medianOf25(window)).toBe(expected);
    }
  });
});
