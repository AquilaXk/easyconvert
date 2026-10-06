import { describe, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { performOcr } from '../src/lib/conversions/ocr';
import { oracleTest } from './helpers/oracle-test';
import { getOracleToolPath, OracleToolMissingError } from './helpers/differential-oracle';
import { characterErrorRatePercent } from './helpers/ocr-cer';

/**
 * Single-column pages rendered by tests/fixtures/ocr/generate_golden.py from known text and then
 * degraded (uneven shading, 72 dpi, 3 degree skew, noise). The expected text is the text that was
 * drawn, so no expectation comes from the recognizer under test.
 */
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'ocr');
const PAGE_TIMEOUT_MS = 120_000;
const ENGLISH_PAGES = ['en_a', 'en_b', 'en_c'] as const;
const MAX_SHADED_CER_PERCENT = 1;
const MAX_LOW_RESOLUTION_CER_PERCENT = 1;

const TESSDATA_DIRS = [
  ...(process.env.TESSDATA_PREFIX ? [process.env.TESSDATA_PREFIX] : []),
  process.cwd(),
  '/usr/share/tesseract-ocr/5/tessdata',
  '/usr/share/tesseract-ocr/4.00/tessdata',
  '/usr/share/tessdata',
];

function requireData(lang: string): void {
  const found = TESSDATA_DIRS.some(
    (dir) =>
      fs.existsSync(path.join(dir, `${lang}.traineddata`)) || fs.existsSync(path.join(dir, `${lang}.traineddata.gz`))
  );
  if (!found) throw new OracleToolMissingError(`${lang}.traineddata`, `${lang}.traineddata is not installed`);
}

function truthFor(page: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, `${page}.gt.txt`), 'utf-8');
}

function pageImage(page: string, variant: string): Buffer {
  return fs.readFileSync(path.join(FIXTURE_DIR, `${page}__${variant}.png`));
}

describe('degraded English pages', () => {
  for (const page of ENGLISH_PAGES) {
    oracleTest(
      `reads the 72 dpi ${page} page (10 px text lines) with CER <= ${MAX_LOW_RESOLUTION_CER_PERCENT}%`,
      ['tesseract'],
      async () => {
        requireData('eng');
        const result = await performOcr(pageImage(page, 'dpi72'), 'eng');
        expect(characterErrorRatePercent(truthFor(page), result.text)).toBeLessThanOrEqual(
          MAX_LOW_RESOLUTION_CER_PERCENT
        );
      },
      PAGE_TIMEOUT_MS
    );

    oracleTest(
      `reads the shaded ${page} page with CER <= ${MAX_SHADED_CER_PERCENT}%`,
      ['tesseract'],
      async () => {
        requireData('eng');
        const result = await performOcr(pageImage(page, 'shade'), 'eng');
        expect(characterErrorRatePercent(truthFor(page), result.text)).toBeLessThanOrEqual(MAX_SHADED_CER_PERCENT);
      },
      PAGE_TIMEOUT_MS
    );
  }
});

interface ReferenceWord {
  text: string;
  centerX: number;
  centerY: number;
}

const TSV_LEVEL = 0;
const TSV_LEFT = 6;
const TSV_TOP = 7;
const TSV_WIDTH = 8;
const TSV_HEIGHT = 9;
const TSV_CONF = 10;
const TSV_TEXT = 11;
const TSV_WORD_LEVEL = '5';
const RENDER_DPI = 300;
const LOW_DPI = 72;
/** Word centres of the enlarged page, mapped back, may differ from the 300 dpi reading by this much at 72 dpi. */
const MAX_CENTRE_ERROR_PX = 4;
const MIN_MATCHED_WORD_SHARE = 0.9;

/** Word boxes the reference CLI reads off the 300 dpi render, scaled to 72 dpi pixels. */
function referenceWordsAt72Dpi(page: string): ReferenceWord[] {
  const cli = getOracleToolPath('tesseract');
  if (!cli) throw new OracleToolMissingError('tesseract', 'tesseract is not installed');
  const tsv = execFileSync(
    cli,
    [path.join(FIXTURE_DIR, `${page}__clean300.png`), 'stdout', '-l', 'eng', '--psm', '3', '--oem', '1', '-c', 'tessedit_create_tsv=1'],
    { encoding: 'utf-8', timeout: PAGE_TIMEOUT_MS, env: { ...process.env, OMP_THREAD_LIMIT: '1' } }
  );
  const scale = LOW_DPI / RENDER_DPI;
  const words: ReferenceWord[] = [];
  for (const row of tsv.split('\n').slice(1)) {
    const fields = row.split('\t');
    if (fields[TSV_LEVEL] !== TSV_WORD_LEVEL || Number(fields[TSV_CONF]) < 0 || !fields[TSV_TEXT]?.trim()) continue;
    words.push({
      text: fields[TSV_TEXT].trim(),
      centerX: (Number(fields[TSV_LEFT]) + Number(fields[TSV_WIDTH]) / 2) * scale,
      centerY: (Number(fields[TSV_TOP]) + Number(fields[TSV_HEIGHT]) / 2) * scale,
    });
  }
  return words;
}

describe('boxes of an enlarged page', () => {
  oracleTest(
    'land on the words of the original 72 dpi image, as the 300 dpi reading places them',
    ['tesseract'],
    async () => {
      requireData('eng');
      const reference = referenceWordsAt72Dpi('en_a');
      const source = pageImage('en_a', 'dpi72');
      const result = await performOcr(source, 'eng');
      const { width, height } = await sharp(source).metadata();
      expect([result.imageWidth, result.imageHeight]).toEqual([width, height]);

      const words = (result.lineBlocks ?? []).flatMap((block) => block.words);
      expect(words.length).toBeGreaterThan(40);
      let matched = 0;
      for (const word of words) {
        const centerX = word.bbox.x + word.bbox.width / 2;
        const centerY = word.bbox.y + word.bbox.height / 2;
        expect(word.bbox.x + word.bbox.width).toBeLessThanOrEqual(width as number);
        expect(word.bbox.y + word.bbox.height).toBeLessThanOrEqual(height as number);
        const near = reference.some(
          (ref) =>
            ref.text === word.text &&
            Math.hypot(ref.centerX - centerX, ref.centerY - centerY) <= MAX_CENTRE_ERROR_PX
        );
        if (near) matched++;
      }
      expect(matched / words.length).toBeGreaterThanOrEqual(MIN_MATCHED_WORD_SHARE);
    },
    PAGE_TIMEOUT_MS
  );
});
