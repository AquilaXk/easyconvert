import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import sharp from 'sharp';
import { convertFile } from '../src/lib/conversions';
import { parseAllXlsxWorksheets } from '../src/lib/conversions/office';
import { probeNativeEngines, executeWorkerConversion } from '../src/worker/engines';
import { synthesizeEnterpriseMultiSlidePptx } from './helpers/golden-corpus-suite';

describe('Phase 3: Office Headless Engine Bridge & DrawingML Parser', () => {
  it('parses DrawingML tables (<p:graphicFrame>) from PPTX slides', async () => {
    const { buffer } = await synthesizeEnterpriseMultiSlidePptx();

    // Convert to text to verify table content is extracted
    const txtRes = await convertFile(buffer, 'pptx', 'txt', {}, 'benchmark.pptx');
    const textOutput = txtRes.buffer.toString('utf-8');

    expect(textOutput).toContain('SSIM Index');
    expect(textOutput).toContain('Phase 5 SOTA');
    expect(textOutput).toContain('Peak SNR');
    expect(textOutput).toContain('44.8 dB');

    // Convert to PDF and verify header and output
    const pdfRes = await convertFile(buffer, 'pptx', 'pdf', {}, 'benchmark.pptx');
    expect(pdfRes.mimeType).toBe('application/pdf');
    expect(pdfRes.buffer.subarray(0, 4).toString('ascii')).toBe('%PDF');

    // Convert to HTML and verify table rendering in SVG
    const htmlRes = await convertFile(buffer, 'pptx', 'html', {}, 'benchmark.pptx');
    const htmlOutput = htmlRes.buffer.toString('utf-8');
    expect(htmlOutput).toContain('SSIM Index');
    expect(htmlOutput).toContain('Phase 5 SOTA');
    expect(htmlOutput).toContain('<rect');
  });

  it('parses DrawingML pictures (<p:pic>) and group shapes (<p:grpSp>) in PPTX', async () => {
    // Synthesize a 1-slide PPTX containing an embedded PNG picture and a group shape
    const zip = new JSZip();

    const samplePng = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 4,
        background: { r: 92, g: 107, b: 192, alpha: 1 },
      },
    })
      .png()
      .toBuffer();

    zip.file('ppt/media/logo.png', samplePng);

    zip.file(
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`
    );

    zip.file(
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`
    );

    zip.file(
      'ppt/presentation.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldSz cx="12192000" cy="6858000"/>
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
</p:presentation>`
    );

    zip.file(
      'ppt/_rels/presentation.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`
    );

    zip.file(
      'ppt/slides/_rels/slide1.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/logo.png"/>
</Relationships>`
    );

    zip.file(
      'ppt/slides/slide1.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
      
      <!-- Slide title -->
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="500000" y="500000"/><a:ext cx="8000000" cy="500000"/></a:xfrm></p:spPr>
        <p:txBody><a:bodyPr/><a:p><a:r><a:t>DrawingML Visual Media Slide</a:t></a:r></a:p></p:txBody>
      </p:sp>

      <!-- Picture shape <p:pic> -->
      <p:pic>
        <p:nvPicPr><p:cNvPr id="3" name="Brand Logo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
        <p:blipFill>
          <a:blip r:embed="rIdImg1"/>
        </p:blipFill>
        <p:spPr>
          <a:xfrm><a:off x="1000000" y="1500000"/><a:ext cx="1270000" cy="1270000"/></a:xfrm>
        </p:spPr>
      </p:pic>

      <!-- Group shape <p:grpSp> with coordinate transforms -->
      <p:grpSp>
        <p:nvGrpSpPr><p:cNvPr id="4" name="Node Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
        <p:grpSpPr>
          <a:xfrm>
            <a:off x="3000000" y="1500000"/><a:ext cx="4000000" cy="2000000"/>
            <a:chOff x="0" y="0"/><a:chExt cx="4000000" cy="2000000"/>
          </a:xfrm>
        </p:grpSpPr>
        <p:sp>
          <p:nvSpPr><p:cNvPr id="5" name="Grouped Rect"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="500000" y="500000"/><a:ext cx="3000000" cy="1000000"/></a:xfrm>
            <a:solidFill><a:srgbClr val="5C6BC0"/></a:solidFill>
          </p:spPr>
          <p:txBody><a:bodyPr/><a:p><a:r><a:t>Grouped Transform Box</a:t></a:r></a:p></p:txBody>
        </p:sp>
      </p:grpSp>
    </p:spTree>
  </p:cSld>
</p:sld>`
    );

    const pptxBuffer = await zip.generateAsync({ type: 'nodebuffer' });

    // Verify PDF conversion succeeds and embeds image without crashing
    const pdfRes = await convertFile(pptxBuffer, 'pptx', 'pdf', {}, 'media.pptx');
    expect(pdfRes.mimeType).toBe('application/pdf');
    expect(pdfRes.buffer.subarray(0, 4).toString('ascii')).toBe('%PDF');

    // Verify HTML conversion renders <image ...> tag for the picture
    const htmlRes = await convertFile(pptxBuffer, 'pptx', 'html', {}, 'media.pptx');
    const html = htmlRes.buffer.toString('utf-8');
    expect(html).toContain('<image href="data:image/png;base64,');
    expect(html).toContain('Grouped Transform Box');
  });

  it('parses XLSX worksheets with custom column widths, cell fills, borders, and number alignments', async () => {
    const zip = new JSZip();

    zip.file(
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`
    );

    zip.file(
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
    );

    zip.file(
      'xl/workbook.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Financials" sheetId="1" r:id="rIdSheet1"/></sheets>
</workbook>`
    );

    zip.file(
      'xl/_rels/workbook.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdSheet1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
    );

    zip.file(
      'xl/styles.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
  </fonts>
  <fills count="2">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF5C6BC0"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/></border>
    <border><left style="thin"/><right style="thin"/><top style="thin"/><bottom style="thin"/></border>
  </borders>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
    <xf numFmtId="0" fontId="1" fillId="1" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center"/>
    </xf>
  </cellXfs>
</styleSheet>`
    );

    zip.file(
      'xl/worksheets/sheet1.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cols>
    <col min="1" max="1" width="24.0" customWidth="1"/>
    <col min="2" max="2" width="16.0" customWidth="1"/>
  </cols>
  <sheetData>
    <row r="1">
      <c r="A1" s="1" t="inlineStr"><is><t>Division</t></is></c>
      <c r="B1" s="1" t="inlineStr"><is><t>Revenue</t></is></c>
    </row>
    <row r="2">
      <c r="A2" s="0" t="inlineStr"><is><t>Edge Operations</t></is></c>
      <c r="B2" s="0"><v>1250000</v></c>
    </row>
  </sheetData>
</worksheet>`
    );

    const xlsxBuffer = await zip.generateAsync({ type: 'nodebuffer' });

    // Test worksheet parsing structured metadata
    const sheets = await parseAllXlsxWorksheets(xlsxBuffer);
    expect(sheets.length).toBe(1);
    expect(sheets[0].name).toBe('Financials');
    expect(sheets[0].columnWidths).toBeDefined();
    expect(sheets[0].columnWidths![0]).toBeGreaterThan(50);

    const structured = sheets[0].structuredRows;
    expect(structured).toBeDefined();
    expect(structured![0][0].bold).toBe(true);
    expect(structured![0][0].align).toBe('center');
    expect(structured![0][0].fillColor).toBe('#5C6BC0');

    // Test XLSX -> PDF rendering with structured styling
    const pdfRes = await convertFile(xlsxBuffer, 'xlsx', 'pdf', {}, 'financials.xlsx');
    expect(pdfRes.mimeType).toBe('application/pdf');
    expect(pdfRes.buffer.subarray(0, 4).toString('ascii')).toBe('%PDF');
    expect(pdfRes.buffer.length).toBeGreaterThan(1000);
  });

  it('probes native engines and dispatches worker conversion with fail-closed fallback', async () => {
    const probe = probeNativeEngines();
    expect(typeof probe.soffice).toBe('boolean');
    expect(typeof probe.ffmpeg).toBe('boolean');
    expect(typeof probe.p7zip).toBe('boolean');
    expect(typeof probe.pdftoppm).toBe('boolean');

    // Verify worker conversion orchestrator on office formats with pure TS fallback
    const md = '# Fast Office Conversion\nHigh-density processing without external latency.';
    const workerRes = await executeWorkerConversion(Buffer.from(md, 'utf-8'), 'md', 'docx', {}, 'test.md');

    expect(workerRes.buffer).toBeDefined();
    expect(workerRes.engineUsed).toBe('internal-fallback');
    expect(workerRes.executionTimeMs).toBeGreaterThanOrEqual(0);
    expect(workerRes.size).toBe(workerRes.buffer.length);
  });
});
