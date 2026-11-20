import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { create7zArchive, createTarArchive } from '../src/lib/conversions/archive';
import { ConversionFailedError } from '../src/lib/types';
import { requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

/**
 * Comic archives packed as 7z (CB7) and TAR (CBT) are bound into a PDF as a CBZ is: the pages are the images, in natural name order.
 * Both were refused as "binary container" by the plain-text reader (the sweep of 2026-11-20). The pages are JPEGs whose widths tell them
 * apart, and `pdfimages -list` (a reader independent of the converter) says which picture is on which page.
 */

const PDF_MAGIC = '%PDF-';
const PAGE_HEIGHT = 30;
const WIDTHS = [40, 52, 64];

async function jpeg(width: number): Promise<Buffer> {
  return sharp({ create: { width, height: PAGE_HEIGHT, channels: 3, background: { r: 30, g: 120, b: 200 } } }).jpeg().toBuffer();
}

/** The archives name the pages out of order, so the order in the PDF is the natural one by name and not the order of the archive. */
async function pages(): Promise<Array<{ filename: string; buffer: Buffer }>> {
  return [
    { filename: 'page10.jpg', buffer: await jpeg(WIDTHS[2]) },
    { filename: 'page2.jpg', buffer: await jpeg(WIDTHS[1]) },
    { filename: 'page1.jpg', buffer: await jpeg(WIDTHS[0]) },
    { filename: 'notes.txt', buffer: Buffer.from('not a page') },
  ];
}

function imageWidthsByPage(pdf: Buffer): number[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comic-oracle-'));
  try {
    fs.writeFileSync(path.join(dir, 'book.pdf'), pdf);
    const listing = execFileSync(requireOracleTool('pdfimages'), ['-list', path.join(dir, 'book.pdf')], { encoding: 'utf-8' });
    return listing
      .split('\n')
      .slice(2)
      .map((line) => line.trim().split(/\s+/))
      .filter((columns) => columns[2] === 'image')
      .map((columns) => Number(columns[3]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe.each([
  ['cb7', async () => create7zArchive(await pages()).buffer],
  ['cbt', async () => createTarArchive(await pages()).buffer],
] as const)('a .%s comic archive', (source, build) => {
  it('is bound into a PDF with a page for each image', async () => {
    const result = await convertFile(await build(), source, 'pdf', {}, `comic.${source}`);
    expect(result.buffer.toString('latin1', 0, PDF_MAGIC.length)).toBe(PDF_MAGIC);
  });

  oracleTest('puts the pages in natural name order', ['pdfimages'], async () => {
    const result = await convertFile(await build(), source, 'pdf', {}, `comic.${source}`);
    expect(imageWidthsByPage(result.buffer)).toEqual(WIDTHS);
  });

  it('refuses an archive with no page image in a typed error', async () => {
    const archive = source === 'cb7' ? create7zArchive([{ filename: 'a.txt', buffer: Buffer.from('words') }]).buffer : createTarArchive([{ filename: 'a.txt', buffer: Buffer.from('words') }]).buffer;
    const failure = await convertFile(archive, source, 'pdf', {}, `comic.${source}`).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect((failure as Error).message).toBe(`The ${source.toUpperCase()} archive holds no page images.`);
  });
});
