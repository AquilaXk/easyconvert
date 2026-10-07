import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import { convertFile } from '../src/lib/conversions';
import { CBZ_MAX_PAGES, compareNaturally } from '../src/lib/conversions/office';
import { ConversionFailedError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { extractTextWithExternalPdftotext, requireOracleTool } from './helpers/differential-oracle';

const PAGE_COUNT = 12;
const BASE_WIDTH = 40;
const WIDTH_STEP = 4;
const PAGE_HEIGHT = 30;
const PDF_MAGIC = '%PDF-';
const LARGE_ARCHIVE_TIMEOUT_MS = 120_000;

/** A solid PNG whose width identifies the page, so the order of images in the PDF proves the page order. */
async function pagePng(width: number): Promise<Buffer> {
  return sharp({ create: { width, height: PAGE_HEIGHT, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer();
}

async function cbzOf(entries: [string, Buffer][]): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, data] of entries) zip.file(name, data);
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** Width of the image on each PDF page, read with `pdfimages -list` (a reader independent of the converter). */
function imageWidthsByPage(pdf: Buffer): { page: number; width: number }[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbz-oracle-'));
  try {
    fs.writeFileSync(path.join(dir, 'book.pdf'), pdf);
    const listing = execFileSync(requireOracleTool('pdfimages'), ['-list', path.join(dir, 'book.pdf')], { encoding: 'utf-8' });
    return listing
      .split('\n')
      .slice(2)
      .map((line) => line.trim().split(/\s+/))
      // Transparent pages also list a soft mask; only the pictures themselves count.
      .filter((columns) => columns[2] === 'image')
      .map((columns) => ({ page: Number(columns[0]), width: Number(columns[3]) }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A 24-bit uncompressed BMP written from the BITMAPINFOHEADER layout: a solid colour, bottom-up rows padded to 4 bytes. */
function solidBmp(width: number, height: number): Buffer {
  const BYTES_PER_PIXEL = 3;
  const ROW_ALIGN = 4;
  const HEADER_BYTES = 54;
  const rowBytes = Math.ceil((width * BYTES_PER_PIXEL) / ROW_ALIGN) * ROW_ALIGN;
  const bmp = Buffer.alloc(HEADER_BYTES + rowBytes * height);
  bmp.write('BM', 0, 'latin1');
  bmp.writeUInt32LE(bmp.length, 2);
  bmp.writeUInt32LE(HEADER_BYTES, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(width, 18);
  bmp.writeInt32LE(height, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) bmp.set([30, 30, 200], HEADER_BYTES + y * rowBytes + x * BYTES_PER_PIXEL);
  }
  return bmp;
}

describe('natural page order', () => {
  it('compares digit runs by value and the rest case-insensitively', () => {
    const shuffled = ['page10.png', 'page2.png', 'Page1.png', 'page01b.png', 'page1a.png', 'cover.png', 'page100.png', 'page9.png'];
    expect([...shuffled].sort(compareNaturally)).toEqual([
      'cover.png',
      'Page1.png',
      'page1a.png',
      'page01b.png',
      'page2.png',
      'page9.png',
      'page10.png',
      'page100.png',
    ]);
  });

  it('orders by chapter folder before page number', () => {
    const names = ['ch10/p1.jpg', 'ch2/p10.jpg', 'ch2/p2.jpg'];
    expect([...names].sort(compareNaturally)).toEqual(['ch2/p2.jpg', 'ch2/p10.jpg', 'ch10/p1.jpg']);
  });
});

describe('CBZ to PDF', () => {
  oracleTest('binds page1..page12 in natural order, whatever the order inside the archive', ['pdfimages', 'pdftotext'], async () => {
    const entries: [string, Buffer][] = [];
    for (let n = PAGE_COUNT; n >= 1; n--) entries.push([`page${n}.png`, await pagePng(BASE_WIDTH + n * WIDTH_STEP)]);
    const result = await convertFile(await cbzOf(entries), 'cbz', 'pdf', {}, 'comic.cbz');
    const images = imageWidthsByPage(result.buffer);
    expect(images.map((image) => image.page)).toEqual(Array.from({ length: PAGE_COUNT }, (_, i) => i + 1));
    expect(images.map((image) => image.width)).toEqual(Array.from({ length: PAGE_COUNT }, (_, i) => BASE_WIDTH + (i + 1) * WIDTH_STEP));
    expect((extractTextWithExternalPdftotext(result.buffer) ?? '').trim()).toBe('');
  });

  oracleTest('embeds JPEG, WebP and GIF pages as images of their own size', ['pdfimages'], async () => {
    const base = await pagePng(BASE_WIDTH);
    const entries: [string, Buffer][] = [
      ['1.jpg', await sharp(base).resize(BASE_WIDTH + 1).jpeg().toBuffer()],
      ['2.webp', await sharp(base).resize(BASE_WIDTH + 2).webp().toBuffer()],
      ['3.gif', await sharp(base).resize(BASE_WIDTH + 3).gif().toBuffer()],
    ];
    const result = await convertFile(await cbzOf(entries), 'cbz', 'pdf', {}, 'mixed.cbz');
    expect(imageWidthsByPage(result.buffer).map((image) => image.width)).toEqual([BASE_WIDTH + 1, BASE_WIDTH + 2, BASE_WIDTH + 3]);
  });

  oracleTest('embeds a BMP page, which libvips cannot read, at its own size', ['pdfimages'], async () => {
    const result = await convertFile(await cbzOf([['1.bmp', solidBmp(BASE_WIDTH + 7, PAGE_HEIGHT)]]), 'cbz', 'pdf', {}, 'bmp.cbz');
    expect(imageWidthsByPage(result.buffer).map((image) => image.width)).toEqual([BASE_WIDTH + 7]);
  });

  it('ignores resource forks and hidden files that archivers add', async () => {
    const png = await pagePng(BASE_WIDTH);
    const cbz = await cbzOf([
      ['__MACOSX/._page1.png', Buffer.from('resource fork')],
      ['.hidden.png', Buffer.from('hidden')],
      ['page1.png', png],
    ]);
    const result = await convertFile(cbz, 'cbz', 'pdf', {}, 'comic.cbz');
    expect(result.buffer.subarray(0, PDF_MAGIC.length).toString('latin1')).toBe(PDF_MAGIC);
  });

  it('fails with a typed 400 error naming a page that cannot be decoded, never a text page', async () => {
    const good = await pagePng(BASE_WIDTH);
    const corrupt = Buffer.concat([good.subarray(0, 40), Buffer.alloc(32, 0xff)]);
    const run = convertFile(await cbzOf([['page1.png', good], ['page2.png', corrupt]]), 'cbz', 'pdf', {}, 'comic.cbz');
    await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(run).rejects.toThrow(/CBZ page "page2\.png" cannot be (decoded|embedded)/);
  });

  it('fails a page that is not an image at all', async () => {
    const run = convertFile(await cbzOf([['page1.png', Buffer.from('this is text, not a PNG')]]), 'cbz', 'pdf', {}, 'comic.cbz');
    await expect(run).rejects.toThrow(/CBZ page "page1\.png" cannot be decoded/);
  });

  it('fails an archive without page images', async () => {
    const run = convertFile(await cbzOf([['readme.txt', Buffer.from('no pages here')]]), 'cbz', 'pdf', {}, 'empty.cbz');
    await expect(run).rejects.toThrow('The CBZ archive holds no page images.');
  });

  it('fails bytes that are not a ZIP archive', async () => {
    const run = convertFile(Buffer.from('PK\u0003\u0004 truncated', 'latin1'), 'cbz', 'pdf', {}, 'bad.cbz');
    await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(run).rejects.toMatchObject({ message: 'The CBZ file is not a valid ZIP archive.' });
  });

  it('refuses an archive with more pages than the limit before decoding any', async () => {
    const entries: [string, Buffer][] = Array.from({ length: CBZ_MAX_PAGES + 1 }, (_, i) => [`p${i}.png`, Buffer.alloc(1)]);
    const run = convertFile(await cbzOf(entries), 'cbz', 'pdf', {}, 'huge.cbz');
    await expect(run).rejects.toThrow(`more than the ${CBZ_MAX_PAGES} page limit`);
  }, LARGE_ARCHIVE_TIMEOUT_MS);
});
