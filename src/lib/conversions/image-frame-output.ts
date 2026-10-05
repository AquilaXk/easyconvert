import JSZip from 'jszip';
import sharp from 'sharp';
import { assembleAnimation, type AnimationEncodeOptions, type FrameSource, type RawFrame } from './image-animation';
import type { DecodedAnimation } from './image-frames';
import { assertAnimationBudget, RGBA_BYTES_PER_PIXEL } from './image-limits';
import { joinTiffPages } from './image-tiff-merge';
import { pageEntryName } from './page-range';
import type { ConversionResult } from '../types';

/** Output assembly for multi-frame sources: decoded animations, per-page ZIP packages and multi-page TIFFs. */

const ZIP_COMPRESSION_LEVEL = 6;
const FIRST_FRAME_INDEX = 0;

/**
 * Upper bound for the size of a resized frame, from the same rules `sharp.resize` follows. Used to check the
 * output budget before any frame is processed.
 */
export function resizedDimensions(
  sourceWidth: number,
  sourceHeight: number,
  resize: { width?: number; height?: number; fit?: string } | null
): { width: number; height: number } {
  if (!resize || (resize.width === undefined && resize.height === undefined)) {
    return { width: sourceWidth, height: sourceHeight };
  }
  const width = resize.width ?? Math.round(((resize.height as number) * sourceWidth) / sourceHeight);
  const height = resize.height ?? Math.round((width * sourceHeight) / sourceWidth);
  if (resize.fit === 'outside') {
    const scale = Math.max(width / sourceWidth, height / sourceHeight);
    return { width: Math.round(sourceWidth * scale), height: Math.round(sourceHeight * scale) };
  }
  return { width, height };
}

async function resizeFrame(frame: RawFrame, resize: sharp.ResizeOptions): Promise<RawFrame> {
  const { data, info } = await sharp(frame.data, {
    raw: { width: frame.width, height: frame.height, channels: RGBA_BYTES_PER_PIXEL },
  })
    .resize(resize)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * Pulls every frame of `animation`, resizes it like a still conversion would and encodes the frames as an
 * animated GIF or WebP with the source's delays and loop count. The resized size is checked against the
 * decoded animation budget before the first frame is touched.
 */
export async function encodeDecodedAnimation(
  animation: DecodedAnimation,
  target: 'gif' | 'webp',
  resize: sharp.ResizeOptions | null,
  encode: AnimationEncodeOptions
): Promise<Buffer> {
  const bound = resizedDimensions(animation.width, animation.height, resize);
  assertAnimationBudget(bound.width, bound.height, animation.frameCount, 'The resized animation');
  const transform = async (frame: RawFrame) => (resize ? resizeFrame(frame, resize) : frame);
  const first = await transform(await animation.frame(FIRST_FRAME_INDEX));
  const source: FrameSource = {
    width: first.width,
    height: first.height,
    frameCount: animation.frameCount,
    timing: animation.timing,
    frame: async (index) => (index === FIRST_FRAME_INDEX ? first : transform(await animation.frame(index))),
  };
  return assembleAnimation(source, target, encode, animation.metadata);
}

/** Converts each of `pages` in order with `convertPage` and returns the encoded results. */
async function convertEachPage(pages: number[], convertPage: (page: number) => Promise<ConversionResult>): Promise<Buffer[]> {
  const outputs: Buffer[] = [];
  for (const page of pages) outputs.push((await convertPage(page)).buffer);
  return outputs;
}

/**
 * Converts each requested page with `convertPage` and packages the results as a ZIP, one entry per page
 * named like the PDF page renderer names its pages (`<name>-p001.<ext>`).
 */
export async function zipPageImages(
  pages: number[],
  convertPage: (page: number) => Promise<ConversionResult>,
  baseName: string,
  extension: string
): Promise<Buffer> {
  const outputs = await convertEachPage(pages, convertPage);
  const zip = new JSZip();
  const lastPage = pages[pages.length - 1];
  outputs.forEach((output, index) => zip.file(pageEntryName(baseName, pages[index], lastPage, extension), output));
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: ZIP_COMPRESSION_LEVEL },
  });
}

/** Converts each requested page to a TIFF with `convertPage` and joins them into one multi-page TIFF. */
export async function joinPageTiffs(pages: number[], convertPage: (page: number) => Promise<ConversionResult>): Promise<Buffer> {
  return joinTiffPages(await convertEachPage(pages, convertPage));
}
