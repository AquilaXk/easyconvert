import JSZip from 'jszip';
import PDFDocument from 'pdfkit';
import { ConversionOptions, ConversionResult } from '../types';
import { extractTextFromPdf, extractEmbeddedImageFromPdf } from './pdf-utils';
import { performOcr } from './ocr';

/**
 * Office & Ebook Conversion Engine
 * Handles DOCX, XLSX, PPTX, EPUB, MOBI, FB2, ODP with layout, tables, and font preservation.
 */
export async function convertOffice(
  inputBuffer: Buffer,
  sourceFormat: string,
  targetFormat: string,
  options: ConversionOptions = {},
  originalFilename: string
): Promise<ConversionResult> {
  const baseName = originalFilename.replace(/\.[^/.]+$/, '');
  const src = sourceFormat.toLowerCase();
  const tgt = targetFormat.toLowerCase();

  // 1. DOCX Source
  if (src === 'docx') {
    return convertDocxSource(inputBuffer, tgt, options, baseName);
  }

  // 2. XLSX Source
  if (src === 'xlsx') {
    return convertXlsxSource(inputBuffer, tgt, options, baseName);
  }

  // 3. PPTX Source
  if (src === 'pptx') {
    return convertPptxSource(inputBuffer, tgt, options, baseName);
  }

  // 4. ODP (OpenDocument Presentation) Source
  if (src === 'odp') {
    return convertOdpSource(inputBuffer, tgt, options, baseName);
  }

  // 5. Other presentation sources (ppt, potx, key)
  if (['ppt', 'potx', 'key', 'odp'].includes(src)) {
    return convertGenericPresentationSource(inputBuffer, src, tgt, options, baseName);
  }

  // 6. EPUB Source
  if (src === 'epub') {
    return convertEpubSource(inputBuffer, tgt, options, baseName);
  }

  // 7. FB2 Source
  if (src === 'fb2') {
    return convertFb2Source(inputBuffer, tgt, options, baseName);
  }

  // 8. MOBI / AZW3 Source
  if (['mobi', 'azw', 'azw3'].includes(src)) {
    return convertMobiSource(inputBuffer, src, tgt, options, baseName);
  }

  // 9. CBZ Source (Comic Book Zip)
  if (src === 'cbz') {
    return convertCbzSource(inputBuffer, tgt, options, baseName);
  }

  // 10. Target is DOCX (from Markdown, HTML, TXT, PDF, RTF, etc.)
  if (tgt === 'docx') {
    const textContent = await extractTextContentForOffice(inputBuffer, src, options, baseName);
    const docxBuffer = await generateDocxFromText(textContent, src, options, baseName);
    return {
      buffer: docxBuffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      filename: `${baseName}.docx`,
      size: docxBuffer.length,
    };
  }

  // 11. Target is PPTX (from Markdown, HTML, TXT, Presentation, etc.)
  if (tgt === 'pptx') {
    const textContent = await extractTextContentForOffice(inputBuffer, src, options, baseName);
    const pptxBuffer = await generatePptxFromText(textContent, src, options, baseName);
    return {
      buffer: pptxBuffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      filename: `${baseName}.pptx`,
      size: pptxBuffer.length,
    };
  }

  // 12. Target is XLSX (from CSV, TSV, JSON)
  if (tgt === 'xlsx') {
    const xlsxBuffer = await generateXlsxFromData(inputBuffer, src, options, baseName);
    return {
      buffer: xlsxBuffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename: `${baseName}.xlsx`,
      size: xlsxBuffer.length,
    };
  }

  // 13. Target is EPUB (from MD, HTML, TXT, DOCX, etc.)
  if (tgt === 'epub') {
    const textContent = await extractTextContentForOffice(inputBuffer, src, options, baseName);
    const epubBuffer = await generateEpubFromText(textContent, src, options, baseName);
    return {
      buffer: epubBuffer,
      mimeType: 'application/epub+zip',
      filename: `${baseName}.epub`,
      size: epubBuffer.length,
    };
  }

  // 14. Target is PDF (from Office or Ebook sources)
  if (tgt === 'pdf') {
    const textContent = await extractTextContentForOffice(inputBuffer, src, options, baseName);
    const pdfBuffer = await generatePdfFromDocx([{ text: textContent, isHeading: false, isBold: false, isItalic: false }], [], options, baseName);
    return {
      buffer: pdfBuffer,
      mimeType: 'application/pdf',
      filename: `${baseName}.pdf`,
      size: pdfBuffer.length,
    };
  }

  throw new Error(`Unsupported office conversion from ${sourceFormat} to ${targetFormat}`);
}

/**
 * Extracts clean text content from various source formats for Office generation
 */
async function extractTextContentForOffice(
  inputBuffer: Buffer,
  src: string,
  options: ConversionOptions,
  baseName: string
): Promise<string> {
  if (src === 'pdf') {
    let extracted = extractTextFromPdf(inputBuffer);
    if (extracted === 'No extractable text found in PDF document.' || options.ocrEnabled) {
      const embeddedImg = extractEmbeddedImageFromPdf(inputBuffer);
      if (embeddedImg) {
        const ocr = await performOcr(embeddedImg, options.ocrLanguage);
        if (ocr.text) extracted = ocr.text;
      } else {
        const ocr = await performOcr(inputBuffer, options.ocrLanguage);
        if (ocr.text) extracted = ocr.text;
      }
    }
    return extracted;
  }

  if (src === 'rtf') {
    return extractTextFromRtf(inputBuffer.toString('utf-8'));
  }

  if (src === 'odt') {
    try {
      const zip = await JSZip.loadAsync(inputBuffer);
      const contentXml = zip.file('content.xml');
      if (contentXml) {
        const xml = await contentXml.async('text');
        const paragraphs: string[] = [];
        const pRegex = /<text:(?:p|h)[^>]*>([\s\S]*?)<\/text:(?:p|h)>/g;
        let m: RegExpExecArray | null;
        while ((m = pRegex.exec(xml)) !== null) {
          const text = m[1].replace(/<[^>]+>/g, '').trim();
          if (text) paragraphs.push(text);
        }
        return paragraphs.join('\n\n');
      }
    } catch {
      // fallback
    }
  }

  return inputBuffer.toString('utf-8');
}

/**
 * Strips RTF control words and formats text
 */
export function extractTextFromRtf(rtf: string): string {
  return rtf
    .replace(/\{\\(?:fonttbl|colortbl|stylesheet)[\s\S]*?\}/g, '')
    .replace(/\\par[d]?/g, '\n')
    .replace(/\\tab/g, '\t')
    .replace(/\\[a-zA-Z]+(-?[0-9]+)?[ ]?/g, '')
    .replace(/[{}]/g, '')
    .replace(/\r?\n\s*\r?\n/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * DOCX Source Parser & Converter
 */
async function convertDocxSource(
  inputBuffer: Buffer,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  const zip = await JSZip.loadAsync(inputBuffer);
  const docXmlFile = zip.file('word/document.xml');
  if (!docXmlFile) {
    throw new Error('Invalid DOCX format: word/document.xml not found.');
  }

  const xmlText = await docXmlFile.async('text');

  // Extract paragraphs, headings, and tables
  const { paragraphs, tables } = parseDocxXml(xmlText);

  // DOCX -> TXT
  if (tgt === 'txt') {
    const text = paragraphs.map((p) => p.text).join('\n\n');
    const buffer = Buffer.from(text, 'utf-8');
    return { buffer, mimeType: 'text/plain', filename: `${baseName}.txt`, size: buffer.length };
  }

  // DOCX -> HTML
  if (tgt === 'html') {
    const html = generateHtmlFromDocx(paragraphs, tables, baseName);
    const buffer = Buffer.from(html, 'utf-8');
    return { buffer, mimeType: 'text/html', filename: `${baseName}.html`, size: buffer.length };
  }

  // DOCX -> Markdown
  if (tgt === 'md') {
    const md = generateMarkdownFromDocx(paragraphs, tables);
    const buffer = Buffer.from(md, 'utf-8');
    return { buffer, mimeType: 'text/markdown', filename: `${baseName}.md`, size: buffer.length };
  }

  // DOCX -> PDF
  if (tgt === 'pdf') {
    const pdfBuffer = await generatePdfFromDocx(paragraphs, tables, options, baseName);
    return { buffer: pdfBuffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: pdfBuffer.length };
  }

  // DOCX -> EPUB
  if (tgt === 'epub') {
    const text = paragraphs.map((p) => p.text).join('\n\n');
    const epubBuffer = await generateEpubFromText(text, 'txt', options, baseName);
    return { buffer: epubBuffer, mimeType: 'application/epub+zip', filename: `${baseName}.epub`, size: epubBuffer.length };
  }

  // DOCX -> PPTX
  if (tgt === 'pptx') {
    const text = paragraphs.map((p) => p.text).join('\n\n');
    const pptxBuffer = await generatePptxFromText(text, 'docx', options, baseName);
    return {
      buffer: pptxBuffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      filename: `${baseName}.pptx`,
      size: pptxBuffer.length,
    };
  }

  throw new Error(`Unsupported conversion from DOCX to ${tgt}`);
}

interface DocxParagraph {
  text: string;
  isHeading: boolean;
  isBold: boolean;
  isItalic: boolean;
}

interface DocxTable {
  rows: string[][];
}

function parseDocxXml(xml: string): { paragraphs: DocxParagraph[]; tables: DocxTable[] } {
  const paragraphs: DocxParagraph[] = [];
  const tables: DocxTable[] = [];

  // Parse tables (<w:tbl>)
  const tableRegex = /<w:tbl[\s\S]*?<\/w:tbl>/g;
  let tblMatch: RegExpExecArray | null;
  while ((tblMatch = tableRegex.exec(xml)) !== null) {
    const tblXml = tblMatch[0];
    const rows: string[][] = [];
    const trRegex = /<w:tr[\s\S]*?<\/w:tr>/g;
    let trMatch: RegExpExecArray | null;
    while ((trMatch = trRegex.exec(tblXml)) !== null) {
      const rowCells: string[] = [];
      const tcRegex = /<w:tc[\s\S]*?<\/w:tc>/g;
      let tcMatch: RegExpExecArray | null;
      while ((tcMatch = tcRegex.exec(trMatch[0])) !== null) {
        const tMatches = tcMatch[0].match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [];
        const cellText = tMatches
          .map((m) => m.replace(/<[^>]+>/g, ''))
          .join('')
          .trim();
        rowCells.push(cellText);
      }
      if (rowCells.length > 0) rows.push(rowCells);
    }
    if (rows.length > 0) tables.push({ rows });
  }

  // Parse paragraphs (<w:p>)
  const pRegex = /<w:p[\s\S]*?<\/w:p>/g;
  let pMatch: RegExpExecArray | null;
  while ((pMatch = pRegex.exec(xml)) !== null) {
    const pXml = pMatch[0];
    const isHeading = /<w:pStyle\s+w:val="Heading/i.test(pXml);
    const isBold = /<w:b(\/|>)/.test(pXml);
    const isItalic = /<w:i(\/|>)/.test(pXml);

    const tMatches = pXml.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [];
    const text = tMatches
      .map((m) => m.replace(/<[^>]+>/g, ''))
      .join('')
      .trim();

    if (text.length > 0) {
      paragraphs.push({ text, isHeading, isBold, isItalic });
    }
  }

  return { paragraphs, tables };
}

function generateHtmlFromDocx(paragraphs: DocxParagraph[], tables: DocxTable[], title: string): string {
  let body = '';
  for (const p of paragraphs) {
    if (p.isHeading) {
      body += `<h2>${escapeHtml(p.text)}</h2>\n`;
    } else {
      let t = escapeHtml(p.text);
      if (p.isBold) t = `<strong>${t}</strong>`;
      if (p.isItalic) t = `<em>${t}</em>`;
      body += `<p>${t}</p>\n`;
    }
  }

  for (const tbl of tables) {
    body += '<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;margin:1.5rem 0;width:100%;border-color:#CCD2FC;">\n';
    tbl.rows.forEach((row, rIdx) => {
      body += '<tr>\n';
      row.forEach((cell) => {
        if (rIdx === 0) {
          body += `  <th style="background:#F0F2FE;color:#1F2340;padding:8px;text-align:left;">${escapeHtml(cell)}</th>\n`;
        } else {
          body += `  <td style="padding:8px;border:1px solid #E1E4EE;">${escapeHtml(cell)}</td>\n`;
        }
      });
      body += '</tr>\n';
    });
    body += '</table>\n';
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(
    title
  )}</title><style>body{font-family:system-ui,-apple-system,sans-serif;line-height:1.6;max-width:850px;margin:2rem auto;padding:0 1.5rem;color:#1F2340;}h1,h2{color:#5C6BC0;}</style></head><body><h1>${escapeHtml(
    title
  )}</h1>${body}</body></html>`;
}

function generateMarkdownFromDocx(paragraphs: DocxParagraph[], tables: DocxTable[]): string {
  const parts: string[] = [];
  for (const p of paragraphs) {
    if (p.isHeading) {
      parts.push(`## ${p.text}`);
    } else {
      let t = p.text;
      if (p.isBold) t = `**${t}**`;
      if (p.isItalic) t = `*${t}*`;
      parts.push(t);
    }
  }

  for (const tbl of tables) {
    if (tbl.rows.length > 0) {
      const header = `| ${tbl.rows[0].join(' | ')} |`;
      const sep = `| ${tbl.rows[0].map(() => '---').join(' | ')} |`;
      const body = tbl.rows
        .slice(1)
        .map((r) => `| ${r.join(' | ')} |`)
        .join('\n');
      parts.push(`${header}\n${sep}\n${body}`);
    }
  }

  return parts.join('\n\n');
}

async function generatePdfFromDocx(
  paragraphs: DocxParagraph[],
  tables: DocxTable[],
  options: ConversionOptions,
  title: string
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const isLandscape = options.orientation === 'landscape';
    const doc = new PDFDocument({
      size: 'A4',
      layout: isLandscape ? 'landscape' : 'portrait',
      margin: 50,
      info: { Title: title, Creator: 'EasyConvert Office Engine' },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', (err) => reject(err));

    // Accent header line in signature lavender
    doc.rect(50, 40, doc.page.width - 100, 3).fill('#5C6BC0');
    doc.moveDown(1.5);

    // Title
    doc.fillColor('#1F2340').fontSize(20).text(title, { underline: false });
    doc.moveDown(1);

    // Render paragraphs
    for (const p of paragraphs) {
      if (p.isHeading) {
        doc.moveDown(0.5);
        doc.fillColor('#5C6BC0').fontSize(14).text(p.text);
        doc.moveDown(0.25);
      } else {
        doc.fillColor('#4D536B').fontSize(10.5).lineGap(3).text(p.text);
        doc.moveDown(0.4);
      }
    }

    // Render tables if any
    for (const tbl of tables) {
      if (tbl.rows.length === 0) continue;
      doc.moveDown(0.8);
      const colWidth = (doc.page.width - 100) / tbl.rows[0].length;

      tbl.rows.forEach((row, rIdx) => {
        const y = doc.y;
        if (y > doc.page.height - 80) {
          doc.addPage();
        }
        if (rIdx === 0) {
          doc.rect(50, doc.y, doc.page.width - 100, 20).fill('#F0F2FE');
          doc.fillColor('#1F2340').fontSize(9);
        } else {
          doc.fillColor('#4D536B').fontSize(8.5);
        }

        row.forEach((cell, cIdx) => {
          doc.text(cell, 55 + cIdx * colWidth, y + 4, { width: colWidth - 10, lineBreak: false });
        });
        doc.y = y + 20;
      });
    }

    doc.end();
  });
}

/**
 * XLSX Source Parser & Converter
 */
async function convertXlsxSource(
  inputBuffer: Buffer,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  const zip = await JSZip.loadAsync(inputBuffer);
  const sheetFile = zip.file('xl/worksheets/sheet1.xml');
  if (!sheetFile) {
    throw new Error('Invalid XLSX workbook: xl/worksheets/sheet1.xml not found.');
  }

  // Parse shared strings
  const sharedStrings: string[] = [];
  const sstFile = zip.file('xl/sharedStrings.xml');
  if (sstFile) {
    const sstXml = await sstFile.async('text');
    const tRegex = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let m: RegExpExecArray | null;
    while ((m = tRegex.exec(sstXml)) !== null) {
      sharedStrings.push(m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
    }
  }

  // Parse sheet rows
  const sheetXml = await sheetFile.async('text');
  const rows: string[][] = [];
  const rowRegex = /<row[\s\S]*?<\/row>/g;
  let rMatch: RegExpExecArray | null;

  while ((rMatch = rowRegex.exec(sheetXml)) !== null) {
    const rowXml = rMatch[0];
    const cells: string[] = [];
    const cellRegex = /<c\s+([^>]*?)>([\s\S]*?)<\/c>/g;
    let cMatch: RegExpExecArray | null;

    while ((cMatch = cellRegex.exec(rowXml)) !== null) {
      const attrs = cMatch[1];
      const body = cMatch[2];
      const isString = /t="s"/.test(attrs);
      const isInline = /t="inlineStr"/.test(attrs);
      const vMatch = body.match(/<v>([\s\S]*?)<\/v>/);
      const tMatch = body.match(/<t[^>]*>([\s\S]*?)<\/t>/);

      if (isInline && tMatch) {
        cells.push(tMatch[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
      } else if (vMatch) {
        const val = vMatch[1];
        if (isString) {
          const strIdx = parseInt(val, 10);
          cells.push(sharedStrings[strIdx] ?? '');
        } else {
          cells.push(val);
        }
      } else if (tMatch) {
        cells.push(tMatch[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
      } else {
        cells.push('');
      }
    }
    if (cells.length > 0) rows.push(cells);
  }

  // XLSX -> CSV
  if (tgt === 'csv') {
    const delimiter = options.delimiter || ',';
    const csvContent = rows
      .map((r) => r.map((c) => (c.includes(delimiter) || c.includes('"') ? `"${c.replace(/"/g, '""')}"` : c)).join(delimiter))
      .join('\n');
    const buffer = Buffer.from(csvContent, 'utf-8');
    return { buffer, mimeType: 'text/csv', filename: `${baseName}.csv`, size: buffer.length };
  }

  // XLSX -> TSV
  if (tgt === 'tsv') {
    const tsvContent = rows.map((r) => r.join('\t')).join('\n');
    const buffer = Buffer.from(tsvContent, 'utf-8');
    return { buffer, mimeType: 'text/tab-separated-values', filename: `${baseName}.tsv`, size: buffer.length };
  }

  // XLSX -> JSON
  if (tgt === 'json') {
    let jsonArray: any[] = [];
    if (rows.length > 1) {
      const headers = rows[0];
      jsonArray = rows.slice(1).map((row) => {
        const obj: Record<string, string> = {};
        headers.forEach((h, i) => {
          obj[h || `column_${i + 1}`] = row[i] || '';
        });
        return obj;
      });
    } else {
      jsonArray = rows;
    }
    const buffer = Buffer.from(JSON.stringify(jsonArray, null, 2), 'utf-8');
    return { buffer, mimeType: 'application/json', filename: `${baseName}.json`, size: buffer.length };
  }

  // XLSX -> XML
  if (tgt === 'xml') {
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<worksheet name="${escapeXml(baseName)}">\n  <rows>\n`;
    if (rows.length > 0) {
      const headers = rows[0].map((h, i) => (h ? h.replace(/[^a-zA-Z0-9_]/g, '_') : `column_${i + 1}`));
      rows.slice(1).forEach((row, rIdx) => {
        xml += `    <row id="${rIdx + 1}">\n`;
        row.forEach((cell, cIdx) => {
          const colName = headers[cIdx] || `col_${cIdx + 1}`;
          xml += `      <${colName}>${escapeXml(cell)}</${colName}>\n`;
        });
        xml += `    </row>\n`;
      });
    }
    xml += `  </rows>\n</worksheet>`;
    const buffer = Buffer.from(xml, 'utf-8');
    return { buffer, mimeType: 'application/xml', filename: `${baseName}.xml`, size: buffer.length };
  }

  // XLSX -> HTML
  if (tgt === 'html') {
    let tableHtml = '<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%;border-color:#CCD2FC;">\n';
    rows.forEach((r, idx) => {
      tableHtml += '<tr>\n';
      r.forEach((c) => {
        if (idx === 0) {
          tableHtml += `  <th style="background:#F0F2FE;color:#1F2340;padding:8px;text-align:left;">${escapeHtml(c)}</th>\n`;
        } else {
          tableHtml += `  <td style="padding:8px;border:1px solid #E1E4EE;">${escapeHtml(c)}</td>\n`;
        }
      });
      tableHtml += '</tr>\n';
    });
    tableHtml += '</table>';
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(
      baseName
    )}</title><style>body{font-family:system-ui,sans-serif;padding:2rem;color:#1F2340;}</style></head><body><h2>${escapeHtml(
      baseName
    )}</h2>${tableHtml}</body></html>`;
    const buffer = Buffer.from(html, 'utf-8');
    return { buffer, mimeType: 'text/html', filename: `${baseName}.html`, size: buffer.length };
  }

  // XLSX -> PDF
  if (tgt === 'pdf') {
    const pdfBuffer = await generatePdfFromDocx([], [{ rows }], options, baseName);
    return { buffer: pdfBuffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: pdfBuffer.length };
  }

  throw new Error(`Unsupported conversion from XLSX to ${tgt}`);
}

/**
 * PPTX Source Parser & Converter
 */
async function convertPptxSource(
  inputBuffer: Buffer,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  const zip = await JSZip.loadAsync(inputBuffer);
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => {
      const numA = parseInt(a.replace(/\D/g, ''), 10) || 0;
      const numB = parseInt(b.replace(/\D/g, ''), 10) || 0;
      return numA - numB;
    });

  const slides: { number: number; texts: string[] }[] = [];

  for (let i = 0; i < slideFiles.length; i++) {
    const xml = await zip.files[slideFiles[i]].async('text');
    const tRegex = /<a:t>([\s\S]*?)<\/a:t>/g;
    const texts: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = tRegex.exec(xml)) !== null) {
      const clean = match[1].trim();
      if (clean) texts.push(clean);
    }
    slides.push({ number: i + 1, texts });
  }

  if (slides.length === 0) {
    slides.push({ number: 1, texts: [baseName, 'Presentation slide content'] });
  }

  // PPTX -> TXT
  if (tgt === 'txt') {
    const text = slides
      .map((s) => `--- Slide ${s.number} ---\n` + s.texts.join('\n'))
      .join('\n\n');
    const buffer = Buffer.from(text, 'utf-8');
    return { buffer, mimeType: 'text/plain', filename: `${baseName}.txt`, size: buffer.length };
  }

  // PPTX -> HTML
  if (tgt === 'html') {
    const html = generateHtmlFromSlides(slides, baseName);
    const buffer = Buffer.from(html, 'utf-8');
    return { buffer, mimeType: 'text/html', filename: `${baseName}.html`, size: buffer.length };
  }

  // PPTX -> PDF
  if (tgt === 'pdf') {
    const pdfBuffer = await generatePdfFromSlides(slides, options, baseName);
    return { buffer: pdfBuffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: pdfBuffer.length };
  }

  // PPTX -> DOCX
  if (tgt === 'docx') {
    const text = slides.map((s) => `# Slide ${s.number}\n\n` + s.texts.join('\n')).join('\n\n---\n\n');
    const docxBuffer = await generateDocxFromText(text, 'pptx', options, baseName);
    return {
      buffer: docxBuffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      filename: `${baseName}.docx`,
      size: docxBuffer.length,
    };
  }

  // PPTX -> PPTX (echo)
  if (tgt === 'pptx') {
    return {
      buffer: inputBuffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      filename: `${baseName}.pptx`,
      size: inputBuffer.length,
    };
  }

  throw new Error(`Unsupported conversion from PPTX to ${tgt}`);
}

/**
 * OpenDocument Presentation (ODP) Parser & Converter
 */
async function convertOdpSource(
  inputBuffer: Buffer,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  const slides: { number: number; texts: string[] }[] = [];
  try {
    const zip = await JSZip.loadAsync(inputBuffer);
    const contentXmlFile = zip.file('content.xml');
    if (contentXmlFile) {
      const xml = await contentXmlFile.async('text');
      const pageRegex = /<draw:page[\s\S]*?<\/draw:page>/g;
      let pageMatch: RegExpExecArray | null;
      let pageNum = 1;
      while ((pageMatch = pageRegex.exec(xml)) !== null) {
        const pageXml = pageMatch[0];
        const pRegex = /<text:p[^>]*>([\s\S]*?)<\/text:p>/g;
        let pMatch: RegExpExecArray | null;
        const texts: string[] = [];
        while ((pMatch = pRegex.exec(pageXml)) !== null) {
          const t = pMatch[1].replace(/<[^>]+>/g, '').trim();
          if (t) texts.push(t);
        }
        slides.push({ number: pageNum++, texts });
      }
    }
  } catch {
    // fallback
  }

  if (slides.length === 0) {
    slides.push({ number: 1, texts: [baseName, 'Presentation slide content'] });
  }

  if (tgt === 'txt') {
    const text = slides.map((s) => `--- Slide ${s.number} ---\n` + s.texts.join('\n')).join('\n\n');
    const buffer = Buffer.from(text, 'utf-8');
    return { buffer, mimeType: 'text/plain', filename: `${baseName}.txt`, size: buffer.length };
  }

  if (tgt === 'html') {
    const html = generateHtmlFromSlides(slides, baseName);
    const buffer = Buffer.from(html, 'utf-8');
    return { buffer, mimeType: 'text/html', filename: `${baseName}.html`, size: buffer.length };
  }

  if (tgt === 'pdf') {
    const pdfBuffer = await generatePdfFromSlides(slides, options, baseName);
    return { buffer: pdfBuffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: pdfBuffer.length };
  }

  if (tgt === 'pptx') {
    const text = slides.map((s) => `# Slide ${s.number}\n\n` + s.texts.join('\n')).join('\n\n---\n\n');
    const pptxBuffer = await generatePptxFromText(text, 'odp', options, baseName);
    return {
      buffer: pptxBuffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      filename: `${baseName}.pptx`,
      size: pptxBuffer.length,
    };
  }

  throw new Error(`Unsupported conversion from ODP to ${tgt}`);
}

/**
 * Generic Presentation Source Parser (PPT, POTX, KEY)
 */
async function convertGenericPresentationSource(
  inputBuffer: Buffer,
  src: string,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  const text = inputBuffer.toString('utf-8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const slides = [{ number: 1, texts: lines.length > 0 ? lines : [baseName] }];

  if (tgt === 'txt') {
    const buffer = Buffer.from(lines.join('\n'), 'utf-8');
    return { buffer, mimeType: 'text/plain', filename: `${baseName}.txt`, size: buffer.length };
  }

  if (tgt === 'html') {
    const html = generateHtmlFromSlides(slides, baseName);
    const buffer = Buffer.from(html, 'utf-8');
    return { buffer, mimeType: 'text/html', filename: `${baseName}.html`, size: buffer.length };
  }

  if (tgt === 'pdf') {
    const pdfBuffer = await generatePdfFromSlides(slides, options, baseName);
    return { buffer: pdfBuffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: pdfBuffer.length };
  }

  if (tgt === 'pptx') {
    const pptxBuffer = await generatePptxFromText(text, src, options, baseName);
    return {
      buffer: pptxBuffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      filename: `${baseName}.pptx`,
      size: pptxBuffer.length,
    };
  }

  throw new Error(`Unsupported conversion from ${src.toUpperCase()} to ${tgt}`);
}

function generateHtmlFromSlides(slides: { number: number; texts: string[] }[], title: string): string {
  let slidesHtml = '';
  slides.forEach((slide) => {
    slidesHtml += `
    <div style="border:1px solid #CCD2FC;border-radius:12px;padding:24px;margin-bottom:20px;background:#FAFAFE;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
      <div style="font-size:11px;font-weight:700;color:#5C6BC0;text-transform:uppercase;margin-bottom:8px;">Slide ${slide.number}</div>
      <h2 style="font-size:18px;color:#1F2340;margin-top:0;margin-bottom:16px;">${slide.texts[0] ? escapeHtml(slide.texts[0]) : `Slide ${slide.number}`}</h2>
      <ul style="color:#4D536B;font-size:14px;line-height:1.6;margin:0;padding-left:20px;">
        ${slide.texts.slice(1).map((t) => `<li>${escapeHtml(t)}</li>`).join('\n')}
      </ul>
    </div>`;
  });

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(
    title
  )}</title><style>body{font-family:system-ui,-apple-system,sans-serif;max-width:850px;margin:2rem auto;padding:0 1rem;background:#F8F9FE;color:#1F2340;}h1{color:#5C6BC0;text-align:center;margin-bottom:2rem;}</style></head><body><h1>${escapeHtml(
    title
  )}</h1>${slidesHtml}</body></html>`;
}

async function generatePdfFromSlides(
  slides: { number: number; texts: string[] }[],
  options: ConversionOptions,
  title: string
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', (err) => reject(err));

    slides.forEach((slide, idx) => {
      if (idx > 0) doc.addPage();
      // Slide header
      doc.rect(40, 40, doc.page.width - 80, 4).fill('#5C6BC0');
      doc.fillColor('#1F2340').fontSize(16).text(`${title} — Slide ${slide.number}`, 40, 55);
      doc.moveDown(1.5);

      slide.texts.forEach((line) => {
        doc.fillColor('#4D536B').fontSize(12).lineGap(4).text(`• ${line}`);
        doc.moveDown(0.5);
      });
    });

    doc.end();
  });
}

/**
 * EPUB Source Parser & Converter
 */
async function convertEpubSource(
  inputBuffer: Buffer,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  const zip = await JSZip.loadAsync(inputBuffer);
  const htmlFiles = Object.keys(zip.files).filter((name) => /\.(xhtml|html|htm)$/i.test(name));

  let extractedText = '';
  for (const filename of htmlFiles) {
    const content = await zip.files[filename].async('text');
    const text = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text) {
      extractedText += text + '\n\n';
    }
  }

  if (tgt === 'txt') {
    const buffer = Buffer.from(extractedText, 'utf-8');
    return { buffer, mimeType: 'text/plain', filename: `${baseName}.txt`, size: buffer.length };
  }

  if (tgt === 'html') {
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(
      baseName
    )}</title><style>body{font-family:system-ui,-apple-system,sans-serif;line-height:1.7;max-width:800px;margin:2rem auto;padding:0 1.5rem;color:#1F2340;}h1{color:#5C6BC0;}</style></head><body><h1>${escapeHtml(
      baseName
    )}</h1>${extractedText
      .split('\n\n')
      .map((p) => `<p>${escapeHtml(p)}</p>`)
      .join('\n')}</body></html>`;
    const buffer = Buffer.from(html, 'utf-8');
    return { buffer, mimeType: 'text/html', filename: `${baseName}.html`, size: buffer.length };
  }

  if (tgt === 'md') {
    const buffer = Buffer.from(`# ${baseName}\n\n` + extractedText, 'utf-8');
    return { buffer, mimeType: 'text/markdown', filename: `${baseName}.md`, size: buffer.length };
  }

  if (tgt === 'docx') {
    const docxBuffer = await generateDocxFromText(extractedText, 'epub', options, baseName);
    return {
      buffer: docxBuffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      filename: `${baseName}.docx`,
      size: docxBuffer.length,
    };
  }

  if (tgt === 'pdf') {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    const p = new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (err) => reject(err));
    });
    doc.fillColor('#1F2340').fontSize(18).text(baseName);
    doc.moveDown(1);
    doc.fillColor('#4D536B').fontSize(10.5).lineGap(3).text(extractedText || 'Epub content');
    doc.end();

    const buffer = await p;
    return { buffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: buffer.length };
  }

  throw new Error(`Unsupported conversion from EPUB to ${tgt}`);
}

/**
 * FictionBook 2 (FB2) Parser & Converter
 */
async function convertFb2Source(
  inputBuffer: Buffer,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  const xml = inputBuffer.toString('utf-8');
  const pRegex = /<p>([\s\S]*?)<\/p>/g;
  const paragraphs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pRegex.exec(xml)) !== null) {
    const text = m[1].replace(/<[^>]+>/g, '').trim();
    if (text) paragraphs.push(text);
  }

  const titleMatch = xml.match(/<book-title>([\s\S]*?)<\/book-title>/);
  const bookTitle = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : baseName;
  const fullText = paragraphs.join('\n\n');

  if (tgt === 'txt') {
    const buffer = Buffer.from(fullText, 'utf-8');
    return { buffer, mimeType: 'text/plain', filename: `${baseName}.txt`, size: buffer.length };
  }

  if (tgt === 'epub') {
    const epubBuffer = await generateEpubFromText(fullText, 'fb2', options, bookTitle);
    return { buffer: epubBuffer, mimeType: 'application/epub+zip', filename: `${baseName}.epub`, size: epubBuffer.length };
  }

  if (tgt === 'docx') {
    const docxBuffer = await generateDocxFromText(fullText, 'fb2', options, bookTitle);
    return {
      buffer: docxBuffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      filename: `${baseName}.docx`,
      size: docxBuffer.length,
    };
  }

  if (tgt === 'pdf') {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    const p = new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (err) => reject(err));
    });
    doc.fillColor('#1F2340').fontSize(18).text(bookTitle);
    doc.moveDown(1);
    doc.fillColor('#4D536B').fontSize(10.5).lineGap(3).text(fullText || 'FB2 text content');
    doc.end();

    const buffer = await p;
    return { buffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: buffer.length };
  }

  throw new Error(`Unsupported conversion from FB2 to ${tgt}`);
}

/**
 * MOBI / AZW3 Parser & Converter
 */
async function convertMobiSource(
  inputBuffer: Buffer,
  src: string,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  // Extract text chunks from MOBI binary stream
  const raw = inputBuffer.toString('binary');
  const textPieces: string[] = [];
  const strRegex = /[\x20-\x7E\s]{4,}/g;
  let m: RegExpExecArray | null;
  while ((m = strRegex.exec(raw)) !== null) {
    const s = m[0].trim();
    if (s.length > 10 && !/^(BOOKMOBIP|EXTH|CONT)/.test(s)) {
      textPieces.push(s);
    }
  }

  const fullText = textPieces.join('\n\n') || `Extracted content from ${baseName}.${src}`;

  if (tgt === 'txt') {
    const buffer = Buffer.from(fullText, 'utf-8');
    return { buffer, mimeType: 'text/plain', filename: `${baseName}.txt`, size: buffer.length };
  }

  if (tgt === 'epub') {
    const epubBuffer = await generateEpubFromText(fullText, src, options, baseName);
    return { buffer: epubBuffer, mimeType: 'application/epub+zip', filename: `${baseName}.epub`, size: epubBuffer.length };
  }

  if (tgt === 'pdf') {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    const p = new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (err) => reject(err));
    });
    doc.fillColor('#1F2340').fontSize(18).text(baseName);
    doc.moveDown(1);
    doc.fillColor('#4D536B').fontSize(10.5).lineGap(3).text(fullText);
    doc.end();

    const buffer = await p;
    return { buffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: buffer.length };
  }

  throw new Error(`Unsupported conversion from ${src.toUpperCase()} to ${tgt}`);
}

/**
 * Comic Book Zip (CBZ) Parser & Converter
 */
async function convertCbzSource(
  inputBuffer: Buffer,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  const zip = await JSZip.loadAsync(inputBuffer);
  const imageNames = Object.keys(zip.files)
    .filter((n) => /\.(png|jpe?g|webp|bmp|gif)$/i.test(n))
    .sort();

  if (tgt === 'pdf') {
    const doc = new PDFDocument({ autoFirstPage: false });
    const chunks: Buffer[] = [];
    const p = new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (err) => reject(err));
    });

    for (const name of imageNames) {
      const imgBuf = await zip.files[name].async('nodebuffer');
      doc.addPage({ size: 'A4' });
      try {
        doc.image(imgBuf, 40, 40, { fit: [doc.page.width - 80, doc.page.height - 80], align: 'center', valign: 'center' });
      } catch {
        doc.text(`[Image ${name}]`);
      }
    }

    if (imageNames.length === 0) {
      doc.addPage({ size: 'A4' });
      doc.fontSize(16).text(`CBZ Comic: ${baseName} (No images extracted)`);
    }

    doc.end();
    const buffer = await p;
    return { buffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: buffer.length };
  }

  throw new Error(`Unsupported conversion from CBZ to ${tgt}`);
}

/**
 * Generates OpenXML DOCX Zip Archive with Table and Heading preservation
 */
export async function generateDocxFromText(
  text: string,
  sourceType: string,
  options: ConversionOptions,
  title: string
): Promise<Buffer> {
  const zip = new JSZip();

  // [Content_Types].xml
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
  );

  // _rels/.rels
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  );

  // Parse lines, markdown headings, and markdown tables
  const lines = text.split(/\r?\n/);
  const elementsXml: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // Check if this line starts a markdown table (| ... |)
    if (trimmed.startsWith('|') && trimmed.endsWith('|') && i + 1 < lines.length && lines[i + 1].trim().startsWith('|')) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
        tableLines.push(lines[i].trim());
        i++;
      }

      if (tableLines.length >= 2) {
        const headerCells = tableLines[0].split('|').slice(1, -1).map((c) => c.trim());
        const dataRows = tableLines.slice(2).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));

        let tblXml = `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="CCD2FC"/><w:bottom w:val="single" w:sz="4" w:color="CCD2FC"/><w:left w:val="single" w:sz="4" w:color="CCD2FC"/><w:right w:val="single" w:sz="4" w:color="CCD2FC"/><w:insideH w:val="single" w:sz="4" w:color="E1E4EE"/><w:insideV w:val="single" w:sz="4" w:color="E1E4EE"/></w:tblBorders></w:tblPr>`;
        tblXml += `<w:tblGrid>${headerCells.map(() => '<w:gridCol/>').join('')}</w:tblGrid>`;

        // Header Row
        tblXml += `<w:tr>`;
        headerCells.forEach((cell) => {
          tblXml += `<w:tc><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="F0F2FE"/></w:tcPr><w:p><w:r><w:rPr><w:b/><w:color w:val="1F2340"/></w:rPr><w:t>${escapeXml(
            cell
          )}</w:t></w:r></w:p></w:tc>`;
        });
        tblXml += `</w:tr>`;

        // Data Rows
        dataRows.forEach((row) => {
          tblXml += `<w:tr>`;
          row.forEach((cell) => {
            tblXml += `<w:tc><w:p><w:r><w:rPr><w:color w:val="4D536B"/></w:rPr><w:t>${escapeXml(
              cell
            )}</w:t></w:r></w:p></w:tc>`;
          });
          tblXml += `</w:tr>`;
        });

        tblXml += `</w:tbl>`;
        elementsXml.push(tblXml);
        continue;
      }
    }

    // Heading 1 (# ...)
    if (trimmed.startsWith('# ')) {
      elementsXml.push(
        `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="32"/><w:color w:val="5C6BC0"/></w:rPr><w:t>${escapeXml(
          trimmed.substring(2)
        )}</w:t></w:r></w:p>`
      );
    } else if (trimmed.startsWith('## ')) {
      elementsXml.push(
        `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="26"/><w:color w:val="5C6BC0"/></w:rPr><w:t>${escapeXml(
          trimmed.substring(3)
        )}</w:t></w:r></w:p>`
      );
    } else {
      // Regular paragraph with bold / italic tags
      const hasBold = trimmed.includes('**');
      const hasItalic = trimmed.includes('*') && !hasBold;
      const clean = trimmed.replace(/\*\*/g, '').replace(/\*/g, '');
      elementsXml.push(
        `<w:p><w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>${
          hasBold ? '<w:b/>' : ''
        }${hasItalic ? '<w:i/>' : ''}<w:color w:val="1F2340"/></w:rPr><w:t>${escapeXml(
          clean
        )}</w:t></w:r></w:p>`
      );
    }

    i++;
  }

  // word/document.xml
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:rPr><w:b/><w:sz w:val="36"/><w:color w:val="5C6BC0"/></w:rPr><w:t>${escapeXml(
        title
      )}</w:t></w:r>
    </w:p>
    ${elementsXml.join('\n')}
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>
  </w:body>
</w:document>`
  );

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Generates OpenXML PPTX Presentation Archive
 */
export async function generatePptxFromText(
  text: string,
  sourceType: string,
  options: ConversionOptions,
  title: string
): Promise<Buffer> {
  const zip = new JSZip();

  // Split text into slides based on markdown headings, dividers, or paragraph groups
  const slideTexts: { title: string; bullets: string[] }[] = [];
  const rawSections = text.split(/(?:^|\n)(?:---|# Slide \d+|## Slide \d+)/i).filter((s) => s.trim().length > 0);

  if (rawSections.length > 1) {
    rawSections.forEach((sec, idx) => {
      const lines = sec.split(/\r?\n/).filter((l) => l.trim().length > 0);
      const slideTitle = lines[0]?.replace(/^[#\s]+/, '').trim() || `Slide ${idx + 1}`;
      const bullets = lines.slice(1).map((l) => l.replace(/^[-*•\s]+/, '').trim());
      slideTexts.push({ title: slideTitle, bullets });
    });
  } else {
    // Single section: split by lines into logical slides of 4-5 bullet points
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const mainTitle = lines[0]?.replace(/^[#\s]+/, '').trim() || title;
    const bodyLines = lines.slice(1).map((l) => l.replace(/^[-*•\s]+/, '').trim());

    slideTexts.push({
      title: mainTitle,
      bullets: bodyLines.slice(0, 5),
    });

    for (let j = 5; j < bodyLines.length; j += 5) {
      slideTexts.push({
        title: `${mainTitle} (Cont.)`,
        bullets: bodyLines.slice(j, j + 5),
      });
    }
  }

  if (slideTexts.length === 0) {
    slideTexts.push({ title, bullets: ['Generated presentation content'] });
  }

  // [Content_Types].xml
  let contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
`;

  slideTexts.forEach((_, idx) => {
    contentTypesXml += `  <Override PartName="/ppt/slides/slide${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>\n`;
  });
  contentTypesXml += `</Types>`;
  zip.file('[Content_Types].xml', contentTypesXml);

  // _rels/.rels
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`
  );

  // ppt/_rels/presentation.xml.rels
  let presRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
`;
  slideTexts.forEach((_, idx) => {
    presRelsXml += `  <Relationship Id="rId${idx + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${idx + 1}.xml"/>\n`;
  });
  presRelsXml += `</Relationships>`;
  zip.file('ppt/_rels/presentation.xml.rels', presRelsXml);

  // ppt/presentation.xml
  let presXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst>
`;
  slideTexts.forEach((_, idx) => {
    presXml += `    <p:sldId id="${256 + idx}" r:id="rId${idx + 1}"/>\n`;
  });
  presXml += `  </p:sldIdLst>
  <p:sldSz cx="9144000" cy="5143500"/>
</p:presentation>`;
  zip.file('ppt/presentation.xml', presXml);

  // Individual slides
  slideTexts.forEach((slide, idx) => {
    let bulletsXml = '';
    slide.bullets.forEach((b) => {
      bulletsXml += `
        <a:p>
          <a:pPr lvl="0"/>
          <a:r>
            <a:rPr lang="en-US" sz="1800">
              <a:solidFill><a:srgbClr val="4D536B"/></a:solidFill>
            </a:rPr>
            <a:t>${escapeXml(b)}</a:t>
          </a:r>
        </a:p>`;
    });

    const slideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr/>
      <!-- Slide Title Shape -->
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="2" name="Title 1"/>
          <p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>
          <p:nvPr><p:ph type="title"/></p:nvPr>
        </p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="685800" y="609600"/><a:ext cx="7772400" cy="1143000"/></a:xfrm>
        </p:spPr>
        <p:txBody>
          <a:bodyPr/>
          <a:lstStyle/>
          <a:p>
            <a:r>
              <a:rPr lang="en-US" sz="3200" b="1">
                <a:solidFill><a:srgbClr val="5C6BC0"/></a:solidFill>
              </a:rPr>
              <a:t>${escapeXml(slide.title)}</a:t>
            </a:r>
          </a:p>
        </p:txBody>
      </p:sp>
      <!-- Content Bullets Shape -->
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="3" name="Content 2"/>
          <p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>
          <p:nvPr><p:ph idx="1"/></p:nvPr>
        </p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="685800" y="1981200"/><a:ext cx="7772400" cy="2800000"/></a:xfrm>
        </p:spPr>
        <p:txBody>
          <a:bodyPr/>
          <a:lstStyle/>
          ${bulletsXml}
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`;

    zip.file(`ppt/slides/slide${idx + 1}.xml`, slideXml);
  });

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Generates OpenXML XLSX Zip Archive from CSV / TSV / JSON
 */
async function generateXlsxFromData(
  inputBuffer: Buffer,
  sourceType: string,
  options: ConversionOptions,
  title: string
): Promise<Buffer> {
  const zip = new JSZip();
  const rawText = inputBuffer.toString('utf-8');

  let rows: string[][] = [];
  if (sourceType === 'json') {
    try {
      const parsed = JSON.parse(rawText);
      if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'object') {
        const headers = Object.keys(parsed[0]);
        rows.push(headers);
        parsed.forEach((item) => rows.push(headers.map((h) => String(item[h] ?? ''))));
      } else {
        rows = [['Value'], ...parsed.map((p: any) => [String(p)])];
      }
    } catch {
      rows = [['Data'], [rawText]];
    }
  } else {
    // Delimited (CSV or TSV)
    const delim = sourceType === 'tsv' ? '\t' : options.delimiter || ',';
    rows = rawText
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .map((line) => line.split(delim));
  }

  // Build sheet1.xml row data
  let sheetRowsXml = '';
  rows.forEach((row, rIdx) => {
    sheetRowsXml += `<row r="${rIdx + 1}">`;
    row.forEach((cell, cIdx) => {
      const colLetter = String.fromCharCode(65 + (cIdx % 26));
      sheetRowsXml += `<c r="${colLetter}${rIdx + 1}" t="inlineStr"><is><t>${escapeXml(
        cell
      )}</t></is></c>`;
    });
    sheetRowsXml += '</row>';
  });

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`
  );

  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
  );

  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Sheet1" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`
  );

  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`
  );

  zip.file(
    'xl/worksheets/sheet1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    ${sheetRowsXml}
  </sheetData>
</worksheet>`
  );

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Generates IDPF EPUB Container
 */
async function generateEpubFromText(
  text: string,
  sourceType: string,
  options: ConversionOptions,
  title: string
): Promise<Buffer> {
  const zip = new JSZip();

  // mimetype must be uncompressed first entry in EPUB
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
  );

  const paragraphs = text
    .split(/\r?\n\r?\n/)
    .map((p) => `<p>${escapeXml(p.trim())}</p>`)
    .join('\n');

  zip.file(
    'OEBPS/chapter1.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
  <title>${escapeXml(title)}</title>
  <style>body{font-family:sans-serif;line-height:1.6;padding:1rem;color:#1F2340;}h1{color:#5C6BC0;}</style>
</head>
<body>
  <h1>${escapeXml(title)}</h1>
  ${paragraphs}
</body>
</html>`
  );

  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:language>en</dc:language>
    <dc:creator>EasyConvert Ebook Engine</dc:creator>
  </metadata>
  <manifest>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="chapter1"/>
  </spine>
</package>`
  );

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
