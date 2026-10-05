import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { RawDecodeError } from '../src/lib/types';
import { OracleToolMissingError, getOracleToolPath } from './helpers/differential-oracle';

const STRICT_MODE = process.env.ORACLE_STRICT_MODE === '1';
const CACHE_DIR = path.join(__dirname, 'fixtures', 'raw', '.cache');
const DCRAW_EMU = getOracleToolPath('dcraw_emu');
const TRUNCATED_FORMATS = ['arw', 'nef', 'cr2', 'orf', 'rw2', 'dng', 'pef', 'raf', 'mrw', 'erf', 'dcr'];
const HALF = 2;
const NINETY_PERCENT = 0.9;
const TEMP_PREFIX = 'easyconvert-raw-';
const DECODE_TIMEOUT_MS = 120_000;
const samplePath = (format: string) => path.join(CACHE_DIR, `${format}.${format}`);
const samplesPresent = TRUNCATED_FORMATS.every((format) => existsSync(samplePath(format)));
const enabled = DCRAW_EMU !== null && samplesPresent;
// A private temp root keeps leftovers from other test files out of the cleanup assertion.
process.env.TMPDIR = mkdtempSync(path.join(os.tmpdir(), 'raw-truncation-'));
const leftovers = () => readdirSync(process.env.TMPDIR!).filter((name) => name.startsWith(TEMP_PREFIX)).sort();

describe.runIf(STRICT_MODE)('RAW truncation tooling', () => {
  it('has dcraw_emu and the real samples', () => {
    if (!enabled) throw new OracleToolMissingError('dcraw_emu', 'RAW truncation checks need dcraw_emu and the sample cache');
    expect(path.basename(DCRAW_EMU!)).toBe('dcraw_emu');
  });
});

describe.skipIf(!enabled)('truncated camera files are rejected, never returned as an image', () => {
  it.each(TRUNCATED_FORMATS)(
    'a 50%% truncation of the real %s sample fails with RawDecodeError',
    async (format) => {
      const bytes = readFileSync(samplePath(format));
      const before = leftovers();
      const error = await dispatchConversion(bytes.subarray(0, bytes.length / HALF), format, 'png', {}, `cut.${format}`).catch(
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(RawDecodeError);
      expect(leftovers()).toEqual(before);
    },
    DECODE_TIMEOUT_MS
  );

  it('a 90% truncation of the arw sample fails with RawDecodeError', async () => {
    const bytes = readFileSync(samplePath('arw'));
    const error = await dispatchConversion(bytes.subarray(0, Math.floor(bytes.length * NINETY_PERCENT)), 'arw', 'png', {}, 'cut.arw').catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(RawDecodeError);
    expect((error as RawDecodeError).message).toMatch(/truncated/);
  });
});
