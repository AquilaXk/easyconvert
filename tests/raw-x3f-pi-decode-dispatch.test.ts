import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { compareWithPreview } from './helpers/raw-container-oracle';
import { DECODE_TIMEOUT_MS, ENABLED, SAMPLES, TARGETS, TOLERANCE, containerOf, exceeded, formatOf, load, type SampleName } from './helpers/raw-sample-set';

/** Each real sample through the dispatcher to PNG and JPEG, compared with the camera's own preview (see raw-x3f-pi-decode.test.ts for the sample set). */
describe.skipIf(!ENABLED)('Sigma X3F and Raspberry Pi RAW decode through the dispatcher', () => {
  const pairs = SAMPLES.flatMap((name) => TARGETS.map((target) => [name, target] as [SampleName, string]));

  it.each(pairs)(
    '%s -> %s decodes the sensor data to the declared size and agrees with the camera preview',
    async (name, target) => {
      const format = formatOf(name);
      const file = load(name);
      const container = containerOf(name, file);
      const result = await dispatchConversion(file, format, target, {}, `sample.${format}`);
      expect(result.engineUsed).toBe('in-process-raw');

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
      expect(exceeded(comparison, TOLERANCE[name]), JSON.stringify(comparison)).toEqual([]);
    },
    DECODE_TIMEOUT_MS
  );
});
