import { safeDecodeXmlEntities, safeExtractXmlElements } from '../safe-xml-scanner';
import { withoutElements } from './xml-without';
import { type DocxBlockElement, type DocxParagraph, type DocxRun, type DocxTable, type DocxTableCell, type OpenXmlChartData, type TableBorder } from './types';
import { parseOpenXmlChart } from './chart-parse';
import { renderChartToSvg } from './chart-svg';
import { renderDrawingMlToSvg } from './drawingml-shapes';
import { safeExtractDocxBlocks, safeExtractFirstXmlElement, safeExtractXmlTags } from './xml-helpers';

function borderStyleOf(val: string): 'double' | 'dashed' | 'dotted' | 'solid' {
  if (val === 'double') return 'double';
  if (val.includes('dash')) return 'dashed';
  return val.includes('dot') ? 'dotted' : 'solid';
}

function headingLevelOf(isHeading1: boolean, isHeading2: boolean, isHeading3: boolean, isHeading: boolean): number {
  if (isHeading1) return 1;
  if (isHeading2) return 2;
  if (isHeading3) return 3;
  return isHeading ? 2 : 0;
}

export function parseBorder(borderXml: string): TableBorder | undefined {
  if (!borderXml) return undefined;
  const valMatch = borderXml.match(/w:val="([^"]+)"/);
  const val = valMatch ? valMatch[1] : 'single';
  if (val === 'none' || val === 'nil') return { style: 'none' };
  const szMatch = borderXml.match(/w:sz="(\d+)"/);
  const sz = szMatch ? parseInt(szMatch[1], 10) / 8 : 0.5; // in pt (w:sz is in eighths of a point)
  const colMatch = borderXml.match(/w:color="([A-Fa-f0-9]{6})"/);
  const color = colMatch ? `#${colMatch[1]}` : '#CCD2FC';
  return { style: borderStyleOf(val), size: sz, color };
}

function parseDrawingBlockElement(
  dXml: string,
  chartMap?: Map<string, string>
): DocxBlockElement | null {
  const chartRefMatch = dXml.match(/<c:chart\b[^>]*?(?:r:id|id)="([^"]+)"/i);
  let parsedChart: OpenXmlChartData | null = null;
  if (chartRefMatch && chartMap?.has(chartRefMatch[1])) {
    parsedChart = parseOpenXmlChart(chartMap.get(chartRefMatch[1])!);
  } else if (
    dXml.includes('<c:chart') ||
    dXml.includes('<c:plotArea') ||
    dXml.includes('<c:chartSpace>')
  ) {
    parsedChart = parseOpenXmlChart(dXml);
  }

  if (parsedChart) {
    const extMatch =
      dXml.match(/<wp:extent\b[^>]*?cx="(\d+)"[^>]*?cy="(\d+)"/i) ||
      dXml.match(/<a:ext\b[^>]*?cx="(\d+)"[^>]*?cy="(\d+)"/i);
    const chartW = extMatch ? Math.max(100, Math.round(parseInt(extMatch[1], 10) / 12700)) : 500;
    const chartH = extMatch ? Math.max(80, Math.round(parseInt(extMatch[2], 10) / 12700)) : 300;
    const chartSvg = renderChartToSvg(parsedChart, chartW, chartH);
    return {
      type: 'drawing',
      svg: chartSvg,
      chart: parsedChart,
      shapes: [
        {
          geomType: 'preset',
          presetGeom: 'rect',
          x: 0,
          y: 0,
          width: chartW,
          height: chartH,
          chart: parsedChart,
          chartSvg,
          text: parsedChart.title || `${parsedChart.type} chart`,
        },
      ],
    };
  }

  const res = renderDrawingMlToSvg(dXml);
  if (res.shapes.length > 0) {
    const chartShape = res.shapes.find((s) => s.chart);
    return {
      type: 'drawing',
      svg: res.svg,
      shapes: res.shapes,
      chart: chartShape?.chart,
    };
  }

  return null;
}

export interface WordTableStyle {
  borders?: DocxTable['tblBorders'];
  shading?: string;
}

export function parseWordStyles(stylesXml: string): Map<string, WordTableStyle> {
  const styleMap = new Map<string, WordTableStyle>();
  if (!stylesXml) return styleMap;

  const styleTags = safeExtractXmlTags(stylesXml, 'w:style');
  for (const sXml of styleTags) {
    const isTableStyle = /w:type="table"/.test(sXml);
    if (!isTableStyle) continue;

    const idMatch = sXml.match(/w:styleId="([^"]+)"/);
    if (!idMatch) continue;
    const styleId = idMatch[1];

    let borders: DocxTable['tblBorders'] | undefined;
    const tblBordersEl = safeExtractFirstXmlElement(sXml, 'w:tblBorders');
    if (tblBordersEl) {
      const bXml = tblBordersEl.content;
      const topEl = safeExtractFirstXmlElement(bXml, 'w:top');
      const bottomEl = safeExtractFirstXmlElement(bXml, 'w:bottom');
      const leftEl = safeExtractFirstXmlElement(bXml, 'w:left');
      const rightEl = safeExtractFirstXmlElement(bXml, 'w:right');
      const inHEl = safeExtractFirstXmlElement(bXml, 'w:insideH');
      const inVEl = safeExtractFirstXmlElement(bXml, 'w:insideV');
      borders = {
        top: parseBorder(topEl ? topEl.raw : ''),
        bottom: parseBorder(bottomEl ? bottomEl.raw : ''),
        left: parseBorder(leftEl ? leftEl.raw : ''),
        right: parseBorder(rightEl ? rightEl.raw : ''),
        insideH: parseBorder(inHEl ? inHEl.raw : ''),
        insideV: parseBorder(inVEl ? inVEl.raw : ''),
      };
    }

    const shdMatch = sXml.match(/<w:shd[^>]*w:fill="([A-Fa-f0-9]{6})"/);
    const shading = shdMatch ? shdMatch[1] : undefined;

    styleMap.set(styleId, { borders, shading });
  }

  return styleMap;
}

function parseSingleDocxTable(
  chunk: string,
  styleMap?: Map<string, WordTableStyle>,
  depth: number = 0
): DocxTable | null {
  if (depth > 16) return null;
  const rows: string[][] = [];
  const structuredRows: DocxTableCell[][] = [];

  const styleMatch = chunk.match(/<w:tblStyle[^>]*w:val="([^"]+)"/);
  const tableStyleId = styleMatch ? styleMatch[1] : undefined;
  const inheritedStyle = tableStyleId && styleMap ? styleMap.get(tableStyleId) : undefined;

  const tblBordersEl = safeExtractFirstXmlElement(chunk, 'w:tblBorders');
  let tblBorders: DocxTable['tblBorders'];
  if (tblBordersEl) {
    const bXml = tblBordersEl.content;
    const topEl = safeExtractFirstXmlElement(bXml, 'w:top');
    const bottomEl = safeExtractFirstXmlElement(bXml, 'w:bottom');
    const leftEl = safeExtractFirstXmlElement(bXml, 'w:left');
    const rightEl = safeExtractFirstXmlElement(bXml, 'w:right');
    const inHEl = safeExtractFirstXmlElement(bXml, 'w:insideH');
    const inVEl = safeExtractFirstXmlElement(bXml, 'w:insideV');
    tblBorders = {
      top: parseBorder(topEl ? topEl.raw : ''),
      bottom: parseBorder(bottomEl ? bottomEl.raw : ''),
      left: parseBorder(leftEl ? leftEl.raw : ''),
      right: parseBorder(rightEl ? rightEl.raw : ''),
      insideH: parseBorder(inHEl ? inHEl.raw : ''),
      insideV: parseBorder(inVEl ? inVEl.raw : ''),
    };
  } else if (inheritedStyle?.borders) {
    tblBorders = inheritedStyle.borders;
  }

  const trList = safeExtractXmlTags(chunk, 'w:tr');
  const activeVMerge = new Map<number, { cell: DocxTableCell; rowIdx: number }>();

  for (let rIdx = 0; rIdx < trList.length; rIdx++) {
    const trXml = trList[rIdx];
    const rowCells: string[] = [];
    const sCells: DocxTableCell[] = [];
    const isHeader = /<w:tblHeader(\/|>)/.test(trXml) || rIdx === 0;

    const tcList = safeExtractXmlTags(trXml, 'w:tc');
    let currentGridCol = 0;

    for (const tcXml of tcList) {
      const shdMatch = tcXml.match(/<w:shd[^>]*w:fill="([A-Fa-f0-9]{6})"/);
      const shading = shdMatch ? shdMatch[1] : inheritedStyle?.shading;

      const spanMatch = tcXml.match(/<w:gridSpan[^>]*w:val="(\d+)"/);
      const colSpan = spanMatch ? parseInt(spanMatch[1], 10) : 1;

      // Vertical merge detection per OpenXML ISO/IEC 29500-1 §17.4.84
      const vMergeMatch = tcXml.match(/<w:vMerge\b([^>]*)\/?>/);
      let vMergeType: 'restart' | 'continue' | undefined;
      if (vMergeMatch) {
        const valMatch = vMergeMatch[1].match(/w:val="([^"]+)"/);
        vMergeType = valMatch && valMatch[1] === 'restart' ? 'restart' : 'continue';
      }

      const tcBordersEl = safeExtractFirstXmlElement(tcXml, 'w:tcBorders');
      let borders: DocxTableCell['borders'];
      if (tcBordersEl) {
        const bXml = tcBordersEl.content;
        const topEl = safeExtractFirstXmlElement(bXml, 'w:top');
        const bottomEl = safeExtractFirstXmlElement(bXml, 'w:bottom');
        const leftEl = safeExtractFirstXmlElement(bXml, 'w:left');
        const rightEl = safeExtractFirstXmlElement(bXml, 'w:right');
        borders = {
          top: parseBorder(topEl ? topEl.raw : ''),
          bottom: parseBorder(bottomEl ? bottomEl.raw : ''),
          left: parseBorder(leftEl ? leftEl.raw : ''),
          right: parseBorder(rightEl ? rightEl.raw : ''),
        };
      }

      const jcMatch = tcXml.match(/<w:jc\b[^>]*w:val="([^"]+)"/i);
      const alignment =
        jcMatch && ['left', 'center', 'right'].includes(jcMatch[1])
          ? (jcMatch[1] as 'left' | 'center' | 'right')
          : undefined;

      // Extract nested tables if present inside cell
      const nestedTblEls = safeExtractXmlElements(tcXml, 'w:tbl');
      const nestedTables: DocxTable[] = [];
      let directTcXml = tcXml;
      for (const nEl of nestedTblEls) {
        const parsedN = parseSingleDocxTable(nEl.raw, styleMap, depth + 1);
        if (parsedN) {
          nestedTables.push(parsedN);
        }
        directTcXml = directTcXml.replace(nEl.raw, '');
      }
      const nestedTable = nestedTables[0];

      // Isolate cell direct content without nested table text
      const pList = safeExtractXmlTags(directTcXml, 'w:p');
      let cellText = '';
      if (pList.length > 0) {
        cellText = pList
          .map((pXml) => {
            const tTags = safeExtractXmlTags(pXml, 'w:t');
            return safeDecodeXmlEntities(
              tTags.map((m) => m.replace(/<[^>]+>/g, '')).join('')
            ).trim();
          })
          .filter(Boolean)
          .join('\n');
      } else {
        const tTags = safeExtractXmlTags(directTcXml, 'w:t');
        cellText = safeDecodeXmlEntities(
          tTags.map((m) => m.replace(/<[^>]+>/g, '')).join('')
        ).trim();
      }

      let fullCellText = cellText;
      for (const nTbl of nestedTables) {
        if (nTbl.rows.length > 0) {
          const nestedRowsText = nTbl.rows.map((r) => r.join(' | ')).join('\n');
          fullCellText = fullCellText ? `${fullCellText}\n${nestedRowsText}` : nestedRowsText;
        }
      }

      const cellObj: DocxTableCell = {
        text: cellText,
        fullCellText,
        shading,
        colSpan,
        isHeader,
        borders,
        alignment,
        nestedTable,
        nestedTables: nestedTables.length > 0 ? nestedTables : undefined,
      };

      if (vMergeType === 'restart') {
        cellObj.rowSpan = 1;
        for (let c = 0; c < colSpan; c++) {
          activeVMerge.set(currentGridCol + c, { cell: cellObj, rowIdx: rIdx });
        }
      } else if (vMergeType === 'continue') {
        const mergeRoot = activeVMerge.get(currentGridCol);
        if (mergeRoot) {
          if (mergeRoot.rowIdx !== rIdx) {
            mergeRoot.cell.rowSpan = (mergeRoot.cell.rowSpan || 1) + 1;
            mergeRoot.rowIdx = rIdx;
          }
          if (cellText) {
            mergeRoot.cell.text = mergeRoot.cell.text
              ? `${mergeRoot.cell.text}\n${cellText}`
              : cellText;
            mergeRoot.cell.fullCellText = mergeRoot.cell.fullCellText
              ? `${mergeRoot.cell.fullCellText}\n${fullCellText}`
              : fullCellText;
          }
          cellObj.rowSpan = 0; // Marked as vertically merged
        }
      } else {
        for (let c = 0; c < colSpan; c++) {
          activeVMerge.delete(currentGridCol + c);
        }
      }

      currentGridCol += colSpan;
      rowCells.push(fullCellText);
      sCells.push(cellObj);
    }

    if (rowCells.length > 0) {
      rows.push(rowCells);
      structuredRows.push(sCells);
    }
  }

  const tblGridEl = safeExtractFirstXmlElement(chunk, 'w:tblGrid');
  let colWidths: number[] | undefined;
  if (tblGridEl) {
    const gridCols = safeExtractXmlTags(tblGridEl.content, 'w:gridCol');
    const parsedWidths: number[] = [];
    for (const colXml of gridCols) {
      const wMatch = colXml.match(/w:w="(\d+)"/);
      if (wMatch) {
        parsedWidths.push(parseInt(wMatch[1], 10));
      }
    }
    if (parsedWidths.length > 0) {
      colWidths = parsedWidths;
    }
  }

  if (rows.length === 0) return null;

  const maxStructuredCols = structuredRows.reduce(
    (max, sr) => Math.max(max, sr.reduce((sum, c) => sum + Math.max(1, c.colSpan || 1), 0)),
    0
  );
  const gridColCount = rows.reduce((max, r) => Math.max(max, r.length), maxStructuredCols);
  const maxCols = colWidths && colWidths.length > 0 ? Math.max(colWidths.length, gridColCount) : gridColCount;

  return {
    rowCount: rows.length,
    colCount: maxCols,
    colWidths,
    rows,
    structuredRows,
    tblBorders,
  };
}

const ALLOWED_JC: ReadonlySet<string> = new Set(['left', 'center', 'right', 'both', 'justify', 'start', 'end']);

export function parseDocxXml(
  xml: string,
  chartMap?: Map<string, string>,
  styleMap?: Map<string, WordTableStyle>
): {
  paragraphs: DocxParagraph[];
  tables: DocxTable[];
  elements: DocxBlockElement[];
} {
  const paragraphs: DocxParagraph[] = [];
  const tables: DocxTable[] = [];
  const elements: DocxBlockElement[] = [];

  const bodyOpen = xml.indexOf('<w:body');
  const bodyClose = xml.indexOf('</w:body>');
  const bodyXml =
    bodyOpen !== -1 && bodyClose !== -1 && bodyClose > bodyOpen
      ? xml.slice(bodyOpen, bodyClose + 9)
      : xml;

  const blocks = safeExtractDocxBlocks(withoutElements(bodyXml, 'w:rt'));

  for (const chunk of blocks) {
    // If chunk is a standalone Drawing (<w:drawing>)
    if (chunk.startsWith('<w:drawing')) {
      const el = parseDrawingBlockElement(chunk, chartMap);
      if (el) elements.push(el);
      continue;
    }

    // If chunk is a Table (<w:tbl>)
    if (chunk.startsWith('<w:tbl')) {
      const tbl = parseSingleDocxTable(chunk, styleMap);
      if (tbl) {
        tables.push(tbl);
        elements.push({ type: 'table', table: tbl });
      }
      continue;
    }

    // Chunk is a Paragraph (<w:p>)
    const isHeading1 = /<w:pStyle\s+[^>]*w:val="Heading1"/i.test(chunk);
    const isHeading2 = /<w:pStyle\s+[^>]*w:val="Heading2"/i.test(chunk);
    const isHeading3 = /<w:pStyle\s+[^>]*w:val="Heading3"/i.test(chunk);
    const isHeading = isHeading1 || isHeading2 || isHeading3 || /<w:pStyle\s+[^>]*w:val="Heading/i.test(chunk);
    const headingLevel = headingLevelOf(isHeading1, isHeading2, isHeading3, isHeading);

    const jcMatch = chunk.match(/<w:jc\s+[^>]*w:val="([^"]+)"/);
    const alignment = jcMatch && ALLOWED_JC.has(jcMatch[1]) ? (jcMatch[1] as any) : undefined;
    const isBullet = /<w:numPr(\/|>)/.test(chunk);

    // Extract runs (<w:r>)
    const runs: DocxRun[] = [];
    const rEls = safeExtractXmlElements(chunk, 'w:r');
    let overallBold = false;
    let overallItalic = false;

    for (const rEl of rEls) {
      const rXml = rEl.raw;
      const rBold = /<w:b(\/|>)/.test(rXml);
      const rItalic = /<w:i(\/|>)/.test(rXml);
      const rUnderline = /<w:u(\/|>)/.test(rXml);
      const rStrike = /<w:strike(\/|>)/.test(rXml);

      const colorMatch = rXml.match(/<w:color\s+[^>]*w:val="([A-Fa-f0-9]{6})"/);
      const color = colorMatch ? colorMatch[1] : undefined;

      const szMatch = rXml.match(/<w:sz\s+[^>]*w:val="(\d+)"/);
      const fontSize = szMatch ? parseInt(szMatch[1], 10) / 2 : undefined;

      const tEls = safeExtractXmlElements(rEl.content, 'w:t');
      const rText = tEls
        .map((m) => safeDecodeXmlEntities(m.content.replace(/<[^>]+>/g, '')))
        .join('');

      if (rText) {
        if (rBold) overallBold = true;
        if (rItalic) overallItalic = true;
        runs.push({
          text: rText,
          isBold: rBold,
          isItalic: rItalic,
          isUnderline: rUnderline,
          isStrike: rStrike,
          color,
          fontSize,
        });
      }
    }

    const text = runs.map((r) => r.text).join('').trim();
    if (text.length > 0) {
      const p: DocxParagraph = {
        text,
        runs,
        isHeading,
        headingLevel,
        isBold: overallBold,
        isItalic: overallItalic,
        alignment,
        isBullet,
      };
      paragraphs.push(p);
      elements.push({ type: 'paragraph', paragraph: p });
    }

    // Extract inline DrawingML drawings from paragraph chunk
    if (chunk.includes('<w:drawing')) {
      const drawingEls = safeExtractXmlElements(chunk, 'w:drawing');
      for (const dEl of drawingEls) {
        const el = parseDrawingBlockElement(dEl.raw, chartMap);
        if (el) elements.push(el);
      }
    }
  }

  return { paragraphs, tables, elements };
}
