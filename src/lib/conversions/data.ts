import Papa from 'papaparse';
import yaml from 'js-yaml';
import { ConversionOptions, ConversionResult } from '../types';

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

  // CSV or TSV -> Target
  if (src === 'csv' || src === 'tsv') {
    const delimiter = options.delimiter || (src === 'tsv' ? '\t' : ',');
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

    if (tgt === 'xml') {
      const xmlStr = jsonToXml(parsedJson, 'root');
      const buffer = Buffer.from(xmlStr, 'utf-8');
      return { buffer, mimeType: 'application/xml', filename: `${baseName}.xml`, size: buffer.length };
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

  // XML -> JSON
  if (src === 'xml') {
    if (tgt === 'json') {
      const parsed = simpleXmlToJson(textContent);
      const json = JSON.stringify(parsed, null, 2);
      const buffer = Buffer.from(json, 'utf-8');
      return { buffer, mimeType: 'application/json', filename: `${baseName}.json`, size: buffer.length };
    }
  }

  throw new Error(`Unsupported data conversion from ${sourceFormat} to ${targetFormat}`);
}

function generateTableHtml(data: Record<string, unknown>[], title: string): string {
  if (!Array.isArray(data) || data.length === 0) {
    return `<!DOCTYPE html><html><body><p>Empty dataset</p></body></html>`;
  }

  const headers = Object.keys(data[0] || {});
  const headerHtml = headers.map((h) => `<th style="padding: 10px; border: 1px solid #CCD2FC; background: #F0F2FE; color: #1F2340;">${escapeHtml(h)}</th>`).join('');
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
  const result: Record<string, unknown> = {};
  const tagRegex = /<([a-zA-Z0-9_-]+)>(.*?)<\/\1>/gs;
  let match;
  while ((match = tagRegex.exec(xml)) !== null) {
    const [, tag, content] = match;
    if (content.includes('<')) {
      result[tag] = simpleXmlToJson(content);
    } else {
      result[tag] = content.trim();
    }
  }
  return Object.keys(result).length > 0 ? result : { text: xml.replace(/<[^>]+>/g, '').trim() };
}
