import crypto from 'node:crypto';
import JSZip from 'jszip';
import Papa from 'papaparse';
import PDFDocument from 'pdfkit';
import sharp, { type Sharp } from 'sharp';
import { assertEmbeddableImageWithinLimit, openInputImage, openLimitedSharp, rethrowInputPixelLimit } from './image-input-limits';
import { ConversionOptions, ConversionResult, ConversionFailedError, EngineUnavailableError, InvalidSheetIndexError, PayloadLimitError } from '../types';
import { extractTextFromPdf, extractEmbeddedImageFromPdf, extractStructuredTextFromPdf } from './pdf-utils';
import { analyzeDocumentLayout, DlaBoundingBox } from './dla-engine';
import { performOcr } from './ocr';
import { AVIF_EFFORT, AVIF_TUNE, decodeBmp, encodeBmp, encodePostscript } from './image';
import { convertHwp, parseHwpDocument, buildHwpCompoundFile, isCfbfContainer, parseCfbf } from './hwp';
import { buildOpenXpsPackage, XpsPageInput } from './openxps';
import { assertNoComplexScript } from './ctl';
import { PdfUnicodeTextWriter, loadFontCoverageIndex, preferredUnicodeFontPath } from './pdf-fonts';
import { readDocText } from './office/doc-reader';
import { readRtfText } from './office/rtf-reader';
import { readPptSlides } from './office/ppt-reader';
import { readMobiText } from './office/mobi-reader';
import { readPmlText } from './office/pml-reader';
import { extractPrintReplicaPdf } from './office/print-replica';
import { extract7zArchive, extractRarArchive } from './archive';
import { htmlToText } from './office/html-text';
import { decodeWindows1252 } from './office/windows-1252';
import { EncryptedOfficeDocumentError } from './office/legacy-office-errors';
import { renderPdfTables } from './pdf-table-layout';

export { buildOpenXpsPackage };

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
  // PDF and raster writers draw text with installed fonts found through the coverage index.
  await loadFontCoverageIndex();

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

  // 8. Other presentation sources: PowerPoint 97-2003 binary, PowerPoint templates and Keynote
  if (src === 'ppt') {
    return convertPptSource(inputBuffer, tgt, options, baseName);
  }
  if (src === 'potx') {
    return convertPotxSource(inputBuffer, tgt, options, baseName);
  }
  if (src === 'key') {
    throw new EngineUnavailableError('soffice', 'Keynote presentations are read by LibreOffice; the in-process engine has no Keynote reader.');
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
    return convertOpenDocumentGraphicSource(inputBuffer, src, tgt);
  }

  // 12.35 AZW4 (Print Replica: a PDF inside a PalmDB container) and CBC (a collection of comic archives)
  if (src === 'azw4') {
    return viaPdf(await extractPrintReplicaPdf(inputBuffer), tgt, options, baseName);
  }
  if (src === 'cbc') {
    return convertCbcSource(inputBuffer, tgt, options, baseName);
  }

  // 12.4 HTMLZ, TXTZ, PML, OEB (Ebooks)
  if (['htmlz', 'txtz', 'pml', 'oeb'].includes(src)) {
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

  // 23.2 Target is OpenXPS / XPS
  if (tgt === 'xps' || tgt === 'oxps') {
    const textContent = await extractTextContentForOffice(inputBuffer, src, options, baseName);
    const lines = textContent.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const buffer = await buildOpenXpsPackage([{ title: baseName, lines }], baseName);
    return {
      buffer,
      mimeType: 'application/oxps',
      filename: `${baseName}.${tgt}`,
      size: buffer.length,
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
    const rtf = `{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Times New Roman;}}\\fs24 ${escapeRtf(textContent)}}\n`;
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
    const structuredPdf = extractStructuredTextFromPdf(inputBuffer);
    let extracted = structuredPdf.text;
    if (!extracted || extracted.trim() === '' || options.ocrEnabled) {
      const embeddedImg = extractEmbeddedImageFromPdf(inputBuffer);
      if (embeddedImg) {
        const ocr = await performOcr(embeddedImg, options.ocrLanguage, undefined, options.ocrDetectOrientation);
        if (ocr.text) extracted = ocr.text;
      } else {
        const ocr = await performOcr(inputBuffer, options.ocrLanguage, undefined, options.ocrDetectOrientation);
        if (ocr.text) extracted = ocr.text;
      }
    } else if (structuredPdf.blocks && structuredPdf.blocks.length > 0) {
      const dlaBoxes: DlaBoundingBox[] = structuredPdf.blocks.map((b) => ({
        x: b.x,
        y: b.y,
        width: Math.max(1, b.width),
        height: Math.max(1, b.height),
        text: b.text,
        fontSize: b.fontSize,
      }));
      const layout = analyzeDocumentLayout(dlaBoxes, 612, 792);
      if (layout.blocks && layout.blocks.length > 0) {
        extracted = layout.blocks
          .map((b) => {
            if (b.type === 'heading') return `## ${b.text}`;
            if (b.type === 'list_item') return `- ${b.text.replace(/^[•\-\*]\s*/, '')}`;
            if (b.type === 'header') return `*${b.text}*\n\n---`;
            if (b.type === 'footer') return `---\n*${b.text}*`;
            return b.text;
          })
          .join('\n\n');
      }
    }
    return extracted;
  }

  if (src === 'rtf') {
    return extractTextFromRtf(inputBuffer);
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
  return readOdtText(buffer);
}

/**
 * Text of a Word 97-2003 binary document, read through its CLX piece table ([MS-DOC]). Malformed input
 * throws a LegacyOfficeFormatError (400) and an encrypted document an EncryptedOfficeDocumentError (422).
 */
export function extractTextFromDoc(buffer: Buffer): string {
  return readDocText(buffer);
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
 * Text of an RTF document: groups, \uN escapes with \ucN fallbacks, \'hh bytes in the document or font
 * code page, and non-text destinations are handled by the tokenizer. Malformed input throws a
 * LegacyOfficeFormatError (400).
 */
export function extractTextFromRtf(rtf: Buffer): string {
  return readRtfText(rtf);
}

// ---------------------------------------------------------------------------
// E-book and OpenDocument text readers
// ---------------------------------------------------------------------------

/** EPUB: the most spine items, the largest decoded chapter and the most text one book may hold. */
const EPUB_MAX_SPINE_ITEMS = 10_000;
const EPUB_MAX_CHAPTER_BYTES = 32 * 1024 * 1024;
const EPUB_MAX_TEXT_CHARS = 128 * 1024 * 1024;
const EPUB_CONTAINER_PATH = 'META-INF/container.xml';
const EPUB_ENCRYPTION_PATH = 'META-INF/encryption.xml';
const EPUB_PACKAGE_MEDIA_TYPE = 'application/oebps-package+xml';
/** Spine items that hold readable text: XHTML content documents (EPUB 2 and 3) and HTML. */
const EPUB_TEXT_MEDIA_TYPES: ReadonlySet<string> = new Set(['application/xhtml+xml', 'text/html']);
/** Encryption methods that only obfuscate embedded fonts; every other method hides the content itself. */
// Algorithm identifiers from the EPUB OCF specification: namespace names compared as strings, never fetched.
const EPUB_FONT_OBFUSCATION_ALGORITHMS: ReadonlySet<string> = new Set([
  'http://www.idpf.org/2008/embedding', // NOSONAR: a spec-defined identifier, not a network address
  'http://ns.adobe.com/pdf/enc#RC', // NOSONAR: a spec-defined identifier, not a network address
]);
const PARAGRAPH_SEPARATOR = '\n\n';

const UTF8_BOM = [0xef, 0xbb, 0xbf];
const UTF16LE_BOM = [0xff, 0xfe];
const UTF16BE_BOM = [0xfe, 0xff];
const XML_DECLARATION_SCAN_BYTES = 200;
const XML_ENCODING_PATTERN = /<\?xml[^>]*\bencoding\s*=\s*["']([A-Za-z0-9._-]+)["']/;

function startsWithBytes(buffer: Buffer, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => buffer[index] === byte);
}

/** Text of an XML or XHTML file: its byte order mark, or else the encoding its declaration names, or UTF-8. */
function decodeXmlBytes(bytes: Buffer, what: string): string {
  if (startsWithBytes(bytes, UTF8_BOM)) return bytes.toString('utf-8', UTF8_BOM.length);
  if (startsWithBytes(bytes, UTF16LE_BOM)) return bytes.toString('utf16le', UTF16LE_BOM.length);
  if (startsWithBytes(bytes, UTF16BE_BOM)) {
    const swapped = Buffer.from(bytes.subarray(UTF16BE_BOM.length));
    return swapped.swap16().toString('utf16le');
  }
  const label = XML_ENCODING_PATTERN.exec(bytes.toString('latin1', 0, XML_DECLARATION_SCAN_BYTES))?.[1]?.toLowerCase();
  if (label === undefined || label === 'utf-8' || label === 'utf8') return bytes.toString('utf-8');
  if (label === 'windows-1252' || label === 'cp1252') return decodeWindows1252(bytes);
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    throw new ConversionFailedError(`The ${what} declares the encoding "${label}", which cannot be decoded.`);
  }
}

/** Opens a ZIP package; anything that is not one is a typed 400 error naming the format. */
async function openPackage(input: Buffer, format: string): Promise<JSZip> {
  try {
    return await JSZip.loadAsync(input);
  } catch {
    throw new ConversionFailedError(`The ${format} file is not a valid ZIP package.`);
  }
}

/** Reads one package entry as bytes, refusing one that declares or holds more than `limit` bytes. */
async function readPackageEntry(zip: JSZip, entryPath: string, limit: number, what: string): Promise<Buffer> {
  const entry = zip.file(entryPath);
  if (!entry) throw new ConversionFailedError(`The ${what} names "${entryPath}", which is not in the package.`);
  const declared = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
  if (declared !== undefined && declared > limit) {
    throw new PayloadLimitError(`"${entryPath}" declares ${declared} bytes, more than the ${limit} byte limit.`);
  }
  const bytes = await entry.async('nodebuffer');
  if (bytes.length > limit) throw new PayloadLimitError(`"${entryPath}" holds ${bytes.length} bytes, more than the ${limit} byte limit.`);
  return bytes;
}

/** The package path a manifest `href` names, relative to the directory of the file that holds it; never above the package root. */
function resolvePackagePath(baseDirectory: string, href: string): string {
  let target = href.split('#')[0];
  try {
    target = decodeURIComponent(target);
  } catch {
    throw new ConversionFailedError(`The package reference "${href}" is not a valid URI.`);
  }
  const segments = (target.startsWith('/') ? target.slice(1) : `${baseDirectory}${target}`).split('/');
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (resolved.pop() === undefined) throw new ConversionFailedError(`The package reference "${href}" points outside the package.`);
    } else {
      resolved.push(segment);
    }
  }
  return resolved.join('/');
}

/** Paths of the package entries META-INF/encryption.xml encrypts with a method other than font obfuscation. */
async function encryptedEpubPaths(zip: JSZip): Promise<Set<string>> {
  const encrypted = new Set<string>();
  const file = zip.file(EPUB_ENCRYPTION_PATH);
  if (!file) return encrypted;
  const xml = decodeXmlBytes(await file.async('nodebuffer'), 'EPUB encryption.xml');
  for (const data of safeExtractXmlElements(xml, ['EncryptedData', 'enc:EncryptedData'])) {
    const algorithm = safeExtractFirstXmlElement(data.content, ['EncryptionMethod', 'enc:EncryptionMethod'])?.attrs.Algorithm;
    const uri = safeExtractFirstXmlElement(data.content, ['CipherReference', 'enc:CipherReference'])?.attrs.URI;
    if (uri !== undefined && !EPUB_FONT_OBFUSCATION_ALGORITHMS.has(algorithm ?? '')) {
      encrypted.add(resolvePackagePath('', uri));
    }
  }
  return encrypted;
}

/**
 * The text of an EPUB in reading order (EPUB Packages 3.3 and Open Packaging Format 2.0.1): META-INF/container.xml
 * names the package document, whose spine lists the content documents, and each XHTML document contributes its
 * body text. Navigation documents, scripts and styles are not text. A book with no text, a DRM-protected one or a
 * broken package is a typed error.
 */
async function readEpubText(input: Buffer): Promise<string> {
  const zip = await openPackage(input, 'EPUB');
  const container = zip.file(EPUB_CONTAINER_PATH);
  if (!container) throw new ConversionFailedError(`The EPUB has no ${EPUB_CONTAINER_PATH}, so its package document cannot be found.`);
  const containerXml = decodeXmlBytes(await container.async('nodebuffer'), 'EPUB container.xml');
  const rootfile = safeExtractXmlElements(containerXml, ['rootfile', 'container:rootfile']).find(
    (el) => el.attrs['full-path'] && (el.attrs['media-type'] ?? EPUB_PACKAGE_MEDIA_TYPE) === EPUB_PACKAGE_MEDIA_TYPE
  );
  if (!rootfile) throw new ConversionFailedError(`${EPUB_CONTAINER_PATH} names no package document.`);
  const packagePath = resolvePackagePath('', rootfile.attrs['full-path']);
  const packageDirectory = packagePath.includes('/') ? packagePath.slice(0, packagePath.lastIndexOf('/') + 1) : '';
  const packageXml = decodeXmlBytes(await readPackageEntry(zip, packagePath, EPUB_MAX_CHAPTER_BYTES, 'EPUB container.xml'), 'EPUB package document');

  const manifest = new Map<string, { href: string; mediaType: string; properties: string }>();
  for (const item of safeExtractXmlElements(packageXml, ['item', 'opf:item'], { maxElements: EPUB_MAX_SPINE_ITEMS * 4 })) {
    if (item.attrs.id && item.attrs.href) {
      manifest.set(item.attrs.id, { href: item.attrs.href, mediaType: item.attrs['media-type'] ?? '', properties: item.attrs.properties ?? '' });
    }
  }
  const spine = safeExtractXmlElements(packageXml, ['itemref', 'opf:itemref'], { maxElements: EPUB_MAX_SPINE_ITEMS + 1 });
  if (spine.length === 0) throw new ConversionFailedError('The EPUB package document has an empty spine.');
  if (spine.length > EPUB_MAX_SPINE_ITEMS) {
    throw new PayloadLimitError(`The EPUB spine lists more than ${EPUB_MAX_SPINE_ITEMS} content documents.`);
  }

  const encrypted = await encryptedEpubPaths(zip);
  const chapters: string[] = [];
  let totalChars = 0;
  for (const itemref of spine) {
    const item = manifest.get(itemref.attrs.idref ?? '');
    if (!item) throw new ConversionFailedError(`The EPUB spine names "${itemref.attrs.idref}", which the manifest does not list.`);
    if (!EPUB_TEXT_MEDIA_TYPES.has(item.mediaType) || item.properties.split(/\s+/).includes('nav')) continue;
    const chapterPath = resolvePackagePath(packageDirectory, item.href);
    if (encrypted.has(chapterPath)) {
      throw new EncryptedOfficeDocumentError('The EPUB content is protected by DRM, so its text cannot be read.');
    }
    const text = htmlToText(decodeXmlBytes(await readPackageEntry(zip, chapterPath, EPUB_MAX_CHAPTER_BYTES, 'EPUB spine'), `EPUB chapter ${chapterPath}`));
    if (text === '') continue;
    totalChars += text.length;
    if (totalChars > EPUB_MAX_TEXT_CHARS) throw new PayloadLimitError(`The EPUB text is longer than ${EPUB_MAX_TEXT_CHARS} characters.`);
    chapters.push(text);
  }
  if (chapters.length === 0) throw new ConversionFailedError('The EPUB holds no text.');
  return chapters.join(PARAGRAPH_SEPARATOR);
}

/** OpenDocument text: the most characters one document may hold, and the longest run one `text:s` element may stand for. */
const ODT_MAX_TEXT_CHARS = 128 * 1024 * 1024;
const ODT_MAX_SPACE_RUN = 1000;
const ODF_TEXT_MIMETYPE_PREFIX = 'application/vnd.oasis.opendocument.text';
const ODF_MANIFEST_PATH = 'META-INF/manifest.xml';

/** The text of one text:p or text:h element: spaces, tabs and line breaks (text:s, text:tab, text:line-break) are characters. */
function odfParagraphText(content: string): string {
  const withoutNotes = content.replace(/<text:note\b[^>]*>[\s\S]*?<\/text:note>/g, '');
  const spaced = withoutNotes
    .replace(/<text:line-break\s*\/>/g, '\n')
    .replace(/<text:tab\s*\/>/g, '\t')
    .replace(/<text:s(?:\s+text:c="(\d+)")?\s*\/>/g, (_, count?: string) => ' '.repeat(Math.min(count === undefined ? 1 : Number(count), ODT_MAX_SPACE_RUN)));
  return safeDecodeXmlEntities(spaced.replace(/<[^>]+>/g, ''));
}

/**
 * The paragraphs and headings of an OpenDocument text file in document order (ODF 1.3, text:p and text:h). A file
 * that is not an OpenDocument text package, an encrypted one, or one without text is a typed error.
 */
async function readOdtText(input: Buffer): Promise<string> {
  const zip = await openPackage(input, 'ODT');
  const mimetype = await zip.file('mimetype')?.async('text');
  if (mimetype !== undefined && !mimetype.startsWith(ODF_TEXT_MIMETYPE_PREFIX)) {
    throw new ConversionFailedError('The ODT file is not an OpenDocument text document.');
  }
  const content = zip.file('content.xml');
  if (!content) throw new ConversionFailedError('The ODT file has no content.xml.');
  const manifest = zip.file(ODF_MANIFEST_PATH);
  if (manifest) {
    const entry = safeExtractXmlElements(await manifest.async('text'), 'manifest:file-entry').find((el) => el.attrs['manifest:full-path'] === 'content.xml');
    if (entry?.content.includes('encryption-data')) {
      throw new EncryptedOfficeDocumentError('The ODT file is password protected, so its text cannot be read.');
    }
  }
  const xml = decodeXmlBytes(await content.async('nodebuffer'), 'ODT content.xml');
  const paragraphs: string[] = [];
  let totalChars = 0;
  for (const element of safeExtractXmlElements(xml, ['text:p', 'text:h'], { maxElements: ODT_MAX_TEXT_CHARS })) {
    const text = odfParagraphText(element.content).trim();
    if (text === '') continue;
    totalChars += text.length;
    if (totalChars > ODT_MAX_TEXT_CHARS) throw new PayloadLimitError(`The ODT text is longer than ${ODT_MAX_TEXT_CHARS} characters.`);
    paragraphs.push(text);
  }
  if (paragraphs.length === 0) throw new ConversionFailedError('The ODT file holds no text.');
  return paragraphs.join(PARAGRAPH_SEPARATOR);
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

  // Load chart relationships and parts if present
  const chartMap = new Map<string, string>();
  const docRelsFile = zip.file('word/_rels/document.xml.rels');
  if (docRelsFile) {
    const relsXml = await docRelsFile.async('text');
    for (const rEl of safeExtractXmlElements(relsXml, 'Relationship')) {
      const rId = rEl.attrs.Id;
      const target = rEl.attrs.Target;
      if (rId && target) {
        const chartPath = target.startsWith('/')
          ? target.slice(1)
          : target.startsWith('word/')
          ? target
          : `word/${target}`;
        const cFile = zip.file(chartPath) || zip.file(target);
        if (cFile) {
          const cXml = await cFile.async('text');
          chartMap.set(rId, cXml);
        }
      }
    }
  }
  for (const fName of Object.keys(zip.files)) {
    if (/^word\/charts\/chart\d+\.xml$/i.test(fName)) {
      const cXml = await zip.files[fName].async('text');
      chartMap.set(fName, cXml);
    }
  }

  // Load table styles from word/styles.xml if present
  let styleMap: Map<string, WordTableStyle> | undefined;
  const stylesFile = zip.file('word/styles.xml');
  if (stylesFile) {
    try {
      const stylesXml = await stylesFile.async('text');
      styleMap = parseWordStyles(stylesXml);
    } catch {}
  }

  // Extract paragraphs, headings, and tables in sequential document order
  const { paragraphs, tables, elements } = parseDocxXml(xmlText, chartMap, styleMap);

  // DOCX -> TXT
  if (tgt === 'txt') {
    const text = elements && elements.length > 0
      ? elements
          .map((el) => {
            if (el.type === 'paragraph') return el.paragraph.text;
            if (el.type === 'table') return el.table.rows.map((r) => r.join('\t')).join('\n');
            if (el.type === 'drawing') {
              if (el.chart) {
                return `[Chart: ${el.chart.title || el.chart.type}] ${el.chart.categories.join(' ')} ${el.chart.series.map((s) => s.values.join(' ')).join(' ')}`;
              }
              return (el.shapes || []).map((s) => s.text).filter(Boolean).join(' ');
            }
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
  fullCellText?: string;
  shading?: string;
  isHeader?: boolean;
  colSpan?: number;
  rowSpan?: number;
  alignment?: 'left' | 'center' | 'right';
  borders?: {
    top?: TableBorder;
    bottom?: TableBorder;
    left?: TableBorder;
    right?: TableBorder;
  };
  nestedTable?: DocxTable;
  nestedTables?: DocxTable[];
}

/**
 * Returns complete text representation of a cell including nested tables.
 */
export function getFullDocxCellText(cell: DocxTableCell): string {
  if (cell.fullCellText && cell.fullCellText.trim().length > 0) {
    return cell.fullCellText;
  }
  if (cell.nestedTables && cell.nestedTables.length > 0) {
    const nestedRowsText = cell.nestedTables.flatMap((t) => t.rows.map((r) => r.join(' | '))).join('\n');
    return cell.text ? `${cell.text}\n${nestedRowsText}` : nestedRowsText;
  }
  if (cell.nestedTable && cell.nestedTable.rows.length > 0) {
    const nestedRowsText = cell.nestedTable.rows.map((r) => r.join(' | ')).join('\n');
    return cell.text ? `${cell.text}\n${nestedRowsText}` : nestedRowsText;
  }
  return cell.text || '';
}

export interface DocxTable {
  rowCount?: number;
  colCount?: number;
  colWidths?: number[];
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

export interface OpenXmlChartSeries {
  name: string;
  values: number[];
  categories?: string[];
  color?: string;
}

export interface OpenXmlChartData {
  type: 'bar' | 'line' | 'pie' | 'area' | 'doughnut' | 'scatter';
  title?: string;
  categories: string[];
  series: OpenXmlChartSeries[];
}

/**
 * 2D Affine Transformation Matrix (3x3 homogeneous coordinates)
 * Represents [a, b, c, d, e, f] where:
 *   x' = a*x + c*y + e
 *   y' = b*x + d*y + f
 */
export type Matrix2D = [number, number, number, number, number, number];

export function identityMatrix(): Matrix2D {
  return [1, 0, 0, 1, 0, 0];
}

export function multiplyMatrix(m1: Matrix2D, m2: Matrix2D): Matrix2D {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

export function translationMatrix(tx: number, ty: number): Matrix2D {
  return [1, 0, 0, 1, tx, ty];
}

export function scaleMatrix(sx: number, sy: number): Matrix2D {
  return [sx, 0, 0, sy, 0, 0];
}

export function rotationMatrix(deg: number): Matrix2D {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [cos, sin, -sin, cos, 0, 0];
}

export function transformPoint(m: Matrix2D, x: number, y: number): { x: number; y: number } {
  return {
    x: m[0] * x + m[2] * y + m[4],
    y: m[1] * x + m[3] * y + m[5],
  };
}

/**
 * Computes the DrawingML group affine transformation matrix (ISO/IEC 29500-1 CT_GroupTransform2D)
 * mapping child coordinate space (chOff, chExt) into the group's bounding box (off, ext),
 * accounting for group rotation (around parent center) and flipH / flipV.
 */
export function computeGroupTransformMatrix(
  off: { x: number; y: number },
  ext: { cx: number; cy: number },
  chOff: { x: number; y: number },
  chExt: { cx: number; cy: number },
  rot: number = 0, // in degrees clockwise
  flipH: boolean = false,
  flipV: boolean = false
): Matrix2D {
  const chw = chExt.cx !== 0 ? chExt.cx : (ext.cx !== 0 ? ext.cx : 1);
  const chh = chExt.cy !== 0 ? chExt.cy : (ext.cy !== 0 ? ext.cy : 1);
  const gw = ext.cx;
  const gh = ext.cy;

  // Center of child coordinate system
  const cChX = chOff.x + chw / 2;
  const cChY = chOff.y + chh / 2;

  // Center of parent bounding box
  const cParentX = off.x + gw / 2;
  const cParentY = off.y + gh / 2;

  // Scaling with reflection
  const sx = (gw / chw) * (flipH ? -1 : 1);
  const sy = (gh / chh) * (flipV ? -1 : 1);

  // Rotation in radians
  const rad = (rot * Math.PI) / 180;

  // M = T(cParentX, cParentY) * R(rad) * S(sx, sy) * T(-cChX, -cChY)
  const tOrigin = translationMatrix(-cChX, -cChY);
  const sScale = scaleMatrix(sx, sy);
  const rRot = rotationMatrix(rad);
  const tCenter = translationMatrix(cParentX, cParentY);

  return multiplyMatrix(tCenter, multiplyMatrix(rRot, multiplyMatrix(sScale, tOrigin)));
}

export interface GroupTransformResult {
  matrix: Matrix2D;
  gx: number;
  gy: number;
  gw: number;
  gh: number;
  chx: number;
  chy: number;
  chw: number;
  chh: number;
  rot: number;
  flipH: boolean;
  flipV: boolean;
}

/**
 * Extracts group shape transform (a:xfrm) attributes and computes the transformation matrix.
 */
export function parseGroupTransform(
  grpXml: string,
  defaultWidth = 100,
  defaultHeight = 60
): GroupTransformResult {
  const grpSpPr = safeExtractFirstXmlElement(grpXml, ['p:grpSpPr', 'wpg:grpSpPr']);
  const xfrm = safeExtractFirstXmlElement(grpSpPr?.content || grpXml, 'a:xfrm');

  let gx = 0;
  let gy = 0;
  let gw = defaultWidth;
  let gh = defaultHeight;
  let chx = 0;
  let chy = 0;
  let chw = defaultWidth;
  let chh = defaultHeight;
  let rot = 0;
  let flipH = false;
  let flipV = false;

  if (xfrm) {
    if (xfrm.attrs.rot) rot = Number.parseInt(xfrm.attrs.rot, 10) / 60000;
    if (xfrm.attrs.flipH === '1' || xfrm.attrs.flipH === 'true') flipH = true;
    if (xfrm.attrs.flipV === '1' || xfrm.attrs.flipV === 'true') flipV = true;

    const offEl = safeExtractFirstXmlElement(xfrm.content, 'a:off');
    if (offEl?.attrs.x && offEl?.attrs.y) {
      gx = Math.round(Number.parseInt(offEl.attrs.x, 10) / 12700);
      gy = Math.round(Number.parseInt(offEl.attrs.y, 10) / 12700);
    }
    const extEl = safeExtractFirstXmlElement(xfrm.content, 'a:ext');
    if (extEl?.attrs.cx && extEl?.attrs.cy) {
      gw = Math.max(1, Math.round(Number.parseInt(extEl.attrs.cx, 10) / 12700));
      gh = Math.max(1, Math.round(Number.parseInt(extEl.attrs.cy, 10) / 12700));
    }
    const chOffEl = safeExtractFirstXmlElement(xfrm.content, 'a:chOff');
    if (chOffEl?.attrs.x && chOffEl?.attrs.y) {
      chx = Math.round(Number.parseInt(chOffEl.attrs.x, 10) / 12700);
      chy = Math.round(Number.parseInt(chOffEl.attrs.y, 10) / 12700);
    } else {
      chx = gx;
      chy = gy;
    }
    const chExtEl = safeExtractFirstXmlElement(xfrm.content, 'a:chExt');
    if (chExtEl?.attrs.cx && chExtEl?.attrs.cy) {
      chw = Math.max(1, Math.round(Number.parseInt(chExtEl.attrs.cx, 10) / 12700));
      chh = Math.max(1, Math.round(Number.parseInt(chExtEl.attrs.cy, 10) / 12700));
    } else {
      chw = gw;
      chh = gh;
    }
  }

  const matrix = computeGroupTransformMatrix(
    { x: gx, y: gy },
    { cx: gw, cy: gh },
    { x: chx, y: chy },
    { cx: chw, cy: chh },
    rot,
    flipH,
    flipV
  );

  return { matrix, gx, gy, gw, gh, chx, chy, chw, chh, rot, flipH, flipV };
}

export interface TransformedElementBounds {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  flipH: boolean;
  flipV: boolean;
  matrix: Matrix2D;
}

/**
 * Computes world coordinates and bounds for a standalone shape or picture element.
 */
export function computeTransformedElementBounds(
  xml: string,
  parentMatrix: Matrix2D
): TransformedElementBounds | null {
  const offEl = safeExtractFirstXmlElement(xml, 'a:off');
  const extEl = safeExtractFirstXmlElement(xml, 'a:ext');
  if (!offEl?.attrs.x || !offEl?.attrs.y || !extEl?.attrs.cx || !extEl?.attrs.cy) {
    return null;
  }

  const rawX = Math.round(Number.parseInt(offEl.attrs.x, 10) / 12700);
  const rawY = Math.round(Number.parseInt(offEl.attrs.y, 10) / 12700);
  const rawW = Math.max(1, Math.round(Number.parseInt(extEl.attrs.cx, 10) / 12700));
  const rawH = Math.max(1, Math.round(Number.parseInt(extEl.attrs.cy, 10) / 12700));

  const xfrmEl = safeExtractFirstXmlElement(xml, 'a:xfrm');
  let rot = 0;
  let flipH = false;
  let flipV = false;
  if (xfrmEl) {
    if (xfrmEl.attrs.rot) rot = Number.parseInt(xfrmEl.attrs.rot, 10) / 60000;
    if (xfrmEl.attrs.flipH === '1' || xfrmEl.attrs.flipH === 'true') flipH = true;
    if (xfrmEl.attrs.flipV === '1' || xfrmEl.attrs.flipV === 'true') flipV = true;
  }

  const localMatrix = computeGroupTransformMatrix(
    { x: rawX, y: rawY },
    { cx: rawW, cy: rawH },
    { x: rawX, y: rawY },
    { cx: rawW, cy: rawH },
    rot,
    flipH,
    flipV
  );
  const worldMatrix = multiplyMatrix(parentMatrix, localMatrix);

  const centerWorld = transformPoint(worldMatrix, rawX + rawW / 2, rawY + rawH / 2);
  const worldW = Math.max(1, Math.round(Math.hypot(worldMatrix[0], worldMatrix[1]) * rawW));
  const worldH = Math.max(1, Math.round(Math.hypot(worldMatrix[2], worldMatrix[3]) * rawH));
  const worldRot = Math.round((Math.atan2(worldMatrix[1], worldMatrix[0]) * 180) / Math.PI);
  const x = Math.round(centerWorld.x - worldW / 2);
  const y = Math.round(centerWorld.y - worldH / 2);

  return { x, y, w: worldW, h: worldH, rot: worldRot, flipH, flipV, matrix: worldMatrix };
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
  flipH?: boolean;
  flipV?: boolean;
  fillColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  text?: string;
  fontSize?: number;
  fontColor?: string;
  bold?: boolean;
  adjustValues?: Record<string, number>;
  guides?: Record<string, number>;
  chart?: OpenXmlChartData;
  chartSvg?: string;
  transformMatrix?: Matrix2D;
}

export type DocxBlockElement =
  | { type: 'paragraph'; paragraph: DocxParagraph }
  | { type: 'table'; table: DocxTable }
  | { type: 'drawing'; svg: string; shapes?: DrawingMlShape[]; chart?: OpenXmlChartData };

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
 * Evaluates an ISO/IEC 29500 DrawingML guide formula (val, mulDiv `* /`, addSub `+-`, `?:`, min, max, abs, sqrt, pin, sin, cos, tan, atan2, cat2, sat2, mod).
 */
export function evaluateDrawingMlGuideFormula(
  fmla: string,
  variables: Record<string, number>
): number {
  const tokens = fmla.trim().split(/\s+/);
  if (tokens.length === 0) return 0;
  const op = tokens[0].toLowerCase();
  const getVal = (token: string | undefined): number => {
    if (!token) return 0;
    const num = parseFloat(token);
    if (!isNaN(num)) return num;
    return variables[token] ?? 0;
  };

  switch (op) {
    case 'val':
      return getVal(tokens[1]);
    case '*/': {
      const z = getVal(tokens[3]);
      return z !== 0 ? (getVal(tokens[1]) * getVal(tokens[2])) / z : 0;
    }
    case '+-':
      return getVal(tokens[1]) + getVal(tokens[2]) - getVal(tokens[3]);
    case '?:':
      return getVal(tokens[1]) > 0 ? getVal(tokens[2]) : getVal(tokens[3]);
    case 'min':
      return Math.min(getVal(tokens[1]), getVal(tokens[2]));
    case 'max':
      return Math.max(getVal(tokens[1]), getVal(tokens[2]));
    case 'abs':
      return Math.abs(getVal(tokens[1]));
    case 'sqrt':
      return Math.sqrt(Math.max(0, getVal(tokens[1])));
    case 'pin': {
      const x = getVal(tokens[1]);
      const y = getVal(tokens[2]);
      const z = getVal(tokens[3]);
      return Math.max(x, Math.min(y, z));
    }
    case 'sin': {
      // Angle in 60,000ths of a degree (ISO/IEC 29500: x * sin(y))
      const x = getVal(tokens[1]);
      const y = getVal(tokens[2]);
      return x * Math.sin(y * (Math.PI / 10800000));
    }
    case 'cos': {
      // Angle in 60,000ths of a degree (ISO/IEC 29500: x * cos(y))
      const x = getVal(tokens[1]);
      const y = getVal(tokens[2]);
      return x * Math.cos(y * (Math.PI / 10800000));
    }
    case 'tan': {
      const x = getVal(tokens[1]);
      const y = getVal(tokens[2]);
      return x * Math.tan(y * (Math.PI / 10800000));
    }
    case 'atan2': {
      // Returns angle in 60,000ths of a degree (ISO/IEC 29500: atan2(y, x))
      const x = getVal(tokens[1]);
      const y = getVal(tokens[2]);
      return Math.atan2(y, x) * (10800000 / Math.PI);
    }
    case 'cat2': {
      // ISO/IEC 29500: x * cos(atan2(z, y))
      const x = getVal(tokens[1]);
      const y = getVal(tokens[2]);
      const z = getVal(tokens[3]);
      return x * Math.cos(Math.atan2(z, y));
    }
    case 'sat2': {
      // ISO/IEC 29500: x * sin(atan2(z, y))
      const x = getVal(tokens[1]);
      const y = getVal(tokens[2]);
      const z = getVal(tokens[3]);
      return x * Math.sin(Math.atan2(z, y));
    }
    case 'mod': {
      // ISO/IEC 29500: sqrt(x^2 + y^2 + z^2)
      const x = getVal(tokens[1]);
      const y = getVal(tokens[2]);
      const z = getVal(tokens[3]);
      return Math.hypot(x, y, z);
    }
    default:
      return getVal(tokens[1]);
  }
}

/**
 * Parses guide lists (<a:avLst>, <a:gdLst>) and evaluates guide variables sequentially with multi-pass dependency resolution.
 */
export function parseDrawingMlGuides(
  xml: string,
  initialVars: Record<string, number> = {}
): Record<string, number> {
  const vars: Record<string, number> = { ...initialVars };
  const gdRegex = /<a:gd\b[^>]*\bname="([^"]+)"[^>]*\bfmla="([^"]+)"/gi;
  let match: RegExpExecArray | null;
  const guideDefs: Array<{ name: string; fmla: string }> = [];
  while ((match = gdRegex.exec(xml)) !== null) {
    guideDefs.push({ name: match[1], fmla: match[2] });
  }

  // Multi-pass evaluation to resolve out-of-order forward references (up to 3 passes)
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const gd of guideDefs) {
      const prev = vars[gd.name];
      const next = evaluateDrawingMlGuideFormula(gd.fmla, vars);
      if (prev !== next) {
        vars[gd.name] = next;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return vars;
}

function extractValuesFromPtXml(containerXml: string): string[] {
  const ptEls = safeExtractXmlElements(containerXml, 'c:pt');
  const results: Array<{ idx: number; val: string }> = [];
  let fallbackIdx = 0;
  for (const pt of ptEls) {
    const idx = pt.attrs.idx !== undefined ? parseInt(pt.attrs.idx, 10) : fallbackIdx++;
    const vContent = safeExtractTagContent(pt.content, 'c:v');
    if (vContent !== null) {
      results.push({ idx, val: safeDecodeXmlEntities(vContent.replace(/<[^>]+>/g, '')).trim() });
    }
  }
  if (results.length > 0) {
    results.sort((a, b) => a.idx - b.idx);
    return results.map((r) => r.val);
  }
  const vEls = safeExtractXmlElements(containerXml, 'c:v');
  return vEls.map((v) => safeDecodeXmlEntities(v.content.replace(/<[^>]+>/g, '')).trim());
}

/**
 * Parses embedded OpenXML <c:chart> XML parts into structured chart model.
 */
export function parseOpenXmlChart(chartXml: string): OpenXmlChartData | null {
  if (
    !chartXml ||
    (!chartXml.includes('<c:chart') &&
      !chartXml.includes('<c:plotArea') &&
      !chartXml.includes('<c:chartSpace>'))
  ) {
    return null;
  }

  // 1. Chart title
  let title: string | undefined;
  const titleEl = safeExtractFirstXmlElement(chartXml, 'c:title');
  if (titleEl) {
    const tEls = [
      ...safeExtractXmlElements(titleEl.content, 'a:t'),
      ...safeExtractXmlElements(titleEl.content, 'c:v'),
    ];
    const joined = tEls
      .map((t) => safeDecodeXmlEntities(t.content.replace(/<[^>]+>/g, '')).trim())
      .filter(Boolean)
      .join(' ');
    if (joined) title = joined;
  }

  // 2. Chart type
  let type: OpenXmlChartData['type'] = 'bar';
  if (/<c:pie(?:3D)?Chart\b/i.test(chartXml)) type = 'pie';
  else if (/<c:line(?:3D)?Chart\b/i.test(chartXml)) type = 'line';
  else if (/<c:area(?:3D)?Chart\b/i.test(chartXml)) type = 'area';
  else if (/<c:doughnutChart\b/i.test(chartXml)) type = 'doughnut';
  else if (/<c:scatterChart\b/i.test(chartXml)) type = 'scatter';
  else if (/<c:bar(?:3D)?Chart\b/i.test(chartXml)) type = 'bar';

  // 3. Series
  const serEls = safeExtractXmlElements(chartXml, 'c:ser');
  const series: OpenXmlChartSeries[] = [];
  let sharedCategories: string[] = [];
  let serIndex = 1;

  for (const serEl of serEls) {
    const serXml = serEl.content;

    // Series name
    let name = `Series ${serIndex++}`;
    const txEl = safeExtractFirstXmlElement(serXml, 'c:tx');
    if (txEl) {
      const vContent = safeExtractTagContent(txEl.content, 'c:v') ?? safeExtractTagContent(txEl.content, 'a:t');
      if (vContent) {
        const decoded = safeDecodeXmlEntities(vContent.replace(/<[^>]+>/g, '')).trim();
        if (decoded) name = decoded;
      }
    }

    // Categories
    const catEl = safeExtractFirstXmlElement(serXml, 'c:cat');
    const categories = catEl ? extractValuesFromPtXml(catEl.raw) : [];
    if (categories.length > 0 && sharedCategories.length === 0) {
      sharedCategories = categories;
    }

    // Values
    const valEl = safeExtractFirstXmlElement(serXml, ['c:val', 'c:yVal']);
    const numStrings = valEl ? extractValuesFromPtXml(valEl.raw) : [];
    const values = numStrings.map((v) => parseFloat(v)).filter((v) => !isNaN(v));

    series.push({
      name,
      values,
      categories: categories.length > 0 ? categories : undefined,
    });
  }

  // Fallback categories if not in series
  if (sharedCategories.length === 0) {
    const axCatEl = safeExtractFirstXmlElement(chartXml, 'c:cat');
    if (axCatEl) {
      sharedCategories = extractValuesFromPtXml(axCatEl.raw);
    }
  }

  if (sharedCategories.length === 0 && series.length > 0) {
    const maxVals = Math.max(0, ...series.map((s) => s.values.length));
    sharedCategories = Array.from({ length: maxVals }, (_, i) => `Item ${i + 1}`);
  }

  return {
    type,
    title,
    categories: sharedCategories,
    series,
  };
}

const CHART_PALETTE = [
  '#5C6BC0',
  '#26A69A',
  '#FFA726',
  '#EF5350',
  '#AB47BC',
  '#42A5F5',
  '#8D6E63',
  '#78909C',
];

function adjustHexBrightness(hex: string | undefined, factor: number): string {
  if (!hex || hex === 'none' || !/^#[0-9A-Fa-f]{6}$/.test(hex)) {
    return hex || 'none';
  }
  const r = Math.min(255, Math.max(0, Math.round(parseInt(hex.slice(1, 3), 16) * factor)));
  const g = Math.min(255, Math.max(0, Math.round(parseInt(hex.slice(3, 5), 16) * factor)));
  const b = Math.min(255, Math.max(0, Math.round(parseInt(hex.slice(5, 7), 16) * factor)));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/**
 * Renders an OpenXML chart specification into an authentic SVG vector chart element.
 */
export function renderChartToSvg(
  chart: OpenXmlChartData,
  width: number = 500,
  height: number = 300
): string {
  const w = Math.max(200, width);
  const h = Math.max(150, height);
  const titleH = chart.title ? 36 : 16;
  const plotLeft = 60;
  const plotRight = w - 30;
  const plotTop = titleH + 10;
  const plotBottom = h - 45;
  const pw = Math.max(10, plotRight - plotLeft);
  const ph = Math.max(10, plotBottom - plotTop);

  const allVals = chart.series.flatMap((s) => s.values);
  const maxVal = Math.max(1, ...allVals);

  let elements = '';

  // Background and border
  elements += `<rect width="${w}" height="${h}" rx="8" fill="#F8F9FE" stroke="#CCD2FC" stroke-width="1"/>\n`;

  // Title
  if (chart.title) {
    elements += `<text x="${w / 2}" y="24" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="14" font-weight="600" fill="#1F2340">${escapeHtml(
      chart.title
    )}</text>\n`;
  }

  // Gridlines & Y-axis labels
  const gridSteps = 4;
  for (let i = 0; i <= gridSteps; i++) {
    const gy = plotBottom - (i / gridSteps) * ph;
    const gVal = Math.round((i / gridSteps) * maxVal);
    elements += `<line x1="${plotLeft}" y1="${gy}" x2="${plotRight}" y2="${gy}" stroke="#E1E4EE" stroke-width="0.8"/>\n`;
    elements += `<text x="${plotLeft - 8}" y="${
      gy + 4
    }" text-anchor="end" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="9" fill="#78909C">${gVal}</text>\n`;
  }

  // X & Y Axes
  elements += `<line x1="${plotLeft}" y1="${plotTop}" x2="${plotLeft}" y2="${plotBottom}" stroke="#CCD2FC" stroke-width="1.2"/>\n`;
  elements += `<line x1="${plotLeft}" y1="${plotBottom}" x2="${plotRight}" y2="${plotBottom}" stroke="#CCD2FC" stroke-width="1.2"/>\n`;

  // Draw chart type
  if (chart.type === 'bar') {
    const numCats = Math.max(1, chart.categories.length);
    const catWidth = pw / numCats;
    const numSeries = Math.max(1, chart.series.length);
    const barWidth = Math.max(3, (catWidth * 0.7) / numSeries);

    chart.categories.forEach((cat, cIdx) => {
      chart.series.forEach((s, sIdx) => {
        const val = s.values[cIdx] || 0;
        const bHeight = Math.max(0, (val / maxVal) * ph);
        const bx = plotLeft + cIdx * catWidth + catWidth * 0.15 + sIdx * barWidth;
        const by = plotBottom - bHeight;
        const color = CHART_PALETTE[sIdx % CHART_PALETTE.length];
        elements += `<rect x="${bx}" y="${by}" width="${Math.max(
          1,
          barWidth - 2
        )}" height="${bHeight}" rx="2" fill="${color}"/>\n`;
      });
      elements += `<text x="${plotLeft + cIdx * catWidth + catWidth / 2}" y="${
        plotBottom + 16
      }" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="10" fill="#4D536B">${escapeHtml(
        cat
      )}</text>\n`;
    });
  } else if (chart.type === 'line' || chart.type === 'scatter') {
    const numCats = Math.max(1, chart.categories.length);
    const catStep = pw / Math.max(1, numCats - 1);

    chart.series.forEach((s, sIdx) => {
      const color = CHART_PALETTE[sIdx % CHART_PALETTE.length];
      const pts: string[] = [];
      s.values.forEach((val, vIdx) => {
        const px = plotLeft + vIdx * catStep;
        const py = plotBottom - Math.max(0, (val / maxVal) * ph);
        pts.push(`${px},${py}`);
        elements += `<circle cx="${px}" cy="${py}" r="3.5" fill="${color}" stroke="#FFFFFF" stroke-width="1.5"/>\n`;
      });
      if (pts.length > 1) {
        elements += `<polyline points="${pts.join(
          ' '
        )}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>\n`;
      }
    });

    chart.categories.forEach((cat, cIdx) => {
      elements += `<text x="${plotLeft + cIdx * catStep}" y="${
        plotBottom + 16
      }" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="10" fill="#4D536B">${escapeHtml(
        cat
      )}</text>\n`;
    });
  } else if (chart.type === 'pie' || chart.type === 'doughnut') {
    const cx = plotLeft + pw / 2;
    const cy = plotTop + ph / 2;
    const rOuter = (Math.min(pw, ph) / 2) * 0.85;
    const rInner = chart.type === 'doughnut' ? rOuter * 0.55 : 0;
    const total = allVals.reduce((a, b) => a + b, 0) || 1;
    let startAngle = -Math.PI / 2;

    allVals.forEach((val, vIdx) => {
      const sliceAngle = (val / total) * 2 * Math.PI;
      const endAngle = startAngle + sliceAngle;
      const color = CHART_PALETTE[vIdx % CHART_PALETTE.length];

      if (sliceAngle >= 2 * Math.PI - 0.001) {
        if (rInner > 0) {
          const dRing = `M ${cx} ${cy - rOuter} A ${rOuter} ${rOuter} 0 1 1 ${cx} ${cy + rOuter} A ${rOuter} ${rOuter} 0 1 1 ${cx} ${cy - rOuter} M ${cx} ${cy - rInner} A ${rInner} ${rInner} 0 1 0 ${cx} ${cy + rInner} A ${rInner} ${rInner} 0 1 0 ${cx} ${cy - rInner} Z`;
          elements += `<path d="${dRing}" fill="${color}" stroke="#FFFFFF" stroke-width="1.5" fill-rule="evenodd"/>\n`;
        } else {
          elements += `<circle cx="${cx}" cy="${cy}" r="${rOuter}" fill="${color}" stroke="#FFFFFF" stroke-width="1.5"/>\n`;
        }
        return;
      }

      const x1 = cx + rOuter * Math.cos(startAngle);
      const y1 = cy + rOuter * Math.sin(startAngle);
      const x2 = cx + rOuter * Math.cos(endAngle);
      const y2 = cy + rOuter * Math.sin(endAngle);
      const largeArc = sliceAngle > Math.PI ? 1 : 0;

      let d = '';
      if (rInner > 0) {
        const x3 = cx + rInner * Math.cos(endAngle);
        const y3 = cy + rInner * Math.sin(endAngle);
        const x4 = cx + rInner * Math.cos(startAngle);
        const y4 = cy + rInner * Math.sin(startAngle);
        d = `M ${x1} ${y1} A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${x2} ${y2} L ${x3} ${y3} A ${rInner} ${rInner} 0 ${largeArc} 0 ${x4} ${y4} Z`;
      } else {
        d = `M ${cx} ${cy} L ${x1} ${y1} A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${x2} ${y2} Z`;
      }

      elements += `<path d="${d}" fill="${color}" stroke="#FFFFFF" stroke-width="1.5"/>\n`;
      startAngle = endAngle;
    });
  } else if (chart.type === 'area') {
    const numCats = Math.max(1, chart.categories.length);
    const catStep = pw / Math.max(1, numCats - 1);

    chart.series.forEach((s, sIdx) => {
      const color = CHART_PALETTE[sIdx % CHART_PALETTE.length];
      const pts: string[] = [];
      s.values.forEach((val, vIdx) => {
        const px = plotLeft + vIdx * catStep;
        const py = plotBottom - Math.max(0, (val / maxVal) * ph);
        pts.push(`${px},${py}`);
      });
      if (pts.length > 1) {
        const areaPath = `M ${plotLeft} ${plotBottom} L ${pts.join(' L ')} L ${
          plotLeft + (s.values.length - 1) * catStep
        } ${plotBottom} Z`;
        elements += `<path d="${areaPath}" fill="${color}" fill-opacity="0.3" stroke="${color}" stroke-width="2"/>\n`;
      }
    });

    chart.categories.forEach((cat, cIdx) => {
      elements += `<text x="${plotLeft + cIdx * catStep}" y="${
        plotBottom + 16
      }" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="10" fill="#4D536B">${escapeHtml(
        cat
      )}</text>\n`;
    });
  }

  // Legend if multiple series or pie/doughnut slices
  if (chart.series.length > 1) {
    let lx = plotLeft;
    const ly = h - 12;
    chart.series.forEach((s, sIdx) => {
      const color = CHART_PALETTE[sIdx % CHART_PALETTE.length];
      elements += `<rect x="${lx}" y="${ly - 7}" width="8" height="8" rx="2" fill="${color}"/>\n`;
      elements += `<text x="${lx + 12}" y="${ly}" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="9" fill="#4D536B">${escapeHtml(
        s.name
      )}</text>\n`;
      lx += s.name.length * 6 + 28;
    });
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">\n${elements}</svg>`;
}

/**
 * OpenXML DrawingML Vector Shape Parser & SVG Renderer
 * Parses <p:spTree>, <w:drawing>, <a:xfrm>, <a:prstGeom>, and <a:custGeom>
 * into clean, standards-compliant SVG vector paths.
 */
export function parseDrawingMlShapes(xml: string, parentMatrix: Matrix2D = identityMatrix()): DrawingMlShape[] {
  const shapes: DrawingMlShape[] = [];

  // 1. Discover top-level DrawingML group shapes (<p:grpSp>, <wpg:wgp>)
  const groupElements = safeExtractXmlElements(xml, ['p:grpSp', 'wpg:wgp']);
  const excludedRanges: Array<[number, number]> = [];
  const topGroups: SafeXmlElement[] = [];

  for (const grpEl of groupElements) {
    const isNestedInOther = excludedRanges.some(([s, e]) => grpEl.startIndex > s && grpEl.endIndex < e);
    if (isNestedInOther) continue;
    excludedRanges.push([grpEl.startIndex, grpEl.endIndex]);
    topGroups.push(grpEl);
  }

  // 2. Discover standalone shape tags: <p:sp>, <wps:wsp>, <a:graphicData>, <w:drawing>
  const targetShapeTags = ['p:sp', 'wps:wsp', 'a:graphicData', 'w:drawing'];
  const shapeElements = safeExtractXmlElements(xml, targetShapeTags);
  const topShapes = shapeElements.filter(
    (e) => !excludedRanges.some(([s, end]) => e.startIndex >= s && e.endIndex <= end)
  );

  type TopLevelItem =
    | { kind: 'group'; el: SafeXmlElement }
    | { kind: 'shape'; xml: string; startIndex: number };

  const items: TopLevelItem[] = [];
  for (const g of topGroups) {
    items.push({ kind: 'group', el: g });
  }
  for (const s of topShapes) {
    items.push({ kind: 'shape', xml: s.raw, startIndex: s.startIndex });
  }

  if (
    items.length === 0 &&
    (xml.includes('<a:prstGeom') ||
      xml.includes('<a:custGeom') ||
      xml.includes('<a:spPr') ||
      xml.includes('<c:chart') ||
      xml.includes('<c:plotArea'))
  ) {
    items.push({ kind: 'shape', xml, startIndex: 0 });
  }

  items.sort((a, b) => {
    const posA = a.kind === 'group' ? a.el.startIndex : a.startIndex;
    const posB = b.kind === 'group' ? b.el.startIndex : b.startIndex;
    return posA - posB;
  });

  for (const item of items) {
    if (item.kind === 'group') {
      const grpXml = item.el.content;
      const { matrix: mGrp } = parseGroupTransform(grpXml, 100, 60);
      const mAccum = multiplyMatrix(parentMatrix, mGrp);
      const childShapes = parseDrawingMlShapes(grpXml, mAccum);
      shapes.push(...childShapes);
      continue;
    }

    const spXml = item.xml;
    // 1. Transform: <a:xfrm rot="..." flipH="..." flipV="..."> <a:off x="..." y="..."/> <a:ext cx="..." cy="..."/>
    const xfrmEl = safeExtractFirstXmlElement(spXml, 'a:xfrm');
    let x = 0,
      y = 0,
      width = 100,
      height = 60,
      rotation = 0,
      flipH = false,
      flipV = false;
    if (xfrmEl) {
      const rotVal = xfrmEl.attrs.rot;
      if (rotVal) rotation = Number.parseInt(rotVal, 10) / 60000;
      if (xfrmEl.attrs.flipH === '1' || xfrmEl.attrs.flipH === 'true') flipH = true;
      if (xfrmEl.attrs.flipV === '1' || xfrmEl.attrs.flipV === 'true') flipV = true;

      const offEl = safeExtractFirstXmlElement(xfrmEl.content, 'a:off');
      if (offEl && offEl.attrs.x && offEl.attrs.y) {
        x = Math.round(Number.parseInt(offEl.attrs.x, 10) / 12700);
        y = Math.round(Number.parseInt(offEl.attrs.y, 10) / 12700);
      }
      const extEl = safeExtractFirstXmlElement(xfrmEl.content, 'a:ext');
      if (extEl && extEl.attrs.cx && extEl.attrs.cy) {
        width = Math.max(1, Math.round(Number.parseInt(extEl.attrs.cx, 10) / 12700));
        height = Math.max(1, Math.round(Number.parseInt(extEl.attrs.cy, 10) / 12700));
      }
    }

    const origX = x;
    const origY = y;
    const origW = width;
    const origH = height;

    const localShapeMatrix = computeGroupTransformMatrix(
      { x, y },
      { cx: width, cy: height },
      { x, y },
      { cx: width, cy: height },
      rotation,
      flipH,
      flipV
    );
    const worldMatrix = multiplyMatrix(parentMatrix, localShapeMatrix);

    const isParentTransformed =
      Math.abs(parentMatrix[0] - 1) > 1e-4 ||
      Math.abs(parentMatrix[1]) > 1e-4 ||
      Math.abs(parentMatrix[2]) > 1e-4 ||
      Math.abs(parentMatrix[3] - 1) > 1e-4 ||
      Math.abs(parentMatrix[4]) > 1e-4 ||
      Math.abs(parentMatrix[5]) > 1e-4;

    if (isParentTransformed) {
      const centerWorld = transformPoint(worldMatrix, x + width / 2, y + height / 2);
      const worldW = Math.max(1, Math.round(Math.hypot(worldMatrix[0], worldMatrix[1]) * width));
      const worldH = Math.max(1, Math.round(Math.hypot(worldMatrix[2], worldMatrix[3]) * height));
      const worldRot = Math.round((Math.atan2(worldMatrix[1], worldMatrix[0]) * 180) / Math.PI);
      x = Math.round(centerWorld.x - worldW / 2);
      y = Math.round(centerWorld.y - worldH / 2);
      width = worldW;
      height = worldH;
      rotation = worldRot;
    }

    // Check if shape contains an embedded chart
    if (
      spXml.includes('<c:chart') ||
      spXml.includes('<c:plotArea') ||
      spXml.includes('<c:chartSpace>')
    ) {
      const chartData = parseOpenXmlChart(spXml);
      if (chartData) {
        const chartSvg = renderChartToSvg(chartData, width, height);
        shapes.push({
          type: 'chart',
          geomType: 'preset',
          presetGeom: 'rect',
          x,
          y,
          width,
          height,
          rotation: rotation || undefined,
          flipH: flipH || undefined,
          flipV: flipV || undefined,
          fillColor: 'none',
          strokeColor: 'none',
          strokeWidth: 0,
          text: chartData.title || `${chartData.type} chart`,
          chart: chartData,
          chartSvg,
          transformMatrix: worldMatrix,
        });
        continue;
      }
    }

    // 2. Fills and Lines
    let fillColor = '#5C6BC0';
    let strokeColor = '#1F2340';
    let strokeWidth = 1;

    if (spXml.includes('<a:noFill/>') || spXml.includes('<a:noFill />')) {
      fillColor = 'none';
    } else {
      const solidFillColor = safeFindColor(spXml, ['a:solidFill']);
      if (solidFillColor) fillColor = solidFillColor;
    }

    const lnEl = safeExtractFirstXmlElement(spXml, 'a:ln');
    if (lnEl) {
      if (lnEl.attrs.w) strokeWidth = Math.max(0.5, Math.round(parseInt(lnEl.attrs.w, 10) / 12700));
      const lnClr = safeFindColor(lnEl.content);
      if (lnClr) strokeColor = lnClr;
    }

    // 3. Guides & Adjust Values (<a:avLst>, <a:gdLst>)
    const initialVars: Record<string, number> = {
      w: width,
      h: height,
      l: x,
      t: y,
      r: x + width,
      b: y + height,
      hc: width / 2,
      vc: height / 2,
      ss: Math.min(width, height),
      ls: Math.max(width, height),
    };
    const guides = parseDrawingMlGuides(spXml, initialVars);
    const avEl = safeExtractFirstXmlElement(spXml, 'a:avLst');
    const adjustValues = avEl ? parseDrawingMlGuides(avEl.raw, {}) : undefined;

    // 4. Geometry (Preset vs Custom)
    let geomType: 'preset' | 'custom' = 'preset';
    let presetGeom = 'rect';
    let svgPath = '';

    const prstEl = safeExtractFirstXmlElement(spXml, 'a:prstGeom');
    const custEl = safeExtractFirstXmlElement(spXml, 'a:custGeom');

    if (custEl) {
      geomType = 'custom';
      const pathEl = safeExtractFirstXmlElement(custEl.content, 'a:path');
      if (pathEl) {
        const pw = pathEl.attrs.w ? Number.parseInt(pathEl.attrs.w, 10) : origW;
        const ph = pathEl.attrs.h ? Number.parseInt(pathEl.attrs.h, 10) : origH;
        const sx = origW / (pw || 1);
        const sy = origH / (ph || 1);

        const dParts: string[] = [];
        const cmdTags = ['a:moveTo', 'a:lnTo', 'a:cubicBezTo', 'a:quadBezTo', 'a:arcTo', 'a:close'];
        const cmdEls = safeExtractXmlElements(pathEl.content, cmdTags);
        for (const cmdEl of cmdEls) {
          const cmdName = cmdEl.localName.toLowerCase();
          const mapPt = (rawPx: number, rawPy: number): { x: number; y: number } => {
            if (isParentTransformed) {
              const res = transformPoint(parentMatrix, rawPx, rawPy);
              return { x: Math.round(res.x), y: Math.round(res.y) };
            }
            return { x: Math.round(rawPx), y: Math.round(rawPy) };
          };

          if (cmdName === 'moveto') {
            const ptEl = safeExtractFirstXmlElement(cmdEl.content, 'a:pt');
            if (ptEl && ptEl.attrs.x && ptEl.attrs.y) {
              const rawPx = origX + Number.parseInt(ptEl.attrs.x, 10) * sx;
              const rawPy = origY + Number.parseInt(ptEl.attrs.y, 10) * sy;
              const p = mapPt(rawPx, rawPy);
              dParts.push(`M ${p.x} ${p.y}`);
            }
          } else if (cmdName === 'lnto') {
            const ptEl = safeExtractFirstXmlElement(cmdEl.content, 'a:pt');
            if (ptEl && ptEl.attrs.x && ptEl.attrs.y) {
              const rawPx = origX + Number.parseInt(ptEl.attrs.x, 10) * sx;
              const rawPy = origY + Number.parseInt(ptEl.attrs.y, 10) * sy;
              const p = mapPt(rawPx, rawPy);
              dParts.push(`L ${p.x} ${p.y}`);
            }
          } else if (cmdName === 'cubicbezto') {
            const ptEls = safeExtractXmlElements(cmdEl.content, 'a:pt');
            const pts: string[] = [];
            for (const pt of ptEls) {
              if (pt.attrs.x && pt.attrs.y) {
                const rawPx = origX + Number.parseInt(pt.attrs.x, 10) * sx;
                const rawPy = origY + Number.parseInt(pt.attrs.y, 10) * sy;
                const p = mapPt(rawPx, rawPy);
                pts.push(`${p.x} ${p.y}`);
              }
            }
            if (pts.length >= 3) {
              dParts.push(`C ${pts[0]}, ${pts[1]}, ${pts[2]}`);
            }
          } else if (cmdName === 'quadbezto') {
            const ptEls = safeExtractXmlElements(cmdEl.content, 'a:pt');
            const pts: string[] = [];
            for (const pt of ptEls) {
              if (pt.attrs.x && pt.attrs.y) {
                const rawPx = origX + Number.parseInt(pt.attrs.x, 10) * sx;
                const rawPy = origY + Number.parseInt(pt.attrs.y, 10) * sy;
                const p = mapPt(rawPx, rawPy);
                pts.push(`${p.x} ${p.y}`);
              }
            }
            if (pts.length >= 2) {
              dParts.push(`Q ${pts[0]}, ${pts[1]}`);
            }
          } else if (cmdName === 'close') {
            dParts.push('Z');
          }
        }
        svgPath = dParts.join(' ');
        if (isParentTransformed) {
          rotation = 0;
          flipH = false;
          flipV = false;
        }
      }
    } else if (prstEl && prstEl.attrs.prst) {
      geomType = 'preset';
      presetGeom = prstEl.attrs.prst.toLowerCase();
    }

    // 5. Text inside shape
    const tEls = safeExtractXmlElements(spXml, 'a:t');
    const text = tEls
      .map((t) => safeDecodeXmlEntities(t.content.replace(/<[^>]+>/g, '')).trim())
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
      rotation: rotation || undefined,
      flipH: flipH || undefined,
      flipV: flipV || undefined,
      fillColor,
      strokeColor,
      strokeWidth,
      text: text || undefined,
      adjustValues,
      guides:
        Object.keys(guides).length > Object.keys(initialVars).length ? guides : undefined,
      transformMatrix: worldMatrix,
    });
  }

  return shapes;
}

/**
 * Extracts normalized adjust ratio (0..1) from DrawingML adjustValues or guides.
 */
export function getShapeAdjustRatio(s: DrawingMlShape, name: string, defaultRatio: number): number {
  if (s.adjustValues && typeof s.adjustValues[name] === 'number') {
    const v = s.adjustValues[name];
    return v > 1 ? v / 100000 : v;
  }
  if (s.guides && typeof s.guides[name] === 'number') {
    const v = s.guides[name];
    return v > 1 ? v / 100000 : v;
  }
  return defaultRatio;
}

/**
 * Extracts computed guide value or returns default.
 */
export function getGuideValue(s: DrawingMlShape, name: string, defaultValue: number): number {
  if (s.guides && typeof s.guides[name] === 'number') {
    return s.guides[name];
  }
  if (s.adjustValues && typeof s.adjustValues[name] === 'number') {
    return s.adjustValues[name];
  }
  return defaultValue;
}

/**
 * Renders a single DrawingML shape into an SVG element string.
 */
export function renderSingleShapeSvg(s: DrawingMlShape): string {
  if (s.chartSvg) {
    return s.chartSvg;
  }

  const cx = s.x + s.width / 2;
  const cy = s.y + s.height / 2;
  const transforms: string[] = [];
  if (s.rotation) {
    transforms.push(`rotate(${s.rotation} ${cx} ${cy})`);
  }
  if (s.flipH || s.flipV) {
    const sx = s.flipH ? -1 : 1;
    const sy = s.flipV ? -1 : 1;
    transforms.push(`translate(${cx} ${cy}) scale(${sx} ${sy}) translate(${-cx} ${-cy})`);
  }
  const rotAttr = transforms.length > 0 ? ` transform="${transforms.join(' ')}"` : '';

  let elementStr = '';

  if (s.geomType === 'custom' && s.svgPath) {
    elementStr = `<path d="${s.svgPath}" fill="${s.fillColor || '#5C6BC0'}" stroke="${s.strokeColor || '#1F2340'}" stroke-width="${s.strokeWidth ?? 1}"${rotAttr} />`;
  } else {
    const geom = (s.presetGeom || 'rect').toLowerCase();
    switch (geom) {
      case 'ellipse':
      case 'circle':
        elementStr = `<ellipse cx="${cx}" cy="${cy}" rx="${s.width / 2}" ry="${
          s.height / 2
        }" fill="${s.fillColor || '#5C6BC0'}" stroke="${s.strokeColor || '#1F2340'}" stroke-width="${s.strokeWidth ?? 1}"${rotAttr} />`;
        break;
      case 'roundrect': {
        const hasGuides = s.guides?.rx !== undefined || s.guides?.r !== undefined || s.adjustValues?.adj !== undefined;
        const defaultRadius = hasGuides ? Math.min(s.width, s.height) * getShapeAdjustRatio(s, 'adj', 0.15) : 8;
        const rx = getGuideValue(s, 'rx', getGuideValue(s, 'r', defaultRadius));
        const ry = getGuideValue(s, 'ry', rx);
        elementStr = `<rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" rx="${rx}" ry="${ry}" fill="${s.fillColor || '#5C6BC0'}" stroke="${s.strokeColor || '#1F2340'}" stroke-width="${s.strokeWidth ?? 1}"${rotAttr} />`;
        break;
      }
      case 'triangle': {
        const pts = `${cx},${s.y} ${s.x + s.width},${s.y + s.height} ${s.x},${s.y + s.height}`;
        elementStr = `<polygon points="${pts}" fill="${s.fillColor || '#5C6BC0'}" stroke="${s.strokeColor || '#1F2340'}" stroke-width="${s.strokeWidth ?? 1}"${rotAttr} />`;
        break;
      }
      case 'diamond':
      case 'flowchartdecision': {
        const pts = `${cx},${s.y} ${s.x + s.width},${cy} ${cx},${s.y + s.height} ${s.x},${cy}`;
        elementStr = `<polygon points="${pts}" fill="${s.fillColor || '#5C6BC0'}" stroke="${s.strokeColor || '#1F2340'}" stroke-width="${s.strokeWidth ?? 1}"${rotAttr} />`;
        break;
      }
      case 'rightarrow': {
        const headRatio = getShapeAdjustRatio(s, 'adj1', 0.4);
        const shaftThick = getShapeAdjustRatio(s, 'adj2', 0.5);
        const shaftX = s.x + s.width * (1 - headRatio);
        const yTop = s.y + (s.height * (1 - shaftThick)) / 2;
        const yBottom = s.y + s.height - (s.height * (1 - shaftThick)) / 2;
        const pts = `${s.x},${yTop} ${shaftX},${yTop} ${shaftX},${s.y} ${s.x + s.width},${cy} ${shaftX},${s.y + s.height} ${shaftX},${yBottom} ${s.x},${yBottom}`;
        elementStr = `<polygon points="${pts}" fill="${s.fillColor || '#5C6BC0'}" stroke="${s.strokeColor || '#1F2340'}" stroke-width="${s.strokeWidth ?? 1}"${rotAttr} />`;
        break;
      }
      case 'leftrightarrow': {
        const headRatio = getShapeAdjustRatio(s, 'adj1', 0.25);
        const shaftThick = getShapeAdjustRatio(s, 'adj2', 0.5);
        const leftHead = s.x + s.width * headRatio;
        const rightHead = s.x + s.width * (1 - headRatio);
        const yTop = s.y + (s.height * (1 - shaftThick)) / 2;
        const yBottom = s.y + s.height - (s.height * (1 - shaftThick)) / 2;
        const pts = `${s.x},${cy} ${leftHead},${s.y} ${leftHead},${yTop} ${rightHead},${yTop} ${rightHead},${s.y} ${
          s.x + s.width
        },${cy} ${rightHead},${s.y + s.height} ${rightHead},${yBottom} ${leftHead},${yBottom} ${leftHead},${s.y + s.height}`;
        elementStr = `<polygon points="${pts}" fill="${s.fillColor || '#5C6BC0'}" stroke="${s.strokeColor || '#1F2340'}" stroke-width="${s.strokeWidth ?? 1}"${rotAttr} />`;
        break;
      }
      case 'wedgerectcallout': {
        const tailX = s.x + s.width * getShapeAdjustRatio(s, 'adj1', 0.3);
        const tailY = s.y + s.height * getShapeAdjustRatio(s, 'adj2', 1.0);
        const d = `M ${s.x} ${s.y} L ${s.x + s.width} ${s.y} L ${s.x + s.width} ${
          s.y + s.height * 0.75
        } L ${s.x + s.width * 0.55} ${s.y + s.height * 0.75} L ${tailX} ${
          tailY
        } L ${s.x + s.width * 0.38} ${s.y + s.height * 0.75} L ${s.x} ${s.y + s.height * 0.75} Z`;
        elementStr = `<path d="${d}" fill="${s.fillColor || '#5C6BC0'}" stroke="${s.strokeColor || '#1F2340'}" stroke-width="${s.strokeWidth ?? 1}"${rotAttr} />`;
        break;
      }
      case 'chevron': {
        const depthRatio = getShapeAdjustRatio(s, 'adj', 0.25);
        const dX = s.width * depthRatio;
        const pts = `${s.x},${s.y} ${s.x + s.width - dX},${s.y} ${s.x + s.width},${cy} ${
          s.x + s.width - dX
        },${s.y + s.height} ${s.x},${s.y + s.height} ${s.x + dX},${cy}`;
        elementStr = `<polygon points="${pts}" fill="${s.fillColor || '#5C6BC0'}" stroke="${s.strokeColor || '#1F2340'}" stroke-width="${s.strokeWidth ?? 1}"${rotAttr} />`;
        break;
      }
      case 'cube': {
        const cd = Math.min(s.width, s.height) * getShapeAdjustRatio(s, 'adj', 0.2);
        const fill = s.fillColor || '#5C6BC0';
        elementStr = `<g${rotAttr}><polygon points="${s.x},${s.y + cd} ${s.x + cd},${s.y} ${
          s.x + s.width
        },${s.y} ${s.x + s.width - cd},${s.y + cd}" fill="${adjustHexBrightness(
          fill,
          1.2
        )}" stroke="${s.strokeColor || '#1F2340'}" stroke-width="${s.strokeWidth ?? 1}" /><polygon points="${
          s.x + s.width - cd
        },${s.y + cd} ${s.x + s.width},${s.y} ${s.x + s.width},${s.y + s.height - cd} ${
          s.x + s.width - cd
        },${s.y + s.height}" fill="${adjustHexBrightness(fill, 0.8)}" stroke="${
          s.strokeColor || '#1F2340'
        }" stroke-width="${s.strokeWidth ?? 1}" /><rect x="${s.x}" y="${s.y + cd}" width="${
          s.width - cd
        }" height="${s.height - cd}" fill="${fill}" stroke="${s.strokeColor || '#1F2340'}" stroke-width="${
          s.strokeWidth ?? 1
        }" /></g>`;
        break;
      }
      case 'line':
        elementStr = `<line x1="${s.x}" y1="${s.y}" x2="${s.x + s.width}" y2="${
          s.y + s.height
        }" stroke="${s.strokeColor || '#1F2340'}" stroke-width="${s.strokeWidth ?? 1}"${rotAttr} />`;
        break;
      case 'star5': {
        const rOuter = Math.min(s.width, s.height) / 2;
        const rInner = rOuter * 0.4;
        const pts: string[] = [];
        for (let i = 0; i < 10; i++) {
          const angle = (i * Math.PI) / 5 - Math.PI / 2;
          const r = i % 2 === 0 ? rOuter : rInner;
          pts.push(`${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`);
        }
        elementStr = `<polygon points="${pts.join(' ')}" fill="${s.fillColor || '#5C6BC0'}" stroke="${
          s.strokeColor || '#1F2340'
        }" stroke-width="${s.strokeWidth ?? 1}"${rotAttr} />`;
        break;
      }
      case 'flowchartprocess':
      case 'rect':
      default:
        elementStr = `<rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" fill="${s.fillColor || '#5C6BC0'}" stroke="${s.strokeColor || '#1F2340'}" stroke-width="${s.strokeWidth ?? 1}"${rotAttr} />`;
        break;
    }
  }

  if (s.text && !elementStr.startsWith('<g')) {
    const textFill =
      s.fillColor === '#5C6BC0' || s.fillColor === '#1F2340' ? '#FFFFFF' : '#1F2340';
    elementStr += `\n  <text x="${cx}" y="${
      cy + 4
    }" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="12" font-weight="500" fill="${textFill}">${escapeHtml(
      s.text
    )}</text>`;
  }

  return elementStr;
}

/**
 * Renders OpenXML DrawingML specifications into an SVG vector graphic string.
 */
export function renderDrawingMlToSvg(
  xmlOrShapes: string | DrawingMlShape[],
  options?: { width?: number; height?: number } | number,
  heightOption?: number
): { svg: string; shapes: DrawingMlShape[] } {
  // If input is an XML string containing an embedded chart part
  if (
    typeof xmlOrShapes === 'string' &&
    (xmlOrShapes.includes('<c:chart') ||
      xmlOrShapes.includes('<c:plotArea') ||
      xmlOrShapes.includes('<c:chartSpace>'))
  ) {
    const chartData = parseOpenXmlChart(xmlOrShapes);
    if (chartData) {
      const optW = typeof options === 'number' ? options : options?.width || 500;
      const optH = typeof options === 'number' ? heightOption || 300 : options?.height || 300;
      const svg = renderChartToSvg(chartData, optW, optH);
      return {
        svg,
        shapes: [
          {
            geomType: 'preset',
            presetGeom: 'rect',
            x: 0,
            y: 0,
            width: optW,
            height: optH,
            chart: chartData,
            chartSvg: svg,
            text: chartData.title || `${chartData.type} chart`,
          },
        ],
      };
    }
  }

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
    svgElements += `  ${renderSingleShapeSvg(s)}\n`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX - 10} ${
    minY - 10
  } ${contentWidth} ${contentHeight}" width="${totalWidth}" height="${totalHeight}">\n${svgElements}</svg>`;
  return { svg, shapes };
}

export interface SafeXmlAttributeMap {
  [key: string]: string;
}

export interface SafeXmlElement {
  tag: string;
  localName: string;
  prefix?: string;
  raw: string;
  attrs: SafeXmlAttributeMap;
  content: string;
  startIndex: number;
  endIndex: number;
}

export interface SafeXmlScannerOptions {
  maxDepth?: number;
  maxElements?: number;
}

/**
 * Linearly extracts XML attributes from an opening tag header in O(N) time with zero regex backtracking.
 */
export function safeExtractXmlAttributes(tagHeader: string): SafeXmlAttributeMap {
  const attrs: SafeXmlAttributeMap = {};
  let i = 0;
  if (i < tagHeader.length && tagHeader[i] === '<') i++;
  // Skip tag name
  while (i < tagHeader.length && tagHeader.charCodeAt(i) > 32 && tagHeader[i] !== '/' && tagHeader[i] !== '>') i++;

  while (i < tagHeader.length) {
    // Skip whitespace
    while (i < tagHeader.length && tagHeader.charCodeAt(i) <= 32) i++;
    if (i >= tagHeader.length || tagHeader[i] === '/' || tagHeader[i] === '>') break;

    const keyStart = i;
    while (
      i < tagHeader.length &&
      tagHeader[i] !== '=' &&
      tagHeader.charCodeAt(i) > 32 &&
      tagHeader[i] !== '/' &&
      tagHeader[i] !== '>'
    ) {
      i++;
    }
    const key = tagHeader.slice(keyStart, i).trim();
    while (i < tagHeader.length && tagHeader.charCodeAt(i) <= 32) i++;

    if (i < tagHeader.length && tagHeader[i] === '=') {
      i++;
      while (i < tagHeader.length && tagHeader.charCodeAt(i) <= 32) i++;
      if (i < tagHeader.length && (tagHeader[i] === '"' || tagHeader[i] === "'")) {
        const quote = tagHeader[i++];
        const valStart = i;
        while (i < tagHeader.length && tagHeader[i] !== quote) i++;
        attrs[key] = safeDecodeXmlEntities(tagHeader.slice(valStart, i));
        if (i < tagHeader.length) i++; // skip closing quote
      } else {
        const valStart = i;
        while (
          i < tagHeader.length &&
          tagHeader.charCodeAt(i) > 32 &&
          tagHeader[i] !== '>' &&
          tagHeader[i] !== '/'
        ) {
          i++;
        }
        attrs[key] = safeDecodeXmlEntities(tagHeader.slice(valStart, i));
      }
    } else if (key) {
      attrs[key] = 'true';
    }
  }
  return attrs;
}

/**
 * Safely extracts XML elements in linear O(N) time without ReDoS backtracking.
 * Accurately tracks nested elements of the same tag name and enforces strict depth bounds.
 */
export function safeExtractXmlElements(
  xml: string,
  tagName: string | string[],
  options: SafeXmlScannerOptions = {}
): SafeXmlElement[] {
  const results: SafeXmlElement[] = [];
  const maxElements = options.maxElements ?? 50000;
  const maxDepth = options.maxDepth ?? 64;

  const tagList = Array.isArray(tagName) ? tagName : [tagName];
  const targetMap = new Map<string, { targetLocal: string; targetPrefix: string | null }>();
  for (const t of tagList) {
    targetMap.set(t, {
      targetLocal: t.includes(':') ? t.split(':')[1] : t,
      targetPrefix: t.includes(':') ? t.split(':')[0] : null,
    });
  }

  const closingTagPresentMap = new Map<string, boolean>();
  let pos = 0;
  while (pos < xml.length && results.length < maxElements) {
    const nextLt = xml.indexOf('<', pos);
    if (nextLt === -1) break;

    // Skip comments <!-- ... -->
    if (xml.startsWith('<!--', nextLt)) {
      const endComment = xml.indexOf('-->', nextLt + 4);
      pos = endComment === -1 ? xml.length : endComment + 3;
      continue;
    }
    // Skip CDATA <![CDATA[ ... ]]>
    if (xml.startsWith('<![CDATA[', nextLt)) {
      const endCdata = xml.indexOf(']]>', nextLt + 9);
      pos = endCdata === -1 ? xml.length : endCdata + 3;
      continue;
    }
    // Skip processing instructions <? ... ?> or <! ... >
    if (xml[nextLt + 1] === '?' || xml[nextLt + 1] === '!') {
      const endPi = xml.indexOf('>', nextLt + 2);
      pos = endPi === -1 ? xml.length : endPi + 1;
      continue;
    }
    // Skip closing tags
    if (xml[nextLt + 1] === '/') {
      const endClose = xml.indexOf('>', nextLt + 2);
      pos = endClose === -1 ? xml.length : endClose + 1;
      continue;
    }

    // Read current opening tag name
    let tagEnd = nextLt + 1;
    while (
      tagEnd < xml.length &&
      xml.charCodeAt(tagEnd) > 32 &&
      xml[tagEnd] !== '>' &&
      xml[tagEnd] !== '/'
    ) {
      tagEnd++;
    }
    const currentTag = xml.slice(nextLt + 1, tagEnd);
    const currLocal = currentTag.includes(':') ? currentTag.split(':')[1] : currentTag;
    const currPrefix = currentTag.includes(':') ? currentTag.split(':')[0] : undefined;

    let isMatch = false;
    for (const [tName, spec] of targetMap) {
      if (spec.targetPrefix ? currentTag === tName : currLocal === spec.targetLocal) {
        isMatch = true;
        break;
      }
    }

    // Find the end of this tag's header '>' taking quotes into account
    let headerClose = tagEnd;
    let inQuote = false;
    let quoteChar = '';
    while (headerClose < xml.length) {
      const ch = xml[headerClose];
      if (inQuote) {
        if (ch === quoteChar) inQuote = false;
      } else if (ch === '"' || ch === "'") {
        inQuote = true;
        quoteChar = ch;
      } else if (ch === '>') {
        break;
      }
      headerClose++;
    }
    if (headerClose >= xml.length) break;

    let checkIdx = headerClose - 1;
    while (checkIdx > nextLt && xml.charCodeAt(checkIdx) <= 32) checkIdx--;
    const isSelfClosing = checkIdx > nextLt && xml[checkIdx] === '/';

    if (!isMatch) {
      pos = headerClose + 1;
      continue;
    }

    const attrs = safeExtractXmlAttributes(
      xml.slice(nextLt + 1, isSelfClosing ? checkIdx : headerClose)
    );

    if (isSelfClosing) {
      results.push({
        tag: currentTag,
        localName: currLocal,
        prefix: currPrefix,
        raw: xml.slice(nextLt, headerClose + 1),
        attrs,
        content: '',
        startIndex: nextLt,
        endIndex: headerClose + 1,
      });
      pos = headerClose + 1;
      continue;
    }

    // If document has no closing tags for this element, skip to avoid search
    let hasClosing = closingTagPresentMap.get(currentTag);
    if (hasClosing === undefined) {
      hasClosing = xml.indexOf('</' + currLocal) !== -1 || xml.indexOf('</' + currentTag) !== -1;
      closingTagPresentMap.set(currentTag, hasClosing);
    }
    if (!hasClosing) {
      pos = headerClose + 1;
      continue;
    }

    // Helper to find the next matching closing tag allowing optional whitespace before '>' (W3C XML 1.0 §3.1)
    const findNextClosingTag = (fromIndex: number): { index: number; end: number } | null => {
      let p = fromIndex;
      const targetClose = '</' + currentTag;
      while (p < xml.length) {
        const idx = xml.indexOf(targetClose, p);
        if (idx === -1) return null;
        let c = idx + targetClose.length;
        while (c < xml.length && xml.charCodeAt(c) <= 32) c++;
        if (c < xml.length && xml[c] === '>') {
          return { index: idx, end: c + 1 };
        }
        p = idx + targetClose.length;
      }
      return null;
    };

    // Scan for matching closing tag with depth tracking
    const startTag = '<' + currentTag;
    let depth = 0;
    let searchPos = headerClose + 1;
    let matchedEnd = -1;
    let contentEnd = -1;

    while (searchPos < xml.length) {
      // Skip inner comments or CDATA
      if (xml.startsWith('<!--', searchPos)) {
        const endC = xml.indexOf('-->', searchPos + 4);
        searchPos = endC === -1 ? xml.length : endC + 3;
        continue;
      }
      if (xml.startsWith('<![CDATA[', searchPos)) {
        const endCd = xml.indexOf(']]>', searchPos + 9);
        searchPos = endCd === -1 ? xml.length : endCd + 3;
        continue;
      }

      const nextOpen = xml.indexOf(startTag, searchPos);
      const closeInfo = findNextClosingTag(searchPos);

      if (!closeInfo) break; // Unclosed tag, abort gracefully

      if (nextOpen !== -1 && nextOpen < closeInfo.index) {
        const charAfter = xml[nextOpen + startTag.length];
        if (charAfter === '>' || charAfter === '/' || charAfter <= ' ') {
          // Check if self-closing
          const nextHeaderClose = xml.indexOf('>', nextOpen);
          if (nextHeaderClose !== -1) {
            let slashIdx = nextHeaderClose - 1;
            while (slashIdx > nextOpen && xml.charCodeAt(slashIdx) <= 32) slashIdx--;
            if (slashIdx > nextOpen && xml[slashIdx] === '/') {
              // Self closing nested tag, does not increase depth
            } else {
              depth++;
              if (depth > maxDepth) break; // Bound depth
            }
            searchPos = nextHeaderClose + 1;
            continue;
          }
        }
        searchPos = nextOpen + startTag.length;
      } else {
        if (depth === 0) {
          contentEnd = closeInfo.index;
          matchedEnd = closeInfo.end;
          break;
        } else {
          depth--;
          searchPos = closeInfo.end;
        }
      }
    }

    if (matchedEnd !== -1) {
      results.push({
        tag: currentTag,
        localName: currLocal,
        prefix: currPrefix,
        raw: xml.slice(nextLt, matchedEnd),
        attrs,
        content: xml.slice(headerClose + 1, contentEnd),
        startIndex: nextLt,
        endIndex: matchedEnd,
      });
      pos = matchedEnd;
    } else {
      pos = headerClose + 1;
    }
  }

  return results;
}

/**
 * Returns the first matching element in linear time, or null if not found.
 */
export function safeExtractFirstXmlElement(
  xml: string,
  tagName: string | string[],
  options?: SafeXmlScannerOptions
): SafeXmlElement | null {
  const elements = safeExtractXmlElements(xml, tagName, { ...options, maxElements: 1 });
  return elements.length > 0 ? elements[0] : null;
}

/**
 * Safely extracts inner XML content of the first matching tag.
 */
export function safeExtractTagContent(xml: string, tagName: string | string[]): string | null {
  const el = safeExtractFirstXmlElement(xml, tagName);
  return el ? el.content : null;
}

/**
 * Linearly decodes standard XML entities and strips tags safely in O(N) time.
 */
export function safeDecodeXmlEntities(str: string): string {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = parseInt(hex, 16);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
    });
}

/**
 * Extracts and decodes all text content from specified tags (e.g. w:t, a:t, text:p)
 * or strips tags linearly in O(N).
 */
export function safeExtractAllText(xml: string, tagName?: string): string {
  if (!xml) return '';
  if (tagName) {
    const elements = safeExtractXmlElements(xml, tagName);
    return elements.map((e) => safeDecodeXmlEntities(e.content.replace(/<[^>]+>/g, ''))).join('');
  }
  return safeDecodeXmlEntities(xml.replace(/<[^>]+>/g, ''));
}

/**
 * Navigates linearly down an element hierarchy path (e.g. ['p:grpSpPr', 'a:xfrm', 'a:off']).
 * Replaces dangerous chained regexes with deterministic O(N) depth-bounded traversal.
 */
export function safeFindXmlPath(xml: string, path: string[]): SafeXmlElement | null {
  let currentXml = xml;
  let currentEl: SafeXmlElement | null = null;
  for (const step of path) {
    currentEl = safeExtractFirstXmlElement(currentXml, step);
    if (!currentEl) return null;
    currentXml = currentEl.content;
  }
  return currentEl;
}

/**
 * Safely extracts hex color from solidFill or srgbClr elements without regex backtracking.
 */
export function safeFindColor(xml: string, parentPath: string[] = []): string | undefined {
  const targetXml = parentPath.length > 0 ? safeFindXmlPath(xml, parentPath)?.content : xml;
  if (!targetXml) return undefined;
  const srgbEl = safeExtractFirstXmlElement(targetXml, 'a:srgbClr') || safeExtractFirstXmlElement(targetXml, 'srgbClr');
  if (srgbEl && srgbEl.attrs.val && /^[A-Fa-f0-9]{6}$/.test(srgbEl.attrs.val)) {
    return `#${srgbEl.attrs.val}`;
  }
  return undefined;
}

function safeExtractXmlTags(xml: string, tagName: string): string[] {
  return safeExtractXmlElements(xml, tagName).map((e) => e.raw);
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

    const el = safeExtractFirstXmlElement(bodyXml.slice(startIdx), tag);
    if (!el) {
      pos = startIdx + tag.length + 1;
      continue;
    }

    blocks.push(el.raw);
    pos = startIdx + el.endIndex;
  }
  return blocks;
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

  const gridColCount = Math.max(
    ...structuredRows.map((sr) =>
      sr.reduce((sum, c) => sum + Math.max(1, c.colSpan || 1), 0)
    ),
    ...rows.map((r) => r.length)
  );
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

  const blocks = safeExtractDocxBlocks(bodyXml);

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
    const headingLevel = isHeading1 ? 1 : isHeading2 ? 2 : isHeading3 ? 3 : isHeading ? 2 : 0;

    const jcMatch = chunk.match(/<w:jc\s+[^>]*w:val="([^"]+)"/);
    const alignment = jcMatch ? (jcMatch[1] as any) : undefined;
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
          if (cell.rowSpan === 0) return; // Skip cells vertically merged from previous row
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
          const rowSpanAttr = cell.rowSpan && cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : '';
          let cellInner = escapeHtml(cell.text).replace(/\n/g, '<br/>');
          if (cell.nestedTable) {
            cellInner += (cellInner ? '<br/>' : '') + renderTable(cell.nestedTable);
          }
          tblHtml += `  <${tag}${colSpanAttr}${rowSpanAttr} style="${cellStyle}">${cellInner}</${tag}>\n`;
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
    const cleanRows = tbl.rows.map((r) =>
      r.map((c) => c.replace(/\n/g, ' ').replace(/\|/g, '\\|'))
    );
    const header = `| ${cleanRows[0].join(' | ')} |`;
    const sep = `| ${cleanRows[0].map(() => '---').join(' | ')} |`;
    const body = cleanRows
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

const WIN_ANSI_SPECIAL_CODES = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
  0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

/**
 * Detects whether text contains characters unencodable in standard WinAnsi encoding.
 */
export function isNonWinAnsi(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0x20 && code <= 0x7e) ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0d ||
      (code >= 0xa0 && code <= 0xff) ||
      WIN_ANSI_SPECIAL_CODES.has(code)
    ) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Sanitizes unencodable non-WinAnsi code points gracefully.
 */
export function sanitizeWinAnsi(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0x20 && code <= 0x7e) ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0d ||
      (code >= 0xa0 && code <= 0xff) ||
      WIN_ANSI_SPECIAL_CODES.has(code)
    ) {
      out += text[i];
    }
  }
  return out;
}

/** Documents whose text is drawn with an embedded Unicode font (an installed one was found). */
const unicodeFontDocuments = new WeakSet<PDFKit.PDFDocument>();

/** One Unicode text writer per pdfkit document, so each embedded font is registered once. */
const unicodeTextWriters = new WeakMap<PDFKit.PDFDocument, PdfUnicodeTextWriter>();

function unicodeTextWriterFor(doc: PDFKit.PDFDocument, customPath?: string): PdfUnicodeTextWriter {
  let writer = unicodeTextWriters.get(doc);
  if (!writer) {
    writer = new PdfUnicodeTextWriter(doc, customPath);
    unicodeTextWriters.set(doc, writer);
  }
  return writer;
}

/**
 * Resolves the preferred installed Unicode font, or the custom font when it exists.
 */
export function resolveUnicodeFallbackFont(customPath?: string): string | null {
  return preferredUnicodeFontPath(customPath);
}

/**
 * Selects the preferred installed Unicode font in the document. Text drawn through
 * renderSafePdfText then picks, per run, an embedded font that covers its characters.
 */
export function configurePdfKitFontFallback(
  doc: PDFKit.PDFDocument,
  customPath?: string
): { hasUnicodeFont: boolean; fontName?: string } {
  const fontName = unicodeTextWriterFor(doc, customPath).usePrimaryFace();
  if (!fontName) return { hasUnicodeFont: false };
  unicodeFontDocuments.add(doc);
  return { hasUnicodeFont: true, fontName };
}

/**
 * Writes text into a PDFKit document with embedded fonts chosen per run by glyph coverage.
 * Throws EngineUnavailableError when no installed font covers a character, instead of drawing
 * empty boxes. Without any installed Unicode font, WinAnsi-only text keeps the standard font.
 */
export function renderSafePdfText(
  doc: PDFKit.PDFDocument,
  text: string,
  hasUnicodeFont: boolean,
  options?: PDFKit.Mixins.TextOptions,
  x?: number,
  y?: number
): PDFKit.PDFDocument {
  const stringText = String(text ?? '');
  if (!stringText) return doc;
  assertNoComplexScript(stringText, 'Pure-TS Office PDF rendering');

  if (!hasUnicodeFont && !isNonWinAnsi(stringText)) {
    if (x !== undefined && y !== undefined) {
      return doc.text(stringText, x, y, options);
    }
    return doc.text(stringText, options);
  }

  unicodeTextWriterFor(doc).write(stringText, options ?? {}, x, y);
  return doc;
}


/**
 * Height the text takes at the given options, measured with the fonts that renderSafePdfText draws it
 * with: each run in its own embedded font, never the font that happens to be selected in the document.
 */
export function measurePdfTextHeight(doc: PDFKit.PDFDocument, text: string, options: PDFKit.Mixins.TextOptions): number {
  if (!text) return 0;
  if (!unicodeFontDocuments.has(doc) && !isNonWinAnsi(text)) {
    return doc.heightOfString(text, options);
  }
  return unicodeTextWriterFor(doc).heightOf(text, options);
}

export function renderPdfChart(
  doc: PDFKit.PDFDocument,
  chart: OpenXmlChartData,
  hasUnicodeFont: boolean,
  x?: number,
  y?: number,
  width?: number,
  height?: number
): void {
  const startX = x !== undefined ? x : 50;
  const chartWidth = width !== undefined ? width : doc.page.width - 100;
  const chartHeight = height !== undefined ? height : 220;

  if (y === undefined && doc.y + chartHeight > doc.page.height - 60) {
    doc.addPage();
  }
  const startY = y !== undefined ? y : doc.y;

  // Chart container background & border
  doc.rect(startX, startY, chartWidth, chartHeight).fillAndStroke('#F8F9FE', '#CCD2FC');

  // Title
  if (chart.title) {
    doc.fillColor('#1F2340').fontSize(11);
    renderSafePdfText(
      doc,
      chart.title,
      hasUnicodeFont,
      { width: chartWidth - 20, align: 'center' },
      startX + 10,
      startY + 8
    );
  }

  // Plot dimensions
  const titleH = chart.title ? 26 : 12;
  const plotLeft = startX + 45;
  const plotRight = startX + chartWidth - 25;
  const plotTop = startY + titleH;
  const plotBottom = startY + chartHeight - 35;
  const pw = Math.max(10, plotRight - plotLeft);
  const ph = Math.max(10, plotBottom - plotTop);

  const allVals = chart.series.flatMap((s) => s.values);
  const maxVal = Math.max(1, ...allVals);

  // Axes
  doc
    .moveTo(plotLeft, plotTop)
    .lineTo(plotLeft, plotBottom)
    .lineTo(plotRight, plotBottom)
    .lineWidth(1)
    .strokeColor('#CCD2FC')
    .stroke();

  // Gridlines
  const gridSteps = 3;
  for (let i = 0; i <= gridSteps; i++) {
    const gy = plotBottom - (i / gridSteps) * ph;
    doc.moveTo(plotLeft, gy).lineTo(plotRight, gy).lineWidth(0.5).strokeColor('#E1E4EE').stroke();
  }

  if (chart.type === 'bar') {
    const numCats = Math.max(1, chart.categories.length);
    const catWidth = pw / numCats;
    const numSeries = Math.max(1, chart.series.length);
    const barWidth = Math.max(3, (catWidth * 0.7) / numSeries);

    chart.categories.forEach((cat, cIdx) => {
      chart.series.forEach((s, sIdx) => {
        const val = s.values[cIdx] || 0;
        const bHeight = Math.max(0, (val / maxVal) * ph);
        const bx = plotLeft + cIdx * catWidth + catWidth * 0.15 + sIdx * barWidth;
        const by = plotBottom - bHeight;
        const color = CHART_PALETTE[sIdx % CHART_PALETTE.length];
        doc.rect(bx, by, Math.max(1, barWidth - 1), bHeight).fill(color);
      });
      doc.fillColor('#4D536B').fontSize(7.5);
      renderSafePdfText(
        doc,
        cat,
        hasUnicodeFont,
        { width: catWidth, align: 'center', lineBreak: false },
        plotLeft + cIdx * catWidth,
        plotBottom + 6
      );
    });
  } else if (chart.type === 'line' || chart.type === 'scatter') {
    const numCats = Math.max(1, chart.categories.length);
    const catStep = pw / Math.max(1, numCats - 1);

    chart.series.forEach((s, sIdx) => {
      const color = CHART_PALETTE[sIdx % CHART_PALETTE.length];
      const pts: Array<{ x: number; y: number }> = [];
      s.values.forEach((val, vIdx) => {
        const px = plotLeft + vIdx * catStep;
        const py = plotBottom - Math.max(0, (val / maxVal) * ph);
        pts.push({ x: px, y: py });
      });
      if (pts.length > 1) {
        doc.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) {
          doc.lineTo(pts[i].x, pts[i].y);
        }
        doc.lineWidth(1.8).strokeColor(color).stroke();
      }
      pts.forEach((p) => {
        doc.circle(p.x, p.y, 2.5).fill(color);
      });
    });

    chart.categories.forEach((cat, cIdx) => {
      doc.fillColor('#4D536B').fontSize(7.5);
      renderSafePdfText(
        doc,
        cat,
        hasUnicodeFont,
        { width: catStep, align: 'center', lineBreak: false },
        plotLeft + cIdx * catStep - catStep / 2,
        plotBottom + 6
      );
    });
  } else if (chart.type === 'area') {
    const numCats = Math.max(1, chart.categories.length);
    const catStep = pw / Math.max(1, numCats - 1);

    chart.series.forEach((s, sIdx) => {
      const color = CHART_PALETTE[sIdx % CHART_PALETTE.length];
      const pts: Array<{ x: number; y: number }> = [];
      s.values.forEach((val, vIdx) => {
        const px = plotLeft + vIdx * catStep;
        const py = plotBottom - Math.max(0, (val / maxVal) * ph);
        pts.push({ x: px, y: py });
      });
      if (pts.length > 1) {
        doc.save();
        doc.moveTo(plotLeft, plotBottom);
        pts.forEach((p) => doc.lineTo(p.x, p.y));
        doc.lineTo(plotLeft + (s.values.length - 1) * catStep, plotBottom);
        doc.closePath();
        doc.fillColor(color).fillOpacity(0.3).fill();
        doc.restore();

        doc.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) {
          doc.lineTo(pts[i].x, pts[i].y);
        }
        doc.lineWidth(1.8).strokeColor(color).stroke();
      }
    });

    chart.categories.forEach((cat, cIdx) => {
      doc.fillColor('#4D536B').fontSize(7.5);
      renderSafePdfText(
        doc,
        cat,
        hasUnicodeFont,
        { width: catStep, align: 'center', lineBreak: false },
        plotLeft + cIdx * catStep - catStep / 2,
        plotBottom + 6
      );
    });
  } else if (chart.type === 'pie' || chart.type === 'doughnut') {
    const cx = plotLeft + pw / 2;
    const cy = plotTop + ph / 2;
    const radius = (Math.min(pw, ph) / 2) * 0.8;
    const rInner = chart.type === 'doughnut' ? radius * 0.55 : 0;
    const total = allVals.reduce((a, b) => a + b, 0) || 1;
    let startAngle = -Math.PI / 2;

    allVals.forEach((val, vIdx) => {
      const sliceAngle = (val / total) * 2 * Math.PI;
      const endAngle = startAngle + sliceAngle;
      const color = CHART_PALETTE[vIdx % CHART_PALETTE.length];

      doc.save();
      if (sliceAngle >= 2 * Math.PI - 0.001) {
        if (rInner > 0) {
          doc.circle(cx, cy, radius).fill(color);
          doc.circle(cx, cy, rInner).fill('#F8F9FE');
        } else {
          doc.circle(cx, cy, radius).fill(color);
        }
      } else {
        const steps = Math.max(8, Math.ceil(sliceAngle / 0.1));
        if (rInner > 0) {
          doc.moveTo(cx + radius * Math.cos(startAngle), cy + radius * Math.sin(startAngle));
          for (let step = 0; step <= steps; step++) {
            const theta = startAngle + (step / steps) * sliceAngle;
            doc.lineTo(cx + radius * Math.cos(theta), cy + radius * Math.sin(theta));
          }
          for (let step = steps; step >= 0; step--) {
            const theta = startAngle + (step / steps) * sliceAngle;
            doc.lineTo(cx + rInner * Math.cos(theta), cy + rInner * Math.sin(theta));
          }
          doc.closePath();
          doc.fillColor(color).fill();
        } else {
          doc.moveTo(cx, cy);
          for (let step = 0; step <= steps; step++) {
            const theta = startAngle + (step / steps) * sliceAngle;
            doc.lineTo(cx + radius * Math.cos(theta), cy + radius * Math.sin(theta));
          }
          doc.closePath();
          doc.fillColor(color).fill();
        }
      }
      doc.restore();
      startAngle = endAngle;
    });
  }

  // Draw legend if multiple series
  if (chart.series.length > 1) {
    let lx = plotLeft;
    const ly = startY + chartHeight - 12;
    chart.series.forEach((s, sIdx) => {
      const color = CHART_PALETTE[sIdx % CHART_PALETTE.length];
      doc.rect(lx, ly - 6, 8, 8).fill(color);
      doc.fillColor('#4D536B').fontSize(7.5);
      renderSafePdfText(doc, s.name, hasUnicodeFont, undefined, lx + 11, ly - 6);
      lx += s.name.length * 5 + 24;
    });
  }

  if (y === undefined) {
    doc.y = startY + chartHeight + 14;
  }
}

export function renderSinglePdfShape(
  doc: PDFKit.PDFDocument,
  s: DrawingMlShape,
  hasUnicodeFont: boolean,
  posX: number,
  posY: number,
  sw: number,
  sh: number
): void {
  doc.save();
  const cx = posX + sw / 2;
  const cy = posY + sh / 2;
  doc.translate(cx, cy);
  if (s.rotation) doc.rotate(s.rotation);
  if (s.flipH || s.flipV) doc.scale(s.flipH ? -1 : 1, s.flipV ? -1 : 1);
  doc.translate(-cx, -cy);

  const geom = (s.presetGeom || 'rect').toLowerCase();
  const hasFill = s.fillColor && s.fillColor !== 'none';
  const strokeColor = s.strokeColor || '#1F2340';
  const strokeWidth = s.strokeWidth ?? 1;
  const hasStroke = strokeWidth > 0 && strokeColor !== 'none';

  if (s.geomType === 'custom' && s.svgPath) {
    try {
      doc.path(s.svgPath);
    } catch {
      doc.rect(posX, posY, sw, sh);
    }
  } else {
    switch (geom) {
      case 'ellipse':
      case 'circle':
        doc.ellipse(posX + sw / 2, posY + sh / 2, sw / 2, sh / 2);
        break;
      case 'roundrect': {
        const hasGuides = s.guides?.rx !== undefined || s.guides?.r !== undefined || s.adjustValues?.adj !== undefined;
        const defaultRadius = hasGuides ? Math.min(sw, sh) * getShapeAdjustRatio(s, 'adj', 0.15) : Math.min(8, sw * 0.15);
        const rx = getGuideValue(s, 'rx', getGuideValue(s, 'r', defaultRadius));
        doc.roundedRect(posX, posY, sw, sh, rx);
        break;
      }
      case 'triangle':
        doc.polygon([posX + sw / 2, posY], [posX + sw, posY + sh], [posX, posY + sh]);
        break;
      case 'diamond':
      case 'flowchartdecision':
        doc.polygon(
          [posX + sw / 2, posY],
          [posX + sw, posY + sh / 2],
          [posX + sw / 2, posY + sh],
          [posX, posY + sh / 2]
        );
        break;
      case 'line':
        doc.moveTo(posX, posY).lineTo(posX + sw, posY + sh);
        break;
      case 'rightarrow': {
        const headRatio = getShapeAdjustRatio(s, 'adj1', 0.4);
        const shaftThick = getShapeAdjustRatio(s, 'adj2', 0.5);
        const shaftX = posX + sw * (1 - headRatio);
        const yTop = posY + (sh * (1 - shaftThick)) / 2;
        const yBottom = posY + sh - (sh * (1 - shaftThick)) / 2;
        doc.polygon(
          [posX, yTop],
          [shaftX, yTop],
          [shaftX, posY],
          [posX + sw, posY + sh * 0.5],
          [shaftX, posY + sh],
          [shaftX, yBottom],
          [posX, yBottom]
        );
        break;
      }
      case 'leftrightarrow': {
        const headRatio = getShapeAdjustRatio(s, 'adj1', 0.25);
        const shaftThick = getShapeAdjustRatio(s, 'adj2', 0.5);
        const leftHead = posX + sw * headRatio;
        const rightHead = posX + sw * (1 - headRatio);
        const yTop = posY + (sh * (1 - shaftThick)) / 2;
        const yBottom = posY + sh - (sh * (1 - shaftThick)) / 2;
        doc.polygon(
          [posX, posY + sh * 0.5],
          [leftHead, posY],
          [leftHead, yTop],
          [rightHead, yTop],
          [rightHead, posY],
          [posX + sw, posY + sh * 0.5],
          [rightHead, posY + sh],
          [rightHead, yBottom],
          [leftHead, yBottom],
          [leftHead, posY + sh]
        );
        break;
      }
      case 'chevron': {
        const depthRatio = getShapeAdjustRatio(s, 'adj', 0.25);
        const dX = sw * depthRatio;
        doc.polygon(
          [posX, posY],
          [posX + sw - dX, posY],
          [posX + sw, posY + sh * 0.5],
          [posX + sw - dX, posY + sh],
          [posX, posY + sh],
          [posX + dX, posY + sh * 0.5]
        );
        break;
      }
      case 'cube': {
        const cd = Math.min(sw, sh) * getShapeAdjustRatio(s, 'adj', 0.2);
        const fill = s.fillColor || '#5C6BC0';
        const topFill = adjustHexBrightness(fill, 1.2);
        const rightFill = adjustHexBrightness(fill, 0.8);

        // Top face
        doc.polygon(
          [posX, posY + cd],
          [posX + cd, posY],
          [posX + sw, posY],
          [posX + sw - cd, posY + cd]
        );
        if (topFill && topFill !== 'none') doc.fill(topFill);
        if (hasStroke) doc.lineWidth(strokeWidth).stroke(strokeColor);

        // Right face
        doc.polygon(
          [posX + sw - cd, posY + cd],
          [posX + sw, posY],
          [posX + sw, posY + sh - cd],
          [posX + sw - cd, posY + sh]
        );
        if (rightFill && rightFill !== 'none') doc.fill(rightFill);
        if (hasStroke) doc.lineWidth(strokeWidth).stroke(strokeColor);

        // Front face
        doc.rect(posX, posY + cd, sw - cd, sh - cd);
        if (fill && fill !== 'none') doc.fill(fill);
        if (hasStroke) doc.lineWidth(strokeWidth).stroke(strokeColor);
        break;
      }
      case 'wedgerectcallout': {
        const tailX = posX + sw * getShapeAdjustRatio(s, 'adj1', 0.3);
        const tailY = posY + sh * getShapeAdjustRatio(s, 'adj2', 1.0);
        doc.polygon(
          [posX, posY],
          [posX + sw, posY],
          [posX + sw, posY + sh * 0.75],
          [posX + sw * 0.55, posY + sh * 0.75],
          [tailX, tailY],
          [posX + sw * 0.38, posY + sh * 0.75],
          [posX, posY + sh * 0.75]
        );
        break;
      }
      case 'star5': {
        const rOuter = Math.min(sw, sh) / 2;
        const rInner = rOuter * 0.4;
        const pts: Array<[number, number]> = [];
        for (let i = 0; i < 10; i++) {
          const angle = (i * Math.PI) / 5 - Math.PI / 2;
          const r = i % 2 === 0 ? rOuter : rInner;
          pts.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
        }
        if (pts.length > 0) doc.polygon(...pts);
        break;
      }
      case 'flowchartprocess':
      case 'rect':
      default:
        doc.rect(posX, posY, sw, sh);
        break;
    }
  }

  if (geom !== 'cube') {
    if (hasFill && hasStroke) {
      doc.lineWidth(strokeWidth).fillAndStroke(s.fillColor!, strokeColor);
    } else if (hasFill) {
      doc.fill(s.fillColor!);
    } else if (hasStroke) {
      doc.lineWidth(strokeWidth).stroke(strokeColor);
    }
  }
  doc.restore();

  if (s.text) {
    const textFill =
      s.fillColor === '#5C6BC0' || s.fillColor === '#1F2340' ? '#FFFFFF' : '#1F2340';
    doc.fillColor(textFill).fontSize(Math.max(8, Math.min(12, sh * 0.3)));
    renderSafePdfText(
      doc,
      s.text,
      hasUnicodeFont,
      { width: Math.max(10, sw - 8), align: 'center' },
      posX + 4,
      posY + sh / 2 - 6
    );
  }
}

function renderPdfDrawingShapes(
  doc: PDFKit.PDFDocument,
  shapes: DrawingMlShape[],
  hasUnicodeFont: boolean
): void {
  if (shapes.length === 0) return;
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

  const drawWidth = Math.max(20, maxX - minX);
  const drawHeight = Math.max(20, maxY - minY);

  if (doc.y + drawHeight > doc.page.height - 60) {
    doc.addPage();
  }
  const baseY = doc.y;
  const startX = 50;
  const maxW = doc.page.width - 100;
  const scale = drawWidth > maxW ? maxW / drawWidth : 1;

  for (const s of shapes) {
    if (s.chart) {
      renderPdfChart(
        doc,
        s.chart,
        hasUnicodeFont,
        startX + (s.x - minX) * scale,
        baseY + (s.y - minY) * scale,
        s.width * scale,
        s.height * scale
      );
      continue;
    }

    const posX = startX + (s.x - minX) * scale;
    const posY = baseY + (s.y - minY) * scale;
    const sw = s.width * scale;
    const sh = s.height * scale;
    renderSinglePdfShape(doc, s, hasUnicodeFont, posX, posY, sw, sh);
  }

  doc.y = baseY + drawHeight * scale + 15;
}

async function generatePdfFromDocx(
  paragraphs: DocxParagraph[],
  tables: DocxTable[],
  options: ConversionOptions,
  title: string,
  elements?: DocxBlockElement[]
): Promise<Buffer> {
  assertNoComplexScript(title, 'Pure-TS DOCX to PDF');
  for (const p of paragraphs) {
    assertNoComplexScript(p.text, 'Pure-TS DOCX to PDF');
  }
  for (const tbl of tables) {
    for (const r of tbl.rows) {
      for (const cell of r) {
        assertNoComplexScript(cell, 'Pure-TS DOCX to PDF');
      }
    }
  }
  if (elements) {
    for (const el of elements) {
      if (el.type === 'paragraph') {
        assertNoComplexScript(el.paragraph.text, 'Pure-TS DOCX to PDF');
      } else if (el.type === 'table') {
        for (const r of el.table.rows) {
          for (const cell of r) {
            assertNoComplexScript(cell, 'Pure-TS DOCX to PDF');
          }
        }
      }
    }
  }

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

    const { hasUnicodeFont } = configurePdfKitFontFallback(doc, (options as any).fontPath);

    const renderTable = (tbl: DocxTable) => {
      if (tbl.rows.length === 0) return;
      doc.moveDown(0.8);
      const colCount = Math.max(1, tbl.colCount || (tbl.colWidths ? tbl.colWidths.length : tbl.rows[0].length));
      const availableWidth = doc.page.width - 100;

      // Compute base grid column widths from w:gridCol or fallback evenly
      const gridColWidths: number[] = [];
      if (tbl.colWidths && tbl.colWidths.length > 0) {
        const totalGridW = tbl.colWidths.reduce((sum, w) => sum + w, 0);
        if (totalGridW > 0) {
          for (let i = 0; i < colCount; i++) {
            const rawW = tbl.colWidths[i] ?? (totalGridW / tbl.colWidths.length);
            gridColWidths.push((rawW / totalGridW) * availableWidth);
          }
        }
      }
      if (gridColWidths.length === 0) {
        const defaultW = availableWidth / colCount;
        for (let i = 0; i < colCount; i++) {
          gridColWidths.push(defaultW);
        }
      }

      if (tbl.structuredRows && tbl.structuredRows.length > 0) {
        tbl.structuredRows.forEach((sRow, rIdx) => {
          // 1. Calculate cell widths and starting X positions using gridSpan / colSpan
          const cellWidths: number[] = [];
          const cellXPositions: number[] = [];
          let currentGridIdx = 0;

          sRow.forEach((cell) => {
            const span = Math.max(1, cell.colSpan || 1);
            let cellW = 0;
            for (let s = 0; s < span; s++) {
              const gIdx = Math.min(currentGridIdx + s, gridColWidths.length - 1);
              cellW += gridColWidths[gIdx] ?? (availableWidth / colCount);
            }
            let startX = 50;
            for (let k = 0; k < currentGridIdx; k++) {
              const gIdx = Math.min(k, gridColWidths.length - 1);
              startX += gridColWidths[gIdx] ?? (availableWidth / colCount);
            }
            cellWidths.push(cellW);
            cellXPositions.push(startX);
            currentGridIdx += span;
          });

          // 2. Compute dynamic row height based on wrapped text height across all cells
          let maxCellHeight = 20;
          sRow.forEach((cell, cIdx) => {
            if (cell.rowSpan === 0) return;
            const cWidth = cellWidths[cIdx];
            const textWidth = Math.max(10, cWidth - 10);
            const fontSize = cell.isHeader || rIdx === 0 ? 9 : 8.5;
            doc.fontSize(fontSize);
            const cellText = cell.text || '';
            const textHeight = cellText.trim().length > 0 ? measurePdfTextHeight(doc, cellText, { width: textWidth }) : 0;
            let requiredHeight = Math.ceil(textHeight + 10);

            const tablesToRender = cell.nestedTables && cell.nestedTables.length > 0
              ? cell.nestedTables
              : (cell.nestedTable && cell.nestedTable.rows.length > 0 ? [cell.nestedTable] : []);

            if (tablesToRender.length > 0) {
              for (const nTbl of tablesToRender) {
                const nRows =
                  nTbl.structuredRows && nTbl.structuredRows.length > 0
                    ? nTbl.structuredRows
                    : nTbl.rows;
                const nColCount = Math.max(
                  1,
                  nTbl.colCount || nTbl.colWidths?.length || (nRows[0]?.length || 1)
                );
                const nColW = Math.max(10, (cWidth - 8) / nColCount);
                doc.fontSize(7.5);
                for (const rowItem of nRows) {
                  let maxSubH = 16;
                  if (Array.isArray(rowItem)) {
                    for (const subCell of rowItem) {
                      const subText = typeof subCell === 'string' ? subCell : (subCell?.text || '');
                      const subTh = measurePdfTextHeight(doc, subText || ' ', { width: Math.max(5, nColW - 6) });
                      if (subTh + 6 > maxSubH) maxSubH = Math.ceil(subTh + 6);
                    }
                  }
                  requiredHeight += maxSubH;
                }
                requiredHeight += 4;
              }
            } else if (cell.fullCellText && cell.fullCellText !== cell.text) {
              const fullH = measurePdfTextHeight(doc, cell.fullCellText, { width: textWidth });
              requiredHeight = Math.max(requiredHeight, Math.ceil(fullH + 10));
            }
            if (requiredHeight > maxCellHeight) {
              maxCellHeight = requiredHeight;
            }
          });

          const rowHeight = maxCellHeight;

          // Check page overflow
          if (doc.y + rowHeight > doc.page.height - 60) {
            doc.addPage();
          }
          const y = doc.y;

          // 3. Render each cell
          sRow.forEach((cell, cIdx) => {
            if (cell.rowSpan === 0) return;
            const x = cellXPositions[cIdx];
            const colWidth = cellWidths[cIdx];

            if (cell.shading && cell.shading !== 'auto') {
              doc.rect(x, y, colWidth, rowHeight).fill('#' + cell.shading);
            } else if (cell.isHeader || rIdx === 0) {
              doc.rect(x, y, colWidth, rowHeight).fill('#F0F2FE');
            }

            const topBorder = cell.borders?.top || tbl.tblBorders?.top;
            const bottomBorder = cell.borders?.bottom || tbl.tblBorders?.bottom;
            const leftBorder = cell.borders?.left || tbl.tblBorders?.left;
            const rightBorder = cell.borders?.right || tbl.tblBorders?.right;

            if (cell.borders || tbl.tblBorders) {
              if (topBorder && topBorder.style !== 'none') {
                doc
                  .moveTo(x, y)
                  .lineTo(x + colWidth, y)
                  .lineWidth(topBorder.size || 0.5)
                  .strokeColor(topBorder.color || '#CCD2FC')
                  .stroke();
              }
              if (bottomBorder && bottomBorder.style !== 'none') {
                doc
                  .moveTo(x, y + rowHeight)
                  .lineTo(x + colWidth, y + rowHeight)
                  .lineWidth(bottomBorder.size || 0.5)
                  .strokeColor(bottomBorder.color || '#CCD2FC')
                  .stroke();
              }
              if (leftBorder && leftBorder.style !== 'none') {
                doc
                  .moveTo(x, y)
                  .lineTo(x, y + rowHeight)
                  .lineWidth(leftBorder.size || 0.5)
                  .strokeColor(leftBorder.color || '#CCD2FC')
                  .stroke();
              }
              if (rightBorder && rightBorder.style !== 'none') {
                doc
                  .moveTo(x + colWidth, y)
                  .lineTo(x + colWidth, y + rowHeight)
                  .lineWidth(rightBorder.size || 0.5)
                  .strokeColor(rightBorder.color || '#CCD2FC')
                  .stroke();
              }
            } else {
              doc.rect(x, y, colWidth, rowHeight).strokeColor('#CCD2FC').lineWidth(0.5).stroke();
            }

            const textCol = cell.isHeader || rIdx === 0 ? '#1F2340' : '#4D536B';
            doc.fillColor(textCol).fontSize(cell.isHeader || rIdx === 0 ? 9 : 8.5);
            const align = cell.alignment || (cell.isHeader || rIdx === 0 ? 'center' : 'left');
            let textOffsetY = y + 5;
            if (cell.text && cell.text.trim().length > 0) {
              renderSafePdfText(
                doc,
                cell.text,
                hasUnicodeFont,
                { width: colWidth - 10, lineBreak: true, align },
                x + 5,
                textOffsetY
              );
              const tH = measurePdfTextHeight(doc, cell.text, { width: colWidth - 10 });
              textOffsetY += Math.ceil(tH + 4);
            }

            const tablesToRender = cell.nestedTables && cell.nestedTables.length > 0
              ? cell.nestedTables
              : (cell.nestedTable && cell.nestedTable.rows.length > 0 ? [cell.nestedTable] : []);

            if (tablesToRender.length > 0) {
              for (const nTbl of tablesToRender) {
                const nX = x + 4;
                const nY = textOffsetY;
                const nW = colWidth - 8;
                const nRows =
                  nTbl.structuredRows && nTbl.structuredRows.length > 0
                    ? nTbl.structuredRows
                    : nTbl.rows.map((r) => r.map((c) => ({ text: c } as DocxTableCell)));
                const nColCount = Math.max(
                  1,
                  nTbl.colCount || (nTbl.colWidths ? nTbl.colWidths.length : (nRows[0]?.length || 1))
                );
                const nColW = nW / nColCount;

                let curNY = nY;
                nRows.forEach((nRow, nrIdx) => {
                  let nRowH = 16;
                  doc.fontSize(7.5);
                  nRow.forEach((nCell) => {
                    const nText = nCell.text || '';
                    const nTh = measurePdfTextHeight(doc, nText || ' ', { width: Math.max(5, nColW - 6) });
                    if (nTh + 6 > nRowH) nRowH = Math.ceil(nTh + 6);
                  });

                  nRow.forEach((nCell, ncIdx) => {
                    const cellSubX = nX + ncIdx * nColW;
                    if (nCell.shading && nCell.shading !== 'auto') {
                      doc.rect(cellSubX, curNY, nColW, nRowH).fill('#' + nCell.shading);
                    } else if (nCell.isHeader || nrIdx === 0) {
                      doc.rect(cellSubX, curNY, nColW, nRowH).fill('#E8EAF6');
                    }
                    doc.rect(cellSubX, curNY, nColW, nRowH).strokeColor('#B0B8E8').lineWidth(0.5).stroke();

                    doc.fillColor('#2C304E').fontSize(7.5);
                    renderSafePdfText(
                      doc,
                      nCell.text || '',
                      hasUnicodeFont,
                      { width: nColW - 6, lineBreak: true, align: nCell.alignment || 'left' },
                      cellSubX + 3,
                      curNY + 3
                    );
                  });
                  curNY += nRowH;
                });
                textOffsetY = curNY + 4;
              }
            } else if (!cell.text && cell.fullCellText) {
              renderSafePdfText(
                doc,
                cell.fullCellText,
                hasUnicodeFont,
                { width: colWidth - 10, lineBreak: true, align },
                x + 5,
                y + 5
              );
            }
          });

          doc.y = y + rowHeight;
        });
      } else {
        // Fallback for simple rows with dynamic text wrapping
        tbl.rows.forEach((row, rIdx) => {
          let maxCellHeight = 20;
          const colWidth = availableWidth / Math.max(1, row.length);
          const fontSize = rIdx === 0 ? 9 : 8.5;
          doc.fontSize(fontSize);
          row.forEach((cellText) => {
            const textHeight = measurePdfTextHeight(doc, cellText || ' ', { width: Math.max(10, colWidth - 10) });
            const reqH = Math.ceil(textHeight + 10);
            if (reqH > maxCellHeight) maxCellHeight = reqH;
          });
          const rowHeight = maxCellHeight;

          if (doc.y + rowHeight > doc.page.height - 60) {
            doc.addPage();
          }
          const y = doc.y;
          const isHdr = rIdx === 0;
          doc.rect(50, y, availableWidth, rowHeight).strokeColor('#CCD2FC').lineWidth(0.5);
          if (isHdr) {
            doc.rect(50, y, availableWidth, rowHeight).fill('#F0F2FE');
            doc.fillColor('#1F2340').fontSize(9);
          } else {
            doc.fillColor('#4D536B').fontSize(8.5);
          }

          row.forEach((cell, cIdx) => {
            renderSafePdfText(
              doc,
              cell,
              hasUnicodeFont,
              { width: colWidth - 10, lineBreak: true, align: isHdr ? 'center' : 'left' },
              50 + cIdx * colWidth + 5,
              y + 5
            );
          });
          doc.y = y + rowHeight;
        });
      }
      doc.moveDown(0.4);
    };

    const renderParagraph = (p: DocxParagraph) => {
      if (p.isHeading) {
        doc.moveDown(0.5);
        doc.fillColor('#5C6BC0').fontSize(p.headingLevel === 1 ? 16 : 14);
        renderSafePdfText(doc, p.text, hasUnicodeFont);
        doc.moveDown(0.25);
      } else {
        doc.fillColor(p.isBold ? '#1F2340' : '#4D536B').fontSize(10.5).lineGap(3);
        renderSafePdfText(doc, p.text, hasUnicodeFont, {
          align:
            p.alignment === 'center' ? 'center' : p.alignment === 'right' ? 'right' : 'left',
        });
        doc.moveDown(0.4);
      }
    };

    if (elements && elements.length > 0) {
      for (const el of elements) {
        if (el.type === 'paragraph') renderParagraph(el.paragraph);
        else if (el.type === 'table') renderTable(el.table);
        else if (el.type === 'drawing') {
          if (el.chart) {
            renderPdfChart(doc, el.chart, hasUnicodeFont);
          } else if (el.shapes && el.shapes.length > 0) {
            renderPdfDrawingShapes(doc, el.shapes, hasUnicodeFont);
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
/**
 * Formats a raw spreadsheet cell value according to Excel NumberFormat specification
 */
export function formatSpreadsheetCellValue(
  rawVal: string,
  numFmtId?: number,
  customFormat?: string
): string {
  if (!rawVal || isNaN(Number(rawVal))) return rawVal;
  const num = Number(rawVal);

  // Currency formats (numFmtId 44 or custom formats with currency symbols)
  if (
    numFmtId === 44 ||
    (customFormat &&
      (customFormat.includes('$') ||
        customFormat.includes('₩') ||
        customFormat.includes('€') ||
        customFormat.includes('£')))
  ) {
    return num.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  }

  // Percentage formats (numFmtId 9, 10 or contains '%')
  if (numFmtId === 9 || numFmtId === 10 || (customFormat && customFormat.includes('%'))) {
    const decimals = numFmtId === 10 || (customFormat && customFormat.includes('.0')) ? 2 : 0;
    return (num * 100).toFixed(decimals) + '%';
  }

  // Number with thousand separator (numFmtId 3, 4, 37, 38 or contains '#,##0')
  if (
    numFmtId === 3 ||
    numFmtId === 4 ||
    numFmtId === 37 ||
    numFmtId === 38 ||
    (customFormat && customFormat.includes('#,##0'))
  ) {
    const decimals =
      numFmtId === 4 || numFmtId === 38 || (customFormat && customFormat.includes('.00')) ? 2 : 0;
    return num.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }

  // Excel serial date formatting (numFmtId 14..22 or contains date tokens)
  if (
    (numFmtId !== undefined && numFmtId >= 14 && numFmtId <= 22) ||
    (customFormat &&
      (customFormat.toLowerCase().includes('yy') ||
        customFormat.toLowerCase().includes('mm') ||
        customFormat.toLowerCase().includes('dd')))
  ) {
    // Excel date epoch: Jan 1 1900 (with Lotus 1-2-3 leap day bug at day 60)
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    const date = new Date(excelEpoch.getTime() + num * 86400000);
    if (!isNaN(date.getTime())) {
      return date.toISOString().split('T')[0];
    }
  }

  return rawVal;
}

export interface OfficeWorksheetCell {
  value: string;
  formattedValue?: string;
  type?: string;
  isHeader?: boolean;
  bold?: boolean;
  italic?: boolean;
  fontSize?: number;
  fontColor?: string;
  fillColor?: string;
  borderColor?: string;
  align?: 'left' | 'center' | 'right';
}

export interface OfficeWorksheetPrintArea {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

export interface OfficeWorksheet {
  name: string;
  rows: string[][];
  structuredRows?: OfficeWorksheetCell[][];
  columnWidths?: number[];
  printArea?: OfficeWorksheetPrintArea;
}

/**
 * Parses an Excel A1 reference or range string into 0-based boundary coordinates.
 * Supports: 'Sheet1!$B$2:$C$3', ''Sheet 1'!$B$2:$C$3', '$B$2:$C$3', 'B2:C3', '$B$2'.
 */
export function parseA1Range(rangeStr: string): {
  sheetName?: string;
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
} | null {
  if (!rangeStr || typeof rangeStr !== 'string') return null;
  const trimmed = rangeStr.trim();
  if (trimmed === '') return null;

  let sheetName: string | undefined;
  let cellRange = trimmed;

  const bangIdx = trimmed.indexOf('!');
  if (bangIdx !== -1) {
    let rawSheet = trimmed.slice(0, bangIdx).trim();
    if ((rawSheet.startsWith("'") && rawSheet.endsWith("'")) || (rawSheet.startsWith('"') && rawSheet.endsWith('"'))) {
      rawSheet = rawSheet.slice(1, -1);
    }
    sheetName = rawSheet;
    cellRange = trimmed.slice(bangIdx + 1).trim();
  }

  // Range may have multiple comma-separated areas; take the first area
  const firstArea = cellRange.split(',')[0].trim();
  const parts = firstArea.split(':');

  const parseCellCoord = (cell: string): { col: number; row: number } | null => {
    const clean = cell.replace(/\$/g, '').trim().toUpperCase();
    const match = clean.match(/^([A-Z]+)(\d+)$/);
    if (!match) return null;
    return {
      col: getExcelColumnIndex(match[1]),
      row: parseInt(match[2], 10) - 1,
    };
  };

  const startCoord = parseCellCoord(parts[0]);
  if (!startCoord) return null;

  const endCoord = parts.length > 1 ? parseCellCoord(parts[1]) : startCoord;
  if (!endCoord) return null;

  return {
    sheetName,
    startRow: Math.min(startCoord.row, endCoord.row),
    endRow: Math.max(startCoord.row, endCoord.row),
    startCol: Math.min(startCoord.col, endCoord.col),
    endCol: Math.max(startCoord.col, endCoord.col),
  };
}

/**
 * Slices worksheet rows and columns down to specified print area rectangular bounds.
 */
export function sliceWorksheetToRange(
  sheet: OfficeWorksheet,
  range: OfficeWorksheetPrintArea
): OfficeWorksheet {
  const { startRow, endRow, startCol, endCol } = range;
  const slicedRows: string[][] = [];
  const slicedStructuredRows: OfficeWorksheetCell[][] = [];

  for (let r = startRow; r <= endRow; r++) {
    const origRow = sheet.rows[r] || [];
    const newRow: string[] = [];
    for (let c = startCol; c <= endCol; c++) {
      newRow.push(origRow[c] ?? '');
    }
    slicedRows.push(newRow);

    if (sheet.structuredRows) {
      const origStructRow = sheet.structuredRows[r] || [];
      const newStructRow: OfficeWorksheetCell[] = [];
      for (let c = startCol; c <= endCol; c++) {
        newStructRow.push(origStructRow[c] ?? { value: '' });
      }
      slicedStructuredRows.push(newStructRow);
    }
  }

  let slicedWidths: number[] | undefined;
  if (sheet.columnWidths) {
    slicedWidths = sheet.columnWidths.slice(startCol, endCol + 1);
  }

  return {
    name: sheet.name,
    rows: slicedRows,
    structuredRows: sheet.structuredRows ? slicedStructuredRows : undefined,
    columnWidths: slicedWidths,
    printArea: sheet.printArea,
  };
}

/**
 * Sanitizes worksheet name for safe filesystem and archive entry usage.
 */
export function sanitizeSheetName(name: string): string {
  const sanitized = name.replace(/[/\\:*?"<>|\x00-\x1f]/g, '_').trim();
  return sanitized.length > 0 ? sanitized : 'sheet';
}

/**
 * Formats a CSV cell conforming to RFC 4180 Section 2.6 (quotes cells with delimiter, quotes, CR, or LF).
 */
export function formatCsvCell(cell: string, delimiter: string): string {
  if (cell.includes(delimiter) || cell.includes('"') || cell.includes('\n') || cell.includes('\r')) {
    return `"${cell.replace(/"/g, '""')}"`;
  }
  return cell;
}


/**
 * Parses all worksheets from an XLSX JSZip instance, discovering sheets from workbook.xml
 * and workbook.xml.rels, resolving shared strings, NumberFormats, and formulas.
 */
export async function parseAllXlsxWorksheets(zipOrBuffer: JSZip | Buffer | Uint8Array): Promise<OfficeWorksheet[]> {
  const zip = (zipOrBuffer && typeof (zipOrBuffer as JSZip).file === 'function')
    ? (zipOrBuffer as JSZip)
    : await JSZip.loadAsync(zipOrBuffer as Buffer | Uint8Array);

  // 1. Parse shared strings
  const sharedStrings: string[] = [];
  const sstFile = zip.file('xl/sharedStrings.xml');
  if (sstFile) {
    const sstXml = await sstFile.async('text');
    const siElements = safeExtractXmlElements(sstXml, 'si');
    if (siElements.length > 0) {
      for (const si of siElements) {
        sharedStrings.push(safeExtractAllText(si.content, 't'));
      }
    } else {
      const tElements = safeExtractXmlElements(sstXml, 't');
      for (const t of tElements) {
        sharedStrings.push(safeDecodeXmlEntities(t.content));
      }
    }
  }

  // 2. Parse NumberFormats, Fonts, Fills, Borders, and Cell Styles from xl/styles.xml
  const styleNumFmtMap = new Map<number, number>();
  const customNumFmtMap = new Map<number, string>();

  interface ParsedCellStyle {
    numFmtId?: number;
    font?: { bold?: boolean; italic?: boolean; size?: number; color?: string };
    fillColor?: string;
    hasBorder?: boolean;
    align?: 'left' | 'center' | 'right';
  }
  const cellStylesMap = new Map<number, ParsedCellStyle>();

  const stylesFile = zip.file('xl/styles.xml');
  if (stylesFile) {
    const stylesXml = await stylesFile.async('text');

    // Parse custom <numFmt numFmtId="..." formatCode="..."/>
    const numFmtRegex = /<numFmt\s+[^>]*?numFmtId="(\d+)"[^>]*?formatCode="([^"]*)"/gi;
    let nfMatch: RegExpExecArray | null;
    while ((nfMatch = numFmtRegex.exec(stylesXml)) !== null) {
      customNumFmtMap.set(parseInt(nfMatch[1], 10), nfMatch[2]);
    }

    // Parse fonts: <fonts><font>...<b/>...<sz val="11"/>...<color rgb="FF0000"/></font></fonts>
    const parsedFonts: Array<{ bold?: boolean; italic?: boolean; size?: number; color?: string }> = [];
    const fontsEl = safeExtractFirstXmlElement(stylesXml, 'fonts');
    if (fontsEl) {
      const fontEls = safeExtractXmlElements(fontsEl.content, 'font');
      for (const fontEl of fontEls) {
        const fBody = fontEl.content;
        const isBold = /<b\b/i.test(fBody);
        const isItalic = /<i\b/i.test(fBody);
        const szEl = safeExtractFirstXmlElement(fBody, 'sz');
        const sz = szEl && szEl.attrs.val ? parseFloat(szEl.attrs.val) : undefined;
        const clrEl = safeExtractFirstXmlElement(fBody, 'color');
        let color: string | undefined;
        if (clrEl && clrEl.attrs.rgb) {
          const rawClr = clrEl.attrs.rgb;
          color = '#' + (rawClr.length === 8 ? rawClr.slice(2) : rawClr);
        }
        parsedFonts.push({ bold: isBold, italic: isItalic, size: sz, color });
      }
    }

    // Parse fills: <fills><fill><patternFill ...><fgColor rgb="FFF0F2FE"/></patternFill></fill></fills>
    const parsedFills: Array<{ fillColor?: string }> = [];
    const fillsEl = safeExtractFirstXmlElement(stylesXml, 'fills');
    if (fillsEl) {
      const fillEls = safeExtractXmlElements(fillsEl.content, 'fill');
      for (const fillEl of fillEls) {
        const fgEl = safeExtractFirstXmlElement(fillEl.content, 'fgColor');
        let fillColor: string | undefined;
        if (fgEl && fgEl.attrs.rgb) {
          const rawClr = fgEl.attrs.rgb;
          fillColor = '#' + (rawClr.length === 8 ? rawClr.slice(2) : rawClr);
        }
        parsedFills.push({ fillColor });
      }
    }

    // Parse borders: <borders><border><left style="thin">...
    const parsedBorders: Array<{ hasBorder?: boolean }> = [];
    const bordersEl = safeExtractFirstXmlElement(stylesXml, 'borders');
    if (bordersEl) {
      const borderEls = safeExtractXmlElements(bordersEl.content, 'border');
      for (const borderEl of borderEls) {
        const bBody = borderEl.content;
        const hasBorder = /<(left|right|top|bottom)\s+style="(?!none)[^"]+"/i.test(bBody);
        parsedBorders.push({ hasBorder });
      }
    }

    // Parse <cellXfs><xf numFmtId="..." .../>
    const cellXfsEl = safeExtractFirstXmlElement(stylesXml, 'cellXfs');
    if (cellXfsEl) {
      const xfEls = safeExtractXmlElements(cellXfsEl.content, 'xf');
      let xfIdx = 0;
      for (const xfEl of xfEls) {
        const xfAttrs = xfEl.attrs;
        const xfBody = xfEl.content || '';

        const nfId = xfAttrs.numFmtId;
        const fontId = xfAttrs.fontId;
        const fillId = xfAttrs.fillId;
        const borderId = xfAttrs.borderId;

        const alignEl = safeExtractFirstXmlElement(xfBody || xfEl.raw, 'alignment');
        let align: 'left' | 'center' | 'right' | undefined;
        if (alignEl && alignEl.attrs.horizontal) {
          const hAlign = alignEl.attrs.horizontal.toLowerCase();
          if (hAlign === 'left' || hAlign === 'center' || hAlign === 'right') {
            align = hAlign;
          }
        }

        const numFmtVal = nfId ? parseInt(nfId, 10) : undefined;
        if (numFmtVal !== undefined) {
          styleNumFmtMap.set(xfIdx, numFmtVal);
        }

        const font = fontId ? parsedFonts[parseInt(fontId, 10)] : undefined;
        const fill = fillId ? parsedFills[parseInt(fillId, 10)] : undefined;
        const border = borderId ? parsedBorders[parseInt(borderId, 10)] : undefined;

        cellStylesMap.set(xfIdx, {
          numFmtId: numFmtVal,
          font,
          fillColor: fill?.fillColor,
          hasBorder: border?.hasBorder,
          align,
        });

        xfIdx++;
      }
    }
  }

  // 3. Discover all worksheets from workbook.xml and workbook.xml.rels
  const sheetEntries: Array<{ name: string; path: string }> = [];
  const printAreaBySheetIndex = new Map<number, OfficeWorksheetPrintArea>();
  const printAreaBySheetName = new Map<string, OfficeWorksheetPrintArea>();

  const wbFile = zip.file('xl/workbook.xml');
  const wbRelsFile = zip.file('xl/_rels/workbook.xml.rels');

  if (wbFile) {
    const wbXml = await wbFile.async('text');
    const relsMap = new Map<string, string>();

    if (wbRelsFile) {
      const wbRelsXml = await wbRelsFile.async('text');
      for (const rEl of safeExtractXmlElements(wbRelsXml, 'Relationship')) {
        if (rEl.attrs.Id && rEl.attrs.Target) {
          relsMap.set(rEl.attrs.Id, rEl.attrs.Target);
        }
      }
    }

    for (const sEl of safeExtractXmlElements(wbXml, 'sheet')) {
      const sheetName = sEl.attrs.name;
      const rId = sEl.attrs['r:id'];
      if (sheetName) {
        let relTarget = (rId ? relsMap.get(rId) : undefined) || `worksheets/sheet${sheetEntries.length + 1}.xml`;
        // Normalize target path
        if (!relTarget.startsWith('xl/')) {
          relTarget = relTarget.startsWith('/') ? relTarget.slice(1) : `xl/${relTarget}`;
        }
        sheetEntries.push({ name: sheetName, path: relTarget });
      }
    }

    // Parse <definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">Sheet1!$B$2:$C$3</definedName></definedNames>
    for (const dnEl of safeExtractXmlElements(wbXml, 'definedName')) {
      if (dnEl.attrs.name === '_xlnm.Print_Area') {
        const parsed = parseA1Range(dnEl.content);
        if (parsed) {
          const area: OfficeWorksheetPrintArea = {
            startRow: parsed.startRow,
            endRow: parsed.endRow,
            startCol: parsed.startCol,
            endCol: parsed.endCol,
          };
          if (dnEl.attrs.localSheetId !== undefined) {
            const sid = parseInt(dnEl.attrs.localSheetId, 10);
            if (!isNaN(sid)) {
              printAreaBySheetIndex.set(sid, area);
            }
          }
          if (parsed.sheetName) {
            printAreaBySheetName.set(parsed.sheetName.toLowerCase(), area);
          }
        }
      }
    }
  }

  // Fallback: search zip directly for worksheets
  if (sheetEntries.length === 0) {
    const wsFiles = Object.keys(zip.files)
      .filter((fn) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(fn))
      .sort((a, b) => {
        const numA = parseInt(a.replace(/\D/g, ''), 10) || 0;
        const numB = parseInt(b.replace(/\D/g, ''), 10) || 0;
        return numA - numB;
      });

    for (let idx = 0; idx < wsFiles.length; idx++) {
      sheetEntries.push({ name: `Sheet${idx + 1}`, path: wsFiles[idx] });
    }
  }

  if (sheetEntries.length === 0) {
    throw new Error('Invalid XLSX workbook: no worksheets found in archive.');
  }

  // 4. Parse all discovered worksheets
  const allSheets: OfficeWorksheet[] = [];

  for (let entryIdx = 0; entryIdx < sheetEntries.length; entryIdx++) {
    const entry = sheetEntries[entryIdx];
    const printArea = printAreaBySheetIndex.get(entryIdx) || printAreaBySheetName.get(entry.name.toLowerCase());
    const sFile = zip.file(entry.path);
    if (!sFile) continue;

    const sheetXml = await sFile.async('text');
    const rows: string[][] = [];
    const structuredRows: OfficeWorksheetCell[][] = [];
    const cellMap: Record<string, any> = {};
    const formulaCells: Array<{ ref: string; formula: string; rowIdx: number; colIdx: number }> = [];

    // Parse column widths from <cols><col min="1" max="1" width="15" customWidth="1"/></cols>
    const columnWidths: number[] = [];
    const colsEl = safeExtractFirstXmlElement(sheetXml, 'cols');
    if (colsEl) {
      const colEls = safeExtractXmlElements(colsEl.content, 'col');
      for (const cl of colEls) {
        if (cl.attrs.min && cl.attrs.max && cl.attrs.width) {
          const min = parseInt(cl.attrs.min, 10) - 1;
          const max = parseInt(cl.attrs.max, 10) - 1;
          const width = parseFloat(cl.attrs.width);
          const ptWidth = Math.round(width * 7.5);
          for (let c = min; c <= max; c++) {
            columnWidths[c] = ptWidth;
          }
        }
      }
    }

    const rowEls = safeExtractXmlElements(sheetXml, 'row');

    for (const rowEl of rowEls) {
      const rowAttrs = rowEl.attrs;
      if (rowAttrs.r) {
        const targetRowIdx = parseInt(rowAttrs.r, 10) - 1;
        while (rows.length < targetRowIdx) {
          rows.push([]);
          structuredRows.push([]);
        }
      }
      const cells: string[] = [];
      const structuredCells: OfficeWorksheetCell[] = [];
      const cellEls = safeExtractXmlElements(rowEl.content, 'c');
      const rowIdx = rows.length;
      let nextColIdx = 0;

      for (const cellEl of cellEls) {
        const attrs = cellEl.attrs;
        const body = cellEl.content;
        const isString = attrs.t === 's';
        const isInline = attrs.t === 'inlineStr';
        const isBool = attrs.t === 'b';
        const vContent = safeExtractTagContent(body, 'v');
        const tContent = safeExtractTagContent(body, 't');
        const fContent = safeExtractTagContent(body, 'f');
        const ref = (attrs.r || '').toUpperCase();
        const rRefMatch = ref.match(/^([A-Za-z]+)(\d+)/);

        // Extract style index for NumberFormat
        const styleIdx = attrs.s !== undefined ? parseInt(attrs.s, 10) : undefined;
        const numFmtId = styleIdx !== undefined ? styleNumFmtMap.get(styleIdx) : undefined;
        const customFmt = numFmtId !== undefined ? customNumFmtMap.get(numFmtId) : undefined;

        let colIdx = nextColIdx;
        if (rRefMatch && rRefMatch[1]) {
          colIdx = getExcelColumnIndex(rRefMatch[1]);
        }

        while (cells.length < colIdx) {
          cells.push('');
          structuredCells.push({ value: '' });
        }

        let cellValue = '';
        if (isInline) {
          const isEl = safeExtractFirstXmlElement(body, 'is');
          if (isEl) {
            cellValue = safeExtractAllText(isEl.content, 't') || safeExtractAllText(isEl.content);
          } else if (tContent !== null) {
            cellValue = safeDecodeXmlEntities(tContent);
          }
        } else if (isBool && vContent !== null) {
          cellValue = vContent === '1' ? 'TRUE' : 'FALSE';
        } else if (vContent !== null) {
          if (isString) {
            const strIdx = Number.parseInt(vContent, 10);
            cellValue = sharedStrings[strIdx] ?? '';
          } else {
            // Apply NumberFormat formatting
            cellValue = formatSpreadsheetCellValue(vContent, numFmtId, customFmt);
          }
        } else if (tContent !== null) {
          cellValue = safeDecodeXmlEntities(tContent);
        }

        if (ref) {
          cellMap[ref] = cellValue;
        }

        if (fContent !== null && (!cellValue || cellValue.trim() === '')) {
          formulaCells.push({ ref, formula: fContent, rowIdx, colIdx });
        }

        cells[colIdx] = cellValue;

        const style = styleIdx !== undefined ? cellStylesMap.get(styleIdx) : undefined;
        const isNum = !isNaN(Number(cellValue)) && cellValue.trim() !== '';
        const cellAlign = style?.align || (isNum ? 'right' : 'left');

        structuredCells[colIdx] = {
          value: cellValue,
          bold: style?.font?.bold,
          italic: style?.font?.italic,
          fontSize: style?.font?.size,
          fontColor: style?.font?.color,
          fillColor: style?.fillColor,
          borderColor: style?.hasBorder ? '#CBD5E1' : undefined,
          align: cellAlign,
        };

        nextColIdx = colIdx + 1;
      }
      rows.push(cells);
      structuredRows.push(structuredCells);
    }

    // Evaluate dynamic formulas with DAG dependency sorter & cycle detection
    if (formulaCells.length > 0) {
      const dagEngine = new SpreadsheetDagEngine(cellMap);
      dagEngine.evaluateWithDag(formulaCells, rows);
      for (const fc of formulaCells) {
        if (structuredRows[fc.rowIdx] && structuredRows[fc.rowIdx][fc.colIdx]) {
          structuredRows[fc.rowIdx][fc.colIdx].value = rows[fc.rowIdx][fc.colIdx] || '';
        }
      }
    }

    allSheets.push({
      name: entry.name,
      rows,
      structuredRows,
      columnWidths: columnWidths.length > 0 ? columnWidths : undefined,
      printArea,
    });
  }

  return allSheets;
}

/** Columns above which a worksheet is drawn on a landscape page. */
const WORKSHEET_LANDSCAPE_COLUMNS = 6;

/**
 * Draws worksheets as tables: the workbook title goes into the PDF metadata, each sheet name becomes an
 * outline entry, and every row and column is drawn (see renderPdfTables).
 */
async function generatePdfFromWorksheets(
  sheets: OfficeWorksheet[],
  options: ConversionOptions,
  title: string
): Promise<Buffer> {
  assertNoComplexScript(title, 'Pure-TS Spreadsheet to PDF');
  for (const s of sheets) {
    assertNoComplexScript(s.name, 'Pure-TS Spreadsheet to PDF');
    for (const r of s.rows) {
      for (const cell of r) {
        assertNoComplexScript(cell, 'Pure-TS Spreadsheet to PDF');
      }
    }
  }

  const widestRow = sheets.reduce((widest, sheet) => Math.max(widest, ...sheet.rows.map((row) => row.length)), 1);
  const isLandscape = options.orientation === 'landscape' || widestRow > WORKSHEET_LANDSCAPE_COLUMNS;
  return renderPdfTables(
    sheets.map((sheet) => ({
      name: sheet.name,
      headerRows: 1,
      widthHints: sheet.columnWidths,
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
    { title, orientation: isLandscape ? 'landscape' : 'portrait', customFontPath: (options as { fontPath?: string }).fontPath }
  );
}

/**
 * XLSX Source Parser & Converter supporting Multi-sheet workbooks and NumberFormat engine
 */
async function convertXlsxSource(
  inputBuffer: Buffer,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  const zip = await JSZip.loadAsync(inputBuffer);
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
            tableHtml += `  <th style="background:#F0F2FE;color:#1F2340;padding:8px;text-align:left;">${escapeHtml(
              c
            )}</th>\n`;
          } else {
            tableHtml += `  <td style="padding:8px;border:1px solid #E1E4EE;">${escapeHtml(c)}</td>\n`;
          }
        });
        tableHtml += '</tr>\n';
      });
      tableHtml += '</table>';
      const bodyHtml = `<h3>${escapeHtml(selectedSheet.name)}</h3>${tableHtml}`;
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeXml(
        baseName
      )}</title><style>body{font-family:system-ui,sans-serif;padding:2rem;color:#1F2340;}</style></head><body><h2>${escapeXml(
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
      tsvContent = primaryRows.map((r) => r.join('\t')).join(lineEnding);
    } else {
      tsvContent = allSheets
        .map((s) => `### Sheet: ${s.name}\n` + s.rows.map((r) => r.join('\t')).join(lineEnding))
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
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<workbook name="${escapeXml(baseName)}">\n`;
    allSheets.forEach((s) => {
      xml += `  <worksheet name="${escapeXml(s.name)}">\n    <rows>\n`;
      if (s.rows.length > 0) {
        const headers = s.rows[0].map((h, i) =>
          h ? h.replace(/[^a-zA-Z0-9_]/g, '_') : `column_${i + 1}`
        );
        s.rows.slice(1).forEach((row, rIdx) => {
          xml += `      <row id="${rIdx + 1}">\n`;
          row.forEach((cell, cIdx) => {
            const colName = headers[cIdx] || `col_${cIdx + 1}`;
            xml += `        <${colName}>${escapeXml(cell)}</${colName}>\n`;
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
            tableHtml += `  <th style="background:#F0F2FE;color:#1F2340;padding:8px;text-align:left;">${escapeHtml(
              c
            )}</th>\n`;
          } else {
            tableHtml += `  <td style="padding:8px;border:1px solid #E1E4EE;">${escapeHtml(c)}</td>\n`;
          }
        });
        tableHtml += '</tr>\n';
      });
      tableHtml += '</table>';
      bodyHtml += `<h3>${escapeHtml(s.name)}</h3>${tableHtml}`;
    });

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeXml(
      baseName
    )}</title><style>body{font-family:system-ui,sans-serif;padding:2rem;color:#1F2340;}</style></head><body><h2>${escapeXml(
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

  // XLSX -> XLS
  if (tgt === 'xls') {
    const xlsContent = generateXlsXmlFromData(primaryRows, baseName);
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
export interface VisualSlideShape {
  x: number;
  y: number;
  width: number;
  height: number;
  shapeType?: 'rect' | 'roundRect' | 'ellipse' | 'triangle' | 'diamond' | 'star5' | 'line' | 'picture' | 'table' | 'chart' | string;
  geometryPath?: string;
  fillColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  text?: string;
  fontSize?: number;
  fontColor?: string;
  bold?: boolean;
  imageData?: Buffer;
  imageMimeType?: string;
  chartData?: OpenXmlChartData;
  chartSvg?: string;
  tableData?: {
    rows: Array<Array<{ text: string; fillColor?: string; fontColor?: string; bold?: boolean }>>;
    colWidths?: number[];
  };
  rotation?: number;
  flipH?: boolean;
  flipV?: boolean;
  transformMatrix?: Matrix2D;
}

export interface VisualSlide {
  number: number;
  texts: string[];
  shapes: VisualSlideShape[];
  width: number;
  height: number;
  backgroundColor?: string;
}

function resolveZipPath(baseDir: string, relativePath: string): string {
  if (relativePath.startsWith('/')) {
    return relativePath.slice(1);
  }
  const parts = `${baseDir}/${relativePath}`.split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  return resolved.join('/');
}

/**
 * Recursively parses DrawingML 2D scene graph for a PPTX slide, accumulating
 * affine transform matrices (M_world = M_parent * M_local) for nested <p:grpSp>,
 * resolving <dgm:relIds> SmartArt diagrams, pictures (<p:pic>), tables, charts, and shapes.
 */
export async function parsePptxSlideSceneGraph(
  xml: string,
  parentMatrix: Matrix2D,
  slideWidth: number,
  slideHeight: number,
  relsMap: Map<string, string>,
  zip: JSZip,
  texts: string[]
): Promise<VisualSlideShape[]> {
  const shapes: VisualSlideShape[] = [];

  const groupElements = safeExtractXmlElements(xml, 'p:grpSp');
  const gfElements = safeExtractXmlElements(xml, 'p:graphicFrame');
  const picElements = safeExtractXmlElements(xml, 'p:pic');
  const spElements = safeExtractXmlElements(xml, 'p:sp');

  // Compute boundaries of group shapes so child shapes are processed in group recursion
  const grpRanges: Array<[number, number]> = [];
  for (const grpEl of groupElements) {
    grpRanges.push([grpEl.startIndex, grpEl.endIndex]);
  }

  // 1. Group shapes (<p:grpSp>) - recursive scene graph traversal
  for (const grpEl of groupElements) {
    // Only process immediate top-level groups at this container depth
    const isChildGroup = grpRanges.some(
      ([s, e]) => grpEl.startIndex > s && grpEl.endIndex < e
    );
    if (isChildGroup) continue;

    const grpXml = grpEl.content;
    const { matrix: mGrp } = parseGroupTransform(grpXml, slideWidth, slideHeight);
    const mAccum = multiplyMatrix(parentMatrix, mGrp);

    const childShapes = await parsePptxSlideSceneGraph(
      grpXml,
      mAccum,
      slideWidth,
      slideHeight,
      relsMap,
      zip,
      texts
    );
    shapes.push(...childShapes);
  }

  // 2. Graphic frames (<p:graphicFrame>) - tables, charts, SmartArt (<dgm:relIds>)
  for (const gfEl of gfElements) {
    const isInsideGroup = grpRanges.some(
      ([s, e]) => gfEl.startIndex >= s && gfEl.endIndex <= e
    );
    if (isInsideGroup) continue;

    const gfXml = gfEl.content;
    const offEl = safeExtractFirstXmlElement(gfXml, 'a:off');
    const extEl = safeExtractFirstXmlElement(gfXml, 'a:ext');
    if (offEl?.attrs.x && offEl?.attrs.y && extEl?.attrs.cx && extEl?.attrs.cy) {
      const rawX = Math.round(parseInt(offEl.attrs.x, 10) / 12700);
      const rawY = Math.round(parseInt(offEl.attrs.y, 10) / 12700);
      const rawW = Math.round(parseInt(extEl.attrs.cx, 10) / 12700);
      const rawH = Math.round(parseInt(extEl.attrs.cy, 10) / 12700);

      const pt = transformPoint(parentMatrix, rawX, rawY);
      const x = Math.round(pt.x);
      const y = Math.round(pt.y);
      const w = Math.round(Math.sqrt(parentMatrix[0] * parentMatrix[0] + parentMatrix[1] * parentMatrix[1]) * rawW);
      const h = Math.round(Math.sqrt(parentMatrix[2] * parentMatrix[2] + parentMatrix[3] * parentMatrix[3]) * rawH);

      const tblEl = safeExtractFirstXmlElement(gfXml, 'a:tbl');
      if (tblEl) {
        const tblXml = tblEl.content;
        const colWidths: number[] = [];
        for (const gcEl of safeExtractXmlElements(tblXml, 'a:gridCol')) {
          if (gcEl.attrs.w) {
            colWidths.push(Math.round(parseInt(gcEl.attrs.w, 10) / 12700));
          }
        }

        const tblRows: Array<Array<{ text: string; fillColor?: string; fontColor?: string; bold?: boolean }>> = [];
        for (const trEl of safeExtractXmlElements(tblXml, 'a:tr')) {
          const trXml = trEl.content;
          const rowCells: Array<{ text: string; fillColor?: string; fontColor?: string; bold?: boolean }> = [];
          for (const tcEl of safeExtractXmlElements(trXml, 'a:tc')) {
            const tcXml = tcEl.content;
            const cellTexts: string[] = [];
            for (const tEl of safeExtractXmlElements(tcXml, 'a:t')) {
              const clean = safeDecodeXmlEntities(tEl.content).trim();
              if (clean) cellTexts.push(clean);
            }
            const cellText = cellTexts.join(' ');
            if (cellText && !texts.includes(cellText)) {
              texts.push(cellText);
            }

            const tcPrEl = safeExtractFirstXmlElement(tcXml, 'a:tcPr');
            let cellFill: string | undefined;
            if (tcPrEl) {
              cellFill = safeFindColor(tcPrEl.content);
            }

            let cellBold = false;
            if (tcXml.includes('b="1"')) cellBold = true;
            const rPrEl = safeExtractFirstXmlElement(tcXml, 'a:rPr');
            let cellFontColor: string | undefined;
            if (rPrEl) {
              cellFontColor = safeFindColor(rPrEl.content);
              if (rPrEl.attrs.b === '1' || rPrEl.attrs.b === 'true') {
                cellBold = true;
              }
            }

            rowCells.push({
              text: cellText,
              fillColor: cellFill,
              fontColor: cellFontColor,
              bold: cellBold,
            });
          }
          tblRows.push(rowCells);
        }

        shapes.push({
          x,
          y,
          width: w,
          height: h,
          shapeType: 'table',
          tableData: {
            rows: tblRows,
            colWidths: colWidths.length > 0 ? colWidths : undefined,
          },
          transformMatrix: parentMatrix,
        });
      } else if (
        gfXml.includes('uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"') ||
        gfXml.includes('<dgm:relIds') ||
        gfXml.includes('dgm:relIds')
      ) {
        // SmartArt diagram processing
        const dgmRelEl = safeExtractFirstXmlElement(gfXml, 'dgm:relIds');
        const dmId = dgmRelEl ? (dgmRelEl.attrs['r:dm'] || dgmRelEl.attrs.dm) : undefined;
        let resolvedDiagram = false;

        if (dmId && relsMap.has(dmId)) {
          const target = relsMap.get(dmId)!;
          const dataPath = resolveZipPath('ppt/slides', target);
          const dataFile = zip.file(dataPath) || zip.file(`ppt/${target}`);
          if (dataFile) {
            const dataXml = await dataFile.async('text');
            const ptEls = safeExtractXmlElements(dataXml, 'dgm:pt');
            const nodeTexts: string[] = [];
            for (const pt of ptEls) {
              const ptType = pt.attrs.type || 'node';
              if (ptType === 'node' || ptType === 'asst') {
                const tEls = safeExtractXmlElements(pt.content, 'a:t');
                const t = tEls.map((el) => safeDecodeXmlEntities(el.content).trim()).filter(Boolean).join(' ');
                if (t) {
                  nodeTexts.push(t);
                  if (!texts.includes(t)) texts.push(t);
                }
              }
            }

            if (nodeTexts.length > 0) {
              resolvedDiagram = true;
              const N = nodeTexts.length;
              const isLandscape = w >= h;
              const isSquareGrid = N === 4 && w / h >= 0.7 && w / h <= 1.5;

              if (isSquareGrid) {
                // 2x2 Matrix / Quadrant SmartArt layout
                const gap = 12;
                const nodeW = Math.max(30, Math.floor((w - gap) / 2));
                const nodeH = Math.max(24, Math.floor((h - gap) / 2));
                for (let nIdx = 0; nIdx < 4; nIdx++) {
                  const col = nIdx % 2;
                  const row = Math.floor(nIdx / 2);
                  const nodeX = x + col * (nodeW + gap);
                  const nodeY = y + row * (nodeH + gap);
                  shapes.push({
                    x: nodeX,
                    y: nodeY,
                    width: nodeW,
                    height: nodeH,
                    shapeType: 'roundrect',
                    fillColor: nIdx % 2 === 0 ? '#3F51B5' : '#5C6BC0',
                    strokeColor: '#303F9F',
                    strokeWidth: 1.5,
                    text: nodeTexts[nIdx],
                    fontColor: '#FFFFFF',
                    bold: true,
                    transformMatrix: parentMatrix,
                  });
                }
              } else if (isLandscape) {
                const gap = 16;
                const nodeW = Math.max(30, Math.floor((w - (N - 1) * gap) / N));
                const nodeH = Math.max(24, Math.floor(h * 0.7));
                const nodeY = y + Math.floor((h - nodeH) / 2);

                for (let nIdx = 0; nIdx < N; nIdx++) {
                  const nodeX = x + nIdx * (nodeW + gap);
                  shapes.push({
                    x: nodeX,
                    y: nodeY,
                    width: nodeW,
                    height: nodeH,
                    shapeType: 'roundrect',
                    fillColor: '#5C6BC0',
                    strokeColor: '#3F51B5',
                    strokeWidth: 1.5,
                    text: nodeTexts[nIdx],
                    fontColor: '#FFFFFF',
                    bold: true,
                    transformMatrix: parentMatrix,
                  });

                  if (nIdx < N - 1) {
                    const arrowW = gap - 4;
                    const arrowX = nodeX + nodeW + 2;
                    const arrowY = nodeY + Math.floor(nodeH / 2) - 6;
                    shapes.push({
                      x: arrowX,
                      y: arrowY,
                      width: arrowW,
                      height: 12,
                      shapeType: 'rightarrow',
                      fillColor: '#9FA8DA',
                      strokeColor: '#7986CB',
                      strokeWidth: 1,
                      transformMatrix: parentMatrix,
                    });
                  }
                }
              } else {
                const gap = 12;
                const nodeH = Math.max(24, Math.floor((h - (N - 1) * gap) / N));
                const nodeW = Math.max(40, Math.floor(w * 0.85));
                const nodeX = x + Math.floor((w - nodeW) / 2);

                for (let nIdx = 0; nIdx < N; nIdx++) {
                  const nodeY = y + nIdx * (nodeH + gap);
                  shapes.push({
                    x: nodeX,
                    y: nodeY,
                    width: nodeW,
                    height: nodeH,
                    shapeType: 'roundrect',
                    fillColor: '#5C6BC0',
                    strokeColor: '#3F51B5',
                    strokeWidth: 1.5,
                    text: nodeTexts[nIdx],
                    fontColor: '#FFFFFF',
                    bold: true,
                    transformMatrix: parentMatrix,
                  });
                }
              }
            }
          }
        }

        if (!resolvedDiagram) {
          shapes.push({
            x,
            y,
            width: w,
            height: h,
            shapeType: 'roundrect',
            fillColor: '#F0F2FE',
            strokeColor: '#5C6BC0',
            strokeWidth: 1.5,
            text: 'SmartArt Diagram',
            fontColor: '#1F2340',
            bold: true,
            transformMatrix: parentMatrix,
          });
        }
      } else {
        // Check if graphicFrame contains or references an OpenXML chart
        const chartEl = safeExtractFirstXmlElement(gfXml, 'c:chart');
        const rId = chartEl ? (chartEl.attrs['r:id'] || chartEl.attrs.id) : undefined;
        let chartData: OpenXmlChartData | null = null;
        if (rId && relsMap.has(rId)) {
          const target = relsMap.get(rId)!;
          const chartPath = resolveZipPath('ppt/slides', target);
          const chartFile = zip.file(chartPath) || zip.file(`ppt/${target}`);
          if (chartFile) {
            const chartXml = await chartFile.async('text');
            chartData = parseOpenXmlChart(chartXml);
          }
        } else if (
          gfXml.includes('<c:chart') ||
          gfXml.includes('<c:plotArea') ||
          gfXml.includes('<c:chartSpace>')
        ) {
          chartData = parseOpenXmlChart(gfXml);
        }

        if (chartData) {
          const chartSvg = renderChartToSvg(chartData, w, h);
          shapes.push({
            x,
            y,
            width: w,
            height: h,
            shapeType: 'chart',
            chartData,
            chartSvg,
            text: chartData.title || `${chartData.type} chart`,
            transformMatrix: parentMatrix,
          });
        } else {
          const chartTexts: string[] = [];
          for (const tEl of safeExtractXmlElements(gfXml, 'a:t')) {
            const clean = safeDecodeXmlEntities(tEl.content).trim();
            if (clean) chartTexts.push(clean);
          }
          shapes.push({
            x,
            y,
            width: w,
            height: h,
            shapeType: 'rect',
            fillColor: '#F8F9FE',
            strokeColor: '#CCD2FC',
            strokeWidth: 1,
            text: chartTexts.join(' ') || undefined,
            transformMatrix: parentMatrix,
          });
        }
      }
    }
  }

  // 3. Pictures (<p:pic>)
  for (const picEl of picElements) {
    const isInsideGroup = grpRanges.some(
      ([s, e]) => picEl.startIndex >= s && picEl.endIndex <= e
    );
    if (isInsideGroup) continue;

    const picXml = picEl.content;
    const bounds = computeTransformedElementBounds(picXml, parentMatrix);
    if (!bounds) continue;
    const { x, y, w: worldW, h: worldH, rot: worldRot, flipH, flipV, matrix: worldMatrix } = bounds;

    const blipEl = safeExtractFirstXmlElement(picXml, 'a:blip');
    const rId = blipEl ? (blipEl.attrs['r:embed'] || blipEl.attrs.embed) : undefined;
    if (rId) {
      const target = relsMap.get(rId);
      if (target) {
        const mediaPath = resolveZipPath('ppt/slides', target);
        const mediaFile = zip.file(mediaPath);
        if (mediaFile) {
          let imgBuffer = await mediaFile.async('nodebuffer');
          // PNG and JPEG are embedded without a re-encode, whatever the part is called: check their header.
          // Pictures are processed one at a time on purpose: each decode can hold up to the pixel limit in memory.
          await assertEmbeddableImageWithinLimit(imgBuffer); // NOSONAR S9382: sequential to bound memory
          let mimeType = 'image/png';
          const lower = mediaPath.toLowerCase();
          if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
            mimeType = 'image/jpeg';
          } else if (!lower.endsWith('.png')) {
            try {
              imgBuffer = await openLimitedSharp(imgBuffer).png().toBuffer(); // NOSONAR S9382: sequential to bound memory
              mimeType = 'image/png';
            } catch (err) {
              rethrowInputPixelLimit(err);
            }
          }

          // DrawingML <a:srcRect> image cropping (ISO/IEC 29500-1 §20.1.8.56)
          const srcRectEl = safeExtractFirstXmlElement(picXml, 'a:srcRect');
          if (srcRectEl) {
            const l = parseInt(srcRectEl.attrs.l || '0', 10);
            const t = parseInt(srcRectEl.attrs.t || '0', 10);
            const r = parseInt(srcRectEl.attrs.r || '0', 10);
            const b = parseInt(srcRectEl.attrs.b || '0', 10);
            if (l > 0 || t > 0 || r > 0 || b > 0) {
              try {
                const meta = await sharp(imgBuffer).metadata();
                if (meta.width && meta.height) {
                  const cropLeft = Math.max(0, Math.min(meta.width - 1, Math.round((meta.width * l) / 100000)));
                  const cropTop = Math.max(0, Math.min(meta.height - 1, Math.round((meta.height * t) / 100000)));
                  const cropRight = Math.max(0, Math.min(meta.width - cropLeft - 1, Math.round((meta.width * r) / 100000)));
                  const cropBottom = Math.max(0, Math.min(meta.height - cropTop - 1, Math.round((meta.height * b) / 100000)));
                  const extractW = Math.max(1, meta.width - cropLeft - cropRight);
                  const extractH = Math.max(1, meta.height - cropTop - cropBottom);
                  imgBuffer = await openLimitedSharp(imgBuffer) // NOSONAR S9382: sequential to bound memory
                    .extract({ left: cropLeft, top: cropTop, width: extractW, height: extractH })
                    .toBuffer();
                }
              } catch (err) {
                rethrowInputPixelLimit(err);
              }
            }
          }
          shapes.push({
            x,
            y,
            width: worldW,
            height: worldH,
            shapeType: 'picture',
            imageData: imgBuffer,
            imageMimeType: mimeType,
            rotation: worldRot || undefined,
            flipH: flipH || undefined,
            flipV: flipV || undefined,
            transformMatrix: worldMatrix,
          });
        }
      }
    }
  }

  // 4. Standalone DrawingML shapes (<p:sp>)
  const standaloneSpElements = spElements.filter(
    (sp) => !grpRanges.some(([start, end]) => sp.startIndex >= start && sp.endIndex <= end)
  );

  for (const spEl of standaloneSpElements) {
    const spXml = spEl.content;
    const bounds = computeTransformedElementBounds(spXml, parentMatrix);
    if (!bounds) continue;
    const { x, y, w: worldW, h: worldH, rot: worldRot, flipH, flipV, matrix: worldMatrix } = bounds;

    let fillColor: string | undefined;
    const spPrEl = safeExtractFirstXmlElement(spXml, 'p:spPr');
    if (spPrEl) {
      fillColor = safeFindColor(spPrEl.content);
    }

    let strokeColor: string | undefined;
    let strokeWidth: number | undefined;
    const lnEl = safeExtractFirstXmlElement(spXml, 'a:ln');
    if (lnEl) {
      if (lnEl.attrs.w) {
        strokeWidth = Math.max(1, Math.round(Number.parseInt(lnEl.attrs.w, 10) / 12700));
      }
      strokeColor = safeFindColor(lnEl.content);
    }

    if (spPrEl && (spPrEl.content.includes('<a:sp3d') || spPrEl.content.includes('<a:bevelT') || spPrEl.content.includes('bevelT'))) {
      if (!strokeWidth) strokeWidth = 2;
      if (!strokeColor && fillColor) {
        strokeColor = '#1A237E';
      }
    }

      let shapeText = '';
      let fontSize: number | undefined;
      let fontColor: string | undefined;
      let bold = false;

      const txEl = safeExtractFirstXmlElement(spXml, 'p:txBody');
      if (txEl) {
        const txBody = txEl.content;
        const textMatches: string[] = [];
        const runElements = safeExtractXmlElements(txBody, 'a:r');

        for (const rEl of runElements) {
          const runXml = rEl.content;
          const tEl = safeExtractFirstXmlElement(runXml, 'a:t');
          if (tEl) {
            const clean = safeDecodeXmlEntities(tEl.content).trim();
            if (clean) textMatches.push(clean);
          }

          const rPrEl = safeExtractFirstXmlElement(runXml, 'a:rPr');
          if (rPrEl) {
            if (!fontSize && rPrEl.attrs.sz) {
              fontSize = Math.round(parseInt(rPrEl.attrs.sz, 10) / 100);
            }
            if (!fontColor) {
              fontColor = safeFindColor(rPrEl.content);
            }
            if (rPrEl.attrs.b === '1' || rPrEl.attrs.b === 'true') {
              bold = true;
            }
          }
        }

        if (textMatches.length > 0) {
          shapeText = textMatches.join(' ');
          for (const tm of textMatches) {
            if (!texts.includes(tm)) texts.push(tm);
          }
        }
      }

      let shapeType = 'rect';
      const prstEl = safeExtractFirstXmlElement(spXml, 'a:prstGeom');
      if (prstEl?.attrs.prst) {
        shapeType = prstEl.attrs.prst;
      }
      let geometryPath: string | undefined;
      const custGeomEl = safeExtractFirstXmlElement(spXml, 'a:custGeom');
      if (custGeomEl) {
        shapeType = 'custom';
        const pathEl = safeExtractFirstXmlElement(custGeomEl.content, 'a:path');
        if (pathEl) {
          geometryPath = pathEl.content;
        }
      }

      shapes.push({
        x,
        y,
        width: worldW,
        height: worldH,
        shapeType,
        geometryPath,
        fillColor,
        strokeColor,
        strokeWidth,
        text: shapeText || undefined,
        fontSize,
        fontColor,
        bold,
        rotation: worldRot || undefined,
        flipH: flipH || undefined,
        flipV: flipV || undefined,
        transformMatrix: worldMatrix,
      });
    }

  return shapes;
}

async function convertPptxSource(
  inputBuffer: Buffer,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  const zip = await JSZip.loadAsync(inputBuffer);

  // 1. Parse presentation slide size from ppt/presentation.xml (in EMUs, 12700 EMUs = 1 pt)
  let slideWidth = 960; // 16:9 standard width in points (12,192,000 EMUs)
  let slideHeight = 540; // 16:9 standard height in points (6,858,000 EMUs)

  const presFile = zip.file('ppt/presentation.xml');
  if (presFile) {
    const presXml = await presFile.async('text');
    const sldSzEl = safeExtractFirstXmlElement(presXml, 'p:sldSz');
    if (sldSzEl?.attrs.cx && sldSzEl?.attrs.cy) {
      const cx = parseInt(sldSzEl.attrs.cx, 10);
      const cy = parseInt(sldSzEl.attrs.cy, 10);
      if (cx > 0 && cy > 0) {
        slideWidth = Math.round(cx / 12700);
        slideHeight = Math.round(cy / 12700);
      }
    }
  }

  // 2. Discover slide XML files
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => {
      const numA = parseInt(a.replace(/\D/g, ''), 10) || 0;
      const numB = parseInt(b.replace(/\D/g, ''), 10) || 0;
      return numA - numB;
    });

  const slides: VisualSlide[] = [];

  for (let i = 0; i < slideFiles.length; i++) {
    const xml = await zip.files[slideFiles[i]].async('text');

    // Extract slide background color
    let backgroundColor: string | undefined;
    const bgEl = safeExtractFirstXmlElement(xml, 'p:bg');
    if (bgEl) {
      const bgClr = safeFindColor(bgEl.content);
      if (bgClr) backgroundColor = bgClr;
    }

    // Extract all text content
    const texts: string[] = [];
    for (const tEl of safeExtractXmlElements(xml, 'a:t')) {
      const clean = safeDecodeXmlEntities(tEl.content).trim();
      if (clean) texts.push(clean);
    }

    // Load relationships for media and parts
    const relsFileName = slideFiles[i].replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels';
    const relsFile = zip.file(relsFileName);
    const relsMap = new Map<string, string>();
    if (relsFile) {
      const relsXml = await relsFile.async('text');
      for (const rEl of safeExtractXmlElements(relsXml, 'Relationship')) {
        if (rEl.attrs.Id && rEl.attrs.Target) {
          relsMap.set(rEl.attrs.Id, rEl.attrs.Target);
        }
      }
    }

    const shapes = await parsePptxSlideSceneGraph(
      xml,
      identityMatrix(),
      slideWidth,
      slideHeight,
      relsMap,
      zip,
      texts
    );

    slides.push({
      number: i + 1,
      texts,
      shapes,
      width: slideWidth,
      height: slideHeight,
      backgroundColor,
    });
  }

  if (slides.length === 0) throw new ConversionFailedError('The PPTX file has no slides.');

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
  const zip = await openPackage(inputBuffer, 'ODP');
  const contentXmlFile = zip.file('content.xml');
  if (!contentXmlFile) throw new ConversionFailedError('The ODP file has no content.xml.');
  const xml = await contentXmlFile.async('text');
  let pageNum = 1;
  for (const pageEl of safeExtractXmlElements(xml, 'draw:page')) {
    const texts: string[] = [];
    for (const pEl of safeExtractXmlElements(pageEl.content, 'text:p')) {
      const t = safeExtractAllText(pEl.content).trim();
      if (t) texts.push(t);
    }
    slides.push({ number: pageNum++, texts });
  }
  if (slides.length === 0) throw new ConversionFailedError('The ODP file has no slides.');

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
 * PowerPoint 97-2003 binary source. The slide text comes from the presentation's records in slide order
 * ([MS-PPT]); malformed or encrypted files throw typed errors instead of producing text.
 */
async function convertPptSource(
  inputBuffer: Buffer,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  const slides = readPptSlides(inputBuffer);

  if (tgt === 'txt') {
    const text = slides
      .filter((slide) => slide.texts.length > 0)
      .map((slide) => slide.texts.join('\n'))
      .join('\n\n');
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
    const text = slides
      .filter((slide) => slide.texts.length > 0)
      .map((slide) => `# Slide ${slide.number}\n\n` + slide.texts.join('\n'))
      .join('\n\n---\n\n');
    const pptxBuffer = await generatePptxFromText(text, 'ppt', options, baseName);
    return {
      buffer: pptxBuffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      filename: `${baseName}.pptx`,
      size: pptxBuffer.length,
    };
  }

  throw new Error(`Unsupported conversion from PPT to ${tgt}`);
}

const POTX_TEMPLATE_MAIN_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml';
const PPTX_MAIN_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
const CONTENT_TYPES_PART = '[Content_Types].xml';

/**
 * PowerPoint template source: an OpenXML package with the slide parts of a presentation, so it is read as
 * one. A package that is not a ZIP, or has no presentation part, fails with a typed 400 error.
 */
async function convertPotxSource(
  inputBuffer: Buffer,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(inputBuffer);
  } catch {
    throw new ConversionFailedError('The POTX file is not a valid OpenXML package.');
  }
  if (!zip.file('ppt/presentation.xml')) {
    throw new ConversionFailedError('The POTX package has no ppt/presentation.xml part.');
  }
  if (tgt === 'pptx') {
    // The package becomes a presentation: its main part loses the template content type.
    const contentTypes = zip.file(CONTENT_TYPES_PART);
    if (!contentTypes) {
      throw new ConversionFailedError(`The POTX package has no ${CONTENT_TYPES_PART} part.`);
    }
    const xml = (await contentTypes.async('text')).replace(POTX_TEMPLATE_MAIN_CONTENT_TYPE, PPTX_MAIN_CONTENT_TYPE);
    zip.file(CONTENT_TYPES_PART, xml);
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    return {
      buffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      filename: `${baseName}.pptx`,
      size: buffer.length,
    };
  }
  return convertPptxSource(inputBuffer, tgt, options, baseName);
}

function generateHtmlFromSlides(
  slides: Array<{
    number: number;
    texts: string[];
    shapes?: VisualSlideShape[];
    width?: number;
    height?: number;
    backgroundColor?: string;
  }>,
  title: string
): string {
  let slidesHtml = '';
  slides.forEach((slide) => {
    const sWidth = slide.width || 960;
    const sHeight = slide.height || 540;
    const bg = slide.backgroundColor || '#FFFFFF';

    let visualSvg = '';
    if (slide.shapes && slide.shapes.length > 0) {
      let svgElements = '';
      slide.shapes.forEach((s) => {
        const type = s.shapeType || 'rect';
        const fill = s.fillColor || 'none';
        const stroke = s.strokeColor || 'none';
        const strokeW = s.strokeWidth || 1;

        if (type === 'chart' && s.chartSvg) {
          svgElements += `        <g transform="translate(${s.x}, ${s.y})">\n${s.chartSvg}\n        </g>\n`;
        } else if (type === 'picture' && s.imageData) {
          const mime = s.imageMimeType || 'image/png';
          const cx = s.x + s.width / 2;
          const cy = s.y + s.height / 2;
          const transforms: string[] = [];
          if (s.rotation) transforms.push(`rotate(${s.rotation} ${cx} ${cy})`);
          if (s.flipH || s.flipV) {
            const sx = s.flipH ? -1 : 1;
            const sy = s.flipV ? -1 : 1;
            transforms.push(`translate(${cx} ${cy}) scale(${sx} ${sy}) translate(${-cx} ${-cy})`);
          }
          const trAttr = transforms.length > 0 ? ` transform="${transforms.join(' ')}"` : '';
          svgElements += `        <image href="data:${mime};base64,${s.imageData.toString('base64')}" x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" preserveAspectRatio="none"${trAttr}/>\n`;
        } else if (type === 'table' && s.tableData) {
          const rowCount = Math.max(1, s.tableData.rows.length);
          const rowH = Math.max(18, Math.round(s.height / rowCount));
          const defaultColW = Math.round(s.width / Math.max(1, s.tableData.rows[0]?.length || 1));
          s.tableData.rows.forEach((r, rIdx) => {
            let curX = s.x;
            const curY = s.y + rIdx * rowH;
            r.forEach((c, cIdx) => {
              const colW = s.tableData?.colWidths?.[cIdx] || defaultColW;
              const fill = c.fillColor || (rIdx === 0 ? '#F0F2FE' : '#FFFFFF');
              svgElements += `        <rect x="${curX}" y="${curY}" width="${colW}" height="${rowH}" fill="${fill}" stroke="#CCD2FC" stroke-width="0.5"/>\n`;
              if (c.text) {
                svgElements += `        <text x="${curX + 4}" y="${curY + 12}" font-size="9" fill="${c.fontColor || '#1F2340'}" font-weight="${c.bold || rIdx === 0 ? 'bold' : 'normal'}" font-family="sans-serif">${escapeHtml(c.text)}</text>\n`;
              }
              curX += colW;
            });
          });
        } else {
          svgElements += `        ${renderSingleShapeSvg({
            geomType: s.shapeType === 'custom' ? 'custom' : 'preset',
            presetGeom: s.shapeType || 'rect',
            svgPath: s.geometryPath,
            x: s.x,
            y: s.y,
            width: s.width,
            height: s.height,
            fillColor: s.fillColor,
            strokeColor: s.strokeColor,
            strokeWidth: s.strokeWidth,
            text: s.text,
            rotation: s.rotation,
            flipH: s.flipH,
            flipV: s.flipV,
          })}\n`;
        }
      });

      visualSvg = `
      <div style="margin-bottom:16px;border:1px solid #E1E4EE;border-radius:8px;overflow:hidden;background:${bg};">
        <svg viewBox="0 0 ${sWidth} ${sHeight}" style="width:100%;height:auto;display:block;">
${svgElements}        </svg>
      </div>`;
    }

    slidesHtml += `
    <div style="border:1px solid #CCD2FC;border-radius:12px;padding:24px;margin-bottom:20px;background:#FAFAFE;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
      <div style="font-size:11px;font-weight:700;color:#5C6BC0;text-transform:uppercase;margin-bottom:8px;">Slide ${slide.number}</div>
      <h2 style="font-size:18px;color:#1F2340;margin-top:0;margin-bottom:16px;">${slide.texts[0] ? escapeHtml(slide.texts[0]) : `Slide ${slide.number}`}</h2>
      ${visualSvg}
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

/** Margin of the pages that hold slide text, in points. */
const SLIDE_TEXT_MARGIN = 40;

async function generatePdfFromSlides(
  slides: Array<{
    number: number;
    texts: string[];
    shapes?: VisualSlideShape[];
    width?: number;
    height?: number;
    backgroundColor?: string;
  }>,
  options: ConversionOptions,
  title: string
): Promise<Buffer> {
  assertNoComplexScript(title, 'Pure-TS Presentation to PDF');
  for (const s of slides) {
    for (const t of s.texts) {
      assertNoComplexScript(t, 'Pure-TS Presentation to PDF');
    }
  }

  return new Promise<Buffer>((resolve, reject) => {
    const firstSlide = slides[0];
    const width = firstSlide?.width || 960;
    const height = firstSlide?.height || 540;

    const doc = new PDFDocument({ size: [width, height], margin: SLIDE_TEXT_MARGIN, info: { Title: title } });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', (err) => reject(err));

    const { hasUnicodeFont } = configurePdfKitFontFallback(doc, (options as any).fontPath);

    slides.forEach((slide, idx) => {
      const sWidth = slide.width || width;
      const sHeight = slide.height || height;
      if (idx > 0) doc.addPage({ size: [sWidth, sHeight], margin: SLIDE_TEXT_MARGIN });

      // 1. Draw slide background
      if (slide.backgroundColor) {
        doc.rect(0, 0, sWidth, sHeight).fill(slide.backgroundColor);
      } else {
        doc.rect(0, 0, sWidth, sHeight).fill('#FAFAFC');
      }

      // 2. Draw visual shapes if present
      if (slide.shapes && slide.shapes.length > 0) {
        slide.shapes.forEach((shape) => {
          if (shape.width > 0 && shape.height > 0) {
            const type = shape.shapeType || 'rect';

            if (type === 'chart' && shape.chartData) {
              renderPdfChart(
                doc,
                shape.chartData,
                hasUnicodeFont,
                shape.x,
                shape.y,
                shape.width,
                shape.height
              );
            } else if (type === 'picture' && shape.imageData) {
              try {
                if (shape.rotation || shape.flipH || shape.flipV) {
                  doc.save();
                  const cx = shape.x + shape.width / 2;
                  const cy = shape.y + shape.height / 2;
                  doc.translate(cx, cy);
                  if (shape.rotation) doc.rotate(shape.rotation);
                  if (shape.flipH || shape.flipV) doc.scale(shape.flipH ? -1 : 1, shape.flipV ? -1 : 1);
                  doc.translate(-cx, -cy);
                  doc.image(shape.imageData, shape.x, shape.y, {
                    width: shape.width,
                    height: shape.height,
                  });
                  doc.restore();
                } else {
                  doc.image(shape.imageData, shape.x, shape.y, {
                    width: shape.width,
                    height: shape.height,
                  });
                }
              } catch {
                doc.rect(shape.x, shape.y, shape.width, shape.height).strokeColor('#CCD2FC').lineWidth(1).stroke();
              }
            } else if (type === 'table' && shape.tableData) {
              const tbl = shape.tableData;
              const rowCount = Math.max(1, tbl.rows.length);
              const rowHeight = Math.max(18, Math.round(shape.height / rowCount));
              const defaultColWidth = Math.round(shape.width / Math.max(1, tbl.rows[0]?.length || 1));

              tbl.rows.forEach((row, rIdx) => {
                const curY = shape.y + rIdx * rowHeight;
                let curX = shape.x;
                row.forEach((cell, cIdx) => {
                  const colW = tbl.colWidths?.[cIdx] || defaultColWidth;
                  const isHeader = rIdx === 0;
                  const fill = cell.fillColor || (isHeader ? '#F0F2FE' : '#FFFFFF');
                  doc.rect(curX, curY, colW, rowHeight).fill(fill);
                  doc.rect(curX, curY, colW, rowHeight).strokeColor('#CCD2FC').lineWidth(0.5).stroke();
                  if (cell.text) {
                    doc.fillColor(cell.fontColor || (isHeader ? '#1F2340' : '#4D536B'));
                    doc.fontSize(cell.bold || isHeader ? 9 : 8.5);
                    renderSafePdfText(
                      doc,
                      cell.text,
                      hasUnicodeFont,
                      { width: Math.max(10, colW - 8) },
                      curX + 4,
                      curY + 4
                    );
                  }
                  curX += colW;
                });
              });
            } else {
              renderSinglePdfShape(
                doc,
                {
                  geomType: shape.shapeType === 'custom' ? 'custom' : 'preset',
                  presetGeom: shape.shapeType || 'rect',
                  svgPath: shape.geometryPath,
                  x: shape.x,
                  y: shape.y,
                  width: shape.width,
                  height: shape.height,
                  fillColor: shape.fillColor,
                  strokeColor: shape.strokeColor,
                  strokeWidth: shape.strokeWidth,
                  text: shape.text,
                  fontSize: shape.fontSize,
                  fontColor: shape.fontColor,
                  rotation: shape.rotation,
                  flipH: shape.flipH,
                  flipV: shape.flipV,
                },
                hasUnicodeFont,
                shape.x,
                shape.y,
                shape.width,
                shape.height
              );
            }
          }
        });
      } else {
        // Text-only slide: the text itself, top to bottom, continuing on further pages when it is long.
        doc.x = SLIDE_TEXT_MARGIN;
        doc.y = SLIDE_TEXT_MARGIN;
        slide.texts.forEach((line) => {
          doc.fillColor('#1F2340').fontSize(14).lineGap(6);
          renderSafePdfText(doc, line, hasUnicodeFont, { width: sWidth - 2 * SLIDE_TEXT_MARGIN }, SLIDE_TEXT_MARGIN, doc.y);
          doc.moveDown(0.5);
        });
      }
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
  const extractedText = await readEpubText(inputBuffer);

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
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: baseName } });
    const chunks: Buffer[] = [];
    const p = new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (err) => reject(err));
    });
    const { hasUnicodeFont } = configurePdfKitFontFallback(doc, (options as any).fontPath);
    doc.fillColor('#4D536B').fontSize(10.5).lineGap(3);
    renderSafePdfText(doc, extractedText, hasUnicodeFont);
    doc.end();

    const buffer = await p;
    return { buffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: buffer.length };
  }

  throw new Error(`Unsupported conversion from EPUB to ${tgt}`);
}

/** FB2: the most paragraphs one book may hold, and how far into the file the FictionBook root element must start. */
const FB2_MAX_PARAGRAPHS = 5_000_000;
const FB2_ROOT_SCAN_CHARS = 4096;

/**
 * FictionBook 2 (FB2) Parser & Converter
 */
async function convertFb2Source(
  inputBuffer: Buffer,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  const xml = decodeXmlBytes(inputBuffer, 'FB2 book');
  const bodies = safeExtractXmlElements(xml, 'body');
  if (!/<FictionBook\b/.test(xml.slice(0, FB2_ROOT_SCAN_CHARS)) || bodies.length === 0) {
    throw new ConversionFailedError('The FB2 file is not a FictionBook document with a body.');
  }

  // Parse title and author
  const titleEl = safeExtractFirstXmlElement(xml, 'book-title');
  const bookTitle = titleEl ? safeExtractAllText(titleEl.content).trim() : baseName;

  const authorEl = safeExtractFirstXmlElement(xml, 'author');
  let authorStr = '';
  if (authorEl) {
    const fnEl = safeExtractFirstXmlElement(authorEl.content, 'first-name');
    const lnEl = safeExtractFirstXmlElement(authorEl.content, 'last-name');
    const fn = fnEl ? safeExtractAllText(fnEl.content).trim() : '';
    const ln = lnEl ? safeExtractAllText(lnEl.content).trim() : '';
    authorStr = `${fn} ${ln}`.trim();
  }

  // The text of a FictionBook is in its bodies (the story and the notes); the description holds metadata only.
  const bodyXml = bodies.map((body) => body.content).join('\n');

  // Parse tables (<table ...>)
  const tables: string[][][] = [];
  for (const tblEl of safeExtractXmlElements(bodyXml, 'table')) {
    const currentTbl: string[][] = [];
    for (const trEl of safeExtractXmlElements(tblEl.content, 'tr')) {
      const row: string[] = [];
      for (const cellEl of safeExtractXmlElements(trEl.content, ['td', 'th'])) {
        row.push(safeExtractAllText(cellEl.content).trim());
      }
      if (row.length > 0) currentTbl.push(row);
    }
    if (currentTbl.length > 0) tables.push(currentTbl);
  }

  // Paragraphs, poem lines, subtitles and the authors of quotations, in document order.
  const paragraphs: string[] = [];
  for (const pEl of safeExtractXmlElements(bodyXml, ['p', 'v', 'subtitle', 'text-author'], { maxElements: FB2_MAX_PARAGRAPHS })) {
    const text = safeExtractAllText(pEl.content).trim();
    if (text) paragraphs.push(text);
  }
  if (paragraphs.length === 0 && tables.length === 0) {
    throw new ConversionFailedError('The FB2 book holds no text.');
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
    if (fullText.trim().length === 0) {
      throw new ConversionFailedError('The FB2 book holds no text to draw in a PDF.');
    }
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: bookTitle } });
    const chunks: Buffer[] = [];
    const p = new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (err) => reject(err));
    });
    const { hasUnicodeFont } = configurePdfKitFontFallback(doc, (options as any).fontPath);
    doc.fillColor('#1F2340').fontSize(18);
    renderSafePdfText(doc, bookTitle, hasUnicodeFont);
    if (authorStr) {
      doc.moveDown(0.3);
      doc.fillColor('#5C6BC0').fontSize(12);
      renderSafePdfText(doc, authorStr, hasUnicodeFont);
    }
    doc.moveDown(1);
    doc.fillColor('#4D536B').fontSize(10.5).lineGap(3);
    renderSafePdfText(doc, fullText, hasUnicodeFont);
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
  // A MOBI, AZW or AZW3 book is read from its PalmDB records; callers that already hold the text pass it with the source `txt`.
  const fullText = src === 'txt' ? inputBuffer.toString('utf-8').trim() : readMobiText(inputBuffer);
  if (fullText === '') throw new ConversionFailedError(`There is no text to write as .${tgt}.`);

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
    const { hasUnicodeFont } = configurePdfKitFontFallback(doc, (options as any).fontPath);
    doc.fillColor('#1F2340').fontSize(18);
    renderSafePdfText(doc, baseName, hasUnicodeFont);
    doc.moveDown(1);
    doc.fillColor('#4D536B').fontSize(10.5).lineGap(3);
    renderSafePdfText(doc, fullText, hasUnicodeFont);
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

/** Most pages one comic archive may hold. */
export const CBZ_MAX_PAGES = 5000;
/** Largest decoded page image, in bytes, the converter reads out of a comic archive. */
export const CBZ_MAX_PAGE_BYTES = 256 * 1024 * 1024;
const CBZ_IMAGE_PATTERN = /\.(png|jpe?g|webp|bmp|gif)$/i;
/** Archive members that are not pages: macOS resource forks and hidden files. */
const CBZ_JUNK_MEMBER_PATTERN = /(^|\/)(__MACOSX\/|\.[^/]*$)/;
const DIGIT_RUN_PATTERN = /(\d+)/;
const PDF_PAGE_MARGIN = 40;
const BMP_SIGNATURE = 'BM';
/** Formats pdfkit embeds as they are; every other page format is decoded and embedded as PNG. */
const PDF_EMBEDDABLE_FORMATS: ReadonlySet<string> = new Set(['png', 'jpeg']);

/**
 * Orders names the way people number comic pages: digit runs compare by value ("page2" before "page10"),
 * the rest compares case-insensitively, and equal keys fall back to the raw names so the order is total.
 */
export function compareNaturally(a: string, b: string): number {
  const left = a.toLowerCase().split(DIGIT_RUN_PATTERN);
  const right = b.toLowerCase().split(DIGIT_RUN_PATTERN);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] === right[i]) continue;
    const isDigitRun = i % 2 === 1;
    if (isDigitRun) {
      const l = left[i].replace(/^0+(?=\d)/, '');
      const r = right[i].replace(/^0+(?=\d)/, '');
      if (l.length !== r.length) return l.length - r.length;
      if (l !== r) return l < r ? -1 : 1;
    } else {
      return left[i] < right[i] ? -1 : 1;
    }
  }
  if (left.length !== right.length) return left.length - right.length;
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** One page of a comic: its name in the archive and a reader that loads and size-checks its bytes. */
interface ComicPage {
  name: string;
  read: () => Promise<Buffer>;
}

/** The page images of a ZIP comic archive in natural name order; each is read, size-checked and decoded only when bound. */
function zipComicPages(zip: JSZip, label: string): ComicPage[] {
  return Object.keys(zip.files)
    .filter((name) => !zip.files[name].dir && CBZ_IMAGE_PATTERN.test(name) && !CBZ_JUNK_MEMBER_PATTERN.test(name))
    .sort(compareNaturally)
    .map((name) => ({
      name: label === '' ? name : `${label}/${name}`,
      read: async () => {
        const declared = (zip.files[name] as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
        if (declared !== undefined && declared > CBZ_MAX_PAGE_BYTES) {
          throw new ConversionFailedError(`CBZ page "${name}" declares ${declared} bytes, more than the ${CBZ_MAX_PAGE_BYTES} byte limit.`);
        }
        return zip.files[name].async('nodebuffer');
      },
    }));
}

/**
 * Binds comic pages into a PDF, one image per A4 page in the order given. A page that cannot be decoded, or no
 * pages at all, fails with a typed 400 error; no page is replaced by text.
 */
async function bindComicPagesToPdf(pages: ComicPage[], format: string, baseName: string): Promise<ConversionResult> {
  if (pages.length === 0) {
    throw new ConversionFailedError(`The ${format} archive holds no page images.`);
  }
  if (pages.length > CBZ_MAX_PAGES) {
    throw new ConversionFailedError(`The ${format} archive holds ${pages.length} pages, more than the ${CBZ_MAX_PAGES} page limit.`);
  }

  const doc = new PDFDocument({ autoFirstPage: false });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', (err) => reject(err));
  });

  for (const comicPage of pages) {
    // Pages are processed one at a time on purpose: each is decoded into memory.
    const page = await decodeComicPage(await comicPage.read(), comicPage.name, format); // NOSONAR S9382: sequential to bound memory
    doc.addPage({ size: 'A4' });
    try {
      doc.image(page, PDF_PAGE_MARGIN, PDF_PAGE_MARGIN, {
        fit: [doc.page.width - 2 * PDF_PAGE_MARGIN, doc.page.height - 2 * PDF_PAGE_MARGIN],
        align: 'center',
        valign: 'center',
      });
    } catch (err) {
      throw new ConversionFailedError(`${format} page "${comicPage.name}" cannot be embedded: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  doc.end();
  const buffer = await done;
  return { buffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: buffer.length };
}

/**
 * Comic Book Zip (CBZ) source: a ZIP of page images. A comic has no text layer, so the only conversion is
 * binding the pages into a PDF, one image per page in natural name order. A page that cannot be decoded, or
 * an archive without pages, fails with a typed 400 error; no page is replaced by text.
 */
async function convertCbzSource(
  inputBuffer: Buffer,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  if (tgt !== 'pdf') {
    throw new Error(`Unsupported conversion from CBZ to ${tgt}`);
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(inputBuffer);
  } catch {
    throw new ConversionFailedError('The CBZ file is not a valid ZIP archive.');
  }
  return bindComicPagesToPdf(zipComicPages(zip, ''), 'CBZ', baseName);
}

/** Comic Book Collection (CBC): the most volumes one collection may list, and the largest volume archive read. */
const CBC_MAX_VOLUMES = 1000;
const CBC_MAX_VOLUME_BYTES = 1024 * 1024 * 1024;
const CBC_LISTING_NAME = 'comics.txt';
const CBC_VOLUME_PATTERN = /\.(cbz|cbr|cb7)$/i;
/** A listing line names a volume and its title: `volume.cbz:Title`. */
const CBC_LISTING_LINE = /^(.+?\.(?:cbz|cbr|cb7))\s*:/i;

/** The page images of one volume of a collection: a CBZ is read lazily, a CBR or CB7 is unpacked by the archive readers. */
async function cbcVolumePages(name: string, bytes: Buffer): Promise<ComicPage[]> {
  const lower = name.toLowerCase();
  if (lower.endsWith('.cbz')) {
    return zipComicPages(await openPackage(bytes, `CBC volume ${name}`), name);
  }
  let members: { filename: string; buffer: Buffer }[];
  try {
    members = lower.endsWith('.cbr') ? extractRarArchive(bytes) : extract7zArchive(bytes);
  } catch (err) {
    throw new ConversionFailedError(`The CBC volume "${name}" cannot be unpacked: ${err instanceof Error ? err.message : String(err)}`);
  }
  return members
    .filter((m) => CBZ_IMAGE_PATTERN.test(m.filename) && !CBZ_JUNK_MEMBER_PATTERN.test(m.filename))
    .sort((a, b) => compareNaturally(a.filename, b.filename))
    .map((m) => ({
      name: `${name}/${m.filename}`,
      read: async () => {
        if (m.buffer.length > CBZ_MAX_PAGE_BYTES) {
          throw new ConversionFailedError(`CBC page "${name}/${m.filename}" is ${m.buffer.length} bytes, more than the ${CBZ_MAX_PAGE_BYTES} byte limit.`);
        }
        return m.buffer;
      },
    }));
}

/**
 * The pages of a Comic Book Collection: a ZIP of CBZ, CBR and CB7 volumes with an optional `comics.txt` that lists
 * them (`volume.cbz:Title`, one per line). Volumes the listing names come first in its order, then any other
 * volume in natural name order; a listed volume that is not in the archive is a typed 400 error.
 */
async function readCbcPages(input: Buffer): Promise<ComicPage[]> {
  const zip = await openPackage(input, 'CBC');
  const present = Object.keys(zip.files).filter((n) => !zip.files[n].dir && CBC_VOLUME_PATTERN.test(n) && !CBZ_JUNK_MEMBER_PATTERN.test(n));
  if (present.length === 0) throw new ConversionFailedError('The CBC archive holds no comic volumes (.cbz, .cbr or .cb7).');
  if (present.length > CBC_MAX_VOLUMES) throw new ConversionFailedError(`The CBC archive holds ${present.length} volumes, more than the ${CBC_MAX_VOLUMES} volume limit.`);

  const listed: string[] = [];
  const listing = zip.file(CBC_LISTING_NAME);
  if (listing) {
    for (const line of (await listing.async('string')).split(/\r?\n/)) {
      const volume = CBC_LISTING_LINE.exec(line.trim())?.[1];
      if (volume === undefined || listed.includes(volume)) continue;
      if (!present.includes(volume)) throw new ConversionFailedError(`The CBC listing names "${volume}", which is not in the archive.`);
      listed.push(volume);
    }
  }
  const ordered = [...listed, ...present.filter((n) => !listed.includes(n)).sort(compareNaturally)];

  const pages: ComicPage[] = [];
  for (const volume of ordered) {
    const bytes = await readPackageEntry(zip, volume, CBC_MAX_VOLUME_BYTES, 'CBC listing'); // NOSONAR S9382: one volume in memory at a time
    pages.push(...(await cbcVolumePages(volume, bytes))); // NOSONAR S9382: sequential to bound memory
    if (pages.length > CBZ_MAX_PAGES) throw new ConversionFailedError(`The CBC collection holds more than the ${CBZ_MAX_PAGES} page limit.`);
  }
  return pages;
}

/**
 * Delivers a PDF made from another source: as the PDF itself, or, for every other target, as the text of its pages
 * (the text layer, or OCR when the pages are pictures) written in that target. Pages with no recognisable text are a
 * typed 400 error, never an empty book.
 */
async function viaPdf(pdf: Buffer, tgt: string, options: ConversionOptions, baseName: string): Promise<ConversionResult> {
  if (tgt === 'pdf') return { buffer: pdf, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: pdf.length };
  const { convertFile } = await import('./index');
  const extractText = async (ocrEnabled: boolean) =>
    (await convertFile(pdf, 'pdf', 'txt', { ...options, ocrEnabled }, `${baseName}.pdf`)).buffer.toString('utf-8').trim();
  // The text layer first; pages that are pictures have none, so they are read with OCR.
  let text = await extractText(false);
  if (text === '') text = await extractText(true);
  if (text === '') {
    throw new ConversionFailedError(`No text was recognised on the pages, so there is nothing to write as .${tgt}.`);
  }
  return writeEbookTargetFromText(text, 'pdf', tgt, options, baseName);
}

/**
 * Comic Book Collection (CBC) source: every volume's pages, volume after volume, bound like a CBZ. A comic has no
 * text layer, so the text and e-book targets read the lettering of the bound pages with OCR and answer with a typed
 * error when none is recognised.
 */
async function convertCbcSource(
  inputBuffer: Buffer,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  const pdf = await bindComicPagesToPdf(await readCbcPages(inputBuffer), 'CBC', baseName);
  return viaPdf(pdf.buffer, tgt, options, baseName);
}

/** Proves that a page decodes and returns bytes pdfkit can embed (PNG and JPEG as stored). */
async function decodeComicPage(bytes: Buffer, name: string, format: string): Promise<Buffer> {
  if (bytes.length > CBZ_MAX_PAGE_BYTES) {
    throw new ConversionFailedError(`${format} page "${name}" is ${bytes.length} bytes, more than the ${CBZ_MAX_PAGE_BYTES} byte limit.`);
  }
  try {
    if (bytes.length >= BMP_SIGNATURE.length && bytes.toString('latin1', 0, BMP_SIGNATURE.length) === BMP_SIGNATURE) {
      // libvips has no BMP loader: the in-process decoder reads the pixels, checking the declared size first.
      const bmp = decodeBmp(bytes);
      return await sharp(bmp.raw, { raw: { width: bmp.width, height: bmp.height, channels: bmp.channels } }).png().toBuffer();
    }
    const image = await openInputImage(bytes);
    const format = (await image.metadata()).format ?? '';
    if (PDF_EMBEDDABLE_FORMATS.has(format)) {
      await openLimitedSharp(bytes).stats();
      return bytes;
    }
    return await image.png().toBuffer();
  } catch (err) {
    rethrowInputPixelLimit(err);
    throw new ConversionFailedError(`${format} page "${name}" cannot be decoded: ${err instanceof Error ? err.message : String(err)}`);
  }
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
  if (text.trim() === '') throw new ConversionFailedError('There is no text to put on slides.');
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

/** BCP 47 tag for content whose language is not known. */
const UNDETERMINED_LANGUAGE = 'und';

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
  // Every book gets its own identifier; the input carries no language metadata, so it is undetermined.
  const bookId = `urn:uuid:${crypto.randomUUID()}`;
  const language = UNDETERMINED_LANGUAGE;

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
<html xmlns="http://www.w3.org/1999/xhtml" lang="${language}">
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
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${language}">
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
    <meta name="dtb:uid" content="${bookId}"/>
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
    <dc:language>${language}</dc:language>
    <dc:identifier id="BookId">${bookId}</dc:identifier>
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

  if (sections.length === 0) throw new ConversionFailedError('There is no text to write as an FB2 book.');

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
 * Escapes plain text for inclusion in RTF documents.
 * Escapes special RTF characters (\, {, }), newlines (\par), tabs (\tab),
 * and encodes non-ASCII characters using signed 16-bit \uN? notation.
 */
export function escapeRtf(text: string): string {
  if (!text) return '';
  return text.replace(/[\\{}]|\t|\r\n|[\r\n]|[^\x20-\x7E]/g, (ch) => {
    if (ch === '\\') return '\\\\';
    if (ch === '{') return '\\{';
    if (ch === '}') return '\\}';
    if (ch === '\r\n' || ch === '\n' || ch === '\r') return '\\par\n';
    if (ch === '\t') return '\\tab ';
    const code = ch.charCodeAt(0);
    if (code > 127) {
      const signed = code > 32767 ? code - 65536 : code;
      return `\\u${signed}?`;
    }
    return ch;
  });
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
    const tsv = rows.map((r) => r.join('\t')).join(lineEnding);
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
 * Decodes a 32-bit BIFF RK number into its floating point or integer value
 */
export function decodeRk(rk: number): number {
  const is100 = (rk & 0x01) !== 0;
  const isInt = (rk & 0x02) !== 0;
  let val: number;
  if (isInt) {
    val = rk >> 2;
  } else {
    const buf = Buffer.alloc(8);
    buf.writeUInt32LE(0, 0);
    buf.writeUInt32LE(rk & ~3, 4);
    val = buf.readDoubleLE(0);
  }
  return is100 ? val / 100 : val;
}

/**
 * Authentic BIFF8 Binary Spreadsheet Stream Parser
 * Parses BOF, SST, LABELSST, LABEL, NUMBER, RK, MULRK, FORMULA, STRING records.
 */
export function parseBiff8Workbook(stream: Buffer): string[][] {
  if (stream.length < 4) return [];

  const firstRec = stream.readUInt16LE(0);
  if (firstRec !== 0x0809 && firstRec !== 0x0409 && firstRec !== 0x0209 && firstRec !== 0x0009) {
    return [];
  }

  const sst: string[] = [];
  const cells = new Map<number, Map<number, string>>();
  let maxRow = -1;
  let maxCol = -1;
  let lastFormulaCell: { r: number; c: number } | null = null;

  let pos = 0;
  while (pos + 4 <= stream.length) {
    const recId = stream.readUInt16LE(pos);
    const recLen = stream.readUInt16LE(pos + 2);
    pos += 4;
    if (pos + recLen > stream.length) break;
    const data = stream.subarray(pos, pos + recLen);
    pos += recLen;

    // 0x00FC: SST (Shared String Table)
    if (recId === 0x00FC) {
      const sstChunks: Buffer[] = [data];
      let peekPos = pos;
      while (peekPos + 4 <= stream.length) {
        const nextId = stream.readUInt16LE(peekPos);
        const nextLen = stream.readUInt16LE(peekPos + 2);
        if (nextId === 0x003C && peekPos + 4 + nextLen <= stream.length) {
          sstChunks.push(stream.subarray(peekPos + 4, peekPos + 4 + nextLen));
          peekPos += 4 + nextLen;
          pos = peekPos;
        } else {
          break;
        }
      }
      const sstBuf = Buffer.concat(sstChunks);
      if (sstBuf.length >= 8) {
        const uniqueStrings = sstBuf.readUInt32LE(4);
        let off = 8;
        for (let i = 0; i < uniqueStrings && off < sstBuf.length; i++) {
          if (off + 3 > sstBuf.length) break;
          const charCount = sstBuf.readUInt16LE(off);
          const flags = sstBuf.readUInt8(off + 2);
          off += 3;
          const isUnicode = (flags & 0x01) !== 0;
          const hasExt = (flags & 0x04) !== 0;
          const hasRich = (flags & 0x08) !== 0;
          let richRuns = 0;
          if (hasRich) {
            if (off + 2 > sstBuf.length) break;
            richRuns = sstBuf.readUInt16LE(off);
            off += 2;
          }
          let extLen = 0;
          if (hasExt) {
            if (off + 4 > sstBuf.length) break;
            extLen = sstBuf.readUInt32LE(off);
            off += 4;
          }
          let str = '';
          if (isUnicode) {
            const byteLen = charCount * 2;
            const avail = Math.min(byteLen, Math.floor((sstBuf.length - off) / 2) * 2);
            str = sstBuf.toString('utf16le', off, off + avail);
            off += byteLen;
          } else {
            const byteLen = charCount;
            const avail = Math.min(byteLen, sstBuf.length - off);
            str = sstBuf.toString('latin1', off, off + avail);
            off += byteLen;
          }
          off += richRuns * 4;
          off += extLen;
          sst.push(str);
        }
      }
    }

    const setCell = (r: number, c: number, val: string) => {
      if (!cells.has(r)) cells.set(r, new Map());
      cells.get(r)!.set(c, val);
      if (r > maxRow) maxRow = r;
      if (c > maxCol) maxCol = c;
    };

    // 0x00FD: LABELSST
    if (recId === 0x00FD && data.length >= 10) {
      const r = data.readUInt16LE(0);
      const c = data.readUInt16LE(2);
      const sstIdx = data.readUInt32LE(6);
      setCell(r, c, sst[sstIdx] ?? '');
    }

    // 0x0204: LABEL
    else if (recId === 0x0204 && data.length >= 8) {
      const r = data.readUInt16LE(0);
      const c = data.readUInt16LE(2);
      const len = data.readUInt16LE(6);
      if (data.length >= 9) {
        const flags = data.readUInt8(8);
        const isUnicode = (flags & 0x01) !== 0;
        let str = '';
        if (isUnicode) {
          const byteLen = len * 2;
          str = data.toString('utf16le', 9, Math.min(data.length, 9 + byteLen));
        } else {
          str = data.toString('latin1', 9, Math.min(data.length, 9 + len));
        }
        setCell(r, c, str);
      }
    }

    // 0x00D6: RSTRING (BIFF5)
    else if (recId === 0x00D6 && data.length >= 8) {
      const r = data.readUInt16LE(0);
      const c = data.readUInt16LE(2);
      const len = data.readUInt16LE(6);
      const str = data.toString('latin1', 8, Math.min(data.length, 8 + len));
      setCell(r, c, str);
    }

    // 0x0203: NUMBER
    else if (recId === 0x0203 && data.length >= 14) {
      const r = data.readUInt16LE(0);
      const c = data.readUInt16LE(2);
      const num = data.readDoubleLE(6);
      setCell(r, c, String(num));
    }

    // 0x027E: RK
    else if (recId === 0x027E && data.length >= 10) {
      const r = data.readUInt16LE(0);
      const c = data.readUInt16LE(2);
      const rk = data.readUInt32LE(6);
      setCell(r, c, String(decodeRk(rk)));
    }

    // 0x00BD: MULRK
    else if (recId === 0x00BD && data.length >= 6) {
      const r = data.readUInt16LE(0);
      const colFirst = data.readUInt16LE(2);
      const colLast = data.readUInt16LE(data.length - 2);
      let c = colFirst;
      let off = 4;
      while (c <= colLast && off + 6 <= data.length) {
        const rk = data.readUInt32LE(off + 2);
        setCell(r, c, String(decodeRk(rk)));
        off += 6;
        c++;
      }
    }

    // 0x0006: FORMULA
    else if (recId === 0x0006 && data.length >= 14) {
      const r = data.readUInt16LE(0);
      const c = data.readUInt16LE(2);
      lastFormulaCell = { r, c };
      if (data[12] === 0xff && data[13] === 0xff) {
        const fType = data[6];
        if (fType === 1) setCell(r, c, data[8] === 1 ? 'TRUE' : 'FALSE');
        else if (fType === 2) setCell(r, c, '#ERR!');
      } else {
        const num = data.readDoubleLE(6);
        setCell(r, c, String(num));
      }
    }

    // 0x0207: STRING
    else if (recId === 0x0207 && lastFormulaCell && data.length >= 3) {
      const len = data.readUInt16LE(0);
      const flags = data.readUInt8(2);
      const isUnicode = (flags & 0x01) !== 0;
      let str = '';
      if (isUnicode) {
        str = data.toString('utf16le', 3, Math.min(data.length, 3 + len * 2));
      } else {
        str = data.toString('latin1', 3, Math.min(data.length, 3 + len));
      }
      setCell(lastFormulaCell.r, lastFormulaCell.c, str);
      lastFormulaCell = null;
    }
  }

  if (maxRow < 0 || maxCol < 0) return [];

  const rows: string[][] = [];
  for (let r = 0; r <= maxRow; r++) {
    const rowMap = cells.get(r);
    const row: string[] = [];
    for (let c = 0; c <= maxCol; c++) {
      row.push(rowMap?.get(c) ?? '');
    }
    rows.push(row);
  }

  while (rows.length > 0 && rows[rows.length - 1].every((cell) => !cell)) {
    rows.pop();
  }

  return rows;
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
  const rows: string[][] = [];

  // 1. CFBF Compound File Binary Format containing Workbook stream
  if (isCfbfContainer(inputBuffer)) {
    const cfbf = parseCfbf(inputBuffer);
    let workbookStream: Buffer | undefined;
    for (const [name, buf] of cfbf.streams.entries()) {
      if (name.toLowerCase() === 'workbook' || name.toLowerCase() === 'book') {
        workbookStream = buf;
        break;
      }
    }
    if (!workbookStream) {
      throw new ConversionFailedError('Corrupt XLS: Workbook stream not found in CFBF container');
    }
    const parsed = parseBiff8Workbook(workbookStream);
    if (parsed.length === 0) {
      throw new ConversionFailedError('Corrupt XLS: No spreadsheet cell records found in BIFF stream');
    }
    rows.push(...parsed);
  }
  // 2. Raw BIFF stream (without CFBF container)
  else if (
    inputBuffer.length >= 4 &&
    (inputBuffer.readUInt16LE(0) === 0x0809 || inputBuffer.readUInt16LE(0) === 0x0409)
  ) {
    const parsed = parseBiff8Workbook(inputBuffer);
    if (parsed.length === 0) {
      throw new ConversionFailedError('Corrupt XLS: No spreadsheet cell records found in raw BIFF stream');
    }
    rows.push(...parsed);
  }
  // 3. XML Spreadsheet 2003 (<Row><Cell><Data ...>)
  else {
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
  }

  if (rows.length === 0) {
    throw new ConversionFailedError('Failed to parse XLS spreadsheet: invalid or empty content');
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
  const text = await readOdtText(inputBuffer);

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
export async function generateOdsFromData(
  data: string[][] | OfficeWorksheet[],
  baseName: string
): Promise<Buffer> {
  const sheets: OfficeWorksheet[] =
    Array.isArray(data) && data.length > 0 && typeof data[0] === 'object' && 'rows' in data[0]
      ? (data as OfficeWorksheet[])
      : [{ name: baseName, rows: (data as string[][]) || [] }];

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

  let tablesXml = '';
  sheets.forEach((sheet) => {
    let rowsXml = '';
    sheet.rows.forEach((row) => {
      rowsXml += '<table:table-row>';
      row.forEach((cell) => {
        rowsXml += `<table:table-cell office:value-type="string"><text:p>${escapeXml(cell)}</text:p></table:table-cell>`;
      });
      rowsXml += '</table:table-row>';
    });
    tablesXml += `
      <table:table table:name="${escapeXml(sheet.name || baseName)}">
        ${rowsXml}
      </table:table>`;
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
      ${tablesXml}
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
      const allSheets = await parseAllXlsxWorksheets(zip);
      if (allSheets.length > 0) {
        if (allSheets.length === 1) return allSheets[0].rows;
        const merged: string[][] = [];
        allSheets.forEach((s, idx) => {
          if (idx > 0 && s.rows.length > 0) {
            merged.push([`### Sheet: ${s.name}`]);
          }
          merged.push(...s.rows);
        });
        return merged;
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

/**
 * Discovers and extracts all worksheets from an office spreadsheet document
 */
export async function extractAllSheetsForOffice(
  inputBuffer: Buffer,
  src: string,
  options: ConversionOptions = {}
): Promise<OfficeWorksheet[]> {
  if (src === 'xlsx') {
    const zip = await JSZip.loadAsync(inputBuffer);
    return parseAllXlsxWorksheets(zip);
  }
  const rows = await extractRowsForOffice(inputBuffer, src, options);
  return [{ name: 'Sheet1', rows }];
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

  const text = inputBuffer.toString('utf-8');
  if (text.trim() === '') throw new ConversionFailedError(`The .${src} file holds no text.`);

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
    const rtf = `{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Times New Roman;}}\\fs24 ${escapeRtf(text)}}\n`;
    const buffer = Buffer.from(rtf, 'utf-8');
    return { buffer, mimeType: 'application/rtf', filename: `${baseName}.rtf`, size: buffer.length };
  }
  if (tgt === 'xps') {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const buffer = await buildOpenXpsPackage([{ title: baseName, lines }], baseName);
    return { buffer, mimeType: 'application/oxps', filename: `${baseName}.xps`, size: buffer.length };
  }
  if (['png', 'jpg', 'jpeg', 'webp', 'bmp'].includes(tgt)) {
    const rendered = await renderTextToRaster(text, tgt, baseName);
    return { buffer: rendered.buffer, mimeType: rendered.mimeType, filename: `${baseName}.${tgt}`, size: rendered.buffer.length };
  }

  const pdfBuffer = await generatePdfFromDocx([{ text, isHeading: false, isBold: false, isItalic: false }], [], options, baseName);
  return { buffer: pdfBuffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: pdfBuffer.length };
}

const ODF_GRAPHICS_MIMETYPE_PREFIX = 'application/vnd.oasis.opendocument.graphics';

/**
 * OpenDocument Drawing (ODG) and drawing template (ODD) source. A drawing has no text target, and the
 * in-process engine has no vector renderer: LibreOffice Draw renders every advertised target, so this
 * validates the package (a malformed file is a typed 400 error) and then reports the missing engine
 * with a typed 503 error. It never answers with the drawing's text under another format's name.
 */
export async function assertOpenDocumentGraphic(inputBuffer: Buffer, src: string): Promise<void> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(inputBuffer);
  } catch {
    throw new ConversionFailedError(`The ${src.toUpperCase()} file is not a valid OpenDocument package.`);
  }
  const mimetype = await zip.file('mimetype')?.async('text');
  if (!mimetype?.startsWith(ODF_GRAPHICS_MIMETYPE_PREFIX) || !zip.file('content.xml')) {
    throw new ConversionFailedError(`The ${src.toUpperCase()} file is not an OpenDocument drawing.`);
  }
}

async function convertOpenDocumentGraphicSource(inputBuffer: Buffer, src: string, tgt: string): Promise<ConversionResult> {
  await assertOpenDocumentGraphic(inputBuffer, src);
  throw new EngineUnavailableError('soffice', `Rendering a drawing to ${tgt} requires LibreOffice Draw; the in-process engine has no drawing renderer.`);
}

/** The text of an e-book in a ZIP wrapper (HTMLZ, TXTZ) or in a plain-text/markup file (OEB package, PML). */
async function readGenericEbookText(input: Buffer, src: string): Promise<string> {
  if (src === 'htmlz' || src === 'txtz') {
    const zip = await openPackage(input, src.toUpperCase());
    const mainName = src === 'htmlz' ? 'index.html' : 'index.txt';
    const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
    const entryName = names.includes(mainName) ? mainName : names.sort((a, b) => a.localeCompare(b)).find((name) => (src === 'htmlz' ? /\.(x?html?)$/i : /\.txt$/i).test(name));
    if (!entryName) throw new ConversionFailedError(`The ${src.toUpperCase()} archive has no ${mainName}.`);
    const decoded = decodeXmlBytes(await readPackageEntry(zip, entryName, EPUB_MAX_CHAPTER_BYTES, `${src.toUpperCase()} archive`), `${src.toUpperCase()} text`);
    const text = src === 'htmlz' ? htmlToText(decoded) : decoded.trim();
    if (text === '') throw new ConversionFailedError(`The ${src.toUpperCase()} archive holds no text.`);
    return text;
  }
  if (src === 'oeb') {
    // An OEB 1.x package names its documents in separate files; the project's single-file package carries its text in <text>.
    const xml = input.toString('utf-8');
    const body = /<text>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/text>/.exec(xml)?.[1]?.trim();
    if (!body) throw new ConversionFailedError('The OEB package holds no text: its content documents are separate files that a single file cannot carry.');
    return body;
  }
  if (src === 'pml') return readPmlText(input);
  throw new ConversionFailedError(`Reading .${src} files is not supported.`);
}

async function convertGenericEbookSource(
  inputBuffer: Buffer,
  src: string,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  return writeEbookTargetFromText(await readGenericEbookText(inputBuffer, src), src, tgt, options, baseName);
}

/** Writes the text of an e-book in any target the e-book sources advertise: EPUB, the Palm family, TXT, RTF, rasters and PDF. */
async function writeEbookTargetFromText(
  text: string,
  src: string,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
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
    const rtf = `{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Times New Roman;}}\\fs24 ${escapeRtf(text)}}\n`;
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
  pipeline: Sharp,
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
      const buffer = await pipeline.avif({ tune: AVIF_TUNE, effort: AVIF_EFFORT }).toBuffer();
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
  const width = Math.max(640, numCols * colWidth + 40);
  const height = Math.max(200, rows.length * rowHeight + 80);

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#ffffff" />
    <text x="20" y="32" font-family="sans-serif" font-size="16" font-weight="bold" fill="#1e293b">${escapeXml(baseName)}</text>
  `;

  rows.forEach((row, rIdx) => {
    const y = 50 + rIdx * rowHeight;
    const isHeader = rIdx === 0;
    const bgFill = isHeader ? '#f1f5f9' : (rIdx % 2 === 0 ? '#ffffff' : '#f8fafc');
    svg += `<rect x="20" y="${y}" width="${width - 40}" height="${rowHeight}" fill="${bgFill}" stroke="#e2e8f0" />`;
    row.forEach((cell, cIdx) => {
      const x = 25 + cIdx * colWidth;
      const fontWeight = isHeader ? 'bold' : 'normal';
      svg += `<text x="${x}" y="${y + 18}" font-family="sans-serif" font-size="12" font-weight="${fontWeight}" fill="#334155">${escapeXml(cell)}</text>`;
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
  const lines = text.split(/\r?\n/);
  const width = 800;
  const height = Math.max(240, lines.length * 24 + 80);

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#ffffff" />
    <text x="30" y="36" font-family="sans-serif" font-size="18" font-weight="bold" fill="#0f172a">${escapeXml(baseName)}</text>
  `;

  lines.forEach((line, idx) => {
    const y = 68 + idx * 24;
    svg += `<text x="30" y="${y}" font-family="sans-serif" font-size="13" fill="#334155">${escapeXml(line)}</text>`;
  });

  svg += `</svg>`;

  const pipeline = sharp(Buffer.from(svg, 'utf-8'));
  return rasterizePipeline(pipeline, tgt);
}


