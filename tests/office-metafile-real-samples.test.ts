import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { PdfPermissionDeniedError, UnsupportedOptionError } from '../src/lib/types';
import { requireOracleTool } from './helpers/differential-oracle';
import { requireRealworldSample } from './helpers/realworld-sample';
import { sofficeConvert } from './helpers/soffice-convert';
import { skipWithoutTools } from './helpers/strict-skip';
import { compareImages } from './helpers/vrt-engine';

/**
 * Real PDF files and presentations written as EMF and WMF (entry 454). The in-process writers write the pages made of paths and fills;
 * a page they refuse (a picture, a mask, a dash, a clip that is not one convex polygon) is written by the office suite from the one-page
 * PDF. Readers other than the writer judge the output: the office suite reading the metafile back with its own import filter, and
 * Inkscape (the reference's tool) where it reads the file. Each is compared with the page that Poppler draws from the PDF of the same
 * source, after both are cut to their drawing, since the office suite's export (like the reference's) is cropped to the drawing.
 *
 * The files are fetched, digest-checked and cached like the nightly corpus run does (bench/realworld/manifest.json).
 */

const toolsMissing = skipWithoutTools('soffice', 'pdfinfo', 'pdftoppm', 'qpdf');
const inkscapeMissing = skipWithoutTools('inkscape');
const CONVERSION_TIMEOUT_MS = 600_000;
const TOOL_TIMEOUT_MS = 120_000;
const INKSCAPE_TIMEOUT_MS = 60_000;
const COMPARE_DPI = 50;
const COMPARE_SIDE = 300;
/** The lowest SSIM of the metafile as the office suite draws it again, against the PDF page: measured 0.39 to 0.99 over the files below (text pages lose a little to the font the viewer picks). */
const MIN_OFFICE_SSIM = 0.3;
/** The lowest SSIM of the metafile as Inkscape draws it. */
const MIN_INKSCAPE_SSIM = 0.3;
/** How far the width over the height of the drawing may differ from that of the PDF page's drawing: a frame that is too short crops it. */
const MAX_ASPECT_DIFFERENCE = 0.1;
/** How far the frame of an EMF may differ from the page of its PDF: a pixel of the file's own resolution and the rounding of the page size. */
const FRAME_TOLERANCE_MM = 1.5;

const EMF_BITMAP_RECORDS: ReadonlySet<number> = new Set([0x4c, 0x4d, 0x4e, 0x4f, 0x50, 0x51, 0x72, 0x74]);
const WMF_PLACEABLE_KEY = 0x9ac6cdd7;
const WMF_PLACEABLE_HEADER_BYTES = 22;
const WMF_HEADER_BYTES = 18;
const WMF_BITMAP_RECORDS: ReadonlySet<number> = new Set([0x0922, 0x0b23, 0x0940, 0x0b41, 0x0d33, 0x0f43]);

/** The bitmap records of an EMF or WMF file, found by walking its records by the layouts of MS-EMF and MS-WMF. */
function bitmapRecordCount(metafile: Buffer, target: string): number {
  let count = 0;
  if (target === 'emf') {
    for (let offset = 0; offset + 8 <= metafile.length; offset += metafile.readUInt32LE(offset + 4)) {
      if (EMF_BITMAP_RECORDS.has(metafile.readUInt32LE(offset))) count++;
    }
    return count;
  }
  let offset = (metafile.readUInt32LE(0) === WMF_PLACEABLE_KEY ? WMF_PLACEABLE_HEADER_BYTES : 0) + WMF_HEADER_BYTES;
  for (; offset + 6 <= metafile.length; offset += metafile.readUInt32LE(offset) * 2) {
    if (WMF_BITMAP_RECORDS.has(metafile.readUInt16LE(offset + 4))) count++;
  }
  return count;
}

interface SampleCase {
  /** Id in bench/realworld/manifest.json. */
  id: string;
  extension: string;
  targets: readonly string[];
  /** The pages of the PDF the converter writes for the sample (the metafile output has one file for each). */
  pages: number;
  /** Whether page 1 draws a picture, which the office suite writes as a bitmap record (the in-process writers refuse it). */
  picture?: boolean;
}

const BOTH = ['emf', 'wmf'] as const;
const SAMPLES: readonly SampleCase[] = [
  // A form in Japanese: text and thin rules, no picture; the in-process writer refuses the mask of a page, the office suite writes it.
  { id: 'cc-0400651.pdf', extension: 'pdf', targets: BOTH, pages: 1 },
  { id: 'cc-4000041.pdf', extension: 'pdf', targets: BOTH, pages: 14 },
  { id: 'cc-6800345.pdf', extension: 'pdf', targets: BOTH, pages: 20 },
  { id: 'govdocs1-000012.pdf', extension: 'pdf', targets: BOTH, pages: 6 },
  { id: 'office-slideshow-pictures.ppt', extension: 'ppt', targets: ['emf'], pages: 5, picture: true },
  { id: 'govdocs1-000133.ppt', extension: 'ppt', targets: ['emf'], pages: 21, picture: true },
  { id: 'lo-macro.pptm', extension: 'pptm', targets: ['emf'], pages: 1 },
  { id: 'lo-tdf96389_deftabstopecma.potx', extension: 'potx', targets: ['emf'], pages: 1 },
];

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-metafile-'));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runTool(tool: Parameters<typeof requireOracleTool>[0], args: string[]): string {
  return execFileSync(requireOracleTool(tool), args, { encoding: 'utf-8', timeout: TOOL_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

/** The short and the long side of a page. */
function sidesOf(width: number, height: number): [number, number] {
  return width <= height ? [width, height] : [height, width];
}

function pdfPageCount(pdf: Buffer): number {
  return withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'in.pdf'), pdf);
    return Number(/^Pages:\s+(\d+)$/m.exec(runTool('pdfinfo', [path.join(dir, 'in.pdf')]))?.[1]);
  });
}

/** The size of the first page of a PDF in millimetres, as pdfinfo reports it in points. */
function firstPageSizeMm(pdf: Buffer): { width: number; height: number } {
  return withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'in.pdf'), pdf);
    const size = /^Page size:\s+([\d.]+) x ([\d.]+) pts/m.exec(runTool('pdfinfo', [path.join(dir, 'in.pdf')]));
    return { width: (Number(size?.[1]) * 25.4) / 72, height: (Number(size?.[2]) * 25.4) / 72 };
  });
}

/** The first page of a PDF as a PNG. */
function firstPageOfPdf(pdf: Buffer): Buffer {
  return withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'in.pdf'), pdf);
    runTool('pdftoppm', ['-png', '-r', String(COMPARE_DPI), '-f', '1', '-l', '1', '-singlefile', path.join(dir, 'in.pdf'), path.join(dir, 'page')]);
    return fs.readFileSync(path.join(dir, 'page.png'));
  });
}

/** The pages of an output that holds one file per page: the file itself, or the entries of the ZIP the pages arrive in. */
async function pagesOf(output: Buffer): Promise<Buffer[]> {
  if (output.subarray(0, 2).toString('latin1') !== 'PK') return [output];
  const archive = await JSZip.loadAsync(output);
  const names = Object.keys(archive.files).sort();
  return Promise.all(names.map(async (name) => Buffer.from(await archive.files[name].async('uint8array'))));
}

/** A picture cut to what it draws and set to one size, so that two renders of a drawing the office suite crops and a page that it does not compare on the drawing alone. */
async function drawingOf(image: Buffer): Promise<Buffer> {
  const flat = await sharp(image).flatten({ background: '#ffffff' }).png().toBuffer();
  const cut = await sharp(flat).trim({ background: '#ffffff', threshold: 24 }).png().toBuffer().catch(() => flat);
  return sharp(cut).resize(COMPARE_SIDE, COMPARE_SIDE, { fit: 'fill' }).png().toBuffer();
}

/** The width over the height of what a picture draws, paper cut away. */
async function drawingAspect(image: Buffer): Promise<number> {
  const flat = await sharp(image).flatten({ background: '#ffffff' }).png().toBuffer();
  const { info } = await sharp(flat).trim({ background: '#ffffff', threshold: 24 }).toBuffer({ resolveWithObject: true });
  return info.width / info.height;
}

async function ssim(actual: Buffer, reference: Buffer): Promise<number> {
  return (await compareImages(await drawingOf(actual), await drawingOf(reference), { includeDiffImage: false })).ssim;
}

/** Inkscape draws the metafile as a PNG; undefined when it reads no file (it stops on some EMF files, and on macOS can write the file and not exit). */
function inkscapePicture(metafile: Buffer, target: string): Buffer | undefined {
  return withTempDir((dir) => {
    const input = path.join(dir, `input.${target}`);
    const out = path.join(dir, 'inkscape.png');
    fs.writeFileSync(input, metafile);
    spawnSync(requireOracleTool('inkscape'), [input, '--export-type=png', `--export-filename=${out}`, '-d', String(COMPARE_DPI)], { timeout: INKSCAPE_TIMEOUT_MS, stdio: 'ignore' });
    return fs.existsSync(out) ? fs.readFileSync(out) : undefined;
  });
}

function expectMetafileHeader(metafile: Buffer, target: string, label: string): void {
  if (target === 'emf') {
    expect({ label, record: metafile.readUInt32LE(0), signature: metafile.readUInt32LE(40), size: metafile.readUInt32LE(48) }).toEqual({ label, record: 1, signature: 0x464d4520, size: metafile.length });
    return;
  }
  const header = metafile.readUInt32LE(0) === WMF_PLACEABLE_KEY ? WMF_PLACEABLE_HEADER_BYTES : 0;
  expect({ label, type: [1, 2].includes(metafile.readUInt16LE(header)), headerWords: metafile.readUInt16LE(header + 2) }).toEqual({ label, type: true, headerWords: 9 });
}

describe.skipIf(toolsMissing)('real PDF files and presentations written as EMF and WMF', () => {
  for (const sample of SAMPLES) {
    it(
      `${sample.id}: every page is written as ${sample.targets.join(' and ')}, and readers other than the writer draw the page`,
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, sample.id);
        const pdf = (await dispatchConversion(bytes, sample.extension, 'pdf', {}, sample.id)).buffer;
        expect({ id: sample.id, pages: pdfPageCount(pdf) }).toEqual({ id: sample.id, pages: sample.pages });
        const pdfPage = firstPageOfPdf(pdf);

        for (const target of sample.targets) {
          const label = `${sample.id} -> ${target}`;
          const result = await dispatchConversion(bytes, sample.extension, target, {}, sample.id);
          const outputs = await pagesOf(result.buffer);
          expect(outputs.length, `${label} pages`).toBe(sample.pages);
          outputs.forEach((metafile, index) => expectMetafileHeader(metafile, target, `${label} page ${index + 1}`));
          if (target === 'emf') {
            // The frame of the file (rclFrame, in 0.01 mm) is the page (a rotated page has its sides the other way round): a page the office suite writes keeps the edge of a picture that fills it, and a page the in-process writer writes has the size of Poppler's page whichever unit the SVG gives it.
            const frame = sidesOf((outputs[0].readInt32LE(32) - outputs[0].readInt32LE(24)) / 100, (outputs[0].readInt32LE(36) - outputs[0].readInt32LE(28)) / 100);
            const pageSize = firstPageSizeMm(pdf);
            const page = sidesOf(pageSize.width, pageSize.height);
            const fits = Math.abs(frame[0] - page[0]) <= FRAME_TOLERANCE_MM && Math.abs(frame[1] - page[1]) <= FRAME_TOLERANCE_MM;
            expect(fits, `${label} frame ${frame.join(' x ')} mm against page ${page.join(' x ')} mm`).toBe(true);
          }
          if (sample.picture) expect(bitmapRecordCount(outputs[0], target), `${label} bitmap records of page 1`).toBeGreaterThan(0);

          const redrawn = sofficeConvert(outputs[0], `out.${target}`, 'png', (output) => output.read());
          expect(await ssim(redrawn, pdfPage), `${label} drawn again by the office suite`).toBeGreaterThan(MIN_OFFICE_SSIM);
          const aspect = (await drawingAspect(redrawn)) / (await drawingAspect(pdfPage));
          expect({ label, aspect: Math.abs(aspect - 1) < MAX_ASPECT_DIFFERENCE, ratio: aspect }).toMatchObject({ label, aspect: true });
          if (!inkscapeMissing) {
            const picture = inkscapePicture(outputs[0], target);
            if (picture) expect(await ssim(picture, pdfPage), `${label} drawn by Inkscape`).toBeGreaterThan(MIN_INKSCAPE_SSIM);
          }
        }
      },
      CONVERSION_TIMEOUT_MS
    );
  }
});

describe.skipIf(toolsMissing)('real PDF files the metafile writers refuse, with the reason of the file', () => {
  it('a page whose text is a Type 3 bitmap font is refused: the office suite would draw the page without its text', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'govdocs1-002145.pdf');
    for (const target of BOTH) {
      const refusal = await dispatchConversion(bytes, 'pdf', target, {}, 'type3.pdf').catch((error: unknown) => error);
      expect(refusal, `pdf -> ${target}`).toBeInstanceOf(UnsupportedOptionError);
      expect((refusal as Error).message, `pdf -> ${target}`).toMatch(/bitmap glyph|mask/);
    }
  }, CONVERSION_TIMEOUT_MS);

  it('a PDF whose permissions forbid assembling pages is refused, as every page operation refuses it', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'govdocs1-000341.pdf');
    const refusal = await dispatchConversion(bytes, 'pdf', 'emf', {}, 'restricted.pdf').catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(PdfPermissionDeniedError);
    expect((refusal as Error).message).toMatch(/permissions forbid page assembly/);
  }, CONVERSION_TIMEOUT_MS);
});
