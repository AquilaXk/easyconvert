import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { convertFile } from '../src/lib/conversions';
import { encodeWoff2, decodeWoff2, createCanonicalFont } from '../src/lib/conversions/font';
import { extractStepBRepMesh, parseStepEntities, extractStepPoint } from '../src/lib/conversions/cad-nurbs';
import { extractEmbeddedImageFromPdf } from '../src/lib/conversions/pdf-utils';

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');

async function ensureGoldenFixtures() {
  if (!fs.existsSync(FIXTURES_DIR)) {
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  }

  // 1. Golden STEP Model (ISO-10303-21 B-Rep Cube)
  const stepPath = path.join(FIXTURES_DIR, 'sample.step');
  if (!fs.existsSync(stepPath)) {
    const stepContent = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('EasyConvert Golden STEP B-Rep Model'), '2;1');
FILE_NAME('cube.step', '2026-09-27', ('Antigravity'), ('EasyConvert Engine'), 'Processor', 'System', 'Auth');
FILE_SCHEMA(('CONFIG_CONTROL_DESIGN'));
ENDSEC;
DATA;
#10=CARTESIAN_POINT('ORIGIN', (0.0, 0.0, 0.0));
#20=CARTESIAN_POINT('P1', (0.0, 0.0, 0.0));
#21=CARTESIAN_POINT('P2', (10.0, 0.0, 0.0));
#22=CARTESIAN_POINT('P3', (10.0, 10.0, 0.0));
#23=CARTESIAN_POINT('P4', (0.0, 10.0, 0.0));
#24=CARTESIAN_POINT('P5', (0.0, 0.0, 10.0));
#25=CARTESIAN_POINT('P6', (10.0, 0.0, 10.0));
#26=CARTESIAN_POINT('P7', (10.0, 10.0, 10.0));
#27=CARTESIAN_POINT('P8', (0.0, 10.0, 10.0));
#30=VERTEX_POINT('V1', #20);
#31=VERTEX_POINT('V2', #21);
#32=VERTEX_POINT('V3', #22);
#33=VERTEX_POINT('V4', #23);
#34=VERTEX_POINT('V5', #24);
#35=VERTEX_POINT('V6', #25);
#36=VERTEX_POINT('V7', #26);
#37=VERTEX_POINT('V8', #27);
#40=LINE('L1', #20, #50);
#50=VECTOR('VEC1', #60, 10.0);
#60=DIRECTION('DIR1', (1.0, 0.0, 0.0));
#70=EDGE_CURVE('E1', #30, #31, #40, .T.);
#71=EDGE_CURVE('E2', #31, #32, #40, .T.);
#72=EDGE_CURVE('E3', #32, #33, #40, .T.);
#73=EDGE_CURVE('E4', #33, #30, #40, .T.);
#80=ORIENTED_EDGE('OE1', *, *, #70, .T.);
#81=ORIENTED_EDGE('OE2', *, *, #71, .T.);
#82=ORIENTED_EDGE('OE3', *, *, #72, .T.);
#83=ORIENTED_EDGE('OE4', *, *, #73, .T.);
#90=EDGE_LOOP('LOOP_BOTTOM', (#80, #81, #82, #83));
#100=FACE_OUTER_BOUND('BOUND_BOTTOM', #90, .T.);
#110=PLANE('PLANE_BOTTOM', #120);
#120=AXIS2_PLACEMENT_3D('AXIS_BOTTOM', #10, #130, #140);
#130=DIRECTION('Z_BOTTOM', (0.0, 0.0, 1.0));
#140=DIRECTION('X_BOTTOM', (1.0, 0.0, 0.0));
#150=ADVANCED_FACE('FACE_BOTTOM', (#100), #110, .F.);
#200=CLOSED_SHELL('CUBE_SHELL', (#150));
#210=MANIFOLD_SOLID_BREP('CUBE_SOLID', #200);
ENDSEC;
END-ISO-10303-21;
`;
    fs.writeFileSync(stepPath, stepContent, 'utf-8');
  }

  // 2. Golden DOCX (Valid OpenXML package)
  const docxPath = path.join(FIXTURES_DIR, 'sample.docx');
  if (!fs.existsSync(docxPath)) {
    const docxZip = new JSZip();
    docxZip.file(
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
    );
    docxZip.file(
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
    );
    docxZip.file(
      'word/document.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>EasyConvert Golden DOCX Standard</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>This is deterministic regression fixture text for enterprise document conversion verification.</w:t></w:r>
    </w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Header A</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Header B</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Value 1</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Value 2</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
  </w:body>
</w:document>`
    );
    const docxBuf = await docxZip.generateAsync({ type: 'nodebuffer' });
    fs.writeFileSync(docxPath, docxBuf);
  }

  // 3. Golden XLSX (Valid OpenXML Spreadsheet with column AA)
  const xlsxPath = path.join(FIXTURES_DIR, 'sample.xlsx');
  if (!fs.existsSync(xlsxPath)) {
    const xlsxZip = new JSZip();
    xlsxZip.file(
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`
    );
    xlsxZip.file(
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
    );
    xlsxZip.file(
      'xl/workbook.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheets>
    <sheet name="Sheet1" sheetId="1" id="rId1"/>
  </sheets>
</workbook>`
  );
    xlsxZip.file(
      'xl/_rels/workbook.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`
    );
    xlsxZip.file(
      'xl/worksheets/sheet1.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="inlineStr"><is><t>Col A</t></is></c>
      <c r="Z1" t="inlineStr"><is><t>Col Z</t></is></c>
      <c r="AA1" t="inlineStr"><is><t>Col AA (Bijective 27)</t></is></c>
      <c r="AB1" t="inlineStr"><is><t>Col AB (Bijective 28)</t></is></c>
    </row>
    <row r="2">
      <c r="A2"><v>100</v></c>
      <c r="Z2"><v>200</v></c>
      <c r="AA2"><v>300</v></c>
      <c r="AB2"><v>400</v></c>
    </row>
  </sheetData>
</worksheet>`
    );
    const xlsxBuf = await xlsxZip.generateAsync({ type: 'nodebuffer' });
    fs.writeFileSync(xlsxPath, xlsxBuf);
  }

  // 4. Golden PDF (Valid PDF via pdf-lib)
  const pdfPath = path.join(FIXTURES_DIR, 'sample.pdf');
  if (!fs.existsSync(pdfPath)) {
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const page = pdfDoc.addPage([600, 400]);
    page.drawText('EasyConvert Golden PDF Document', {
      x: 50,
      y: 350,
      size: 24,
      font,
      color: rgb(0.1, 0.1, 0.1),
    });
    page.drawText('Deterministic regression oracle fixture text stream.', {
      x: 50,
      y: 300,
      size: 14,
      font,
      color: rgb(0.3, 0.3, 0.3),
    });
    pdfDoc.setTitle('EasyConvert Golden Document');
    pdfDoc.setAuthor('EasyConvert Engine');
    const pdfBytes = await pdfDoc.save();
    fs.writeFileSync(pdfPath, Buffer.from(pdfBytes));
  }

  // 6. Golden WOFF2 Font
  const woff2Path = path.join(FIXTURES_DIR, 'sample.woff2');
  if (!fs.existsSync(woff2Path)) {
    const sampleFont = createCanonicalFont(Buffer.alloc(0), 'EasyConvertGoldenFont');
    const woff2Buf = encodeWoff2(sampleFont);
    fs.writeFileSync(woff2Path, woff2Buf);
  }

  // 7. Golden ZIP Archive
  const zipPath = path.join(FIXTURES_DIR, 'sample.zip');
  if (!fs.existsSync(zipPath)) {
    const zip = new JSZip();
    zip.file('hello.txt', 'Hello EasyConvert Golden Archive!');
    zip.file('metadata.json', JSON.stringify({ version: '1.0', engine: 'EasyConvert' }));
    const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });
    fs.writeFileSync(zipPath, zipBuf);
  }
}

describe('Phase 4: Golden Binary Testnet, Decoder Oracle Validation & Fuzzing Guards', () => {
  beforeAll(async () => {
    await ensureGoldenFixtures();
  });

  describe('1. Golden Binary Fixture Integrity Checks', () => {
    it('verifies that all domain golden fixtures exist with non-zero byte size', () => {
      const requiredFixtures = [
        'sample.step',
        'sample.docx',
        'sample.xlsx',
        'sample.pdf',
        'sample.mp4',
        'sample.woff2',
        'sample.zip',
      ];

      for (const name of requiredFixtures) {
        const filePath = path.join(FIXTURES_DIR, name);
        expect(fs.existsSync(filePath), `Fixture ${name} must exist on disk`).toBe(true);
        const stat = fs.statSync(filePath);
        expect(stat.size, `Fixture ${name} must not be empty`).toBeGreaterThan(0);
      }
    });

    it('verifies ISO BMFF container structure of golden sample.mp4', () => {
      const mp4Buf = fs.readFileSync(path.join(FIXTURES_DIR, 'sample.mp4'));
      // Check ftyp box
      expect(mp4Buf.toString('ascii', 4, 8)).toBe('ftyp');
      expect(mp4Buf.toString('ascii', 8, 12)).toBe('isom');

      // Check moov box presence
      const moovIdx = mp4Buf.indexOf('moov');
      expect(moovIdx).toBeGreaterThan(0);

      // Check mdat box presence
      const mdatIdx = mp4Buf.indexOf('mdat');
      expect(mdatIdx).toBeGreaterThan(0);
    });

    it('verifies W3C WOFF2 signature and table directory in golden sample.woff2', () => {
      const woff2Buf = fs.readFileSync(path.join(FIXTURES_DIR, 'sample.woff2'));
      // WOFF2 magic: 0x77, 0x4F, 0x46, 0x32 ('wOF2')
      expect(woff2Buf.toString('ascii', 0, 4)).toBe('wOF2');
      // Flavor should be 0x00010000 (OpenType TrueType)
      const flavor = woff2Buf.readUInt32BE(4);
      expect(flavor).toBe(0x00010000);

      // Decode WOFF2 back to SFNT using decodeWoff2
      const decodedSfnt = decodeWoff2(woff2Buf, 'sample.woff2');
      expect(decodedSfnt.sfntVersion).toBe(0x00010000);
      expect(decodedSfnt.numTables).toBeGreaterThanOrEqual(1);
      expect(decodedSfnt.tables['head']).toBeDefined();
    });

    it('verifies B-Rep topology mesh extraction on golden sample.step', () => {
      const stepText = fs.readFileSync(path.join(FIXTURES_DIR, 'sample.step'), 'utf-8');
      const entityMap = parseStepEntities(stepText);
      const bRepMesh = extractStepBRepMesh(entityMap);

      expect(bRepMesh).toBeDefined();
      expect(bRepMesh!.vertices.length).toBeGreaterThan(0);
      expect(bRepMesh!.faces.length).toBeGreaterThan(0);

      // Verify vertex coordinate values match the STEP CARTESIAN_POINT definitions
      const flatCoords = bRepMesh!.vertices.flat();
      expect(flatCoords).toContain(10.0);
      expect(flatCoords).toContain(0.0);
    });
  });

  describe('2. Oracle Decoder Structural Validations (No Loose Size Checks)', () => {
    it('converts golden DOCX to TXT with strict structural content oracle', async () => {
      const docxBuf = fs.readFileSync(path.join(FIXTURES_DIR, 'sample.docx'));
      const result = await convertFile(docxBuf, 'docx', 'txt', {}, 'sample.docx');

      const text = result.buffer.toString('utf-8');
      // Must contain heading, paragraph, and table values extracted deterministically
      expect(text).toContain('EasyConvert Golden DOCX Standard');
      expect(text).toContain('deterministic regression fixture text');
      expect(text).toContain('Header A');
      expect(text).toContain('Header B');
      expect(text).toContain('Value 1');
      expect(text).toContain('Value 2');
    });

    it('converts golden XLSX to CSV and verifies Bijective Base-26 column coordinates (AA1)', async () => {
      const xlsxBuf = fs.readFileSync(path.join(FIXTURES_DIR, 'sample.xlsx'));
      const result = await convertFile(xlsxBuf, 'xlsx', 'csv', {}, 'sample.xlsx');

      const csvText = result.buffer.toString('utf-8');
      // Col AA must NOT have collapsed into Col A
      expect(csvText).toContain('Col A');
      expect(csvText).toContain('Col Z');
      expect(csvText).toContain('Col AA (Bijective 27)');
      expect(csvText).toContain('Col AB (Bijective 28)');
      expect(csvText).toContain('100');
      expect(csvText).toContain('200');
      expect(csvText).toContain('300');
      expect(csvText).toContain('400');
    });

    it('converts golden STEP model to OBJ with verified geometric vertices and face definitions', async () => {
      const stepBuf = fs.readFileSync(path.join(FIXTURES_DIR, 'sample.step'));
      const result = await convertFile(stepBuf, 'step', 'obj', {}, 'sample.step');

      const objText = result.buffer.toString('utf-8');
      // OBJ must have valid 'v x y z' vertex definitions and 'f v1 v2 v3' face definitions
      const lines = objText.split('\n');
      const vLines = lines.filter((l) => l.startsWith('v '));
      const fLines = lines.filter((l) => l.startsWith('f '));

      expect(vLines.length).toBeGreaterThan(0);
      expect(fLines.length).toBeGreaterThan(0);

      // Verify vertex coordinate format
      const firstVertex = vLines[0].split(/\s+/).slice(1).map(Number);
      expect(firstVertex.length).toBe(3);
      expect(firstVertex.every((n) => !Number.isNaN(n))).toBe(true);
    });

    it('converts golden ZIP archive to TAR with valid POSIX ustar headers', async () => {
      const zipBuf = fs.readFileSync(path.join(FIXTURES_DIR, 'sample.zip'));
      const result = await convertFile(zipBuf, 'zip', 'tar', {}, 'sample.zip');

      const tarBuf = result.buffer;
      // POSIX ustar header checks:
      // Offset 257 contains 'ustar' magic bytes
      const magic = tarBuf.toString('ascii', 257, 262);
      expect(magic).toBe('ustar');

      // The TAR buffer should contain hello.txt entry
      const tarString = tarBuf.toString('utf-8');
      expect(tarString).toContain('hello.txt');
      expect(tarString).toContain('Hello EasyConvert Golden Archive!');
    });
  });

  describe('3. Malformed Header Fuzzing & Fail-Closed Robustness', () => {
    it('fails closed when given a truncated/corrupted MP4 container', async () => {
      // Create corrupt MP4: valid ftyp header followed by random corrupted garbage
      const corruptMp4 = Buffer.from([
        0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, // 'ftyp'
        0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
        0xff, 0xff, 0xff, 0xff, 0xde, 0xad, 0xbe, 0xef,
      ]);

      // Converting corrupt MP4 to MP3 should reject or fail closed (no fake beep synthesis)
      await expect(
        convertFile(corruptMp4, 'mp4', 'mp3', {}, 'corrupted.mp4')
      ).rejects.toThrow();
    });

    it('fails closed when given an invalid/corrupted WOFF2 font header', () => {
      const corruptWoff2 = Buffer.from([
        0x00, 0x00, 0x00, 0x00, // Invalid magic (not 'wOF2')
        0x00, 0x01, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x20,
      ]);

      expect(() => decodeWoff2(corruptWoff2, 'corrupt.woff2')).toThrow(/missing wOF2 magic signature/);
    });

    it('fails closed when given a truncated STEP file with broken syntax', () => {
      const corruptStep = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Corrupted Model'), '2;1');
DATA;
#10=CARTESIAN_POINT('CORRUPT', (invalid_syntax_not_numbers));
ENDSEC;`;

      const entityMap = parseStepEntities(corruptStep);
      const mesh = extractStepBRepMesh(entityMap);
      // Fails closed gracefully without crashing or throwing unhandled errors
      expect(mesh).toBeNull();
    });

    it('fails closed when given an invalid zip/docx file buffer', async () => {
      const corruptZip = Buffer.from('This is completely invalid non-zip binary payload');
      await expect(
        convertFile(corruptZip, 'docx', 'txt', {}, 'corrupt.docx')
      ).rejects.toThrow();
    });

    it('fails closed on malformed PDF buffer missing standard header', async () => {
      const corruptPdf = Buffer.from('CORRUPT_HEADER_NOT_PDF_DATA_STREAM_XYZ');
      await expect(
        convertFile(corruptPdf, 'pdf', 'txt', {}, 'corrupt.pdf')
      ).rejects.toThrow();
    });

    it('fails closed and prevents infinite recursion when given STEP entities with mutual circular reference', () => {
      const loopStep = `ISO-10303-21;
HEADER;
FILE_NAME('loop.step', '2026-09-27', ('Auth'), ('EasyConvert'), '', '', '');
ENDSEC;
DATA;
#10=VERTEX_POINT('V1', #20);
#20=VERTEX_POINT('V2', #10);
#70=EDGE_CURVE('E1', #10, #20, #40, .T.);
#80=ORIENTED_EDGE('OE1', *, *, #70, .T.);
#90=EDGE_LOOP('LOOP', (#80));
#100=FACE_OUTER_BOUND('BOUND', #90, .T.);
#150=ADVANCED_FACE('FACE', (#100), #110, .F.);
ENDSEC;
END-ISO-10303-21;`;

      const entityMap = parseStepEntities(loopStep);
      // Directly check point resolution and B-Rep extraction on cyclic graph
      const pt = extractStepPoint(10, entityMap);
      expect(pt).toBeNull();

      const mesh = extractStepBRepMesh(entityMap);
      expect(mesh).toBeNull();
    });

    it('fails closed and prevents infinite recursion when given self-referential STEP entities', () => {
      const selfLoopStep = `ISO-10303-21;
HEADER;
FILE_NAME('self_loop.step', '2026-09-27', ('Auth'), ('EasyConvert'), '', '', '');
ENDSEC;
DATA;
#10=VERTEX_POINT('V1', #10);
ENDSEC;
END-ISO-10303-21;`;

      const entityMap = parseStepEntities(selfLoopStep);
      const pt = extractStepPoint(10, entityMap);
      expect(pt).toBeNull();
    });

    it('fails closed when WOFF2 has valid header but corrupted Brotli compressed stream instead of returning synthetic font', () => {
      // 48-byte header with 'wOF2' signature + valid table entry flag + corrupted compressed stream
      const header = Buffer.alloc(48);
      header.write('wOF2', 0, 4, 'ascii');
      header.writeUInt32BE(0x00010000, 4); // flavor
      header.writeUInt16BE(1, 12); // numTables = 1
      const tableDir = Buffer.from([0x00, 0x10]); // tag 0, length 16
      const corruptPayload = Buffer.from('TOTALLY_CORRUPTED_NON_BROTLI_BITSTREAM_BYTES_XYZ');
      header.writeUInt32BE(header.length + tableDir.length + corruptPayload.length, 8); // total length
      header.writeUInt32BE(corruptPayload.length, 20); // total compressed size
      const corruptWoff2 = Buffer.concat([header, tableDir, corruptPayload]);

      expect(() => decodeWoff2(corruptWoff2, 'corrupt.woff2')).toThrow(/not a valid Brotli stream/);
    });

    it('extracts embedded image from PDF when /Filter /DCTDecode has whitespace formatting', () => {
      const pdfWithSpaces = Buffer.from(
        '%PDF-1.4\n1 0 obj\n<< /Type /XObject /Subtype /Image /Width 10 /Height 10 /Filter /DCTDecode /Length 12 >>\nstream\n' +
        'FAKE_JPG_DATA\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF'
      );
      const extracted = extractEmbeddedImageFromPdf(pdfWithSpaces);
      expect(extracted).not.toBeNull();
      expect(extracted!.toString('ascii')).toBe('FAKE_JPG_DATA');
    });

  });
});
