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
import { oracleTest } from './helpers/oracle-test';
import { dxfFacts, packageFacts, parquetFacts, pdfFacts, pngFacts, sevenZipFacts, tarFacts, xpathNames, zstdFacts } from './helpers/corpus-facts';
import { compareImages } from './helpers/vrt-engine';
import { readHwpWithReference } from './helpers/hwp-reference';
import { decodeParquet } from '../src/lib/conversions/parquet';
import { parseAllXlsxWorksheets } from '../src/lib/conversions/office';
import { synthesizeGradientStressCard } from './helpers/golden-corpus-suite';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';

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

    oracleTest('1.2 creates valid signed manifest file and verifies sha256 checksums on disk', ['pdfinfo', '7z'], () => {
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
        // The integrity check ran and passed for every format that has one (raw and otf have none).
        expect(file.verified, file.name).toBe(!['raw', 'otf'].includes(file.format));
      }
    });

    oracleTest(
      '1.3 standard tools read every synthesized file and report the content it is meant to hold',
      ['pdfinfo', 'pdftotext', '7z', 'tar', 'zstd', 'identify', 'xmllint', 'python3'],
      async () => {
        const bytesOf = (name: string): Buffer => {
          const file = testManifest.files.find((candidate) => candidate.name === name);
          expect(file, name).toBeTruthy();
          return fs.readFileSync(path.resolve((file as { relativePath: string }).relativePath));
        };

        // PDF (poppler): two pages, the title and the text of both.
        expect(pdfFacts(bytesOf('differential-layout.pdf'))).toEqual({
          pages: 2,
          title: 'EasyConvert Enterprise Golden PDF Standard',
          text:
            'Enterprise High-Fidelity Differential Architecture Column A: Distributed Core Engine Column B: Differential Oracle Gate ' +
            'Zero-heap multipart chunk streaming ensures Automated cross-comparison against reference safe bounded RAM consumption. ' +
            'AST structures and SSIM/PSNR gates. Page 2: OCR Scanned Document Sandwich Simulation Recognized Text: Enterprise Scanned Document Searchable Text Layer',
        });

        // 7-Zip, tar, zstd and ImageMagick.
        expect(sevenZipFacts(bytesOf('enterprise-bundle.7z'))).toEqual({
          testPassed: true,
          entries: [
            { path: 'config.json', size: 42, crc: '0743FA30' },
            { path: 'manifest.txt', size: 55, crc: '35AFA211' },
          ],
        });
        expect(tarFacts(bytesOf('conformance-bundle.tar'))).toEqual([
          { path: 'manifest.json', size: 80 },
          { path: 'data/audit.log', size: 76 },
        ]);
        expect(zstdFacts(bytesOf('compressed-stream.zst'))).toEqual({
          testPassed: true,
          text: 'EasyConvert RFC 8878 Zstandard Golden Corpus High-Throughput Verification Stream',
        });
        expect(pngFacts(bytesOf('perceptual-stress-card.png'))).toBe('PNG 96x96 8-bit sRGB');

        // Packages: every XML part is well-formed per xmllint and the parts are the ones each format needs.
        const xlsx = await packageFacts(bytesOf('multi-sheet-enterprise.xlsx'));
        expect(xlsx.malformedParts).toEqual([]);
        expect(xlsx.entries.filter((name) => name.startsWith('xl/worksheets/'))).toEqual([
          'xl/worksheets/sheet1.xml',
          'xl/worksheets/sheet2.xml',
          'xl/worksheets/sheet3.xml',
        ]);
        expect(xpathNames(await xlsx.zip.files['xl/workbook.xml'].async('text'), "//*[local-name()='sheet']/@name")).toEqual([
          'Executive_Summary',
          'Q1_Financials',
          'Regional_Breakdown',
        ]);

        const ods = await packageFacts(bytesOf('multi-sheet-enterprise.ods'));
        expect(ods.malformedParts).toEqual([]);
        expect(ods.entries[0]).toBe('mimetype');
        expect(await ods.zip.files.mimetype.async('text')).toBe('application/vnd.oasis.opendocument.spreadsheet');

        const pptx = await packageFacts(bytesOf('drawingml-shapes-presentation.pptx'));
        expect(pptx.malformedParts).toEqual([]);
        expect(pptx.entries.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(3);

        const docx = await packageFacts(bytesOf('multi-column-annotated.docx'));
        expect(docx.malformedParts).toEqual([]);
        expect(docx.entries).toContain('word/footnotes.xml');

        // CAD text formats: group-code pairs of the DXF, the STEP cube's topology counts (V - E + F = 2).
        expect(dxfFacts(bytesOf('multi-layer-drawing.dxf').toString('utf-8'))).toEqual({
          entities: ['LINE', 'LINE', 'CIRCLE', '3DFACE', 'TEXT'],
          layers: ['0', 'STRUCTURAL_CONTOUR', 'ANNOTATIONS'],
        });
        const step = bytesOf('brep-solid.step').toString('utf-8');
        const stepCount = (entity: string) => (step.match(new RegExp(`=${entity}\\(`, 'g')) ?? []).length;
        expect([stepCount('VERTEX_POINT'), stepCount('EDGE_CURVE'), stepCount('ADVANCED_FACE')]).toEqual([8, 12, 6]);

        // Parquet (pyarrow): 60 rows of the 10 corpus columns, Snappy.
        expect(parquetFacts(bytesOf('columnar-snappy-records.parquet'))).toEqual({
          numRows: 60,
          columns: [
            'transaction_id:int64',
            'account_code:string',
            'category:string',
            'region:string',
            'amount:double',
            'tax_rate:double',
            'is_cleared:bool',
            'timestamp:int64',
            'execution_latency_ms:double',
            'notes:string',
          ],
          codec: 'SNAPPY',
        });

        // Raw sensor frame: 64 x 64 samples of 16 bits; HWP: 7-Zip opens the compound file and lists its HWP streams.
        expect(bytesOf('sensor-raw-frame.raw').length).toBe(64 * 64 * 2);
        expect(readHwpWithReference(bytesOf('enterprise-compound-document.hwp'))).toMatchObject({
          streamPaths: ['BodyText/Section0', 'DocInfo', 'FileHeader'],
          version: '5.0.3.0',
          paragraphs: [
            'HWP 5.0 Enterprise Financial & Technical Architecture Specification',
            'This document validates KS C 5601 binary stream extraction and EqEdit math transpilation.',
            'Mathematical formulations are parsed from HWPTAG_EQEDIT records into clean MathML and LaTeX representations.',
          ],
          tables: [[['Metric Name', 'Observed Value', 'Compliance Target'], ['Tessellation Delta Ratio', '0.0002', '< 0.0005'], ['Memory Shredding Cycles', '3 Passes', 'DoD 5220.22-M']]],
        });
      }
    );
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

    oracleTest('3.2 differential comparison catches structural mutation between golden and modified PDF', ['pdfinfo', 'pdftotext'], async () => {
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

    it('3.4 enforces quantitative SSIM differential oracle assertions with configurable thresholds', async () => {
      const g1 = await synthesizeGradientStressCard(64, 64);
      const g2 = await synthesizeGradientStressCard(64, 64);

      // Same images pass minSsim = 0.99
      const passReport = await runDifferentialComparison(g1, g2, 'png', { minSsim: 0.99 });
      expect(passReport.matched).toBe(true);
      expect(passReport.ssim).toBe(1.0);

      // Create a slightly perturbed image by adjusting brightness/contrast
      const perturbedPng = await sharp(g1)
        .linear(0.85, 10)
        .png()
        .toBuffer();

      // Passing with a lenient threshold
      const lenientReport = await runDifferentialComparison(perturbedPng, g1, 'png', { minSsim: 0.5 });
      expect(lenientReport.ssim).toBeDefined();
      expect(lenientReport.ssim!).toBeGreaterThan(0.5);

      // Fails when minSsim threshold is set higher than actual SSIM
      const strictReport = await runDifferentialComparison(perturbedPng, g1, 'png', { minSsim: 0.999 });
      expect(strictReport.matched).toBe(false);
      expect(strictReport.discrepancies.some((d) => d.includes('Quantitative SSIM assertion failed'))).toBe(true);
    });

    it('3.5 enforces quantitative PSNR differential oracle assertions with configurable thresholds', async () => {
      const g1 = await synthesizeGradientStressCard(64, 64);
      const g2 = await synthesizeGradientStressCard(64, 64);

      // Same images pass minPsnr = 50 dB
      const passReport = await runDifferentialComparison(g1, g2, 'png', { minPsnr: 50 });
      expect(passReport.matched).toBe(true);
      expect(passReport.psnr).toBe(Infinity);

      // Create a slightly perturbed image
      const perturbedPng = await sharp(g1)
        .linear(0.9, 5)
        .png()
        .toBuffer();

      // Fails when minPsnr threshold is set higher than actual PSNR
      const strictReport = await runDifferentialComparison(perturbedPng, g1, 'png', { minPsnr: 80 });
      expect(strictReport.matched).toBe(false);
      expect(strictReport.discrepancies.some((d) => d.includes('Quantitative PSNR assertion failed'))).toBe(true);
    });
  });
});
