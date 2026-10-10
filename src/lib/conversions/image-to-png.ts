import sharp from 'sharp';
import { decodeBmp } from './bmp';
import { assertInputPixels, openLimitedSharp } from './image-input-limits';

/**
 * Redraws a picture a document carries as a PNG, for targets whose package or page format cannot hold its type (a BMP in
 * an EPUB or a PDF, an SVG in a Word document). BMP is decoded by the project's own decoder; the other types go through
 * sharp under the input pixel limit.
 */
export async function redrawAsPng(data: Buffer, mime: string): Promise<Buffer> {
  if (mime === 'image/bmp') {
    const bitmap = decodeBmp(data);
    assertInputPixels(bitmap.width, bitmap.height);
    return sharp(bitmap.raw, { raw: { width: bitmap.width, height: bitmap.height, channels: bitmap.channels } }).png().toBuffer();
  }
  return openLimitedSharp(data).png().toBuffer();
}
