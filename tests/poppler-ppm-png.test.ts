import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { ConversionFailedError, InvalidPageRangeError, UnsupportedOptionError } from '../src/lib/types';
import { PdfStructureError } from '../src/lib/conversions/pdf-document';
import { exceedsPpmPageLimit, parsePpmHeader, PPM_PAGE_MAX_BYTES, ppmBatchPages, splitIntoBatches } from '../src/worker/poppler-ppm';
import { requireOracleTool } from './helpers/differential-oracle';
import { decodeRgba } from './helpers/imagemagick';
import { oracleTest } from './helpers/oracle-test';

/**
 * PNG pages from Poppler are written by the worker's encoder from PPM pages, because Poppler's own PNG writer costs more
 * than the rendering. The pixels, the size and the pixel density must be exactly what `pdftoppm -png` writes: the
 * oracle is the real `pdftoppm -png` of the same PDF, decoded by ImageMagick (which shares no code with the encoder).
 */

const NATIVE_TIMEOUT_MS = 120_000;
const DPI = 150;
const PNG_SIGNATURE_BYTES = 8;
const PNG_PHYS = 'pHYs';

async function drawing(pageSizes: Array<[number, number]>): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  pageSizes.forEach(([width, height], index) => {
    const page = doc.addPage([width, height]);
    page.drawRectangle({ x: 10, y: 10, width: width / 2, height: height / 3, color: rgb(0.84, 0.15, 0.16) });
    page.drawCircle({ x: width * 0.6, y: height * 0.6, size: Math.min(width, height) / 5, color: rgb(0.12, 0.47, 0.71), borderColor: rgb(0, 0, 0), borderWidth: 2 });
    page.drawText(`Page ${index + 1} of the drawing`, { x: 14, y: height - 30, size: 14, font });
  });
  return Buffer.from(await doc.save());
}

/** PNG chunks as [type, data] in file order. */
function chunks(png: Buffer): Array<[string, Buffer]> {
  const found: Array<[string, Buffer]> = [];
  let at = PNG_SIGNATURE_BYTES;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    found.push([png.toString('latin1', at + 4, at + 8), png.subarray(at + 8, at + 8 + length)]);
    at += 12 + length;
  }
  return found;
}

/** Chunks whose stored CRC-32 is not that of their type and data, read with zlib's routine. */
function badChecksums(png: Buffer): string[] {
  const bad: string[] = [];
  let at = PNG_SIGNATURE_BYTES;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const stored = png.readUInt32BE(at + 8 + length);
    if (zlib.crc32(png.subarray(at + 4, at + 8 + length)) !== stored) bad.push(png.toString('latin1', at + 4, at + 8));
    at += 12 + length;
  }
  return bad;
}

function ihdr(png: Buffer): { width: number; height: number; depth: number; colourType: number } {
  const data = chunks(png)[0][1];
  return { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colourType: data[9] };
}

function referencePages(pdf: Buffer, dpi: number): Buffer[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppm-ref-'));
  try {
    fs.writeFileSync(path.join(dir, 'in.pdf'), pdf);
    execFileSync(requireOracleTool('pdftoppm'), ['-r', String(dpi), '-png', path.join(dir, 'in.pdf'), path.join(dir, 'page')]);
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.png'))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      .map((name) => fs.readFileSync(path.join(dir, name)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A stand-in for pdftoppm that records its arguments and then runs the real one, or does what `onRaw` says for a PPM request. */
async function withPdftoppmShim<T>(onRaw: string, run: (calls: () => string[][]) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdftoppm-shim-'));
  const previous = process.env.PDFTOPPM_PATH;
  try {
    const log = path.join(dir, 'calls.log');
    const shim = path.join(dir, 'pdftoppm');
    const real = requireOracleTool('pdftoppm');
    fs.writeFileSync(
      shim,
      [
        '#!/bin/sh',
        `echo "$*" >> '${log}'`,
        'case " $* " in',
        '  *" -png "*) exec ' + `'${real}'` + ' "$@" ;;',
        'esac',
        onRaw,
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
    process.env.PDFTOPPM_PATH = shim;
    return await run(() => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => line.split(' ')) : []));
  } finally {
    if (previous === undefined) delete process.env.PDFTOPPM_PATH;
    else process.env.PDFTOPPM_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const realPdftoppm = (): string => `exec '${requireOracleTool('pdftoppm')}' "$@"`;

describe('PPM header', () => {
  it('reads the size of a binary PPM with comments between the fields', () => {
    const page = parsePpmHeader(Buffer.from('P6\n# a comment\n834 625\n255\n\xff\xff', 'latin1'));
    expect(page).toEqual({ width: 834, height: 625, dataOffset: 27 });
  });

  it.each([
    ['text PPM (P3)', 'P3\n2 2\n255\n'],
    ['16-bit samples', 'P6\n2 2\n65535\n'],
    ['zero width', 'P6\n0 2\n255\n'],
    ['no size', 'P6\n'],
    ['not a number', 'P6\nwide tall\n255\n'],
    ['header not closed', 'P6\n2 2\n255'],
  ])('refuses %s', (_name, head) => {
    expect(() => parsePpmHeader(Buffer.from(head, 'latin1'))).toThrow(ConversionFailedError);
  });
});

describe('batching', () => {
  it('splits an interval into consecutive batches', () => {
    expect(splitIntoBatches(3, 9, 3)).toEqual([
      { start: 3, end: 5 },
      { start: 6, end: 8 },
      { start: 9, end: 9 },
    ]);
  });

  it('keeps the raw pages of a batch to about 48 MiB, one page at a time at high resolutions', () => {
    expect(ppmBatchPages(72)).toBe(8);
    expect(ppmBatchPages(150)).toBe(7);
    expect(ppmBatchPages(300)).toBe(1);
    expect(ppmBatchPages(600)).toBe(1);
  });

  it('limits one raw page to 128 MiB', () => {
    expect(exceedsPpmPageLimit(PPM_PAGE_MAX_BYTES)).toBe(false);
    expect(exceedsPpmPageLimit(PPM_PAGE_MAX_BYTES + 1)).toBe(true);
  });
});

describe('PDF pages as PNG through PPM', () => {
  oracleTest('a page is the pixels, the size, the layout and the density of `pdftoppm -png`', ['pdftoppm', 'identify'], async () => {
    const pdf = await drawing([[300, 200]]);
    await withPdftoppmShim(realPdftoppm(), async (calls) => {
      const result = await dispatchConversion(pdf, 'pdf', 'png', { dpi: DPI }, 'drawing.pdf');
      const [reference] = referencePages(pdf, DPI);
      expect(ihdr(result.buffer)).toEqual(ihdr(reference));
      const phys = (png: Buffer) => chunks(png).find(([type]) => type === PNG_PHYS)?.[1];
      // The same chunks in the same order, one density chunk and no colour profile, and the chunk checksums hold.
      const layout = (png: Buffer) => chunks(png).map(([type]) => type).filter((type, index, all) => type !== 'IDAT' || all[index - 1] !== 'IDAT');
      expect(layout(result.buffer)).toEqual(layout(reference));
      expect(chunks(result.buffer).filter(([type]) => type === PNG_PHYS)).toHaveLength(1);
      expect(badChecksums(result.buffer)).toEqual([]);
      expect(phys(result.buffer)).toBeDefined();
      expect(phys(result.buffer)?.equals(phys(reference) as Buffer)).toBe(true);
      const ours = decodeRgba(result.buffer, 'png');
      const theirs = decodeRgba(reference, 'png');
      expect(ours.width).toBe(theirs.width);
      expect(ours.height).toBe(theirs.height);
      expect(ours.data.equals(theirs.data)).toBe(true);
      const render = calls().find((call) => call.includes('-f'));
      expect(render).toBeDefined();
      expect(render).not.toContain('-png');
    });
  }, NATIVE_TIMEOUT_MS);

  oracleTest('several pages come back as the ZIP of pages, each identical to the reference page', ['pdftoppm', 'identify'], async () => {
    const pdf = await drawing([
      [300, 200],
      [200, 300],
      [250, 250],
    ]);
    await withPdftoppmShim(realPdftoppm(), async () => {
      const result = await dispatchConversion(pdf, 'pdf', 'png', { dpi: DPI }, 'drawing.pdf');
      const zip = await JSZip.loadAsync(result.buffer);
      const names = Object.keys(zip.files).sort();
      expect(names).toEqual(['drawing-p001.png', 'drawing-p002.png', 'drawing-p003.png']);
      const references = referencePages(pdf, DPI);
      expect(references).toHaveLength(3);
      for (const [index, name] of names.entries()) {
        const page = await (zip.file(name) as JSZip.JSZipObject).async('nodebuffer');
        expect(decodeRgba(page, 'png').data.equals(decodeRgba(references[index], 'png').data)).toBe(true);
      }
    });
  }, NATIVE_TIMEOUT_MS);

  oracleTest('a page selection renders only those pages', ['pdftoppm', 'identify'], async () => {
    const pdf = await drawing([
      [300, 200],
      [200, 300],
      [250, 250],
    ]);
    await withPdftoppmShim(realPdftoppm(), async () => {
      const result = await dispatchConversion(pdf, 'pdf', 'png', { dpi: DPI, page: 2 }, 'drawing.pdf');
      const reference = referencePages(pdf, DPI)[1];
      expect(decodeRgba(result.buffer, 'png').data.equals(decodeRgba(reference, 'png').data)).toBe(true);
    });
  }, NATIVE_TIMEOUT_MS);

  oracleTest('a page over the raw-size limit is drawn again by Poppler as a PNG', ['pdftoppm', 'identify'], async () => {
    const pdf = await drawing([[200, 150]]);
    // The stand-in reports what the process limit reports for a file above the limit: it is stopped by SIGXFSZ.
    await withPdftoppmShim('kill -XFSZ $$', async (calls) => {
      const result = await dispatchConversion(pdf, 'pdf', 'png', { dpi: DPI }, 'drawing.pdf');
      const reference = referencePages(pdf, DPI)[0];
      expect(decodeRgba(result.buffer, 'png').data.equals(decodeRgba(reference, 'png').data)).toBe(true);
      const renders = calls().filter((call) => call.includes('-f'));
      expect(renders).toHaveLength(2);
      expect(renders[0]).not.toContain('-png');
      expect(renders[1]).toContain('-png');
    });
  }, NATIVE_TIMEOUT_MS);

  oracleTest('a page file that is not a binary PPM is a typed error, never a guessed picture', ['pdftoppm'], async () => {
    const pdf = await drawing([[200, 150]]);
    await withPdftoppmShim('for last; do :; done; printf "P3\\n1 1\\n255\\n0 0 0\\n" > "$last-1.ppm"', async () => {
      const run = dispatchConversion(pdf, 'pdf', 'png', { dpi: DPI }, 'drawing.pdf');
      await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
      await expect(run).rejects.toThrow(/not a binary PPM/);
    });
  }, NATIVE_TIMEOUT_MS);

  oracleTest('the page count is read while the first pages render, and its failures are still the ones reported', ['pdftoppm', 'pdfinfo'], async () => {
    const pdf = await drawing([[200, 150]]);
    await withPdftoppmShim(realPdftoppm(), async () => {
      // A damaged document: pdfinfo cannot count it, whatever the early render did.
      await expect(dispatchConversion(pdf.subarray(0, 120), 'pdf', 'png', { dpi: DPI }, 'damaged.pdf')).rejects.toBeInstanceOf(PdfStructureError);
      // A page that is not in the document, and a resolution out of range, are the client's.
      await expect(dispatchConversion(pdf, 'pdf', 'png', { dpi: DPI, page: 9 }, 'drawing.pdf')).rejects.toBeInstanceOf(InvalidPageRangeError);
      await expect(dispatchConversion(pdf, 'pdf', 'png', { dpi: 5000 }, 'drawing.pdf')).rejects.toBeInstanceOf(UnsupportedOptionError);
    });
  }, NATIVE_TIMEOUT_MS);

  oracleTest('a document of more pages than one batch renders every page, in order', ['pdftoppm', 'identify'], async () => {
    const pdf = await drawing(Array.from({ length: 12 }, (_unused, index): [number, number] => [200 + index * 4, 120]));
    await withPdftoppmShim(realPdftoppm(), async (calls) => {
      const result = await dispatchConversion(pdf, 'pdf', 'png', { dpi: DPI }, 'many.pdf');
      const zip = await JSZip.loadAsync(result.buffer);
      const names = Object.keys(zip.files).sort();
      expect(names).toHaveLength(12);
      const references = referencePages(pdf, DPI);
      for (const [index, name] of names.entries()) {
        const page = await (zip.file(name) as JSZip.JSZipObject).async('nodebuffer');
        expect(decodeRgba(page, 'png').data.equals(decodeRgba(references[index], 'png').data)).toBe(true);
      }
      // The first batch starts with the page count; the pages after it follow in batches.
      const batches = calls().map((call) => call.slice(call.indexOf('-f'), call.indexOf('-l') + 2).join(' '));
      expect(batches[0]).toBe(`-f 1 -l ${ppmBatchPages(DPI)}`);
      expect(batches.length).toBeGreaterThan(1);
    });
  }, NATIVE_TIMEOUT_MS);

  oracleTest('JPEG pages are still written by Poppler', ['pdftoppm'], async () => {
    const pdf = await drawing([[200, 150]]);
    await withPdftoppmShim(realPdftoppm(), async (calls) => {
      const result = await dispatchConversion(pdf, 'pdf', 'jpg', { dpi: DPI }, 'drawing.pdf');
      expect(result.buffer.subarray(0, 2).toString('hex')).toBe('ffd8');
      expect(calls().some((call) => call.includes('-jpeg'))).toBe(true);
    });
  }, NATIVE_TIMEOUT_MS);
});
