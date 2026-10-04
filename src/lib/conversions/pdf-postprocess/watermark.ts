import {
  PDFDocument,
  rgb,
  degrees,
  StandardFonts,
  type PDFPage,
  type PDFFont,
  type PDFImage,
} from 'pdf-lib';
import { parsePageRanges } from '../page-range';
import {
  PdfWatermarkOptions,
  PdfWatermarkPosition,
  PdfWatermarkLayer,
  PdfPostprocessError,
} from '../../types';

function parseRgbColor(colorStr?: string) {
  if (!colorStr) {
    return rgb(0.5, 0.5, 0.5); // Default neutral gray
  }
  const str = colorStr.trim().toLowerCase();
  if (str.startsWith('#')) {
    const hex = str.slice(1);
    if (hex.length === 3) {
      const r = parseInt(hex[0] + hex[0], 16) / 255;
      const g = parseInt(hex[1] + hex[1], 16) / 255;
      const b = parseInt(hex[2] + hex[2], 16) / 255;
      return rgb(r, g, b);
    }
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16) / 255;
      const g = parseInt(hex.slice(2, 4), 16) / 255;
      const b = parseInt(hex.slice(4, 6), 16) / 255;
      return rgb(r, g, b);
    }
  }
  const rgbMatch = str.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (rgbMatch) {
    return rgb(
      parseInt(rgbMatch[1], 10) / 255,
      parseInt(rgbMatch[2], 10) / 255,
      parseInt(rgbMatch[3], 10) / 255
    );
  }
  return rgb(0.5, 0.5, 0.5);
}

function parseImageBuffer(imageSource: Buffer | string): { buffer: Buffer; format: 'png' | 'jpeg' } {
  let buf: Buffer;
  if (Buffer.isBuffer(imageSource)) {
    buf = imageSource;
  } else if (typeof imageSource === 'string') {
    const base64Data = imageSource.replace(/^data:image\/[a-z0-9-+]+;base64,/, '');
    buf = Buffer.from(base64Data, 'base64');
  } else {
    throw new PdfPostprocessError('Invalid image watermark source: expected Buffer or Base64 string.');
  }

  if (buf.length < 4) {
    throw new PdfPostprocessError('Invalid watermark image buffer: too small.');
  }

  // Detect PNG vs JPEG magic bytes
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { buffer: buf, format: 'png' };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { buffer: buf, format: 'jpeg' };
  }

  throw new PdfPostprocessError('Unsupported watermark image format: only PNG and JPEG are supported.');
}

function calculateWatermarkCoordinates(
  pos: PdfWatermarkPosition,
  pageWidth: number,
  pageHeight: number,
  elemWidth: number,
  elemHeight: number,
  margin = 40
): { x: number; y: number } {
  switch (pos) {
    case 'top-left':
      return { x: margin, y: pageHeight - margin - elemHeight };
    case 'top-center':
      return { x: (pageWidth - elemWidth) / 2, y: pageHeight - margin - elemHeight };
    case 'top-right':
      return { x: pageWidth - margin - elemWidth, y: pageHeight - margin - elemHeight };
    case 'center-left':
      return { x: margin, y: (pageHeight - elemHeight) / 2 };
    case 'center':
      return { x: (pageWidth - elemWidth) / 2, y: (pageHeight - elemHeight) / 2 };
    case 'center-right':
      return { x: pageWidth - margin - elemWidth, y: (pageHeight - elemHeight) / 2 };
    case 'bottom-left':
      return { x: margin, y: margin };
    case 'bottom-center':
      return { x: (pageWidth - elemWidth) / 2, y: margin };
    case 'bottom-right':
      return { x: pageWidth - margin - elemWidth, y: margin };
    default:
      return { x: (pageWidth - elemWidth) / 2, y: (pageHeight - elemHeight) / 2 };
  }
}

function reorderContentStreamUnder(page: PDFPage): void {
  const node = page.node as any;
  const Contents = node.normalizedEntries().Contents;
  if (Contents && typeof Contents.size === 'function' && Contents.size() > 1) {
    const arr = Contents.asArray();
    const last = arr.pop();
    arr.unshift(last);
  }
}

interface RenderImageWatermarkParams {
  page: PDFPage;
  image: PDFImage;
  position: PdfWatermarkPosition;
  scale: number;
  opacity: number;
  rotationDegrees: number;
}

function renderImageWatermarkOnPage({
  page,
  image,
  position,
  scale,
  opacity,
  rotationDegrees,
}: RenderImageWatermarkParams): void {
  const { width: pageWidth, height: pageHeight } = page.getSize();
  const imgWidth = image.width * scale;
  const imgHeight = image.height * scale;

  if (position === 'tile') {
    const stepX = Math.max(imgWidth + 60, 150);
    const stepY = Math.max(imgHeight + 60, 150);
    for (let x = 30; x < pageWidth; x += stepX) {
      for (let y = 30; y < pageHeight; y += stepY) {
        page.drawImage(image, {
          x,
          y,
          width: imgWidth,
          height: imgHeight,
          opacity,
          rotate: degrees(rotationDegrees),
        });
      }
    }
    return;
  }

  const { x, y } = calculateWatermarkCoordinates(position, pageWidth, pageHeight, imgWidth, imgHeight);
  page.drawImage(image, {
    x,
    y,
    width: imgWidth,
    height: imgHeight,
    opacity,
    rotate: degrees(rotationDegrees),
  });
}

interface RenderTextWatermarkParams {
  page: PDFPage;
  text: string;
  font: PDFFont;
  fontSize: number;
  textColor: ReturnType<typeof rgb>;
  position: PdfWatermarkPosition;
  opacity: number;
  rotationDegrees: number;
}

function calculateRotatedTextCoordinates(
  position: PdfWatermarkPosition,
  pageWidth: number,
  pageHeight: number,
  textWidth: number,
  textHeight: number,
  rotationDegrees: number
): { x: number; y: number } {
  let { x, y } = calculateWatermarkCoordinates(position, pageWidth, pageHeight, textWidth, textHeight);
  if (rotationDegrees !== 0 && position === 'center') {
    const rad = (rotationDegrees * Math.PI) / 180;
    x = (pageWidth - (textWidth * Math.cos(rad) - textHeight * Math.sin(rad))) / 2;
    y = (pageHeight - (textWidth * Math.sin(rad) + textHeight * Math.cos(rad))) / 2;
  }
  return { x, y };
}

function renderTextWatermarkOnPage({
  page,
  text,
  font,
  fontSize,
  textColor,
  position,
  opacity,
  rotationDegrees,
}: RenderTextWatermarkParams): void {
  const { width: pageWidth, height: pageHeight } = page.getSize();
  const textWidth = font.widthOfTextAtSize(text, fontSize);
  const textHeight = font.heightAtSize(fontSize);

  if (position === 'tile') {
    const stepX = Math.max(textWidth + 80, 200);
    const stepY = Math.max(textHeight + 100, 200);
    for (let x = 40; x < pageWidth; x += stepX) {
      for (let y = 40; y < pageHeight; y += stepY) {
        page.drawText(text, {
          x,
          y,
          size: fontSize,
          font,
          color: textColor,
          opacity,
          rotate: degrees(rotationDegrees),
        });
      }
    }
    return;
  }

  const { x, y } = calculateRotatedTextCoordinates(
    position,
    pageWidth,
    pageHeight,
    textWidth,
    textHeight,
    rotationDegrees
  );

  page.drawText(text, {
    x,
    y,
    size: fontSize,
    font,
    color: textColor,
    opacity,
    rotate: degrees(rotationDegrees),
  });
}

/**
 * Apply text or image watermarking to a PDF document with configurable positioning,
 * rotation, opacity, page range selection, and over/under layering.
 */
export async function applyPdfWatermark(
  pdfBuffer: Buffer,
  options: PdfWatermarkOptions = {}
): Promise<Buffer> {
  if (!pdfBuffer || pdfBuffer.length === 0) {
    throw new PdfPostprocessError('PDF buffer is empty.');
  }

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  } catch (err: any) {
    throw new PdfPostprocessError(`Failed to parse PDF document for watermarking: ${err.message}`);
  }

  const pageCount = doc.getPageCount();
  if (pageCount === 0) {
    throw new PdfPostprocessError('PDF document contains 0 pages.');
  }

  // Resolve target 1-based page indices
  let targetPages: number[];
  if (options.pages) {
    targetPages = parsePageRanges(options.pages, pageCount);
  } else {
    targetPages = Array.from({ length: pageCount }, (_, i) => i + 1);
  }

  const targetSet = new Set(targetPages);
  const opacity = Math.min(Math.max(options.opacity ?? 0.3, 0), 1);
  const rotationDegrees = options.rotation ?? (options.image ? 0 : -45);
  const position: PdfWatermarkPosition = options.position ?? 'center';
  const layer: PdfWatermarkLayer = options.layer ?? 'over';

  let embeddedFont: PDFFont | null = null;
  let embeddedImage: PDFImage | null = null;
  const isImageWatermark = Boolean(options.image || options.type === 'image');

  if (isImageWatermark) {
    if (!options.image) {
      throw new PdfPostprocessError('Watermark image source is missing for image watermark.');
    }
    const { buffer: imgBuf, format } = parseImageBuffer(options.image);
    embeddedImage = format === 'png' ? await doc.embedPng(imgBuf) : await doc.embedJpg(imgBuf);
  } else {
    embeddedFont = await doc.embedFont(StandardFonts.HelveticaBold);
  }

  const watermarkText = options.text || (isImageWatermark ? '' : 'CONFIDENTIAL');
  const textColor = parseRgbColor(options.fontColor);
  const fontSize = options.fontSize ?? 48;
  const scale = options.scale ?? 1.0;

  const pages = doc.getPages();

  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const pageNum = pageIdx + 1;
    if (!targetSet.has(pageNum)) {
      continue;
    }

    const page = pages[pageIdx];

    if (isImageWatermark && embeddedImage) {
      renderImageWatermarkOnPage({
        page,
        image: embeddedImage,
        position,
        scale,
        opacity,
        rotationDegrees,
      });
    } else if (embeddedFont && watermarkText) {
      renderTextWatermarkOnPage({
        page,
        text: watermarkText,
        font: embeddedFont,
        fontSize,
        textColor,
        position,
        opacity,
        rotationDegrees,
      });
    }

    if (layer === 'under') {
      reorderContentStreamUnder(page);
    }
  }

  const modifiedBytes = await doc.save();
  return Buffer.from(modifiedBytes);
}
