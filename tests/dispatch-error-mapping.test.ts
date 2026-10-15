import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { ConversionFailedError, EngineUnavailableError, UnsupportedOptionError } from '../src/lib/types';
import { withMissingBinary } from './helpers/native-tools';
import { skipWithoutTools } from './helpers/strict-skip';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const ENGINE_UNAVAILABLE_TYPE = 'https://api.easyconvert.io/problems/engine-unavailable';
const HTTP_SERVICE_UNAVAILABLE = 503;
const HTTP_BAD_REQUEST = 400;
const CONVERT_TIMEOUT_MS = 120_000;
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const PDF_SIGNATURE = '%PDF-';
const ARABIC_TEXT = Buffer.from('مرحبا بالعالم', 'utf-8');

const SAMPLE_DOCX = readFileSync(path.resolve(__dirname, 'fixtures', 'sample.docx'));
const NOISE_SIZE = 64;
const TRUNCATED_PNG_FRACTION = 0.5;

/** A PNG whose header reads fine but whose pixel data is cut off, so decoding it fails. */
async function buildTruncatedPng(): Promise<Buffer> {
  const noise = Buffer.alloc(NOISE_SIZE * NOISE_SIZE * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 7919) % 251;
  const png = await sharp(noise, { raw: { width: NOISE_SIZE, height: NOISE_SIZE, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  return png.subarray(0, Math.floor(png.length * TRUNCATED_PNG_FRACTION));
}
/** Valid zip local-file signature followed by bytes LibreOffice cannot open as a document. */
const BROKEN_DOCX = Buffer.concat([ZIP_SIGNATURE, Buffer.alloc(64, 0x41)]);

describe('engine-missing conditions surface as EngineUnavailableError', () => {
  it('maps a missing LibreOffice for a requested PDF standard', async () => {
    const run = withMissingBinary('SOFFICE_PATH', () =>
      dispatchConversion(SAMPLE_DOCX, 'docx', 'pdf', { pdfStandard: 'pdfa-1b' }, 'sample.docx')
    );
    await expect(run).rejects.toBeInstanceOf(EngineUnavailableError);
    await expect(run).rejects.toMatchObject({ engineName: 'soffice' });
  });

  it('shapes complex-script text in-process when LibreOffice is missing instead of failing', async () => {
    const result = await withMissingBinary('SOFFICE_PATH', () => dispatchConversion(ARABIC_TEXT, 'txt', 'pdf', {}, 'in.txt'));
    expect(result.engineUsed).toBe('internal-fallback');
    expect(result.buffer.subarray(0, PDF_SIGNATURE.length).toString('latin1')).toBe(PDF_SIGNATURE);
  });

  it('keeps an undecodable OCR image a client error, not a missing engine', async () => {
    const run = dispatchConversion(await buildTruncatedPng(), 'png', 'pdf', { ocrEnabled: true }, 'scan.png');
    await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(run).rejects.not.toBeInstanceOf(EngineUnavailableError);
    await expect(run).rejects.toThrow(/could not be decoded/);
  });
});

describe('a PDF standard on a source no native engine renders', () => {
  it('is rejected as an unsupported option instead of an untyped error', async () => {
    const run = dispatchConversion(Buffer.from('plain text'), 'txt', 'pdf', { pdfStandard: 'pdfa-1b' }, 'in.txt');
    await expect(run).rejects.toBeInstanceOf(UnsupportedOptionError);
    await expect(run).rejects.toThrow(/Fallback to pure TypeScript engine is forbidden when pdfStandard \('pdfa-1b'\)/);
  });
});

describe('POST /api/v1/convert error responses', () => {
  let secretKey: string;

  beforeEach(async () => {
    const user = await userStore.createUser({
      name: 'Error Mapping Tester',
      email: `errmap_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
      tier: 'pro',
    });
    const key = await redisKeyStore.generateApiKey(user.id, 'Error Mapping Key', { scopes: ['convert:write', 'convert:read'] });
    secretKey = key.secretKey;
  });

  function convertRequest(file: Buffer, fileName: string, targetFormat: string, options?: object): NextRequest {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file)]), fileName);
    form.append('targetFormat', targetFormat);
    if (options) form.append('options', JSON.stringify(options));
    return new NextRequest('http://localhost/api/v1/convert', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secretKey}` },
      body: form,
    });
  }

  it('answers 503 engine-unavailable when the PDF standard needs a missing LibreOffice', async () => {
    const res = await withMissingBinary('SOFFICE_PATH', () =>
      v1ConvertPost(convertRequest(SAMPLE_DOCX, 'sample.docx', 'pdf', { pdfStandard: 'pdfa-1b' }))
    );
    expect(res.status).toBe(HTTP_SERVICE_UNAVAILABLE);
    const problem = await res.json();
    expect(problem.type).toBe(ENGINE_UNAVAILABLE_TYPE);
    expect(JSON.stringify(problem)).not.toContain('/tmp/');
  });

  it.skipIf(skipWithoutTools('soffice'))(
    'answers a document LibreOffice cannot open with a 400 that names the file, not a 500, and echoes no sandbox path (needs soffice)',
    async () => {
      const res = await v1ConvertPost(convertRequest(BROKEN_DOCX, 'broken.docx', 'png'));
      expect(res.status).toBe(HTTP_BAD_REQUEST);
      const problem = await res.json();
      expect(problem.detail).toContain('LibreOffice could not read the .docx file');
      expect(JSON.stringify(problem)).not.toContain('/tmp');
    },
    CONVERT_TIMEOUT_MS
  );
});
