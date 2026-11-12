import { ConversionOptions, ConversionResult } from '../../types';
import { readPptSlides } from './ppt-reader';
import { glyphCoverageOf } from '../pdf-fonts';
import { unconvertibleOfficeTarget } from '../native-engine-pairs';
import { chartTextLines, readEmbeddedCharts } from './odf-charts';
import { generateHtmlFromSlides, generatePdfFromSlides } from './slides-render';
import { generatePptxFromText } from './office-from-text';

/**
 * PowerPoint 97-2003 binary source. The slide text comes from the presentation's records in slide order
 * ([MS-PPT]); malformed or encrypted files throw typed errors instead of producing text.
 */
export async function convertPptSource(
  inputBuffer: Buffer,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  const warnings: string[] = [];
  const readSlides = readPptSlides(inputBuffer, warnings, await glyphCoverageOf(tgt));
  const slides = [];
  for (const slide of readSlides) slides.push({ ...slide, charts: await readEmbeddedCharts(slide.embedded, slide.number, warnings) });
  // The text targets list what the charts say as lines of the slide; the PDF draws the charts.
  const slidesWithChartText = slides.map((slide) => ({ ...slide, texts: [...slide.texts, ...slide.charts.flatMap(chartTextLines)] }));
  const withWarnings = (result: ConversionResult): ConversionResult => (warnings.length > 0 ? { ...result, metadata: { ...result.metadata, warnings } } : result);

  if (tgt === 'txt') {
    const text = slidesWithChartText
      .filter((slide) => slide.texts.length > 0)
      .map((slide) => slide.texts.join('\n'))
      .join('\n\n');
    const buffer = Buffer.from(text, 'utf-8');
    return withWarnings({ buffer, mimeType: 'text/plain', filename: `${baseName}.txt`, size: buffer.length });
  }

  if (tgt === 'html') {
    const html = generateHtmlFromSlides(slidesWithChartText, baseName);
    const buffer = Buffer.from(html, 'utf-8');
    return withWarnings({ buffer, mimeType: 'text/html', filename: `${baseName}.html`, size: buffer.length });
  }

  if (tgt === 'pdf') {
    const pdfBuffer = await generatePdfFromSlides(slides, baseName);
    return withWarnings({ buffer: pdfBuffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: pdfBuffer.length });
  }

  if (tgt === 'pptx') {
    const text = slidesWithChartText
      .filter((slide) => slide.texts.length > 0)
      .map((slide) => `# Slide ${slide.number}\n\n` + slide.texts.join('\n'))
      .join('\n\n---\n\n');
    const pptxBuffer = await generatePptxFromText(text, 'ppt', options, baseName);
    return withWarnings({
      buffer: pptxBuffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      filename: `${baseName}.pptx`,
      size: pptxBuffer.length,
    });
  }

  throw unconvertibleOfficeTarget('ppt', tgt);
}
