import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { RawDecodeError } from '../src/lib/types';
import { compareWithPreview, readPiFrame, readX3fContainer } from './helpers/raw-container-oracle';
import { DECODE_TIMEOUT_MS, ENABLED, SAMPLES, TOLERANCE, containerOf, exceeded, formatOf, load } from './helpers/raw-sample-set';

/** The comparison with the camera preview must reject a flipped, blanked or noisy decode; a decoder that returns damaged data must fail. */
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
    expect(exceeded(comparison, TOLERANCE.raw)).toEqual(expect.arrayContaining(['lumaRatioError', 'chromaRelativeError']));
  }, DECODE_TIMEOUT_MS);

  const VARIANTS = SAMPLES.filter((name) => name.includes('-'));

  it.each(VARIANTS)('the comparator rejects a vertically flipped decode of %s', async (name) => {
    const format = formatOf(name);
    const file = load(name);
    const container = containerOf(name, file);
    const result = await dispatchConversion(file, format, 'png', {}, `sample.${format}`);
    const flipped = await sharp(result.buffer).flip().png().toBuffer();
    const comparison = await compareWithPreview(flipped, container.previewJpeg);
    const failed = exceeded(comparison, TOLERANCE[name]);
    expect(failed).toContain('lumaRatioError');
    expect(failed).toContain('lumaRankCorrelation');
    expect(comparison.lumaRatioError).toBeGreaterThan(TOLERANCE[name].lumaRatioError * 1.2);
  }, DECODE_TIMEOUT_MS);

  it.each(['raw-imx219', 'raw-imx477'] as const)('a %s frame whose sensor data is replaced by noise fails the comparison', async (name) => {
    const file = Buffer.from(load(name));
    const frame = readPiFrame(file);
    let state = 0x2545f491;
    for (let at = frame.sensorDataOffset; at < file.length; at += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      file[at] = state >>> 24;
    }
    const result = await dispatchConversion(file, 'raw', 'png', {}, 'noise.raw');
    const comparison = await compareWithPreview(result.buffer, frame.previewJpeg);
    expect(comparison.lumaRankCorrelation).toBeLessThan(TOLERANCE[name].lumaRankCorrelation - 0.3);
    expect(comparison.chromaRelativeError).toBeGreaterThan(TOLERANCE[name].chromaRelativeError);
  }, DECODE_TIMEOUT_MS);

  it.each(['x3f-sd14', 'x3f-merrill', 'x3f-quattro'] as const)('an %s file with damaged compressed sensor data is rejected with RawDecodeError', async (name) => {
    const file = Buffer.from(load(name));
    const container = readX3fContainer(file);
    const middle = container.sensorDataOffset + Math.floor((container.sensorSectionLength - 28) / 3);
    for (let at = middle; at < middle + 4096; at += 1) file[at] ^= 0xa5;
    const error = await dispatchConversion(file, 'x3f', 'png', {}, 'damaged.x3f').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RawDecodeError);
    expect((error as RawDecodeError).message).toMatch(/malformed/);
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
