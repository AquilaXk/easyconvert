import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getOracleToolPath, OracleToolMissingError } from './differential-oracle';

/**
 * Shared access to the OCR golden pages (tests/fixtures/ocr, rendered by generate_golden.py from
 * known text) and to the reference engine CLI. Ground truth is the text that was drawn onto each
 * page and the reference output comes from the standard CLI, never from the code under test.
 */

export const OCR_FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'ocr');

const TESSDATA_DIRS = [
  ...(process.env.TESSDATA_PREFIX ? [process.env.TESSDATA_PREFIX] : []),
  process.cwd(),
  '/usr/share/tesseract-ocr/5/tessdata',
  '/usr/share/tesseract-ocr/4.00/tessdata',
  '/usr/share/tessdata',
  '/opt/homebrew/share/tessdata',
  '/usr/local/share/tessdata',
];

/** Directory holding `<lang>.traineddata`, or a skip (a failure under ORACLE_STRICT_MODE=1) when it is missing. */
export function requireTessdata(lang: string): string {
  const dir = TESSDATA_DIRS.find((candidate) => fs.existsSync(path.join(candidate, `${lang}.traineddata`)));
  if (!dir) throw new OracleToolMissingError(`${lang}.traineddata`, `${lang}.traineddata is not installed`);
  return dir;
}

export function requireTesseract(): string {
  const cli = getOracleToolPath('tesseract');
  if (!cli) throw new OracleToolMissingError('tesseract', 'the tesseract CLI is not installed');
  return cli;
}

export function groundTruth(page: string): string {
  return fs.readFileSync(path.join(OCR_FIXTURE_DIR, `${page}.gt.txt`), 'utf-8');
}

export function fixturePath(page: string, variant: string): string {
  return path.join(OCR_FIXTURE_DIR, `${page}__${variant}.png`);
}

export function fixtureImage(page: string, variant: string): Buffer {
  return fs.readFileSync(fixturePath(page, variant));
}

const REFERENCE_TIMEOUT_MS = 120_000;

/** One tesseract CLI run on a file, as the reference: the same segmentation and engine as the pipeline. */
export function runTesseractCli(file: string, lang: string, extraArgs: string[] = [], psm = '3'): string {
  return execFileSync(
    requireTesseract(),
    [file, 'stdout', '-l', lang, '--tessdata-dir', requireTessdata(lang), '--psm', psm, '--oem', '1', ...extraArgs],
    {
      encoding: 'utf-8',
      timeout: REFERENCE_TIMEOUT_MS,
      env: { ...process.env, OMP_THREAD_LIMIT: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
    }
  );
}

/** The engine's own plain-text output for a file. */
export function engineText(file: string, lang: string): string {
  return runTesseractCli(file, lang);
}

export interface ReferenceWord {
  text: string;
  /** Pixels, y down. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Engine confidence, 0..100. */
  confidence: number;
}

/** Word rows of the engine's TSV output, parsed independently of the code under test. */
export function engineTsvWords(file: string, lang: string, psm = '3'): ReferenceWord[] {
  const tsv = runTesseractCli(file, lang, ['-c', 'tessedit_create_tsv=1'], psm);
  const words: ReferenceWord[] = [];
  for (const row of tsv.split('\n').slice(1)) {
    const fields = row.split('\t');
    if (fields.length < 12 || fields[0] !== '5' || fields[11].trim() === '') continue;
    const [left, top, width, height, conf] = fields.slice(6, 11).map(Number);
    words.push({
      text: fields[11].trim(),
      x0: left,
      y0: top,
      x1: left + width,
      y1: top + height,
      confidence: conf,
    });
  }
  return words;
}

/** Whitespace-separated words of a text, after NFKC normalization. */
export function wordsOf(text: string): string[] {
  return text.normalize('NFKC').split(/\s+/).filter(Boolean);
}
