import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readDxf } from './helpers/dxf-reader';
import sharp from 'sharp';
import JSZip from 'jszip';
import { NextRequest } from 'next/server';
import { POST as batchRoute } from '../src/app/api/convert/batch/route';
import {
  convertFile,
  quantizeMedianCut,
  quantizeNeuQuant,
  encodeBmp8,
  evaluateCubicBezier,
  evaluateCubicBezierDerivative,
  adaptiveTessellateCubicBezier,
  cubicBezierToBSpline,
  parseSvgPathToBezierPoints,
  svgToDxf,
  performOcr,
  generateSearchablePdf,
  generateFb2FromText,
} from '../src/lib/conversions';
import { zipEntryText } from './helpers/zip-entry';
import { xmlWellFormed, xpathString } from './helpers/xml-oracle';
import { oracleTest } from './helpers/oracle-test';
import { requireOracleTool } from './helpers/differential-oracle';
import { characterErrorRatePercent } from './helpers/ocr-cer';

describe('Advanced Conversion Algorithms & Cross-Domain Boost', () => {
  describe('Domain: Color Quantization (NeuQuant & Median Cut)', () => {
    it('quantizes RGB image with Median Cut algorithm into 16 and 256 colors', () => {
      // Create synthetic 100x100 RGB buffer with gradient
      const width = 100;
      const height = 100;
      const rgb = Buffer.alloc(width * height * 3);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * 3;
          rgb[idx] = Math.floor((x / width) * 255); // R
          rgb[idx + 1] = Math.floor((y / height) * 255); // G
          rgb[idx + 2] = 128; // B
        }
      }

      // Test 16 colors
      const res16 = quantizeMedianCut(rgb, width, height, 3, 16, true);
      expect(res16.palette.length).toBeLessThanOrEqual(16);
      expect(res16.palette.length).toBeGreaterThan(0);
      expect(res16.indexedPixels.length).toBe(width * height);
      expect(res16.paletteBuffer.length).toBe(res16.palette.length * 3);

      // Test 256 colors
      const res256 = quantizeMedianCut(rgb, width, height, 3, 256, true);
      expect(res256.palette.length).toBeLessThanOrEqual(256);
      expect(res256.palette.length).toBeGreaterThan(16);
    });

    it('quantizes complex RGB image using NeuQuant neural network and encodes valid 8-bit paletted BMP', async () => {
      const width = 64;
      const height = 64;
      const rgb = Buffer.alloc(width * height * 3);
      for (let i = 0; i < width * height; i++) {
        rgb[i * 3] = (i * 7) % 256;
        rgb[i * 3 + 1] = (i * 13) % 256;
        rgb[i * 3 + 2] = (i * 19) % 256;
      }

      const quant = quantizeNeuQuant(rgb, width, height, 3, 5, true);
      expect(quant.palette.length).toBe(256);
      expect(quant.indexedPixels.length).toBe(width * height);

      const bmp8 = encodeBmp8(quant.indexedPixels, quant.palette, width, height);
      expect(bmp8.toString('ascii', 0, 2)).toBe('BM');
      expect(bmp8.readUInt16LE(28)).toBe(8); // 8 bits per pixel
      expect(bmp8.readUInt32LE(46)).toBe(256); // 256 colors in palette
    });

    it('converts image to paletted GIF and 8-bit paletted PNG using color quantization options', async () => {
      const testImage = await sharp({
        create: {
          width: 50,
          height: 50,
          channels: 3,
          background: { r: 120, g: 60, b: 200 },
        },
      })
        .png()
        .toBuffer();

      // Convert to GIF with 64 colors
      const gifRes = await convertFile(testImage, 'png', 'gif', { colors: 64, dither: true }, 'palette_test.png');
      expect(gifRes.mimeType).toBe('image/gif');
      expect(gifRes.buffer.toString('ascii', 0, 3)).toBe('GIF');

      // Convert to PNG-8 (paletted PNG)
      const png8Res = await convertFile(testImage, 'png', 'png', { colorDepth: 8, colors: 128 }, 'palette_test.png');
      expect(png8Res.mimeType).toBe('image/png');
      expect(png8Res.size).toBeGreaterThan(0);
    });
  });

  describe('Domain: Vector & CAD True Cubic Bezier Evaluation', () => {
    it('evaluates cubic Bezier Bernstein polynomials and exact derivatives at boundary and midpoints', () => {
      const p0 = { x: 0, y: 0, z: 0 };
      const p1 = { x: 10, y: 50, z: 0 };
      const p2 = { x: 90, y: 50, z: 0 };
      const p3 = { x: 100, y: 0, z: 0 };

      // At t = 0: B(0) = P0
      const at0 = evaluateCubicBezier(p0, p1, p2, p3, 0.0);
      expect(at0.x).toBeCloseTo(0);
      expect(at0.y).toBeCloseTo(0);

      // At t = 1: B(1) = P3
      const at1 = evaluateCubicBezier(p0, p1, p2, p3, 1.0);
      expect(at1.x).toBeCloseTo(100);
      expect(at1.y).toBeCloseTo(0);

      // At t = 0.5: Symmetrical midpoint
      const atMid = evaluateCubicBezier(p0, p1, p2, p3, 0.5);
      expect(atMid.x).toBeCloseTo(50);
      expect(atMid.y).toBeGreaterThan(30);

      // Derivative at t = 0: B'(0) = 3 * (P1 - P0) = (30, 150)
      const d0 = evaluateCubicBezierDerivative(p0, p1, p2, p3, 0.0);
      expect(d0.x).toBeCloseTo(30);
      expect(d0.y).toBeCloseTo(150);
    });

    it('adaptively tessellates cubic Bezier curve using recursive de Casteljau subdivision', () => {
      const p0 = { x: 0, y: 0, z: 0 };
      const p1 = { x: 0, y: 100, z: 0 };
      const p2 = { x: 100, y: 100, z: 0 };
      const p3 = { x: 100, y: 0, z: 0 };

      const points = adaptiveTessellateCubicBezier(p0, p1, p2, p3, 0.5);
      expect(points.length).toBeGreaterThan(4);
      expect(points[0].x).toBe(0);
      expect(points[points.length - 1].x).toBe(100);
    });

    it('converts cubic Bezier curve into exact degree-3 clamped B-Spline curve', () => {
      const p0 = { x: 10, y: 10, z: 0 };
      const p1 = { x: 20, y: 40, z: 0 };
      const p2 = { x: 60, y: 40, z: 0 };
      const p3 = { x: 70, y: 10, z: 0 };

      const bspline = cubicBezierToBSpline(p0, p1, p2, p3);
      expect(bspline.degree).toBe(3);
      expect(bspline.controlPoints.length).toBe(4);
      expect(bspline.knots).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    });

    it('parses SVG path commands with Cubic and Quadratic Bezier curves into one flattened DXF polyline', () => {
      const svg = `<svg width="200" height="200">
        <path d="M 10 10 C 20 20, 40 20, 50 10 S 80 0, 90 10 Q 120 50, 150 10 Z" fill="none" stroke="black"/>
      </svg>`;

      const subpaths = parseSvgPathToBezierPoints('M 10 10 C 20 20, 40 20, 50 10 S 80 0, 90 10 Q 120 50, 150 10 Z');
      expect(subpaths.length).toBeGreaterThan(0);
      expect(subpaths[0].length).toBeGreaterThan(5);

      // The closed path (M, C, S, Q, Z) is one closed polyline that starts at the path's first point and follows
      // the curves: vertices lie within the path's bounding box, y flipped for DXF (page height 200).
      const { entities } = readDxf(svgToDxf(svg));
      expect(entities).toHaveLength(1);
      expect(entities[0].type).toBe('POLYLINE');
      expect(entities[0].closed).toBe(true);
      expect(entities[0].points.length).toBeGreaterThan(20);
      expect([entities[0].points[0].x, entities[0].points[0].y]).toEqual([10, 190]);
      for (const point of entities[0].points) {
        expect(point.x).toBeGreaterThanOrEqual(10);
        expect(point.x).toBeLessThanOrEqual(150);
        expect(200 - point.y).toBeGreaterThanOrEqual(0);
        expect(200 - point.y).toBeLessThanOrEqual(50);
      }
    });
  });

  describe('Domain: PDF & OCR Real Searchable PDF Overlay', () => {
    /** A page of black text on white, large enough for the recognizer to read without error. */
    async function renderPage(width: number, height: number, lines: { text: string; y: number; size: number }[]): Promise<Buffer> {
      const markup = lines
        .map((line) => `<text x="40" y="${line.y}" font-family="DejaVu Sans Mono, monospace" font-size="${line.size}" fill="black">${line.text}</text>`)
        .join('');
      return sharp({ create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } } })
        .composite([{ input: Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${markup}</svg>`), top: 0, left: 0 }])
        .png()
        .toBuffer();
    }

    /** The text of `pdf` as the Poppler text extractor reads it, an oracle independent of the PDF writer and of the OCR engine. */
    function popplerText(pdf: Buffer): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'searchable-pdf-'));
      try {
        const file = path.join(dir, 'page.pdf');
        fs.writeFileSync(file, pdf);
        return execFileSync(requireOracleTool('pdftotext'), ['-enc', 'UTF-8', file, '-'], { encoding: 'utf-8' });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }

    /** Character error rate allowed for clean, large, machine-rendered text. */
    const MAX_CLEAN_TEXT_CER_PERCENT = 5;
    /** Real recognition runs here; under a loaded test shard it can take well over the default 5 s. */
    const OCR_TEST_TIMEOUT_MS = 60_000;

    oracleTest('generates a searchable PDF whose invisible text layer holds the page text, as pdftotext reads it', ['tesseract', 'pdftotext'], async () => {
      const expected = 'SEARCHABLE PDF ZERO RETENTION';
      const scannedImage = await renderPage(1100, 320, [
        { text: 'SEARCHABLE PDF', y: 110, size: 64 },
        { text: 'ZERO RETENTION', y: 240, size: 64 },
      ]);

      const ocrResult = await performOcr(scannedImage);
      expect(characterErrorRatePercent(expected, ocrResult.text)).toBeLessThanOrEqual(MAX_CLEAN_TEXT_CER_PERCENT);
      expect(ocrResult.lineBlocks?.map((block) => block.text.trim())).toEqual(['SEARCHABLE PDF', 'ZERO RETENTION']);

      const searchablePdf = await generateSearchablePdf(scannedImage, ocrResult, {}, 'Test Document');
      expect(searchablePdf.toString('ascii', 0, 4)).toBe('%PDF');
      expect(characterErrorRatePercent(expected, popplerText(searchablePdf))).toBeLessThanOrEqual(MAX_CLEAN_TEXT_CER_PERCENT);
    }, OCR_TEST_TIMEOUT_MS);

    oracleTest('converts an image directly to a searchable PDF when ocrEnabled is true', ['tesseract', 'pdftotext'], async () => {
      const img = await renderPage(900, 200, [{ text: 'OCR SEARCH', y: 130, size: 72 }]);

      const result = await convertFile(img, 'png', 'pdf', { ocrEnabled: true }, 'scan.png');
      expect(result.mimeType).toBe('application/pdf');
      expect(characterErrorRatePercent('OCR SEARCH', result.ocrExtractedText ?? '')).toBeLessThanOrEqual(MAX_CLEAN_TEXT_CER_PERCENT);
      expect(result.ocrConfidence).toBeGreaterThan(0.7);
      expect(characterErrorRatePercent('OCR SEARCH', popplerText(result.buffer))).toBeLessThanOrEqual(MAX_CLEAN_TEXT_CER_PERCENT);
    }, OCR_TEST_TIMEOUT_MS);
  });

  describe('Domain: Document & Ebook Semantic Enhancements', () => {
    oracleTest('converts text with markdown table to genuine FictionBook 2.0 (FB2) XML with semantic markup', ['xmllint'], async () => {
      const text = `# Chapter 1: The Encounter
The crew arrived at the destination.

| Star | Distance | Type |
| --- | --- | --- |
| Sol | 0 ly | G2V |
| Alpha Centauri | 4.37 ly | Triple |

The voyage was recorded.`;

      const fb2Buf = generateFb2FromText(text, 'Space Voyage');
      const xml = fb2Buf.toString('utf-8');

      // xmllint (libxml2) reads the document; the expectations are the FictionBook 2.0 structure written by hand.
      expect(xmlWellFormed(xml).ok).toBe(true);
      const q = (expr: string) => xpathString(xml, expr);
      expect(q('namespace-uri(/*[local-name()="FictionBook"])')).toBe('http://www.gribuser.ru/xml/fictionbook/2.0');
      expect(q('string(//*[local-name()="title-info"]/*[local-name()="book-title"])')).toBe('Space Voyage');
      expect(q('count(//*[local-name()="body"]/*[local-name()="section"])')).toBe('1');
      // The Markdown table becomes one <table> with a header row and two data rows.
      expect(q('count(//*[local-name()="table"])')).toBe('1');
      expect(q('count(//*[local-name()="table"]/*[local-name()="tr"])')).toBe('3');
      expect(q('string(//*[local-name()="table"]/*[local-name()="tr"][1]/*[local-name()="th"][1])')).toBe('Star');
      expect(q('string(//*[local-name()="table"]/*[local-name()="tr"][1]/*[local-name()="th"][3])')).toBe('Type');
      expect(q('string(//*[local-name()="table"]/*[local-name()="tr"][3]/*[local-name()="td"][1])')).toBe('Alpha Centauri');
      expect(q('string(//*[local-name()="table"]/*[local-name()="tr"][3]/*[local-name()="td"][2])')).toBe('4.37 ly');
      // Paragraphs on either side of the table survive in order.
      expect(q('string(//*[local-name()="section"]/*[local-name()="p"][1])')).toBe('The crew arrived at the destination.');
      expect(q('string(//*[local-name()="section"]/*[local-name()="p"][last()])')).toBe('The voyage was recorded.');
    });

    it('converts FB2 to HTML and Markdown preserving semantic tables and authors', async () => {
      const fb2 = `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
  <description>
    <title-info>
      <author><first-name>Arthur</first-name><last-name>Clarke</last-name></author>
      <book-title>Rendezvous</book-title>
    </title-info>
  </description>
  <body>
    <section>
      <p>The spacecraft approached the cylinder.</p>
      <table>
        <tr><th>Metric</th><th>Value</th></tr>
        <tr><td>Length</td><td>50 km</td></tr>
      </table>
    </section>
  </body>
</FictionBook>`;

      const fb2Buf = Buffer.from(fb2, 'utf-8');

      // Convert to HTML
      const htmlRes = await convertFile(fb2Buf, 'fb2', 'html', {}, 'rendezvous.fb2');
      expect(htmlRes.mimeType).toBe('text/html');
      const html = htmlRes.buffer.toString('utf-8');
      expect(html).toContain('Rendezvous');
      expect(html).toContain('Arthur Clarke');
      expect(html).toContain('<table>');
      expect(html).toContain('50 km');

      // Convert to Markdown
      const mdRes = await convertFile(fb2Buf, 'fb2', 'md', {}, 'rendezvous.fb2');
      expect(mdRes.mimeType).toBe('text/markdown');
      const md = mdRes.buffer.toString('utf-8');
      expect(md).toContain('# Rendezvous');
      expect(md).toContain('*Arthur Clarke*');
      expect(md).toContain('| Metric | Value |');
    });

    it('generates EPUB 3 with navigation document (nav.xhtml), toc.ncx, and semantic tags', async () => {
      const md = `# Galaxy Guide\n\nDon't panic.\n\n| Item | Essential |\n| --- | --- |\n| Towel | Yes |\n\nAlways carry a towel.`;
      const epubRes = await convertFile(Buffer.from(md, 'utf-8'), 'md', 'epub', {}, 'guide.md');
      expect(epubRes.mimeType).toBe('application/epub+zip');

      const zip = await JSZip.loadAsync(epubRes.buffer);
      expect(await zipEntryText(zip, 'mimetype')).toBe('application/epub+zip');
      // EPUB 3 navigation document: a <nav epub:type="toc"> listing the heading; EPUB 2 NCX: a navMap entry for it.
      const nav = await zipEntryText(zip, 'OEBPS/nav.xhtml');
      expect(nav).toContain('<nav epub:type="toc"');
      expect(nav).toContain('<a href="chapter1.xhtml#h-1">Galaxy Guide</a>');
      const ncx = await zipEntryText(zip, 'OEBPS/toc.ncx');
      expect(ncx).toContain('<navLabel><text>Galaxy Guide</text></navLabel><content src="chapter1.xhtml#h-1"/>');

      const chapterXml = await zipEntryText(zip, 'OEBPS/chapter1.xhtml');
      expect(chapterXml).toContain('<h1 id="h-1">Galaxy Guide</h1>');
      expect(chapterXml).toContain('<thead>\n<tr><th>Item</th><th>Essential</th></tr>\n</thead>');
      expect(chapterXml).toContain('<td>Towel</td><td>Yes</td>');
    });

    it('converts DOCX to HTML and Markdown preserving interleaved document order of paragraphs and tables', async () => {
      // Create a DOCX zip with interleaved <w:p> and <w:tbl>
      const zip = new JSZip();
      zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`);
      zip.file(
        'word/document.xml',
        `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Project Plan</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Phase 1 Overview</w:t></w:r></w:p>
    <w:tbl>
      <w:tr><w:tc><w:p><w:r><w:t>Task</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Status</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>Parser</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Complete</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
    <w:p><w:r><w:t>Phase 2 Next Steps</w:t></w:r></w:p>
  </w:body>
</w:document>`
      );

      const docxBuf = await zip.generateAsync({ type: 'nodebuffer' });

      // Convert to HTML
      const htmlRes = await convertFile(docxBuf, 'docx', 'html', {}, 'plan.docx');
      const html = htmlRes.buffer.toString('utf-8');
      expect(html).toContain('<h1>Project Plan</h1>');
      expect(html).toContain('<strong>Phase 1 Overview</strong>');
      expect(html).toContain('<table');
      expect(html).toContain('Phase 2 Next Steps');

      // The order in HTML must have table between Phase 1 and Phase 2
      const phase1Idx = html.indexOf('Phase 1 Overview');
      const tblIdx = html.indexOf('<table');
      const phase2Idx = html.indexOf('Phase 2 Next Steps');
      expect(phase1Idx).toBeLessThan(tblIdx);
      expect(tblIdx).toBeLessThan(phase2Idx);
    });
  });

  describe('Domain: Zero-Retention Batch 100MB Gate', () => {
    it('blocks batch requests when any single file exceeds 100MB', async () => {
      const req = {
        formData: async () => {
          const map = new Map<string, any>();
          map.set('files', [
            {
              name: 'huge_archive.zip',
              size: 105 * 1024 * 1024,
              arrayBuffer: async () => new ArrayBuffer(0),
            },
          ]);
          return {
            getAll: (key: string) => map.get(key) || [],
            get: () => null,
          };
        },
      } as unknown as NextRequest;

      const res = await batchRoute(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toMatch(/exceeds real-time in-memory conversion limit/i);
    });

    it('blocks batch requests when cumulative size exceeds 100MB', async () => {
      const req = {
        formData: async () => {
          const map = new Map<string, any>();
          map.set('files', [
            {
              name: 'file1.zip',
              size: 60 * 1024 * 1024,
              arrayBuffer: async () => new ArrayBuffer(0),
            },
            {
              name: 'file2.zip',
              size: 50 * 1024 * 1024,
              arrayBuffer: async () => new ArrayBuffer(0),
            },
          ]);
          return {
            getAll: (key: string) => map.get(key) || [],
            get: () => null,
          };
        },
      } as unknown as NextRequest;

      const res = await batchRoute(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toMatch(/exceeds real-time in-memory conversion limit/i);
    });
  });
});
