import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { oracleTest } from './helpers/oracle-test';
import { OracleToolMissingError, getOracleToolPath, type ExternalOracleTool } from './helpers/differential-oracle';
import {
  FIXTURE_HEADINGS,
  FIXTURE_LINK_URL,
  buildDocxWithJpeg,
  buildPptxWithJpeg,
  makeNoisyJpeg,
} from './helpers/office-jpeg-fixtures';
import { dispatchConversion } from '../src/lib/conversions/dispatch';

/**
 * Office -> PDF export keeps the source JPEG stream byte for byte, keeps the outline and the
 * hyperlinks, and gives a PDF/A request the same fidelity as a plain export. The expected bytes
 * are the JPEG the fixture was built from; images are read back with `pdfimages -j`, links with
 * `pdfinfo -url` and the outline with PyMuPDF, none of which is part of the code under test.
 */

const CONVERT_TIMEOUT_MS = 180_000;
const TOOLS: ExternalOracleTool[] = ['soffice', 'pdfimages', 'pdfinfo'];
const PDFA_2B_PART = '2';
/** The compression profile test downsamples a 96 ppi image to this resolution. */
const COMPRESSED_IMAGE_DPI = 72;
const COMPRESSED_JPEG_QUALITY = 40;
const OUT_OF_RANGE_IMAGE_DPI = 5;
const OUT_OF_RANGE_JPEG_QUALITY = 101;

let workDir: string;
let jpeg: Buffer;
let docx: Buffer;
let pptx: Buffer;

const md5 = (data: Buffer) => crypto.createHash('md5').update(data).digest('hex');

function tool(name: ExternalOracleTool): string {
  const resolved = getOracleToolPath(name);
  if (!resolved) throw new OracleToolMissingError(name);
  return resolved;
}

/** MD5 and pixel size of every JPEG stream `pdfimages -j` extracts from the PDF. */
function embeddedJpegs(pdf: Buffer, label: string): string[] {
  const pdfPath = path.join(workDir, `${label}.pdf`);
  const prefix = path.join(workDir, `${label}-img`);
  fs.writeFileSync(pdfPath, pdf);
  execFileSync(tool('pdfimages'), ['-j', pdfPath, prefix]);
  return fs
    .readdirSync(workDir)
    .filter((name) => name.startsWith(`${label}-img`) && name.endsWith('.jpg'))
    .sort()
    .map((name) => md5(fs.readFileSync(path.join(workDir, name))));
}

/** Pixel width of the first image `pdfimages -list` reports. */
function firstImageWidth(pdf: Buffer, label: string): number {
  const pdfPath = path.join(workDir, `${label}-list.pdf`);
  fs.writeFileSync(pdfPath, pdf);
  const listing = execFileSync(tool('pdfimages'), ['-list', pdfPath], { encoding: 'utf-8' });
  const firstRow = listing.split('\n')[2]?.trim().split(/\s+/);
  const width = Number(firstRow?.[3]);
  if (!Number.isInteger(width)) throw new Error(`pdfimages -list printed no image row:\n${listing}`);
  return width;
}

function linkUrls(pdf: Buffer, label: string): string[] {
  const pdfPath = path.join(workDir, `${label}-url.pdf`);
  fs.writeFileSync(pdfPath, pdf);
  const listing = execFileSync(tool('pdfinfo'), ['-url', pdfPath], { encoding: 'utf-8' });
  return listing
    .split('\n')
    .filter((line) => /^\s*\d+\s+\w+\s+https?:/.test(line))
    .map((line) => line.trim().split(/\s+/).pop() as string);
}

function xmpPdfAPart(pdf: Buffer, label: string): string | undefined {
  const pdfPath = path.join(workDir, `${label}-meta.pdf`);
  fs.writeFileSync(pdfPath, pdf);
  const xmp = execFileSync(tool('pdfinfo'), ['-meta', pdfPath], { encoding: 'utf-8' });
  return xmp.match(/<pdfaid:part>(\d+)<\/pdfaid:part>/)?.[1];
}

const OUTLINE_SCRIPT = 'import json,sys,pymupdf; print(json.dumps(pymupdf.open(sys.argv[1]).get_toc()))';

/** Outline titles in document order, read with PyMuPDF; skips (throws under strict mode) when it is missing. */
function outlineTitles(pdf: Buffer, label: string): string[] {
  const pdfPath = path.join(workDir, `${label}-outline.pdf`);
  fs.writeFileSync(pdfPath, pdf);
  const python = getOracleToolPath('python3');
  if (!python) throw new OracleToolMissingError('python3');
  let json: string;
  try {
    json = execFileSync(python, ['-I', '-c', OUTLINE_SCRIPT, pdfPath], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    throw new OracleToolMissingError('pymupdf', 'PyMuPDF is not importable by python3');
  }
  return (JSON.parse(json) as [number, string, number][]).map((entry) => entry[1]);
}

beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-pdf-fidelity-'));
  jpeg = await makeNoisyJpeg();
  docx = await buildDocxWithJpeg(jpeg);
  pptx = await buildPptxWithJpeg(jpeg);
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('Office to PDF export fidelity (#558)', () => {
  oracleTest(
    'docx to pdf keeps the JPEG stream, the outline and the link',
    [...TOOLS, 'python3'],
    async () => {
      const result = await dispatchConversion(docx, 'docx', 'pdf', {}, 'fx.docx');

      expect(embeddedJpegs(result.buffer, 'docx')).toEqual([md5(jpeg)]);
      expect(outlineTitles(result.buffer, 'docx')).toEqual([...FIXTURE_HEADINGS]);
      expect(linkUrls(result.buffer, 'docx')).toEqual([FIXTURE_LINK_URL]);
    },
    CONVERT_TIMEOUT_MS
  );

  oracleTest(
    'pptx to pdf keeps the JPEG stream and the link',
    TOOLS,
    async () => {
      const result = await dispatchConversion(pptx, 'pptx', 'pdf', {}, 'fx.pptx');

      expect(embeddedJpegs(result.buffer, 'pptx')).toEqual([md5(jpeg)]);
      expect(linkUrls(result.buffer, 'pptx')).toEqual([FIXTURE_LINK_URL]);
    },
    CONVERT_TIMEOUT_MS
  );

  oracleTest(
    'docx to PDF/A-2b exports directly: same JPEG stream, outline and link as the plain export',
    [...TOOLS, 'python3', 'verapdf'],
    async () => {
      const plain = await dispatchConversion(docx, 'docx', 'pdf', {}, 'fx.docx');
      const archival = await dispatchConversion(docx, 'docx', 'pdf', { pdfa: { conformance: 'pdfa-2b' } }, 'fx.docx');

      expect(xmpPdfAPart(archival.buffer, 'pdfa')).toBe(PDFA_2B_PART);
      expect(embeddedJpegs(archival.buffer, 'pdfa')).toEqual([md5(jpeg)]);
      expect(outlineTitles(archival.buffer, 'pdfa')).toEqual(outlineTitles(plain.buffer, 'plain'));
      expect(outlineTitles(archival.buffer, 'pdfa')).toEqual([...FIXTURE_HEADINGS]);
      expect(linkUrls(archival.buffer, 'pdfa')).toEqual([FIXTURE_LINK_URL]);
    },
    CONVERT_TIMEOUT_MS
  );

  oracleTest(
    'a PDF input still goes through the Draw round trip and keeps its JPEG stream',
    [...TOOLS, 'verapdf'],
    async () => {
      const plain = await dispatchConversion(docx, 'docx', 'pdf', {}, 'fx.docx');
      const archival = await dispatchConversion(
        plain.buffer,
        'pdf',
        'pdf',
        { pdfa: { conformance: 'pdfa-2b' } },
        'fx.pdf'
      );

      expect(xmpPdfAPart(archival.buffer, 'pdf-input')).toBe(PDFA_2B_PART);
      expect(embeddedJpegs(archival.buffer, 'pdf-input')).toEqual([md5(jpeg)]);
    },
    CONVERT_TIMEOUT_MS
  );

  oracleTest(
    'imageDpi downsamples the image and jpegQuality re-encodes it, both on request only',
    TOOLS,
    async () => {
      const original = await dispatchConversion(docx, 'docx', 'pdf', {}, 'fx.docx');
      const downsampled = await dispatchConversion(docx, 'docx', 'pdf', { imageDpi: COMPRESSED_IMAGE_DPI }, 'fx.docx');
      expect(firstImageWidth(downsampled.buffer, 'dpi')).toBeLessThan(firstImageWidth(original.buffer, 'full'));

      const recompressed = await dispatchConversion(docx, 'docx', 'pdf', { jpegQuality: COMPRESSED_JPEG_QUALITY }, 'fx.docx');
      const [recompressedMd5] = embeddedJpegs(recompressed.buffer, 'quality');
      expect(recompressedMd5).not.toBe(md5(jpeg));
    },
    CONVERT_TIMEOUT_MS
  );

  it('rejects imageDpi and jpegQuality values outside the accepted range before converting', async () => {
    await expect(
      dispatchConversion(docx, 'docx', 'pdf', { imageDpi: OUT_OF_RANGE_IMAGE_DPI }, 'fx.docx')
    ).rejects.toThrow('The imageDpi option must be an integer between 72 and 1200.');
    await expect(
      dispatchConversion(docx, 'docx', 'pdf', { jpegQuality: OUT_OF_RANGE_JPEG_QUALITY }, 'fx.docx')
    ).rejects.toThrow('The jpegQuality option must be an integer between 1 and 100.');
  });
});
