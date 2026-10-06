import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import { performOcr } from '../src/lib/conversions/ocr';
import { OcrLanguageUnavailableError, OcrEngineUnavailableError } from '../src/lib/types';

describe('OCR Offline Language Enforcement & Zero-Egress', () => {
  let tmpDir: string;
  let origDispatcher: ReturnType<typeof getGlobalDispatcher>;
  let origTessdataPrefix: string | undefined;

  const sampleImage = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-offline-test-'));
    origDispatcher = getGlobalDispatcher();
    origTessdataPrefix = process.env.TESSDATA_PREFIX;

    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(() => {
    setGlobalDispatcher(origDispatcher);
    if (origTessdataPrefix !== undefined) {
      process.env.TESSDATA_PREFIX = origTessdataPrefix;
    } else {
      delete process.env.TESSDATA_PREFIX;
    }

    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('rejects unsupported or unrecognized language codes fail-closed', async () => {
    await expect(
      performOcr(sampleImage, 'klingon')
    ).rejects.toThrow(OcrLanguageUnavailableError);

    await expect(
      performOcr(sampleImage, 'unsupported_lang_123')
    ).rejects.toThrow(/Unsupported or unrecognized OCR language/);
  });

  it('fails closed when traineddata is absent locally without attempting network download', async () => {
    // Force candidate directory to an empty temp dir
    process.env.TESSDATA_PREFIX = tmpDir;

    // Use a language definitely not preinstalled on system
    await expect(
      performOcr(sampleImage, 'de')
    ).rejects.toThrow(OcrLanguageUnavailableError);

    await expect(
      performOcr(sampleImage, 'fr')
    ).rejects.toThrow(/is not available locally/);
  });

  it('verifies zero outbound network requests occur during OCR language rejection', async () => {
    process.env.TESSDATA_PREFIX = tmpDir;

    // With MockAgent disabling all network connect, if Tesseract.js tried to fetch from
    // https://tessdata.projectnaptha.com or any CDN, MockAgent would throw NetConnectNotAllowedError.
    // Instead, our offline gate throws OcrEngineUnavailableError fail-closed.
    let thrownError: unknown;
    try {
      // Traditional Chinese data is not installed on the CI runner or the worker image.
      await performOcr(sampleImage, 'zh_tra');
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(OcrLanguageUnavailableError);
    expect((thrownError as OcrLanguageUnavailableError).name).toBe('OcrLanguageUnavailableError');
    expect((thrownError as Error).message).toBe("OCR language 'zh_tra' (chi_tra.traineddata) is not available locally.");
  });
});
