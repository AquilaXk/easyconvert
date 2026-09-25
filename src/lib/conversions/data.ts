import Papa from 'papaparse';
import yaml from 'js-yaml';
import PDFDocument from 'pdfkit';
import { ConversionOptions, ConversionResult } from '../types';
import { generateXlsxFromData, generateOdsFromData, generateXlsXmlFromData } from './office';

export async function convertData(
  inputBuffer: Buffer,
  sourceFormat: string,
  targetFormat: string,
  options: ConversionOptions = {},
  originalFilename: string
): Promise<ConversionResult> {
  const baseName = originalFilename.replace(/\.[^/.]+$/, '');
  const src = sourceFormat.toLowerCase();
  const tgt = targetFormat.toLowerCase();
  const textContent = inputBuffer.toString('utf-8');

  // CSV, TSV, or TAB -> Target
  if (src === 'csv' || src === 'tsv' || src === 'tab') {
    const delimiter = options.delimiter || (src === 'tsv' || src === 'tab' ? '\t' : ',');
    const parsed = Papa.parse(textContent, {
      header: true,
      skipEmptyLines: true,
      delimiter,
    });

    if (parsed.errors && parsed.errors.length > 0 && parsed.data.length === 0) {
      throw new Error(`Failed to parse ${src.toUpperCase()}: ${parsed.errors[0].message}`);
    }

    if (tgt === 'json') {
      const json = JSON.stringify(parsed.data, null, 2);
      const buffer = Buffer.from(json, 'utf-8');
      return { buffer, mimeType: 'application/json', filename: `${baseName}.json`, size: buffer.length };
    }

    if (tgt === 'csv' || tgt === 'tsv') {
      const targetDelim = tgt === 'tsv' ? '\t' : ',';
      const outputStr = Papa.unparse(parsed.data, { delimiter: targetDelim });
      const buffer = Buffer.from(outputStr, 'utf-8');
      return {
        buffer,
        mimeType: tgt === 'tsv' ? 'text/tab-separated-values' : 'text/csv',
        filename: `${baseName}.${tgt}`,
        size: buffer.length,
      };
    }

    if (tgt === 'pdf') {
      const pdfBuffer = await renderDataToPdf(parsed.data as Record<string, unknown>[], baseName, options);
      return { buffer: pdfBuffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: pdfBuffer.length };
    }

    if (tgt === 'xlsx') {
      const xlsxBuffer = await generateXlsxFromData(inputBuffer, src, options, baseName);
      return {
        buffer: xlsxBuffer,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        filename: `${baseName}.xlsx`,
        size: xlsxBuffer.length,
      };
    }

    if (tgt === 'ods') {
      const headers = Object.keys((parsed.data[0] || {}) as Record<string, unknown>);
      const rows = [
        headers,
        ...(parsed.data as Record<string, unknown>[]).map((d) => headers.map((h) => String(d[h] ?? ''))),
      ];
      const odsBuffer = await generateOdsFromData(rows, baseName);
      return {
        buffer: odsBuffer,
        mimeType: 'application/vnd.oasis.opendocument.spreadsheet',
        filename: `${baseName}.ods`,
        size: odsBuffer.length,
      };
    }

    if (tgt === 'xls') {
      const headers = Object.keys((parsed.data[0] || {}) as Record<string, unknown>);
      const rows = [
        headers,
        ...(parsed.data as Record<string, unknown>[]).map((d) => headers.map((h) => String(d[h] ?? ''))),
      ];
      const xlsXml = generateXlsXmlFromData(rows, baseName);
      const buffer = Buffer.from(xlsXml, 'utf-8');
      return {
        buffer,
        mimeType: 'application/vnd.ms-excel',
        filename: `${baseName}.xls`,
        size: buffer.length,
      };
    }

    if (tgt === 'yaml' || tgt === 'yml') {
      const yamlStr = yaml.dump(parsed.data);
      const buffer = Buffer.from(yamlStr, 'utf-8');
      return { buffer, mimeType: 'application/x-yaml', filename: `${baseName}.yaml`, size: buffer.length };
    }

    if (tgt === 'html') {
      const html = generateTableHtml(parsed.data as Record<string, unknown>[], baseName);
      const buffer = Buffer.from(html, 'utf-8');
      return { buffer, mimeType: 'text/html', filename: `${baseName}.html`, size: buffer.length };
    }

    if (tgt === 'txt') {
      const buffer = Buffer.from(textContent, 'utf-8');
      return { buffer, mimeType: 'text/plain', filename: `${baseName}.txt`, size: buffer.length };
    }
  }

  // JSON -> Target
  if (src === 'json') {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(textContent);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Invalid JSON';
      throw new Error(`JSON parsing failed: ${msg}`);
    }

    if (tgt === 'csv' || tgt === 'tsv') {
      const targetDelim = tgt === 'tsv' ? '\t' : ',';
      const arrayData = Array.isArray(parsedJson) ? parsedJson : [parsedJson];
      const outputStr = Papa.unparse(arrayData, { delimiter: targetDelim });
      const buffer = Buffer.from(outputStr, 'utf-8');
      return {
        buffer,
        mimeType: tgt === 'tsv' ? 'text/tab-separated-values' : 'text/csv',
        filename: `${baseName}.${tgt}`,
        size: buffer.length,
      };
    }

    if (tgt === 'yaml' || tgt === 'yml') {
      const yamlStr = yaml.dump(parsedJson);
      const buffer = Buffer.from(yamlStr, 'utf-8');
      return { buffer, mimeType: 'application/x-yaml', filename: `${baseName}.yaml`, size: buffer.length };
    }

    if (tgt === 'pdf') {
      const arrayData = Array.isArray(parsedJson) ? parsedJson : [parsedJson];
      const pdfBuffer = await renderDataToPdf(arrayData as Record<string, unknown>[], baseName, options);
      return { buffer: pdfBuffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: pdfBuffer.length };
    }

    if (tgt === 'xlsx') {
      const xlsxBuffer = await generateXlsxFromData(inputBuffer, 'json', options, baseName);
      return {
        buffer: xlsxBuffer,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        filename: `${baseName}.xlsx`,
        size: xlsxBuffer.length,
      };
    }

    if (tgt === 'ods') {
      const arrayData = Array.isArray(parsedJson) ? parsedJson : [parsedJson];
      const headers = Object.keys((arrayData[0] || {}) as Record<string, unknown>);
      const rows = [
        headers,
        ...(arrayData as Record<string, unknown>[]).map((d) => headers.map((h) => String(d[h] ?? ''))),
      ];
      const odsBuffer = await generateOdsFromData(rows, baseName);
      return {
        buffer: odsBuffer,
        mimeType: 'application/vnd.oasis.opendocument.spreadsheet',
        filename: `${baseName}.ods`,
        size: odsBuffer.length,
      };
    }

    if (tgt === 'xls') {
      const arrayData = Array.isArray(parsedJson) ? parsedJson : [parsedJson];
      const headers = Object.keys((arrayData[0] || {}) as Record<string, unknown>);
      const rows = [
        headers,
        ...(arrayData as Record<string, unknown>[]).map((d) => headers.map((h) => String(d[h] ?? ''))),
      ];
      const xlsXml = generateXlsXmlFromData(rows, baseName);
      const buffer = Buffer.from(xlsXml, 'utf-8');
      return {
        buffer,
        mimeType: 'application/vnd.ms-excel',
        filename: `${baseName}.xls`,
        size: buffer.length,
      };
    }

    if (tgt === 'xml') {
      const xmlStr = jsonToXml(parsedJson, 'root');
      const buffer = Buffer.from(xmlStr, 'utf-8');
      return { buffer, mimeType: 'application/xml', filename: `${baseName}.xml`, size: buffer.length };
    }

    if (tgt === 'html') {
      const arrayData = Array.isArray(parsedJson)
        ? (parsedJson as Record<string, unknown>[])
        : [parsedJson as Record<string, unknown>];
      const html = generateTableHtml(arrayData, baseName);
      const buffer = Buffer.from(html, 'utf-8');
      return { buffer, mimeType: 'text/html', filename: `${baseName}.html`, size: buffer.length };
    }

    if (tgt === 'txt') {
      const buffer = Buffer.from(JSON.stringify(parsedJson, null, 2), 'utf-8');
      return { buffer, mimeType: 'text/plain', filename: `${baseName}.txt`, size: buffer.length };
    }
  }

  // YAML -> Target
  if (src === 'yaml' || src === 'yml') {
    let parsedYaml: unknown;
    try {
      parsedYaml = yaml.load(textContent);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Invalid YAML';
      throw new Error(`YAML parsing failed: ${msg}`);
    }

    if (tgt === 'json') {
      const json = JSON.stringify(parsedYaml, null, 2);
      const buffer = Buffer.from(json, 'utf-8');
      return { buffer, mimeType: 'application/json', filename: `${baseName}.json`, size: buffer.length };
    }

    if (tgt === 'txt') {
      const buffer = Buffer.from(textContent, 'utf-8');
      return { buffer, mimeType: 'text/plain', filename: `${baseName}.txt`, size: buffer.length };
    }
  }

  // XML -> Target
  if (src === 'xml') {
    const parsed = simpleXmlToJson(textContent);
    const output =
      parsed.root && typeof parsed.root === 'object' && Object.keys(parsed).length === 1
        ? parsed.root
        : parsed;

    if (tgt === 'json') {
      const json = JSON.stringify(output, null, 2);
      const buffer = Buffer.from(json, 'utf-8');
      return { buffer, mimeType: 'application/json', filename: `${baseName}.json`, size: buffer.length };
    }

    if (tgt === 'yaml' || tgt === 'yml') {
      const yamlStr = yaml.dump(output);
      const buffer = Buffer.from(yamlStr, 'utf-8');
      return { buffer, mimeType: 'application/x-yaml', filename: `${baseName}.yaml`, size: buffer.length };
    }

    if (tgt === 'csv' || tgt === 'tsv') {
      const records = extractTabularRecordsFromXml(output);
      const targetDelim = tgt === 'tsv' ? '\t' : ',';
      const outputStr = Papa.unparse(records, { delimiter: targetDelim });
      const buffer = Buffer.from(outputStr, 'utf-8');
      return {
        buffer,
        mimeType: tgt === 'tsv' ? 'text/tab-separated-values' : 'text/csv',
        filename: `${baseName}.${tgt}`,
        size: buffer.length,
      };
    }

    if (tgt === 'txt') {
      // Clean XML to plain text
      const clean = textContent
        .replace(/<[^>]+>/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
      const buffer = Buffer.from(clean || textContent, 'utf-8');
      return { buffer, mimeType: 'text/plain', filename: `${baseName}.txt`, size: buffer.length };
    }
  }

  // NDJSON or JSONL -> Target
  if (src === 'ndjson' || src === 'jsonl') {
    const lines = textContent
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const parsedData: Record<string, unknown>[] = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        parsedData.push(typeof obj === 'object' && obj !== null ? obj : { value: obj });
      } catch {
        // skip malformed lines
      }
    }
    if (parsedData.length === 0) {
      throw new Error(`Failed to parse ${src.toUpperCase()}: no valid JSON records found.`);
    }

    if (tgt === 'json') {
      const json = JSON.stringify(parsedData, null, 2);
      const buffer = Buffer.from(json, 'utf-8');
      return { buffer, mimeType: 'application/json', filename: `${baseName}.json`, size: buffer.length };
    }

    if (tgt === 'csv' || tgt === 'tsv') {
      const targetDelim = tgt === 'tsv' ? '\t' : ',';
      const outputStr = Papa.unparse(parsedData, { delimiter: targetDelim });
      const buffer = Buffer.from(outputStr, 'utf-8');
      return {
        buffer,
        mimeType: tgt === 'tsv' ? 'text/tab-separated-values' : 'text/csv',
        filename: `${baseName}.${tgt}`,
        size: buffer.length,
      };
    }

    if (tgt === 'yaml' || tgt === 'yml') {
      const yamlStr = yaml.dump(parsedData);
      const buffer = Buffer.from(yamlStr, 'utf-8');
      return { buffer, mimeType: 'application/x-yaml', filename: `${baseName}.yaml`, size: buffer.length };
    }

    if (tgt === 'pdf') {
      const pdfBuffer = await renderDataToPdf(parsedData, baseName, options);
      return { buffer: pdfBuffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: pdfBuffer.length };
    }

    if (tgt === 'xlsx') {
      const headers = Object.keys(parsedData[0] || {});
      const rows = [headers, ...parsedData.map((d) => headers.map((h) => String(d[h] ?? '')))];
      const csv = rows.map((r) => r.map((c) => (c.includes(',') ? `"${c}"` : c)).join(',')).join('\n');
      const xlsxBuffer = await generateXlsxFromData(Buffer.from(csv, 'utf-8'), 'csv', options, baseName);
      return {
        buffer: xlsxBuffer,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        filename: `${baseName}.xlsx`,
        size: xlsxBuffer.length,
      };
    }

    if (tgt === 'ods') {
      const headers = Object.keys(parsedData[0] || {});
      const rows = [headers, ...parsedData.map((d) => headers.map((h) => String(d[h] ?? '')))];
      const odsBuffer = await generateOdsFromData(rows, baseName);
      return {
        buffer: odsBuffer,
        mimeType: 'application/vnd.oasis.opendocument.spreadsheet',
        filename: `${baseName}.ods`,
        size: odsBuffer.length,
      };
    }

    if (tgt === 'xls') {
      const headers = Object.keys(parsedData[0] || {});
      const rows = [headers, ...parsedData.map((d) => headers.map((h) => String(d[h] ?? '')))];
      const xlsXml = generateXlsXmlFromData(rows, baseName);
      const buffer = Buffer.from(xlsXml, 'utf-8');
      return { buffer, mimeType: 'application/vnd.ms-excel', filename: `${baseName}.xls`, size: buffer.length };
    }

    if (tgt === 'txt') {
      const buffer = Buffer.from(JSON.stringify(parsedData, null, 2), 'utf-8');
      return { buffer, mimeType: 'text/plain', filename: `${baseName}.txt`, size: buffer.length };
    }
  }

  throw new Error(`Unsupported data conversion from ${sourceFormat} to ${targetFormat}`);
}

function generateTableHtml(data: Record<string, unknown>[], title: string): string {
  if (!Array.isArray(data) || data.length === 0) {
    return `<!DOCTYPE html><html><body><p>Empty dataset</p></body></html>`;
  }

  const headers = Object.keys(data[0] || {});
  const headerHtml = headers
    .map(
      (h) =>
        `<th style="padding: 10px; border: 1px solid #CCD2FC; background: #F0F2FE; color: #1F2340;">${escapeHtml(
          h
        )}</th>`
    )
    .join('');
  const rowsHtml = data
    .map(
      (row) =>
        `<tr>${headers
          .map(
            (h) =>
              `<td style="padding: 8px 10px; border: 1px solid #E1E4EE; color: #4D536B;">${escapeHtml(
                String(row[h] ?? '')
              )}</td>`
          )
          .join('')}</tr>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 2rem; color: #1F2340; }
    h1 { color: #5C6BC0; }
    table { border-collapse: collapse; width: 100%; max-width: 1000px; margin-top: 1rem; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <table>
    <thead><tr>${headerHtml}</tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function jsonToXml(obj: unknown, rootName = 'root'): string {
  function toXml(val: unknown, tag: string): string {
    if (val === null || val === undefined) return `<${tag}/>`;
    if (typeof val !== 'object') {
      return `<${tag}>${escapeHtml(String(val))}</${tag}>`;
    }
    if (Array.isArray(val)) {
      return val.map((item) => toXml(item, 'item')).join('');
    }
    const children = Object.entries(val as Record<string, unknown>)
      .map(([k, v]) => toXml(v, k.replace(/[^a-zA-Z0-9_-]/g, '_')))
      .join('');
    return `<${tag}>${children}</${tag}>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n${toXml(obj, rootName)}`;
}

function simpleXmlToJson(xml: string): Record<string, unknown> {
  const cleanXml = xml.replace(/<\?xml.*?\?>/gi, '').trim();
  const result: Record<string, unknown> = {};
  const tagRegex = /<([a-zA-Z0-9_-]+)[^>]*>(.*?)<\/\1>/gs;
  let match;
  while ((match = tagRegex.exec(cleanXml)) !== null) {
    const [, tag, content] = match;
    const val =
      content.includes('<') && /<[a-zA-Z0-9_-]+/.test(content)
        ? simpleXmlToJson(content)
        : content.trim();

    if (result[tag] !== undefined) {
      if (Array.isArray(result[tag])) {
        (result[tag] as unknown[]).push(val);
      } else {
        result[tag] = [result[tag], val];
      }
    } else {
      result[tag] = val;
    }
  }
  return Object.keys(result).length > 0 ? result : { text: cleanXml.replace(/<[^>]+>/g, '').trim() };
}

/**
 * Renders structured tabular dataset into a formatted PDF document with lavender palette
 */
async function renderDataToPdf(
  data: Record<string, unknown>[],
  title: string,
  options: ConversionOptions
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margin: 30,
    });

    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', (err) => reject(err));

    // Title header
    doc.fillColor('#5C6BC0').fontSize(16).text(title, 30, 30);
    doc.fillColor('#8E95AF').fontSize(9).text(`Structured Data Export • ${new Date().toLocaleDateString()}`, 30, 50);

    if (!Array.isArray(data) || data.length === 0) {
      doc.fillColor('#4D536B').fontSize(11).text('No records found in dataset.', 30, 80);
      doc.end();
      return;
    }

    const headers = Object.keys(data[0] || {}).slice(0, 10);
    if (headers.length === 0) {
      doc.end();
      return;
    }

    const startX = 30;
    const startY = 75;
    const pageWidth = doc.page.width - 60;
    const colWidth = Math.floor(pageWidth / headers.length);
    const rowHeight = 22;

    let currY = startY;

    // Header Background
    doc.rect(startX, currY, pageWidth, rowHeight).fill('#F0F2FE');
    doc.rect(startX, currY, pageWidth, rowHeight).strokeColor('#CCD2FC').lineWidth(1).stroke();

    headers.forEach((h, idx) => {
      doc.fillColor('#1F2340').fontSize(10).font('Helvetica-Bold');
      doc.text(h, startX + idx * colWidth + 6, currY + 6, {
        width: colWidth - 12,
        ellipsis: true,
      });
    });

    currY += rowHeight;

    // Data rows
    doc.font('Helvetica');
    data.slice(0, 200).forEach((row, rIdx) => {
      if (currY + rowHeight > doc.page.height - 40) {
        doc.addPage({ size: 'A4', layout: 'landscape', margin: 30 });
        currY = 30;
      }

      if (rIdx % 2 === 1) {
        doc.rect(startX, currY, pageWidth, rowHeight).fill('#FAFAFE');
      }
      doc.rect(startX, currY, pageWidth, rowHeight).strokeColor('#E1E4EE').lineWidth(0.5).stroke();

      headers.forEach((h, idx) => {
        const val = String(row[h] ?? '');
        doc.fillColor('#4D536B').fontSize(9);
        doc.text(val, startX + idx * colWidth + 6, currY + 6, {
          width: colWidth - 12,
          ellipsis: true,
        });
      });

      currY += rowHeight;
    });

    doc.end();
  });
}

function extractTabularRecordsFromXml(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
  if (!parsed || typeof parsed !== 'object') return [{ value: parsed }];

  const obj = parsed as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object') {
      return val as Record<string, unknown>[];
    }
    if (val && typeof val === 'object') {
      const childObj = val as Record<string, unknown>;
      for (const innerKey of Object.keys(childObj)) {
        const innerVal = childObj[innerKey];
        if (Array.isArray(innerVal) && innerVal.length > 0) {
          return innerVal as Record<string, unknown>[];
        }
      }
      return [childObj];
    }
  }
  return [obj];
}
