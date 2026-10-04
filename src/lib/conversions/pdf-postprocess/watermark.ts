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
    const step = hex.length === 3 ? 1 : hex.length === 6 ? 2 : 0;
    if (step > 0) {
      const getVal = (idx: number) => {
        const seg = step === 1 ? hex[idx] + hex[idx] : hex.slice(idx * 2, idx * 2 + 2);
        return Number.parseInt(seg, 16) / 255;
      };
      return rgb(getVal(0), getVal(1), getVal(2));
    }
  }
  const rgbMatch = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(str);
  if (rgbMatch) {
    return rgb(
      Number.parseInt(rgbMatch[1], 10) / 255,
      Number.parseInt(rgbMatch[2], 10) / 255,
      Number.parseInt(rgbMatch[3], 10) / 255
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

function renderTiled(
  pageWidth: number,
  pageHeight: number,
  stepX: number,
  stepY: number,
  startX: number,
  startY: number,
  drawAt: (x: number, y: number) => void
): void {
  for (let x = startX; x < pageWidth; x += stepX) {
    for (let y = startY; y < pageHeight; y += stepY) {
      drawAt(x, y);
    }
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
    renderTiled(
      pageWidth,
      pageHeight,
      Math.max(imgWidth + 60, 150),
      Math.max(imgHeight + 60, 150),
      30,
      30,
      (x, y) => {
        page.drawImage(image, {
          x,
          y,
          width: imgWidth,
          height: imgHeight,
          opacity,
          rotate: degrees(rotationDegrees),
        });
      }
    );
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
    renderTiled(
      pageWidth,
      pageHeight,
      Math.max(textWidth + 80, 200),
      Math.max(textHeight + 100, 200),
      40,
      40,
      (x, y) => {
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
    );
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

async function loadAndPrepareDocument(
  pdfBuffer: Buffer
): Promise<{ doc: PDFDocument; pageCount: number }> {
  if (!pdfBuffer || pdfBuffer.length === 0) {
    throw new PdfPostprocessError('PDF buffer is empty.');
  }
  try {
    const doc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    const pageCount = doc.getPageCount();
    if (pageCount === 0) {
      throw new PdfPostprocessError('PDF document contains 0 pages.');
    }
    return { doc, pageCount };
  } catch (err: any) {
    if (err instanceof PdfPostprocessError) {
      throw err;
    }
    throw new PdfPostprocessError(`Failed to parse PDF document for watermarking: ${err.message}`);
  }
}

interface PreparedWatermarkAsset {
  isImage: boolean;
  image: PDFImage | null;
  font: PDFFont | null;
  text: string;
}

async function prepareWatermarkAsset(
  doc: PDFDocument,
  options: PdfWatermarkOptions
): Promise<PreparedWatermarkAsset> {
  const isImage = Boolean(options.image || options.type === 'image');
  if (isImage) {
    if (!options.image) {
      throw new PdfPostprocessError('Watermark image source is missing for image watermark.');
    }
    const { buffer: imgBuf, format } = parseImageBuffer(options.image);
    const image = format === 'png' ? await doc.embedPng(imgBuf) : await doc.embedJpg(imgBuf);
    return { isImage: true, image, font: null, text: '' };
  }

  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const text = options.text || 'CONFIDENTIAL';
  return { isImage: false, image: null, font, text };
}

/**
 * Apply text or image watermarking to a PDF document with configurable positioning,
 * rotation, opacity, page range selection, and over/under layering.
 */
export async function applyPdfWatermark(
  pdfBuffer: Buffer,
  options: PdfWatermarkOptions = {}
): Promise<Buffer> {
  const { doc, pageCount } = await loadAndPrepareDocument(pdfBuffer);

  const targetPages = options.pages
    ? parsePageRanges(options.pages, pageCount)
    : Array.from({ length: pageCount }, (_, i) => i + 1);
  const targetSet = new Set(targetPages);

  const opacity = Math.min(Math.max(options.opacity ?? 0.3, 0), 1);
  const rotationDegrees = options.rotation ?? (options.image ? 0 : -45);
  const position: PdfWatermarkPosition = options.position ?? 'center';
  const layer: PdfWatermarkLayer = options.layer ?? 'over';

  const asset = await prepareWatermarkAsset(doc, options);
  const textColor = parseRgbColor(options.fontColor);
  const fontSize = options.fontSize ?? 48;
  const scale = options.scale ?? 1.0;

  for (const [idx, page] of doc.getPages().entries()) {
    if (!targetSet.has(idx + 1)) {
      continue;
    }

    if (asset.isImage && asset.image) {
      renderImageWatermarkOnPage({
        page,
        image: asset.image,
        position,
        scale,
        opacity,
        rotationDegrees,
      });
    } else if (asset.font && asset.text) {
      renderTextWatermarkOnPage({
        page,
        text: asset.text,
        font: asset.font,
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
