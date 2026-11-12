import { ConversionFailedError, ConversionOptions, ConversionResult, EngineUnavailableError } from '../../types';
import { openPackage } from '../package-access';
import { InflateBudget } from '../bounded-inflate';
import { readZipEntryText } from '../zip-entry-reader';
import { assertWellFormedXml } from '../xml-wellformed';
import { safeExtractXmlElements } from '../safe-xml-scanner';
import { writeXlsx } from '../xlsx-writer';
import { unconvertibleOfficeTarget } from '../native-engine-pairs';
import { safeExtractAllText, safeExtractFirstXmlElement } from './xml-helpers';
import { formatCsvCell } from './spreadsheet-ranges';
import { escapeMarkupAttribute } from '../../text/escape';
import { generatePdfFromDocx } from './docx-pdf';
import { readOdtText } from './odt-text';
import { generateDocxFromExtractedText, generateEpubFromText } from './office-from-text';
import { MAX_MIMETYPE_ENTRY_BYTES } from './text-constants';

/**
 * OpenDocument Spreadsheet (ODS) Parser & Converter
 */
export async function convertOdsSource(
  inputBuffer: Buffer,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  const zip = await openPackage(inputBuffer, 'ODS');
  const budget = new InflateBudget();
  const contentXml = zip.file('content.xml');
  if (!contentXml) {
    throw new ConversionFailedError('Invalid ODS workbook: content.xml not found.');
  }

  const xml = await readZipEntryText(contentXml, { budget });
  assertWellFormedXml('content.xml', xml, 'ODS');
  const rows: string[][] = [];
  const rowElements = safeExtractXmlElements(xml, 'table:table-row');
  for (const rEl of rowElements) {
    const rowXml = rEl.content;
    const cells: string[] = [];
    const cellElements = safeExtractXmlElements(rowXml, 'table:table-cell');
    for (const cEl of cellElements) {
      const pEl = safeExtractFirstXmlElement(cEl.content, 'text:p');
      const text = pEl ? safeExtractAllText(pEl.content).trim() : '';

      const repeatVal = cEl.attrs['table:number-columns-repeated'];
      const repeat = repeatVal ? Math.min(50, parseInt(repeatVal, 10)) : 1;
      for (let rep = 0; rep < repeat; rep++) {
        cells.push(text);
      }
    }

    while (cells.length > 0 && cells[cells.length - 1] === '') {
      cells.pop();
    }
    if (cells.length > 0) {
      rows.push(cells);
    }
  }

  if (rows.length === 0) {
    rows.push(['Data'], ['Empty ODS content']);
  }

  // ODS -> CSV
  if (tgt === 'csv') {
    const delim = options.delimiter || ',';
    const lineEnding = options.lineEnding === 'crlf' ? '\r\n' : '\n';
    const csv = rows
      .map((r) => r.map((c) => formatCsvCell(c, delim)).join(delim))
      .join(lineEnding);
    const buffer = Buffer.from(csv, 'utf-8');
    return { buffer, mimeType: 'text/csv', filename: `${baseName}.csv`, size: buffer.length };
  }

  // ODS -> TSV
  if (tgt === 'tsv') {
    const lineEnding = options.lineEnding === 'crlf' ? '\r\n' : '\n';
    const tsv = rows.map((r) => r.map((c) => formatCsvCell(c, '\t')).join('\t')).join(lineEnding);
    const buffer = Buffer.from(tsv, 'utf-8');
    return { buffer, mimeType: 'text/tab-separated-values', filename: `${baseName}.tsv`, size: buffer.length };
  }

  // ODS -> JSON
  if (tgt === 'json') {
    let jsonArray: Record<string, string>[] = [];
    if (rows.length > 1) {
      const headers = rows[0];
      jsonArray = rows.slice(1).map((row) => {
        const obj: Record<string, string> = {};
        headers.forEach((h, i) => {
          obj[h || `col_${i + 1}`] = row[i] || '';
        });
        return obj;
      });
    }
    const buffer = Buffer.from(JSON.stringify(jsonArray.length > 0 ? jsonArray : rows, null, 2), 'utf-8');
    return { buffer, mimeType: 'application/json', filename: `${baseName}.json`, size: buffer.length };
  }

  // ODS -> XLSX
  if (tgt === 'xlsx') {
    const xlsxBuffer = await writeXlsx(rows, 'detect');
    return {
      buffer: xlsxBuffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename: `${baseName}.xlsx`,
      size: xlsxBuffer.length,
    };
  }

  // ODS -> HTML
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

  // ODS -> PDF
  if (tgt === 'pdf') {
    const pdfBuffer = await generatePdfFromDocx([], [{ rows }], options, baseName);
    return { buffer: pdfBuffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: pdfBuffer.length };
  }

  // ODS -> ODS (echo)
  if (tgt === 'ods') {
    return {
      buffer: inputBuffer,
      mimeType: 'application/vnd.oasis.opendocument.spreadsheet',
      filename: `${baseName}.ods`,
      size: inputBuffer.length,
    };
  }

  throw unconvertibleOfficeTarget('ods', tgt);
}

/**
 * OpenDocument Text (ODT) Parser & Converter
 */
export async function convertOdtSource(
  inputBuffer: Buffer,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  const text = await readOdtText(inputBuffer);

  if (tgt === 'txt') {
    const buffer = Buffer.from(text, 'utf-8');
    return { buffer, mimeType: 'text/plain', filename: `${baseName}.txt`, size: buffer.length };
  }

  if (tgt === 'html') {
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeMarkupAttribute(
      baseName
    )}</title><style>body{font-family:system-ui,sans-serif;padding:2rem;color:#1F2340;}</style></head><body><h1>${escapeMarkupAttribute(
      baseName
    )}</h1>${text.split('\n\n').map((p) => `<p>${escapeMarkupAttribute(p)}</p>`).join('\n')}</body></html>`;
    const buffer = Buffer.from(html, 'utf-8');
    return { buffer, mimeType: 'text/html', filename: `${baseName}.html`, size: buffer.length };
  }

  if (tgt === 'md') {
    const buffer = Buffer.from(`# ${baseName}\n\n` + text, 'utf-8');
    return { buffer, mimeType: 'text/markdown', filename: `${baseName}.md`, size: buffer.length };
  }

  if (tgt === 'pdf') {
    const pdfBuffer = await generatePdfFromDocx([{ text, isHeading: false, isBold: false, isItalic: false }], [], options, baseName);
    return { buffer: pdfBuffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: pdfBuffer.length };
  }

  if (tgt === 'docx') {
    const docxBuffer = await generateDocxFromExtractedText(text, 'odt', options, baseName);
    return {
      buffer: docxBuffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      filename: `${baseName}.docx`,
      size: docxBuffer.length,
    };
  }

  if (tgt === 'epub') {
    const epubBuffer = await generateEpubFromText(text, 'odt', options, baseName);
    return {
      buffer: epubBuffer,
      mimeType: 'application/epub+zip',
      filename: `${baseName}.epub`,
      size: epubBuffer.length,
    };
  }

  if (tgt === 'odt') {
    return { buffer: inputBuffer, mimeType: 'application/vnd.oasis.opendocument.text', filename: `${baseName}.odt`, size: inputBuffer.length };
  }

  throw unconvertibleOfficeTarget('odt', tgt);
}

const ODF_GRAPHICS_MIMETYPE_PREFIX = 'application/vnd.oasis.opendocument.graphics';

/**
 * OpenDocument Drawing (ODG) and drawing template (ODD) source. A drawing has no text target, and the
 * in-process engine has no vector renderer: LibreOffice Draw renders every advertised target, so this
 * validates the package (a malformed file is a typed 400 error) and then reports the missing engine
 * with a typed 503 error. It never answers with the drawing's text under another format's name.
 */
export async function assertOpenDocumentGraphic(inputBuffer: Buffer, src: string): Promise<void> {
  const zip = await openPackage(inputBuffer, src.toUpperCase(), 'OpenDocument package');
  const budget = new InflateBudget();
  const mimetypeEntry = zip.file('mimetype');
  const mimetype = mimetypeEntry ? await readZipEntryText(mimetypeEntry, { maxBytes: MAX_MIMETYPE_ENTRY_BYTES, budget }) : undefined;
  if (!mimetype?.startsWith(ODF_GRAPHICS_MIMETYPE_PREFIX) || !zip.file('content.xml')) {
    throw new ConversionFailedError(`The ${src.toUpperCase()} file is not an OpenDocument drawing.`);
  }
}

export async function convertOpenDocumentGraphicSource(inputBuffer: Buffer, src: string, tgt: string): Promise<ConversionResult> {
  await assertOpenDocumentGraphic(inputBuffer, src);
  throw new EngineUnavailableError('soffice', `Rendering a drawing to ${tgt} requires LibreOffice Draw; the in-process engine has no drawing renderer.`);
}
