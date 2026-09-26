import JSZip from 'jszip';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import { ConversionOptions, ConversionResult } from '../types';
import { convertOffice, extractTextFromRtf, generateOdtFromText } from './office';
import { performOcr, generateSearchablePdf, OcrResult } from './ocr';
import { extractTextFromPdf, extractEmbeddedImageFromPdf } from './pdf-utils';
import { extractRasterImagesFromPdf, ExtractedPdfImage } from './pdf-rasterizer';
import { svgToDxf } from './vector-cad';

export { extractTextFromPdf, extractEmbeddedImageFromPdf };

/**
 * Extracts plain text from ODT OpenDocument Text zip archive
 */
export async function extractTextFromOdt(buffer: Buffer): Promise<string> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const contentXml = zip.file('content.xml');
    if (contentXml) {
      const xml = await contentXml.async('text');
      const paragraphs: string[] = [];
      const pRegex = /<text:(?:p|h)[^>]*>([\s\S]*?)<\/text:(?:p|h)>/g;
      let m: RegExpExecArray | null;
      while ((m = pRegex.exec(xml)) !== null) {
        const text = m[1].replace(/<[^>]+>/g, '').trim();
        if (text) paragraphs.push(text);
      }
      return paragraphs.join('\n\n');
    }
  } catch {
    // fallback
  }
  return buffer.toString('utf-8');
}

/**
 * Extracts readable text streams from binary legacy DOC (Word) files
 */
export function extractTextFromDoc(buffer: Buffer): string {
  const strings: string[] = [];
  let curr = '';
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];
    if (byte >= 32 && byte <= 126) {
      curr += String.fromCharCode(byte);
    } else if (byte === 10 || byte === 13) {
      if (curr.trim().length >= 4) strings.push(curr.trim());
      curr = '';
    } else {
      if (curr.trim().length >= 5) strings.push(curr.trim());
      curr = '';
    }
  }
  if (curr.trim().length >= 4) strings.push(curr.trim());
  return strings.join('\n\n') || 'Extracted document content.';
}

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
  originalFilename: string
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
    let extractedText = extractTextFromPdf(inputBuffer);
    let ocrInfo: { text?: string; confidence?: number } = {};
    let lastOcrResult: OcrResult | null = null;

    // If scanned document or OCR is requested
    const isScanned = extractedText === 'No extractable text found in PDF document.';
    if (options.ocrEnabled || isScanned) {
      let rasterImages: ExtractedPdfImage[] = [];
      try {
        rasterImages = await extractRasterImagesFromPdf(inputBuffer, options.dpi || 300);
      } catch (err: any) {
        if (options.ocrEnabled) {
          const rawMsg = err?.message || 'Unsupported compression filter in PDF document.';
          const cleanMsg = rawMsg.startsWith('PDF OCR failed: ') ? rawMsg.replace('PDF OCR failed: ', '') : rawMsg;
          throw new Error(`PDF OCR failed: ${cleanMsg}`);
        }
      }

      if (rasterImages.length > 0) {
        const ocrTexts: string[] = [];
        let totalConfidence = 0;
        let count = 0;

        for (const img of rasterImages) {
          const ocr = await performOcr(img.buffer, options.ocrLanguage);
          if (ocr && ocr.text) {
            ocrTexts.push(ocr.text);
            lastOcrResult = ocr;
            totalConfidence += ocr.confidence;
            count++;
          }
        }

        if (ocrTexts.length > 0) {
          extractedText = ocrTexts.join('\n\n');
          ocrInfo = {
            text: extractedText,
            confidence: count > 0 ? totalConfidence / count : 0.9,
          };
        } else if (options.ocrEnabled) {
          throw new Error('PDF OCR failed: Optical character recognition failed to detect readable text.');
        }
      } else {
        const embeddedImg = extractEmbeddedImageFromPdf(inputBuffer);
        if (embeddedImg) {
          const ocr = await performOcr(embeddedImg, options.ocrLanguage);
          if (ocr.text) {
            extractedText = ocr.text;
            ocrInfo = { text: ocr.text, confidence: ocr.confidence };
            lastOcrResult = ocr;
          } else if (options.ocrEnabled) {
            throw new Error('PDF OCR failed: Optical character recognition failed to detect readable text.');
          }
        } else if (options.ocrEnabled) {
          throw new Error('PDF OCR failed: Unsupported compression filter or no extractable raster image found in document.');
        }
      }
    }

    if (tgt === 'txt') {
      const buffer = Buffer.from(extractedText, 'utf-8');
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
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(
        baseName
      )}</title><style>body { font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; padding: 2rem; max-width: 800px; margin: 0 auto; }</style></head><body><pre>${escapeHtml(
        extractedText
      )}</pre></body></html>`;
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
      const buffer = Buffer.from(extractedText, 'utf-8');
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
        if (!lastOcrResult) {
          throw new Error('PDF OCR failed: Unsupported compression filter or no extractable raster image found in document.');
        }
        try {
          const embeddedImg = extractEmbeddedImageFromPdf(inputBuffer);
          const imgToUse = embeddedImg || inputBuffer;
          const searchablePdf = await generateSearchablePdf(imgToUse, lastOcrResult, options, baseName);
          return {
            buffer: searchablePdf,
            mimeType: 'application/pdf',
            filename: `${baseName}.pdf`,
            size: searchablePdf.length,
            ocrExtractedText: ocrInfo.text,
            ocrConfidence: ocrInfo.confidence,
          };
        } catch (pdfErr: any) {
          throw new Error(`PDF OCR failed: Failed to synthesize searchable PDF: ${pdfErr?.message || 'Synthesis error'}`);
        }
      }
      return {
        buffer: inputBuffer,
        mimeType: 'application/pdf',
        filename: `${baseName}.pdf`,
        size: inputBuffer.length,
      };
    }

    if (tgt === 'png') {
      const embedded = extractEmbeddedImageFromPdf(inputBuffer);
      let pngBuffer: Buffer;
      if (embedded) {
        pngBuffer = await sharp(embedded).png().toBuffer();
      } else {
        const svg = renderTextPageSvg(extractedText, baseName);
        pngBuffer = await sharp(Buffer.from(svg, 'utf-8')).png().toBuffer();
      }
      return {
        buffer: pngBuffer,
        mimeType: 'image/png',
        filename: `${baseName}.png`,
        size: pngBuffer.length,
        ocrExtractedText: ocrInfo.text,
        ocrConfidence: ocrInfo.confidence,
      };
    }

    if (tgt === 'svg') {
      const svg = renderTextPageSvg(extractedText, baseName);
      const buffer = Buffer.from(svg, 'utf-8');
      return {
        buffer,
        mimeType: 'image/svg+xml',
        filename: `${baseName}.svg`,
        size: buffer.length,
        ocrExtractedText: ocrInfo.text,
        ocrConfidence: ocrInfo.confidence,
      };
    }

    if (tgt === 'dxf') {
      const svg = renderTextPageSvg(extractedText, baseName);
      const dxf = svgToDxf(svg);
      const buffer = Buffer.from(dxf, 'utf-8');
      return {
        buffer,
        mimeType: 'image/vnd.dxf',
        filename: `${baseName}.dxf`,
        size: buffer.length,
      };
    }

    if (tgt === 'rtf') {
      const rtf = `{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Times New Roman;}}\\fs24 ${escapeHtml(extractedText).replace(/\\r?\\n/g, '\\par ')}}\n`;
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

function renderTextPageSvg(text: string, title: string): string {
  const lines = text.split(/\r?\n/).slice(0, 45);
  const textElements = lines
    .map(
      (l, idx) =>
        `<text x="40" y="${50 + idx * 16}" fill="#1F2340" font-family="system-ui, -apple-system, sans-serif" font-size="11">${escapeHtml(
          l
        )}</text>`
    )
    .join('\n    ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="595" height="842" viewBox="0 0 595 842">
  <title>${escapeHtml(title)}</title>
  <rect width="100%" height="100%" fill="#FFFFFF" />
  <g>
    ${textElements}
  </g>
</svg>`;
}
