import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { expect } from 'vitest';
import { requireOracleTool } from './differential-oracle';
import { decodeRgba, maxSampleDifference, type DecodedRgba } from './image-pixels';
import { sofficeConvert } from './soffice-office';

/**
 * Readers other than the converter for a document that becomes page images: the office suite's own PDF of the same file, whose
 * pages `pdftoppm` draws at the density the product uses, and `pdfinfo` for the page count.
 */

const RENDER_DPI = '150';

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-pages-'));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The pages of `pdf` as the page chain draws them: `pdftoppm -png` at the product's density, `first` to `last` inclusive. */
export function referencePages(pdf: Buffer, first: number, last: number): Buffer[] {
  return withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'in.pdf'), pdf);
    execFileSync(requireOracleTool('pdftoppm'), ['-r', RENDER_DPI, '-png', '-f', String(first), '-l', String(last), path.join(dir, 'in.pdf'), path.join(dir, 'page')]);
    return fs
      .readdirSync(dir)
      .filter((name) => name.startsWith('page-'))
      .sort((a, b) => a.localeCompare(b))
      .map((name) => fs.readFileSync(path.join(dir, name)));
  });
}

export function pdfPageCount(pdf: Buffer): number {
  return withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'in.pdf'), pdf);
    const info = execFileSync(requireOracleTool('pdfinfo'), [path.join(dir, 'in.pdf')], { encoding: 'utf-8' });
    return Number(/^Pages:\s+(\d+)/m.exec(info)?.[1]);
  });
}

/** The office suite's own PDF of a document: the truth for the page count and for the pixels of every page. */
export function suitePdf(document: Buffer, extension: string): Buffer {
  return sofficeConvert(document, extension, 'pdf', 'pdf');
}

/** Samples of a picture that are not white: a blank page has none. */
function inkedSamples(picture: DecodedRgba): number {
  let inked = 0;
  for (let i = 0; i < picture.data.length; i += 4) {
    if (picture.data[i] !== 255 || picture.data[i + 1] !== 255 || picture.data[i + 2] !== 255) inked += 1;
  }
  return inked;
}

export async function expectSamePixels(actual: Buffer, expected: Buffer, label: string): Promise<void> {
  const [got, want] = await Promise.all([decodeRgba(actual), decodeRgba(expected)]);
  expect({ label, width: got.width, height: got.height }).toEqual({ label, width: want.width, height: want.height });
  expect({ label, difference: maxSampleDifference(got, want) }).toEqual({ label, difference: 0 });
  expect(inkedSamples(got), `${label} is not a blank page`).toBeGreaterThan(0);
}

/** The entries of a ZIP of pages, in name order. */
export async function pagesOfZip(zipBytes: Buffer): Promise<Buffer[]> {
  const zip = await JSZip.loadAsync(zipBytes);
  const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir).sort((a, b) => a.localeCompare(b));
  return Promise.all(names.map((name) => zip.files[name].async('nodebuffer')));
}
