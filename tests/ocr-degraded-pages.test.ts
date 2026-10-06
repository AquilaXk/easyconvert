import { describe, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { performOcr } from '../src/lib/conversions/ocr';
import { OCR_PREPROCESS_STEPS, type OcrPreprocessSteps } from '../src/lib/conversions/ocr-preprocess';
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
const MAX_SKEWED_CER_PERCENT = 1;
const MAX_SKEWED_CJK_CER_PERCENT = 3;
const JAPANESE_PAGES = ['ja_a', 'ja_b'] as const;

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

/** CJK text has no spaces, and the recognizer may add some between glyphs, so compare without whitespace. */
function withoutWhitespace(text: string): string {
  return text.replace(/\s+/g, '');
}

describe('3 degree skew', () => {
  for (const page of ENGLISH_PAGES) {
    oracleTest(
      `reads the skewed ${page} page with CER <= ${MAX_SKEWED_CER_PERCENT}%`,
      ['tesseract'],
      async () => {
        requireData('eng');
        const result = await performOcr(pageImage(page, 'skew3'), 'eng');
        expect(characterErrorRatePercent(truthFor(page), result.text)).toBeLessThanOrEqual(MAX_SKEWED_CER_PERCENT);
      },
      PAGE_TIMEOUT_MS
    );
  }

  // Without levelling, the WebAssembly engine's page layout analysis cuts Japanese lines apart
  // (character error rate 58% and 90% on these pages).
  for (const page of JAPANESE_PAGES) {
    oracleTest(
      `reads the skewed ${page} Japanese page with CER <= ${MAX_SKEWED_CJK_CER_PERCENT}%`,
      ['tesseract'],
      async () => {
        requireData('jpn');
        const result = await performOcr(pageImage(page, 'skew3'), 'jpn');
        expect(
          characterErrorRatePercent(withoutWhitespace(truthFor(page)), withoutWhitespace(result.text))
        ).toBeLessThanOrEqual(MAX_SKEWED_CJK_CER_PERCENT);
      },
      PAGE_TIMEOUT_MS
    );
  }
});

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

type Language = 'eng' | 'kor' | 'jpn';

const LANGUAGE_OF: Record<string, Language> = { en: 'eng', ko: 'kor', ja: 'jpn' };

/** Character error rate of one fixture page read with the given preparation steps. */
async function pageCer(
  page: string,
  variant: string,
  steps: OcrPreprocessSteps = OCR_PREPROCESS_STEPS
): Promise<number> {
  const lang = LANGUAGE_OF[page.slice(0, 2)];
  const result = await performOcr(pageImage(page, variant), lang, steps);
  const spaced = lang === 'eng';
  return characterErrorRatePercent(
    spaced ? truthFor(page) : withoutWhitespace(truthFor(page)),
    spaced ? result.text : withoutWhitespace(result.text)
  );
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * CJK pages per degradation. Bounds sit above the measured error rates with room for engine build
 * differences. The 3 degree skew is asserted for Japanese above; Korean skew is not asserted because
 * the WebAssembly engine's automatic page segmentation reads the same Korean page from 0% to 66%
 * depending on small changes in the input (the native CLI reads this page exactly).
 */
const CJK_BOUNDS: Array<{ page: string; variant: string; maxCerPercent: number }> = [
  { page: 'ko_a', variant: 'shade', maxCerPercent: 5 },
  { page: 'ko_a', variant: 'dpi72', maxCerPercent: 5 },
  { page: 'ko_a', variant: 'noise', maxCerPercent: 10 },
  { page: 'ja_a', variant: 'shade', maxCerPercent: 2 },
  { page: 'ja_a', variant: 'dpi72', maxCerPercent: 5 },
  { page: 'ja_a', variant: 'noise', maxCerPercent: 2 },
  { page: 'ja_b', variant: 'shade', maxCerPercent: 2 },
  { page: 'ja_b', variant: 'dpi72', maxCerPercent: 5 },
  { page: 'ja_b', variant: 'noise', maxCerPercent: 2 },
];

describe('degraded Korean and Japanese pages', () => {
  for (const { page, variant, maxCerPercent } of CJK_BOUNDS) {
    oracleTest(
      `reads the ${variant} ${page} page with CER <= ${maxCerPercent}%`,
      ['tesseract'],
      async () => {
        requireData(LANGUAGE_OF[page.slice(0, 2)]);
        expect(await pageCer(page, variant)).toBeLessThanOrEqual(maxCerPercent);
      },
      PAGE_TIMEOUT_MS
    );
  }
});

const ENGLISH_VARIANTS = ['clean300', 'shade', 'dpi72', 'skew3', 'noise'] as const;
const MAX_ENGLISH_MEAN_CER_PERCENT = 0.5;

describe('English degradation set', () => {
  oracleTest(
    `has a mean CER of at most ${MAX_ENGLISH_MEAN_CER_PERCENT}% over ${ENGLISH_PAGES.length * ENGLISH_VARIANTS.length} pages`,
    ['tesseract'],
    async () => {
      requireData('eng');
      const rates: number[] = [];
      for (const page of ENGLISH_PAGES) {
        for (const variant of ENGLISH_VARIANTS) rates.push(await pageCer(page, variant));
      }
      expect(mean(rates)).toBeLessThanOrEqual(MAX_ENGLISH_MEAN_CER_PERCENT);
    },
    PAGE_TIMEOUT_MS
  );
});

/**
 * The gate for the preparation steps: a step stays enabled only if the pages it targets read
 * better with it than without it, and the pages with every step beat the unprepared pages.
 * Pages are the shaded, 72 dpi and skewed variants of two English and two Japanese pages (Korean
 * is left out because its page segmentation is erratic, see CJK_BOUNDS).
 */
const GATE_PAGES = ['en_a', 'en_b', 'ja_a', 'ja_b'];
const GATE_VARIANTS = ['shade', 'dpi72', 'skew3'];

async function gateMean(steps: OcrPreprocessSteps): Promise<number> {
  const rates: number[] = [];
  for (const page of GATE_PAGES) {
    for (const variant of GATE_VARIANTS) rates.push(await pageCer(page, variant, steps));
  }
  return mean(rates);
}

describe('preparation step gate', () => {
  oracleTest(
    'keeps every enabled step only if it lowers the mean CER',
    ['tesseract'],
    async () => {
      requireData('eng');
      requireData('jpn');
      const all = OCR_PREPROCESS_STEPS;
      const withAll = await gateMean(all);
      const withNone = await gateMean({ rescale: false, deskew: false, binarize: false });
      expect(withAll).toBeLessThan(withNone);
      for (const step of ['rescale', 'deskew', 'binarize'] as const) {
        if (!all[step]) continue;
        const without = await gateMean({ ...all, [step]: false });
        expect(withAll, `mean CER with all steps vs without ${step}`).toBeLessThan(without);
      }
    },
    300_000
  );
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
const MIN_MATCHED_WORD_SHARE = 0.9;
const MIN_WORDS = 40;

/** Words (text and centre) the reference CLI reads off an image, with coordinates multiplied by `scale`. */
function referenceWords(imagePath: string, scale: number): ReferenceWord[] {
  const cli = getOracleToolPath('tesseract');
  if (!cli) throw new OracleToolMissingError('tesseract', 'tesseract is not installed');
  const tsv = execFileSync(
    cli,
    [imagePath, 'stdout', '-l', 'eng', '--psm', '3', '--oem', '1', '-c', 'tessedit_create_tsv=1'],
    { encoding: 'utf-8', timeout: PAGE_TIMEOUT_MS, env: { ...process.env, OMP_THREAD_LIMIT: '1' } }
  );
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

/** Share of recognized words whose box centre is within `maxCentreErrorPx` of a reference word with the same text. */
async function matchedWordShare(
  source: Buffer,
  reference: ReferenceWord[],
  maxCentreErrorPx: number
): Promise<number> {
  const result = await performOcr(source, 'eng');
  const { width, height } = await sharp(source).metadata();
  expect([result.imageWidth, result.imageHeight]).toEqual([width, height]);
  const words = (result.lineBlocks ?? []).flatMap((block) => block.words);
  expect(words.length).toBeGreaterThan(MIN_WORDS);
  let matched = 0;
  for (const word of words) {
    expect(word.bbox.x + word.bbox.width).toBeLessThanOrEqual(width as number);
    expect(word.bbox.y + word.bbox.height).toBeLessThanOrEqual(height as number);
    const centerX = word.bbox.x + word.bbox.width / 2;
    const centerY = word.bbox.y + word.bbox.height / 2;
    const near = reference.some(
      (ref) => ref.text === word.text && Math.hypot(ref.centerX - centerX, ref.centerY - centerY) <= maxCentreErrorPx
    );
    if (near) matched++;
  }
  return matched / words.length;
}

describe('boxes of a prepared page', () => {
  // Word centres of the enlarged page, mapped back, may differ from the 300 dpi reading by this much at 72 dpi.
  const MAX_CENTRE_ERROR_72_DPI_PX = 4;
  // A turned page's boxes come from the levelled text, whose words the engine delimits slightly differently.
  const MAX_CENTRE_ERROR_SKEWED_PX = 10;

  oracleTest(
    'of the enlarged 72 dpi page land on the words of the original image, as the 300 dpi reading places them',
    ['tesseract'],
    async () => {
      requireData('eng');
      const reference = referenceWords(path.join(FIXTURE_DIR, 'en_a__clean300.png'), LOW_DPI / RENDER_DPI);
      const share = await matchedWordShare(pageImage('en_a', 'dpi72'), reference, MAX_CENTRE_ERROR_72_DPI_PX);
      expect(share).toBeGreaterThanOrEqual(MIN_MATCHED_WORD_SHARE);
    },
    PAGE_TIMEOUT_MS
  );

  oracleTest(
    'of the levelled 3 degree skewed page land on the words of the skewed image, as the reference reads them there',
    ['tesseract'],
    async () => {
      requireData('eng');
      const reference = referenceWords(path.join(FIXTURE_DIR, 'en_a__skew3.png'), 1);
      const share = await matchedWordShare(pageImage('en_a', 'skew3'), reference, MAX_CENTRE_ERROR_SKEWED_PX);
      expect(share).toBeGreaterThanOrEqual(MIN_MATCHED_WORD_SHARE);
    },
    PAGE_TIMEOUT_MS
  );
});
