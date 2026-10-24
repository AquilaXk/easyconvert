import { deflateSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { convertFile } from '../src/lib/conversions/index';
import { shutdownPdfTextThreads } from '../src/lib/conversions/pdf-text-host';
import { ImageExtractor } from '../src/lib/conversions/pdf-text-images';
import { PDF_TEXT_DEADLINE_ENV, type PdfContentImage } from '../src/lib/conversions/pdf-text-types';
import { startBusyThreads } from './helpers/busy-threads';
import { buildPdf } from './helpers/pdf-craft';
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

/**
 * The text thread stays up between documents, and pdf.js keeps the decoders of CCITT and JBIG2 pictures for the whole thread
 * (`WasmImage`, `pdf.worker.mjs` of pdfjs-dist 6.3.289): a document that is closed while pdf.js still decodes one of its pictures
 * sets the decoder up again through the closed document, which never answers, and every later picture of that kind on the thread
 * waits for it until the thread's deadline. Page 1 paints a CCITT stencil mask, which pdf.js decodes while it builds the operator
 * list; page 2 paints a gray picture whose /Mask is CCITT-encoded, which it decodes after the list has resolved.
 */
const THREAD_REUSE_ROUNDS = 6;
const THREAD_REUSE_DEADLINE_MS = 10_000;
const MASKED_PICTURE_SIZE = 64;

function pdfWithLateCcittMask(): Buffer {
  const text = 'BT /F1 14 Tf 20 760 Td (Quarterly figures of the regional offices.) Tj ET\n';
  const ccitt = (size: number) =>
    `/Type /XObject /Subtype /Image /Width ${size} /Height ${size} /ImageMask true /BitsPerComponent 1 /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns ${size} /Rows ${size} >>`;
  // End of facsimile block alone: a picture with no black run.
  const eofb = Buffer.from([0x00, 0x10, 0x01]);
  const size = MASKED_PICTURE_SIZE;
  return buildPdf(
    [
      { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
      { id: 2, dict: '/Type /Pages /Kids [3 0 R 8 0 R] /Count 2' },
      { id: 3, dict: '/Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> /XObject << /Im0 5 0 R >> >> /Contents 6 0 R' },
      { id: 4, dict: '/Type /Font /Subtype /Type1 /BaseFont /Helvetica' },
      { id: 5, dict: ccitt(8), stream: eofb },
      { id: 6, stream: Buffer.from(`${text}q 100 0 0 100 50 300 cm /Im0 Do Q`) },
      { id: 7, dict: ccitt(size), stream: eofb },
      { id: 8, dict: '/Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> /XObject << /Im1 9 0 R >> >> /Contents 10 0 R' },
      {
        id: 9,
        dict: `/Type /XObject /Subtype /Image /Width ${size} /Height ${size} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Mask 7 0 R`,
        stream: deflateSync(Buffer.alloc(size * size, 120)),
      },
      { id: 10, stream: Buffer.from(`${text}q 300 0 0 300 50 300 cm /Im1 Do Q`) },
    ],
    1
  ).buffer;
}

const MANY_PICTURES = 5000;
const PICTURES_PER_ROW = 250;

/** One page with a line of text and `count` distinct 2 x 2 gray pictures, each its own image XObject: as many dependencies as pictures. */
function pdfWithDistinctPictures(count: number): Buffer {
  const firstPicture = 6;
  const draws = Array.from({ length: count }, (_, index) => `q 2 0 0 2 ${(index % PICTURES_PER_ROW) * 2} ${Math.floor(index / PICTURES_PER_ROW) * 2} cm /Im${index} Do Q`);
  const names = Array.from({ length: count }, (_, index) => `/Im${index} ${firstPicture + index} 0 R`).join(' ');
  return buildPdf(
    [
      { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
      { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
      { id: 3, dict: `/Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> /XObject << ${names} >> >> /Contents 5 0 R` },
      { id: 4, dict: '/Type /Font /Subtype /Type1 /BaseFont /Helvetica' },
      { id: 5, stream: Buffer.from(`BT /F1 14 Tf 20 760 Td (Quarterly figures of the regional offices.) Tj ET\n${draws.join('\n')}`) },
      ...Array.from({ length: count }, (_, index) => ({
        id: firstPicture + index,
        dict: '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode',
        stream: deflateSync(Buffer.from([index & 0xff, (index >> 8) & 0xff, 7, 9])),
      })),
    ],
    1
  ).buffer;
}

/** A conversion's outcome: the byte length of its result, or the class of its error. */
async function outcome(bytes: Buffer, target: string): Promise<string> {
  try {
    return `${target} ${(await convertFile(bytes, 'pdf', target, {}, 'document.pdf')).buffer.length}`;
  } catch (error) {
    return `${target} ${(error as Error).constructor.name}`;
  }
}

/** The outcome of each target converted on a thread of its own. */
async function outcomesOnFreshThreads(bytes: Buffer, targets: readonly string[]): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  for (const target of targets) {
    shutdownPdfTextThreads();
    results.set(target, await outcome(bytes, target));
  }
  shutdownPdfTextThreads();
  return results;
}

/** The outcomes of the conversions run one after another, on the one thread a sequence of jobs reuses. */
async function outcomesInSequence(bytes: Buffer, targets: readonly string[]): Promise<string[]> {
  const results: string[] = [];
  for (const target of targets) results.push(await outcome(bytes, target));
  return results;
}

describe('a document read after another on the same text thread', () => {
  const deadlineBefore = process.env[PDF_TEXT_DEADLINE_ENV];
  afterAll(() => {
    if (deadlineBefore === undefined) delete process.env[PDF_TEXT_DEADLINE_ENV];
    else process.env[PDF_TEXT_DEADLINE_ENV] = deadlineBefore;
    shutdownPdfTextThreads();
  });

  it('converts after a text conversion that ended while pdf.js still decoded a CCITT mask', async () => {
    process.env[PDF_TEXT_DEADLINE_ENV] = String(THREAD_REUSE_DEADLINE_MS);
    const bytes = pdfWithLateCcittMask();
    const targets = Array.from({ length: THREAD_REUSE_ROUNDS }, () => ['txt', 'md']).flat();
    const alone = await outcomesOnFreshThreads(bytes, ['txt', 'md']);
    expect(await outcomesInSequence(bytes, targets)).toEqual(targets.map((target) => alone.get(target)));
  }, 180_000);

  it('reads a page of 5,000 distinct pictures to text and then to Markdown on one thread as each reads on a thread of its own', async () => {
    process.env[PDF_TEXT_DEADLINE_ENV] = String(THREAD_REUSE_DEADLINE_MS);
    const bytes = pdfWithDistinctPictures(MANY_PICTURES);
    const targets = ['txt', 'md', 'txt', 'md'];
    const alone = await outcomesOnFreshThreads(bytes, ['txt', 'md']);
    expect(await outcomesInSequence(bytes, targets)).toEqual(targets.map((target) => alone.get(target)));
  }, 180_000);

  it('gd-026598.pdf to Markdown and HTML after its text holds the pictures it holds on a fresh thread', async (ctx) => {
    const sample = await requireRealworldSample(ctx, 'gd-026598.pdf');
    process.env[PDF_TEXT_DEADLINE_ENV] = String(THREAD_REUSE_DEADLINE_MS);
    const targets = Array.from({ length: 3 }, () => ['txt', 'md', 'txt', 'html']).flat();
    const alone = await outcomesOnFreshThreads(sample.bytes, ['txt', 'md', 'html']);
    expect(await outcomesInSequence(sample.bytes, targets)).toEqual(targets.map((target) => alone.get(target)));
  }, 180_000);
});
