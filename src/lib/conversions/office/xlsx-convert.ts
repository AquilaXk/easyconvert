import { ConversionOptions, ConversionResult, InvalidSheetIndexError } from '../../types';
import { renderPdfTables } from '../pdf-table-layout';
import { openOpcPackage } from '../package-access';
import JSZip from 'jszip';
import { unconvertibleOfficeTarget } from '../native-engine-pairs';
import { type WorkbookCompression, writeXlsx, writeXlsxWorkbook } from '../xlsx-writer';
import { readPdfSheets } from '../pdf-sheets';
import { parseJsonTableCells } from '../sheet-text-tables';
import { type OfficeWorksheet } from './types';
import { renderPdfChart } from './pdf-chart';
import { parseAllXlsxWorksheets } from './xlsx-parse';
import { formatCsvCell, sanitizeSheetName, sliceWorksheetToRange } from './spreadsheet-ranges';
import { escapeMarkupAttribute, escapeXmlQuoted } from '../../text/escape';
import { generateOdsFromData } from './odf-writers';
import { extractRowsForOffice } from './sheet-extract';

/** Columns above which a worksheet is drawn on a landscape page. */
const WORKSHEET_LANDSCAPE_COLUMNS = 6;

/**
 * Draws worksheets as tables: the workbook title goes into the PDF metadata, each sheet name becomes an
 * outline entry, and every row and column is drawn (see renderPdfTables).
 */
export async function generatePdfFromWorksheets(
  sheets: OfficeWorksheet[],
  options: ConversionOptions,
  title: string
): Promise<Buffer> {
  let widestRow = 1;
  for (const sheet of sheets) {
    for (const row of sheet.rows) widestRow = Math.max(widestRow, row.length);
  }
  const isLandscape = options.orientation === 'landscape' || widestRow > WORKSHEET_LANDSCAPE_COLUMNS;
  return renderPdfTables(
    sheets.map((sheet) => ({
      name: sheet.name,
      headerRows: 1,
      widthHints: sheet.columnWidths,
      afterTable: sheet.charts?.length ? (doc: PDFKit.PDFDocument) => sheet.charts?.forEach((chart) => renderPdfChart(doc, chart, true)) : undefined,
      rows: sheet.rows.map((row, r) => {
        const structured = sheet.structuredRows?.[r] ?? [];
        return Array.from({ length: Math.max(row.length, structured.length) }, (_, c) => {
          const cell = structured[c];
          return {
            text: cell?.value ?? row[c] ?? '',
            fill: cell?.fillColor,
            fontColor: cell?.fontColor,
            align: cell?.align,
            borderColor: cell?.borderColor,
          };
        });
      }),
    })),
    { title, orientation: isLandscape ? 'landscape' : 'portrait' }
  );
}

/**
 * XLSX Source Parser & Converter supporting Multi-sheet workbooks and NumberFormat engine
 */
export async function convertXlsxSource(
  inputBuffer: Buffer,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  const zip = await openOpcPackage(inputBuffer, 'XLSX');
  const rawSheets = await parseAllXlsxWorksheets(zip);

  // 1. Slicing by print area if range: 'printArea'
  const allSheets = options.range === 'printArea'
    ? rawSheets.map((s) => (s.printArea ? sliceWorksheetToRange(s, s.printArea) : s))
    : rawSheets;

  const sheetMode = options.sheetMode || 'merged';
  const delimiter = options.delimiter || (tgt === 'tsv' ? '\t' : ',');
  const lineEnding = options.lineEnding === 'crlf' ? '\r\n' : '\n';

  // 2. Handle sheetMode: 'index'
  if (sheetMode === 'index') {
    const targetIdx = options.sheetIndex ?? 0;
    if (targetIdx < 0 || targetIdx >= allSheets.length) {
      throw new InvalidSheetIndexError(
        `Invalid sheetIndex ${targetIdx}: workbook has ${allSheets.length} worksheet(s)`
      );
    }
    const selectedSheet = allSheets[targetIdx];
    const targetRows = selectedSheet.rows;

    if (tgt === 'csv' || tgt === 'tsv') {
      const csvContent = targetRows
        .map((r) => r.map((c) => formatCsvCell(c, delimiter)).join(delimiter))
        .join(lineEnding);
      const buffer = Buffer.from(csvContent, 'utf-8');
      const mimeType = tgt === 'csv' ? 'text/csv' : 'text/tab-separated-values';
      return { buffer, mimeType, filename: `${baseName}.${tgt}`, size: buffer.length };
    }

    if (tgt === 'json') {
      let outputJson: any;
      if (targetRows.length > 1) {
        const headers = targetRows[0];
        outputJson = targetRows.slice(1).map((row) => {
          const obj: Record<string, string> = {};
          headers.forEach((h, i) => {
            obj[h || `column_${i + 1}`] = row[i] || '';
          });
          return obj;
        });
      } else {
        outputJson = targetRows;
      }
      const buffer = Buffer.from(JSON.stringify(outputJson, null, 2), 'utf-8');
      return { buffer, mimeType: 'application/json', filename: `${baseName}.json`, size: buffer.length };
    }

    if (tgt === 'html') {
      let tableHtml =
        '<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%;margin-bottom:2rem;border-color:#CCD2FC;">\n';
      targetRows.forEach((r, idx) => {
        tableHtml += '<tr>\n';
        r.forEach((c) => {
          if (idx === 0) {
            tableHtml += `  <th style="background:#F0F2FE;color:#1F2340;padding:8px;text-align:left;">${escapeMarkupAttribute(
              c
            )}</th>\n`;
          } else {
            tableHtml += `  <td style="padding:8px;border:1px solid #E1E4EE;">${escapeMarkupAttribute(c)}</td>\n`;
          }
        });
        tableHtml += '</tr>\n';
      });
      tableHtml += '</table>';
      const bodyHtml = `<h3>${escapeMarkupAttribute(selectedSheet.name)}</h3>${tableHtml}`;
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeXmlQuoted(
        baseName
      )}</title><style>body{font-family:system-ui,sans-serif;padding:2rem;color:#1F2340;}</style></head><body><h2>${escapeXmlQuoted(
        baseName
      )}</h2>${bodyHtml}</body></html>`;
      const buffer = Buffer.from(html, 'utf-8');
      return { buffer, mimeType: 'text/html', filename: `${baseName}.html`, size: buffer.length };
    }

    if (tgt === 'pdf') {
      const pdfBuffer = await generatePdfFromWorksheets([selectedSheet], options, baseName);
      return { buffer: pdfBuffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: pdfBuffer.length };
    }
  }

  // 3. Handle sheetMode: 'split'
  if (sheetMode === 'split') {
    if (tgt === 'csv' || tgt === 'tsv') {
      const outZip = new JSZip();
      for (let i = 0; i < allSheets.length; i++) {
        const s = allSheets[i];
        const content = s.rows
          .map((r) => r.map((c) => formatCsvCell(c, delimiter)).join(delimiter))
          .join(lineEnding);
        const safeName = sanitizeSheetName(s.name || `Sheet${i + 1}`);
        outZip.file(`${baseName}-${safeName}.${tgt}`, content);
      }
      const zipBuffer = await outZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      return {
        buffer: zipBuffer,
        mimeType: 'application/zip',
        filename: `${baseName}.zip`,
        size: zipBuffer.length,
      };
    }
  }

  // 4. Default sheetMode: 'merged'
  const primaryRows = allSheets.length > 0 ? allSheets[0].rows : [];

  // XLSX -> CSV
  if (tgt === 'csv') {
    let csvContent: string;
    if (allSheets.length <= 1) {
      csvContent = primaryRows
        .map((r) => r.map((c) => formatCsvCell(c, delimiter)).join(delimiter))
        .join(lineEnding);
    } else {
      csvContent = allSheets
        .map((s) => {
          const table = s.rows
            .map((r) => r.map((c) => formatCsvCell(c, delimiter)).join(delimiter))
            .join(lineEnding);
          return `### Sheet: ${s.name}\n${table}`;
        })
        .join(lineEnding + lineEnding);
    }
    const buffer = Buffer.from(csvContent, 'utf-8');
    return { buffer, mimeType: 'text/csv', filename: `${baseName}.csv`, size: buffer.length };
  }

  // XLSX -> TSV
  if (tgt === 'tsv') {
    let tsvContent: string;
    if (allSheets.length <= 1) {
      tsvContent = primaryRows.map((r) => r.map((c) => formatCsvCell(c, '\t')).join('\t')).join(lineEnding);
    } else {
      tsvContent = allSheets
        .map((s) => `### Sheet: ${s.name}\n` + s.rows.map((r) => r.map((c) => formatCsvCell(c, '\t')).join('\t')).join(lineEnding))
        .join(lineEnding + lineEnding);
    }
    const buffer = Buffer.from(tsvContent, 'utf-8');
    return {
      buffer,
      mimeType: 'text/tab-separated-values',
      filename: `${baseName}.tsv`,
      size: buffer.length,
    };
  }

  // XLSX -> JSON
  if (tgt === 'json') {
    let outputJson: any;
    if (allSheets.length <= 1) {
      if (primaryRows.length > 1) {
        const headers = primaryRows[0];
        outputJson = primaryRows.slice(1).map((row) => {
          const obj: Record<string, string> = {};
          headers.forEach((h, i) => {
            obj[h || `column_${i + 1}`] = row[i] || '';
          });
          return obj;
        });
      } else {
        outputJson = primaryRows;
      }
    } else {
      const sheetsObj: Record<string, any[]> = {};
      allSheets.forEach((s) => {
        if (s.rows.length > 1) {
          const headers = s.rows[0];
          sheetsObj[s.name] = s.rows.slice(1).map((row) => {
            const obj: Record<string, string> = {};
            headers.forEach((h, i) => {
              obj[h || `column_${i + 1}`] = row[i] || '';
            });
            return obj;
          });
        } else {
          sheetsObj[s.name] = s.rows;
        }
      });
      outputJson = sheetsObj;
    }
    const buffer = Buffer.from(JSON.stringify(outputJson, null, 2), 'utf-8');
    return { buffer, mimeType: 'application/json', filename: `${baseName}.json`, size: buffer.length };
  }

  // XLSX -> XML
  if (tgt === 'xml') {
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<workbook name="${escapeXmlQuoted(baseName)}">\n`;
    allSheets.forEach((s) => {
      xml += `  <worksheet name="${escapeXmlQuoted(s.name)}">\n    <rows>\n`;
      if (s.rows.length > 0) {
        const headers = s.rows[0].map((h, i) =>
          h ? h.replace(/[^a-zA-Z0-9_]/g, '_') : `column_${i + 1}`
        );
        s.rows.slice(1).forEach((row, rIdx) => {
          xml += `      <row id="${rIdx + 1}">\n`;
          row.forEach((cell, cIdx) => {
            const colName = headers[cIdx] || `col_${cIdx + 1}`;
            xml += `        <${colName}>${escapeXmlQuoted(cell)}</${colName}>\n`;
          });
          xml += `      </row>\n`;
        });
      }
      xml += `    </rows>\n  </worksheet>\n`;
    });
    xml += `</workbook>`;
    const buffer = Buffer.from(xml, 'utf-8');
    return { buffer, mimeType: 'application/xml', filename: `${baseName}.xml`, size: buffer.length };
  }

  // XLSX -> HTML
  if (tgt === 'html') {
    let bodyHtml = '';
    allSheets.forEach((s) => {
      let tableHtml =
        '<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%;margin-bottom:2rem;border-color:#CCD2FC;">\n';
      s.rows.forEach((r, idx) => {
        tableHtml += '<tr>\n';
        r.forEach((c) => {
          if (idx === 0) {
            tableHtml += `  <th style="background:#F0F2FE;color:#1F2340;padding:8px;text-align:left;">${escapeMarkupAttribute(
              c
            )}</th>\n`;
          } else {
            tableHtml += `  <td style="padding:8px;border:1px solid #E1E4EE;">${escapeMarkupAttribute(c)}</td>\n`;
          }
        });
        tableHtml += '</tr>\n';
      });
      tableHtml += '</table>';
      bodyHtml += `<h3>${escapeMarkupAttribute(s.name)}</h3>${tableHtml}`;
    });

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeXmlQuoted(
      baseName
    )}</title><style>body{font-family:system-ui,sans-serif;padding:2rem;color:#1F2340;}</style></head><body><h2>${escapeXmlQuoted(
      baseName
    )}</h2>${bodyHtml}</body></html>`;
    const buffer = Buffer.from(html, 'utf-8');
    return { buffer, mimeType: 'text/html', filename: `${baseName}.html`, size: buffer.length };
  }

  // XLSX -> PDF
  if (tgt === 'pdf') {
    const pdfBuffer = await generatePdfFromWorksheets(allSheets, options, baseName);
    return { buffer: pdfBuffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: pdfBuffer.length };
  }

  // XLSX -> ODS
  if (tgt === 'ods') {
    const odsBuffer = await generateOdsFromData(allSheets.length > 0 ? allSheets : primaryRows, baseName);
    return {
      buffer: odsBuffer,
      mimeType: 'application/vnd.oasis.opendocument.spreadsheet',
      filename: `${baseName}.ods`,
      size: odsBuffer.length,
    };
  }

  // XLSX -> XLSX (echo)
  if (tgt === 'xlsx') {
    return {
      buffer: inputBuffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename: `${baseName}.xlsx`,
      size: inputBuffer.length,
    };
  }

  throw unconvertibleOfficeTarget('xlsx', tgt);
}

/** The XLSX workbook of a source read as a table: JSON keeps its value types; delimited text, a Kingsoft workbook and the tables of a PDF (`readPdfSheets`) store a number or ISO date as one. */
export async function officeSheetWorkbook(inputBuffer: Buffer, src: string, options: ConversionOptions, compression?: WorkbookCompression): Promise<Buffer> {
  if (src === 'pdf') return writeXlsxWorkbook(await readPdfSheets(inputBuffer, options), 'detect', compression);
  if (src === 'json') return writeXlsx(parseJsonTableCells(inputBuffer.toString('utf-8')), 'verbatim', compression);
  return writeXlsx(await extractRowsForOffice(inputBuffer, src, options), 'detect', compression);
}
