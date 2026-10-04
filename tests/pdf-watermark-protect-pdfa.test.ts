import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
  applyPdfWatermark,
  protectPdf,
  convertToPdfA,
  getQpdfBinaryPath,
} from '../src/lib/conversions/pdf-postprocess';
import {
  PdfPostprocessError,
  InvalidPageRangeError,
  EngineUnavailableError,
} from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { getOracleToolPath } from './helpers/differential-oracle';
import { processGraphNodeJob } from '../src/lib/queue/graph/node-executor';
import { s3Storage } from '../src/lib/storage/s3-storage';

async function createSamplePdf(pageCount = 1, texts: string[] = ['Default Document Body']): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([500, 700]);
    const text = texts[i] || `Page ${i + 1} Body Content`;
    page.drawText(text, {
      x: 50,
      y: 600,
      size: 16,
      font,
      color: rgb(0.1, 0.1, 0.1),
    });
  }

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

function createSamplePng(): Buffer {
  // Minimal valid 1x1 red PNG
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
}

describe('WP-41: PDF Watermark, AES-256 Protect Encryption, and PDF/A Support', () => {
  describe('1. PDF Watermarking Engine', () => {
    oracleTest('applies text watermark and verifies text presence via pdftotext differential oracle', ['pdftotext'], async () => {
      const originalPdf = await createSamplePdf(1, ['Original Document Text']);
      const watermarkText = 'CONFIDENTIAL_TEST_MARK';

      const watermarked = await applyPdfWatermark(originalPdf, {
        text: watermarkText,
        fontSize: 18,
        fontColor: '#ff0000',
        opacity: 0.5,
        rotation: 0,
        position: 'center',
        layer: 'over',
      });

      expect(watermarked.length).toBeGreaterThan(originalPdf.length);

      const pdftotext = getOracleToolPath('pdftotext')!;
      const tmpDir = os.tmpdir();
      const testFile = path.join(tmpDir, `wm_test_${Date.now()}.pdf`);
      fs.writeFileSync(testFile, watermarked);

      try {
        const extracted = execFileSync(pdftotext, [testFile, '-'], { encoding: 'utf-8' });
        expect(extracted).toContain('Original Document Text');
        expect(extracted).toContain(watermarkText);
      } finally {
        try { fs.unlinkSync(testFile); } catch {}
      }
    });

    oracleTest('applies image watermark and verifies visual raster rendering via pdftoppm', ['pdftoppm'], async () => {
      const originalPdf = await createSamplePdf(1, ['Base Document for Image Watermark']);
      const pngImage = createSamplePng();

      const watermarked = await applyPdfWatermark(originalPdf, {
        type: 'image',
        image: pngImage,
        scale: 10,
        opacity: 0.8,
        position: 'center',
      });

      expect(watermarked.length).toBeGreaterThan(originalPdf.length);

      const pdftoppm = getOracleToolPath('pdftoppm')!;
      const tmpDir = os.tmpdir();
      const token = Date.now();
      const testFile = path.join(tmpDir, `wm_img_${token}.pdf`);
      const outPrefix = path.join(tmpDir, `wm_out_${token}`);
      fs.writeFileSync(testFile, watermarked);

      try {
        execFileSync(pdftoppm, ['-png', '-r', '72', testFile, outPrefix]);
        const renderedPng = `${outPrefix}-1.png`;
        expect(fs.existsSync(renderedPng)).toBe(true);
        const pngBuf = fs.readFileSync(renderedPng);
        expect(pngBuf.length).toBeGreaterThan(100);
        // Verify PNG magic header
        expect(pngBuf[0]).toBe(0x89);
        expect(pngBuf[1]).toBe(0x50);
        expect(pngBuf[2]).toBe(0x4e);
        expect(pngBuf[3]).toBe(0x47);
        try { fs.unlinkSync(renderedPng); } catch {}
      } finally {
        try { fs.unlinkSync(testFile); } catch {}
      }
    });

    oracleTest('respects page range selection filtering (only designated pages are watermarked)', ['pdftotext'], async () => {
      const pagesPdf = await createSamplePdf(3, [
        'Page 1 unique text',
        'Page 2 unique text',
        'Page 3 unique text',
      ]);
      const watermarkText = 'TARGETED_PAGES_ONLY';

      // Apply only to pages 1 and 3
      const watermarked = await applyPdfWatermark(pagesPdf, {
        text: watermarkText,
        fontSize: 18,
        rotation: 0,
        pages: '1,3',
      });

      const pdftotext = getOracleToolPath('pdftotext')!;
      const tmpDir = os.tmpdir();
      const testFile = path.join(tmpDir, `wm_pages_${Date.now()}.pdf`);
      fs.writeFileSync(testFile, watermarked);

      try {
        const p1Text = execFileSync(pdftotext, ['-f', '1', '-l', '1', testFile, '-'], { encoding: 'utf-8' });
        const p2Text = execFileSync(pdftotext, ['-f', '2', '-l', '2', testFile, '-'], { encoding: 'utf-8' });
        const p3Text = execFileSync(pdftotext, ['-f', '3', '-l', '3', testFile, '-'], { encoding: 'utf-8' });

        expect(p1Text).toContain('Page 1 unique text');
        expect(p1Text).toContain(watermarkText);

        expect(p2Text).toContain('Page 2 unique text');
        expect(p2Text).not.toContain(watermarkText);

        expect(p3Text).toContain('Page 3 unique text');
        expect(p3Text).toContain(watermarkText);
      } finally {
        try { fs.unlinkSync(testFile); } catch {}
      }
    });

    it('supports 9-grid positions and tile mode', async () => {
      const pdf = await createSamplePdf(1, ['Grid Test']);

      const positions = ['top-left', 'center', 'bottom-right', 'tile'] as const;
      for (const pos of positions) {
        const res = await applyPdfWatermark(pdf, {
          text: `POS_${pos.toUpperCase()}`,
          position: pos,
          opacity: 0.3,
        });
        expect(res.length).toBeGreaterThan(pdf.length);
      }
    });

    it('supports under layer ordering without corrupting document structure', async () => {
      const pdf = await createSamplePdf(1, ['Top Layer Document Text']);
      const underWatermarked = await applyPdfWatermark(pdf, {
        text: 'BEHIND_TEXT',
        layer: 'under',
      });

      expect(underWatermarked.length).toBeGreaterThan(pdf.length);

      // Verify the PDF parses properly with pdf-lib
      const loaded = await PDFDocument.load(underWatermarked);
      expect(loaded.getPageCount()).toBe(1);
    });

    it('fails closed on empty buffer or invalid page ranges', async () => {
      await expect(applyPdfWatermark(Buffer.alloc(0))).rejects.toThrow(PdfPostprocessError);

      const pdf = await createSamplePdf(1);
      await expect(applyPdfWatermark(pdf, { pages: '0' })).rejects.toThrow(InvalidPageRangeError);
      await expect(applyPdfWatermark(pdf, { pages: '5' })).rejects.toThrow(InvalidPageRangeError);
    });
  });

  describe('2. PDF Protect & AES-256 Encryption Engine', () => {
    oracleTest('encrypts PDF with AES-256 and verifies encryption dictionary and permissions via pdfinfo', ['qpdf', 'pdfinfo'], async () => {
      const originalPdf = await createSamplePdf(1, ['Top Secret Classified Document']);

      const protectedPdf = await protectPdf(originalPdf, {
        userPassword: 'UserSecretPassword99',
        ownerPassword: 'OwnerMasterKey123',
        keyLength: 256,
        permissions: {
          print: 'none',
          modify: 'none',
          extract: false,
          annotate: false,
        },
      });

      expect(protectedPdf.length).toBeGreaterThan(100);

      const pdfinfo = getOracleToolPath('pdfinfo')!;
      const tmpDir = os.tmpdir();
      const testFile = path.join(tmpDir, `protect_test_${Date.now()}.pdf`);
      fs.writeFileSync(testFile, protectedPdf);

      try {
        // Without user password, pdfinfo on 256-bit encrypted PDF fails or requires password
        let failedWithoutPw = false;
        try {
          execFileSync(pdfinfo, [testFile], { encoding: 'utf-8' });
        } catch {
          failedWithoutPw = true;
        }
        expect(failedWithoutPw).toBe(true);

        // With user password, pdfinfo inspects security attributes
        const info = execFileSync(pdfinfo, ['-upw', 'UserSecretPassword99', testFile], { encoding: 'utf-8' });
        expect(info).toContain('Encrypted:       yes');
        expect(info).toContain('algorithm:AES-256');
        expect(info).toContain('print:no');
        expect(info).toContain('copy:no');
        expect(info).toContain('change:no');
      } finally {
        try { fs.unlinkSync(testFile); } catch {}
      }
    });

    oracleTest('refuses text extraction with pdftotext without user password and allows extraction with valid password', ['qpdf', 'pdftotext'], async () => {
      const secretContent = 'Unreadable Without Credentials 48291';
      const originalPdf = await createSamplePdf(1, [secretContent]);
      const userPw = 'CorrectPassword77';

      const encrypted = await protectPdf(originalPdf, {
        userPassword: userPw,
        keyLength: 256,
      });

      const pdftotext = getOracleToolPath('pdftotext')!;
      const tmpDir = os.tmpdir();
      const testFile = path.join(tmpDir, `extract_pw_${Date.now()}.pdf`);
      fs.writeFileSync(testFile, encrypted);

      try {
        // (1) Extraction without password fails or produces error
        let failed = false;
        try {
          execFileSync(pdftotext, [testFile, '-'], { encoding: 'utf-8' });
        } catch {
          failed = true;
        }
        expect(failed).toBe(true);

        // (2) Extraction with correct password succeeds
        const textWithPw = execFileSync(pdftotext, ['-upw', userPw, testFile, '-'], { encoding: 'utf-8' });
        expect(textWithPw).toContain(secretContent);
      } finally {
        try { fs.unlinkSync(testFile); } catch {}
      }
    });

    it('fails closed when input buffer is empty or corrupt', async () => {
      await expect(protectPdf(Buffer.alloc(0))).rejects.toThrow(PdfPostprocessError);
      await expect(protectPdf(Buffer.from('not a pdf at all'))).rejects.toThrow(PdfPostprocessError);
    });

    it('fails closed with EngineUnavailableError when qpdf binary is absent', async () => {
      const pdf = await createSamplePdf(1);
      const originalPath = process.env.QPDF_PATH;
      process.env.QPDF_PATH = '/path/to/nonexistent/qpdf';

      try {
        await expect(protectPdf(pdf, { userPassword: 'test' })).rejects.toThrow(EngineUnavailableError);
      } finally {
        if (originalPath !== undefined) {
          process.env.QPDF_PATH = originalPath;
        } else {
          delete process.env.QPDF_PATH;
        }
      }
    });
  });

  describe('3. PDF/A Archival Conversion & Metadata Reporting', () => {
    it('reports transparent validation metadata (pdfaValidated: false when veraPDF is absent)', async () => {
      const originalPdf = await createSamplePdf(1, ['Archival Record 2026']);

      // When LibreOffice is available, converts and sets pdfaValidated; when not, throws EngineUnavailableError
      const soffice = getOracleToolPath('soffice');
      if (soffice) {
        const result = await convertToPdfA(originalPdf, { conformance: 'pdfa-1b' });
        expect(result.buffer.length).toBeGreaterThan(0);
        expect(result.conformanceLevel).toBe('pdfa-1b');
        expect(result.pdfaValidated).toBe(false); // VeraPDF is absent
      } else {
        await expect(convertToPdfA(originalPdf, { conformance: 'pdfa-1b' })).rejects.toThrow(
          EngineUnavailableError
        );
      }
    });

    it('fails closed when input buffer is empty', async () => {
      await expect(convertToPdfA(Buffer.alloc(0))).rejects.toThrow(PdfPostprocessError);
    });
  });

  describe('4. Job Graph Node Execution Integration', () => {
    it('executes pdf.watermark and pdf.protect nodes sequentially in graph scheduler', async () => {
      const samplePdf = await createSamplePdf(1, ['Graph Pipeline Document']);
      const graphId = `graph_test_${Date.now()}`;

      // Save input artifact in storage
      const inputKey = `intermediate/${graphId}/init/source.pdf`;
      s3Storage.saveObject(inputKey, samplePdf, 'application/pdf', 'source.pdf');

      // 1. Execute watermark node
      const watermarkJob: any = {
        signal: new AbortController().signal,
        data: {
          graphId,
          graphNodeId: 'wmNode',
          graphNode: {
            id: 'wmNode',
            op: 'pdf.watermark',
            operation: 'pdf.watermark',
            input: [inputKey],
            options: {
              watermark: {
                text: 'APPROVED_STAMP',
                fontSize: 28,
              },
            },
          },
          inputArtifacts: [inputKey],
        },
        log: async () => {},
        updateProgress: async () => {},
      };

      const wmResult = await processGraphNodeJob(watermarkJob, undefined, s3Storage);
      expect(wmResult.resultKey).toBeTruthy();
      const wmArtifactKey = wmResult.resultKey;

      // 2. Execute protect node on the watermarked artifact
      const protectJob: any = {
        signal: new AbortController().signal,
        data: {
          graphId,
          graphNodeId: 'protectNode',
          graphNode: {
            id: 'protectNode',
            op: 'pdf.protect',
            operation: 'pdf.protect',
            input: [wmArtifactKey],
            options: {
              protect: {
                userPassword: 'GraphUserPw123',
                keyLength: 256,
              },
            },
          },
          inputArtifacts: [wmArtifactKey],
        },
        log: async () => {},
        updateProgress: async () => {},
      };

      const protectResult = await processGraphNodeJob(protectJob, undefined, s3Storage);
      expect(protectResult.resultKey).toBeTruthy();

      const finalKey = protectResult.resultKey;
      const finalStored = s3Storage.getObject(finalKey);
      expect(finalStored).toBeDefined();
      expect(finalStored!.buffer.length).toBeGreaterThan(100);

      // Verify that final stored artifact is encrypted with AES-256
      const pdfinfo = getOracleToolPath('pdfinfo');
      if (pdfinfo) {
        const tmpDir = os.tmpdir();
        const testFile = path.join(tmpDir, `graph_final_${Date.now()}.pdf`);
        fs.writeFileSync(testFile, finalStored!.buffer);
        try {
          const info = execFileSync(pdfinfo, ['-upw', 'GraphUserPw123', testFile], { encoding: 'utf-8' });
          expect(info).toContain('Encrypted:       yes');
        } finally {
          try { fs.unlinkSync(testFile); } catch {}
        }
      }
    });
  });
});
