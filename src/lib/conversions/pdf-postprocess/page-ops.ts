import fs from 'node:fs';
import path from 'node:path';
import {
  InvalidPageRangeError,
  PdfPostprocessError,
  UnsupportedOptionError,
  type PdfReorderOptions,
  type PdfRotateOptions,
  type PdfRotation,
  type PdfRotationDegrees,
  type PdfSplitOptions,
} from '../../types';
import { SandboxedBufferLimitError } from '../../security/process-sandbox';
import { createZipArchive } from '../archive';
import { assertPdfHeader } from '../pdf-text-document';
import { openPdfForEditing, type PdfAccess, type PdfEditOperation } from '../pdf-access';
import { validatePageRangeSyntax } from '../page-range';
import { QPDF_COMPACT_OUTPUT_ARGS, runQpdf, runQpdfToBuffer, withQpdfInputFile, withQpdfWorkspace, type QpdfWorkspace } from './qpdf-run';

/**
 * Structural PDF operations, each one qpdf run on the document (qpdf copies pages as objects, so bookmarks, links,
 * forms and tagged structure of the kept pages survive; nothing is rendered or re-encoded): split, extract, delete,
 * reorder and rotate.
 *
 * A page specification is the grammar of the `pages` option: `3`, `2-5`, `4-` (to the last page), `-3` (the first
 * three), comma separated. Every operation goes through the same gate as every other PDF edit (see pdf-access): an
 * encrypted input is refused or decrypted first, and the result is written without encryption.
 */

/** Longest page specification, in characters. */
const MAX_PAGE_SPEC_CHARS = 8192;
/** Most digits of a page number; a longer number is no page of any document. */
const MAX_PAGE_DIGITS = 9;
/** Most parts one split may produce (the extractor of the ZIP the parts come back in refuses more entries than this). */
export const MAX_SPLIT_PARTS = 1000;
/** Parts written at the same time when a split runs one qpdf per range. */
const SPLIT_CONCURRENCY = 4;
const SPLIT_PART_PREFIX = 'part';
const SPLIT_OUTPUT_TEMPLATE = `${SPLIT_PART_PREFIX}-%d.pdf`;
/** Parts are stored in the ZIP, not deflated: a PDF is already compressed. */
const ZIP_STORE_LEVEL = 0;
const MIN_PART_DIGITS = 3;

/** The parts of one split may total this much, or this multiple of the input if that is more: every part repeats the resources its pages share. */
const SPLIT_MIN_OUTPUT_BYTES = 256 * 1024 * 1024;
const SPLIT_OUTPUT_SIZE_FACTOR = 8;
const SPLIT_WATCH_INTERVAL_MS = 50;

const ROTATIONS: ReadonlySet<number> = new Set([90, 180, 270]);

function assertPageSpec(spec: unknown, name: string): string {
  if (typeof spec !== 'string' || spec.trim() === '') {
    throw new InvalidPageRangeError(`Option "${name}" must be a page specification such as "1-3,5".`);
  }
  if (spec.length > MAX_PAGE_SPEC_CHARS) {
    throw new InvalidPageRangeError(`Option "${name}" is longer than ${MAX_PAGE_SPEC_CHARS} characters.`);
  }
  validatePageRangeSyntax(spec);
  return spec;
}

function pageNumberOf(text: string): string {
  if (text.length > MAX_PAGE_DIGITS) {
    throw new InvalidPageRangeError(`Page number ${text} is no page of any document.`);
  }
  return String(Number.parseInt(text, 10));
}

/** One range token of the page grammar in qpdf's: `N`, `N-M`, `N-` becomes `N-z`, `-M` becomes `1-M`. */
function qpdfRangeOf(token: string): string {
  const [start, end] = token.split('-');
  if (!token.includes('-')) return pageNumberOf(token);
  if (start === '') return `1-${pageNumberOf(end)}`;
  if (end === '') return `${pageNumberOf(start)}-z`;
  return `${pageNumberOf(start)}-${pageNumberOf(end)}`;
}

/** The tokens of a validated page specification, trimmed. */
function tokensOf(spec: string): string[] {
  return spec.split(',').map((token) => token.trim());
}

/** A validated page specification as one qpdf page range (`1-3,5,7-z`). */
function toQpdfRange(spec: string, name: string): string {
  return tokensOf(assertPageSpec(spec, name)).map(qpdfRangeOf).join(',');
}

async function editablePdf(pdf: Buffer, operation: PdfEditOperation, access: PdfAccess): Promise<Buffer> {
  if (!pdf || pdf.length === 0) {
    throw new PdfPostprocessError('PDF buffer is empty.');
  }
  assertPdfHeader(pdf);
  return openPdfForEditing(pdf, operation, access);
}

function pagesSelection(range: string): string[] {
  return ['--pages', '.', range, '--'];
}

/**
 * The pages of `spec`, in the order the specification lists them. A page listed twice appears twice.
 * @throws InvalidPageRangeError for an invalid specification or a page the document does not have.
 */
export async function extractPdfPages(pdf: Buffer, spec: string, access: PdfAccess = {}): Promise<Buffer> {
  const range = toQpdfRange(spec, 'pages');
  const plain = await editablePdf(pdf, 'extract', access);
  return withQpdfInputFile(plain, (workspace) =>
    runQpdfToBuffer(workspace, { args: [...QPDF_COMPACT_OUTPUT_ARGS, workspace.inputPath, ...pagesSelection(range), '-'], action: 'Extracting the pages' })
  );
}

/** A group larger than any document: `--split-pages` with it writes the selection as one file, and none when the selection is empty. */
const WHOLE_DOCUMENT_GROUP = 100_000_000;
const DELETE_OUTPUT_TEMPLATE = 'result-%d.pdf';

/**
 * The document without the pages of `spec`.
 *
 * qpdf writes the pages that remain; written through `--split-pages` with a group larger than any document, it writes
 * nothing when no page remains, which tells an emptied document from a result without a second run to count pages.
 *
 * @throws InvalidPageRangeError for an invalid specification or a page the document does not have.
 * @throws PdfPostprocessError when the specification names every page: a PDF with no page is no result.
 */
export async function deletePdfPages(pdf: Buffer, spec: string, access: PdfAccess = {}): Promise<Buffer> {
  const excluded = tokensOf(assertPageSpec(spec, 'pages')).map((token) => `x${qpdfRangeOf(token)}`);
  const selection = pagesSelection(['1-z', ...excluded].join(','));
  const plain = await editablePdf(pdf, 'delete', access);
  return withQpdfWorkspace(plain, async (workspace) => {
    const action = 'Deleting the pages';
    await runQpdf(workspace, {
      args: [...QPDF_COMPACT_OUTPUT_ARGS, `--split-pages=${WHOLE_DOCUMENT_GROUP}`, workspace.inputPath, ...selection, DELETE_OUTPUT_TEMPLATE],
      action,
    });
    const written = fs.readdirSync(workspace.dir).filter((name) => name.startsWith('result-'));
    if (written.length !== 1) {
      throw new PdfPostprocessError('Deleting the pages failed: the specification names every page, and a PDF needs at least one.');
    }
    return fs.readFileSync(path.join(workspace.dir, written[0]));
  });
}

interface PageToken {
  start: number;
  /** Infinity for an open range (`4-`), which runs to the last page. */
  end: number;
}

function pageTokenOf(token: string): PageToken {
  if (!token.includes('-')) {
    const page = Number.parseInt(pageNumberOf(token), 10);
    return { start: page, end: page };
  }
  const [start, end] = token.split('-');
  return {
    start: start === '' ? 1 : Number.parseInt(pageNumberOf(start), 10),
    end: end === '' ? Number.POSITIVE_INFINITY : Number.parseInt(pageNumberOf(end), 10),
  };
}

/** A page two listed tokens both name is listed twice, which is a copy of the page and no reordering. */
function assertNoRepeatedPage(tokens: readonly string[]): void {
  const listed = tokens.map(pageTokenOf);
  for (const [index, token] of listed.entries()) {
    const clash = listed.slice(index + 1).find((other) => token.start <= other.end && other.start <= token.end);
    if (clash) {
      throw new InvalidPageRangeError(`The page order lists page ${Math.max(token.start, clash.start)} twice.`);
    }
  }
}

/**
 * The document with the pages of `options.order` first, in the order written, and every page it does not list after
 * them in their original order: no page is lost by a reordering. A full order (every page once) is the usual request.
 * @throws InvalidPageRangeError when a page is listed twice or is not in the document.
 */
export async function reorderPdfPages(pdf: Buffer, options: PdfReorderOptions, access: PdfAccess = {}): Promise<Buffer> {
  const spec = assertPageSpec(options?.order, 'reorder.order');
  const tokens = tokensOf(spec);
  assertNoRepeatedPage(tokens);
  const qpdfTokens = tokens.map(qpdfRangeOf);
  // qpdf's `x` takes the pages it names out of the range group before it: the rest of the document, minus what was listed.
  const range = [...qpdfTokens, '1-z', ...qpdfTokens.map((token) => `x${token}`)].join(',');
  const plain = await editablePdf(pdf, 'reorder', access);
  return withQpdfInputFile(plain, (workspace) =>
    runQpdfToBuffer(workspace, { args: [...QPDF_COMPACT_OUTPUT_ARGS, workspace.inputPath, ...pagesSelection(range), '-'], action: 'Reordering the pages' })
  );
}

function normalizedRotation(value: unknown): PdfRotationDegrees {
  const degrees = typeof value === 'string' && /^\+?\d+$/.test(value.trim()) ? Number.parseInt(value, 10) : value;
  if (typeof degrees !== 'number' || !ROTATIONS.has(degrees)) {
    throw new UnsupportedOptionError('The rotation must be 90, 180 or 270 degrees clockwise.');
  }
  return degrees as PdfRotationDegrees;
}

/** The rotations a request names: one `rotation` with optional `pages`, or a list of them, never both. */
function rotationGroups(options: PdfRotateOptions): PdfRotation[] {
  const listed = options?.rotations;
  if (listed !== undefined) {
    if (options.rotation !== undefined || options.pages !== undefined) {
      throw new UnsupportedOptionError('Give either "rotation" with optional "pages", or "rotations", not both.');
    }
    if (!Array.isArray(listed) || listed.length === 0) {
      throw new UnsupportedOptionError('"rotations" must be a non-empty list of { pages, rotation }.');
    }
    return listed;
  }
  if (options?.rotation === undefined) {
    throw new UnsupportedOptionError('Rotating needs "rotation" (90, 180 or 270) or a list of "rotations".');
  }
  return [{ rotation: options.rotation, pages: options.pages }];
}

/**
 * Turns pages clockwise. `rotation` applies to `pages` (every page when omitted); `rotations` turns several groups of
 * pages by different amounts, and a page in two groups turns by both.
 * @throws UnsupportedOptionError for a rotation other than 90, 180 and 270.
 * @throws InvalidPageRangeError for an invalid specification or a page the document does not have.
 */
export async function rotatePdfPages(pdf: Buffer, options: PdfRotateOptions, access: PdfAccess = {}): Promise<Buffer> {
  const args = rotationGroups(options).map((group) => {
    const degrees = normalizedRotation(group.rotation);
    return group.pages === undefined ? `--rotate=+${degrees}` : `--rotate=+${degrees}:${toQpdfRange(group.pages, 'rotate.pages')}`;
  });
  const plain = await editablePdf(pdf, 'rotate', access);
  return withQpdfInputFile(plain, (workspace) =>
    runQpdfToBuffer(workspace, { args: [...QPDF_COMPACT_OUTPUT_ARGS, ...args, workspace.inputPath, '-'], action: 'Rotating the pages' })
  );
}

/** The parts of a split by `ranges`: the range written for each part. */
function splitRangesOf(options: PdfSplitOptions): string[] {
  const ranges = tokensOf(assertPageSpec(options.ranges, 'split.ranges'));
  if (ranges.length > MAX_SPLIT_PARTS) {
    throw new UnsupportedOptionError(`A split writes at most ${MAX_SPLIT_PARTS} parts; "split.ranges" lists ${ranges.length}.`);
  }
  return ranges;
}

function splitEvery(options: PdfSplitOptions): number {
  const every = options.everyNPages;
  if (typeof every !== 'number' || !Number.isInteger(every) || every < 1) {
    throw new UnsupportedOptionError('"split.everyNPages" must be a whole number of pages, at least 1.');
  }
  return every;
}

/** Entry name of part `index` (from 1) of `count` parts: `<name>-part001.pdf`, padded to the width of the last. */
function partName(baseName: string, index: number, count: number): string {
  const width = Math.max(MIN_PART_DIGITS, String(count).length);
  return `${baseName}-part${String(index).padStart(width, '0')}.pdf`;
}

function partNumberOf(name: string): number {
  const digits = /^part-(\d+)/.exec(name)?.[1];
  return digits === undefined ? Number.NaN : Number.parseInt(digits, 10);
}

/** Size of the parts in `dir` together. */
function directoryBytes(dir: string): number {
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(SPLIT_PART_PREFIX))
    .reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0);
}

/** Runs `run` and aborts it when the files it writes into `dir` pass `budget` bytes together. */
async function withDirectoryBudget(dir: string, budget: number, run: (signal: AbortSignal) => Promise<unknown>): Promise<void> {
  const controller = new AbortController();
  const watch = setInterval(() => {
    try {
      if (directoryBytes(dir) > budget) controller.abort(new SandboxedBufferLimitError(budget));
    } catch {
      // A part that vanishes between listing and measuring is not an overrun.
    }
  }, SPLIT_WATCH_INTERVAL_MS);
  try {
    await run(controller.signal);
  } finally {
    clearInterval(watch);
  }
}

async function splitFiles(workspace: QpdfWorkspace, options: PdfSplitOptions, budget: number): Promise<Buffer[]> {
  const action = 'Splitting the PDF';
  if (options.ranges !== undefined) {
    if (options.everyNPages !== undefined) {
      throw new UnsupportedOptionError('Give either "split.ranges" or "split.everyNPages", not both.');
    }
    const ranges = splitRangesOf(options).map(qpdfRangeOf);
    const parts: Buffer[] = [];
    let total = 0;
    for (let from = 0; from < ranges.length; from += SPLIT_CONCURRENCY) {
      const batch = await Promise.all(
        ranges
          .slice(from, from + SPLIT_CONCURRENCY)
          .map((range) => runQpdfToBuffer(workspace, { args: [...QPDF_COMPACT_OUTPUT_ARGS, workspace.inputPath, ...pagesSelection(range), '-'], action }))
      );
      for (const part of batch) total += part.length;
      if (total > budget) throw new PdfPostprocessError(`${action} failed: the parts exceed the allowed size; split into fewer pages.`);
      parts.push(...batch);
    }
    return parts;
  }
  const every = options.everyNPages === undefined ? 1 : splitEvery(options);
  await withDirectoryBudget(workspace.dir, budget, (signal) =>
    runQpdf(workspace, { args: [...QPDF_COMPACT_OUTPUT_ARGS, `--split-pages=${every}`, workspace.inputPath, SPLIT_OUTPUT_TEMPLATE], action, signal })
  );
  const names = fs
    .readdirSync(workspace.dir)
    .filter((name) => name.startsWith(SPLIT_PART_PREFIX))
    .sort((a, b) => partNumberOf(a) - partNumberOf(b));
  return names.map((name) => fs.readFileSync(path.join(workspace.dir, name)));
}

/**
 * Cuts the document into parts and returns them as one ZIP (`<name>-part001.pdf`, ...). With `ranges` each comma
 * separated range is a part; with `everyNPages` each run of that many pages is; with neither, every page is.
 * @throws UnsupportedOptionError when both `ranges` and `everyNPages` are given, or the split would write more than
 *   MAX_SPLIT_PARTS parts.
 * @throws InvalidPageRangeError for an invalid range or a page the document does not have.
 */
export async function splitPdfPages(
  pdf: Buffer,
  options: PdfSplitOptions = {},
  access: PdfAccess = {},
  baseName = 'document'
): Promise<Buffer> {
  const split = options ?? {};
  // Validated before the document is opened, so a wrong request costs no decryption.
  if (split.ranges !== undefined) splitRangesOf(split);
  if (split.everyNPages !== undefined) splitEvery(split);
  const plain = await editablePdf(pdf, 'split', access);
  const budget = Math.max(SPLIT_MIN_OUTPUT_BYTES, plain.length * SPLIT_OUTPUT_SIZE_FACTOR);
  const parts = await withQpdfWorkspace(plain, (workspace) => splitFiles(workspace, split, budget));
  if (parts.length === 0) {
    throw new PdfPostprocessError('Splitting the PDF failed: qpdf wrote no part.');
  }
  if (parts.length > MAX_SPLIT_PARTS) {
    throw new UnsupportedOptionError(`A split writes at most ${MAX_SPLIT_PARTS} parts; this one would write ${parts.length}.`);
  }
  const zip = await createZipArchive(
    parts.map((buffer, index) => ({ filename: partName(baseName, index + 1, parts.length), buffer })),
    { compressionLevel: ZIP_STORE_LEVEL }
  );
  return zip.buffer;
}
