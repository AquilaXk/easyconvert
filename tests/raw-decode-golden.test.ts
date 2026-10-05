import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { decodeBrcmRaw } from '../src/lib/conversions/raw-brcm';
import {
  decodeHuffmanLayers,
  decodeQuattroLayers,
  decodeTrueLayers,
  readX3fDirectory,
  readX3fImageSections,
  decodeX3f,
  type LayerPlane,
} from '../src/lib/conversions/raw-x3f';

/**
 * Golden SHA-256 values of the in-process decoders' output on the real samples. The region comparison
 * with the camera preview (raw-x3f-pi-decode.test.ts) averages 6x6 cells, so a half-pixel shift in the
 * Quattro upsampling or a small bias in one layer would not move it; these hashes pin every sample.
 * They were recorded from the decoders before the memory refactor of the X3F output stage, so the
 * refactor is proven to leave each decoded sample unchanged. Layer hashes are of the planes as stored
 * (the Quattro lower layers at half resolution). Hashes cover the little-endian bytes.
 */
const STRICT_MODE = process.env.ORACLE_STRICT_MODE === '1';
const CACHE_DIR = path.join(__dirname, 'fixtures', 'raw', '.cache');
const DECODE_TIMEOUT_MS = 120_000;
/** Sensor data section types: 3 (DP1/DP2/SD14 generation) and 1 (Merrill/Quattro generation). */
const SENSOR_IMAGE_TYPES = new Set([1, 3]);
const IMAGE_FORMAT_HUFFMAN = 0x06;
const IMAGE_FORMAT_QUATTRO = 0x23;

interface Golden {
  width: number;
  height: number;
  rgb16Sha256: string;
  layerSha256?: string[];
}

const GOLDEN: Record<string, Golden> = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'raw', 'decode-golden.json'), 'utf8'));

const formatOf = (name: string) => name.split('-')[0];
const samplePath = (name: string) => path.join(CACHE_DIR, `${name}.${formatOf(name)}`);
const sha256 = (view: ArrayBufferView) => createHash('sha256').update(Buffer.from(view.buffer, view.byteOffset, view.byteLength)).digest('hex');
const missing = (name: string) => !STRICT_MODE && !existsSync(samplePath(name));

function decodeSensorLayers(file: Buffer): LayerPlane[] {
  const sensor = readX3fImageSections(file, readX3fDirectory(file)).find((image) => SENSOR_IMAGE_TYPES.has(image.imageType));
  if (!sensor) throw new Error('the sample holds no sensor section');
  if (sensor.format === IMAGE_FORMAT_HUFFMAN) return decodeHuffmanLayers(file, sensor).planes;
  if (sensor.format === IMAGE_FORMAT_QUATTRO) return decodeQuattroLayers(file, sensor).planes;
  return decodeTrueLayers(file, sensor, sensor.columns * sensor.rows).planes;
}

describe('in-process RAW decode golden hashes', () => {
  for (const [name, golden] of Object.entries(GOLDEN)) {
    it.skipIf(missing(name))(`${name} decodes to the recorded 16-bit sRGB samples`, () => {
      const file = readFileSync(samplePath(name));
      const decoded = formatOf(name) === 'x3f' ? decodeX3f(file) : decodeBrcmRaw(file);
      expect([decoded.width, decoded.height]).toEqual([golden.width, golden.height]);
      expect(sha256(decoded.rgb16)).toBe(golden.rgb16Sha256);
    }, DECODE_TIMEOUT_MS);

    const layerHashes = golden.layerSha256;
    if (layerHashes) {
      it.skipIf(missing(name))(`${name} decodes to the recorded sensor layer planes`, () => {
        const planes = decodeSensorLayers(readFileSync(samplePath(name)));
        expect(planes.map(sha256)).toEqual(layerHashes);
      }, DECODE_TIMEOUT_MS);
    }
  }
});
