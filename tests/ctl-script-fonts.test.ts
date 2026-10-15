import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  hasComplexTextScript,
  getDetectedComplexScripts,
  assertNoComplexScript,
  ComplexScriptRequiresNativeEngineError,
} from '../src/lib/conversions/ctl';
import { convertDocument } from '../src/lib/conversions/document';
import { convertOffice } from '../src/lib/conversions/office';
import { convertData } from '../src/lib/conversions/data';
import { executeWorkerConversion } from '../src/worker/engines';
import { oracleTest } from './helpers/oracle-test';
import {
  extractFontsWithExternalPdffonts,
  extractTextWithExternalPdftotext,
} from './helpers/differential-oracle';

/**
 * Independent DOCX synthesis for differential oracle testing.
 * Synthesizes a valid OpenXML WordprocessingML package using JSZip without importing production code.
 */
async function createTestDocx(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  );
  const pXml = paragraphs
    .map(
      (text) => `
    <w:p>
      <w:r>
        <w:t>${text}</w:t>
      </w:r>
    </w:p>`
    )
    .join('');

  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${pXml}</w:body>
</w:document>`
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('WP-42: Complex Text Layout (CTL) Script Detection and Routing', () => {
  describe('Unit Tests: Unicode CTL / Bidi Script Probing', () => {
    it('detects complex scripts accurately across diverse languages', () => {
      expect(hasComplexTextScript('مرحبا بالعالم')).toBe(true); // Arabic
      expect(hasComplexTextScript('שלום עולם')).toBe(true); // Hebrew
      expect(hasComplexTextScript('สวัสดีชาวโลก')).toBe(true); // Thai
      expect(hasComplexTextScript('नमस्ते दुनिया')).toBe(true); // Devanagari (Hindi)
      expect(hasComplexTextScript('নমস্কার বিশ্ব')).toBe(true); // Bengali
      expect(hasComplexTextScript('வணக்கம் உலகம்')).toBe(true); // Tamil
      expect(hasComplexTextScript('హలో ప్రపంచం')).toBe(true); // Telugu
      expect(hasComplexTextScript('ഹലോ ലോകം')).toBe(true); // Malayalam
      expect(hasComplexTextScript('ສະບາຍດີ')).toBe(true); // Lao
    });

    it('returns false for Latin, CJK, Korean Hangul, numbers and punctuation', () => {
      expect(hasComplexTextScript('Hello World 123!@#')).toBe(false);
      expect(hasComplexTextScript('안녕하세요 반갑습니다')).toBe(false); // Korean
      expect(hasComplexTextScript('こんにちは世界')).toBe(false); // Japanese
      expect(hasComplexTextScript('你好世界')).toBe(false); // Chinese
      expect(hasComplexTextScript('Bonjour le monde, ça va?')).toBe(false); // Latin Extended
      expect(hasComplexTextScript('')).toBe(false);
    });

    it('identifies exact script names in multi-lingual strings', () => {
      const scripts = getDetectedComplexScripts('مرحبا (Arabic) and שלום (Hebrew)');
      expect(scripts).toEqual(['Arabic', 'Hebrew']);
      expect(scripts).toHaveLength(2);
    });

    it('assertNoComplexScript throws ComplexScriptRequiresNativeEngineError on CTL text', () => {
      expect(() => {
        assertNoComplexScript('مرحبا', 'TestDocument');
      }).toThrow(ComplexScriptRequiresNativeEngineError);

      expect(() => {
        assertNoComplexScript('Valid standard Latin & 한글 text', 'TestDocument');
      }).not.toThrow();
    });
  });

  describe('In-process PDF generation shapes complex scripts instead of refusing them', () => {
    /** Logical text of a PDF as Poppler extracts it: no bidi marks, no whitespace. */
    function logicalText(pdf: Buffer): string {
      return (extractTextWithExternalPdftotext(pdf) ?? '').normalize('NFC').replace(/\p{Cf}/gu, '').replace(/\s+/g, '');
    }

    oracleTest('renders text-to-pdf conversion with Arabic script', ['pdftotext'], async () => {
      const result = await convertDocument(Buffer.from('مرحبا بكم في الاختبار', 'utf-8'), 'txt', 'pdf', {}, 'arabic');
      expect(logicalText(result.buffer)).toBe('مرحبابكمفيالاختبار');
    });

    oracleTest('renders markdown-to-pdf conversion with Hebrew script', ['pdftotext'], async () => {
      const result = await convertDocument(Buffer.from('# שלום עולם\n\nבדיקת תאימות מערכת', 'utf-8'), 'md', 'pdf', {}, 'hebrew');
      expect(logicalText(result.buffer).match(/שלוםעולם|בדיקתתאימותמערכת/g)).toEqual(['שלוםעולם', 'בדיקתתאימותמערכת']);
    });

    oracleTest('renders docx-to-pdf conversion with Thai script', ['pdftotext'], async () => {
      const result = await convertOffice(await createTestDocx(['สวัสดีชาวโลก']), 'docx', 'pdf', {}, 'thai');
      expect(logicalText(result.buffer)).toBe('สวัสดีชาวโลก');
    });

    oracleTest('renders data-to-pdf (csv) conversion with Devanagari script', ['pdftotext'], async () => {
      const result = await convertData(Buffer.from('id,name\n1,नमस्ते\n2,दुनिया', 'utf-8'), 'csv', 'pdf', {}, 'hindi');
      expect(logicalText(result.buffer).match(/नमस्ते|दुनिया/g)).toEqual(['नमस्ते', 'दुनिया']);
    });

    oracleTest('renders complex text in-process in executeWorkerConversion when native soffice is unavailable', ['pdftotext'], async () => {
      const prevSoffice = process.env.SOFFICE_PATH;
      process.env.SOFFICE_PATH = '/nonexistent/soffice_binary';
      try {
        const result = await executeWorkerConversion(Buffer.from('مرحبا بالعالم', 'utf-8'), 'txt', 'pdf', {}, 'arabic.txt');
        expect(result.engineUsed).toBe('internal-fallback');
        expect(logicalText(result.buffer)).toBe('مرحبابالعالم');
      } finally {
        if (prevSoffice === undefined) {
          delete process.env.SOFFICE_PATH;
        } else {
          process.env.SOFFICE_PATH = prevSoffice;
        }
      }
    });
  });

  describe('Differential Oracle Tests (LibreOffice + Noto Fonts + Poppler CLI)', () => {
    oracleTest(
      'converts multi-lingual CTL DOCX to authentic PDF with embedded Noto fonts and NFC text matching',
      ['soffice', 'pdffonts', 'pdftotext'],
      async () => {
        const ctlPhrases = [
          'Arabic: مرحبا بكم في سهولة التحويل',
          'Hebrew: שלום עולם בדיקה תקינה',
          'Thai: สวัสดี ยินดีต้อนรับสู่ระบบ',
          'Hindi: नमस्ते दुनिया आपका स्वागत है',
        ];

        const testDocx = await createTestDocx(ctlPhrases);
        const result = await executeWorkerConversion(testDocx, 'docx', 'pdf', {}, 'multilingual-ctl.docx');

        expect(result).toBeDefined();
        expect(result.mimeType).toBe('application/pdf');
        expect(result.buffer.length).toBeGreaterThan(1000);

        // 1. Verify embedded Noto fonts via Poppler pdffonts
        const fonts = extractFontsWithExternalPdffonts(result.buffer);
        expect(fonts.length).toBeGreaterThan(0);
        const hasEmbeddedFonts = fonts.some((f) => f.emb === true);
        expect(hasEmbeddedFonts).toBe(true);

        // 2. Verify logical character content via Poppler pdftotext with NFC normalization
        const extractedText = extractTextWithExternalPdftotext(result.buffer);
        expect(extractedText).not.toBeNull();
        const normalized = (extractedText || '').normalize('NFC');

        // Check each script's logical characters are authentically preserved
        expect(normalized).toContain('مرحبا');
        expect(normalized).toContain('שלום');
        expect(normalized).toContain('สวัสดี');
        expect(normalized).toContain('नमस्ते');
      },
      60000
    );
  });
});
