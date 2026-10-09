import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { readPiFrame, readX3fContainer, type RegionComparison } from './raw-container-oracle';

/**
 * The RAW sample set and the tolerances shared by the files that decode it (raw-x3f-pi-decode*.test.ts). The samples
 * are fetched by `npm run fixtures:raw`.
 */
export const STRICT_MODE = process.env.ORACLE_STRICT_MODE === '1';
export const CACHE_DIR = path.join(__dirname, '..', 'fixtures', 'raw', '.cache');

/**
 * Every sample the decoders are checked against: the primary sample of each format (`manifest.json`) and
 * the sensor-data variants (`variants.json`). The compression of each is what the section headers declare:
 *  - x3f: TRUE (type 3, format 0x1e), one Huffman table, three full-resolution planes
 *  - x3f-sd14: Huffman (type 3, format 0x06), 1024-entry difference and code tables, interleaved layers
 *  - x3f-merrill: TRUE per-layer planes (type 1, format 0x1e)
 *  - x3f-quattro: TRUE planes (type 1, format 0x23), full-resolution top layer, quarter-resolution lower layers
 *  - raw: Raspberry Pi ov5647, MIPI RAW10; raw-imx219: RAW10; raw-imx477: MIPI RAW12
 */
export const SAMPLES = ['x3f', 'x3f-sd14', 'x3f-merrill', 'x3f-quattro', 'raw', 'raw-imx219', 'raw-imx477'] as const;
export type SampleName = (typeof SAMPLES)[number];
export const formatOf = (name: string) => name.split('-')[0];
export const samplePath = (name: string) => path.join(CACHE_DIR, `${name}.${formatOf(name)}`);
export const SAMPLES_PRESENT = SAMPLES.every((name) => existsSync(samplePath(name)));
export const ENABLED = STRICT_MODE || SAMPLES_PRESENT;

export const DECODE_TIMEOUT_MS = 180_000;
export const TARGETS = ['png', 'jpg'];

export interface Tolerance {
  lumaRatioError: number;
  chromaRelativeError: number;
  chromaAbsoluteError: number;
  /** Lower bound of the rank correlation of the cell lumas. */
  lumaRankCorrelation: number;
}

/**
 * Tolerances of the comparison with the camera's own preview, on a 6x6 grid of region means. The
 * preview is the firmware's rendering (its own tone curve, white balance and shading correction), so
 * the check is of structure and colour relationships, not of identical pixels.
 *  - luma: per-cell luma over the image's mean luma, so exposure differences cancel; the firmware's
 *    contrast curve moves the darkest and brightest cells (Merrill: bright lamp and black background);
 *  - chroma (relative): red and blue shares of the cell's total after removing each image's mean cast;
 *  - chroma (absolute): the same without removing the cast, only meant to catch swapped channels;
 *  - rank: Spearman correlation of the 36 cell lumas, which any monotonic tone curve preserves.
 * Observed on the real samples through the dispatcher (luma / relative / absolute / rank), measured after
 * the 16-bit encode stopped shifting colours through a wide-gamut working profile:
 *   x3f 0.049 / 0.008 / 0.007 / 0.999      x3f-sd14 0.124 / 0.016 / 0.024 / 0.998
 *   x3f-merrill 0.496 / 0.039 / 0.039 / 0.996   x3f-quattro 0.203 / 0.037 / 0.038 / 0.985
 *   raw 0.165 / 0.012 / 0.056 / 0.804      raw-imx219 0.183 / 0.031 / 0.067 / 0.798
 *   raw-imx477 0.154 / 0.071 / 0.103 / 0.988
 * The Raspberry Pi frames carry no sensor colour characterisation (grey-world white balance and a generic
 * matrix), which is why their chroma limits are looser than the X3F ones.
 */
export const TOLERANCE: Readonly<Record<SampleName, Tolerance>> = {
  x3f: { lumaRatioError: 0.1, chromaRelativeError: 0.02, chromaAbsoluteError: 0.02, lumaRankCorrelation: 0.99 },
  'x3f-sd14': { lumaRatioError: 0.17, chromaRelativeError: 0.025, chromaAbsoluteError: 0.035, lumaRankCorrelation: 0.98 },
  'x3f-merrill': { lumaRatioError: 0.6, chromaRelativeError: 0.05, chromaAbsoluteError: 0.055, lumaRankCorrelation: 0.98 },
  'x3f-quattro': { lumaRatioError: 0.26, chromaRelativeError: 0.045, chromaAbsoluteError: 0.05, lumaRankCorrelation: 0.96 },
  raw: { lumaRatioError: 0.25, chromaRelativeError: 0.03, chromaAbsoluteError: 0.1, lumaRankCorrelation: 0.7 },
  'raw-imx219': { lumaRatioError: 0.25, chromaRelativeError: 0.04, chromaAbsoluteError: 0.08, lumaRankCorrelation: 0.7 },
  'raw-imx477': { lumaRatioError: 0.18, chromaRelativeError: 0.09, chromaAbsoluteError: 0.12, lumaRankCorrelation: 0.96 },
};

/** Names of the metrics of `result` outside `limit` (the rank correlation is a lower bound). */
export function exceeded(result: RegionComparison, limit: Tolerance): string[] {
  const names = (Object.keys(limit) as (keyof Tolerance)[]).filter((metric) =>
    metric === 'lumaRankCorrelation' ? result[metric] < limit[metric] : result[metric] > limit[metric]
  );
  return names;
}

export function load(name: string): Buffer {
  return readFileSync(samplePath(name));
}

export const containerOf = (name: string, file: Buffer) => (formatOf(name) === 'x3f' ? readX3fContainer(file) : readPiFrame(file));
