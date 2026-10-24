import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { convertVectorCad } from '../src/lib/conversions/vector-cad';
import { getFormatByExtension } from '../src/lib/registry';
import { CadGeometryUnavailableError, EngineUnavailableError } from '../src/lib/types';
import { defaultResolver, EZDXF_PSEUDO_TOOL } from '../bench/tools';
import { requireOracleTool } from './helpers/differential-oracle';
import { sofficeConvert } from './helpers/soffice-convert';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipUnless, skipWithoutTools } from './helpers/strict-skip';
import { compareImages } from './helpers/vrt-engine';

/**
 * Real Visio, CorelDRAW, Windows metafile (EMF, WMF) and Computer Graphics Metafile files, and the formats that stay
 * refused (DWF, Sketch and sK1). Until #783 the in-process engine took these files for convertible only when their bytes
 * held the text `<svg`, so every real drawing was refused, and the metafiles were not accepted as sources at all. The
 * office suite's Draw application (Impress for CGM) now imports them and every target the registry offers is written from
 * its PDF export: the page chain for images, SVG and PostScript, and the SVG that Poppler draws for DXF, EMF and WMF.
 * Readers other than the converter judge the output:
 *
 * - pinned phrases, read from the drawing as the renders show them (pdftotext on the PDF) and checked in the PDF;
 * - the page count and size of the PDF (pdfinfo), pinned as literals, and for the CGM files the number of pictures that
 *   the binary encoding itself declares (class 0, element 3 of ISO 8632-3, counted by walking the file);
 * - the PNG, SVG, EPS and PostScript pages against the PDF page they were written from (SSIM; ghostscript draws the PostScript);
 * - Inkscape, which reads Visio and CorelDRAW files with the same libraries and writes a PDF of its own: every letter it
 *   shows is in the converter's PDF, and the pages look alike (SSIM of the first page). It reads the metafiles too and makes
 *   their page the frame of the header, as the converter does (docs/policy-decisions.md entry 100), so their pages have the same
 *   size; it reads no CGM and crashes on two of the EMF files (`lo-sine_wave.emf`, `tika-testemf.emf`), whose page is the frame
 *   worked out from the header by hand;
 * - for the DXF, ezdxf: the file reads without audit errors and its extents hold every inked pixel of the page;
 * - for the EMF and WMF written from a drawing, the office suite reading them back, which is the import filter of those
 *   formats and not the encoder that wrote them;
 * - for the CorelDRAW file with no text, the page thumbnail that CorelDRAW stored in the file itself.
 *
 * The files are fetched, digest-checked and cached like the nightly corpus run does (bench/realworld/manifest.json).
 */

const toolsMissing = skipWithoutTools('soffice', 'pdftotext', 'pdfinfo', 'pdftoppm', 'pdftocairo', 'pdfimages', 'gs');
const inkscapeMissing = skipWithoutTools('inkscape');
const PYTHON_WITH_EZDXF = defaultResolver()(EZDXF_PSEUDO_TOOL);
const ezdxfMissing = skipUnless('python3 and ezdxf', PYTHON_WITH_EZDXF !== null);
const CONVERSION_TIMEOUT_MS = 600_000;
const TOOL_TIMEOUT_MS = 120_000;
const COMPARE_DPI = 50;
/** The longest side, in pixels, of an A4 page at the comparison resolution: a smaller page is compared at a higher one, so that its SSIM is taken over as many pixels. */
const COMPARE_LONG_SIDE_PIXELS = Math.ceil((841.89 * COMPARE_DPI) / 72);
const POINT_TOLERANCE = 0.6;
/** Lowest SSIM of a page against another renderer's page of the same file (measured 0.95 to 1.0 against Inkscape). */
const MIN_RENDERER_SSIM = 0.9;
/** Lowest SSIM of the PNG, the SVG and the PostScript render against the PDF page they were written from (measured 0.83 to 1.0: each renderer rasterises text, thin lines and photographs its own way). A blank or other page scores far lower. The floors were measured on macOS (Poppler 26, LibreOffice 26.8); their first run on the Linux image (Poppler 24, LibreOffice 24.2) is the CI run. */
const MIN_CHAIN_SSIM = 0.8;
/** Largest distance, in one 8-bit colour channel, between a colour of the render and the same spot of CorelDRAW's thumbnail. */
const THUMBNAIL_COLOUR_TOLERANCE = 16;
const A4_POINTS = { width: 595.28, height: 841.89 };
const CGM_PAGE_POINTS = { width: 793.7, height: 446.46 };
const PAGE_TARGETS = ['pdf', 'png', 'svg', 'eps', 'ps'] as const;
const METAFILE_PAGE_TARGETS = [...PAGE_TARGETS, 'jpg'] as const;
/** Visio drawings are the one source whose pages the DXF writer and the metafile encoders can write (the others hold pictures or clip regions). */
const VISIO_TARGETS = [...PAGE_TARGETS, 'dxf', 'emf', 'wmf'] as const;
const NO_PHRASE: readonly string[] = [];
/** The DXF extents may differ from the inked pixels by this many points: a stroke has a width the outline does not. */
const DXF_EXTENT_TOLERANCE_POINTS = 2;
const INK_DPI = 72;
const INK_THRESHOLD = 245;
/** Lowest SSIM of an EMF or WMF written from a drawing, drawn again by the office suite, against the PNG of the drawing (measured 0.76 for a dense UML page, above 0.9 for the others). */
const MIN_METAFILE_REIMPORT_SSIM = 0.7;

interface Point {
  width: number;
  height: number;
}

/** How Inkscape reads the sample: draws the page as the Draw application does, only its letters are comparable, or it cannot read the file. */
type InkscapeReading = 'alike' | 'letters' | 'none';

interface SampleCase {
  /** Id in bench/realworld/manifest.json. */
  id: string;
  extension: 'vsd' | 'cdr' | 'emf' | 'wmf' | 'cgm';
  targets: readonly string[];
  /** The page size in points, as the PDF declares it. */
  pageSize: Point;
  pages: number;
  /** Phrases of each page's own text, pinned as literals read from the render (a page without an entry has no text). */
  pagePhrases: readonly (readonly string[])[];
  /** Pictures embedded in the first page, which pdfimages lists in the PDF (for an EMF or WMF also the bitmap records the file itself holds). */
  embeddedPictures?: number;
  inkscape: InkscapeReading;
  /** Floor of the chain SSIM for a page whose renders differ more than `MIN_CHAIN_SSIM` allows, with the reason beside the sample. */
  minChainSsim?: number;
  /** Floor of the SSIM against Inkscape's page for a page that Inkscape draws differently, with the reason beside the sample. */
  minRendererSsim?: number;
}

const SAMPLES: readonly SampleCase[] = [
  { id: 'tika-testvisio.vsd', extension: 'vsd', targets: VISIO_TARGETS, pageSize: A4_POINTS, pages: 1, pagePhrases: [['test view', 'i am a test view', 'some random text on a page']], inkscape: 'alike' },
  { id: 'lo-fdo57117-1.vsd', extension: 'vsd', targets: VISIO_TARGETS, pageSize: A4_POINTS, pages: 1, pagePhrases: [['test']], inkscape: 'alike' },
  // The Visio text box is narrower than its text, so the Draw application breaks "Nouveau" after "Nouvea".
  { id: 'office-44501.vsd', extension: 'vsd', targets: VISIO_TARGETS, pageSize: { width: 612.28, height: 790.87 }, pages: 1, pagePhrases: [['penible', 'farine']], inkscape: 'alike' },
  {
    id: 'office-44501e.vsd',
    extension: 'vsd',
    targets: VISIO_TARGETS,
    pageSize: { width: 612, height: 792 },
    pages: 2,
    pagePhrases: [['busstatus', 'weekdayschedule', 'trafficcondition'], ['player', 'team', 'position']],
    inkscape: 'alike',
  },
  { id: 'office-pb-poi.cdr', extension: 'cdr', targets: PAGE_TARGETS, pageSize: A4_POINTS, pages: 1, pagePhrases: [['powered by', 'apache']], embeddedPictures: 1, inkscape: 'letters' },
  { id: 'lo-fdo65220-2.cdr', extension: 'cdr', targets: PAGE_TARGETS, pageSize: A4_POINTS, pages: 1, pagePhrases: [NO_PHRASE], inkscape: 'alike' },
  // Twelve gradient bitmaps under heavy outlines fill the page edge to edge: the renderers differ by a pixel along every edge and in the banding
  // (measured 0.75 for the SVG and above 0.8 for the rest of the chain). Inkscape draws the envelope's body dark where every other renderer draws it white
  // (measured 0.84 on a page that is otherwise the same: the page, the scale and the position of the drawing are those of Inkscape).
  { id: 'lo-computer_mail.emf', extension: 'emf', targets: METAFILE_PAGE_TARGETS, pageSize: { width: 68.28, height: 71.26 }, pages: 1, pagePhrases: [], embeddedPictures: 12, inkscape: 'alike', minChainSsim: 0.7, minRendererSsim: 0.8 },
  { id: 'lo-sine_wave.emf', extension: 'emf', targets: METAFILE_PAGE_TARGETS, pageSize: { width: 646.72, height: 529.03 }, pages: 1, pagePhrases: [['10 20 30 40 50 60 70 80 90 100']], inkscape: 'none' },
  { id: 'tika-testemf.emf', extension: 'emf', targets: METAFILE_PAGE_TARGETS, pageSize: { width: 154.91, height: 95.98 }, pages: 1, pagePhrases: [], embeddedPictures: 1, inkscape: 'none' },
  { id: 'lo-testroundrect.wmf', extension: 'wmf', targets: METAFILE_PAGE_TARGETS, pageSize: { width: 90.23, height: 66.15 }, pages: 1, pagePhrases: [], inkscape: 'alike' },
  { id: 'lo-visio_import_source.wmf', extension: 'wmf', targets: METAFILE_PAGE_TARGETS, pageSize: { width: 255.2, height: 106.45 }, pages: 1, pagePhrases: [['dgps rsxx2', 'each input output has individual dcdc converter']], inkscape: 'alike' },
  { id: 'tika-testwmf.wmf', extension: 'wmf', targets: METAFILE_PAGE_TARGETS, pageSize: { width: 117, height: 72.75 }, pages: 1, pagePhrases: [], embeddedPictures: 1, inkscape: 'alike' },
  { id: 'lo-binary_corvette.cgm', extension: 'cgm', targets: METAFILE_PAGE_TARGETS, pageSize: CGM_PAGE_POINTS, pages: 1, pagePhrases: [], inkscape: 'none' },
  { id: 'lo-circles.cgm', extension: 'cgm', targets: METAFILE_PAGE_TARGETS, pageSize: CGM_PAGE_POINTS, pages: 14, pagePhrases: [], inkscape: 'none' },
  // The file's 13 axis labels share one spot on the page: the office suite's CGM import (24.2 and 26.8 alike) places every
  // RESTRICTED TEXT element at one point, so the text check below reads the characters, not the order an extractor lists them in.
  { id: 'tika-plotutils-bin-cgm-v3.cgm', extension: 'cgm', targets: METAFILE_PAGE_TARGETS, pageSize: CGM_PAGE_POINTS, pages: 1, pagePhrases: [], inkscape: 'none' },
];

// ---------------------------------------------------------------------------
// Readers other than the converter
// ---------------------------------------------------------------------------

function withTempDir<T>(prefix: string, run: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runTool(tool: Parameters<typeof requireOracleTool>[0], args: string[]): string {
  return execFileSync(requireOracleTool(tool), args, { encoding: 'utf-8', timeout: TOOL_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

function withFile<T>(bytes: Buffer, extension: string, run: (file: string, dir: string) => T): T {
  return withTempDir('vector-source-', (dir) => {
    const file = path.join(dir, `input.${extension}`);
    fs.writeFileSync(file, bytes);
    return run(file, dir);
  });
}

function normalizedText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** The text of each page of a PDF, as pdftotext reads it. */
function pdfPageTexts(pdf: Buffer): string[] {
  const pages = withFile(pdf, 'pdf', (file) => runTool('pdftotext', [file, '-'])).split('\f');
  if (pages.at(-1)?.trim() === '') pages.pop();
  return pages;
}

function pdfPages(pdf: Buffer): { count: number; sizes: Point[] } {
  const info = withFile(pdf, 'pdf', (file) => runTool('pdfinfo', ['-f', '1', '-l', '99', file]));
  const sizes = [...info.matchAll(/^Page\s+\d+ size:\s+([\d.]+) x ([\d.]+) pts/gm)].map((match) => ({ width: Number(match[1]), height: Number(match[2]) }));
  return { count: Number(/^Pages:\s+(\d+)$/m.exec(info)?.[1]), sizes };
}

function pdfPictureCount(pdf: Buffer): number {
  const listing = withFile(pdf, 'pdf', (file) => runTool('pdfimages', ['-list', file]));
  return listing.split('\n').filter((line) => /^\s*\d+\s+\d+\s+image\b/.test(line)).length;
}

/** The resolution a page is compared at: 50 dpi, or more for a page whose longest side is shorter than an A4 page's at 50 dpi. */
function comparisonDpi(page: Point): number {
  return Math.max(COMPARE_DPI, Math.ceil((COMPARE_LONG_SIDE_PIXELS * 72) / Math.max(page.width, page.height)));
}

/** The first page of a PDF as a PNG at the comparison resolution. */
function firstPageOfPdf(pdf: Buffer, dpi = COMPARE_DPI): Buffer {
  return withFile(pdf, 'pdf', (file, dir) => {
    runTool('pdftoppm', ['-png', '-r', String(dpi), '-f', '1', '-l', '1', '-singlefile', file, path.join(dir, 'page')]);
    return fs.readFileSync(path.join(dir, 'page.png'));
  });
}

/** The first page of a PostScript or EPS file as a PNG at the comparison resolution, drawn by ghostscript. */
function firstPageOfPostScript(source: Buffer, extension: 'ps' | 'eps', dpi = COMPARE_DPI): Buffer {
  return withFile(source, extension, (file, dir) => {
    const crop = extension === 'eps' ? ['-dEPSCrop'] : [];
    runTool('gs', ['-q', '-dBATCH', '-dNOPAUSE', '-dSAFER', '-sDEVICE=png16m', `-r${dpi}`, ...crop, '-dFirstPage=1', '-dLastPage=1', `-sOutputFile=${path.join(dir, 'page.png')}`, file]);
    return fs.readFileSync(path.join(dir, 'page.png'));
  });
}

/** Inkscape is given this long to write its PDF; on macOS it can write the file and then not exit, so a complete file is taken when the time is up. */
const INKSCAPE_TIMEOUT_MS = 30_000;
const PDF_TRAILER = /%%EOF\s*$/;

/** The file as Inkscape reads it, written as a PDF. */
function inkscapePdf(source: Buffer, extension: string): Buffer {
  return withFile(source, extension, (file, dir) => {
    const out = path.join(dir, 'inkscape.pdf');
    const run = spawnSync(requireOracleTool('inkscape'), [file, '--export-type=pdf', `--export-filename=${out}`], { timeout: INKSCAPE_TIMEOUT_MS, stdio: 'ignore' });
    const written = fs.existsSync(out) ? fs.readFileSync(out) : Buffer.alloc(0);
    const complete = written.length > 0 && PDF_TRAILER.test(written.subarray(-32).toString('latin1'));
    if (!complete) throw run.error ?? new Error(`inkscape exited with ${run.status} and wrote no PDF for ${file}`);
    return written;
  });
}

/** How often each letter or digit occurs in the text: the words of a page without their order or where a line breaks. */
function characterCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const character of normalizedText(text).replaceAll(' ', '')) counts.set(character, (counts.get(character) ?? 0) + 1);
  return counts;
}

/** The pages of an output that holds one file per page: the file itself, or the entries of the ZIP the pages arrive in. */
async function pagesOf(output: Buffer): Promise<Buffer[]> {
  if (output.subarray(0, 2).toString('latin1') !== 'PK') return [output];
  const archive = await JSZip.loadAsync(output);
  const names = Object.keys(archive.files).sort();
  return Promise.all(names.map(async (name) => Buffer.from(await archive.files[name].async('uint8array'))));
}

async function ssim(actual: Buffer, reference: Buffer): Promise<number> {
  const size = await sharp(reference).metadata();
  const resized = await sharp(actual).resize(size.width, size.height, { fit: 'fill' }).png().toBuffer();
  return (await compareImages(resized, reference, { includeDiffImage: false })).ssim;
}

function expectClose(actual: Point, expected: Point, label: string): void {
  expect({ label, width: Math.abs(actual.width - expected.width) <= POINT_TOLERANCE, height: Math.abs(actual.height - expected.height) <= POINT_TOLERANCE }).toEqual({
    label,
    width: true,
    height: true,
  });
}

/** A picture of the right kind with a size and more than one colour. */
async function expectDrawnPicture(image: Buffer, label: string): Promise<{ width: number; height: number }> {
  const metadata = await sharp(image).metadata();
  expect(metadata.width, label).toBeGreaterThan(0);
  expect(metadata.height, label).toBeGreaterThan(0);
  const { channels } = await sharp(image).stats();
  expect(Math.max(...channels.map((channel) => channel.max - channel.min)), `${label} is one flat colour`).toBeGreaterThan(0);
  return { width: metadata.width as number, height: metadata.height as number };
}

function expectPhrases(phrases: readonly string[], text: string, label: string): void {
  const normalized = normalizedText(text);
  expect({ label, missing: phrases.filter((phrase) => !normalized.includes(phrase)) }).toEqual({ label, missing: [] });
}

/** The box of the pixels that are not paper white on the first page of a PDF, in points from the bottom left (the way DXF counts). */
async function inkBoxOfPdf(pdf: Buffer): Promise<{ minX: number; minY: number; maxX: number; maxY: number }> {
  const page = withFile(pdf, 'pdf', (file, dir) => {
    runTool('pdftoppm', ['-png', '-r', String(INK_DPI), '-f', '1', '-l', '1', '-singlefile', file, path.join(dir, 'page')]);
    return fs.readFileSync(path.join(dir, 'page.png'));
  });
  const { data, info } = await sharp(page).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const at = (y * info.width + x) * info.channels;
      if (data[at] >= INK_THRESHOLD && data[at + 1] >= INK_THRESHOLD && data[at + 2] >= INK_THRESHOLD) continue;
      box.minX = Math.min(box.minX, x);
      box.maxX = Math.max(box.maxX, x + 1);
      box.minY = Math.min(box.minY, info.height - y - 1);
      box.maxY = Math.max(box.maxY, info.height - y);
    }
  }
  return box;
}

const EZDXF_READER = `
import json, sys, ezdxf
from ezdxf import bbox
document = ezdxf.readfile(sys.argv[1])
auditor = document.audit()
modelspace = document.modelspace()
extents = bbox.extents(modelspace)
print(json.dumps({"errors": len(auditor.errors), "entities": len(modelspace), "min": list(extents.extmin)[:2], "max": list(extents.extmax)[:2]}))
`;

interface DxfFacts {
  errors: number;
  entities: number;
  min: [number, number];
  max: [number, number];
}

/**
 * DXF units per point. The DXF is written in SVG pixels: Poppler 24 writes the page size of its SVG without a unit
 * (a pixel is a point), Poppler 26 in `pt` (a point is 4/3 pixel), so the factor is read from the SVG of the same PDF.
 */
const SVG_PIXELS_PER_POINT = 96 / 72;
function dxfUnitsPerPoint(pdf: Buffer): number {
  const svg = withFile(pdf, 'pdf', (file) => runTool('pdftocairo', ['-svg', '-f', '1', '-l', '1', file, '-']));
  return /<svg\b[^>]*\swidth="[\d.]+pt"/.test(svg) ? SVG_PIXELS_PER_POINT : 1;
}

/** What ezdxf reads from a DXF file: audit errors, entity count and the extents of the drawing. */
function ezdxfFacts(dxf: Buffer): DxfFacts {
  return withFile(dxf, 'dxf', (file) =>
    JSON.parse(execFileSync(PYTHON_WITH_EZDXF as string, ['-I', '-c', EZDXF_READER, file], { encoding: 'utf-8', timeout: TOOL_TIMEOUT_MS })) as DxfFacts
  );
}

const EMF_RECORD_HEADER_BYTES = 8;
/** EMF bitmap records (MS-EMF 2.3): BITBLT, STRETCHBLT, MASKBLT, PLGBLT, SETDIBITSTODEVICE, STRETCHDIBITS, ALPHABLEND, TRANSPARENTBLT. */
const EMF_BITMAP_RECORDS: ReadonlySet<number> = new Set([0x4c, 0x4d, 0x4e, 0x4f, 0x50, 0x51, 0x72, 0x74]);
const EMF_HEADER_RECORD = 1;
const EMF_SIGNATURE = 0x464d4520;
const EMF_SIGNATURE_OFFSET = 40;
const WMF_HEADER_WORDS = 9;
const WMF_PLACEABLE_KEY = 0x9ac6cdd7;
const WMF_PLACEABLE_HEADER_BYTES = 22;
const WMF_HEADER_BYTES = 18;
const WMF_RECORD_HEADER_BYTES = 6;
/** WMF bitmap records (MS-WMF 2.3.1): BITBLT, STRETCHBLT, DIBBITBLT, DIBSTRETCHBLT, SETDIBTODEV, STRETCHDIB. */
const WMF_BITMAP_RECORDS: ReadonlySet<number> = new Set([0x0922, 0x0b23, 0x0940, 0x0b41, 0x0d33, 0x0f43]);

/** The bitmap records of an EMF or WMF file, found by walking its records by the layouts of MS-EMF and MS-WMF. */
function bitmapRecordCount(metafile: Buffer, extension: 'emf' | 'wmf'): number {
  let count = 0;
  if (extension === 'emf') {
    for (let offset = 0; offset + EMF_RECORD_HEADER_BYTES <= metafile.length; offset += metafile.readUInt32LE(offset + 4)) {
      if (EMF_BITMAP_RECORDS.has(metafile.readUInt32LE(offset))) count++;
    }
    return count;
  }
  let offset = metafile.readUInt32LE(0) === WMF_PLACEABLE_KEY ? WMF_PLACEABLE_HEADER_BYTES : 0;
  for (offset += WMF_HEADER_BYTES; offset + WMF_RECORD_HEADER_BYTES <= metafile.length; offset += metafile.readUInt32LE(offset) * 2) {
    if (WMF_BITMAP_RECORDS.has(metafile.readUInt16LE(offset + 4))) count++;
  }
  return count;
}

const CGM_CLASS = { delimiter: 0, graphicalPrimitive: 4 };
const CGM_ELEMENT = { beginPicture: 3, text: 4, restrictedText: 5 };
const CGM_SHORT_FORM_MAX_LENGTH = 30;
const CGM_PARTITION_BIT = 0x8000;

interface CgmElement {
  elementClass: number;
  id: number;
  parameters: Buffer;
}

/**
 * The elements of a binary CGM, walked by the layout of ISO 8632-3: a 16-bit header of a 4-bit class, a 7-bit id and a
 * 5-bit parameter length, a long form of its own, parameters padded to an even length. Independent of the office suite's reader.
 */
function cgmElements(cgm: Buffer): CgmElement[] {
  const elements: CgmElement[] = [];
  let offset = 0;
  while (offset + 2 <= cgm.length) {
    const header = cgm.readUInt16BE(offset);
    offset += 2;
    let length = header & 0x1f;
    if (length > CGM_SHORT_FORM_MAX_LENGTH) {
      const long = cgm.readUInt16BE(offset);
      offset += 2;
      expect(long & CGM_PARTITION_BIT, 'a partitioned element is not walked here').toBe(0);
      length = long & ~CGM_PARTITION_BIT;
    }
    elements.push({ elementClass: header >> 12, id: (header >> 5) & 0x7f, parameters: cgm.subarray(offset, offset + length) });
    offset += length + (length % 2);
  }
  expect(offset, 'the elements end where the file ends').toBe(cgm.length);
  return elements;
}

/** The number of pictures a binary CGM declares: its BEGIN PICTURE elements. */
function cgmPictureCount(cgm: Buffer): number {
  return cgmElements(cgm).filter((element) => element.elementClass === CGM_CLASS.delimiter && element.id === CGM_ELEMENT.beginPicture).length;
}

/** For each picture, how many graphical primitives (lines, polygons, arcs, text, ...: class 4) it draws. */
function cgmPrimitivesPerPicture(cgm: Buffer): number[] {
  const counts: number[] = [];
  for (const element of cgmElements(cgm)) {
    if (element.elementClass === CGM_CLASS.delimiter && element.id === CGM_ELEMENT.beginPicture) counts.push(0);
    else if (element.elementClass === CGM_CLASS.graphicalPrimitive && counts.length > 0) counts[counts.length - 1]++;
  }
  return counts;
}

const CGM_BACKGROUND_COLOUR = { elementClass: 2, id: 7 };
const CGM_COLOUR_PRECISION = { elementClass: 1, id: 7 };

/** The background colour of a binary CGM with a 16-bit direct colour precision (class 2, id 7): three 16-bit components, red, green and blue. */
function cgmBackgroundColour(cgm: Buffer): [number, number, number] {
  const elements = cgmElements(cgm);
  const precision = elements.find((element) => element.elementClass === CGM_COLOUR_PRECISION.elementClass && element.id === CGM_COLOUR_PRECISION.id);
  expect(precision?.parameters.readUInt16BE(0), 'the colour components have 16 bits').toBe(16);
  const background = elements.find((element) => element.elementClass === CGM_BACKGROUND_COLOUR.elementClass && element.id === CGM_BACKGROUND_COLOUR.id);
  expect(background?.parameters.length, 'a direct colour has three 16-bit components').toBe(6);
  const [red, green, blue] = [0, 2, 4].map((at) => (background as CgmElement).parameters.readUInt16BE(at));
  return [red, green, blue];
}

/** The characters of the strings that the TEXT and RESTRICTED TEXT elements carry: the string is the last parameter, a length byte and its characters. */
function cgmTextCharacters(cgm: Buffer): Set<string> {
  const characters = new Set<string>();
  for (const { elementClass, id, parameters } of cgmElements(cgm)) {
    if (elementClass !== CGM_CLASS.graphicalPrimitive || (id !== CGM_ELEMENT.text && id !== CGM_ELEMENT.restrictedText)) continue;
    const start = [...parameters.keys()].find((at) => parameters[at] === parameters.length - at - 1);
    expect(start, 'a text element ends in a length byte and that many characters').toBeDefined();
    for (const character of parameters.subarray((start as number) + 1).toString('latin1')) characters.add(character);
  }
  return characters;
}

const WMF_ROUND_RECTANGLE_RECORD = 0x061c;

/** The box of the first ROUNDRECT record of a WMF file (MS-WMF 2.3.3.20: height, width, bottom, right, top, left, each a 16-bit value). */
function wmfRoundRectangleBox(wmf: Buffer): { width: number; height: number } {
  let offset = (wmf.readUInt32LE(0) === WMF_PLACEABLE_KEY ? WMF_PLACEABLE_HEADER_BYTES : 0) + WMF_HEADER_BYTES;
  while (offset + WMF_RECORD_HEADER_BYTES <= wmf.length) {
    if (wmf.readUInt16LE(offset + 4) === WMF_ROUND_RECTANGLE_RECORD) {
      const [bottom, right, top, left] = [10, 12, 14, 16].map((at) => wmf.readInt16LE(offset + at));
      return { width: right - left, height: bottom - top };
    }
    offset += wmf.readUInt32LE(offset) * 2;
  }
  throw new Error('the WMF file has no ROUNDRECT record');
}

/** How far the aspect of the drawn ink may differ from the aspect of the box the file records: a stroke widens the ink by its width. */
const RECORD_ASPECT_TOLERANCE = 0.06;
/** The page corner that a CGM background colour must reach, and the distance in one 8-bit channel the converted colour may differ by. */
const CORNER_PIXEL = 3;
const BACKGROUND_COLOUR_TOLERANCE = 8;

interface RecordFactInput {
  bytes: Buffer;
  pdf: Buffer;
  /** The pages of the PNG output, in page order. */
  pngPages: Buffer[];
}

async function expectInkAspect(pdf: Buffer, recorded: { width: number; height: number }, label: string): Promise<void> {
  const ink = await inkBoxOfPdf(pdf);
  const drawn = (ink.maxX - ink.minX) / (ink.maxY - ink.minY);
  const expected = recorded.width / recorded.height;
  expect({ label, withinTolerance: Math.abs(drawn / expected - 1) <= RECORD_ASPECT_TOLERANCE, drawn, expected }).toMatchObject({ label, withinTolerance: true });
}

/**
 * One fact per sample that no phrase or second reader judges, read from the records of the file itself and checked in the
 * output: the box of the one rounded rectangle of a WMF file, the background colour of a CGM drawing, which pictures of a CGM file
 * draw anything, and the characters of the text a CGM file carries.
 */
const RECORD_FACTS: Readonly<Record<string, (input: RecordFactInput) => Promise<void>>> = {
  'lo-testroundrect.wmf': ({ bytes, pdf }) => expectInkAspect(pdf, wmfRoundRectangleBox(bytes), 'the rounded rectangle of the WMF record'),
  'lo-binary_corvette.cgm': async ({ bytes, pngPages }) => {
    const expected = cgmBackgroundColour(bytes);
    const { data, info } = await sharp(pngPages[0]).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const corner = (CORNER_PIXEL * info.width + CORNER_PIXEL) * info.channels;
    const distance = Math.max(...[0, 1, 2].map((channel) => Math.abs(data[corner + channel] - expected[channel])));
    expect({ background: expected, nearEnough: distance <= BACKGROUND_COLOUR_TOLERANCE }).toMatchObject({ nearEnough: true });
  },
  'lo-circles.cgm': async ({ bytes, pngPages }) => {
    const primitives = cgmPrimitivesPerPicture(bytes);
    expect(primitives.length).toBe(pngPages.length);
    for (const [index, count] of primitives.entries()) {
      expect(count, `picture ${index + 1} of the file draws something`).toBeGreaterThan(0);
      await expectDrawnPicture(pngPages[index], `page ${index + 1} of circles.cgm, a picture that draws ${count} primitives`);
    }
  },
  'tika-plotutils-bin-cgm-v3.cgm': async ({ bytes, pdf }) => {
    const wanted = cgmTextCharacters(bytes);
    expect([...wanted].sort().join('')).toBe('.0123456');
    const shown = new Set(pdfPageTexts(pdf).join(''));
    expect({ missing: [...wanted].filter((character) => !shown.has(character)) }).toEqual({ missing: [] });
  },
};

// ---------------------------------------------------------------------------
// CorelDRAW's own thumbnail of a page
// ---------------------------------------------------------------------------

const BMP_HEADER_BYTES = 54;
const BMP_BITS_PER_PIXEL = 24;

/** A 24-bit uncompressed bottom-up bitmap (the format of the thumbnails in a CorelDRAW package), read from its header per the BMP file layout. */
function readBitmap24(bmp: Buffer): { width: number; height: number; pixel: (x: number, y: number) => [number, number, number] } {
  expect(bmp.subarray(0, 2).toString('latin1')).toBe('BM');
  const width = bmp.readInt32LE(18);
  const height = bmp.readInt32LE(22);
  expect({ bitsPerPixel: bmp.readUInt16LE(28), compression: bmp.readUInt32LE(30) }).toEqual({ bitsPerPixel: BMP_BITS_PER_PIXEL, compression: 0 });
  const rowBytes = Math.ceil((width * BMP_BITS_PER_PIXEL) / 32) * 4;
  return {
    width,
    height,
    pixel: (x, y) => {
      const at = BMP_HEADER_BYTES + (height - 1 - y) * rowBytes + x * 3;
      return [bmp[at + 2], bmp[at + 1], bmp[at]];
    },
  };
}

/** Spots inside the four boxes of the left column of the drawing, as fractions of the page. */
const COLUMN_SPOTS: ReadonlyArray<readonly [number, number]> = [
  [0.17, 0.16],
  [0.17, 0.3],
  [0.17, 0.48],
  [0.17, 0.64],
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(toolsMissing)('real Visio, CorelDRAW, EMF, WMF and CGM files', () => {
  for (const sample of SAMPLES) {
    it(
      `${sample.id}: converts to ${sample.targets.filter((target) => target !== 'dxf').join(', ')} and every output shows the drawing`,
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, sample.id);
        const label = (target: string): string => `${sample.id} -> ${target}`;

        const pdf = (await dispatchConversion(bytes, sample.extension, 'pdf', {}, sample.id)).buffer;
        const pages = pdfPages(pdf);
        expect({ id: sample.id, pages: pages.count }).toEqual({ id: sample.id, pages: sample.pages });
        if (sample.extension === 'cgm') expect(cgmPictureCount(bytes), `${sample.id} pictures the file declares`).toBe(sample.pages);
        pages.sizes.forEach((size, index) => expectClose(size, sample.pageSize, `${label('pdf')} page ${index + 1} size`));
        const pageTexts = pdfPageTexts(pdf);
        sample.pagePhrases.forEach((phrases, index) => expectPhrases(phrases, pageTexts[index] ?? '', `${label('pdf')} page ${index + 1} text`));
        expect(pdfPictureCount(pdf), `${label('pdf')} pictures`).toBe(sample.embeddedPictures ?? 0);
        if (sample.extension === 'emf' || sample.extension === 'wmf') {
          expect(bitmapRecordCount(bytes, sample.extension), `${sample.id} bitmap records the file holds`).toBe(sample.embeddedPictures ?? 0);
        }
        const dpi = comparisonDpi(pages.sizes[0]);
        const minChainSsim = sample.minChainSsim ?? MIN_CHAIN_SSIM;
        const pdfPage = firstPageOfPdf(pdf, dpi);

        let pngPages: Buffer[] = [];
        for (const target of sample.targets.filter((candidate) => candidate !== 'pdf' && candidate !== 'dxf')) {
          const result = await dispatchConversion(bytes, sample.extension, target, {}, sample.id);
          const outputs = await pagesOf(result.buffer);
          if (target !== 'ps') expect(outputs.length, `${label(target)} pages`).toBe(pages.count);
          if (target === 'png' || target === 'jpg') {
            if (target === 'png') pngPages = outputs;
            for (const image of outputs) await expectDrawnPicture(image, label(target));
            expect(await ssim(outputs[0], pdfPage), `${label(target)} against the PDF page`).toBeGreaterThan(minChainSsim);
          } else if (target === 'svg') {
            expect(outputs[0].toString('utf-8'), label(target)).toMatch(/^<\?xml[^>]*\?>\s*<svg\b/);
            const drawn = await sharp(outputs[0], { density: dpi }).png().toBuffer();
            await expectDrawnPicture(drawn, label(target));
            expect(await ssim(drawn, pdfPage), `${label(target)} against the PDF page`).toBeGreaterThan(minChainSsim);
          } else if (target === 'eps' || target === 'ps') {
            const header = outputs[0].subarray(0, 40).toString('latin1');
            expect(header, label(target)).toMatch(target === 'eps' ? /^%!PS-Adobe-[\d.]+ EPSF-/ : /^%!PS-Adobe-/);
            expect(await ssim(firstPageOfPostScript(outputs[0], target, dpi), pdfPage), `${label(target)} against the PDF page`).toBeGreaterThan(minChainSsim);
          } else if (target === 'emf' || target === 'wmf') {
            await expectMetafileDrawsThePage(outputs[0], target, pdfPage, label(target));
          } else {
            expect(target, 'a target the checks above do not cover').toBe('dxf');
          }
        }
        await RECORD_FACTS[sample.id]?.({ bytes, pdf, pngPages });
      },
      CONVERSION_TIMEOUT_MS
    );
  }

  it(
    'lo-fdo65220-2.cdr: the colours of the left column are those CorelDRAW stored in the page thumbnail of the file',
    async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, 'lo-fdo65220-2.cdr');
      const thumbnail = readBitmap24(Buffer.from(await (await JSZip.loadAsync(bytes)).files['metadata/thumbnails/page1.bmp'].async('uint8array')));
      const picture = (await dispatchConversion(bytes, 'cdr', 'png', {}, 'fdo65220-2.cdr')).buffer;
      const { data, info } = await sharp(picture).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      for (const [x, y] of COLUMN_SPOTS) {
        const expected = thumbnail.pixel(Math.round(x * thumbnail.width), Math.round(y * thumbnail.height));
        const at = (Math.round(y * info.height) * info.width + Math.round(x * info.width)) * info.channels;
        const actual = [data[at], data[at + 1], data[at + 2]];
        expect({ spot: [x, y], distance: Math.max(...actual.map((channel, index) => Math.abs(channel - expected[index]))) <= THUMBNAIL_COLOUR_TOLERANCE }).toEqual({
          spot: [x, y],
          distance: true,
        });
      }
    },
    CONVERSION_TIMEOUT_MS
  );
});

/** The DXF reads without audit errors, holds entities, and its extents lie in the page and hold every inked pixel of the PDF page. */
async function expectDxfHoldsTheInk(dxf: Buffer, pdf: Buffer, label: string): Promise<void> {
  const unit = dxfUnitsPerPoint(pdf);
  const facts = ezdxfFacts(dxf);
  const ink = await inkBoxOfPdf(pdf);
  const tolerance = DXF_EXTENT_TOLERANCE_POINTS * unit;
  for (const side of ['minX', 'minY', 'maxX', 'maxY'] as const) ink[side] *= unit;
  expect({ label, errors: facts.errors }).toEqual({ label, errors: 0 });
  expect(facts.entities, `${label} entities`).toBeGreaterThan(0);
  const holdsInk = facts.min[0] <= ink.minX + tolerance && facts.min[1] <= ink.minY + tolerance && facts.max[0] >= ink.maxX - tolerance && facts.max[1] >= ink.maxY - tolerance;
  expect({ label, holdsInk, extents: [...facts.min, ...facts.max], ink: [ink.minX, ink.minY, ink.maxX, ink.maxY] }).toMatchObject({ label, holdsInk: true });
  const page = pdfPages(pdf).sizes[0];
  const [width, height] = [page.width * unit, page.height * unit];
  expect(facts.min[0], `${label} left edge`).toBeGreaterThanOrEqual(-tolerance);
  expect(facts.min[1], `${label} bottom edge`).toBeGreaterThanOrEqual(-tolerance);
  expect(facts.max[0], `${label} right edge`).toBeLessThanOrEqual(width + tolerance);
  expect(facts.max[1], `${label} top edge`).toBeLessThanOrEqual(height + tolerance);
}

/** The office suite reads the EMF or WMF back (its own import filter) and draws the page the PNG of the drawing shows. */
async function expectMetafileDrawsThePage(metafile: Buffer, target: string, pdfPage: Buffer, label: string): Promise<void> {
  if (target === 'emf') {
    expect({ label, record: metafile.readUInt32LE(0), signature: metafile.readUInt32LE(EMF_SIGNATURE_OFFSET) }).toEqual({ label, record: EMF_HEADER_RECORD, signature: EMF_SIGNATURE });
  } else {
    const header = metafile.readUInt32LE(0) === WMF_PLACEABLE_KEY ? WMF_PLACEABLE_HEADER_BYTES : 0;
    expect({ label, type: [1, 2].includes(metafile.readUInt16LE(header)), headerWords: metafile.readUInt16LE(header + 2) }).toEqual({ label, type: true, headerWords: WMF_HEADER_WORDS });
  }
  const redrawn = sofficeConvert(metafile, `out.${target}`, 'png', (output) => output.read());
  await expectDrawnPicture(redrawn, label);
  expect(await ssim(redrawn, pdfPage), `${label} drawn again by the office suite`).toBeGreaterThan(MIN_METAFILE_REIMPORT_SSIM);
}

describe.skipIf(toolsMissing || inkscapeMissing)('real files against Inkscape', () => {
  for (const sample of SAMPLES.filter((candidate) => candidate.inkscape !== 'none')) {
    it(
      `${sample.id}: Inkscape's letters are all in the PDF${sample.inkscape === 'alike' ? ', and the first page looks the same' : ''}`,
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, sample.id);
        const reference = inkscapePdf(bytes, sample.extension);
        const pdf = (await dispatchConversion(bytes, sample.extension, 'pdf', {}, sample.id)).buffer;
        const have = characterCounts(pdfPageTexts(pdf).join(' '));
        const lacking = [...characterCounts(pdfPageTexts(reference).join(' '))].filter(([character, count]) => (have.get(character) ?? 0) < count).map(([character]) => character);
        expect({ id: sample.id, lacking }).toEqual({ id: sample.id, lacking: [] });
        if (sample.inkscape === 'alike') {
          expectClose(pdfPages(pdf).sizes[0], pdfPages(reference).sizes[0], `${sample.id} first page size`);
          const dpi = comparisonDpi(pdfPages(pdf).sizes[0]);
          expect(await ssim(firstPageOfPdf(pdf, dpi), firstPageOfPdf(reference, dpi)), `${sample.id} first page`).toBeGreaterThan(sample.minRendererSsim ?? MIN_RENDERER_SSIM);
        }
      },
      CONVERSION_TIMEOUT_MS
    );
  }
});

describe.skipIf(toolsMissing || ezdxfMissing)('the DXF of a Visio drawing against ezdxf', () => {
  for (const sample of SAMPLES.filter((candidate) => candidate.targets.includes('dxf'))) {
    it(
      `${sample.id}: the DXF reads without audit errors and its extents hold every inked pixel of the page`,
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, sample.id);
        const pdf = (await dispatchConversion(bytes, sample.extension, 'pdf', {}, sample.id)).buffer;
        const dxf = (await dispatchConversion(bytes, sample.extension, 'dxf', {}, sample.id)).buffer;
        const outputs = await pagesOf(dxf);
        expect(outputs.length, `${sample.id} pages`).toBe(sample.pages);
        await expectDxfHoldsTheInk(outputs[0], pdf, `${sample.id} -> dxf`);
      },
      CONVERSION_TIMEOUT_MS
    );
  }
});

describe('what the in-process engine no longer pretends to read', () => {
  it.each(['vsd', 'cdr', 'emf', 'wmf', 'cgm'])('a file named .%s whose bytes hold an SVG is not converted by cutting the SVG out of it', async (extension) => {
    const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>');
    const failure = await convertVectorCad(svg, extension, 'png', {}, `drawing.${extension}`).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EngineUnavailableError);
    expect((failure as EngineUnavailableError).engineName).toBe('soffice');
  });

  it.each(['sk', 'sk1'])('a file named .%s is refused with the reason, whatever its bytes hold', async (extension) => {
    const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
    for (const bytes of [svg, Buffer.from('##Sketch 1 2\nlayer(\'Layer 1\')\n')]) {
      const failure = await convertVectorCad(bytes, extension, 'svg', {}, `drawing.${extension}`).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CadGeometryUnavailableError);
      expect((failure as Error).message).toMatch(/no reader for them is included in the worker/);
    }
  });

  it('a clear-text CGM is still read by the in-process parser, not handed to the office suite', async () => {
    const cgm = Buffer.from('BEGMF "text";\nMFVERSION 1;\nBEGPIC "p";\nBEGPICBODY;\nVDCEXT (0,0) (100,100);\nLINE (0,0) (100,100);\nENDPIC;\nENDMF;\n');
    const result = await convertVectorCad(cgm, 'cgm', 'svg', {}, 'text.cgm');
    const coordinates = [...result.buffer.toString('utf-8').matchAll(/\b(x1|y1|x2|y2)="([\d.]+)"/g)].map((match) => [match[1], Number(match[2])]);
    expect(coordinates).toEqual([['x1', 0], ['y1', 0], ['x2', 100], ['y2', 100]]);
  });

  it.each(['vsd', 'cdr', 'emf', 'wmf', 'cgm'])('every target the registry offers for .%s is one a real file above converts to', (extension) => {
    const advertised = getFormatByExtension(extension)?.targetFormats ?? [];
    const converted = new Set(SAMPLES.filter((sample) => sample.extension === extension).flatMap((sample) => sample.targets));
    expect([...advertised].sort()).toEqual([...converted].sort());
  });
});

describe('DWF, which has no reader in the worker', () => {
  it('a real .dwf file is refused with the reason for every target the registry offers', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'tika-testdwf2010.dwf');
    for (const target of getFormatByExtension('dwf')?.targetFormats ?? []) {
      const failure = await dispatchConversion(bytes, 'dwf', target, {}, 'testDWF2010.dwf').catch((error: unknown) => error);
      expect(failure, `dwf -> ${target}`).toBeInstanceOf(CadGeometryUnavailableError);
      expect((failure as Error).message, `dwf -> ${target}`).toMatch(/no reader of DWF 6 \(W2D\) or DWFx files is included in the worker/);
    }
  });
});
