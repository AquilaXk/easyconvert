import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAGICK_BINARY } from './helpers/imagemagick';
import { openPdfPageRenderer } from '../src/lib/conversions/pdf-page-render';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

/**
 * A scanned page is drawn for OCR at 300 dpi. Poppler spends nearly all of its time on a page like this in encoding
 * the PNG it writes (0.7 s of 0.8 s for a letter-size scan), which the OCR pipeline then decodes again, so the page is
 * taken from it as raw gray pixels and encoded with the cheapest setting of the image library. The oracle is Poppler's
 * own PNG of the same page: every pixel must be the one it draws, and the resolution must be the one it records.
 */

const DPI = 300;
const PAGE_WIDTH_PT = 612;
const PAGE_HEIGHT_PT = 792;
const SCAN_WIDTH_PX = 2550;
const SCAN_HEIGHT_PX = 3300;
const TIMING_RUNS = 3;
const REFERENCE_TIMEOUT_MS = 60_000;
/** Ours must cost at most this share of Poppler's PNG render of the same page (measured: about a seventh). */
const MAX_COST_RATIO = 0.5;
const TEST_TIMEOUT_MS = 120_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PIXELS_PER_METRE_AT_300_DPI = 11_811;
const PNG_CHUNK_OVERHEAD = 12;

/** The chunks of a PNG in file order, read here from the bytes so that no image library decides which one counts. */
function pngChunks(png: Buffer): Array<{ type: string; data: Buffer }> {
  const chunks: Array<{ type: string; data: Buffer }> = [];
  let offset = PNG_SIGNATURE.length;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    chunks.push({ type: png.toString('latin1', offset + 4, offset + 8), data: png.subarray(offset + 8, offset + 8 + length) });
    offset += PNG_CHUNK_OVERHEAD + length;
  }
  return chunks;
}

let workDir: string;
let scanPdf: string;

/** A gray scan: paper with seeded speckle and ruled lines, so the PNG does not collapse to a few bytes. */
function scanPixels(): Buffer {
  const pixels = Buffer.alloc(SCAN_WIDTH_PX * SCAN_HEIGHT_PX, 0xf4);
  let state = 0x2545f491;
  for (let index = 0; index < pixels.length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    if (state >>> 24 < 20) pixels[index] = state >>> 16 & 0x7f;
  }
  for (let row = 200; row < SCAN_HEIGHT_PX; row += 150) pixels.fill(0x10, row * SCAN_WIDTH_PX + 100, row * SCAN_WIDTH_PX + SCAN_WIDTH_PX - 100);
  return pixels;
}

beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-page-render-cost-'));
  const png = await sharp(scanPixels(), { raw: { width: SCAN_WIDTH_PX, height: SCAN_HEIGHT_PX, channels: 1 } }).png().toBuffer();
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE_WIDTH_PT, PAGE_HEIGHT_PT]);
  page.drawImage(await doc.embedPng(png), { x: 0, y: 0, width: PAGE_WIDTH_PT, height: PAGE_HEIGHT_PT });
  scanPdf = path.join(workDir, 'scan.pdf');
  fs.writeFileSync(scanPdf, await doc.save());
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function referencePng(): string {
  const base = path.join(workDir, 'reference');
  execFileSync(getOracleToolPath('pdftoppm') as string, ['-png', '-gray', '-cropbox', '-singlefile', '-r', String(DPI), scanPdf, base], { timeout: REFERENCE_TIMEOUT_MS });
  return `${base}.png`;
}

async function bestOf<T>(runs: number, task: () => Promise<T>): Promise<{ ms: number; value: T }> {
  let best = Number.POSITIVE_INFINITY;
  let value!: T;
  for (let run = 0; run < runs; run++) {
    const started = performance.now();
    value = await task();
    best = Math.min(best, performance.now() - started);
  }
  return { ms: best, value };
}

describe('rendering a scanned page for OCR', () => {
  oracleTest(
    'draws every pixel Poppler draws, records the resolution, and costs a fraction of Poppler PNG output',
    ['pdftoppm'],
    async () => {
      const pdf = fs.readFileSync(scanPdf);
      const renderer = await openPdfPageRenderer(pdf, undefined, DPI);
      try {
        const ours = await bestOf(TIMING_RUNS, () => renderer.render(0));
        const reference = await bestOf(TIMING_RUNS, async () => referencePng());

        const expectedRaw = await sharp(reference.value).raw().toBuffer({ resolveWithObject: true });
        const actualRaw = await sharp(ours.value.image).raw().toBuffer({ resolveWithObject: true });
        expect(actualRaw.info).toMatchObject({ width: SCAN_WIDTH_PX, height: SCAN_HEIGHT_PX, channels: expectedRaw.info.channels });
        expect(actualRaw.data.equals(expectedRaw.data)).toBe(true);

        const expectedMeta = await sharp(reference.value).metadata();
        const actualMeta = await sharp(ours.value.image).metadata();
        expect(expectedMeta.density).toBe(DPI);
        expect(actualMeta.density).toBe(DPI);
        expect(actualMeta.format).toBe('png');
        expect(ours.value.page).toMatchObject({ dpi: DPI, widthPx: SCAN_WIDTH_PX, heightPx: SCAN_HEIGHT_PX });

        expect(ours.ms / reference.ms, `ours ${ours.ms.toFixed(0)} ms against Poppler PNG ${reference.ms.toFixed(0)} ms`).toBeLessThan(MAX_COST_RATIO);
      } finally {
        await renderer.close();
      }
    },
    TEST_TIMEOUT_MS
  );

  it('keeps the page an 8-bit gray PNG, the form Poppler writes and the OCR preparation reads', async () => {
    const renderer = await openPdfPageRenderer(fs.readFileSync(scanPdf), undefined, DPI);
    try {
      const { image } = await renderer.render(0);
      // PNG signature, then the IHDR chunk: width, height, bit depth at byte 24, colour type at byte 25 (0 is grayscale).
      expect(image.subarray(0, 8)).toEqual(PNG_SIGNATURE);
      expect(image.subarray(12, 16).toString('latin1')).toBe('IHDR');
      expect(image.readUInt32BE(16)).toBe(SCAN_WIDTH_PX);
      expect(image.readUInt32BE(20)).toBe(SCAN_HEIGHT_PX);
      expect(image[24]).toBe(8);
      expect(image[25]).toBe(0);
    } finally {
      await renderer.close();
    }
  });

  oracleTest(
    'records the resolution in exactly one pHYs chunk that the other readers (Pillow, libpng through ImageMagick) read as 300 dpi without a warning',
    ['python3'],
    async () => {
      const renderer = await openPdfPageRenderer(fs.readFileSync(scanPdf), undefined, DPI);
      try {
        const { image } = await renderer.render(0);
        const chunks = pngChunks(image);
        const physical = chunks.filter((chunk) => chunk.type === 'pHYs');
        expect(chunks.map((chunk) => chunk.type).filter((type) => type !== 'IDAT')).toEqual(['IHDR', 'pHYs', 'IEND']);
        expect(physical).toHaveLength(1);
        expect(physical[0].data.readUInt32BE(0)).toBe(PIXELS_PER_METRE_AT_300_DPI);
        expect(physical[0].data.readUInt32BE(4)).toBe(PIXELS_PER_METRE_AT_300_DPI);
        expect(physical[0].data[8]).toBe(1);

        const file = path.join(workDir, 'rendered.png');
        fs.writeFileSync(file, image);
        const pillow = execFileSync(
          getOracleToolPath('python3') as string,
          ['-c', 'import sys; from PIL import Image; i = Image.open(sys.argv[1]); i.load(); print(i.info["dpi"][0], i.info["dpi"][1], i.mode)', file],
          { encoding: 'utf8', timeout: REFERENCE_TIMEOUT_MS }
        ).trim();
        const [dpiX, dpiY, mode] = pillow.split(' ');
        expect(Math.round(Number(dpiX))).toBe(DPI);
        expect(Math.round(Number(dpiY))).toBe(DPI);
        expect(mode).toBe('L');

        if (MAGICK_BINARY) {
          // libpng reports a repeated chunk as a warning on stderr.
          const identified = spawnSync(MAGICK_BINARY, ['identify', '-units', 'PixelsPerInch', '-format', '%x %y', file], { encoding: 'utf8', timeout: REFERENCE_TIMEOUT_MS });
          expect(identified.stderr).toBe('');
          const [x, y] = identified.stdout.trim().split(' ').map(Number);
          expect(Math.round(x)).toBe(DPI);
          expect(Math.round(y)).toBe(DPI);
        }
      } finally {
        await renderer.close();
      }
    },
    TEST_TIMEOUT_MS
  );
});
