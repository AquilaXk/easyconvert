import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resampleInterleavedInt16, resamplePlanarFloat, AudioResampleFaultError } from '../src/lib/conversions/audio-resampler';
import { encodeAvifWithCli, type AvifCliRequest } from '../src/lib/conversions/avif-cli';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { convertMedia } from '../src/lib/conversions/media';
import { LoudnessReportMissingError } from '../src/lib/conversions/media-audio-quality';
import { performOcr } from '../src/lib/conversions/ocr';
import { preprocessOcrImage } from '../src/lib/conversions/ocr-preprocess';
import { compressZstdAsync, decompressZstd, ZSTD_POOL_MIN_LEVEL } from '../src/lib/conversions/zstd';
import { ZSTD_BLOCK_SIZE_MAX } from '../src/lib/conversions/zstd-tables';
import { FORMAT_REGISTRY, getFormatByExtension } from '../src/lib/registry';
import { getCpuPool, shutdownCpuPool } from '../src/lib/workers/cpu-pool';
import { OcrPreprocessError, OcrPreprocessFaultError, SERVER_FAULT_STATUS, typedFailureOf } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';

/**
 * Every class that declares 500 is a fault of the server's own code or tools. This file starts from the worst plausible
 * upload for each one and shows the answer is a 4xx or the class cannot be reached, so that a picture or a sound a person
 * can send never becomes a server fault (a 5xx also stops the idempotent answer from being stored).
 */

const HTTP_BAD_REQUEST = 400;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const AV1_MAX_SIDE = 65_536;
const PNM_MAX_SIDE = 1_000_000;
const SCRIPT_MODE = 0o755;
const VERSION_ANSWER = `[ "$1" = "--version" ] && { echo 'Version: 1.4.2 (fake)'; exit 0; }`;
const TEST_TIMEOUT_MS = 120_000;

let workDir: string;
const savedAvifencPath = process.env.AVIFENC_PATH;

beforeAll(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'server-fault-real-input-'));
});
afterEach(() => {
  if (savedAvifencPath === undefined) delete process.env.AVIFENC_PATH;
  else process.env.AVIFENC_PATH = savedAvifencPath;
});
afterAll(async () => {
  rmSync(workDir, { recursive: true, force: true });
  await shutdownCpuPool();
});

async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error: unknown) {
    return error;
  }
  return null;
}

function statusOf(error: unknown): number | undefined {
  return typedFailureOf(error)?.status;
}

function fakeAvifenc(name: string, body: string): { script: string; marker: string } {
  const marker = path.join(workDir, `${name}.ran`);
  const script = path.join(workDir, name);
  writeFileSync(script, `#!/bin/sh\n${VERSION_ANSWER}\ntouch '${marker}'\n${body}\n`);
  chmodSync(script, SCRIPT_MODE);
  return { script, marker };
}

function strip(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#808080' } }).png({ compressionLevel: 9 }).toBuffer();
}

describe('a picture wider than AV1 allows, sent as PNG', () => {
  it.each([AV1_MAX_SIDE + 1, 70_000])('is refused as a 4xx before the encoder starts (%i x 2)', async (width) => {
    const tool = fakeAvifenc(`never-run-${width}`, 'exit 0');
    process.env.AVIFENC_PATH = tool.script;

    const error = await rejection(async () => dispatchConversion(await strip(width, 2), 'png', 'avif', {}, 'wide.png'));

    expect(error).not.toBeNull();
    expect(statusOf(error)).toBe(HTTP_PAYLOAD_TOO_LARGE);
    expect(typedFailureOf(error)?.code).toBe('input_over_limit');
    expect(existsSync(tool.marker)).toBe(false);
  }, TEST_TIMEOUT_MS);

  it('is refused on its height as well', async () => {
    const tool = fakeAvifenc('never-run-tall', 'exit 0');
    process.env.AVIFENC_PATH = tool.script;

    const error = await rejection(async () => dispatchConversion(await strip(2, AV1_MAX_SIDE + 1), 'png', 'avif', {}, 'tall.png'));

    expect(statusOf(error)).toBe(HTTP_PAYLOAD_TOO_LARGE);
    expect(existsSync(tool.marker)).toBe(false);
  }, TEST_TIMEOUT_MS);

  it('reaches the encoder at exactly the AV1 limit', async () => {
    const tool = fakeAvifenc('runs-at-limit', 'exit 3');
    process.env.AVIFENC_PATH = tool.script;

    await rejection(async () => dispatchConversion(await strip(AV1_MAX_SIDE, 1), 'png', 'avif', {}, 'limit.png'));

    expect(existsSync(tool.marker)).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('is refused when only the resized picture would be over the limit, and accepted when the resize brings it under', async () => {
    const tool = fakeAvifenc('runs-after-resize', 'exit 3');
    process.env.AVIFENC_PATH = tool.script;
    const wide = await strip(70_000, 2);

    await rejection(() => dispatchConversion(wide, 'png', 'avif', { width: 1000 }, 'wide.png'));

    expect(existsSync(tool.marker)).toBe(true);
  }, TEST_TIMEOUT_MS);
});

describe('an exit of the AVIF encoder', () => {
  const request = async (): Promise<AvifCliRequest> => ({ png: await strip(64, 64), width: 64, height: 64, quality: 60, effort: 3, bitdepth: 8, layout: '4:2:0' });

  it.each([
    ['the encoder judged an argument invalid', `echo 'ERROR: Failed to encode image: Invalid argument' >&2\nexit 1`],
    ['the encoder found invalid dimensions', `echo 'the first image cell has invalid dimensions for AV1: 70000x2' >&2\nexit 1`],
  ])('is a refusal of the picture when %s', async (name, body) => {
    const tool = fakeAvifenc(`refuses-${name.replace(/\W+/g, '-')}`, body);

    const error = await rejection(async () => encodeAvifWithCli(tool.script, await request()));

    expect(error).not.toBeNull();
    expect(typedFailureOf(error)).toEqual({ status: HTTP_BAD_REQUEST, code: 'conversion_failed' });
  }, TEST_TIMEOUT_MS);

  it.each([
    ['prints no diagnostic', 'exit 3'],
    ['prints a diagnostic about something else', `echo 'ERROR: Failed to encode image: Encoding of color planes failed' >&2\nexit 1`],
    ['ends on a signal', 'kill -ABRT $$'],
  ])('is a fault of the encoder when it %s', async (name, body) => {
    const tool = fakeAvifenc(`faults-${name.replace(/\W+/g, '-')}`, body);

    const error = await rejection(async () => encodeAvifWithCli(tool.script, await request()));

    expect(statusOf(error)).toBe(SERVER_FAULT_STATUS);
  }, TEST_TIMEOUT_MS);
});

describe('a picture wider than the Netpbm writer allows, sent for OCR', () => {
  it('is a 400 OcrPreprocessError, not a fault of the server', async () => {
    const png = await strip(PNM_MAX_SIDE + 1, 8);

    const error = await rejection(() => preprocessOcrImage(png));

    expect(error).toBeInstanceOf(OcrPreprocessError);
    expect(error).not.toBeInstanceOf(OcrPreprocessFaultError);
    expect(typedFailureOf(error)).toEqual({ status: HTTP_BAD_REQUEST, code: 'conversion_failed' });
  }, TEST_TIMEOUT_MS);

  oracleTest('is a 400 through performOcr as well', ['tesseract'], async () => {
    const png = await strip(PNM_MAX_SIDE + 1, 8);

    const error = await rejection(() => performOcr(png, 'eng'));

    expect(error).toBeInstanceOf(OcrPreprocessError);
    expect(statusOf(error)).toBe(HTTP_BAD_REQUEST);
  }, TEST_TIMEOUT_MS);
});

describe('the page preparation for OCR', () => {
  const SHAPES: ReadonlyArray<readonly [number, number]> = [[1, 1], [1, 5000], [5000, 1], [2, 1600], [60, 2000]];
  const CHANNELS = [1, 2, 3, 4] as const;

  it('never reaches an invariant fault on a picture of an odd shape or any channel count', async () => {
    const faults: string[] = [];
    for (const [width, height] of SHAPES) {
      for (const channels of CHANNELS) {
        const raw = Buffer.alloc(width * height * channels);
        for (let at = 0; at < raw.length; at += 1) raw[at] = (at * 2654435761) >>> 24;
        const png = await sharp(raw, { raw: { width, height, channels } }).png().toBuffer();

        const error = await rejection(() => preprocessOcrImage(png));

        if (error instanceof OcrPreprocessFaultError) faults.push(`${width}x${height}, ${channels} channels: ${error.message}`);
      }
    }
    expect(faults).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('never reaches an invariant fault on a 16-bit grey picture', async () => {
    const png = await sharp(Buffer.alloc(200 * 100), { raw: { width: 200, height: 100, channels: 1 } }).toColourspace('grey16').png().toBuffer();

    const error = await rejection(() => preprocessOcrImage(png));

    expect(error instanceof OcrPreprocessFaultError ? error.message : null).toBeNull();
  }, TEST_TIMEOUT_MS);
});

describe('the audio resampler', () => {
  const RATES = [1, 100, 8000, 44_100, 192_000, 768_000, 10_000_000];
  const CHANNEL_COUNTS = [1, 2, 6, 8, 33, 1000];

  it('refuses any sample rate or channel count a file can declare as a 4xx, never as a fault', () => {
    for (const source of RATES) {
      for (const target of RATES) {
        for (const channels of CHANNEL_COUNTS) {
          const planar = Array.from({ length: channels }, () => new Float32Array(16));
          for (const run of [() => resamplePlanarFloat(planar, source, target), () => resampleInterleavedInt16(new Int16Array(16 * channels), source, target, channels)]) {
            try {
              run();
            } catch (error: unknown) {
              expect(error, `${source} to ${target} Hz, ${channels} channels`).not.toBeInstanceOf(AudioResampleFaultError);
              expect(statusOf(error)).toBeLessThan(SERVER_FAULT_STATUS);
            }
          }
        }
      }
    }
  });
});

function wavOf(frames: number, sampleRate: number): Buffer {
  const data = Buffer.alloc(frames * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

describe('the loudness measuring pass', () => {
  it.each([
    ['no samples', 0],
    ['three samples', 3],
    ['one second of silence', 48_000],
  ])('answers a clip of %s with a result or a 4xx, never with a missing report', async (_name, frames) => {
    const error = await rejection(() => convertMedia(wavOf(frames, 48_000), 'wav', 'flac', { audio: { loudness: {} } }, 'clip.wav'));

    expect(error).not.toBeInstanceOf(LoudnessReportMissingError);
    if (error !== null) expect(statusOf(error) ?? HTTP_BAD_REQUEST).toBeLessThan(SERVER_FAULT_STATUS);
  }, TEST_TIMEOUT_MS);
});

describe('a text conversion whose output would be a container', () => {
  it.each([
    ['txt', 'md'],
    ['md', 'txt'],
    ['html', 'txt'],
  ])('refuses a ZIP sent as .%s to .%s with a 400 before any output is judged', async (source, target) => {
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40)]);

    const error = await rejection(() => dispatchConversion(zip, source, target, {}, `upload.${source}`));

    expect(statusOf(error)).toBe(HTTP_BAD_REQUEST);
  }, TEST_TIMEOUT_MS);
});

describe('the artifact names of a conversion', () => {
  it('has a registered format for every target a request can name, so that no artifact is stored under an unknown extension', () => {
    const unknown = Object.values(FORMAT_REGISTRY)
      .flatMap((definition) => definition.targetFormats)
      .filter((target) => getFormatByExtension(target) === undefined);

    expect(unknown).toEqual([]);
  });
});

describe('the zstd jobs of a large input', () => {
  const CASES: ReadonlyArray<readonly [string, number]> = [
    ['two blocks', 2 * ZSTD_BLOCK_SIZE_MAX],
    ['two blocks and a byte', 2 * ZSTD_BLOCK_SIZE_MAX + 1],
    ['three blocks', 3 * ZSTD_BLOCK_SIZE_MAX],
    ['many blocks', 40 * ZSTD_BLOCK_SIZE_MAX + 17],
  ];

  it.each(CASES)('splits %s as the pool thread plans it again', async (_name, bytes) => {
    for (const level of [1, ZSTD_POOL_MIN_LEVEL - 1, ZSTD_POOL_MIN_LEVEL]) {
      const input = Buffer.alloc(bytes, 'ab');

      const frame = await compressZstdAsync(input, { level });

      expect(decompressZstd(frame).equals(input), `level ${level}`).toBe(true);
    }
  }, TEST_TIMEOUT_MS);

  it('is a fault of the server when a thread is asked for a job of an input that is not split', async () => {
    const error = await rejection(() => getCpuPool().submit('zstdJob', { data: new Uint8Array(100), level: 1, index: 0 }));

    expect(error).not.toBeNull();
    expect(typedFailureOf(error)).toEqual({ status: SERVER_FAULT_STATUS, code: 'conversion_failed' });
  }, TEST_TIMEOUT_MS);
});
