import JSZip from 'jszip';
import sharp from 'sharp';
import { assembleAnimation, type AnimationEncodeOptions, type RawFrame } from './image-animation';
import type { DecodedAnimation } from './image-frames';
import { pageEntryName } from './page-range';
import type { ConversionResult } from '../types';

/** Output assembly for multi-frame sources: decoded animations and per-page ZIP packages. */

const RGBA_CHANNELS = 4;
const ZIP_COMPRESSION_LEVEL = 6;

async function transformFrame(frame: RawFrame, resize: sharp.ResizeOptions | null): Promise<RawFrame> {
  if (!resize) return frame;
  const { data, info } = await sharp(frame.data, {
    raw: { width: frame.width, height: frame.height, channels: RGBA_CHANNELS },
  })
    .resize(resize)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * Decodes every frame of `animation`, resizes it like a still conversion would and encodes the frames as an
 * animated GIF or WebP with the source's delays and loop count.
 */
export async function encodeDecodedAnimation(
  animation: DecodedAnimation,
  target: 'gif' | 'webp',
  resize: sharp.ResizeOptions | null,
  encode: AnimationEncodeOptions
): Promise<Buffer> {
  const frames: RawFrame[] = [];
  for (let index = 0; index < animation.frameCount; index += 1) {
    frames.push(await transformFrame(await animation.loadFrame(index), resize));
  }
  return assembleAnimation(frames, animation.timing, target, encode);
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
  const zip = new JSZip();
  const lastPage = pages[pages.length - 1];
  for (const page of pages) {
    const converted = await convertPage(page);
    zip.file(pageEntryName(baseName, page, lastPage, extension), converted.buffer);
  }
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: ZIP_COMPRESSION_LEVEL },
  });
}
