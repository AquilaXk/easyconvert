import { beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { convertFile } from '../src/lib/conversions';
import { convertImage } from '../src/lib/conversions/image';
import { InputPixelLimitError } from '../src/lib/conversions/image-input-limits';
import { bombGif, bombJpeg, bombPng, bombTiff, bombWebp, withCorruptIhdr } from './helpers/image-bombs';
import { ConversionFailedError } from '../src/lib/types';
import { cbzWithImages, pptxWithPicture } from './helpers/embedded-image-docs';

const BYTES_PER_MIB = 1024 * 1024;
const MAX_RSS_GROWTH_BYTES = 50 * BYTES_PER_MIB;
const HTTP_PAYLOAD_TOO_LARGE = 413;
/** Hand-written default limit of the issue (100 megapixels). */
const EXPECTED_DEFAULT_LIMIT = 100_000_000;
const OVER_CAP_SIDE = 15_000;
const WEBP_MAX_SIDE = 16_383;
const SMALL_SIDE = 32;

async function expectTypedRejection(run: () => Promise<unknown>): Promise<void> {
  const rssBefore = process.memoryUsage().rss;
  let error: unknown;
  try {
    await run();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(InputPixelLimitError);
  expect(error).toMatchObject({ status: HTTP_PAYLOAD_TOO_LARGE, limit: EXPECTED_DEFAULT_LIMIT });
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

  describe('a header the size check cannot read is refused, not waved through', () => {
    const brokenBomb = (): Buffer => withCorruptIhdr(bombPng(OVER_CAP_SIDE, OVER_CAP_SIDE));

    it('refuses a CBZ page whose PNG header is corrupt, which pdfkit would still decode', async () => {
      const cbz = await cbzWithImages([{ name: '001.png', data: brokenBomb() }]);
      const run = convertFile(cbz, 'cbz', 'pdf', {}, 'comic.cbz');
      await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
      await expect(run).rejects.toThrow(/header could not be decoded/);
    });

    it.each(['logo.png', 'logo.jpg', 'logo.emf'])('refuses the same PNG as the PPTX picture %s', async (name) => {
      const pptx = await pptxWithPicture(name, brokenBomb());
      const run = convertFile(pptx, 'pptx', 'pdf', {}, 'deck.pptx');
      await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
      await expect(run).rejects.toThrow(/header could not be decoded/);
    });

    it('refuses an unreadable image sent straight to the image converter', async () => {
      const run = convertImage(brokenBomb(), 'jpg', {}, 'a.png', 'png');
      await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
      await expect(run).rejects.toThrow(/header could not be decoded/);
    });

    it('refuses a CBZ page that is no image, but keeps converting a PPTX picture in a format pdfkit never decodes', async () => {
      const notAnImage = Buffer.from('EMF placeholder bytes, not a PNG or a JPEG');
      const comic = convertFile(await cbzWithImages([{ name: '001.bmp', data: notAnImage }]), 'cbz', 'pdf', {}, 'bad.cbz');
      await expect(comic).rejects.toBeInstanceOf(ConversionFailedError);
      await expect(comic).rejects.toThrow(/CBZ page "001\.bmp" cannot be decoded/);
      const deck = await convertFile(await pptxWithPicture('chart.emf', notAnImage), 'pptx', 'pdf', {}, 'ok.pptx');
      expect(deck.buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    });
  });
});
