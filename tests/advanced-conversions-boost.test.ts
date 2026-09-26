import { describe, it, expect } from 'vitest';
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
  extractTextFromPdf,
} from '../src/lib/conversions';

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

    it('parses SVG path commands with Cubic and Quadratic Bezier curves into DXF LWPOLYLINE', () => {
      const svg = `<svg width="200" height="200">
        <path d="M 10 10 C 20 20, 40 20, 50 10 S 80 0, 90 10 Q 120 50, 150 10 Z" fill="none" stroke="black"/>
      </svg>`;

      const subpaths = parseSvgPathToBezierPoints('M 10 10 C 20 20, 40 20, 50 10 S 80 0, 90 10 Q 120 50, 150 10 Z');
      expect(subpaths.length).toBeGreaterThan(0);
      expect(subpaths[0].length).toBeGreaterThan(5);

      const dxf = svgToDxf(svg);
      expect(dxf).toContain('LWPOLYLINE');
      expect(dxf).toContain('ENTITIES');
      expect(dxf).toContain('EOF');
    });
  });

  describe('Domain: PDF & OCR Real Searchable PDF Overlay', () => {
    it('generates an authentic Searchable PDF with invisible text layer and verifies OCR text extraction', async () => {
      // 1. Create a scanned document image with text
      const scannedImage = await sharp({
        create: {
          width: 400,
          height: 120,
          channels: 3,
          background: { r: 255, g: 255, b: 255 },
        },
      })
        .composite([
          {
            input: Buffer.from(
              `<svg width="400" height="120">
                <text x="30" y="40" font-family="monospace" font-size="20" fill="black">SEARCHABLE PDF</text>
                <text x="30" y="85" font-family="monospace" font-size="18" fill="black">ZERO RETENTION</text>
              </svg>`
            ),
            top: 0,
            left: 0,
          },
        ])
        .png()
        .toBuffer();

      // 2. Run OCR to extract text and layout coordinates
      const ocrResult = await performOcr(scannedImage);
      expect(ocrResult.lines.length).toBeGreaterThan(0);
      expect(ocrResult.lineBlocks).toBeDefined();

      // 3. Generate Searchable PDF ("Sandwich PDF") with invisible text overlay layer
      const searchablePdf = await generateSearchablePdf(scannedImage, ocrResult, {}, 'Test Document');
      expect(searchablePdf.toString('ascii', 0, 4)).toBe('%PDF');

      // 4. Verify text extraction from generated searchable PDF
      const extracted = extractTextFromPdf(searchablePdf);
      expect(extracted).not.toBe('No extractable text found in PDF document.');
      expect(extracted.length).toBeGreaterThan(0);
    });

    it('converts image directly to searchable PDF when ocrEnabled option is true', async () => {
      const img = await sharp({
        create: {
          width: 300,
          height: 80,
          channels: 3,
          background: { r: 255, g: 255, b: 255 },
        },
      })
        .composite([
          {
            input: Buffer.from(
              `<svg width="300" height="80">
                <text x="20" y="50" font-family="monospace" font-size="22" fill="black">OCR SEARCH</text>
              </svg>`
            ),
            top: 0,
            left: 0,
          },
        ])
        .png()
        .toBuffer();

      const result = await convertFile(img, 'png', 'pdf', { ocrEnabled: true }, 'scan.png');
      expect(result.mimeType).toBe('application/pdf');
      expect(result.ocrExtractedText).toBeDefined();
      expect(result.ocrConfidence).toBeGreaterThan(0.7);

      const extracted = extractTextFromPdf(result.buffer);
      expect(extracted).not.toBe('No extractable text found in PDF document.');
    });
  });

  describe('Domain: Document & Ebook Semantic Enhancements', () => {
    it('converts text with markdown table to genuine FictionBook 2.0 (FB2) XML with semantic markup', async () => {
      const text = `# Chapter 1: The Encounter
The crew arrived at the destination.

| Star | Distance | Type |
| --- | --- | --- |
| Sol | 0 ly | G2V |
| Alpha Centauri | 4.37 ly | Triple |

The voyage was recorded.`;

      const fb2Buf = generateFb2FromText(text, 'Space Voyage');
      const xml = fb2Buf.toString('utf-8');

      expect(xml).toContain('<FictionBook');
      expect(xml).toContain('<book-title>Space Voyage</book-title>');
      expect(xml).toContain('<table>');
      expect(xml).toContain('<th>Star</th>');
      expect(xml).toContain('<td>Alpha Centauri</td>');
      expect(xml).toContain('<section>');
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
      expect(zip.file('mimetype')).toBeDefined();
      expect(zip.file('OEBPS/nav.xhtml')).toBeDefined();
      expect(zip.file('OEBPS/toc.ncx')).toBeDefined();
      expect(zip.file('OEBPS/styles.css')).toBeDefined();

      const chapterXml = await zip.file('OEBPS/chapter1.xhtml')!.async('text');
      expect(chapterXml).toContain('<header>');
      expect(chapterXml).toContain('<article>');
      expect(chapterXml).toContain('table');
      expect(chapterXml).toContain('Towel');
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
    <w:p><w:r><w:b/><w:t>Phase 1 Overview</w:t></w:r></w:p>
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
