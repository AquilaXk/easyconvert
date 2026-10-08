import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { convertFile } from '../src/lib/conversions/index';
import { performOcr, readEngineMarkup } from '../src/lib/conversions/ocr';
import {
  describeEngineError,
  OCR_RECOVERABLE_WASM_FAILURES,
  OCR_WASM_OUT_OF_MEMORY,
  OCR_WASM_RUNTIME_TRAP,
  OCR_WASM_WORKER_LOST,
  recoverableWasmFailure,
} from '../src/lib/conversions/ocr-engine-failure';
import { OcrEngineUnavailableError } from '../src/lib/types';
import { characterErrorRatePercent } from './helpers/ocr-cer';
import { fixtureImage, fixturePath, groundTruth, requireTessdata } from './helpers/ocr-fixtures';
import { oracleTest } from './helpers/oracle-test';

/**
 * A failure of the WebAssembly engine is never silent. Only the documented recoverable classes are answered by the
 * native tool, and the answer is recorded on the result (`engineFallback`); any other failure is a 503. The pool is
 * made to fail so that the engine path is the one under test; the text is scored against the text drawn into the
 * fixture, and the engine's own markup against the words the fixture page holds.
 */

const poolRun = vi.hoisted(() => vi.fn());

vi.mock('../src/lib/conversions/ocr-worker-pool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/conversions/ocr-worker-pool')>();
  return { ...actual, getSharedOcrWorkerPool: () => ({ run: poolRun }) };
});

const PAGE_TIMEOUT_MS = 120_000;
const MAX_CER_PERCENT = 1;

beforeEach(() => {
  poolRun.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('which WebAssembly failures the native tool takes over', () => {
  it('names three recoverable classes and recognizes each by what the runtime reports', () => {
    expect([...OCR_RECOVERABLE_WASM_FAILURES].sort()).toEqual([OCR_WASM_OUT_OF_MEMORY, OCR_WASM_RUNTIME_TRAP, OCR_WASM_WORKER_LOST].sort());
    expect(recoverableWasmFailure(new WebAssembly.RuntimeError('unreachable'))).toBe(OCR_WASM_RUNTIME_TRAP);
    expect(recoverableWasmFailure(new Error('memory access out of bounds'))).toBe(OCR_WASM_RUNTIME_TRAP);
    expect(recoverableWasmFailure(new Error('Aborted(OOM). Build with -sASSERTIONS'))).toBe(OCR_WASM_RUNTIME_TRAP);
    expect(recoverableWasmFailure(new RangeError('WebAssembly.Memory(): could not allocate memory'))).toBe(OCR_WASM_OUT_OF_MEMORY);
    expect(recoverableWasmFailure(new Error('Cannot enlarge memory arrays'))).toBe(OCR_WASM_OUT_OF_MEMORY);
    expect(recoverableWasmFailure(new Error('Worker was terminated'))).toBe(OCR_WASM_WORKER_LOST);
  });

  it('does not take over a failure of anything else', () => {
    for (const err of [new Error('boom'), new TypeError('x is not a function'), 'Error attempting to read image.', undefined, 42]) {
      expect(recoverableWasmFailure(err), String(err)).toBeNull();
    }
  });

  it('reports an engine error as one bounded line of printable text', () => {
    expect(describeEngineError(new Error(`line one\n\tline\u0000two ${'x'.repeat(500)}`)).length).toBeLessThanOrEqual(200);
    expect(describeEngineError(new Error('a\nb'))).toBe('a b');
    expect(describeEngineError(undefined)).toBe('unknown error');
  });
});

describe('the engine path of a page', () => {
  oracleTest(
    'a WebAssembly runtime trap is read by the native tool and the fallback is recorded on the result',
    ['tesseract'],
    async () => {
      requireTessdata('eng');
      poolRun.mockRejectedValue(new WebAssembly.RuntimeError('unreachable'));
      const result = await performOcr(fixtureImage('en_a', 'clean300'), 'eng');
      expect(result.engineFallback).toEqual({ from: 'wasm', to: 'cli', reason: OCR_WASM_RUNTIME_TRAP });
      expect(characterErrorRatePercent(groundTruth('en_a'), result.text)).toBeLessThanOrEqual(MAX_CER_PERCENT);
    },
    PAGE_TIMEOUT_MS
  );

  oracleTest(
    'any other failure of the WebAssembly engine is a 503 that says what failed, and no second engine reads the page',
    ['tesseract'],
    async () => {
      requireTessdata('eng');
      poolRun.mockRejectedValue(new TypeError('worker.recognize is not a function'));
      let thrown: unknown;
      try {
        await performOcr(fixtureImage('en_a', 'clean300'), 'eng');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(OcrEngineUnavailableError);
      expect((thrown as Error).message).toContain('worker.recognize is not a function');
    },
    PAGE_TIMEOUT_MS
  );

  oracleTest(
    'a typed engine error from the pool passes through as it is',
    ['tesseract'],
    async () => {
      requireTessdata('eng');
      const saturated = new OcrEngineUnavailableError('OCR is saturated: 64 jobs are already waiting.');
      poolRun.mockRejectedValue(saturated);
      await expect(performOcr(fixtureImage('en_a', 'clean300'), 'eng')).rejects.toBe(saturated);
    },
    PAGE_TIMEOUT_MS
  );

  oracleTest(
    'a recoverable failure with no native tool to take over is a 503, not an empty page',
    ['tesseract'],
    async () => {
      requireTessdata('eng');
      poolRun.mockRejectedValue(new WebAssembly.RuntimeError('unreachable'));
      const exists = fs.existsSync.bind(fs);
      vi.spyOn(fs, 'existsSync').mockImplementation((candidate) => (/\/tesseract$/.test(String(candidate)) ? false : exists(candidate)));
      await expect(performOcr(fixtureImage('en_a', 'clean300'), 'eng')).rejects.toBeInstanceOf(OcrEngineUnavailableError);
    },
    PAGE_TIMEOUT_MS
  );
});

/** A one-page PDF holding a scan as its only content. */
async function scannedPdf(page: string): Promise<Buffer> {
  const png = fs.readFileSync(fixturePath(page, 'clean300'));
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(png);
  const pdfPage = doc.addPage([image.width / 4.1667, image.height / 4.1667]);
  pdfPage.drawImage(image, { x: 0, y: 0, width: pdfPage.getWidth(), height: pdfPage.getHeight() });
  return Buffer.from(await doc.save());
}

describe('the result metadata of a PDF read', () => {
  oracleTest(
    'records the pages the native tool read after a WebAssembly failure',
    ['tesseract', 'pdftoppm'],
    async () => {
      requireTessdata('eng');
      poolRun.mockRejectedValue(new WebAssembly.RuntimeError('memory access out of bounds'));
      const result = await convertFile(await scannedPdf('en_a'), 'pdf', 'txt', { ocrEnabled: true, ocrLanguage: 'eng' }, 'scan.pdf');
      expect(result.metadata?.engineFallback).toEqual([{ pageNumber: 1, from: 'wasm', to: 'cli', reason: OCR_WASM_RUNTIME_TRAP }]);
      expect(characterErrorRatePercent(groundTruth('en_a'), result.ocrExtractedText ?? '')).toBeLessThanOrEqual(MAX_CER_PERCENT);
    },
    PAGE_TIMEOUT_MS
  );

  oracleTest(
    'ocrEngineMarkup returns the engine own hOCR next to the product hOCR, on the same page size',
    ['tesseract', 'pdftoppm'],
    async () => {
      requireTessdata('eng');
      poolRun.mockImplementation(() => Promise.reject(new WebAssembly.RuntimeError('unreachable')));
      const result = await convertFile(await scannedPdf('en_a'), 'pdf', 'hocr', { ocrEnabled: true, ocrLanguage: 'eng', ocrEngineMarkup: 'hocr' }, 'scan.pdf');
      const markup = result.metadata?.ocrEngineMarkup as Array<{ pageNumber: number; format: string; content: string }>;
      expect(markup).toHaveLength(1);
      expect(markup[0]).toMatchObject({ pageNumber: 1, format: 'hocr' });
      const engineWords = [...markup[0].content.matchAll(/<span class='ocrx_word'[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]).join(' ');
      expect(characterErrorRatePercent(groundTruth('en_a'), engineWords)).toBeLessThanOrEqual(MAX_CER_PERCENT);
      const pageBox = (text: string): string | undefined => /class=['"]ocr_page['"][^>]*bbox (\d+ \d+ \d+ \d+)/.exec(text)?.[1];
      expect(pageBox(markup[0].content)).toBeDefined();
      expect(pageBox(result.buffer.toString('utf-8'))).toBe(pageBox(markup[0].content));
    },
    PAGE_TIMEOUT_MS
  );

  oracleTest(
    'readEngineMarkup writes ALTO as the engine does, in the pixels of the page as submitted',
    ['tesseract'],
    async () => {
      requireTessdata('eng');
      const alto = await readEngineMarkup(fixtureImage('en_a', 'clean300'), 'eng', 'alto');
      expect(alto.format).toBe('alto');
      expect(alto.content).toContain('<alto ');
      expect(alto.content).toMatch(/<String [^>]*CONTENT="The"/);
      const words = [...alto.content.matchAll(/<String [^>]*CONTENT="([^"]*)"/g)].map((m) => m[1]).join(' ');
      expect(characterErrorRatePercent(groundTruth('en_a'), words)).toBeLessThanOrEqual(MAX_CER_PERCENT);
    },
    PAGE_TIMEOUT_MS
  );
});
