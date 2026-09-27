import JSZip from 'jszip';
import {
  encodeParquet,
  decodeParquet,
  inferColumnSchemas,
  ParquetType,
  ColumnSchema,
} from '../../src/lib/conversions/parquet';
import {
  createFvarTable,
  createStatTable,
  createCanonicalFont,
  encodeSfnt,
  inspectVariableFont,
  VariableFontAxis,
  VariableFontInstance,
  StatDesignAxis,
  StatAxisValue,
  ParsedFont,
} from '../../src/lib/conversions/font';
import {
  renderDrawingMlToSvg,
  parseDrawingMlShapes,
  DrawingMlShape,
} from '../../src/lib/conversions/office';
import { buildHwpxContainer } from '../../src/lib/conversions/hwpx';
import { encodePureMp3, encodeFlacStream } from '../../src/lib/conversions/media-encoder';

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

      // Add footnotes section
      docXml += `    <w:p><w:r><w:rPr><w:b/><w:sz w:val="24"/></w:rPr><w:t>Footnotes</w:t></w:r></w:p>
`;
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
      const allParagraphs: Array<{ text: string; isHeading?: boolean }> = [
        { text: metadata.title, isHeading: true },
        { text: `${metadata.author} • ${metadata.version} • ${metadata.createdAt}`, isHeading: false },
      ];

      for (const sec of sections) {
        allParagraphs.push({ text: sec.heading, isHeading: true });
        for (const p of sec.paragraphs) {
          allParagraphs.push({ text: p, isHeading: false });
        }
      }

      allParagraphs.push({ text: 'Footnotes & Annotations', isHeading: true });
      for (const fn of footnotes) {
        allParagraphs.push({ text: `${fn.label} ${fn.content}`, isHeading: false });
      }

      return buildHwpxContainer({
        paragraphs: allParagraphs,
        metadata: {
          title: metadata.title,
          author: metadata.author,
          date: metadata.createdAt,
        },
      });
    },
  };
}

// ============================================================================
// 2. Complex Nested Tables & DrawingML Vector Shape Synthesizer
// ============================================================================

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
      customPath: 'M 0 30 Q 30 5 60 18 T 120 5',
      svgPath: 'M 0 30 Q 30 5 60 18 T 120 5',
      x: 200,
      y: 10,
      width: 120,
      height: 36,
      fillColor: 'none',
      strokeColor: '#3B4890',
      strokeWidth: 2.5,
    },
  ];

  const drawingMlXml = `
<p:sp xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:spPr>
    <a:xfrm>
      <a:off x="914400" y="457200"/>
      <a:ext cx="1828800" cy="457200"/>
    </a:xfrm>
    <a:prstGeom prst="roundRect">
      <a:avLst>
        <a:gd name="adj" fmla="val 16667"/>
      </a:avLst>
    </a:prstGeom>
    <a:solidFill>
      <a:srgbClr val="5C6BC0"/>
    </a:solidFill>
    <a:ln w="25400">
      <a:solidFill>
        <a:srgbClr val="4A58A9"/>
      </a:solidFill>
    </a:ln>
  </p:spPr>
</p:sp>
<p:sp xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:spPr>
    <a:xfrm>
      <a:off x="2834640" y="457200"/>
      <a:ext cx="457200" cy="457200"/>
    </a:xfrm>
    <a:prstGeom prst="ellipse"/>
    <a:solidFill>
      <a:srgbClr val="8E9CE6"/>
    </a:solidFill>
  </p:spPr>
</p:sp>
<p:sp xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:spPr>
    <a:xfrm>
      <a:off x="3400000" y="457200"/>
      <a:ext cx="1200000" cy="360000"/>
    </a:xfrm>
    <a:custGeom>
      <a:pathLst>
        <a:path w="120" h="36">
          <a:moveTo><a:pt x="0" y="30"/></a:moveTo>
          <a:quadBezTo>
            <a:pt x="30" y="5"/>
            <a:pt x="60" y="18"/>
          </a:quadBezTo>
          <a:lnTo><a:pt x="120" y="5"/></a:lnTo>
        </a:path>
      </a:pathLst>
    </a:custGeom>
    <a:ln w="31750">
      <a:solidFill><a:srgbClr val="3B4890"/></a:solidFill>
    </a:ln>
  </p:spPr>
</p:sp>
`;

  const innerSubTable: NestedTable = {
    id: 'sub_tbl_finance',
    rowCount: 2,
    colCount: 2,
    rows: [
      [
        { text: 'Q3 Inflow', isHeader: true, shading: 'CCD2FC' },
        { text: 'Q4 Inflow', isHeader: true, shading: 'CCD2FC' },
      ],
      [
        { text: '$1,450,200', shading: 'F8F9FF' },
        { text: '$2,190,500', shading: 'F8F9FF' },
      ],
    ],
  };

  const outerTable: NestedTable = {
    id: 'tbl_master_enterprise',
    rowCount: 4,
    colCount: 3,
    borders: {
      top: { val: 'single', sz: 8, color: '4A58A9' },
      bottom: { val: 'double', sz: 12, color: '1F2340' },
      insideH: { val: 'single', sz: 4, color: 'E1E4EE' },
      insideV: { val: 'single', sz: 4, color: 'E1E4EE' },
    },
    rows: [
      // Row 0: Full table span header
      [
        {
          text: 'Enterprise Portfolio & Vector Analytics Master Ledger',
          colSpan: 3,
          isHeader: true,
          shading: '4A58A9',
        },
      ],
      // Row 1: Left cell merged across 2 rows, middle contains inner subtable, right contains DrawingML shape
      [
        {
          text: 'Consolidated Metrics',
          rowSpan: 2,
          shading: 'F0F2F7',
        },
        {
          text: '',
          nestedTable: innerSubTable,
          shading: 'FFFFFF',
        },
        {
          text: 'Vector Annotation',
          drawingShape: sampleShapes[0],
          shading: 'FFFFFF',
        },
      ],
      // Row 2: Bottom row of the merged row block
      [
        {
          text: 'Active Node Status: Operational (99.99%)',
          shading: 'EEF2FF',
        },
        {
          text: 'Confidence Score: 0.9984',
          drawingShape: sampleShapes[1],
          shading: 'EEF2FF',
        },
      ],
      // Row 3: Footer summary with double underline
      [
        { text: 'Total Aggregation', isHeader: true, shading: 'CCD2FC' },
        { text: '$3,640,700 Total Volume', colSpan: 2, shading: 'F8F9FF' },
      ],
    ],
  };

  return {
    table: outerTable,
    shapes: sampleShapes,
    drawingMlXml,
    renderSvg: () => renderDrawingMlToSvg(sampleShapes),
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

  const fvarTable = createFvarTable(axes, instances);
  const statTable = createStatTable(statAxes, statValues);

  // Synthesize canonical base font with head, hhea, maxp, fvar, STAT
  const headTable = Buffer.alloc(54);
  headTable.writeUInt32BE(0x5f0f3cf5, 0); // magicNumber
  headTable.writeUInt16BE(1024, 18); // unitsPerEm = 1024

  const hheaTable = Buffer.alloc(36);
  hheaTable.writeInt16BE(800, 4); // ascender
  hheaTable.writeInt16BE(-200, 6); // descender
  hheaTable.writeUInt16BE(1, 34); // numberOfHMetrics

  const maxpTable = Buffer.alloc(32);
  maxpTable.writeUInt32BE(0x00010000, 0); // version 1.0
  maxpTable.writeUInt16BE(2, 4); // numGlyphs = 2

  // Build name table with axis strings
  const nameEntries = [
    { nameID: 1, str: 'EasyConvert Variable Font' },
    { nameID: 2, str: 'Regular' },
    { nameID: 4, str: 'EasyConvert Variable Font Regular' },
    { nameID: 256, str: 'Weight' },
    { nameID: 257, str: 'Width' },
    { nameID: 258, str: 'Slant' },
    { nameID: 260, str: 'Thin' },
    { nameID: 261, str: 'Light' },
    { nameID: 262, str: 'Regular' },
    { nameID: 263, str: 'Bold' },
    { nameID: 264, str: 'Black Condensed' },
    { nameID: 265, str: 'Oblique' },
  ];

  let strStorageOffset = 6 + nameEntries.length * 12;
  const strBuffers: Buffer[] = [];
  const nameRecords: Buffer[] = [];
  let curStrOffset = 0;

  function encodeUtf16BE(str: string): Buffer {
    const buf = Buffer.alloc(str.length * 2);
    for (let i = 0; i < str.length; i++) {
      buf.writeUInt16BE(str.charCodeAt(i), i * 2);
    }
    return buf;
  }

  for (const entry of nameEntries) {
    const sBuf = encodeUtf16BE(entry.str);
    strBuffers.push(sBuf);
    const rec = Buffer.alloc(12);
    rec.writeUInt16BE(3, 0); // platformID Windows
    rec.writeUInt16BE(1, 2); // encodingID Unicode BMP
    rec.writeUInt16BE(0x0409, 4); // langID English (US)
    rec.writeUInt16BE(entry.nameID, 6);
    rec.writeUInt16BE(sBuf.length, 8);
    rec.writeUInt16BE(curStrOffset, 10);
    nameRecords.push(rec);
    curStrOffset += sBuf.length;
  }

  const nameHeader = Buffer.alloc(6);
  nameHeader.writeUInt16BE(0, 0); // format 0
  nameHeader.writeUInt16BE(nameEntries.length, 2);
  nameHeader.writeUInt16BE(strStorageOffset, 4);

  const nameTable = Buffer.concat([nameHeader, ...nameRecords, ...strBuffers]);

  const numTables = 6;
  const tableData = [
    { tag: 'head', data: headTable },
    { tag: 'hhea', data: hheaTable },
    { tag: 'maxp', data: maxpTable },
    { tag: 'name', data: nameTable },
    { tag: 'fvar', data: fvarTable },
    { tag: 'STAT', data: statTable },
  ];

  let totalSize = 12 + numTables * 16;
  for (const t of tableData) {
    totalSize += t.data.length + ((4 - (t.data.length % 4)) % 4);
  }

  const fontBuf = Buffer.alloc(totalSize);
  fontBuf.writeUInt32BE(0x00010000, 0); // sfntVersion TrueType
  fontBuf.writeUInt16BE(numTables, 4);

  let dirOff = 12;
  let dataOff = 12 + numTables * 16;

  for (const t of tableData) {
    fontBuf.write(t.tag, dirOff, 4, 'ascii');
    fontBuf.writeUInt32BE(0, dirOff + 4); // checksum
    fontBuf.writeUInt32BE(dataOff, dirOff + 8);
    fontBuf.writeUInt32BE(t.data.length, dirOff + 12);
    t.data.copy(fontBuf, dataOff);
    dirOff += 16;
    dataOff += t.data.length + ((4 - (t.data.length % 4)) % 4);
  }

  const finalBuf = fontBuf.subarray(0, dataOff);
  const parsedFont = createCanonicalFont(finalBuf, 'EasyConvert Variable Font');
  parsedFont.tables['fvar'] = {
    tag: 'fvar',
    checkSum: 0,
    offset: 0,
    length: fvarTable.length,
    data: fvarTable,
  };
  parsedFont.tables['STAT'] = {
    tag: 'STAT',
    checkSum: 0,
    offset: 0,
    length: statTable.length,
    data: statTable,
  };

  return {
    fontBuffer: finalBuf,
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

  const schemas = inferColumnSchemas(records);
  const buffer = encodeParquet(records);

  return {
    records,
    buffer,
    schemas,
    verifyRoundTrip: () => decodeParquet(buffer),
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
  const totalSamples = Math.floor(sampleRate * durationSeconds);

  // Synthesize dual-tone 440Hz + 880Hz harmonic PCM wave
  const pcmSamples = new Int16Array(totalSamples * channels);
  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    const toneA = Math.sin(2 * Math.PI * 440 * t);
    const toneB = Math.sin(2 * Math.PI * 880 * t) * 0.35;
    const sampleVal = Math.round((toneA + toneB) * 14000);
    const clamped = Math.max(-32768, Math.min(32767, sampleVal));

    pcmSamples[i * 2] = clamped; // Left
    pcmSamples[i * 2 + 1] = clamped; // Right
  }

  // 1. WAV RIFF container
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  const dataSize = totalSamples * blockAlign;
  const wavBuf = Buffer.alloc(44 + dataSize);

  wavBuf.write('RIFF', 0, 'ascii');
  wavBuf.writeUInt32LE(36 + dataSize, 4);
  wavBuf.write('WAVE', 8, 'ascii');
  wavBuf.write('fmt ', 12, 'ascii');
  wavBuf.writeUInt32LE(16, 16); // subchunk1 size
  wavBuf.writeUInt16LE(1, 20); // PCM audio format = 1
  wavBuf.writeUInt16LE(channels, 22);
  wavBuf.writeUInt32LE(sampleRate, 24);
  wavBuf.writeUInt32LE(byteRate, 28);
  wavBuf.writeUInt16LE(blockAlign, 32);
  wavBuf.writeUInt16LE(16, 34); // bitsPerSample
  wavBuf.write('data', 36, 'ascii');
  wavBuf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < pcmSamples.length; i++) {
    wavBuf.writeInt16LE(pcmSamples[i], 44 + i * 2);
  }

  // 2. Pure MP3 bitstream via engine's encodePureMp3
  const mp3Buf = encodePureMp3(pcmSamples, sampleRate, channels, '192k', 'Golden Audio Corpus');

  // 3. Authentic RFC 9639 FLAC Stream
  const flacBuf = encodeFlacStream(pcmSamples, sampleRate, channels);

  return {
    wav: wavBuf,
    mp3: mp3Buf,
    flac: flacBuf,
    sampleRate,
    channels,
    durationSeconds,
  };
}
