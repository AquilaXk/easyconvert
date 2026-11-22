import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { PDFDocument, PDFName, StandardFonts, rgb } from 'pdf-lib';
import sharp from 'sharp';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { wordF1 } from '../bench/text-metrics';
import { convertFile } from '../src/lib/conversions/index';
import { performOcr, recognizePage, shutdownOcrWorkerPool } from '../src/lib/conversions/ocr';
import { locateLanguageData } from '../src/lib/conversions/ocr-language-data';
import * as onnxHelper from '../src/lib/conversions/ocr-onnx-helper';
import { onnxOcrUnavailableReason } from '../src/lib/conversions/ocr-onnx-helper';
import { createLosslessSandwichPdfFromImage, type OcrLineBlock } from '../src/lib/conversions/ocr-pdf-combiner';
import { createLosslessSandwichPdfFromPdf } from '../src/lib/conversions/ocr-pdf-sandwich';
import { preprocessOcrImage } from '../src/lib/conversions/ocr-preprocess';
import { hasUncoveredRuledTableInk, parsePnmView } from '../src/lib/conversions/ocr-ruled-table';
import { stripInvisibleTextBlocks, stripPageInvisibleOcrText } from '../src/lib/conversions/ocr-strip-invisible-text';
import { encodePgm } from '../src/lib/conversions/pnm';
import { DecompressionLimitError } from '../src/lib/types';
import { characterErrorRatePercent } from './helpers/ocr-cer';
import { oracleTest } from './helpers/oracle-test';
import { skipUnless } from './helpers/strict-skip';

const FIXTURES = path.join(__dirname, 'fixtures', 'ocr');
const TIMEOUT_MS = 180_000;
const hasEngData = locateLanguageData('eng') !== null;
const engMissing = skipUnless('eng.traineddata (Tesseract English data)', hasEngData);
const onnxEngMissing = skipUnless(
  'ONNX English OCR models and eng.traineddata',
  onnxOcrUnavailableReason(undefined, 'eng') === null && hasEngData
);

function extractPdfText(pdfBuffer: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-redo-test-'));
  const pdfPath = path.join(dir, 'out.pdf');
  try {
    fs.writeFileSync(pdfPath, pdfBuffer);
    return execFileSync('pdftotext', ['-enc', 'UTF-8', pdfPath, '-'], { encoding: 'utf8' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('Ruled-table uncovered glyph-ink detector (ocr-ruled-table)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await shutdownOcrWorkerPool();
  });

  it('rejects malformed, truncated, or over-budget Netpbm headers cleanly', () => {
    expect(parsePnmView(Buffer.from(''))).toBeNull();
    expect(parsePnmView(Buffer.from('PNG\r\n'))).toBeNull();
    expect(parsePnmView(Buffer.from('P5\n8000 8000\n255\n'))).toBeNull();
    expect(parsePnmView(Buffer.from('P5\n10 10\n255\nshort'))).toBeNull();
    expect(hasUncoveredRuledTableInk(Buffer.from('P5\n10 10\n255\nshort'), [])).toBe(false);
  });

  it('flags a synthetic ruled grid when cell ink is uncovered and stays silent when cells are covered or unruled', () => {
    const width = 600;
    const height = 360;
    const gray = new Uint8Array(width * height).fill(255);
    // Draw 4 horizontal rules (y = 40, 120, 200, 280) and 3 vertical rules (x = 40, 300, 560)
    for (const ry of [40, 120, 200, 280]) {
      for (let x = 40; x <= 560; x++) {
        gray[ry * width + x] = 0;
        gray[(ry + 1) * width + x] = 0;
      }
    }
    for (const rx of [40, 300, 560]) {
      for (let y = 40; y <= 280; y++) {
        gray[y * width + rx] = 0;
        gray[y * width + rx + 1] = 0;
      }
    }
    // Paint short glyph strokes in all 3 rows x 2 cols
    const cellOrigins = [
      [70, 70], [330, 70],
      [70, 150], [330, 150],
      [70, 230], [330, 230],
    ];
    for (const [cx, cy] of cellOrigins) {
      for (let dy = 0; dy < 14; dy++) {
        for (let g = 0; g < 6; g++) {
          for (let dx = 0; dx < 8; dx++) {
            gray[(cy + dy) * width + (cx + g * 14 + dx)] = 10;
          }
        }
      }
    }
    const pnm = encodePgm(gray, width, height);

    // Partial boxes covering only Row 0 -> 67% of cell glyph ink is uncovered -> true
    const partialBlocks: OcrLineBlock[] = [
      {
        text: 'Row0',
        bbox: { x: 65, y: 65, width: 400, height: 24 },
        words: [
          { text: 'Cell00', bbox: { x: 65, y: 65, width: 100, height: 24 }, confidence: 0.96 },
          { text: 'Cell01', bbox: { x: 325, y: 65, width: 100, height: 24 }, confidence: 0.95 },
        ],
      },
    ];
    expect(hasUncoveredRuledTableInk(pnm, partialBlocks)).toBe(true);

    // Complete boxes covering all 6 cells -> uncovered ink is 0% -> false
    const completeBlocks: OcrLineBlock[] = cellOrigins.map(([cx, cy], idx) => ({
      text: `Cell${idx}`,
      bbox: { x: cx - 4, y: cy - 4, width: 96, height: 22 },
      words: [{ text: `Cell${idx}`, bbox: { x: cx - 4, y: cy - 4, width: 96, height: 22 }, confidence: 0.95 }],
    }));
    expect(hasUncoveredRuledTableInk(pnm, completeBlocks)).toBe(false);
  });

  it('flags a grid with one dropped cell even when the rest of the page is read, and ignores a speck in a cell', () => {
    const width = 600;
    const height = 360;
    const gray = new Uint8Array(width * height).fill(255);
    for (const ry of [40, 120, 200, 280]) {
      for (let x = 40; x <= 560; x++) {
        gray[ry * width + x] = 0;
        gray[(ry + 1) * width + x] = 0;
      }
    }
    for (const rx of [40, 300, 560]) {
      for (let y = 40; y <= 280; y++) {
        gray[y * width + rx] = 0;
        gray[y * width + rx + 1] = 0;
      }
    }
    const cellOrigins = [
      [70, 70], [330, 70],
      [70, 150], [330, 150],
      [70, 230], [330, 230],
    ];
    for (const [cx, cy] of cellOrigins) {
      for (let dy = 0; dy < 14; dy++) {
        for (let g = 0; g < 6; g++) {
          for (let dx = 0; dx < 8; dx++) gray[(cy + dy) * width + (cx + g * 14 + dx)] = 10;
        }
      }
    }
    const boxesOf = (origins: number[][]): OcrLineBlock[] =>
      origins.map(([cx, cy], idx) => ({
        text: `Cell${idx}`,
        bbox: { x: cx - 4, y: cy - 4, width: 96, height: 22 },
        words: [{ text: `Cell${idx}`, bbox: { x: cx - 4, y: cy - 4, width: 96, height: 22 }, confidence: 0.95 }],
      }));
    // One cell of six has no word at all: 17% of the ink of the grid is uncovered, under the 25% of the grid as a whole, yet a cell is lost.
    expect(hasUncoveredRuledTableInk(encodePgm(gray, width, height), boxesOf(cellOrigins.slice(0, 5)))).toBe(true);
    // The cell is read by a word that stops short of its last third (a cell that lost its end, as `14,2` for `14,250.00`).
    const shortWord = boxesOf(cellOrigins.slice(0, 5));
    const [lx, ly] = cellOrigins[5];
    shortWord.push({ text: 'Cell5', bbox: { x: lx - 4, y: ly - 4, width: 30, height: 22 }, words: [{ text: 'Cell5', bbox: { x: lx - 4, y: ly - 4, width: 30, height: 22 }, confidence: 0.95 }] });
    expect(hasUncoveredRuledTableInk(encodePgm(gray, width, height), shortWord)).toBe(true);
    // All six cells read: silent. A speck of a few pixels in an unread cell is not a cell with text.
    const speck = new Uint8Array(gray);
    for (let dy = 0; dy < 14; dy++) for (let dx = 0; dx < 84; dx++) speck[(150 + dy) * width + 330 + dx] = dy < 3 && dx < 4 ? 10 : 255;
    expect(hasUncoveredRuledTableInk(encodePgm(speck, width, height), boxesOf([...cellOrigins.slice(0, 3), ...cellOrigins.slice(4)]))).toBe(false);
  });

  it.skipIf(engMissing)(
    'detects uncovered cells on table_ruled.png under Tesseract, triggers ONNX second reading, and stays silent on prose',
    async () => {
      const ruledBuf = fs.readFileSync(path.join(FIXTURES, 'table_ruled.png'));
      const preparedRuled = await preprocessOcrImage(ruledBuf, { rescale: true, deskew: true, binarize: false });
      const tesseractOnly = await recognizePage(ruledBuf, 'eng', { detectOrientation: false, enginePath: 'wasm' });
      // Map boxes into prepared coordinates if rescaled, or check via performOcr wire-up below
      expect((tesseractOnly.result.confidence ?? 0)).toBeGreaterThan(0.85);

      const spy = vi.spyOn(onnxHelper, 'recognizePageWithOnnxHelper').mockResolvedValue({
        text: 'Item Qty Unit price Total\nHex bolt M8 x 30 1,500 $0.12 $180.00\nGasket, rubber (set) 48 $7.90 $379.20\nSteel bracket 40 mm 120 $2.35 $282.00\nCable tie 200 mm 2,000 $0.03 $60.00\nShipping and handling 1 $45.50 $45.50\nTotal due (net 30) $946.70',
        confidence: 0.99,
        wordCount: 40,
        lines: ['Item Qty Unit price Total', 'Hex bolt M8 x 30 1,500 $0.12 $180.00'],
        lineBlocks: [
          {
            text: 'Item Qty Unit price Total Hex bolt M8 x 30 1,500 $0.12 $180.00 Gasket, rubber (set) 48 $7.90 $379.20 Steel bracket 40 mm 120 $2.35 $282.00 Cable tie 200 mm 2,000 $0.03 $60.00 Shipping and handling 1 $45.50 $45.50 Total due (net 30) $946.70',
            bbox: { x: 20, y: 20, width: 500, height: 300 },
            words: [
              {
                text: 'Item Qty Unit price Total Hex bolt M8 x 30 1,500 $0.12 $180.00 Gasket, rubber (set) 48 $7.90 $379.20 Steel bracket 40 mm 120 $2.35 $282.00 Cable tie 200 mm 2,000 $0.03 $60.00 Shipping and handling 1 $45.50 $45.50 Total due (net 30) $946.70',
                bbox: { x: 20, y: 20, width: 500, height: 300 },
                confidence: 0.99,
              },
            ],
          },
        ],
      });

      const rescued = await performOcr(ruledBuf, 'eng', undefined, false);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(rescued.text).toContain('Hex bolt M8 x 30');
      expect(rescued.text).toContain('Gasket, rubber');

      // Prose and borderless fixtures must NOT trigger the ONNX helper
      spy.mockClear();
      for (const fixture of ['en_a__clean300.png', 'twocol__clean300.png', 'table_borderless.png']) {
        const buf = fs.readFileSync(path.join(FIXTURES, fixture));
        const prep = await preprocessOcrImage(buf, { rescale: true, deskew: true, binarize: false });
        expect(hasUncoveredRuledTableInk(prep.image, []), fixture).toBe(false);
      }
      await performOcr(fs.readFileSync(path.join(FIXTURES, 'en_a__clean300.png')), 'eng', undefined, false);
      expect(spy).not.toHaveBeenCalled();
      expect(preparedRuled.image.byteLength).toBeGreaterThan(1000);
    },
    TIMEOUT_MS
  );

  it.skipIf(onnxEngMissing)(
    'automatically rescues table_ruled.png via default English recognition when ONNX models are installed',
    async () => {
      const ruledBuf = fs.readFileSync(path.join(FIXTURES, 'table_ruled.png'));
      const truth = fs.readFileSync(path.join(FIXTURES, 'table_ruled.gt.txt'), 'utf8');
      const result = await performOcr(ruledBuf, 'eng', undefined, false);
      expect(characterErrorRatePercent(truth.replace(/\s+/g, ''), result.text.replace(/\s+/g, ''))).toBeLessThanOrEqual(2);
      expect(wordF1(truth, result.text)).toBeGreaterThanOrEqual(0.98);
    },
    TIMEOUT_MS
  );
});

describe('Prior invisible OCR (3 Tr) layer stripping and ocrMode=redo (ocr-strip-invisible-text)', () => {
  it('strips 3 Tr BT..ET blocks while keeping visible 0 Tr text and graphics state intact', () => {
    const stream = Buffer.from(
      'q 1 0 0 1 0 0 cm /Im0 Do Q\n' +
        'BT /F1 12 Tf 1 0 0 1 48 700 Tm (VISIBLE BORN DIGITAL HEADING) Tj ET\n' +
        'q 3 Tr BT /ECToUnicodeFont 11 Tf 1 0 0 1 48 640 Tm <004F004C0044> Tj ET Q\n',
      'latin1'
    );
    const res = stripInvisibleTextBlocks(stream);
    expect(res.strippedInvisibleBlocks).toBe(1);
    expect(res.visibleTextBlocks).toBe(1);
    const out = Buffer.from(res.bytes).toString('latin1');
    expect(out).toContain('VISIBLE BORN DIGITAL HEADING');
    expect(out).toContain('/Im0 Do');
    expect(out).not.toContain('<004F004C0044>');
  });

  it('rejects a compressed content stream exceeding the 32 MiB decompression cap', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const hugeZeros = Buffer.alloc(33 * 1024 * 1024, 0x20);
    const compressed = zlib.deflateSync(hugeZeros, { level: 1 });
    const stream = doc.context.stream(compressed, { Filter: 'FlateDecode' });
    page.node.set(PDFName.of('Contents'), doc.context.register(stream));
    expect(() => stripPageInvisibleOcrText(page)).toThrow(DecompressionLimitError);
  });

  describe.skipIf(engMissing)('with eng.traineddata installed', () => {
    oracleTest(
      'replaces a prior wrong 3 Tr OCR layer on redo without duplicating visible vector text on hybrid PDFs',
      ['pdftotext', 'tesseract'],
      async () => {
        // Build a scan image reading "FRESH SCAN OCR 7741"
      const scanPng = await sharp(
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="180">' +
            '<rect width="640" height="180" fill="#ffffff"/>' +
            '<text x="36" y="110" font-family="DejaVu Sans, Arial, sans-serif" font-size="44" fill="#000000">FRESH SCAN OCR 7741</text>' +
            '</svg>'
        )
      )
        .png()
        .toBuffer();

      // Wrap scanPng in a sandwich PDF carrying a WRONG prior 3 Tr layer ("STALE GARBLED LAYER 9999")
      const staleSandwich = await createLosslessSandwichPdfFromImage(scanPng, {
        text: 'STALE GARBLED LAYER 9999',
        confidence: 0.5,
        wordCount: 4,
        lines: ['STALE GARBLED LAYER 9999'],
        imageWidth: 640,
        imageHeight: 180,
        lineBlocks: [
          {
            text: 'STALE GARBLED LAYER 9999',
            bbox: { x: 36, y: 70, width: 520, height: 44 },
            words: [
              { text: 'STALE', bbox: { x: 36, y: 70, width: 110, height: 44 }, confidence: 0.5 },
              { text: 'GARBLED', bbox: { x: 160, y: 70, width: 150, height: 44 }, confidence: 0.5 },
              { text: 'LAYER', bbox: { x: 325, y: 70, width: 110, height: 44 }, confidence: 0.5 },
              { text: '9999', bbox: { x: 450, y: 70, width: 90, height: 44 }, confidence: 0.5 },
            ],
          },
        ],
      });
      expect(extractPdfText(staleSandwich)).toContain('STALE GARBLED LAYER 9999');

      // Assemble a 2-page hybrid PDF:
      //   Page 1: visible 0 Tr born-digital vector text ("VECTOR HEADER 314159")
      //   Page 2: copied from staleSandwich (scan image + stale 3 Tr OCR layer)
      const hybridDoc = await PDFDocument.create();
      const font = await hybridDoc.embedFont(StandardFonts.Helvetica);
      const p1 = hybridDoc.addPage([612, 300]);
      p1.drawText('VECTOR HEADER 314159 PRESERVED ONCE', { x: 40, y: 200, size: 18, font, color: rgb(0, 0, 0) });
      const staleLoaded = await PDFDocument.load(staleSandwich);
      const [copiedScanPage] = await hybridDoc.copyPages(staleLoaded, [0]);
      hybridDoc.addPage(copiedScanPage);
      const hybridBytes = Buffer.from(await hybridDoc.save());

      // Run ocrMode: 'redo' -> Page 1 keeps VECTOR HEADER 314159 ONCE, Page 2 drops STALE 9999 and gains FRESH 7741
      const rebuilt = await convertFile(
        hybridBytes,
        'pdf',
        'pdf',
        { ocrEnabled: true, ocrLanguage: 'eng', ocrMode: 'redo' },
        'hybrid.pdf'
      );
      const extracted = extractPdfText(rebuilt.buffer);
      const vectorMatches = extracted.match(/314159/g) ?? [];
      expect(vectorMatches).toHaveLength(1);
      expect(extracted).not.toContain('STALE');
      expect(extracted).not.toContain('9999');
      expect(extracted.toUpperCase()).toContain('FRESH');
      expect(extracted).toContain('7741');

      // Direct createLosslessSandwichPdfFromPdf in 'redo' mode strips prior 3 Tr layers, whereas default leaves both readable
      const redoneDirect = await createLosslessSandwichPdfFromPdf(
        staleSandwich,
        new Map([
          [
            1,
            {
              text: 'REPLACED CLEAN 8888',
              confidence: 0.99,
              wordCount: 3,
              lines: ['REPLACED CLEAN 8888'],
              imageWidth: 640,
              imageHeight: 180,
              lineBlocks: [
                {
                  text: 'REPLACED CLEAN 8888',
                  bbox: { x: 36, y: 70, width: 420, height: 44 },
                  words: [
                    { text: 'REPLACED', bbox: { x: 36, y: 70, width: 160, height: 44 }, confidence: 0.99 },
                    { text: 'CLEAN', bbox: { x: 210, y: 70, width: 110, height: 44 }, confidence: 0.99 },
                    { text: '8888', bbox: { x: 335, y: 70, width: 90, height: 44 }, confidence: 0.99 },
                  ],
                },
              ],
            },
          ],
        ]),
        { ocrMode: 'redo' }
      );
      const redoneText = extractPdfText(redoneDirect);
      expect(redoneText).not.toContain('STALE');
      expect(redoneText).toContain('REPLACED CLEAN 8888');
    },
    TIMEOUT_MS
  );
  });
});
