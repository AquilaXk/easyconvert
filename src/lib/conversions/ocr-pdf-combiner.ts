import {
  PDFDocument,
  PDFFont,
  PDFPage,
  StandardFonts,
  pushGraphicsState,
  popGraphicsState,
  beginText,
  endText,
  setFontAndSize,
  setTextRenderingMode,
  TextRenderingMode,
  setTextMatrix,
  showText,
  PDFOperator,
  PDFOperatorNames,
  PDFNumber,
  PDFHexString,
} from 'pdf-lib';
import { ConversionOptions } from '../types';
import { OcrResult } from './ocr';

/**
 * Encodes text safely for WinAnsi standard font embedding.
 * Strips unsupported code points without throwing and avoids emitting empty space operators.
 */
function safeEncodeText(font: PDFFont, text: string): PDFHexString | null {
  let safeStr = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code >= 32 && code <= 126) || (code >= 160 && code <= 255)) {
      safeStr += text[i];
    } else {
      safeStr += ' ';
    }
  }
  const trimmed = safeStr.trim();
  if (!trimmed) return null;
  try {
    return font.encodeText(trimmed);
  } catch {
    return null;
  }
}

function renderTextItem(
  page: PDFPage,
  font: PDFFont,
  text: string,
  bbox: { x: number; y: number; width: number; height: number },
  pageHeight: number,
  scaleX: number,
  scaleY: number
): void {
  const scaledX = bbox.x * scaleX;
  const scaledY = pageHeight - (bbox.y + bbox.height) * scaleY;
  const scaledWidth = bbox.width * scaleX;
  const scaledHeight = bbox.height * scaleY;

  const fontSize = Math.max(6, Math.min(72, scaledHeight * 0.85));
  const encodedText = safeEncodeText(font, text);
  if (!encodedText) return;

  let tz = 100;
  try {
    const rawWidth = font.widthOfTextAtSize(text.trim(), fontSize);
    if (rawWidth > 0 && scaledWidth > 0) {
      tz = Math.max(50, Math.min(250, (scaledWidth / rawWidth) * 100));
    }
  } catch {
    tz = 100;
  }

  page.pushOperators(
    pushGraphicsState(),
    setTextRenderingMode(TextRenderingMode.Invisible), // 3 Tr
    beginText(),
    setFontAndSize(font.name, fontSize),
    PDFOperator.of(PDFOperatorNames.SetTextHorizontalScaling, [PDFNumber.of(Math.round(tz))]),
    setTextMatrix(1, 0, 0, 1, scaledX, Math.max(0, scaledY)),
    showText(encodedText),
    endText(),
    popGraphicsState()
  );
}

/**
 * Injects an invisible searchable text layer into a PDF page's /Contents stream.
 * Uses PDF rendering mode 3 (3 Tr = Neither fill nor stroke), horizontal scaling (Tz),
 * and text matrix positioning (Tm) matching Phase 3 specs.
 */
export function injectInvisibleTextLayer(
  page: PDFPage,
  font: PDFFont,
  ocrResult: OcrResult,
  scaleX: number = 1.0,
  scaleY: number = 1.0
): void {
  const { height: pageHeight } = page.getSize();
  const blocks = ocrResult.lineBlocks || [];

  if (blocks.length > 0) {
    for (const block of blocks) {
      if (!block.text) continue;

      if (block.words && block.words.length > 0) {
        for (const word of block.words) {
          if (word.text.trim()) {
            renderTextItem(page, font, word.text, word.bbox, pageHeight, scaleX, scaleY);
          }
        }
      } else {
        renderTextItem(page, font, block.text, block.bbox, pageHeight, scaleX, scaleY);
      }
    }
  } else if (ocrResult.lines && ocrResult.lines.length > 0) {
    // Fallback: estimate equidistant text lines
    const lineCount = ocrResult.lines.length;
    const lineHeight = Math.min(24, pageHeight / (lineCount + 2));
    const fontSize = Math.max(8, lineHeight * 0.75);

    for (let i = 0; i < lineCount; i++) {
      const lineText = ocrResult.lines[i];
      if (!lineText.trim()) continue;

      const encodedText = safeEncodeText(font, lineText);
      if (!encodedText) continue;

      const y = pageHeight - (40 + i * lineHeight);
      page.pushOperators(
        pushGraphicsState(),
        setTextRenderingMode(TextRenderingMode.Invisible),
        beginText(),
        setFontAndSize(font.name, fontSize),
        setTextMatrix(1, 0, 0, 1, 40, Math.max(0, y)),
        showText(encodedText),
        endText(),
        popGraphicsState()
      );
    }
  }
}

/**
 * Generates an authentic Lossless Sandwich PDF directly from an existing PDF document.
 * Preserves 100% of the original PDF's metadata, objects, vector artwork, annotations,
 * and compression streams while non-destructively injecting transparent text layers.
 */
export async function createLosslessSandwichPdfFromPdf(
  originalPdfBuffer: Buffer,
  pageOcrResults: Map<number, OcrResult>
): Promise<Buffer> {
  const doc = await PDFDocument.load(originalPdfBuffer);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const numPages = doc.getPageCount();
  for (let i = 0; i < numPages; i++) {
    const pageNum = i + 1;
    const ocrResult = pageOcrResults.get(pageNum);
    if (!ocrResult) continue;

    const page = doc.getPage(i);
    const { width: pageWidth, height: pageHeight } = page.getSize();

    const imgWidth = ocrResult.imageWidth || pageWidth;
    const imgHeight = ocrResult.imageHeight || pageHeight;

    const scaleX = pageWidth / imgWidth;
    const scaleY = pageHeight / imgHeight;

    injectInvisibleTextLayer(page, font, ocrResult, scaleX, scaleY);
  }

  const pdfBytes = await doc.save();
  return Buffer.from(pdfBytes);
}

/**
 * Generates a Lossless Sandwich PDF from a single scanned bitmap image.
 * Uses pdf-lib (zero PDFKit reliance) to embed the visual bitmap at full fidelity
 * and layer invisible searchable text on top with millimetric accuracy.
 */
export async function createLosslessSandwichPdfFromImage(
  scannedImageBuffer: Buffer | Uint8Array,
  ocrResult: OcrResult,
  options: ConversionOptions = {},
  title: string = 'Searchable Document'
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setCreator('EasyConvert Lossless Sandwich PDF Engine');

  const font = await doc.embedFont(StandardFonts.Helvetica);

  // Embed image: try PNG or JPG based on magic bytes
  const isJpg =
    scannedImageBuffer.length > 3 &&
    scannedImageBuffer[0] === 0xff &&
    scannedImageBuffer[1] === 0xd8 &&
    scannedImageBuffer[2] === 0xff;

  let embeddedImage;
  if (isJpg) {
    embeddedImage = await doc.embedJpg(scannedImageBuffer);
  } else {
    embeddedImage = await doc.embedPng(scannedImageBuffer);
  }

  const imgWidth = embeddedImage.width || ocrResult.imageWidth || 595.28;
  const imgHeight = embeddedImage.height || ocrResult.imageHeight || 841.89;

  const page = doc.addPage([imgWidth, imgHeight]);
  page.drawImage(embeddedImage, {
    x: 0,
    y: 0,
    width: imgWidth,
    height: imgHeight,
  });

  injectInvisibleTextLayer(page, font, ocrResult, 1.0, 1.0);

  const pdfBytes = await doc.save();
  return Buffer.from(pdfBytes);
}
