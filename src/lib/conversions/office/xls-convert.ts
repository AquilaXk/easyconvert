import { ConversionFailedError, ConversionOptions, ConversionResult } from '../../types';
import { isCfbfContainer } from '../cfbf-reader';
import { safeExtractXmlElements } from '../safe-xml-scanner';
import { writeXlsx } from '../xlsx-writer';
import { unconvertibleOfficeTarget } from '../native-engine-pairs';
import { BIFF_BOF_RECORDS, type BiffWorksheet, GRID_LIMIT, JSON_ROWS_LAYOUT, PDF_TEXT_LIMIT, type XlsSheet, assertCellsOrCompleteWorkbook, compactWorksheetForPdf, delimitedLayout, denseXlsSheet, encodeXlsSheetText, mergedSheetOf, namedSheetsOf, readBiff8Worksheets, readCfbfWorkbookSheets } from './xls-parse';
import { safeExtractAllText } from './xml-helpers';
import { type OfficeWorksheet } from './types';
import { generatePdfFromWorksheets } from './xlsx-convert';
import { generateOdsFromData } from './odf-writers';
import { generatePdfFromDocx } from './docx-pdf';
import { escapeMarkupAttribute } from '../../text/escape';

/**
 * Excel XLS Parser & Converter
 */
export async function convertXlsSource(
  inputBuffer: Buffer,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  let sheet: XlsSheet;
  /** The worksheets of a BIFF workbook, kept apart for the PDF target. */
  let worksheets: readonly BiffWorksheet[] | undefined;

  // 1. CFBF Compound File Binary Format containing Workbook stream
  if (isCfbfContainer(inputBuffer)) {
    worksheets = readCfbfWorkbookSheets(inputBuffer);
    sheet = mergedSheetOf(worksheets);
  }
  // 2. Raw BIFF stream (without CFBF container)
  else if (
    inputBuffer.length >= 4 &&
    BIFF_BOF_RECORDS.has(inputBuffer.readUInt16LE(0))
  ) {
    worksheets = readBiff8Worksheets(inputBuffer);
    assertCellsOrCompleteWorkbook(inputBuffer, worksheets);
    sheet = mergedSheetOf(worksheets);
  }
  // 3. XML Spreadsheet 2003 (<Row><Cell><Data ...>)
  else {
    const rows: string[][] = [];
    const text = inputBuffer.toString('utf-8');
    if (text.includes('<Row') || text.includes('<row')) {
      const rowElements = safeExtractXmlElements(text, ['Row', 'row']);
      for (const rEl of rowElements) {
        const rowXml = rEl.content;
        const cells: string[] = [];
        for (const cEl of safeExtractXmlElements(rowXml, ['Data', 'data'])) {
          cells.push(safeExtractAllText(cEl.content).trim());
        }
        if (cells.length > 0) rows.push(cells);
      }
    }

    if (rows.length === 0) {
      // Delimited text fallback only if printable
      const isPrintable = /^[\x20-\x7E\r\n\t]+$/.test(text.slice(0, 1024));
      if (isPrintable) {
        text.split(/\r?\n/).forEach((l) => {
          const trimmed = l.trim();
          if (trimmed) rows.push(trimmed.split('\t'));
        });
      }
    }
    sheet = denseXlsSheet(rows);
    if (sheet.rowCount === 0) {
      throw new ConversionFailedError('Failed to parse XLS spreadsheet: invalid or empty content');
    }
  }

  if (tgt === 'csv') {
    const buffer = encodeXlsSheetText(sheet, delimitedLayout(options.delimiter || ','), tgt);
    return { buffer, mimeType: 'text/csv', filename: `${baseName}.csv`, size: buffer.length };
  }

  if (tgt === 'json') {
    const buffer = encodeXlsSheetText(sheet, JSON_ROWS_LAYOUT, tgt);
    return { buffer, mimeType: 'application/json', filename: `${baseName}.json`, size: buffer.length };
  }

  if (tgt === 'tsv') {
    const buffer = encodeXlsSheetText(sheet, delimitedLayout('\t'), tgt);
    return { buffer, mimeType: 'text/tab-separated-values', filename: `${baseName}.tsv`, size: buffer.length };
  }

  if (tgt === 'pdf' && worksheets !== undefined) {
    const sheets: OfficeWorksheet[] = namedSheetsOf(worksheets)
      .filter(({ sheet: worksheet }) => worksheet.rowCount > 0)
      .map(({ name, sheet: worksheet, columnWidths }) => compactWorksheetForPdf(name, worksheet.toRows(PDF_TEXT_LIMIT), columnWidths));
    const pdfBuffer = await generatePdfFromWorksheets(sheets, options, baseName);
    return { buffer: pdfBuffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: pdfBuffer.length };
  }

  // The remaining targets build documents from the whole grid.
  const rows = sheet.toRows(tgt === 'pdf' ? PDF_TEXT_LIMIT : GRID_LIMIT);

  if (tgt === 'xlsx') {
    const xlsxBuffer = await writeXlsx(rows, 'detect');
    return {
      buffer: xlsxBuffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename: `${baseName}.xlsx`,
      size: xlsxBuffer.length,
    };
  }

  if (tgt === 'ods') {
    const odsBuffer = await generateOdsFromData(rows, baseName);
    return {
      buffer: odsBuffer,
      mimeType: 'application/vnd.oasis.opendocument.spreadsheet',
      filename: `${baseName}.ods`,
      size: odsBuffer.length,
    };
  }

  if (tgt === 'pdf') {
    const pdfBuffer = await generatePdfFromDocx([], [{ rows }], options, baseName);
    return { buffer: pdfBuffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: pdfBuffer.length };
  }

  if (tgt === 'html') {
    let tableHtml = '<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%;border-color:#CCD2FC;">\n';
    rows.forEach((r, idx) => {
      tableHtml += '<tr>\n';
      r.forEach((c) => {
        tableHtml +=
          idx === 0
            ? `  <th style="background:#F0F2FE;color:#1F2340;padding:8px;text-align:left;">${escapeMarkupAttribute(c)}</th>\n`
            : `  <td style="padding:8px;border:1px solid #E1E4EE;">${escapeMarkupAttribute(c)}</td>\n`;
      });
      tableHtml += '</tr>\n';
    });
    tableHtml += '</table>';
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeMarkupAttribute(
      baseName
    )}</title><style>body{font-family:system-ui,sans-serif;padding:2rem;color:#1F2340;}</style></head><body><h2>${escapeMarkupAttribute(
      baseName
    )}</h2>${tableHtml}</body></html>`;
    const buffer = Buffer.from(html, 'utf-8');
    return { buffer, mimeType: 'text/html', filename: `${baseName}.html`, size: buffer.length };
  }

  throw unconvertibleOfficeTarget('xls', tgt);
}
