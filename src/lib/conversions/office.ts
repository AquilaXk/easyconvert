import JSZip from 'jszip';
import Papa from 'papaparse';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import { ConversionOptions, ConversionResult } from '../types';
import { extractTextFromPdf, extractEmbeddedImageFromPdf } from './pdf-utils';
import { performOcr } from './ocr';
import { encodeBmp, encodePostscript } from './image';
import { convertHwp, parseHwpDocument, buildHwpCompoundFile } from './hwp';

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

  // 5. ODS (OpenDocument Spreadsheet) Source
  if (src === 'ods') {
    return convertOdsSource(inputBuffer, tgt, options, baseName);
  }

  // 6. XLS Source
  if (src === 'xls') {
    return convertXlsSource(inputBuffer, tgt, options, baseName);
  }

  // 7. ODT (OpenDocument Text) Source
  if (src === 'odt') {
    return convertOdtSource(inputBuffer, tgt, options, baseName);
  }

  // 8. Other presentation sources (ppt, potx, key)
  if (['ppt', 'potx', 'key'].includes(src)) {
    return convertGenericPresentationSource(inputBuffer, src, tgt, options, baseName);
  }

  // 9. EPUB Source
  if (src === 'epub') {
    return convertEpubSource(inputBuffer, tgt, options, baseName);
  }

  // 10. FB2 Source
  if (src === 'fb2') {
    return convertFb2Source(inputBuffer, tgt, options, baseName);
  }

  // 11. MOBI / AZW3 Source
  if (['mobi', 'azw', 'azw3'].includes(src)) {
    return convertMobiSource(inputBuffer, src, tgt, options, baseName);
  }

  // 12. CBZ Source (Comic Book Zip)
  if (src === 'cbz') {
    return convertCbzSource(inputBuffer, tgt, options, baseName);
  }

  // 12.1 ET (Kingsoft WPS Spreadsheet)
  if (src === 'et') {
    return convertEtSource(inputBuffer, tgt, options, baseName);
  }

  // 12.2 HWP Source (Hangul Word Processor)
  if (src === 'hwp') {
    return convertHwp(inputBuffer, tgt, options, baseName);
  }

  // 12.3 LWP, PUB (Documents)
  if (['lwp', 'pub'].includes(src)) {
    return convertGenericDocumentSource(inputBuffer, src, tgt, options, baseName);
  }

  // 12.3 ODG, ODD (OpenDocument Graphics / Drawing)
  if (['odg', 'odd'].includes(src)) {
    return convertOpenDocumentGraphicSource(inputBuffer, src, tgt, options, baseName);
  }

  // 12.4 AZW4, CBC, HTMLZ, TXTZ, PML, OEB (Ebooks)
  if (['azw4', 'cbc', 'htmlz', 'txtz', 'pml', 'oeb'].includes(src)) {
    return convertGenericEbookSource(inputBuffer, src, tgt, options, baseName);
  }

  // 13.0 Target is HWP (from Markdown, HTML, TXT, DOCX, ODT, RTF, etc.)
  if (tgt === 'hwp') {
    const textContent = await extractTextContentForOffice(inputBuffer, src, options, baseName);
    const hwpBuffer = generateHwpFromText(textContent, baseName);
    return {
      buffer: hwpBuffer,
      mimeType: 'application/x-hwp',
      filename: `${baseName}.hwp`,
      size: hwpBuffer.length,
    };
  }

  // 13. Target is DOCX (from Markdown, HTML, TXT, PDF, RTF, etc.)
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

  // 14. Target is PPTX (from Markdown, HTML, TXT, Presentation, etc.)
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

  // 15. Target is XLSX (from CSV, TSV, JSON)
  if (tgt === 'xlsx') {
    const xlsxBuffer = await generateXlsxFromData(inputBuffer, src, options, baseName);
    return {
      buffer: xlsxBuffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename: `${baseName}.xlsx`,
      size: xlsxBuffer.length,
    };
  }

  // 16. Target is ODS (OpenDocument Spreadsheet)
  if (tgt === 'ods') {
    const rows = await extractRowsForOffice(inputBuffer, src, options);
    const odsBuffer = await generateOdsFromData(rows, baseName);
    return {
      buffer: odsBuffer,
      mimeType: 'application/vnd.oasis.opendocument.spreadsheet',
      filename: `${baseName}.ods`,
      size: odsBuffer.length,
    };
  }

  // 17. Target is XLS
  if (tgt === 'xls') {
    const rows = await extractRowsForOffice(inputBuffer, src, options);
    const xlsXml = generateXlsXmlFromData(rows, baseName);
    const buffer = Buffer.from(xlsXml, 'utf-8');
    return {
      buffer,
      mimeType: 'application/vnd.ms-excel',
      filename: `${baseName}.xls`,
      size: buffer.length,
    };
  }

  // 18. Target is ODP (OpenDocument Presentation)
  if (tgt === 'odp') {
    const textContent = await extractTextContentForOffice(inputBuffer, src, options, baseName);
    const rawSlides = textContent.split(/\n\n+/).map((p, idx) => ({
      number: idx + 1,
      texts: p.split('\n').filter(Boolean),
    }));
    const odpBuffer = await generateOdpFromSlides(
      rawSlides.length > 0 ? rawSlides : [{ number: 1, texts: [baseName] }],
      baseName
    );
    return {
      buffer: odpBuffer,
      mimeType: 'application/vnd.oasis.opendocument.presentation',
      filename: `${baseName}.odp`,
      size: odpBuffer.length,
    };
  }

  // 19. Target is ODT (OpenDocument Text)
  if (tgt === 'odt') {
    const textContent = await extractTextContentForOffice(inputBuffer, src, options, baseName);
    const odtBuffer = await generateOdtFromText(textContent, baseName);
    return {
      buffer: odtBuffer,
      mimeType: 'application/vnd.oasis.opendocument.text',
      filename: `${baseName}.odt`,
      size: odtBuffer.length,
    };
  }

  // 20. Target is EPUB (from MD, HTML, TXT, DOCX, etc.)
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

  // 21. Target is PDF (from Office or Ebook sources)
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

  // 22. Target is Apple iWork (pages, numbers, key)
  if (['pages', 'numbers', 'key'].includes(tgt)) {
    const zip = new JSZip();
    zip.file('mimetype', `application/x-iwork-${tgt}-sff${tgt}`);
    zip.file('Index/Document.iwa', inputBuffer);
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    return {
      buffer,
      mimeType: `application/x-iwork-${tgt}-sff${tgt}`,
      filename: `${baseName}.${tgt}`,
      size: buffer.length,
    };
  }

  // 23. Target is eBook (azw3, mobi, lrf, oeb, pdb)
  if (['azw3', 'mobi', 'lrf', 'oeb', 'pdb'].includes(tgt)) {
    const textContent = await extractTextContentForOffice(inputBuffer, src, options, baseName);
    return convertMobiSource(Buffer.from(textContent, 'utf-8'), 'txt', tgt, options, baseName);
  }

  // 23.1 Target is FB2 (FictionBook 2.0 with semantic markup)
  if (tgt === 'fb2') {
    const textContent = await extractTextContentForOffice(inputBuffer, src, options, baseName);
    const fb2Buffer = generateFb2FromText(textContent, baseName, options);
    return {
      buffer: fb2Buffer,
      mimeType: 'application/x-fictionbook+xml',
      filename: `${baseName}.fb2`,
      size: fb2Buffer.length,
    };
  }

  // 24. Target is Plain Text / Markdown / HTML / RTF
  if (tgt === 'txt' || tgt === 'text') {
    const textContent = await extractTextContentForOffice(inputBuffer, src, options, baseName);
    const buffer = Buffer.from(textContent, 'utf-8');
    return { buffer, mimeType: 'text/plain', filename: `${baseName}.txt`, size: buffer.length };
  }
  if (tgt === 'html') {
    const textContent = await extractTextContentForOffice(inputBuffer, src, options, baseName);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(baseName)}</title></head><body><pre>${escapeHtml(textContent)}</pre></body></html>`;
    const buffer = Buffer.from(html, 'utf-8');
    return { buffer, mimeType: 'text/html', filename: `${baseName}.html`, size: buffer.length };
  }
  if (tgt === 'rtf') {
    const textContent = await extractTextContentForOffice(inputBuffer, src, options, baseName);
    const rtf = `{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Times New Roman;}}\\fs24 ${escapeHtml(textContent).replace(/\\r?\\n/g, '\\par ')}}\n`;
    const buffer = Buffer.from(rtf, 'utf-8');
    return { buffer, mimeType: 'application/rtf', filename: `${baseName}.rtf`, size: buffer.length };
  }
  if (tgt === 'csv') {
    const rows = await extractRowsForOffice(inputBuffer, src, options);
    const csv = Papa.unparse(rows, { delimiter: options.delimiter || ',' });
    const buffer = Buffer.from(csv, 'utf-8');
    return { buffer, mimeType: 'text/csv', filename: `${baseName}.csv`, size: buffer.length };
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

  if (src === 'doc') {
    return extractTextFromDocBytes(inputBuffer);
  }

  if (src === 'tex') {
    return extractTextFromTexString(inputBuffer.toString('utf-8'));
  }

  if (src === 'hwp') {
    const doc = parseHwpDocument(inputBuffer);
    const parts = doc.paragraphs.map((p) => p.text);
    doc.tables.forEach((t) => {
      parts.push(t.rows.map((r) => r.join('\t')).join('\n'));
    });
    return parts.join('\n\n');
  }

  return inputBuffer.toString('utf-8');
}

function extractTextFromDocBytes(buffer: Buffer): string {
  const strings: string[] = [];
  let curr = '';
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];
    if (byte >= 32 && byte <= 126) {
      curr += String.fromCharCode(byte);
    } else if (byte === 10 || byte === 13) {
      if (curr.trim().length >= 4) strings.push(curr.trim());
      curr = '';
    } else {
      if (curr.trim().length >= 5) strings.push(curr.trim());
      curr = '';
    }
  }
  if (curr.trim().length >= 4) strings.push(curr.trim());
  return strings.join('\n\n') || 'Extracted document content.';
}

function extractTextFromTexString(tex: string): string {
  return tex
    .replace(/\\(?:section|chapter|subsection)\*?\{([^}]+)\}/g, '$1\n\n')
    .replace(/\\[a-zA-Z]+(?:\[[^\]]*\])?(?:\{([^}]*)\})?/g, '$1 ')
    .replace(/[{}]/g, '')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
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

  // Extract paragraphs, headings, and tables in sequential document order
  const { paragraphs, tables, elements } = parseDocxXml(xmlText);

  // DOCX -> TXT
  if (tgt === 'txt') {
    const text = elements && elements.length > 0
      ? elements
          .map((el) =>
            el.type === 'paragraph'
              ? el.paragraph.text
              : el.table.rows.map((r) => r.join('\t')).join('\n')
          )
          .join('\n\n')
      : paragraphs.map((p) => p.text).join('\n\n');
    const buffer = Buffer.from(text, 'utf-8');
    return { buffer, mimeType: 'text/plain', filename: `${baseName}.txt`, size: buffer.length };
  }

  // DOCX -> HTML
  if (tgt === 'html') {
    const html = generateHtmlFromDocx(paragraphs, tables, baseName, elements);
    const buffer = Buffer.from(html, 'utf-8');
    return { buffer, mimeType: 'text/html', filename: `${baseName}.html`, size: buffer.length };
  }

  // DOCX -> Markdown
  if (tgt === 'md') {
    const md = generateMarkdownFromDocx(paragraphs, tables, elements);
    const buffer = Buffer.from(md, 'utf-8');
    return { buffer, mimeType: 'text/markdown', filename: `${baseName}.md`, size: buffer.length };
  }

  // DOCX -> PDF
  if (tgt === 'pdf') {
    const pdfBuffer = await generatePdfFromDocx(paragraphs, tables, options, baseName, elements);
    return { buffer: pdfBuffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: pdfBuffer.length };
  }

  // DOCX -> FB2
  if (tgt === 'fb2') {
    const md = generateMarkdownFromDocx(paragraphs, tables, elements);
    const fb2Buffer = generateFb2FromText(md, baseName, options);
    return { buffer: fb2Buffer, mimeType: 'application/x-fictionbook+xml', filename: `${baseName}.fb2`, size: fb2Buffer.length };
  }

  // DOCX -> EPUB
  if (tgt === 'epub') {
    const text = generateMarkdownFromDocx(paragraphs, tables, elements);
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

  // DOCX -> ODT
  if (tgt === 'odt') {
    const text = paragraphs.map((p) => p.text).join('\n\n');
    const odtBuffer = await generateOdtFromText(text, baseName);
    return {
      buffer: odtBuffer,
      mimeType: 'application/vnd.oasis.opendocument.text',
      filename: `${baseName}.odt`,
      size: odtBuffer.length,
    };
  }

  // DOCX -> DOCX (echo)
  if (tgt === 'docx') {
    return {
      buffer: inputBuffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      filename: `${baseName}.docx`,
      size: inputBuffer.length,
    };
  }

  throw new Error(`Unsupported conversion from DOCX to ${tgt}`);
}

export interface DocxRun {
  text: string;
  isBold: boolean;
  isItalic: boolean;
  isUnderline: boolean;
  isStrike: boolean;
  color?: string;
  fontSize?: number;
}

export interface DocxParagraph {
  text: string;
  runs?: DocxRun[];
  isHeading?: boolean;
  headingLevel?: number;
  isBold?: boolean;
  isItalic?: boolean;
  alignment?: 'left' | 'center' | 'right' | 'both';
  isBullet?: boolean;
}

export interface DocxTableCell {
  text: string;
  shading?: string;
  isHeader?: boolean;
  colSpan?: number;
}

export interface DocxTable {
  rowCount?: number;
  colCount?: number;
  rows: string[][];
  structuredRows?: DocxTableCell[][];
}

export type DocxBlockElement =
  | { type: 'paragraph'; paragraph: DocxParagraph }
  | { type: 'table'; table: DocxTable };

function parseDocxXml(xml: string): {
  paragraphs: DocxParagraph[];
  tables: DocxTable[];
  elements: DocxBlockElement[];
} {
  const paragraphs: DocxParagraph[] = [];
  const tables: DocxTable[] = [];
  const elements: DocxBlockElement[] = [];

  const bodyMatch = xml.match(/<w:body[\s\S]*?<\/w:body>/);
  const bodyXml = bodyMatch ? bodyMatch[0] : xml;

  // Match top-level blocks: <w:tbl> is matched as a single unit, avoiding duplicate extraction of inner paragraphs
  const blockRegex = /(<w:tbl[\s\S]*?<\/w:tbl>|<w:p[\s\S]*?<\/w:p>)/g;
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(bodyXml)) !== null) {
    const chunk = match[0];

    // If chunk is a Table (<w:tbl>)
    if (chunk.startsWith('<w:tbl')) {
      const rows: string[][] = [];
      const structuredRows: DocxTableCell[][] = [];

      const trRegex = /<w:tr[\s\S]*?<\/w:tr>/g;
      let trMatch: RegExpExecArray | null;

      while ((trMatch = trRegex.exec(chunk)) !== null) {
        const trXml = trMatch[0];
        const rowCells: string[] = [];
        const sCells: DocxTableCell[] = [];
        const isHeader = /<w:tblHeader(\/|>)/.test(trXml) || rows.length === 0;

        const tcRegex = /<w:tc[\s\S]*?<\/w:tc>/g;
        let tcMatch: RegExpExecArray | null;

        while ((tcMatch = tcRegex.exec(trXml)) !== null) {
          const tcXml = tcMatch[0];

          const shdMatch = tcXml.match(/<w:shd[^>]*w:fill="([A-Fa-f0-9]{6})"/);
          const shading = shdMatch ? shdMatch[1] : undefined;

          const spanMatch = tcXml.match(/<w:gridSpan[^>]*w:val="(\d+)"/);
          const colSpan = spanMatch ? parseInt(spanMatch[1], 10) : 1;

          const tMatches = tcXml.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [];
          const cellText = tMatches
            .map((m) => m.replace(/<[^>]+>/g, ''))
            .join('')
            .trim();

          rowCells.push(cellText);
          sCells.push({ text: cellText, shading, colSpan, isHeader });
        }

        if (rowCells.length > 0) {
          rows.push(rowCells);
          structuredRows.push(sCells);
        }
      }

      if (rows.length > 0) {
        const maxCols = Math.max(...rows.map((r) => r.length));
        const tbl: DocxTable = {
          rowCount: rows.length,
          colCount: maxCols,
          rows,
          structuredRows,
        };
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
    const headingLevel = isHeading1 ? 1 : isHeading2 ? 2 : isHeading3 ? 3 : isHeading ? 2 : 0;

    const jcMatch = chunk.match(/<w:jc\s+[^>]*w:val="([^"]+)"/);
    const alignment = jcMatch ? (jcMatch[1] as any) : undefined;
    const isBullet = /<w:numPr(\/|>)/.test(chunk);

    // Extract runs (<w:r>)
    const runs: DocxRun[] = [];
    const rRegex = /<w:r[\s\S]*?<\/w:r>/g;
    let rMatch: RegExpExecArray | null;
    let overallBold = false;
    let overallItalic = false;

    while ((rMatch = rRegex.exec(chunk)) !== null) {
      const rXml = rMatch[0];
      const rBold = /<w:b(\/|>)/.test(rXml);
      const rItalic = /<w:i(\/|>)/.test(rXml);
      const rUnderline = /<w:u(\/|>)/.test(rXml);
      const rStrike = /<w:strike(\/|>)/.test(rXml);

      const colorMatch = rXml.match(/<w:color\s+[^>]*w:val="([A-Fa-f0-9]{6})"/);
      const color = colorMatch ? colorMatch[1] : undefined;

      const szMatch = rXml.match(/<w:sz\s+[^>]*w:val="(\d+)"/);
      const fontSize = szMatch ? parseInt(szMatch[1], 10) / 2 : undefined;

      const tMatches = rXml.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [];
      const rText = tMatches
        .map((m) => m.replace(/<[^>]+>/g, ''))
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
  }

  return { paragraphs, tables, elements };
}

function generateHtmlFromDocx(
  paragraphs: DocxParagraph[],
  tables: DocxTable[],
  title: string,
  elements?: DocxBlockElement[]
): string {
  let body = '';

  const renderParagraph = (p: DocxParagraph): string => {
    let pContent = '';
    for (const r of (p.runs || [])) {
      let t = escapeHtml(r.text);
      if (r.isBold) t = `<strong>${t}</strong>`;
      if (r.isItalic) t = `<em>${t}</em>`;
      if (r.isUnderline) t = `<u>${t}</u>`;
      if (r.isStrike) t = `<del>${t}</del>`;
      if (r.color) t = `<span style="color:#${r.color}">${t}</span>`;
      pContent += t;
    }
    if (!pContent) pContent = escapeHtml(p.text);

    if (p.isHeading) {
      const hTag = `h${p.headingLevel || 2}`;
      return `<${hTag}>${pContent}</${hTag}>\n`;
    }
    if (p.isBullet) {
      return `<ul><li>${pContent}</li></ul>\n`;
    }
    const alignStyle = p.alignment ? ` style="text-align:${p.alignment}"` : '';
    return `<p${alignStyle}>${pContent}</p>\n`;
  };

  const renderTable = (tbl: DocxTable): string => {
    let tblHtml = '<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;margin:1.5rem 0;width:100%;border-color:#CCD2FC;">\n';
    tbl.rows.forEach((row, rIdx) => {
      tblHtml += '<tr>\n';
      row.forEach((cell) => {
        if (rIdx === 0) {
          tblHtml += `  <th style="background:#F0F2FE;color:#1F2340;padding:8px;text-align:left;">${escapeHtml(cell)}</th>\n`;
        } else {
          tblHtml += `  <td style="padding:8px;border:1px solid #E1E4EE;">${escapeHtml(cell)}</td>\n`;
        }
      });
      tblHtml += '</tr>\n';
    });
    tblHtml += '</table>\n';
    return tblHtml;
  };

  if (elements && elements.length > 0) {
    for (const el of elements) {
      if (el.type === 'paragraph') body += renderParagraph(el.paragraph);
      else if (el.type === 'table') body += renderTable(el.table);
    }
  } else {
    for (const p of paragraphs) body += renderParagraph(p);
    for (const tbl of tables) body += renderTable(tbl);
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(
    title
  )}</title><style>body{font-family:system-ui,-apple-system,sans-serif;line-height:1.6;max-width:850px;margin:2rem auto;padding:0 1.5rem;color:#1F2340;}h1,h2,h3{color:#5C6BC0;}</style></head><body><h1>${escapeHtml(
    title
  )}</h1>${body}</body></html>`;
}

function generateMarkdownFromDocx(
  paragraphs: DocxParagraph[],
  tables: DocxTable[],
  elements?: DocxBlockElement[]
): string {
  const parts: string[] = [];

  const renderParagraph = (p: DocxParagraph): string => {
    if (p.isHeading) {
      const hashes = '#'.repeat(p.headingLevel || 2);
      return `${hashes} ${p.text}`;
    }
    if (p.isBullet) {
      return `- ${p.text}`;
    }
    let t = '';
    for (const r of (p.runs || [])) {
      let rText = r.text;
      if (r.isBold) rText = `**${rText}**`;
      if (r.isItalic) rText = `*${rText}*`;
      if (r.isStrike) rText = `~~${rText}~~`;
      t += rText;
    }
    return t || p.text;
  };

  const renderTable = (tbl: DocxTable): string => {
    if (tbl.rows.length === 0) return '';
    const header = `| ${tbl.rows[0].join(' | ')} |`;
    const sep = `| ${tbl.rows[0].map(() => '---').join(' | ')} |`;
    const body = tbl.rows
      .slice(1)
      .map((r) => `| ${r.join(' | ')} |`)
      .join('\n');
    return `${header}\n${sep}\n${body}`;
  };

  if (elements && elements.length > 0) {
    for (const el of elements) {
      if (el.type === 'paragraph') parts.push(renderParagraph(el.paragraph));
      else if (el.type === 'table') parts.push(renderTable(el.table));
    }
  } else {
    for (const p of paragraphs) parts.push(renderParagraph(p));
    for (const tbl of tables) parts.push(renderTable(tbl));
  }

  return parts.join('\n\n');
}

async function generatePdfFromDocx(
  paragraphs: DocxParagraph[],
  tables: DocxTable[],
  options: ConversionOptions,
  title: string,
  elements?: DocxBlockElement[]
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

    const renderTable = (tbl: DocxTable) => {
      if (tbl.rows.length === 0) return;
      doc.moveDown(0.8);
      const colCount = Math.max(1, tbl.colCount || tbl.rows[0].length);
      const colWidth = (doc.page.width - 100) / colCount;

      tbl.rows.forEach((row, rIdx) => {
        const y = doc.y;
        if (y > doc.page.height - 80) {
          doc.addPage();
        }
        const isHdr = rIdx === 0;
        doc.rect(50, doc.y, doc.page.width - 100, 20).strokeColor('#CCD2FC').lineWidth(0.5);
        if (isHdr) {
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
      doc.moveDown(0.4);
    };

    const renderParagraph = (p: DocxParagraph) => {
      if (p.isHeading) {
        doc.moveDown(0.5);
        doc.fillColor('#5C6BC0').fontSize(p.headingLevel === 1 ? 16 : 14).text(p.text);
        doc.moveDown(0.25);
      } else {
        doc.fillColor(p.isBold ? '#1F2340' : '#4D536B').fontSize(10.5).lineGap(3).text(p.text, {
          align: p.alignment === 'center' ? 'center' : p.alignment === 'right' ? 'right' : 'left',
        });
        doc.moveDown(0.4);
      }
    };

    if (elements && elements.length > 0) {
      for (const el of elements) {
        if (el.type === 'paragraph') renderParagraph(el.paragraph);
        else if (el.type === 'table') renderTable(el.table);
      }
    } else {
      for (const p of paragraphs) renderParagraph(p);
      for (const tbl of tables) renderTable(tbl);
    }

    doc.end();
  });
}

export type CellResolver = (cellRef: string) => any;

type FormulaTokenType =
  | 'NUMBER'
  | 'STRING'
  | 'BOOLEAN'
  | 'RANGE'
  | 'CELL_REF'
  | 'FUNCTION'
  | 'OP'
  | 'OP_COMP'
  | 'LPAREN'
  | 'RPAREN'
  | 'COMMA';

interface FormulaToken {
  type: FormulaTokenType;
  val: any;
}

/**
 * Pure TypeScript Spreadsheet Formula Evaluator
 * Supports basic arithmetic (+, -, *, /, ^, %, &), comparisons (=, <>, <, <=, >, >=),
 * cell references/ranges (A1, $B$2, A1:B10), and common functions (SUM, AVERAGE, COUNT, MIN, MAX, IF).
 */
export class SpreadsheetFormulaEvaluator {
  constructor(private cellLookup: CellResolver) {}

  public evaluate(formula: string): any {
    if (formula.startsWith('=')) formula = formula.slice(1);
    const tokens = this.tokenize(formula);
    let pos = 0;

    const peek = (): FormulaToken | undefined => tokens[pos];
    const consume = (expectedType?: FormulaTokenType): FormulaToken => {
      const t = tokens[pos];
      if (!t) throw new Error('Unexpected end of formula');
      if (expectedType && t.type !== expectedType) throw new Error(`Expected ${expectedType} but got ${t.type}`);
      pos++;
      return t;
    };

    const parseComparison = (): any => {
      let left = parseConcat();
      while (peek() && peek()!.type === 'OP_COMP') {
        const op = consume().val;
        const right = parseConcat();
        if (op === '=') left = left == right;
        else if (op === '<>') left = left != right;
        else if (op === '<') left = left < right;
        else if (op === '<=') left = left <= right;
        else if (op === '>') left = left > right;
        else if (op === '>=') left = left >= right;
      }
      return left;
    };

    const parseConcat = (): any => {
      let left = parseAdditive();
      while (peek() && peek()!.type === 'OP' && peek()!.val === '&') {
        consume();
        const right = parseAdditive();
        left = String(left ?? '') + String(right ?? '');
      }
      return left;
    };

    const parseAdditive = (): any => {
      let left = parseMultiplicative();
      while (peek() && peek()!.type === 'OP' && (peek()!.val === '+' || peek()!.val === '-')) {
        const op = consume().val;
        const right = parseMultiplicative();
        left = op === '+' ? Number(left) + Number(right) : Number(left) - Number(right);
      }
      return left;
    };

    const parseMultiplicative = (): any => {
      let left = parsePower();
      while (peek() && peek()!.type === 'OP' && (peek()!.val === '*' || peek()!.val === '/')) {
        const op = consume().val;
        const right = parsePower();
        left = op === '*' ? Number(left) * Number(right) : Number(left) / Number(right);
      }
      return left;
    };

    const parsePower = (): any => {
      let left = parseUnary();
      while (peek() && peek()!.type === 'OP' && peek()!.val === '^') {
        consume();
        const right = parseUnary();
        left = Math.pow(Number(left), Number(right));
      }
      return left;
    };

    const parseUnary = (): any => {
      if (peek() && peek()!.type === 'OP' && (peek()!.val === '+' || peek()!.val === '-')) {
        const op = consume().val;
        const operand = parseUnary();
        return op === '-' ? -Number(operand) : Number(operand);
      }
      let val = parsePrimary();
      if (peek() && peek()!.type === 'OP' && peek()!.val === '%') {
        consume();
        val = Number(val) / 100;
      }
      return val;
    };

    const parsePrimary = (): any => {
      const t = peek();
      if (!t) throw new Error('Unexpected end of expression');
      if (t.type === 'NUMBER' || t.type === 'STRING' || t.type === 'BOOLEAN') {
        consume();
        return t.val;
      }
      if (t.type === 'LPAREN') {
        consume();
        const val = parseComparison();
        consume('RPAREN');
        return val;
      }
      if (t.type === 'FUNCTION') {
        return parseFunctionCall();
      }
      if (t.type === 'RANGE') {
        consume();
        return this.resolveRange(t.val);
      }
      if (t.type === 'CELL_REF') {
        consume();
        return this.cellLookup(t.val);
      }
      throw new Error(`Unexpected token: ${t.type} (${t.val})`);
    };

    const parseFunctionCall = (): any => {
      const fnName = String(consume('FUNCTION').val).toUpperCase();
      consume('LPAREN');
      const args: any[] = [];
      if (!peek() || peek()!.type !== 'RPAREN') {
        while (true) {
          args.push(parseComparison());
          if (peek() && peek()!.type === 'COMMA') {
            consume();
          } else {
            break;
          }
        }
      }
      consume('RPAREN');
      return this.executeFunction(fnName, args);
    };

    return parseComparison();
  }

  private resolveRange(rangeStr: string): any[] {
    const [start, end] = rangeStr.split(':');
    const match1 = start.match(/^(\$?)([A-Za-z]+)(\$?)([0-9]+)$/);
    const match2 = end.match(/^(\$?)([A-Za-z]+)(\$?)([0-9]+)$/);
    if (!match1 || !match2) return [];

    const colToNum = (s: string): number => {
      let c = 0;
      for (let i = 0; i < s.length; i++) c = c * 26 + (s.charCodeAt(i) - 64);
      return c;
    };

    const c1 = colToNum(match1[2].toUpperCase());
    const r1 = Number.parseInt(match1[4], 10);
    const c2 = colToNum(match2[2].toUpperCase());
    const r2 = Number.parseInt(match2[4], 10);
    const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
    const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);

    const values: any[] = [];
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        let colName = '';
        let temp = c;
        while (temp > 0) {
          colName = String.fromCharCode(65 + ((temp - 1) % 26)) + colName;
          temp = Math.floor((temp - 1) / 26);
        }
        values.push(this.cellLookup(`${colName}${r}`));
      }
    }
    return values;
  }

  private executeFunction(name: string, args: any[]): any {
    const flattenNumbers = (arr: any[]): number[] => {
      const out: number[] = [];
      const walk = (item: any) => {
        if (Array.isArray(item)) {
          item.forEach(walk);
        } else if (item !== null && item !== undefined && item !== '' && !Number.isNaN(Number(item))) {
          out.push(Number(item));
        }
      };
      walk(arr);
      return out;
    };

    switch (name) {
      case 'SUM': {
        const nums = flattenNumbers(args);
        return nums.reduce((a, b) => a + b, 0);
      }
      case 'AVERAGE': {
        const nums = flattenNumbers(args);
        return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length;
      }
      case 'COUNT': {
        const nums = flattenNumbers(args);
        return nums.length;
      }
      case 'MIN': {
        const nums = flattenNumbers(args);
        return nums.length === 0 ? 0 : Math.min(...nums);
      }
      case 'MAX': {
        const nums = flattenNumbers(args);
        return nums.length === 0 ? 0 : Math.max(...nums);
      }
      case 'IF': {
        const cond = Boolean(args[0]);
        return cond ? args[1] : args.length > 2 ? args[2] : false;
      }
      default:
        throw new Error(`Unsupported spreadsheet function: ${name}`);
    }
  }

  private tokenize(expr: string): FormulaToken[] {
    const tokens: FormulaToken[] = [];
    let i = 0;
    while (i < expr.length) {
      const ch = expr[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (ch === '(') { tokens.push({ type: 'LPAREN', val: '(' }); i++; continue; }
      if (ch === ')') { tokens.push({ type: 'RPAREN', val: ')' }); i++; continue; }
      if (ch === ',') { tokens.push({ type: 'COMMA', val: ',' }); i++; continue; }
      if (ch === '"') {
        let str = '';
        i++;
        while (i < expr.length) {
          if (expr[i] === '"') {
            if (i + 1 < expr.length && expr[i + 1] === '"') { str += '"'; i += 2; }
            else { i++; break; }
          } else { str += expr[i++]; }
        }
        tokens.push({ type: 'STRING', val: str });
        continue;
      }
      if (ch === '<' || ch === '>' || ch === '=') {
        let op = ch;
        if (i + 1 < expr.length && ((ch === '<' && (expr[i + 1] === '>' || expr[i + 1] === '=')) || (ch === '>' && expr[i + 1] === '='))) {
          op += expr[i + 1];
          i += 2;
        } else {
          i++;
        }
        tokens.push({ type: 'OP_COMP', val: op });
        continue;
      }
      if ('+-*/^%&'.includes(ch)) {
        tokens.push({ type: 'OP', val: ch });
        i++;
        continue;
      }
      if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(expr[i + 1]))) {
        const match = expr.slice(i).match(/^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/)!;
        tokens.push({ type: 'NUMBER', val: Number.parseFloat(match[0]) });
        i += match[0].length;
        continue;
      }
      const rangeMatch = expr.slice(i).match(/^(\$?[A-Za-z]+)(\$?)([0-9]+):(\$?[A-Za-z]+)(\$?)([0-9]+)/);
      if (rangeMatch) {
        tokens.push({ type: 'RANGE', val: rangeMatch[0] });
        i += rangeMatch[0].length;
        continue;
      }
      const cellMatch = expr.slice(i).match(/^(\$?[A-Za-z]+)(\$?)([0-9]+)/);
      if (cellMatch && expr[i + cellMatch[0].length] !== '(') {
        tokens.push({ type: 'CELL_REF', val: cellMatch[0] });
        i += cellMatch[0].length;
        continue;
      }
      const fnMatch = expr.slice(i).match(/^[A-Za-z_][A-Za-z0-9_.]*/);
      if (fnMatch) {
        const str = fnMatch[0];
        const nextChar = expr[i + str.length];
        if (nextChar === '(') {
          tokens.push({ type: 'FUNCTION', val: str });
        } else if (str.toUpperCase() === 'TRUE') {
          tokens.push({ type: 'BOOLEAN', val: true });
        } else if (str.toUpperCase() === 'FALSE') {
          tokens.push({ type: 'BOOLEAN', val: false });
        } else {
          tokens.push({ type: 'CELL_REF', val: str });
        }
        i += str.length;
        continue;
      }
      throw new Error(`Unexpected character: "${ch}" at index ${i}`);
    }
    return tokens;
  }
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
  const cellMap: Record<string, any> = {};
  const formulaCells: Array<{ ref: string; formula: string; rowIdx: number; colIdx: number }> = [];

  const rowRegex = /<row[\s\S]*?<\/row>/g;
  let rMatch: RegExpExecArray | null;

  while ((rMatch = rowRegex.exec(sheetXml)) !== null) {
    const rowXml = rMatch[0];
    const cells: string[] = [];
    const cellRegex = /<c\s+([^>]*?)>([\s\S]*?)<\/c>/g;
    let cMatch: RegExpExecArray | null;
    const rowIdx = rows.length;

    while ((cMatch = cellRegex.exec(rowXml)) !== null) {
      const attrs = cMatch[1];
      const body = cMatch[2];
      const isString = /t="s"/.test(attrs);
      const isInline = /t="inlineStr"/.test(attrs);
      const vMatch = body.match(/<v>([\s\S]*?)<\/v>/);
      const tMatch = body.match(/<t[^>]*>([\s\S]*?)<\/t>/);
      const fMatch = body.match(/<f[^>]*>([\s\S]*?)<\/f>/);
      const rRefMatch = attrs.match(/r="([A-Za-z0-9]+)"/);
      const ref = rRefMatch ? rRefMatch[1].toUpperCase() : '';

      let cellValue = '';
      if (isInline && tMatch) {
        cellValue = tMatch[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      } else if (vMatch) {
        const val = vMatch[1];
        if (isString) {
          const strIdx = Number.parseInt(val, 10);
          cellValue = sharedStrings[strIdx] ?? '';
        } else {
          cellValue = val;
        }
      } else if (tMatch) {
        cellValue = tMatch[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      }

      if (ref) {
        cellMap[ref] = cellValue;
      }

      const colIdx = cells.length;
      if (fMatch && (!cellValue || cellValue.trim() === '')) {
        formulaCells.push({ ref, formula: fMatch[1], rowIdx, colIdx });
      }

      cells.push(cellValue);
    }
    if (cells.length > 0) rows.push(cells);
  }

  // Evaluate dynamic formulas if any values were missing
  if (formulaCells.length > 0) {
    const evaluator = new SpreadsheetFormulaEvaluator((ref) => {
      const cleanRef = ref.replace(/\$/g, '').toUpperCase();
      return cellMap[cleanRef] ?? 0;
    });

    for (const fc of formulaCells) {
      try {
        const result = evaluator.evaluate(fc.formula);
        const strResult = result !== null && result !== undefined ? String(result) : '';
        if (rows[fc.rowIdx] && fc.colIdx < rows[fc.rowIdx].length) {
          rows[fc.rowIdx][fc.colIdx] = strResult;
        }
        if (fc.ref) {
          cellMap[fc.ref] = result;
        }
      } catch {
        // Fallback to empty if formula syntax is complex
      }
    }
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

  // XLSX -> ODS
  if (tgt === 'ods') {
    const odsBuffer = await generateOdsFromData(rows, baseName);
    return {
      buffer: odsBuffer,
      mimeType: 'application/vnd.oasis.opendocument.spreadsheet',
      filename: `${baseName}.ods`,
      size: odsBuffer.length,
    };
  }

  // XLSX -> XLS
  if (tgt === 'xls') {
    const xlsContent = generateXlsXmlFromData(rows, baseName);
    const buffer = Buffer.from(xlsContent, 'utf-8');
    return {
      buffer,
      mimeType: 'application/vnd.ms-excel',
      filename: `${baseName}.xls`,
      size: buffer.length,
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

  // PPTX -> ODP
  if (tgt === 'odp') {
    const odpBuffer = await generateOdpFromSlides(slides, baseName);
    return {
      buffer: odpBuffer,
      mimeType: 'application/vnd.oasis.opendocument.presentation',
      filename: `${baseName}.odp`,
      size: odpBuffer.length,
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

  if (tgt === 'docx') {
    const text = slides.map((s) => `# Slide ${s.number}\n\n` + s.texts.join('\n')).join('\n\n---\n\n');
    const docxBuffer = await generateDocxFromText(text, 'odp', options, baseName);
    return {
      buffer: docxBuffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      filename: `${baseName}.docx`,
      size: docxBuffer.length,
    };
  }

  if (tgt === 'odp') {
    return {
      buffer: inputBuffer,
      mimeType: 'application/vnd.oasis.opendocument.presentation',
      filename: `${baseName}.odp`,
      size: inputBuffer.length,
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

  // Parse title and author
  const titleMatch = xml.match(/<book-title>([\s\S]*?)<\/book-title>/);
  const bookTitle = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : baseName;

  const authorMatch = xml.match(/<author>([\s\S]*?)<\/author>/);
  let authorStr = '';
  if (authorMatch) {
    const fn = (authorMatch[1].match(/<first-name>([\s\S]*?)<\/first-name>/) || [])[1] || '';
    const ln = (authorMatch[1].match(/<last-name>([\s\S]*?)<\/last-name>/) || [])[1] || '';
    authorStr = `${fn.replace(/<[^>]+>/g, '').trim()} ${ln.replace(/<[^>]+>/g, '').trim()}`.trim();
  }

  // Parse tables (<table ...>)
  const tables: string[][][] = [];
  const tblRegex = /<table[\s\S]*?<\/table>/g;
  let tMatch: RegExpExecArray | null;
  while ((tMatch = tblRegex.exec(xml)) !== null) {
    const tblXml = tMatch[0];
    const trRegex = /<tr[\s\S]*?<\/tr>/g;
    let trMatch: RegExpExecArray | null;
    const currentTbl: string[][] = [];
    while ((trMatch = trRegex.exec(tblXml)) !== null) {
      const cellRegex = /<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/g;
      let cMatch: RegExpExecArray | null;
      const row: string[] = [];
      while ((cMatch = cellRegex.exec(trMatch[0])) !== null) {
        row.push(cMatch[1].replace(/<[^>]+>/g, '').trim());
      }
      if (row.length > 0) currentTbl.push(row);
    }
    if (currentTbl.length > 0) tables.push(currentTbl);
  }

  // Parse paragraphs (<p>)
  const pRegex = /<p>([\s\S]*?)<\/p>/g;
  const paragraphs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pRegex.exec(xml)) !== null) {
    const text = m[1].replace(/<[^>]+>/g, '').trim();
    if (text) paragraphs.push(text);
  }

  const fullText = paragraphs.join('\n\n');

  if (tgt === 'fb2') {
    return { buffer: inputBuffer, mimeType: 'application/x-fictionbook+xml', filename: `${baseName}.fb2`, size: inputBuffer.length };
  }

  if (tgt === 'txt') {
    let outText = fullText;
    if (tables.length > 0) {
      outText += '\n\n' + tables.map((t) => t.map((r) => r.join('\t')).join('\n')).join('\n\n');
    }
    const buffer = Buffer.from(outText, 'utf-8');
    return { buffer, mimeType: 'text/plain', filename: `${baseName}.txt`, size: buffer.length };
  }

  if (tgt === 'html') {
    let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(bookTitle)}</title>`;
    html += `<style>body{font-family:system-ui,-apple-system,sans-serif;line-height:1.7;max-width:800px;margin:2rem auto;padding:0 1.5rem;color:#1F2340;}h1{color:#5C6BC0;}table{border-collapse:collapse;width:100%;margin:1.5rem 0;}th,td{border:1px solid #CCD2FC;padding:8px 12px;text-align:left;}th{background:#F0F2FE;}</style></head><body>`;
    html += `<h1>${escapeHtml(bookTitle)}</h1>`;
    if (authorStr) html += `<p><em>${escapeHtml(authorStr)}</em></p>`;
    html += paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n');
    for (const t of tables) {
      html += '<table>';
      t.forEach((row, rIdx) => {
        html += '<tr>' + row.map((c) => `<${rIdx === 0 ? 'th' : 'td'}>${escapeHtml(c)}</${rIdx === 0 ? 'th' : 'td'}>`).join('') + '</tr>';
      });
      html += '</table>';
    }
    html += '</body></html>';
    const buffer = Buffer.from(html, 'utf-8');
    return { buffer, mimeType: 'text/html', filename: `${baseName}.html`, size: buffer.length };
  }

  if (tgt === 'md') {
    let md = `# ${bookTitle}\n\n`;
    if (authorStr) md += `*${authorStr}*\n\n`;
    md += fullText;
    for (const t of tables) {
      if (t.length > 0) {
        md += `\n\n| ${t[0].join(' | ')} |\n| ${t[0].map(() => '---').join(' | ')} |\n` + t.slice(1).map((r) => `| ${r.join(' | ')} |`).join('\n');
      }
    }
    const buffer = Buffer.from(md, 'utf-8');
    return { buffer, mimeType: 'text/markdown', filename: `${baseName}.md`, size: buffer.length };
  }

  if (tgt === 'epub') {
    let md = `# ${bookTitle}\n\n` + fullText;
    for (const t of tables) {
      if (t.length > 0) {
        md += `\n\n| ${t[0].join(' | ')} |\n| ${t[0].map(() => '---').join(' | ')} |\n` + t.slice(1).map((r) => `| ${r.join(' | ')} |`).join('\n');
      }
    }
    const epubBuffer = await generateEpubFromText(md, 'fb2', options, bookTitle);
    return { buffer: epubBuffer, mimeType: 'application/epub+zip', filename: `${baseName}.epub`, size: epubBuffer.length };
  }

  if (tgt === 'docx') {
    let md = `# ${bookTitle}\n\n` + fullText;
    for (const t of tables) {
      if (t.length > 0) {
        md += `\n\n| ${t[0].join(' | ')} |\n| ${t[0].map(() => '---').join(' | ')} |\n` + t.slice(1).map((r) => `| ${r.join(' | ')} |`).join('\n');
      }
    }
    const docxBuffer = await generateDocxFromText(md, 'fb2', options, bookTitle);
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
    if (authorStr) {
      doc.moveDown(0.3);
      doc.fillColor('#5C6BC0').fontSize(12).text(authorStr);
    }
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
 * Generates authentic HWP 5.0 CFBF compound document from text and markdown tables
 */
export function generateHwpFromText(text: string, title: string): Buffer {
  const lines = text.split(/\r?\n/);
  const paragraphs: { text: string; isHeading?: boolean }[] = [];
  const tables: { rows: string[][] }[] = [];
  let currentTableRows: string[][] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      if (currentTableRows.length > 0) {
        tables.push({ rows: currentTableRows });
        currentTableRows = [];
      }
      continue;
    }

    // Markdown table row
    if (line.startsWith('|') && line.endsWith('|')) {
      const cells = line.split('|').map((c) => c.trim()).slice(1, -1);
      if (cells.every((c) => /^[-:]+$/.test(c))) {
        continue;
      }
      currentTableRows.push(cells);
      continue;
    }

    if (currentTableRows.length > 0) {
      tables.push({ rows: currentTableRows });
      currentTableRows = [];
    }

    // Heading detection
    if (line.startsWith('#')) {
      const headingText = line.replace(/^#+\s*/, '').trim();
      if (headingText) {
        paragraphs.push({ text: headingText, isHeading: true });
      }
    } else {
      paragraphs.push({ text: line, isHeading: paragraphs.length === 0 && line.length < 60 });
    }
  }

  if (currentTableRows.length > 0) {
    tables.push({ rows: currentTableRows });
  }

  if (paragraphs.length === 0) {
    paragraphs.push({ text: title || 'Document', isHeading: true });
  }

  return buildHwpCompoundFile({ paragraphs, tables, compressed: true });
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
export async function generateXlsxFromData(
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
 * Generates IDPF EPUB Container with EPUB 3 Navigation & NCX Semantic Markup
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

  const lines = text.split(/\r?\n/);
  const bodyElements: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      i++;
      continue;
    }

    // Markdown Table
    if (trimmed.startsWith('|') && trimmed.endsWith('|') && i + 1 < lines.length && lines[i + 1].trim().startsWith('|')) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
        tableLines.push(lines[i].trim());
        i++;
      }
      if (tableLines.length >= 2) {
        let tbl = '<table class="semantic-table">\n';
        const headers = tableLines[0].split('|').slice(1, -1).map((c) => c.trim());
        tbl += '  <thead>\n    <tr>\n' + headers.map((h) => `      <th>${escapeXml(h)}</th>\n`).join('') + '    </tr>\n  </thead>\n  <tbody>\n';
        const rows = tableLines.slice(2).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
        for (const r of rows) {
          tbl += '    <tr>\n' + r.map((c) => `      <td>${escapeXml(c)}</td>\n`).join('') + '    </tr>\n';
        }
        tbl += '  </tbody>\n</table>';
        bodyElements.push(tbl);
        continue;
      }
    }

    // Headings & Blockquotes
    if (trimmed.startsWith('# ')) {
      bodyElements.push(`<h1>${escapeXml(trimmed.slice(2))}</h1>`);
    } else if (trimmed.startsWith('## ')) {
      bodyElements.push(`<h2>${escapeXml(trimmed.slice(3))}</h2>`);
    } else if (trimmed.startsWith('### ')) {
      bodyElements.push(`<h3>${escapeXml(trimmed.slice(4))}</h3>`);
    } else if (trimmed.startsWith('> ')) {
      bodyElements.push(`<blockquote><p>${escapeXml(trimmed.slice(2))}</p></blockquote>`);
    } else {
      bodyElements.push(`<p>${escapeXml(trimmed)}</p>`);
    }
    i++;
  }

  const contentHtml = bodyElements.join('\n');

  // Stylesheet
  zip.file(
    'OEBPS/styles.css',
    `body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Georgia, serif; line-height: 1.7; padding: 1.5rem; color: #1F2340; }
h1, h2, h3 { color: #5C6BC0; font-weight: 600; margin-top: 1.5rem; margin-bottom: 0.8rem; }
p { margin-bottom: 1rem; text-align: justify; }
table.semantic-table { border-collapse: collapse; width: 100%; margin: 1.5rem 0; }
table.semantic-table th, table.semantic-table td { border: 1px solid #CCD2FC; padding: 8px 12px; text-align: left; }
table.semantic-table th { background-color: #F0F2FE; color: #1F2340; font-weight: 600; }
blockquote { border-left: 4px solid #5C6BC0; margin: 1.5rem 0; padding: 0.5rem 1rem; color: #4D536B; background: #F8F9FE; }`
  );

  // Chapter 1 XHTML with semantic markup
  zip.file(
    'OEBPS/chapter1.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
  <title>${escapeXml(title)}</title>
  <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
  <header>
    <h1>${escapeXml(title)}</h1>
  </header>
  <main>
    <article>
      ${contentHtml}
    </article>
  </main>
</body>
</html>`
  );

  // Navigation document (EPUB 3)
  zip.file(
    'OEBPS/nav.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head>
  <title>Navigation</title>
  <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Table of Contents</h1>
    <ol>
      <li><a href="chapter1.xhtml">${escapeXml(title)}</a></li>
    </ol>
  </nav>
</body>
</html>`
  );

  // NCX (EPUB 2 backward compatibility for all e-readers)
  zip.file(
    'OEBPS/toc.ncx',
    `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:easyconvert-book"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escapeXml(title)}</text></docTitle>
  <navMap>
    <navPoint id="navpoint-1" playOrder="1">
      <navLabel><text>${escapeXml(title)}</text></navLabel>
      <content src="chapter1.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`
  );

  // Package manifest (content.opf)
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:language>en</dc:language>
    <dc:identifier id="BookId">urn:uuid:easyconvert-book</dc:identifier>
    <dc:creator>EasyConvert Ebook Engine</dc:creator>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
  </metadata>
  <manifest>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="styles.css" media-type="text/css"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="chapter1"/>
  </spine>
</package>`
  );

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Generates valid, semantic FictionBook 2.0 (FB2) electronic book XML
 */
export function generateFb2FromText(
  text: string,
  title: string,
  options: ConversionOptions = {}
): Buffer {
  const lines = text.split(/\r?\n/);
  const sections: { title?: string; paragraphs: string[]; table?: string[][] }[] = [];
  let currentSection: { title?: string; paragraphs: string[]; table?: string[][] } = {
    paragraphs: [],
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // Markdown Table check
    if (trimmed.startsWith('|') && trimmed.endsWith('|') && i + 1 < lines.length && lines[i + 1].trim().startsWith('|')) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
        tableLines.push(lines[i].trim());
        i++;
      }
      if (tableLines.length >= 2) {
        const rows = tableLines
          .filter((_, idx) => idx !== 1)
          .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
        currentSection.table = rows;
        continue;
      }
    }

    // Heading check
    if (trimmed.startsWith('# ') || trimmed.startsWith('## ') || trimmed.startsWith('### ')) {
      const hText = trimmed.replace(/^#+\s*/, '');
      if (currentSection.paragraphs.length > 0 || currentSection.title || currentSection.table) {
        sections.push(currentSection);
      }
      currentSection = { title: hText, paragraphs: [] };
      i++;
      continue;
    }

    currentSection.paragraphs.push(trimmed);
    i++;
  }

  if (currentSection.paragraphs.length > 0 || currentSection.title || currentSection.table) {
    sections.push(currentSection);
  }

  if (sections.length === 0) {
    sections.push({ title, paragraphs: [text.trim() || 'Electronic Book Content'] });
  }

  let bodyXml = `    <title><p>${escapeXml(title)}</p></title>\n`;
  for (const sec of sections) {
    bodyXml += `    <section>\n`;
    if (sec.title) {
      bodyXml += `      <title><p>${escapeXml(sec.title)}</p></title>\n`;
    }
    for (const p of sec.paragraphs) {
      bodyXml += `      <p>${escapeXml(p)}</p>\n`;
    }
    if (sec.table && sec.table.length > 0) {
      bodyXml += `      <table>\n`;
      sec.table.forEach((row, rIdx) => {
        bodyXml += `        <tr>\n`;
        const tag = rIdx === 0 ? 'th' : 'td';
        row.forEach((cell) => {
          bodyXml += `          <${tag}>${escapeXml(cell)}</${tag}>\n`;
        });
        bodyXml += `        </tr>\n`;
      });
      bodyXml += `      </table>\n`;
    }
    bodyXml += `    </section>\n`;
  }

  const dateStr = new Date().toISOString().split('T')[0];
  const fb2 = `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
  <description>
    <title-info>
      <genre>prose</genre>
      <author>
        <first-name>EasyConvert</first-name>
        <last-name>Author</last-name>
      </author>
      <book-title>${escapeXml(title)}</book-title>
      <date>${dateStr}</date>
      <lang>en</lang>
    </title-info>
  </description>
  <body>
${bodyXml}  </body>
</FictionBook>`;

  return Buffer.from(fb2, 'utf-8');
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * OpenDocument Spreadsheet (ODS) Parser & Converter
 */
export async function convertOdsSource(
  inputBuffer: Buffer,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  const zip = await JSZip.loadAsync(inputBuffer);
  const contentXml = zip.file('content.xml');
  if (!contentXml) {
    throw new Error('Invalid ODS workbook: content.xml not found.');
  }

  const xml = await contentXml.async('text');
  const rows: string[][] = [];
  const rowRegex = /<table:table-row[\s\S]*?<\/table:table-row>/g;
  let rMatch: RegExpExecArray | null;

  while ((rMatch = rowRegex.exec(xml)) !== null) {
    const rowXml = rMatch[0];
    const cells: string[] = [];
    const cellRegex = /<table:table-cell[\s\S]*?<\/table:table-cell>/g;
    let cMatch: RegExpExecArray | null;

    while ((cMatch = cellRegex.exec(rowXml)) !== null) {
      const cellXml = cMatch[0];
      const pMatch = cellXml.match(/<text:p>([\s\S]*?)<\/text:p>/);
      const text = pMatch ? pMatch[1].replace(/<[^>]+>/g, '').trim() : '';

      const repeatMatch = cellXml.match(/table:number-columns-repeated="(\d+)"/);
      const repeat = repeatMatch ? Math.min(50, parseInt(repeatMatch[1], 10)) : 1;
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
    const csv = rows
      .map((r) =>
        r.map((c) => (c.includes(delim) || c.includes('"') ? `"${c.replace(/"/g, '""')}"` : c)).join(delim)
      )
      .join('\n');
    const buffer = Buffer.from(csv, 'utf-8');
    return { buffer, mimeType: 'text/csv', filename: `${baseName}.csv`, size: buffer.length };
  }

  // ODS -> TSV
  if (tgt === 'tsv') {
    const tsv = rows.map((r) => r.join('\t')).join('\n');
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
    const csv = rows.map((r) => r.join(',')).join('\n');
    const xlsxBuffer = await generateXlsxFromData(Buffer.from(csv, 'utf-8'), 'csv', options, baseName);
    return {
      buffer: xlsxBuffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename: `${baseName}.xlsx`,
      size: xlsxBuffer.length,
    };
  }

  // ODS -> XLS
  if (tgt === 'xls') {
    const xls = generateXlsXmlFromData(rows, baseName);
    const buffer = Buffer.from(xls, 'utf-8');
    return { buffer, mimeType: 'application/vnd.ms-excel', filename: `${baseName}.xls`, size: buffer.length };
  }

  // ODS -> HTML
  if (tgt === 'html') {
    let tableHtml = '<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%;border-color:#CCD2FC;">\n';
    rows.forEach((r, idx) => {
      tableHtml += '<tr>\n';
      r.forEach((c) => {
        tableHtml +=
          idx === 0
            ? `  <th style="background:#F0F2FE;color:#1F2340;padding:8px;text-align:left;">${escapeHtml(c)}</th>\n`
            : `  <td style="padding:8px;border:1px solid #E1E4EE;">${escapeHtml(c)}</td>\n`;
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

  throw new Error(`Unsupported conversion from ODS to ${tgt}`);
}

/**
 * Excel XLS Parser & Converter
 */
export async function convertXlsSource(
  inputBuffer: Buffer,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  const text = inputBuffer.toString('utf-8');
  const rows: string[][] = [];

  // Parse Excel XML Spreadsheet (<Row><Cell><Data ...>)
  if (text.includes('<Row') || text.includes('<row')) {
    const rowRegex = /<Row[\s\S]*?<\/Row>/gi;
    let rMatch: RegExpExecArray | null;
    while ((rMatch = rowRegex.exec(text)) !== null) {
      const rowXml = rMatch[0];
      const cells: string[] = [];
      const cellRegex = /<Data[^>]*>([\s\S]*?)<\/Data>/gi;
      let cMatch: RegExpExecArray | null;
      while ((cMatch = cellRegex.exec(rowXml)) !== null) {
        cells.push(cMatch[1].replace(/<[^>]+>/g, '').trim());
      }
      if (cells.length > 0) rows.push(cells);
    }
  }

  if (rows.length === 0) {
    text.split(/\r?\n/).forEach((l) => {
      const trimmed = l.trim();
      if (trimmed) rows.push(trimmed.split('\t'));
    });
  }

  if (rows.length === 0) {
    rows.push(['Data'], ['XLS spreadsheet content']);
  }

  if (tgt === 'csv') {
    const delim = options.delimiter || ',';
    const csv = rows.map((r) => r.join(delim)).join('\n');
    const buffer = Buffer.from(csv, 'utf-8');
    return { buffer, mimeType: 'text/csv', filename: `${baseName}.csv`, size: buffer.length };
  }

  if (tgt === 'xlsx') {
    const csv = rows.map((r) => r.join(',')).join('\n');
    const xlsxBuffer = await generateXlsxFromData(Buffer.from(csv, 'utf-8'), 'csv', options, baseName);
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

  if (tgt === 'json') {
    const buffer = Buffer.from(JSON.stringify(rows, null, 2), 'utf-8');
    return { buffer, mimeType: 'application/json', filename: `${baseName}.json`, size: buffer.length };
  }

  if (tgt === 'tsv') {
    const tsv = rows.map((r) => r.join('\t')).join('\n');
    const buffer = Buffer.from(tsv, 'utf-8');
    return { buffer, mimeType: 'text/tab-separated-values', filename: `${baseName}.tsv`, size: buffer.length };
  }

  if (tgt === 'html') {
    let tableHtml = '<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%;border-color:#CCD2FC;">\n';
    rows.forEach((r, idx) => {
      tableHtml += '<tr>\n';
      r.forEach((c) => {
        tableHtml +=
          idx === 0
            ? `  <th style="background:#F0F2FE;color:#1F2340;padding:8px;text-align:left;">${escapeHtml(c)}</th>\n`
            : `  <td style="padding:8px;border:1px solid #E1E4EE;">${escapeHtml(c)}</td>\n`;
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

  if (tgt === 'xls') {
    return { buffer: inputBuffer, mimeType: 'application/vnd.ms-excel', filename: `${baseName}.xls`, size: inputBuffer.length };
  }

  throw new Error(`Unsupported conversion from XLS to ${tgt}`);
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
  let text = '';
  try {
    const zip = await JSZip.loadAsync(inputBuffer);
    const contentXml = zip.file('content.xml');
    if (contentXml) {
      const xml = await contentXml.async('text');
      const paragraphs: string[] = [];
      const pRegex = /<text:(?:p|h)[^>]*>([\s\S]*?)<\/text:(?:p|h)>/g;
      let m: RegExpExecArray | null;
      while ((m = pRegex.exec(xml)) !== null) {
        const t = m[1].replace(/<[^>]+>/g, '').trim();
        if (t) paragraphs.push(t);
      }
      text = paragraphs.join('\n\n');
    }
  } catch {
    text = inputBuffer.toString('utf-8');
  }

  if (!text) text = `Extracted content from ${baseName}.odt`;

  if (tgt === 'txt') {
    const buffer = Buffer.from(text, 'utf-8');
    return { buffer, mimeType: 'text/plain', filename: `${baseName}.txt`, size: buffer.length };
  }

  if (tgt === 'html') {
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(
      baseName
    )}</title><style>body{font-family:system-ui,sans-serif;padding:2rem;color:#1F2340;}</style></head><body><h1>${escapeHtml(
      baseName
    )}</h1>${text.split('\n\n').map((p) => `<p>${escapeHtml(p)}</p>`).join('\n')}</body></html>`;
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
    const docxBuffer = await generateDocxFromText(text, 'odt', options, baseName);
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

  throw new Error(`Unsupported conversion from ODT to ${tgt}`);
}

/**
 * Generates OpenDocument Spreadsheet (ODS) Archive
 */
export async function generateOdsFromData(rows: string[][], baseName: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet', { compression: 'STORE' });
  zip.file(
    'META-INF/manifest.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">
  <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`
  );

  let rowsXml = '';
  rows.forEach((row) => {
    rowsXml += '<table:table-row>';
    row.forEach((cell) => {
      rowsXml += `<table:table-cell office:value-type="string"><text:p>${escapeXml(cell)}</text:p></table:table-cell>`;
    });
    rowsXml += '</table:table-row>';
  });

  zip.file(
    'content.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  office:version="1.2">
  <office:body>
    <office:spreadsheet>
      <table:table table:name="${escapeXml(baseName)}">
        ${rowsXml}
      </table:table>
    </office:spreadsheet>
  </office:body>
</office:document-content>`
  );

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Generates Microsoft Excel XML Spreadsheet (2003)
 */
export function generateXlsXmlFromData(rows: string[][], baseName: string): string {
  let rowsXml = '';
  rows.forEach((row) => {
    rowsXml += '   <Row>\n';
    row.forEach((cell) => {
      rowsXml += `    <Cell><Data ss:Type="String">${escapeXml(cell)}</Data></Cell>\n`;
    });
    rowsXml += '   </Row>\n';
  });

  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <Worksheet ss:Name="${escapeXml(baseName)}">
  <Table>
${rowsXml}  </Table>
 </Worksheet>
</Workbook>`;
}

/**
 * Generates OpenDocument Presentation (ODP) Archive
 */
export async function generateOdpFromSlides(
  slides: { number: number; texts: string[] }[],
  title: string
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.presentation', { compression: 'STORE' });
  zip.file(
    'META-INF/manifest.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">
  <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.presentation"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`
  );

  let pagesXml = '';
  slides.forEach((s, idx) => {
    pagesXml += `<draw:page draw:name="page${idx + 1}">
      <draw:frame draw:layer="layout" svg:width="25cm" svg:height="15cm" svg:x="1cm" svg:y="1cm">
        <draw:text-box>
          ${s.texts.map((t) => `<text:p>${escapeXml(t)}</text:p>`).join('\n          ')}
        </draw:text-box>
      </draw:frame>
    </draw:page>`;
  });

  zip.file(
    'content.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
  office:version="1.2">
  <office:body>
    <office:presentation>
      ${pagesXml}
    </office:presentation>
  </office:body>
</office:document-content>`
  );

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Generates OpenDocument Text (ODT) Archive
 */
export async function generateOdtFromText(text: string, title: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });
  zip.file(
    'META-INF/manifest.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">
  <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`
  );

  const paragraphs = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `<text:p>${escapeXml(l)}</text:p>`)
    .join('\n');

  zip.file(
    'content.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  office:version="1.2">
  <office:body>
    <office:text>
      <text:h text:outline-level="1">${escapeXml(title)}</text:h>
      ${paragraphs}
    </office:text>
  </office:body>
</office:document-content>`
  );

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Extracts 2D array of rows from CSV, TSV, JSON, or XLSX for Office Generation
 */
async function extractRowsForOffice(
  inputBuffer: Buffer,
  src: string,
  options: ConversionOptions
): Promise<string[][]> {
  if (src === 'xlsx') {
    try {
      const zip = await JSZip.loadAsync(inputBuffer);
      const sheetFile = zip.file('xl/worksheets/sheet1.xml');
      if (sheetFile) {
        const sstFile = zip.file('xl/sharedStrings.xml');
        const sharedStrings: string[] = [];
        if (sstFile) {
          const sstXml = await sstFile.async('text');
          const tRegex = /<t[^>]*>([\s\S]*?)<\/t>/g;
          let m: RegExpExecArray | null;
          while ((m = tRegex.exec(sstXml)) !== null) {
            sharedStrings.push(m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
          }
        }

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
            const vMatch = body.match(/<v>([\s\S]*?)<\/v>/);
            if (vMatch) {
              const val = vMatch[1];
              cells.push(isString ? sharedStrings[parseInt(val, 10)] ?? '' : val);
            } else {
              cells.push('');
            }
          }
          if (cells.length > 0) rows.push(cells);
        }
        if (rows.length > 0) return rows;
      }
    } catch {
      // fallback
    }
  }

  const text = inputBuffer.toString('utf-8');
  if (src === 'json') {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'object') {
        const headers = Object.keys(parsed[0]);
        return [headers, ...parsed.map((item) => headers.map((h) => String(item[h] ?? '')))];
      }
    } catch {
      // fallback
    }
  }

  const delim = src === 'tsv' ? '\t' : options.delimiter || ',';
  const parsedCsv = Papa.parse<string[]>(text, {
    delimiter: delim,
    skipEmptyLines: true,
  });
  if (parsedCsv.data && parsedCsv.data.length > 0) {
    return parsedCsv.data;
  }

  return text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => l.split(delim));
}

async function convertEtSource(
  inputBuffer: Buffer,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  const rows = await extractRowsForOffice(inputBuffer, 'et', options);

  if (tgt === 'csv') {
    const csv = Papa.unparse(rows, { delimiter: options.delimiter || ',' });
    const buffer = Buffer.from(csv, 'utf-8');
    return { buffer, mimeType: 'text/csv', filename: `${baseName}.csv`, size: buffer.length };
  }

  if (tgt === 'tsv') {
    const tsv = Papa.unparse(rows, { delimiter: '\t' });
    const buffer = Buffer.from(tsv, 'utf-8');
    return { buffer, mimeType: 'text/tab-separated-values', filename: `${baseName}.tsv`, size: buffer.length };
  }

  if (tgt === 'xlsx') {
    const buffer = await generateXlsxFromData(inputBuffer, 'et', options, baseName);
    return { buffer, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `${baseName}.xlsx`, size: buffer.length };
  }

  if (tgt === 'ods') {
    const buffer = await generateOdsFromData(rows, baseName);
    return { buffer, mimeType: 'application/vnd.oasis.opendocument.spreadsheet', filename: `${baseName}.ods`, size: buffer.length };
  }

  if (tgt === 'xls') {
    const xlsXml = generateXlsXmlFromData(rows, baseName);
    const buffer = Buffer.from(xlsXml, 'utf-8');
    return { buffer, mimeType: 'application/vnd.ms-excel', filename: `${baseName}.xls`, size: buffer.length };
  }

  if (tgt === 'html') {
    const tableRows = rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('\n');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(baseName)}</title><style>table { border-collapse: collapse; width: 100%; } td { border: 1px solid #ddd; padding: 8px; font-family: sans-serif; }</style></head><body><table>${tableRows}</table></body></html>`;
    const buffer = Buffer.from(html, 'utf-8');
    return { buffer, mimeType: 'text/html', filename: `${baseName}.html`, size: buffer.length };
  }

  if (['jpg', 'jpeg', 'png', 'webp', 'bmp'].includes(tgt)) {
    const rendered = await renderTableToRaster(rows, tgt, baseName);
    return { buffer: rendered.buffer, mimeType: rendered.mimeType, filename: `${baseName}.${tgt}`, size: rendered.buffer.length };
  }

  const textTable = rows.map((r) => r.join(' | ')).join('\n');
  const pdfBuffer = await generatePdfFromDocx([{ text: textTable, isHeading: false, isBold: false, isItalic: false }], [], options, baseName);
  return { buffer: pdfBuffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: pdfBuffer.length };
}

async function convertGenericDocumentSource(
  inputBuffer: Buffer,
  src: string,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  let text = '';
  try {
    text = inputBuffer.toString('utf-8');
  } catch {
    text = `${baseName} document content`;
  }

  if (tgt === 'docx') {
    const buffer = await generateDocxFromText(text, src, options, baseName);
    return { buffer, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', filename: `${baseName}.docx`, size: buffer.length };
  }
  if (tgt === 'odt') {
    const buffer = await generateOdtFromText(text, baseName);
    return { buffer, mimeType: 'application/vnd.oasis.opendocument.text', filename: `${baseName}.odt`, size: buffer.length };
  }
  if (tgt === 'html') {
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(baseName)}</title></head><body><pre>${escapeHtml(text)}</pre></body></html>`;
    const buffer = Buffer.from(html, 'utf-8');
    return { buffer, mimeType: 'text/html', filename: `${baseName}.html`, size: buffer.length };
  }
  if (tgt === 'txt') {
    const buffer = Buffer.from(text, 'utf-8');
    return { buffer, mimeType: 'text/plain', filename: `${baseName}.txt`, size: buffer.length };
  }
  if (tgt === 'rtf') {
    const rtf = `{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Times New Roman;}}\\fs24 ${escapeHtml(text).replace(/\\r?\\n/g, '\\par ')}}\n`;
    const buffer = Buffer.from(rtf, 'utf-8');
    return { buffer, mimeType: 'application/rtf', filename: `${baseName}.rtf`, size: buffer.length };
  }
  if (tgt === 'xps') {
    const zip = new JSZip();
    zip.file(
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="fdseq" ContentType="application/vnd.ms-package.xps-fixeddocumentsequence+xml"/></Types>'
    );
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    return { buffer, mimeType: 'application/oxps', filename: `${baseName}.xps`, size: buffer.length };
  }
  if (['png', 'jpg', 'jpeg', 'webp', 'bmp'].includes(tgt)) {
    const rendered = await renderTextToRaster(text, tgt, baseName);
    return { buffer: rendered.buffer, mimeType: rendered.mimeType, filename: `${baseName}.${tgt}`, size: rendered.buffer.length };
  }

  const pdfBuffer = await generatePdfFromDocx([{ text, isHeading: false, isBold: false, isItalic: false }], [], options, baseName);
  return { buffer: pdfBuffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: pdfBuffer.length };
}

async function convertOpenDocumentGraphicSource(
  inputBuffer: Buffer,
  src: string,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  let content = '';
  try {
    const zip = await JSZip.loadAsync(inputBuffer);
    const c = zip.file('content.xml');
    if (c) content = await c.async('text');
  } catch {
    content = inputBuffer.toString('utf-8');
  }

  const plainText = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || `${baseName} drawing`;

  if (tgt === 'pdf') {
    const pdfBuffer = await generatePdfFromDocx([{ text: plainText, isHeading: false, isBold: false, isItalic: false }], [], options, baseName);
    return { buffer: pdfBuffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: pdfBuffer.length };
  }
  if (['png', 'jpg', 'jpeg', 'webp', 'avif', 'tiff', 'gif', 'bmp', 'eps', 'ps', 'ico', 'psd'].includes(tgt)) {
    const rendered = await renderTextToRaster(plainText, tgt, baseName);
    return { buffer: rendered.buffer, mimeType: rendered.mimeType, filename: `${baseName}.${tgt}`, size: rendered.buffer.length };
  }

  const pdfBuffer = await generatePdfFromDocx([{ text: plainText, isHeading: false, isBold: false, isItalic: false }], [], options, baseName);
  return { buffer: pdfBuffer, mimeType: 'application/pdf', filename: `${baseName}.${tgt}`, size: pdfBuffer.length };
}

async function convertGenericEbookSource(
  inputBuffer: Buffer,
  src: string,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  let text = '';
  try {
    const zip = await JSZip.loadAsync(inputBuffer);
    for (const [filename, file] of Object.entries(zip.files)) {
      if (/\.(html|htm|txt|xhtml)$/i.test(filename) && !file.dir) {
        const c = await file.async('text');
        text += c.replace(/<[^>]+>/g, ' ') + '\n\n';
      }
    }
  } catch {
    text = inputBuffer.toString('utf-8');
  }

  text = text.trim() || `${baseName} ebook content`;

  if (tgt === 'epub') {
    const buffer = await generateEpubFromText(text, src, options, baseName);
    return { buffer, mimeType: 'application/epub+zip', filename: `${baseName}.epub`, size: buffer.length };
  }
  if (tgt === 'mobi' || tgt === 'azw3' || tgt === 'lrf' || tgt === 'oeb' || tgt === 'pdb') {
    return convertMobiSource(Buffer.from(text, 'utf-8'), 'txt', tgt, options, baseName);
  }
  if (tgt === 'txt') {
    const buffer = Buffer.from(text, 'utf-8');
    return { buffer, mimeType: 'text/plain', filename: `${baseName}.txt`, size: buffer.length };
  }
  if (tgt === 'rtf') {
    const rtf = `{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Times New Roman;}}\\fs24 ${escapeHtml(text).replace(/\\r?\\n/g, '\\par ')}}\n`;
    const buffer = Buffer.from(rtf, 'utf-8');
    return { buffer, mimeType: 'application/rtf', filename: `${baseName}.rtf`, size: buffer.length };
  }
  if (['png', 'jpg', 'jpeg', 'webp', 'bmp'].includes(tgt)) {
    const rendered = await renderTextToRaster(text, tgt, baseName);
    return { buffer: rendered.buffer, mimeType: rendered.mimeType, filename: `${baseName}.${tgt}`, size: rendered.buffer.length };
  }

  const pdfBuffer = await generatePdfFromDocx([{ text, isHeading: false, isBold: false, isItalic: false }], [], options, baseName);
  return { buffer: pdfBuffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: pdfBuffer.length };
}

async function rasterizePipeline(
  pipeline: sharp.Sharp,
  tgt: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  switch (tgt) {
    case 'jpg':
    case 'jpeg': {
      const buffer = await pipeline.jpeg({ quality: 90 }).toBuffer();
      return { buffer, mimeType: 'image/jpeg' };
    }
    case 'webp': {
      const buffer = await pipeline.webp().toBuffer();
      return { buffer, mimeType: 'image/webp' };
    }
    case 'avif': {
      const buffer = await pipeline.avif().toBuffer();
      return { buffer, mimeType: 'image/avif' };
    }
    case 'tiff': {
      const buffer = await pipeline.tiff().toBuffer();
      return { buffer, mimeType: 'image/tiff' };
    }
    case 'gif': {
      const buffer = await pipeline.gif().toBuffer();
      return { buffer, mimeType: 'image/gif' };
    }
    case 'bmp': {
      const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const buffer = encodeBmp(data, info.width, info.height, info.channels);
      return { buffer, mimeType: 'image/bmp' };
    }
    case 'eps':
    case 'ps': {
      const { data, info } = await pipeline.removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const buffer = encodePostscript(data, info.width, info.height, tgt === 'eps');
      return { buffer, mimeType: 'application/postscript' };
    }
    case 'png':
    default: {
      const buffer = await pipeline.png().toBuffer();
      return { buffer, mimeType: 'image/png' };
    }
  }
}

async function renderTableToRaster(
  rows: string[][],
  tgt: string,
  baseName: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  const rowHeight = 26;
  const colWidth = 140;
  const numCols = Math.max(1, ...rows.map((r) => r.length));
  const width = Math.min(2400, Math.max(640, numCols * colWidth + 40));
  const height = Math.min(2400, Math.max(200, rows.length * rowHeight + 80));

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#ffffff" />
    <text x="20" y="32" font-family="sans-serif" font-size="16" font-weight="bold" fill="#1e293b">${escapeXml(baseName)}</text>
  `;

  rows.slice(0, 80).forEach((row, rIdx) => {
    const y = 50 + rIdx * rowHeight;
    const isHeader = rIdx === 0;
    const bgFill = isHeader ? '#f1f5f9' : (rIdx % 2 === 0 ? '#ffffff' : '#f8fafc');
    svg += `<rect x="20" y="${y}" width="${width - 40}" height="${rowHeight}" fill="${bgFill}" stroke="#e2e8f0" />`;
    row.forEach((cell, cIdx) => {
      const x = 25 + cIdx * colWidth;
      const fontWeight = isHeader ? 'bold' : 'normal';
      svg += `<text x="${x}" y="${y + 18}" font-family="sans-serif" font-size="12" font-weight="${fontWeight}" fill="#334155">${escapeXml(cell.slice(0, 20))}</text>`;
    });
  });

  svg += `</svg>`;

  const pipeline = sharp(Buffer.from(svg, 'utf-8'));
  return rasterizePipeline(pipeline, tgt);
}

async function renderTextToRaster(
  text: string,
  tgt: string,
  baseName: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  const lines = text.split(/\\r?\\n/).slice(0, 60);
  const width = 800;
  const height = Math.min(2400, Math.max(240, lines.length * 24 + 80));

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#ffffff" />
    <text x="30" y="36" font-family="sans-serif" font-size="18" font-weight="bold" fill="#0f172a">${escapeXml(baseName)}</text>
  `;

  lines.forEach((line, idx) => {
    const y = 68 + idx * 24;
    svg += `<text x="30" y="${y}" font-family="sans-serif" font-size="13" fill="#334155">${escapeXml(line.slice(0, 95))}</text>`;
  });

  svg += `</svg>`;

  const pipeline = sharp(Buffer.from(svg, 'utf-8'));
  return rasterizePipeline(pipeline, tgt);
}


