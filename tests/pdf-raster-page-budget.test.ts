import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { PDFDocument, PDFName, PDFNumber, PDFString, degrees } from 'pdf-lib';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { InputPixelLimitError } from '../src/lib/conversions/image-input-limits';
import {
  MAX_RASTER_PAGE_PIXELS,
  PdfPageFrameError,
  assertPdfRasterPageBudget,
  checkPdfRasterPageBudget,
  readPdfPageFrames,
  renderedSizePixels,
} from '../src/lib/conversions/pdf-page-geometry';
import { boundPageImages, resolvePageIntervals } from '../src/lib/conversions/page-range';
import { pagesOfIntervals } from '../src/lib/conversions/page-intervals';
import { planPageRender } from '../src/lib/conversions/pdf-page-render';
import { InvalidPageRangeError, PayloadLimitError, UnsupportedOptionError } from '../src/lib/types';
import { convertWithNativePoppler, executeWorkerConversion } from '../src/worker/engines';
import { oracleTest } from './helpers/oracle-test';
import { buildPdf } from './helpers/pdf-craft';

vi.setConfig({ testTimeout: 120_000 });

function corruptPdfXref(pdf: Buffer): Buffer {
  const text = pdf.toString('latin1').replace(/xref\s+\d+\s+\d+/, 'xref\n0 brokenxref');
  return Buffer.from(text, 'latin1');
}

async function withPdftoppmSpy<T>(run: (wasInvoked: () => boolean) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdftoppm-spy-'));
  const markerPath = path.join(dir, 'invoked.marker');
  const scriptPath = path.join(dir, 'pdftoppm');
  const previous = process.env.PDFTOPPM_PATH;
  fs.writeFileSync(scriptPath, `#!/bin/sh\nprintf 'invoked' > '${markerPath}'\nexit 1\n`, { mode: 0o755 });
  process.env.PDFTOPPM_PATH = scriptPath;
  try {
    return await run(() => fs.existsSync(markerPath));
  } finally {
    if (previous === undefined) {
      delete process.env.PDFTOPPM_PATH;
    } else {
      process.env.PDFTOPPM_PATH = previous;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function createPdfWithPages(pageCount: number, size: [number, number]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage(size);
    page.drawRectangle({ x: 10, y: 10, width: 20, height: 20 });
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

describe('PDF page rasterization pixel budgets', () => {
  it('refuses a 14400x14400 pt page at 600 DPI with HTTP 413 before pdftoppm starts', async () => {
    const pdf = await createPdfWithPages(1, [14_400, 14_400]);
    await withPdftoppmSpy(async (wasInvoked) => {
      const error = await executeWorkerConversion(pdf, 'pdf', 'png', { dpi: 600 }, 'huge-page.pdf').catch((err: unknown) => err);
      expect(error).toBeInstanceOf(InputPixelLimitError);
      const pixelError = error as InputPixelLimitError;
      expect(pixelError.status).toBe(413);
      expect(pixelError.limit).toBe(MAX_RASTER_PAGE_PIXELS);
      expect(pixelError.width).toBe(120_000);
      expect(pixelError.height).toBe(120_000);
      expect(pixelError.message).toContain('page 1');
      expect(pixelError.message).toContain('120000x120000');
      expect(pixelError.message).toContain('100000000');
      expect(wasInvoked()).toBe(false);
    });
  });

  it('applies /UserUnit and /Rotate when computing rendered pixel dimensions and enforcing page budgets', async () => {
    const userUnitDoc = await PDFDocument.create();
    const userUnitPage = userUnitDoc.addPage([600, 600]);
    userUnitPage.node.set(PDFName.of('UserUnit'), PDFNumber.of(25));
    const userUnitPdf = Buffer.from(await userUnitDoc.save());

    await withPdftoppmSpy(async (wasInvoked) => {
      const error = await executeWorkerConversion(userUnitPdf, 'pdf', 'png', { dpi: 600 }, 'user-unit.pdf').catch((err: unknown) => err);
      expect(error).toBeInstanceOf(InputPixelLimitError);
      const pixelError = error as InputPixelLimitError;
      expect(pixelError.status).toBe(413);
      expect(pixelError.width).toBe(125_000);
      expect(pixelError.height).toBe(125_000);
      expect(wasInvoked()).toBe(false);
    });

    const invalidUnitDoc = await PDFDocument.create();
    const invalidUnitPage = invalidUnitDoc.addPage([600, 600]);
    invalidUnitPage.node.set(PDFName.of('UserUnit'), PDFNumber.of(0));
    const invalidUnitPdf = Buffer.from(await invalidUnitDoc.save());
    await expect(readPdfPageFrames(invalidUnitPdf)).rejects.toThrow(PdfPageFrameError);

    const nonNumericUnitDoc = await PDFDocument.create();
    const nonNumericUnitPage = nonNumericUnitDoc.addPage([600, 600]);
    nonNumericUnitPage.node.set(PDFName.of('UserUnit'), PDFString.of('25'));
    const nonNumericUnitPdf = Buffer.from(await nonNumericUnitDoc.save());
    await expect(readPdfPageFrames(nonNumericUnitPdf)).rejects.toThrow(PdfPageFrameError);

    const fractionalUnitDoc = await PDFDocument.create();
    const fractionalUnitPage = fractionalUnitDoc.addPage([14_400, 14_400]);
    fractionalUnitPage.node.set(PDFName.of('UserUnit'), PDFNumber.of(0.01));
    const fractionalUnitPdf = Buffer.from(await fractionalUnitDoc.save());
    await withPdftoppmSpy(async (wasInvoked) => {
      const error = await executeWorkerConversion(fractionalUnitPdf, 'pdf', 'png', { dpi: 600 }, 'fractional-unit.pdf').catch((err: unknown) => err);
      expect(error).toBeInstanceOf(InputPixelLimitError);
      expect((error as InputPixelLimitError).width).toBe(120_000);
      expect((error as InputPixelLimitError).height).toBe(120_000);
      expect(wasInvoked()).toBe(false);
    });

    const mixedInvalidDoc = await PDFDocument.create();
    mixedInvalidDoc.addPage([14_400, 14_400]);
    const secondPage = mixedInvalidDoc.addPage([600, 600]);
    secondPage.node.set(PDFName.of('Rotate'), PDFNumber.of(45));
    const mixedInvalidPdf = Buffer.from(await mixedInvalidDoc.save());
    await withPdftoppmSpy(async (wasInvoked) => {
      const error = await executeWorkerConversion(mixedInvalidPdf, 'pdf', 'png', { dpi: 600 }, 'mixed-invalid.pdf').catch((err: unknown) => err);
      expect(error).toBeInstanceOf(InputPixelLimitError);
      expect(wasInvoked()).toBe(false);
    });
    await expect(planPageRender(mixedInvalidPdf, undefined, 600)).rejects.toThrow(InputPixelLimitError);

    const rotatedDoc = await PDFDocument.create();
    const rotatedPage = rotatedDoc.addPage([300, 600]);
    rotatedPage.setCropBox(0, 0, 300, 600);
    rotatedPage.setRotation(degrees(90));
    const rotatedFrames = await readPdfPageFrames(Buffer.from(await rotatedDoc.save()));
    expect(renderedSizePixels(rotatedFrames[0], 300)).toEqual({ width: 2500, height: 1250 });
    expect(() => assertPdfRasterPageBudget(rotatedFrames, [2], 300)).toThrow(PdfPageFrameError);

    const rotatedHugeDoc = await PDFDocument.create();
    const rotatedHugePage = rotatedHugeDoc.addPage([3000, 14_400]);
    rotatedHugePage.setRotation(degrees(90));
    rotatedHugePage.node.set(PDFName.of('UserUnit'), PDFNumber.of(0));
    const rotatedHugePdf = Buffer.from(await rotatedHugeDoc.save());
    await withPdftoppmSpy(async (wasInvoked) => {
      const error = await executeWorkerConversion(rotatedHugePdf, 'pdf', 'png', { dpi: 600 }, 'rotated-huge.pdf').catch((err: unknown) => err);
      expect(error).toBeInstanceOf(InputPixelLimitError);
      expect((error as InputPixelLimitError).width).toBe(120_000);
      expect((error as InputPixelLimitError).height).toBe(25_000);
      expect(wasInvoked()).toBe(false);
    });

    const nonNumericRotateDoc = await PDFDocument.create();
    const nonNumericRotatePage = nonNumericRotateDoc.addPage([600, 600]);
    nonNumericRotatePage.node.set(PDFName.of('Rotate'), PDFString.of('90'));
    const nonNumericRotatePdf = Buffer.from(await nonNumericRotateDoc.save());
    await expect(readPdfPageFrames(nonNumericRotatePdf)).rejects.toThrow(/\/Rotate/);
  });

  it('refuses damaged-xref PDFs and malformed page catalogs before pdftoppm starts', async () => {
    const rawSignedPdf = corruptPdfXref(
      buildPdf(
        [
          { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
          { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
          { id: 3, dict: '/Type /Page /Parent 2 0 R /MediaBox [0 0 +14400 14400.]' },
        ],
        1
      ).buffer
    );
    await expect(PDFDocument.load(rawSignedPdf, { updateMetadata: false, throwOnInvalidObject: true })).rejects.toThrow();
    await withPdftoppmSpy(async (wasInvoked) => {
      const error = await executeWorkerConversion(rawSignedPdf, 'pdf', 'png', { dpi: 600 }, 'damaged-huge.pdf').catch((err: unknown) => err);
      expect(error).toBeInstanceOf(InputPixelLimitError);
      expect((error as InputPixelLimitError).width).toBe(120_000);
      expect((error as InputPixelLimitError).height).toBe(120_000);
      expect(wasInvoked()).toBe(false);
    });

    const rawUserUnitPdf = corruptPdfXref(
      buildPdf(
        [
          { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
          { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
          { id: 3, dict: '/Type /Page /Parent 2 0 R /MediaBox [0 0 600 600] /UserUnit 25' },
        ],
        1
      ).buffer
    );
    await expect(PDFDocument.load(rawUserUnitPdf, { updateMetadata: false, throwOnInvalidObject: true })).rejects.toThrow();
    await withPdftoppmSpy(async (wasInvoked) => {
      const error = await executeWorkerConversion(rawUserUnitPdf, 'pdf', 'png', { dpi: 600 }, 'damaged-unit.pdf').catch((err: unknown) => err);
      expect(error).toBeInstanceOf(InputPixelLimitError);
      expect((error as InputPixelLimitError).width).toBe(125_000);
      expect((error as InputPixelLimitError).height).toBe(125_000);
      expect(wasInvoked()).toBe(false);
    });

    const damagedFortyA4 = corruptPdfXref(await createPdfWithPages(40, [595.28, 841.89]));
    await expect(PDFDocument.load(damagedFortyA4, { updateMetadata: false, throwOnInvalidObject: true })).rejects.toThrow();
    await withPdftoppmSpy(async (wasInvoked) => {
      const error = await executeWorkerConversion(damagedFortyA4, 'pdf', 'png', { dpi: 600 }, 'damaged-forty.pdf').catch((err: unknown) => err);
      expect(error).not.toBeInstanceOf(InputPixelLimitError);
      expect(wasInvoked()).toBe(true);
    });

    const inheritedKids = Array.from({ length: 40 }, (_, idx) => `${idx + 3} 0 R`).join(' ');
    const inheritedFortyPages = corruptPdfXref(
      buildPdf(
        [
          { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
          { id: 2, dict: `/Type /Pages /Kids [${inheritedKids}] /Count 40 /MediaBox [0 0 595.28 841.89]` },
          ...Array.from({ length: 39 }, (_, idx) => ({ id: idx + 3, dict: '/Type /Page /Parent 2 0 R' })),
          { id: 42, dict: '/Type /Page /Parent 2 0 R /MediaBox [0 0 10 10]' },
        ],
        1
      ).buffer
    );
    await expect(PDFDocument.load(inheritedFortyPages, { updateMetadata: false, throwOnInvalidObject: true })).rejects.toThrow();
    await withPdftoppmSpy(async (wasInvoked) => {
      const error = await executeWorkerConversion(inheritedFortyPages, 'pdf', 'png', { dpi: 600 }, 'inherited-forty.pdf').catch((err: unknown) => err);
      expect(error).not.toBeInstanceOf(InputPixelLimitError);
      expect(wasInvoked()).toBe(true);
    });

    const hugeCountPdf = corruptPdfXref(
      buildPdf(
        [
          { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
          { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 5000000000' },
          { id: 3, dict: '/Type /Page /Parent 2 0 R /MediaBox [0 0 10 10]' },
        ],
        1
      ).buffer
    );
    await withPdftoppmSpy(async (wasInvoked) => {
      const error = await executeWorkerConversion(hugeCountPdf, 'pdf', 'png', { dpi: 300 }, 'huge-count.pdf').catch((err: unknown) => err);
      expect(error).toBeInstanceOf(PayloadLimitError);
      expect(wasInvoked()).toBe(false);
    });
    await expect(planPageRender(hugeCountPdf, undefined, 300)).rejects.toThrow(PayloadLimitError);

    const singleBoxDamagedA4 = corruptPdfXref(
      buildPdf(
        [
          { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
          { id: 2, dict: '/Type /Pages /MediaBox [0 0 595.28 841.89]' },
        ],
        1
      ).buffer
    );
    await withPdftoppmSpy(async () => {
      const error = await executeWorkerConversion(singleBoxDamagedA4, 'pdf', 'png', { pages: '1-40', dpi: 600 }, 'range-forty.pdf').catch(
        (err: unknown) => err
      );
      expect(error).not.toBeInstanceOf(InputPixelLimitError);
      const directError = await convertWithNativePoppler(singleBoxDamagedA4, 'pdf', 'png', { pages: '1-40', dpi: 600 }, 'range-forty.pdf').catch(
        (err: unknown) => err
      );
      expect(directError).not.toBeInstanceOf(InputPixelLimitError);
    });
    for (const openSpec of ['2-', '9960-']) {
      await expect(
        checkPdfRasterPageBudget(
          singleBoxDamagedA4,
          (count) =>
            pagesOfIntervals(
              boundPageImages(
                resolvePageIntervals(undefined, openSpec, count, (p, c) => new InvalidPageRangeError(`Page ${p} > ${c}`)) ?? [
                  { start: 1, end: count },
                ],
                undefined
              )
            ),
          600
        )
      ).resolves.toBeUndefined();
    }

    const unparseablePageObjectPdf = Buffer.from(
      '%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 14400 14400] /PieceInfo <<\nendobj\ntrailer\n<< /Size 4 /Root 1 0 R >>\n%%EOF\n',
      'latin1'
    );
    await expect(PDFDocument.load(unparseablePageObjectPdf, { updateMetadata: false, throwOnInvalidObject: true })).rejects.toThrow();
    await withPdftoppmSpy(async (wasInvoked) => {
      const error = await executeWorkerConversion(unparseablePageObjectPdf, 'pdf', 'png', { dpi: 600 }, 'invalid-obj.pdf').catch((err: unknown) => err);
      expect(error).toBeInstanceOf(InputPixelLimitError);
      expect((error as InputPixelLimitError).width).toBe(120_000);
      expect((error as InputPixelLimitError).height).toBe(120_000);
      expect(wasInvoked()).toBe(false);
    });

    const jsActionPagesCatalog = buildPdf(
      [
        { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
        { id: 2, dict: '/S /JavaScript /JS (func=function(){};func();)' },
        { id: 3, dict: '/Type /Page /Parent 2 0 R /MediaBox [0 0 200 100]' },
      ],
      1
    ).buffer;
    await expect(readPdfPageFrames(jsActionPagesCatalog)).rejects.toThrow(PdfPageFrameError);
    await withPdftoppmSpy(async (wasInvoked) => {
      const error = await executeWorkerConversion(jsActionPagesCatalog, 'pdf', 'png', { dpi: 300 }, 'bad-catalog.pdf').catch((err: unknown) => err);
      expect(error).toBeInstanceOf(PdfPageFrameError);
      expect(wasInvoked()).toBe(false);
    });

    const degenerateRawBoxPdf = corruptPdfXref(
      buildPdf(
        [
          { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
          { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
          { id: 3, dict: '/Type /Page /Parent 2 0 R /MediaBox [0 0 0 100]' },
        ],
        1
      ).buffer
    );
    await withPdftoppmSpy(async (wasInvoked) => {
      const error = await executeWorkerConversion(degenerateRawBoxPdf, 'pdf', 'png', { dpi: 300 }, 'degenerate-raw.pdf').catch((err: unknown) => err);
      expect(error).toBeInstanceOf(PdfPageFrameError);
      expect(wasInvoked()).toBe(false);
    });
  });

  it('does not add the pages of a request up: 40 A4 pages at 600 DPI, each within the page budget, reach pdftoppm', async () => {
    const pdf = await createPdfWithPages(40, [595.28, 841.89]);
    await withPdftoppmSpy(async (wasInvoked) => {
      const error = await executeWorkerConversion(pdf, 'pdf', 'png', { dpi: 600 }, 'forty-a4.pdf').catch((err: unknown) => err);
      expect(error).not.toBeInstanceOf(InputPixelLimitError);
      expect(wasInvoked()).toBe(true);
    });
    await expect(planPageRender(pdf, undefined, 600)).resolves.toMatchObject({ dpi: 600 });
  });

  it('accepts a long document of ordinary pages at 150 and 300 DPI, whatever its pixels in total', async () => {
    const letters = await createPdfWithPages(489, [612, 792]);
    const selectAll = (count: number): number[] => Array.from({ length: count }, (_, index) => index + 1);
    const atDefault = await checkPdfRasterPageBudget(letters, selectAll, 150);
    expect(atDefault?.pageNumbers).toHaveLength(489);
    const atOcr = await checkPdfRasterPageBudget(letters, selectAll, 300);
    expect(atOcr?.pageNumbers).toHaveLength(489);
    const plan = await planPageRender(letters, undefined, 300);
    expect(plan.pageNumbers).toHaveLength(489);
    const a4 = await createPdfWithPages(137, [595.28, 841.89]);
    await expect(planPageRender(a4, undefined, 300)).resolves.toMatchObject({ dpi: 300 });
    await expect(planPageRender(a4, undefined, 600)).resolves.toMatchObject({ dpi: 600 });
  });

  it('keeps the page budget for a long document that holds one giant page', async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 20; i++) doc.addPage([612, 792]);
    doc.addPage([14_400, 14_400]);
    const pdf = Buffer.from(await doc.save({ useObjectStreams: false }));
    const error = await planPageRender(pdf, undefined, 300).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(InputPixelLimitError);
    expect(error).toMatchObject({ limit: MAX_RASTER_PAGE_PIXELS });
    expect((error as Error).message).toContain('PDF page 21');
  });

  it('gives a page whose tree carries no MediaBox the US Letter box pdf.js gives it, and keeps a CropBox that stands alone', async () => {
    const page = (dict: string): Buffer =>
      buildPdf(
        [
          { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
          { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
          { id: 3, dict: `/Type /Page /Parent 2 0 R ${dict}` },
        ],
        1
      ).buffer;
    const [letter] = await readPdfPageFrames(page(''));
    expect(letter.cropBox).toEqual({ x0: 0, y0: 0, x1: 612, y1: 792 });
    await expect(checkPdfRasterPageBudget(page(''), (count) => Array.from({ length: count }, (_, i) => i + 1), 300)).resolves.not.toThrow();
    const [cropped] = await readPdfPageFrames(page('/CropBox [0 0 300 400]'));
    expect(cropped.cropBox).toEqual({ x0: 0, y0: 0, x1: 300, y1: 400 });
  });

  it('reads the CropBox of a page of a damaged file, not the MediaBox it is cut from, as pdftoppm draws it with -cropbox', async () => {
    const scanned = corruptPdfXref(
      buildPdf(
        [
          { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
          { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
          { id: 3, dict: '/Type /Page /Parent 2 0 R /MediaBox [0 0 2672 4072] /CropBox [0 0 641 977]' },
        ],
        1
      ).buffer
    );
    await expect(PDFDocument.load(scanned, { updateMetadata: false, throwOnInvalidObject: true })).rejects.toThrow();
    await expect(checkPdfRasterPageBudget(scanned, () => [1], 300)).resolves.toBeUndefined();
    const cropFirst = corruptPdfXref(
      buildPdf(
        [
          { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
          { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
          { id: 3, dict: '/Type /Page /Parent 2 0 R /CropBox [0 0 641 977] /MediaBox [0 0 2672 4072]' },
        ],
        1
      ).buffer
    );
    await expect(checkPdfRasterPageBudget(cropFirst, () => [1], 300)).resolves.toBeUndefined();
    const giantCrop = corruptPdfXref(
      buildPdf(
        [
          { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
          { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
          { id: 3, dict: '/Type /Page /Parent 2 0 R /MediaBox [0 0 14400 14400] /CropBox [0 0 14400 14400]' },
        ],
        1
      ).buffer
    );
    await expect(checkPdfRasterPageBudget(giantCrop, () => [1], 300)).rejects.toBeInstanceOf(InputPixelLimitError);
  });

  oracleTest('converts 10 selected A4 pages at 300 DPI into a 10-entry ZIP', ['pdftoppm'], async () => {
    const pdf = await createPdfWithPages(40, [595.28, 841.89]);
    const result = await executeWorkerConversion(pdf, 'pdf', 'png', { pages: '1-10', dpi: 300 }, 'forty-a4.pdf');
    expect(result.mimeType).toBe('application/zip');
    const zip = await JSZip.loadAsync(result.buffer);
    const entries = Object.keys(zip.files).filter((name) => !zip.files[name].dir).sort();
    expect(entries).toHaveLength(10);
  });

  oracleTest('renders a 1-page A4 PDF at 300 DPI to a 2480x3508 PNG', ['pdftoppm'], async () => {
    const pdf = await createPdfWithPages(1, [595.2, 841.92]);
    const result = await executeWorkerConversion(pdf, 'pdf', 'png', { dpi: 300 }, 'a4.pdf');
    expect(result.mimeType).toBe('image/png');
    const meta = await sharp(result.buffer).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(2480);
    expect(meta.height).toBe(3508);
  });

  it('rejects out-of-range DPI values with UnsupportedOptionError before pdftoppm starts', async () => {
    const pdf = await createPdfWithPages(1, [595.2, 841.92]);
    await withPdftoppmSpy(async (wasInvoked) => {
      for (const dpi of [1200, 30]) {
        const error = await executeWorkerConversion(pdf, 'pdf', 'png', { dpi }, 'a4.pdf').catch((err: unknown) => err);
        expect(error).toBeInstanceOf(UnsupportedOptionError);
        expect((error as UnsupportedOptionError).refusalCode).toBe('option_not_supported');
        expect((error as UnsupportedOptionError).message).toContain(String(dpi));
      }
      expect(wasInvoked()).toBe(false);
    });
  });
});
