import { remainingJobMs } from './job-time';
import { PdfPageFrameError } from './pdf-page-geometry';
import JSZip from 'jszip';
import { ConversionOptions, ConversionResult, ConversionFailedError, UnsupportedTargetError, EngineUnavailableError, OcrEngineUnavailableError, OcrLanguageUnavailableError } from '../types';
import { buildOpenXpsPackage } from './openxps';
import { unconvertibleOfficeTarget } from './native-engine-pairs';
import {
  convertOffice,
  extractTextFromRtf,
  generateOdtFromText,
  extractTextFromOdt,
  extractTextFromDoc,
  renderDrawingMlToSvg,
  parseDrawingMlShapes,
  escapeRtf,
  DrawingMlShape,
  TableBorder,
} from './office';
import {
  recognizeRenderedPdfPages,
  generateSearchablePdf,
  OcrResult,
  OcrPageResult,
  exportHocr,
  exportAlto,
  parseHocr,
  parseAlto,
  evaluatePageOcrDecisions,
  assembleCombinedOcrResult,
  STRUCTURED_OCR_TARGETS,
} from './ocr';
import { OcrPageDecision, PdfPageAnalysis } from '../types';
import { PdfTextGeometryError } from './pdf-text-types';
import { assertPdfHeader, extractPdfDocument, readPdfDocument, type ExtractedPdfDocument, type ReadPdfResult } from './pdf-text-document';
import { documentToHtml } from './document-model/html';
import { documentToMarkdown } from './document-model/markdown';
import { rethrowInputPixelLimit } from './image-input-limits';
import { createLosslessSandwichPdfFromPdf } from './ocr-pdf-combiner';
import { characterWeightedConfidence } from './ocr-calibration';
import { renderPdfBlocks, type PdfBlock } from './pdf-blocks';
import { parseHtmlToPdfBlocks } from './html-blocks';
import { decodeTextInput } from './text-input';
import { markdownToSafeHtml } from './markdown-pdf';
import { renderMarkdownFragment } from './markdown';
import { analyzeDocumentLayout, DlaBoundingBox, DlaBlock, DlaPageLayout } from './dla-engine';

/**
 * Facts about how the PDF's pages were recognized, for the result metadata: pages the WebAssembly engine failed on
 * and the native one read (`engineFallback`), and the engine's own markup when it was asked for (`ocrEngineMarkup`).
 * Undefined when there is nothing to report.
 */
function pdfOcrMetadata(results: Map<number, OcrResult>): Record<string, unknown> | undefined {
  const fallbacks = [...results].filter(([, result]) => result.engineFallback).map(([pageNumber, result]) => ({ pageNumber, ...result.engineFallback }));
  const markup = [...results].filter(([, result]) => result.engineMarkup).map(([pageNumber, result]) => ({ pageNumber, ...result.engineMarkup }));
  if (fallbacks.length === 0 && markup.length === 0) return undefined;
  return { ...(fallbacks.length > 0 ? { engineFallback: fallbacks } : {}), ...(markup.length > 0 ? { ocrEngineMarkup: markup } : {}) };
}

export {
  analyzeDocumentLayout,
  extractTextFromOdt,
  extractTextFromDoc,
  renderDrawingMlToSvg,
  parseDrawingMlShapes,
  escapeRtf,
  parseHocr,
  parseAlto,
};
export type { DrawingMlShape, TableBorder, DlaBoundingBox, DlaBlock, DlaPageLayout };

/**
 * Strips LaTeX macro commands
 */
export function extractTextFromTex(tex: string): string {
  return tex
    .replace(/\\(?:section|chapter|subsection)\*?\{([^}]+)\}/g, '$1\n\n')
    .replace(/\\[a-zA-Z]+(?:\[[^\]]*\])?(?:\{([^}]*)\})?/g, '$1 ')
    .replace(/[{}]/g, '')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
}

/** The text of a PDF (its text layer, in reading order); see `extractPdfDocument` for the failures. */
export async function extractTextFromPdf(pdfBuffer: Buffer): Promise<string> {
  return (await extractPdfDocument(pdfBuffer)).text;
}

export async function convertDocument(
  inputBuffer: Buffer,
  sourceFormat: string,
  targetFormat: string,
  options: ConversionOptions = {},
  originalFilename = 'file'
): Promise<ConversionResult> {
  const baseName = originalFilename.replace(/\.[^/.]+$/, '');
  const src = sourceFormat.toLowerCase();
  const tgt = targetFormat.toLowerCase();

  // Route Office formats to office engine
  if (
    ['docx', 'xlsx', 'pptx', 'epub', 'ods', 'odp', 'odt', 'xls'].includes(src) ||
    ['docx', 'xlsx', 'epub', 'pptx', 'ods', 'odp', 'odt', 'xls'].includes(tgt)
  ) {
    return convertOffice(inputBuffer, src, tgt, options, originalFilename);
  }

  // hOCR 1.2 XHTML and ALTO 4.x XML as source formats
  if (src === 'hocr' || src === 'alto') {
    const content = inputBuffer.toString('utf-8');
    const ocrResult = src === 'hocr' ? parseHocr(content) : parseAlto(content);

    // hOCR / ALTO to ALTO XML
    if (tgt === 'alto') {
      const xml = src === 'alto' ? content : exportAlto(ocrResult, { filename: originalFilename });
      const buffer = Buffer.from(xml, 'utf-8');
      return {
        buffer,
        mimeType: 'application/xml',
        filename: `${baseName}.xml`,
        size: buffer.length,
        ocrExtractedText: ocrResult.text,
        ocrConfidence: ocrResult.confidence,
      };
    }

    // hOCR / ALTO to hOCR XHTML
    if (tgt === 'hocr') {
      const html =
        src === 'hocr'
          ? content
          : exportHocr(ocrResult, { documentTitle: baseName, filename: originalFilename });
      const buffer = Buffer.from(html, 'utf-8');
      return {
        buffer,
        mimeType: 'application/xhtml+xml',
        filename: `${baseName}.hocr`,
        size: buffer.length,
        ocrExtractedText: ocrResult.text,
        ocrConfidence: ocrResult.confidence,
      };
    }

    // hOCR / ALTO to Plain Text (semantic extraction without HTML/XML markup)
    if (tgt === 'txt') {
      const buffer = Buffer.from(ocrResult.text, 'utf-8');
      return {
        buffer,
        mimeType: 'text/plain',
        filename: `${baseName}.txt`,
        size: buffer.length,
        ocrExtractedText: ocrResult.text,
        ocrConfidence: ocrResult.confidence,
      };
    }

    // hOCR / ALTO to HTML
    if (tgt === 'html') {
      const html =
        src === 'hocr'
          ? content
          : exportHocr(ocrResult, { documentTitle: baseName, filename: originalFilename });
      const buffer = Buffer.from(html, 'utf-8');
      return {
        buffer,
        mimeType: 'text/html',
        filename: `${baseName}.html`,
        size: buffer.length,
        ocrExtractedText: ocrResult.text,
        ocrConfidence: ocrResult.confidence,
      };
    }

    // hOCR / ALTO to PDF: render structured PDF with page dimensions
    if (tgt === 'pdf') {
      const res = await generatePdfFromText(ocrResult.text, src, options, baseName);
      return {
        ...res,
        ocrExtractedText: ocrResult.text,
        ocrConfidence: ocrResult.confidence,
      };
    }
  }

  // PDF as source format
  if (src === 'pdf') {
    assertPdfHeader(inputBuffer);
    let ocrInfo: { text?: string; confidence?: number | null } = {};
    let lastOcrResult: OcrResult | null = null;
    const pageOcrResults = new Map<number, OcrResult>();

    // The text layer, its structure, the per-page density (Smart Multi-Page OCR) and, for hOCR and ALTO, the word
    // geometry of pages that keep their own text come from one pass over the document. Fonts with no Unicode mapping
    // are refused unless OCR is on, which then recognizes those pages.
    const ocrMode = options.ocrMode || 'skip_text';
    const densityThreshold = options.ocrDensityThreshold || 15;
    const geometryWanted = (tgt === 'hocr' || tgt === 'alto') && ocrMode !== 'force' && ocrMode !== 'redo';
    let read: ReadPdfResult | null = null;
    try {
      read = await readPdfDocument(inputBuffer, {
        densityThreshold,
        geometry: geometryWanted ? 'text-pages' : 'none',
        onUnmapped: options.ocrEnabled ? 'omit' : 'throw',
        images: tgt === 'html' || tgt === 'md',
      });
    } catch (err) {
      // A document pdfjs cannot read is recognized as displayed when OCR was asked for; otherwise it is refused.
      if (!(options.ocrEnabled && err instanceof PdfTextGeometryError)) throw err;
    }
    const structuredPdf: ExtractedPdfDocument | null = read?.extracted ?? null;
    let extractedText = structuredPdf?.text ?? '';
    const pageAnalyses: PdfPageAnalysis[] = read?.analyses ?? [];
    // Word geometry of pages that keep their own text layer.
    const textLayerResults = read?.geometry ?? new Map<number, OcrResult>();

    const { pageDecisions, pagesNeedingOcr } = evaluatePageOcrDecisions(pageAnalyses, ocrMode);

    // If scanned document or OCR is requested or target is hocr/alto
    const isScanned = extractedText.trim() === '';
    const shouldRunOcr = options.ocrEnabled || isScanned || tgt === 'hocr' || tgt === 'alto';

    if (shouldRunOcr && (pagesNeedingOcr.length > 0 || (pageAnalyses.length === 0 && (options.ocrEnabled || isScanned)))) {
      // The pages are recognized as displayed (rendered by Poppler), not read from the images they contain.
      let recognizedPages = new Map<number, OcrResult>();
      try {
        recognizedPages = await recognizeRenderedPdfPages(inputBuffer, pagesNeedingOcr.length > 0 ? new Set(pagesNeedingOcr) : undefined, {
          dpi: options.dpi,
          language: options.ocrLanguage,
          detectOrientation: options.ocrDetectOrientation,
          engineMarkup: options.ocrEngineMarkup,
          parallelBands: STRUCTURED_OCR_TARGETS.has(tgt) ? false : undefined,
          jobDeadlineMs: remainingJobMs(options),
          signal: options.signal,
        });
      } catch (err: unknown) {
        // An input over the pixel limit is refused whether or not OCR was asked for, never answered empty.
        rethrowInputPixelLimit(err);
        // OCR that nobody asked for (a scanned page converted to text) is best effort when no engine can render the
        // pages; the text stays as extracted. A requested OCR, or a target that is OCR output, never is.
        // A page tree that cannot be walked leaves nothing to render either, so it is treated the same way.
        const optional = !options.ocrEnabled && tgt !== 'hocr' && tgt !== 'alto';
        const cannotRender = (err instanceof OcrEngineUnavailableError && !(err instanceof OcrLanguageUnavailableError)) || err instanceof PdfPageFrameError;
        if (!(optional && cannotRender)) {
          if (err instanceof ConversionFailedError) throw err;
          const rawMsg = err instanceof Error ? err.message : String(err);
          throw new ConversionFailedError(`PDF OCR failed: ${rawMsg.startsWith('PDF OCR failed: ') ? rawMsg.replace('PDF OCR failed: ', '') : rawMsg}`);
        }
      }

      if (recognizedPages.size > 0) {
        const ocrTexts: string[] = [];
        const ocrTextPages: { pageNumber: number; text: string }[] = [];
        let totalConfidence = 0;
        let count = 0;

        for (const [pageNumber, ocr] of [...recognizedPages].sort(([a], [b]) => a - b)) {
          if (ocr.text) {
            ocrTexts.push(ocr.text);
            ocrTextPages.push({ pageNumber, text: ocr.text });
            pageOcrResults.set(pageNumber, ocr);
            lastOcrResult = ocr;
            if (ocr.confidence !== null) {
              totalConfidence += ocr.confidence;
              count++;
            }
          }
        }

        if (ocrTexts.length > 0) {
          const allTextParts: string[] = [];
          if (pageAnalyses.length > 0) {
            for (const pa of pageAnalyses) {
              const ocr = pageOcrResults.get(pa.pageNumber);
              if (ocr) {
                allTextParts.push(ocr.text);
              } else if (pa.text) {
                allTextParts.push(pa.text);
              }
            }
          } else {
            allTextParts.push(...ocrTextPages.map((page) => page.text));
          }
          extractedText = allTextParts.join('\n\n').trim();
          // No recognized word had a confidence: the page is read, but how well is not known, so none is reported.
          ocrInfo = {
            text: extractedText,
            confidence: count > 0 ? totalConfidence / count : null,
          };
        } else if (options.ocrEnabled && pagesNeedingOcr.length > 0) {
          throw new ConversionFailedError('PDF OCR failed: Optical character recognition failed to detect readable text.');
        }
      } else if (options.ocrEnabled && pagesNeedingOcr.length > 0) {
        throw new ConversionFailedError('PDF OCR failed: no page could be rendered and recognized.');
      }
    }

    const ocrMetadata = pdfOcrMetadata(pageOcrResults);

    // Collect bounding boxes for Document Layout Analysis (DLA)
    let dlaBoxes: DlaBoundingBox[] = [];
    if (pageOcrResults.size > 0) {
      for (const [, ocr] of pageOcrResults) {
        if (ocr.lineBlocks && ocr.lineBlocks.length > 0) {
          for (const lb of ocr.lineBlocks) {
            const b = lb.bbox as any;
            const x = b.x ?? b.x0 ?? 0;
            const y = b.y ?? b.y0 ?? 0;
            const width = b.width ?? (b.x1 != null ? Math.max(1, b.x1 - x) : 100);
            const height = b.height ?? (b.y1 != null ? Math.max(1, b.y1 - y) : 20);
            dlaBoxes.push({
              x,
              y,
              width,
              height,
              text: lb.text,
              confidence: characterWeightedConfidence([lb]) ?? ocr.confidence ?? undefined,
            });
          }
        } else if (ocr.lines && ocr.lines.length > 0) {
          let lineY = 0;
          for (const l of (ocr.lines as any[])) {
            if (typeof l === 'object' && l !== null && l.bbox) {
              const b = l.bbox as any;
              const x = b.x ?? b.x0 ?? 0;
              const y = b.y ?? b.y0 ?? 0;
              const width = b.width ?? (b.x1 != null ? Math.max(1, b.x1 - x) : 100);
              const height = b.height ?? (b.y1 != null ? Math.max(1, b.y1 - y) : 20);
              dlaBoxes.push({
                x,
                y,
                width,
                height,
                text: l.text || '',
                confidence: l.confidence ?? ocr.confidence ?? undefined,
              });
            } else if (typeof l === 'string') {
              dlaBoxes.push({
                x: 50,
                y: lineY,
                width: 500,
                height: 20,
                text: l,
                confidence: ocr.confidence ?? undefined,
              });
              lineY += 24;
            }
          }
        }
      }
    }

    // The boxes of several scanned pages all start at the top of their own page: analysed together they interleave
    // by height, so a multi-page scan keeps its text in page order instead of going through the layout analysis.
    // The layout is measured against the page the boxes are on (the render's pixels for a recognized page, the
    // page's points for its text); a page of unknown size gets no layout, not an assumed one.
    const [layoutPage] = pageOcrResults.size === 1 ? [...pageOcrResults.values()] : [];
    const layoutWidth = layoutPage ? layoutPage.imageWidth : pageAnalyses[0]?.width;
    const layoutHeight = layoutPage ? layoutPage.imageHeight : pageAnalyses[0]?.height;
    const dlaLayout =
      dlaBoxes.length > 0 && pageOcrResults.size <= 1 && layoutWidth && layoutHeight
        ? analyzeDocumentLayout(dlaBoxes, layoutWidth, layoutHeight)
        : null;

    if (tgt === 'txt') {
      const textToEmit = dlaLayout && dlaLayout.fullText ? dlaLayout.fullText : extractedText;
      const buffer = Buffer.from(textToEmit, 'utf-8');
      return {
        buffer,
        mimeType: 'text/plain',
        filename: `${baseName}.txt`,
        size: buffer.length,
        ocrExtractedText: ocrInfo.text,
        ocrConfidence: ocrInfo.confidence,
        ...(ocrMetadata ? { metadata: ocrMetadata } : {}),
      };
    }

    // Pages that keep their own text are written from the structure the layout analysis found (headings, lists,
    // tables, columns); the layout of recognized pages is that of the OCR boxes, below.
    const structured = structuredPdf !== null && pageOcrResults.size === 0 && extractedText.trim() !== '' ? structuredPdf.model : null;

    if (tgt === 'html' && structured) {
      const buffer = Buffer.from(documentToHtml(structured, baseName), 'utf-8');
      return { buffer, mimeType: 'text/html', filename: `${baseName}.html`, size: buffer.length };
    }

    if (tgt === 'md' && structured) {
      const buffer = Buffer.from(`${documentToMarkdown(structured)}\n`, 'utf-8');
      return { buffer, mimeType: 'text/markdown', filename: `${baseName}.md`, size: buffer.length };
    }

    if (tgt === 'html') {
      let bodyContent: string;
      if (dlaLayout && dlaLayout.blocks.length > 0) {
        bodyContent = dlaLayout.blocks
          .map((b) => {
            switch (b.type) {
              case 'header':
                return `<header style="font-size:0.875rem;color:#6E768E;border-bottom:1px solid #E1E4EE;margin-bottom:1.5rem;padding-bottom:0.5rem;">${escapeHtml(b.text)}</header>`;
              case 'footer':
                return `<footer style="font-size:0.875rem;color:#6E768E;border-top:1px solid #E1E4EE;margin-top:2rem;padding-top:0.5rem;text-align:center;">${escapeHtml(b.text)}</footer>`;
              case 'heading':
                return `<h2 style="font-size:1.5rem;color:#1F2340;margin-top:1.5rem;margin-bottom:0.5rem;">${escapeHtml(b.text)}</h2>`;
              case 'list_item':
                return `<ul style="margin:0 0 0.5rem 1.5rem;padding:0;"><li>${escapeHtml(b.text.replace(/^[•\-\*]\s*/, ''))}</li></ul>`;
              case 'table':
                return `<table border="1" cellpadding="6" style="border-collapse:collapse;width:100%;margin-bottom:1rem;border-color:#CCD2FC;"><tr><td>${escapeHtml(b.text)}</td></tr></table>`;
              case 'paragraph':
              default:
                return `<p style="margin-bottom:1rem;color:#373D54;">${escapeHtml(b.text)}</p>`;
            }
          })
          .join('\n');
      } else {
        bodyContent = `<pre>${escapeHtml(extractedText)}</pre>`;
      }

      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(
        baseName
      )}</title><style>body { font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; padding: 2rem; max-width: 800px; margin: 0 auto; }</style></head><body>${bodyContent}</body></html>`;
      const buffer = Buffer.from(html, 'utf-8');
      return {
        buffer,
        mimeType: 'text/html',
        filename: `${baseName}.html`,
        size: buffer.length,
        ocrExtractedText: ocrInfo.text,
        ocrConfidence: ocrInfo.confidence,
        ...(ocrMetadata ? { metadata: ocrMetadata } : {}),
      };
    }

    if (tgt === 'md') {
      let mdText: string;
      if (dlaLayout && dlaLayout.blocks.length > 0) {
        mdText = dlaLayout.blocks
          .map((b) => {
            switch (b.type) {
              case 'header':
                return `*${b.text}*\n\n---`;
              case 'footer':
                return `---\n*${b.text}*`;
              case 'heading':
                return `## ${b.text}`;
              case 'list_item':
                return `- ${b.text.replace(/^[•\-\*]\s*/, '')}`;
              case 'table':
                return `| ${b.text} |`;
              case 'paragraph':
              default:
                return b.text;
            }
          })
          .join('\n\n');
      } else {
        mdText = extractedText;
      }
      const buffer = Buffer.from(mdText, 'utf-8');
      return {
        buffer,
        mimeType: 'text/markdown',
        filename: `${baseName}.md`,
        size: buffer.length,
        ocrExtractedText: ocrInfo.text,
        ocrConfidence: ocrInfo.confidence,
        ...(ocrMetadata ? { metadata: ocrMetadata } : {}),
      };
    }

    if (tgt === 'pdf') {
      if (options.ocrEnabled || isScanned) {
        if (pageOcrResults.size === 0 && !lastOcrResult && pagesNeedingOcr.length > 0) {
          throw new ConversionFailedError('PDF OCR failed: Unsupported compression filter or no extractable raster image found in document.');
        }

        if (pageOcrResults.size > 0) {
          try {
            const searchablePdf = await createLosslessSandwichPdfFromPdf(inputBuffer, pageOcrResults);
            return {
              buffer: searchablePdf,
              mimeType: 'application/pdf',
              filename: `${baseName}.pdf`,
              size: searchablePdf.length,
              ocrExtractedText: ocrInfo.text,
              ocrConfidence: ocrInfo.confidence,
              ...(ocrMetadata ? { metadata: ocrMetadata } : {}),
            };
          } catch (pdfErr: any) {
            throw new ConversionFailedError(
              `PDF OCR failed: Failed to synthesize lossless searchable PDF: ${pdfErr?.message || 'Synthesis error'}`
            );
          }
        }
      }
      if (options.ocrEnabled || isScanned) {
        // OCR recognised nothing. That is only acceptable when it had nothing to do: skip_text and every page already has text.
        if (pageAnalyses.length > 0 && pagesNeedingOcr.length === 0 && !isScanned) {
          return {
            buffer: inputBuffer,
            mimeType: 'application/pdf',
            filename: `${baseName}.pdf`,
            size: inputBuffer.length,
            ocrSkipped: true,
          };
        }
        throw new ConversionFailedError('PDF OCR failed: no text was recognised on any page.');
      }
      return {
        buffer: inputBuffer,
        mimeType: 'application/pdf',
        filename: `${baseName}.pdf`,
        size: inputBuffer.length,
        ocrExtractedText: ocrInfo.text,
        ocrConfidence: ocrInfo.confidence,
        ...(ocrMetadata ? { metadata: ocrMetadata } : {}),
      };
    }

    if (tgt === 'hocr' || tgt === 'alto') {
      // Pages OCR recognized keep their OCR result; the others take their word boxes from the text layer.
      const combinedResult = assembleCombinedOcrResult(
        new Map([...textLayerResults, ...pageOcrResults]),
        pageAnalyses,
        extractedText,
        ocrInfo.confidence
      );
      const isHocr = tgt === 'hocr';
      const xml = isHocr
        ? exportHocr(combinedResult, { documentTitle: baseName, filename: originalFilename })
        : exportAlto(combinedResult, { filename: originalFilename });
      const buffer = Buffer.from(xml, 'utf-8');
      return {
        buffer,
        mimeType: isHocr ? 'application/xhtml+xml' : 'application/xml',
        filename: `${baseName}.${isHocr ? 'hocr' : 'xml'}`,
        size: buffer.length,
        ocrExtractedText: combinedResult.text,
        ocrConfidence: combinedResult.confidence,
        ...(ocrMetadata ? { metadata: ocrMetadata } : {}),
      };
    }

    if (tgt === 'png' || tgt === 'jpg' || tgt === 'jpeg' || tgt === 'tiff' || tgt === 'tif' || tgt === 'ppm') {
      throw new EngineUnavailableError(
        'pdftoppm',
        'PDF page rasterization requires the native worker with Poppler pdftoppm.'
      );
    }

    if (tgt === 'svg') {
      throw new UnsupportedTargetError(
        `Direct PDF to ${tgt.toUpperCase()} conversion without vector graphics renderer is unsupported.`
      );
    }

    if (tgt === 'dxf') {
      throw new UnsupportedTargetError(
        `Direct PDF to ${tgt.toUpperCase()} conversion without vector CAD geometry is unsupported.`
      );
    }

    if (tgt === 'rtf') {
      const rtf = `{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Times New Roman;}}\\fs24 ${escapeRtf(extractedText)}}\n`;
      const buffer = Buffer.from(rtf, 'utf-8');
      return {
        buffer,
        mimeType: 'application/rtf',
        filename: `${baseName}.rtf`,
        size: buffer.length,
      };
    }
  }

  // Extract text representation according to source format
  let textContent = '';
  if (src === 'rtf') {
    textContent = extractTextFromRtf(inputBuffer);
  } else if (src === 'odt') {
    textContent = await extractTextFromOdt(inputBuffer);
  } else if (src === 'doc') {
    textContent = extractTextFromDoc(inputBuffer);
  } else if (src === 'tex') {
    textContent = extractTextFromTex(inputBuffer.toString('utf-8'));
  } else if (STRICT_TEXT_PDF_SOURCES.has(src) && tgt === 'pdf') {
    // Rendered text must be exactly the input text: non-UTF-8 bytes fail instead of becoming mojibake.
    textContent = decodeTextInput(inputBuffer);
  } else {
    textContent = inputBuffer.toString('utf-8');
  }

  // Convert to PDF
  if (tgt === 'pdf') {
    return generatePdfFromText(textContent, src, options, baseName);
  }

  // Convert to Plain Text
  if (tgt === 'txt') {
    const cleanText =
      src === 'html'
        ? stripHtmlTags(textContent)
        : src === 'md'
        ? stripMarkdownSyntax(textContent)
        : textContent;
    const buffer = Buffer.from(cleanText, 'utf-8');
    return {
      buffer,
      mimeType: 'text/plain',
      filename: `${baseName}.txt`,
      size: buffer.length,
    };
  }

  // Convert to HTML
  if (tgt === 'html') {
    const html =
      src === 'md'
        ? markdownToHtml(textContent, baseName)
        : `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(
            baseName
          )}</title><style>body { font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; padding: 2rem; max-width: 800px; margin: 0 auto; color:#1F2340; }h1{color:#5C6BC0;}</style></head><body><h1>${escapeHtml(
            baseName
          )}</h1><pre>${escapeHtml(textContent)}</pre></body></html>`;
    const buffer = Buffer.from(html, 'utf-8');
    return {
      buffer,
      mimeType: 'text/html',
      filename: `${baseName}.html`,
      size: buffer.length,
    };
  }

  // Convert to Markdown
  if (tgt === 'md') {
    const md = src === 'html' ? htmlToMarkdown(textContent) : textContent;
    const buffer = Buffer.from(md, 'utf-8');
    return {
      buffer,
      mimeType: 'text/markdown',
      filename: `${baseName}.md`,
      size: buffer.length,
    };
  }

  // Convert to ODT
  if (tgt === 'odt') {
    const odtBuffer = await generateOdtFromText(textContent, baseName);
    return {
      buffer: odtBuffer,
      mimeType: 'application/vnd.oasis.opendocument.text',
      filename: `${baseName}.odt`,
      size: odtBuffer.length,
    };
  }

  // Convert to OpenXPS / XPS
  if (tgt === 'xps' || tgt === 'oxps') {
    const lines = textContent.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const buffer = await buildOpenXpsPackage([{ title: baseName, lines }], baseName);
    return {
      buffer,
      mimeType: 'application/oxps',
      filename: `${baseName}.${tgt}`,
      size: buffer.length,
    };
  }

  throw unconvertibleOfficeTarget(src, tgt);
}

// Defense in depth for the generated page: no script execution or network access beyond images,
// even if a future renderer change let active content through.
const MARKDOWN_HTML_CSP =
  "default-src 'none'; img-src http: https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

function markdownToHtml(md: string, title: string): string {
  const body = renderMarkdownFragment(md);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${MARKDOWN_HTML_CSP}">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; max-width: 800px; margin: 2rem auto; padding: 0 1rem; color: #1F2340; }
    h1, h2, h3 { color: #5C6BC0; }
    code { background: #F0F2FE; padding: 0.2rem 0.4rem; border-radius: 4px; font-family: monospace; font-size: 0.9em; }
    pre { background: #F8F9FF; border: 1px solid #CCD2FC; padding: 1rem; border-radius: 6px; overflow-x: auto; }
    pre code { background: none; padding: 0; }
    blockquote { margin: 1rem 0; padding: 0 1rem; border-left: 4px solid #CCD2FC; color: #4A5078; }
    table { border-collapse: collapse; margin: 1.5rem 0; width: 100%; }
    th, td { border: 1px solid #E1E4EE; padding: 8px; text-align: left; }
    th { background: #F0F2FE; color: #1F2340; }
    img { max-width: 100%; }
  </style>
</head>
<body>
${body}</body>
</html>`;
}

function htmlToMarkdown(html: string): string {
  return html
    .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n')
    .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n')
    .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n')
    .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<b[^>]*>(.*?)<\/b>/gi, '**$1**')
    .replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*')
    .replace(/<i[^>]*>(.*?)<\/i>/gi, '*$1*')
    .replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`')
    .replace(/<br\s*[\/]?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

function stripMarkdownSyntax(md: string): string {
  return md
    .replace(/^#+\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
    .trim();
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Text sources decoded strictly (UTF-8, or UTF-16 with a byte order mark) when rendered to PDF. */
const STRICT_TEXT_PDF_SOURCES: ReadonlySet<string> = new Set(['txt', 'md', 'html', 'htm']);
/** Source formats parsed as HTML when rendered to PDF. */
const HTML_SOURCE_FORMATS: ReadonlySet<string> = new Set(['html', 'htm']);
const MARKDOWN_SOURCE_FORMAT = 'md';
const FORM_FEED = '\f';

/** Plain text as preformatted blocks; a form feed starts a new page. */
function plainTextToPdfBlocks(text: string): PdfBlock[] {
  const blocks: PdfBlock[] = [];
  text
    .replace(/^\ufeff/, '')
    .split(FORM_FEED)
    .forEach((page, index) => {
      if (index > 0) blocks.push({ kind: 'pageBreak' });
      blocks.push({ kind: 'preformatted', text: page });
    });
  return blocks;
}

/**
 * Renders text, Markdown or HTML to PDF in-process. The page holds only the document content,
 * drawn with embedded fonts that cover every character (EngineUnavailableError otherwise).
 */
async function generatePdfFromText(
  text: string,
  sourceType: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  let blocks: PdfBlock[];
  let title = baseName;
  let warnings: string[] = [];
  if (HTML_SOURCE_FORMATS.has(sourceType) || sourceType === MARKDOWN_SOURCE_FORMAT) {
    // Markdown goes through the escaping renderer: raw HTML and `<...>` text stay literal.
    const html = sourceType === MARKDOWN_SOURCE_FORMAT ? markdownToSafeHtml(text, baseName) : text;
    const parsed = await parseHtmlToPdfBlocks(html, { requireResources: options.requireResources });
    blocks = parsed.blocks;
    title = parsed.title || baseName;
    warnings = parsed.warnings;
  } else {
    blocks = plainTextToPdfBlocks(text);
  }

  const buffer = await renderPdfBlocks(blocks, { orientation: options.orientation, title });
  return {
    buffer,
    mimeType: 'application/pdf',
    filename: `${baseName}.pdf`,
    size: buffer.length,
    ...(warnings.length > 0 ? { metadata: { warnings } } : {}),
  };
}
