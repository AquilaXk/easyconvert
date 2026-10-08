import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { trimOverreachingWords } from '../src/lib/conversions/ocr-geometry';
import type { OcrLineBlock, OcrResult, OcrWord } from '../src/lib/conversions/ocr-pdf-combiner';
import { getOracleToolPath } from './helpers/differential-oracle';
import { characterErrorRatePercent } from './helpers/ocr-cer';
import { oracleTest } from './helpers/oracle-test';
import { requireTessdata, requireTesseract } from './helpers/ocr-fixtures';

/**
 * Word boxes the engine reports must not run over the words after them, or a searchable PDF puts two words
 * on top of each other and a text extractor reads "slip" and "ways" as pieces of other words. The boxes in
 * the unit cases are the ones the engine reported for a line of the benchmark scan (the native tool's TSV for
 * the same prepared page shows the same 538 px box for "slipways"); the expected boxes are worked out by hand.
 */

const BENCH_SCAN = path.join(__dirname, '..', 'bench', 'corpus', 'scan.png');
const BENCH_SCAN_TRUTH = path.join(__dirname, '..', 'bench', 'corpus', 'scan.gt.txt');
const PAGE_TIMEOUT_MS = 120_000;
const REFERENCE_TIMEOUT_MS = 60_000;

function word(text: string, x: number, width: number, y = 90, height = 22): OcrWord {
  return { text, bbox: { x, y, width, height } };
}

function lineOf(words: OcrWord[]): OcrResult {
  const block: OcrLineBlock = {
    text: words.map((w) => w.text).join(' '),
    bbox: { x: words[0].bbox.x, y: words[0].bbox.y, width: 600, height: 26 },
    words,
  };
  return { text: block.text, confidence: null, wordCount: words.length, lines: [block.text], lineBlocks: [block], imageWidth: 700, imageHeight: 300 };
}

function boxesOf(result: OcrResult): Array<[string, number, number]> {
  return (result.lineBlocks ?? []).flatMap((block) => block.words.map((w): [string, number, number] => [w.text, w.bbox.x, w.bbox.width]));
}

describe('trimOverreachingWords', () => {
  it('cuts a box that takes in the rest of the line back to where the next word starts, leaving a gap of a tenth of the word height', () => {
    const line = lineOf([
      word('four', 396, 29),
      word('slipways', 432, 215),
      word('and', 507, 26),
      word('a', 540, 8),
      word('ruined', 557, 48),
      word('mill.', 612, 37),
    ]);
    // Word height 22, so the gap is round(2.2) = 2: "slipways" ends at 507 - 2 = 505, a width of 505 - 432 = 73.
    expect(boxesOf(trimOverreachingWords(line))).toEqual([
      ['four', 396, 29],
      ['slipways', 432, 73],
      ['and', 507, 26],
      ['a', 540, 8],
      ['ruined', 557, 48],
      ['mill.', 612, 37],
    ]);
  });

  it('cuts a box that reaches into the next word, and keeps the text of every word', () => {
    const line = lineOf([word('carried', 189, 75), word('a', 258, 8), word('measuring', 275, 77)]);
    // The first word overlaps "a" by 6 px; it is cut to 258 - 2 = 256, a width of 67.
    const trimmed = trimOverreachingWords(line);
    expect(boxesOf(trimmed)).toEqual([
      ['carried', 189, 67],
      ['a', 258, 8],
      ['measuring', 275, 77],
    ]);
    expect(trimmed.lineBlocks?.[0].words.map((w) => w.text)).toEqual(['carried', 'a', 'measuring']);
  });

  it('returns a line whose boxes do not overlap as it is', () => {
    const line = lineOf([word('By', 27, 19), word('noon', 54, 36), word('the', 97, 26)]);
    expect(trimOverreachingWords(line)).toBe(line);
  });

  it('leaves touching boxes alone, as CJK text has no spaces between its boxes', () => {
    const line = lineOf([word('한', 100, 40), word('글', 140, 40), word('문', 180, 40)]);
    expect(trimOverreachingWords(line)).toBe(line);
  });

  it('cuts the near edge in reading direction on a line that reads right to left', () => {
    // Words are listed right to left. The first one's box overruns to the left over the second.
    const line = lineOf([word('first', 400, 120), word('second', 300, 80), word('third', 200, 60)]);
    // "first" spans 400-520 and "second" 300-380, so there is no overlap; widen "first" to the left over "second".
    const overrun = lineOf([word('first', 350, 170), word('second', 300, 80), word('third', 200, 60)]);
    expect(trimOverreachingWords(line)).toBe(line);
    // "second" ends at 380; "first" now starts at 380 + gap, the gap being round(0.1 x 22) = 2.
    expect(boxesOf(trimOverreachingWords(overrun))).toEqual([
      ['first', 382, 138],
      ['second', 300, 80],
      ['third', 200, 60],
    ]);
  });

  it('works along y on a vertical line', () => {
    const column = (words: OcrWord[]): OcrResult => lineOf(words);
    const result = column([
      { text: 'top', bbox: { x: 50, y: 10, width: 22, height: 150 } },
      { text: 'middle', bbox: { x: 50, y: 100, width: 22, height: 40 } },
      { text: 'bottom', bbox: { x: 50, y: 150, width: 22, height: 50 } },
    ]);
    const trimmed = trimOverreachingWords(result);
    // "top" runs on over "middle" (from y = 100); cut to 100 - round(0.1 x 22) = 98: a height of 88.
    expect(trimmed.lineBlocks?.[0].words.map((w) => [w.bbox.y, w.bbox.height])).toEqual([
      [10, 88],
      [100, 40],
      [150, 50],
    ]);
  });
});

describe('the searchable PDF of the benchmark scan', () => {
  oracleTest(
    'reads back through pdftotext no worse than the tesseract command line reads the scan',
    ['tesseract', 'pdftotext'],
    async () => {
      const truth = fs.readFileSync(BENCH_SCAN_TRUTH, 'utf-8');
      const converted = await dispatchConversion(fs.readFileSync(BENCH_SCAN), 'png', 'pdf', { ocrEnabled: true }, 'scan.png');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-trim-'));
      try {
        const pdf = path.join(dir, 'scan.pdf');
        fs.writeFileSync(pdf, converted.buffer);
        const layerText = execFileSync(getOracleToolPath('pdftotext') as string, ['-enc', 'UTF-8', pdf, '-'], { encoding: 'utf-8', timeout: REFERENCE_TIMEOUT_MS });
        const reference = execFileSync(
          requireTesseract(),
          [BENCH_SCAN, 'stdout', '-l', 'eng', '--tessdata-dir', requireTessdata('eng'), '--psm', '3', '--oem', '1'],
          { encoding: 'utf-8', timeout: REFERENCE_TIMEOUT_MS, env: { ...process.env, OMP_THREAD_LIMIT: '1' }, stdio: ['ignore', 'pipe', 'ignore'] }
        );
        expect(characterErrorRatePercent(truth, layerText)).toBeLessThanOrEqual(characterErrorRatePercent(truth, reference));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    PAGE_TIMEOUT_MS
  );
});
