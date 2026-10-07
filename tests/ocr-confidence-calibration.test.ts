import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { performOcr, recognizePage } from '../src/lib/conversions/ocr';
import {
  assertCalibrationTable,
  calibrateOcrResult,
  calibrateScore,
  calibrationTableFor,
  fitIsotonicTable,
  type CalibrationTable,
  type OcrEnginePath,
} from '../src/lib/conversions/ocr-calibration';
import { analyzeDocumentLayout } from '../src/lib/conversions/dla-engine';
import type { OcrResult } from '../src/lib/conversions/ocr-pdf-combiner';
import { oracleTest } from './helpers/oracle-test';
import {
  CALIBRATION_DEGRADATIONS,
  calibrationPage,
  calibrationPageNames,
  HELD_OUT_PAGE_LETTERS,
  HELD_OUT_SEED,
  type CalibrationLanguage,
} from './helpers/ocr-calibration-set';
import { requireTessdata, requireTesseract } from './helpers/ocr-fixtures';
import { expectedCalibrationError, labelWords, splitWords, type ScoredWord } from './helpers/ocr-word-labels';

/**
 * Word and page confidence are calibrated probabilities. Every expectation is computed outside the
 * code under test: tables are checked against hand-worked regressions and against the committed
 * JSON read directly, and the held-out expected calibration error is scored with the word
 * alignment of tests/helpers/ocr-word-labels.ts on pages whose text was drawn.
 */

const TEST_TIMEOUT_MS = 300_000;
const ECE_BINS = 15;
const MAX_HELD_OUT_ECE = 0.05;
const TABLE_DIR = path.join(__dirname, '..', 'src', 'lib', 'conversions', 'ocr-calibration');

function committedTable(language: string, enginePath: OcrEnginePath): CalibrationTable {
  return JSON.parse(fs.readFileSync(path.join(TABLE_DIR, `${language}.${enginePath}.json`), 'utf-8')) as CalibrationTable;
}

function resultWith(language: string | undefined, words: Array<[string, number | undefined]>): OcrResult {
  return {
    text: words.map(([text]) => text).join(' '),
    confidence: null,
    wordCount: words.length,
    lines: [words.map(([text]) => text).join(' ')],
    language,
    lineBlocks: [
      {
        text: words.map(([text]) => text).join(' '),
        bbox: { x: 0, y: 0, width: 100, height: 10 },
        words: words.map(([text, confidence], index) => ({
          text,
          confidence,
          bbox: { x: index * 20, y: 0, width: 20, height: 10 },
        })),
      },
    ],
  };
}

describe('isotonic regression', () => {
  it('pools the neighbours that violate the order and puts a knot at each pooled block', () => {
    // Sorted: (0.1 right), (0.2 wrong), (0.3 right), (0.4 right). The first two pool to 1/2 at
    // x 0.15; the last two pool to 1 at x 0.35.
    const fitted = fitIsotonicTable(
      [
        { raw: 0.3, correct: true },
        { raw: 0.1, correct: true },
        { raw: 0.4, correct: true },
        { raw: 0.2, correct: false },
      ],
      1
    );
    expect(fitted.x[0]).toBeCloseTo(0.15, 12);
    expect(fitted.x[1]).toBeCloseTo(0.35, 12);
    expect(fitted.y).toEqual([0.5, 1]);
  });

  it('pools samples with the same score before ordering', () => {
    const fitted = fitIsotonicTable(
      [
        { raw: 0.5, correct: true },
        { raw: 0.5, correct: false },
        { raw: 0.5, correct: false },
        { raw: 0.9, correct: true },
      ],
      1
    );
    expect(fitted.x).toEqual([0.5, 0.9]);
    expect(fitted.y).toEqual([1 / 3, 1]);
  });

  it('merges blocks smaller than the minimum into the neighbour with the closer mean', () => {
    // Pooling leaves a block of three (2 right, 1 wrong) and a lone right sample; with a minimum of
    // two samples the lone one folds into its only neighbour: 3 right of 4 at the mean score.
    const samples = [
      { raw: 0.1, correct: true },
      { raw: 0.2, correct: true },
      { raw: 0.3, correct: false },
      { raw: 0.8, correct: true },
    ];
    const fitted = fitIsotonicTable(samples, 2);
    expect(fitted.x).toHaveLength(1);
    expect(fitted.x[0]).toBeCloseTo(0.35, 12);
    expect(fitted.y).toEqual([0.75]);
  });

  it('never decreases, keeps the overall share of correct words, and stays within 0..1', () => {
    // A seeded pseudo-random labelled set whose chance of being right rises with the score.
    let state = 12345;
    const next = (): number => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
    const samples = Array.from({ length: 400 }, () => {
      const raw = next();
      return { raw, correct: next() < raw * 0.9 };
    });
    const fitted = fitIsotonicTable(samples, 10);
    expect(fitted.x.every((value, i) => i === 0 || value > fitted.x[i - 1])).toBe(true);
    expect(fitted.y.every((value, i) => i === 0 || value >= fitted.y[i - 1])).toBe(true);
    expect(fitted.y.every((value) => value >= 0 && value <= 1)).toBe(true);
    // Pooling preserves the mean of every block, so the share-weighted mean over the sample is unchanged.
    const table = { x: fitted.x, y: fitted.y };
    const predictedCorrect = samples.reduce((sum, s) => sum + calibrateScore(s.raw, table), 0);
    const actualCorrect = samples.filter((s) => s.correct).length;
    expect(Math.abs(predictedCorrect - actualCorrect) / samples.length).toBeLessThan(0.02);
  });

  it('refuses an empty labelled set', () => {
    expect(() => fitIsotonicTable([])).toThrow('at least one labelled word');
  });
});

describe('applying a table', () => {
  const table = { x: [0.2, 0.6], y: [0.1, 0.9] };

  it('interpolates linearly between knots and stays flat outside them', () => {
    expect(calibrateScore(0.4, table)).toBeCloseTo(0.5, 12);
    expect(calibrateScore(0.2, table)).toBe(0.1);
    expect(calibrateScore(0.6, table)).toBe(0.9);
    expect(calibrateScore(0, table)).toBe(0.1);
    expect(calibrateScore(1, table)).toBe(0.9);
  });

  it('rejects a table that would corrupt confidences', () => {
    const base = committedTable('eng', 'wasm');
    expect(() => assertCalibrationTable({ ...base, x: [0.5, 0.4], y: [0.1, 0.2] })).toThrow('do not increase');
    expect(() => assertCalibrationTable({ ...base, x: [0.1, 0.2], y: [0.9, 0.2] })).toThrow('probabilities decrease');
    expect(() => assertCalibrationTable({ ...base, x: [0.1, 1.2], y: [0.1, 0.2] })).toThrow('outside 0..1');
    expect(() => assertCalibrationTable({ ...base, x: [], y: [] })).toThrow('missing');
    expect(() => assertCalibrationTable({ ...base, x: [0.1], y: [0.1, 0.2] })).toThrow('unequal');
  });
});

describe('the committed tables', () => {
  const combinations: Array<[CalibrationLanguage, OcrEnginePath]> = [
    ['eng', 'wasm'],
    ['eng', 'cli'],
    ['kor', 'wasm'],
    ['kor', 'cli'],
  ];

  for (const [language, enginePath] of combinations) {
    it(`${language}/${enginePath} is monotone, within 0..1 and says what it was fitted on`, () => {
      const table = committedTable(language, enginePath);
      expect(() => assertCalibrationTable(table)).not.toThrow();
      expect(table.language).toBe(language);
      expect(table.enginePath).toBe(enginePath);
      expect(table.x.length).toBeGreaterThan(2);
      expect(table.provenance.fittedOn.words).toBeGreaterThan(1000);
      expect(table.provenance.fittedOn.pages).toHaveLength(3);
      expect(table.provenance.engine).toMatch(/^tesseract /);
      expect(calibrationTableFor(language, enginePath)).toEqual(table);
    });
  }

  it('has no table for a language that was not fitted', () => {
    expect(calibrationTableFor('deu', 'wasm')).toBeNull();
    expect(calibrationTableFor('jpn', 'cli')).toBeNull();
    expect(calibrationTableFor(undefined, 'wasm')).toBeNull();
  });
});

describe('calibrating a result', () => {
  it('maps a raw score at a knot to the probability fitted for it', () => {
    const table = committedTable('eng', 'wasm');
    const knot = Math.floor(table.x.length / 2);
    const result = calibrateOcrResult(resultWith('eng', [['word', table.x[knot]]]), 'wasm');
    expect(result.confidenceCalibrated).toBe(true);
    expect(result.lineBlocks?.[0].words[0].confidence).toBeCloseTo(table.y[knot], 12);
    expect(result.confidence).toBeCloseTo(table.y[knot], 12);
  });

  it('uses the table of the engine path', () => {
    const wasm = committedTable('kor', 'wasm');
    const cli = committedTable('kor', 'cli');
    const raw = 0.5;
    const viaWasm = calibrateOcrResult(resultWith('kor', [['단어', raw]]), 'wasm').confidence;
    const viaCli = calibrateOcrResult(resultWith('kor', [['단어', raw]]), 'cli').confidence;
    expect(viaWasm).toBeCloseTo(calibrateScore(raw, wasm), 12);
    expect(viaCli).toBeCloseTo(calibrateScore(raw, cli), 12);
  });

  it('weights the page confidence by the characters of each word', () => {
    const table = committedTable('eng', 'cli');
    const low = table.x[0];
    const high = table.x[table.x.length - 1];
    const result = calibrateOcrResult(resultWith('eng', [['a', low], ['abcdefghi', high]]), 'cli');
    const expected = (table.y[0] * 1 + table.y[table.y.length - 1] * 9) / 10;
    expect(result.confidence).toBeCloseTo(expected, 12);
  });

  it('keeps the raw score and says so for a language without a table', () => {
    const result = calibrateOcrResult(resultWith('deu', [['Wort', 0.83], ['zwei', undefined]]), 'wasm');
    expect(result.confidenceCalibrated).toBe(false);
    expect(result.lineBlocks?.[0].words.map((w) => w.confidence)).toEqual([0.83, undefined]);
    expect(result.confidence).toBeCloseTo(0.83, 12);
  });

  it('reports no page confidence when no word has one, instead of a made-up value', () => {
    const result = calibrateOcrResult(resultWith('eng', [['word', undefined]]), 'wasm');
    expect(result.confidence).toBeNull();
  });

  it('clamps a raw score outside 0..1 into the range', () => {
    const result = calibrateOcrResult(resultWith('deu', [['a', 1.7], ['b', -0.2]]), 'cli');
    expect(result.lineBlocks?.[0].words.map((w) => w.confidence)).toEqual([1, 0]);
  });
});

describe('layout analysis confidence', () => {
  const box = (x: number, y: number, text: string, confidence?: number) => ({ x, y, width: 80, height: 14, text, confidence });

  it('derives a block confidence from the words it was built from', () => {
    const layout = analyzeDocumentLayout([box(50, 100, 'alpha', 0.5), box(140, 100, 'beta', 0.7)], 612, 792);
    const confidences = layout.blocks.map((block) => block.confidence);
    expect(confidences).toHaveLength(1);
    expect(confidences[0]).toBeCloseTo(0.6, 12);
  });

  it('leaves the confidence out when no word carries one', () => {
    const layout = analyzeDocumentLayout([box(50, 100, 'alpha'), box(140, 100, 'beta')], 612, 792);
    expect(layout.blocks.map((block) => block.confidence)).toEqual([undefined]);
  });
});

/** Held-out words of one language and engine path, with calibrated and raw scores and the correct label. */
async function heldOutWords(
  language: CalibrationLanguage,
  enginePath: OcrEnginePath
): Promise<{ calibrated: ScoredWord[]; raw: ScoredWord[] }> {
  const calibrated: ScoredWord[] = [];
  const raw: ScoredWord[] = [];
  const jobs: Array<{ name: string; truth: string[]; png: Buffer; degradation: (typeof CALIBRATION_DEGRADATIONS)[number] }> = [];
  for (const name of calibrationPageNames(language, HELD_OUT_PAGE_LETTERS)) {
    const page = calibrationPage(name);
    for (const degradation of CALIBRATION_DEGRADATIONS) {
      jobs.push({ name, truth: splitWords(page.truth), png: page.png, degradation });
    }
  }
  const results = await Promise.all(
    jobs.map(async (job) => {
      const image = await job.degradation.apply(job.png, HELD_OUT_SEED);
      // The WebAssembly path is the one `performOcr` takes; the native path is read through the same steps.
      // The pages are upright, so orientation detection is left out of what is being scored.
      const page = await recognizePage(image, language, { enginePath, detectOrientation: false });
      return { job, page, calibratedResult: calibrateOcrResult(page.result, enginePath) };
    })
  );
  for (const { page, calibratedResult, job } of results) {
    expect(page.enginePath).toBe(enginePath);
    const rawWords = (page.result.lineBlocks ?? []).flatMap((block) => block.words);
    const calibratedWords = (calibratedResult.lineBlocks ?? []).flatMap((block) => block.words);
    const labels = labelWords(job.truth, rawWords.map((word) => word.text.normalize('NFKC')));
    rawWords.forEach((word, index) => {
      if (word.confidence === undefined) return;
      const calibratedConfidence = calibratedWords[index].confidence as number;
      expect(calibratedConfidence).toBeGreaterThanOrEqual(0);
      expect(calibratedConfidence).toBeLessThanOrEqual(1);
      raw.push({ confidence: word.confidence, correct: labels[index] });
      calibrated.push({ confidence: calibratedConfidence, correct: labels[index] });
    });
  }
  return { calibrated, raw };
}

describe('held-out expected calibration error', () => {
  const combinations: Array<[CalibrationLanguage, OcrEnginePath]> = [
    ['eng', 'wasm'],
    ['eng', 'cli'],
    ['kor', 'wasm'],
    ['kor', 'cli'],
  ];

  for (const [language, enginePath] of combinations) {
    oracleTest(
      `${language} on the ${enginePath} path is within ${MAX_HELD_OUT_ECE} on pages and noise the fit never saw`,
      ['tesseract'],
      async () => {
        requireTessdata(language);
        requireTesseract();
        const { calibrated, raw } = await heldOutWords(language, enginePath);
        expect(calibrated.length).toBeGreaterThan(900);
        const calibratedError = expectedCalibrationError(calibrated, ECE_BINS);
        const rawError = expectedCalibrationError(raw, ECE_BINS);
        expect(calibratedError).toBeLessThanOrEqual(MAX_HELD_OUT_ECE);
        // Calibration is worth shipping only if it does not make the engine's own score worse.
        expect(calibratedError).toBeLessThanOrEqual(rawError + 0.01);
      },
      TEST_TIMEOUT_MS
    );
  }

  oracleTest(
    'performOcr returns every word with a confidence in 0..1 and says the result is calibrated',
    ['tesseract'],
    async () => {
      requireTessdata('eng');
      const { png } = calibrationPage('en_d');
      const result = await performOcr(png, 'eng');
      expect(result.confidenceCalibrated).toBe(true);
      const words = (result.lineBlocks ?? []).flatMap((block) => block.words);
      expect(words.length).toBeGreaterThan(40);
      for (const word of words) {
        expect(word.confidence).toBeGreaterThanOrEqual(0);
        expect(word.confidence).toBeLessThanOrEqual(1);
      }
      expect(result.confidence).toBeGreaterThan(0.5);
      expect(result.confidence).toBeLessThanOrEqual(1);
    },
    TEST_TIMEOUT_MS
  );
});
