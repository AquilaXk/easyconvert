import { describe, expect, it } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { InputPixelLimitError } from '../src/lib/conversions/image-input-limits';
import { bombPng } from './helpers/image-bombs';
import { buildBilevelTiff } from './helpers/tiff-builder';
import { captureError } from './helpers/capture-error';

/**
 * Image to PDF decodes through its own page path (decodePdfPages). It must answer an image over the input
 * pixel limit with InputPixelLimitError (413) like every other target, whichever page or icon holds it.
 */

// 12000 x 12000 = 144 Mpx, over the 100 Mpx default input limit.
const OVERSIZED_SIDE = 12000;
const SMALL_SIDE = 16;
const ICO_HEADER_BYTES = 6;
const ICO_ENTRY_BYTES = 16;
const ICO_TYPE_ICON = 1;
const ICO_BITS_PER_PIXEL = 32;

/** A one-image ICO (ICONDIR + one ICONDIRENTRY) whose payload is a PNG, as Windows Vista and later write them. */
function icoWithPng(png: Buffer): Buffer {
  const head = Buffer.alloc(ICO_HEADER_BYTES + ICO_ENTRY_BYTES);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(ICO_TYPE_ICON, 2);
  head.writeUInt16LE(1, 4);
  // Width and height bytes of 0 mean 256 or more; the PNG header carries the real size.
  head.writeUInt16LE(1, ICO_HEADER_BYTES + 4);
  head.writeUInt16LE(ICO_BITS_PER_PIXEL, ICO_HEADER_BYTES + 6);
  head.writeUInt32LE(png.length, ICO_HEADER_BYTES + 8);
  head.writeUInt32LE(head.length, ICO_HEADER_BYTES + 12);
  return Buffer.concat([head, png]);
}

describe('image to PDF holds the input pixel limit', () => {
  it('refuses an ICO whose PNG payload is over the limit', async () => {
    const ico = icoWithPng(bombPng(OVERSIZED_SIDE, OVERSIZED_SIDE));
    const error = await captureError(() => convertImage(ico, 'pdf', {}, 'big.ico', 'ico'));
    expect(error).toBeInstanceOf(InputPixelLimitError);
    expect((error as InputPixelLimitError).status).toBe(413);
  });

  it('refuses a selected TIFF page over the limit even when the first page is small', async () => {
    const tiff = buildBilevelTiff([
      { width: SMALL_SIDE, height: SMALL_SIDE },
      { width: OVERSIZED_SIDE, height: OVERSIZED_SIDE },
    ]);
    const error = await captureError(() => convertImage(tiff, 'pdf', { page: 2 }, 'pages.tif', 'tiff'));
    expect(error).toBeInstanceOf(InputPixelLimitError);
    expect(error.message).toContain(`${OVERSIZED_SIDE}x${OVERSIZED_SIDE} pixels`);
  });
});
