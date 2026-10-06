import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { findBrcmTrailer, parseBrcmHeader, unpackMipiRaw } from '../../src/lib/conversions/raw-brcm';
import type { BayerSensorData } from '../../src/lib/conversions/image';
import type { DemosaicName } from './inputs';

export const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'raw');
export const GOLDEN_PATH = path.join(FIXTURE_DIR, 'demosaic-golden.json');
export const IMX477_SAMPLE_PATH = path.join(FIXTURE_DIR, '.cache', 'raw-imx477.raw');

export interface GoldenEntry {
  id: string;
  method: DemosaicName;
  width: number;
  height: number;
  /** SHA-256 of the little-endian bytes of floatData. */
  floatSha256: string;
  /** SHA-256 of the 8-bit RGB buffer. */
  rgb8Sha256: string;
  /** The 8-bit RGB buffer, gzip + base64, for the max-abs-error comparison when the digests differ. */
  rgb8GzBase64: string;
}

export const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export function digestOutput(result: { data: Buffer; floatData?: Float32Array; width: number; height: number }, id: string, method: DemosaicName): GoldenEntry {
  if (!result.floatData) throw new Error(`${id}/${method}: demosaic returned no floatData`);
  const floatBytes = new Uint8Array(result.floatData.buffer, result.floatData.byteOffset, result.floatData.byteLength);
  return {
    id,
    method,
    width: result.width,
    height: result.height,
    floatSha256: sha256Of(floatBytes),
    rgb8Sha256: sha256Of(result.data),
    rgb8GzBase64: gzipSync(result.data, { level: 9 }).toString('base64'),
  };
}

export function loadImx477Plane(): { plane: Uint16Array; width: number; bayer: BayerSensorData['pattern'] } | null {
  if (!existsSync(IMX477_SAMPLE_PATH)) return null;
  const buffer = readFileSync(IMX477_SAMPLE_PATH);
  const frame = parseBrcmHeader(buffer, findBrcmTrailer(buffer));
  return { plane: unpackMipiRaw(buffer, frame), width: frame.width, bayer: frame.bayer };
}

