import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
  applyPdfWatermark,
  protectPdf,
  convertToPdfA,
  getQpdfBinaryPath,
} from '../src/lib/conversions/pdf-postprocess';
import { validatePdfProtectOptions } from '../src/lib/conversions/pdf-postprocess/protect';
import { assertPdfPostProcessOptions } from '../src/lib/conversions';
import { validateJobGraph } from '../src/lib/jobs/graph';
import { getAvailableTargetFormats } from '../src/lib/registry';
import { sealGraph } from '../src/lib/queue/graph/node-jobs';
import * as safeFetchModule from '../src/lib/security/safe-fetch';
import {
  PdfPostprocessError,
  InvalidPageRangeError,
  EngineUnavailableError,
} from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { getOracleToolPath, requireOracleTool } from './helpers/differential-oracle';
import { withMissingBinary } from './helpers/native-tools';
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

    it('rejects qpdf argument-file injection in permissions and passwords in both protectPdf and validateJobGraph', async () => {
      const pdf = await createSamplePdf(1);

      expect(() =>
        validatePdfProtectOptions({ userPassword: 'ok', permissions: { print: 'full\n--modify=all' as any } })
      ).toThrow(/Unsupported print permission/);
      expect(() =>
        validatePdfProtectOptions({ userPassword: 'ok', permissions: { modify: 'all\n--extract=y' as any } })
      ).toThrow(/Unsupported modify permission/);
      expect(() => validatePdfProtectOptions({ userPassword: 'a'.repeat(257) })).toThrow(/exceeds maximum length of 256/);
      expect(() => validatePdfProtectOptions({ userPassword: 'bad\npassword' })).toThrow(/invalid newline or null characters/);
      expect(() =>
        assertPdfPostProcessOptions({
          protect: { userPassword: 'ok', permissions: { print: 'full\n--modify=all' as any } },
        })
      ).toThrow(/Unsupported print permission/);

      await expect(
        protectPdf(pdf, { userPassword: 'ok', permissions: { print: 'full\n--modify=all' as any } })
      ).rejects.toThrow(PdfPostprocessError);

      const badGraphResult = validateJobGraph({
        nodes: {
          in: { op: 'import.upload', storageKey: 'uploads/doc.pdf' },
          prot: {
            op: 'pdf.protect',
            input: 'in',
            options: { protect: { userPassword: 'ok', permissions: { print: 'full\n--modify=all' as any } } },
          },
        },
      } as any);
      expect(badGraphResult.valid).toBe(false);
      expect(badGraphResult.errors.map((e) => e.message).join(' ')).toMatch(/Unsupported print permission/);

      const badConvertGraphResult = validateJobGraph({
        nodes: {
          in: { op: 'import.upload', storageKey: 'uploads/doc.docx' },
          conv: {
            op: 'convert',
            input: 'in',
            targetFormat: 'pdf',
            options: {
              libreOfficeFilter: 'MS Excel 97',
              protect: { userPassword: 'ok', permissions: { modify: 'all\n--extract=y' as any } },
            },
          },
        },
      } as any);
      expect(badConvertGraphResult.valid).toBe(false);
      expect(badConvertGraphResult.errors.map((e) => e.message).join(' ')).toMatch(/Unsupported modify permission/);
      expect(badConvertGraphResult.errors.map((e) => e.message).join(' ')).toMatch(/Unsupported LibreOffice export filter/);

      expect(getAvailableTargetFormats('__proto__')).toEqual([]);
      expect(getAvailableTargetFormats('constructor')).toEqual([]);
      const protoGraphResult = validateJobGraph({
        nodes: {
          in: { op: 'import.upload', storageKey: 'uploads/doc.pdf' },
          conv: { op: 'convert', input: 'in', sourceFormat: '__proto__', targetFormat: 'toString' },
        },
      } as any);
      expect(protoGraphResult.valid).toBe(false);
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
    oracleTest(
      'reports the verified level and a validated verdict when veraPDF validated the output',
      ['soffice', 'verapdf'],
      async () => {
        const originalPdf = await createSamplePdf(1, ['Archival Record 2026']);

        const result = await convertToPdfA(originalPdf, { conformance: 'pdfa-2b' });

        expect(result.buffer.length).toBeGreaterThan(0);
        expect(result.conformanceLevel).toBe('pdfa-2b');
        expect(result.pdfaValidated).toBe(true);
      },
      120_000
    );

    it('answers with an engine-unavailable error instead of an unvalidated file when veraPDF is absent', async () => {
      const originalPdf = await createSamplePdf(1, ['Archival Record 2026']);

      await withMissingBinary('VERAPDF_PATH', async () => {
        await expect(convertToPdfA(originalPdf, { conformance: 'pdfa-2b' })).rejects.toThrow(EngineUnavailableError);
      });
    });

    it('fails closed when input buffer is empty', async () => {
      await expect(convertToPdfA(Buffer.alloc(0))).rejects.toThrow(PdfPostprocessError);
    });
  });

  describe('4. Job Graph Node Execution Integration', () => {
    oracleTest('executes pdf.watermark and pdf.protect nodes sequentially in graph scheduler', ['pdfinfo'], async () => {
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

      // Verify that final stored artifact is encrypted with AES-256: pdfinfo opens it with the user password
      const testFile = path.join(os.tmpdir(), `graph_final_${Date.now()}.pdf`);
      fs.writeFileSync(testFile, finalStored!.buffer);
      try {
        const info = execFileSync(requireOracleTool('pdfinfo'), ['-upw', 'GraphUserPw123', testFile], { encoding: 'utf-8' });
        expect(info).toContain('Encrypted:       yes');
        expect(info).toMatch(/algorithm:AES-256/);
      } finally {
        fs.rmSync(testFile, { force: true });
      }
    });

    it('extracts .tar.gz archives in DAG archive.extract and cancels export.url response streams without buffering', async () => {
      const graphId = `graph_targz_${Date.now()}`;
      const payload = Buffer.from('hello from tar.gz', 'utf-8');
      const header = Buffer.alloc(512, 0);
      header.write('nested/hello.txt', 0, 'utf-8');
      header.write('0000644\0', 100, 'ascii');
      header.write('0000000\0', 108, 'ascii');
      header.write('0000000\0', 116, 'ascii');
      header.write(`${payload.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
      header.write('00000000000\0', 136, 'ascii');
      header.write('        ', 148, 'ascii');
      header.write('0', 156, 'ascii');
      header.write('ustar\0', 257, 'ascii');
      header.write('00', 263, 'ascii');
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += header[i];
      header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
      const dataBlock = Buffer.alloc(512, 0);
      payload.copy(dataBlock, 0);
      const tarBytes = Buffer.concat([header, dataBlock, Buffer.alloc(1024, 0)]);
      const tarGzBytes = zlib.gzipSync(tarBytes);
      const inputKey = `intermediate/${graphId}/init/bundle.tar.gz`;
      s3Storage.saveObject(inputKey, tarGzBytes, 'application/gzip', 'bundle.tar.gz');

      const extractJob: any = {
        signal: new AbortController().signal,
        data: {
          graphId,
          graphNodeId: 'extractNode',
          graphNode: {
            id: 'extractNode',
            op: 'archive.extract',
            input: [inputKey],
          },
          inputArtifacts: [inputKey],
        },
        log: async () => {},
        updateProgress: async () => {},
      };

      const extractResult = await processGraphNodeJob(extractJob, undefined, s3Storage);
      expect(extractResult.resultKey).toBe(`intermediate/${graphId}/extractNode/0/hello.txt`);
      expect(s3Storage.getObject(extractResult.resultKey)?.buffer.toString('utf-8')).toBe('hello from tar.gz');

      const cancelSpy = vi.fn(async () => undefined);
      const arrayBufferSpy = vi.fn(async () => new ArrayBuffer(0));
      const safeFetchSpy = vi.spyOn(safeFetchModule, 'safeFetch').mockResolvedValue({
        ok: true,
        status: 200,
        body: { cancel: cancelSpy },
        arrayBuffer: arrayBufferSpy,
      } as unknown as Response);

      try {
        const sealed = sealGraph(graphId, {
          nodes: {
            exportNode: {
              op: 'export.url',
              input: 'extractNode',
              url: 'https://storage.example.com/upload/hello.txt',
              method: 'PUT',
            },
          },
        });
        const exportJob: any = {
          signal: new AbortController().signal,
          data: {
            graphId,
            graphNodeId: 'exportNode',
            graphNode: sealed.nodes.exportNode,
            inputArtifacts: [extractResult.resultKey],
          },
          log: async () => {},
          updateProgress: async () => {},
        };

        await processGraphNodeJob(exportJob, undefined, s3Storage);
        expect(cancelSpy).toHaveBeenCalledTimes(1);
        expect(arrayBufferSpy).not.toHaveBeenCalled();
      } finally {
        safeFetchSpy.mockRestore();
      }
    });
  });
});
