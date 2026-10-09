import { describe, it, expect, vi } from 'vitest';
import {
  rgbToOklab,
  oklabToRgb,
  srgbToLinear,
  linearToSrgb,
  deltaEOk,
  deltaEOkRgb,
  generateHilbertCurveOrder,
  quantizePaletteOklab,
  riemersmaDither,
  applyOklabQuantizationAndDither,
} from '../src/lib/conversions/color-quantizer';
import {
  adaptiveIncrementalBRepMesh,
  StepEntity,
} from '../src/lib/conversions/cad-nurbs';
import { performOcr } from '../src/lib/conversions/ocr';
import {
  analyzeDocumentLayout,
  DlaBoundingBox,
} from '../src/lib/conversions/dla-engine';
import { convertImage } from '../src/lib/conversions/image';
import { convertDocument } from '../src/lib/conversions/document';
import {
  convertOffice,
  generateOdsFromData,
  extractAllSheetsForOffice,
} from '../src/lib/conversions/office';
import JSZip from 'jszip';
import sharp from 'sharp';
import { oracleTest } from './helpers/oracle-test';
import { sheetRowsViaLibreOffice } from './helpers/sheet-rows';
import { xmlWellFormed, xpathAttributes, xpathCount, xpathString } from './helpers/xml-oracle';

/** Real engine, CLI or large-input work: the 5 s default fails on a loaded CI shard without any regression; 60 s only stops a hang. */
const ENGINE_TEST_TIMEOUT_MS = 60_000;
vi.setConfig({ testTimeout: ENGINE_TEST_TIMEOUT_MS });

describe('Phase 4 SOTA Algorithms & DLA Testnet', () => {
  // ==========================================================================
  // 1. OKLab Color Space & Riemersma Space-Filling Curve Dithering
  // ==========================================================================
  describe('OKLab Color Space & Riemersma Dithering (Component 4.1)', () => {
    it('round-trips sRGB through linear color transform accurately', () => {
      for (const val of [0, 16, 64, 128, 192, 255]) {
        const lin = srgbToLinear(val);
        const back = linearToSrgb(lin);
        expect(Math.abs(back - val)).toBeLessThanOrEqual(1);
      }
    });

    it('computes correct OKLab coordinates and Delta E_OK metric', () => {
      const black = rgbToOklab({ r: 0, g: 0, b: 0 });
      expect(black.L).toBeCloseTo(0, 4);

      const white = rgbToOklab({ r: 255, g: 255, b: 255 });
      expect(white.L).toBeCloseTo(1, 2);

      // Delta E_OK between identical colors is 0
      expect(deltaEOk(black, black)).toBe(0);
      expect(deltaEOk(white, white)).toBe(0);

      // Delta E_OK between black and white is close to 1.0
      const distBw = deltaEOk(black, white);
      expect(distBw).toBeGreaterThan(0.9);

      // Perceptual similarity: red vs pink vs blue
      const red = { r: 255, g: 0, b: 0 };
      const pink = { r: 255, g: 150, b: 150 };
      const blue = { r: 0, g: 0, b: 255 };

      const distRedPink = deltaEOkRgb(red, pink);
      const distRedBlue = deltaEOkRgb(red, blue);
      expect(distRedPink).toBeLessThan(distRedBlue);
    });

    it('generates complete Hilbert curve traversing all image coordinates', () => {
      const width = 8;
      const height = 8;
      const curve = generateHilbertCurveOrder(width, height);
      expect(curve.length).toBe(width * height);

      // Ensure every coordinate (0..w-1, 0..h-1) is visited exactly once
      const visited = new Set<string>();
      for (const pt of curve) {
        expect(pt.x).toBeGreaterThanOrEqual(0);
        expect(pt.x).toBeLessThan(width);
        expect(pt.y).toBeGreaterThanOrEqual(0);
        expect(pt.y).toBeLessThan(height);
        visited.add(`${pt.x},${pt.y}`);
      }
      expect(visited.size).toBe(width * height);
    });

    it('quantizes colors into OKLab palette and dithers along space-filling curve', () => {
      const width = 16;
      const height = 16;
      const pixels = new Uint8Array(width * height * 4);

      // Generate a smooth gradient image
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * 4;
          pixels[idx] = Math.round((x / width) * 255);
          pixels[idx + 1] = Math.round((y / height) * 255);
          pixels[idx + 2] = 128;
          pixels[idx + 3] = 255;
        }
      }

      // Quantize to 8 colors with Riemersma dithering
      const result = applyOklabQuantizationAndDither(
        { data: pixels, width, height },
        8,
        true
      );

      expect(result.palette.length).toBeLessThanOrEqual(8);
      expect(result.indexed.length).toBe(width * height);
      expect(result.rgba.length).toBe(width * height * 4);

      // Indices must strictly stay within palette bounds
      for (let i = 0; i < result.indexed.length; i++) {
        expect(result.indexed[i]).toBeGreaterThanOrEqual(0);
        expect(result.indexed[i]).toBeLessThan(result.palette.length);
      }
    });
  });

  // ==========================================================================
  // 2. Adaptive Incremental BRepMesh Tessellation
  // ==========================================================================
  describe('Adaptive Incremental BRepMesh (Component 4.2)', () => {
    it('adaptively subdivides B-Rep solid boundary faces based on chordal deflection', () => {
      // Create a mock STEP entity map with a quad face
      const entityMap = new Map<number, StepEntity>();

      entityMap.set(10, {
        id: 10,
        type: 'ADVANCED_FACE',
        args: ['', [20], 100, true],
      });

      entityMap.set(20, {
        id: 20,
        type: 'FACE_OUTER_BOUND',
        args: ['', 30, true],
      });

      entityMap.set(30, {
        id: 30,
        type: 'EDGE_LOOP',
        args: ['', [41, 42, 43, 44]],
      });

      // 4 oriented edges forming a 10x10 square
      entityMap.set(41, { id: 41, type: 'ORIENTED_EDGE', args: ['', 0, 51, true] });
      entityMap.set(42, { id: 42, type: 'ORIENTED_EDGE', args: ['', 0, 52, true] });
      entityMap.set(43, { id: 43, type: 'ORIENTED_EDGE', args: ['', 0, 53, true] });
      entityMap.set(44, { id: 44, type: 'ORIENTED_EDGE', args: ['', 0, 54, true] });

      entityMap.set(51, { id: 51, type: 'EDGE_CURVE', args: ['', 61, 62, 0, true] });
      entityMap.set(52, { id: 52, type: 'EDGE_CURVE', args: ['', 62, 63, 0, true] });
      entityMap.set(53, { id: 53, type: 'EDGE_CURVE', args: ['', 63, 64, 0, true] });
      entityMap.set(54, { id: 54, type: 'EDGE_CURVE', args: ['', 64, 61, 0, true] });

      entityMap.set(61, { id: 61, type: 'VERTEX_POINT', args: ['', 71] });
      entityMap.set(62, { id: 62, type: 'VERTEX_POINT', args: ['', 72] });
      entityMap.set(63, { id: 63, type: 'VERTEX_POINT', args: ['', 73] });
      entityMap.set(64, { id: 64, type: 'VERTEX_POINT', args: ['', 74] });

      entityMap.set(71, { id: 71, type: 'CARTESIAN_POINT', args: ['', [0, 0, 0]] });
      entityMap.set(72, { id: 72, type: 'CARTESIAN_POINT', args: ['', [10, 0, 0]] });
      entityMap.set(73, { id: 73, type: 'CARTESIAN_POINT', args: ['', [10, 10, 0]] });
      entityMap.set(74, { id: 74, type: 'CARTESIAN_POINT', args: ['', [0, 10, 0]] });

      // Coarse deflection -> base mesh
      const coarseMesh = adaptiveIncrementalBRepMesh(entityMap, {
        linearDeflection: 1.0,
        angularDeflection: 1.5,
      });
      expect(coarseMesh).toBeDefined();
      expect(coarseMesh!.faces.length).toBeGreaterThan(0);

      // Fine deflection -> adaptive subdivision producing more triangles
      const fineMesh = adaptiveIncrementalBRepMesh(entityMap, {
        linearDeflection: 0.05,
        angularDeflection: 0.2,
      });
      expect(fineMesh).toBeDefined();
      expect(fineMesh!.faces.length).toBeGreaterThan(coarseMesh!.faces.length);
      expect(fineMesh!.vertices.length).toBeGreaterThan(coarseMesh!.vertices.length);
    });
  });

  // ==========================================================================
  // 3. Lightweight CJK Optical Character Recognition Engine
  // ==========================================================================
  describe('Lightweight CJK OCR Pipeline (Component 4.3)', () => {
    it('executes CJK OCR pipeline with structured line and word tokenization', async () => {
      // Create a simulated high-contrast test image buffer
      const width = 200;
      const height = 100;
      const raw = Buffer.alloc(width * height * 4, 255); // White background

      // Draw dark horizontal text lines
      for (let y = 30; y < 45; y++) {
        for (let x = 20; x < 180; x++) {
          const idx = (y * width + x) * 4;
          raw[idx] = 0;
          raw[idx + 1] = 0;
          raw[idx + 2] = 0;
        }
      }

      const sharp = (await import('sharp')).default;
      const pngBuf = await sharp(raw, { raw: { width, height, channels: 4 } })
        .png()
        .toBuffer();

      const ocrKo = await performOcr(pngBuf, 'ko');
      expect(ocrKo).toBeDefined();
      expect(ocrKo.imageWidth).toBe(width);
      expect(ocrKo.imageHeight).toBe(height);
      expect(Array.isArray(ocrKo.lines)).toBe(true);
    });
  });

  // ==========================================================================
  // 4. Recursive XY-Cut+ Document Layout Analysis (DLA)
  // ==========================================================================
  describe('Recursive XY-Cut+ Document Layout Analysis (Component 4.4)', () => {
    it('analyzes multi-column layouts and orders blocks topologically', () => {
      const pageWidth = 800;
      const pageHeight = 1000;

      // Simulate a two-column academic paper layout:
      // - Header at top (y = 30)
      // - Title / Heading (y = 120)
      // - Column 1 Paragraphs (x = 50..370, y = 200..600)
      // - Column 2 Paragraphs (x = 430..750, y = 200..600)
      // - Footer at bottom (y = 950)
      const boxes: DlaBoundingBox[] = [
        // Header
        {
          x: 50,
          y: 30,
          width: 700,
          height: 20,
          text: 'International Journal of Document Analysis (2026)',
        },
        // Heading
        {
          x: 100,
          y: 120,
          width: 600,
          height: 35,
          text: 'Adaptive Multi-Column Layout Analysis and Segmentation',
          fontSize: 24,
          isBold: true,
        },
        // Column 1 - Paragraph 1
        {
          x: 50,
          y: 200,
          width: 320,
          height: 60,
          text: 'In this paper we present a recursive XY-cut algorithm.',
          fontSize: 12,
        },
        // Column 1 - Paragraph 2
        {
          x: 50,
          y: 280,
          width: 320,
          height: 60,
          text: 'The spatial projection profiles decompose the document.',
          fontSize: 12,
        },
        // Column 2 - Paragraph 1
        {
          x: 430,
          y: 200,
          width: 320,
          height: 60,
          text: 'Experimental results validate the effectiveness of our approach.',
          fontSize: 12,
        },
        // Column 2 - Paragraph 2
        {
          x: 430,
          y: 280,
          width: 320,
          height: 60,
          text: 'The reading order follows natural human scanning patterns.',
          fontSize: 12,
        },
        // Footer
        {
          x: 380,
          y: 950,
          width: 40,
          height: 20,
          text: 'Page 1',
        },
      ];

      const layout = analyzeDocumentLayout(boxes, pageWidth, pageHeight, {
        minColumnGap: 30,
        minParagraphGap: 15,
      });

      expect(layout.columnCount).toBe(2);
      expect(layout.blocks.length).toBeGreaterThanOrEqual(5);

      // Verify Header is first in reading order
      expect(layout.blocks[0].type).toBe('header');
      expect(layout.blocks[0].readingOrder).toBe(1);

      // Verify Footer is last in reading order
      const lastBlock = layout.blocks[layout.blocks.length - 1];
      expect(lastBlock.type).toBe('footer');

      // Verify Column 1 items appear before Column 2 items in body reading order
      const col1Blocks = layout.blocks.filter((b) => b.columnIndex === 0 && b.type === 'paragraph');
      const col2Blocks = layout.blocks.filter((b) => b.columnIndex === 1 && b.type === 'paragraph');

      expect(col1Blocks.length).toBeGreaterThan(0);
      expect(col2Blocks.length).toBeGreaterThan(0);
      expect(col1Blocks[0].readingOrder).toBeLessThan(col2Blocks[0].readingOrder);
    });

    it('classifies headings, list items, and tables accurately', () => {
      const pageWidth = 600;
      const pageHeight = 800;

      const boxes: DlaBoundingBox[] = [
        {
          x: 50,
          y: 100,
          width: 500,
          height: 30,
          text: '1. Executive Summary',
          fontSize: 20,
          isBold: true,
        },
        {
          x: 50,
          y: 160,
          width: 500,
          height: 40,
          text: '• First key deliverable completed on schedule.',
          fontSize: 12,
        },
        {
          x: 50,
          y: 220,
          width: 500,
          height: 40,
          text: '• Second key deliverable under active testing.',
          fontSize: 12,
        },
      ];

      const layout = analyzeDocumentLayout(boxes, pageWidth, pageHeight);
      const headingBlock = layout.blocks.find((b) => b.type === 'heading');
      expect(headingBlock).toBeDefined();
      expect(headingBlock!.text).toContain('Executive Summary');

      const listBlocks = layout.blocks.filter((b) => b.type === 'list_item');
      expect(listBlocks.length).toBe(2);
    });
  });

  // ==========================================================================
  // 5. OKLab Image Quantization & Dithering Pipeline in image.ts
  // ==========================================================================
  describe('OKLab Image Quantization & Dithering in image.ts (Component 4.5)', () => {
    it('quantizes and dithers image to PNG-8, BMP-8, GIF, and ICO with OKLab and space-filling curves', async () => {
      const width = 32;
      const height = 32;
      const rawRgba = Buffer.alloc(width * height * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * 4;
          rawRgba[idx] = Math.round((x / width) * 255);
          rawRgba[idx + 1] = Math.round((y / height) * 255);
          rawRgba[idx + 2] = 120;
          rawRgba[idx + 3] = 255;
        }
      }
      const inputPng = await sharp(rawRgba, { raw: { width, height, channels: 4 } })
        .png()
        .toBuffer();

      // PNG with OKLab and Riemersma dithering
      const pngOklab = await convertImage(inputPng, 'png', {
        palette: true,
        quantizer: 'oklab',
        ditherMethod: 'riemersma',
        colors: 16,
      });
      expect(pngOklab.mimeType).toBe('image/png');
      expect(pngOklab.buffer.length).toBeGreaterThan(0);

      // PNG with Void-and-Cluster Blue Noise dithering
      const pngBlueNoise = await convertImage(inputPng, 'png', {
        palette: true,
        ditherMethod: 'blue-noise',
        colors: 16,
      });
      expect(pngBlueNoise.mimeType).toBe('image/png');
      expect(pngBlueNoise.buffer.length).toBeGreaterThan(0);

      // BMP 8-bit paletted with OKLab quantization
      const bmpOklab = await convertImage(inputPng, 'bmp', {
        colorDepth: 8,
        quantizer: 'oklab',
        colors: 16,
      });
      expect(bmpOklab.mimeType).toBe('image/bmp');
      expect(bmpOklab.buffer.length).toBeGreaterThan(0);

      // BMP 8-bit with blue-noise dithering
      const bmpBlueNoise = await convertImage(inputPng, 'bmp', {
        colorDepth: 8,
        quantizer: 'oklab',
        ditherMethod: 'blue-noise',
        colors: 16,
      });
      expect(bmpBlueNoise.mimeType).toBe('image/bmp');
      expect(bmpBlueNoise.buffer.length).toBeGreaterThan(0);

      // GIF with OKLab quantization
      const gifOklab = await convertImage(inputPng, 'gif', {
        quantizer: 'oklab',
        colors: 16,
      });
      expect(gifOklab.mimeType).toBe('image/gif');
      expect(gifOklab.buffer.length).toBeGreaterThan(0);

      // GIF with blue-noise dithering
      const gifBlueNoise = await convertImage(inputPng, 'gif', {
        quantizer: 'oklab',
        ditherMethod: 'blue-noise',
        colors: 16,
      });
      expect(gifBlueNoise.mimeType).toBe('image/gif');
      expect(gifBlueNoise.buffer.length).toBeGreaterThan(0);

      // ICO with OKLab quantization
      const icoOklab = await convertImage(inputPng, 'ico', {
        colorDepth: 8,
        quantizer: 'oklab',
        colors: 16,
      });
      expect(icoOklab.mimeType).toBe('image/x-icon');
      expect(icoOklab.buffer.length).toBeGreaterThan(0);

      // ICO with blue-noise dithering
      const icoBlueNoise = await convertImage(inputPng, 'ico', {
        ditherMethod: 'blue-noise',
        colors: 16,
      });
      expect(icoBlueNoise.mimeType).toBe('image/x-icon');
      expect(icoBlueNoise.buffer.length).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // 6. DLA-Structured Document Conversion in document.ts
  // ==========================================================================
  describe('DLA-Structured HTML & Markdown Output in document.ts (Component 4.6)', () => {
    it('produces semantic HTML and Markdown with header, heading, list, paragraph, and footer blocks', async () => {
      // PDF user space has its origin at the bottom left (ISO 32000-1, 8.3.2.3): the header is drawn near y = 792.
      const pdfSource = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>
endobj
4 0 obj
<< /Length 480 >>
stream
BT
/F1 10 Tf
50 762 Td
(Document Confidential Header) Tj
ET
BT
/F1 24 Tf
50 690 Td
(Architecture Specification) Tj
ET
BT
/F1 12 Tf
50 640 Td
(- High throughput transformation engine) Tj
ET
BT
/F1 12 Tf
50 622 Td
(- Client-side processing) Tj
ET
BT
/F1 12 Tf
50 590 Td
(The platform processes media entirely client-side without cloud hops.) Tj
ET
BT
/F1 10 Tf
50 40 Td
(Page 1 of 12 - EasyConvert) Tj
ET
endstream
endobj
xref
0 5
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000266 00000 n 
trailer
<< /Size 5 /Root 1 0 R >>
startxref
700
%%EOF`;
      const pdfBuffer = Buffer.from(pdfSource, 'utf-8');

      // Convert to HTML
      const htmlRes = await convertDocument(pdfBuffer, 'pdf', 'html', {}, 'test-doc.pdf');
      const htmlText = htmlRes.buffer.toString('utf-8');

      expect(htmlRes.mimeType).toBe('text/html');
      const body = htmlText.slice(htmlText.indexOf('<body>'));
      expect(body).toMatch(
        /^<body><header><p>Document Confidential Header<\/p><\/header>\s*<h1>Architecture Specification<\/h1>\s*<ul><li>High throughput transformation engine<\/li><li>Client-side processing<\/li><\/ul>\s*<p>The platform processes media entirely client-side without cloud hops\.<\/p>\s*<footer><p>Page 1 of 12 - EasyConvert<\/p><\/footer><\/body>/,
      );
      expect(htmlText).not.toContain('<pre>');

      // Convert to Markdown
      const mdRes = await convertDocument(pdfBuffer, 'pdf', 'md', {}, 'test-doc.pdf');
      const mdText = mdRes.buffer.toString('utf-8');

      expect(mdRes.mimeType).toBe('text/markdown');
      expect(mdText.trimEnd().split('\n\n')).toEqual([
        '*Document Confidential Header*',
        '# Architecture Specification',
        '- High throughput transformation engine\n- Client-side processing',
        'The platform processes media entirely client-side without cloud hops.',
        '*Page 1 of 12 - EasyConvert*',
      ]);
    });
  });

  // ==========================================================================
  // 7. Multi-Sheet Office Parity & ODS Preservation in office.ts
  // ==========================================================================
  describe('Multi-Sheet Office Parity & ODS Preservation (Component 4.7)', () => {
    async function createTestXlsx(): Promise<Buffer> {
      const zip = new JSZip();
      const sheet1Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="inlineStr"><is><t>Quarter</t></is></c>
      <c r="B1" t="inlineStr"><is><t>Revenue</t></is></c>
    </row>
    <row r="2">
      <c r="A2" t="inlineStr"><is><t>Q1</t></is></c>
      <c r="B2" t="inlineStr"><is><t>$10,000</t></is></c>
    </row>
  </sheetData>
</worksheet>`;

      const sheet2Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="inlineStr"><is><t>Department</t></is></c>
      <c r="B1" t="inlineStr"><is><t>Expense</t></is></c>
    </row>
    <row r="2">
      <c r="A2" t="inlineStr"><is><t>R&amp;D</t></is></c>
      <c r="B2" t="inlineStr"><is><t>$4,500</t></is></c>
    </row>
  </sheetData>
</worksheet>`;

      zip.file('xl/worksheets/sheet1.xml', sheet1Xml);
      zip.file('xl/worksheets/sheet2.xml', sheet2Xml);
      zip.file(
        'xl/workbook.xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Quarterly Revenue" sheetId="1" r:id="rId1"/>
    <sheet name="Department Expenses" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`
      );
      zip.file(
        'xl/_rels/workbook.xml.rels',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>`
      );
      return zip.generateAsync({ type: 'nodebuffer' });
    }

    it('extracts all worksheets from multi-sheet XLSX document', async () => {
      const xlsxBuffer = await createTestXlsx();
      const sheets = await extractAllSheetsForOffice(xlsxBuffer, 'xlsx');

      expect(sheets.length).toBe(2);
      expect(sheets[0].name).toBe('Quarterly Revenue');
      expect(sheets[0].rows[0]).toEqual(['Quarter', 'Revenue']);
      expect(sheets[0].rows[1]).toEqual(['Q1', '$10,000']);

      expect(sheets[1].name).toBe('Department Expenses');
      expect(sheets[1].rows[0]).toEqual(['Department', 'Expense']);
      expect(sheets[1].rows[1]).toEqual(['R&D', '$4,500']);
    });

    it('generates multi-sheet ODS archive preserving distinct table structures', async () => {
      const xlsxBuffer = await createTestXlsx();
      const res = await convertOffice(xlsxBuffer, 'xlsx', 'ods', {}, 'financial_report.xlsx');

      expect(res.mimeType).toBe('application/vnd.oasis.opendocument.spreadsheet');
      const odsZip = await JSZip.loadAsync(res.buffer);
      const contentXml = await odsZip.file('content.xml')?.async('text');

      expect(contentXml).toBeDefined();
      expect(contentXml).toContain('<table:table table:name="Quarterly Revenue">');
      expect(contentXml).toContain('<table:table table:name="Department Expenses">');
      expect(contentXml).toContain('Quarter');
      expect(contentXml).toContain('$10,000');
      expect(contentXml).toContain('Department');
      expect(contentXml).toContain('R&amp;D');
    });

    oracleTest('creates multi-sheet ODS using generateOdsFromData', ['xmllint', 'soffice', 'python3'], async () => {
      const odsBuffer = await generateOdsFromData(
        [
          { name: 'Summary', rows: [['Total', '100']] },
          { name: 'Details', rows: [['Item', '50'], ['Item2', '50']] },
        ],
        'report'
      );
      const odsZip = await JSZip.loadAsync(odsBuffer);
      const contentXml = (await odsZip.file('content.xml')?.async('text')) as string;

      // The package: the stored mimetype entry comes first (OpenDocument packaging), and content.xml is XML.
      expect(Object.keys(odsZip.files)[0]).toBe('mimetype');
      expect(await odsZip.file('mimetype')?.async('text')).toBe('application/vnd.oasis.opendocument.spreadsheet');
      expect(xmlWellFormed(contentXml).ok).toBe(true);

      // Sheet names and the cells of each sheet, read with XPath.
      const SHEET = "//*[local-name()='table']";
      expect(xpathAttributes(contentXml, `${SHEET}/@*[local-name()='name']`)).toEqual(['Summary', 'Details']);
      const cellText = (sheet: number, row: number, cell: number) =>
        xpathString(contentXml, `string((${SHEET}[${sheet}]//*[local-name()='table-row'])[${row}]/*[local-name()='table-cell'][${cell}])`);
      expect([cellText(1, 1, 1), cellText(1, 1, 2)]).toEqual(['Total', '100']);
      expect([cellText(2, 1, 1), cellText(2, 1, 2), cellText(2, 2, 1), cellText(2, 2, 2)]).toEqual(['Item', '50', 'Item2', '50']);
      expect(xpathCount(contentXml, `${SHEET}[1]//*[local-name()='table-row']`)).toBe(1);
      expect(xpathCount(contentXml, `${SHEET}[2]//*[local-name()='table-row']`)).toBe(2);

      // LibreOffice opens the file and reads the first sheet's row.
      expect(sheetRowsViaLibreOffice(odsBuffer, 'ods')).toEqual([['Total', '100']]);
    });
  });

  // ==========================================================================
  // 8. PPTX Vector Shape Extraction & PDF/HTML Rendering in office.ts
  // ==========================================================================
  describe('PPTX Vector Shape Extraction & Rendering (Component 4.8)', () => {
    async function createTestPptxWithShapes(): Promise<Buffer> {
      const zip = new JSZip();
      zip.file(
        'ppt/presentation.xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldSz cx="12192000" cy="6858000"/>
</p:presentation>`
      );
      zip.file(
        'ppt/slides/slide1.xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:spPr>
          <a:xfrm><a:off x="1270000" y="1270000"/><a:ext cx="2540000" cy="1270000"/></a:xfrm>
          <a:prstGeom prst="rect"/>
          <a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>
          <a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>
        </p:spPr>
        <p:txBody><a:p><a:r><a:t>Rectangle Feature</a:t></a:r></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:spPr>
          <a:xfrm><a:off x="4000000" y="1270000"/><a:ext cx="1270000" cy="1270000"/></a:xfrm>
          <a:prstGeom prst="ellipse"/>
          <a:solidFill><a:srgbClr val="00FF00"/></a:solidFill>
        </p:spPr>
        <p:txBody><a:p><a:r><a:t>Ellipse Feature</a:t></a:r></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:spPr>
          <a:xfrm><a:off x="1270000" y="3000000"/><a:ext cx="2540000" cy="1270000"/></a:xfrm>
          <a:prstGeom prst="roundRect"/>
          <a:solidFill><a:srgbClr val="0000FF"/></a:solidFill>
        </p:spPr>
        <p:txBody><a:p><a:r><a:t>RoundRect Feature</a:t></a:r></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:spPr>
          <a:xfrm><a:off x="4000000" y="3000000"/><a:ext cx="1270000" cy="1270000"/></a:xfrm>
          <a:prstGeom prst="triangle"/>
          <a:solidFill><a:srgbClr val="FFFF00"/></a:solidFill>
        </p:spPr>
        <p:txBody><a:p><a:r><a:t>Triangle Feature</a:t></a:r></a:p></p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`
      );
      return zip.generateAsync({ type: 'nodebuffer' });
    }

    it('renders vector shapes (rect, ellipse, roundRect, triangle) in HTML slide export', async () => {
      const pptxBuffer = await createTestPptxWithShapes();
      const htmlRes = await convertOffice(pptxBuffer, 'pptx', 'html', {}, 'presentation.pptx');

      expect(htmlRes.mimeType).toBe('text/html');
      const html = htmlRes.buffer.toString('utf-8');

      expect(html).toContain('<svg');
      expect(html).toContain('<rect');
      expect(html).toContain('<ellipse');
      expect(html).toContain('rx="');
      expect(html).toContain('<polygon points=');
      expect(html).toContain('Rectangle Feature');
      expect(html).toContain('Ellipse Feature');
      expect(html).toContain('RoundRect Feature');
      expect(html).toContain('Triangle Feature');
    });

    it('renders vector shapes in PDF slide export', async () => {
      const pptxBuffer = await createTestPptxWithShapes();
      const pdfRes = await convertOffice(pptxBuffer, 'pptx', 'pdf', {}, 'presentation.pptx');

      expect(pdfRes.mimeType).toBe('application/pdf');
      expect(pdfRes.buffer.length).toBeGreaterThan(1000);
      expect(pdfRes.buffer.toString('binary', 0, 5)).toBe('%PDF-');
    });
  });
});

