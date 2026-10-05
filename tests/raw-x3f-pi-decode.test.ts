import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { RawDecodeError } from '../src/lib/types';
import { OracleToolMissingError } from './helpers/differential-oracle';
import { withMissingBinary } from './helpers/native-tools';
import { compareWithPreview, readPiFrame, readX3fContainer, type RegionComparison } from './helpers/raw-container-oracle';

const STRICT_MODE = process.env.ORACLE_STRICT_MODE === '1';
const CACHE_DIR = path.join(__dirname, 'fixtures', 'raw', '.cache');
const samplePath = (format: string) => path.join(CACHE_DIR, `${format}.${format}`);
const SAMPLES_PRESENT = existsSync(samplePath('x3f')) && existsSync(samplePath('raw'));
const ENABLED = STRICT_MODE || SAMPLES_PRESENT;

const DECODE_TIMEOUT_MS = 120_000;
/** A hostile file must be rejected quickly: decoding the real sample takes about two seconds. */
const HOSTILE_TIME_LIMIT_MS = 15_000;
const TARGETS = ['png', 'jpg'];

/**
 * Tolerances of the comparison with the camera's own preview, on a 6x6 grid of region means. The
 * preview is the firmware's rendering (its own tone curve, white balance and shading correction), so
 * the check is of structure and colour relationships, not of identical pixels.
 *  - luma: per-cell luma over the image's mean luma, so exposure differences cancel;
 *  - chroma (relative): red and blue shares of the cell's total after removing each image's mean cast;
 *  - chroma (absolute): the same without removing the cast, only meant to catch swapped channels.
 * Observed on the real samples: X3F 0.045 / 0.013 / 0.011, Pi frame 0.167 / 0.008 / 0.055.
 */
const TOLERANCE: Readonly<Record<string, RegionComparison>> = {
  x3f: { lumaRatioError: 0.1, chromaRelativeError: 0.03, chromaAbsoluteError: 0.04 },
  raw: { lumaRatioError: 0.25, chromaRelativeError: 0.03, chromaAbsoluteError: 0.1 },
};

/** Names of the metrics of `result` that exceed `limit`. */
function exceeded(result: RegionComparison, limit: RegionComparison): string[] {
  return (Object.keys(limit) as (keyof RegionComparison)[]).filter((metric) => result[metric] > limit[metric]);
}

function load(format: string): Buffer {
  return readFileSync(samplePath(format));
}

describe('in-process RAW sample files', () => {
  it.skipIf(!STRICT_MODE)('are present in strict mode', () => {
    const missing = ['x3f', 'raw'].filter((format) => !existsSync(samplePath(format)));
    if (missing.length > 0) throw new OracleToolMissingError('raw-fixtures', `${missing.join(', ')} samples missing. Run npm run fixtures:raw.`);
    expect(missing).toEqual([]);
  });
});

describe.skipIf(!ENABLED)('Sigma X3F and Raspberry Pi RAW decode through the dispatcher', () => {
  const pairs = ['x3f', 'raw'].flatMap((format) => TARGETS.map((target) => [format, target] as [string, string]));

  it.each(pairs)(
    '%s -> %s decodes the sensor data to the declared size and agrees with the camera preview',
    async (format, target) => {
      const file = load(format);
      const container = format === 'x3f' ? readX3fContainer(file) : readPiFrame(file);
      const result = await dispatchConversion(file, format, target, {}, `sample.${format}`);
      expect(result.engineUsed).toBe('native-raw');

      const meta = await sharp(result.buffer).metadata();
      expect(meta.format).toBe(target === 'jpg' ? 'jpeg' : 'png');
      expect({ width: meta.width, height: meta.height }).toEqual({
        width: container.declaredWidth,
        height: container.declaredHeight,
      });
      // The finished X3F frame is the sensor array without its calibration margins.
      expect(container.declaredWidth).toBeLessThanOrEqual(container.sensorWidth);
      expect(container.declaredHeight).toBeLessThanOrEqual(container.sensorHeight);

      const comparison = await compareWithPreview(result.buffer, container.previewJpeg);
      expect(comparison.lumaRatioError).toBeLessThanOrEqual(TOLERANCE[format].lumaRatioError);
      expect(comparison.chromaRelativeError).toBeLessThanOrEqual(TOLERANCE[format].chromaRelativeError);
      expect(comparison.chromaAbsoluteError).toBeLessThanOrEqual(TOLERANCE[format].chromaAbsoluteError);
    },
    DECODE_TIMEOUT_MS
  );

  it.each(['x3f', 'raw'])(
    'decodes %s without LibRaw installed',
    async (format) => {
      const result = await withMissingBinary('DCRAW_EMU_PATH', () => dispatchConversion(load(format), format, 'png', {}, `sample.${format}`));
      expect(result.engineUsed).toBe('native-raw');
      const { channels } = await sharp(result.buffer).stats();
      expect(Math.max(...channels.map((channel) => channel.stdev))).toBeGreaterThan(10);
    },
    DECODE_TIMEOUT_MS
  );
});

describe.skipIf(!ENABLED)('region comparison negative controls', () => {
  it('the comparator rejects a vertically flipped decode', async () => {
    const file = load('x3f');
    const container = readX3fContainer(file);
    const result = await dispatchConversion(file, 'x3f', 'png', {}, 'sample.x3f');
    const flipped = await sharp(result.buffer).flip().png().toBuffer();
    const comparison = await compareWithPreview(flipped, container.previewJpeg);
    expect(exceeded(comparison, TOLERANCE.x3f)).toContain('lumaRatioError');
    expect(comparison.lumaRatioError).toBeGreaterThan(TOLERANCE.x3f.lumaRatioError * 3);
  }, DECODE_TIMEOUT_MS);

  it('a Raspberry Pi frame with a third of its sensor rows blanked fails the comparison', async () => {
    const file = Buffer.from(load('raw'));
    const frame = readPiFrame(file);
    const start = frame.sensorDataOffset + Math.floor(frame.declaredHeight / 3) * frame.stride;
    file.fill(0, start, start + Math.floor(frame.declaredHeight / 3) * frame.stride);
    const result = await dispatchConversion(file, 'raw', 'png', {}, 'corrupt.raw');
    const comparison = await compareWithPreview(result.buffer, frame.previewJpeg);
    expect(comparison.lumaRatioError).toBeGreaterThan(TOLERANCE.raw.lumaRatioError);
  }, DECODE_TIMEOUT_MS);

  it('a Raspberry Pi frame whose sensor data is replaced by noise fails the comparison', async () => {
    const file = Buffer.from(load('raw'));
    const frame = readPiFrame(file);
    let state = 0x2545f491;
    for (let at = frame.sensorDataOffset; at < file.length; at += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      file[at] = state >>> 24;
    }
    const result = await dispatchConversion(file, 'raw', 'png', {}, 'noise.raw');
    const comparison = await compareWithPreview(result.buffer, frame.previewJpeg);
    expect(exceeded(comparison, TOLERANCE.raw)).toEqual(['lumaRatioError', 'chromaRelativeError']);
  }, DECODE_TIMEOUT_MS);

  it('an X3F file with damaged compressed sensor data is rejected with RawDecodeError', async () => {
    const file = Buffer.from(load('x3f'));
    const container = readX3fContainer(file);
    const middle = container.sensorDataOffset + 4_000_000;
    for (let at = middle; at < middle + 64; at += 1) file[at] ^= 0xa5;
    // Entropy-coded layers desynchronise after the damage: the decoder must not return a picture.
    const error = await dispatchConversion(file, 'x3f', 'png', {}, 'damaged.x3f').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RawDecodeError);
    expect((error as RawDecodeError).message).toMatch(/malformed/);
  }, DECODE_TIMEOUT_MS);
});

/** Runs a conversion that must fail with a RawDecodeError, quickly. */
async function expectRejected(file: Buffer, format: string, message: RegExp): Promise<void> {
  const started = performance.now();
  const error = await dispatchConversion(file, format, 'png', {}, `hostile.${format}`).catch((e: unknown) => e);
  expect(performance.now() - started).toBeLessThan(HOSTILE_TIME_LIMIT_MS);
  expect(error).toBeInstanceOf(RawDecodeError);
  expect((error as RawDecodeError).message).toMatch(message);
}

describe.skipIf(!ENABLED)('Raspberry Pi RAW hostile input', () => {
  const mutate = (change: (file: Buffer, trailer: number) => Buffer | void): Buffer => {
    const file = Buffer.from(load('raw'));
    const trailer = file.indexOf('BRCM', 0, 'latin1');
    return change(file, trailer) ?? file;
  };
  const OFFSET_STRIDE = 0xa0;
  const OFFSET_WIDTH = 0xd0;
  const OFFSET_HEIGHT = 0xd2;
  const OFFSET_ORDER = 0xf4;
  const OFFSET_WIDTH_COPY = 0x10e;
  const OFFSET_HEIGHT_COPY = 0x110;
  const OFFSET_NAME = 0x10;

  it('rejects sensor data cut in half', async () => {
    await expectRejected(mutate((file, trailer) => file.subarray(0, trailer + 32768 + 3_000_000)), 'raw', /truncated/);
  });

  it('rejects a header block cut short', async () => {
    await expectRejected(mutate((file, trailer) => file.subarray(0, trailer + 1000)), 'raw', /cut short/);
  });

  it('rejects a frame size above the pixel limit', async () => {
    const huge = 65532;
    const file = mutate((buffer, trailer) => {
      buffer.writeUInt16LE(huge, trailer + OFFSET_WIDTH);
      buffer.writeUInt16LE(huge, trailer + OFFSET_HEIGHT);
      buffer.writeUInt16LE(huge, trailer + OFFSET_WIDTH_COPY);
      buffer.writeUInt16LE(huge, trailer + OFFSET_HEIGHT_COPY);
      buffer.writeUInt32LE(81920, trailer + OFFSET_STRIDE);
    });
    await expectRejected(file, 'raw', /pixel limit/);
  });

  it('rejects disagreeing copies of the frame size', async () => {
    await expectRejected(mutate((file, trailer) => void file.writeUInt16LE(2000, trailer + OFFSET_WIDTH_COPY)), 'raw', /disagree/);
  });

  it('rejects a stride that does not fit the declared width', async () => {
    await expectRejected(mutate((file, trailer) => void file.writeUInt32LE(4000, trailer + OFFSET_STRIDE)), 'raw', /stride/);
  });

  it('rejects an unknown Bayer order', async () => {
    await expectRejected(mutate((file, trailer) => void (file[trailer + OFFSET_ORDER] = 9)), 'raw', /Bayer order/);
  });

  it('rejects a sensor without calibration', async () => {
    await expectRejected(mutate((file, trailer) => void file.write('zz9999', trailer + OFFSET_NAME, 'latin1')), 'raw', /no calibration/);
  });

  it('rejects an unterminated sensor name', async () => {
    await expectRejected(mutate((file, trailer) => void file.fill(0x41, trailer + OFFSET_NAME, trailer + OFFSET_NAME + 100)), 'raw', /sensor name/);
  });
});

describe.skipIf(!ENABLED)('Sigma X3F hostile input', () => {
  const OFFSET_DIRECTORY_ENTRY_LENGTH = 4;
  const IMAGE_HEADER_BYTES = 28;
  const mutate = (change: (file: Buffer) => Buffer | void): Buffer => {
    const file = Buffer.from(load('x3f'));
    return change(file) ?? file;
  };
  const directoryOf = (file: Buffer) => file.readUInt32LE(file.length - 4);

  it('rejects a file cut after most of its sensor data', async () => {
    await expectRejected(mutate((file) => file.subarray(0, Math.floor(file.length * 0.6))), 'x3f', /malformed/);
  });

  it('rejects a directory pointer past the end of the file', async () => {
    await expectRejected(mutate((file) => void file.writeUInt32LE(file.length + 100, file.length - 4)), 'x3f', /outside the file/);
  });

  it('rejects a section that extends past the end of the file', async () => {
    const file = mutate((buffer) => {
      const entry = directoryOf(buffer) + 12;
      buffer.writeUInt32LE(0xfffffff0, entry + OFFSET_DIRECTORY_ENTRY_LENGTH);
    });
    await expectRejected(file, 'x3f', /outside the file/);
  });

  it('rejects an absurd section count', async () => {
    await expectRejected(mutate((file) => void file.writeUInt32LE(0x7fffffff, directoryOf(file) + 8)), 'x3f', /lists \d+ sections/);
  });

  it('rejects sensor dimensions above the pixel limit before allocating', async () => {
    const container = readX3fContainer(load('x3f'));
    const file = mutate((buffer) => {
      buffer.writeUInt32LE(60000, container.sensorDataOffset - IMAGE_HEADER_BYTES + 16);
      buffer.writeUInt32LE(60000, container.sensorDataOffset - IMAGE_HEADER_BYTES + 20);
    });
    await expectRejected(file, 'x3f', /pixel limit/);
  });

  it('rejects a plane that extends past its section', async () => {
    const container = readX3fContainer(load('x3f'));
    const file = mutate((buffer) => {
      // Plane sizes follow the seeds (8 bytes) and the Huffman table, which ends with a zero length byte.
      let at = container.sensorDataOffset + 8;
      while (buffer[at] !== 0) at += 2;
      buffer.writeUInt32LE(0xffffff00, at + 2);
    });
    await expectRejected(file, 'x3f', /extends past its section/);
  });

  it('rejects a Huffman table that is never terminated', async () => {
    const container = readX3fContainer(load('x3f'));
    const file = mutate((buffer) => {
      buffer.fill(0x41, container.sensorDataOffset + 8, container.sensorDataOffset + 8 + 600);
    });
    await expectRejected(file, 'x3f', /Huffman table/);
  });

  it('rejects a calibration block that claims an enormous decoded size', async () => {
    const file = mutate((buffer) => {
      const directory = directoryOf(buffer);
      const count = buffer.readUInt32LE(directory + 8);
      for (let index = 0; index < count; index += 1) {
        const entry = directory + 12 + index * 12;
        if (buffer.toString('latin1', entry + 8, entry + 12) === 'CAMF') buffer.writeUInt32LE(0xfffffff0, buffer.readUInt32LE(entry) + 12);
      }
    });
    await expectRejected(file, 'x3f', /CAMF/);
  });

  it('rejects a calibration block cut down to its header', async () => {
    const file = mutate((buffer) => {
      const directory = directoryOf(buffer);
      const count = buffer.readUInt32LE(directory + 8);
      for (let index = 0; index < count; index += 1) {
        const entry = directory + 12 + index * 12;
        if (buffer.toString('latin1', entry + 8, entry + 12) === 'CAMF') buffer.writeUInt32LE(40, entry + OFFSET_DIRECTORY_ENTRY_LENGTH);
      }
    });
    await expectRejected(file, 'x3f', /Huffman table/);
  });
});
