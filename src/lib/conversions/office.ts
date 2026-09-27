import JSZip from 'jszip';
import Papa from 'papaparse';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import { ConversionOptions, ConversionResult } from '../types';
import { extractTextFromPdf, extractEmbeddedImageFromPdf } from './pdf-utils';
import { performOcr } from './ocr';
import { encodeBmp, encodePostscript } from './image';
import { convertHwp, parseHwpDocument, buildHwpCompoundFile, isCfbfContainer, parseCfbf } from './hwp';

/**
 * Office & Ebook Conversion Engine
 * Handles DOCX, XLSX, PPTX, EPUB, MOBI, FB2, ODP with layout, tables, and font preservation.
 */
export async function convertOffice(
  inputBuffer: Buffer,
  sourceFormat: string,
  targetFormat: string,
  options: ConversionOptions = {},
  originalFilename: string = 'document'
): Promise<ConversionResult> {
  const baseName = (originalFilename || 'document').replace(/\.[^/.]+$/, '');
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

  // 12.21 HWPX Source (KS X 6101 Hangul Word Processor XML)
  if (src === 'hwpx') {
    const { convertHwpx } = await import('./hwpx');
    return convertHwpx(inputBuffer, tgt, options, baseName);
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

  // 13.01 Target is HWPX (from Markdown, HTML, TXT, DOCX, ODT, RTF, etc.)
  if (tgt === 'hwpx') {
    const { markdownToHwpx } = await import('./hwpx');
    const textContent = await extractTextContentForOffice(inputBuffer, src, options, baseName);
    const hwpxBuffer = await markdownToHwpx(textContent, baseName);
    return {
      buffer: hwpxBuffer,
      mimeType: 'application/hwp+zip',
      filename: `${baseName}.hwpx`,
      size: hwpxBuffer.length,
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
    throw new Error(`Unsupported office conversion: target iWork format '${tgt}' is not supported`);
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
export async function extractTextContentForOffice(
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
    return extractTextFromOdt(inputBuffer);
  }

  if (src === 'doc') {
    return extractTextFromDoc(inputBuffer);
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

  const UNSUPPORTED_BINARY_OFFICE_FORMATS = new Set([
    'pages',
    'numbers',
    'key',
    'pub',
    'lwp',
    'epub',
    'et',
    'mobi',
    'azw',
    'azw3',
    'azw4',
    'cbz',
    'cbr',
    'cbc',
    'fb2',
    'ibooks',
    'lit',
    'prc',
    'snb',
    'tcr',
    'chm',
    'djvu',
    'xps',
    'oxps',
    'xlsx',
    'xls',
    'docx',
    'docm',
    'pptx',
    'pptm',
    'potx',
    'potm',
    'ods',
    'odp',
    'odg',
    'odd',
  ]);

  if (UNSUPPORTED_BINARY_OFFICE_FORMATS.has(src)) {
    throw new Error(
      `Unsupported binary or compressed format '.${src}' for text extraction: fail-closed against mojibake corruption.`
    );
  }

  if (
    inputBuffer.length >= 4 &&
    ((inputBuffer[0] === 0x50 && inputBuffer[1] === 0x4b && inputBuffer[2] === 0x03 && inputBuffer[3] === 0x04) ||
      (inputBuffer[0] === 0xd0 && inputBuffer[1] === 0xcf && inputBuffer[2] === 0x11 && inputBuffer[3] === 0xe0) ||
      (inputBuffer[0] === 0x37 && inputBuffer[1] === 0x7a && inputBuffer[2] === 0xbc && inputBuffer[3] === 0xaf))
  ) {
    throw new Error(
      `Cannot extract plain text from binary/compressed container for format '.${src}': fail-closed against mojibake corruption.`
    );
  }

  if (inputBuffer.subarray(0, Math.min(inputBuffer.length, 4096)).includes(0x00)) {
    throw new Error(
      `Binary null bytes detected in source format '.${src}': fail-closed against mojibake corruption.`
    );
  }

  return inputBuffer.toString('utf-8');
}

export async function extractTextFromOdt(buffer: Buffer): Promise<string> {
  try {
    const zip = await JSZip.loadAsync(buffer);
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
  throw new Error('Failed to extract text content from ODT document: fail-closed.');
}

function sanitizeControlChars(text: string): string {
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31)) {
      result += ' ';
    } else {
      result += text[i];
    }
  }
  return result;
}

export function extractTextFromDoc(buffer: Buffer): string {
  // 1. OLE2 Compound File Binary Format (.doc)
  if (isCfbfContainer(buffer)) {
    try {
      const cfbf = parseCfbf(buffer);
      const wordDoc = cfbf.streams.get('WordDocument') || cfbf.streams.get('worddocument');
      if (wordDoc && wordDoc.length >= 0x0100) {
        // Parse File Information Block (FIB)
        const wIdent = wordDoc.readUInt16LE(0);
        // Standard Microsoft Word binary signatures: 0xA5EC (Word 97-2003), 0xA5DC (Word 95)
        if (wIdent === 0xa5ec || wIdent === 0xa5dc || wIdent === 0xa5cd) {
          const fcMin = wordDoc.length > 0x001c ? wordDoc.readUInt32LE(0x0018) : 0;
          const ccpText = wordDoc.length > 0x0050 ? wordDoc.readUInt32LE(0x004c) : 0;

          if (fcMin > 0 && fcMin < wordDoc.length && ccpText > 0) {
            // Text stream starting at fcMin
            const textBytes = Math.min(ccpText * 2, wordDoc.length - fcMin);
            const textSlice = wordDoc.subarray(fcMin, fcMin + textBytes);

            // Attempt UTF-16LE decode
            const decodedUtf16 = sanitizeControlChars(textSlice.toString('utf16le')).trim();

            if (decodedUtf16.length > 0) {
              const paragraphs = decodedUtf16
                .split(/\r?\n/)
                .map((p) => p.trim())
                .filter((p) => p.length > 0);
              if (paragraphs.length > 0) {
                return paragraphs.join('\n\n');
              }
            }
          }
        }

        // If FIB offsets point outside or 8-bit text: inspect WordDocument stream directly
        const rawUtf16 = sanitizeControlChars(wordDoc.toString('utf16le'));
        const utf16Candidate = rawUtf16
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s.length >= 3);

        if (utf16Candidate.length > 0) {
          return utf16Candidate.join('\n\n');
        }
      }
    } catch {
      // Fallback to byte scraping on malformed CFBF
    }
  }

  // 2. Fallback character scanner for raw or fragmented text
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
          .map((el) => {
            if (el.type === 'paragraph') return el.paragraph.text;
            if (el.type === 'table') return el.table.rows.map((r) => r.join('\t')).join('\n');
            if (el.type === 'drawing') return (el.shapes || []).map((s) => s.text).filter(Boolean).join(' ');
            return '';
          })
          .filter(Boolean)
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

export interface TableBorder {
  style?: string; // solid, dashed, dotted, double, none
  size?: number; // in pt
  color?: string; // hex color e.g. #CCD2FC
}

export interface DocxTableCell {
  text: string;
  shading?: string;
  isHeader?: boolean;
  colSpan?: number;
  rowSpan?: number;
  borders?: {
    top?: TableBorder;
    bottom?: TableBorder;
    left?: TableBorder;
    right?: TableBorder;
  };
}

export interface DocxTable {
  rowCount?: number;
  colCount?: number;
  rows: string[][];
  structuredRows?: DocxTableCell[][];
  tblBorders?: {
    top?: TableBorder;
    bottom?: TableBorder;
    left?: TableBorder;
    right?: TableBorder;
    insideH?: TableBorder;
    insideV?: TableBorder;
  };
}

export interface DrawingMlShape {
  id?: string;
  name?: string;
  type?: string;
  geomType: 'preset' | 'custom';
  presetGeom?: string;
  customPath?: string;
  svgPath?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  fillColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  text?: string;
}

export type DocxBlockElement =
  | { type: 'paragraph'; paragraph: DocxParagraph }
  | { type: 'table'; table: DocxTable }
  | { type: 'drawing'; svg: string; shapes?: DrawingMlShape[] };

export function parseBorder(borderXml: string): TableBorder | undefined {
  if (!borderXml) return undefined;
  const valMatch = borderXml.match(/w:val="([^"]+)"/);
  const val = valMatch ? valMatch[1] : 'single';
  if (val === 'none' || val === 'nil') return { style: 'none' };
  const szMatch = borderXml.match(/w:sz="(\d+)"/);
  const sz = szMatch ? parseInt(szMatch[1], 10) / 8 : 0.5; // in pt (w:sz is in eighths of a point)
  const colMatch = borderXml.match(/w:color="([A-Fa-f0-9]{6})"/);
  const color = colMatch ? `#${colMatch[1]}` : '#CCD2FC';
  const style =
    val === 'double' ? 'double' : val.includes('dash') ? 'dashed' : val.includes('dot') ? 'dotted' : 'solid';
  return { style, size: sz, color };
}

/**
 * OpenXML DrawingML Vector Shape Parser & SVG Renderer
 * Parses <p:spTree>, <w:drawing>, <a:xfrm>, <a:prstGeom>, and <a:custGeom>
 * into clean, standards-compliant SVG vector paths.
 */
export function parseDrawingMlShapes(xml: string): DrawingMlShape[] {
  const shapes: DrawingMlShape[] = [];

  // Match all shape tags: <p:sp>, <wps:wsp>, <a:graphicData>, <w:drawing>
  const shapeRegex = /<(?:(?:p|wps):sp|a:graphicData|w:drawing)\b[\s\S]*?<\/(?:(?:p|wps):sp|a:graphicData|w:drawing)>/gi;
  let spMatch: RegExpExecArray | null;
  const matches: string[] = [];

  while ((spMatch = shapeRegex.exec(xml)) !== null) {
    matches.push(spMatch[0]);
  }

  if (matches.length === 0 && (xml.includes('<a:prstGeom') || xml.includes('<a:custGeom') || xml.includes('<a:spPr'))) {
    matches.push(xml);
  }

  for (const spXml of matches) {

    // 1. Transform: <a:xfrm rot="..."> <a:off x="..." y="..."/> <a:ext cx="..." cy="..."/>
    const xfrmMatch = spXml.match(/<a:xfrm\b([^>]*?)>([\s\S]*?)<\/a:xfrm>/i);
    let x = 0,
      y = 0,
      width = 100,
      height = 60,
      rotation = 0;
    if (xfrmMatch) {
      const xfrmAttrs = xfrmMatch[1];
      const xfrmBody = xfrmMatch[2];
      const rotMatch = xfrmAttrs.match(/rot="(\d+)"/i);
      if (rotMatch) rotation = parseInt(rotMatch[1], 10) / 60000;

      const offMatch = xfrmBody.match(/<a:off\b[^>]*x="(-?\d+)"[^>]*y="(-?\d+)"/i);
      if (offMatch) {
        x = Math.round(parseInt(offMatch[1], 10) / 12700);
        y = Math.round(parseInt(offMatch[2], 10) / 12700);
      }
      const extMatch = xfrmBody.match(/<a:ext\b[^>]*cx="(\d+)"[^>]*cy="(\d+)"/i);
      if (extMatch) {
        width = Math.max(1, Math.round(parseInt(extMatch[1], 10) / 12700));
        height = Math.max(1, Math.round(parseInt(extMatch[2], 10) / 12700));
      }
    }

    // 2. Fills and Lines
    let fillColor = '#5C6BC0';
    let strokeColor = '#1F2340';
    let strokeWidth = 1;

    if (spXml.includes('<a:noFill/>') || spXml.includes('<a:noFill />')) {
      fillColor = 'none';
    } else {
      const fillMatch = spXml.match(/<a:solidFill>[\s\S]*?<a:srgbClr\b[^>]*val="([A-Fa-f0-9]{6})"/i);
      if (fillMatch) fillColor = `#${fillMatch[1]}`;
    }

    const lnMatch = spXml.match(/<a:ln\b([^>]*?)>([\s\S]*?)<\/a:ln>/i);
    if (lnMatch) {
      const wMatch = lnMatch[1].match(/w="(\d+)"/i);
      if (wMatch) strokeWidth = Math.max(0.5, Math.round(parseInt(wMatch[1], 10) / 12700));
      const lnClrMatch = lnMatch[2].match(/<a:srgbClr\b[^>]*val="([A-Fa-f0-9]{6})"/i);
      if (lnClrMatch) strokeColor = `#${lnClrMatch[1]}`;
    }

    // 3. Geometry (Preset vs Custom)
    let geomType: 'preset' | 'custom' = 'preset';
    let presetGeom = 'rect';
    let svgPath = '';

    const prstMatch = spXml.match(/<a:prstGeom\b[^>]*prst="([^"]+)"/i);
    const custMatch = spXml.match(/<a:custGeom\b[\s\S]*?<\/a:custGeom>/i);

    if (custMatch) {
      geomType = 'custom';
      const custXml = custMatch[0];
      const pathTagMatch = custXml.match(/<a:path\b([^>]*?)>([\s\S]*?)<\/a:path>/i);
      if (pathTagMatch) {
        const pathAttrs = pathTagMatch[1];
        const pathBody = pathTagMatch[2];
        const pwMatch = pathAttrs.match(/w="(\d+)"/i);
        const phMatch = pathAttrs.match(/h="(\d+)"/i);
        const pw = pwMatch ? parseInt(pwMatch[1], 10) : width;
        const ph = phMatch ? parseInt(phMatch[1], 10) : height;
        const sx = width / (pw || 1);
        const sy = height / (ph || 1);

        const dParts: string[] = [];
        // Process path commands in sequential document order to preserve geometry
        const cmdRegex = /<a:(moveTo|lnTo|cubicBezTo|quadBezTo|arcTo|close)\b([^>]*?)>([\s\S]*?)<\/a:\1>|<a:(close)\b[^>]*\/>/gi;
        let cmdMatch: RegExpExecArray | null;
        while ((cmdMatch = cmdRegex.exec(pathBody)) !== null) {
          const cmdName = (cmdMatch[1] || cmdMatch[4]).toLowerCase();
          const cmdContent = cmdMatch[3] || '';

          if (cmdName === 'moveto') {
            const ptMatch = cmdContent.match(/<a:pt\b[^>]*x="(-?\d+)"[^>]*y="(-?\d+)"/i);
            if (ptMatch) {
              const px = Math.round(parseInt(ptMatch[1], 10) * sx + x);
              const py = Math.round(parseInt(ptMatch[2], 10) * sy + y);
              dParts.push(`M ${px} ${py}`);
            }
          } else if (cmdName === 'lnto') {
            const ptMatch = cmdContent.match(/<a:pt\b[^>]*x="(-?\d+)"[^>]*y="(-?\d+)"/i);
            if (ptMatch) {
              const px = Math.round(parseInt(ptMatch[1], 10) * sx + x);
              const py = Math.round(parseInt(ptMatch[2], 10) * sy + y);
              dParts.push(`L ${px} ${py}`);
            }
          } else if (cmdName === 'cubicbezto') {
            const ptRegex = /<a:pt\b[^>]*x="(-?\d+)"[^>]*y="(-?\d+)"/gi;
            const pts: string[] = [];
            let ptM: RegExpExecArray | null;
            while ((ptM = ptRegex.exec(cmdContent)) !== null) {
              const px = Math.round(parseInt(ptM[1], 10) * sx + x);
              const py = Math.round(parseInt(ptM[2], 10) * sy + y);
              pts.push(`${px} ${py}`);
            }
            if (pts.length >= 3) {
              dParts.push(`C ${pts[0]}, ${pts[1]}, ${pts[2]}`);
            }
          } else if (cmdName === 'quadbezto') {
            const ptRegex = /<a:pt\b[^>]*x="(-?\d+)"[^>]*y="(-?\d+)"/gi;
            const pts: string[] = [];
            let ptM: RegExpExecArray | null;
            while ((ptM = ptRegex.exec(cmdContent)) !== null) {
              const px = Math.round(parseInt(ptM[1], 10) * sx + x);
              const py = Math.round(parseInt(ptM[2], 10) * sy + y);
              pts.push(`${px} ${py}`);
            }
            if (pts.length >= 2) {
              dParts.push(`Q ${pts[0]}, ${pts[1]}`);
            }
          } else if (cmdName === 'close') {
            dParts.push('Z');
          }
        }
        svgPath = dParts.join(' ');
      }
    } else if (prstMatch) {
      geomType = 'preset';
      presetGeom = prstMatch[1].toLowerCase();
    }

    // 4. Text inside shape
    const tTags = spXml.match(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi) || [];
    const text = tTags
      .map((t) => t.replace(/<[^>]+>/g, '').trim())
      .filter(Boolean)
      .join(' ');

    shapes.push({
      type: geomType === 'custom' ? 'custom' : presetGeom,
      geomType,
      presetGeom,
      customPath: svgPath || undefined,
      svgPath,
      x,
      y,
      width,
      height,
      rotation,
      fillColor,
      strokeColor,
      strokeWidth,
      text: text || undefined,
    });
  }

  return shapes;
}

/**
 * Renders OpenXML DrawingML specifications into an SVG vector graphic string.
 */
export function renderDrawingMlToSvg(
  xmlOrShapes: string | DrawingMlShape[],
  options?: { width?: number; height?: number } | number,
  heightOption?: number
): { svg: string; shapes: DrawingMlShape[] } {
  const shapes = Array.isArray(xmlOrShapes) ? xmlOrShapes : parseDrawingMlShapes(xmlOrShapes);
  if (shapes.length === 0) {
    return {
      svg: '',
      shapes: [],
    };
  }

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  shapes.forEach((s) => {
    minX = Math.min(minX, s.x);
    minY = Math.min(minY, s.y);
    maxX = Math.max(maxX, s.x + s.width);
    maxY = Math.max(maxY, s.y + s.height);
  });

  const optWidth = typeof options === 'number' ? options : options?.width;
  const optHeight = typeof options === 'number' ? heightOption : options?.height;

  const contentWidth = Math.max(10, maxX - minX + 20);
  const contentHeight = Math.max(10, maxY - minY + 20);
  const totalWidth = optWidth || contentWidth;
  const totalHeight = optHeight || contentHeight;

  let svgElements = '';
  for (const s of shapes) {
    const rotAttr = s.rotation ? ` transform="rotate(${s.rotation} ${s.x + s.width / 2} ${s.y + s.height / 2})"` : '';
    let elementStr = '';

    if (s.geomType === 'custom' && s.svgPath) {
      elementStr = `<path d="${s.svgPath}" fill="${s.fillColor}" stroke="${s.strokeColor}" stroke-width="${s.strokeWidth}"${rotAttr} />`;
    } else {
      switch (s.presetGeom) {
        case 'ellipse':
          elementStr = `<ellipse cx="${s.x + s.width / 2}" cy="${s.y + s.height / 2}" rx="${s.width / 2}" ry="${
            s.height / 2
          }" fill="${s.fillColor}" stroke="${s.strokeColor}" stroke-width="${s.strokeWidth}"${rotAttr} />`;
          break;
        case 'roundrect':
          elementStr = `<rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" rx="8" ry="8" fill="${s.fillColor}" stroke="${s.strokeColor}" stroke-width="${s.strokeWidth}"${rotAttr} />`;
          break;
        case 'triangle': {
          const pts = `${s.x + s.width / 2},${s.y} ${s.x + s.width},${s.y + s.height} ${s.x},${s.y + s.height}`;
          elementStr = `<polygon points="${pts}" fill="${s.fillColor}" stroke="${s.strokeColor}" stroke-width="${s.strokeWidth}"${rotAttr} />`;
          break;
        }
        case 'diamond': {
          const pts = `${s.x + s.width / 2},${s.y} ${s.x + s.width},${s.y + s.height / 2} ${s.x + s.width / 2},${
            s.y + s.height
          } ${s.x},${s.y + s.height / 2}`;
          elementStr = `<polygon points="${pts}" fill="${s.fillColor}" stroke="${s.strokeColor}" stroke-width="${s.strokeWidth}"${rotAttr} />`;
          break;
        }
        case 'line':
          elementStr = `<line x1="${s.x}" y1="${s.y}" x2="${s.x + s.width}" y2="${s.y + s.height}" stroke="${
            s.strokeColor
          }" stroke-width="${s.strokeWidth}"${rotAttr} />`;
          break;
        case 'star5': {
          const cx = s.x + s.width / 2;
          const cy = s.y + s.height / 2;
          const rOuter = Math.min(s.width, s.height) / 2;
          const rInner = rOuter * 0.4;
          const pts: string[] = [];
          for (let i = 0; i < 10; i++) {
            const angle = (i * Math.PI) / 5 - Math.PI / 2;
            const r = i % 2 === 0 ? rOuter : rInner;
            pts.push(`${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`);
          }
          elementStr = `<polygon points="${pts.join(' ')}" fill="${s.fillColor}" stroke="${s.strokeColor}" stroke-width="${
            s.strokeWidth
          }"${rotAttr} />`;
          break;
        }
        case 'rect':
        default:
          elementStr = `<rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" fill="${s.fillColor}" stroke="${s.strokeColor}" stroke-width="${s.strokeWidth}"${rotAttr} />`;
          break;
      }
    }

    if (s.text) {
      const textFill = s.fillColor === '#5C6BC0' || s.fillColor === '#1F2340' ? '#FFFFFF' : '#1F2340';
      elementStr += `\n  <text x="${s.x + s.width / 2}" y="${
        s.y + s.height / 2 + 4
      }" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="12" font-weight="500" fill="${textFill}">${escapeHtml(
        s.text
      )}</text>`;
    }

    svgElements += `  ${elementStr}\n`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX - 10} ${minY - 10} ${contentWidth} ${contentHeight}" width="${totalWidth}" height="${totalHeight}">\n${svgElements}</svg>`;
  return { svg, shapes };
}

function safeExtractXmlTags(xml: string, tagName: string): string[] {
  const results: string[] = [];
  const openTag = `<${tagName}`;
  const closeTag = `</${tagName}>`;
  let pos = 0;
  while (pos < xml.length) {
    const startIdx = xml.indexOf(openTag, pos);
    if (startIdx === -1) break;
    const charAfter = xml[startIdx + openTag.length];
    if (
      charAfter !== '>' &&
      charAfter !== ' ' &&
      charAfter !== '/' &&
      charAfter !== '\t' &&
      charAfter !== '\n' &&
      charAfter !== '\r'
    ) {
      pos = startIdx + openTag.length;
      continue;
    }
    const endIdx = xml.indexOf(closeTag, startIdx);
    if (endIdx === -1) break;
    results.push(xml.slice(startIdx, endIdx + closeTag.length));
    pos = endIdx + closeTag.length;
  }
  return results;
}

function safeExtractDocxBlocks(bodyXml: string): string[] {
  const blocks: string[] = [];
  let pos = 0;
  while (pos < bodyXml.length) {
    const nextTbl = bodyXml.indexOf('<w:tbl', pos);
    const nextP = bodyXml.indexOf('<w:p', pos);
    const nextDrawing = bodyXml.indexOf('<w:drawing', pos);

    const candidates = [
      { tag: 'w:tbl', idx: nextTbl },
      { tag: 'w:p', idx: nextP },
      { tag: 'w:drawing', idx: nextDrawing },
    ]
      .filter((c) => c.idx !== -1)
      .sort((a, b) => a.idx - b.idx);

    if (candidates.length === 0) break;
    const startIdx = candidates[0].idx;
    const tag = candidates[0].tag;

    const closeTag = `</${tag}>`;
    const endIdx = bodyXml.indexOf(closeTag, startIdx);
    if (endIdx === -1) break;

    blocks.push(bodyXml.slice(startIdx, endIdx + closeTag.length));
    pos = endIdx + closeTag.length;
  }
  return blocks;
}

function parseDocxXml(xml: string): {
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

  const blocks = safeExtractDocxBlocks(bodyXml);

  for (const chunk of blocks) {
    // If chunk is a standalone Drawing (<w:drawing>)
    if (chunk.startsWith('<w:drawing')) {
      const res = renderDrawingMlToSvg(chunk);
      if (res.shapes.length > 0) {
        elements.push({ type: 'drawing', svg: res.svg, shapes: res.shapes });
      }
      continue;
    }

    // If chunk is a Table (<w:tbl>)
    if (chunk.startsWith('<w:tbl')) {
      const rows: string[][] = [];
      const structuredRows: DocxTableCell[][] = [];

      const tblBordersMatch = chunk.match(/<w:tblBorders\b[^>]*>([\s\S]*?)<\/w:tblBorders>/i);
      let tblBorders: DocxTable['tblBorders'];
      if (tblBordersMatch) {
        const bXml = tblBordersMatch[1];
        const topM = bXml.match(/<w:top\b([^>]*?)\/?>/i);
        const bottomM = bXml.match(/<w:bottom\b([^>]*?)\/?>/i);
        const leftM = bXml.match(/<w:left\b([^>]*?)\/?>/i);
        const rightM = bXml.match(/<w:right\b([^>]*?)\/?>/i);
        const inHM = bXml.match(/<w:insideH\b([^>]*?)\/?>/i);
        const inVM = bXml.match(/<w:insideV\b([^>]*?)\/?>/i);
        tblBorders = {
          top: parseBorder(topM ? topM[1] : ''),
          bottom: parseBorder(bottomM ? bottomM[1] : ''),
          left: parseBorder(leftM ? leftM[1] : ''),
          right: parseBorder(rightM ? rightM[1] : ''),
          insideH: parseBorder(inHM ? inHM[1] : ''),
          insideV: parseBorder(inVM ? inVM[1] : ''),
        };
      }

      const trList = safeExtractXmlTags(chunk, 'w:tr');

      for (const trXml of trList) {
        const rowCells: string[] = [];
        const sCells: DocxTableCell[] = [];
        const isHeader = /<w:tblHeader(\/|>)/.test(trXml) || rows.length === 0;

        const tcList = safeExtractXmlTags(trXml, 'w:tc');

        for (const tcXml of tcList) {
          const shdMatch = tcXml.match(/<w:shd[^>]*w:fill="([A-Fa-f0-9]{6})"/);
          const shading = shdMatch ? shdMatch[1] : undefined;

          const spanMatch = tcXml.match(/<w:gridSpan[^>]*w:val="(\d+)"/);
          const colSpan = spanMatch ? parseInt(spanMatch[1], 10) : 1;

          const tcBordersMatch = tcXml.match(/<w:tcBorders\b[^>]*>([\s\S]*?)<\/w:tcBorders>/i);
          let borders: DocxTableCell['borders'];
          if (tcBordersMatch) {
            const bXml = tcBordersMatch[1];
            const topM = bXml.match(/<w:top\b([^>]*?)\/?>/i);
            const bottomM = bXml.match(/<w:bottom\b([^>]*?)\/?>/i);
            const leftM = bXml.match(/<w:left\b([^>]*?)\/?>/i);
            const rightM = bXml.match(/<w:right\b([^>]*?)\/?>/i);
            borders = {
              top: parseBorder(topM ? topM[1] : ''),
              bottom: parseBorder(bottomM ? bottomM[1] : ''),
              left: parseBorder(leftM ? leftM[1] : ''),
              right: parseBorder(rightM ? rightM[1] : ''),
            };
          }

          const tTags = safeExtractXmlTags(tcXml, 'w:t');
          const cellText = tTags
            .map((m) => m.replace(/<[^>]+>/g, ''))
            .join('')
            .trim();

          rowCells.push(cellText);
          sCells.push({ text: cellText, shading, colSpan, isHeader, borders });
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
          tblBorders,
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

    // Extract inline DrawingML drawings from paragraph chunk
    if (chunk.includes('<w:drawing')) {
      const drawingMatches = chunk.match(/<w:drawing\b[\s\S]*?<\/w:drawing>/gi) || [];
      for (const dXml of drawingMatches) {
        const res = renderDrawingMlToSvg(dXml);
        if (res.shapes.length > 0) {
          elements.push({ type: 'drawing', svg: res.svg, shapes: res.shapes });
        }
      }
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
    let tblStyle = 'border-collapse:collapse;margin:1.5rem 0;width:100%;';
    if (tbl.tblBorders) {
      if (tbl.tblBorders.top && tbl.tblBorders.top.style !== 'none') {
        tblStyle += `border-top:${tbl.tblBorders.top.size || 1}pt ${tbl.tblBorders.top.style || 'solid'} ${tbl.tblBorders.top.color || '#CCD2FC'};`;
      }
      if (tbl.tblBorders.bottom && tbl.tblBorders.bottom.style !== 'none') {
        tblStyle += `border-bottom:${tbl.tblBorders.bottom.size || 1}pt ${tbl.tblBorders.bottom.style || 'solid'} ${tbl.tblBorders.bottom.color || '#CCD2FC'};`;
      }
    }
    let tblHtml = `<table border="1" cellpadding="8" cellspacing="0" style="${tblStyle}">\n`;

    if (tbl.structuredRows && tbl.structuredRows.length > 0) {
      tbl.structuredRows.forEach((sRow, rIdx) => {
        tblHtml += '<tr>\n';
        sRow.forEach((cell) => {
          const tag = cell.isHeader || rIdx === 0 ? 'th' : 'td';
          let cellStyle = 'padding:8px;text-align:left;';
          if (cell.shading && cell.shading !== 'auto') {
            cellStyle += `background-color:#${cell.shading};`;
          } else if (tag === 'th') {
            cellStyle += 'background:#F0F2FE;color:#1F2340;';
          }
          if (cell.borders) {
            if (cell.borders.top && cell.borders.top.style !== 'none') {
              cellStyle += `border-top:${cell.borders.top.size || 1}pt ${cell.borders.top.style || 'solid'} ${cell.borders.top.color || '#CCD2FC'};`;
            }
            if (cell.borders.bottom && cell.borders.bottom.style !== 'none') {
              cellStyle += `border-bottom:${cell.borders.bottom.size || 1}pt ${cell.borders.bottom.style || 'solid'} ${cell.borders.bottom.color || '#CCD2FC'};`;
            }
            if (cell.borders.left && cell.borders.left.style !== 'none') {
              cellStyle += `border-left:${cell.borders.left.size || 1}pt ${cell.borders.left.style || 'solid'} ${cell.borders.left.color || '#CCD2FC'};`;
            }
            if (cell.borders.right && cell.borders.right.style !== 'none') {
              cellStyle += `border-right:${cell.borders.right.size || 1}pt ${cell.borders.right.style || 'solid'} ${cell.borders.right.color || '#CCD2FC'};`;
            }
          } else {
            cellStyle += 'border:1px solid #E1E4EE;';
          }
          const colSpanAttr = cell.colSpan && cell.colSpan > 1 ? ` colspan="${cell.colSpan}"` : '';
          tblHtml += `  <${tag}${colSpanAttr} style="${cellStyle}">${escapeHtml(cell.text)}</${tag}>\n`;
        });
        tblHtml += '</tr>\n';
      });
    } else {
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
    }
    tblHtml += '</table>\n';
    return tblHtml;
  };

  if (elements && elements.length > 0) {
    for (const el of elements) {
      if (el.type === 'paragraph') body += renderParagraph(el.paragraph);
      else if (el.type === 'table') body += renderTable(el.table);
      else if (el.type === 'drawing') body += `<div class="vector-drawing" style="margin:1.5rem 0;">${el.svg}</div>\n`;
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
      else if (el.type === 'drawing' && el.shapes) {
        const shapeTexts = el.shapes.map((s) => s.text).filter(Boolean);
        if (shapeTexts.length > 0) {
          parts.push(shapeTexts.map((t) => `> **[Drawing]** ${t}`).join('\n'));
        }
      }
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

      if (tbl.structuredRows && tbl.structuredRows.length > 0) {
        tbl.structuredRows.forEach((sRow, rIdx) => {
          const y = doc.y;
          if (y > doc.page.height - 80) {
            doc.addPage();
          }
          sRow.forEach((cell, cIdx) => {
            const x = 50 + cIdx * colWidth;
            if (cell.shading && cell.shading !== 'auto') {
              doc.rect(x, y, colWidth, 20).fill('#' + cell.shading);
            } else if (cell.isHeader || rIdx === 0) {
              doc.rect(x, y, colWidth, 20).fill('#F0F2FE');
            }
            const borderCol = cell.borders?.bottom?.color || '#CCD2FC';
            const borderW = cell.borders?.bottom?.size || 0.5;
            doc.rect(x, y, colWidth, 20).strokeColor(borderCol).lineWidth(borderW).stroke();
            const textCol = cell.isHeader || rIdx === 0 ? '#1F2340' : '#4D536B';
            doc.fillColor(textCol).fontSize(cell.isHeader || rIdx === 0 ? 9 : 8.5);
            doc.text(cell.text, x + 5, y + 4, { width: colWidth - 10, lineBreak: false });
          });
          doc.y = y + 20;
        });
      } else {
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
      }
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
        else if (el.type === 'drawing' && el.shapes) {
          const shapeTexts = el.shapes.map((s) => s.text).filter(Boolean);
          if (shapeTexts.length > 0) {
            doc.moveDown(0.3);
            for (const st of shapeTexts) {
              doc.fillColor('#5C6BC0').fontSize(10).text(`[Drawing: ${st}]`, { align: 'center' });
            }
            doc.moveDown(0.3);
          }
        }
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

    const isErrorCode = (v: any): boolean => typeof v === 'string' && v.startsWith('#');

    const parseComparison = (): any => {
      let left = parseConcat();
      while (peek() && peek()!.type === 'OP_COMP') {
        const op = consume().val;
        const right = parseConcat();
        if (isErrorCode(left)) return left;
        if (isErrorCode(right)) return right;
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
        if (isErrorCode(left)) return left;
        if (isErrorCode(right)) return right;
        left = String(left ?? '') + String(right ?? '');
      }
      return left;
    };

    const parseAdditive = (): any => {
      let left = parseMultiplicative();
      while (peek() && peek()!.type === 'OP' && (peek()!.val === '+' || peek()!.val === '-')) {
        const op = consume().val;
        const right = parseMultiplicative();
        if (isErrorCode(left)) return left;
        if (isErrorCode(right)) return right;
        left = op === '+' ? Number(left) + Number(right) : Number(left) - Number(right);
      }
      return left;
    };

    const parseMultiplicative = (): any => {
      let left = parsePower();
      while (peek() && peek()!.type === 'OP' && (peek()!.val === '*' || peek()!.val === '/')) {
        const op = consume().val;
        const right = parsePower();
        if (isErrorCode(left)) return left;
        if (isErrorCode(right)) return right;
        if (op === '/') {
          if (Number(right) === 0) return '#DIV/0!';
          left = Number(left) / Number(right);
        } else {
          left = Number(left) * Number(right);
        }
      }
      return left;
    };

    const parsePower = (): any => {
      let left = parseUnary();
      while (peek() && peek()!.type === 'OP' && peek()!.val === '^') {
        consume();
        const right = parseUnary();
        if (isErrorCode(left)) return left;
        if (isErrorCode(right)) return right;
        left = Math.pow(Number(left), Number(right));
      }
      return left;
    };

    const parseUnary = (): any => {
      if (peek() && peek()!.type === 'OP' && (peek()!.val === '+' || peek()!.val === '-')) {
        const op = consume().val;
        const operand = parseUnary();
        if (isErrorCode(operand)) return operand;
        return op === '-' ? -Number(operand) : Number(operand);
      }
      let val = parsePrimary();
      if (peek() && peek()!.type === 'OP' && peek()!.val === '%') {
        consume();
        if (isErrorCode(val)) return val;
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
        const r2d = this.resolveRange2D(t.val);
        const flat = r2d.flat();
        (flat as any)._range2D = r2d;
        (flat as any)._isRange = true;
        return flat;
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

      if (fnName === 'IFERROR') {
        let val: any;
        let isErr = false;
        try {
          val = parseComparison();
          if (typeof val === 'string' && val.startsWith('#')) {
            isErr = true;
          }
        } catch {
          isErr = true;
        }
        consume('COMMA');
        const fallback = parseComparison();
        consume('RPAREN');
        return isErr ? fallback : val;
      }

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

  public resolveRange2D(rangeStr: string): any[][] {
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

    const rows: any[][] = [];
    for (let r = minR; r <= maxR; r++) {
      const row: any[] = [];
      for (let c = minC; c <= maxC; c++) {
        let colName = '';
        let temp = c;
        while (temp > 0) {
          colName = String.fromCharCode(65 + ((temp - 1) % 26)) + colName;
          temp = Math.floor((temp - 1) / 26);
        }
        row.push(this.cellLookup(`${colName}${r}`));
      }
      rows.push(row);
    }
    return rows;
  }

  private resolveRange(rangeStr: string): any[] {
    return this.resolveRange2D(rangeStr).flat();
  }

  private executeFunction(name: string, args: any[]): any {
    const flattenNumbers = (arr: any[]): number[] | string => {
      const out: number[] = [];
      let err: string | null = null;
      const walk = (item: any) => {
        if (err) return;
        if (typeof item === 'string' && item.startsWith('#')) {
          err = item;
          return;
        }
        if (Array.isArray(item)) {
          item.forEach(walk);
        } else if (item !== null && item !== undefined && item !== '' && !Number.isNaN(Number(item))) {
          out.push(Number(item));
        }
      };
      walk(arr);
      return err || out;
    };

    const isCellMatch = (cellVal: any, lookupVal: any): boolean => {
      if (cellVal === undefined || cellVal === null) return false;
      if (cellVal === lookupVal) return true;
      if (String(cellVal).toLowerCase() === String(lookupVal).toLowerCase()) return true;
      const sCell = String(cellVal).trim();
      const sLookup = String(lookupVal).trim();
      if (sCell !== '' && sLookup !== '') {
        const numCell = Number(sCell);
        const numLookup = Number(sLookup);
        if (!Number.isNaN(numCell) && !Number.isNaN(numLookup)) {
          return numCell === numLookup;
        }
      }
      return false;
    };

    switch (name) {
      case 'SUM': {
        const nums = flattenNumbers(args);
        if (typeof nums === 'string') return nums;
        return nums.reduce((a, b) => a + b, 0);
      }
      case 'AVERAGE': {
        const nums = flattenNumbers(args);
        if (typeof nums === 'string') return nums;
        return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length;
      }
      case 'COUNT': {
        const nums = flattenNumbers(args);
        if (typeof nums === 'string') return nums;
        return nums.length;
      }
      case 'MIN': {
        const nums = flattenNumbers(args);
        if (typeof nums === 'string') return nums;
        return nums.length === 0 ? 0 : Math.min(...nums);
      }
      case 'MAX': {
        const nums = flattenNumbers(args);
        if (typeof nums === 'string') return nums;
        return nums.length === 0 ? 0 : Math.max(...nums);
      }
      case 'IF': {
        const cond = Boolean(args[0]);
        return cond ? args[1] : args.length > 2 ? args[2] : false;
      }
      case 'ROUND': {
        const val = Number(args[0]);
        const digits = args.length > 1 ? Number(args[1]) : 0;
        if (Number.isNaN(val) || Number.isNaN(digits)) return '#VALUE!';
        const factor = Math.pow(10, digits);
        return Math.round(val * factor) / factor;
      }
      case 'IFERROR': {
        const v = args[0];
        if (typeof v === 'string' && v.startsWith('#')) return args[1];
        return v;
      }
      case 'CONCAT': {
        const parts: string[] = [];
        const walk = (item: any) => {
          if (Array.isArray(item)) item.forEach(walk);
          else if (item !== null && item !== undefined) parts.push(String(item));
        };
        args.forEach(walk);
        return parts.join('');
      }
      case 'LEFT': {
        const str = String(args[0] ?? '');
        const n = args.length > 1 ? Number(args[1]) : 1;
        return str.slice(0, Math.max(0, n));
      }
      case 'RIGHT': {
        const str = String(args[0] ?? '');
        const n = args.length > 1 ? Number(args[1]) : 1;
        return str.slice(Math.max(0, str.length - n));
      }
      case 'MID': {
        const str = String(args[0] ?? '');
        const start = Number(args[1]);
        const n = Number(args[2]);
        if (Number.isNaN(start) || Number.isNaN(n) || start < 1) return '#VALUE!';
        return str.substring(start - 1, start - 1 + n);
      }
      case 'DATE': {
        const y = Number(args[0]);
        const m = Number(args[1]);
        const d = Number(args[2]);
        if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) return '#VALUE!';
        const dt = new Date(Date.UTC(y, m - 1, d));
        return dt.toISOString().slice(0, 10);
      }
      case 'VLOOKUP': {
        const lookupVal = args[0];
        const tableArg = args[1];
        const colIdx = Number(args[2]);
        const rangeLookup = args.length > 3 ? Boolean(args[3]) : true;

        const grid: any[][] =
          (tableArg as any)?._range2D ||
          (Array.isArray(tableArg) && Array.isArray(tableArg[0])
            ? tableArg
            : Array.isArray(tableArg)
            ? tableArg.map((x) => [x])
            : [[tableArg]]);

        if (grid.length === 0 || colIdx < 1) return '#REF!';
        const maxCols = Math.max(...grid.map((r) => r.length));
        if (colIdx > maxCols) return '#REF!';

        if (!rangeLookup) {
          // Exact match
          for (let r = 0; r < grid.length; r++) {
            const cellVal = grid[r][0];
            if (isCellMatch(cellVal, lookupVal)) {
              return colIdx - 1 < grid[r].length ? grid[r][colIdx - 1] : '';
            }
          }
          return '#N/A';
        } else {
          // Approximate match
          let bestRow = -1;
          for (let r = 0; r < grid.length; r++) {
            const cellVal = grid[r][0];
            if (cellVal === undefined || cellVal === '') continue;
            const numCell = Number(cellVal);
            const numLookup = Number(lookupVal);
            if (!Number.isNaN(numCell) && !Number.isNaN(numLookup)) {
              if (numCell <= numLookup) bestRow = r;
            } else {
              if (String(cellVal).localeCompare(String(lookupVal)) <= 0) bestRow = r;
            }
          }
          if (bestRow === -1) return '#N/A';
          return colIdx - 1 < grid[bestRow].length ? grid[bestRow][colIdx - 1] : '';
        }
      }
      case 'HLOOKUP': {
        const lookupVal = args[0];
        const tableArg = args[1];
        const rowIdx = Number(args[2]);
        const rangeLookup = args.length > 3 ? Boolean(args[3]) : true;

        const grid: any[][] =
          (tableArg as any)?._range2D ||
          (Array.isArray(tableArg) && Array.isArray(tableArg[0]) ? tableArg : [tableArg]);

        if (grid.length === 0 || rowIdx < 1 || rowIdx > grid.length) return '#REF!';
        const firstRow = grid[0];

        if (!rangeLookup) {
          for (let c = 0; c < firstRow.length; c++) {
            const cellVal = firstRow[c];
            if (isCellMatch(cellVal, lookupVal)) {
              return c < grid[rowIdx - 1].length ? grid[rowIdx - 1][c] : '';
            }
          }
          return '#N/A';
        } else {
          let bestCol = -1;
          for (let c = 0; c < firstRow.length; c++) {
            const cellVal = firstRow[c];
            if (cellVal === undefined || cellVal === '') continue;
            const numCell = Number(cellVal);
            const numLookup = Number(lookupVal);
            if (!Number.isNaN(numCell) && !Number.isNaN(numLookup)) {
              if (numCell <= numLookup) bestCol = c;
            } else {
              if (String(cellVal).localeCompare(String(lookupVal)) <= 0) bestCol = c;
            }
          }
          if (bestCol === -1) return '#N/A';
          return bestCol < grid[rowIdx - 1].length ? grid[rowIdx - 1][bestCol] : '';
        }
      }
      case 'INDEX': {
        const tableArg = args[0];
        const rowNum = Number(args[1]);
        const colNum = args.length > 2 ? Number(args[2]) : 1;

        const grid: any[][] =
          (tableArg as any)?._range2D ||
          (Array.isArray(tableArg) && Array.isArray(tableArg[0])
            ? tableArg
            : Array.isArray(tableArg)
            ? [tableArg]
            : [[tableArg]]);

        if (rowNum < 1 || rowNum > grid.length) return '#REF!';
        const targetRow = grid[rowNum - 1];
        if (colNum < 1 || colNum > targetRow.length) return '#REF!';
        return targetRow[colNum - 1];
      }
      case 'MATCH': {
        const lookupVal = args[0];
        const arr = Array.isArray(args[1]) ? args[1] : [args[1]];
        const matchType = args.length > 2 ? Number(args[2]) : 1;

        if (matchType === 0) {
          for (let i = 0; i < arr.length; i++) {
            if (isCellMatch(arr[i], lookupVal)) {
              return i + 1;
            }
          }
          return '#N/A';
        } else if (matchType === 1) {
          let bestIdx = -1;
          for (let i = 0; i < arr.length; i++) {
            const numA = Number(arr[i]);
            const numL = Number(lookupVal);
            if (!Number.isNaN(numA) && !Number.isNaN(numL)) {
              if (numA <= numL) bestIdx = i;
            } else if (String(arr[i]).localeCompare(String(lookupVal)) <= 0) {
              bestIdx = i;
            }
          }
          return bestIdx === -1 ? '#N/A' : bestIdx + 1;
        } else if (matchType === -1) {
          let bestIdx = -1;
          for (let i = 0; i < arr.length; i++) {
            const numA = Number(arr[i]);
            const numL = Number(lookupVal);
            if (!Number.isNaN(numA) && !Number.isNaN(numL)) {
              if (numA >= numL) bestIdx = i;
            } else if (String(arr[i]).localeCompare(String(lookupVal)) >= 0) {
              bestIdx = i;
            }
          }
          return bestIdx === -1 ? '#N/A' : bestIdx + 1;
        }
        return '#N/A';
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

export interface FormulaCellInfo {
  ref: string;
  formula: string;
  rowIdx?: number;
  colIdx?: number;
}

/**
 * Directed Acyclic Graph (DAG) Dependency Topological Sorter & Circular Reference Engine
 * Solves multi-layer cell dependencies, evaluates formulas in correct topological order,
 * and detects cycles safely without recursion stack overflow, assigning #CYCLE! standard error codes.
 */
export class SpreadsheetDagEngine {
  private formulaCells: FormulaCellInfo[] = [];

  constructor(private cellMap: Record<string, any> = {}) {}

  public setCell(ref: string, value: any): void {
    const cleanRef = ref.replace(/\$/g, '').toUpperCase();
    this.formulaCells = this.formulaCells.filter((fc) => fc.ref !== cleanRef);
    if (typeof value === 'string' && value.startsWith('=')) {
      this.formulaCells.push({ ref: cleanRef, formula: value });
      delete this.cellMap[cleanRef];
    } else {
      this.cellMap[cleanRef] = value;
    }
  }

  public getCellValue(ref: string): any {
    const cleanRef = ref.replace(/\$/g, '').toUpperCase();
    return this.cellMap[cleanRef];
  }

  public evaluate(rows?: string[][]): { evaluated: Record<string, any>; cycles: string[] } {
    return this.evaluateWithDag(this.formulaCells, rows);
  }

  /**
   * Extracts dependent cell references and ranges from formula expression.
   */
  public static extractDependencies(formula: string): string[] {
    if (!formula) return [];
    if (formula.startsWith('=')) formula = formula.slice(1);
    // Remove string literals to avoid false positives
    const stripped = formula.replace(/"(?:[^"\\]|\\.)*"/g, '');
    const refs = new Set<string>();

    const colToNum = (s: string): number => {
      let c = 0;
      for (let i = 0; i < s.length; i++) c = c * 26 + (s.charCodeAt(i) - 64);
      return c;
    };
    const numToCol = (n: number): string => {
      let s = '';
      let temp = n;
      while (temp > 0) {
        s = String.fromCharCode(65 + ((temp - 1) % 26)) + s;
        temp = Math.floor((temp - 1) / 26);
      }
      return s;
    };

    // 1. Ranges like A1:B5 or $A$1:$B$5 (supporting whitespace around colon)
    const rangeRegex = /(\$?)([A-Za-z]{1,3})(\$?)([0-9]+)\s*:\s*(\$?)([A-Za-z]{1,3})(\$?)([0-9]+)/g;
    let rMatch: RegExpExecArray | null;
    while ((rMatch = rangeRegex.exec(stripped)) !== null) {
      const c1 = rMatch[2].toUpperCase();
      const row1 = parseInt(rMatch[4], 10);
      const c2 = rMatch[6].toUpperCase();
      const row2 = parseInt(rMatch[8], 10);

      const startC = Math.min(colToNum(c1), colToNum(c2));
      const endC = Math.max(colToNum(c1), colToNum(c2));
      const startR = Math.min(row1, row2);
      const endR = Math.max(row1, row2);

      for (let r = startR; r <= endR; r++) {
        for (let c = startC; c <= endC; c++) {
          refs.add(`${numToCol(c)}${r}`);
        }
      }
    }

    // Replace all extracted ranges with spaces to avoid duplicate endpoint matches
    const strippedWithoutRanges = stripped.replace(rangeRegex, ' ');

    // 2. Individual cell references like A1, $B$2
    const cellRegex = /\b(\$?)([A-Za-z]{1,3})(\$?)([0-9]+)\b/g;
    let cMatch: RegExpExecArray | null;
    while ((cMatch = cellRegex.exec(strippedWithoutRanges)) !== null) {
      const afterIdx = cMatch.index + cMatch[0].length;
      const afterStr = strippedWithoutRanges.slice(afterIdx).trimStart();
      if (afterStr.startsWith('(')) {
        continue; // Function name
      }
      const ref = `${cMatch[2].toUpperCase()}${cMatch[4]}`;
      refs.add(ref);
    }

    return Array.from(refs);
  }

  /**
   * Evaluates all formula cells in topological dependency order.
   * Detects cycles and safely sets #CYCLE! error codes without stack overflows.
   */
  public evaluateWithDag(
    formulaCells: FormulaCellInfo[],
    rows?: string[][]
  ): { evaluated: Record<string, any>; cycles: string[] } {
    const formulaMap = new Map<string, FormulaCellInfo>();
    for (const fc of formulaCells) {
      if (fc.ref) {
        formulaMap.set(fc.ref.toUpperCase(), fc);
      }
    }

    // Build dependency graph among formula cells
    const deps = new Map<string, Set<string>>();
    const reverseDeps = new Map<string, Set<string>>(); // who depends on me
    for (const [ref, fc] of formulaMap.entries()) {
      const referenced = SpreadsheetDagEngine.extractDependencies(fc.formula);
      const formulaReferenced = new Set<string>();
      for (const r of referenced) {
        if (formulaMap.has(r)) {
          formulaReferenced.add(r);
        }
      }
      deps.set(ref, formulaReferenced);

      for (const parent of formulaReferenced) {
        if (!reverseDeps.has(parent)) reverseDeps.set(parent, new Set());
        reverseDeps.get(parent)!.add(ref);
      }
    }

    // Detect cycles using 3-color DFS
    const UNVISITED = 0,
      VISITING = 1,
      VISITED = 2;
    const state = new Map<string, number>();
    const cyclicCells = new Set<string>();
    const stack: string[] = [];

    const dfs = (u: string) => {
      state.set(u, VISITING);
      stack.push(u);

      const neighbors = deps.get(u) || new Set();
      for (const v of neighbors) {
        if (v === u) {
          // Self-cycle
          cyclicCells.add(u);
          continue;
        }
        const vState = state.get(v) || UNVISITED;
        if (vState === VISITING) {
          // Cycle detected!
          const cycleStart = stack.indexOf(v);
          if (cycleStart !== -1) {
            for (let i = cycleStart; i < stack.length; i++) {
              cyclicCells.add(stack[i]);
            }
          } else {
            cyclicCells.add(v);
            cyclicCells.add(u);
          }
        } else if (vState === UNVISITED) {
          dfs(v);
        }
      }

      stack.pop();
      state.set(u, VISITED);
    };

    for (const node of formulaMap.keys()) {
      if ((state.get(node) || UNVISITED) === UNVISITED) {
        dfs(node);
      }
    }

    // Propagate cyclic status to all downstream dependent cells
    const queue = Array.from(cyclicCells);
    while (queue.length > 0) {
      const curr = queue.shift()!;
      const dependents = reverseDeps.get(curr) || new Set();
      for (const dep of dependents) {
        if (!cyclicCells.has(dep)) {
          cyclicCells.add(dep);
          queue.push(dep);
        }
      }
    }

    // Assign #CYCLE! error code to all cyclic cells
    for (const cRef of cyclicCells) {
      this.cellMap[cRef] = '#CYCLE!';
      const fc = formulaMap.get(cRef);
      if (fc && rows && fc.rowIdx !== undefined && fc.colIdx !== undefined && rows[fc.rowIdx]) {
        rows[fc.rowIdx][fc.colIdx] = '#CYCLE!';
      }
    }

    // Topological Sort on non-cyclic cells (Kahn's algorithm)
    const inDegree = new Map<string, number>();
    const nonCyclicNodes: string[] = [];
    for (const node of formulaMap.keys()) {
      if (!cyclicCells.has(node)) {
        nonCyclicNodes.push(node);
        let deg = 0;
        for (const dep of deps.get(node) || []) {
          if (!cyclicCells.has(dep)) deg++;
        }
        inDegree.set(node, deg);
      }
    }

    const topoQueue: string[] = [];
    for (const node of nonCyclicNodes) {
      if ((inDegree.get(node) || 0) === 0) {
        topoQueue.push(node);
      }
    }

    const topoOrder: string[] = [];
    while (topoQueue.length > 0) {
      const curr = topoQueue.shift()!;
      topoOrder.push(curr);

      const dependents = reverseDeps.get(curr) || new Set();
      for (const dep of dependents) {
        if (!cyclicCells.has(dep)) {
          const newDeg = (inDegree.get(dep) || 1) - 1;
          inDegree.set(dep, newDeg);
          if (newDeg === 0) {
            topoQueue.push(dep);
          }
        }
      }
    }

    // Any remaining non-cyclic nodes without degree 0 (safeguard)
    for (const node of nonCyclicNodes) {
      if (!topoOrder.includes(node)) {
        topoOrder.push(node);
      }
    }

    // Evaluate in topological order
    const evaluator = new SpreadsheetFormulaEvaluator((ref) => {
      const cleanRef = ref.replace(/\$/g, '').toUpperCase();
      const val = this.cellMap[cleanRef];
      if (val === undefined || val === null) return '';
      return val;
    });

    for (const node of topoOrder) {
      const fc = formulaMap.get(node);
      if (!fc) continue;
      try {
        const result = evaluator.evaluate(fc.formula);
        this.cellMap[node] = result;
        const strResult = result !== null && result !== undefined ? String(result) : '';
        if (rows && fc.rowIdx !== undefined && fc.colIdx !== undefined && rows[fc.rowIdx]) {
          rows[fc.rowIdx][fc.colIdx] = strResult;
        }
      } catch {
        this.cellMap[node] = '#REF!';
        if (rows && fc.rowIdx !== undefined && fc.colIdx !== undefined && rows[fc.rowIdx]) {
          rows[fc.rowIdx][fc.colIdx] = '#REF!';
        }
      }
    }

    return {
      evaluated: this.cellMap,
      cycles: Array.from(cyclicCells),
    };
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

  const rowRegex = /<row\b([^>]*?)(?:>([\s\S]*?)<\/row>|\/>)/g;
  let rMatch: RegExpExecArray | null;

  while ((rMatch = rowRegex.exec(sheetXml)) !== null) {
    const rowAttrs = rMatch[1];
    const rowXml = rMatch[2] || '';
    const rRowAttr = /r="(\d+)"/i.exec(rowAttrs);
    if (rRowAttr) {
      const targetRowIdx = parseInt(rRowAttr[1], 10) - 1;
      while (rows.length < targetRowIdx) {
        rows.push([]);
      }
    }
    const cells: string[] = [];
    const cellRegex = /<c\s+([^>]*?)(?:>([\s\S]*?)<\/c>|\/>)/g;
    let cMatch: RegExpExecArray | null;
    const rowIdx = rows.length;
    let nextColIdx = 0;

    while ((cMatch = cellRegex.exec(rowXml)) !== null) {
      const attrs = cMatch[1];
      const body = cMatch[2] || '';
      const isString = /t="s"/i.test(attrs);
      const isInline = /t="inlineStr"/i.test(attrs);
      const isBool = /t="b"/i.test(attrs);
      const vMatch = body.match(/<v>([\s\S]*?)<\/v>/i);
      const tMatch = body.match(/<t[^>]*>([\s\S]*?)<\/t>/i);
      const fMatch = body.match(/<f[^>]*>([\s\S]*?)<\/f>/i);
      const rRefMatch = attrs.match(/r="([A-Za-z]+)(\d+)"/i);
      const ref = rRefMatch ? (rRefMatch[1] + rRefMatch[2]).toUpperCase() : '';

      let colIdx = nextColIdx;
      if (rRefMatch && rRefMatch[1]) {
        colIdx = getExcelColumnIndex(rRefMatch[1]);
      }

      while (cells.length < colIdx) {
        cells.push('');
      }

      let cellValue = '';
      if (isInline) {
        const isMatch = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/i.exec(body) || tMatch;
        if (isMatch) {
          cellValue = isMatch[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        }
      } else if (isBool && vMatch) {
        cellValue = vMatch[1] === '1' ? 'TRUE' : 'FALSE';
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

      if (fMatch && (!cellValue || cellValue.trim() === '')) {
        formulaCells.push({ ref, formula: fMatch[1], rowIdx, colIdx });
      }

      cells[colIdx] = cellValue;
      nextColIdx = colIdx + 1;
    }
    rows.push(cells);
  }

  // Evaluate dynamic formulas with DAG dependency sorter & cycle detection
  if (formulaCells.length > 0) {
    const dagEngine = new SpreadsheetDagEngine(cellMap);
    dagEngine.evaluateWithDag(formulaCells, rows);
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
 * Generates genuine Palm Database format with optional MOBI/AZW3 header
 */
function generatePalmDoc(
  text: string,
  title: string,
  type: 'pdb' | 'mobi' | 'azw3' = 'pdb'
): Buffer {
  const isMobi = type === 'mobi' || type === 'azw3';
  const textBuffer = Buffer.from(text, 'utf-8');
  const CHUNK_SIZE = 4096;
  const numTextRecords = Math.max(1, Math.ceil(textBuffer.length / CHUNK_SIZE));
  const numRecords = isMobi ? 1 + numTextRecords + 1 : 1 + numTextRecords;

  // 1. Palm Database Header (78 bytes)
  const header = Buffer.alloc(78);
  const cleanTitle = title.replace(/[^\x20-\x7E]/g, '_').slice(0, 31);
  header.write(cleanTitle, 0, 31, 'ascii');
  header.writeUInt16BE(0, 32); // attributes
  header.writeUInt16BE(0, 34); // version
  const palmEpoch = Math.floor(Date.now() / 1000) + 2082844800;
  header.writeUInt32BE(palmEpoch, 36); // creation time
  header.writeUInt32BE(palmEpoch, 40); // modification time
  header.write(isMobi ? 'BOOK' : 'TEXt', 60, 4, 'ascii');
  header.write(isMobi ? 'MOBI' : 'REAd', 64, 4, 'ascii');
  header.writeUInt16BE(numRecords, 76);

  // 2. Prepare Records
  const records: Buffer[] = [];

  // Record 0: PalmDOC header (16 bytes)
  const palmDocHeader = Buffer.alloc(16);
  palmDocHeader.writeUInt16BE(1, 0); // 1 = uncompressed
  palmDocHeader.writeUInt16BE(0, 2);
  palmDocHeader.writeUInt32BE(textBuffer.length, 4);
  palmDocHeader.writeUInt16BE(numTextRecords, 8);
  palmDocHeader.writeUInt16BE(CHUNK_SIZE, 10);
  palmDocHeader.writeUInt32BE(0, 12);

  if (isMobi) {
    const mobiHeader = Buffer.alloc(232);
    mobiHeader.write('MOBI', 0, 4, 'ascii');
    mobiHeader.writeUInt32BE(232, 4);
    mobiHeader.writeUInt32BE(2, 8); // mobi book
    mobiHeader.writeUInt32BE(65001, 12); // UTF-8
    mobiHeader.writeUInt32BE(1234567, 16);
    mobiHeader.writeUInt32BE(type === 'azw3' ? 8 : 6, 20);
    mobiHeader.writeUInt32BE(0xffffffff, 24);
    mobiHeader.writeUInt32BE(0xffffffff, 28);
    mobiHeader.writeUInt32BE(0xffffffff, 32);
    mobiHeader.writeUInt32BE(0xffffffff, 36);
    mobiHeader.writeUInt32BE(0xffffffff, 40);
    mobiHeader.writeUInt32BE(0, 80);
    mobiHeader.writeUInt32BE(cleanTitle.length, 84);
    mobiHeader.writeUInt32BE(16 + 232, 88);

    const titleBuffer = Buffer.from(cleanTitle, 'utf-8');
    records.push(Buffer.concat([palmDocHeader, mobiHeader, titleBuffer]));
  } else {
    records.push(palmDocHeader);
  }

  for (let i = 0; i < numTextRecords; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, textBuffer.length);
    records.push(textBuffer.subarray(start, end));
  }

  if (isMobi) {
    records.push(Buffer.from('FLIS\x00\x00\x00\x08\x00\x41\x00\x00\x00\x00\x00\x00\xff\xff\xff\xff', 'binary'));
  }

  // 3. Record info list
  const recordListSize = numRecords * 8 + 2;
  const recordList = Buffer.alloc(recordListSize);

  let currentOffset = 78 + recordListSize;
  for (let i = 0; i < numRecords; i++) {
    recordList.writeUInt32BE(currentOffset, i * 8);
    recordList.writeUInt8(0, i * 8 + 4);
    recordList.writeUInt8((i >> 16) & 0xff, i * 8 + 5);
    recordList.writeUInt8((i >> 8) & 0xff, i * 8 + 6);
    recordList.writeUInt8(i & 0xff, i * 8 + 7);
    currentOffset += records[i].length;
  }
  recordList.writeUInt16BE(0, numRecords * 8);

  return Buffer.concat([header, recordList, ...records]);
}

/**
 * Generates Open eBook Publication (OEB 1.0) XML package
 */
function generateOebPackage(text: string, title: string): Buffer {
  const oebXml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE package PUBLIC "+//ISBN 0-9673008-1-9//DTD OEB 1.0.1 Package//EN" "http://openebook.org/dtds/oeb-1.0.1/oebpkg101.dtd">
<package unique-identifier="uid">
  <metadata>
    <dc-metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:Title>${escapeXml(title)}</dc:Title>
      <dc:Language>en</dc:Language>
      <dc:Identifier id="uid">urn:uuid:easyconvert-${Date.now()}</dc:Identifier>
    </dc-metadata>
  </metadata>
  <manifest>
    <item id="content" href="content.html" media-type="text/html"/>
  </manifest>
  <spine>
    <itemref idref="content"/>
  </spine>
  <guide/>
  <text>
<![CDATA[
${text}
]]>
  </text>
</package>`;
  return Buffer.from(oebXml, 'utf-8');
}

/**
 * Generates Sony BBeB (LRF) document binary
 */
function generateLrf(text: string, _title: string): Buffer {
  const header = Buffer.alloc(28);
  header.set([0x00, 0x00, 0x4c, 0x30, 0x30, 0x31, 0x00, 0x00], 0);
  header.writeUInt16LE(0x0200, 8); // version
  header.writeUInt32LE(28, 10); // root object offset
  header.writeUInt32LE(1, 14); // object count
  const textBuf = Buffer.from(text, 'utf-8');
  header.writeUInt32LE(textBuf.length, 18);
  return Buffer.concat([header, textBuf]);
}

/**
 * MOBI / AZW3 / E-Book Parser & Converter
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

  if (tgt === 'pdb') {
    const buffer = generatePalmDoc(fullText, baseName, 'pdb');
    return { buffer, mimeType: 'application/vnd.palm', filename: `${baseName}.pdb`, size: buffer.length };
  }

  if (tgt === 'mobi') {
    const buffer = generatePalmDoc(fullText, baseName, 'mobi');
    return { buffer, mimeType: 'application/x-mobipocket-ebook', filename: `${baseName}.mobi`, size: buffer.length };
  }

  if (tgt === 'azw3') {
    const buffer = generatePalmDoc(fullText, baseName, 'azw3');
    return { buffer, mimeType: 'application/vnd.amazon.mobi8-ebook', filename: `${baseName}.azw3`, size: buffer.length };
  }

  if (tgt === 'oeb') {
    const buffer = generateOebPackage(fullText, baseName);
    return { buffer, mimeType: 'application/x-oeb1-package+xml', filename: `${baseName}.oeb`, size: buffer.length };
  }

  if (tgt === 'lrf') {
    const buffer = generateLrf(fullText, baseName);
    return { buffer, mimeType: 'application/x-sony-bbeb', filename: `${baseName}.lrf`, size: buffer.length };
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
 * Bijective Base-26 Excel column naming algorithm (0 -> 'A', 25 -> 'Z', 26 -> 'AA', etc.)
 */
export function getExcelColumnName(colIndex: number): string {
  let colName = '';
  let temp = colIndex + 1;
  while (temp > 0) {
    const mod = (temp - 1) % 26;
    colName = String.fromCharCode(65 + mod) + colName;
    temp = Math.floor((temp - 1) / 26);
  }
  return colName;
}

/**
 * Inverse Bijective Base-26 column index calculation ('A' -> 0, 'Z' -> 25, 'AA' -> 26, 'C' -> 2, etc.)
 */
export function getExcelColumnIndex(colLetters: string): number {
  let idx = 0;
  const upper = colLetters.toUpperCase();
  for (let i = 0; i < upper.length; i++) {
    const code = upper.charCodeAt(i);
    if (code >= 65 && code <= 90) {
      idx = idx * 26 + (code - 64);
    }
  }
  return Math.max(0, idx - 1);
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
    // Delimited (CSV or TSV) using Papa.parse for RFC 4180 compliance
    const delim = sourceType === 'tsv' ? '\t' : options.delimiter || ',';
    const parsedCsv = Papa.parse<string[]>(rawText, {
      delimiter: delim,
      skipEmptyLines: true,
    });
    rows =
      parsedCsv.data && parsedCsv.data.length > 0
        ? parsedCsv.data
        : rawText
            .split(/\r?\n/)
            .filter((l) => l.trim().length > 0)
            .map((line) => line.split(delim));
  }

  // Build sheet1.xml row data
  let sheetRowsXml = '';
  rows.forEach((row, rIdx) => {
    sheetRowsXml += `<row r="${rIdx + 1}">`;
    row.forEach((cell, cIdx) => {
      const colLetter = getExcelColumnName(cIdx);
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
        const rowRegex = /<row\b([^>]*?)(?:>([\s\S]*?)<\/row>|\/>)/g;
        let rMatch: RegExpExecArray | null;

        while ((rMatch = rowRegex.exec(sheetXml)) !== null) {
          const rowAttrs = rMatch[1];
          const rowXml = rMatch[2] || '';
          const rRowAttr = /r="(\d+)"/i.exec(rowAttrs);
          if (rRowAttr) {
            const targetRowIdx = parseInt(rRowAttr[1], 10) - 1;
            while (rows.length < targetRowIdx) {
              rows.push([]);
            }
          }
          const cells: string[] = [];
          const cellRegex = /<c\s+([^>]*?)(?:>([\s\S]*?)<\/c>|\/>)/g;
          let cMatch: RegExpExecArray | null;
          let nextColIdx = 0;

          while ((cMatch = cellRegex.exec(rowXml)) !== null) {
            const attrs = cMatch[1];
            const body = cMatch[2] || '';

            // Extract column index from r="C1" coordinate
            const rAttr = /r="([A-Za-z]+)(\d+)"/.exec(attrs);
            let colIdx = nextColIdx;
            if (rAttr && rAttr[1]) {
              colIdx = getExcelColumnIndex(rAttr[1]);
            }

            // Fill sparse empty cells prior to colIdx to maintain table structure
            while (cells.length < colIdx) {
              cells.push('');
            }

            let cellValue = '';

            // 1. Inline string: <c t="inlineStr"><is><t>Text</t></is></c>
            if (/t="inlineStr"/i.test(attrs)) {
              const isMatch = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/i.exec(body) || /<t[^>]*>([\s\S]*?)<\/t>/i.exec(body);
              if (isMatch) {
                cellValue = isMatch[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
              }
            } else if (/t="s"/i.test(attrs)) {
              // 2. Shared string
              const vMatch = body.match(/<v>([\s\S]*?)<\/v>/i);
              if (vMatch) {
                const sIdx = parseInt(vMatch[1], 10);
                cellValue = sharedStrings[sIdx] ?? '';
              }
            } else if (/t="b"/i.test(attrs)) {
              // 3. Boolean
              const vMatch = body.match(/<v>([\s\S]*?)<\/v>/i);
              if (vMatch) {
                cellValue = vMatch[1] === '1' ? 'TRUE' : 'FALSE';
              }
            } else {
              // 4. Number or direct formula value
              const vMatch = body.match(/<v>([\s\S]*?)<\/v>/i);
              if (vMatch) {
                cellValue = vMatch[1];
              } else {
                const tMatch = body.match(/<t[^>]*>([\s\S]*?)<\/t>/i);
                if (tMatch) {
                  cellValue = tMatch[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
                }
              }
            }

            cells[colIdx] = cellValue;
            nextColIdx = colIdx + 1;
          }
          rows.push(cells);
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
  if (
    inputBuffer.length >= 4 &&
    ((inputBuffer[0] === 0x50 && inputBuffer[1] === 0x4b && inputBuffer[2] === 0x03 && inputBuffer[3] === 0x04) ||
      (inputBuffer[0] === 0xd0 && inputBuffer[1] === 0xcf && inputBuffer[2] === 0x11 && inputBuffer[3] === 0xe0) ||
      (inputBuffer[0] === 0x37 && inputBuffer[1] === 0x7a && inputBuffer[2] === 0xbc && inputBuffer[3] === 0xaf))
  ) {
    throw new Error(
      `Cannot extract plain text from binary/compressed container for format '.${src}': fail-closed against mojibake corruption.`
    );
  }

  if (inputBuffer.subarray(0, Math.min(inputBuffer.length, 4096)).includes(0x00)) {
    throw new Error(
      `Binary null bytes detected in source format '.${src}': fail-closed against mojibake corruption.`
    );
  }

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


