import { renderModelTarget } from '../document-targets';
import { ConversionFailedError, ConversionOptions, ConversionResult, DecompressionLimitError, EngineUnavailableError, UnsupportedTargetError } from '../../types';
import JSZip from 'jszip';
import { InflateBudget } from '../bounded-inflate';
import { readZipEntryText } from '../zip-entry-reader';
import { safeExtractXmlElements } from '../safe-xml-scanner';
import { openPackage } from '../package-access';
import { readDocxModel } from '../docx-model';
import { documentToText } from '../document-model/text';
import { assertWellFormedXml } from '../xml-wellformed';
import { docxBodyModel, docxBodyText } from '../docx-body-text';
import { documentToOdt } from '../document-model/odt';
import { generateEpubFromText, generateFb2FromText, generatePptxFromText } from './office-from-text';
import { type WordTableStyle, parseDocxXml, parseWordStyles } from './docx-parse';
import { generateHtmlFromDocx, generateMarkdownFromDocx } from './docx-html';
import { generatePdfFromDocx } from './docx-pdf';

/** DOCX targets only LibreOffice writes. */
const DOCX_NATIVE_ENGINE_TARGETS: ReadonlySet<string> = new Set(['rtf', 'doc', 'jpg', 'png']);

/** Targets written from the structured DOCX model. */
const MODEL_DOCX_TARGETS: ReadonlySet<string> = new Set(['txt', 'html', 'md', 'pdf', 'epub', 'odt']);

export const convertModelTarget = renderModelTarget;

async function docxTextToPptx(text: string, options: ConversionOptions, baseName: string): Promise<ConversionResult> {
  const pptxBuffer = await generatePptxFromText(text, 'docx', options, baseName);
  return {
    buffer: pptxBuffer,
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    filename: `${baseName}.pptx`,
    size: pptxBuffer.length,
  };
}

async function loadDocxChartMap(zip: JSZip, budget: InflateBudget): Promise<Map<string, string>> {
  const chartMap = new Map<string, string>();
  const chartXmlByPath = new Map<string, string>();
  const readCached = async (entry: JSZip.JSZipObject): Promise<string> => {
    const existing = chartXmlByPath.get(entry.name);
    if (existing !== undefined) return existing;
    const text = await readZipEntryText(entry, { budget });
    chartXmlByPath.set(entry.name, text);
    return text;
  };
  const docRelsFile = zip.file('word/_rels/document.xml.rels');
  if (docRelsFile) {
    const relsXml = await readZipEntryText(docRelsFile, { budget });
    for (const rEl of safeExtractXmlElements(relsXml, 'Relationship')) {
      const rId = rEl.attrs.Id;
      const target = rEl.attrs.Target;
      if (!rId || !target) continue;
      const type = rEl.attrs.Type || '';
      if (!type.endsWith('/chart') && !/chart\d*\.xml$/i.test(target)) continue;
      const stripped = target.startsWith('/') ? target.slice(1) : target;
      const chartPath = stripped.startsWith('word/') ? stripped : `word/${stripped}`;
      const cFile = zip.file(chartPath) || zip.file(target);
      if (cFile) chartMap.set(rId, await readCached(cFile));
    }
  }
  for (const fName of Object.keys(zip.files)) {
    if (/^word\/charts\/chart\d+\.xml$/i.test(fName)) chartMap.set(fName, await readCached(zip.files[fName]));
  }
  return chartMap;
}

export async function convertDocxSource(inputBuffer: Buffer, tgt: string, options: ConversionOptions, baseName: string): Promise<ConversionResult> {
  const zip = await openPackage(inputBuffer, 'DOCX');
  const docXmlFile = zip.file('word/document.xml');
  if (!docXmlFile) throw new ConversionFailedError('Invalid DOCX format: word/document.xml not found.');
  if (MODEL_DOCX_TARGETS.has(tgt) || tgt === 'pptx') {
    const read = await readDocxModel(zip);
    if (!read.drawsShapes && MODEL_DOCX_TARGETS.has(tgt)) return convertModelTarget(read.model, tgt, options, baseName);
    if (!read.drawsShapes && tgt === 'pptx') return docxTextToPptx(documentToText(read.model), options, baseName);
  }
  const budget = new InflateBudget();
  const xmlText = await readZipEntryText(docXmlFile, { budget });
  assertWellFormedXml('word/document.xml', xmlText, 'DOCX');
  const chartMap = await loadDocxChartMap(zip, budget);
  let styleMap: Map<string, WordTableStyle> | undefined;
  const stylesFile = zip.file('word/styles.xml');
  if (stylesFile) {
    try {
      styleMap = parseWordStyles(await readZipEntryText(stylesFile, { budget }));
    } catch (err) {
      if (err instanceof DecompressionLimitError) throw err;
    }
  }
  const { paragraphs, tables, elements } = parseDocxXml(xmlText, chartMap, styleMap);

  // DOCX -> TXT
  if (tgt === 'txt') {
    const buffer = Buffer.from(docxBodyText(paragraphs, elements), 'utf-8');
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
    const epubBuffer = await generateEpubFromText(text, 'md', options, baseName);
    return { buffer: epubBuffer, mimeType: 'application/epub+zip', filename: `${baseName}.epub`, size: epubBuffer.length };
  }

  // DOCX -> PPTX
  if (tgt === 'pptx') {
    return docxTextToPptx(docxBodyText(paragraphs, elements), options, baseName);
  }

  // DOCX -> ODT
  if (tgt === 'odt') {
    const odtBuffer = await documentToOdt(docxBodyModel(paragraphs, elements), { title: baseName, language: options.language });
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

  if (DOCX_NATIVE_ENGINE_TARGETS.has(tgt)) {
    throw new EngineUnavailableError('soffice', `Converting DOCX to .${tgt} needs the native LibreOffice engine; the in-process engine has no writer for it.`);
  }
  throw new UnsupportedTargetError(`Cannot convert DOCX documents to '.${tgt}'.`);
}
