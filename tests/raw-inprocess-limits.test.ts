import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { RawDecodeError } from '../src/lib/types';
import { readX3fContainer } from './helpers/raw-container-oracle';
import { skipWithoutRawSamples } from './helpers/strict-skip';

/** Real engine, CLI or large-input work: the 5 s default fails on a loaded CI shard without any regression; 60 s only stops a hang. */
const ENGINE_TEST_TIMEOUT_MS = 60_000;
vi.setConfig({ testTimeout: ENGINE_TEST_TIMEOUT_MS });

const CACHE_DIR = path.join(__dirname, 'fixtures', 'raw', '.cache');
const samplePath = (format: string) => path.join(CACHE_DIR, `${format}.${format}`);
const SKIP_WITHOUT_SAMPLES = skipWithoutRawSamples('x3f', 'raw');
/** Hang guard only: a hostile header is refused in milliseconds; the allocation check carries the claim that nothing large is built. */
const REJECT_HANG_GUARD_MS = 30_000;
/** Rejection must not allocate pixel buffers: a decode of the declared size would take hundreds of MB. */
const MAX_ALLOCATION_BYTES = 64 * 1024 * 1024;
const DECODE_TIMEOUT_MS = 120_000;
const TICK_MS = 10;
const MIN_TICKS = 40;
const IMAGE_HEADER_BYTES = 28;
const OFFSET_COLUMNS = 16;
const OFFSET_ROWS = 20;
const TRUE_SEED_BYTES = 8;
const TINY_PLANE_BYTES = 64;
const BRCM_OFFSET_STRIDE = 0xa0;
const BRCM_OFFSET_WIDTH = 0xd0;
const BRCM_OFFSET_HEIGHT = 0xd2;
const BRCM_OFFSET_WIDTH_COPY = 0x10e;
const BRCM_OFFSET_HEIGHT_COPY = 0x110;

function external(): number {
  const usage = process.memoryUsage();
  return usage.arrayBuffers + usage.rss;
}

async function expectQuickRejection(file: Buffer, format: string, message: RegExp): Promise<void> {
  const before = external();
  const started = performance.now();
  const error = await dispatchConversion(file, format, 'png', {}, `hostile.${format}`).catch((e: unknown) => e);
  expect(performance.now() - started).toBeLessThan(REJECT_HANG_GUARD_MS);
  expect(external() - before).toBeLessThan(MAX_ALLOCATION_BYTES);
  expect(error).toBeInstanceOf(RawDecodeError);
  expect((error as RawDecodeError).message).toMatch(message);
}

describe.skipIf(SKIP_WITHOUT_SAMPLES)('in-process RAW decoders bound their work by real hardware', () => {
  it('rejects a Raspberry Pi frame declaring more than the ov5647 sensor has', async () => {
    const file = Buffer.from(readFileSync(samplePath('raw')));
    const trailer = file.indexOf('BRCM', 0, 'latin1');
    const side = 12240;
    file.writeUInt16LE(side, trailer + BRCM_OFFSET_WIDTH);
    file.writeUInt16LE(side, trailer + BRCM_OFFSET_HEIGHT);
    file.writeUInt16LE(side, trailer + BRCM_OFFSET_WIDTH_COPY);
    file.writeUInt16LE(side, trailer + BRCM_OFFSET_HEIGHT_COPY);
    file.writeUInt32LE(15328, trailer + BRCM_OFFSET_STRIDE);
    await expectQuickRejection(file, 'raw', /larger than the 2592x1944 ov5647 sensor/);
  });

  it('rejects an X3F sensor section above the Foveon pixel cap', async () => {
    const file = Buffer.from(readFileSync(samplePath('x3f')));
    const at = readX3fContainer(file).sensorDataOffset - IMAGE_HEADER_BYTES;
    file.writeUInt32LE(12000, at + OFFSET_COLUMNS);
    file.writeUInt32LE(12500, at + OFFSET_ROWS);
    await expectQuickRejection(file, 'x3f', /pixel limit/);
  });

  it('rejects X3F planes too small to hold one bit per sample before allocating', async () => {
    const file = Buffer.from(readFileSync(samplePath('x3f')));
    // Plane sizes follow the seeds (8 bytes) and the Huffman table, which ends with a zero length byte.
    let at = readX3fContainer(file).sensorDataOffset + TRUE_SEED_BYTES;
    while (file[at] !== 0) at += 2;
    file.writeUInt32LE(TINY_PLANE_BYTES, at + 2);
    await expectQuickRejection(file, 'x3f', /too small for/);
  });

  it.each(['x3f', 'raw'])(
    'keeps the main thread responsive while decoding %s',
    async (format) => {
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
      }, TICK_MS);
      try {
        await dispatchConversion(readFileSync(samplePath(format)), format, 'png', {}, `sample.${format}`);
      } finally {
        clearInterval(timer);
      }
      expect(ticks).toBeGreaterThan(MIN_TICKS);
    },
    DECODE_TIMEOUT_MS
  );

  it('terminates the decode thread when the time limit passes', async () => {
    const error = await dispatchConversion(readFileSync(samplePath('x3f')), 'x3f', 'png', { timeoutMs: 1 }, 'slow.x3f').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RawDecodeError);
    expect((error as RawDecodeError).message).toMatch(/time limit/);
  }, DECODE_TIMEOUT_MS);

  it('rejects a CAMF block declaring more decoded bytes than its stream can produce', async () => {
    const file = Buffer.from(readFileSync(samplePath('x3f')));
    const directory = file.readUInt32LE(file.length - 4);
    const count = file.readUInt32LE(directory + 8);
    for (let index = 0; index < count; index += 1) {
      const entry = directory + 12 + index * 12;
      if (file.toString('latin1', entry + 8, entry + 12) === 'CAMF') file.writeUInt32LE(50_000_000, file.readUInt32LE(entry) + 12);
    }
    await expectQuickRejection(file, 'x3f', /more than its stream can hold/);
  });
});
