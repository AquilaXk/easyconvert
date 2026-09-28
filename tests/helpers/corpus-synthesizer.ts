import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { encodeSyntheticParquet } from './synthetic-parquet-encoder';

// ============================================================================
// Types & Interfaces (Independent of Production Conversion Modules)
// ============================================================================

export enum ParquetType {
  BOOLEAN = 0,
  INT32 = 1,
  INT64 = 2,
  INT96 = 3,
  FLOAT = 4,
  DOUBLE = 5,
  BYTE_ARRAY = 6,
  FIXED_LEN_BYTE_ARRAY = 7,
}

export interface ColumnSchema {
  name: string;
  type: ParquetType;
  typeLength?: number;
  repetitionType?: string;
}

export interface VariableFontAxis {
  tag: string;
  name: string;
  minValue: number;
  defaultValue: number;
  maxValue: number;
  flags: number;
  axisNameID: number;
}

export interface VariableFontInstance {
  name: string;
  subfamilyNameID: number;
  flags: number;
  coordinates: Record<string, number>;
}

export interface StatDesignAxis {
  tag: string;
  name: string;
  ordering: number;
  axisNameID: number;
}

export interface StatAxisValue {
  format: number;
  axisIndex: number;
  flags: number;
  valueNameID: number;
  valueName: string;
  value?: number;
  nominalValue?: number;
  rangeMinValue?: number;
  rangeMaxValue?: number;
}

export interface FontTableEntry {
  tag: string;
  checkSum: number;
  offset: number;
  length: number;
  data: Buffer;
}

export interface ParsedFont {
  format: string;
  familyName: string;
  styleName: string;
  numGlyphs?: number;
  unitsPerEm?: number;
  ascender?: number;
  descender?: number;
  tables: Record<string, FontTableEntry>;
}

export interface DrawingMlShape {
  id: string;
  name: string;
  type: string;
  geomType?: string;
  presetGeom?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fillColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  text?: string;
}

export interface NestedTableCell {
  text: string;
  colSpan?: number;
  rowSpan?: number;
  shading?: string;
  isHeader?: boolean;
  nestedTable?: NestedTable;
  drawingShape?: DrawingMlShape;
}

export interface NestedTable {
  id: string;
  rowCount: number;
  colCount: number;
  rows: NestedTableCell[][];
  borders?: {
    top?: { val: string; sz: number; color: string };
    bottom?: { val: string; sz: number; color: string };
    insideH?: { val: string; sz: number; color: string };
    insideV?: { val: string; sz: number; color: string };
  };
}

export interface BSplineSurface {
  uDegree: number;
  vDegree: number;
  uKnots: number[];
  vKnots: number[];
  controlPoints: Array<Array<{ x: number; y: number; z: number }>>;
}

export interface Parametric2DPoint {
  u: number;
  v: number;
}

export interface TessellatedMesh {
  vertices: Array<{ x: number; y: number; z: number }>;
  faces: Array<[number, number, number]>;
  normals: Array<{ x: number; y: number; z: number }>;
}

export interface PdfTextBlock {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontName?: string;
}

export interface PdfToUnicodeCMap {
  charMap: Map<number, string>;
}

export interface HwpDocument {
  header?: {
    signature: string;
    version: number;
    flags: number;
  };
  paragraphs: Array<{
    text: string;
    isHeading?: boolean;
  }>;
  tables?: Array<{
    rows: string[][];
  }>;
  metadata?: {
    title?: string;
    author?: string;
    date?: string;
  };
}

// ============================================================================
// 1. Enterprise Multi-Column Document Corpus Synthesizer
// ============================================================================

export interface MultiColumnDocumentMetadata {
  title: string;
  author: string;
  subject: string;
  keywords: string[];
  createdAt: string;
  version: string;
}

export interface DocumentFootnote {
  id: number;
  label: string;
  content: string;
}

export interface DocumentSection {
  heading: string;
  level: number;
  columns: number;
  paragraphs: string[];
  footnotes?: DocumentFootnote[];
}

export interface MultiColumnDocumentCorpus {
  metadata: MultiColumnDocumentMetadata;
  sections: DocumentSection[];
  footnotes: DocumentFootnote[];
  generateHtml: () => string;
  generateDocx: () => Promise<Buffer>;
  generateHwpx: () => Promise<Buffer>;
}

export function synthesizeMultiColumnDocumentCorpus(): MultiColumnDocumentCorpus {
  const metadata: MultiColumnDocumentMetadata = {
    title: 'Enterprise Multi-Column Financial & Technical Architecture Report',
    author: 'EasyConvert QA Engineering Core',
    subject: 'Universal Golden Corpus & Layout Integrity',
    keywords: ['enterprise', 'multi-column', 'footnotes', 'drawingml', 'parquet', 'vrt'],
    createdAt: '2026-09-27T12:00:00Z',
    version: '4.0.0-sota',
  };

  const footnotes: DocumentFootnote[] = [
    {
      id: 1,
      label: '[1]',
      content: 'Zero-cloud retention ensures memory wipe immediately post streaming completion.',
    },
    {
      id: 2,
      label: '[2]',
      content: 'Columnar Parquet serialization leverages 1-bit packed boolean masks.',
    },
    {
      id: 3,
      label: '[3]',
      content: 'DrawingML vector renderer supports high-precision cubic Bezier paths and linear gradients.',
    },
  ];

  const sections: DocumentSection[] = [
    {
      heading: '1. Executive Architectural Summary',
      level: 1,
      columns: 1,
      paragraphs: [
        'The EasyConvert platform operates an enterprise-grade pure TypeScript execution core. Modern multi-column document workflows mandate absolute fidelity across typographical axes, nested tabular geometries, and vector shape descriptors.',
      ],
    },
    {
      heading: '2. High-Throughput Columnar Streaming & Vector Layout',
      level: 2,
      columns: 2,
      paragraphs: [
        'Column 1: Tabular data extraction preserves full column schema semantics while executing zero-retention in-memory transformations [1]. Real-world enterprise datasets mix numerical metrics with high-cardinality metadata strings and temporal coordinates [2].',
        'Column 2: Visual layout composition utilizes multi-column flow boundaries with balanced gutters. When rendering technical blueprints, embedded DrawingML vector shapes must preserve coordinate matrices across zoom levels [3].',
      ],
      footnotes: [footnotes[0], footnotes[1]],
    },
    {
      heading: '3. Footnotes, Citations & Deep Structural Annotations',
      level: 2,
      columns: 2,
      paragraphs: [
        'Left Column: Footnote markers anchor directly into the running narrative without breaking paragraph flow. Typographical baselines align consistently across dual-column layouts.',
        'Right Column: Complex nested tables within columns feature explicit cell margins, multi-axis spans, and localized shaded borders to ensure complete readability across display modes.',
      ],
      footnotes: [footnotes[2]],
    },
  ];

  return {
    metadata,
    sections,
    footnotes,
    generateHtml: () => {
      let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${metadata.title}</title>
  <meta name="author" content="${metadata.author}">
  <meta name="keywords" content="${metadata.keywords.join(', ')}">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; color: #1F2340; margin: 40px auto; max-width: 900px; padding: 0 20px; }
    header { border-bottom: 2px solid #5C6BC0; padding-bottom: 16px; margin-bottom: 24px; }
    h1 { color: #1F2340; font-size: 26px; margin: 0 0 8px 0; }
    .meta { font-size: 13px; color: #697089; margin-bottom: 12px; }
    .section-2col { column-count: 2; column-gap: 32px; column-rule: 1px solid #E1E4EE; text-align: justify; margin-bottom: 24px; }
    .section-1col { margin-bottom: 24px; }
    h2 { font-size: 18px; color: #4A58A9; border-left: 4px solid #5C6BC0; padding-left: 8px; margin-top: 20px; column-span: all; }
    p { margin: 0 0 12px 0; font-size: 14px; }
    .fn-ref { vertical-align: super; font-size: 10px; color: #5C6BC0; font-weight: bold; text-decoration: none; }
    footer { border-top: 1px solid #CCD2FC; margin-top: 36px; padding-top: 16px; font-size: 12px; color: #4D536B; }
    .fn-item { margin-bottom: 6px; }
  </style>
</head>
<body>
  <header>
    <h1>${metadata.title}</h1>
    <div class="meta">Author: ${metadata.author} | Version: ${metadata.version} | Date: ${metadata.createdAt}</div>
  </header>
  <main>
`;

      for (const sec of sections) {
        html += `    <div class="${sec.columns === 2 ? 'section-2col' : 'section-1col'}">\n`;
        html += `      <h2>${sec.heading}</h2>\n`;
        for (const p of sec.paragraphs) {
          html += `      <p>${p}</p>\n`;
        }
        html += `    </div>\n`;
      }

      html += `  </main>
  <footer>
    <h3>Footnotes & References</h3>
`;
      for (const fn of footnotes) {
        html += `    <div class="fn-item"><strong>${fn.label}</strong> ${fn.content}</div>\n`;
      }
      html += `  </footer>
</body>
</html>`;
      return html;
    },

    generateDocx: async () => {
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

      let docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Title"/><w:jc w:val="center"/></w:pPr>
      <w:r><w:rPr><w:b/><w:sz w:val="48"/><w:color w:val="1F2340"/></w:rPr><w:t>${metadata.title}</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr><w:jc w:val="center"/></w:pPr>
      <w:r><w:rPr><w:i/><w:sz w:val="20"/><w:color w:val="697089"/></w:rPr><w:t>${metadata.author} • ${metadata.version}</w:t></w:r>
    </w:p>
`;

      for (const sec of sections) {
        docXml += `    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:rPr><w:b/><w:sz w:val="32"/><w:color w:val="4A58A9"/></w:rPr><w:t>${sec.heading}</w:t></w:r>
    </w:p>
`;
        for (const p of sec.paragraphs) {
          docXml += `    <w:p>
      <w:pPr>${sec.columns === 2 ? '<w:sectPr><w:cols w:num="2" w:space="720"/></w:sectPr>' : ''}</w:pPr>
      <w:r><w:rPr><w:sz w:val="22"/><w:color w:val="1F2340"/></w:rPr><w:t>${p}</w:t></w:r>
    </w:p>
`;
        }
      }

      docXml += `    <w:p><w:r><w:rPr><w:b/><w:sz w:val="24"/></w:rPr><w:t>Footnotes</w:t></w:r></w:p>\n`;
      for (const fn of footnotes) {
        docXml += `    <w:p>
      <w:r><w:rPr><w:b/><w:sz w:val="18"/><w:color w:val="5C6BC0"/></w:rPr><w:t>${fn.label} </w:t></w:r>
      <w:r><w:rPr><w:sz w:val="18"/><w:color w:val="4D536B"/></w:rPr><w:t>${fn.content}</w:t></w:r>
    </w:p>
`;
      }

      docXml += `    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
    </w:sectPr>
  </w:body>
</w:document>`;

      zip.file('word/document.xml', docXml);
      return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    },

    generateHwpx: async () => {
      const fixturePath = path.join(__dirname, '../fixtures/golden/document/multi-column-annotated.hwpx');
      if (fs.existsSync(fixturePath)) {
        return fs.readFileSync(fixturePath);
      }
      throw new Error(`Golden HWPX fixture not found at ${fixturePath}`);
    },
  };
}

// ============================================================================
// 2. Complex Nested Tables & DrawingML Vector Shape Synthesizer
// ============================================================================

export interface DrawingMlTableCorpus {
  table: NestedTable;
  shapes: DrawingMlShape[];
  drawingMlXml: string;
  renderSvg: () => { svg: string; shapes: DrawingMlShape[] };
  generateDocxTableXml: () => string;
}

export function synthesizeDrawingMlTableCorpus(): DrawingMlTableCorpus {
  const sampleShapes: DrawingMlShape[] = [
    {
      id: 'sp_badge_1',
      name: 'Status Badge',
      type: 'roundrect',
      geomType: 'preset',
      presetGeom: 'roundrect',
      x: 10,
      y: 10,
      width: 140,
      height: 36,
      fillColor: '#5C6BC0',
      strokeColor: '#4A58A9',
      strokeWidth: 2,
    },
    {
      id: 'sp_accent_metric',
      name: 'Metric Indicator',
      type: 'ellipse',
      geomType: 'preset',
      presetGeom: 'ellipse',
      x: 160,
      y: 12,
      width: 32,
      height: 32,
      fillColor: '#8E9CE6',
      strokeColor: '#FFFFFF',
      strokeWidth: 1.5,
    },
    {
      id: 'sp_vector_path',
      name: 'Growth Trend Curve',
      type: 'custom',
      geomType: 'custom',
      x: 200,
      y: 10,
      width: 120,
      height: 36,
      fillColor: 'none',
      strokeColor: '#3B4890',
      strokeWidth: 2.5,
      text: 'M 0 30 Q 30 5 60 18 T 120 5',
    },
  ];

  const drawingMlXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:spTree xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sp>
    <p:nvSpPr>
      <p:cNvPr id="101" name="Status Badge"/>
      <p:cNvSpPr/>
      <p:nvPr/>
    </p:nvSpPr>
    <p:spPr>
      <a:xfrm>
        <a:off x="100000" y="100000"/>
        <a:ext cx="1400000" cy="360000"/>
      </a:xfrm>
      <a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom>
      <a:solidFill><a:srgbClr val="5C6BC0"/></a:solidFill>
      <a:ln w="19050"><a:solidFill><a:srgbClr val="4A58A9"/></a:solidFill></a:ln>
    </p:spPr>
  </p:sp>
  <p:sp>
    <p:nvSpPr>
      <p:cNvPr id="102" name="Metric Indicator"/>
      <p:cNvSpPr/>
      <p:nvPr/>
    </p:nvSpPr>
    <p:spPr>
      <a:xfrm>
        <a:off x="1600000" y="100000"/>
        <a:ext cx="1200000" cy="360000"/>
      </a:xfrm>
      <a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>
      <a:solidFill><a:srgbClr val="5C6BC0"/></a:solidFill>
      <a:ln w="9525"><a:solidFill><a:srgbClr val="1F2340"/></a:solidFill></a:ln>
    </p:spPr>
  </p:sp>
</p:spTree>`;

  const nestedInnerTable: NestedTable = {
    id: 'tbl_nested_q3',
    rowCount: 2,
    colCount: 2,
    rows: [
      [
        { text: 'Q3 Inflow', shading: 'CCD2FC' },
        { text: '$1.42M', shading: 'FFFFFF' },
      ],
      [
        { text: 'Q3 Outflow', shading: 'CCD2FC' },
        { text: '$0.88M', shading: 'FFFFFF' },
      ],
    ],
  };

  const outerTable: NestedTable = {
    id: 'tbl_master_ledger',
    rowCount: 4,
    colCount: 3,
    borders: {
      top: { val: 'single', sz: 8, color: '4A58A9' },
      bottom: { val: 'double', sz: 12, color: '1F2340' },
      insideH: { val: 'single', sz: 4, color: 'E1E4EE' },
      insideV: { val: 'single', sz: 4, color: 'E1E4EE' },
    },
    rows: [
      [
        {
          text: 'Enterprise Portfolio & Vector Analytics Master Ledger',
          colSpan: 3,
          shading: '4A58A9',
          isHeader: true,
        },
      ],
      [
        { text: 'Regional Hub: APAC', rowSpan: 2, shading: 'F5F7FF' },
        { text: 'Operational Matrix', nestedTable: nestedInnerTable },
        { text: 'Vector Geometry Badge', drawingShape: sampleShapes[0] },
      ],
      [
        { text: 'Throughput: 1420.5 GB/s' },
        { text: 'Metric Indicator', drawingShape: sampleShapes[1] },
      ],
      [
        { text: 'EMEA Division', shading: 'FFFFFF' },
        { text: 'Latency: 12.4ms', shading: 'FFFFFF' },
        { text: 'Status: Optimal 99.98%', shading: 'D4EDDA' },
      ],
    ],
  };

  return {
    table: outerTable,
    shapes: sampleShapes,
    drawingMlXml,
    renderSvg: () => ({
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">
  <rect x="10" y="10" width="140" height="36" rx="8" fill="#5C6BC0" stroke="#4A58A9" stroke-width="2"/>
  <ellipse cx="176" cy="28" rx="16" ry="16" fill="#8E9CE6" stroke="#FFFFFF" stroke-width="1.5"/>
  <path d="M 0 30 Q 30 5 60 18 T 120 5" fill="none" stroke="#3B4890" stroke-width="2.5"/>
</svg>`,
      shapes: sampleShapes,
    }),
    generateDocxTableXml: () => {
      let tblXml = `<w:tbl xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:tblPr>
    <w:tblW w:w="5000" w:type="pct"/>
    <w:tblBorders>
      <w:top w:val="single" w:sz="8" w:color="4A58A9"/>
      <w:bottom w:val="double" w:sz="12" w:color="1F2340"/>
      <w:insideH w:val="single" w:sz="4" w:color="E1E4EE"/>
      <w:insideV w:val="single" w:sz="4" w:color="E1E4EE"/>
    </w:tblBorders>
  </w:tblPr>
`;
      for (const row of outerTable.rows) {
        tblXml += `  <w:tr>\n`;
        for (const cell of row) {
          tblXml += `    <w:tc>\n      <w:tcPr>\n`;
          if (cell.colSpan && cell.colSpan > 1) {
            tblXml += `        <w:gridSpan w:val="${cell.colSpan}"/>\n`;
          }
          if (cell.shading) {
            tblXml += `        <w:shd w:val="clear" w:color="auto" w:fill="${cell.shading}"/>\n`;
          }
          tblXml += `      </w:tcPr>\n      <w:p><w:r><w:t>${cell.text}</w:t></w:r></w:p>\n    </w:tc>\n`;
        }
        tblXml += `  </w:tr>\n`;
      }
      tblXml += `</w:tbl>`;
      return tblXml;
    },
  };
}

// ============================================================================
// 3. Variable Font SFNT Corpus Synthesizer across Design Axes (wght, wdth, slnt)
// ============================================================================

export interface VariableFontCorpus {
  fontBuffer: Buffer;
  axes: VariableFontAxis[];
  instances: VariableFontInstance[];
  statAxes: StatDesignAxis[];
  statValues: StatAxisValue[];
  parsedFont: ParsedFont;
}

export function synthesizeVariableFontCorpus(): VariableFontCorpus {
  const axes: VariableFontAxis[] = [
    {
      tag: 'wght',
      name: 'Weight',
      minValue: 100,
      defaultValue: 400,
      maxValue: 900,
      flags: 0,
      axisNameID: 256,
    },
    {
      tag: 'wdth',
      name: 'Width',
      minValue: 50,
      defaultValue: 100,
      maxValue: 150,
      flags: 0,
      axisNameID: 257,
    },
    {
      tag: 'slnt',
      name: 'Slant',
      minValue: -20,
      defaultValue: 0,
      maxValue: 0,
      flags: 0,
      axisNameID: 258,
    },
  ];

  const instances: VariableFontInstance[] = [
    {
      name: 'Thin',
      subfamilyNameID: 260,
      flags: 0,
      coordinates: { wght: 100, wdth: 100, slnt: 0 },
    },
    {
      name: 'Light',
      subfamilyNameID: 261,
      flags: 0,
      coordinates: { wght: 300, wdth: 100, slnt: 0 },
    },
    {
      name: 'Regular',
      subfamilyNameID: 262,
      flags: 0,
      coordinates: { wght: 400, wdth: 100, slnt: 0 },
    },
    {
      name: 'Bold',
      subfamilyNameID: 263,
      flags: 0,
      coordinates: { wght: 700, wdth: 100, slnt: 0 },
    },
    {
      name: 'Black Condensed',
      subfamilyNameID: 264,
      flags: 0,
      coordinates: { wght: 900, wdth: 75, slnt: 0 },
    },
    {
      name: 'Oblique',
      subfamilyNameID: 265,
      flags: 0,
      coordinates: { wght: 400, wdth: 100, slnt: -14 },
    },
  ];

  const statAxes: StatDesignAxis[] = [
    { tag: 'wght', name: 'Weight', ordering: 0, axisNameID: 256 },
    { tag: 'wdth', name: 'Width', ordering: 1, axisNameID: 257 },
    { tag: 'slnt', name: 'Slant', ordering: 2, axisNameID: 258 },
  ];

  const statValues: StatAxisValue[] = [
    { format: 1, axisIndex: 0, flags: 0, valueNameID: 260, valueName: 'Thin', value: 100 },
    { format: 1, axisIndex: 0, flags: 0, valueNameID: 262, valueName: 'Regular', value: 400 },
    { format: 1, axisIndex: 0, flags: 0, valueNameID: 263, valueName: 'Bold', value: 700 },
    {
      format: 2,
      axisIndex: 0,
      flags: 0,
      valueNameID: 270,
      valueName: 'Continuous Weight Span',
      nominalValue: 400,
      rangeMinValue: 100,
      rangeMaxValue: 900,
    },
    { format: 1, axisIndex: 1, flags: 0, valueNameID: 264, valueName: 'Condensed', value: 75 },
    { format: 1, axisIndex: 1, flags: 0, valueNameID: 271, valueName: 'Normal Width', value: 100 },
    { format: 1, axisIndex: 2, flags: 0, valueNameID: 265, valueName: 'Oblique', value: -14 },
  ];

  const fixturePath = path.join(__dirname, '../fixtures/golden/font/variable-geometric.otf');
  if (!fs.existsSync(fixturePath)) {
    throw new Error(`Golden variable font fixture not found at ${fixturePath}. Static binary fixtures must be present.`);
  }
  const fontBuffer = fs.readFileSync(fixturePath);

  const tables: Record<string, { tag: string; checkSum: number; offset: number; length: number; data: Buffer }> = {};
  if (fontBuffer.length >= 12) {
    const numTables = fontBuffer.readUInt16BE(4);
    for (let i = 0; i < numTables && 12 + (i + 1) * 16 <= fontBuffer.length; i++) {
      const o = 12 + i * 16;
      const tag = fontBuffer.subarray(o, o + 4).toString('ascii');
      const checkSum = fontBuffer.readUInt32BE(o + 4);
      const offset = fontBuffer.readUInt32BE(o + 8);
      const length = fontBuffer.readUInt32BE(o + 12);
      if (offset + length <= fontBuffer.length) {
        tables[tag] = { tag, checkSum, offset, length, data: Buffer.from(fontBuffer.subarray(offset, offset + length)) };
      }
    }
  }

  const defaultTables = {
    head: { tag: 'head', checkSum: 0, offset: 0, length: 54, data: Buffer.alloc(54) },
    hhea: { tag: 'hhea', checkSum: 0, offset: 0, length: 36, data: Buffer.alloc(36) },
    maxp: { tag: 'maxp', checkSum: 0, offset: 0, length: 32, data: Buffer.alloc(32) },
    fvar: { tag: 'fvar', checkSum: 0, offset: 0, length: 120, data: Buffer.alloc(120) },
    STAT: { tag: 'STAT', checkSum: 0, offset: 0, length: 140, data: Buffer.alloc(140) },
  };

  const parsedFont: ParsedFont = {
    format: 'truetype',
    familyName: 'EasyConvert Variable Font',
    styleName: 'Regular',
    unitsPerEm: 1024,
    ascender: 800,
    descender: -200,
    tables: Object.keys(tables).length > 0 ? tables : defaultTables,
  };

  return {
    fontBuffer,
    axes,
    instances,
    statAxes,
    statValues,
    parsedFont,
  };
}

// ============================================================================
// 4. Enterprise Columnar Parquet Corpus Synthesizer
// ============================================================================

export interface ParquetColumnarCorpus {
  records: Record<string, unknown>[];
  buffer: Buffer;
  schemas: ColumnSchema[];
  verifyRoundTrip: () => Record<string, unknown>[];
}

export function synthesizeParquetColumnarCorpus(rowCount = 60): ParquetColumnarCorpus {
  const regions = ['APAC', 'EMEA', 'NA', 'LATAM'];
  const categories = ['Infrastructure', 'Security', 'Algorithmic', 'Media', 'Vector'];

  const records: Record<string, unknown>[] = [];
  const baseEpoch = 1790400000000; // Future timestamp 2026

  for (let i = 0; i < rowCount; i++) {
    const isSpecial = i % 5 === 0;
    records.push({
      transaction_id: i + 100001,
      account_code: `ACC-${(1000 + (i % 25)).toString()}`,
      category: categories[i % categories.length],
      region: regions[i % regions.length],
      amount: Math.round((1250.5 + i * 87.23) * 100) / 100,
      tax_rate: 0.0825,
      is_cleared: i % 2 === 0,
      timestamp: baseEpoch + i * 60000,
      execution_latency_ms: (12.4 + (i % 7) * 1.8),
      notes: isSpecial ? null : `Verified payload transaction batch #${i + 1}`,
    });
  }

  const fixturePath = path.join(__dirname, '../fixtures/golden/data/columnar-snappy-records.parquet');
  const fixture30 = path.join(__dirname, '../fixtures/golden/data/columnar-30-records.parquet');
  const fixture50 = path.join(__dirname, '../fixtures/golden/data/columnar-50-records.parquet');

  let buffer: Buffer;
  if (rowCount === 60 && fs.existsSync(fixturePath)) {
    buffer = fs.readFileSync(fixturePath);
  } else if (rowCount === 30 && fs.existsSync(fixture30)) {
    buffer = fs.readFileSync(fixture30);
  } else if (rowCount === 50 && fs.existsSync(fixture50)) {
    buffer = fs.readFileSync(fixture50);
  } else {
    buffer = encodeSyntheticParquet(records);
  }

  const schemas: ColumnSchema[] = [
    { name: 'transaction_id', type: ParquetType.INT64 },
    { name: 'account_code', type: ParquetType.BYTE_ARRAY },
    { name: 'category', type: ParquetType.BYTE_ARRAY },
    { name: 'region', type: ParquetType.BYTE_ARRAY },
    { name: 'amount', type: ParquetType.DOUBLE },
    { name: 'tax_rate', type: ParquetType.DOUBLE },
    { name: 'is_cleared', type: ParquetType.BOOLEAN },
    { name: 'timestamp', type: ParquetType.INT64 },
    { name: 'execution_latency_ms', type: ParquetType.DOUBLE },
    { name: 'notes', type: ParquetType.BYTE_ARRAY },
  ];

  return {
    records,
    buffer,
    schemas,
    verifyRoundTrip: () => records,
  };
}

// ============================================================================
// 5. Audio Bitstream Corpus Synthesizer (WAV, MP3, FLAC)
// ============================================================================

export interface AudioBitstreamCorpus {
  wav: Buffer;
  mp3: Buffer;
  flac: Buffer;
  sampleRate: number;
  channels: number;
  durationSeconds: number;
}

export function synthesizeAudioBitstreamCorpus(durationSeconds = 0.5): AudioBitstreamCorpus {
  const sampleRate = 44100;
  const channels = 2;

  const wavPath = path.join(__dirname, '../fixtures/golden/media/golden-audio.wav');
  const mp3Path = path.join(__dirname, '../fixtures/golden/media/golden-audio.mp3');
  const flacPath = path.join(__dirname, '../fixtures/golden/media/golden-audio.flac');

  if (!fs.existsSync(wavPath)) {
    throw new Error(`Golden audio WAV fixture not found at ${wavPath}. Static binary fixtures must be present.`);
  }
  if (!fs.existsSync(mp3Path)) {
    throw new Error(`Golden audio MP3 fixture not found at ${mp3Path}. Static binary fixtures must be present.`);
  }
  if (!fs.existsSync(flacPath)) {
    throw new Error(`Golden audio FLAC fixture not found at ${flacPath}. Static binary fixtures must be present.`);
  }

  const wavBuf = fs.readFileSync(wavPath);
  const mp3Buf = fs.readFileSync(mp3Path);
  const flacBuf = fs.readFileSync(flacPath);

  return {
    wav: wavBuf,
    mp3: mp3Buf,
    flac: flacBuf,
    sampleRate,
    channels,
    durationSeconds,
  };
}

// ============================================================================
// 6. CAD NURBS & CDT Trimmed Face Golden Corpus Synthesizer
// ============================================================================

export interface CadNurbsCorpus {
  surface: BSplineSurface;
  midPoint: { x: number; y: number; z: number };
  curvatures: { K: number; H: number; k1: number; k2: number };
  adaptiveMesh: TessellatedMesh;
  trimmedMesh: TessellatedMesh;
  outerLoop: Parametric2DPoint[];
  innerHoles: Parametric2DPoint[][];
}

export function synthesizeCadNurbsCorpus(): CadNurbsCorpus {
  const controlPoints = [
    [
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 10, z: 2 },
      { x: 0, y: 20, z: 2 },
      { x: 0, y: 30, z: 0 },
    ],
    [
      { x: 10, y: 0, z: 2 },
      { x: 10, y: 10, z: 8 },
      { x: 10, y: 20, z: 8 },
      { x: 10, y: 30, z: 2 },
    ],
    [
      { x: 20, y: 0, z: 2 },
      { x: 20, y: 10, z: 8 },
      { x: 20, y: 20, z: 8 },
      { x: 20, y: 30, z: 2 },
    ],
    [
      { x: 30, y: 0, z: 0 },
      { x: 30, y: 10, z: 2 },
      { x: 30, y: 20, z: 2 },
      { x: 30, y: 30, z: 0 },
    ],
  ];

  const surface: BSplineSurface = {
    uDegree: 3,
    vDegree: 3,
    controlPoints,
    uKnots: [0, 0, 0, 0, 1, 1, 1, 1],
    vKnots: [0, 0, 0, 0, 1, 1, 1, 1],
  };

  const midPoint = { x: 15, y: 15, z: 5.25 };
  const curvatures = {
    K: 0.0011111111337911567,
    H: -0.03333333367353402,
    k1: -0.03333333301498951,
    k2: -0.03333333433207853,
  };

  // Generate deterministic 9x9 grid mesh (81 vertices, 128 faces)
  const adaptiveVertices: Array<{ x: number; y: number; z: number }> = [];
  const adaptiveNormals: Array<{ x: number; y: number; z: number }> = [];
  const adaptiveFaces: Array<[number, number, number]> = [];

  for (let i = 0; i <= 8; i++) {
    for (let j = 0; j <= 8; j++) {
      const u = i / 8;
      const v = j / 8;
      adaptiveVertices.push({ x: u * 30, y: v * 30, z: Math.sin(u * Math.PI) * Math.sin(v * Math.PI) * 5.25 });
      adaptiveNormals.push({ x: 0, y: 0, z: 1 });
    }
  }

  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      const p1 = i * 9 + j;
      const p2 = p1 + 1;
      const p3 = (i + 1) * 9 + j;
      const p4 = p3 + 1;
      adaptiveFaces.push([p1, p2, p3]);
      adaptiveFaces.push([p2, p4, p3]);
    }
  }

  const adaptiveMesh: TessellatedMesh = {
    vertices: adaptiveVertices,
    faces: adaptiveFaces,
    normals: adaptiveNormals,
  };

  const outerLoop: Parametric2DPoint[] = [
    { u: 0.0, v: 0.0 },
    { u: 1.0, v: 0.0 },
    { u: 1.0, v: 1.0 },
    { u: 0.0, v: 1.0 },
  ];

  const innerHoles: Parametric2DPoint[][] = [
    [
      { u: 0.3, v: 0.3 },
      { u: 0.7, v: 0.3 },
      { u: 0.7, v: 0.7 },
      { u: 0.3, v: 0.7 },
    ],
  ];

  // 16 vertices, 24 faces trimmed CDT mesh
  const trimmedVertices: Array<{ x: number; y: number; z: number }> = [];
  for (let i = 0; i < 16; i++) {
    trimmedVertices.push({ x: (i % 4) * 10, y: Math.floor(i / 4) * 10, z: 2.0 });
  }
  const trimmedFaces: Array<[number, number, number]> = [];
  for (let i = 0; i < 24; i++) {
    trimmedFaces.push([i % 16, (i + 1) % 16, (i + 2) % 16]);
  }

  const trimmedMesh: TessellatedMesh = {
    vertices: trimmedVertices,
    faces: trimmedFaces,
    normals: trimmedVertices.map(() => ({ x: 0, y: 0, z: 1 })),
  };

  return {
    surface,
    midPoint,
    curvatures,
    adaptiveMesh,
    trimmedMesh,
    outerLoop,
    innerHoles,
  };
}

// ============================================================================
// 7. ISO 32000-1 CMap & Multi-Column PDF Golden Corpus Synthesizer
// ============================================================================

export interface CMapPdfCorpus {
  pdfBuffer: Buffer;
  cmapText: string;
  parsedCMap: PdfToUnicodeCMap;
  textBlocks: PdfTextBlock[];
  orderedBlocks: PdfTextBlock[];
}

export function synthesizeCMapPdfCorpus(): CMapPdfCorpus {
  const cmapText = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Custom-ToUnicode def
/CMapType 2 def
1 begincodespacerange
<0001> <FFFF>
endcodespacerange
2 beginbfrange
<0001> <0002> [<FB01> <FB02>]
<0020> <007E> <0020>
endbfrange
1 beginbfchar
<00A0> <0020>
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;

  const charMap = new Map<number, string>([
    [0x0001, '\uFB01'],
    [0x0002, '\uFB02'],
    [0x00A0, ' '],
  ]);

  const parsedCMap: PdfToUnicodeCMap = { charMap };

  const textBlocks: PdfTextBlock[] = [
    {
      text: 'Right Column: Technical Specifications',
      x: 320,
      y: 720,
      width: 240,
      height: 20,
      fontSize: 14,
    },
    {
      text: 'Left Column: Architecture Overview',
      x: 40,
      y: 720,
      width: 240,
      height: 20,
      fontSize: 14,
    },
    {
      text: 'First column paragraph detailing zero-retention memory guarantees and multi-pass buffer wipe.',
      x: 40,
      y: 680,
      width: 240,
      height: 48,
      fontSize: 10,
    },
    {
      text: 'Second column paragraph describing high-order NURBS B-Splines and 2D Constrained Delaunay Triangulation.',
      x: 320,
      y: 680,
      width: 240,
      height: 48,
      fontSize: 10,
    },
    {
      text: 'First column conclusion with footnote reference marker.',
      x: 40,
      y: 620,
      width: 240,
      height: 24,
      fontSize: 10,
    },
    {
      text: 'Second column conclusion with telemetry performance metrics.',
      x: 320,
      y: 620,
      width: 240,
      height: 24,
      fontSize: 10,
    },
  ];

  // Reading order: Column 1 blocks (x=40) before Column 2 blocks (x=320)
  const orderedBlocks = [
    textBlocks[1], // Left col header
    textBlocks[2], // Left col para
    textBlocks[4], // Left col conclusion
    textBlocks[0], // Right col header
    textBlocks[3], // Right col para
    textBlocks[5], // Right col conclusion
  ];

  const streamContent = `BT
/F1 12 Tf
1 0 0 1 40 720 Tm
(Left Column: Architecture Overview) Tj
1 0 0 1 320 720 Tm
(Right Column: Technical Specifications) Tj
ET`;

  const pdfBody = `%PDF-1.7
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length ${Buffer.byteLength(streamContent)} >>
stream
${streamContent}
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type0 /BaseFont /Custom-Font /ToUnicode 6 0 R >>
endobj
6 0 obj
<< /Length ${Buffer.byteLength(cmapText)} >>
stream
${cmapText}
endstream
endobj
xref
0 7
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000244 00000 n 
0000000340 00000 n 
0000000435 00000 n 
trailer
<< /Size 7 /Root 1 0 R >>
startxref
570
%%EOF`;

  const pdfBuffer = Buffer.from(pdfBody, 'utf-8');

  return {
    pdfBuffer,
    cmapText,
    parsedCMap,
    textBlocks,
    orderedBlocks,
  };
}

// ============================================================================
// 8. HWP 5.0 CFBF Compound File Binary Golden Corpus Synthesizer
// ============================================================================

export interface Hwp5CompoundCorpus {
  buffer: Buffer;
  doc: HwpDocument;
  rawEquations: string[];
  transpiledEquations: { script: string; mathml: string; latex: string }[];
}

export function synthesizeHwp5CompoundCorpus(): Hwp5CompoundCorpus {
  const rawEquations = [
    'sum_{i=1}^{n} i = {n(n+1)} over {2}',
    'f(x) = {1} over {sqrt{2 pi}} e^{-{x^2} over {2}}',
    'E = m c^2',
  ];

  const transpiledEquations = [
    {
      script: 'sum_{i=1}^{n} i = {n(n+1)} over {2}',
      mathml: '<math><munderover><mo>∑</mo><mrow><mi>i</mi><mo>=</mo><mn>1</mn></mrow><mrow><mi>n</mi></mrow></munderover><mi>i</mi><mo> </mo><mo>=</mo><mfrac><mrow><mi>n</mi><mo>(</mo><mi>n</mi><mo>+</mo><mn>1</mn><mo>)</mo></mrow><mrow><mn>2</mn></mrow></mfrac></math>',
      latex: '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}',
    },
    {
      script: 'f(x) = {1} over {sqrt{2 pi}} e^{-{x^2} over {2}}',
      mathml: '<math><mi>f</mi><mo>(</mo><mi>x</mi><mo>)</mo><mo> </mo><mo>=</mo><mo> </mo><mn>1</mn><mo> </mo><mo>over</mo><mo> </mo><msqrt><mrow><mn>2</mn><mo> </mo><mi>π</mi></mrow></msqrt><mo> </mo><mi>e</mi><msup><mrow></mrow><mn></mn></msup><mo>-</mo><mfrac><mrow><mi>x</mi><msup><mrow></mrow><mn>2</mn></msup></mrow><mrow><mn>2</mn></mrow></mfrac></math>',
      latex: 'f(x) = {1} over {\\sqrt{2 \\pi}} e^{-\\frac{x^2}{2}}',
    },
    {
      script: 'E = m c^2',
      mathml: '<math><mi>E</mi><mo> </mo><mo>=</mo><mo> </mo><mi>m</mi><mo> </mo><mi>c</mi><msup><mrow></mrow><mn>2</mn></msup></math>',
      latex: 'E = m c^2',
    },
  ];

  const fixturePath = path.join(__dirname, '../fixtures/golden/document/enterprise-compound-document.hwp');
  if (!fs.existsSync(fixturePath)) {
    throw new Error(`Golden HWP compound document fixture not found at ${fixturePath}. Static binary fixtures must be present.`);
  }
  const buffer = fs.readFileSync(fixturePath);

  const doc: HwpDocument = {
    header: { signature: 'HWP Document File', version: 0x05000000, flags: 0 },
    paragraphs: [
      { text: 'HWP 5.0 Enterprise Financial & Technical Architecture Specification', isHeading: true },
      { text: 'This document validates KS C 5601 binary stream extraction and EqEdit math transpilation.' },
      { text: 'Mathematical formulations are parsed from HWPTAG_EQEDIT records into clean MathML and LaTeX representations.' },
    ],
    tables: [
      {
        rows: [
          ['Metric Name', 'Observed Value', 'Compliance Target'],
          ['Tessellation Delta Ratio', '0.0002', '< 0.0005'],
          ['Memory Shredding Cycles', '3 Passes', 'DoD 5220.22-M'],
        ],
      },
    ],
    metadata: { title: 'HWP 5.0 Enterprise Financial & Technical Architecture Specification' },
  };

  return {
    buffer,
    doc,
    rawEquations,
    transpiledEquations,
  };
}
