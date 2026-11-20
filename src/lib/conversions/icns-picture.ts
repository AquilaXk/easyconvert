import sharp from 'sharp';
import { decodeIcns } from './ico';
import { decodeWithOpenJpeg } from './image-openjpeg-cli';

const RGBA_CHANNELS = 4;

/**
 * The best picture of an ICNS file as PNG or JPEG bytes: a PNG or JPEG element as it is, a JPEG 2000 element decoded by OpenJPEG,
 * and an old-style picture written as a PNG from its decoded pixels.
 */
export async function icnsPictureBytes(icns: Buffer, signal?: AbortSignal): Promise<Buffer> {
  const picture = decodeIcns(icns);
  if (picture.kind === 'raster') {
    return sharp(picture.rgba, { raw: { width: picture.width, height: picture.height, channels: RGBA_CHANNELS } }).png().toBuffer();
  }
  return picture.jpeg2000 ? decodeWithOpenJpeg(picture.data, signal) : picture.data;
}
