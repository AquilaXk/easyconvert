import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { exportAlto, exportHocr, generateSearchablePdf, performOcr, recognizePage } from '../src/lib/conversions/ocr';
import { calibrationTableFor } from '../src/lib/conversions/ocr-calibration';
import {
  assessKoreanLayoutCoherence,
  composeDetachedHangulJamo,
  composeHangulSyllable,
  decomposeHangulSyllable,
  jamoVisualDistance,
  postCorrectKoreanOcrResult,
  scoreKoreanNeuralCandidate,
} from '../src/lib/conversions/ocr-neural';
import type { OcrResult } from '../src/lib/conversions/ocr-pdf-combiner';
import { characterErrorRatePercent } from './helpers/ocr-cer';
import { requireTessdata, requireTesseract } from './helpers/ocr-fixtures';
import { oracleTest } from './helpers/oracle-test';

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'ocr');
const TEST_TIMEOUT_MS = 120_000;

function withoutWhitespace(text: string): string {
  return text.replace(/\s+/g, '');
}

describe('Hangul Jamo grapheme decomposition, composition, and visual distance', () => {
  it('decomposes and recomposes modern Hangul syllables (U+AC00..U+D7A3) losslessly', () => {
    // '가' = (0, 0, 0), '한' = (18, 0, 4), '글' = (0, 18, 8), '힣' = (18, 20, 27)
    expect(decomposeHangulSyllable('가'.charCodeAt(0))).toEqual({ l: 0, v: 0, t: 0 });
    expect(decomposeHangulSyllable('한'.charCodeAt(0))).toEqual({ l: 18, v: 0, t: 4 });
    expect(decomposeHangulSyllable('글'.charCodeAt(0))).toEqual({ l: 0, v: 18, t: 8 });
    expect(decomposeHangulSyllable('힣'.charCodeAt(0))).toEqual({ l: 18, v: 20, t: 27 });
    expect(decomposeHangulSyllable('A'.charCodeAt(0))).toBeNull();

    for (const ch of ['가', '나', '다', '한', '글', '위', '원', '회', '승', '인', '했다', '힣']) {
      const code = ch.charCodeAt(0);
      const triple = decomposeHangulSyllable(code)!;
      expect(String.fromCharCode(composeHangulSyllable(triple.l, triple.v, triple.t))).toBe(ch[0]);
    }
  });

  it('composes detached compatibility Jamo sequences into canonical NFC Hangul syllables', () => {
    // ㄱ + ㅏ -> 가; ㅎ + ㅏ + ㄴ + ㄱ + ㅡ + ㄹ -> 한글
    expect(composeDetachedHangulJamo('\u3131\u314f')).toBe('가');
    expect(composeDetachedHangulJamo('\u314e\u314f\u3134\u3131\u3161\u3139')).toBe('한글');
    // Consonant followed by vowel starts the next syllable rather than acting as Jongseong: ㄱ + ㅏ + ㄴ + ㅏ -> 가나
    expect(composeDetachedHangulJamo('\u3131\u314f\u3134\u314f')).toBe('가나');
    expect(composeDetachedHangulJamo('위원회 2025년')).toBe('위원회 2025년');
  });

  it('scores visually confusable Jamo strokes closer than unrelated Jamo', () => {
    expect(jamoVisualDistance('공', '공')).toBe(0);
    // '공' (ㄱ+ㅗ+ㅇ) vs '궁' (ㄱ+ㅜ+ㅇ): 1 visually confusable vowel stroke (ㅗ vs ㅜ) -> 0.35
    expect(jamoVisualDistance('공', '궁')).toBeCloseTo(0.35, 6);
    // '공' (ㄱ+ㅗ+ㅇ) vs '감' (ㄱ+ㅏ+ㅁ): unrelated vowel (ㅗ vs ㅏ = 1.0) + confusable Jongseong (ㅇ vs ㅁ = 0.35) -> 1.35
    expect(jamoVisualDistance('공', '감')).toBeGreaterThan(jamoVisualDistance('공', '궁'));
  });

  it('prunes low-confidence standalone compatibility-Jamo fragment lines while keeping real Korean text', () => {
    const fragmented: OcrResult = {
      text: '위원회는 2025년 분기 보고서를 검토하고\n으\n지역 상수도 사업에 대한 예산을 승인했다.',
      confidence: 0.9,
      wordCount: 10,
      lines: [
        '위원회는 2025년 분기 보고서를 검토하고',
        '으',
        '지역 상수도 사업에 대한 예산을 승인했다.',
      ],
      language: 'kor',
      lineBlocks: [
        {
          text: '위원회는 2025년 분기 보고서를 검토하고',
          bbox: { x: 100, y: 100, width: 1600, height: 32 },
          words: [{ text: '위원회는', confidence: 0.95, bbox: { x: 100, y: 100, width: 200, height: 32 } }],
        },
        {
          text: '으',
          bbox: { x: 120, y: 150, width: 30, height: 24 },
          words: [{ text: '으', confidence: 0.42, bbox: { x: 120, y: 150, width: 30, height: 24 } }],
        },
        {
          text: '지역 상수도 사업에 대한 예산을 승인했다.',
          bbox: { x: 100, y: 200, width: 1620, height: 32 },
          words: [{ text: '지역', confidence: 0.96, bbox: { x: 100, y: 200, width: 120, height: 32 } }],
        },
      ],
    };

    const coherence = assessKoreanLayoutCoherence(fragmented, 2000);
    expect(coherence.fragmented).toBe(true);
    expect(coherence.fragmentLineCount).toBe(1);

    const cleaned = postCorrectKoreanOcrResult(fragmented);
    expect(cleaned.lines).toEqual([
      '위원회는 2025년 분기 보고서를 검토하고',
      '지역 상수도 사업에 대한 예산을 승인했다.',
    ]);
    expect(scoreKoreanNeuralCandidate(cleaned, 'neural', 2000)).toBeGreaterThan(
      scoreKoreanNeuralCandidate(fragmented, 'neural', 2000)
    );
  });

  it('has monotonic calibration tables registered for the neural engine path', () => {
    const korTable = calibrationTableFor('kor', 'neural');
    const engTable = calibrationTableFor('eng', 'neural');
    expect(korTable).not.toBeNull();
    expect(engTable).not.toBeNull();
    expect(korTable?.enginePath).toBe('neural');
    expect(engTable?.enginePath).toBe('neural');
  });
});

describe('Korean-first CPU neural OCR engine accuracy and format exports', () => {
  oracleTest(
    'reads every ko_a variant (clean300, shade, dpi72, noise, skew3) with CER <= 1% on the neural path and never hallucinates on blank images',
    ['tesseract'],
    async () => {
      requireTessdata('kor');
      requireTesseract();
      const truth = withoutWhitespace(fs.readFileSync(path.join(FIXTURE_DIR, 'ko_a.gt.txt'), 'utf-8'));

      for (const variant of ['clean300', 'shade', 'dpi72', 'noise', 'skew3'] as const) {
        const image = fs.readFileSync(path.join(FIXTURE_DIR, `ko_a__${variant}.png`));
        const page = await recognizePage(image, 'kor', { enginePath: 'neural', detectOrientation: false });
        expect(page.enginePath).toBe('neural');
        const cer = characterErrorRatePercent(truth, withoutWhitespace(page.result.text));
        expect(cer, `ko_a__${variant}`).toBeLessThanOrEqual(1);
      }

      // Blank white page must return empty text and never invent characters.
      const blankPng = await sharp({
        create: { width: 400, height: 120, channels: 3, background: { r: 255, g: 255, b: 255 } },
      })
        .png()
        .toBuffer();
      const blankPage = await recognizePage(blankPng, 'kor', { enginePath: 'neural', detectOrientation: false });
      expect(blankPage.result.text.trim()).toBe('');
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'exports valid hOCR, ALTO XML, and searchable PDF from a Korean page',
    ['tesseract'],
    async () => {
      requireTessdata('kor');
      requireTesseract();
      const image = fs.readFileSync(path.join(FIXTURE_DIR, 'ko_a__skew3.png'));
      const ocr = await performOcr(image, 'kor');
      expect(ocr.confidenceCalibrated).toBe(true);
      expect(ocr.text).toContain('위원회는 2025년 3월 14일');
      expect(ocr.text).toContain('서면으로 알려야 한다.');

      const hocrText = exportHocr(ocr);
      expect(hocrText).toContain('class="ocr_page"');
      expect(hocrText).toContain('class="ocrx_word"');
      expect(hocrText).toContain('위원회는');

      const altoText = exportAlto(ocr);
      expect(altoText).toContain('<alto ');
      expect(altoText).toContain('<String ');
      expect(altoText).toContain('위원회는');

      const pdf = await generateSearchablePdf(image, ocr);
      expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
      expect(pdf.length).toBeGreaterThan(1000);
    },
    TEST_TIMEOUT_MS
  );
});
