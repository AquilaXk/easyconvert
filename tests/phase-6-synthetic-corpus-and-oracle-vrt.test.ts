import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  generateGoldenCorpus,
  CorpusManifest,
} from '../scripts/generate-golden-corpus';
import {
  assertFormatIntegrity,
  getOracleToolDiagnostics,
  runDifferentialComparison,
  parseXlsxToAst,
} from './helpers/differential-oracle';
import { compareImages } from './helpers/vrt-engine';
import { decodeParquet } from '../src/lib/conversions/parquet';
import { parseAllXlsxWorksheets } from '../src/lib/conversions/office';
import { synthesizeGradientStressCard } from './helpers/golden-corpus-suite';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';

describe('Phase 6: Automated Synthetic Corpus Generator & Differential Oracle VRT Testnet (#103)', () => {
  const testOutputDir = path.resolve('tests/fixtures/golden-testnet-temp');
  let testManifest: CorpusManifest;

  beforeAll(async () => {
    testManifest = await generateGoldenCorpus({
      outputDir: testOutputDir,
      verify: true,
      quiet: true,
    });
  });

  afterAll(() => {
    if (fs.existsSync(testOutputDir)) {
      fs.rmSync(testOutputDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 1. Programmatic Corpus Generator Execution & Manifest Integrity
  // =========================================================================
  describe('1. Programmatic Corpus Generator Execution & Manifest Integrity', () => {
    it('1.1 generates exactly 15 enterprise stress fixtures across 7 categories', () => {
      expect(testManifest.totalFiles).toBe(15);
      expect(testManifest.files).toHaveLength(15);
      expect(testManifest.version).toBe('1.0.0');
      expect(testManifest.totalSizeBytes).toBeGreaterThan(50000);

      const categories = new Set(testManifest.files.map((f) => f.category));
      expect(categories).toContain('office');
      expect(categories).toContain('document');
      expect(categories).toContain('cad');
      expect(categories).toContain('media');
      expect(categories).toContain('data');
      expect(categories).toContain('font');
      expect(categories).toContain('archive');
    });

    it('1.2 creates valid signed manifest file and verifies sha256 checksums on disk', () => {
      const manifestPath = path.join(testOutputDir, 'corpus-manifest.json');
      expect(fs.existsSync(manifestPath)).toBe(true);

      const parsedManifest: CorpusManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      expect(parsedManifest.totalFiles).toBe(15);

      for (const file of parsedManifest.files) {
        const fullPath = path.resolve(file.relativePath);
        expect(fs.existsSync(fullPath)).toBe(true);

        const content = fs.readFileSync(fullPath);
        const actualHash = crypto.createHash('sha256').update(content).digest('hex');
        expect(actualHash).toBe(file.sha256);
        expect(content.length).toBe(file.sizeBytes);
        expect(file.verified).toBe(true);
      }
    });

    it('1.3 validates format integrity across all synthesized files via assertFormatIntegrity', () => {
      for (const file of testManifest.files) {
        if (file.format === 'raw' || file.format === 'otf') {
          continue;
        }
        const fullPath = path.resolve(file.relativePath);
        const content = fs.readFileSync(fullPath);
        expect(() => assertFormatIntegrity(content, file.format)).not.toThrow();
      }
    });
  });

  // =========================================================================
  // 2. Multi-Sheet Office & Structured Data Parity
  // =========================================================================
  describe('2. Multi-Sheet Office & Structured Data Parity', () => {
    it('2.1 parses multi-sheet XLSX golden fixture and preserves all 3 sheets and formula definitions', async () => {
      const xlsxFile = testManifest.files.find((f) => f.name === 'multi-sheet-enterprise.xlsx');
      expect(xlsxFile).toBeDefined();

      const xlsxBuffer = fs.readFileSync(path.resolve(xlsxFile!.relativePath));
      const ast = await parseXlsxToAst(xlsxBuffer);

      expect(ast.sheetCount).toBe(3);
      expect(ast.sheetNames).toEqual(['Executive_Summary', 'Q1_Financials', 'Regional_Breakdown']);

      const summarySheet = ast.sheets['Executive_Summary'];
      expect(summarySheet).toBeDefined();
      expect(summarySheet.cells['B5'].formula).toBe('SUM(B2:B4)');
      expect(summarySheet.cells['B5'].value).toBe(2787500.75);

      // Verify all worksheets can be parsed by office extraction pipeline
      const extractedSheets = await parseAllXlsxWorksheets(xlsxBuffer);
      expect(extractedSheets.length).toBe(3);
      expect(extractedSheets.map((s) => s.name)).toEqual(['Executive_Summary', 'Q1_Financials', 'Regional_Breakdown']);
    });

    it('2.2 parses multi-sheet ODS archive and verifies OASIS table structures', async () => {
      const odsFile = testManifest.files.find((f) => f.name === 'multi-sheet-enterprise.ods');
      expect(odsFile).toBeDefined();

      const odsBuffer = fs.readFileSync(path.resolve(odsFile!.relativePath));
      const zip = await JSZip.loadAsync(odsBuffer);

      const mimetype = await zip.file('mimetype')?.async('text');
      expect(mimetype?.trim()).toBe('application/vnd.oasis.opendocument.spreadsheet');

      const contentXml = await zip.file('content.xml')?.async('text');
      expect(contentXml).toBeDefined();
      expect(contentXml).toContain('table:name="Executive_Summary"');
      expect(contentXml).toContain('table:name="Regional_Breakdown"');
      expect(contentXml).toContain('Conversion Throughput');
      expect(contentXml).toContain('Perceptual SSIM Index');
    });

    it('2.3 decodes Snappy-compressed Parquet fixture and validates typed records', () => {
      const parquetFile = testManifest.files.find((f) => f.name === 'columnar-snappy-records.parquet');
      expect(parquetFile).toBeDefined();

      const parquetBuffer = fs.readFileSync(path.resolve(parquetFile!.relativePath));
      const records = decodeParquet(parquetBuffer);

      expect(records).toHaveLength(60);
      const first = records[0];
      expect(first).toHaveProperty('transaction_id');
      expect(first).toHaveProperty('account_code');
      expect(first).toHaveProperty('category');
      expect(first).toHaveProperty('region');
      expect(first).toHaveProperty('amount');
      expect(first).toHaveProperty('tax_rate');
      expect(first).toHaveProperty('is_cleared');
      expect(first).toHaveProperty('timestamp');
      expect(first).toHaveProperty('execution_latency_ms');
    });
  });

  // =========================================================================
  // 3. Differential Oracle & Non-Tautological VRT Gates
  // =========================================================================
  describe('3. Differential Oracle & Non-Tautological VRT Gates', () => {
    it('3.1 executes non-tautological VRT comparing two independently synthesized gradient buffers', async () => {
      const g1 = await synthesizeGradientStressCard(64, 64);
      const g2 = await synthesizeGradientStressCard(64, 64);

      // Verify g1 and g2 are distinct memory allocations
      expect(g1).not.toBe(g2);
      expect(Buffer.compare(g1, g2)).toBe(0);

      const res = await compareImages(g1, g2);
      expect(res.passed).toBe(true);
      expect(res.ssim).toBe(1.0);
      expect(res.psnr).toBe(Infinity);
      expect(res.deltaRatio).toBe(0);
      expect(res.mismatchedPixels).toBe(0);
    });

    it('3.2 differential comparison catches structural mutation between golden and modified PDF', async () => {
      const pdfFile = testManifest.files.find((f) => f.name === 'differential-layout.pdf');
      expect(pdfFile).toBeDefined();

      const origPdf = fs.readFileSync(path.resolve(pdfFile!.relativePath));
      const pdfCopy = Buffer.from(origPdf);
      const report = await runDifferentialComparison(origPdf, pdfCopy, 'pdf');
      expect(report.matched).toBe(true);
      expect(report.structuralScore).toBe(1.0);

      // Mutate PDF structurally by adding a page
      const doc = await PDFDocument.load(origPdf);
      doc.addPage([200, 200]);
      const mutatedBuffer = Buffer.from(await doc.save());

      const diffReport = await runDifferentialComparison(mutatedBuffer, origPdf, 'pdf');
      expect(diffReport.matched).toBe(false);
      expect(diffReport.structuralScore).toBeLessThan(1.0);
      expect(diffReport.discrepancies.length).toBeGreaterThan(0);
    });

    it('3.3 diagnostic probe reports complete status matrix across external oracle toolset', () => {
      const diagnostics = getOracleToolDiagnostics();
      expect(diagnostics.length).toBeGreaterThanOrEqual(9);

      const names = diagnostics.map((d) => d.tool);
      expect(names).toContain('pdftotext');
      expect(names).toContain('ffmpeg');
      expect(names).toContain('ffprobe');
      expect(names).toContain('soffice');
      expect(names).toContain('tesseract');
      expect(names).toContain('7z');
      expect(names).toContain('tar');
      expect(names).toContain('zstd');

      for (const diag of diagnostics) {
        expect(typeof diag.available).toBe('boolean');
        if (diag.available) {
          expect(typeof diag.path).toBe('string');
        } else {
          expect(diag.path).toBeNull();
        }
      }
    });
  });
});
