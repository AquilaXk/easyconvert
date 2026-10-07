/**
 * Fits the OCR confidence calibration tables (src/lib/conversions/ocr-calibration/*.json).
 *
 *   npx tsx tests/helpers/fit-ocr-calibration.mts [language/path ...]
 *
 * For each language and engine path, the fit pages (a and b of tests/fixtures/ocr-calibration) are
 * degraded, recognized, and every recognized word is labelled correct or incorrect by aligning it to
 * the words that were drawn. Isotonic regression of the label on the raw score gives the table. The
 * held-out half (pages c and d) is never read here; tests/ocr-confidence-calibration.test.ts scores
 * the tables on it. Needs the tesseract CLI and the eng and kor traineddata.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { recognizePage, shutdownOcrWorkerPool } from '../../src/lib/conversions/ocr';
import { fitIsotonicTable, type CalibrationSample, type CalibrationTable, type OcrEnginePath } from '../../src/lib/conversions/ocr-calibration';
import {
  CALIBRATION_DEGRADATIONS,
  calibrationPage,
  calibrationPageNames,
  FIT_PAGE_LETTERS,
  FIT_SEED,
  type CalibrationLanguage,
} from './ocr-calibration-set';
import { labelWords, splitWords } from './ocr-word-labels';
import { requireTessdata } from './ocr-fixtures';

const LANGUAGES: readonly CalibrationLanguage[] = ['eng', 'kor'];
const PATHS: readonly OcrEnginePath[] = ['wasm', 'cli'];
const OUTPUT_DIR = path.join(import.meta.dirname, '..', '..', 'src', 'lib', 'conversions', 'ocr-calibration');
const DATA_HASH_CHARS = 16;
const TABLE_DECIMALS = 6;

function engineVersion(): string {
  return execFileSync('tesseract', ['--version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    .split('\n')[0]
    .trim();
}

function dataHash(language: string): string {
  const file = path.join(requireTessdata(language), `${language}.traineddata`);
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, DATA_HASH_CHARS);
}

async function fit(language: CalibrationLanguage, enginePath: OcrEnginePath): Promise<CalibrationTable> {
  const samples: CalibrationSample[] = [];
  const pages = calibrationPageNames(language, FIT_PAGE_LETTERS);
  for (const name of pages) {
    const { png, truth } = calibrationPage(name);
    const truthWords = splitWords(truth);
    for (const degradation of CALIBRATION_DEGRADATIONS) {
      const page = await recognizePage(await degradation.apply(png, FIT_SEED), language, undefined, enginePath);
      if (page.enginePath !== enginePath) throw new Error(`Expected the ${enginePath} engine, got ${page.enginePath}`);
      const words = (page.result.lineBlocks ?? []).flatMap((block) => block.words).filter((w) => w.confidence !== undefined);
      const labels = labelWords(truthWords, words.map((w) => w.text.normalize('NFKC')));
      words.forEach((word, index) => samples.push({ raw: word.confidence as number, correct: labels[index] }));
    }
  }
  const fitted = fitIsotonicTable(samples);
  // Six decimals are far finer than the data supports; they keep the committed tables readable.
  const x: number[] = [];
  const y: number[] = [];
  fitted.x.forEach((knot, index) => {
    const rounded = Number(knot.toFixed(TABLE_DECIMALS));
    if (x.length > 0 && rounded <= x[x.length - 1]) return;
    x.push(rounded);
    y.push(Number(fitted.y[index].toFixed(TABLE_DECIMALS)));
  });
  return {
    language,
    enginePath,
    x,
    y,
    provenance: {
      method:
        'Isotonic regression (pool-adjacent-violators) of word correctness on the raw word score; ' +
        'words are labelled by Levenshtein alignment to the drawn text.',
      engine: engineVersion(),
      languageData: `${language}.traineddata sha256:${dataHash(language)}`,
      fittedOn: {
        pages,
        degradations: CALIBRATION_DEGRADATIONS.map((d) => d.name),
        words: samples.length,
        correctWords: samples.filter((s) => s.correct).length,
      },
      generator: 'tests/helpers/fit-ocr-calibration.mts',
    },
  };
}

async function main(): Promise<void> {
  // Optional arguments such as `kor/wasm` limit the run to those language and engine path pairs.
  const only = process.argv.slice(2);
  for (const language of LANGUAGES) {
    for (const enginePath of PATHS) {
      if (only.length > 0 && !only.includes(`${language}/${enginePath}`)) continue;
      const table = await fit(language, enginePath);
      const file = path.join(OUTPUT_DIR, `${language}.${enginePath}.json`);
      fs.writeFileSync(file, `${JSON.stringify(table, null, 2)}\n`);
      console.log(`${language}/${enginePath}: ${table.x.length} knots from ${table.provenance.fittedOn.words} words -> ${file}`);
    }
  }
  await shutdownOcrWorkerPool();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
