import { describe, it, expect } from 'vitest';
import { demosaicAmazeBayerCfa, demosaicRcdBayerCfa } from '../src/lib/conversions/image';
import { ConversionFailedError, InvalidRawSensorError } from '../src/lib/types';

const DEMOSAICERS = [
  ['amaze', demosaicAmazeBayerCfa],
  ['rcd', demosaicRcdBayerCfa],
] as const;

describe.each(DEMOSAICERS)('%s demosaicer rejects malformed sensor buffers with a typed error', (_name, demosaic) => {
  it('rejects odd sensor dimensions', () => {
    const run = () => demosaic({ width: 869, height: 593, pattern: 'RGGB', data: new Uint8Array(869 * 593) });
    expect(run).toThrow(InvalidRawSensorError);
    expect(run).toThrow(/Invalid sensor dimensions: 869x593/);
  });

  it('rejects a sample buffer shorter than width x height', () => {
    const run = () => demosaic({ width: 4, height: 4, pattern: 'RGGB', data: new Uint8Array(10) });
    expect(run).toThrow(InvalidRawSensorError);
    expect(run).toThrow(/Bayer sensor buffer underflow: expected at least 16 samples/);
  });

  it('is a client error (ConversionFailedError)', () => {
    try {
      demosaic({ width: 3, height: 2, pattern: 'RGGB', data: new Uint8Array(6) });
      expect.unreachable('odd dimensions must throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConversionFailedError);
      expect((err as Error).name).toBe('InvalidRawSensorError');
    }
  });
});
