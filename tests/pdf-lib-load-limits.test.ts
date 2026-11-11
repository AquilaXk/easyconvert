import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { loadPdfDocument } from '../src/lib/conversions/pdf-access';
import { createLosslessSandwichPdfFromPdf } from '../src/lib/conversions/ocr-pdf-sandwich';
import { assertPdfLibParseWithinLimits, loadPdfLibDocument } from '../src/lib/conversions/pdf-lib-load';
import { checkPdfRasterPageBudget, readPdfPageFrames } from '../src/lib/conversions/pdf-page-frames';
import { extractPrintReplicaPdf } from '../src/lib/conversions/office/print-replica';
import { countPagesOfReadablePdf } from '../src/worker/engines';
import { CorruptStreamError, DecompressionLimitError } from '../src/lib/types';
import { PdfStructureError } from '../src/lib/conversions/pdf-document';
import { ImageExtractor } from '../src/lib/conversions/pdf-text-images';
import { type CraftObject, buildPdf } from './helpers/pdf-craft';
import { buildAzw4 } from './helpers/print-replica-builder';

/**
 * pdf-lib inflates every object stream and cross-reference stream it meets while it loads a file, with no output limit. Each
 * route that opens a PDF with pdf-lib goes through `loadPdfLibDocument`, which decodes those streams under the byte budgets first.
 * The bombs are 128 MiB of zeros, above the 64 MiB per-stream cap, 130 KB deflated.
 */

const MIB = 1024 * 1024;
const BOMB_MIB = 128;
/** Hang guard only: the check stops a bomb in milliseconds; pdf-lib inflating it takes seconds and gigabytes. */
const BOMB_HANG_GUARD_MS = 20_000;
vi.setConfig({ testTimeout: BOMB_HANG_GUARD_MS });

const bomb = zlib.deflateSync(Buffer.alloc(BOMB_MIB * MIB), { level: 9 });

const BASE: CraftObject[] = [
  { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
  { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
  { id: 3, dict: '/Type /Page /Parent 2 0 R /MediaBox [0 0 200 100]' },
];

function pdfWith(...extra: CraftObject[]): Buffer {
  return buildPdf([...BASE, ...extra], 1).buffer;
}

const bombs: Record<string, Buffer> = {
  'an object stream no entry leads to': pdfWith({ id: 4, dict: '/Type /ObjStm /N 0 /First 0 /Filter /FlateDecode', stream: bomb }),
  'an object stream with no /N or /First': pdfWith({ id: 4, dict: '/Type /ObjStm /Filter /FlateDecode', stream: bomb }),
  'a cross-reference stream no startxref leads to': pdfWith({ id: 4, dict: '/Type /XRef /W [1 1 1] /Size 1 /Filter /FlateDecode', stream: bomb }),
  'an object stream whose /Type is an indirect reference': pdfWith(
    { id: 5, raw: '/ObjStm' },
    { id: 4, dict: '/Type 5 0 R /N 0 /First 0 /Filter /FlateDecode', stream: bomb }
  ),
  'an object stream written twice, the bomb first': buildPdf(
    [...BASE, { id: 4, dict: '/Type /ObjStm /N 0 /First 0 /Filter /FlateDecode', stream: bomb }, { id: 4, raw: '<< /Replaced true >>' }],
    1
  ).buffer,
};

describe('pdf-lib stream limits', () => {
  describe.each(Object.entries(bombs))('%s', (_name, pdf) => {
    it('is refused by the check before pdf-lib reads it', async () => {
      expect(() => assertPdfLibParseWithinLimits(pdf)).toThrow(DecompressionLimitError);
      await expect(loadPdfLibDocument(pdf)).rejects.toThrow(DecompressionLimitError);
    });

    it('is refused by loadPdfDocument, readPdfPageFrames and the raster budget with the limit error', async () => {
      await expect(loadPdfDocument(pdf)).rejects.toThrow(DecompressionLimitError);
      await expect(readPdfPageFrames(pdf)).rejects.toThrow(DecompressionLimitError);
      await expect(checkPdfRasterPageBudget(pdf, () => [1], 72)).rejects.toThrow(DecompressionLimitError);
    });

    it('is refused by the Lossless Sandwich writer, the page count fallback and the image catalog', async () => {
      await expect(createLosslessSandwichPdfFromPdf(pdf, new Map())).rejects.toThrow(DecompressionLimitError);
      const previous = process.env.PDFINFO_PATH;
      process.env.PDFINFO_PATH = '/nonexistent/pdfinfo';
      try {
        await expect(countPagesOfReadablePdf('/nonexistent.pdf', '/tmp', 5_000, undefined, pdf)).rejects.toThrow(DecompressionLimitError);
      } finally {
        if (previous === undefined) delete process.env.PDFINFO_PATH;
        else process.env.PDFINFO_PATH = previous;
      }
      const images = [{ pixelWidth: 1, pixelHeight: 1 }];
      await expect(new ImageExtractor(pdf).attach(0, {} as never, images as never, [{}] as never)).rejects.toThrow(DecompressionLimitError);
    });

    it('is refused as a Print Replica book member', async () => {
      await expect(extractPrintReplicaPdf(buildAzw4([pdf]))).rejects.toThrow(DecompressionLimitError);
    });
  });

  it('refuses an object stream whose filter pdf-lib decodes without any limit', () => {
    const runLength = pdfWith({ id: 4, dict: '/Type /ObjStm /N 0 /First 0 /Filter /RunLengthDecode', stream: Buffer.from([129, 0, 128]) });
    expect(() => assertPdfLibParseWithinLimits(runLength)).toThrow(PdfStructureError);
  });

  it('refuses an object stream of corrupt Flate data', () => {
    const corrupt = pdfWith({ id: 4, dict: '/Type /ObjStm /N 0 /First 0 /Filter /FlateDecode', stream: Buffer.from('not flate data at all') });
    expect(() => assertPdfLibParseWithinLimits(corrupt)).toThrow(CorruptStreamError);
  });

  it('loads a file whose object stream and cross-reference stream are ordinary', async () => {
    const small = zlib.deflateSync(Buffer.from('10 0 11 12 << /A 1 >> << /B 2 >>'));
    const pdf = pdfWith({ id: 4, dict: '/Type /ObjStm /N 2 /First 11 /Filter /FlateDecode', stream: small });
    const doc = await loadPdfLibDocument(pdf);
    expect(doc.getPageCount()).toBe(1);
  });

  it('leaves an encrypted file to pdf-lib, which does not decrypt it', () => {
    const encrypted = buildPdf(
      [...BASE, { id: 4, dict: '/Type /ObjStm /N 0 /First 0 /Filter /FlateDecode', stream: bomb }, { id: 6, raw: '<< /Filter /Standard /V 1 /R 2 /O (x) /U (y) /P -4 >>' }],
      1
    ).buffer.toString('latin1').replace('/Root 1 0 R', '/Root 1 0 R /Encrypt 6 0 R');
    expect(() => assertPdfLibParseWithinLimits(Buffer.from(encrypted, 'latin1'))).not.toThrow();
  });
});

const SRC_ROOT = path.resolve(__dirname, '..', 'src');
const LOAD_CALL = /\bPDFDocument\s*\.\s*load\b|\[\s*['"]load['"]\s*\]\s*\(/;
const SAFE_LOADER = path.join('lib', 'conversions', 'pdf-lib-load.ts');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(?:ts|tsx|mts)$/.test(entry.name) ? [full] : [];
  });
}

describe('PDFDocument.load in src/', () => {
  it('is called only by the checked loader', () => {
    const direct = sourceFiles(SRC_ROOT)
      .filter((file) => path.relative(SRC_ROOT, file) !== SAFE_LOADER)
      .filter((file) => LOAD_CALL.test(fs.readFileSync(file, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')))
      .map((file) => path.relative(SRC_ROOT, file));
    expect(direct).toEqual([]);
  });
});
