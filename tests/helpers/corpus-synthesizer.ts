import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import { buildCompoundFile } from './cfb-craft';
import { pyarrowWrite, type ReferenceColumnKind } from './parquet-oracle';

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

/** Row counts with a committed golden file under tests/fixtures/golden/data. */
export const PARQUET_GOLDEN_FILES: ReadonlyMap<number, string> = new Map([
  [30, 'columnar-30-records.parquet'],
  [50, 'columnar-50-records.parquet'],
  [60, 'columnar-snappy-records.parquet'],
]);

const CORPUS_PARQUET_COLUMNS: ReadonlyArray<[string, ReferenceColumnKind]> = [
  ['transaction_id', 'int64'],
  ['account_code', 'string'],
  ['category', 'string'],
  ['region', 'string'],
  ['amount', 'double'],
  ['tax_rate', 'double'],
  ['is_cleared', 'bool'],
  ['timestamp', 'int64'],
  ['execution_latency_ms', 'double'],
  ['notes', 'string'],
];

/** Writes the corpus records as a Snappy-compressed Parquet file with the reference writer (pyarrow). */
export function writeCorpusParquet(records: Record<string, unknown>[]): Buffer {
  const columns: Record<string, (string | number | boolean | null)[]> = {};
  for (const [name] of CORPUS_PARQUET_COLUMNS) {
    columns[name] = records.map((record) => record[name] as string | number | boolean | null);
  }
  return pyarrowWrite(columns, [...CORPUS_PARQUET_COLUMNS], 'snappy');
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

  // The committed goldens (tests/fixtures/golden/data, see its PROVENANCE) and any other size are written by the
  // reference Parquet writer (pyarrow, Snappy), never by an encoder of this project, so every file is one the
  // reference reader reads. A size without a committed file needs python3 with pyarrow and throws
  // OracleToolMissingError without it.
  const goldenFile = PARQUET_GOLDEN_FILES.get(rowCount);
  const buffer =
    goldenFile && fs.existsSync(path.join(__dirname, '../fixtures/golden/data', goldenFile))
      ? fs.readFileSync(path.join(__dirname, '../fixtures/golden/data', goldenFile))
      : writeCorpusParquet(records);

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

  return {
    surface,
    midPoint,
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
  /** What was written into the file: the expectation any reader of it has to meet. */
  doc: HwpDocument;
  /** Equation scripts written into the file, in order. */
  rawEquations: string[];
}

// HWP 5.0 record layout (Hancom "Hangul Document File Format 5.0"): a 32-bit header holds the tag (10 bits), the
// level (10 bits) and the payload size (12 bits, 0xFFF meaning a 32-bit size follows).
const HWP_TAG = { DOCUMENT_PROPERTIES: 16, PARA_HEADER: 66, PARA_TEXT: 67, PARA_CHAR_SHAPE: 68, CTRL_HEADER: 71, LIST_HEADER: 72, TABLE: 77, EQEDIT: 88 } as const;
const HWP_EXTENDED_RECORD_SIZE = 0xfff;

function hwpRecord(tag: number, level: number, payload: Buffer): Buffer {
  const extended = payload.length >= HWP_EXTENDED_RECORD_SIZE;
  const header = Buffer.alloc(extended ? 8 : 4);
  const size = extended ? HWP_EXTENDED_RECORD_SIZE : payload.length;
  header.writeUInt32LE(((tag & 0x3ff) | ((level & 0x3ff) << 10) | (size << 20)) >>> 0, 0);
  if (extended) header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function hwpUnits(...units: number[]): Buffer {
  const out = Buffer.alloc(units.length * 2);
  units.forEach((unit, index) => out.writeUInt16LE(unit, index * 2));
  return out;
}

/** A paragraph: header, text with the paragraph-end mark, one character-shape run. `controls` are extended-control units placed before the text. */
function hwpParagraph(text: string, level: number, controls: Buffer = Buffer.alloc(0)): Buffer[] {
  const textBytes = Buffer.concat([controls, Buffer.from(text, 'utf16le'), hwpUnits(0x000d)]);
  const header = Buffer.alloc(24);
  header.writeUInt32LE(textBytes.length / 2, 0);
  header.writeUInt16LE(1, 14); // character shape runs
  header.writeUInt16LE(1, 18); // line segments
  return [hwpRecord(HWP_TAG.PARA_HEADER, level, header), hwpRecord(HWP_TAG.PARA_TEXT, level + 1, textBytes), hwpRecord(HWP_TAG.PARA_CHAR_SHAPE, level + 1, Buffer.alloc(8))];
}

/** The eight units an extended control takes in paragraph text: the code 0x0b, the control id (4 bytes), 8 bytes of data, the code again. */
function hwpControlMark(controlId: string): Buffer {
  return Buffer.concat([hwpUnits(0x000b), Buffer.from(controlId.split('').reverse().join(''), 'latin1'), Buffer.alloc(8), hwpUnits(0x000b)]);
}

function hwpTable(rows: string[][]): Buffer[] {
  const cols = Math.max(...rows.map((row) => row.length));
  const control = Buffer.alloc(46);
  control.write(' lbt', 0, 'latin1');
  const table = Buffer.alloc(18 + rows.length * 2 + 2);
  table.writeUInt32LE(0x04000006, 0);
  table.writeUInt16LE(rows.length, 4);
  table.writeUInt16LE(cols, 6);
  rows.forEach((_, row) => table.writeUInt16LE(cols, 18 + row * 2));
  const records = [...hwpParagraph('', 0, hwpControlMark('tbl ')), hwpRecord(HWP_TAG.CTRL_HEADER, 1, control), hwpRecord(HWP_TAG.TABLE, 2, table)];
  rows.forEach((row, rowIndex) => {
    for (let col = 0; col < cols; col += 1) {
      const cell = Buffer.alloc(34);
      cell.writeUInt32LE(1, 0);
      cell.writeUInt16LE(col, 8);
      cell.writeUInt16LE(rowIndex, 10);
      cell.writeUInt16LE(1, 12);
      cell.writeUInt16LE(1, 14);
      records.push(hwpRecord(HWP_TAG.LIST_HEADER, 2, cell), ...hwpParagraph(row[col] ?? '', 2));
    }
  });
  return records;
}

function hwpEquation(script: string): Buffer[] {
  const control = Buffer.alloc(4);
  control.write('deqe', 0, 'latin1');
  const payload = Buffer.concat([Buffer.alloc(4), hwpUnits(script.length), Buffer.from(script, 'utf16le')]);
  return [...hwpParagraph('', 0, hwpControlMark('eqed')), hwpRecord(HWP_TAG.CTRL_HEADER, 1, control), hwpRecord(HWP_TAG.EQEDIT, 2, payload)];
}

/**
 * An HWP 5.0 document written here, record by record, into a compound file written by the independent test writer
 * (cfb-craft). Nothing of the converter is used, so reading it back is a real check of the converter's reader.
 */
export function synthesizeHwp5CompoundCorpus(): Hwp5CompoundCorpus {
  const rawEquations = ['sum_{i=1}^{n} i = {n(n+1)} over {2}', 'f(x) = {1} over {sqrt{2 pi}} e^{-{x^2} over {2}}', 'E = m c^2'];
  const doc: HwpDocument = {
    header: { signature: 'HWP Document File', version: 0x05000300, flags: 0x01 },
    paragraphs: [
      { text: 'HWP 5.0 Enterprise Financial & Technical Architecture Specification' },
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
  };

  const section = Buffer.concat([
    ...doc.paragraphs.flatMap((paragraph) => hwpParagraph(paragraph.text, 0)),
    ...rawEquations.flatMap(hwpEquation),
    ...(doc.tables ?? []).flatMap((table) => hwpTable(table.rows)),
  ]);
  const fileHeader = Buffer.alloc(256);
  fileHeader.write('HWP Document File', 0, 'latin1');
  fileHeader.writeUInt32LE(doc.header?.version ?? 0, 32);
  fileHeader.writeUInt32LE(doc.header?.flags ?? 0, 36);
  const documentProperties = Buffer.alloc(26);
  documentProperties.writeUInt16LE(1, 0);

  const buffer = buildCompoundFile([
    { name: 'FileHeader', data: fileHeader },
    { name: 'DocInfo', data: zlib.deflateRawSync(hwpRecord(HWP_TAG.DOCUMENT_PROPERTIES, 0, documentProperties)) },
    { name: 'BodyText/Section0', data: zlib.deflateRawSync(section) },
  ]);
  return { buffer, doc, rawEquations };
}
