import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { PDFDocument, PDFName, PDFNumber, degrees } from 'pdf-lib';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { InputPixelLimitError } from '../src/lib/conversions/image-input-limits';
import {
  MAX_RASTER_AGGREGATE_PIXELS,
  MAX_RASTER_PAGE_PIXELS,
  PdfPageFrameError,
  readPdfPageFrames,
  renderedSizePixels,
} from '../src/lib/conversions/pdf-page-geometry';
import { planPageRender } from '../src/lib/conversions/pdf-page-render';
import { UnsupportedOptionError } from '../src/lib/types';
import { executeWorkerConversion } from '../src/worker/engines';
import { oracleTest } from './helpers/oracle-test';

vi.setConfig({ testTimeout: 120_000 });

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
  return Buffer.from(await doc.save());
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

    const rotatedDoc = await PDFDocument.create();
    const rotatedPage = rotatedDoc.addPage([300, 600]);
    rotatedPage.setCropBox(0, 0, 300, 600);
    rotatedPage.setRotation(degrees(90));
    const rotatedFrames = await readPdfPageFrames(Buffer.from(await rotatedDoc.save()));
    expect(renderedSizePixels(rotatedFrames[0], 300)).toEqual({ width: 2500, height: 1250 });
  });

  it('refuses a 40-page A4 PDF at 600 DPI exceeding the 400 MP aggregate budget before pdftoppm starts', async () => {
    const pdf = await createPdfWithPages(40, [595.28, 841.89]);
    await withPdftoppmSpy(async (wasInvoked) => {
      const error = await executeWorkerConversion(pdf, 'pdf', 'png', { dpi: 600 }, 'forty-a4.pdf').catch((err: unknown) => err);
      expect(error).toBeInstanceOf(InputPixelLimitError);
      const pixelError = error as InputPixelLimitError;
      expect(pixelError.status).toBe(413);
      expect(pixelError.limit).toBe(MAX_RASTER_AGGREGATE_PIXELS);
      expect(pixelError.message).toContain('400000000');
      expect(wasInvoked()).toBe(false);
    });
    await expect(planPageRender(pdf, undefined, 600)).rejects.toThrow(InputPixelLimitError);
  });

  oracleTest('converts 10 selected A4 pages at 300 DPI within the aggregate pixel budget into a 10-entry ZIP', ['pdftoppm'], async () => {
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
