import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OcrResult } from '../src/lib/conversions/ocr-pdf-combiner';

const helper = vi.hoisted(() => ({ recognize: vi.fn() }));
vi.mock('../src/lib/conversions/ocr-onnx-helper', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/conversions/ocr-onnx-helper')>()),
  recognizePageWithOnnxHelper: helper.recognize,
}));

import { performOcr, recognizePage } from '../src/lib/conversions/ocr';
import { OnnxOcrFailedError, OnnxOcrUnavailableError } from '../src/lib/conversions/ocr-onnx-helper';
import { calibrationTableFor } from '../src/lib/conversions/ocr-calibration';
import { OcrEngineUnavailableError } from '../src/lib/types';
import { chainEngineFallbacks } from '../src/lib/conversions/ocr-onnx-route';

/**
 * Which engine reads a page. The helper is replaced by a stand-in here, so these tests check the routing (the languages, the explicit
 * engine paths, the typed fallback) and not the recognizer; tests/ocr-onnx-real.test.ts reads pages with the real models.
 */

const READING: OcrResult = {
  text: '대한민국',
  confidence: 0.99,
  confidenceCalibrated: false,
  wordCount: 1,
  lines: ['대한민국'],
  lineBlocks: [{ text: '대한민국', bbox: { x: 1, y: 1, width: 30, height: 10 }, words: [{ text: '대한민국', confidence: 0.99, bbox: { x: 1, y: 1, width: 30, height: 10 } }] }],
  imageWidth: 64,
  imageHeight: 32,
  language: 'kor',
};

let page: Buffer;
beforeEach(async () => {
  helper.recognize.mockReset();
  page = await sharp({ create: { width: 64, height: 32, channels: 3, background: '#fff' } }).png().toBuffer();
});

describe('Korean pages are read by the ONNX engine by default', () => {
  it('reads kor and kor+eng with the helper and reports the engine path', async () => {
    helper.recognize.mockResolvedValue(READING);
    for (const language of ['kor', 'kor+eng']) {
      const read = await recognizePage(page, language, { detectOrientation: false });
      expect(read.enginePath).toBe('onnx');
      expect(read.result.text).toBe('대한민국');
      expect(read.result.engineFallback).toBeUndefined();
    }
    expect(helper.recognize.mock.calls[1][1]).toMatchObject({ language: 'kor+eng' });
  });

  it('calibrates the word scores with the table of the ONNX engine', async () => {
    helper.recognize.mockResolvedValue(READING);
    const result = await performOcr(page, 'kor', undefined, false);
    expect(calibrationTableFor('kor', 'onnx')).not.toBeNull();
    expect(result.confidenceCalibrated).toBe(true);
  });

  it('passes the job signal and the page turn to the helper', async () => {
    helper.recognize.mockResolvedValue(READING);
    const controller = new AbortController();
    await recognizePage(page, 'kor', { detectOrientation: false, signal: controller.signal });
    expect(helper.recognize.mock.calls[0][1]).toMatchObject({ quarterTurn: 0, signal: controller.signal });
  });
});

const ENGLISH_READING: OcrResult = {
  ...READING,
  text: 'Quarterly report',
  lines: ['Quarterly report'],
  lineBlocks: [
    {
      text: 'Quarterly report',
      bbox: { x: 1, y: 1, width: 60, height: 10 },
      words: [
        { text: 'Quarterly', confidence: 0.99, bbox: { x: 1, y: 1, width: 30, height: 10 } },
        { text: 'report', confidence: 0.99, bbox: { x: 32, y: 1, width: 29, height: 10 } },
      ],
    },
  ],
  language: 'eng',
};

describe('English pages are read by Tesseract and, when it reads them poorly, a second time by the ONNX engine', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const goodPage = (): Buffer => fs.readFileSync(path.join(__dirname, 'fixtures/ocr/en_a__clean300.png'));

  it('reads English with Tesseract alone when the second reading was switched off, or the engine as a whole', async () => {
    helper.recognize.mockRejectedValue(new Error('the helper must not be asked'));
    vi.stubEnv('EASYCONVERT_OCR_ONNX_ENGLISH', 'off');
    await recognizePage(page, 'eng', { detectOrientation: false });
    vi.stubEnv('EASYCONVERT_OCR_ONNX_ENGLISH', 'auto');
    vi.stubEnv('EASYCONVERT_OCR_ONNX', 'off');
    await recognizePage(page, 'eng', { detectOrientation: false });
    expect(helper.recognize).not.toHaveBeenCalled();
  });

  it('goes through the gate of the page: a refused second reading leaves Tesseract\'s reading, an allowed one is the one that is timed', async () => {
    helper.recognize.mockResolvedValue(ENGLISH_READING);
    const refusing = { run: vi.fn(async () => null) };
    const kept = await recognizePage(page, 'eng', { detectOrientation: false, rescue: refusing });
    expect(kept.enginePath).not.toBe('onnx');
    expect(refusing.run).toHaveBeenCalledTimes(1);
    expect(helper.recognize).not.toHaveBeenCalled();
    let allowed = 0;
    const allowing = {
      run: async <T,>(task: () => Promise<T>): Promise<T | null> => {
        allowed++;
        return task();
      },
    };
    const read = await recognizePage(page, 'eng', { detectOrientation: false, rescue: allowing });
    expect(read.enginePath).toBe('onnx');
    expect(allowed).toBe(1);
  });

  it('does not ask the helper for a page that Tesseract read well', async () => {
    helper.recognize.mockRejectedValue(new Error('the helper must not be asked'));
    const read = await recognizePage(goodPage(), 'eng', { detectOrientation: false });
    expect(read.enginePath).not.toBe('onnx');
    expect(helper.recognize).not.toHaveBeenCalled();
  });

  it('keeps the ONNX reading of a page that Tesseract found no text on, and asks the helper for the English recognizer', async () => {
    helper.recognize.mockResolvedValue(ENGLISH_READING);
    const read = await recognizePage(page, 'eng', { detectOrientation: false });
    expect(read.enginePath).toBe('onnx');
    expect(read.result.text).toBe('Quarterly report');
    expect(helper.recognize).toHaveBeenCalledTimes(1);
    expect(helper.recognize.mock.calls[0][1]).toMatchObject({ language: 'eng', recognizer: 'eng' });
  });

  it('calibrates the ONNX reading of an English page with the table of the English recognizer', async () => {
    helper.recognize.mockResolvedValue(ENGLISH_READING);
    const result = await performOcr(page, 'eng', undefined, false);
    expect(calibrationTableFor('eng', 'onnx')).not.toBeNull();
    expect(result.confidenceCalibrated).toBe(true);
  });

  it('is not tried when the Tesseract path was named', async () => {
    helper.recognize.mockRejectedValue(new Error('the helper must not be asked'));
    for (const enginePath of ['wasm', 'cli'] as const) await recognizePage(page, 'eng', { detectOrientation: false, enginePath });
    expect(helper.recognize).not.toHaveBeenCalled();
  });

  it('keeps Tesseract\'s reading, with no fallback recorded, when the engine cannot be used', async () => {
    helper.recognize.mockRejectedValue(new OnnxOcrUnavailableError('models-missing', 'no models'));
    const read = await recognizePage(page, 'eng', { detectOrientation: false });
    expect(read.enginePath).not.toBe('onnx');
    expect(read.result.engineFallback).toBeUndefined();
  });

  it('does not turn an error that is not the engine\'s into a reading by another engine', async () => {
    helper.recognize.mockRejectedValue(new TypeError('a defect'));
    await expect(recognizePage(page, 'eng', { detectOrientation: false })).rejects.toThrow('a defect');
  });
});

describe('what is not read by the ONNX engine', () => {
  it.each(['wasm', 'cli', 'neural'] as const)('leaves a Korean page to Tesseract when the path is %s', async (enginePath) => {
    helper.recognize.mockRejectedValue(new Error('the helper must not be asked'));
    // The page holds no text; the reading is Tesseract's, whatever it finds, or its own refusal when its Korean data is not installed.
    await recognizePage(page, 'kor', { detectOrientation: false, enginePath }).catch(() => undefined);
    expect(helper.recognize).not.toHaveBeenCalled();
  });

  it('leaves a request that names another language beside Korean to Tesseract', async () => {
    helper.recognize.mockRejectedValue(new Error('the helper must not be asked'));
    await recognizePage(page, 'kor+jpn', { detectOrientation: false }).catch(() => undefined);
    expect(helper.recognize).not.toHaveBeenCalled();
  });
});

describe('when the ONNX engine cannot read the page', () => {
  it('refuses, without another engine, when `onnx` was demanded', async () => {
    helper.recognize.mockRejectedValue(new OnnxOcrUnavailableError('models-missing', 'no models'));
    const refused = recognizePage(page, 'kor', { detectOrientation: false, enginePath: 'onnx' });
    await expect(refused).rejects.toMatchObject({ name: 'OnnxOcrUnavailableError', reason: 'models-missing' });
    await expect(refused).rejects.toBeInstanceOf(OcrEngineUnavailableError);
  });

  it('does not turn an error that is not the engine\'s into a reading by another engine', async () => {
    helper.recognize.mockRejectedValue(new TypeError('a defect'));
    await expect(recognizePage(page, 'kor', { detectOrientation: false })).rejects.toThrow('a defect');
  });

  it('does not read again by another engine after the job was aborted', async () => {
    const controller = new AbortController();
    helper.recognize.mockImplementation(async () => {
      controller.abort(new Error('cancelled'));
      throw new OnnxOcrFailedError('helper-lost', 'killed');
    });
    await expect(recognizePage(page, 'kor', { detectOrientation: false, signal: controller.signal })).rejects.toBeInstanceOf(OnnxOcrFailedError);
    expect(helper.recognize).toHaveBeenCalledTimes(1);
  });
});

describe('the fallbacks a result reports', () => {
  const onnx = { from: 'onnx', to: 'wasm', reason: 'onnx-models-missing' } as const;
  const wasm = { from: 'wasm', to: 'cli', reason: 'wasm-runtime-trap' } as const;

  it('keeps the WebAssembly to native fallback and the ONNX one under it', () => {
    expect(chainEngineFallbacks(onnx, wasm)).toEqual({ ...wasm, previous: onnx });
  });

  it('reports the one that happened when only one did, and nothing when none did', () => {
    expect(chainEngineFallbacks(onnx, undefined)).toEqual(onnx);
    expect(chainEngineFallbacks(undefined, wasm)).toEqual(wasm);
    expect(chainEngineFallbacks(undefined, undefined)).toBeUndefined();
  });
});
