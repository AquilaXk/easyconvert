import JSZip from 'jszip';
import sharp from 'sharp';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { demosaicBayerCfa, BayerPattern, BayerSensorData } from '../../src/lib/conversions/image';
import { crc32, compressZstd } from '../../src/lib/conversions/archive';

// ============================================================================
// 1. Enterprise Multi-Sheet XLSX with NumberFormat & Formula Engine
// ============================================================================

export interface GoldenXlsxResult {
  buffer: Buffer;
  sheets: string[];
  cellCount: number;
  formulaCount: number;
  expectedValues: Record<string, string | number>;
}

export async function synthesizeEnterpriseMultiSheetXlsx(): Promise<GoldenXlsxResult> {
  const zip = new JSZip();

  // 1. [Content_Types].xml
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedString+xml"/>
</Types>`
  );

  // 2. _rels/.rels
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
  );

  // 3. xl/workbook.xml with 3 sheets
  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Executive_Summary" sheetId="1" r:id="rId1"/>
    <sheet name="Q1_Financials" sheetId="2" r:id="rId2"/>
    <sheet name="Regional_Breakdown" sheetId="3" r:id="rId3"/>
  </sheets>
</workbook>`
  );

  // 4. xl/_rels/workbook.xml.rels
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`
  );

  // 5. xl/styles.xml with custom number formats
  zip.file(
    'xl/styles.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="3">
    <numFmt numFmtId="164" formatCode="$#,##0.00"/>
    <numFmt numFmtId="165" formatCode="0.0%"/>
    <numFmt numFmtId="166" formatCode="yyyy-mm-dd"/>
  </numFmts>
  <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf/></cellStyleXfs>
  <cellXfs count="5">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  </cellXfs>
</styleSheet>`
  );

  // 6. xl/sharedStrings.xml
  const sstItems = [
    'Category',
    'Gross Revenue',
    'Operating Margin',
    'Audit Date',
    'Enterprise Cloud Tier',
    'Edge WASM Compute',
    'Zero-Heap Ingestion',
    'North America',
    'EMEA',
    'Asia Pacific',
    'Consolidated Subtotal',
    'Annualized Run-Rate',
  ];
  const sstXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sstItems.length}" uniqueCount="${sstItems.length}">
  ${sstItems.map((s) => `<si><t>${s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</t></si>`).join('\n  ')}
</sst>`;
  zip.file('xl/sharedStrings.xml', sstXml);

  // 7. xl/worksheets/sheet1.xml (Executive_Summary)
  zip.file(
    'xl/worksheets/sheet1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="s"><v>1</v></c>
      <c r="C1" t="s"><v>2</v></c>
      <c r="D1" t="s"><v>3</v></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>4</v></c>
      <c r="B2" s="1"><v>1250000.50</v></c>
      <c r="C2" s="2"><v>0.342</v></c>
      <c r="D2" s="3"><v>45562</v></c>
    </row>
    <row r="3">
      <c r="A3" t="s"><v>5</v></c>
      <c r="B3" s="1"><v>895400.00</v></c>
      <c r="C3" s="2"><v>0.418</v></c>
      <c r="D3" s="3"><v>45562</v></c>
    </row>
    <row r="4">
      <c r="A4" t="s"><v>6</v></c>
      <c r="B4" s="1"><v>642100.25</v></c>
      <c r="C4" s="2"><v>0.285</v></c>
      <c r="D4" s="3"><v>45562</v></c>
    </row>
    <row r="5">
      <c r="A5" t="s"><v>10</v></c>
      <c r="B5" s="1"><f>SUM(B2:B4)</f><v>2787500.75</v></c>
      <c r="C5" s="2"><f>AVERAGE(C2:C4)</f><v>0.3483</v></c>
      <c r="D5"/>
    </row>
  </sheetData>
</worksheet>`
  );

  // 8. xl/worksheets/sheet2.xml (Q1_Financials)
  zip.file(
    'xl/worksheets/sheet2.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="s"><v>1</v></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>7</v></c>
      <c r="B2" s="1"><v>1420500.00</v></c>
    </row>
    <row r="3">
      <c r="A3" t="s"><v>8</v></c>
      <c r="B3" s="1"><v>980200.00</v></c>
    </row>
    <row r="4">
      <c r="A4" t="s"><v>9</v></c>
      <c r="B4" s="1"><v>386800.75</v></c>
    </row>
    <row r="5">
      <c r="A5" t="s"><v>10</v></c>
      <c r="B5" s="1"><f>SUM(B2:B4)</f><v>2787500.75</v></c>
    </row>
  </sheetData>
</worksheet>`
  );

  // 9. xl/worksheets/sheet3.xml (Regional_Breakdown)
  zip.file(
    'xl/worksheets/sheet3.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>11</v></c>
      <c r="B1" s="1"><f>Q1_Financials!B5 * 4</f><v>11150003.00</v></c>
    </row>
  </sheetData>
</worksheet>`
  );

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  return {
    buffer,
    sheets: ['Executive_Summary', 'Q1_Financials', 'Regional_Breakdown'],
    cellCount: 20,
    formulaCount: 3,
    expectedValues: {
      'Executive_Summary!B5': 2787500.75,
      'Executive_Summary!C5': 0.3483,
      'Regional_Breakdown!B1': 11150003.0,
    },
  };
}

// ============================================================================
// 2. Enterprise Multi-Slide Visual Presentation PPTX
// ============================================================================

export interface GoldenPptxResult {
  buffer: Buffer;
  slideCount: number;
  shapeCount: number;
  slideTitles: string[];
}

export async function synthesizeEnterpriseMultiSlidePptx(): Promise<GoldenPptxResult> {
  const zip = new JSZip();

  // [Content_Types].xml
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slides/slide3.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`
  );

  // _rels/.rels
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`
  );

  // ppt/presentation.xml (16:9 12192000 x 6858000 EMUs = 960x540 pt)
  zip.file(
    'ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldSz cx="12192000" cy="6858000"/>
  <p:sldIdLst>
    <p:sldId id="256" r:id="rId1"/>
    <p:sldId id="257" r:id="rId2"/>
    <p:sldId id="258" r:id="rId3"/>
  </p:sldIdLst>
</p:presentation>`
  );

  // ppt/_rels/presentation.xml.rels
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide3.xml"/>
</Relationships>`
  );

  // Slide 1: Title slide with dark background (#0F172A)
  zip.file(
    'ppt/slides/slide1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld>
    <p:bg>
      <p:bgPr>
        <a:solidFill><a:srgbClr val="0F172A"/></a:solidFill>
      </p:bgPr>
    </p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="1000000" y="1500000"/><a:ext cx="10192000" cy="1200000"/></a:xfrm>
        </p:spPr>
        <p:txBody>
          <a:bodyPr/>
          <a:p><a:r><a:rPr sz="4400" b="1"><a:solidFill><a:srgbClr val="F8FAFC"/></a:solidFill></a:rPr><a:t>Enterprise Architecture &amp; Golden VRT CI</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Subtitle"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="1000000" y="3000000"/><a:ext cx="10192000" cy="800000"/></a:xfrm>
        </p:spPr>
        <p:txBody>
          <a:bodyPr/>
          <a:p><a:r><a:rPr sz="2200"><a:solidFill><a:srgbClr val="94A3B8"/></a:solidFill></a:rPr><a:t>Phase 5 High-Fidelity Differential Verification Engine</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`
  );

  // Slide 2: Geometric Shapes (DrawingML rect, ellipse, roundRect)
  zip.file(
    'ppt/slides/slide2.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="4" name="Header"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="800000" y="500000"/><a:ext cx="10000000" cy="600000"/></a:xfrm></p:spPr>
        <p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="3200" b="1"/><a:t>DrawingML Multi-Shape Topology</a:t></a:r></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="5" name="RectShape"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="1000000" y="1600000"/><a:ext cx="2800000" cy="2400000"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:solidFill><a:srgbClr val="3B82F6"/></a:solidFill>
        </p:spPr>
        <p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="1800"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>Compute Node L0</a:t></a:r></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="6" name="EllipseShape"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="4600000" y="1600000"/><a:ext cx="2800000" cy="2400000"/></a:xfrm>
          <a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>
          <a:solidFill><a:srgbClr val="10B981"/></a:solidFill>
        </p:spPr>
        <p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="1800"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>SIMD Worker L2</a:t></a:r></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="7" name="TriangleShape"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="8200000" y="1600000"/><a:ext cx="2800000" cy="2400000"/></a:xfrm>
          <a:prstGeom prst="triangle"><a:avLst/></a:prstGeom>
          <a:solidFill><a:srgbClr val="F59E0B"/></a:solidFill>
        </p:spPr>
        <p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="1800"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>OPFS VFS L3</a:t></a:r></a:p></p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`
  );

  // Slide 3: Table shape
  zip.file(
    'ppt/slides/slide3.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="8" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="800000" y="500000"/><a:ext cx="10000000" cy="600000"/></a:xfrm></p:spPr>
        <p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="3200" b="1"/><a:t>Verification Benchmark Results</a:t></a:r></a:p></p:txBody>
      </p:sp>
      <p:graphicFrame>
        <p:nvGraphicFramePr><p:cNvPr id="9" name="Table 1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
        <p:xfrm><a:off x="1000000" y="1500000"/><a:ext cx="10000000" cy="3000000"/></p:xfrm>
        <a:graphic>
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
            <a:tbl>
              <a:tblGrid><a:gridCol w="3333333"/><a:gridCol w="3333333"/><a:gridCol w="3333334"/></a:tblGrid>
              <a:tr h="600000">
                <a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:rPr b="1"/><a:t>Metric</a:t></a:r></a:p></a:txBody></a:tc>
                <a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:rPr b="1"/><a:t>Baseline</a:t></a:r></a:p></a:txBody></a:tc>
                <a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:rPr b="1"/><a:t>Phase 5 SOTA</a:t></a:r></a:p></a:txBody></a:tc>
              </a:tr>
              <a:tr h="600000">
                <a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>SSIM Index</a:t></a:r></a:p></a:txBody></a:tc>
                <a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>0.82</a:t></a:r></a:p></a:txBody></a:tc>
                <a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>0.99</a:t></a:r></a:p></a:txBody></a:tc>
              </a:tr>
              <a:tr h="600000">
                <a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>Peak SNR</a:t></a:r></a:p></a:txBody></a:tc>
                <a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>29.4 dB</a:t></a:r></a:p></a:txBody></a:tc>
                <a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>44.8 dB</a:t></a:r></a:p></a:txBody></a:tc>
              </a:tr>
            </a:tbl>
          </a:graphicData>
        </a:graphic>
      </p:graphicFrame>
    </p:spTree>
  </p:cSld>
</p:sld>`
  );

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  return {
    buffer,
    slideCount: 3,
    shapeCount: 7,
    slideTitles: [
      'Enterprise Architecture & Golden VRT CI',
      'DrawingML Multi-Shape Topology',
      'Verification Benchmark Results',
    ],
  };
}

// ============================================================================
// 3. Enterprise Multi-Column DOCX with Nested Tables & Footnotes
// ============================================================================

export interface GoldenDocxResult {
  buffer: Buffer;
  paragraphCount: number;
  tableCount: number;
  hasNestedTable: boolean;
  hasFootnotes: boolean;
}

export async function synthesizeEnterpriseMultiColumnDocx(): Promise<GoldenDocxResult> {
  const zip = new JSZip();

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>
</Types>`
  );

  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  );

  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>
</Relationships>`
  );

  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:rPr><w:b/><w:sz w:val="36"/></w:rPr><w:t>Enterprise Differential Oracle &amp; Golden Corpus</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>This document contains multi-column sections with footnotes</w:t></w:r>
      <w:r><w:footnoteReference w:id="1"/></w:r>
      <w:r><w:t> and embedded nested structures.</w:t></w:r>
    </w:p>
    <!-- Outer Table with Nested Table -->
    <w:tbl>
      <w:tblPr><w:tblW w:w="5000" w:type="pct"/></w:tblPr>
      <w:tr>
        <w:tc>
          <w:p><w:r><w:t>Outer Column 1</w:t></w:r></w:p>
        </w:tc>
        <w:tc>
          <w:p><w:r><w:t>Outer Column 2 (Nested Container):</w:t></w:r></w:p>
          <!-- Nested Table -->
          <w:tbl>
            <w:tr>
              <w:tc><w:p><w:r><w:t>Nested Cell A1</w:t></w:r></w:p></w:tc>
              <w:tc><w:p><w:r><w:t>Nested Cell B1</w:t></w:r></w:p></w:tc>
            </w:tr>
          </w:tbl>
        </w:tc>
      </w:tr>
    </w:tbl>
    <w:sectPr>
      <w:cols w:num="2" w:space="720"/>
    </w:sectPr>
  </w:body>
</w:document>`
  );

  zip.file(
    'word/footnotes.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:footnote w:id="1">
    <w:p><w:r><w:t>Verified against IEEE / ISO 29500-1 specification compliance.</w:t></w:r></w:p>
  </w:footnote>
</w:footnotes>`
  );

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  return {
    buffer,
    paragraphCount: 5,
    tableCount: 2,
    hasNestedTable: true,
    hasFootnotes: true,
  };
}

// ============================================================================
// 4. Enterprise CAD STEP AP214 B-Rep Manifold & Multi-Layer DXF
// ============================================================================

export interface GoldenStepResult {
  buffer: Buffer;
  text: string;
  vertexCount: number;
  edgeCount: number;
  faceCount: number;
  eulerCharacteristic: number;
}

export function synthesizeEnterpriseStepBRep(): GoldenStepResult {
  // A complete closed B-Rep cube satisfying Euler formula: V - E + F = 8 - 12 + 6 = 2
  const text = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('EasyConvert Enterprise SOTA Golden CAD STEP AP214 B-Rep Model'), '2;1');
FILE_NAME('golden_cube_brep.step', '2026-09-27T12:00:00', ('Antigravity Core'), ('EasyConvert Engine'), 'Processor 5.0', 'System', 'Auth');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));
ENDSEC;
DATA;
#10=CARTESIAN_POINT('ORIGIN', (0.0, 0.0, 0.0));
#20=CARTESIAN_POINT('P1', (0.0, 0.0, 0.0));
#21=CARTESIAN_POINT('P2', (20.0, 0.0, 0.0));
#22=CARTESIAN_POINT('P3', (20.0, 20.0, 0.0));
#23=CARTESIAN_POINT('P4', (0.0, 20.0, 0.0));
#24=CARTESIAN_POINT('P5', (0.0, 0.0, 20.0));
#25=CARTESIAN_POINT('P6', (20.0, 0.0, 20.0));
#26=CARTESIAN_POINT('P7', (20.0, 20.0, 20.0));
#27=CARTESIAN_POINT('P8', (0.0, 20.0, 20.0));
#30=VERTEX_POINT('V1', #20);
#31=VERTEX_POINT('V2', #21);
#32=VERTEX_POINT('V3', #22);
#33=VERTEX_POINT('V4', #23);
#34=VERTEX_POINT('V5', #24);
#35=VERTEX_POINT('V6', #25);
#36=VERTEX_POINT('V7', #26);
#37=VERTEX_POINT('V8', #27);
#40=LINE('L1', #20, #50);
#50=VECTOR('VEC_X', #60, 20.0);
#60=DIRECTION('DIR_X', (1.0, 0.0, 0.0));
#61=DIRECTION('DIR_Y', (0.0, 1.0, 0.0));
#62=DIRECTION('DIR_Z', (0.0, 0.0, 1.0));
#70=EDGE_CURVE('E1', #30, #31, #40, .T.);
#71=EDGE_CURVE('E2', #31, #32, #40, .T.);
#72=EDGE_CURVE('E3', #32, #33, #40, .T.);
#73=EDGE_CURVE('E4', #33, #30, #40, .T.);
#74=EDGE_CURVE('E5', #34, #35, #40, .T.);
#75=EDGE_CURVE('E6', #35, #36, #40, .T.);
#76=EDGE_CURVE('E7', #36, #37, #40, .T.);
#77=EDGE_CURVE('E8', #37, #34, #40, .T.);
#78=EDGE_CURVE('E9', #30, #34, #40, .T.);
#79=EDGE_CURVE('E10', #31, #35, #40, .T.);
#80=EDGE_CURVE('E11', #32, #36, #40, .T.);
#81=EDGE_CURVE('E12', #33, #37, #40, .T.);
#90=EDGE_LOOP('LOOP_BOTTOM', (#70, #71, #72, #73));
#91=EDGE_LOOP('LOOP_TOP', (#74, #75, #76, #77));
#92=EDGE_LOOP('LOOP_FRONT', (#70, #79, #74, #78));
#93=EDGE_LOOP('LOOP_BACK', (#72, #81, #76, #80));
#94=EDGE_LOOP('LOOP_LEFT', (#73, #78, #77, #81));
#95=EDGE_LOOP('LOOP_RIGHT', (#71, #80, #75, #79));
#100=FACE_OUTER_BOUND('BOUND_1', #90, .T.);
#101=FACE_OUTER_BOUND('BOUND_2', #91, .T.);
#102=FACE_OUTER_BOUND('BOUND_3', #92, .T.);
#103=FACE_OUTER_BOUND('BOUND_4', #93, .T.);
#104=FACE_OUTER_BOUND('BOUND_5', #94, .T.);
#105=FACE_OUTER_BOUND('BOUND_6', #95, .T.);
#110=PLANE('PLANE_SURF', #120);
#120=AXIS2_PLACEMENT_3D('AXIS', #10, #62, #60);
#150=ADVANCED_FACE('F1', (#100), #110, .F.);
#151=ADVANCED_FACE('F2', (#101), #110, .T.);
#152=ADVANCED_FACE('F3', (#102), #110, .T.);
#153=ADVANCED_FACE('F4', (#103), #110, .T.);
#154=ADVANCED_FACE('F5', (#104), #110, .T.);
#155=ADVANCED_FACE('F6', (#105), #110, .T.);
#200=CLOSED_SHELL('SOLID_SHELL', (#150, #151, #152, #153, #154, #155));
#210=MANIFOLD_SOLID_BREP('CUBE_SOLID', #200);
ENDSEC;
END-ISO-10303-21;
`;

  return {
    buffer: Buffer.from(text, 'utf-8'),
    text,
    vertexCount: 8,
    edgeCount: 12,
    faceCount: 6,
    eulerCharacteristic: 8 - 12 + 6, // 2
  };
}

export interface GoldenDxfResult {
  buffer: Buffer;
  text: string;
  layers: string[];
  entityCount: number;
}

export function synthesizeEnterpriseDxf(): GoldenDxfResult {
  const text = `  0
SECTION
  2
HEADER
  9
$ACADVER
  1
AC1015
  0
ENDSEC
  0
SECTION
  2
TABLES
  0
TABLE
  2
LAYER
  0
LAYER
  2
0
 70
0
 62
7
  0
LAYER
  2
STRUCTURAL_CONTOUR
 70
0
 62
1
  0
LAYER
  2
ANNOTATIONS
 70
0
 62
3
  0
ENDTAB
  0
ENDSEC
  0
SECTION
  2
ENTITIES
  0
LINE
  8
STRUCTURAL_CONTOUR
 10
0.0
 20
0.0
 30
0.0
 11
100.0
 21
0.0
 31
0.0
  0
LINE
  8
STRUCTURAL_CONTOUR
 10
100.0
 20
0.0
 30
0.0
 11
100.0
 21
50.0
 31
0.0
  0
CIRCLE
  8
STRUCTURAL_CONTOUR
 10
50.0
 20
25.0
 30
0.0
 40
15.0
  0
3DFACE
  8
STRUCTURAL_CONTOUR
 10
0.0
 20
0.0
 30
0.0
 11
10.0
 21
0.0
 31
0.0
 12
10.0
 22
10.0
 32
0.0
 13
0.0
 23
10.0
 33
0.0
  0
TEXT
  8
ANNOTATIONS
 10
10.0
 20
-10.0
 30
0.0
 40
5.0
  1
EasyConvert Golden CAD Tolerance Specification
  0
ENDSEC
  0
SECTION
  2
OBJECTS
  0
ENDSEC
  0
EOF
`;

  return {
    buffer: Buffer.from(text, 'utf-8'),
    text,
    layers: ['0', 'STRUCTURAL_CONTOUR', 'ANNOTATIONS'],
    entityCount: 5,
  };
}

// ============================================================================
// 5. ISO 32000-1 PDF 1.7 with Compressed Object Streams & Sandwich OCR
// ============================================================================

export interface GoldenPdfResult {
  buffer: Buffer;
  pageCount: number;
  hasObjectStreams: boolean;
  hasSandwichOcrText: boolean;
  metadata: {
    title: string;
    producer: string;
  };
}

export async function synthesizeEnterprisePdf(): Promise<GoldenPdfResult> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle('EasyConvert Enterprise Golden PDF Standard');
  pdfDoc.setProducer('EasyConvert ISO 32000-1 Engine 5.0');
  pdfDoc.setAuthor('Antigravity QA Core');

  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const regularFont = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // Page 1: Multi-column content
  const page1 = pdfDoc.addPage([595.28, 841.89]); // A4
  page1.drawText('Enterprise High-Fidelity Differential Architecture', {
    x: 50,
    y: 800,
    size: 20,
    font,
    color: rgb(0.06, 0.09, 0.16),
  });

  // Left Column
  page1.drawText('Column A: Distributed Core Engine', {
    x: 50,
    y: 750,
    size: 14,
    font,
    color: rgb(0.15, 0.38, 0.92),
  });
  page1.drawText('Zero-heap multipart chunk streaming ensures safe bounded RAM consumption.', {
    x: 50,
    y: 720,
    size: 10,
    font: regularFont,
    maxWidth: 220,
    color: rgb(0.2, 0.2, 0.2),
  });

  // Right Column
  page1.drawText('Column B: Differential Oracle Gate', {
    x: 320,
    y: 750,
    size: 14,
    font,
    color: rgb(0.06, 0.72, 0.51),
  });
  page1.drawText('Automated cross-comparison against reference AST structures and SSIM/PSNR gates.', {
    x: 320,
    y: 720,
    size: 10,
    font: regularFont,
    maxWidth: 220,
    color: rgb(0.2, 0.2, 0.2),
  });

  // Page 2: Synthetic Sandwich OCR Layer (Simulating 3 Tr text layer)
  const page2 = pdfDoc.addPage([595.28, 841.89]);
  page2.drawText('Page 2: OCR Scanned Document Sandwich Simulation', {
    x: 50,
    y: 800,
    size: 16,
    font,
    color: rgb(0.1, 0.1, 0.1),
  });
  page2.drawText('Recognized Text: KOREAN_SAMPLE_TEXT_OCR_SANDWICH_LAYER_2026', {
    x: 50,
    y: 750,
    size: 11,
    font: regularFont,
    color: rgb(0.3, 0.3, 0.3),
  });

  const pdfBytes = await pdfDoc.save({ useObjectStreams: true });
  const buffer = Buffer.from(pdfBytes);

  return {
    buffer,
    pageCount: 2,
    hasObjectStreams: buffer.toString('utf-8').includes('/ObjStm'),
    hasSandwichOcrText: true,
    metadata: {
      title: 'EasyConvert Enterprise Golden PDF Standard',
      producer: 'EasyConvert ISO 32000-1 Engine 5.0',
    },
  };
}

// ============================================================================
// 6. Camera RAW Bayer CFA Sensor Matrix & Color Gradient Stress Card
// ============================================================================

export function synthesizeEnterpriseBayerRaw(
  pattern: BayerPattern = 'RGGB',
  width: number = 64,
  height: number = 64
): BayerSensorData {
  const pixelCount = width * height;
  const data = new Uint16Array(pixelCount);

  // Black level 512, Saturation 16383 (14-bit standard sensor)
  const blackLevel = 512;
  const saturation = 16383;
  const maxRange = saturation - blackLevel;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;

      // Synthetic 4-quadrant color target:
      // Top-Left: Pure Red
      // Top-Right: Pure Green
      // Bottom-Left: Pure Blue
      // Bottom-Right: 50% Neutral Gray
      let r = 0;
      let g = 0;
      let b = 0;

      if (x < width / 2 && y < height / 2) {
        r = 1.0; g = 0.05; b = 0.05;
      } else if (x >= width / 2 && y < height / 2) {
        r = 0.05; g = 0.95; b = 0.05;
      } else if (x < width / 2 && y >= height / 2) {
        r = 0.05; g = 0.05; b = 0.95;
      } else {
        r = 0.5; g = 0.5; b = 0.5;
      }

      // Determine CFA channel according to Bayer pattern
      let channelVal = 0;
      const isEvenRow = y % 2 === 0;
      const isEvenCol = x % 2 === 0;

      if (pattern === 'RGGB') {
        if (isEvenRow && isEvenCol) channelVal = r;
        else if (isEvenRow && !isEvenCol) channelVal = g;
        else if (!isEvenRow && isEvenCol) channelVal = g;
        else channelVal = b;
      } else if (pattern === 'BGGR') {
        if (isEvenRow && isEvenCol) channelVal = b;
        else if (isEvenRow && !isEvenCol) channelVal = g;
        else if (!isEvenRow && isEvenCol) channelVal = g;
        else channelVal = r;
      } else if (pattern === 'GRBG') {
        if (isEvenRow && isEvenCol) channelVal = g;
        else if (isEvenRow && !isEvenCol) channelVal = r;
        else if (!isEvenRow && isEvenCol) channelVal = b;
        else channelVal = g;
      } else if (isEvenRow && isEvenCol) {
        channelVal = g;
      } else if (isEvenRow && !isEvenCol) {
        channelVal = b;
      } else if (!isEvenRow && isEvenCol) {
        channelVal = r;
      } else {
        channelVal = g;
      }

      data[idx] = Math.round(blackLevel + channelVal * maxRange);
    }
  }

  return {
    width,
    height,
    data,
    pattern,
    bitsPerSample: 14,
    blackLevel,
    whiteBalance: [2.0, 1.0, 1.5], // Standard daylight camera WB multipliers (R, G, B)
  };
}

export async function synthesizeGradientStressCard(width = 128, height = 128): Promise<Buffer> {
  const rgba = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y++) {
    const v = y / (height - 1);
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1);
      const idx = (y * width + x) * 4;

      // Complex color gradient with smooth hue transition and high-frequency radial sweep
      const r = Math.round(255 * Math.sin(u * Math.PI));
      const g = Math.round(255 * Math.cos(v * Math.PI * 0.5));
      const b = Math.round(255 * (u * 0.5 + v * 0.5));

      rgba[idx] = Math.max(0, Math.min(255, r));
      rgba[idx + 1] = Math.max(0, Math.min(255, g));
      rgba[idx + 2] = Math.max(0, Math.min(255, b));
      rgba[idx + 3] = 255;
    }
  }

  return sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

// ============================================================================
// 7. Multi-Stream 7z Archive & Zstandard Frames
// ============================================================================

export interface Golden7zResult {
  buffer: Buffer;
  signature: Buffer;
  files: Array<{ name: string; content: string; size: number }>;
}

export function synthesizeEnterprise7z(): Golden7zResult {
  const files = [
    { name: 'config.json', content: '{"engine":"EasyConvert","version":"5.0.0"}', size: 44 },
    { name: 'manifest.txt', content: 'Golden multi-stream archive payload for differential QA', size: 55 },
  ];

  // 7z 32-byte header:
  // Signature (6 bytes): 0x37 0x7A 0xBC 0xAF 0x27 0x1C
  // Major/Minor version (2 bytes): 0x00 0x04
  // StartHeaderCRC (4 bytes): CRC32 of bytes 12..31
  // NextHeaderOffset (8 bytes LE): offset from byte 32 to Header
  // NextHeaderSize (8 bytes LE): size of Header
  // NextHeaderCRC (4 bytes LE): CRC32 of Header
  const headerBuf = Buffer.alloc(32);
  headerBuf.set([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], 0);
  headerBuf[6] = 0x00; // Major
  headerBuf[7] = 0x04; // Minor

  // Payload: concatenation of file contents
  const payloadBuf = Buffer.concat(files.map((f) => Buffer.from(f.content, 'utf-8')));

  // Next header data (simulated 7z EndHeader)
  const endHeader = Buffer.from([0x17, 0x01, 0x00]); // kHeader, kEnd
  const nextHeaderOffset = payloadBuf.length;
  const nextHeaderSize = endHeader.length;
  const nextHeaderCrcVal = crc32(endHeader);

  headerBuf.writeBigUInt64LE(BigInt(nextHeaderOffset), 12);
  headerBuf.writeBigUInt64LE(BigInt(nextHeaderSize), 20);
  headerBuf.writeUInt32LE(nextHeaderCrcVal, 28);

  const startHeaderCrcVal = crc32(headerBuf.slice(12, 32));
  headerBuf.writeUInt32LE(startHeaderCrcVal, 8);

  const buffer = Buffer.concat([headerBuf, payloadBuf, endHeader]);

  return {
    buffer,
    signature: headerBuf.slice(0, 6),
    files,
  };
}

export function synthesizeEnterpriseZstd(): { buffer: Buffer; uncompressedText: string } {
  const uncompressedText = 'EasyConvert RFC 8878 Zstandard Golden Corpus High-Throughput Verification Stream';
  const rawBuf = Buffer.from(uncompressedText, 'utf-8');
  const buffer = compressZstd(rawBuf);

  return {
    buffer,
    uncompressedText,
  };
}

// ============================================================================
// 8. Adversarial & Corrupted Edge Case Fixtures
// ============================================================================

export interface CorruptedFixtures {
  pdfCyclicXref: Buffer;
  pdfTruncatedStream: Buffer;
  docxCorruptedZip: Buffer;
  xlsxUnclosedTags: Buffer;
  cadNonManifoldStep: Buffer;
  archiveZipSlip: Buffer;
  archiveTruncated7z: Buffer;
  zeroByte: Buffer;
  singleByte: Buffer;
  randomFuzz: Buffer;
}

export function synthesizeCorruptedFixtures(): CorruptedFixtures {
  // 1. PDF with cyclic xref (xref points back to itself)
  const pdfCyclicXref = Buffer.from(
    `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R >>
endobj
xref
0 4
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
trailer
<< /Size 4 /Root 1 0 R /Prev 164 >>
startxref
164
%%EOF`,
    'utf-8'
  );

  // 2. PDF truncated mid-stream without endstream or EOF
  const pdfTruncatedStream = Buffer.from(
    `%PDF-1.7
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Length 5000 >>
stream
CORRUPTED_STREAM_TRUNCATED_PREMATURELY`,
    'utf-8'
  );

  // 3. Corrupted DOCX ZIP (header says 2 files, truncated after 20 bytes)
  const docxCorruptedZip = Buffer.from([
    0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc,
  ]);

  // 4. XLSX with unclosed tags
  const xlsxUnclosedTags = Buffer.from(
    `<?xml version="1.0"?>
<worksheet><sheetData><row r="1"><c r="A1"><v>Incomplete`,
    'utf-8'
  );

  // 5. Non-manifold STEP (self-intersecting or invalid topology reference)
  const cadNonManifoldStep = Buffer.from(
    `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Malformed Non-Manifold STEP'), '2;1');
FILE_NAME('corrupt.step', '2026-09-27', ('Tester'), ('Org'), 'Proc', 'Sys', 'Auth');
FILE_SCHEMA(('CONFIG_CONTROL_DESIGN'));
ENDSEC;
DATA;
#10=CARTESIAN_POINT('P1', (0.0, 0.0, 0.0));
#20=VERTEX_POINT('V1', #999); /* Reference to non-existent entity #999 */
#30=EDGE_LOOP('SELF_INTERSECT', (#40, #40, #40));
ENDSEC;
END-ISO-10303-21;`,
    'utf-8'
  );

  // 6. Archive with ZipSlip path traversal payload
  const zipSlipHeader = Buffer.from([
    0x50, 0x4b, 0x03, 0x04, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x21, 0x84, 0x40, 0x57, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
  ]);
  const zipSlipPath = Buffer.from('../../etc/passwd', 'utf-8');
  const archiveZipSlip = Buffer.concat([zipSlipHeader, zipSlipPath]);

  // 7. Truncated 7z
  const archiveTruncated7z = Buffer.from([
    0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04, 0x00, 0x00,
    0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
  ]);

  // 8. 0-byte buffer
  const zeroByte = Buffer.alloc(0);

  // 9. Single-byte buffer
  const singleByte = Buffer.from([0x42]);

  // 10. Random fuzz noise
  const randomFuzz = Buffer.alloc(1024);
  for (let i = 0; i < randomFuzz.length; i++) {
    randomFuzz[i] = (i * 137 + 73) & 0xff;
  }

  return {
    pdfCyclicXref,
    pdfTruncatedStream,
    docxCorruptedZip,
    xlsxUnclosedTags,
    cadNonManifoldStep,
    archiveZipSlip,
    archiveTruncated7z,
    zeroByte,
    singleByte,
    randomFuzz,
  };
}
