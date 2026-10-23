import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions/index';
import { ImageExtractor } from '../src/lib/conversions/pdf-text-images';
import { PDF_CONTENT_MAX_IMAGES_PER_PAGE, PDF_CONTENT_MAX_PICTURES, type PdfContentImage } from '../src/lib/conversions/pdf-text-types';
import { PayloadLimitError } from '../src/lib/types';
import { picturePdf } from './helpers/picture-pdf';

/**
 * A page may paint one picture hundreds of times, and a small file can hold thousands of such pages. The picture is encoded once
 * per object and its bytes are shared by every placement, and a document may place only so many pictures: the output holds one
 * copy per placement in Markdown and HTML, so the placements and not the distinct pictures are what the output grows with.
 */

const MARKDOWN_PICTURE = /!\[[^\]]*\]\(data:[^)]*\)/g;
const PAGES_PAST_THE_LIMIT = Math.ceil(PDF_CONTENT_MAX_PICTURES / PDF_CONTENT_MAX_IMAGES_PER_PAGE) + 1;
const HOSTILE_TIME_MS = 60_000;

const decodedGray = { kind: 2, width: 1, height: 1, data: new Uint8ClampedArray([7, 7, 7]) };

function pool(entries: Record<string, unknown>) {
  return { has: (id: string) => id in entries, get: (id: string) => entries[id] };
}

function placements(count: number): PdfContentImage[] {
  return Array.from({ length: count }, () => ({ x: 0, y: 0, width: 2, height: 2, pixelWidth: 1, pixelHeight: 1 }));
}

describe('a picture placed many times', () => {
  it('is encoded once and its bytes are shared by every placement', async () => {
    const images = placements(PDF_CONTENT_MAX_IMAGES_PER_PAGE);
    const sources = images.map(() => ({ objId: 'img_p0_1' }));
    await new ImageExtractor(new Uint8Array(0)).attach(0, { objs: pool({ img_p0_1: decodedGray }), commonObjs: pool({}) }, images, sources);
    expect(images.every((image) => image.format === 'png')).toBe(true);
    expect(new Set(images.map((image) => image.data)).size).toBe(1);
  });

  it('is refused with a 413 once the document places more pictures than the limit, however small they are', async () => {
    const extractor = new ImageExtractor(new Uint8Array(0));
    const page = { objs: pool({ img_p0_1: decodedGray }), commonObjs: pool({}) };
    const started = Date.now();
    let refusal: unknown;
    try {
      for (let pageIndex = 0; pageIndex < PAGES_PAST_THE_LIMIT; pageIndex++) {
        await extractor.attach(pageIndex, page, placements(PDF_CONTENT_MAX_IMAGES_PER_PAGE), Array.from({ length: PDF_CONTENT_MAX_IMAGES_PER_PAGE }, () => ({ objId: 'img_p0_1' })));
      }
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(PayloadLimitError);
    expect(Date.now() - started).toBeLessThan(HOSTILE_TIME_MS);
  }, HOSTILE_TIME_MS + 5_000);
});

describe('a small PDF that paints a picture over and over', () => {
  it('gives one picture per placement in Markdown and one media file in Word', async () => {
    const draws = PDF_CONTENT_MAX_IMAGES_PER_PAGE;
    const bytes = picturePdf({ pages: 1, drawsPerPage: draws, dimension: 1, sharedPicture: false });
    const markdown = await convertFile(bytes, 'pdf', 'md', {}, 'repeats.pdf');
    expect(markdown.buffer.toString('utf8').match(MARKDOWN_PICTURE)).toHaveLength(draws);
    const word = await convertFile(bytes, 'pdf', 'docx', {}, 'repeats.pdf');
    const zip = await JSZip.loadAsync(word.buffer);
    expect(Object.keys(zip.files).filter((name) => name.startsWith('word/media/'))).toHaveLength(1);
  }, HOSTILE_TIME_MS);

  it('is refused with a 413 when its pages place more pictures than the limit', async () => {
    const bytes = picturePdf({ pages: PAGES_PAST_THE_LIMIT, drawsPerPage: PDF_CONTENT_MAX_IMAGES_PER_PAGE, dimension: 1, sharedPicture: false });
    const started = Date.now();
    await expect(convertFile(bytes, 'pdf', 'md', {}, 'hostile.pdf')).rejects.toBeInstanceOf(PayloadLimitError);
    expect(Date.now() - started).toBeLessThan(HOSTILE_TIME_MS);
  }, HOSTILE_TIME_MS + 5_000);

  it('converts a picture shared by many pages, one placement each, in time and with one copy per placement', async () => {
    const pages = 300;
    const bytes = picturePdf({ pages, drawsPerPage: 1, dimension: 64, sharedPicture: true });
    const started = Date.now();
    const converted = await convertFile(bytes, 'pdf', 'md', {}, 'shared.pdf');
    expect(converted.buffer.toString('utf8').match(MARKDOWN_PICTURE)).toHaveLength(pages);
    expect(Date.now() - started).toBeLessThan(HOSTILE_TIME_MS);
  }, HOSTILE_TIME_MS + 5_000);
});
