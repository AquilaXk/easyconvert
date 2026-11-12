import { ConversionFailedError, ConversionOptions, ConversionResult } from '../../types';
import { openPackage } from '../package-access';
import { InflateBudget } from '../bounded-inflate';
import { readZipEntryText } from '../zip-entry-reader';
import { PptxSymbolRuns } from './pptx-symbol-runs';
import { glyphCoverageOf } from '../pdf-fonts';
import { HTML_MAX_EMBEDDED_BASE64_CHARS, PptxMedia } from './pptx-media';
import { assertWellFormedXml } from '../xml-wellformed';
import { safeDecodeXmlEntities, safeExtractXmlElements } from '../safe-xml-scanner';
import { unconvertibleOfficeTarget } from '../native-engine-pairs';
import { safeExtractFirstXmlElement, safeFindColor } from './xml-helpers';
import { type VisualSlide, parsePptxSlideSceneGraph } from './pptx-scene';
import { identityMatrix } from './affine';
import { generateHtmlFromSlides, generatePdfFromSlides } from './slides-render';
import { generateDocxFromExtractedText } from './office-from-text';
import { generateOdpFromSlides } from './odf-writers';

export async function convertPptxSource(
  inputBuffer: Buffer,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  const zip = await openPackage(inputBuffer, 'PPTX');
  const slideBudget = new InflateBudget();

  // 1. Parse presentation slide size from ppt/presentation.xml (in EMUs, 12700 EMUs = 1 pt)
  let slideWidth = 960; // 16:9 standard width in points (12,192,000 EMUs)
  let slideHeight = 540; // 16:9 standard height in points (6,858,000 EMUs)

  const presFile = zip.file('ppt/presentation.xml');
  if (presFile) {
    const presXml = await readZipEntryText(presFile, { budget: slideBudget });
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
  const symbolRuns = new PptxSymbolRuns(await glyphCoverageOf(tgt));
  // Only the HTML and PDF targets draw pictures; an HTML page also cannot hold more than a string can.
  const media = new PptxMedia({
    enabled: tgt === 'html' || tgt === 'pdf',
    maxPartBytes: tgt === 'html' ? Math.floor(HTML_MAX_EMBEDDED_BASE64_CHARS / 4) * 3 : undefined,
    xmlBudget: slideBudget,
  });

  for (let i = 0; i < slideFiles.length; i++) {
    let xml = await readZipEntryText(zip.files[slideFiles[i]], { budget: slideBudget });
    assertWellFormedXml(slideFiles[i], xml, 'PPTX');
    xml = symbolRuns.map(xml);

    // Extract slide background color
    let backgroundColor: string | undefined;
    const bgEl = safeExtractFirstXmlElement(xml, 'p:bg');
    if (bgEl) {
      const bgClr = safeFindColor(bgEl.content);
      if (bgClr) backgroundColor = bgClr;
    }

    // Extract all text content
    const texts = safeExtractXmlElements(xml, 'a:t').map((tEl) => safeDecodeXmlEntities(tEl.content).trim()).filter(Boolean);

    // Load relationships for media and parts
    const relsFileName = slideFiles[i].replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels';
    const relsFile = zip.file(relsFileName);
    const relsMap = new Map<string, string>();
    if (relsFile) {
      const relsXml = await readZipEntryText(relsFile, { budget: slideBudget });
      for (const rEl of safeExtractXmlElements(relsXml, 'Relationship')) {
        if (rEl.attrs.Id && rEl.attrs.Target) {
          relsMap.set(rEl.attrs.Id, rEl.attrs.Target);
        }
      }
    }

    const shapes = await parsePptxSlideSceneGraph(xml, identityMatrix(), slideWidth, slideHeight, relsMap, zip, texts, media);

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
  symbolRuns.report();

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
    const pdfBuffer = await generatePdfFromSlides(slides, baseName);
    return { buffer: pdfBuffer, mimeType: 'application/pdf', filename: `${baseName}.pdf`, size: pdfBuffer.length };
  }

  // PPTX -> DOCX
  if (tgt === 'docx') {
    const text = slides.map((s) => `# Slide ${s.number}\n\n` + s.texts.join('\n')).join('\n\n---\n\n');
    const docxBuffer = await generateDocxFromExtractedText(text, 'pptx', options, baseName);
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

  throw unconvertibleOfficeTarget('pptx', tgt);
}

const POTX_TEMPLATE_MAIN_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml';

const PPTX_MAIN_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';

const CONTENT_TYPES_PART = '[Content_Types].xml';

/**
 * PowerPoint template source: an OpenXML package with the slide parts of a presentation, so it is read as
 * one. A package that is not a ZIP, or has no presentation part, fails with a typed 400 error.
 */
export async function convertPotxSource(
  inputBuffer: Buffer,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  const zip = await openPackage(inputBuffer, 'POTX', 'OpenXML package');
  const budget = new InflateBudget();
  if (!zip.file('ppt/presentation.xml')) {
    throw new ConversionFailedError('The POTX package has no ppt/presentation.xml part.');
  }
  if (tgt === 'pptx') {
    // The package becomes a presentation: its main part loses the template content type.
    const contentTypes = zip.file(CONTENT_TYPES_PART);
    if (!contentTypes) {
      throw new ConversionFailedError(`The POTX package has no ${CONTENT_TYPES_PART} part.`);
    }
    const xml = (await readZipEntryText(contentTypes, { budget })).replace(POTX_TEMPLATE_MAIN_CONTENT_TYPE, PPTX_MAIN_CONTENT_TYPE);
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
