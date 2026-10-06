import { beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { convertFile } from '../src/lib/conversions';
import { InputPixelLimitError } from '../src/lib/conversions/image-input-limits';
import { bombGif, bombJpeg, bombPng, bombTiff, bombWebp } from './helpers/image-bombs';
import { cbzWithImages, pptxWithPicture } from './helpers/embedded-image-docs';

const BYTES_PER_MIB = 1024 * 1024;
const MAX_REJECTION_MS = 1000;
const MAX_RSS_GROWTH_BYTES = 50 * BYTES_PER_MIB;
const HTTP_PAYLOAD_TOO_LARGE = 413;
/** Hand-written default limit of the issue (100 megapixels). */
const EXPECTED_DEFAULT_LIMIT = 100_000_000;
const OVER_CAP_SIDE = 15_000;
const WEBP_MAX_SIDE = 16_383;
const SMALL_SIDE = 32;

async function expectTypedRejection(run: () => Promise<unknown>): Promise<void> {
  const rssBefore = process.memoryUsage().rss;
  const start = performance.now();
  let error: unknown;
  try {
    await run();
  } catch (caught) {
    error = caught;
  }
  const ms = performance.now() - start;
  expect(error).toBeInstanceOf(InputPixelLimitError);
  expect(error).toMatchObject({ status: HTTP_PAYLOAD_TOO_LARGE, limit: EXPECTED_DEFAULT_LIMIT });
  expect(ms).toBeLessThan(MAX_REJECTION_MS);
  expect(process.memoryUsage().rss - rssBefore).toBeLessThan(MAX_RSS_GROWTH_BYTES);
}

describe('images embedded in documents are held to the input pixel limit', () => {
  beforeAll(async () => {
    // Load the native decoders and the PDF writer once so the measurements cover the rejection only.
    const small = await sharp({ create: { width: SMALL_SIDE, height: SMALL_SIDE, channels: 3, background: '#336699' } }).png().toBuffer();
    await convertFile(await cbzWithImages([{ name: '1.png', data: small }]), 'cbz', 'pdf', {}, 'warm.cbz');
  });

  it('refuses an over-cap PNG page of a CBZ instead of inflating it into the PDF', async () => {
    const cbz = await cbzWithImages([{ name: '001.png', data: bombPng(OVER_CAP_SIDE, OVER_CAP_SIDE) }]);
    await expectTypedRejection(() => convertFile(cbz, 'cbz', 'pdf', {}, 'comic.cbz'));
  });

  it('refuses an over-cap JPEG page of a CBZ', async () => {
    const cbz = await cbzWithImages([{ name: '001.jpg', data: bombJpeg(OVER_CAP_SIDE, OVER_CAP_SIDE) }]);
    await expectTypedRejection(() => convertFile(cbz, 'cbz', 'pdf', {}, 'comic.cbz'));
  });

  it('still converts a CBZ whose pages are within the limit', async () => {
    const page = await sharp({ create: { width: SMALL_SIDE, height: SMALL_SIDE, channels: 3, background: '#cc3366' } }).png().toBuffer();
    const result = await convertFile(await cbzWithImages([{ name: '001.png', data: page }]), 'cbz', 'pdf', {}, 'ok.cbz');
    expect(result.buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(result.buffer.includes(Buffer.from('/Subtype /Image'))).toBe(true);
  });

  it.each([
    ['png', () => bombPng(OVER_CAP_SIDE, OVER_CAP_SIDE)],
    ['jpg', () => bombJpeg(OVER_CAP_SIDE, OVER_CAP_SIDE)],
    ['webp', () => bombWebp(WEBP_MAX_SIDE, WEBP_MAX_SIDE)],
    ['tif', () => bombTiff(OVER_CAP_SIDE, OVER_CAP_SIDE)],
    ['gif', () => bombGif(OVER_CAP_SIDE, OVER_CAP_SIDE)],
  ])('refuses an over-cap .%s picture on a PPTX slide instead of dropping it', async (extension, build) => {
    const pptx = await pptxWithPicture(`bomb.${extension}`, build());
    await expectTypedRejection(() => convertFile(pptx, 'pptx', 'pdf', {}, 'deck.pptx'));
  });

  it('refuses an over-cap picture on a PPTX slide that is cropped with srcRect', async () => {
    const crop = '<a:srcRect l="10000" t="10000" r="10000" b="10000"/>';
    const pptx = await pptxWithPicture('bomb.tif', bombTiff(OVER_CAP_SIDE, OVER_CAP_SIDE), crop);
    await expectTypedRejection(() => convertFile(pptx, 'pptx', 'pdf', {}, 'deck.pptx'));
  });

  it('refuses the same PPTX picture for the HTML target', async () => {
    const pptx = await pptxWithPicture('bomb.png', bombPng(OVER_CAP_SIDE, OVER_CAP_SIDE));
    await expectTypedRejection(() => convertFile(pptx, 'pptx', 'html', {}, 'deck.pptx'));
  });

  it('still renders a PPTX picture within the limit', async () => {
    const picture = await sharp({ create: { width: SMALL_SIDE, height: SMALL_SIDE, channels: 3, background: '#33aa66' } }).webp().toBuffer();
    const result = await convertFile(await pptxWithPicture('ok.webp', picture), 'pptx', 'pdf', {}, 'ok.pptx');
    expect(result.buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(result.buffer.includes(Buffer.from('/Subtype /Image'))).toBe(true);
  });
});
