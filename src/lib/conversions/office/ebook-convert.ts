import { ConversionFailedError, ConversionOptions, ConversionResult, UnsupportedTargetError } from '../../types';
import { readEpubModel } from '../source-model';
import { documentToDocx } from '../document-model/docx';
import { decodeXmlBytes } from '../package-access';
import { safeExtractXmlElements } from '../safe-xml-scanner';
import { readFb2Model } from '../fb2-model';
import { readMobiModel } from '../mobi-model';
import { readMobiText } from './mobi-reader';
import PDFDocument from 'pdfkit';
import { bindComicPagesToPdf, comicPagesToEpub, readCbcPages, readComicPages } from '../comic-book';
import { readEpubText } from './text-extraction';
import { writeEbookTargetFromText } from './convert-generic';
import { convertModelTarget } from './convert-docx';
import { safeExtractAllText, safeExtractFirstXmlElement } from './xml-helpers';
import { escapeMarkupAttribute } from '../../text/escape';
import { generateDocxFromExtractedText, generateEpubFromText } from './office-from-text';
import { configurePdfKitFontFallback, renderSafePdfText } from './pdf-text';

/**
 * EPUB Source Parser & Converter
 */
export async function convertEpubSource(
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

  if (tgt === 'rtf') return writeEbookTargetFromText(extractedText, 'epub', tgt, options, baseName);

  if (tgt === 'html' || tgt === 'md' || tgt === 'pdf') {
    const model = await readEpubModel(inputBuffer);
    return convertModelTarget(model, tgt, options, baseName);
  }

  if (tgt === 'docx') {
    const docxBuffer = await documentToDocx(await readEpubModel(inputBuffer), { title: baseName, language: options.language });
    return {
      buffer: docxBuffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      filename: `${baseName}.docx`,
      size: docxBuffer.length,
    };
  }

  throw new UnsupportedTargetError(`Unsupported conversion from EPUB to ${tgt}`);
}

/** FB2: the most paragraphs one book may hold, and how far into the file the FictionBook root element must start. */
const FB2_MAX_PARAGRAPHS = 5_000_000;

const FB2_ROOT_SCAN_CHARS = 4096;

/** The text of a FictionBook: its paragraphs, then its tables, one line a row with tabs between the cells. */
function fb2TextWithTables(text: string, tables: string[][][]): string {
  if (tables.length === 0) return text;
  return text + '\n\n' + tables.map((t) => t.map((r) => r.join('\t')).join('\n')).join('\n\n');
}

/**
 * FictionBook 2 (FB2) Parser & Converter
 */
export async function convertFb2Source(
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

  // Paragraphs, poem lines, list items, subtitles and the authors of quotations, in document order.
  const paragraphs: string[] = [];
  for (const pEl of safeExtractXmlElements(bodyXml, ['p', 'v', 'subtitle', 'text-author', 'li'], { maxElements: FB2_MAX_PARAGRAPHS })) {
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

  if (tgt === 'rtf') return writeEbookTargetFromText(fb2TextWithTables(fullText, tables), 'fb2', tgt, options, baseName);

  if (tgt === 'txt') {
    const buffer = Buffer.from(fb2TextWithTables(fullText, tables), 'utf-8');
    return { buffer, mimeType: 'text/plain', filename: `${baseName}.txt`, size: buffer.length };
  }

  if (tgt === 'html') {
    let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeMarkupAttribute(bookTitle)}</title>`;
    html += `<style>body{font-family:system-ui,-apple-system,sans-serif;line-height:1.7;max-width:800px;margin:2rem auto;padding:0 1.5rem;color:#1F2340;}h1{color:#5C6BC0;}table{border-collapse:collapse;width:100%;margin:1.5rem 0;}th,td{border:1px solid #CCD2FC;padding:8px 12px;text-align:left;}th{background:#F0F2FE;}</style></head><body>`;
    html += `<h1>${escapeMarkupAttribute(bookTitle)}</h1>`;
    if (authorStr) html += `<p><em>${escapeMarkupAttribute(authorStr)}</em></p>`;
    html += paragraphs.map((p) => `<p>${escapeMarkupAttribute(p)}</p>`).join('\n');
    for (const t of tables) {
      html += '<table>';
      t.forEach((row, rIdx) => {
        html += '<tr>' + row.map((c) => `<${rIdx === 0 ? 'th' : 'td'}>${escapeMarkupAttribute(c)}</${rIdx === 0 ? 'th' : 'td'}>`).join('') + '</tr>';
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

  // The structured targets are written from the book's own structure: sections, headings, pictures, notes.
  if (tgt === 'epub' || tgt === 'pdf') {
    return convertModelTarget(await readFb2Model(xml, bookTitle), tgt, options, baseName);
  }

  if (tgt === 'docx') {
    let md = `# ${bookTitle}\n\n` + fullText;
    for (const t of tables) {
      if (t.length > 0) {
        md += `\n\n| ${t[0].join(' | ')} |\n| ${t[0].map(() => '---').join(' | ')} |\n` + t.slice(1).map((r) => `| ${r.join(' | ')} |`).join('\n');
      }
    }
    const docxBuffer = await generateDocxFromExtractedText(md, 'fb2', options, bookTitle);
    return {
      buffer: docxBuffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      filename: `${baseName}.docx`,
      size: docxBuffer.length,
    };
  }

  throw new UnsupportedTargetError(`Unsupported conversion from FB2 to ${tgt}`);
}

/**
 * MOBI / AZW3 / E-Book Parser & Converter
 */
export async function convertMobiSource(
  inputBuffer: Buffer,
  src: string,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  if ((src === 'mobi' || src === 'azw' || src === 'prc') && (tgt === 'epub' || tgt === 'pdf')) {
    // A book with markup is written from its structure (chapters, headings, pictures, cover); a plain PalmDOC book has none.
    const structured = await readMobiModel(inputBuffer, baseName);
    if (structured) return convertModelTarget(structured, tgt, options, baseName);
  }

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

  if (tgt === 'rtf') return writeEbookTargetFromText(fullText, src, tgt, options, baseName);

  if (tgt === 'pdf') {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    const p = new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (err) => reject(err));
    });
    const { hasUnicodeFont } = configurePdfKitFontFallback(doc);
    doc.fillColor('#1F2340').fontSize(18);
    renderSafePdfText(doc, baseName, hasUnicodeFont);
    doc.moveDown(1);
    doc.fillColor('#4D536B').fontSize(10.5).lineGap(3);
    renderSafePdfText(doc, fullText, hasUnicodeFont);
    doc.end();

    const buffer = await p;
    return { buffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: buffer.length };
  }

  throw new UnsupportedTargetError(`Unsupported conversion from ${src.toUpperCase()} to ${tgt}`);
}

/**
 * Delivers a PDF made from another source: as the PDF itself, or, for every other target, as the text of its pages
 * (the text layer, or OCR when the pages are pictures) written in that target. Pages with no recognisable text are a
 * typed 400 error, never an empty book.
 */
export async function viaPdf(pdf: Buffer, tgt: string, options: ConversionOptions, baseName: string): Promise<ConversionResult> {
  if (tgt === 'pdf') return { buffer: pdf, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: pdf.length };
  const { convertFile } = await import('../index');
  const extractText = async (ocrEnabled: boolean) =>
    (await convertFile(pdf, 'pdf', 'txt', { ...options, ocrEnabled, libreOfficeFilter: undefined }, `${baseName}.pdf`)).buffer.toString('utf-8').trim();
  // The text layer first; pages that are pictures have none, so they are read with OCR.
  let text = await extractText(false);
  if (text === '') text = await extractText(true);
  if (text === '') {
    throw new ConversionFailedError(`No text was recognised on the pages, so there is nothing to write as .${tgt}.`);
  }
  return writeEbookTargetFromText(text, 'pdf', tgt, options, baseName);
}

/** The targets of a comic archive: its pages bound as a PDF or as an image book, and the lettering of the pages read as text. */
export const COMIC_SOURCES: ReadonlySet<string> = new Set(['cbz', 'cbr']);

const COMIC_TARGETS: ReadonlySet<string> = new Set(['pdf', 'epub', 'txt', 'rtf']);

/**
 * Comic Book Zip (CBZ) and Comic Book RAR (CBR) sources: an archive of page images in natural name order. The PDF binds the
 * pages, one image per page, and the EPUB (which the Palm, Kindle, Sony and Open eBook writers read) is an image book with the
 * first page as its cover. A comic has no text layer, so the text and RTF targets read the lettering of the bound pages with
 * OCR and answer with a typed error when none is recognised, never with an empty file. A page that cannot be decoded, or an
 * archive without pages, fails with a typed 400 error; no page is replaced by text.
 */
export async function convertComicSource(
  inputBuffer: Buffer,
  src: string,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  if (!COMIC_TARGETS.has(tgt)) throw new UnsupportedTargetError(`Unsupported conversion from ${src.toUpperCase()} to ${tgt}`);
  const format = src.toUpperCase();
  const pages = await readComicPages(inputBuffer, src === 'cbr' ? 'cbr' : 'cbz');
  if (tgt === 'epub') return comicPagesToEpub(pages, format, baseName, options);
  const pdf = await bindComicPagesToPdf(pages, format, baseName);
  return viaPdf(pdf.buffer, tgt, options, baseName);
}

/**
 * Comic Book Collection (CBC) source: every volume's pages, volume after volume, bound like a CBZ. A comic has no
 * text layer, so the text and e-book targets read the lettering of the bound pages with OCR and answer with a typed
 * error when none is recognised.
 */
export async function convertCbcSource(
  inputBuffer: Buffer,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  const pdf = await bindComicPagesToPdf(await readCbcPages(inputBuffer), 'CBC', baseName);
  return viaPdf(pdf.buffer, tgt, options, baseName);
}
