import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { executeWorkerConversion } from '../src/worker/engines';
import { EngineUnavailableError } from '../src/lib/types';
import { withMissingBinary } from './helpers/native-tools';
import { skipWithoutRawSamples } from './helpers/strict-skip';

const CACHE_DIR = path.join(__dirname, 'fixtures', 'raw', '.cache');
const samplePath = (format: string) => path.join(CACHE_DIR, `${format}.${format}`);
/** Samples the in-process engine rejects with different typed errors: unsupported compression, no Bayer decode, odd sensor size. */
const IN_PROCESS_FAILURES = ['arw', 'cr3', 'nef'];
const SKIP_WITHOUT_SAMPLES = skipWithoutRawSamples(...IN_PROCESS_FAILURES);

describe.skipIf(SKIP_WITHOUT_SAMPLES)('executeWorkerConversion without dcraw_emu', () => {
  it.each(IN_PROCESS_FAILURES)('surfaces %s as EngineUnavailableError whatever throwOnUnavailable says', async (format) => {
    for (const throwOnUnavailable of [undefined, false, true]) {
      const error = await withMissingBinary('DCRAW_EMU_PATH', () =>
        executeWorkerConversion(readFileSync(samplePath(format)), format, 'png', { throwOnUnavailable }, `s.${format}`).catch(
          (e: unknown) => e
        )
      );
      expect(error).toBeInstanceOf(EngineUnavailableError);
      expect((error as EngineUnavailableError).engineName).toBe('dcraw_emu');
    }
  });
});
