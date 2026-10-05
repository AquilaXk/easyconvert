import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { RawDecodeError } from '../src/lib/types';
import { decodeCamfBytes, readX3fDirectory } from '../src/lib/conversions/raw-x3f';

const SAMPLE = path.join(__dirname, 'fixtures', 'raw', '.cache', 'x3f.x3f');
const ENABLED = existsSync(SAMPLE);
const TIMEOUT_MS = 120_000;
const CAMF_HEADER_BYTES = 28;
const CAMF_TYPE_XOR = 2;
const XOR_KEY = 1234;

/** Independent XOR keystream of the type-2 CAMF encoding (symmetric: encoding equals decoding). */
function xorStream(data: Buffer, seed: number): Buffer {
  const out = Buffer.alloc(data.length);
  let key = seed;
  for (let i = 0; i < data.length; i += 1) {
    key = (key * 1597 + 51749) % 244944;
    const scaled = Math.floor((key * 301593171) / 2 ** 24);
    out[i] = data[i] ^ (((((key << 8) - scaled) >> 1) + scaled) >>> 17 & 0xff);
  }
  return out;
}

/** Rewrites the sample's CAMF as a type-2 block in which the named float matrix holds `value`. */
function withCalibrationValue(name: string, value: number): Buffer {
  const file = Buffer.from(readFileSync(SAMPLE));
  const camfIndex = readX3fDirectory(file).findIndex((section) => section.type === 'CAMF');
  const section = readX3fDirectory(file)[camfIndex];
  const decoded = Buffer.from(decodeCamfBytes(file, section));
  let at = 0;
  while (at < decoded.length) {
    const size = decoded.readUInt32LE(at + 8);
    const nameAt = at + decoded.readUInt32LE(at + 12);
    if (decoded.toString('latin1', nameAt, nameAt + name.length + 1) === `${name}\0`) {
      const valueAt = at + decoded.readUInt32LE(at + 16);
      decoded.writeFloatLE(value, at + decoded.readUInt32LE(valueAt + 8));
      break;
    }
    at += size;
  }
  expect(at).toBeLessThan(decoded.length);
  const encoded = xorStream(decoded, XOR_KEY);
  encoded.copy(file, section.offset + CAMF_HEADER_BYTES);
  file.writeUInt32LE(CAMF_TYPE_XOR, section.offset + 8);
  file.writeUInt32LE(XOR_KEY, section.offset + 24);
  const directory = file.readUInt32LE(file.length - 4);
  file.writeUInt32LE(CAMF_HEADER_BYTES + encoded.length, directory + 12 + camfIndex * 12 + 4);
  return file;
}

describe.skipIf(!ENABLED)('X3F calibration values are range-checked', () => {
  it('decodes the sample re-encoded as a type-2 CAMF with its original ISO', async () => {
    const result = await dispatchConversion(withCalibrationValue('CaptureISO', 400), 'x3f', 'png', {}, 's.x3f');
    expect(result.buffer.subarray(1, 4).toString('latin1')).toBe('PNG');
  }, TIMEOUT_MS);

  it.each([Infinity, 3e38, 1e-40, -400, NaN])('rejects a CaptureISO of %s', async (iso) => {
    const error = await dispatchConversion(withCalibrationValue('CaptureISO', iso), 'x3f', 'png', {}, 's.x3f').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RawDecodeError);
    expect((error as RawDecodeError).message).toMatch(/ISO/);
  }, TIMEOUT_MS);

  it('rejects a SensorISO of 1e-40', async () => {
    const error = await dispatchConversion(withCalibrationValue('SensorISO', 1e-40), 'x3f', 'png', {}, 's.x3f').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RawDecodeError);
    expect((error as RawDecodeError).message).toMatch(/ISO/);
  }, TIMEOUT_MS);
});
