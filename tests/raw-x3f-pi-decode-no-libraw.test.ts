import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { withMissingBinary } from './helpers/native-tools';
import { DECODE_TIMEOUT_MS, ENABLED, SAMPLES, formatOf, load } from './helpers/raw-sample-set';

/** The in-process decoders on their own: every sample converts with the LibRaw binary removed from the lookup. */
describe.skipIf(!ENABLED)('Sigma X3F and Raspberry Pi RAW decode through the dispatcher', () => {
  it.each(SAMPLES)(
    'decodes %s without LibRaw installed',
    async (name) => {
      const format = formatOf(name);
      const result = await withMissingBinary('DCRAW_EMU_PATH', () => dispatchConversion(load(name), format, 'png', {}, `sample.${format}`));
      expect(result.engineUsed).toBe('in-process-raw');
      const { channels } = await sharp(result.buffer).stats();
      expect(Math.max(...channels.map((channel) => channel.stdev))).toBeGreaterThan(10);
    },
    DECODE_TIMEOUT_MS
  );
});
