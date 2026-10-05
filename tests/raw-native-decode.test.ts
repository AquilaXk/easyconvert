import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { EngineUnavailableError, RawDecodeError } from '../src/lib/types';
import { OracleToolMissingError, getOracleToolPath } from './helpers/differential-oracle';
import { withMissingBinary } from './helpers/native-tools';

const STRICT_MODE = process.env.ORACLE_STRICT_MODE === '1';
const RAW_FIXTURE_DIR = path.join(__dirname, 'fixtures', 'raw');
const RAW_CACHE_DIR = path.join(RAW_FIXTURE_DIR, '.cache');
const RAW_MANIFEST: readonly { format: string; sha256: string }[] = JSON.parse(
  readFileSync(path.join(RAW_FIXTURE_DIR, 'manifest.json'), 'utf-8')
);
const DCRAW_EMU = getOracleToolPath('dcraw_emu');
const RAW_IDENTIFY = getOracleToolPath('raw-identify');
const SAMPLES_PRESENT = RAW_MANIFEST.every((entry) => existsSync(samplePath(entry.format)));
const CHECKS_ENABLED = DCRAW_EMU !== null && RAW_IDENTIFY !== null && SAMPLES_PRESENT;

/** Formats LibRaw recognizes; the native engine must decode every one of them from the real sample. */
const NATIVE_FORMATS = [
  '3fr', 'arw', 'cr2', 'cr3', 'crw', 'dcr', 'dng', 'erf', 'mos', 'mrw', 'nef', 'orf', 'pef', 'raf', 'rw2',
];
const NATIVE_TARGETS = ['png', 'jpg'];
const DECODE_TIMEOUT_MS = 180_000;
const MEAN_MIN = 5;
const MEAN_MAX = 250;
const TRUNCATED_SAMPLE_BYTES = 300_000;
const JUNK_BYTES = 4096;
const TEMP_PREFIX = 'easyconvert-raw-';
const VFS_DIR = path.join(os.tmpdir(), 'easyconvert-vfs');

function samplePath(format: string): string {
  return path.join(RAW_CACHE_DIR, `${format}.${format}`);
}

/** Output size as reported by LibRaw's identify tool, an executable independent of the engine under test. */
function expectedOutputSize(format: string): { width: number; height: number } {
  const report = execFileSync(RAW_IDENTIFY!, ['-v', samplePath(format)], { encoding: 'utf-8' });
  const match = /Output size:\s+(\d+) x (\d+)/.exec(report);
  if (!match) throw new Error(`raw-identify reported no output size for ${format}:\n${report}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

function leftoverTempEntries(): string[] {
  const vfs = existsSync(VFS_DIR) ? readdirSync(VFS_DIR).map((name) => `vfs/${name}`) : [];
  return [...readdirSync(os.tmpdir()).filter((name) => name.startsWith(TEMP_PREFIX)), ...vfs].sort();
}

describe('native RAW decode tooling', () => {
  it.runIf(STRICT_MODE)('has dcraw_emu, raw-identify and the real samples (strict mode fails instead of skipping)', () => {
    if (!CHECKS_ENABLED) {
      throw new OracleToolMissingError(
        'dcraw_emu',
        `Native RAW checks need dcraw_emu, raw-identify and tests/fixtures/raw/.cache (dcraw_emu=${DCRAW_EMU}, raw-identify=${RAW_IDENTIFY}, samples=${SAMPLES_PRESENT})`
      );
    }
    expect(path.basename(DCRAW_EMU!)).toBe('dcraw_emu');
  });
});

describe.skipIf(!CHECKS_ENABLED)('native RAW sensor decode through the dispatcher', () => {
  const pairs = NATIVE_FORMATS.flatMap((format) => NATIVE_TARGETS.map((target) => [format, target] as [string, string]));

  it.each(pairs)(
    '%s -> %s decodes the real sample to the size LibRaw reports',
    async (format, target) => {
      const result = await dispatchConversion(readFileSync(samplePath(format)), format, target, {}, `sample.${format}`);
      expect(result.engineUsed).toBe('native-raw');

      const meta = await sharp(result.buffer).metadata();
      expect(meta.format).toBe(target === 'jpg' ? 'jpeg' : 'png');
      expect({ width: meta.width, height: meta.height }).toEqual(expectedOutputSize(format));

      const { channels } = await sharp(result.buffer).stats();
      expect(Math.max(...channels.map((channel) => channel.stdev))).toBeGreaterThan(0);
      const mean = channels.reduce((sum, channel) => sum + channel.mean, 0) / channels.length;
      expect(mean).toBeGreaterThan(MEAN_MIN);
      expect(mean).toBeLessThan(MEAN_MAX);
    },
    DECODE_TIMEOUT_MS
  );
});

describe.skipIf(!CHECKS_ENABLED)('native RAW decode rejects corrupt input', () => {
  it('fails a truncated DNG with a typed 400 error and cleans its temporary files', async () => {
    const truncated = readFileSync(samplePath('dng')).subarray(0, TRUNCATED_SAMPLE_BYTES);
    const before = leftoverTempEntries();
    const error = await dispatchConversion(truncated, 'dng', 'png', {}, 'truncated.dng').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RawDecodeError);
    expect((error as RawDecodeError).message).toMatch(/Native RAW decoder rejected the \.dng file/);
    expect(leftoverTempEntries()).toEqual(before);
  });

  it('fails a TIFF-framed payload that is not camera data without producing output', async () => {
    const junk = Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.alloc(JUNK_BYTES, 0xa5)]);
    const before = leftoverTempEntries();
    const error = await dispatchConversion(junk, 'dng', 'jpg', {}, 'junk.dng').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RawDecodeError);
    expect(leftoverTempEntries()).toEqual(before);
  });
});

describe.skipIf(!SAMPLES_PRESENT)('RAW conversion without the native engine', () => {
  it('raises EngineUnavailableError for a sample only sensor decode can convert', async () => {
    const error = await withMissingBinary('DCRAW_EMU_PATH', () =>
      dispatchConversion(readFileSync(samplePath('arw')), 'arw', 'png', {}, 'sample.arw').catch((e: unknown) => e)
    );
    expect(error).toBeInstanceOf(EngineUnavailableError);
    expect((error as EngineUnavailableError).engineName).toBe('dcraw_emu');
  });

  it('keeps the in-process embedded-preview route when the request opts in', async () => {
    const result = await withMissingBinary('DCRAW_EMU_PATH', () =>
      dispatchConversion(readFileSync(samplePath('cr3')), 'cr3', 'png', { allowEmbeddedPreview: true }, 'sample.cr3')
    );
    expect(result.engineUsed).toBe('internal-fallback');
    const meta = await sharp(result.buffer).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBeGreaterThan(0);
  });
});
