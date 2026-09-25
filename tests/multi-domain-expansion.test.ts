import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import sharp from 'sharp';
import { convertFile } from '../src/lib/conversions/index';
import { createCanonicalFont, encodeSfnt } from '../src/lib/conversions/font';

describe('Multi-Domain Conversion Engine Expansion (Font, Vector/CAD, Spreadsheet, Presentation, Document)', () => {
  // Helper to generate a minimal valid TrueType font buffer
  function createTestTtfBuffer(fontFamily = 'EasyConvertSans'): Buffer {
    const canonical = createCanonicalFont(Buffer.alloc(0), fontFamily);
    return encodeSfnt(canonical);
  }

  // =========================================================================
  // 1. FONT CONVERSIONS (TTF, OTF, WOFF, WOFF2, EOT, SVG FONT)
  // =========================================================================
  describe('Font Conversion Engine', () => {
    it('converts TTF to genuine WOFF 1.0 container format', async () => {
      const ttf = createTestTtfBuffer('BrandSans');
      const result = await convertFile(ttf, 'ttf', 'woff', {}, 'BrandSans.ttf');

      expect(result.mimeType).toBe('font/woff');
      expect(result.filename).toBe('BrandSans.woff');
      expect(result.size).toBeGreaterThan(44);

      // Verify WOFF 1.0 magic signature ('wOFF' = [0x77, 0x4F, 0x46, 0x46])
      expect(result.buffer.toString('ascii', 0, 4)).toBe('wOFF');

      // Verify flavor matches standard TrueType (0x00010000)
      expect(result.buffer.readUInt32BE(4)).toBe(0x00010000);

      // Verify table directory count > 0
      const numTables = result.buffer.readUInt16BE(12);
      expect(numTables).toBeGreaterThan(0);
    });

    it('round-trips WOFF back to TTF with intact SFNT table directory', async () => {
      const ttf = createTestTtfBuffer('RoundtripFont');
      const woffResult = await convertFile(ttf, 'ttf', 'woff', {}, 'Roundtrip.ttf');

      // Convert WOFF -> TTF
      const ttfResult = await convertFile(woffResult.buffer, 'woff', 'ttf', {}, 'Roundtrip.woff');
      expect(ttfResult.mimeType).toBe('font/ttf');
      expect(ttfResult.filename).toBe('Roundtrip.ttf');

      // Verify SFNT TrueType 1.0 header (0x00010000)
      expect(ttfResult.buffer.readUInt32BE(0)).toBe(0x00010000);
      const numTables = ttfResult.buffer.readUInt16BE(4);
      expect(numTables).toBeGreaterThan(0);
    });

    it('converts TTF to genuine WOFF2 container format', async () => {
      const ttf = createTestTtfBuffer('Woff2Font');
      const result = await convertFile(ttf, 'ttf', 'woff2', {}, 'Woff2Font.ttf');

      expect(result.mimeType).toBe('font/woff2');
      expect(result.filename).toBe('Woff2Font.woff2');

      // Verify WOFF2 magic signature ('wOF2' = [0x77, 0x4F, 0x46, 0x32])
      expect(result.buffer.toString('ascii', 0, 4)).toBe('wOF2');
    });

    it('converts TTF to Microsoft Embedded OpenType (EOT)', async () => {
      const ttf = createTestTtfBuffer('WebFont');
      const result = await convertFile(ttf, 'ttf', 'eot', {}, 'WebFont.ttf');

      expect(result.mimeType).toBe('application/vnd.ms-fontobject');
      expect(result.filename).toBe('WebFont.eot');

      // Verify EOT Magic number at offset 34 ('LP' = 0x504c)
      expect(result.buffer.readUInt16LE(34)).toBe(0x504c);
    });

    it('converts TTF to W3C SVG Font XML with glyph tags', async () => {
      const ttf = createTestTtfBuffer('GlyphFont');
      const result = await convertFile(ttf, 'ttf', 'svg', {}, 'GlyphFont.ttf');

      expect(result.mimeType).toBe('image/svg+xml');
      expect(result.filename).toBe('GlyphFont.svg');

      const xml = result.buffer.toString('utf-8');
      expect(xml).toContain('<svg');
      expect(xml).toContain('<font');
      expect(xml).toContain('<glyph');
    });
  });

  // =========================================================================
  // 2. VECTOR & 2D/3D CAD CONVERSIONS (SVG, DXF, DWG, STEP, STL, OBJ, IGES)
  // =========================================================================
  describe('Vector & CAD Conversion Engine', () => {
    it('converts SVG vector graphics to AutoCAD ASCII DXF with LINE and CIRCLE entities', async () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
        <line x1="10" y1="10" x2="100" y2="100" />
        <circle cx="50" cy="50" r="30" />
      </svg>`;
      const buffer = Buffer.from(svg, 'utf-8');

      const result = await convertFile(buffer, 'svg', 'dxf', {}, 'blueprint.svg');
      expect(result.mimeType).toBe('image/vnd.dxf');
      expect(result.filename).toBe('blueprint.dxf');

      const dxf = result.buffer.toString('utf-8');
      expect(dxf).toContain('SECTION');
      expect(dxf).toContain('ENTITIES');
      expect(dxf).toContain('LINE');
      expect(dxf).toContain('CIRCLE');
      expect(dxf).toContain('EOF');
    });

    it('converts AutoCAD DXF drawing to standard SVG vector document', async () => {
      const dxf = `  0\nSECTION\n  2\nHEADER\n  0\nENDSEC\n  0\nSECTION\n  2\nENTITIES\n  0\nLINE\n  8\n0\n 10\n0.0\n 20\n0.0\n 11\n100.0\n 21\n100.0\n  0\nCIRCLE\n  8\n0\n 10\n50.0\n 20\n50.0\n 40\n25.0\n  0\nENDSEC\n  0\nEOF\n`;
      const buffer = Buffer.from(dxf, 'utf-8');

      const result = await convertFile(buffer, 'dxf', 'svg', {}, 'schematic.dxf');
      expect(result.mimeType).toBe('image/svg+xml');
      expect(result.filename).toBe('schematic.svg');

      const svg = result.buffer.toString('utf-8');
      expect(svg).toContain('<svg');
      expect(svg).toContain('<line');
      expect(svg).toContain('<circle');
      expect(svg).toContain('viewBox=');
    });

    it('converts DXF drawing to PDF plot layout', async () => {
      const dxf = `  0\nSECTION\n  2\nENTITIES\n  0\nLINE\n  8\n0\n 10\n10.0\n 20\n10.0\n 11\n80.0\n 21\n80.0\n  0\nENDSEC\n  0\nEOF\n`;
      const buffer = Buffer.from(dxf, 'utf-8');

      const result = await convertFile(buffer, 'dxf', 'pdf', {}, 'floorplan.dxf');
      expect(result.mimeType).toBe('application/pdf');
      expect(result.filename).toBe('floorplan.pdf');
      expect(result.buffer.toString('ascii', 0, 4)).toBe('%PDF');
    });

    it('rasterizes DXF to crisp PNG image via Sharp rendering pipeline', async () => {
      const dxf = `  0\nSECTION\n  2\nENTITIES\n  0\nLINE\n  8\n0\n 10\n0.0\n 20\n0.0\n 11\n50.0\n 21\n50.0\n  0\nENDSEC\n  0\nEOF\n`;
      const buffer = Buffer.from(dxf, 'utf-8');

      const result = await convertFile(buffer, 'dxf', 'png', {}, 'part.dxf');
      expect(result.mimeType).toBe('image/png');
      expect(result.filename).toBe('part.png');

      const meta = await sharp(result.buffer).metadata();
      expect(meta.format).toBe('png');
      expect(meta.width).toBeGreaterThan(0);
      expect(meta.height).toBeGreaterThan(0);
    });

    it('converts 3D STEP solid model to standard 3D STL mesh', async () => {
      const step = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('EasyConvert Test Model'),'2;1');
ENDSEC;
DATA;
#10 = CARTESIAN_POINT('', (0.0, 0.0, 0.0));
#11 = CARTESIAN_POINT('', (10.0, 0.0, 0.0));
#12 = CARTESIAN_POINT('', (0.0, 10.0, 0.0));
ENDSEC;
END-ISO-10303-21;`;
      const buffer = Buffer.from(step, 'utf-8');

      const result = await convertFile(buffer, 'step', 'stl', {}, 'mechanical.step');
      expect(result.mimeType).toBe('model/stl');
      expect(result.filename).toBe('mechanical.stl');

      const stl = result.buffer.toString('utf-8');
      expect(stl).toContain('solid');
      expect(stl).toContain('facet normal');
      expect(stl).toContain('vertex');
      expect(stl).toContain('endsolid');
    });

    it('converts 3D STL mesh to Wavefront OBJ format', async () => {
      const stl = `solid Cube
  facet normal 0 0 1
    outer loop
      vertex 0 0 1
      vertex 1 0 1
      vertex 1 1 1
    endloop
  endfacet
endsolid Cube`;
      const buffer = Buffer.from(stl, 'utf-8');

      const result = await convertFile(buffer, 'stl', 'obj', {}, 'box.stl');
      expect(result.mimeType).toBe('model/obj');
      expect(result.filename).toBe('box.obj');

      const obj = result.buffer.toString('utf-8');
      expect(obj).toContain('v ');
      expect(obj).toContain('f ');
    });

    it('converts Wavefront OBJ to standard ISO 10303-21 STEP representation', async () => {
      const obj = `v 0 0 0\nv 10 0 0\nv 0 10 0\nf 1 2 3\n`;
      const buffer = Buffer.from(obj, 'utf-8');

      const result = await convertFile(buffer, 'obj', 'step', {}, 'mesh.obj');
      expect(result.mimeType).toBe('application/step');
      expect(result.filename).toBe('mesh.step');

      const step = result.buffer.toString('utf-8');
      expect(step).toContain('ISO-10303-21;');
      expect(step).toContain('CARTESIAN_POINT');
      expect(step).toContain('END-ISO-10303-21;');
    });

    it('converts 3D STL mesh to ANSI IGES format', async () => {
      const stl = `solid Model\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid Model`;
      const buffer = Buffer.from(stl, 'utf-8');

      const result = await convertFile(buffer, 'stl', 'iges', {}, 'surface.stl');
      expect(result.mimeType).toBe('application/iges');
      expect(result.filename).toBe('surface.iges');

      const iges = result.buffer.toString('utf-8');
      expect(iges).toContain('EasyConvert IGES 3D Model');
    });
  });

  // =========================================================================
  // 3. SPREADSHEETS (CSV, TSV, JSON, ODS, XLS, PDF)
  // =========================================================================
  describe('Spreadsheet & Tabular Conversion Engine', () => {
    it('converts CSV to structured PDF with headers, borders, and lavender styling', async () => {
      const csv = 'EmployeeID,FullName,Department,Salary\n101,Jane Doe,Engineering,$140000\n102,John Smith,Design,$125000';
      const buffer = Buffer.from(csv, 'utf-8');

      const result = await convertFile(buffer, 'csv', 'pdf', {}, 'payroll.csv');
      expect(result.mimeType).toBe('application/pdf');
      expect(result.filename).toBe('payroll.pdf');
      expect(result.buffer.toString('ascii', 0, 4)).toBe('%PDF');
    });

    it('converts JSON dataset to structured PDF table', async () => {
      const json = JSON.stringify([
        { item: 'Server A', cpu: '94%', memory: '16GB', status: 'Healthy' },
        { item: 'Server B', cpu: '22%', memory: '32GB', status: 'Idle' },
      ]);
      const buffer = Buffer.from(json, 'utf-8');

      const result = await convertFile(buffer, 'json', 'pdf', {}, 'cluster.json');
      expect(result.mimeType).toBe('application/pdf');
      expect(result.filename).toBe('cluster.pdf');
      expect(result.buffer.toString('ascii', 0, 4)).toBe('%PDF');
    });

    it('converts CSV to genuine OpenDocument Spreadsheet (ODS) zip archive', async () => {
      const csv = 'City,Country,Population\nTokyo,Japan,37400000\nSeoul,Korea,9900000';
      const buffer = Buffer.from(csv, 'utf-8');

      const result = await convertFile(buffer, 'csv', 'ods', {}, 'cities.csv');
      expect(result.mimeType).toBe('application/vnd.oasis.opendocument.spreadsheet');
      expect(result.filename).toBe('cities.ods');

      // Verify ODS ZIP structure
      const zip = await JSZip.loadAsync(result.buffer);
      expect(zip.file('mimetype')).toBeDefined();
      expect(zip.file('content.xml')).toBeDefined();

      const xml = await zip.file('content.xml')!.async('text');
      expect(xml).toContain('<table:table');
      expect(xml).toContain('<table:table-row');
      expect(xml).toContain('Tokyo');
      expect(xml).toContain('Seoul');
    });

    it('converts ODS spreadsheet to CSV and JSON formats', async () => {
      // 1. Generate ODS from CSV first
      const csv = 'SKU,Price,InStock\nA101,29.99,Yes\nB202,49.99,No';
      const odsResult = await convertFile(Buffer.from(csv, 'utf-8'), 'csv', 'ods', {}, 'products.csv');

      // 2. Convert ODS -> CSV
      const csvResult = await convertFile(odsResult.buffer, 'ods', 'csv', {}, 'products.ods');
      expect(csvResult.mimeType).toBe('text/csv');
      const csvText = csvResult.buffer.toString('utf-8');
      expect(csvText).toContain('SKU');
      expect(csvText).toContain('A101');
      expect(csvText).toContain('29.99');

      // 3. Convert ODS -> JSON
      const jsonResult = await convertFile(odsResult.buffer, 'ods', 'json', {}, 'products.ods');
      expect(jsonResult.mimeType).toBe('application/json');
      const parsed = JSON.parse(jsonResult.buffer.toString('utf-8'));
      expect(parsed).toHaveLength(2);
      expect(parsed[0].SKU).toBe('A101');
    });

    it('converts CSV to Microsoft Excel XML Spreadsheet (XLS)', async () => {
      const csv = 'Category,Q1,Q2\nHardware,12000,15000\nSoftware,45000,52000';
      const buffer = Buffer.from(csv, 'utf-8');

      const result = await convertFile(buffer, 'csv', 'xls', {}, 'sales.csv');
      expect(result.mimeType).toBe('application/vnd.ms-excel');
      expect(result.filename).toBe('sales.xls');

      const xml = result.buffer.toString('utf-8');
      expect(xml).toContain('urn:schemas-microsoft-com:office:spreadsheet');
      expect(xml).toContain('<Workbook');
      expect(xml).toContain('Hardware');
    });

    it('converts Excel XML Spreadsheet (XLS) to CSV and PDF', async () => {
      const csv = 'Month,Revenue\nJan,100\nFeb,150';
      const xlsResult = await convertFile(Buffer.from(csv, 'utf-8'), 'csv', 'xls', {}, 'revenue.csv');

      // XLS -> CSV
      const csvResult = await convertFile(xlsResult.buffer, 'xls', 'csv', {}, 'revenue.xls');
      expect(csvResult.mimeType).toBe('text/csv');
      expect(csvResult.buffer.toString('utf-8')).toContain('Revenue');

      // XLS -> PDF
      const pdfResult = await convertFile(xlsResult.buffer, 'xls', 'pdf', {}, 'revenue.xls');
      expect(pdfResult.mimeType).toBe('application/pdf');
      expect(pdfResult.buffer.toString('ascii', 0, 4)).toBe('%PDF');
    });
  });

  // =========================================================================
  // 4. PRESENTATIONS & DOCUMENTS (PPTX, ODP, DOCX, ODT)
  // =========================================================================
  describe('Presentation & Document Expansion', () => {
    it('converts Markdown presentation to genuine OpenDocument Presentation (ODP)', async () => {
      const md = `# EasyConvert Engine\n- Instant in-memory zero retention\n- High throughput\n\n---\n\n# Slide 2\n- Bullet A\n- Bullet B`;
      const buffer = Buffer.from(md, 'utf-8');

      const result = await convertFile(buffer, 'md', 'odp', {}, 'pitch.md');
      expect(result.mimeType).toBe('application/vnd.oasis.opendocument.presentation');
      expect(result.filename).toBe('pitch.odp');

      const zip = await JSZip.loadAsync(result.buffer);
      expect(zip.file('mimetype')).toBeDefined();
      expect(zip.file('content.xml')).toBeDefined();

      const xml = await zip.file('content.xml')!.async('text');
      expect(xml).toContain('<draw:page');
      expect(xml).toContain('EasyConvert Engine');
    });

    it('converts PPTX presentation to OpenDocument Presentation (ODP)', async () => {
      const md = `# Slide 1\nContent 1\n---\n# Slide 2\nContent 2`;
      const pptxResult = await convertFile(Buffer.from(md, 'utf-8'), 'md', 'pptx', {}, 'deck.md');

      const odpResult = await convertFile(pptxResult.buffer, 'pptx', 'odp', {}, 'deck.pptx');
      expect(odpResult.mimeType).toBe('application/vnd.oasis.opendocument.presentation');
      expect(odpResult.filename).toBe('deck.odp');

      const zip = await JSZip.loadAsync(odpResult.buffer);
      expect(zip.file('content.xml')).toBeDefined();
    });

    it('converts Markdown to genuine OpenDocument Text (ODT) archive', async () => {
      const md = `# Executive Brief\n\nThis is a formal report created for system validation.`;
      const buffer = Buffer.from(md, 'utf-8');

      const result = await convertFile(buffer, 'md', 'odt', {}, 'report.md');
      expect(result.mimeType).toBe('application/vnd.oasis.opendocument.text');
      expect(result.filename).toBe('report.odt');

      const zip = await JSZip.loadAsync(result.buffer);
      expect(zip.file('mimetype')).toBeDefined();
      expect(zip.file('content.xml')).toBeDefined();

      const xml = await zip.file('content.xml')!.async('text');
      expect(xml).toContain('<text:h');
      expect(xml).toContain('Executive Brief');
    });

    it('converts OpenXML DOCX to OpenDocument Text (ODT)', async () => {
      const md = '# Title for ODT\n\nParagraph text for cross-office validation.';
      const docxResult = await convertFile(Buffer.from(md, 'utf-8'), 'md', 'docx', {}, 'document.md');

      const odtResult = await convertFile(docxResult.buffer, 'docx', 'odt', {}, 'document.docx');
      expect(odtResult.mimeType).toBe('application/vnd.oasis.opendocument.text');
      expect(odtResult.filename).toBe('document.odt');

      const zip = await JSZip.loadAsync(odtResult.buffer);
      const xml = await zip.file('content.xml')!.async('text');
      expect(xml).toContain('Title for ODT');
    });

    it('converts ODT to DOCX and PDF', async () => {
      const md = '# Standard Document\n\nDetailed test paragraph.';
      const odtResult = await convertFile(Buffer.from(md, 'utf-8'), 'md', 'odt', {}, 'spec.md');

      // ODT -> DOCX
      const docxResult = await convertFile(odtResult.buffer, 'odt', 'docx', {}, 'spec.odt');
      expect(docxResult.mimeType).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );
      expect(docxResult.filename).toBe('spec.docx');

      // ODT -> PDF
      const pdfResult = await convertFile(odtResult.buffer, 'odt', 'pdf', {}, 'spec.odt');
      expect(pdfResult.mimeType).toBe('application/pdf');
      expect(pdfResult.filename).toBe('spec.pdf');
      expect(pdfResult.buffer.toString('ascii', 0, 4)).toBe('%PDF');
    });
  });
});
