import { ConversionOptions, ConversionResult, EngineUnavailableError, UnsupportedTargetError } from '../../types';
import { officeReadingFormat } from './office-suite-sources';
import { calibreEngineUnavailable, isCalibreEbookTarget } from '../calibre-ebook-targets';
import { loadFontCoverageIndex } from '../pdf-fonts';
import { OOXML_VARIANT_FAMILY, ooxmlVariantToPlainFormat } from '../ooxml-variants';
import { buildOpenXpsPackage } from '../openxps';
import { convertHwp } from '../hwp';
import { extractPrintReplicaPdf } from './print-replica';
import { documentToDocx } from '../document-model/docx';
import { pdfToEpub, readPdfForOffice } from '../pdf-office';
import { unconvertibleOfficeTarget } from '../native-engine-pairs';
import Papa from 'papaparse';
import { documentToOdt } from '../document-model/odt';
import { readEpubModel } from '../source-model';
import { convertDocxSource } from './convert-docx';
import { convertXlsxSource, officeSheetWorkbook } from './xlsx-convert';
import { convertPotxSource, convertPptxSource } from './pptx-convert';
import { convertOdpSource } from './odp-convert';
import { convertOdsSource, convertOdtSource, convertOpenDocumentGraphicSource } from './odf-convert';
import { convertXlsSource } from './xls-convert';
import { convertPptSource } from './ppt-convert';
import { COMIC_SOURCES, convertCbcSource, convertComicSource, convertEpubSource, convertFb2Source, convertMobiSource, viaPdf } from './ebook-convert';
import { convertEtSource, convertGenericDocumentSource, convertGenericEbookSource } from './convert-generic';
import { extractTextContentForOffice } from './text-extraction';
import { generateDocxFromExtractedText, generateDocxFromText, generateEpubFromText, generateFb2FromText, generateHwpFromText, generatePptxFromText, modelFromExtractedText } from './office-from-text';
import { extractRowsForOffice } from './sheet-extract';
import { generateOdpFromSlides, generateOdsFromData, generateOdtFromText } from './odf-writers';
import { generatePdfFromDocx } from './docx-pdf';
import { escapeMarkupAttribute } from '../../text/escape';
import { escapeRtf } from './rtf-escape';

/** One conversion: the input, its source and target format, the options and the base name of the output. */
type FormatConverter = (inputBuffer: Buffer, src: string, tgt: string, options: ConversionOptions, baseName: string) => Promise<ConversionResult>;

function officeResult(buffer: Buffer, mimeType: string, baseName: string, extension: string): ConversionResult {
  return { buffer, mimeType, filename: `${baseName}.${extension}`, size: buffer.length };
}

const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Sources that have a reader of their own; every other source is read as text for the target's writer. */
const SOURCE_READERS: ReadonlyArray<readonly [readonly string[], FormatConverter]> = [
  [['docx'], (input, _src, tgt, options, baseName) => convertDocxSource(input, tgt, options, baseName)],
  [['xlsx'], (input, _src, tgt, options, baseName) => convertXlsxSource(input, tgt, options, baseName)],
  [['pptx'], (input, _src, tgt, options, baseName) => convertPptxSource(input, tgt, options, baseName)],
  [['odp'], (input, _src, tgt, options, baseName) => convertOdpSource(input, tgt, options, baseName)],
  [['ods'], (input, _src, tgt, options, baseName) => convertOdsSource(input, tgt, options, baseName)],
  [['xls'], (input, _src, tgt, options, baseName) => convertXlsSource(input, tgt, options, baseName)],
  [['odt'], (input, _src, tgt, options, baseName) => convertOdtSource(input, tgt, options, baseName)],
  // PowerPoint 97-2003 binary, PowerPoint templates and Keynote
  [['ppt'], (input, _src, tgt, options, baseName) => convertPptSource(input, tgt, options, baseName)],
  [['potx'], (input, _src, tgt, options, baseName) => convertPotxSource(input, tgt, options, baseName)],
  [
    ['key'],
    async () => {
      throw new EngineUnavailableError('soffice', 'Keynote presentations are read by LibreOffice; the in-process engine has no Keynote reader.');
    },
  ],
  [['epub'], (input, _src, tgt, options, baseName) => convertEpubSource(input, tgt, options, baseName)],
  [['fb2'], (input, _src, tgt, options, baseName) => convertFb2Source(input, tgt, options, baseName)],
  // MOBI / AZW3 / PRC
  [['mobi', 'azw', 'azw3', 'prc'], (input, src, tgt, options, baseName) => convertMobiSource(input, src, tgt, options, baseName)],
  // CBZ and CBR (Comic Book Zip and RAR)
  [[...COMIC_SOURCES], (input, src, tgt, options, baseName) => convertComicSource(input, src, tgt, options, baseName)],
  // ET (Kingsoft WPS Spreadsheet)
  [['et'], (input, _src, tgt, options, baseName) => convertEtSource(input, tgt, options, baseName)],
  // HWP (Hangul Word Processor) and HWPX (KS X 6101 Hangul Word Processor XML)
  [['hwp'], (input, _src, tgt, options, baseName) => convertHwp(input, tgt, options, baseName)],
  [
    ['hwpx'],
    async (input, _src, tgt, options, baseName) => {
      const { convertHwpx } = await import('../hwpx');
      return convertHwpx(input, tgt, options, baseName);
    },
  ],
  // LWP, PUB (Documents)
  [['lwp', 'pub'], (input, src, tgt, options, baseName) => convertGenericDocumentSource(input, src, tgt, options, baseName)],
  // ODG, ODD (OpenDocument Graphics / Drawing)
  [['odg', 'odd'], async (input, src, tgt) => convertOpenDocumentGraphicSource(input, src, tgt)],
  // AZW4 (Print Replica: a PDF inside a PalmDB container) and CBC (a collection of comic archives)
  [['azw4'], async (input, _src, tgt, options, baseName) => viaPdf(await extractPrintReplicaPdf(input), tgt, options, baseName)],
  [['cbc'], (input, _src, tgt, options, baseName) => convertCbcSource(input, tgt, options, baseName)],
  // HTMLZ, TXTZ, PML, OEB (Ebooks)
  [['htmlz', 'txtz', 'pml', 'oeb', 'rb'], (input, src, tgt, options, baseName) => convertGenericEbookSource(input, src, tgt, options, baseName)],
];

const SOURCE_CONVERTERS: ReadonlyMap<string, FormatConverter> = new Map(
  SOURCE_READERS.flatMap(([sources, convert]) => sources.map((source): [string, FormatConverter] => [source, convert]))
);

/** Targets the in-process engine writes from any source, by target format. */
const TARGET_CONVERTERS: ReadonlyMap<string, FormatConverter> = new Map<string, FormatConverter>([
  // Target is HWP or HWPX (from Markdown, HTML, TXT, DOCX, ODT, RTF, etc.)
  ['hwp', async (input, src, _tgt, options, baseName) => {
    const hwpBuffer = generateHwpFromText(await extractTextContentForOffice(input, src, options, baseName), baseName);
    return officeResult(hwpBuffer, 'application/x-hwp', baseName, 'hwp');
  }],
  ['hwpx', async (input, src, _tgt, options, baseName) => {
    const { markdownToHwpx } = await import('../hwpx');
    const textContent = await extractTextContentForOffice(input, src, options, baseName);
    return officeResult(await markdownToHwpx(textContent, baseName), 'application/hwp+zip', baseName, 'hwpx');
  }],
  // Target is DOCX (from Markdown, HTML, TXT, PDF, RTF, etc.)
  ['docx', async (input, src, _tgt, options, baseName) => {
    // A PDF keeps the structure its layout analysis found: columns, headings, lists, tables and images.
    const docxBuffer = src === 'pdf'
      ? await documentToDocx(await readPdfForOffice(input, options, true))
      : await generateDocxFromSource(input, src, options, baseName);
    return officeResult(docxBuffer, DOCX_MIME_TYPE, baseName, 'docx');
  }],
  // Target is PPTX (from Markdown, HTML, TXT, Presentation, etc.)
  ['pptx', async (input, src, _tgt, options, baseName) => {
    const textContent = await extractTextContentForOffice(input, src, options, baseName);
    const pptxBuffer = await generatePptxFromText(textContent, src, options, baseName);
    return officeResult(pptxBuffer, 'application/vnd.openxmlformats-officedocument.presentationml.presentation', baseName, 'pptx');
  }],
  // Target is XLSX (from CSV, TSV, JSON)
  ['xlsx', async (input, src, _tgt, options, baseName) => {
    const xlsxBuffer = await officeSheetWorkbook(input, src, options);
    return officeResult(xlsxBuffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', baseName, 'xlsx');
  }],
  // Target is ODS (OpenDocument Spreadsheet)
  ['ods', async (input, src, _tgt, options, baseName) => {
    const rows = await extractRowsForOffice(input, src, options);
    return officeResult(await generateOdsFromData(rows, baseName), 'application/vnd.oasis.opendocument.spreadsheet', baseName, 'ods');
  }],
  // Target is XLS: only the office suite writes a BIFF8 workbook, from the XLSX workbook this engine writes (the worker's route)
  ['xls', async (_input, src, tgt) => {
    throw unconvertibleOfficeTarget(src, tgt);
  }],
  // Target is ODP (OpenDocument Presentation)
  ['odp', async (input, src, _tgt, options, baseName) => {
    const textContent = await extractTextContentForOffice(input, src, options, baseName);
    const rawSlides = textContent.split(/\n\n+/).map((p, idx) => ({
      number: idx + 1,
      texts: p.split('\n').filter(Boolean),
    }));
    const odpBuffer = await generateOdpFromSlides(
      rawSlides.length > 0 ? rawSlides : [{ number: 1, texts: [baseName] }],
      baseName
    );
    return officeResult(odpBuffer, 'application/vnd.oasis.opendocument.presentation', baseName, 'odp');
  }],
  // Target is ODT (OpenDocument Text)
  ['odt', async (input, src, _tgt, options, baseName) =>
    officeResult(await generateOdtFromSource(input, src, options, baseName), 'application/vnd.oasis.opendocument.text', baseName, 'odt')],
  // Target is EPUB (from MD, HTML, TXT, DOCX, etc.)
  ['epub', async (input, src, _tgt, options, baseName) =>
    officeResult(await generateEpubFromSource(input, src, options, baseName), 'application/epub+zip', baseName, 'epub')],
  // Target is PDF (from Office or Ebook sources)
  ['pdf', async (input, src, _tgt, options, baseName) => {
    const textContent = await extractTextContentForOffice(input, src, options, baseName);
    const pdfBuffer = await generatePdfFromDocx([{ text: textContent, isHeading: false, isBold: false, isItalic: false }], [], options, baseName);
    return officeResult(pdfBuffer, 'application/pdf', baseName, 'pdf');
  }],
  // Target is FB2 (FictionBook 2.0 with semantic markup)
  ['fb2', async (input, src, _tgt, options, baseName) => {
    const textContent = await extractTextContentForOffice(input, src, options, baseName);
    return officeResult(generateFb2FromText(textContent, baseName, options), 'application/x-fictionbook+xml', baseName, 'fb2');
  }],
  // Target is OpenXPS / XPS
  ['xps', convertToXps],
  ['oxps', convertToXps],
  // Target is Plain Text / HTML / RTF / CSV
  ['txt', convertToText],
  ['text', convertToText],
  ['html', async (input, src, _tgt, options, baseName) => {
    const textContent = await extractTextContentForOffice(input, src, options, baseName);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeMarkupAttribute(baseName)}</title></head><body><pre>${escapeMarkupAttribute(textContent)}</pre></body></html>`;
    return officeResult(Buffer.from(html, 'utf-8'), 'text/html', baseName, 'html');
  }],
  ['rtf', async (input, src, _tgt, options, baseName) => {
    const textContent = await extractTextContentForOffice(input, src, options, baseName);
    const rtf = `{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Times New Roman;}}\\fs24 ${escapeRtf(textContent)}}\n`;
    return officeResult(Buffer.from(rtf, 'utf-8'), 'application/rtf', baseName, 'rtf');
  }],
  ['csv', async (input, src, _tgt, options, baseName) => {
    const rows = await extractRowsForOffice(input, src, options);
    return officeResult(Buffer.from(Papa.unparse(rows, { delimiter: options.delimiter || ',' }), 'utf-8'), 'text/csv', baseName, 'csv');
  }],
  // Target is Apple iWork (pages, numbers, key)
  ...['pages', 'numbers', 'key'].map((iWork): [string, FormatConverter] => [
    iWork,
    async (_input, _src, tgt) => {
      throw new UnsupportedTargetError(`Unsupported office conversion: target iWork format '${tgt}' is not supported`);
    },
  ]),
]);

async function convertToXps(inputBuffer: Buffer, src: string, tgt: string, options: ConversionOptions, baseName: string): Promise<ConversionResult> {
  const textContent = await extractTextContentForOffice(inputBuffer, src, options, baseName);
  const lines = textContent.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const buffer = await buildOpenXpsPackage([{ title: baseName, lines }], baseName);
  return officeResult(buffer, 'application/oxps', baseName, tgt);
}

async function convertToText(inputBuffer: Buffer, src: string, _tgt: string, options: ConversionOptions, baseName: string): Promise<ConversionResult> {
  const textContent = await extractTextContentForOffice(inputBuffer, src, options, baseName);
  return officeResult(Buffer.from(textContent, 'utf-8'), 'text/plain', baseName, 'txt');
}

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
  // A template or slide show is read by the reader of the format it is a layout of.
  const src = officeReadingFormat(sourceFormat);
  const tgt = targetFormat.toLowerCase();
  if (isCalibreEbookTarget(tgt)) {
    throw calibreEngineUnavailable(`Writing .${tgt} needs the native ebook-convert (calibre) engine; the in-process engine has no writer for it.`);
  }
  // PDF and raster writers draw text with installed fonts found through the coverage index.
  await loadFontCoverageIndex();

  // Macro-enabled, template and slideshow variants: read by the reader of their plain format, macros never run.
  const ooxmlFamily = OOXML_VARIANT_FAMILY[src];
  if (ooxmlFamily !== undefined) {
    if (tgt === ooxmlFamily) return ooxmlVariantToPlainFormat(inputBuffer, src, ooxmlFamily, baseName);
    if (tgt === 'xps' || tgt === 'oxps') {
      // The plain format's reader gives the text (a workbook, its rows as CSV lines); the XPS writer lays it out like the
      // one of the other text-based sources.
      const textTarget = ooxmlFamily === 'xlsx' ? 'csv' : 'txt';
      const text = (await convertOffice(inputBuffer, ooxmlFamily, textTarget, options, originalFilename)).buffer.toString('utf-8');
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
      const buffer = await buildOpenXpsPackage([{ title: baseName, lines }], baseName);
      return { buffer, mimeType: 'application/oxps', filename: `${baseName}.${tgt}`, size: buffer.length };
    }
    return convertOffice(inputBuffer, ooxmlFamily, tgt, options, originalFilename);
  }

  const sourceConverter = SOURCE_CONVERTERS.get(src);
  if (sourceConverter) return sourceConverter(inputBuffer, src, tgt, options, baseName);
  const targetConverter = TARGET_CONVERTERS.get(tgt);
  if (targetConverter) return targetConverter(inputBuffer, src, tgt, options, baseName);

  throw new UnsupportedTargetError(`Unsupported office conversion from ${sourceFormat} to ${targetFormat}`);
}

/** An EPUB from any other source; a PDF is written from its blocks (`pdfToEpub`), the rest from the text extracted from them. */
async function generateEpubFromSource(inputBuffer: Buffer, src: string, options: ConversionOptions, baseName: string): Promise<Buffer> {
  if (src === 'pdf') return pdfToEpub(inputBuffer, options, baseName);
  return generateEpubFromText(await extractTextContentForOffice(inputBuffer, src, options, baseName), src, options, baseName);
}

/** An ODT from any other source: PDF text keeps the text writer; every other source is written from the block model. */
async function generateOdtFromSource(inputBuffer: Buffer, src: string, options: ConversionOptions, baseName: string): Promise<Buffer> {
  if (src === 'epub') return documentToOdt(await readEpubModel(inputBuffer), { title: baseName, language: options.language });
  const textContent = await extractTextContentForOffice(inputBuffer, src, options, baseName);
  if (src === 'pdf') return generateOdtFromText(textContent, baseName);
  return documentToOdt(await modelFromExtractedText(textContent, src), { title: baseName, language: options.language });
}

/**
 * A DOCX from any other source. PDF text keeps the existing text writer; every other source is read into the block
 * model first (EPUB through its package reader, the rest through the text extractor) and written by the DOCX writer.
 */
async function generateDocxFromSource(inputBuffer: Buffer, src: string, options: ConversionOptions, baseName: string): Promise<Buffer> {
  if (src === 'epub') return documentToDocx(await readEpubModel(inputBuffer), { title: baseName, language: options.language });
  const textContent = await extractTextContentForOffice(inputBuffer, src, options, baseName);
  if (src === 'pdf') return generateDocxFromText(textContent, src, options, baseName);
  return generateDocxFromExtractedText(textContent, src, options, baseName);
}
