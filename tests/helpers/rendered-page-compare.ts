import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { expect } from 'vitest';
import { requireOracleTool } from './differential-oracle';
import { identifyImage, ocrText } from './office-pair-fixtures';
import { sofficeConvert } from './soffice-office';

/**
 * Compares the page images a converter renders with the reference render of the same input: the reference office
 * suite exports a PDF, `pdftoppm` rasterises it page by page at the resolution of the output under test, and ffmpeg's
 * `ssim` filter scores each page pair. Text is read from the vector stage (`pdftotext` on the reference PDF), not from
 * OCR, so the expected words do not depend on how a font rasterises. Every tool here is independent of the converter.
 *
 * Measured noise floor (macOS arm64, LibreOffice and poppler from Homebrew): the reference rendered twice from separate
 * soffice runs, and the converter's pages against the reference, both score SSIM 1.000000 for PNG and JPEG. The
 * converter and the reference run the same suite and rasteriser on the same host and fonts, so a platform's font choice
 * moves both sides alike. Pages that must be told apart score lower: another slide of the same deck 0.994 (slides are
 * mostly white), a blank page 0.899, and a page at another resolution fails the exact dimension check. MIN_PAGE_SSIM sits
 * between the noise floor and a blank page; the "own page beats every other page" rule covers the white-on-white gap.
 */

export const RENDER_DPI = 150;
/** Lowest SSIM (grey, 0..1) of an output page against its reference page. */
export const MIN_PAGE_SSIM = 0.998;
/** Least gap by which a page must resemble its own reference page more than any other reference page. */
export const MIN_SSIM_MARGIN = 0.0005;
/** Lowest share of the authored words OCR must read back from a page; a lenient check, an OCR slip is not a defect. */
export const MIN_OCR_WORD_RECALL = 0.6;

const TOOL_TIMEOUT_MS = 120_000;
const MAX_TOOL_OUTPUT = 64 * 1024 * 1024;
const PDFTOTEXT_PAGE_BREAK = '\f';

export type PageFormat = 'png' | 'jpg';

export interface ReferenceRender {
  pdf: Buffer;
  /** Page images at the requested resolution, in page order. */
  pages: Buffer[];
  /** Text of each page as `pdftotext` extracts it from the vector stage. */
  pageTexts: string[];
}

const referenceCache = new Map<string, ReferenceRender>();

function withTempDir<T>(prefix: string, run: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function pdfPageTexts(pdfFile: string): string[] {
  const text = execFileSync(requireOracleTool('pdftotext'), [pdfFile, '-'], {
    encoding: 'utf-8',
    maxBuffer: MAX_TOOL_OUTPUT,
    timeout: TOOL_TIMEOUT_MS,
  });
  const pages = text.split(PDFTOTEXT_PAGE_BREAK);
  if (pages.at(-1)?.trim() === '') pages.pop();
  return pages;
}

function rasterisePdf(pdfFile: string, dir: string, format: PageFormat, dpi: number): Buffer[] {
  execFileSync(requireOracleTool('pdftoppm'), ['-r', String(dpi), format === 'png' ? '-png' : '-jpeg', pdfFile, path.join(dir, 'page')], {
    timeout: TOOL_TIMEOUT_MS,
    stdio: 'ignore',
  });
  const extension = format === 'png' ? '.png' : '.jpg';
  // pdftoppm zero-pads the page number to the width of the page count, so a plain sort is page order.
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith('page-') && name.endsWith(extension))
    .sort()
    .map((name) => fs.readFileSync(path.join(dir, name)));
}

/**
 * The reference render of `input` (a file of `extension` the reference office suite opens): its PDF, the PDF's pages
 * as `format` images at `dpi`, and the text of each page. Memoised on the input bytes, the format and the resolution.
 */
export function renderReferencePages(input: Buffer, extension: string, format: PageFormat, dpi = RENDER_DPI): ReferenceRender {
  const key = `${createHash('sha256').update(input).digest('hex')}:${extension}:${format}:${dpi}`;
  const cached = referenceCache.get(key);
  if (cached) return cached;
  const render = withTempDir('reference-render-', (dir) => {
    const pdf = sofficeConvert(input, extension, 'pdf', 'pdf');
    const pdfFile = path.join(dir, 'reference.pdf');
    fs.writeFileSync(pdfFile, pdf);
    return { pdf, pages: rasterisePdf(pdfFile, dir, format, dpi), pageTexts: pdfPageTexts(pdfFile) };
  });
  referenceCache.set(key, render);
  return render;
}

/** SSIM of two same-sized page images on their grey levels, as ffmpeg's `ssim` filter reports its `All` value. */
export function pageSsim(actual: Buffer, reference: Buffer, format: PageFormat): number {
  return withTempDir('page-ssim-', (dir) => {
    const actualFile = path.join(dir, `actual.${format}`);
    const referenceFile = path.join(dir, `reference.${format}`);
    fs.writeFileSync(actualFile, actual);
    fs.writeFileSync(referenceFile, reference);
    const run = spawnSync(
      requireOracleTool('ffmpeg'),
      [
        '-hide_banner', '-nostdin', '-i', actualFile, '-i', referenceFile,
        '-filter_complex', '[0:v]format=gray[a];[1:v]format=gray[b];[a][b]ssim', '-f', 'null', '-',
      ],
      { encoding: 'utf-8', maxBuffer: MAX_TOOL_OUTPUT, timeout: TOOL_TIMEOUT_MS }
    );
    const output = `${run.stderr ?? ''}${run.stdout ?? ''}`;
    const match = /SSIM .*All:([0-9.]+)/.exec(output);
    if (run.status !== 0 || !match) throw new Error(`ffmpeg ssim exited with ${run.status}: ${output.slice(-400)}`);
    return Number.parseFloat(match[1]);
  });
}

/** Share of `words` (case-insensitive) that occur in `text`. */
export function wordRecall(text: string, words: readonly string[]): number {
  const haystack = text.toLowerCase();
  const found = words.filter((word) => haystack.includes(word.toLowerCase()));
  return found.length / words.length;
}

/** The distinct words of authored lines, lower-cased. */
export function wordsOf(lines: readonly string[]): string[] {
  return [...new Set(lines.flatMap((line) => line.toLowerCase().split(/\s+/)).filter((word) => word.length > 0))];
}

/**
 * Asserts that rendered pages match the reference render: the same page count, the same pixel size per page, an SSIM
 * of at least MIN_PAGE_SSIM, and a closer match to their own reference page than to any other (which is what tells
 * apart the mostly-white pages of a deck whose order was shuffled).
 */
export function expectPagesMatchReference(label: string, actual: readonly Buffer[], reference: readonly Buffer[], format: PageFormat): void {
  expect(actual, `${label}: page count`).toHaveLength(reference.length);
  actual.forEach((page, index) => {
    const size = identifyImage(page, format);
    const expected = identifyImage(reference[index], format);
    expect({ width: size.width, height: size.height }, `${label}: page ${index + 1} pixel size`).toEqual({
      width: expected.width,
      height: expected.height,
    });
    const own = pageSsim(page, reference[index], format);
    expect(own, `${label}: page ${index + 1} SSIM against the reference page`).toBeGreaterThanOrEqual(MIN_PAGE_SSIM);
    reference.forEach((other, otherIndex) => {
      if (otherIndex === index) return;
      if (identifyImage(other, format).width !== size.width) return;
      expect(own - pageSsim(page, other, format), `${label}: page ${index + 1} must resemble reference page ${index + 1} more than page ${otherIndex + 1}`).toBeGreaterThanOrEqual(
        MIN_SSIM_MARGIN
      );
    });
  });
}

/** Asserts that every authored word of each page is on the same page of the reference PDF's text layer. */
export function expectWordsOnReferencePages(label: string, pageTexts: readonly string[], authored: readonly (readonly string[])[]): void {
  expect(pageTexts, `${label}: reference PDF page count`).toHaveLength(authored.length);
  authored.forEach((lines, index) => {
    const text = pageTexts[index].toLowerCase();
    for (const word of wordsOf(lines)) {
      expect(text, `${label}: reference page ${index + 1} must carry "${word}"`).toContain(word);
    }
  });
}

/** Asserts that OCR reads at least MIN_OCR_WORD_RECALL of the authored words off a rendered page. */
export function expectOcrRecall(label: string, page: Buffer, format: PageFormat, authored: readonly string[]): void {
  const recall = wordRecall(ocrText(page, format), wordsOf(authored));
  expect(recall, `${label}: share of authored words OCR reads`).toBeGreaterThanOrEqual(MIN_OCR_WORD_RECALL);
}
