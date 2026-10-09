import {
  PDFDocument,
  rgb,
  degrees,
  StandardFonts,
  type PDFEmbeddedPage,
  type PDFPage,
  type PDFFont,
  type PDFImage,
} from 'pdf-lib';
import { assertEncodedImageWithinLimit } from '../image-input-limits';
import { parsePageRanges } from '../page-range';
import { faceCoversText, findFaceByFamily, type PdfFontFace } from '../pdf-fonts';
import { attachWinAnsiToUnicode } from '../pdf-winansi-tounicode';
import {
  PdfWatermarkOptions,
  PdfWatermarkPosition,
  PdfWatermarkLayer,
  PdfPostprocessError,
  WatermarkFontError,
} from '../../types';
import { renderTextStamp, STAMP_PAGE_INDEX } from './watermark-text-stamp';

/** Longest watermark text, in code points; a watermark is a short label, not a paragraph. */
export const WATERMARK_MAX_CHARS = 256;
const LINE_BREAK = /[\r\n\u2028\u2029]/;
const DEFAULT_WATERMARK_TEXT = 'CONFIDENTIAL';

function parseRgbColor(colorStr?: string) {
  if (!colorStr) {
    return rgb(0.5, 0.5, 0.5); // Default neutral gray
  }
  const str = colorStr.trim().toLowerCase();
  if (str.startsWith('#')) {
    const hex = str.slice(1);
    let step = 0;
    if (hex.length === 3) {
      step = 1;
    } else if (hex.length === 6) {
      step = 2;
    }
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

/** How one watermark text is measured and drawn: with a standard font, or as an embedded-font stamp. */
interface TextWatermark {
  width: number;
  height: number;
  draw(page: PDFPage, at: { x: number; y: number }, rotationDegrees: number): void;
}

interface RenderTextWatermarkParams {
  page: PDFPage;
  text: TextWatermark;
  position: PdfWatermarkPosition;
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

function renderTextWatermarkOnPage({ page, text, position, rotationDegrees }: RenderTextWatermarkParams): void {
  const { width: pageWidth, height: pageHeight } = page.getSize();
  const { width: textWidth, height: textHeight } = text;

  if (position === 'tile') {
    renderTiled(
      pageWidth,
      pageHeight,
      Math.max(textWidth + 80, 200),
      Math.max(textHeight + 100, 200),
      40,
      40,
      (x, y) => text.draw(page, { x, y }, rotationDegrees)
    );
    return;
  }

  const at = calculateRotatedTextCoordinates(position, pageWidth, pageHeight, textWidth, textHeight, rotationDegrees);
  text.draw(page, at, rotationDegrees);
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
  text: TextWatermark | null;
  /** The standard font the text is drawn with, when it is; it needs its ToUnicode map attached before saving. */
  standardFont: PDFFont | null;
}

/** Whether the standard Helvetica-Bold (WinAnsi) can draw every character of the text. */
async function drawableWithStandardFont(text: string): Promise<boolean> {
  const probe = await PDFDocument.create();
  const font = await probe.embedFont(StandardFonts.HelveticaBold);
  try {
    font.widthOfTextAtSize(text, 1);
    return true;
  } catch {
    return false;
  }
}

function assertWatermarkText(text: string): void {
  if (Array.from(text).length > WATERMARK_MAX_CHARS) {
    throw new WatermarkFontError(`The watermark text is longer than ${WATERMARK_MAX_CHARS} characters.`);
  }
  if (LINE_BREAK.test(text)) {
    throw new WatermarkFontError('The watermark text must be a single line.');
  }
}

/** The face the requested family names; it must be installed and have a glyph for every character of the text. */
async function requestedFace(family: string, text: string): Promise<PdfFontFace> {
  const face = await findFaceByFamily(family);
  if (!face) {
    throw new WatermarkFontError(`The watermark font family '${family}' is not installed.`);
  }
  if (!faceCoversText(face, text)) {
    throw new WatermarkFontError(`The watermark font family '${family}' has no glyph for every character of the text.`);
  }
  return face;
}

function standardTextWatermark(font: PDFFont, text: string, fontSize: number, color: ReturnType<typeof rgb>, opacity: number): TextWatermark {
  return {
    width: font.widthOfTextAtSize(text, fontSize),
    height: font.heightAtSize(fontSize),
    draw: (page, { x, y }, rotationDegrees) =>
      page.drawText(text, { x, y, size: fontSize, font, color, opacity, rotate: degrees(rotationDegrees) }),
  };
}

/** The text as a stamp page with an embedded subset font, placed on the pages as a form XObject. */
async function stampTextWatermark(
  doc: PDFDocument,
  text: string,
  family: string | undefined,
  fontSize: number,
  color: ReturnType<typeof rgb>,
  opacity: number
): Promise<TextWatermark> {
  const face = family ? await requestedFace(family, text) : undefined;
  const stamp = await renderTextStamp({ text, fontSize, color, opacity, face });
  const [embedded]: PDFEmbeddedPage[] = await doc.embedPdf(await PDFDocument.load(stamp.pdf), [STAMP_PAGE_INDEX]);
  return {
    width: stamp.width,
    height: stamp.height,
    draw: (page, { x, y }, rotationDegrees) =>
      page.drawPage(embedded, { x, y, width: stamp.width, height: stamp.height, rotate: degrees(rotationDegrees) }),
  };
}

async function prepareWatermarkAsset(
  doc: PDFDocument,
  options: PdfWatermarkOptions,
  style: { fontSize: number; color: ReturnType<typeof rgb>; opacity: number }
): Promise<PreparedWatermarkAsset> {
  const isImage = Boolean(options.image || options.type === 'image');
  if (isImage) {
    if (!options.image) {
      throw new PdfPostprocessError('Watermark image source is missing for image watermark.');
    }
    const { buffer: imgBuf, format } = parseImageBuffer(options.image);
    // pdf-lib decodes PNG and JPEG itself and leniently: check the declared size first, and refuse a header libvips cannot read.
    await assertEncodedImageWithinLimit(imgBuf);
    const image = format === 'png' ? await doc.embedPng(imgBuf) : await doc.embedJpg(imgBuf);
    return { isImage: true, image, text: null, standardFont: null };
  }

  const text = options.text || DEFAULT_WATERMARK_TEXT;
  const family = options.fontFamily?.trim() || undefined;
  assertWatermarkText(text);
  // Text the standard font can draw keeps it; anything else, and any requested family, is an embedded subset.
  if (!family && (await drawableWithStandardFont(text))) {
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    return { isImage: false, image: null, text: standardTextWatermark(font, text, style.fontSize, style.color, style.opacity), standardFont: font };
  }
  const stamped = await stampTextWatermark(doc, text, family, style.fontSize, style.color, style.opacity);
  return { isImage: false, image: null, text: stamped, standardFont: null };
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

  const textColor = parseRgbColor(options.fontColor);
  const fontSize = options.fontSize ?? 48;
  const scale = options.scale ?? 1.0;
  const asset = await prepareWatermarkAsset(doc, options, { fontSize, color: textColor, opacity });

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
    } else if (asset.text) {
      renderTextWatermarkOnPage({ page, text: asset.text, position, rotationDegrees });
    }

    if (layer === 'under') {
      reorderContentStreamUnder(page);
    }
  }

  // pdf-lib writes the font dictionary again at save because drawing text marks the font as modified, so the CMap is
  // attached last, to the dictionary that is written.
  if (asset.standardFont) await attachWinAnsiToUnicode(doc, asset.standardFont);
  const modifiedBytes = await doc.save();
  return Buffer.from(modifiedBytes);
}
