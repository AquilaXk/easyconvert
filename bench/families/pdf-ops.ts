import fs from 'node:fs';
import path from 'node:path';
import { importProduct } from '../product';
import { REPO_ROOT } from '../config';
import type { FamilyContext, FamilyRunner } from '../context';
import { OutputIntegrityError, ToolRunError } from '../errors';
import { measureSsimPsnr } from '../measure';
import { type GrayRaster, lineAngleDifference, measureInk, type InkMeasure, parsePgm } from '../pdf-ink';
import { buildPhotoPdf } from '../pdf-photo';
import { buildStampPdf } from '../pdf-stamp';
import type { BenchRow } from '../report';
import { measuredRow, type MetricSpec, skippedGroup, SPEC, throughputRow, speedRowId } from '../rows';
import { wordF1 } from '../text-metrics';
import { runTool } from '../tools';

/**
 * PDF operations of the product, each against qpdf and checked with tools that share no code with it:
 *  - merge (the workflow merge node): three PDFs into one, against `qpdf --empty --pages`;
 *  - watermark (the pdf.watermark node and the `watermark` option of a PDF output): a text stamp on pages 2 and 3 of three,
 *    against `qpdf --overlay` of a stamp PDF written in bench/pdf-stamp.ts;
 *  - protect (the pdf.protect node): AES-256 encryption with a user and an owner password, against `qpdf --encrypt`;
 *  - decrypt (the password option of every PDF source): a decrypted copy, against `qpdf --decrypt`;
 *  - unlock (the pdf.unlock node): the user-password copy of a PDF whose owner forbids modifying and copying, with the
 *    request confirming the right to edit, against `qpdf --decrypt`. The input is checked with `qpdf --show-encryption`
 *    to carry the restrictions under both passwords, and the copy unlocked with the owner password, with no
 *    confirmation, must report as the reference's does.
 *  - split (the pdf.split-pages node): one file per page as a ZIP, against `qpdf --split-pages=1`;
 *  - extract, delete and reorder pages (the pdf.extract-pages, pdf.delete-pages and pdf.reorder-pages nodes), against
 *    `qpdf --pages`;
 *  - rotate (the pdf.rotate-pages node): pages 2 and 3 turned 90 degrees, against `qpdf --rotate`; the rotation of every
 *    page is read back with `pdfinfo`;
 *  - compress (the optimize node on a PDF, profile `web`): a PDF with a photograph on every page, against Ghostscript's
 *    pdfwrite `/ebook` preset. The result must be no larger than the reference's, render as close to the source, and keep
 *    the text of every page.
 *
 * Per output: `qpdf --check` passes, the page count equals the expected one, the text of every page read by `pdftotext`
 * matches the text of the same page of the source (word F1, so a wrong page order or a lost page scores low), and the
 * rendered pages (`pdftoppm`, SSIM by ffmpeg) equal the source pages where the operation leaves them alone. The watermark's
 * appearance is compared with the reference render page by page. Output bytes are reported, and the end-to-end time is
 * timed interleaved with the reference.
 *
 * The sources are the committed PDF text goldens (tests/fixtures/pdf-text, written by LibreOffice from sources of this
 * repository, as the document family uses them).
 */

/**
 * A module of the product, resolved on the first call and reused after it: the timed calls measure the operation, not the
 * resolution of its module. A version of the product without the module fails the closure that calls it (the row is then
 * measured against the reference alone), not the whole runner.
 */
function lazyModule<T>(relative: string): () => Promise<T> {
  let loaded: Promise<T> | undefined;
  return () => (loaded ??= importProduct<T>(relative));
}

const artifactHelpers = lazyModule<typeof import('../../src/lib/jobs/artifact-helpers')>('lib/jobs/artifact-helpers');
const watermarkModule = lazyModule<typeof import('../../src/lib/conversions/pdf-postprocess/watermark')>('lib/conversions/pdf-postprocess/watermark');
const protectModule = lazyModule<typeof import('../../src/lib/conversions/pdf-postprocess/protect')>('lib/conversions/pdf-postprocess/protect');
const decryptModule = lazyModule<typeof import('../../src/worker/pdf-decrypt')>('worker/pdf-decrypt');
const unlockModule = lazyModule<typeof import('../../src/lib/conversions/pdf-postprocess/unlock')>('lib/conversions/pdf-postprocess/unlock');
const pageOpsModule = lazyModule<typeof import('../../src/lib/conversions/pdf-postprocess/page-ops')>('lib/conversions/pdf-postprocess/page-ops');
const compressModule = lazyModule<typeof import('../../src/lib/conversions/pdf-postprocess/compress')>('lib/conversions/pdf-postprocess/compress');

const FIXTURE_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'pdf-text');
const MERGE_SOURCES = ['latin', 'multipage', 'two-column'] as const;
const SINGLE_SOURCE = 'multipage';
const FAMILY = 'pdf-ops';
const MERGE_CASE = 'merge.pdf->pdf';
const WATERMARK_CASE = 'watermark.pdf->pdf';
const PROTECT_CASE = 'protect.pdf->pdf';
const DECRYPT_CASE = 'decrypt.pdf->pdf';
const UNLOCK_CASE = 'unlock.pdf->pdf';
const SPLIT_CASE = 'split.pdf->pdf';
const EXTRACT_CASE = 'extract.pdf->pdf';
const DELETE_CASE = 'delete.pdf->pdf';
const REORDER_CASE = 'reorder.pdf->pdf';
const ROTATE_CASE = 'rotate.pdf->pdf';
const COMPRESS_CASE = 'compress.pdf->pdf';
const REFERENCE_TOOL = 'qpdf';
const GHOSTSCRIPT_TOOL = 'ghostscript';

const MERGE_SPECS: readonly MetricSpec[] = [SPEC.pdfCheckFailures, SPEC.pageCountError, SPEC.wordF1, SPEC.ssim, SPEC.bytes, SPEC.throughput];
const WATERMARK_SPECS: readonly MetricSpec[] = [SPEC.pdfCheckFailures, SPEC.pageCountError, SPEC.wordF1, SPEC.ssim, SPEC.stampInkMatchesReference, SPEC.stampGeometryMatchesSpec, SPEC.renderMatchesReference, SPEC.bytes, SPEC.throughput];
const ENCRYPTION_SPECS: readonly MetricSpec[] = [SPEC.pdfCheckFailures, SPEC.pageCountError, SPEC.wordF1, SPEC.encryptionMatchesReference, SPEC.bytes, SPEC.throughput];

/** How qpdf is asked to write the files a user keeps: compressed streams and the objects packed into object streams, its smallest ordinary output. */
const COMPACT_OUTPUT = ['--object-streams=generate', '--compress-streams=y'] as const;

const USER_PASSWORD = 'bench-user-secret';
const OWNER_PASSWORD = 'bench-owner-secret';
const AES_256_KEY_BITS = 256;
const RENDER_DPI = '72';

const WATERMARK_TEXT = 'DRAFT COPY';
const WATERMARK_FONT_SIZE = 48;
const WATERMARK_ROTATION = -45;
const WATERMARK_OPACITY = 0.3;
const WATERMARK_GREY = 0.5;
/** Pages the watermark covers (the page range option), as the range string and as page numbers; the rest must stay as the source. */
const WATERMARK_PAGES = '2-3';
const WATERMARK_PAGE_NUMBERS: ReadonlySet<number> = new Set([2, 3]);
/** Resolution of the renders the stamp is measured on, in dots per inch. */
const INK_DPI = 144;
/**
 * The stamp's darkness: the brightness it removes from the page, summed over the page, may differ from the reference
 * stamp's by this share. The two are drawn by different code in the same font, size and opacity, so they agree within
 * a few percent; a stamp with 0.5, 2/3 or 1.5 times the opacity differs by 50, 33 or 50 percent.
 */
const STAMP_INK_TOLERANCE = 0.1;
/** The ink box of the stamp must be centred on the page within this many points along and across its text, and run at the requested angle within this many degrees. */
const STAMP_CENTRE_TOLERANCE_POINTS = 2;
const STAMP_ANGLE_TOLERANCE_DEGREES = 2;
/**
 * SSIM, over the central square, at or above which our watermark render counts as the reference render. The two stamps
 * are set in the same font, size, angle, opacity and centring by different code. The text is thin and faint on a white
 * page, so the whole page would score 0.98 with no stamp at all; in the central square a missing stamp scores 0.92.
 */
const WATERMARK_MATCH_FLOOR = 0.97;
/** The stamp is compared in a square at the page centre of this share of the shorter page side; the rotated text spans about 0.3 of the page width. */
const WATERMARK_CROP_SHARE = 0.5;

const PNG_WIDTH_OFFSET = 16;
const PNG_HEIGHT_OFFSET = 20;
const PAGE_SIZE_PATTERN = /Page size:\s+([0-9.]+) x ([0-9.]+) pts/;
const PAGE_FILE_PATTERN = /-(\d+)\.png$/;

interface PdfTools {
  qpdf: string;
  pdftotext: string;
  pdftoppm: string;
  pdfinfo: string;
  ffmpeg: string;
}

interface OutputScore {
  checkFailures: number;
  pageCountError: number;
  textF1: number;
  bytes: number;
}

/** Runs a reference tool that may legitimately refuse a document; only its own failure is absorbed. */
function attempt(action: () => Buffer): Buffer | null {
  try {
    return action();
  } catch (error) {
    if (error instanceof ToolRunError) return null;
    throw error;
  }
}

const passwordArgs = (flag: string, password: string | undefined): string[] => (password === undefined ? [] : [`${flag}${password}`]);

function pageCount(tools: PdfTools, file: string, password?: string): number {
  const out = attempt(() => runTool(tools.qpdf, [...passwordArgs('--password=', password), '--show-npages', file]).stdout);
  return out === null ? 0 : Number.parseInt(out.toString('utf8').trim(), 10) || 0;
}

function pageText(tools: PdfTools, file: string, page: number, password?: string): string {
  const out = attempt(() =>
    runTool(tools.pdftotext, [...(password === undefined ? [] : ['-upw', password]), '-f', String(page), '-l', String(page), '-enc', 'UTF-8', file, '-']).stdout
  );
  return out === null ? '' : out.toString('utf8');
}

function pageTexts(tools: PdfTools, file: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => pageText(tools, file, index + 1));
}

interface CropBox {
  x: number;
  y: number;
  size: number;
}

/** The pages of `file` as gray PNGs at 72 dpi (one pixel per point), in page order; `crop` keeps only that square of each page. */
function renderPages(tools: PdfTools, file: string, dir: string, crop?: CropBox): string[] {
  fs.mkdirSync(dir, { recursive: true });
  const window = crop ? ['-x', String(crop.x), '-y', String(crop.y), '-W', String(crop.size), '-H', String(crop.size)] : [];
  attempt(() => runTool(tools.pdftoppm, ['-r', RENDER_DPI, '-gray', '-png', ...window, file, path.join(dir, 'p')]).stdout);
  const pageNumber = (name: string): number => Number(PAGE_FILE_PATTERN.exec(name)?.[1] ?? 0);
  return fs
    .readdirSync(dir)
    .filter((name) => PAGE_FILE_PATTERN.test(name))
    .sort((a, b) => pageNumber(a) - pageNumber(b))
    .map((name) => path.join(dir, name));
}

/** The pages of `file` as 8-bit gray rasters at INK_DPI, in page order. */
function renderRasters(tools: PdfTools, file: string, dir: string): GrayRaster[] {
  fs.mkdirSync(dir, { recursive: true });
  attempt(() => runTool(tools.pdftoppm, ['-r', String(INK_DPI), '-gray', file, path.join(dir, 'p')]).stdout);
  const pageNumber = (name: string): number => Number(/-(\d+)\.pgm$/.exec(name)?.[1] ?? 0);
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.pgm'))
    .sort((a, b) => pageNumber(a) - pageNumber(b))
    .map((name) => parsePgm(fs.readFileSync(path.join(dir, name))));
}

/** Whether the ink of one stamped page sits where the spec puts a stamp: centred on the page, along the requested angle. */
function stampGeometryHolds(ink: InkMeasure): boolean {
  return (
    ink.inkPixels > 0 &&
    Math.abs(ink.centreAlong) <= STAMP_CENTRE_TOLERANCE_POINTS &&
    Math.abs(ink.centreAcross) <= STAMP_CENTRE_TOLERANCE_POINTS &&
    lineAngleDifference(ink.principalAngleDegrees, WATERMARK_ROTATION) <= STAMP_ANGLE_TOLERANCE_DEGREES
  );
}

function pngSize(file: string): string {
  const head = fs.readFileSync(file).subarray(0, PNG_HEIGHT_OFFSET + 4);
  return `${head.readUInt32BE(PNG_WIDTH_OFFSET)}x${head.readUInt32BE(PNG_HEIGHT_OFFSET)}`;
}

/** SSIM of each page against the expected one; a missing page, or one of another size, scores 0. */
function pageSsims(tools: PdfTools, actual: string[], expected: string[]): number[] {
  return expected.map((file, index) => {
    const page = actual[index];
    if (page === undefined || pngSize(page) !== pngSize(file)) return 0;
    return measureSsimPsnr(tools.ffmpeg, page, file).ssim;
  });
}

const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

function scoreOutput(tools: PdfTools, file: string, truth: string[], password?: string): OutputScore {
  const checked = attempt(() => runTool(tools.qpdf, [...passwordArgs('--password=', password), '--check', file]).stdout);
  const count = pageCount(tools, file, password);
  const scores = truth.map((expected, index) => wordF1(expected, pageText(tools, file, index + 1, password)));
  return {
    checkFailures: checked === null ? 1 : 0,
    pageCountError: Math.abs(count - truth.length),
    textF1: mean(scores),
    bytes: fs.statSync(file).size,
  };
}

function qualityRows(caseName: string, ours: OutputScore, reference: OutputScore, extra: BenchRow[], referenceTool = REFERENCE_TOOL): BenchRow[] {
  return [
    measuredRow(FAMILY, caseName, SPEC.pdfCheckFailures, ours.checkFailures, reference.checkFailures, referenceTool),
    measuredRow(FAMILY, caseName, SPEC.pageCountError, ours.pageCountError, reference.pageCountError, referenceTool),
    measuredRow(FAMILY, caseName, SPEC.wordF1, ours.textF1, reference.textF1, referenceTool),
    ...extra,
    measuredRow(FAMILY, caseName, SPEC.bytes, ours.bytes, reference.bytes, referenceTool),
  ];
}

function timeBoth(ctx: FamilyContext, rowId: string, ours: () => Promise<unknown>, reference: () => unknown): ReturnType<FamilyContext['time']> {
  return ctx.time(
    rowId,
    async () => {
      await ours();
    },
    () => {
      reference();
    },
    'light'
  );
}

function source(name: string): { file: string; bytes: Buffer } {
  const file = path.join(FIXTURE_DIR, `${name}.pdf`);
  return { file, bytes: fs.readFileSync(file) };
}

/** What qpdf prints about the encryption of a document under a password (an unaccepted password is part of the text). */
function encryptionReport(tools: PdfTools, file: string, password?: string): string {
  const run = runTool(tools.qpdf, [...passwordArgs('--password=', password), '--show-encryption', file]);
  return `${run.stdout.toString('utf8')}${run.stderr}`;
}

/**
 * What the requested protection (AES-256, print allowed, no modification, no extraction) must report, whoever wrote the
 * file: the user password opens it with exactly these rights and the owner password is the owner password.
 */
const PROTECTION_RIGHTS = [
  'R = 6',
  'extract for any purpose: not allowed',
  'print low resolution: allowed',
  'print high resolution: allowed',
  'modify anything: not allowed',
  'stream encryption method: AESv3',
  'string encryption method: AESv3',
  'file encryption method: AESv3',
] as const;

function reportHolds(report: string, password: 'user' | 'owner'): boolean {
  const lines = new Set(report.split('\n').map((line) => line.trim()));
  return [...PROTECTION_RIGHTS, `Supplied password is ${password} password`].every((line) => lines.has(line));
}

/** Both passwords are honoured with the requested rights; true for a file that reports as the spec says under each. */
function protectionHolds(tools: PdfTools, file: string): boolean {
  return reportHolds(encryptionReport(tools, file, USER_PASSWORD), 'user') && reportHolds(encryptionReport(tools, file, OWNER_PASSWORD), 'owner');
}

function encryptWithReference(tools: PdfTools, input: string, output: string): void {
  runTool(tools.qpdf, ['--encrypt', USER_PASSWORD, OWNER_PASSWORD, String(AES_256_KEY_BITS), '--print=full', '--modify=none', '--extract=n', '--', input, output]);
}

async function runMerge(ctx: FamilyContext, tools: PdfTools): Promise<BenchRow[]> {
  const inputs = MERGE_SOURCES.map(source);
  const sourceDir = ctx.scratch('merge-source');
  const truth = inputs.flatMap((input) => pageTexts(tools, input.file, pageCount(tools, input.file)));
  const sourcePages = inputs.flatMap((input, index) => renderPages(tools, input.file, path.join(sourceDir, String(index))));

  // Resolved at every call: the product is the one of the checkout this process measures (bench/product.ts).
  const mergeOurs = async (): Promise<Buffer> => {
    const { mergePdfBuffers } = await artifactHelpers();
    return mergePdfBuffers(inputs.map((input) => input.bytes));
  };
  const oursFile = ctx.scratch('merge-ours.pdf');
  fs.writeFileSync(oursFile, await mergeOurs());
  const referenceFile = ctx.scratch('merge-reference.pdf');
  const mergeReference = (): void => {
    runTool(tools.qpdf, [...COMPACT_OUTPUT, '--empty', '--pages', ...inputs.map((input) => input.file), '--', referenceFile]);
  };
  mergeReference();

  const rows: BenchRow[] = [];
  if (ctx.quality) {
    const ssim = (file: string, name: string): number => mean(pageSsims(tools, renderPages(tools, file, ctx.scratch(name)), sourcePages));
    rows.push(
      ...qualityRows(MERGE_CASE, scoreOutput(tools, oursFile, truth), scoreOutput(tools, referenceFile, truth), [
        measuredRow(FAMILY, MERGE_CASE, SPEC.ssim, ssim(oursFile, 'merge-ours-pages'), ssim(referenceFile, 'merge-reference-pages'), REFERENCE_TOOL),
      ])
    );
  }
  if (ctx.speed) {
    const timing = await timeBoth(ctx, speedRowId(FAMILY, MERGE_CASE), mergeOurs, mergeReference);
    rows.push(throughputRow(FAMILY, MERGE_CASE, inputs.reduce((sum, input) => sum + input.bytes.length, 0), timing, REFERENCE_TOOL));
  }
  return rows;
}

async function runWatermark(ctx: FamilyContext, tools: PdfTools): Promise<BenchRow[]> {
  const input = source(SINGLE_SOURCE);
  const sourceCount = pageCount(tools, input.file);
  const sourceText = pageTexts(tools, input.file, sourceCount);
  const sourcePages = renderPages(tools, input.file, ctx.scratch('watermark-source'));
  const truth = sourceText.map((text, index) => (WATERMARK_PAGE_NUMBERS.has(index + 1) ? `${text}\n${WATERMARK_TEXT}` : text));
  const untouched = sourcePages.map((_, index) => index).filter((index) => !WATERMARK_PAGE_NUMBERS.has(index + 1));
  if (untouched.length === 0) throw new OutputIntegrityError('the watermark case needs a page the watermark leaves alone');

  // The operation of the pdf.watermark node, as the protect and unlock rows time the code of their nodes. (A PDF to PDF
  // conversion with the watermark option first reads the document's text to decide whether it needs OCR, which is not
  // part of watermarking.)
  const oursOptions = { text: WATERMARK_TEXT, fontSize: WATERMARK_FONT_SIZE, rotation: WATERMARK_ROTATION, opacity: WATERMARK_OPACITY, position: 'center' as const, pages: WATERMARK_PAGES };
  const watermarkOurs = async (): Promise<Buffer> => {
    const { applyPdfWatermark } = await watermarkModule();
    return applyPdfWatermark(input.bytes, oursOptions);
  };
  const oursFile = ctx.scratch('watermark-ours.pdf');
  fs.writeFileSync(oursFile, await watermarkOurs());

  const size = PAGE_SIZE_PATTERN.exec(runTool(tools.pdfinfo, [input.file]).stdout.toString('utf8'));
  if (!size) throw new OutputIntegrityError('pdfinfo printed no page size');
  const stampFile = ctx.scratch('watermark-stamp.pdf');
  fs.writeFileSync(
    stampFile,
    buildStampPdf({ text: WATERMARK_TEXT, fontSize: WATERMARK_FONT_SIZE, rotationDegrees: WATERMARK_ROTATION, opacity: WATERMARK_OPACITY, grey: WATERMARK_GREY, pageWidth: Number(size[1]), pageHeight: Number(size[2]) })
  );
  const pageWidth = Number(size[1]);
  const pageHeight = Number(size[2]);
  const cropSize = Math.floor(Math.min(pageWidth, pageHeight) * WATERMARK_CROP_SHARE);
  const crop = { x: Math.floor((pageWidth - cropSize) / 2), y: Math.floor((pageHeight - cropSize) / 2), size: cropSize };
  const referenceFile = ctx.scratch('watermark-reference.pdf');
  const watermarkReference = (): void => {
    runTool(tools.qpdf, [...COMPACT_OUTPUT, input.file, '--overlay', stampFile, `--to=${WATERMARK_PAGES}`, '--repeat=1', '--', referenceFile]);
  };
  watermarkReference();

  const rows: BenchRow[] = [];
  if (ctx.quality) {
    const oursPages = renderPages(tools, oursFile, ctx.scratch('watermark-ours-pages'));
    const referencePages = renderPages(tools, referenceFile, ctx.scratch('watermark-reference-pages'));
    const unchangedSsim = (pages: string[]): number => mean(pageSsims(tools, pages, sourcePages).filter((_, index) => untouched.includes(index)));
    const againstReference = pageSsims(tools, renderPages(tools, oursFile, ctx.scratch('watermark-ours-crop'), crop), renderPages(tools, referenceFile, ctx.scratch('watermark-reference-crop'), crop));
    ctx.log(`watermark render SSIM against the reference, central square, per page: ${againstReference.map((value) => value.toFixed(4)).join(', ')} (floor ${WATERMARK_MATCH_FLOOR})`);
    const sourceRasters = renderRasters(tools, input.file, ctx.scratch('watermark-source-gray'));
    const oursRasters = renderRasters(tools, oursFile, ctx.scratch('watermark-ours-gray'));
    const referenceRasters = renderRasters(tools, referenceFile, ctx.scratch('watermark-reference-gray'));
    const stampedIndexes = sourceRasters.map((_, index) => index).filter((index) => WATERMARK_PAGE_NUMBERS.has(index + 1));
    const inkOf = (rasters: GrayRaster[]): InkMeasure[] => stampedIndexes.map((index) => measureInk(rasters[index], sourceRasters[index], INK_DPI, WATERMARK_ROTATION));
    const oursInk = oursRasters.length === sourceCount ? inkOf(oursRasters) : [];
    const referenceInk = referenceRasters.length === sourceCount ? inkOf(referenceRasters) : [];
    const describeInk = (ink: InkMeasure[]): string => ink.map((one) => `mass ${one.mass.toFixed(1)} centre ${one.centreAlong.toFixed(2)}/${one.centreAcross.toFixed(2)} angle ${one.principalAngleDegrees.toFixed(2)}`).join('; ');
    ctx.log(`watermark ink per stamped page, ours: ${describeInk(oursInk)}`);
    ctx.log(`watermark ink per stamped page, reference: ${describeInk(referenceInk)}`);
    const inkMatches =
      oursInk.length === stampedIndexes.length &&
      referenceInk.length === stampedIndexes.length &&
      oursInk.every((ink, index) => ink.inkPixels > 0 && Math.abs(ink.mass / referenceInk[index].mass - 1) <= STAMP_INK_TOLERANCE);
    const geometryHolds = (ink: InkMeasure[]): number => (ink.length === stampedIndexes.length && ink.every(stampGeometryHolds) ? 1 : 0);
    rows.push(
      ...qualityRows(WATERMARK_CASE, scoreOutput(tools, oursFile, truth), scoreOutput(tools, referenceFile, truth), [
        measuredRow(FAMILY, WATERMARK_CASE, SPEC.ssim, unchangedSsim(oursPages), unchangedSsim(referencePages), REFERENCE_TOOL),
        measuredRow(FAMILY, WATERMARK_CASE, SPEC.stampInkMatchesReference, inkMatches ? 1 : 0, 1, REFERENCE_TOOL),
        measuredRow(FAMILY, WATERMARK_CASE, SPEC.stampGeometryMatchesSpec, geometryHolds(oursInk), geometryHolds(referenceInk), REFERENCE_TOOL),
        measuredRow(FAMILY, WATERMARK_CASE, SPEC.renderMatchesReference, againstReference.length === sourceCount && Math.min(...againstReference) >= WATERMARK_MATCH_FLOOR ? 1 : 0, 1, REFERENCE_TOOL),
      ])
    );
  }
  if (ctx.speed) {
    rows.push(throughputRow(FAMILY, WATERMARK_CASE, input.bytes.length, await timeBoth(ctx, speedRowId(FAMILY, WATERMARK_CASE), watermarkOurs, watermarkReference), REFERENCE_TOOL));
  }
  return rows;
}

async function runProtect(ctx: FamilyContext, tools: PdfTools): Promise<BenchRow[]> {
  const input = source(SINGLE_SOURCE);
  const truth = pageTexts(tools, input.file, pageCount(tools, input.file));
  const protectOurs = async (): Promise<Buffer> => {
    const { protectPdf } = await protectModule();
    return protectPdf(input.bytes, { userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD, keyLength: AES_256_KEY_BITS });
  };
  const oursFile = ctx.scratch('protect-ours.pdf');
  fs.writeFileSync(oursFile, await protectOurs());
  const referenceFile = ctx.scratch('protect-reference.pdf');
  const protectReference = (): void => encryptWithReference(tools, input.file, referenceFile);
  protectReference();

  const rows: BenchRow[] = [];
  if (ctx.quality) {
    // Under each password the report equals the reference's, and it is the spec's: a file that ignores the owner password or grants the user more differs on both counts.
    const reportsEqual = [USER_PASSWORD, OWNER_PASSWORD].every((password) => encryptionReport(tools, oursFile, password) === encryptionReport(tools, referenceFile, password));
    const same = reportsEqual && protectionHolds(tools, oursFile) ? 1 : 0;
    rows.push(
      ...qualityRows(PROTECT_CASE, scoreOutput(tools, oursFile, truth, USER_PASSWORD), scoreOutput(tools, referenceFile, truth, USER_PASSWORD), [
        measuredRow(FAMILY, PROTECT_CASE, SPEC.encryptionMatchesReference, same, protectionHolds(tools, referenceFile) ? 1 : 0, REFERENCE_TOOL),
      ])
    );
  }
  if (ctx.speed) {
    rows.push(throughputRow(FAMILY, PROTECT_CASE, input.bytes.length, await timeBoth(ctx, speedRowId(FAMILY, PROTECT_CASE), protectOurs, protectReference), REFERENCE_TOOL));
  }
  return rows;
}

async function runDecrypt(ctx: FamilyContext, tools: PdfTools): Promise<BenchRow[]> {
  const plain = source(SINGLE_SOURCE);
  const truth = pageTexts(tools, plain.file, pageCount(tools, plain.file));
  const encryptedFile = ctx.scratch('decrypt-input.pdf');
  encryptWithReference(tools, plain.file, encryptedFile);
  const encryptedSize = fs.statSync(encryptedFile).size;

  const tempDir = ctx.scratch('decrypt-temp');
  fs.mkdirSync(tempDir);
  const decryptOurs = async (): Promise<Buffer> => {
    const { withDecryptedPdf } = await decryptModule();
    return withDecryptedPdf({ inputPath: encryptedFile, tempDir, password: USER_PASSWORD, timeoutMs: 60_000 }, (readable) => Promise.resolve(fs.readFileSync(readable)));
  };
  const oursFile = ctx.scratch('decrypt-ours.pdf');
  fs.writeFileSync(oursFile, await decryptOurs());
  const referenceFile = ctx.scratch('decrypt-reference.pdf');
  const decryptReference = (): void => {
    runTool(tools.qpdf, [`--password=${USER_PASSWORD}`, '--decrypt', encryptedFile, referenceFile]);
  };
  decryptReference();

  const rows: BenchRow[] = [];
  if (ctx.quality) {
    const decrypted = (file: string): boolean => encryptionReport(tools, file).trim() === 'File is not encrypted';
    const same = encryptionReport(tools, oursFile) === encryptionReport(tools, referenceFile) && decrypted(oursFile) ? 1 : 0;
    rows.push(
      ...qualityRows(DECRYPT_CASE, scoreOutput(tools, oursFile, truth), scoreOutput(tools, referenceFile, truth), [
        measuredRow(FAMILY, DECRYPT_CASE, SPEC.encryptionMatchesReference, same, decrypted(referenceFile) ? 1 : 0, REFERENCE_TOOL),
      ])
    );
  }
  if (ctx.speed) {
    rows.push(throughputRow(FAMILY, DECRYPT_CASE, encryptedSize, await timeBoth(ctx, speedRowId(FAMILY, DECRYPT_CASE), decryptOurs, decryptReference), REFERENCE_TOOL));
  }
  return rows;
}

async function runUnlock(ctx: FamilyContext, tools: PdfTools): Promise<BenchRow[]> {
  const plain = source(SINGLE_SOURCE);
  const truth = pageTexts(tools, plain.file, pageCount(tools, plain.file));
  const encryptedFile = ctx.scratch('unlock-input.pdf');
  encryptWithReference(tools, plain.file, encryptedFile);
  const encrypted = fs.readFileSync(encryptedFile);

  const { unlockPdf } = await unlockModule();
  const unlockOurs = (): Promise<Buffer> => unlockPdf(encrypted, { password: USER_PASSWORD, confirmEditRights: true });
  const oursFile = ctx.scratch('unlock-ours.pdf');
  fs.writeFileSync(oursFile, await unlockOurs());
  const ownerFile = ctx.scratch('unlock-owner.pdf');
  fs.writeFileSync(ownerFile, await unlockPdf(encrypted, { password: OWNER_PASSWORD }));
  const referenceFile = ctx.scratch('unlock-reference.pdf');
  const unlockReference = (): void => {
    runTool(tools.qpdf, [`--password=${USER_PASSWORD}`, '--decrypt', encryptedFile, referenceFile]);
  };
  unlockReference();

  const rows: BenchRow[] = [];
  if (ctx.quality) {
    const unlocked = (file: string): boolean => encryptionReport(tools, file).trim() === 'File is not encrypted';
    const referenceReport = encryptionReport(tools, referenceFile);
    const same =
      encryptionReport(tools, oursFile) === referenceReport && encryptionReport(tools, ownerFile) === referenceReport && unlocked(oursFile) ? 1 : 0;
    const expected = unlocked(referenceFile) && protectionHolds(tools, encryptedFile) ? 1 : 0;
    rows.push(
      ...qualityRows(UNLOCK_CASE, scoreOutput(tools, oursFile, truth), scoreOutput(tools, referenceFile, truth), [
        measuredRow(FAMILY, UNLOCK_CASE, SPEC.encryptionMatchesReference, same, expected, REFERENCE_TOOL),
      ])
    );
  }
  if (ctx.speed) {
    rows.push(throughputRow(FAMILY, UNLOCK_CASE, encrypted.length, await timeBoth(ctx, speedRowId(FAMILY, UNLOCK_CASE), unlockOurs, unlockReference), REFERENCE_TOOL));
  }
  return rows;
}

type PageOps = typeof import('../../src/lib/conversions/pdf-postprocess/page-ops');

const PAGE_OP_SPECS: readonly MetricSpec[] = [SPEC.pdfCheckFailures, SPEC.pageCountError, SPEC.wordF1, SPEC.ssim, SPEC.bytes];
const ROTATE_SPECS: readonly MetricSpec[] = [SPEC.pdfCheckFailures, SPEC.pageCountError, SPEC.wordF1, SPEC.rotationErrors, SPEC.renderMatchesReference, SPEC.bytes];
const SPLIT_SPECS: readonly MetricSpec[] = [SPEC.pdfCheckFailures, SPEC.pageCountError, SPEC.wordF1, SPEC.ssim, SPEC.bytes];
const COMPRESS_SPECS: readonly MetricSpec[] = [SPEC.pdfCheckFailures, SPEC.pageCountError, SPEC.wordF1, SPEC.ssim, SPEC.bytes];

/** Pages of the source (1-based) the page operations keep, in the order they must come out. */
const EXTRACT_PAGES = '3,1';
const EXTRACT_EXPECTED = [3, 1] as const;
const DELETE_PAGES = '2';
const DELETE_EXPECTED = [1, 3] as const;
const REORDER_ORDER = '3,1,2';
const REORDER_EXPECTED = [3, 1, 2] as const;
const ROTATE_PAGES = '2-3';
const ROTATE_DEGREES = 90;
const ROTATED_PAGE_NUMBERS: ReadonlySet<number> = new Set([2, 3]);
/** SSIM of a rendered page of ours against the same page of the reference at or above which the two render alike. */
const ROTATE_MATCH_FLOOR = 0.999;

const GHOSTSCRIPT_REFERENCE_ARGS = ['-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=pdfwrite', '-dPDFSETTINGS=/ebook'] as const;
const PHOTO_PAGE_COUNT = 3;
const PHOTO_PAGE_WIDTH = 612;
const PHOTO_PAGE_HEIGHT = 792;
/** Widths of the photograph on its pages in points; at 768 pixels each is above 250 dpi, so the 150 dpi preset downsamples. */
const PHOTO_WIDTHS_POINTS = [180, 200, 220] as const;

interface SourceFacts {
  file: string;
  bytes: Buffer;
  texts: string[];
  /** The source pages rendered at 72 dpi. */
  pages: string[];
}

function sourceFacts(ctx: FamilyContext, tools: PdfTools, label: string): SourceFacts {
  const input = source(SINGLE_SOURCE);
  return {
    file: input.file,
    bytes: input.bytes,
    texts: pageTexts(tools, input.file, pageCount(tools, input.file)),
    pages: renderPages(tools, input.file, ctx.scratch(`${label}-source`)),
  };
}

/** Mean SSIM of the pages of `file` against the source pages that should have come out in their place. */
function orderedSsim(ctx: FamilyContext, tools: PdfTools, file: string, label: string, sourcePages: string[], expected: readonly number[]): number {
  const rendered = renderPages(tools, file, ctx.scratch(label));
  return mean(pageSsims(tools, rendered, expected.map((page) => sourcePages[page - 1])));
}

/** Extract, delete and reorder: pages of the source in a new selection or order, against `qpdf --pages`. */
async function runPageSelection(
  ctx: FamilyContext,
  tools: PdfTools,
  caseName: string,
  expected: readonly number[],
  oursOf: (ops: PageOps, bytes: Buffer) => Promise<Buffer>,
  selection: string
): Promise<BenchRow[]> {
  const facts = sourceFacts(ctx, tools, caseName);
  const truth = expected.map((page) => facts.texts[page - 1]);
  const ours = async (): Promise<Buffer> => oursOf(await pageOpsModule(), facts.bytes);
  const referenceFile = ctx.scratch(`${caseName}-reference.pdf`);
  const reference = (): void => {
    runTool(tools.qpdf, [...COMPACT_OUTPUT, facts.file, '--pages', '.', selection, '--', referenceFile]);
  };
  const rows: BenchRow[] = [];
  if (ctx.quality) {
    const oursFile = ctx.scratch(`${caseName}-ours.pdf`);
    fs.writeFileSync(oursFile, await ours());
    reference();
    rows.push(
      ...qualityRows(caseName, scoreOutput(tools, oursFile, truth), scoreOutput(tools, referenceFile, truth), [
        measuredRow(FAMILY, caseName, SPEC.ssim, orderedSsim(ctx, tools, oursFile, `${caseName}-ours-pages`, facts.pages, expected), orderedSsim(ctx, tools, referenceFile, `${caseName}-reference-pages`, facts.pages, expected), REFERENCE_TOOL),
      ])
    );
  }
  return rows;
}

const runExtract = (ctx: FamilyContext, tools: PdfTools): Promise<BenchRow[]> =>
  runPageSelection(ctx, tools, EXTRACT_CASE, EXTRACT_EXPECTED, (ops, bytes) => ops.extractPdfPages(bytes, EXTRACT_PAGES), EXTRACT_PAGES);

/** qpdf spells "every page but 2" as the whole range minus it. */
const runDelete = (ctx: FamilyContext, tools: PdfTools): Promise<BenchRow[]> =>
  runPageSelection(ctx, tools, DELETE_CASE, DELETE_EXPECTED, (ops, bytes) => ops.deletePdfPages(bytes, DELETE_PAGES), `1-z,x${DELETE_PAGES}`);

const runReorder = (ctx: FamilyContext, tools: PdfTools): Promise<BenchRow[]> =>
  runPageSelection(ctx, tools, REORDER_CASE, REORDER_EXPECTED, (ops, bytes) => ops.reorderPdfPages(bytes, { order: REORDER_ORDER }), REORDER_ORDER);

/** The rotation of each page of `file` as `pdfinfo` reports it. */
function pageRotations(tools: PdfTools, file: string, count: number): number[] {
  const out = attempt(() => runTool(tools.pdfinfo, ['-f', '1', '-l', String(count), file]).stdout);
  if (out === null) return [];
  return [...out.toString('utf8').matchAll(/Page\s+\d+ rot:\s+(\d+)/g)].map((match) => Number.parseInt(match[1], 10));
}

async function runRotate(ctx: FamilyContext, tools: PdfTools): Promise<BenchRow[]> {
  const facts = sourceFacts(ctx, tools, ROTATE_CASE);
  const ours = async (): Promise<Buffer> => (await pageOpsModule()).rotatePdfPages(facts.bytes, { rotation: ROTATE_DEGREES, pages: ROTATE_PAGES });
  const referenceFile = ctx.scratch('rotate-reference.pdf');
  const reference = (): void => {
    runTool(tools.qpdf, [...COMPACT_OUTPUT, `--rotate=+${ROTATE_DEGREES}:${ROTATE_PAGES}`, facts.file, '--', referenceFile]);
  };
  const rows: BenchRow[] = [];
  if (ctx.quality) {
    const oursFile = ctx.scratch('rotate-ours.pdf');
    fs.writeFileSync(oursFile, await ours());
    reference();
    const count = facts.texts.length;
    const expectedRotations = facts.texts.map((_, index) => (ROTATED_PAGE_NUMBERS.has(index + 1) ? ROTATE_DEGREES : 0));
    const rotationErrors = (file: string): number => {
      const actual = pageRotations(tools, file, count);
      return actual.length !== count ? count : actual.filter((degrees, index) => degrees !== expectedRotations[index]).length;
    };
    const againstReference = pageSsims(tools, renderPages(tools, oursFile, ctx.scratch('rotate-ours-pages')), renderPages(tools, referenceFile, ctx.scratch('rotate-reference-pages')));
    ctx.log(`rotate render SSIM against the reference, per page: ${againstReference.map((value) => value.toFixed(4)).join(', ')} (floor ${ROTATE_MATCH_FLOOR})`);
    rows.push(
      ...qualityRows(ROTATE_CASE, scoreOutput(tools, oursFile, facts.texts), scoreOutput(tools, referenceFile, facts.texts), [
        measuredRow(FAMILY, ROTATE_CASE, SPEC.rotationErrors, rotationErrors(oursFile), rotationErrors(referenceFile), REFERENCE_TOOL),
        measuredRow(FAMILY, ROTATE_CASE, SPEC.renderMatchesReference, againstReference.length === count && Math.min(...againstReference) >= ROTATE_MATCH_FLOOR ? 1 : 0, 1, REFERENCE_TOOL),
      ])
    );
  }
  return rows;
}

/** Aggregate of a set of output files (the parts of a split): failures and page-count errors add up, text is the mean, bytes add up. */
function scoreParts(tools: PdfTools, files: string[], truth: string[][]): OutputScore {
  const scores = truth.map((pages, index) => (files[index] === undefined ? null : scoreOutput(tools, files[index], pages)));
  const present = scores.filter((score): score is OutputScore => score !== null);
  const missing = truth.length - present.length;
  return {
    checkFailures: present.reduce((sum, score) => sum + score.checkFailures, 0) + missing + Math.max(0, files.length - truth.length),
    pageCountError: present.reduce((sum, score) => sum + score.pageCountError, 0) + missing + Math.max(0, files.length - truth.length),
    textF1: scores.reduce((sum, score) => sum + (score?.textF1 ?? 0), 0) / truth.length,
    bytes: present.reduce((sum, score) => sum + score.bytes, 0),
  };
}

async function runSplit(ctx: FamilyContext, tools: PdfTools): Promise<BenchRow[]> {
  const facts = sourceFacts(ctx, tools, SPLIT_CASE);
  const ours = async (): Promise<Buffer> => (await pageOpsModule()).splitPdfPages(facts.bytes, {}, {}, SINGLE_SOURCE);
  const referenceDir = ctx.scratch('split-reference');
  fs.mkdirSync(referenceDir);
  const reference = (): void => {
    runTool(tools.qpdf, [...COMPACT_OUTPUT, '--split-pages=1', facts.file, path.join(referenceDir, 'part-%d.pdf')]);
  };
  const rows: BenchRow[] = [];
  if (ctx.quality) {
    const { default: JSZip } = await import('jszip');
    const archive = await JSZip.loadAsync(await ours());
    const oursDir = ctx.scratch('split-ours');
    fs.mkdirSync(oursDir);
    const oursFiles: string[] = [];
    for (const name of Object.keys(archive.files).sort((a, b) => a.localeCompare(b))) {
      const file = path.join(oursDir, name);
      fs.writeFileSync(file, await archive.files[name].async('nodebuffer')); // NOSONAR S9382 sequential
      oursFiles.push(file);
    }
    reference();
    const referenceFiles = fs.readdirSync(referenceDir).sort((a, b) => a.localeCompare(b)).map((name) => path.join(referenceDir, name));
    const truth = facts.texts.map((text) => [text]);
    const partsSsim = (files: string[], label: string): number =>
      mean(files.map((file, index) => (facts.pages[index] === undefined ? 0 : (pageSsims(tools, renderPages(tools, file, ctx.scratch(`${label}-${index}`)), [facts.pages[index]])[0] ?? 0))));
    rows.push(
      ...qualityRows(SPLIT_CASE, scoreParts(tools, oursFiles, truth), scoreParts(tools, referenceFiles, truth), [
        measuredRow(FAMILY, SPLIT_CASE, SPEC.ssim, partsSsim(oursFiles, 'split-ours-pages'), partsSsim(referenceFiles, 'split-reference-pages'), REFERENCE_TOOL),
      ])
    );
  }
  return rows;
}

async function runCompress(ctx: FamilyContext, tools: PdfTools & { gs: string }): Promise<BenchRow[]> {
  const photo = fs.readFileSync(path.join(REPO_ROOT, 'bench', 'corpus', 'photo-a.jpg'));
  const input = buildPhotoPdf({
    jpeg: photo,
    pageWidth: PHOTO_PAGE_WIDTH,
    pageHeight: PHOTO_PAGE_HEIGHT,
    pages: PHOTO_WIDTHS_POINTS.slice(0, PHOTO_PAGE_COUNT).map((width, index) => ({ text: `Photograph page ${index + 1} of ${PHOTO_PAGE_COUNT}`, photoWidthPoints: width })),
  });
  const inputFile = ctx.scratch('compress-input.pdf');
  fs.writeFileSync(inputFile, input);
  const ours = async (): Promise<Buffer> => {
    const { compressPdf } = await compressModule();
    return (await compressPdf(input, { profile: 'web' })).buffer;
  };
  const referenceFile = ctx.scratch('compress-reference.pdf');
  const reference = (): void => {
    runTool(tools.gs, [...GHOSTSCRIPT_REFERENCE_ARGS, `-sOutputFile=${referenceFile}`, inputFile]);
  };
  const rows: BenchRow[] = [];
  if (ctx.quality) {
    const count = pageCount(tools, inputFile);
    const truth = pageTexts(tools, inputFile, count);
    const sourcePages = renderPages(tools, inputFile, ctx.scratch('compress-source'));
    const oursFile = ctx.scratch('compress-ours.pdf');
    fs.writeFileSync(oursFile, await ours());
    reference();
    const ssim = (file: string, label: string): number => mean(pageSsims(tools, renderPages(tools, file, ctx.scratch(label)), sourcePages));
    rows.push(
      ...qualityRows(
        COMPRESS_CASE,
        scoreOutput(tools, oursFile, truth),
        scoreOutput(tools, referenceFile, truth),
        [measuredRow(FAMILY, COMPRESS_CASE, SPEC.ssim, ssim(oursFile, 'compress-ours-pages'), ssim(referenceFile, 'compress-reference-pages'), GHOSTSCRIPT_TOOL)],
        GHOSTSCRIPT_TOOL
      )
    );
  }
  return rows;
}

interface PdfOpsCase {
  name: string;
  specs: readonly MetricSpec[];
  /** Tools beyond those every case needs. */
  extraTools?: readonly string[];
  /** The case has quality rows only, so a speed-only run leaves it out. */
  qualityOnly?: boolean;
  run: (ctx: FamilyContext, tools: PdfTools & { gs: string }) => Promise<BenchRow[]>;
}

const COMMON_TOOLS = ['qpdf', 'pdftotext', 'pdftoppm', 'pdfinfo', 'ffmpeg'] as const;

export const runPdfOps: FamilyRunner = async (ctx) => {
  const rows: BenchRow[] = [];
  const cases: PdfOpsCase[] = [
    { name: MERGE_CASE, specs: MERGE_SPECS, run: runMerge },
    { name: WATERMARK_CASE, specs: WATERMARK_SPECS, run: runWatermark },
    { name: PROTECT_CASE, specs: ENCRYPTION_SPECS, run: runProtect },
    { name: DECRYPT_CASE, specs: ENCRYPTION_SPECS, run: runDecrypt },
    { name: UNLOCK_CASE, specs: ENCRYPTION_SPECS, run: runUnlock },
    // The page operations come last. They have quality rows only for now: their speed rows are added with the gap entries
    // that the CI runner's measurement calls for (bench/parity-gaps.json), in a change that touches the bench alone.
    { name: SPLIT_CASE, specs: SPLIT_SPECS, qualityOnly: true, run: runSplit },
    { name: EXTRACT_CASE, specs: PAGE_OP_SPECS, qualityOnly: true, run: runExtract },
    { name: DELETE_CASE, specs: PAGE_OP_SPECS, qualityOnly: true, run: runDelete },
    { name: REORDER_CASE, specs: PAGE_OP_SPECS, qualityOnly: true, run: runReorder },
    { name: ROTATE_CASE, specs: ROTATE_SPECS, qualityOnly: true, run: runRotate },
    { name: COMPRESS_CASE, specs: COMPRESS_SPECS, extraTools: ['gs'], qualityOnly: true, run: runCompress },
  ].filter((item) => ctx.inScope(FAMILY, item.name) && (ctx.quality || item.qualityOnly !== true));
  for (const item of cases) {
    const plan = ctx.plan([...COMMON_TOOLS, ...(item.extraTools ?? [])], FAMILY);
    if (!plan.ok) {
      rows.push(...skippedGroup(FAMILY, item.name, item.specs, item.extraTools ? GHOSTSCRIPT_TOOL : REFERENCE_TOOL, plan));
      continue;
    }
    ctx.log(`pdf-ops ${item.name}`);
    rows.push(...(await item.run(ctx, plan.paths as unknown as PdfTools & { gs: string }))); // NOSONAR S9382 sequential
  }
  return rows;
};
