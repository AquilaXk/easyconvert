import { beforeEach, describe, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { performOcr } from '../src/lib/conversions/ocr';
import { ConversionFailedError, OcrEngineUnavailableError, OcrPreprocessError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { OracleToolMissingError } from './helpers/differential-oracle';

/**
 * `performOcr` reports what went wrong with the page: a saturated preparation queue is a 503
 * (OcrEngineUnavailableError), an image preparation refuses is OcrPreprocessError, and only an
 * undecodable image is "Invalid image". The preparation itself is replaced by a function that
 * fails, since saturating the real one takes dozens of pages.
 */
const prepare = vi.hoisted(() => vi.fn());

vi.mock('../src/lib/conversions/ocr-preprocess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/conversions/ocr-preprocess')>();
  return { ...actual, preprocessOcrImage: prepare };
});

const TESSDATA_DIRS = [
  ...(process.env.TESSDATA_PREFIX ? [process.env.TESSDATA_PREFIX] : []),
  process.cwd(),
  '/usr/share/tesseract-ocr/5/tessdata',
  '/usr/share/tesseract-ocr/4.00/tessdata',
  '/usr/share/tessdata',
];

function requireEnglishData(): void {
  const found = TESSDATA_DIRS.some(
    (dir) =>
      fs.existsSync(path.join(dir, 'eng.traineddata')) || fs.existsSync(path.join(dir, 'eng.traineddata.gz'))
  );
  if (!found) throw new OracleToolMissingError('eng.traineddata', 'eng.traineddata is not installed');
}

const PAGE = Buffer.from('not decoded, preparation is replaced');

describe('errors from page preparation', () => {
  beforeEach(() => {
    prepare.mockReset();
  });

  oracleTest('keep a saturated queue as OcrEngineUnavailableError', ['tesseract'], async () => {
    requireEnglishData();
    const saturated = new OcrEngineUnavailableError('OCR is saturated: 64 page preparations are already waiting.');
    prepare.mockRejectedValue(saturated);
    await expect(performOcr(PAGE, 'eng')).rejects.toBe(saturated);
  });

  oracleTest('keep OcrPreprocessError (an image above the limits, a malformed buffer)', ['tesseract'], async () => {
    requireEnglishData();
    const tooBig = new OcrPreprocessError('A 20000x20000 image exceeds the 100000000 pixel binarization limit.');
    prepare.mockRejectedValue(tooBig);
    await expect(performOcr(PAGE, 'eng')).rejects.toBe(tooBig);
  });

  oracleTest('report any other failure as an undecodable image', ['tesseract'], async () => {
    requireEnglishData();
    prepare.mockRejectedValue(new Error('Input buffer contains unsupported image format'));
    const failure = await performOcr(PAGE, 'eng').catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect(failure).not.toBeInstanceOf(OcrEngineUnavailableError);
    expect((failure as Error).message).toBe('Invalid image: the OCR input could not be decoded.');
  });
});
