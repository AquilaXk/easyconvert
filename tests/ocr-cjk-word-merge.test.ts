import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportAlto, exportHocr, generateSearchablePdf, performOcr } from '../src/lib/conversions/ocr';
import { parseTesseractTsv, recognizeWithCli } from '../src/lib/conversions/ocr-cli';
import {
  groupAtBoundaries,
  mergeWordsWithPageText,
  wordBoundariesAfter,
} from '../src/lib/conversions/ocr-word-merge';
import type { OcrWord } from '../src/lib/conversions/ocr-pdf-combiner';
import { oracleTest } from './helpers/oracle-test';
import { getOracleToolPath } from './helpers/differential-oracle';
import { characterErrorRatePercent, normalizeOcrText, wordRecall } from './helpers/ocr-cer';
import {
  engineText,
  engineTsvWords,
  fixtureImage,
  fixturePath,
  groundTruth,
  requireTessdata,
  requireTesseract,
  wordsOf,
} from './helpers/ocr-fixtures';

/**
 * Korean, Japanese and Chinese words stay whole in the word boxes, the plain text, the searchable
 * PDF text layer and the hOCR/ALTO exports. The recognizer reports one character per box and its
 * page text keeps the spacing; the expected words are the words drawn onto the fixture page
 * (tests/fixtures/ocr/generate_golden.py), never output of the code under test.
 */

const TEST_TIMEOUT_MS = 180_000;
const MAX_CER_GAP_TO_ENGINE_POINTS = 1;
const MIN_PDF_WORD_RECALL = 0.95;
const MAX_WORD_COUNT_DEVIATION = 0.02;
const ENGLISH_PAGE = 'en_a';
const KOREAN_PAGE = 'ko_a';
const JAPANESE_PAGE = 'ja_a';

/** The lines of ko_a as drawn: the generator breaks between any two characters, so words wrap. */
const KOREAN_DRAWN_LINES = [
  '위원회는 2025년 3월 14일 분기 보고서를 검토하고 지역 상수도 사업',
  '에 대한 예산을 승인했다. 북부 양수장의 공사 지연은 자재 공급 부족',
  '때문이었으며 시공사는 10월 말까지 남은 관로 공사를 마칠 것으로 예',
  '상한다. 위원들은 송장 번호 4471번부터 4529번까지에 대한 독립적인',
  '감사를 요청했다. 서명한 임대차 계약서는 금요일까지 제출해 주시기',
  '바랍니다. 월세는 첫째 영업일까지 납부해야 하며 다섯째 날이 지나면',
  '연체료가 부과됩니다. 세입자는 이사하기 최소 60일 전에 집주인에게',
  '서면으로 알려야 한다.',
];
const KOREAN_DRAWN_TEXT = KOREAN_DRAWN_LINES.join('\n');
const KOREAN_DRAWN_WORD_COUNT = wordsOf(KOREAN_DRAWN_TEXT).length;

function word(text: string, x: number, confidence?: number): OcrWord {
  return { text, confidence, bbox: { x, y: 10, width: 20, height: 30 } };
}

describe('word boundaries from the engine page text', () => {
  it('merges characters with no whitespace between them and splits where the page text has some', () => {
    const boxes = ['위', '원', '회', '는', '2025', '년', '3', '월'];
    expect(wordBoundariesAfter('위원회는 2025년 3월', boxes)).toEqual([
      false, false, false, true, false, true, false, true,
    ]);
  });

  it('treats every Unicode whitespace character as a boundary, including the ideographic space', () => {
    expect(wordBoundariesAfter('가　나 다\n라', ['가', '나', '다', '라'])).toEqual([true, true, true, true]);
  });

  it('keeps Latin words that are already separated by whitespace', () => {
    expect(wordBoundariesAfter('Invoice 송장 42', ['Invoice', '송', '장', '42'])).toEqual([true, false, true, true]);
  });

  it('refuses boxes that do not spell out the page text', () => {
    expect(wordBoundariesAfter('위원회', ['위', '원'])).toBeNull();
    expect(wordBoundariesAfter('위원회', ['위', '훤', '회'])).toBeNull();
    expect(wordBoundariesAfter('위원', ['위', '원', '회'])).toBeNull();
    expect(wordBoundariesAfter('위 원', ['위', '', '원'])).toBeNull();
  });

  it('merges to whole words with the union box and the lowest confidence', () => {
    const merged = mergeWordsWithPageText('위원회는 2025년', [
      word('위', 0, 90),
      word('원', 40, 70),
      word('회', 80, 95),
      word('는', 120, 80),
      word('2025', 200, 99),
      word('년', 260, undefined),
    ]);
    expect(merged.wordMerge).toBe('aligned');
    expect(merged.words.map((w) => w.text)).toEqual(['위원회는', '2025년']);
    expect(merged.words[0].bbox).toMatchObject({ x: 0, y: 10, width: 140, height: 30 });
    expect(merged.words[0].confidence).toBe(70);
    expect(merged.words[1].bbox).toMatchObject({ x: 200, width: 80 });
    expect(merged.words[1].confidence).toBe(99);
  });

  it('keeps the engine boxes and says so when they disagree with the page text', () => {
    const boxes = [word('위', 0), word('훤', 40), word('회', 80)];
    const result = mergeWordsWithPageText('위원회', boxes);
    expect(result.wordMerge).toBe('unaligned');
    expect(result.words).toEqual(boxes);
  });

  it('groups items at the given boundaries', () => {
    expect(groupAtBoundaries(['a', 'b', 'c', 'd'], [false, true, false, true], (g) => g.join(''))).toEqual(['ab', 'cd']);
  });

  it('aligns a very long page in one pass', () => {
    const count = 200_000;
    const text = Array.from({ length: count / 2 }, () => '가나').join(' ');
    const boxes = Array.from({ length: count }, (_, i) => (i % 2 === 0 ? '가' : '나'));
    const boundaries = wordBoundariesAfter(text, boxes);
    expect(boundaries).not.toBeNull();
    expect(boundaries!.filter(Boolean)).toHaveLength(count / 2);
  });
});

describe('TSV rows merged with the page text', () => {
  const header = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
  const rows = [
    '1\t1\t0\t0\t0\t0\t0\t0\t400\t100\t-1\t',
    '2\t1\t1\t0\t0\t0\t10\t10\t300\t40\t-1\t',
    '3\t1\t1\t1\t0\t0\t10\t10\t300\t40\t-1\t',
    '4\t1\t1\t1\t1\t0\t10\t10\t300\t40\t-1\t',
    '5\t1\t1\t1\t1\t1\t10\t10\t40\t40\t90\t위',
    '5\t1\t1\t1\t1\t2\t60\t10\t40\t40\t60\t원',
    '5\t1\t1\t1\t1\t3\t140\t10\t40\t40\t95\t42',
  ].join('\n');
  const tsv = `${header}\n${rows}\n`;

  it('rebuilds the words of the page text and keeps the spacing out of the words', () => {
    const result = parseTesseractTsv(tsv, 'kor', '위원 42\n\n');
    expect(result.wordMerge).toBe('aligned');
    expect(result.text).toBe('위원 42');
    expect(result.wordCount).toBe(2);
    const words = result.lineBlocks?.[0].words ?? [];
    expect(words.map((w) => [w.text, w.bbox.x, w.bbox.width, w.confidence])).toEqual([
      ['위원', 10, 90, 60],
      ['42', 140, 40, 95],
    ]);
  });

  it('keeps one word per row and reports it when the page text is not what the rows spell', () => {
    const result = parseTesseractTsv(tsv, 'kor', '위훤 42');
    expect(result.wordMerge).toBe('unaligned');
    expect(result.text).toBe('위 원 42');
    expect(result.lineBlocks?.[0].words.map((w) => w.text)).toEqual(['위', '원', '42']);
  });

  it('leaves rows alone when no page text is given', () => {
    const result = parseTesseractTsv(tsv, 'kor');
    expect(result.wordMerge).toBeUndefined();
    expect(result.text).toBe('위 원 42');
  });
});

describe('Korean page, as drawn', () => {
  oracleTest(
    'the CLI path reads within 1 point of the engine\'s own text output and keeps words whole',
    ['tesseract'],
    async () => {
      const tessdataDir = requireTessdata('kor');
      const cliPath = requireTesseract();
      const file = fixturePath(KOREAN_PAGE, 'clean300');
      const reference = engineText(file, 'kor');
      const result = await recognizeWithCli({
        cliPath,
        tessdataDir,
        tesseractLang: 'kor',
        image: fixtureImage(KOREAN_PAGE, 'clean300'),
      });
      const truth = groundTruth(KOREAN_PAGE);
      const referenceCer = characterErrorRatePercent(truth, reference);
      const cliCer = characterErrorRatePercent(truth, result.text);
      expect(cliCer).toBeLessThanOrEqual(referenceCer + MAX_CER_GAP_TO_ENGINE_POINTS);

      expect(result.wordMerge).toBe('aligned');
      const boxWords = (result.lineBlocks ?? []).flatMap((block) => block.words.map((w) => w.text));
      expect(wordRecall(KOREAN_DRAWN_TEXT, boxWords.join(' '))).toBeGreaterThanOrEqual(MIN_PDF_WORD_RECALL);
      expect(Math.abs(boxWords.length - KOREAN_DRAWN_WORD_COUNT) / KOREAN_DRAWN_WORD_COUNT).toBeLessThanOrEqual(
        MAX_WORD_COUNT_DEVIATION
      );
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'hOCR and ALTO hold one word element per drawn word, within 2%',
    ['tesseract'],
    async () => {
      requireTessdata('kor');
      const result = await performOcr(fixtureImage(KOREAN_PAGE, 'clean300'), 'kor');
      expect(result.wordMerge).toBe('aligned');
      const hocrWords = (exportHocr(result).match(/class="ocrx_word"/g) ?? []).length;
      const altoWords = (exportAlto(result).match(/<String /g) ?? []).length;
      for (const count of [hocrWords, altoWords]) {
        expect(Math.abs(count - KOREAN_DRAWN_WORD_COUNT) / KOREAN_DRAWN_WORD_COUNT).toBeLessThanOrEqual(
          MAX_WORD_COUNT_DEVIATION
        );
      }
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'pdftotext finds at least 95% of the drawn words in the searchable PDF',
    ['tesseract', 'pdftotext'],
    async () => {
      requireTessdata('kor');
      const image = fixtureImage(KOREAN_PAGE, 'clean300');
      const result = await performOcr(image, 'kor');
      const pdf = await generateSearchablePdf(image, result);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-cjk-merge-'));
      try {
        const pdfPath = path.join(dir, 'page.pdf');
        fs.writeFileSync(pdfPath, pdf);
        const extracted = execFileSync(getOracleToolPath('pdftotext') as string, ['-enc', 'UTF-8', pdfPath, '-'], {
          encoding: 'utf-8',
        });
        expect(wordRecall(KOREAN_DRAWN_TEXT, extracted)).toBeGreaterThanOrEqual(MIN_PDF_WORD_RECALL);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS
  );
});

describe('Japanese page, as drawn', () => {
  oracleTest(
    'the CLI path reads within 1 point of the engine\'s own text output',
    ['tesseract'],
    async () => {
      const tessdataDir = requireTessdata('jpn');
      const cliPath = requireTesseract();
      const reference = engineText(fixturePath(JAPANESE_PAGE, 'clean300'), 'jpn');
      const result = await recognizeWithCli({
        cliPath,
        tessdataDir,
        tesseractLang: 'jpn',
        image: fixtureImage(JAPANESE_PAGE, 'clean300'),
      });
      // Japanese text has no spaces, so the engine's reading is compared without them.
      const withoutSpaces = (text: string): string => text.normalize('NFKC').replace(/\s+/g, '');
      const truth = withoutSpaces(groundTruth(JAPANESE_PAGE));
      expect(characterErrorRatePercent(truth, withoutSpaces(result.text))).toBeLessThanOrEqual(
        characterErrorRatePercent(truth, withoutSpaces(reference)) + MAX_CER_GAP_TO_ENGINE_POINTS
      );
      // Every drawn line is one run of characters without spaces, so no line splits into characters.
      for (const block of result.lineBlocks ?? []) {
        expect(block.words.length).toBeLessThanOrEqual(2);
      }
    },
    TEST_TIMEOUT_MS
  );
});

describe('English page', () => {
  oracleTest(
    'keeps every word box and the text the engine itself produces',
    ['tesseract'],
    async () => {
      const tessdataDir = requireTessdata('eng');
      const cliPath = requireTesseract();
      const file = fixturePath(ENGLISH_PAGE, 'clean300');
      const reference = engineText(file, 'eng');
      const referenceWords = engineTsvWords(file, 'eng');
      const cli = await recognizeWithCli({ cliPath, tessdataDir, tesseractLang: 'eng', image: fixtureImage(ENGLISH_PAGE, 'clean300') });
      expect(normalizeOcrText(cli.text)).toBe(normalizeOcrText(reference));
      expect((cli.lineBlocks ?? []).flatMap((b) => b.words.map((w) => w.text))).toEqual(
        // The boxes are in reading order, which for one column is the engine's order.
        referenceWords.map((w) => w.text)
      );
      expect(cli.wordMerge).toBe('aligned');

      const wasm = await performOcr(fixtureImage(ENGLISH_PAGE, 'clean300'), 'eng');
      expect(characterErrorRatePercent(groundTruth(ENGLISH_PAGE), wasm.text)).toBe(0);
      expect(wasm.lineBlocks?.flatMap((b) => b.words).length).toBe(referenceWords.length);
    },
    TEST_TIMEOUT_MS
  );
});
