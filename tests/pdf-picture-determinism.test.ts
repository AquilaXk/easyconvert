import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { convertFile } from '../src/lib/conversions/index';
import { ImageExtractor } from '../src/lib/conversions/pdf-text-images';
import type { PdfContentImage } from '../src/lib/conversions/pdf-text-types';
import { startBusyThreads } from './helpers/busy-threads';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * A picture the PDF paints is in the Markdown and HTML every time. pdf.js decodes a picture in its own task and delivers it
 * to the page's object table after the operator list has resolved, so a reader that looks the picture up the moment the
 * list resolves finds it on some runs and not on others (pdf.js waits at the list's `dependency` operator,
 * src/display/canvas.js executeOperatorList).
 */

const RUNS = 12;
const PICTURES = 6;
const SIZE = 48;
const DELIVERY_DELAY_MS = 25;
const MARKDOWN_PICTURE = /!\[[^\]]*\]\(data:[^)]*\)/g;
const HTML_PICTURE = /<img\b[^>]*>/g;

type Waiter = (data: unknown) => void;

/** An object table in which a decoded picture arrives `delayMs` after it is first asked for, as pdf.js delivers it. */
function lateTable(entries: Record<string, unknown>, delayMs: number) {
  const resolved = new Set<string>();
  return {
    has: (id: string) => resolved.has(id),
    get: (id: string, callback?: Waiter) => {
      if (callback === undefined) {
        if (!resolved.has(id)) throw new Error(`Requesting object that isn't resolved yet ${id}.`);
        return entries[id];
      }
      setTimeout(() => {
        resolved.add(id);
        callback(entries[id]);
      }, delayMs);
      return null;
    },
  };
}

function decodedRgb(shade: number): { kind: number; width: number; height: number; data: Uint8ClampedArray } {
  return { kind: 2, width: 2, height: 2, data: new Uint8ClampedArray(12).fill(shade) };
}

function placement(): PdfContentImage {
  return { x: 0, y: 0, width: 10, height: 10, pixelWidth: 2, pixelHeight: 2 };
}

describe('the pictures of a page are attached when pdf.js delivers them', () => {
  it('waits for a picture of the page table that arrives after the operator list', async () => {
    const images = [placement(), placement()];
    const sources = [{ objId: 'img_p0_1' }, { objId: 'img_p0_2' }];
    const page = {
      objs: lateTable({ img_p0_1: decodedRgb(10), img_p0_2: decodedRgb(200) }, DELIVERY_DELAY_MS),
      commonObjs: lateTable({}, DELIVERY_DELAY_MS),
    };
    await new ImageExtractor(new Uint8Array(0)).attach(0, page, images, sources);
    expect(images.map((image) => image.format)).toEqual(['png', 'png']);
  });

  it('looks a picture shared by several pages up in the common table, as pdf.js does for ids that start with g_', async () => {
    const images = [placement()];
    const sources = [{ objId: 'g_abc_img_p0_1' }];
    const page = { objs: lateTable({}, DELIVERY_DELAY_MS), commonObjs: lateTable({ g_abc_img_p0_1: decodedRgb(90) }, DELIVERY_DELAY_MS) };
    await new ImageExtractor(new Uint8Array(0)).attach(0, page, images, sources);
    expect(images[0].format).toBe('png');
  });

  it('leaves out a picture pdf.js could not decode, the same on every run', async () => {
    const images = [placement()];
    const page = { objs: lateTable({ img_p0_1: null }, DELIVERY_DELAY_MS), commonObjs: lateTable({}, DELIVERY_DELAY_MS) };
    await new ImageExtractor(new Uint8Array(0)).attach(0, page, images, [{ objId: 'img_p0_1' }]);
    expect(images[0].data).toBeUndefined();
  });
});

async function pictureCounts(bytes: Buffer, target: 'md' | 'html'): Promise<number[]> {
  const counts: number[] = [];
  for (let run = 0; run < RUNS; run++) {
    const converted = await convertFile(bytes, 'pdf', target, {}, 'pictures.pdf');
    counts.push((converted.buffer.toString('utf8').match(target === 'md' ? MARKDOWN_PICTURE : HTML_PICTURE) ?? []).length);
  }
  return counts;
}

async function pdfWithPictures(count: number): Promise<Buffer> {
  const document = await PDFDocument.create();
  const page = document.addPage([600, 800]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  // A page of pictures alone is read by OCR, which lays the pictures out itself; text keeps it on the text layer.
  for (const [line, text] of ['Quarterly figures of the regional offices.', 'The photographs below show each site.'].entries()) {
    page.drawText(text, { x: 20, y: 760 - line * 20, size: 14, font });
  }
  for (let index = 0; index < count; index++) {
    const noise = Buffer.alloc(SIZE * SIZE * 3);
    for (let at = 0; at < noise.length; at++) noise[at] = (at * (index + 7) + index * 29) & 0xff;
    const png = await sharp(noise, { raw: { width: SIZE, height: SIZE, channels: 3 } }).png().toBuffer();
    const embedded = await document.embedPng(png);
    page.drawImage(embedded, { x: 20 + (index % 3) * 190, y: 600 - Math.floor(index / 3) * 200, width: 150, height: 150 });
  }
  return Buffer.from(await document.save());
}

describe('Markdown and HTML from a PDF carry the same pictures on every run', () => {
  it('pdfjs-issue9972-3.pdf (two pictures, 1 page) gives two pictures in Markdown on each run', async (ctx) => {
    const sample = await requireRealworldSample(ctx, 'pdfjs-issue9972-3.pdf');
    expect(await pictureCounts(sample.bytes, 'md')).toEqual(Array(RUNS).fill(2));
  });

  it('pdfjs-issue9972-2.pdf (two pictures, 1 page) gives two pictures in HTML on each run', async (ctx) => {
    const sample = await requireRealworldSample(ctx, 'pdfjs-issue9972-2.pdf');
    expect(await pictureCounts(sample.bytes, 'html')).toEqual(Array(RUNS).fill(2));
  });

  it('a hand-made PDF with several pictures gives all of them on each run while every core is busy', async () => {
    const bytes = await pdfWithPictures(PICTURES);
    const stopLoad = startBusyThreads();
    try {
      expect(await pictureCounts(bytes, 'md')).toEqual(Array(RUNS).fill(PICTURES));
      expect(await pictureCounts(bytes, 'html')).toEqual(Array(RUNS).fill(PICTURES));
    } finally {
      await stopLoad();
    }
  }, 120_000);
});
