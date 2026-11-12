import { ConversionFailedError, ConversionOptions, ConversionResult, UnsupportedTargetError } from '../../types';
import Papa from 'papaparse';
import { writeXlsx } from '../xlsx-writer';
import { assertReadableAsText } from './text-source-guard';
import { buildOpenXpsPackage } from '../openxps';
import { decodeXmlBytes, openPackage, readPackageEntry } from '../package-access';
import { InflateBudget } from '../bounded-inflate';
import { EPUB_MAX_CHAPTER_BYTES } from '../epub-reader';
import { htmlToText } from './html-text';
import { readPmlText } from './pml-reader';
import { extractRowsForOffice } from './sheet-extract';
import { generateOdsFromData, generateOdtFromText } from './odf-writers';
import { escapeMarkupAttribute } from '../../text/escape';
import { renderTableToRaster, renderTextToRaster } from './raster';
import { generatePdfFromDocx } from './docx-pdf';
import { generateDocxFromExtractedText, generateEpubFromText } from './office-from-text';
import { escapeRtf } from './rtf-escape';

export async function convertEtSource(
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
    const buffer = await writeXlsx(rows, 'detect');
    return { buffer, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `${baseName}.xlsx`, size: buffer.length };
  }

  if (tgt === 'ods') {
    const buffer = await generateOdsFromData(rows, baseName);
    return { buffer, mimeType: 'application/vnd.oasis.opendocument.spreadsheet', filename: `${baseName}.ods`, size: buffer.length };
  }

  if (tgt === 'html') {
    const tableRows = rows.map((r) => `<tr>${r.map((c) => `<td>${escapeMarkupAttribute(c)}</td>`).join('')}</tr>`).join('\n');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeMarkupAttribute(baseName)}</title><style>table { border-collapse: collapse; width: 100%; } td { border: 1px solid #ddd; padding: 8px; font-family: sans-serif; }</style></head><body><table>${tableRows}</table></body></html>`;
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

export async function convertGenericDocumentSource(
  inputBuffer: Buffer,
  src: string,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  assertReadableAsText(inputBuffer, src);

  const text = inputBuffer.toString('utf-8');
  if (text.trim() === '') throw new ConversionFailedError(`The .${src} file holds no text.`);

  if (tgt === 'docx') {
    const buffer = await generateDocxFromExtractedText(text, src, options, baseName);
    return { buffer, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', filename: `${baseName}.docx`, size: buffer.length };
  }
  if (tgt === 'odt') {
    const buffer = await generateOdtFromText(text, baseName);
    return { buffer, mimeType: 'application/vnd.oasis.opendocument.text', filename: `${baseName}.odt`, size: buffer.length };
  }
  if (tgt === 'html') {
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeMarkupAttribute(baseName)}</title></head><body><pre>${escapeMarkupAttribute(text)}</pre></body></html>`;
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

/** The text of an e-book in a ZIP wrapper (HTMLZ, TXTZ) or in a plain-text/markup file (OEB package, PML). */
async function readGenericEbookText(input: Buffer, src: string): Promise<string> {
  if (src === 'htmlz' || src === 'txtz') {
    const zip = await openPackage(input, src.toUpperCase());
    const budget = new InflateBudget();
    const mainName = src === 'htmlz' ? 'index.html' : 'index.txt';
    const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
    const entryName = names.includes(mainName) ? mainName : names.sort((a, b) => a.localeCompare(b)).find((name) => (src === 'htmlz' ? /\.(x?html?)$/i : /\.txt$/i).test(name));
    if (!entryName) throw new ConversionFailedError(`The ${src.toUpperCase()} archive has no ${mainName}.`);
    const decoded = decodeXmlBytes(await readPackageEntry(zip, entryName, EPUB_MAX_CHAPTER_BYTES, `${src.toUpperCase()} archive`, budget), `${src.toUpperCase()} text`);
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

export async function convertGenericEbookSource(inputBuffer: Buffer, src: string, tgt: string, options: ConversionOptions, baseName: string): Promise<ConversionResult> {
  if (src === 'rb') return (await import('../rocketbook-source')).convertRocketBookSource(inputBuffer, tgt, options, baseName, writeEbookTargetFromText);
  return writeEbookTargetFromText(await readGenericEbookText(inputBuffer, src), src, tgt, options, baseName);
}

/** Writes the text of an e-book in the targets the in-process engine writes for the e-book sources: EPUB, TXT, RTF, rasters and PDF (the Palm, Sony and Open eBook targets are calibre's). */
export async function writeEbookTargetFromText(
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
  if (tgt !== 'pdf') throw new UnsupportedTargetError(`Cannot write the text of a .${src} book as '.${tgt}'.`);
  const pdfBuffer = await generatePdfFromDocx([{ text, isHeading: false, isBold: false, isItalic: false }], [], options, baseName);
  return { buffer: pdfBuffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: pdfBuffer.length };
}
