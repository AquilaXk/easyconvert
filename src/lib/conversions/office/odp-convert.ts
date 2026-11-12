import { ConversionFailedError, ConversionOptions, ConversionResult } from '../../types';
import { openPackage } from '../package-access';
import { InflateBudget } from '../bounded-inflate';
import { readZipEntryText } from '../zip-entry-reader';
import { assertWellFormedXml } from '../xml-wellformed';
import { safeExtractXmlElements } from '../safe-xml-scanner';
import { unconvertibleOfficeTarget } from '../native-engine-pairs';
import { safeExtractAllText } from './xml-helpers';
import { generateHtmlFromSlides, generatePdfFromSlides } from './slides-render';
import { generateDocxFromExtractedText, generatePptxFromText } from './office-from-text';

/**
 * OpenDocument Presentation (ODP) Parser & Converter
 */
export async function convertOdpSource(
  inputBuffer: Buffer,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  const slides: { number: number; texts: string[] }[] = [];
  const zip = await openPackage(inputBuffer, 'ODP');
  const budget = new InflateBudget();
  const contentXmlFile = zip.file('content.xml');
  if (!contentXmlFile) throw new ConversionFailedError('The ODP file has no content.xml.');
  const xml = await readZipEntryText(contentXmlFile, { budget });
  assertWellFormedXml('content.xml', xml, 'ODP');
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
    const pdfBuffer = await generatePdfFromSlides(slides, baseName);
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
    const docxBuffer = await generateDocxFromExtractedText(text, 'odp', options, baseName);
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

  throw unconvertibleOfficeTarget('odp', tgt);
}
