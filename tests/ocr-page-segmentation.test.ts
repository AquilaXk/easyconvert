import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performOcr } from '../src/lib/conversions/ocr';
import { ocrSegmentationFor } from '../src/lib/conversions/ocr-config';
import { oracleTest } from './helpers/oracle-test';
import { getOracleToolPath, OracleToolMissingError } from './helpers/differential-oracle';
import { characterErrorRatePercent, levenshtein, normalizeOcrText, wordRecall } from './helpers/ocr-cer';

/**
 * Two-column pages rendered by tests/fixtures/ocr/generate_golden.py from known text. The
 * recognizer must find both columns (automatic page segmentation); a single-block mode reads
 * across the gutter and scores a character error rate of about 73% on these pages.
 */
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'ocr');
const GROUND_TRUTH = fs.readFileSync(path.join(FIXTURE_DIR, 'twocol.gt.txt'), 'utf-8');
const MAX_CER_PERCENT = 1;
const PAGE_TIMEOUT_MS = 120_000;
const VARIANTS = ['clean300', 'skew3', 'noise', 'dpi150'] as const;

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

function loadVariant(variant: string): Buffer {
  return fs.readFileSync(path.join(FIXTURE_DIR, `twocol__${variant}.png`));
}

describe('CER helper (independent of the OCR engine)', () => {
  it('matches hand-computed edit distances', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('flaw', 'lawn')).toBe(2);
    expect(characterErrorRatePercent('abcd', 'abxd')).toBe(25);
  });

  it('counts recalled words as a multiset, ignoring order', () => {
    expect(wordRecall('a b b c', 'c b a')).toBe(0.75);
    expect(wordRecall('a b', 'b a')).toBe(1);
    expect(wordRecall('a b', '')).toBe(0);
  });

  it('applies NFKC and collapses whitespace before comparing', () => {
    expect(normalizeOcrText('ﬁne\n\n  text\t')).toBe('fine text');
    expect(characterErrorRatePercent('fine text', 'ﬁne \n text')).toBe(0);
  });
});

describe('OCR segmentation parameters', () => {
  it('uses automatic page segmentation and the LSTM engine for horizontal text', () => {
    expect(ocrSegmentationFor('eng')).toEqual({ pageSegMode: '3', engineMode: 1 });
    expect(ocrSegmentationFor('chi_sim')).toEqual({ pageSegMode: '3', engineMode: 1 });
  });

  it('uses single-block vertical segmentation for _vert data', () => {
    expect(ocrSegmentationFor('jpn_vert')).toEqual({ pageSegMode: '5', engineMode: 1 });
    expect(ocrSegmentationFor('chi_tra_vert')).toEqual({ pageSegMode: '5', engineMode: 1 });
  });
});

describe('two-column OCR accuracy', () => {
  oracleTest(
    'reference CLI with automatic segmentation reads every variant (fixture is solvable)',
    ['tesseract'],
    () => {
      requireEnglishData();
      const cli = getOracleToolPath('tesseract')!;
      for (const variant of VARIANTS) {
        const text = execFileSync(
          cli,
          [path.join(FIXTURE_DIR, `twocol__${variant}.png`), 'stdout', '-l', 'eng', '--psm', '3', '--oem', '1'],
          { encoding: 'utf-8', timeout: PAGE_TIMEOUT_MS, env: { ...process.env, OMP_THREAD_LIMIT: '1' } }
        );
        expect(characterErrorRatePercent(GROUND_TRUTH, text), variant).toBeLessThanOrEqual(MAX_CER_PERCENT);
      }
    },
    PAGE_TIMEOUT_MS
  );

  for (const variant of VARIANTS) {
    oracleTest(
      `performOcr reads the ${variant} two-column page with CER <= ${MAX_CER_PERCENT}%`,
      ['tesseract'],
      async () => {
        requireEnglishData();
        const result = await performOcr(loadVariant(variant), 'eng');
        expect(characterErrorRatePercent(GROUND_TRUTH, result.text)).toBeLessThanOrEqual(MAX_CER_PERCENT);
      },
      PAGE_TIMEOUT_MS
    );
  }
});

/**
 * Known trade-off of automatic page segmentation (PSM 3): a table drawn without ruling lines is
 * read column by column, so the row order is lost and an occasional cell can be dropped
 * (measured on this fixture: word recall 0.903 and character error rate 70.3% against row-wise
 * reading, where single-block PSM 6 reads it exactly). Gridded tables and multi-column pages read correctly under PSM 3. The recall bound
 * keeps the loss from growing; a layout-aware recognizer is the real fix for tables.
 */
const BORDERLESS_TABLE_MIN_WORD_RECALL = 0.9;

describe('borderless table (PSM 3 trade-off)', () => {
  const tableTruth = fs.readFileSync(path.join(FIXTURE_DIR, 'table_borderless.gt.txt'), 'utf-8');
  const tablePage = (): Buffer => fs.readFileSync(path.join(FIXTURE_DIR, 'table_borderless.png'));

  oracleTest(
    `performOcr keeps at least ${BORDERLESS_TABLE_MIN_WORD_RECALL} of the cell words`,
    ['tesseract'],
    async () => {
      requireEnglishData();
      const result = await performOcr(tablePage(), 'eng');
      expect(wordRecall(tableTruth, result.text)).toBeGreaterThanOrEqual(BORDERLESS_TABLE_MIN_WORD_RECALL);
    },
    PAGE_TIMEOUT_MS
  );

  oracleTest(
    'reference CLI with single-block segmentation reads the rows exactly (what PSM 3 gives up)',
    ['tesseract'],
    () => {
      requireEnglishData();
      const cli = getOracleToolPath('tesseract')!;
      const text = execFileSync(
        cli,
        [path.join(FIXTURE_DIR, 'table_borderless.png'), 'stdout', '-l', 'eng', '--psm', '6', '--oem', '1'],
        { encoding: 'utf-8', timeout: PAGE_TIMEOUT_MS, env: { ...process.env, OMP_THREAD_LIMIT: '1' } }
      );
      expect(characterErrorRatePercent(tableTruth, text)).toBeLessThanOrEqual(MAX_CER_PERCENT);
    },
    PAGE_TIMEOUT_MS
  );
});
