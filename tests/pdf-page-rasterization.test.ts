import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, vi } from 'vitest';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import JSZip from 'jszip';
import {
  parsePageRanges,
  groupConsecutiveRanges,
  validatePageRangeSyntax,
  validateTierPageLimit,
  TIER_MAX_PAGES,
} from '../src/lib/conversions/page-range';
import { InvalidPageRangeError, EngineUnavailableError, UnsupportedTargetError } from '../src/lib/types';
import { convertDocument } from '../src/lib/conversions/document';
import { executeWorkerConversion, getPdfPageCount } from '../src/worker/engines';
import { oracleTest } from './helpers/oracle-test';

/** Real engine, CLI or large-input work: the 5 s default fails on a loaded CI shard without any regression; 60 s only stops a hang. */
const ENGINE_TEST_TIMEOUT_MS = 60_000;
vi.setConfig({ testTimeout: ENGINE_TEST_TIMEOUT_MS });

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function generateTestPdf(pageCount = 3): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  for (let i = 1; i <= pageCount; i++) {
    const page = pdfDoc.addPage([400, 400]);
    page.drawText(`EasyConvert Test Vector Page ${i}`, {
      x: 50,
      y: 350,
      size: 20,
      font,
      color: rgb(0.1, 0.2, 0.8),
    });
    page.drawRectangle({
      x: 50,
      y: 50,
      width: 300,
      height: 250,
      borderColor: rgb(0.8, 0.1, 0.1),
      borderWidth: 2,
    });
  }

  const uint8 = await pdfDoc.save();
  return Buffer.from(uint8);
}

describe('WP-40: PDF Page Range Selection & Multi-Page Rasterization', () => {
  describe('Page Range Grammar & Syntax Parsing', () => {
    it('parses single page numbers', () => {
      expect(parsePageRanges('1', 5)).toEqual([1]);
      expect(parsePageRanges('3', 5)).toEqual([3]);
      expect(parsePageRanges('5', 5)).toEqual([5]);
    });

    it('parses closed contiguous ranges', () => {
      expect(parsePageRanges('1-3', 5)).toEqual([1, 2, 3]);
      expect(parsePageRanges('2-4', 5)).toEqual([2, 3, 4]);
      expect(parsePageRanges('4-5', 5)).toEqual([4, 5]);
    });

    it('parses open-ended ranges', () => {
      expect(parsePageRanges('3-', 5)).toEqual([3, 4, 5]);
      expect(parsePageRanges('-3', 5)).toEqual([1, 2, 3]);
      expect(parsePageRanges('1-', 3)).toEqual([1, 2, 3]);
      expect(parsePageRanges('-1', 3)).toEqual([1]);
    });

    it('parses comma-separated combinations and deduplicates in ascending order', () => {
      expect(parsePageRanges('1, 3-5, 2', 5)).toEqual([1, 2, 3, 4, 5]);
      expect(parsePageRanges('1-3, 2-4, 5', 5)).toEqual([1, 2, 3, 4, 5]);
      expect(parsePageRanges('4, 2, 5, 1, 3', 5)).toEqual([1, 2, 3, 4, 5]);
      expect(parsePageRanges('2, 2, 2-3', 5)).toEqual([2, 3]);
    });

    it('fails closed on invalid characters or syntax', () => {
      expect(() => parsePageRanges('2-x', 5)).toThrow(InvalidPageRangeError);
      expect(() => parsePageRanges('abc', 5)).toThrow(InvalidPageRangeError);
      expect(() => parsePageRanges('1,,3', 5)).toThrow(InvalidPageRangeError);
      expect(() => parsePageRanges(',1', 5)).toThrow(InvalidPageRangeError);
      expect(() => parsePageRanges('1,', 5)).toThrow(InvalidPageRangeError);
      expect(() => parsePageRanges('-', 5)).toThrow(InvalidPageRangeError);
      expect(() => parsePageRanges('1-2-3', 5)).toThrow(InvalidPageRangeError);
      expect(() => parsePageRanges('', 5)).toThrow(InvalidPageRangeError);
      expect(() => parsePageRanges('   ', 5)).toThrow(InvalidPageRangeError);
    });

    it('fails closed on 0, negative numbers, or out of bounds pages', () => {
      expect(() => parsePageRanges('0', 5)).toThrow(InvalidPageRangeError);
      expect(() => parsePageRanges('0-3', 5)).toThrow(InvalidPageRangeError);
      expect(() => parsePageRanges('6', 5)).toThrow(InvalidPageRangeError);
      expect(() => parsePageRanges('1-6', 5)).toThrow(InvalidPageRangeError);
      expect(() => parsePageRanges('7-', 5)).toThrow(InvalidPageRangeError);
    });

    it('fails closed on reverse ranges (start > end)', () => {
      expect(() => parsePageRanges('5-2', 5)).toThrow(InvalidPageRangeError);
      expect(() => parsePageRanges('3-1', 5)).toThrow(InvalidPageRangeError);
    });
  });

  describe('Consecutive Range Grouping', () => {
    it('groups consecutive page numbers into contiguous intervals', () => {
      expect(groupConsecutiveRanges([1, 2, 3, 5, 7, 8])).toEqual([
        { start: 1, end: 3 },
        { start: 5, end: 5 },
        { start: 7, end: 8 },
      ]);
      expect(groupConsecutiveRanges([1])).toEqual([{ start: 1, end: 1 }]);
      expect(groupConsecutiveRanges([1, 2, 3, 4])).toEqual([{ start: 1, end: 4 }]);
      expect(groupConsecutiveRanges([])).toEqual([]);
    });
  });

  describe('Tier Page Limits & Syntax Validation', () => {
    it('validates syntax without total page count', () => {
      expect(() => validatePageRangeSyntax('1-5, 8, 10-')).not.toThrow();
      expect(() => validatePageRangeSyntax('0')).toThrow(InvalidPageRangeError);
      expect(() => validatePageRangeSyntax('5-2')).toThrow(InvalidPageRangeError);
      expect(() => validatePageRangeSyntax('1,,3')).toThrow(InvalidPageRangeError);
    });

    it('enforces tier page limits', () => {
      expect(TIER_MAX_PAGES.free).toBe(50);
      expect(TIER_MAX_PAGES.pro).toBe(500);
      expect(TIER_MAX_PAGES.enterprise).toBe(2000);

      expect(() => validateTierPageLimit('1-50', 'free')).not.toThrow();
      expect(() => validateTierPageLimit('1-51', 'free')).toThrow(InvalidPageRangeError);
      expect(() => validateTierPageLimit('51', 'free')).toThrow(InvalidPageRangeError);

      expect(() => validateTierPageLimit('1-500', 'pro')).not.toThrow();
      expect(() => validateTierPageLimit('1-501', 'pro')).toThrow(InvalidPageRangeError);
      expect(() => validateTierPageLimit('501', 'pro')).toThrow(InvalidPageRangeError);

      expect(() => validateTierPageLimit('1-2000', 'enterprise')).not.toThrow();
      expect(() => validateTierPageLimit('1-2001', 'enterprise')).toThrow(InvalidPageRangeError);
      expect(() => validateTierPageLimit('2001', 'enterprise')).toThrow(InvalidPageRangeError);
    });
  });

  describe('Pure-TS Fail-Closed Gating', () => {
    it('fails closed when attempting PDF to PNG rasterization without native Poppler worker', async () => {
      const pdfBuffer = await generateTestPdf(2);
      await expect(convertDocument(pdfBuffer, 'pdf', 'png')).rejects.toThrow(
        EngineUnavailableError
      );
    });

    it('fails closed when attempting PDF to SVG conversion without native Poppler worker', async () => {
      const pdfBuffer = await generateTestPdf(2);
      await expect(convertDocument(pdfBuffer, 'pdf', 'svg')).rejects.toThrow(
        UnsupportedTargetError
      );
    });
  });

  describe('PDF Page Count Probing & Fallback', () => {
    it('accurately resolves page count via pdf-lib parser fallback', async () => {
      const pdfBuffer = await generateTestPdf(4);
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyconvert-pagecount-'));
      try {
        const dummyPath = path.join(tempDir, 'dummy.pdf');
        fs.writeFileSync(dummyPath, pdfBuffer);
        const count = await getPdfPageCount(dummyPath, tempDir, 5000, undefined, pdfBuffer);
        expect(count).toBe(4);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('fails closed on invalid or corrupted PDF buffer', async () => {
      const corrupt = Buffer.from('NOT_A_VALID_PDF_STREAM');
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyconvert-corrupt-'));
      try {
        const dummyPath = path.join(tempDir, 'corrupt.pdf');
        fs.writeFileSync(dummyPath, corrupt);
        await expect(getPdfPageCount(dummyPath, tempDir, 5000, undefined, corrupt)).rejects.toThrow(
          'Unable to determine PDF page count'
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('Differential Poppler Oracle Integration', () => {
    oracleTest('renders single requested page to authentic standalone PNG image', ['pdftoppm'], async () => {
      const pdfBuffer = await generateTestPdf(3);
      const result = await executeWorkerConversion(
        pdfBuffer,
        'pdf',
        'png',
        { pages: '2' },
        'sample-document.pdf'
      );

      expect(result.engineUsed).toBe('native-poppler');
      expect(result.mimeType).toBe('image/png');
      expect(result.filename).toBe('sample-document.png');
      expect(result.buffer.subarray(0, 8)).toEqual(PNG_MAGIC);
    });

    oracleTest('renders multiple requested pages into a structured ZIP archive', ['pdftoppm'], async () => {
      const pdfBuffer = await generateTestPdf(3);
      const result = await executeWorkerConversion(
        pdfBuffer,
        'pdf',
        'png',
        { pages: '1-3' },
        'multi-slide.pdf'
      );

      expect(result.engineUsed).toBe('native-poppler');
      expect(result.mimeType).toBe('application/zip');
      expect(result.filename).toBe('multi-slide.zip');

      const zip = await JSZip.loadAsync(result.buffer);
      const fileNames = Object.keys(zip.files).sort();

      expect(fileNames).toEqual([
        'multi-slide-p001.png',
        'multi-slide-p002.png',
        'multi-slide-p003.png',
      ]);

      for (const name of fileNames) {
        const fileData = await zip.files[name].async('nodebuffer');
        expect(fileData.subarray(0, 8)).toEqual(PNG_MAGIC);
      }
    });

    oracleTest('honors multiPageOutput=first returning single image even when range spans multiple pages', ['pdftoppm'], async () => {
      const pdfBuffer = await generateTestPdf(3);
      const result = await executeWorkerConversion(
        pdfBuffer,
        'pdf',
        'png',
        { pages: '1-3', multiPageOutput: 'first' },
        'deck.pdf'
      );

      expect(result.engineUsed).toBe('native-poppler');
      expect(result.mimeType).toBe('image/png');
      expect(result.filename).toBe('deck.png');
      expect(result.buffer.subarray(0, 8)).toEqual(PNG_MAGIC);
    });

    oracleTest('renders authentic vector SVG via pdftocairo for single and multi-page requests', ['pdftocairo'], async () => {
      const pdfBuffer = await generateTestPdf(2);

      // 1. Single page SVG
      const singleRes = await executeWorkerConversion(
        pdfBuffer,
        'pdf',
        'svg',
        { pages: '1' },
        'vector-chart.pdf'
      );
      expect(singleRes.engineUsed).toBe('native-poppler');
      expect(singleRes.mimeType).toBe('image/svg+xml');
      expect(singleRes.filename).toBe('vector-chart.svg');
      const svgText = singleRes.buffer.toString('utf-8');
      expect(svgText).toContain('<svg');

      // 2. Multi-page SVG ZIP archive
      const multiRes = await executeWorkerConversion(
        pdfBuffer,
        'pdf',
        'svg',
        { pages: '1-2' },
        'vector-chart.pdf'
      );
      expect(multiRes.engineUsed).toBe('native-poppler');
      expect(multiRes.mimeType).toBe('application/zip');
      expect(multiRes.filename).toBe('vector-chart.zip');

      const zip = await JSZip.loadAsync(multiRes.buffer);
      const fileNames = Object.keys(zip.files).sort();
      expect(fileNames).toEqual(['vector-chart-p001.svg', 'vector-chart-p002.svg']);
      for (const name of fileNames) {
        const entrySvg = (await zip.files[name].async('nodebuffer')).toString('utf-8');
        expect(entrySvg).toContain('<svg');
      }
    });

    oracleTest('chains PPTX presentation to multi-page PNG archive via LibreOffice + Poppler', ['soffice', 'pdftoppm'], async () => {
      const pptxPath = path.resolve(__dirname, 'fixtures/golden/office/drawingml-shapes-presentation.pptx');
      if (!fs.existsSync(pptxPath)) return;
      const pptxBuffer = fs.readFileSync(pptxPath);

      const result = await executeWorkerConversion(
        pptxBuffer,
        'pptx',
        'png',
        { pages: '1-2' },
        'presentation.pptx'
      );

      expect(result.mimeType).toBe('application/zip');
      const zip = await JSZip.loadAsync(result.buffer);
      const entries = Object.keys(zip.files);
      expect(entries.length).toBeGreaterThanOrEqual(1);
      for (const entry of entries) {
        const data = await zip.files[entry].async('nodebuffer');
        expect(data.subarray(0, 8)).toEqual(PNG_MAGIC);
      }
    });
  });
});
