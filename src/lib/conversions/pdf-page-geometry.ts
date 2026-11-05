import { PDFArray, PDFCatalog, PDFDocument, PDFName, PDFNull, PDFNumber, PDFPage, PDFPageLeaf, PDFPageTree, PDFRef } from 'pdf-lib';
import { ConversionFailedError, PayloadLimitError } from '../types';
import { DEFAULT_MAX_INPUT_PIXELS, InputPixelLimitError, maxInputPixels } from './image-input-limit-config';
import { MAX_AGGREGATE_PAGE_PIXELS } from './image-limits';
import { mapBoxToSource, normaliseLeafPageCatalogWithLib, type OcrGeometry, type OcrQuarterTurn } from './ocr-geometry';
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

export const MAX_RASTER_PAGE_PIXELS = DEFAULT_MAX_INPUT_PIXELS;
export const MAX_RASTER_AGGREGATE_PIXELS = MAX_AGGREGATE_PAGE_PIXELS;

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
  userUnit?: number;
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

export function normaliseLeafPageCatalog(doc: PDFDocument): void {
  if (!normaliseLeafPageCatalogWithLib(doc, { PDFCatalog, PDFName, PDFPageLeaf, PDFPageTree, PDFRef })) {
    throw new PdfPageFrameError('Invalid PDF: the /Pages entry of the catalog is missing or is not a page tree dictionary typed /Type /Pages.');
  }
}

const RAW_NUMBER_TOKEN = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
const RAW_PAGE_BOX_PATTERN = new RegExp(
  `\\/(?:MediaBox|CropBox)\\s*\\[\\s*(${RAW_NUMBER_TOKEN})\\s+(${RAW_NUMBER_TOKEN})\\s+(${RAW_NUMBER_TOKEN})\\s+(${RAW_NUMBER_TOKEN})\\s*\\]`,
  'g'
);
const RAW_USER_UNIT_PATTERN = new RegExp(`\\/UserUnit\\s+(${RAW_NUMBER_TOKEN})`, 'g');
const RAW_LEAF_PAGE_PATTERN = /\/Type\s*\/Page\b(?![A-Za-z])/g;
const RAW_PAGE_COUNT_PATTERN = /\/Count\s+(\d+)/g;

function readPageCropBox(page: PDFPage, pageNumber: number): PdfBox {
  let crop: ReturnType<typeof page.getCropBox>;
  try {
    crop = page.getCropBox();
  } catch (err) {
    throw new PdfPageFrameError(`Invalid PDF: page ${pageNumber} has no readable page box (${err instanceof Error ? err.message : String(err)}).`);
  }
  if (!(crop.width > 0) || !(crop.height > 0) || !Number.isFinite(crop.x) || !Number.isFinite(crop.y)) {
    throw new PdfPageFrameError(`Invalid PDF: page ${pageNumber} has an empty or unreadable CropBox.`);
  }
  return { x0: crop.x, y0: crop.y, x1: crop.x + crop.width, y1: crop.y + crop.height };
}

function readPageUserUnit(page: PDFPage, pageNumber: number): number | undefined {
  const unitObj = page.node.lookup(PDFName.of('UserUnit'));
  if (unitObj === undefined || unitObj === PDFNull) return undefined;
  if (!(unitObj instanceof PDFNumber)) {
    throw new PdfPageFrameError(`Invalid PDF: page ${pageNumber} has a non-numeric /UserUnit.`);
  }
  const rawUnit = unitObj.asNumber();
  if (!Number.isFinite(rawUnit) || rawUnit <= 0) {
    throw new PdfPageFrameError(`Invalid PDF: page ${pageNumber} has a non-positive or invalid /UserUnit (${rawUnit}).`);
  }
  return rawUnit === 1 ? undefined : rawUnit;
}

function readPageRotation(page: PDFPage, pageNumber: number): OcrQuarterTurn {
  let angle: number;
  try {
    angle = page.getRotation().angle;
  } catch (err) {
    throw new PdfPageFrameError(`Invalid PDF: page ${pageNumber} has an unreadable /Rotate entry (${err instanceof Error ? err.message : String(err)}).`);
  }
  return normalizePdfRotation(angle);
}

function readPageFrame(page: PDFPage, pageNumber: number): PdfPageFrame {
  const cropBox = readPageCropBox(page, pageNumber);
  const userUnit = readPageUserUnit(page, pageNumber);
  const rotation = readPageRotation(page, pageNumber);
  return {
    cropBox,
    rotation,
    ...(userUnit === undefined ? {} : { userUnit }),
  };
}

/** The frame of every page of a PDF, in page order. */
export async function readPdfPageFrames(pdf: Buffer | Uint8Array): Promise<PdfPageFrame[]> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdf, { updateMetadata: false });
  } catch (err) {
    throw new PdfPageFrameError(`Invalid PDF: the page boxes could not be read (${err instanceof Error ? err.message : String(err)}).`);
  }
  normaliseLeafPageCatalog(doc);
  let pages: PDFPage[];
  try {
    pages = doc.getPages();
  } catch (err) {
    throw new PdfPageFrameError(`Invalid PDF: the page tree could not be read (${err instanceof Error ? err.message : String(err)}).`);
  }
  return pages.map((page, index) => readPageFrame(page, index + 1));
}

/** Size in points of the page as displayed: the CropBox, with width and height swapped by a quarter turn. */
export function displayedSizePoints(frame: PdfPageFrame): { width: number; height: number } {
  const unit = Math.max(1, frame.userUnit ?? 1);
  const sideways = frame.rotation === 90 || frame.rotation === 270;
  return sideways
    ? { width: height(frame.cropBox) * unit, height: width(frame.cropBox) * unit }
    : { width: width(frame.cropBox) * unit, height: height(frame.cropBox) * unit };
}

/** Size in pixels a page renders at: its displayed size at `dpi`, rounded up as the renderer does. */
export function renderedSizePixels(frame: PdfPageFrame, dpi: number): { width: number; height: number } {
  const size = displayedSizePoints(frame);
  return { width: Math.ceil((size.width * dpi) / POINTS_PER_INCH), height: Math.ceil((size.height * dpi) / POINTS_PER_INCH) };
}

function assertPageWithinPixelLimit(frame: PdfPageFrame, pageNumber: number, dpi: number, perPageLimit: number): number {
  const { width: widthPx, height: heightPx } = renderedSizePixels(frame, dpi);
  const pixels = widthPx * heightPx;
  if (!Number.isFinite(pixels) || pixels > perPageLimit) {
    throw new InputPixelLimitError(perPageLimit, widthPx, heightPx, `PDF page ${pageNumber} at ${dpi} DPI`);
  }
  return pixels;
}

function assertAggregatePixelLimit(totalPixels: number, pageCount: number, dpi: number): void {
  if (!Number.isFinite(totalPixels) || totalPixels > MAX_RASTER_AGGREGATE_PIXELS) {
    throw new InputPixelLimitError(
      MAX_RASTER_AGGREGATE_PIXELS,
      undefined,
      undefined,
      `${pageCount} selected PDF pages at ${dpi} DPI (${totalPixels} pixels in total)`
    );
  }
}

const MAX_RAW_FALLBACK_PAGES = 10_000;

export interface CheckedPdfRasterBudget {
  pageNumbers: number[];
  frames: PdfPageFrame[];
}

function checkPageFrameWithBudget(
  page: PDFPage,
  pageNumber: number,
  dpi: number,
  perPageLimit: number
): { frame: PdfPageFrame; pixels: number } {
  const cropBox = readPageCropBox(page, pageNumber);
  let userUnit: number | undefined;
  let rotation: OcrQuarterTurn = 0;
  let frameError: unknown;
  try {
    userUnit = readPageUserUnit(page, pageNumber);
  } catch (err) {
    frameError = err;
  }
  try {
    rotation = readPageRotation(page, pageNumber);
  } catch (err) {
    frameError ??= err;
  }
  const frame: PdfPageFrame = {
    cropBox,
    rotation,
    ...(userUnit === undefined ? {} : { userUnit }),
  };
  const pixels = assertPageWithinPixelLimit(frame, pageNumber, dpi, perPageLimit);
  if (frameError !== undefined) {
    throw frameError;
  }
  return { frame, pixels };
}

function maxRawUserUnit(text: string): number {
  let unit = 1;
  for (const match of text.matchAll(RAW_USER_UNIT_PATTERN)) {
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed) && parsed > unit) {
      unit = parsed;
    }
  }
  return unit;
}

function extractRawPdfBoxes(text: string, unit: number): PdfPageFrame[] {
  const frames: PdfPageFrame[] = [];
  for (const match of text.matchAll(RAW_PAGE_BOX_PATTERN)) {
    const w = Math.abs(Number(match[3]) - Number(match[1]));
    const h = Math.abs(Number(match[4]) - Number(match[2]));
    if (!(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) continue;
    frames.push({
      cropBox: { x0: 0, y0: 0, x1: w, y1: h },
      rotation: 0,
      ...(unit > 1 ? { userUnit: unit } : {}),
    });
  }
  return frames;
}

function countRawPdfPages(text: string, boxCount: number): number {
  let count = boxCount;
  const leafMatches = text.match(RAW_LEAF_PAGE_PATTERN);
  if (leafMatches && leafMatches.length > count) {
    count = leafMatches.length;
  }
  for (const match of text.matchAll(RAW_PAGE_COUNT_PATTERN)) {
    const parsed = Math.min(Number.parseInt(match[1], 10), MAX_RAW_FALLBACK_PAGES);
    if (Number.isFinite(parsed) && parsed > count) {
      count = parsed;
    }
  }
  return Math.min(count, MAX_RAW_FALLBACK_PAGES);
}

function findMinimalFallbackPageCount(
  selectPageNumbers: (pageCount: number) => readonly number[],
  minPageCount: number
): number | null {
  let low = minPageCount;
  let high = MAX_RAW_FALLBACK_PAGES;
  let candidate: number | null = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    try {
      selectPageNumbers(mid);
      candidate = mid;
      high = mid - 1;
    } catch (err) {
      if (err instanceof PayloadLimitError) {
        candidate = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
  }
  return candidate;
}

function resolveFallbackSelectedPages(
  selectPageNumbers: (pageCount: number) => readonly number[],
  pageCount: number
): readonly number[] {
  try {
    return selectPageNumbers(pageCount);
  } catch (err) {
    if (err instanceof PayloadLimitError) {
      throw err;
    }
    if (pageCount < MAX_RAW_FALLBACK_PAGES) {
      const retryCount = findMinimalFallbackPageCount(selectPageNumbers, pageCount + 1);
      if (retryCount !== null) {
        return selectPageNumbers(retryCount);
      }
    }
    return [];
  }
}

function assertRawPdfBoxesWithinPageLimit(
  pdf: Buffer | Uint8Array,
  selectPageNumbers: (pageCount: number) => readonly number[],
  dpi: number
): void {
  const text = Buffer.isBuffer(pdf) ? pdf.toString('latin1') : Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength).toString('latin1');
  const frames = extractRawPdfBoxes(text, maxRawUserUnit(text));
  if (frames.length === 0) return;
  const perPageLimit = Math.min(MAX_RASTER_PAGE_PIXELS, maxInputPixels());
  let maxFramePixels = 0;
  for (let i = 0; i < frames.length; i++) {
    const pixels = assertPageWithinPixelLimit(frames[i], i + 1, dpi, perPageLimit);
    if (pixels > maxFramePixels) {
      maxFramePixels = pixels;
    }
  }
  const pageCount = countRawPdfPages(text, frames.length);
  const selected = resolveFallbackSelectedPages(selectPageNumbers, pageCount);
  const usePerPageBox = frames.length >= pageCount && selected.every((pageNum) => pageNum >= 1 && pageNum <= frames.length);
  let totalPixels = 0;
  for (const pageNum of selected) {
    if (usePerPageBox) {
      const { width: widthPx, height: heightPx } = renderedSizePixels(frames[pageNum - 1], dpi);
      totalPixels += widthPx * heightPx;
    } else {
      totalPixels += maxFramePixels;
    }
  }
  assertAggregatePixelLimit(totalPixels, selected.length, dpi);
}

function isMissingRef(doc: PDFDocument, ref: unknown): boolean {
  return ref instanceof PDFRef && doc.context.lookup(ref) === undefined;
}

function inspectTreeNodeKids(doc: PDFDocument, tree: PDFPageTree, visited: Set<PDFRef>, stack: PDFPageTree[]): boolean {
  const kidsEntry = tree.get(PDFName.of('Kids'));
  if (isMissingRef(doc, kidsEntry)) return true;
  const kids = doc.context.lookup(kidsEntry);
  if (!(kids instanceof PDFArray)) return false;
  for (let idx = 0; idx < kids.size(); idx++) {
    const kidRef = kids.get(idx);
    if (!(kidRef instanceof PDFRef) || visited.has(kidRef)) continue;
    visited.add(kidRef);
    const kid = doc.context.lookup(kidRef);
    if (kid === undefined) return true;
    if (kid instanceof PDFPageTree) stack.push(kid);
  }
  return false;
}

function hasUnresolvedPageTreeRef(doc: PDFDocument): boolean {
  if (!(doc.catalog instanceof PDFCatalog)) return false;
  const pagesRef = doc.catalog.get(PDFName.of('Pages'));
  if (isMissingRef(doc, pagesRef)) return true;
  const rootTree = doc.catalog.lookup(PDFName.of('Pages'));
  if (!(rootTree instanceof PDFPageTree)) return false;
  const visited = new Set<PDFRef>();
  if (pagesRef instanceof PDFRef) visited.add(pagesRef);
  const stack: PDFPageTree[] = [rootTree];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current && inspectTreeNodeKids(doc, current, visited, stack)) return true;
  }
  return false;
}

export function assertPdfRasterPageBudget(frames: readonly PdfPageFrame[], pageNumbers: readonly number[], dpi: number): void {
  const perPageLimit = Math.min(MAX_RASTER_PAGE_PIXELS, maxInputPixels());
  let totalPixels = 0;
  for (const pageNumber of pageNumbers) {
    const frame = frames[pageNumber - 1];
    if (!frame) {
      throw new PdfPageFrameError(`Invalid PDF: page ${pageNumber} does not exist.`);
    }
    totalPixels += assertPageWithinPixelLimit(frame, pageNumber, dpi, perPageLimit);
  }
  assertAggregatePixelLimit(totalPixels, pageNumbers.length, dpi);
}

export async function checkPdfRasterPageBudget(
  pdf: Buffer | Uint8Array,
  selectPageNumbers: (pageCount: number) => readonly number[],
  dpi: number
): Promise<CheckedPdfRasterBudget | undefined> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdf, { updateMetadata: false, throwOnInvalidObject: true });
  } catch {
    assertRawPdfBoxesWithinPageLimit(pdf, selectPageNumbers, dpi);
    return undefined;
  }
  if (hasUnresolvedPageTreeRef(doc)) {
    assertRawPdfBoxesWithinPageLimit(pdf, selectPageNumbers, dpi);
    return undefined;
  }
  normaliseLeafPageCatalog(doc);
  let pages: PDFPage[];
  try {
    pages = doc.getPages();
  } catch (err) {
    throw new PdfPageFrameError(`Invalid PDF: the page tree could not be read (${err instanceof Error ? err.message : String(err)}).`);
  }
  if (pages.length === 0) {
    assertRawPdfBoxesWithinPageLimit(pdf, selectPageNumbers, dpi);
    return undefined;
  }
  const pageNumbers = [...selectPageNumbers(pages.length)];
  const perPageLimit = Math.min(MAX_RASTER_PAGE_PIXELS, maxInputPixels());
  const selectedFrames: PdfPageFrame[] = [];
  let totalPixels = 0;
  for (const pageNumber of pageNumbers) {
    const page = pages[pageNumber - 1];
    if (!page) {
      throw new PdfPageFrameError(`Invalid PDF: page ${pageNumber} does not exist.`);
    }
    const { frame, pixels } = checkPageFrameWithBudget(page, pageNumber, dpi, perPageLimit);
    selectedFrames.push(frame);
    totalPixels += pixels;
  }
  assertAggregatePixelLimit(totalPixels, pageNumbers.length, dpi);
  return { pageNumbers, frames: selectedFrames };
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
