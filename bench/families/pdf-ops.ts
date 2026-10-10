import fs from 'node:fs';
import path from 'node:path';
import { convertWithProject } from '../convert';
import { importProduct } from '../product';
import { REPO_ROOT } from '../config';
import type { FamilyContext, FamilyRunner } from '../context';
import { OutputIntegrityError, ToolRunError } from '../errors';
import { measureSsimPsnr } from '../measure';
import { type GrayRaster, lineAngleDifference, measureInk, type InkMeasure, parsePgm } from '../pdf-ink';
import { buildStampPdf } from '../pdf-stamp';
import type { BenchRow } from '../report';
import { measuredRow, type MetricSpec, skippedGroup, skippedRow, SPEC, throughputRow } from '../rows';
import { wordF1 } from '../text-metrics';
import { runTool } from '../tools';

/**
 * PDF operations of the product, each against qpdf and checked with tools that share no code with it:
 *  - merge (the workflow merge node): three PDFs into one, against `qpdf --empty --pages`;
 *  - watermark (the pdf.watermark node and the `watermark` option of a PDF output): a text stamp on pages 2 and 3 of three,
 *    against `qpdf --overlay` of a stamp PDF written in bench/pdf-stamp.ts;
 *  - protect (the pdf.protect node): AES-256 encryption with a user and an owner password, against `qpdf --encrypt`;
 *  - decrypt (the password option of every PDF source): a decrypted copy, against `qpdf --decrypt`.
 * The product has no split, rotate or compress operation, so those cases are listed as unsupported rather than measured.
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

const FIXTURE_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'pdf-text');
const MERGE_SOURCES = ['latin', 'multipage', 'two-column'] as const;
const SINGLE_SOURCE = 'multipage';
const FAMILY = 'pdf-ops';
const MERGE_CASE = 'merge.pdf->pdf';
const WATERMARK_CASE = 'watermark.pdf->pdf';
const PROTECT_CASE = 'protect.pdf->pdf';
const DECRYPT_CASE = 'decrypt.pdf->pdf';
const UNSUPPORTED_CASES = [
  { name: 'split.pdf->pdf', reason: 'the product has no PDF split operation: a page range selects pages of a conversion to text or images, and a PDF output keeps every page' },
  { name: 'rotate.pdf->pdf', reason: 'the product has no PDF rotate operation: the orientation option sets the page shape of a PDF written from text, not the rotation of an existing page' },
  { name: 'compress.pdf->pdf', reason: 'the product has no PDF compress operation: a PDF to PDF conversion returns the document unchanged' },
] as const;
const REFERENCE_TOOL = 'qpdf';

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

function qualityRows(caseName: string, ours: OutputScore, reference: OutputScore, extra: BenchRow[]): BenchRow[] {
  return [
    measuredRow(FAMILY, caseName, SPEC.pdfCheckFailures, ours.checkFailures, reference.checkFailures, REFERENCE_TOOL),
    measuredRow(FAMILY, caseName, SPEC.pageCountError, ours.pageCountError, reference.pageCountError, REFERENCE_TOOL),
    measuredRow(FAMILY, caseName, SPEC.wordF1, ours.textF1, reference.textF1, REFERENCE_TOOL),
    ...extra,
    measuredRow(FAMILY, caseName, SPEC.bytes, ours.bytes, reference.bytes, REFERENCE_TOOL),
  ];
}

function timeBoth(ctx: FamilyContext, ours: () => Promise<unknown>, reference: () => unknown): ReturnType<FamilyContext['time']> {
  return ctx.time(
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

  // Resolved at every call: a timed run of ours may be on the head or on the base of the change (bench/product.ts).
  const mergeOurs = async (): Promise<Buffer> => {
    const { mergePdfBuffers } = await importProduct<typeof import('../../src/lib/jobs/artifact-helpers')>('lib/jobs/artifact-helpers');
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
    const timing = await timeBoth(ctx, mergeOurs, mergeReference);
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

  const oursOptions = { watermark: { text: WATERMARK_TEXT, fontSize: WATERMARK_FONT_SIZE, rotation: WATERMARK_ROTATION, opacity: WATERMARK_OPACITY, position: 'center' as const, pages: WATERMARK_PAGES } };
  const watermarkOurs = async (): Promise<Buffer> => (await convertWithProject(input.bytes, 'pdf', 'pdf', oursOptions, `${SINGLE_SOURCE}.pdf`)).buffer;
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
    rows.push(throughputRow(FAMILY, WATERMARK_CASE, input.bytes.length, await timeBoth(ctx, watermarkOurs, watermarkReference), REFERENCE_TOOL));
  }
  return rows;
}

async function runProtect(ctx: FamilyContext, tools: PdfTools): Promise<BenchRow[]> {
  const input = source(SINGLE_SOURCE);
  const truth = pageTexts(tools, input.file, pageCount(tools, input.file));
  const protectOurs = async (): Promise<Buffer> => {
    const { protectPdf } = await importProduct<typeof import('../../src/lib/conversions/pdf-postprocess/protect')>('lib/conversions/pdf-postprocess/protect');
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
    rows.push(throughputRow(FAMILY, PROTECT_CASE, input.bytes.length, await timeBoth(ctx, protectOurs, protectReference), REFERENCE_TOOL));
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
    const { withDecryptedPdf } = await importProduct<typeof import('../../src/worker/pdf-decrypt')>('worker/pdf-decrypt');
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
    rows.push(throughputRow(FAMILY, DECRYPT_CASE, encryptedSize, await timeBoth(ctx, decryptOurs, decryptReference), REFERENCE_TOOL));
  }
  return rows;
}

export const runPdfOps: FamilyRunner = async (ctx) => {
  const rows: BenchRow[] = [];
  const cases = [
    { name: MERGE_CASE, specs: MERGE_SPECS, run: runMerge },
    { name: WATERMARK_CASE, specs: WATERMARK_SPECS, run: runWatermark },
    { name: PROTECT_CASE, specs: ENCRYPTION_SPECS, run: runProtect },
    { name: DECRYPT_CASE, specs: ENCRYPTION_SPECS, run: runDecrypt },
  ].filter((item) => ctx.inScope(FAMILY, item.name));
  if (cases.length > 0) {
    const plan = ctx.plan(['qpdf', 'pdftotext', 'pdftoppm', 'pdfinfo', 'ffmpeg'], FAMILY);
    if (!plan.ok) {
      for (const item of cases) rows.push(...skippedGroup(FAMILY, item.name, item.specs, REFERENCE_TOOL, plan));
    } else {
      const tools = plan.paths as unknown as PdfTools;
      for (const item of cases) {
        ctx.log(`pdf-ops ${item.name}`);
        rows.push(...(await item.run(ctx, tools)));
      }
    }
  }
  for (const item of UNSUPPORTED_CASES) {
    if (!ctx.inScope(FAMILY, item.name)) continue;
    if (ctx.quality) rows.push(skippedRow(FAMILY, item.name, SPEC.pdfCheckFailures, REFERENCE_TOOL, 'unsupported', item.reason));
    if (ctx.speed) rows.push(skippedRow(FAMILY, item.name, SPEC.throughput, REFERENCE_TOOL, 'unsupported', item.reason));
  }
  return rows;
};
