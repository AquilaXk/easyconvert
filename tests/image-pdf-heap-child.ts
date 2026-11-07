import crypto from 'node:crypto';
import sharp from 'sharp';
import { assemblePicturePdf } from '../src/lib/conversions/image-pdf-pages';
import { DEFAULT_PRINT_DENSITY } from '../src/lib/conversions/image-print-density';

/**
 * Child process of tests/image-pdf-plain-png-embed.test.ts, started with a small V8 heap: it places a PNG of random pixels
 * (a PNG that does not compress, so the bytes of its image data are as many as its samples; RGB, or RGBA when a third argument says 4 channels) on a PDF page and prints the size of
 * the PDF. Native buffers are outside the V8 heap, so only a reader that holds the image data as JavaScript values runs out.
 */
async function main(): Promise<void> {
  const [, , widthArg, heightArg, channelsArg = '3'] = process.argv;
  const width = Number(widthArg);
  const height = Number(heightArg);
  const channels = Number(channelsArg) as 3 | 4;
  const pixels = crypto.randomBytes(width * height * channels);
  const png = await sharp(pixels, { raw: { width, height, channels } }).png({ compressionLevel: 0 }).toBuffer();
  const pdf = await assemblePicturePdf([{ png, width, height, density: DEFAULT_PRINT_DENSITY }], undefined);
  process.stdout.write(`${pdf.length}\n`);
}

void main();
