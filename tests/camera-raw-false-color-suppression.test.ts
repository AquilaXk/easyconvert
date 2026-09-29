import { describe, it, expect } from 'vitest';
import {
  applyFalseColorSuppression,
  demosaicAmazeBayerCfa,
  demosaicAhdBayerCfa,
  BayerSensorData,
} from '../src/lib/conversions/image';

describe('Camera RAW False Color Suppression (AMaZE & AHD)', () => {
  describe('1. 5x5 Chrominance Difference Plane Filtering', () => {
    it('suppresses high-frequency alternating chromatic zipper noise', () => {
      const width = 16;
      const height = 16;
      const size = width * height;

      const noisyRedDiff = new Float32Array(size);
      const noisyBlueDiff = new Float32Array(size);

      // Create high-frequency chromatic zipper spikes (outliers typical of demosaicing chromatic errors)
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = y * width + x;
          const isSpike = x % 3 === 0 && y % 2 === 0;
          const noise = isSpike ? 60 : 0;
          noisyRedDiff[idx] = noise;
          noisyBlueDiff[idx] = -noise;
        }
      }

      // Compute initial variance
      const meanInitialR = noisyRedDiff.reduce((a, b) => a + b, 0) / size;
      const varInitialR =
        noisyRedDiff.reduce((acc, v) => acc + (v - meanInitialR) ** 2, 0) / size;
      expect(varInitialR).toBeGreaterThan(400);

      // Apply False Color Suppression (1 pass of 5x5 median filtering)
      const filtered = applyFalseColorSuppression(
        noisyRedDiff,
        noisyBlueDiff,
        width,
        height,
        1
      );

      // In a 5x5 window with alternating +50 / -50:
      // The median of 13 of one sign and 12 of the other will be close to zero or smooth
      const meanFilteredR =
        filtered.filteredRedDiff.reduce((a, b) => a + b, 0) / size;
      const varFilteredR =
        filtered.filteredRedDiff.reduce((acc, v) => acc + (v - meanFilteredR) ** 2, 0) / size;

      // Variance should be reduced by more than 80%
      expect(varFilteredR).toBeLessThan(varInitialR * 0.2);
    });

    it('strictly preserves smooth/uniform chromatic regions without degradation', () => {
      const width = 10;
      const height = 10;
      const size = width * height;

      // Constant chrominance offset: e.g. warm sunlight (R - G = 25, B - G = -15)
      const smoothRedDiff = new Float32Array(size).fill(25);
      const smoothBlueDiff = new Float32Array(size).fill(-15);

      const filtered = applyFalseColorSuppression(
        smoothRedDiff,
        smoothBlueDiff,
        width,
        height,
        2
      );

      for (let i = 0; i < size; i++) {
        expect(filtered.filteredRedDiff[i]).toBeCloseTo(25, 4);
        expect(filtered.filteredBlueDiff[i]).toBeCloseTo(-15, 4);
      }
    });
  });

  describe('2. End-to-End Demosaicing with False Color Suppression', () => {
    it('reduces chromatic overshoot across high-contrast vertical edge in AMaZE demosaicing', () => {
      const width = 16;
      const height = 16;
      // High-contrast vertical edge: left half 20 (shadow), right half 220 (highlight)
      const bayer = new Uint8Array(width * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          bayer[y * width + x] = x < 8 ? 20 : 220;
        }
      }

      const sensorBase: BayerSensorData = {
        width,
        height,
        pattern: 'RGGB',
        data: bayer,
        applySrgbGamma: false,
      };

      // Demosaic without FCS
      const resultNoFcs = demosaicAmazeBayerCfa(sensorBase);

      // Demosaic with FCS
      const sensorFcs: BayerSensorData = {
        ...sensorBase,
        falseColorSuppression: true,
      };
      const resultWithFcs = demosaicAmazeBayerCfa(sensorFcs);

      expect(resultWithFcs.data.length).toBe(width * height * 3);

      // Compute total chromatic divergence |R - G| + |B - G| in the edge transition column (x=7, x=8)
      let edgeChromaNoFcs = 0;
      let edgeChromaFcs = 0;

      for (let y = 4; y < 12; y++) {
        for (const x of [7, 8]) {
          const idx = (y * width + x) * 3;
          const r0 = resultNoFcs.data[idx];
          const g0 = resultNoFcs.data[idx + 1];
          const b0 = resultNoFcs.data[idx + 2];
          edgeChromaNoFcs += Math.abs(r0 - g0) + Math.abs(b0 - g0);

          const r1 = resultWithFcs.data[idx];
          const g1 = resultWithFcs.data[idx + 1];
          const b1 = resultWithFcs.data[idx + 2];
          edgeChromaFcs += Math.abs(r1 - g1) + Math.abs(b1 - g1);
        }
      }

      // FCS must suppress false color overshoots at the boundary
      expect(edgeChromaFcs).toBeLessThanOrEqual(edgeChromaNoFcs);
    });

    it('applies False Color Suppression in AHD demosaicing cleanly', () => {
      const width = 16;
      const height = 16;
      const bayer = new Uint8Array(width * height).fill(128);

      const sensor: BayerSensorData = {
        width,
        height,
        pattern: 'RGGB',
        data: bayer,
        falseColorSuppression: 2, // 2 passes
      };

      const result = demosaicAhdBayerCfa(sensor);
      expect(result.data.length).toBe(width * height * 3);

      // On a flat field, output should remain perfectly balanced grey
      const midIdx = (8 * width + 8) * 3;
      expect(result.data[midIdx]).toBeGreaterThan(100);
      expect(result.data[midIdx + 1]).toBeGreaterThan(100);
      expect(result.data[midIdx + 2]).toBeGreaterThan(100);
      expect(Math.abs(result.data[midIdx] - result.data[midIdx + 1])).toBeLessThanOrEqual(5);
    });
  });
});
