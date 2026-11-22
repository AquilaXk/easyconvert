import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OcrResult } from '../src/lib/conversions/ocr-pdf-combiner';

const helper = vi.hoisted(() => ({ recognize: vi.fn() }));
vi.mock('../src/lib/conversions/ocr-onnx-helper', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/conversions/ocr-onnx-helper')>()),
  recognizePageWithOnnxHelper: helper.recognize,
}));

import { performOcr, recognizePage, recognizeRenderedPdfPages, shutdownOcrWorkerPool } from '../src/lib/conversions/ocr';
import { OnnxOcrFailedError, OnnxOcrUnavailableError } from '../src/lib/conversions/ocr-onnx-helper';
import { calibrationTableFor } from '../src/lib/conversions/ocr-calibration';
import { locateLanguageData } from '../src/lib/conversions/ocr-language-data';
import { OcrEngineUnavailableError } from '../src/lib/types';
import {
  chainEngineFallbacks,
  OCR_DOCUMENT_ONNX_SWITCH_PAGES,
  shouldSwitchDocumentToOnnx,
} from '../src/lib/conversions/ocr-onnx-route';
import { skipUnless, skipWithoutTools } from './helpers/strict-skip';

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
  // A stand-in page with a mark Tesseract reads no text from: a page without ink is not read a second time (imageHasInk).
  const blankPage = await sharp({ create: { width: 64, height: 32, channels: 3, background: '#fff' } }).png().toBuffer();
  page = await sharp(blankPage).composite([{ input: { create: { width: 3, height: 3, channels: 3, background: '#000' } }, left: 30, top: 14 }]).png().toBuffer();
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

const RENDERED_PDF_MISSING =
  skipWithoutTools('pdftoppm', 'pdfinfo') ||
  skipUnless('eng.traineddata (Tesseract English data)', locateLanguageData('eng') !== null);

/** Builds an image-only PDF with `pageCount` copies of `png` at 300 dpi dimensions. */
async function pdfWithPages(png: Buffer, pageCount: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const embedded = await doc.embedPng(png);
  const widthPt = (embedded.width * 72) / 300;
  const heightPt = (embedded.height * 72) / 300;
  for (let i = 0; i < pageCount; i++) {
    const p = doc.addPage([widthPt, heightPt]);
    p.drawImage(embedded, { x: 0, y: 0, width: widthPt, height: heightPt });
  }
  return Buffer.from(await doc.save());
}

/** A 320x180 PNG holding a 3-row, 2-column ruled grid with ink inside a cell so Tesseract reads poor/no words while content is present. */
async function ruledGridPage(): Promise<Buffer> {
  const ruleH = (top: number) => ({ input: { create: { width: 220, height: 3, channels: 3 as const, background: '#000' } }, left: 50, top });
  const ruleV = (left: number) => ({ input: { create: { width: 3, height: 100, channels: 3 as const, background: '#000' } }, left, top: 40 });
  const cellMark = (left: number, top: number) => ({
    input: { create: { width: 16, height: 12, channels: 3 as const, background: '#000' } },
    left,
    top,
  });
  return sharp({ create: { width: 320, height: 180, channels: 3, background: '#fff' } })
    .composite([
      ruleH(40),
      ruleH(90),
      ruleH(137),
      ruleV(50),
      ruleV(160),
      ruleV(267),
      cellMark(70, 58),
      cellMark(180, 108),
    ])
    .png()
    .toBuffer();
}

describe('choosing the ONNX recognizer for the rest of an English document', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await shutdownOcrWorkerPool();
  });

  it('requires four finished contiguous text-bearing pages averaging below 0.6 and skips blank pages', () => {
    expect(OCR_DOCUMENT_ONNX_SWITCH_PAGES).toBe(4);
    expect(shouldSwitchDocumentToOnnx([0.3, 0.3, 0.3])).toBe(false);
    expect(shouldSwitchDocumentToOnnx([0.6, 0.6, 0.6, 0.6])).toBe(false);
    expect(shouldSwitchDocumentToOnnx([0.95, null, 0.96, null, 0.94, 0.95])).toBe(false);
    expect(shouldSwitchDocumentToOnnx([0.92, undefined, 0.4, 0.4, 0.4, 0.4])).toBe(false);

    expect(shouldSwitchDocumentToOnnx([0.52, 0.48, 0.55, 0.50])).toBe(true);
    expect(shouldSwitchDocumentToOnnx([0.92, 0.94, 0.95, 0.94, 0.66, 0.55, 0.61, 0.55])).toBe(true);
    expect(shouldSwitchDocumentToOnnx([0.5, null, 0.55, null, 0.58, 0.5])).toBe(true);
  });

  it('preserves Tesseract score before an ONNX second reading and treats blank pages as null content', async () => {
    helper.recognize.mockResolvedValue(ENGLISH_READING);
    const allowing = { run: async <T,>(task: () => Promise<T>): Promise<T | null> => task() };

    const blank = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#fff' } }).png().toBuffer();
    const blankRead = await recognizePage(blank, 'eng', { detectOrientation: false, rescue: allowing });
    expect(blankRead.enginePath).not.toBe('onnx');
    expect(blankRead.tesseractQuality).toBeNull();

    const grid = await ruledGridPage();
    const gridRescued = await recognizePage(grid, 'eng', { detectOrientation: false, rescue: allowing });
    expect(gridRescued.enginePath).toBe('onnx');
    expect(gridRescued.tesseractQuality).not.toBeNull();
    expect(gridRescued.tesseractQuality).toBeLessThan(0.6);
  });

  it('reads directly with ONNX when preferOnnx is set, and falls back quietly once without a duplicate rescue call', async () => {
    helper.recognize.mockResolvedValue(ENGLISH_READING);
    const grid = await ruledGridPage();
    const direct = await recognizePage(grid, 'eng', { detectOrientation: false, preferOnnx: true });
    expect(direct.enginePath).toBe('onnx');
    expect(direct.tesseractQuality).toBeUndefined();
    expect(direct.onnxDeclined).toBeUndefined();
    expect(helper.recognize).toHaveBeenCalledTimes(1);

    helper.recognize.mockReset();
    helper.recognize.mockRejectedValue(new OnnxOcrUnavailableError('models-missing', 'no models'));
    const declined = await recognizePage(grid, 'eng', { detectOrientation: false, preferOnnx: true });
    expect(declined.enginePath).not.toBe('onnx');
    expect(declined.onnxDeclined).toBe(true);
    expect(declined.result.engineFallback).toBeUndefined();
    expect(declined.tesseractQuality).toBeLessThan(0.6);
    expect(helper.recognize).toHaveBeenCalledTimes(1);
  });

  it.skipIf(RENDERED_PDF_MISSING)(
    'switches pages 5 and 6 to ONNX directly on a low-scoring 6-page PDF and leaves a clean 6-page PDF on Tesseract',
    async () => {
      const cleanPng = fs.readFileSync(path.join(__dirname, 'fixtures/ocr/en_a__clean300.png'));
      const cleanPdf = await pdfWithPages(cleanPng, 6);
      helper.recognize.mockRejectedValue(new Error('clean PDF must not call ONNX'));
      const cleanResults = await recognizeRenderedPdfPages(cleanPdf, undefined, {
        language: 'eng',
        detectOrientation: false,
      });
      expect(cleanResults.size).toBe(6);
      expect(helper.recognize).not.toHaveBeenCalled();
      expect(cleanResults.get(6)?.text).toContain('quarterly report');

      vi.stubEnv('EASYCONVERT_OCR_PAGE_CONCURRENCY', '1');
      const statsSpy = vi.spyOn(sharp.prototype, 'stats');
      helper.recognize.mockReset();
      helper.recognize.mockResolvedValue(ENGLISH_READING);
      const gridPdf = await pdfWithPages(await ruledGridPage(), 6);
      const gridResults = await recognizeRenderedPdfPages(gridPdf, undefined, {
        language: 'eng',
        detectOrientation: false,
      });
      expect(gridResults.size).toBe(6);
      // Opening pages (1..4) use the rescue gate (`imageHasInk` -> sharp.stats); switched pages (5..6) skip Tesseract and `imageHasInk`.
      const statsCalls = statsSpy.mock.calls.length;
      const helperCalls = helper.recognize.mock.calls.length;
      expect(statsCalls).toBeGreaterThanOrEqual(1);
      expect(statsCalls).toBeLessThanOrEqual(4);
      expect(helperCalls - statsCalls).toBe(2);
      expect(gridResults.get(5)?.text).toBe('Quarterly report');
      expect(gridResults.get(6)?.text).toBe('Quarterly report');

      // Once a switched page hits an ONNX helper failure, `canSwitchDocument` turns off and later pages stay on Tesseract.
      statsSpy.mockClear();
      helper.recognize.mockReset();
      helper.recognize.mockImplementation(async () => {
        if (helper.recognize.mock.calls.length > statsSpy.mock.calls.length) {
          throw new OnnxOcrUnavailableError('models-missing', 'no models');
        }
        return ENGLISH_READING;
      });
      const fallbackResults = await recognizeRenderedPdfPages(gridPdf, undefined, {
        language: 'eng',
        detectOrientation: false,
      });
      expect(fallbackResults.size).toBe(6);
      // Only page 5 tries preferOnnx (+1 beyond statsCalls); page 6 drops back to Tesseract + rescue gate (+1 statsCall, +1 helperCall).
      expect(helper.recognize.mock.calls.length - statsSpy.mock.calls.length).toBe(1);
      statsSpy.mockRestore();
    },
    120_000
  );
});
