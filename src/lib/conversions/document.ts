import JSZip from 'jszip';
import PDFDocument from 'pdfkit';
import { ConversionOptions, ConversionResult, ConversionFailedError, UnsupportedTargetError, EngineUnavailableError } from '../types';
import { buildOpenXpsPackage } from './openxps';
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
  performOcr,
  generateSearchablePdf,
  OcrResult,
  OcrPageResult,
  exportHocr,
  exportAlto,
  inspectPdfPagesTextDensity,
  evaluatePageOcrDecisions,
  assembleCombinedOcrResult,
} from './ocr';
import { OcrPageDecision, PdfPageAnalysis } from '../types';
import {
  extractTextFromPdf,
  extractEmbeddedImageFromPdf,
  extractStructuredTextFromPdf,
  parseToUnicodeCMap,
  extractPdfFontCMaps,
  recursiveXyCut,
  type PdfTextBlock,
  type PdfToUnicodeCMap,
  type XyCutOptions,
} from './pdf-utils';
import { extractRasterImagesFromPdf, ExtractedPdfImage } from './pdf-rasterizer';
import { createLosslessSandwichPdfFromPdf } from './ocr-pdf-combiner';
import { assertNoComplexScript } from './ctl';
import { analyzeDocumentLayout, DlaBoundingBox, DlaBlock, DlaPageLayout } from './dla-engine';

export {
  extractTextFromPdf,
  extractEmbeddedImageFromPdf,
  extractStructuredTextFromPdf,
  parseToUnicodeCMap,
  extractPdfFontCMaps,
  recursiveXyCut,
  analyzeDocumentLayout,
  extractTextFromOdt,
  extractTextFromDoc,
  renderDrawingMlToSvg,
  parseDrawingMlShapes,
  escapeRtf,
};
export type { DrawingMlShape, TableBorder, PdfTextBlock, PdfToUnicodeCMap, XyCutOptions, DlaBoundingBox, DlaBlock, DlaPageLayout };

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

  // PDF as source format
  if (src === 'pdf') {
    const structuredPdf = extractStructuredTextFromPdf(inputBuffer);
    let extractedText = structuredPdf.text;
    let ocrInfo: { text?: string; confidence?: number | null } = {};
    let lastOcrResult: OcrResult | null = null;
    const pageOcrResults = new Map<number, OcrResult>();

    // Inspect each page for existing text layer density to enable Smart Multi-Page OCR
    const pageAnalyses = await inspectPdfPagesTextDensity(
      inputBuffer,
      options.ocrDensityThreshold || 15
    ).catch(() => []);

    const ocrMode = options.ocrMode || 'skip_text';
    const { pageDecisions, pagesNeedingOcr } = evaluatePageOcrDecisions(pageAnalyses, ocrMode);

    // If scanned document or OCR is requested or target is hocr/alto
    const isScanned = !structuredPdf.hasTextLayer || !extractedText || extractedText.trim() === '';
    const shouldRunOcr = options.ocrEnabled || isScanned || tgt === 'hocr' || tgt === 'alto';

    if (shouldRunOcr && (pagesNeedingOcr.length > 0 || (pageAnalyses.length === 0 && (options.ocrEnabled || isScanned)))) {
      let rasterImages: ExtractedPdfImage[] = [];
      try {
        rasterImages = await extractRasterImagesFromPdf(
          inputBuffer,
          options.dpi || 300,
          pagesNeedingOcr.length > 0 ? new Set(pagesNeedingOcr) : undefined
        );
      } catch (err: any) {
        if (options.ocrEnabled) {
          const rawMsg = err?.message || 'Unsupported compression filter in PDF document.';
          const cleanMsg = rawMsg.startsWith('PDF OCR failed: ') ? rawMsg.replace('PDF OCR failed: ', '') : rawMsg;
          throw new Error(`PDF OCR failed: ${cleanMsg}`);
        }
      }

      if (rasterImages.length === 0 && options.ocrEnabled && pagesNeedingOcr.length > 0) {
        throw new ConversionFailedError('PDF OCR failed: PDF contains no renderable raster pages or images. Page rasterization requires the native worker.');
      }

      if (rasterImages.length > 0) {
        const ocrTexts: string[] = [];
        let totalConfidence = 0;
        let count = 0;

        for (const img of rasterImages) {
          const ocr = await performOcr(img.buffer, options.ocrLanguage);
          if (ocr && ocr.text) {
            ocrTexts.push(ocr.text);
            const existing = pageOcrResults.get(img.pageNumber);
            if (!existing) {
              pageOcrResults.set(img.pageNumber, ocr);
            } else {
              const mergedText = `${existing.text}\n\n${ocr.text}`;
              const mergedLines = [...existing.lines, ...ocr.lines];
              const mergedBlocks = [
                ...(existing.lineBlocks || []),
                ...(ocr.lineBlocks || []),
              ];
              const mergedConfidence =
                existing.confidence !== null && ocr.confidence !== null
                  ? (existing.confidence + ocr.confidence) / 2
                  : (existing.confidence ?? ocr.confidence);
              const mergedWordCount = existing.wordCount + ocr.wordCount;
              pageOcrResults.set(img.pageNumber, {
                text: mergedText,
                confidence: mergedConfidence,
                wordCount: mergedWordCount,
                lines: mergedLines,
                lineBlocks: mergedBlocks,
                imageWidth: Math.max(existing.imageWidth || 0, img.width),
                imageHeight: (existing.imageHeight || 0) + img.height,
              });
            }
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
            allTextParts.push(...ocrTexts);
          }
          extractedText = allTextParts.join('\n\n').trim();
          ocrInfo = {
            text: extractedText,
            confidence: count > 0 ? totalConfidence / count : 0.9,
          };
        } else if (options.ocrEnabled && pagesNeedingOcr.length > 0) {
          throw new Error('PDF OCR failed: Optical character recognition failed to detect readable text.');
        }
      } else if (options.ocrEnabled && pagesNeedingOcr.length > 0) {
        throw new Error('PDF OCR failed: Unsupported compression filter or no extractable raster image found in document.');
      }
    }

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
              confidence: (lb as any).confidence ?? ocr.confidence ?? 1.0,
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
                confidence: l.confidence ?? ocr.confidence ?? 1.0,
              });
            } else if (typeof l === 'string') {
              dlaBoxes.push({
                x: 50,
                y: lineY,
                width: 500,
                height: 20,
                text: l,
                confidence: ocr.confidence ?? 1.0,
              });
              lineY += 24;
            }
          }
        }
      }
    } else if (structuredPdf.blocks && structuredPdf.blocks.length > 0) {
      dlaBoxes = structuredPdf.blocks.map((b) => ({
        x: b.x,
        y: b.y,
        width: Math.max(1, b.width),
        height: Math.max(1, b.height),
        text: b.text,
        fontSize: b.fontSize,
      }));
    }

    const dlaLayout = dlaBoxes.length > 0 ? analyzeDocumentLayout(dlaBoxes, 612, 792) : null;

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
      };
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
      };
    }

    if (tgt === 'pdf') {
      if (options.ocrEnabled || isScanned) {
        if (pageOcrResults.size === 0 && !lastOcrResult && pagesNeedingOcr.length > 0) {
          throw new Error('PDF OCR failed: Unsupported compression filter or no extractable raster image found in document.');
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
            };
          } catch (pdfErr: any) {
            throw new ConversionFailedError(
              `PDF OCR failed: Failed to synthesize lossless searchable PDF: ${pdfErr?.message || 'Synthesis error'}`
            );
          }
        }
      }
      return {
        buffer: inputBuffer,
        mimeType: 'application/pdf',
        filename: `${baseName}.pdf`,
        size: inputBuffer.length,
        ocrExtractedText: ocrInfo.text,
        ocrConfidence: ocrInfo.confidence,
      };
    }

    if (tgt === 'hocr' || tgt === 'alto') {
      const combinedResult = assembleCombinedOcrResult(
        pageOcrResults,
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
    textContent = extractTextFromRtf(inputBuffer.toString('utf-8'));
  } else if (src === 'odt') {
    textContent = await extractTextFromOdt(inputBuffer);
  } else if (src === 'doc') {
    textContent = extractTextFromDoc(inputBuffer);
  } else if (src === 'tex') {
    textContent = extractTextFromTex(inputBuffer.toString('utf-8'));
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

  throw new Error(`Unsupported document conversion from ${sourceFormat} to ${targetFormat}`);
}

function markdownToHtml(md: string, title: string): string {
  // Convert markdown tables
  let processed = md;
  const tableRegex = /((?:\|[^\n]+\|\r?\n)+)/g;
  processed = processed.replace(tableRegex, (match) => {
    const lines = match.trim().split(/\r?\n/).map((l) => l.trim());
    if (lines.length < 2) return match;
    const headerRow = lines[0].split('|').slice(1, -1).map((c) => c.trim());
    const dataRows = lines.slice(2).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));

    let tableHtml = '<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;margin:1.5rem 0;width:100%;border-color:#CCD2FC;">\n<thead><tr>';
    headerRow.forEach((h) => {
      tableHtml += `<th style="background:#F0F2FE;color:#1F2340;padding:8px;text-align:left;">${escapeHtml(h)}</th>`;
    });
    tableHtml += '</tr></thead>\n<tbody>';
    dataRows.forEach((r) => {
      tableHtml += '<tr>';
      r.forEach((c) => {
        tableHtml += `<td style="padding:8px;border:1px solid #E1E4EE;">${escapeHtml(c)}</td>`;
      });
      tableHtml += '</tr>\n';
    });
    tableHtml += '</tbody></table>\n';
    return tableHtml;
  });

  let html = processed
    .replace(/^### (.*$)/gim, '<h3>$1</h3>')
    .replace(/^## (.*$)/gim, '<h2>$1</h2>')
    .replace(/^# (.*$)/gim, '<h1>$1</h1>')
    .replace(/\*\*\*(.*?)\*\*\*/gim, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/gim, '<em>$1</em>')
    .replace(/`([^`]+)`/gim, '<code>$1</code>')
    .replace(/\n\n+/g, '</p><p>')
    .replace(/\n/g, '<br/>');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; max-width: 800px; margin: 2rem auto; padding: 0 1rem; color: #1F2340; }
    h1, h2, h3 { color: #5C6BC0; }
    code { background: #F0F2FE; padding: 0.2rem 0.4rem; border-radius: 4px; font-family: monospace; font-size: 0.9em; }
    pre { background: #F8F9FF; border: 1px solid #CCD2FC; padding: 1rem; border-radius: 6px; overflow-x: auto; }
  </style>
</head>
<body>
  <p>${html}</p>
</body>
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

async function generatePdfFromText(
  text: string,
  sourceType: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  assertNoComplexScript(text, `Pure-TS ${sourceType.toUpperCase()} to PDF conversion`);

  return new Promise((resolve, reject) => {
    const isLandscape = options.orientation === 'landscape';
    const doc = new PDFDocument({
      size: 'A4',
      layout: isLandscape ? 'landscape' : 'portrait',
      margin: 50,
      info: {
        Title: baseName,
        Creator: 'EasyConvert Platform',
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => {
      const buffer = Buffer.concat(chunks);
      resolve({
        buffer,
        mimeType: 'application/pdf',
        filename: `${baseName}.pdf`,
        size: buffer.length,
      });
    });
    doc.on('error', (err) => reject(err));

    // Lavender-themed header bar
    doc.rect(50, 40, doc.page.width - 100, 3).fill('#5C6BC0');
    doc.moveDown(1.5);

    // Document Title
    doc.fillColor('#1F2340').fontSize(18).text(baseName, { underline: false });
    doc.moveDown(0.5);

    // Check for markdown tables if source is md
    const hasTable = sourceType === 'md' && /\|[^\n]+\|/.test(text);

    if (hasTable && options.preserveTables !== false) {
      // Parse markdown sections and tables
      const lines = text.split(/\r?\n/);
      let inTable = false;
      let tableRows: string[][] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('|') && line.endsWith('|')) {
          if (/^\|[\s\-:]+\|\s*$/.test(line)) {
            // Separator row
            continue;
          }
          const cells = line.split('|').slice(1, -1).map((c) => c.trim());
          tableRows.push(cells);
          inTable = true;
        } else {
          if (inTable && tableRows.length > 0) {
            // Render table
            renderPdfTable(doc, tableRows);
            tableRows = [];
            inTable = false;
          }
          if (line.startsWith('# ')) {
            doc.moveDown(0.5).fillColor('#5C6BC0').fontSize(14).text(line.replace(/^#+\s*/, ''));
          } else if (line.startsWith('## ')) {
            doc.moveDown(0.4).fillColor('#5C6BC0').fontSize(12).text(line.replace(/^#+\s*/, ''));
          } else if (line.length > 0) {
            doc.fillColor('#4D536B').fontSize(10).lineGap(3).text(line);
          }
        }
      }
      if (inTable && tableRows.length > 0) {
        renderPdfTable(doc, tableRows);
      }
    } else {
      const content =
        sourceType === 'html'
          ? stripHtmlTags(text)
          : sourceType === 'md'
          ? stripMarkdownSyntax(text)
          : text;

      // Document Body
      doc.fillColor('#4D536B').fontSize(10.5).lineGap(4).text(content);
    }

    // Footer
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.fillColor('#697089').fontSize(8.5).text(
        `Generated with EasyConvert — Page ${i + 1} of ${range.count}`,
        50,
        doc.page.height - 40,
        { align: 'center', width: doc.page.width - 100 }
      );
    }

    doc.end();
  });
}

function renderPdfTable(doc: any, rows: string[][]) {
  if (rows.length === 0) return;
  const colCount = Math.max(...rows.map((r) => r.length));
  const tableWidth = doc.page.width - 100;
  const colWidth = tableWidth / Math.max(1, colCount);

  doc.moveDown(0.5);

  rows.forEach((row, rIdx) => {
    const y = doc.y;
    if (y > doc.page.height - 70) {
      doc.addPage();
    }
    if (rIdx === 0) {
      doc.rect(50, doc.y, tableWidth, 20).fill('#F0F2FE');
      doc.fillColor('#1F2340').fontSize(9);
    } else {
      doc.fillColor('#4D536B').fontSize(8.5);
    }

    row.forEach((cell, cIdx) => {
      doc.text(cell, 55 + cIdx * colWidth, y + 4, {
        width: colWidth - 10,
        lineBreak: false,
      });
    });
    doc.y = y + 20;
  });

  doc.moveDown(0.5);
}


