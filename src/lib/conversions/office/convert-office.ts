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
import { escapeHtml } from './markup-escape';
import { escapeRtf } from './rtf-escape';

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

  // 0. Macro-enabled, template and slideshow variants: read by the reader of their plain format, macros never run.
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

  // 11. MOBI / AZW3 / PRC Source
  if (['mobi', 'azw', 'azw3', 'prc'].includes(src)) {
    return convertMobiSource(inputBuffer, src, tgt, options, baseName);
  }

  // 12. CBZ and CBR Sources (Comic Book Zip and RAR)
  if (COMIC_SOURCES.has(src)) {
    return convertComicSource(inputBuffer, src, tgt, options, baseName);
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
    const { convertHwpx } = await import('../hwpx');
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
  if (['htmlz', 'txtz', 'pml', 'oeb', 'rb'].includes(src)) {
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
    const { markdownToHwpx } = await import('../hwpx');
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
  if (tgt === 'docx' && src === 'pdf') {
    // A PDF keeps the structure its layout analysis found: columns, headings, lists, tables and images.
    const docxBuffer = await documentToDocx(await readPdfForOffice(inputBuffer, options, true));
    return {
      buffer: docxBuffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      filename: `${baseName}.docx`,
      size: docxBuffer.length,
    };
  }
  if (tgt === 'docx') {
    const docxBuffer = await generateDocxFromSource(inputBuffer, src, options, baseName);
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
    const xlsxBuffer = await officeSheetWorkbook(inputBuffer, src, options);
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

  // 17. Target is XLS: only the office suite writes a BIFF8 workbook, from the XLSX workbook this engine writes (the worker's route)
  if (tgt === 'xls') {
    throw unconvertibleOfficeTarget(src, tgt);
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
    const odtBuffer = await generateOdtFromSource(inputBuffer, src, options, baseName);
    return {
      buffer: odtBuffer,
      mimeType: 'application/vnd.oasis.opendocument.text',
      filename: `${baseName}.odt`,
      size: odtBuffer.length,
    };
  }

  // 20. Target is EPUB (from MD, HTML, TXT, DOCX, etc.)
  if (tgt === 'epub') {
    const epubBuffer = await generateEpubFromSource(inputBuffer, src, options, baseName);
    return { buffer: epubBuffer, mimeType: 'application/epub+zip', filename: `${baseName}.epub`, size: epubBuffer.length };
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
    throw new UnsupportedTargetError(`Unsupported office conversion: target iWork format '${tgt}' is not supported`);
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
