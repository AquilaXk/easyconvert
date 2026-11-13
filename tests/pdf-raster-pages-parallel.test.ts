import { expect, vi } from 'vitest';
import JSZip from 'jszip';
import sharp from 'sharp';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import * as conversions from '../src/lib/conversions';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { pageRenderProcesses } from '../src/worker/poppler-ppm';
import { oracleTest } from './helpers/oracle-test';

/**
 * The pages of a PDF written as BMP, GIF, WebP or AVIF are drawn as PNG pages and then encoded one by one. The encoding goes several pages
 * at a time (as many as the pages are drawn by), so that a document of hundreds of pages stays inside the stage limit: the regression
 * corpus's `gd-209092.pdf` to AVIF took 38 s of its 48 s in the encoding loop, one page after another, on the Linux VM. Every page is the
 * file the encoder writes for that page alone, in its place in the ZIP.
 */

const PAGES = 12;
const PAUSE_MS = 150;
const NATIVE_TIMEOUT_MS = 120_000;

async function document(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < PAGES; index++) {
    const page = doc.addPage([240 + (index % 5) * 10, 180]);
    page.drawRectangle({ x: 10 + index, y: 10, width: 60, height: 40, color: rgb(0.84, 0.15, 0.16) });
    page.drawText(`Page ${index + 1} of the drawing`, { x: 14, y: 140, size: 14, font });
  }
  return Buffer.from(await doc.save());
}

async function pagesOf(buffer: Buffer): Promise<Array<{ name: string; data: Buffer }>> {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files).sort();
  return Promise.all(names.map(async (name) => ({ name, data: await (zip.file(name) as JSZip.JSZipObject).async('nodebuffer') })));
}

oracleTest(
  'the pages of a long PDF are encoded several at a time, each page once, and every page is the file the encoder writes for it alone',
  ['pdftoppm'],
  async () => {
    const pdf = await document();
    const original = conversions.convertImage;
    let running = 0;
    let mostAtOnce = 0;
    const calls: string[] = [];
    const spy = vi.spyOn(conversions, 'convertImage').mockImplementation(async (...args: Parameters<typeof original>) => {
      running++;
      mostAtOnce = Math.max(mostAtOnce, running);
      calls.push(String(args[3]));
      try {
        await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
        return await original(...args);
      } finally {
        running--;
      }
    });
    try {
      const bmp = await pagesOf((await dispatchConversion(pdf, 'pdf', 'bmp', {}, 'long.pdf')).buffer);
      const pngs = await pagesOf((await dispatchConversion(pdf, 'pdf', 'png', {}, 'long.pdf')).buffer);
      expect(bmp.map((page) => page.name)).toEqual(pngs.map((page) => page.name.replace(/\.png$/, '.bmp')));
      expect(bmp).toHaveLength(PAGES);
      spy.mockRestore();
      for (const [index, page] of bmp.entries()) {
        const alone = (await original(pngs[index].data, 'bmp', {}, pngs[index].name, 'png')).buffer;
        expect({ name: page.name, same: page.data.equals(alone) }).toEqual({ name: page.name, same: true });
      }
      expect([...calls].sort()).toEqual(pngs.map((page) => page.name).sort());
      expect(mostAtOnce).toBe(Math.min(pageRenderProcesses(), PAGES));
    } finally {
      spy.mockRestore();
    }
  },
  NATIVE_TIMEOUT_MS
);

/**
 * The PNG pages that only feed the encoder are written the cheap way (no adaptive filter search): the same pixels, a third of the time of
 * the page PNG that a PNG request gets, which is what the encoder reads back and drops. The files of the PNG route keep the full search.
 */
oracleTest(
  'the PNG pages handed to the encoder hold the pixels of the PNG pages of the PNG route, written without the filter search',
  ['pdftoppm'],
  async () => {
    const pdf = await document();
    const original = conversions.convertImage;
    const handed = new Map<string, Buffer>();
    const spy = vi.spyOn(conversions, 'convertImage').mockImplementation(async (...args: Parameters<typeof original>) => {
      handed.set(String(args[3]), args[0] as Buffer);
      return original(...args);
    });
    try {
      await dispatchConversion(pdf, 'pdf', 'bmp', {}, 'long.pdf');
    } finally {
      spy.mockRestore();
    }
    const pngs = await pagesOf((await dispatchConversion(pdf, 'pdf', 'png', {}, 'long.pdf')).buffer);
    expect([...handed.keys()].sort()).toEqual(pngs.map((page) => page.name));
    for (const page of pngs) {
      const intermediate = handed.get(page.name) as Buffer;
      const pixels = async (png: Buffer) => (await sharp(png).raw().toBuffer({ resolveWithObject: true }));
      const [a, b] = await Promise.all([pixels(intermediate), pixels(page.data)]);
      expect({ name: page.name, info: a.info, same: a.data.equals(b.data) }).toEqual({ name: page.name, info: b.info, same: true });
      expect({ name: page.name, written: 'cheaply', identical: intermediate.equals(page.data) }).toEqual({ name: page.name, written: 'cheaply', identical: false });
    }
  },
  NATIVE_TIMEOUT_MS
);
