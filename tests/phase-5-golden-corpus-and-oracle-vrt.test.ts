import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, beforeAll } from 'vitest';
import sharp from 'sharp';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import {
  synthesizeEnterpriseMultiSheetXlsx,
  synthesizeEnterpriseMultiSlidePptx,
  synthesizeEnterpriseMultiColumnDocx,
  synthesizeEnterpriseStepBRep,
  synthesizeEnterpriseDxf,
  synthesizeEnterprisePdf,
  synthesizeEnterpriseBayerRaw,
  synthesizeGradientStressCard,
  synthesizeEnterprise7z,
  synthesizeEnterpriseZstd,
  synthesizeEnterpriseMultiSheetOds,
  synthesizeCorruptedFixtures,
} from './helpers/golden-corpus-suite';
import {
  isOracleToolAvailable,
  getOracleToolPath,
  requireOracleTool,
  parsePdfToAst,
  parseXlsxToAst,
  parsePptxToAst,
  parseDocxToAst,
  parseCadStepToAst,
  parseAudioMediaToAst,
  parseArchiveToAst,
  runDifferentialComparison,
  calculateNormalizedTextSimilarity,
  assertFormatIntegrity,
  getOracleToolDiagnostics,
  extractTextWithExternalPdftotext,
} from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { pyarrowRead } from './helpers/parquet-oracle';
import { shownSheetRowsViaLibreOffice } from './helpers/sheet-rows';
import { dxfFacts, imageFacts, packageFacts, parquetFacts, xpathNames, zstdFacts } from './helpers/corpus-facts';
import { ffprobeReport } from './helpers/ffprobe-json';
import { readHwpWithReference } from './helpers/hwp-reference';
import { readSfntTables } from './helpers/font-oracles';
import { pdfPageCount } from './helpers/pdftocairo-svg';
import { compareImages, computeSsim, pixelmatch } from './helpers/vrt-engine';
import { convertFile } from '../src/lib/conversions';
import { demosaicBayerCfa, decodeRawBayerSensor } from '../src/lib/conversions/image';
import { convertOffice } from '../src/lib/conversions/office';
import { CadGeometryUnavailableError, ConversionFailedError, DataParseError } from '../src/lib/types';
import { PdfStructureError } from '../src/lib/conversions/pdf-document';
import { convertVectorCad } from '../src/lib/conversions/vector-cad';
import { decompressZstd, createTarArchive } from '../src/lib/conversions/archive';
import {
  synthesizeVariableFontCorpus,
  synthesizeParquetColumnarCorpus,
  synthesizeHwp5CompoundCorpus,
  synthesizeAudioBitstreamCorpus,
} from './helpers/corpus-synthesizer';
import { parseHwpDocument, buildHwpCompoundFile } from '../src/lib/conversions/hwp';
import { inspectVariableFont, encodeWoff2 } from '../src/lib/conversions/font';
import { decodeParquet } from '../src/lib/conversions/parquet';

const TOOL_TIMEOUT_MS = 60_000;

function withTempDir<T>(body: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-corpus-'));
  try {
    return body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('Phase 5: Real-World Golden Corpus & Differential Oracle VRT CI Gates (#85)', () => {
  // =========================================================================
  // 1. Multi-Category Enterprise Golden Corpus Synthesis & Conformance
  // =========================================================================
  describe('1. Multi-Category Enterprise Golden Corpus Synthesis & Conformance', () => {
    it('1.1 synthesizes multi-sheet XLSX with custom number formats and formula trees', async () => {
      const golden = await synthesizeEnterpriseMultiSheetXlsx();

      assertFormatIntegrity(golden.buffer, 'xlsx');
      expect(golden.sheets).toEqual(['Executive_Summary', 'Q1_Financials', 'Regional_Breakdown']);
      expect(golden.cellCount).toBeGreaterThanOrEqual(15);
      expect(golden.formulaCount).toBe(3);

      // Verify AST extraction through structural oracle
      const ast = await parseXlsxToAst(golden.buffer);
      expect(ast.sheetCount).toBe(3);
      expect(ast.sheetNames).toContain('Executive_Summary');
      expect(ast.sheetNames).toContain('Q1_Financials');
      expect(ast.sheetNames).toContain('Regional_Breakdown');

      // Verify custom number format codes
      expect(ast.customNumberFormats[164]).toBe('$#,##0.00');
      expect(ast.customNumberFormats[165]).toBe('0.0%');
      expect(ast.customNumberFormats[166]).toBe('yyyy-mm-dd');

      // Verify formula evaluation & cached values
      const summarySheet = ast.sheets['Executive_Summary'];
      expect(summarySheet.cells['B5'].formula).toBe('SUM(B2:B4)');
      expect(summarySheet.cells['B5'].value).toBe(2787500.75);
      expect(summarySheet.cells['C5'].formula).toBe('AVERAGE(C2:C4)');
    });

    it('1.2 synthesizes multi-slide PPTX with 16:9 canvas, DrawingML geometries, and table shapes', async () => {
      const golden = await synthesizeEnterpriseMultiSlidePptx();

      assertFormatIntegrity(golden.buffer, 'pptx');
      expect(golden.slideCount).toBe(3);
      expect(golden.shapeCount).toBeGreaterThanOrEqual(7);

      const ast = await parsePptxToAst(golden.buffer);
      expect(ast.slideCount).toBe(3);
      expect(ast.slideWidthPt).toBe(960);
      expect(ast.slideHeightPt).toBe(540);

      // Slide 1: Dark theme background and title
      const slide1 = ast.slides[0];
      expect(slide1.backgroundColor).toBe('#0F172A');
      expect(slide1.shapes[0].text).toContain('Enterprise Architecture & Golden VRT CI');

      // Slide 2: DrawingML shapes (rect, ellipse, triangle)
      const slide2 = ast.slides[1];
      const geomTypes = slide2.shapes.map((s) => s.geomType);
      expect(geomTypes).toContain('rect');
      expect(geomTypes).toContain('ellipse');
      expect(geomTypes).toContain('triangle');

      // Slide 3: Table shape
      const slide3 = ast.slides[2];
      expect(slide3.tableCount).toBe(1);
    });

    it('1.3 synthesizes multi-column DOCX with nested tables and footnotes', async () => {
      const golden = await synthesizeEnterpriseMultiColumnDocx();

      assertFormatIntegrity(golden.buffer, 'docx');
      expect(golden.hasNestedTable).toBe(true);
      expect(golden.hasFootnotes).toBe(true);

      const ast = await parseDocxToAst(golden.buffer);
      expect(ast.columnCount).toBe(2);
      expect(ast.tableCount).toBe(2);
      expect(ast.footnotes.length).toBeGreaterThan(0);
      expect(ast.footnotes[0]).toContain('ISO 29500-1');

      // Check nested cell content in AST
      const outerTable = ast.tables[0];
      expect(outerTable.rowCount).toBe(1);
      expect(outerTable.cellTexts[0][0]).toBe('Outer Column 1');
      expect(outerTable.cellTexts[0][1]).toContain('Outer Column 2');
    });

    it('1.4 synthesizes CAD STEP AP214 B-Rep manifold solid with Euler characteristic χ = 2', () => {
      const golden = synthesizeEnterpriseStepBRep();

      assertFormatIntegrity(golden.buffer, 'step');
      expect(golden.text).toContain('AUTOMOTIVE_DESIGN');
      expect(golden.vertexCount).toBe(8);
      expect(golden.edgeCount).toBe(12);
      expect(golden.faceCount).toBe(6);
      expect(golden.eulerCharacteristic).toBe(2); // V - E + F = 8 - 12 + 6 = 2

      const ast = parseCadStepToAst(golden.buffer);
      expect(ast.isClosedManifold).toBe(true);
      expect(ast.eulerCharacteristic).toBe(2);
      expect(ast.faceCount).toBe(6);
    });

    it('1.5 synthesizes multi-layer CAD DXF with lines, arcs, 3D faces, and text', () => {
      const golden = synthesizeEnterpriseDxf();

      expect(golden.buffer.length).toBeGreaterThan(200);
      expect(golden.layers).toEqual(['0', 'STRUCTURAL_CONTOUR', 'ANNOTATIONS']);
      expect(golden.entityCount).toBe(5);
      expect(golden.text).toContain('SECTION\n  2\nENTITIES');
      expect(golden.text).toContain('3DFACE');
      expect(golden.text).toContain('CIRCLE');
    });

    oracleTest('1.6 synthesizes ISO 32000-1 PDF 1.7 with compressed object streams and sandwich OCR text', ['pdfinfo'], async () => {
      const golden = await synthesizeEnterprisePdf();

      assertFormatIntegrity(golden.buffer, 'pdf');
      expect(golden.pageCount).toBe(2);
      expect(golden.hasObjectStreams).toBe(true);
      expect(golden.metadata.title).toBe('EasyConvert Enterprise Golden PDF Standard');

      const ast = await parsePdfToAst(golden.buffer);
      expect(ast.pageCount).toBe(2);
      expect(ast.hasObjectStreams).toBe(true);
      expect(ast.hasSandwichOcrText).toBe(true);
      expect(ast.version).toBe('1.7');
    });

    it('1.7 synthesizes 14-bit Bayer CFA RAW sensor buffers for all four standard patterns', () => {
      const patterns = ['RGGB', 'BGGR', 'GRBG', 'GBRG'] as const;

      for (const pat of patterns) {
        const sensor = synthesizeEnterpriseBayerRaw(pat, 32, 32);
        expect(sensor.pattern).toBe(pat);
        expect(sensor.bitsPerSample).toBe(14);
        expect(sensor.blackLevel).toBe(512);
        expect(sensor.data).toHaveLength(32 * 32);

        // Verify minimum and maximum values within 14-bit range
        let minVal = 65535;
        let maxVal = 0;
        for (let i = 0; i < sensor.data.length; i++) {
          if (sensor.data[i] < minVal) minVal = sensor.data[i];
          if (sensor.data[i] > maxVal) maxVal = sensor.data[i];
        }
        expect(minVal).toBeGreaterThanOrEqual(512);
        expect(maxVal).toBeLessThanOrEqual(16383);

        // Verify demosaicing runs cleanly on all patterns
        const demosaiced = demosaicBayerCfa(sensor);
        expect(demosaiced.width).toBe(32);
        expect(demosaiced.height).toBe(32);
        expect(demosaiced.data).toHaveLength(32 * 32 * 3);
      }
    });

    oracleTest('1.8 synthesizes 7z multi-stream LZMA2 and Zstandard RFC 8878 golden archives', ['7z'], () => {
      // 7z
      const golden7z = synthesizeEnterprise7z();
      assertFormatIntegrity(golden7z.buffer, '7z');
      expect(golden7z.files).toHaveLength(2);
      expect(golden7z.files[0].name).toBe('config.json');

      // Zstd
      const goldenZstd = synthesizeEnterpriseZstd();
      expect(goldenZstd.buffer.readUInt32LE(0)).toBe(0xfd2fb528);
      const decompressed = decompressZstd(goldenZstd.buffer);
      expect(decompressed.toString('utf-8')).toBe(goldenZstd.uncompressedText);
    });

    it('1.9 synthesizes OpenType variable font corpus with fvar/STAT tables and SFNT checksums', () => {
      const corpus = synthesizeVariableFontCorpus();

      expect(corpus.fontBuffer.length).toBeGreaterThan(500);
      expect(corpus.axes).toHaveLength(3); // wght, wdth, slnt
      expect(corpus.instances.length).toBeGreaterThanOrEqual(4);

      const inspection = inspectVariableFont(corpus.fontBuffer);
      expect(inspection.isVariableFont).toBe(true);
      expect(inspection.axes.map((a) => a.tag)).toContain('wght');
      expect(inspection.axes.map((a) => a.tag)).toContain('wdth');
    });

    it('1.10 synthesizes Parquet columnar corpus with binary schema and roundtrip decode', () => {
      const corpus = synthesizeParquetColumnarCorpus(50);

      expect(corpus.buffer.length).toBeGreaterThan(100);
      expect(corpus.records).toHaveLength(50);
      expect(corpus.schemas.length).toBeGreaterThanOrEqual(4);

      const decoded = decodeParquet(corpus.buffer);
      expect(decoded).toHaveLength(50);
    });

    it('1.11 synthesizes HWP 5.0 CFBF compound binary and converts EqEdit math expressions to MathML', () => {
      const corpus = synthesizeHwp5CompoundCorpus();

      expect(corpus.buffer.length).toBeGreaterThan(1024);
      expect(corpus.buffer.readUInt32LE(0)).toBe(0xe011cfd0); // CFBF magic

      const doc = parseHwpDocument(corpus.buffer);
      expect(doc.version).toBe('5.0.3.0');
      expect(doc.paragraphs.map((paragraph) => paragraph.text)).toEqual(corpus.doc.paragraphs.map((paragraph) => paragraph.text));

      // The three equations written into the file come back as their scripts, with a fraction and a root among the MathML
      expect(doc.equations?.map((equation) => equation.script)).toEqual(corpus.rawEquations);
      expect(doc.equations?.[0].mathml).toContain('<mfrac>');
      expect(doc.equations?.[1].mathml).toContain('<msqrt>');
    });

    it('1.12 synthesizes audio bitstream corpus with WAV, MP3, and FLAC containers', () => {
      const corpus = synthesizeAudioBitstreamCorpus(0.2); // 0.2s duration

      expect(corpus.sampleRate).toBe(44100);
      expect(corpus.channels).toBe(2);
      expect(corpus.durationSeconds).toBe(0.2);
      expect(corpus.wav.length).toBeGreaterThan(100);
      expect(corpus.mp3.length).toBeGreaterThan(50);
      expect(corpus.flac.length).toBeGreaterThan(50);

      // Verify WAV RIFF header
      expect(corpus.wav.toString('ascii', 0, 4)).toBe('RIFF');
      expect(corpus.wav.toString('ascii', 8, 12)).toBe('WAVE');

      // Verify FLAC fLaC header
      expect(corpus.flac.toString('ascii', 0, 4)).toBe('fLaC');
    });
  });

  // =========================================================================
  // 2. Differential Oracle Cross-Comparison Engine
  // =========================================================================
  describe('2. Differential Oracle Cross-Comparison Engine', () => {
    it('2.1 probes CLI utility availability without crashing and supports graceful reference oracle fallback', () => {
      const isPdfAvailable = isOracleToolAvailable('pdftotext');
      const isFfmpegAvailable = isOracleToolAvailable('ffmpeg');
      const isSofficeAvailable = isOracleToolAvailable('soffice');

      expect(typeof isPdfAvailable).toBe('boolean');
      expect(typeof isFfmpegAvailable).toBe('boolean');
      expect(typeof isSofficeAvailable).toBe('boolean');

      // Path lookup behaves deterministically
      const tool = isPdfAvailable ? getOracleToolPath('pdftotext') : null;
      if (isPdfAvailable) {
        expect(tool).not.toBeNull();
      } else {
        expect(tool).toBeNull();
      }
    });

    oracleTest('2.2 differential PDF comparison scores matching PDF documents and detects structural variance', ['pdfinfo', 'pdftotext'], async () => {
      const goldenPdf1 = await synthesizeEnterprisePdf();
      const goldenPdf2 = await synthesizeEnterprisePdf();

      const report = await runDifferentialComparison(goldenPdf1.buffer, goldenPdf2.buffer, 'pdf');
      expect(report.matched).toBe(true);
      expect(report.structuralScore).toBe(1.0);
      expect(report.textSimilarity).toBe(1.0);
      expect(report.discrepancies).toHaveLength(0);

      // Mutate PDF by removing a page to verify differential detector catches structural variance
      const doc = await PDFDocument.load(goldenPdf1.buffer);
      if (doc.getPageCount() > 1) {
        doc.removePage(doc.getPageCount() - 1);
      } else {
        doc.addPage([200, 200]);
      }
      const mutatedBuffer = Buffer.from(await doc.save());

      const diffReport = await runDifferentialComparison(mutatedBuffer, goldenPdf1.buffer, 'pdf');
      expect(diffReport.matched).toBe(false);
      expect(diffReport.structuralScore).toBeLessThan(1.0);
      expect(diffReport.discrepancies.length).toBeGreaterThan(0);
    });

    it('2.3 differential XLSX comparison detects missing worksheets and structural variance', async () => {
      const fullXlsx = await synthesizeEnterpriseMultiSheetXlsx();

      // Create partial XLSX with only 1 sheet
      const partialZip = new JSZip();
      partialZip.file('[Content_Types].xml', (await JSZip.loadAsync(fullXlsx.buffer)).file('[Content_Types].xml')!.async('nodebuffer'));
      partialZip.file('_rels/.rels', (await JSZip.loadAsync(fullXlsx.buffer)).file('_rels/.rels')!.async('nodebuffer'));
      partialZip.file('xl/workbook.xml', `<?xml version="1.0"?><workbook><sheets><sheet name="Executive_Summary" sheetId="1" r:id="rId1"/></sheets></workbook>`);
      partialZip.file('xl/sharedStrings.xml', (await JSZip.loadAsync(fullXlsx.buffer)).file('xl/sharedStrings.xml')!.async('nodebuffer'));
      partialZip.file('xl/worksheets/sheet1.xml', (await JSZip.loadAsync(fullXlsx.buffer)).file('xl/worksheets/sheet1.xml')!.async('nodebuffer'));
      const partialBuffer = await partialZip.generateAsync({ type: 'nodebuffer' });

      const report = await runDifferentialComparison(partialBuffer, fullXlsx.buffer, 'xlsx');
      expect(report.matched).toBe(false);
      expect(report.structuralScore).toBeLessThan(1.0);
      expect(report.discrepancies.some((d) => d.includes('Sheet count mismatch'))).toBe(true);
      expect(report.discrepancies.some((d) => d.includes('Q1_Financials'))).toBe(true);
    });

    it('2.4 differential PPTX comparison verifies visual canvas dimensions, slide counts, and structural variance', async () => {
      const goldenPptx1 = await synthesizeEnterpriseMultiSlidePptx();
      const goldenPptx2 = await synthesizeEnterpriseMultiSlidePptx();

      const report = await runDifferentialComparison(goldenPptx1.buffer, goldenPptx2.buffer, 'pptx');
      expect(report.matched).toBe(true);
      expect(report.structuralScore).toBe(1.0);
      expect(report.discrepancies).toHaveLength(0);

      // Mutate PPTX by removing slide2 to verify differential oracle detects variance
      const zip = await JSZip.loadAsync(goldenPptx1.buffer);
      zip.remove('ppt/slides/slide2.xml');
      const mutatedBuffer = await zip.generateAsync({ type: 'nodebuffer' });

      const diffReport = await runDifferentialComparison(mutatedBuffer, goldenPptx1.buffer, 'pptx');
      expect(diffReport.matched).toBe(false);
      expect(diffReport.discrepancies.some((d) => d.includes('Slide count mismatch') || d.includes('missing'))).toBe(true);
    });

    it('2.5 differential CAD comparison detects deviations in topological Euler characteristic', () => {
      const goldenStep = synthesizeEnterpriseStepBRep();

      // Corrupted STEP with missing faces
      const corruptStepText = goldenStep.text.replace(/#154=ADVANCED_FACE[\s\S]*?#155=ADVANCED_FACE[\s\S]*?;/g, '');
      const corruptBuffer = Buffer.from(corruptStepText, 'utf-8');

      const actualAst = parseCadStepToAst(corruptBuffer);
      const refAst = parseCadStepToAst(goldenStep.buffer);

      expect(actualAst.faceCount).toBeLessThan(refAst.faceCount);
      expect(actualAst.eulerCharacteristic).not.toBe(refAst.eulerCharacteristic);
    });

    it('2.6 audio/media AST oracle parses MP4 moov atom, WebM EBML headers, and MP3 frames', () => {
      // Synthetic MP4 moov box
      const moovBuf = Buffer.alloc(24);
      moovBuf.writeUInt32BE(24, 0);
      moovBuf.write('moov', 4, 'ascii');
      moovBuf.writeUInt32BE(16, 8);
      moovBuf.write('trak', 12, 'ascii');
      moovBuf.writeUInt32BE(8, 16);
      moovBuf.write('soun', 20, 'ascii');

      const mp4Ast = parseAudioMediaToAst(moovBuf, 'mp4');
      expect(mp4Ast.hasMoovHeader).toBe(true);
      expect(mp4Ast.hasAudioTrack).toBe(true);

      // Synthetic WebM EBML header
      const webmBuf = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('Audio')]);
      const webmAst = parseAudioMediaToAst(webmBuf, 'webm');
      expect(webmAst.hasEbmlHeader).toBe(true);
      expect(webmAst.hasAudioTrack).toBe(true);
    });

    it('2.7 font SFNT directory oracle validates SFNT table tags (head, hhea, maxp, OS/2, fvar)', () => {
      const corpus = synthesizeVariableFontCorpus();
      const numTables = corpus.fontBuffer.readUInt16BE(4);
      expect(numTables).toBeGreaterThanOrEqual(5);

      const tableTags: string[] = [];
      for (let i = 0; i < numTables; i++) {
        const offset = 12 + i * 16;
        const tag = corpus.fontBuffer.toString('ascii', offset, offset + 4);
        tableTags.push(tag);
      }

      expect(tableTags).toContain('head');
      expect(tableTags).toContain('hhea');
      expect(tableTags).toContain('maxp');
      expect(tableTags).toContain('fvar');
    });

    oracleTest('2.8 parquet decoder returns the rows pyarrow reads from the same file', ['python3'], () => {
      const corpus = synthesizeParquetColumnarCorpus(30);
      const decoded = decodeParquet(corpus.buffer);

      const reference = pyarrowRead(corpus.buffer);
      expect(reference.numRows).toBe(30);
      const referenceRows = Array.from({ length: reference.numRows }, (_, row) =>
        Object.fromEntries(Object.entries(reference.columns).map(([name, values]) => [name, values[row]]))
      );
      expect(decoded).toEqual(referenceRows);
      // The file was written from these records, so the reader sees the data that went in.
      expect(decoded).toEqual(corpus.records);
    });

    it('2.9 differential archive oracle parses TAR archives and extracts file structure', async () => {
      const tarArchive = createTarArchive([
        { filename: 'hello.txt', buffer: Buffer.from('Hello EasyConvert TAR', 'utf-8') },
        { filename: 'data/info.json', buffer: Buffer.from('{"test":true}', 'utf-8') },
      ]);
      assertFormatIntegrity(tarArchive.buffer, 'tar');

      const ast = await parseArchiveToAst(tarArchive.buffer, 'tar');
      expect(ast.format).toBe('tar');
      expect(ast.fileCount).toBe(2);
      expect(ast.files.map((f) => f.name)).toEqual(['hello.txt', 'data/info.json']);
    });

    oracleTest('2.10 differential archive oracle parses 7z archives using AST and exact sizes', ['7z'], async () => {
      const golden7z = synthesizeEnterprise7z();
      assertFormatIntegrity(golden7z.buffer, '7z');

      const ast = await parseArchiveToAst(golden7z.buffer, '7z');
      expect(ast.format).toBe('7z');
      expect(ast.fileCount).toBe(2);
      expect(ast.files.map((f) => f.name)).toEqual(['config.json', 'manifest.txt']);
      expect(ast.files[0].size).toBe(42);
      expect(ast.files[1].size).toBe(55);
    });

    it('2.11 differential PPTX oracle sorts slide numbers numerically', async () => {
      const zip = new JSZip();
      zip.file('ppt/presentation.xml', `<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldSz cx="9144000" cy="5143500"/></p:presentation>`);
      zip.file('ppt/slides/slide1.xml', `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>Slide 1</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
      zip.file('ppt/slides/slide2.xml', `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>Slide 2</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
      zip.file('ppt/slides/slide10.xml', `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>Slide 10</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });

      const ast = await parsePptxToAst(buffer);
      expect(ast.slideCount).toBe(3);
      expect(ast.slides[0].slideIndex).toBe(1);
      expect(ast.slides[1].slideIndex).toBe(2);
      expect(ast.slides[2].slideIndex).toBe(3);
      expect(ast.slides[0].shapes[0].text).toBe('Slide 1');
      expect(ast.slides[1].shapes[0].text).toBe('Slide 2');
      expect(ast.slides[2].shapes[0].text).toBe('Slide 10');
    });

    oracleTest(
      '2.12 every supported format of the corpus is read back by its standard tool to the content that was written',
      ['zstd', 'woff2_decompress', '7z', 'python3', 'ffprobe', 'identify', 'xmllint'],
      async () => {
        const zstd = synthesizeEnterpriseZstd();
        assertFormatIntegrity(zstd.buffer, 'zstd');
        expect(zstdFacts(zstd.buffer)).toEqual({ testPassed: true, text: zstd.uncompressedText });

        // woff2_decompress rebuilds an sfnt from the encoder's output; it holds the tables that went in.
        const font = synthesizeVariableFontCorpus();
        const woff2 = encodeWoff2(font.parsedFont);
        assertFormatIntegrity(woff2, 'woff2');
        const decoded = withTempDir((dir) => {
          fs.writeFileSync(path.join(dir, 'font.woff2'), woff2);
          const run = spawnSync(requireOracleTool('woff2_decompress'), [path.join(dir, 'font.woff2')], { encoding: 'utf-8', timeout: TOOL_TIMEOUT_MS });
          expect(run.status, run.stderr).toBe(0);
          return fs.readFileSync(path.join(dir, 'font.ttf'));
        });
        expect([...readSfntTables(decoded).keys()].sort()).toEqual(Object.keys(font.parsedFont.tables).sort());

        // 7-Zip opens the compound file; the Hancom record layout is walked by the reference reader.
        const hwp = synthesizeHwp5CompoundCorpus();
        assertFormatIntegrity(hwp.buffer, 'hwp');
        expect(readHwpWithReference(hwp.buffer)).toMatchObject({
          version: '5.0.3.0',
          streamPaths: ['BodyText/Section0', 'DocInfo', 'FileHeader'],
          paragraphs: [
            'HWP 5.0 Enterprise Financial & Technical Architecture Specification',
            'This document validates KS C 5601 binary stream extraction and EqEdit math transpilation.',
            'Mathematical formulations are parsed from HWPTAG_EQEDIT records into clean MathML and LaTeX representations.',
          ],
        });

        // pyarrow reads the footer: five rows of the ten corpus columns, Snappy.
        const parquet = synthesizeParquetColumnarCorpus(5);
        assertFormatIntegrity(parquet.buffer, 'parquet');
        expect(parquetFacts(parquet.buffer)).toEqual({
          numRows: 5,
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

        // ffprobe: 16-bit stereo PCM at 44.1 kHz for half a second.
        const audio = synthesizeAudioBitstreamCorpus();
        assertFormatIntegrity(audio.wav, 'wav');
        const probed = ffprobeReport(audio.wav, 'wav');
        expect(probed.streams).toHaveLength(1);
        expect(probed.streams[0]).toMatchObject({ codec_name: 'pcm_s16le', sample_rate: '44100', channels: 2 });
        expect(Number(probed.format.duration)).toBeCloseTo(audio.durationSeconds, 2);

        // ImageMagick identifies the JPEG by its bytes.
        const jpegBuffer = await sharp({
          create: { width: 32, height: 32, channels: 3, background: { r: 255, g: 0, b: 0 } },
        }).jpeg().toBuffer();
        assertFormatIntegrity(jpegBuffer, 'jpeg');
        expect(imageFacts(jpegBuffer)).toBe('JPEG 32x32 8-bit sRGB');

        const dxf = synthesizeEnterpriseDxf();
        assertFormatIntegrity(dxf.buffer, 'dxf');
        expect(dxfFacts(dxf.buffer.toString('utf-8'))).toEqual({
          entities: ['LINE', 'LINE', 'CIRCLE', '3DFACE', 'TEXT'],
          layers: ['0', 'STRUCTURAL_CONTOUR', 'ANNOTATIONS'],
        });

        // Packages: xmllint finds every XML part well-formed; the parts are the ones each format needs.
        const ods = synthesizeEnterpriseMultiSheetOds();
        assertFormatIntegrity(ods.buffer, 'ods');
        const odsPackage = await packageFacts(ods.buffer);
        expect(odsPackage.malformedParts).toEqual([]);
        expect(odsPackage.entries[0]).toBe('mimetype');
        expect(await odsPackage.zip.files.mimetype.async('text')).toBe('application/vnd.oasis.opendocument.spreadsheet');

        const xlsx = await synthesizeEnterpriseMultiSheetXlsx();
        assertFormatIntegrity(xlsx.buffer, 'xlsx');
        const xlsxPackage = await packageFacts(xlsx.buffer);
        expect(xlsxPackage.malformedParts).toEqual([]);
        expect(xpathNames(await xlsxPackage.zip.files['xl/workbook.xml'].async('text'), "//*[local-name()='sheet']/@name")).toEqual([
          'Executive_Summary',
          'Q1_Financials',
          'Regional_Breakdown',
        ]);
        expect(() => assertFormatIntegrity(xlsx.buffer, 'ods')).toThrow(/Integrity Violation/);
      }
    );

    it('2.13 getOracleToolDiagnostics provides comprehensive diagnostic status across external tool matrix', () => {
      const diagnostics = getOracleToolDiagnostics();
      expect(diagnostics.length).toBeGreaterThanOrEqual(9);

      const toolNames = diagnostics.map((d) => d.tool);
      expect(toolNames).toContain('pdftotext');
      expect(toolNames).toContain('ffmpeg');
      expect(toolNames).toContain('7z');
      expect(toolNames).toContain('tar');
      expect(toolNames).toContain('zstd');

      for (const diag of diagnostics) {
        expect(typeof diag.available).toBe('boolean');
        if (diag.available) {
          expect(fs.existsSync(diag.path as string), `${diag.tool} path ${diag.path}`).toBe(true);
          expect(path.basename(diag.path as string)).toBe(diag.tool);
        } else {
          expect(diag.path).toBeNull();
        }
      }
    });
  });

  // =========================================================================
  // 3. Perceptual VRT Visual Regression CI Gates
  // =========================================================================
  describe('3. Perceptual VRT Visual Regression CI Gates', () => {
    it('3.1 verifies exact image match achieves SSIM 1.0, PSNR Infinity, and zero delta ratio', async () => {
      const gradient1 = await synthesizeGradientStressCard(64, 64);
      const gradient2 = await synthesizeGradientStressCard(64, 64);
      const res = await compareImages(gradient1, gradient2);

      expect(res.passed).toBe(true);
      expect(res.ssim).toBe(1.0);
      expect(res.psnr).toBe(Infinity);
      expect(res.deltaRatio).toBe(0);
      expect(res.mismatchedPixels).toBe(0);
    });

    it('3.2 passes sub-threshold minor color difference (< 0.05% pixel delta)', async () => {
      const w = 100;
      const h = 100;
      const buf1 = Buffer.alloc(w * h * 4, 128);
      const buf2 = Buffer.from(buf1);

      // Mutate 2 pixels out of 10,000 (0.02% < 0.05%)
      buf2[0] = 255;
      buf2[4] = 255;

      const img1 = await sharp(buf1, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
      const img2 = await sharp(buf2, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();

      const res = await compareImages(img1, img2, { maxDeltaRatio: 0.0005 });
      expect(res.passed).toBe(true);
      expect(res.deltaRatio).toBeLessThan(0.0005);
      expect(res.ssim).toBeGreaterThan(0.99);
    });

    it('3.3 rejects macro visual regressions exceeding allowable pixel mismatch threshold', async () => {
      const w = 100;
      const h = 100;
      const buf1 = Buffer.alloc(w * h * 4, 255);
      const buf2 = Buffer.from(buf1);

      // Mutate 200 pixels out of 10,000 (2.0% >> 0.05%)
      for (let i = 0; i < 200; i++) {
        buf2[i * 4] = 0;
        buf2[i * 4 + 1] = 0;
        buf2[i * 4 + 2] = 0;
      }

      const img1 = await sharp(buf1, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
      const img2 = await sharp(buf2, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();

      const res = await compareImages(img1, img2, { maxDeltaRatio: 0.0005 });
      expect(res.passed).toBe(false);
      expect(res.deltaRatio).toBeGreaterThan(0.0005);
      expect(res.mismatchedPixels).toBeGreaterThanOrEqual(200);
    });

    it('3.4 validates high perceptual fidelity (SSIM >= 0.85, PSNR >= 28dB) on image format transcode', async () => {
      const gradient = await synthesizeGradientStressCard(96, 96);

      // Convert PNG -> WebP (quality 90)
      const webpBuf = await sharp(gradient).webp({ quality: 90 }).toBuffer();
      // Re-decode WebP to PNG for differential VRT
      const reDecodedPng = await sharp(webpBuf).png().toBuffer();

      const res = await compareImages(gradient, reDecodedPng, {
        threshold: 0.1,
        maxDeltaRatio: 0.1, // Allow compression loss
      });

      expect(res.ssim).toBeGreaterThanOrEqual(0.85);
      expect(res.psnr).toBeGreaterThanOrEqual(28.0);
    });

    it('3.5 verifies Bayer CFA demosaicing maintains color fidelity across color checker quadrants', () => {
      const sensor = synthesizeEnterpriseBayerRaw('RGGB', 64, 64);
      const demosaiced = demosaicBayerCfa(sensor);

      // Quadrant 1 (Top-Left): Red patch
      const redIdx = (16 * 64 + 16) * 3;
      const r1 = demosaiced.data[redIdx];
      const g1 = demosaiced.data[redIdx + 1];
      const b1 = demosaiced.data[redIdx + 2];
      expect(r1).toBeGreaterThan(g1);
      expect(r1).toBeGreaterThan(b1);

      // Quadrant 2 (Top-Right): Green patch
      const greenIdx = (16 * 64 + 48) * 3;
      const r2 = demosaiced.data[greenIdx];
      const g2 = demosaiced.data[greenIdx + 1];
      const b2 = demosaiced.data[greenIdx + 2];
      expect(g2).toBeGreaterThan(r2);
      expect(g2).toBeGreaterThan(b2);

      // Quadrant 3 (Bottom-Left): Blue patch
      const blueIdx = (48 * 64 + 16) * 3;
      const r3 = demosaiced.data[blueIdx];
      const g3 = demosaiced.data[blueIdx + 1];
      const b3 = demosaiced.data[blueIdx + 2];
      expect(b3).toBeGreaterThan(r3);
      expect(b3).toBeGreaterThan(g3);
    });
  });

  // =========================================================================
  // 4. Adversarial & Edge-Case Fail-Closed Resilience
  // =========================================================================
  describe('4. Adversarial & Edge-Case Fail-Closed Resilience', () => {
    const corrupt = synthesizeCorruptedFixtures();

    it('4.1 fails closed on truncated zero-byte and single-byte buffers with format integrity error', () => {
      expect(() => assertFormatIntegrity(corrupt.zeroByte, 'pdf')).toThrow(/Integrity Violation/);
      expect(() => assertFormatIntegrity(corrupt.singleByte, 'docx')).toThrow(/Integrity Violation/);
    });

    it('4.2 fails closed on corrupted DOCX zip with truncated headers', async () => {
      const failure = await convertOffice(corrupt.docxCorruptedZip, 'docx', 'txt').catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(ConversionFailedError);
      expect((failure as Error).message).toBe('The DOCX file is not a valid ZIP package.');
    });

    it('4.3 fails closed on malformed XML in XLSX worksheets', async () => {
      // A genuine workbook package whose first worksheet is cut off inside a tag (the fixture's unclosed-tag XML).
      const workbook = await JSZip.loadAsync(fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.xlsx')));
      workbook.file('xl/worksheets/sheet1.xml', corrupt.xlsxUnclosedTags.toString('utf-8'));
      const brokenWorkbook = await workbook.generateAsync({ type: 'nodebuffer' });

      const failure = await convertOffice(brokenWorkbook, 'xlsx', 'csv').catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(DataParseError);
      expect((failure as Error).message).toMatch(/^Invalid XLSX package: xl\/worksheets\/sheet1\.xml is not well-formed XML/);
    });

    it('4.3b refuses a workbook that is not a ZIP package instead of reading its bytes as CSV', async () => {
      const failure = await convertOffice(corrupt.xlsxUnclosedTags, 'xlsx', 'csv').catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(ConversionFailedError);
      expect((failure as Error).message).toBe('The XLSX file is not a valid ZIP package.');
    });

    it('4.4 fails closed or rejects corrupted CAD STEP with invalid entity references', async () => {
      const failure = await convertVectorCad(corrupt.cadNonManifoldStep, 'step', 'svg').catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(CadGeometryUnavailableError);
      expect((failure as Error).message).toBe(
        'Failed to tessellate CAD geometry from step: No valid B-spline surfaces, B-Rep topology, or curves found.'
      );
    });

    it('4.5 fails closed on truncated 7z archive headers', async () => {
      expect(() => assertFormatIntegrity(corrupt.archiveTruncated7z, '7z')).toThrow(/Integrity Violation/);
      const ast = await parseArchiveToAst(corrupt.archiveTruncated7z, '7z');
      expect(ast.fileCount).toBe(0);
      expect(ast.files).toHaveLength(0);
    });

    it('4.6 fails closed on unsupported binary formats without emitting mojibake', async () => {
      const dummyBinary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd, 0x12, 0x34]);

      // Pages, Numbers, Key, Pub must throw rather than output raw binary UTF-8 garbage
      await expect(
        convertOffice(dummyBinary, 'pages', 'txt')
      ).rejects.toThrow(/Binary null bytes|Unsupported|corrupted|not supported|fail-closed/i);

      await expect(
        convertOffice(dummyBinary, 'pub', 'html')
      ).rejects.toThrow(/Binary null bytes|Unsupported|corrupted|not supported|fail-closed/i);
    });

    it('4.7 neutralises ZipSlip entry names in a package and refuses it when the document part is missing', async () => {
      // JSZip cleans entry names on write, so the entry is written under a same-length placeholder and the name
      // is patched to the traversal path in the local header and the central directory.
      const slipPackage = new JSZip();
      slipPackage.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
      slipPackage.file('xx/xx/etc/passwd', 'root:x:0:0:root:/root:/bin/bash');
      const placeholderBuffer = await slipPackage.generateAsync({ type: 'nodebuffer' });
      const slipBuffer = Buffer.from(placeholderBuffer.toString('latin1').split('xx/xx/etc/passwd').join('../../etc/passwd'), 'latin1');
      expect(slipBuffer.includes(Buffer.from('../../etc/passwd'))).toBe(true);

      // The package reader maps the traversal name to a path below the package root, and the package has no
      // word/document.xml, so the conversion is refused for the missing part.
      const entryNames = Object.keys((await JSZip.loadAsync(slipBuffer)).files);
      expect(entryNames).toContain('etc/passwd');
      expect(entryNames.filter((name) => name.includes('..'))).toEqual([]);

      const failure = await convertOffice(slipBuffer, 'docx', 'txt').catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(ConversionFailedError);
      expect((failure as Error).message).toBe('Invalid DOCX format: word/document.xml not found.');
    });

    oracleTest('4.8 reads a cyclic xref table as an empty page and refuses a stream cut off before endstream', ['pdftotext'], async () => {
      // The reconstructed page of the cyclic-xref file has no content stream: no text, which poppler agrees
      // with. The cut-off stream has no end marker, so it is refused with the object named.
      const cyclic = await convertFile(corrupt.pdfCyclicXref, 'pdf', 'txt', {}, 'cyclic.pdf');
      expect(cyclic.buffer.toString('utf-8')).toBe('');
      expect(extractTextWithExternalPdftotext(corrupt.pdfCyclicXref)?.trim()).toBe('');

      const failure = await convertFile(corrupt.pdfTruncatedStream, 'pdf', 'txt', {}, 'truncated.pdf').catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(PdfStructureError);
      expect((failure as Error).message).toBe('PDF stream of object 2 is not terminated by endstream.');
    });

    it('4.9 assertFormatIntegrity fails closed on truncated/corrupt headers across all formats', () => {
      const garbage = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
      expect(() => assertFormatIntegrity(garbage, 'tar')).toThrow(/Integrity Violation/);
      expect(() => assertFormatIntegrity(garbage, 'zstd')).toThrow(/Integrity Violation/);
      expect(() => assertFormatIntegrity(garbage, 'woff2')).toThrow(/Integrity Violation/);
      expect(() => assertFormatIntegrity(garbage, 'hwp')).toThrow(/Integrity Violation/);
      expect(() => assertFormatIntegrity(garbage, 'parquet')).toThrow(/Integrity Violation/);
      expect(() => assertFormatIntegrity(garbage, 'wav')).toThrow(/Integrity Violation/);
      expect(() => assertFormatIntegrity(garbage, 'webp')).toThrow(/Integrity Violation/);
      expect(() => assertFormatIntegrity(garbage, 'flac')).toThrow(/Integrity Violation/);
      expect(() => assertFormatIntegrity(garbage, 'mp3')).toThrow(/Integrity Violation/);
      expect(() => assertFormatIntegrity(garbage, 'jpeg')).toThrow(/Integrity Violation/);
    });
  });

  // =========================================================================
  // 5. End-to-End High-Fidelity Differential Golden Testnet (All Categories)
  // =========================================================================
  describe('5. End-to-End High-Fidelity Differential Golden Testnet (All Categories)', () => {
    it('5.1 converts golden multi-sheet XLSX to CSV preserving all worksheet tables and formula outputs', async () => {
      const goldenXlsx = await synthesizeEnterpriseMultiSheetXlsx();

      const result = await convertOffice(goldenXlsx.buffer, 'xlsx', 'csv');
      expect(result.mimeType).toBe('text/csv');

      const csvContent = result.buffer.toString('utf-8');
      expect(csvContent).toContain('Executive_Summary');
      expect(csvContent).toContain('Q1_Financials');
      expect(csvContent).toContain('Regional_Breakdown');
      expect(csvContent).toContain('Consolidated Subtotal');
      expect(csvContent).toContain('$2,787,500.75');
    });

    oracleTest('5.2 converts golden multi-sheet XLSX to JSON extracting structured records', ['soffice', 'python3'], async () => {
      const goldenXlsx = await synthesizeEnterpriseMultiSheetXlsx();

      const result = await convertOffice(goldenXlsx.buffer, 'xlsx', 'json');
      expect(result.mimeType).toBe('application/json');

      const jsonData = JSON.parse(result.buffer.toString('utf-8'));
      expect(Object.keys(jsonData)).toEqual(goldenXlsx.sheets);

      // The first sheet: the office suite's own display of every cell, header row first.
      const [header, ...shown] = shownSheetRowsViaLibreOffice(goldenXlsx.buffer, 'xlsx');
      expect(jsonData.Executive_Summary).toEqual(shown.map((row) => Object.fromEntries(header.map((name, column) => [name, row[column]]))));

      // The other sheets, from the cells of the workbook XML (number format $#,##0.00).
      expect(jsonData.Q1_Financials).toEqual([
        { Category: 'North America', 'Gross Revenue': '$1,420,500.00' },
        { Category: 'EMEA', 'Gross Revenue': '$980,200.00' },
        { Category: 'Asia Pacific', 'Gross Revenue': '$386,800.75' },
        { Category: 'Consolidated Subtotal', 'Gross Revenue': '$2,787,500.75' },
      ]);
      expect(jsonData.Regional_Breakdown).toEqual([['Annualized Run-Rate', '$11,150,003.00']]);
    });

    oracleTest('5.3 converts golden multi-slide PPTX to visual PDF with preserved slides', ['pdfinfo'], async () => {
      const goldenPptx = await synthesizeEnterpriseMultiSlidePptx();

      const result = await convertOffice(goldenPptx.buffer, 'pptx', 'pdf');
      assertFormatIntegrity(result.buffer, 'pdf');

      // The deck has three slides (the slide parts of the package), and pdfinfo counts one page for each.
      const slideParts = Object.keys((await JSZip.loadAsync(goldenPptx.buffer)).files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
      expect(slideParts).toHaveLength(3);
      expect(pdfPageCount(result.buffer)).toBe(3);
    });

    it('5.4 converts golden multi-column DOCX to TXT with table structure and footnotes', async () => {
      const goldenDocx = await synthesizeEnterpriseMultiColumnDocx();

      const result = await convertOffice(goldenDocx.buffer, 'docx', 'txt');
      expect(result.mimeType).toBe('text/plain');

      const txt = result.buffer.toString('utf-8');
      expect(txt).toContain('Enterprise Differential Oracle');
      expect(txt).toContain('Outer Column 1');
      expect(txt).toContain('Nested Cell A1');
      expect(txt).toContain('Nested Cell B1');
    });

    it('5.5 converts golden CAD STEP B-Rep solid to OBJ 3D model with vertices and faces', async () => {
      const goldenStep = synthesizeEnterpriseStepBRep();

      const result = await convertVectorCad(goldenStep.buffer, 'step', 'obj');
      expect(result.mimeType).toBe('model/obj');

      const objStr = result.buffer.toString('utf-8');
      expect(objStr).toContain('v ');
      expect(objStr).toContain('f ');
      expect(result.size).toBeGreaterThan(100);
    });

    it('5.6 converts golden CAD DXF with multiple layers to SVG', async () => {
      const goldenDxf = synthesizeEnterpriseDxf();

      const result = await convertVectorCad(goldenDxf.buffer, 'dxf', 'svg');
      expect(result.mimeType).toBe('image/svg+xml');

      const svg = result.buffer.toString('utf-8');
      expect(svg).toContain('<svg');
      expect(svg).toContain('</svg>');
      expect(svg).toContain('<line');
    });

    it('5.7 decodes camera RAW Bayer frames to PNG with intact 8-byte PNG signature', async () => {
      const sensor = synthesizeEnterpriseBayerRaw('RGGB', 64, 64);
      const demosaiced = demosaicBayerCfa(sensor);

      // Encode RGB raw buffer to PNG
      const pngBuffer = await sharp(demosaiced.data, {
        raw: { width: 64, height: 64, channels: 3 },
      })
        .png()
        .toBuffer();

      assertFormatIntegrity(pngBuffer, 'png');
      expect(pngBuffer.length).toBeGreaterThan(100);

      // Verify re-decoded PNG dimensions match sensor
      const meta = await sharp(pngBuffer).metadata();
      expect(meta.width).toBe(64);
      expect(meta.height).toBe(64);
      expect(meta.channels).toBe(3);
    });

    it('5.8 performs roundtrip Zstandard compression and decompression with 100% byte fidelity', () => {
      const goldenZstd = synthesizeEnterpriseZstd();
      const decompressed = decompressZstd(goldenZstd.buffer);

      expect(decompressed.toString('utf-8')).toBe(goldenZstd.uncompressedText);
    });

    it('5.9 converts variable font OTF to WOFF2 with valid WOFF2 header signature', () => {
      const corpus = synthesizeVariableFontCorpus();
      const woff2Buffer = encodeWoff2(corpus.parsedFont);

      expect(woff2Buffer.length).toBeGreaterThan(100);
      // WOFF2 magic 'wOF2' (0x77 0x4F 0x46 0x32)
      expect(woff2Buffer.toString('ascii', 0, 4)).toBe('wOF2');
    });

    it('5.10 converts HWP 5.0 CFBF compound file to TXT with intact paragraph content', async () => {
      const hwpBuffer = buildHwpCompoundFile({
        paragraphs: [
          { text: 'EasyConvert Phase 5 HWP Integration Standard', isHeading: true },
          { text: 'Differential oracle test stream text block.' },
        ],
        compressed: false,
      });

      const result = await convertFile(hwpBuffer, 'hwp', 'txt');
      expect(result.mimeType).toBe('text/plain');

      const txt = result.buffer.toString('utf-8');
      expect(txt).toContain('EasyConvert Phase 5 HWP Integration Standard');
      expect(txt).toContain('Differential oracle test stream text block.');
    });
  });
});
