import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { assemblePicturePdf } from '../src/lib/conversions/image-pdf-pages';
import { DEFAULT_PRINT_DENSITY } from '../src/lib/conversions/image-print-density';
import { requireOracleTool } from './helpers/differential-oracle';
import { CHANNELS_OF, craftPng, type CraftedPng } from './helpers/png-craft';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * A picture with an alpha channel (grey+alpha, RGBA), a palette (with or without a tRNS chunk) or interlacing is placed on a PDF page
 * without PDFKit's PNG reader, which keeps each byte of the image data as a JavaScript value. The page must show the same pixels the
 * reader showed and the pixels of the picture: Poppler (`pdfimages -png`) extracts the picture and its soft mask, and both are compared
 * with PDFKit's own output for the same PNG and with the PNG decoded by the image library.
 */

const PngReader = createRequire(import.meta.url)('png-js') as { prototype: { readUInt32(): number } };
const noTools = skipWithoutTools('pdfimages');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'image-pdf-alpha-png-'));
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

function samples(length: number, seed: number): Buffer {
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 31 + ((i * i) >> 3) + seed * 17) & 0xff;
  return out;
}

function crafted(colorType: number, bits: number, width: number, height: number, extra: Partial<CraftedPng> = {}): Buffer {
  const rowBytes = Math.ceil((width * CHANNELS_OF[colorType] * bits) / 8);
  const rows = samples(rowBytes * height, colorType + bits);
  // Every index of a palette picture names an entry of the palette.
  if (colorType === 3 && bits === 8) for (let i = 0; i < rows.length; i += 1) rows[i] %= (extra.palette as Buffer).length / 3;
  return craftPng({ width, height, bits, colorType, rows, ...extra });
}

/** A palette of `count` entries; a tRNS chunk of `count` alphas, the indices past it opaque. PDFKit's reader makes index 255 transparent whatever the chunk says, so the pictures it is compared on stop at 254. */
function palette(count: number): Buffer {
  return Buffer.from(Array.from({ length: count * 3 }, (_, i) => (i * 53 + 11) & 0xff));
}
function alphas(count: number): Buffer {
  return Buffer.from(Array.from({ length: count }, (_, i) => (i * 37 + 5) & 0xff));
}

async function interlaced(): Promise<Buffer> {
  const width = 53;
  const height = 37;
  return sharp(samples(width * height * 4, 9), { raw: { width, height, channels: 4 } })
    .png({ progressive: true })
    .toBuffer();
}

/** The PNG as PDFKit's own reader places it (the path every such picture took before). */
function pdfOfPdfKit(png: Buffer, width: number, height: number): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: [width, height], margin: 0 });
    const parts: Buffer[] = [];
    doc.on('data', (part) => parts.push(part));
    doc.on('end', () => resolve(Buffer.concat(parts)));
    doc.image(png, 0, 0, { width, height });
    doc.end();
  });
}

interface Extracted {
  /** `pdfimages -list` rows: type, width, height, colour, components, bpc. */
  listing: string[][];
  /** The extracted pictures in order (the image, then its soft mask) as raw 8-bit samples. */
  pictures: { data: Buffer; channels: number }[];
}

async function extract(pdf: Buffer, name: string): Promise<Extracted> {
  const file = path.join(directory, `${name}.pdf`);
  fs.writeFileSync(file, pdf);
  const tool = requireOracleTool('pdfimages');
  const lines = execFileSync(tool, ['-list', file], { encoding: 'utf8' }).trim().split('\n').slice(2);
  execFileSync(tool, ['-png', file, path.join(directory, name)]);
  const pictures: Extracted['pictures'] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const { data, info } = await sharp(path.join(directory, `${name}-${String(index).padStart(3, '0')}.png`)).raw().toBuffer({ resolveWithObject: true });
    pictures.push({ data, channels: info.channels });
  }
  return { listing: lines.map((line) => line.trim().split(/\s+/).slice(2, 9)), pictures };
}

/** The first channel of each pixel (Poppler writes a grey picture with one channel or three equal ones). */
function firstChannel(picture: Extracted['pictures'][number]): Buffer {
  const out = Buffer.alloc(picture.data.length / picture.channels);
  for (let i = 0; i < out.length; i += 1) out[i] = picture.data[i * picture.channels];
  return out;
}

/** The PNG decoded by the image library, as 8-bit colour channels and the alpha channel (null for none); a 16-bit sample keeps its top byte. */
async function decoded(png: Buffer): Promise<{ color: Buffer; alpha: Buffer | null; colors: number }> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const bytes = info.depth === 'ushort' ? 2 : 1;
  const channels = info.channels;
  const hasAlpha = channels === 2 || channels === 4;
  const colors = hasAlpha ? channels - 1 : channels;
  const color = Buffer.alloc(info.width * info.height * colors);
  const alpha = hasAlpha ? Buffer.alloc(info.width * info.height) : null;
  for (let pixel = 0; pixel < info.width * info.height; pixel += 1) {
    for (let c = 0; c < colors; c += 1) color[pixel * colors + c] = data[(pixel * channels + c) * bytes + bytes - 1];
    if (alpha) alpha[pixel] = data[(pixel * channels + colors) * bytes + bytes - 1];
  }
  return { color, alpha, colors };
}

interface Case {
  name: string;
  png: () => Buffer | Promise<Buffer>;
  /** The PDF objects: the image type and its soft mask (`pdfimages -list` types). */
  types: string[];
  /** False for a picture PDFKit's own reader gets wrong (a palette alpha of fewer than 8 bits per index). */
  matchesPdfKit?: boolean;
}

const W = 41;
const H = 23;
const cases: Case[] = [
  { name: 'grey+alpha 8-bit', png: () => crafted(4, 8, W, H), types: ['image', 'smask'] },
  { name: 'grey+alpha 16-bit', png: () => crafted(4, 16, W, H), types: ['image', 'smask'] },
  { name: 'RGBA 8-bit', png: () => crafted(6, 8, W, H), types: ['image', 'smask'] },
  { name: 'RGBA 16-bit', png: () => crafted(6, 16, W, H), types: ['image', 'smask'] },
  { name: 'palette 8-bit', png: () => crafted(3, 8, W, H, { palette: palette(256) }), types: ['image'] },
  { name: 'palette 4-bit', png: () => crafted(3, 4, W, H, { palette: palette(16) }), types: ['image'] },
  { name: 'palette 2-bit', png: () => crafted(3, 2, W, H, { palette: palette(4) }), types: ['image'] },
  { name: 'palette 8-bit with tRNS', png: () => crafted(3, 8, W, H, { palette: palette(255), transparency: alphas(150) }), types: ['image', 'smask'] },
  { name: 'palette 4-bit with tRNS', png: () => crafted(3, 4, W, H, { palette: palette(16), transparency: alphas(5) }), types: ['image', 'smask'], matchesPdfKit: false },
  { name: 'palette 8-bit, index 255, short tRNS', png: () => crafted(3, 8, W, H, { palette: palette(256), transparency: alphas(10) }), types: ['image', 'smask'], matchesPdfKit: false },
  { name: 'interlaced RGBA', png: interlaced, types: ['image', 'smask'] },
];

describe('an alpha, palette or interlaced PNG on a PDF page', () => {
  it.each(cases)('$name: pixels equal PDFKit\'s page and the source', async ({ name, png, types, matchesPdfKit }) => {
    if (noTools) return;
    const source = await png();
    const { width, height } = await sharp(source).metadata();
    const slug = name.replace(/\W+/g, '-');
    const page = { png: source, width: width as number, height: height as number, density: DEFAULT_PRINT_DENSITY };
    // PDFKit's reader reads a chunk length first, so a spy on that method sees whether the reader was given the PNG.
    const readerCalls = vi.spyOn(PngReader.prototype, 'readUInt32');
    const pdf = await assemblePicturePdf([page], undefined);
    expect(readerCalls).not.toHaveBeenCalled();
    readerCalls.mockRestore();
    const fresh = await extract(pdf, `new-${slug}`);
    expect(fresh.listing.map((row) => row[0])).toEqual(types);

    const expected = await decoded(source);
    expect(firstChannelsOf(fresh.pictures[0], expected.colors).equals(expected.color)).toBe(true);
    if (expected.alpha) expect(firstChannel(fresh.pictures[1]).equals(expected.alpha)).toBe(true);

    if (matchesPdfKit === false) return;
    const oldCalls = vi.spyOn(PngReader.prototype, 'readUInt32');
    const oldPdf = await pdfOfPdfKit(source, width as number, height as number);
    expect(oldCalls).toHaveBeenCalled();
    oldCalls.mockRestore();
    const old = await extract(oldPdf, `old-${slug}`);
    expect(fresh.listing).toEqual(old.listing);
    fresh.pictures.forEach((picture, index) => {
      expect(picture.channels).toBe(old.pictures[index].channels);
      expect(picture.data.equals(old.pictures[index].data)).toBe(true);
    });
  });
});

/** The colour channels of an extracted picture, `colors` of them per pixel (a grey picture may come as three equal channels). */
function firstChannelsOf(picture: Extracted['pictures'][number], colors: number): Buffer {
  if (colors === 1) return firstChannel(picture);
  return picture.data;
}
