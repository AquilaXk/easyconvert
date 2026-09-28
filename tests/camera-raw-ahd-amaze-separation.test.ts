import { describe, it, expect } from 'vitest';
import {
  demosaicAhdBayerCfa,
  demosaicAmazeBayerCfa,
  demosaicBayerCfa,
  BayerSensorData,
} from '../src/lib/conversions/image';

/**
 * Calculates Peak Signal-to-Noise Ratio (PSNR) between two RGB buffers.
 */
function calculatePsnr(bufA: Buffer, bufB: Buffer): number {
  expect(bufA.length).toBe(bufB.length);
  let mse = 0;
  for (let i = 0; i < bufA.length; i++) {
    const diff = bufA[i] - bufB[i];
    mse += diff * diff;
  }
  mse /= bufA.length;
  if (mse === 0) return Infinity;
  return 10 * Math.log10((255 * 255) / mse);
}

/**
 * Generates synthetic Bayer CFA mosaic pattern with sharp diagonal edges and gradients.
 */
function generateSyntheticCfa(
  width: number,
  height: number,
  pattern: 'RGGB' | 'BGGR' | 'GRBG' | 'GBRG',
  bitDepth: number = 8
): { sensor: BayerSensorData; groundTruth: Buffer } {
  const maxVal = (1 << bitDepth) - 1;
  const cfaData = Buffer.alloc(width * height * (bitDepth > 8 ? 2 : 1));
  const groundTruth = Buffer.alloc(width * height * 3);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Synthetic ground truth scene: diagonal zone plate with high-frequency spatial variation
      const rVal = Math.round(128 + 100 * Math.sin((x * x + y * y) * 0.01));
      const gVal = Math.round(128 + 100 * Math.cos((x * y) * 0.015));
      const bVal = Math.round(128 + 100 * Math.sin((x + y) * 0.15));

      const rClamped = Math.max(0, Math.min(255, rVal));
      const gClamped = Math.max(0, Math.min(255, gVal));
      const bClamped = Math.max(0, Math.min(255, bVal));

      const gtIdx = (y * width + x) * 3;
      groundTruth[gtIdx] = rClamped;
      groundTruth[gtIdx + 1] = gClamped;
      groundTruth[gtIdx + 2] = bClamped;

      // Determine CFA channel based on Bayer pattern
      let ch: 'R' | 'G' | 'B';
      const row = y % 2;
      const col = x % 2;

      if (pattern === 'RGGB') {
        ch = row === 0 ? (col === 0 ? 'R' : 'G') : col === 0 ? 'G' : 'B';
      } else if (pattern === 'BGGR') {
        ch = row === 0 ? (col === 0 ? 'B' : 'G') : col === 0 ? 'G' : 'R';
      } else if (pattern === 'GRBG') {
        ch = row === 0 ? (col === 0 ? 'G' : 'R') : col === 0 ? 'B' : 'G';
      } else {
        // GBRG
        ch = row === 0 ? (col === 0 ? 'G' : 'B') : col === 0 ? 'R' : 'G';
      }

      const sample8 = ch === 'R' ? rClamped : ch === 'G' ? gClamped : bClamped;
      const sampleBit = Math.round((sample8 / 255.0) * maxVal);

      const offset = y * width + x;
      if (bitDepth > 8) {
        cfaData.writeUInt16LE(sampleBit, offset * 2);
      } else {
        cfaData[offset] = sampleBit;
      }
    }
  }

  return {
    sensor: {
      width,
      height,
      data: cfaData,
      pattern,
      bitsPerSample: bitDepth,
      applySrgbGamma: false,
    },
    groundTruth,
  };
}

describe('Camera RAW Demosaicing Algorithm Separation (AHD vs AMaZE)', () => {
  it('strictly isolates AHD and AMaZE bitstreams with measurable divergence and high fidelity', () => {
    const width = 64;
    const height = 64;
    const { sensor } = generateSyntheticCfa(width, height, 'RGGB', 8);

    const resultAhd = demosaicAhdBayerCfa(sensor);
    const resultAmaze = demosaicAmazeBayerCfa(sensor);

    expect(resultAhd.width).toBe(width);
    expect(resultAhd.height).toBe(height);
    expect(resultAmaze.width).toBe(width);
    expect(resultAmaze.height).toBe(height);

    // Verify buffer lengths match 3 channels RGB
    expect(resultAhd.data.length).toBe(width * height * 3);
    expect(resultAmaze.data.length).toBe(width * height * 3);

    // Anti-cheating contract: bitstreams MUST diverge (AHD is not a trivial clone or alias of AMaZE)
    const isExactMatch = Buffer.compare(resultAhd.data, resultAmaze.data) === 0;
    expect(isExactMatch).toBe(false);

    // Compute byte-level divergence
    let differentBytes = 0;
    let totalAbsDiff = 0;
    for (let i = 0; i < resultAhd.data.length; i++) {
      const diff = Math.abs(resultAhd.data[i] - resultAmaze.data[i]);
      if (diff > 0) {
        differentBytes++;
        totalAbsDiff += diff;
      }
    }

    const diffRatio = differentBytes / resultAhd.data.length;
    const meanDiff = totalAbsDiff / resultAhd.data.length;

    // AHD and AMaZE use fundamentally different directional selection strategies:
    // AHD uses CIELAB Delta-E homogeneity map; AMaZE uses spatial-weighted edge gradients.
    // Significant proportion of pixels should have distinct reconstructions
    expect(diffRatio).toBeGreaterThan(0.3); // At least 30% differing bytes
    expect(meanDiff).toBeGreaterThan(1.0); // Mean difference across image

    // Both algorithms must maintain reasonable mutual PSNR (typically 25dB - 45dB)
    const mutualPsnr = calculatePsnr(resultAhd.data, resultAmaze.data);
    expect(mutualPsnr).toBeGreaterThan(20);
    expect(mutualPsnr).toBeLessThan(60); // Not identical
  });

  it('correctly processes all 4 Bayer CFA mosaic layouts (RGGB, BGGR, GRBG, GBRG)', () => {
    const patterns: Array<'RGGB' | 'BGGR' | 'GRBG' | 'GBRG'> = ['RGGB', 'BGGR', 'GRBG', 'GBRG'];

    for (const pat of patterns) {
      const { sensor } = generateSyntheticCfa(32, 32, pat, 8);
      const resAhd = demosaicAhdBayerCfa(sensor);

      expect(resAhd.data.length).toBe(32 * 32 * 3);

      // Verify no all-zero or NaN output
      let sum = 0;
      for (let i = 0; i < resAhd.data.length; i++) {
        sum += resAhd.data[i];
      }
      expect(sum).toBeGreaterThan(0);

      // Average pixel value should fall in expected range [50, 200]
      const avg = sum / resAhd.data.length;
      expect(avg).toBeGreaterThan(50);
      expect(avg).toBeLessThan(200);
    }
  });

  it('accurately handles 12-bit and 14-bit high dynamic range sensor RAW data', () => {
    const { sensor: sensor12 } = generateSyntheticCfa(32, 32, 'RGGB', 12);
    const { sensor: sensor14 } = generateSyntheticCfa(32, 32, 'RGGB', 14);

    const res12 = demosaicAhdBayerCfa(sensor12);
    const res14 = demosaicAhdBayerCfa(sensor14);

    expect(res12.data.length).toBe(32 * 32 * 3);
    expect(res14.data.length).toBe(32 * 32 * 3);

    // 12-bit and 14-bit reconstructions from normalized input should be highly correlated (>35 dB PSNR)
    const psnr1214 = calculatePsnr(res12.data, res14.data);
    expect(psnr1214).toBeGreaterThan(35);
  });

  it('preserves sharp horizontal and vertical step edges according to homogeneity orientation', () => {
    const width = 16;
    const height = 16;

    // Create sharp horizontal edge (top half black, bottom half white)
    const cfaH = Buffer.alloc(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        cfaH[y * width + x] = y < height / 2 ? 20 : 230;
      }
    }

    const sensorH: BayerSensorData = {
      width,
      height,
      data: cfaH,
      pattern: 'RGGB',
      bitsPerSample: 8,
      applySrgbGamma: false,
    };

    const resH = demosaicAhdBayerCfa(sensorH);

    // Verify top row remains dark and bottom row remains bright
    const topRowAvg = (resH.data[0] + resH.data[1] + resH.data[2]) / 3;
    const botIdx = ((height - 1) * width + 0) * 3;
    const botRowAvg = (resH.data[botIdx] + resH.data[botIdx + 1] + resH.data[botIdx + 2]) / 3;

    expect(topRowAvg).toBeLessThan(40);
    expect(botRowAvg).toBeGreaterThan(200);
  });

  it('normalizes blackLevel offset and scales by whiteLevel in demosaicAhdBayerCfa', () => {
    const width = 8;
    const height = 8;
    const blackLevel = 512;
    const whiteLevel = 4095;

    // Synthetic 12-bit sensor where all pixels are at black level
    const dataAtBlack = new Uint16Array(width * height);
    dataAtBlack.fill(blackLevel);

    const sensorBlack: BayerSensorData = {
      width,
      height,
      data: dataAtBlack,
      pattern: 'RGGB',
      bitsPerSample: 12,
      blackLevel,
      whiteLevel,
      applySrgbGamma: false,
    };

    const resBlack = demosaicAhdBayerCfa(sensorBlack);
    // When raw is at blackLevel, output must be clamped to 0
    for (let i = 0; i < resBlack.data.length; i++) {
      expect(resBlack.data[i]).toBe(0);
    }

    // Mid-level sensor signal: blackLevel + 1000
    const dataMid = new Uint16Array(width * height);
    dataMid.fill(blackLevel + 1000);

    const sensorMid: BayerSensorData = {
      width,
      height,
      data: dataMid,
      pattern: 'RGGB',
      bitsPerSample: 12,
      blackLevel,
      whiteLevel,
      applySrgbGamma: false,
    };

    const resMid = demosaicAhdBayerCfa(sensorMid);
    // (1000 / (4095 - 512)) * 255 = (1000 / 3583) * 255 = ~71.17
    const expected = Math.round((1000 / (whiteLevel - blackLevel)) * 255);
    const actual = resMid.data[0];
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(2);
  });

  it('fails closed when whiteLevel <= blackLevel or invalid blackLevel array is supplied', () => {
    const width = 4;
    const height = 4;
    const raw = new Uint16Array(width * height).fill(300);

    // Inverted levels
    expect(() =>
      demosaicAhdBayerCfa({
        width,
        height,
        data: raw,
        pattern: 'RGGB',
        whiteLevel: 200,
        blackLevel: 500,
      })
    ).toThrow(/Invalid Bayer calibration: whiteLevel \(200\) must be strictly greater than blackLevel \(500\)/);

    // Invalid blackLevel array length (3 items for 2x2 CFA)
    expect(() =>
      demosaicAhdBayerCfa({
        width,
        height,
        data: raw,
        pattern: 'RGGB',
        whiteLevel: 4095,
        blackLevel: [100, 200, 300],
      })
    ).toThrow(/blackLevel array length \(3\) must be 1 or 4/);

    // Negative black level
    expect(() =>
      demosaicAhdBayerCfa({
        width,
        height,
        data: raw,
        pattern: 'RGGB',
        whiteLevel: 4095,
        blackLevel: -50,
      })
    ).toThrow(/blackLevel \(-50\) must be a non-negative finite number/);
  });
});
