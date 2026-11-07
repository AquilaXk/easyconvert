import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { assemblePicturePdf } from '../src/lib/conversions/image-pdf-pages';
import { DEFAULT_PRINT_DENSITY } from '../src/lib/conversions/image-print-density';
import { requireOracleTool } from './helpers/differential-oracle';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * A picture goes on a PDF page as its PNG data stream, which the page carries as it is (ISO 32000-1 7.4.4.4: a Flate stream with a
 * PNG predictor), and PDFKit's PNG reader keeps every byte of that stream as a JavaScript number. A noisy 50 megapixel picture
 * (a camera file developed to PNG) is then hundreds of megabytes of heap on top of the pixels, and a worker with several jobs at once
 * is killed for memory (issue #783, the real-world file pix-google-pixel6pro.dng to PDF). A plain picture (opaque, not interlaced,
 * no palette, no colour key) is therefore embedded from its chunks without the reader, and so is an RGBA one (its planes are split row
 * by row; tests/image-pdf-alpha-palette-png-embed.test.ts); only a colour key or an animation still goes through the reader. The PDF is judged by Poppler (`pdfimages`).
 */

const noTools = skipWithoutTools('pdfimages');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'image-pdf-plain-png-'));
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

const HEAP_LIMIT_MB = 96;
const NOISE_WIDTH = 2400;
const NOISE_HEIGHT = 2400;

function gradient(width: number, height: number, channels: 1 | 3 | 4): Buffer {
  const raw = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let c = 0; c < channels; c += 1) raw[(y * width + x) * channels + c] = c === 3 ? 128 : (x * 7 + y * 13 + c * 60) % 256;
    }
  }
  return raw;
}

async function pdfOf(raw: Buffer, width: number, height: number, channels: 1 | 3 | 4, png: (s: Sharp) => Sharp = (s) => s.png()): Promise<string> {
  const picture = await png(sharp(raw, { raw: { width, height, channels } })).toBuffer();
  const pdf = await assemblePicturePdf([{ png: picture, width, height, density: DEFAULT_PRINT_DENSITY }], undefined);
  const file = path.join(directory, `${channels}-${width}x${height}-${Math.random().toString(36).slice(2)}.pdf`);
  fs.writeFileSync(file, pdf);
  return file;
}

/** The rows of `pdfimages -list` after the header: one per image, a soft mask included. */
function imageRows(pdf: string): string[][] {
  const lines = execFileSync(requireOracleTool('pdfimages'), ['-list', pdf], { encoding: 'utf8' }).trim().split('\n').slice(2);
  return lines.map((line) => line.trim().split(/\s+/));
}

/** The first picture of the PDF as Poppler extracts it (`pdfimages -png`): its raw samples and its size. */
async function extracted(pdf: string): Promise<{ data: Buffer; width: number; height: number; channels: number }> {
  const stem = pdf.replace(/\.pdf$/, '');
  execFileSync(requireOracleTool('pdfimages'), ['-png', pdf, stem]);
  const { data, info } = await sharp(`${stem}-000.png`).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

describe('a plain PNG on a PDF page', () => {
  it.skipIf(noTools).each([
    { kind: 'plain', channels: '3', samplesPerPixel: 3 },
    { kind: 'RGBA', channels: '4', samplesPerPixel: 4 },
  ])('is placed from its chunks without holding its bytes as JavaScript values ($kind)', ({ channels, samplesPerPixel }) => {
    const child = path.join(__dirname, 'image-pdf-heap-child.ts');
    const run = spawnSync(
      process.execPath,
      [`--max-old-space-size=${HEAP_LIMIT_MB}`, '--import', 'tsx', child, String(NOISE_WIDTH), String(NOISE_HEIGHT), channels],
      { encoding: 'utf8', timeout: 120_000 }
    );
    expect(run.stderr.slice(0, 300)).not.toMatch(/heap out of memory/);
    expect(run.status).toBe(0);
    expect(Number(run.stdout)).toBeGreaterThan(NOISE_WIDTH * NOISE_HEIGHT * samplesPerPixel);
  });

  it.skipIf(noTools)('keeps every pixel of an RGB picture (listed as 8-bit RGB)', async () => {
    const width = 96;
    const height = 64;
    const raw = gradient(width, height, 3);
    const pdf = await pdfOf(raw, width, height, 3);
    expect(imageRows(pdf).map((row) => row.slice(3, 8))).toEqual([[String(width), String(height), 'rgb', '3', '8']]);
    const picture = await extracted(pdf);
    expect({ width: picture.width, height: picture.height, channels: picture.channels }).toEqual({ width, height, channels: 3 });
    expect(picture.data.equals(raw)).toBe(true);
  });

  it.skipIf(noTools)('keeps every pixel of a grey picture (listed as 8-bit gray)', async () => {
    const width = 80;
    const height = 48;
    const raw = gradient(width, height, 1);
    const pdf = await pdfOf(raw, width, height, 1, (s) => s.toColourspace('b-w').png());
    expect(imageRows(pdf).map((row) => row.slice(3, 8))).toEqual([[String(width), String(height), 'gray', '1', '8']]);
    // Poppler writes a grey image as a PNG that the reader expands to three equal channels.
    const picture = await extracted(pdf);
    expect(picture.data.length).toBe(raw.length * picture.channels);
    for (let at = 0; at < raw.length; at += 1) expect(picture.data[at * picture.channels]).toBe(raw[at]);
  });

  it.skipIf(noTools)('still gives a picture with an alpha channel its soft mask', async () => {
    const width = 64;
    const height = 40;
    const pdf = await pdfOf(gradient(width, height, 4), width, height, 4);
    const rows = imageRows(pdf);
    expect(rows.map((row) => row[2])).toEqual(['image', 'smask']);
  });

  it.skipIf(noTools)('still reads an interlaced picture', async () => {
    const width = 70;
    const height = 50;
    const raw = gradient(width, height, 3);
    const pdf = await pdfOf(raw, width, height, 3, (s) => s.png({ progressive: true }));
    expect((await extracted(pdf)).data.equals(raw)).toBe(true);
  });

  it.skipIf(noTools)('still reads a palette picture', async () => {
    const width = 64;
    const height = 32;
    const raw = gradient(width, height, 3);
    const pdf = await pdfOf(raw, width, height, 3, (s) => s.png({ palette: true, colours: 256, dither: 0 }));
    const rows = imageRows(pdf);
    expect(rows).toHaveLength(1);
    expect(rows[0].slice(5, 8)).toEqual(['index', '1', '8']);
  });

  it.skipIf(noTools)('puts the pictures of a multi-page document on their own pages', async () => {
    const png = (shade: number) => sharp({ create: { width: 30, height: 20, channels: 3, background: { r: shade, g: shade, b: shade } } }).png().toBuffer();
    const pdf = await assemblePicturePdf(
      [
        { png: await png(10), width: 30, height: 20, density: DEFAULT_PRINT_DENSITY },
        { png: await png(200), width: 30, height: 20, density: DEFAULT_PRINT_DENSITY },
      ],
      undefined
    );
    const file = path.join(directory, 'two-pages.pdf');
    fs.writeFileSync(file, pdf);
    const rows = imageRows(file);
    expect(rows.map((row) => row[0])).toEqual(['1', '2']);
  });
});
