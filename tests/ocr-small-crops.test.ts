import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { performOcr, shutdownOcrWorkerPool } from '../src/lib/conversions/ocr';
import { recognizeWithCli } from '../src/lib/conversions/ocr-cli';
import { getSharedOcrWorkerPool } from '../src/lib/conversions/ocr-worker-pool';
import { oracleTest } from './helpers/oracle-test';
import { getOracleToolPath, OracleToolMissingError } from './helpers/differential-oracle';
import { wordRecall } from './helpers/ocr-cer';

/**
 * Images too short for page layout analysis (a UI label, a cropped word) are read as one block on
 * the same worker; automatic segmentation can return nothing or stray glyphs on them. Taller
 * images where automatic segmentation finds no words are retried as one block. Expected text is
 * the text drawn into each image.
 */
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'ocr');
const TEST_TIMEOUT_MS = 120_000;
/** Same recorded bound as the borderless-table test in ocr-page-segmentation.test.ts. */
const BORDERLESS_TABLE_MIN_WORD_RECALL = 0.9;

const TESSDATA_DIRS = [
  ...(process.env.TESSDATA_PREFIX ? [process.env.TESSDATA_PREFIX] : []),
  '/usr/share/tesseract-ocr/5/tessdata',
  '/usr/share/tesseract-ocr/4.00/tessdata',
  '/usr/share/tessdata',
];

function requireTraineddata(lang: string): string {
  const dir = TESSDATA_DIRS.find(
    (d) => fs.existsSync(path.join(d, `${lang}.traineddata`)) || fs.existsSync(path.join(d, `${lang}.traineddata.gz`))
  );
  if (!dir) throw new OracleToolMissingError(`${lang}.traineddata`, `${lang}.traineddata is not installed`);
  return dir;
}

async function textImage(word: string, width: number, height: number, fontSize: number, font: string): Promise<Buffer> {
  const svg =
    `<svg width="${width}" height="${height}"><text x="10" y="${height - 12}" ` +
    `font-family="${font}" font-size="${fontSize}" fill="black">${word}</text></svg>`;
  return sharp({ create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

/** Counts the recognitions run with single-block segmentation, by wrapping the shared pool's run. */
function countSegmentationRetries(): () => number {
  const pool = getSharedOcrWorkerPool();
  const run = pool.run.bind(pool);
  let retries = 0;
  vi.spyOn(pool, 'run').mockImplementation((spec, job) =>
    run(spec, (recognize, recognizeWith, detect) =>
      job(
        recognize,
        (parameters, image, options, output) => {
          retries++;
          return recognizeWith(parameters, image, options, output);
        },
        detect
      )
    )
  );
  return () => retries;
}

describe('small crops', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await shutdownOcrWorkerPool();
  });

  oracleTest(
    'reads a 120x40 Korean label as one block on the shared worker',
    ['tesseract'],
    async () => {
      requireTraineddata('kor');
      await shutdownOcrWorkerPool();
      const createSpy = vi.spyOn(getSharedOcrWorkerPool(), 'createWorker');
      const retries = countSegmentationRetries();
      const result = await performOcr(await textImage('한글', 120, 40, 20, 'monospace'), 'ko');
      expect(result.text).toContain('한글');
      expect(retries()).toBe(1);
      expect([result.imageWidth, result.imageHeight]).toEqual([120, 40]);
      expect(createSpy).toHaveBeenCalledTimes(1);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'reads the 120x40 Korean label through the native CLI too',
    ['tesseract'],
    async () => {
      const tessdataDir = requireTraineddata('kor');
      const result = await recognizeWithCli({
        cliPath: getOracleToolPath('tesseract')!,
        tessdataDir,
        tesseractLang: 'kor',
        image: await textImage('한글', 120, 40, 20, 'monospace'),
        imageHeight: 40,
        textRows: 1,
      });
      expect(result.text).toBe('한글');
      expect(result.wordCount).toBe(1);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'reads a one-row label in a bitmap font as one line, without a ghost line',
    ['tesseract'],
    async () => {
      requireTraineddata('kor');
      // Read as a block, this crop came back as "한글\n글" on the reference CLI.
      const result = await performOcr(await textImage('한글', 120, 40, 20, 'Unifont'), 'ko');
      expect(result.text).toBe('한글');
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'reads both rows of a short two-line label',
    ['tesseract'],
    async () => {
      requireTraineddata('eng');
      const svg =
        '<svg width="160" height="90"><g font-family="sans-serif" font-size="22" fill="black">' +
        '<text x="10" y="32">Hello</text><text x="10" y="72">World</text></g></svg>';
      const label = await sharp({ create: { width: 160, height: 90, channels: 3, background: '#ffffff' } })
        .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
        .png()
        .toBuffer();
      const result = await performOcr(label, 'eng');
      expect(result.text.split(/\s+/)).toEqual(['Hello', 'World']);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'reads a tiny English single-word crop',
    ['tesseract'],
    async () => {
      requireTraineddata('eng');
      const result = await performOcr(await textImage('Hello', 90, 30, 18, 'sans-serif'), 'eng');
      expect(result.text).toBe('Hello');
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'returns no text for a blank image instead of inventing some',
    ['tesseract'],
    async () => {
      requireTraineddata('eng');
      const blank = await sharp({
        create: { width: 120, height: 40, channels: 3, background: { r: 255, g: 255, b: 255 } },
      })
        .png()
        .toBuffer();
      const result = await performOcr(blank, 'eng');
      expect(result.text).toBe('');
      expect(result.wordCount).toBe(0);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'retries a blank page as one block once and still returns no text',
    ['tesseract'],
    async () => {
      requireTraineddata('eng');
      const retries = countSegmentationRetries();
      const blankPage = await sharp({
        create: { width: 600, height: 400, channels: 3, background: { r: 255, g: 255, b: 255 } },
      })
        .png()
        .toBuffer();
      const result = await performOcr(blankPage, 'eng');
      expect(result.text).toBe('');
      expect(retries()).toBe(1);
    },
    TEST_TIMEOUT_MS
  );

  for (const [page, minRecall] of [
    ['twocol__clean300.png', 1],
    ['table_borderless.png', BORDERLESS_TABLE_MIN_WORD_RECALL],
  ] as const) {
    oracleTest(
      `does not retry ${page}, which automatic segmentation already reads`,
      ['tesseract'],
      async () => {
        requireTraineddata('eng');
        const retries = countSegmentationRetries();
        const result = await performOcr(fs.readFileSync(path.join(FIXTURE_DIR, page)), 'eng');
        expect(retries()).toBe(0);
        const truth = fs.readFileSync(path.join(FIXTURE_DIR, page.replace(/(__clean300)?\.png$/, '.gt.txt')), 'utf-8');
        expect(wordRecall(truth, result.text)).toBeGreaterThanOrEqual(minRecall);
      },
      TEST_TIMEOUT_MS
    );
  }
});
