import { PDFDocument } from 'pdf-lib';
import { ConversionFailedError } from '../types';
import { mapBoxToSource, type OcrGeometry, type OcrQuarterTurn } from './ocr-geometry';
import type { OcrBBox } from './ocr-pdf-combiner';

/**
 * How a rendered PDF page relates to the PDF page it was rendered from, so that boxes the recognizer reports in
 * pixels land in PDF user space. A renderer shows the page's CropBox (the MediaBox when there is none) turned
 * clockwise by /Rotate (ISO 32000-1 7.7.3.3), at `dpi` pixels per inch with the top row first; PDF user space is
 * in points (1/72 inch) with y up and the origin wherever the page's boxes put it.
 *
 *   x_pt = x_px x 72 / dpi, y_pt = H_pt - y_px x 72 / dpi
 *
 * for an unrotated page whose CropBox starts at the origin, where H_pt is the page height. The CropBox origin and
 * /Rotate add the offset and the turn; the turn is the same quarter turn the recognizer's orientation step
 * undoes, so the one implementation (ocr-geometry.ts) serves both.
 */

const POINTS_PER_INCH = 72;
const FULL_TURN_DEGREES = 360;
const QUARTER_TURN_DEGREES = 90;

/** The visible rectangle of a page in PDF user space (points, y up): the CropBox, or the MediaBox when none is set. */
export interface PdfBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PdfPageFrame {
  cropBox: PdfBox;
  /** /Rotate: the clockwise turn a viewer gives the page, a multiple of 90 degrees. */
  rotation: OcrQuarterTurn;
}

/** A rendered page: its frame in the PDF, the resolution it was drawn at and its size in pixels. */
export interface RenderedPdfPage {
  frame: PdfPageFrame;
  dpi: number;
  /** Size of the rendered image, which is the page as displayed (after /Rotate). */
  widthPx: number;
  heightPx: number;
}

/** A rectangle in PDF user space (points, y up). */
export interface UserSpaceRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A PDF whose page boxes or /Rotate cannot be read as a page frame. */
export class PdfPageFrameError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'PdfPageFrameError';
  }
}

function width(box: PdfBox): number {
  return box.x1 - box.x0;
}

function height(box: PdfBox): number {
  return box.y1 - box.y0;
}

/** Normalizes a /Rotate value to 0, 90, 180 or 270; any other value is not a valid page rotation. */
export function normalizePdfRotation(angle: number): OcrQuarterTurn {
  const turned = ((angle % FULL_TURN_DEGREES) + FULL_TURN_DEGREES) % FULL_TURN_DEGREES;
  if (!Number.isInteger(turned) || turned % QUARTER_TURN_DEGREES !== 0) {
    throw new PdfPageFrameError(`Invalid PDF: /Rotate ${angle} is not a multiple of 90 degrees.`);
  }
  return turned as OcrQuarterTurn;
}

/** The frame of every page of a PDF, in page order. */
export async function readPdfPageFrames(pdf: Buffer | Uint8Array): Promise<PdfPageFrame[]> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdf, { updateMetadata: false });
  } catch (err) {
    throw new PdfPageFrameError(`Invalid PDF: the page boxes could not be read (${err instanceof Error ? err.message : String(err)}).`);
  }
  let pages: ReturnType<PDFDocument['getPages']>;
  try {
    pages = doc.getPages();
  } catch (err) {
    // A page tree the parser cannot walk (a cyclic or broken /Kids chain) leaves no page boxes to read.
    throw new PdfPageFrameError(`Invalid PDF: the page tree could not be read (${err instanceof Error ? err.message : String(err)}).`);
  }
  return pages.map((page, index) => {
    let crop: ReturnType<typeof page.getCropBox>;
    let angle: number;
    try {
      crop = page.getCropBox();
      angle = page.getRotation().angle;
    } catch (err) {
      // A page without a readable MediaBox in its own dictionary or in any ancestor has no box to render.
      throw new PdfPageFrameError(`Invalid PDF: page ${index + 1} has no readable page box (${err instanceof Error ? err.message : String(err)}).`);
    }
    if (!(crop.width > 0) || !(crop.height > 0) || !Number.isFinite(crop.x) || !Number.isFinite(crop.y)) {
      throw new PdfPageFrameError(`Invalid PDF: page ${index + 1} has an empty or unreadable CropBox.`);
    }
    return {
      cropBox: { x0: crop.x, y0: crop.y, x1: crop.x + crop.width, y1: crop.y + crop.height },
      rotation: normalizePdfRotation(angle),
    };
  });
}

/** Size in points of the page as displayed: the CropBox, with width and height swapped by a quarter turn. */
export function displayedSizePoints(frame: PdfPageFrame): { width: number; height: number } {
  const sideways = frame.rotation === 90 || frame.rotation === 270;
  return sideways
    ? { width: height(frame.cropBox), height: width(frame.cropBox) }
    : { width: width(frame.cropBox), height: height(frame.cropBox) };
}

/** Size in pixels a page renders at: its displayed size at `dpi`, rounded up as the renderer does. */
export function renderedSizePixels(frame: PdfPageFrame, dpi: number): { width: number; height: number } {
  const size = displayedSizePoints(frame);
  return { width: Math.ceil((size.width * dpi) / POINTS_PER_INCH), height: Math.ceil((size.height * dpi) / POINTS_PER_INCH) };
}

/**
 * The geometry that undoes a page's /Rotate: the rendered image is the unrotated page turned clockwise by
 * `rotation`, whose size in pixels is the rendered size, swapped by a quarter turn.
 */
export function unrotatedPageGeometry(page: RenderedPdfPage): OcrGeometry {
  const sideways = page.frame.rotation === 90 || page.frame.rotation === 270;
  return {
    sourceWidth: sideways ? page.heightPx : page.widthPx,
    sourceHeight: sideways ? page.widthPx : page.heightPx,
    ...(page.frame.rotation === 0 ? {} : { quarterTurnDegrees: page.frame.rotation }),
    scaledWidth: page.widthPx,
    scaledHeight: page.heightPx,
    outputWidth: page.widthPx,
    outputHeight: page.heightPx,
    rotationDegrees: 0,
  };
}

/**
 * Points per pixel (72 / dpi, the same along both axes: a renderer draws at one scale) and the top-left corner of the
 * unrotated page's CropBox in user space, where its pixel grid starts. A page's size in pixels is rounded up, so the
 * last row and column may lie past the CropBox.
 */
export function unrotatedPageScale(page: RenderedPdfPage): { scaleX: number; scaleY: number; originX: number; top: number } {
  const pointsPerPixel = POINTS_PER_INCH / page.dpi;
  return { scaleX: pointsPerPixel, scaleY: pointsPerPixel, originX: page.frame.cropBox.x0, top: page.frame.cropBox.y1 };
}

/**
 * Maps a box of the rendered page (pixels, top-left origin) to PDF user space (points, y up): the box's corners
 * are returned to the unrotated page, scaled by 72 / dpi and moved to the CropBox origin. The result is the
 * smallest rectangle holding the turned box.
 */
export function pxToPdfUserSpace(box: Pick<OcrBBox, 'x' | 'y' | 'width' | 'height'>, page: RenderedPdfPage): UserSpaceRect {
  const unrotated = mapBoxToSource({ x: box.x, y: box.y, width: box.width, height: box.height }, unrotatedPageGeometry(page));
  const { scaleX, scaleY, originX, top } = unrotatedPageScale(page);
  return {
    x0: originX + unrotated.x * scaleX,
    y0: top - (unrotated.y + unrotated.height) * scaleY,
    x1: originX + (unrotated.x + unrotated.width) * scaleX,
    y1: top - unrotated.y * scaleY,
  };
}
