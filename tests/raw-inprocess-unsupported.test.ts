import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { RawDecodeError } from '../src/lib/types';
import { readPiFrame, readX3fContainer } from './helpers/raw-container-oracle';

const CACHE_DIR = path.join(__dirname, 'fixtures', 'raw', '.cache');
const samplePath = (format: string) => path.join(CACHE_DIR, `${format}.${format}`);
const ENABLED = existsSync(samplePath('x3f')) && existsSync(samplePath('raw'));
const TIMEOUT_MS = 120_000;
const IMAGE_HEADER_FORMAT_OFFSET = 12;
const UNSUPPORTED_FORMAT = 0x25;
const BRCM_OFFSET_NAME = 0x10;
const PI_PREVIEW_SIZE = { width: 720, height: 480 };

function unsupportedX3f(): Buffer {
  const file = Buffer.from(readFileSync(samplePath('x3f')));
  file.writeUInt32LE(UNSUPPORTED_FORMAT, readX3fContainer(file).sensorDataOffset - 28 + IMAGE_HEADER_FORMAT_OFFSET);
  return file;
}

function unknownSensorPi(): Buffer {
  const file = Buffer.from(readFileSync(samplePath('raw')));
  file.write('zz9999', file.indexOf('BRCM', 0, 'latin1') + BRCM_OFFSET_NAME, 'latin1');
  return file;
}

describe.skipIf(!ENABLED)('unsupported in-process RAW variants', () => {
  it.each([
    ['x3f', unsupportedX3f],
    ['raw', unknownSensorPi],
  ])('%s: a typed unrecognized error without the preview opt-in', async (format, make) => {
    const error = await dispatchConversion(make(), format, 'png', {}, `v.${format}`).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RawDecodeError);
    expect((error as RawDecodeError).unrecognized).toBe(true);
  }, TIMEOUT_MS);

  it('x3f: the embedded preview with the opt-in', async () => {
    const result = await dispatchConversion(unsupportedX3f(), 'x3f', 'png', { allowEmbeddedPreview: true }, 'v.x3f');
    const info = readX3fContainer(readFileSync(samplePath('x3f')));
    const meta = await sharp(result.buffer).metadata();
    expect({ width: meta.width, height: meta.height }).toEqual({ width: info.declaredWidth, height: info.declaredHeight });
  }, TIMEOUT_MS);

  it('raw: the embedded preview with the opt-in', async () => {
    const result = await dispatchConversion(unknownSensorPi(), 'raw', 'png', { allowEmbeddedPreview: true }, 'v.raw');
    const meta = await sharp(result.buffer).metadata();
    expect({ width: meta.width, height: meta.height }).toEqual(PI_PREVIEW_SIZE);
    expect(readPiFrame(readFileSync(samplePath('raw'))).declaredWidth).toBeGreaterThan(PI_PREVIEW_SIZE.width);
  }, TIMEOUT_MS);
});
