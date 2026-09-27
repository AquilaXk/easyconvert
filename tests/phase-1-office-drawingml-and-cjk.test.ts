import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import PDFDocument from 'pdfkit';
import { convertFile } from '../src/lib/conversions';
import {
  evaluateDrawingMlGuideFormula,
  parseDrawingMlGuides,
  parseDrawingMlShapes,
  renderDrawingMlToSvg,
  parseOpenXmlChart,
  renderChartToSvg,
  isNonWinAnsi,
  sanitizeWinAnsi,
  resolveUnicodeFallbackFont,
  configurePdfKitFontFallback,
  renderSafePdfText,
  renderSinglePdfShape,
  renderPdfChart,
} from '../src/lib/conversions/office';

describe('Phase 1.2: Office High-Fidelity Engine - DrawingML, Dynamic Charts & CJK Fonts', () => {
  describe('1. DrawingML Presets & Vector Geometry', () => {
    it('parses expanded shape presets: flowchart, block arrows, callout, chevron, and cube', () => {
      const xml = `
<p:spTree xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <!-- FlowChart Process -->
  <p:sp>
    <p:spPr>
      <a:xfrm><a:off x="1270000" y="1270000"/><a:ext cx="2540000" cy="1270000"/></a:xfrm>
      <a:prstGeom prst="flowChartProcess"><a:avLst/></a:prstGeom>
      <a:solidFill><a:srgbClr val="5C6BC0"/></a:solidFill>
    </p:spPr>
    <p:txBody><a:p><a:r><a:t>Process Step</a:t></a:r></a:p></p:txBody>
  </p:sp>

  <!-- FlowChart Decision -->
  <p:sp>
    <p:spPr>
      <a:xfrm><a:off x="5080000" y="1270000"/><a:ext cx="2540000" cy="2540000"/></a:xfrm>
      <a:prstGeom prst="flowChartDecision"><a:avLst/></a:prstGeom>
      <a:solidFill><a:srgbClr val="26A69A"/></a:solidFill>
    </p:spPr>
    <p:txBody><a:p><a:r><a:t>Decision Node</a:t></a:r></a:p></p:txBody>
  </p:sp>

  <!-- Right Arrow -->
  <p:sp>
    <p:spPr>
      <a:xfrm><a:off x="1270000" y="3810000"/><a:ext cx="3810000" cy="1270000"/></a:xfrm>
      <a:prstGeom prst="rightArrow"><a:avLst/></a:prstGeom>
      <a:solidFill><a:srgbClr val="FFA726"/></a:solidFill>
    </p:spPr>
  </p:sp>

  <!-- Left-Right Arrow -->
  <p:sp>
    <p:spPr>
      <a:xfrm><a:off x="5080000" y="3810000"/><a:ext cx="3810000" cy="1270000"/></a:xfrm>
      <a:prstGeom prst="leftRightArrow"><a:avLst/></a:prstGeom>
    </p:spPr>
  </p:sp>

  <!-- Wedge Rect Callout -->
  <p:sp>
    <p:spPr>
      <a:xfrm><a:off x="1270000" y="6350000"/><a:ext cx="3175000" cy="1905000"/></a:xfrm>
      <a:prstGeom prst="wedgeRectCallout"><a:avLst/></a:prstGeom>
    </p:spPr>
    <p:txBody><a:p><a:r><a:t>Callout Message</a:t></a:r></a:p></p:txBody>
  </p:sp>

  <!-- Chevron -->
  <p:sp>
    <p:spPr>
      <a:xfrm><a:off x="5080000" y="6350000"/><a:ext cx="2540000" cy="1905000"/></a:xfrm>
      <a:prstGeom prst="chevron"><a:avLst/></a:prstGeom>
    </p:spPr>
  </p:sp>

  <!-- Cube -->
  <p:sp>
    <p:spPr>
      <a:xfrm><a:off x="8890000" y="6350000"/><a:ext cx="2540000" cy="2540000"/></a:xfrm>
      <a:prstGeom prst="cube"><a:avLst/></a:prstGeom>
      <a:solidFill><a:srgbClr val="AB47BC"/></a:solidFill>
    </p:spPr>
  </p:sp>
</p:spTree>`;

      const shapes = parseDrawingMlShapes(xml);
      expect(shapes.length).toBe(7);

      expect(shapes[0].presetGeom).toBe('flowchartprocess');
      expect(shapes[0].text).toBe('Process Step');
      expect(shapes[0].fillColor).toBe('#5C6BC0');

      expect(shapes[1].presetGeom).toBe('flowchartdecision');
      expect(shapes[1].text).toBe('Decision Node');

      expect(shapes[2].presetGeom).toBe('rightarrow');
      expect(shapes[3].presetGeom).toBe('leftrightarrow');
      expect(shapes[4].presetGeom).toBe('wedgerectcallout');
      expect(shapes[5].presetGeom).toBe('chevron');
      expect(shapes[6].presetGeom).toBe('cube');

      // Verify SVG rendering contains corresponding vector elements
      const { svg } = renderDrawingMlToSvg(shapes);
      expect(svg).toContain('<svg');
      expect(svg).toContain('<rect'); // flowchartprocess & cube
      expect(svg).toContain('<polygon'); // decision, arrows, chevron, cube faces
      expect(svg).toContain('<path'); // wedgerectcallout
      expect(svg).toContain('Process Step');
      expect(svg).toContain('Decision Node');
      expect(svg).toContain('Callout Message');
    });

    it('evaluates DrawingML guide formulas and adjust values accurately', () => {
      const vars: Record<string, number> = { w: 100, h: 60, adj: 25000 };

      expect(evaluateDrawingMlGuideFormula('val 42', vars)).toBe(42);
      expect(evaluateDrawingMlGuideFormula('*/ w adj 100000', vars)).toBe(25);
      expect(evaluateDrawingMlGuideFormula('+- w 20 10', vars)).toBe(110);
      expect(evaluateDrawingMlGuideFormula('?: w 50 10', vars)).toBe(50);
      expect(evaluateDrawingMlGuideFormula('min w h', vars)).toBe(60);
      expect(evaluateDrawingMlGuideFormula('max w h', vars)).toBe(100);
      expect(evaluateDrawingMlGuideFormula('abs -35', vars)).toBe(35);
      expect(evaluateDrawingMlGuideFormula('sqrt 144', vars)).toBe(12);
      expect(evaluateDrawingMlGuideFormula('pin 10 5 100', vars)).toBe(10);
      expect(evaluateDrawingMlGuideFormula('pin 10 150 100', vars)).toBe(100);

      // Safe division by zero
      expect(evaluateDrawingMlGuideFormula('*/ 100 50 0', vars)).toBe(0);

      // ISO/IEC 29500 §20.1.9.11 Trigonometric & advanced math functions
      // Angle unit: 60,000ths of a degree (90 deg = 5,400,000)
      expect(evaluateDrawingMlGuideFormula('sin 100 5400000', vars)).toBeCloseTo(100, 4);
      expect(evaluateDrawingMlGuideFormula('cos 100 0', vars)).toBeCloseTo(100, 4);
      expect(evaluateDrawingMlGuideFormula('tan 100 0', vars)).toBeCloseTo(0, 4);
      expect(evaluateDrawingMlGuideFormula('atan2 0 100', vars)).toBeCloseTo(5400000, 2);
      expect(evaluateDrawingMlGuideFormula('cat2 100 0 100', vars)).toBeCloseTo(0, 4);
      expect(evaluateDrawingMlGuideFormula('sat2 100 0 100', vars)).toBeCloseTo(100, 4);
      expect(evaluateDrawingMlGuideFormula('mod 3 4 0', vars)).toBe(5);
      expect(evaluateDrawingMlGuideFormula('mod 2 3 6', vars)).toBe(7);

      // Guide list evaluation with sequential dependencies
      const guideXml = `
<a:prstGeom prst="rect" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <a:avLst>
    <a:gd name="adj1" fmla="val 20000"/>
  </a:avLst>
  <a:gdLst>
    <a:gd name="x1" fmla="*/ w adj1 100000"/>
    <a:gd name="x2" fmla="+- w x1 0"/>
  </a:gdLst>
</a:prstGeom>`;

      const initial = { w: 200, h: 100 };
      const guides = parseDrawingMlGuides(guideXml, initial);
      expect(guides.adj1).toBe(20000);
      expect(guides.x1).toBe(40);
      expect(guides.x2).toBe(240);
    });

    it('resolves out-of-order forward references in parseDrawingMlGuides via multi-pass convergence', () => {
      // finalY depends on stepX, but finalY is declared before stepX
      const forwardRefXml = `
<a:gdLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <a:gd name="finalY" fmla="+- stepX 15 0"/>
  <a:gd name="stepX" fmla="val 85"/>
</a:gdLst>`;

      const resolved = parseDrawingMlGuides(forwardRefXml, {});
      expect(resolved.stepX).toBe(85);
      expect(resolved.finalY).toBe(100);
    });

    it('renders all expanded shape presets directly to PDFKit without errors', () => {
      const doc = new PDFDocument({ autoFirstPage: true });
      const chunks: Buffer[] = [];
      doc.on('data', (c) => chunks.push(c));

      const presets: Array<DrawingMlShape['presetGeom']> = [
        'flowchartprocess',
        'flowchartdecision',
        'rightarrow',
        'leftrightarrow',
        'wedgerectcallout',
        'chevron',
        'cube',
        'ellipse',
        'roundrect',
        'triangle',
        'line',
        'star5',
      ];

      expect(() => {
        presets.forEach((preset, idx) => {
          renderSinglePdfShape(
            doc,
            {
              geomType: 'preset',
              presetGeom: preset,
              x: 20 + (idx % 4) * 100,
              y: 20 + Math.floor(idx / 4) * 80,
              width: 80,
              height: 60,
              fillColor: idx % 2 === 0 ? '#5C6BC0' : undefined,
              strokeColor: '#1F2340',
              strokeWidth: 1.5,
              text: preset,
            },
            false,
            20 + (idx % 4) * 100,
            20 + Math.floor(idx / 4) * 80,
            80,
            60
          );
        });

        // Also test custom SVG path
        renderSinglePdfShape(
          doc,
          {
            geomType: 'custom',
            svgPath: 'M 0 0 L 50 0 L 50 50 Z',
            x: 20,
            y: 300,
            width: 50,
            height: 50,
            fillColor: '#26A69A',
          },
          false,
          20,
          300,
          50,
          50
        );

        doc.end();
      }).not.toThrow();
    });

    it('handles flipH and flipV coordinate transforms in shapes and SVG rendering', () => {
      const xml = `
<p:sp xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:spPr>
    <a:xfrm rot="5400000" flipH="1" flipV="1">
      <a:off x="1270000" y="1270000"/>
      <a:ext cx="2540000" cy="1270000"/>
    </a:xfrm>
    <a:prstGeom prst="rightArrow"/>
  </p:spPr>
</p:sp>`;

      const shapes = parseDrawingMlShapes(xml);
      expect(shapes.length).toBe(1);
      expect(shapes[0].rotation).toBe(90); // 5400000 / 60000
      expect(shapes[0].flipH).toBe(true);
      expect(shapes[0].flipV).toBe(true);

      const { svg } = renderDrawingMlToSvg(shapes);
      expect(svg).toContain('rotate(90');
      expect(svg).toContain('scale(-1 -1)');
    });
  });

  describe('2. Dynamic Chart Vector Rendering', () => {
    it('parses embedded OpenXML <c:barChart> XML and extracts title, categories, and series', () => {
      const chartXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <c:chart>
    <c:title>
      <c:tx><c:rich><a:p><a:r><a:t>Quarterly Revenue Performance</a:t></a:r></a:p></c:rich></c:tx>
    </c:title>
    <c:plotArea>
      <c:barChart>
        <c:ser>
          <c:tx><c:v>FY2025</c:v></c:tx>
          <c:cat>
            <c:strRef>
              <c:strCache>
                <c:pt idx="0"><c:v>Q1</c:v></c:pt>
                <c:pt idx="1"><c:v>Q2</c:v></c:pt>
                <c:pt idx="2"><c:v>Q3</c:v></c:pt>
                <c:pt idx="3"><c:v>Q4</c:v></c:pt>
              </c:strCache>
            </c:strRef>
          </c:cat>
          <c:val>
            <c:numRef>
              <c:numCache>
                <c:pt idx="0"><c:v>120</c:v></c:pt>
                <c:pt idx="1"><c:v>180</c:v></c:pt>
                <c:pt idx="2"><c:v>240</c:v></c:pt>
                <c:pt idx="3"><c:v>310</c:v></c:pt>
              </c:numCache>
            </c:numRef>
          </c:val>
        </c:ser>
      </c:barChart>
    </c:plotArea>
  </c:chart>
</c:chartSpace>`;

      const chartData = parseOpenXmlChart(chartXml);
      expect(chartData).not.toBeNull();
      expect(chartData!.type).toBe('bar');
      expect(chartData!.title).toBe('Quarterly Revenue Performance');
      expect(chartData!.categories).toEqual(['Q1', 'Q2', 'Q3', 'Q4']);
      expect(chartData!.series.length).toBe(1);
      expect(chartData!.series[0].name).toBe('FY2025');
      expect(chartData!.series[0].values).toEqual([120, 180, 240, 310]);

      // Render chart to SVG
      const svg = renderChartToSvg(chartData!, 600, 350);
      expect(svg).toContain('<svg');
      expect(svg).toContain('Quarterly Revenue Performance');
      expect(svg).toContain('<rect');
      expect(svg).toContain('Q1');
      expect(svg).toContain('Q4');
    });

    it('parses and renders <c:lineChart> and <c:pieChart> formats', () => {
      // Line Chart XML
      const lineXml = `
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <c:chart>
    <c:title><c:tx><c:v>Conversion Throughput</c:v></c:tx></c:title>
    <c:plotArea>
      <c:lineChart>
        <c:ser>
          <c:tx><c:v>Worker Latency</c:v></c:tx>
          <c:cat>
            <c:strCache>
              <c:pt idx="0"><c:v>Jan</c:v></c:pt>
              <c:pt idx="1"><c:v>Feb</c:v></c:pt>
              <c:pt idx="2"><c:v>Mar</c:v></c:pt>
            </c:strCache>
          </c:cat>
          <c:val>
            <c:numCache>
              <c:pt idx="0"><c:v>45</c:v></c:pt>
              <c:pt idx="1"><c:v>32</c:v></c:pt>
              <c:pt idx="2"><c:v>18</c:v></c:pt>
            </c:numCache>
          </c:val>
        </c:ser>
      </c:lineChart>
    </c:plotArea>
  </c:chart>
</c:chartSpace>`;

      const lineData = parseOpenXmlChart(lineXml);
      expect(lineData).not.toBeNull();
      expect(lineData!.type).toBe('line');
      const lineSvg = renderChartToSvg(lineData!);
      expect(lineSvg).toContain('<polyline');
      expect(lineSvg).toContain('<circle');
      expect(lineSvg).toContain('Conversion Throughput');

      // Pie Chart XML
      const pieXml = `
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">
  <c:chart>
    <c:title><c:tx><c:v>Traffic Distribution</c:v></c:tx></c:title>
    <c:plotArea>
      <c:pieChart>
        <c:ser>
          <c:cat><c:v>Office</c:v><c:v>CAD</c:v><c:v>Media</c:v></c:cat>
          <c:val><c:v>50</c:v><c:v>30</c:v><c:v>20</c:v></c:val>
        </c:ser>
      </c:pieChart>
    </c:plotArea>
  </c:chart>
</c:chartSpace>`;

      const pieData = parseOpenXmlChart(pieXml);
      expect(pieData).not.toBeNull();
      expect(pieData!.type).toBe('pie');
      const pieSvg = renderChartToSvg(pieData!);
      expect(pieSvg).toContain('<path');
      expect(pieSvg).toContain('Traffic Distribution');
    });

    it('renders SVG chart directly when XML containing <c:chart> is passed to renderDrawingMlToSvg', () => {
      const chartXml = `
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">
  <c:chart>
    <c:title><c:tx><c:v>System Metrics</c:v></c:tx></c:title>
    <c:plotArea>
      <c:barChart>
        <c:ser>
          <c:cat><c:v>CPU</c:v><c:v>RAM</c:v></c:cat>
          <c:val><c:v>35</c:v><c:v>62</c:v></c:val>
        </c:ser>
      </c:barChart>
    </c:plotArea>
  </c:chart>
</c:chartSpace>`;

      const res = renderDrawingMlToSvg(chartXml);
      expect(res.shapes.length).toBe(1);
      expect(res.shapes[0].chart).toBeDefined();
      expect(res.svg).toContain('System Metrics');
      expect(res.svg).toContain('<rect');
    });

    it('renders 360-degree single-slice pie and doughnut charts without SVG arc singularities', () => {
      // 100% single-slice pie chart
      const singlePieSvg = renderChartToSvg({
        type: 'pie',
        title: 'Mono Category',
        categories: ['All'],
        series: [{ name: 'Share', values: [100] }],
      });
      expect(singlePieSvg).toContain('<circle');
      expect(singlePieSvg).toContain('Mono Category');

      // 100% single-slice doughnut chart
      const singleDoughnutSvg = renderChartToSvg({
        type: 'doughnut',
        title: 'Doughnut 100%',
        categories: ['All'],
        series: [{ name: 'Share', values: [100] }],
      });
      expect(singleDoughnutSvg).toContain('fill-rule="evenodd"');
      expect(singleDoughnutSvg).toContain('Doughnut 100%');
    });

    it('handles self-closing c:pt elements correctly during series data extraction', () => {
      const xml = `
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">
  <c:chart>
    <c:plotArea>
      <c:barChart>
        <c:ser>
          <c:cat>
            <c:strCache>
              <c:pt idx="0"><c:v>Active</c:v></c:pt>
              <c:pt idx="1"/>
              <c:pt idx="2"><c:v>Standby</c:v></c:pt>
            </c:strCache>
          </c:cat>
          <c:val>
            <c:numCache>
              <c:pt idx="0"><c:v>500</c:v></c:pt>
              <c:pt idx="1"/>
              <c:pt idx="2"><c:v>150</c:v></c:pt>
            </c:numCache>
          </c:val>
        </c:ser>
      </c:barChart>
    </c:plotArea>
  </c:chart>
</c:chartSpace>`;
      const chart = parseOpenXmlChart(xml);
      expect(chart).not.toBeNull();
      expect(chart!.categories).toEqual(['Active', 'Standby']);
      expect(chart!.series[0].values).toEqual([500, 150]);
    });

    it('renders all chart types (bar, line, area, pie, doughnut, scatter) in PDFKit without error', () => {
      const chartTypes: Array<OpenXmlChartData['type']> = [
        'bar',
        'line',
        'area',
        'pie',
        'doughnut',
        'scatter',
      ];

      expect(() => {
        chartTypes.forEach((type) => {
          const doc = new PDFDocument({ autoFirstPage: true });
          const chunks: Buffer[] = [];
          doc.on('data', (c) => chunks.push(c));

          renderPdfChart(
            doc,
            {
              type,
              title: `${type.toUpperCase()} Chart Title`,
              categories: ['Cat A', 'Cat B', 'Cat C'],
              series: [
                { name: 'Series 1', values: [30, 70, 45] },
                { name: 'Series 2', values: [50, 20, 65] },
              ],
            },
            false,
            50,
            50,
            400,
            200
          );

          doc.end();
        });
      }).not.toThrow();
    });

    it('returns null safely for non-chart XML or empty input', () => {
      expect(parseOpenXmlChart('')).toBeNull();
      expect(parseOpenXmlChart('<p:sp></p:sp>')).toBeNull();
    });
  });

  describe('3. CJK & Unicode Font Fallback in PDFKit Document Rendering', () => {
    it('accurately identifies non-WinAnsi and CJK characters vs Latin text', () => {
      // Latin ASCII & Windows-1252 printable characters
      expect(isNonWinAnsi('Hello World')).toBe(false);
      expect(isNonWinAnsi('Invoice #1024 - Price: €50.00 (© 2026)')).toBe(false);

      // CJK characters
      expect(isNonWinAnsi('안녕하세요 (Korean)')).toBe(true);
      expect(isNonWinAnsi('日本語テキスト (Japanese)')).toBe(true);
      expect(isNonWinAnsi('中文文档 (Chinese)')).toBe(true);
      expect(isNonWinAnsi('Кириллица (Cyrillic)')).toBe(true);
      expect(isNonWinAnsi('Emoji 🚀 test')).toBe(true);
    });

    it('sanitizes non-WinAnsi text gracefully while preserving valid Latin glyphs', () => {
      const mixed = 'EasyConvert 2026: 한글 보고서 (Enterprise Edition €100)';
      const safe = sanitizeWinAnsi(mixed);
      expect(safe).toContain('EasyConvert 2026:');
      expect(safe).toContain('(Enterprise Edition €100)');
      expect(safe).not.toContain('한글');
      expect(safe).not.toContain('보고서');
    });

    it('resolves system or custom Unicode fallback fonts cleanly', () => {
      const font = resolveUnicodeFallbackFont();
      // On macOS, Arial Unicode or AppleSDGothicNeo is typically present; on CI or Docker, null or Linux noto font
      if (font) {
        expect(typeof font).toBe('string');
      }

      const doc = new PDFDocument();
      const config = configurePdfKitFontFallback(doc);
      expect(typeof config.hasUnicodeFont).toBe('boolean');
    });

    it('renders CJK text safely without throwing WinAnsi encoding errors', () => {
      const doc = new PDFDocument();
      const chunks: Buffer[] = [];
      doc.on('data', (c) => chunks.push(c));

      // Test rendering CJK text using safe helper
      expect(() => {
        renderSafePdfText(doc, '한국어 문서 보고서 (Korean Performance Report)', false);
        renderSafePdfText(doc, '日本語の概要 (Japanese Summary)', false);
        renderSafePdfText(doc, '中文简要 (Chinese Overview)', false);
        doc.end();
      }).not.toThrow();
    });

    it('converts DOCX containing CJK characters to PDF without crashing and produces valid PDF buffer', async () => {
      const zip = new JSZip();

      zip.file(
        '[Content_Types].xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
      );

      zip.file(
        '_rels/.rels',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
      );

      // DOCX containing Korean, Japanese, and Chinese text
      zip.file(
        'word/document.xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>글로벌 비즈니스 성과 보고서 (Global Business Report)</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>본 문서는 2026년 상반기 아시아-태평양 지역의 전환 처리 실적을 다룹니다.</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>日本語セクション: クラウド変換のスループットが前四半期比で45%向上しました。</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>中文部分: 转换延迟降低至零保留存储标准。</w:t></w:r>
    </w:p>

    <!-- Table with CJK text, shading, and alignment -->
    <w:tbl>
      <w:tr>
        <w:tc>
          <w:tcPr>
            <w:shd w:fill="5C6BC0"/>
            <w:jc w:val="center"/>
          </w:tcPr>
          <w:p><w:r><w:t>지역 (Region)</w:t></w:r></w:p>
        </w:tc>
        <w:tc>
          <w:tcPr>
            <w:shd w:fill="5C6BC0"/>
            <w:jc w:val="center"/>
          </w:tcPr>
          <w:p><w:r><w:t>처리량 (Throughput)</w:t></w:r></w:p>
        </w:tc>
      </w:tr>
      <w:tr>
        <w:tc>
          <w:tcPr><w:jc w:val="left"/></w:tcPr>
          <w:p><w:r><w:t>대한민국 서울</w:t></w:r></w:p>
        </w:tc>
        <w:tc>
          <w:tcPr><w:jc w:val="right"/></w:tcPr>
          <w:p><w:r><w:t>1,500,000건</w:t></w:r></w:p>
        </w:tc>
      </w:tr>
    </w:tbl>
  </w:body>
</w:document>`
      );

      const docxBuffer = await zip.generateAsync({ type: 'nodebuffer' });

      // Convert DOCX to PDF
      const pdfRes = await convertFile(docxBuffer, 'docx', 'pdf', {}, 'korean_report.docx');
      expect(pdfRes.mimeType).toBe('application/pdf');
      expect(pdfRes.buffer.length).toBeGreaterThan(1000);
      expect(pdfRes.buffer.subarray(0, 4).toString('ascii')).toBe('%PDF');

      // Convert DOCX to HTML
      const htmlRes = await convertFile(docxBuffer, 'docx', 'html', {}, 'korean_report.docx');
      const htmlText = htmlRes.buffer.toString('utf-8');
      expect(htmlText).toContain('글로벌 비즈니스 성과 보고서');
      expect(htmlText).toContain('대한민국 서울');
      expect(htmlText).toContain('1,500,000건');
    });
  });

  describe('4. End-to-End High-Fidelity DOCX & PPTX Integration', () => {
    it('converts DOCX containing DrawingML shapes and embedded chart to PDF and HTML', async () => {
      const zip = new JSZip();

      zip.file(
        '[Content_Types].xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>
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
  <Relationship Id="rIdChart1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="charts/chart1.xml"/>
</Relationships>`
      );

      zip.file(
        'word/charts/chart1.xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <c:chart>
    <c:title><c:tx><c:v>Conversion Latency Benchmark</c:v></c:tx></c:title>
    <c:plotArea>
      <c:barChart>
        <c:ser>
          <c:tx><c:v>Execution Time (ms)</c:v></c:tx>
          <c:cat>
            <c:strCache>
              <c:pt idx="0"><c:v>PDF</c:v></c:pt>
              <c:pt idx="1"><c:v>Office</c:v></c:pt>
              <c:pt idx="2"><c:v>CAD</c:v></c:pt>
            </c:strCache>
          </c:cat>
          <c:val>
            <c:numCache>
              <c:pt idx="0"><c:v>12</c:v></c:pt>
              <c:pt idx="1"><c:v>24</c:v></c:pt>
              <c:pt idx="2"><c:v>48</c:v></c:pt>
            </c:numCache>
          </c:val>
        </c:ser>
      </c:barChart>
    </c:plotArea>
  </c:chart>
</c:chartSpace>`
      );

      zip.file(
        'word/document.xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>Architecture &amp; Performance Review</w:t></w:r>
    </w:p>
    
    <!-- DrawingML Shape: Chevron -->
    <w:drawing>
      <a:graphic>
        <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/main">
          <a:xfrm><a:off x="500000" y="500000"/><a:ext cx="2000000" cy="1000000"/></a:xfrm>
          <a:prstGeom prst="chevron"/>
          <a:solidFill><a:srgbClr val="5C6BC0"/></a:solidFill>
        </a:graphicData>
      </a:graphic>
    </w:drawing>

    <!-- DrawingML Chart reference via relationship -->
    <w:drawing>
      <a:graphic>
        <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
          <c:chart r:id="rIdChart1"/>
        </a:graphicData>
      </a:graphic>
    </w:drawing>
  </w:body>
</w:document>`
      );

      const docxBuf = await zip.generateAsync({ type: 'nodebuffer' });

      // 1. Convert to PDF and verify vector rendering without placeholders
      const pdfRes = await convertFile(docxBuf, 'docx', 'pdf', {}, 'benchmark.docx');
      expect(pdfRes.mimeType).toBe('application/pdf');
      expect(pdfRes.buffer.subarray(0, 4).toString('ascii')).toBe('%PDF');

      // 2. Convert to HTML and verify SVG chart and chevron polygon
      const htmlRes = await convertFile(docxBuf, 'docx', 'html', {}, 'benchmark.docx');
      const html = htmlRes.buffer.toString('utf-8');
      expect(html).toContain('Architecture');
      expect(html).toContain('Performance Review');
      expect(html).toContain('Conversion Latency Benchmark');
      expect(html).toContain('<rect'); // bar chart
      expect(html).toContain('<polygon'); // chevron
    });

    it('converts PPTX containing <p:graphicFrame> with embedded chart to visual HTML and PDF', async () => {
      const zip = new JSZip();

      zip.file(
        '[Content_Types].xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>
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
  <Relationship Id="rIdChart" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>
</Relationships>`
      );

      zip.file(
        'ppt/charts/chart1.xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <c:chart>
    <c:title><c:tx><c:v>Slide Vector Chart</c:v></c:tx></c:title>
    <c:plotArea>
      <c:barChart>
        <c:ser>
          <c:tx><c:v>Metric</c:v></c:tx>
          <c:cat><c:v>Alpha</c:v><c:v>Beta</c:v></c:cat>
          <c:val><c:v>80</c:v><c:v>95</c:v></c:val>
        </c:ser>
      </c:barChart>
    </c:plotArea>
  </c:chart>
</c:chartSpace>`
      );

      zip.file(
        'ppt/slides/slide1.xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
      
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="500000" y="500000"/><a:ext cx="8000000" cy="500000"/></a:xfrm></p:spPr>
        <p:txBody><a:bodyPr/><a:p><a:r><a:t>Executive Visual Dashboard</a:t></a:r></a:p></p:txBody>
      </p:sp>

      <!-- Graphic frame referencing chart -->
      <p:graphicFrame>
        <p:nvGraphicFramePr><p:cNvPr id="3" name="Chart 1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
        <p:xfrm><a:off x="1000000" y="1500000"/><a:ext cx="6000000" cy="4000000"/></p:xfrm>
        <a:graphic>
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
            <c:chart r:id="rIdChart"/>
          </a:graphicData>
        </a:graphic>
      </p:graphicFrame>
    </p:spTree>
  </p:cSld>
</p:sld>`
      );

      const pptxBuf = await zip.generateAsync({ type: 'nodebuffer' });

      // Convert to HTML
      const htmlRes = await convertFile(pptxBuf, 'pptx', 'html', {}, 'deck.pptx');
      const html = htmlRes.buffer.toString('utf-8');
      expect(html).toContain('Executive Visual Dashboard');
      expect(html).toContain('Slide Vector Chart');
      expect(html).toContain('<rect');

      // Convert to PDF
      const pdfRes = await convertFile(pptxBuf, 'pptx', 'pdf', {}, 'deck.pptx');
      expect(pdfRes.mimeType).toBe('application/pdf');
      expect(pdfRes.buffer.subarray(0, 4).toString('ascii')).toBe('%PDF');
    });

    it('converts PPTX containing expanded presets to HTML and PDF', async () => {
      const zip = new JSZip();

      zip.file(
        '[Content_Types].xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
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
        'ppt/slides/slide1.xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
      <p:sp>
        <p:spPr>
          <a:xfrm><a:off x="500000" y="500000"/><a:ext cx="2000000" cy="1000000"/></a:xfrm>
          <a:prstGeom prst="cube"/>
          <a:solidFill><a:srgbClr val="5C6BC0"/></a:solidFill>
        </p:spPr>
        <p:txBody><a:bodyPr/><a:p><a:r><a:t>Cube Component</a:t></a:r></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:spPr>
          <a:xfrm><a:off x="3000000" y="500000"/><a:ext cx="2000000" cy="1000000"/></a:xfrm>
          <a:prstGeom prst="chevron"/>
          <a:solidFill><a:srgbClr val="26A69A"/></a:solidFill>
        </p:spPr>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`
      );

      const pptxBuf = await zip.generateAsync({ type: 'nodebuffer' });

      const htmlRes = await convertFile(pptxBuf, 'pptx', 'html', {}, 'shapes.pptx');
      const html = htmlRes.buffer.toString('utf-8');
      expect(html).toContain('Cube Component');
      expect(html).toContain('<polygon');

      const pdfRes = await convertFile(pptxBuf, 'pptx', 'pdf', {}, 'shapes.pptx');
      expect(pdfRes.mimeType).toBe('application/pdf');
      expect(pdfRes.buffer.subarray(0, 4).toString('ascii')).toBe('%PDF');
    });
  });
});
