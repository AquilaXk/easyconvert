import JSZip from 'jszip';
import sharp, { type ResizeOptions } from 'sharp';
import { assembleAnimation, type AnimationEncodeOptions, type FrameSource, type RawFrame } from './image-animation';
import type { DecodedAnimation, FrameSelection } from './image-frames';
import { assertAnimationBudget, COMPOSED_MEMORY, RGBA_BYTES_PER_PIXEL } from './image-limits';
import { joinPostscriptPages } from './image-postscript';
import { joinTiffPages } from './image-tiff-merge';
import { pageEntryName } from './page-range';
import type { ConversionResult } from '../types';
import { resizedDimensions } from './image-input-limits';

/** Output assembly for multi-frame sources: decoded animations, per-page ZIP packages, multi-page TIFFs and multi-page PostScript. */

const ZIP_COMPRESSION_LEVEL = 6;
const FIRST_FRAME_INDEX = 0;

async function resizeFrame(frame: RawFrame, resize: ResizeOptions): Promise<RawFrame> {
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
  resize: ResizeOptions | null,
  encode: AnimationEncodeOptions
): Promise<Buffer> {
  const bound = resizedDimensions(animation.width, animation.height, resize ?? {});
  assertAnimationBudget(bound.width, bound.height, animation.frameCount, 'The resized animation', COMPOSED_MEMORY);
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

/** The PostScript target, which is a document of pages: an EPS is one figure and stays one file per page. */
const POSTSCRIPT_TARGET = 'ps';

/** What names a page-package output: the target, the name it is written under, its file extension and the frame counts it reports. */
export interface PagePackage {
  target: string;
  baseName: string;
  extension: string;
  frameFields: Pick<ConversionResult, 'sourceFrameCount' | 'frameUsed'>;
}

/**
 * The output of a source of several pages, assembled from one conversion per page: one multi-page TIFF, one PostScript
 * document, or a ZIP with one image per page. Null when the selection is not a set of pages.
 */
export async function packagePageOutputs(
  selection: FrameSelection,
  output: PagePackage,
  convertPage: (page: number) => Promise<ConversionResult>
): Promise<ConversionResult | null> {
  const { target, baseName, extension, frameFields } = output;
  if (selection.tiffPages) {
    const joined = await joinPageTiffs(selection.tiffPages, convertPage);
    return { buffer: joined, mimeType: 'image/tiff', filename: `${baseName}.${extension}`, size: joined.length, ...frameFields };
  }
  if (selection.zipPages && target === POSTSCRIPT_TARGET) {
    const document = joinPostscriptPages(await convertEachPage(selection.zipPages, convertPage));
    return { buffer: document, mimeType: 'application/postscript', filename: `${baseName}.${extension}`, size: document.length, ...frameFields };
  }
  if (selection.zipPages) {
    const zipped = await zipPageImages(selection.zipPages, convertPage, baseName, extension);
    return { buffer: zipped, mimeType: 'application/zip', filename: `${baseName}.zip`, size: zipped.length, ...frameFields };
  }
  return null;
}
