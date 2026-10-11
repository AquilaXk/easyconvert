import fs from 'node:fs';
import path from 'node:path';
import type { FamilyContext } from '../context';
import { ToolRunError } from '../errors';
import { measureSsimPsnr } from '../measure';
import { PublicClassRows } from '../public-classes';
import { publicFile, publicSamples, type PublicSample } from '../public-samples';
import { publicSpeedSample } from '../public-scope';
import { attemptOurs, CONVERTS_SPEC, convertsRow, unavailableRows } from '../public-support';
import type { BenchRow } from '../report';
import { measuredRow, type MetricSpec, skippedGroup, SPEC, speedRowId, throughputRow } from '../rows';
import { wordF1 } from '../text-metrics';
import { runTool } from '../tools';
import {
  compressModule,
  COMPACT_OUTPUT,
  encryptionReport,
  GHOSTSCRIPT_REFERENCE_ARGS,
  GHOSTSCRIPT_TOOL,
  pageOpsModule,
  protectionHolds,
  protectModule,
  OWNER_PASSWORD,
  type PdfTools,
  REFERENCE_TOOL,
  unlockModule,
  USER_PASSWORD,
} from './pdf-ops';

/**
 * PDF operations on public PDF files (bench/corpus/public-manifest.json): tagged, form, encrypted, scanned, damaged, very long
 * and CJK documents from the PDF.js regression suite, the PDF/UA conformance corpus and the real-world government corpus. The
 * operations are those of the generated three-page source (extract, delete, reorder, rotate, split, compress, protect,
 * unlock), adapted to the page count of the file, each against qpdf (Ghostscript for compress) and checked by tools that share
 * no code with the product: `qpdf --check`, the page count, the text of every page against the same page of the source (one
 * `pdftotext` run per file, pages split at the form feed), and for the pages that are kept the render of up to twelve of them
 * (SSIM). A damaged file is read by qpdf's repair on both sides. A file the product refuses is a `converts` row.
 *
 * An encrypted sample has an empty user password, so every tool opens it; the operation measured on it is `unlock`, with the
 * request confirming the right to edit, against `qpdf --decrypt`, and the output must report as not encrypted.
 */

const FAMILY = 'pdf-ops';
const RENDER_DPI = '72';
const MAX_SPLIT_PAGES = 40;
const SSIM_SAMPLE_PAGES = 12;
const ROTATE_DEGREES = 90;

type Operation = 'extract' | 'delete' | 'reorder' | 'rotate' | 'split' | 'compress' | 'protect' | 'unlock';
const OPERATIONS: readonly Operation[] = ['extract', 'delete', 'reorder', 'rotate', 'split', 'compress', 'protect', 'unlock'];
const caseOf = (sample: PublicSample, operation: Operation): string => `${sample.id}->${operation}`;

const QUALITY_SPECS: readonly MetricSpec[] = [SPEC.pdfCheckFailures, SPEC.pageCountError, SPEC.wordF1, SPEC.bytes];
const OPERATION_SPECS: Readonly<Record<Operation, readonly MetricSpec[]>> = {
  extract: [...QUALITY_SPECS, SPEC.ssim],
  delete: [...QUALITY_SPECS, SPEC.ssim],
  reorder: [...QUALITY_SPECS, SPEC.ssim],
  rotate: [...QUALITY_SPECS, SPEC.rotationErrors],
  split: [...QUALITY_SPECS, SPEC.ssim],
  compress: [...QUALITY_SPECS, SPEC.ssim],
  protect: [...QUALITY_SPECS, SPEC.encryptionMatchesReference],
  unlock: [...QUALITY_SPECS, SPEC.encryptionMatchesReference],
};
const REFERENCE_OF = (operation: Operation): string => (operation === 'compress' ? GHOSTSCRIPT_TOOL : REFERENCE_TOOL);

/** The pages of a source (1-based) an operation keeps, in the order they come out; null when the file has too few pages for it. */
function expectedPages(operation: Operation, pages: number): number[] | null {
  const all = Array.from({ length: pages }, (_, index) => index + 1);
  if (operation === 'extract') return pages >= 2 ? [pages, 1] : [1];
  if (operation === 'delete') {
    if (pages < 2) return null;
    const dropped = pages >= 3 ? 2 : 1;
    return all.filter((page) => page !== dropped);
  }
  if (operation === 'reorder') return pages >= 2 ? [pages, ...all.slice(0, -1)] : null;
  return all;
}

/** Whether the operation applies to the sample at all: an encrypted file is only unlocked, a plain one is not unlocked, and a very long one is not split. */
function applies(operation: Operation, sample: PublicSample, pages: number): boolean {
  const encrypted = sample.class === 'encrypted';
  if (operation === 'unlock') return encrypted;
  if (encrypted) return false;
  if (operation === 'split') return pages <= MAX_SPLIT_PAGES;
  return expectedPages(operation, pages) !== null;
}

interface Source {
  sample: PublicSample;
  file: string;
  bytes: Buffer;
  pages: number;
  /** The text of each page, from one pdftotext run. */
  texts: string[];
}

const meanOrNull = (values: readonly number[]): number | null => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);

/** qpdf exits 3 when it read a damaged file and repaired it; the output it wrote is complete, so the reference's runs ask it to exit 0 for warnings (`qpdf --check` does not, since its warnings are the faults it counts). */
const WARNINGS_OK = '--warning-exit-0';

const attempt = <T>(action: () => T): T | null => {
  try {
    return action();
  } catch (error) {
    if (error instanceof ToolRunError) return null;
    throw error;
  }
};

/** The text of every page of a PDF from one `pdftotext` run, split at the form feed it writes after each page. */
function pageTexts(tools: PdfTools, file: string): string[] {
  const out = attempt(() => runTool(tools.pdftotext, ['-enc', 'UTF-8', file, '-']).stdout.toString('utf8'));
  if (out === null) return [];
  const pages = out.split('\f');
  if (pages[pages.length - 1].trim() === '') pages.pop();
  return pages;
}

function pageCountOf(tools: PdfTools, file: string): number {
  const out = attempt(() => runTool(tools.qpdf, [WARNINGS_OK, '--show-npages', file]).stdout);
  return out === null ? 0 : Number.parseInt(out.toString('utf8').trim(), 10) || 0;
}

interface Score {
  checkFailures: number;
  pageCountError: number;
  /** Mean word F1 over the pages that have words in the source; null when none has (a scanned document has no text to keep). */
  textF1: number | null;
  bytes: number;
}

function scoreOutput(tools: PdfTools, file: string, truth: string[]): Score {
  const checked = attempt(() => runTool(tools.qpdf, ['--check', file]).stdout);
  const texts = pageTexts(tools, file);
  const scores = truth.flatMap((expected, index) => (/[\p{L}\p{N}]/u.test(expected) ? [wordF1(expected, texts[index] ?? '')] : []));
  return {
    checkFailures: checked === null ? 1 : 0,
    pageCountError: Math.abs(pageCountOf(tools, file) - truth.length),
    textF1: scores.length === 0 ? null : scores.reduce((sum, value) => sum + value, 0) / scores.length,
    bytes: fs.statSync(file).size,
  };
}

/** Positions (0-based) of the pages whose render is compared: all of them for a short document, else the first six and the last six. */
function sampledPositions(count: number): number[] {
  if (count <= SSIM_SAMPLE_PAGES) return Array.from({ length: count }, (_, index) => index);
  const half = SSIM_SAMPLE_PAGES / 2;
  return [...Array.from({ length: half }, (_, index) => index), ...Array.from({ length: half }, (_, index) => count - half + index)];
}

function renderPage(tools: PdfTools, file: string, page: number, output: string): string | null {
  const stem = output.replace(/\.png$/, '');
  attempt(() => runTool(tools.pdftoppm, ['-r', RENDER_DPI, '-gray', '-png', '-singlefile', '-f', String(page), '-l', String(page), file, stem]));
  return fs.existsSync(output) ? output : null;
}

const pngDimensions = (file: string): string => {
  const head = fs.readFileSync(file).subarray(0, 24);
  return `${head.readUInt32BE(16)}x${head.readUInt32BE(20)}`;
};

/** Mean SSIM, over the sampled positions, of the pages of `file` against the source pages that should have come out in their place. */
function orderedSsim(ctx: FamilyContext, tools: PdfTools, source: Source, file: string, expected: readonly number[], label: string): number {
  const scores = sampledPositions(expected.length).map((position) => {
    const mine = renderPage(tools, file, position + 1, ctx.scratch(`${label}-${position}.png`));
    const wanted = renderPage(tools, source.file, expected[position], ctx.scratch(`${label}-source-${position}.png`));
    if (mine === null || wanted === null || pngDimensions(mine) !== pngDimensions(wanted)) return 0;
    return measureSsimPsnr(tools.ffmpeg, mine, wanted).ssim;
  });
  return scores.reduce((sum, value) => sum + value, 0) / Math.max(1, scores.length);
}

function rotationsOf(tools: PdfTools, file: string, count: number): number[] {
  const out = attempt(() => runTool(tools.pdfinfo, ['-f', '1', '-l', String(count), file]).stdout);
  return out === null ? [] : [...out.toString('utf8').matchAll(/Page\s+\d+ rot:\s+(\d+)/g)].map((match) => Number.parseInt(match[1], 10));
}

interface Run {
  /** Our output, as one file. */
  ours: () => Promise<Buffer>;
  /** The reference writes its output here. */
  reference: (out: string) => void;
  /** The pages of the source that the output holds, in order. */
  expected: readonly number[];
  /** Extra rows of the operation, from the files of both sides. */
  extra: (oursFile: string, referenceFile: string) => BenchRow[];
}

function runOf(ctx: FamilyContext, tools: PdfTools & { gs: string }, source: Source, operation: Operation, caseName: string): Run | null {
  const { bytes, file, pages } = source;
  const kept = expectedPages(operation, pages);
  if (kept === null) return null;
  const ssimRow = (oursFile: string, referenceFile: string, expected: readonly number[]): BenchRow =>
    measuredRow(FAMILY, caseName, SPEC.ssim, orderedSsim(ctx, tools, source, oursFile, expected, `${caseName}-ours`), orderedSsim(ctx, tools, source, referenceFile, expected, `${caseName}-reference`), REFERENCE_OF(operation));
  const selection = (spec: string): string[] => [WARNINGS_OK, ...COMPACT_OUTPUT, file, '--pages', '.', spec, '--'];
  if (operation === 'extract') {
    const spec = pages >= 2 ? `${pages},1` : '1';
    return {
      ours: async () => (await pageOpsModule()).extractPdfPages(bytes, spec),
      reference: (out) => void runTool(tools.qpdf, [...selection(spec), out]),
      expected: kept,
      extra: (o, r) => [ssimRow(o, r, kept)],
    };
  }
  if (operation === 'delete') {
    const dropped = pages >= 3 ? 2 : 1;
    return {
      ours: async () => (await pageOpsModule()).deletePdfPages(bytes, String(dropped)),
      reference: (out) => void runTool(tools.qpdf, [...selection(`1-z,x${dropped}`), out]),
      expected: kept,
      extra: (o, r) => [ssimRow(o, r, kept)],
    };
  }
  if (operation === 'reorder') {
    const order = `${pages},1-${pages - 1}`;
    return {
      ours: async () => (await pageOpsModule()).reorderPdfPages(bytes, { order }),
      reference: (out) => void runTool(tools.qpdf, [...selection(order), out]),
      expected: kept,
      extra: (o, r) => [ssimRow(o, r, kept)],
    };
  }
  if (operation === 'rotate') {
    return {
      ours: async () => (await pageOpsModule()).rotatePdfPages(bytes, { rotation: ROTATE_DEGREES, pages: '1' }),
      reference: (out) => void runTool(tools.qpdf, [WARNINGS_OK, ...COMPACT_OUTPUT, `--rotate=+${ROTATE_DEGREES}:1`, file, '--', out]),
      expected: kept,
      extra: (o, r) => {
        const original = rotationsOf(tools, file, pages);
        const wanted = kept.map((page) => ((original[page - 1] ?? 0) + (page === 1 ? ROTATE_DEGREES : 0)) % 360);
        const errors = (output: string): number => {
          const actual = rotationsOf(tools, output, pages);
          return actual.length !== pages ? pages : actual.filter((degrees, index) => degrees % 360 !== wanted[index]).length;
        };
        return [measuredRow(FAMILY, caseName, SPEC.rotationErrors, errors(o), errors(r), REFERENCE_TOOL)];
      },
    };
  }
  if (operation === 'compress') {
    return {
      ours: async () => (await (await compressModule()).compressPdf(bytes, { profile: 'web' })).buffer,
      reference: (out) => void runTool(tools.gs, [...GHOSTSCRIPT_REFERENCE_ARGS, `-sOutputFile=${out}`, file]),
      expected: kept,
      extra: (o, r) => [ssimRow(o, r, kept)],
    };
  }
  if (operation === 'protect') {
    return {
      ours: async () => (await protectModule()).protectPdf(bytes, { userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD, keyLength: 256 }),
      reference: (out) => void runTool(tools.qpdf, [WARNINGS_OK, '--encrypt', USER_PASSWORD, OWNER_PASSWORD, '256', '--print=full', '--modify=none', '--extract=n', '--', file, out]),
      expected: kept,
      extra: (o, r) => [measuredRow(FAMILY, caseName, SPEC.encryptionMatchesReference, protectionHolds(tools, o) ? 1 : 0, protectionHolds(tools, r) ? 1 : 0, REFERENCE_TOOL)],
    };
  }
  // unlock: an encrypted file with an empty user password.
  return {
    ours: async () => (await unlockModule()).unlockPdf(bytes, { password: '', confirmEditRights: true }),
    reference: (out) => void runTool(tools.qpdf, [WARNINGS_OK, '--decrypt', file, out]),
    expected: kept,
    extra: (o, r) => {
      const unlocked = (output: string): boolean => encryptionReport(tools, output).trim() === 'File is not encrypted';
      return [measuredRow(FAMILY, caseName, SPEC.encryptionMatchesReference, unlocked(o) ? 1 : 0, unlocked(r) ? 1 : 0, REFERENCE_TOOL)];
    },
  };
}

/** The split case: one file per page as a ZIP against `qpdf --split-pages=1`. */
async function runSplit(ctx: FamilyContext, tools: PdfTools & { gs: string }, source: Source, classRows: PublicClassRows): Promise<BenchRow[]> {
  const caseName = caseOf(source.sample, 'split');
  const rows: BenchRow[] = [];
  const referenceDir = ctx.scratch('split-reference');
  fs.mkdirSync(referenceDir);
  const reference = (): void => {
    runTool(tools.qpdf, [WARNINGS_OK, ...COMPACT_OUTPUT, '--split-pages=1', source.file, path.join(referenceDir, 'part-%d.pdf')]);
  };
  const ours = async (): Promise<Buffer> => (await pageOpsModule()).splitPdfPages(source.bytes, {}, {}, source.sample.id);
  if (ctx.quality) {
    classRows.expect(source.sample.class, '->split', [...OPERATION_SPECS.split, CONVERTS_SPEC].map((spec) => spec.metric));
    const attemptSplit = await attemptOurs(ours);
    let referenceConverted = true;
    try {
      reference();
    } catch (error) {
      if (!(error instanceof ToolRunError)) throw error;
      referenceConverted = false;
    }
    rows.push(convertsRow(FAMILY, caseName, attemptSplit.ok, referenceConverted, REFERENCE_TOOL));
    if (attemptSplit.ok && referenceConverted) {
      const { default: JSZip } = await import('jszip');
      const archive = await JSZip.loadAsync(attemptSplit.value);
      const oursDir = ctx.scratch('split-ours');
      fs.mkdirSync(oursDir);
      const oursFiles: string[] = [];
      for (const name of Object.keys(archive.files).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
        const target = path.join(oursDir, name);
        fs.writeFileSync(target, await archive.files[name].async('nodebuffer')); // NOSONAR S9382 sequential
        oursFiles.push(target);
      }
      const referenceFiles = fs.readdirSync(referenceDir).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).map((name) => path.join(referenceDir, name));
      const parts = (files: string[]): { score: Score; ssim: number } => {
        const scores = source.texts.map((text, index) => (files[index] === undefined ? null : scoreOutput(tools, files[index], [text])));
        const missing = source.texts.length - scores.filter((score) => score !== null).length + Math.max(0, files.length - source.texts.length);
        const present = scores.filter((score): score is Score => score !== null);
        const positions = sampledPositions(source.texts.length);
        const ssims = positions.map((position) => {
          const mine = files[position] === undefined ? null : renderPage(tools, files[position], 1, ctx.scratch(`split-${position}.png`));
          const wanted = renderPage(tools, source.file, position + 1, ctx.scratch(`split-source-${position}.png`));
          return mine === null || wanted === null || pngDimensions(mine) !== pngDimensions(wanted) ? 0 : measureSsimPsnr(tools.ffmpeg, mine, wanted).ssim;
        });
        return {
          score: {
            checkFailures: present.reduce((sum, score) => sum + score.checkFailures, 0) + missing,
            pageCountError: present.reduce((sum, score) => sum + score.pageCountError, 0) + missing,
            textF1: meanOrNull(scores.flatMap((score, index) => (/[\p{L}\p{N}]/u.test(source.texts[index]) ? [score?.textF1 ?? 0] : []))),
            bytes: present.reduce((sum, score) => sum + score.bytes, 0),
          },
          ssim: ssims.reduce((sum, value) => sum + value, 0) / Math.max(1, ssims.length),
        };
      };
      const o = parts(oursFiles);
      const r = parts(referenceFiles);
      rows.push(...qualityRows(caseName, o.score, r.score, REFERENCE_TOOL), measuredRow(FAMILY, caseName, SPEC.ssim, o.ssim, r.ssim, REFERENCE_TOOL));
    }
    classRows.addCases(source.sample.class, source.sample.id, rows);
  }
  if (ctx.speed && publicSpeedSample(FAMILY, source.sample.id)) {
    const timing = await ctx.time(
      speedRowId(FAMILY, caseName),
      async () => {
        await ours();
      },
      reference,
      'light'
    );
    rows.push(throughputRow(FAMILY, caseName, source.bytes.length, timing, REFERENCE_TOOL));
  }
  return rows;
}

function qualityRows(caseName: string, ours: Score, reference: Score, referenceTool: string): BenchRow[] {
  return [
    measuredRow(FAMILY, caseName, SPEC.pdfCheckFailures, ours.checkFailures, reference.checkFailures, referenceTool),
    measuredRow(FAMILY, caseName, SPEC.pageCountError, ours.pageCountError, reference.pageCountError, referenceTool),
    ...(ours.textF1 === null || reference.textF1 === null ? [] : [measuredRow(FAMILY, caseName, SPEC.wordF1, ours.textF1, reference.textF1, referenceTool)]),
    measuredRow(FAMILY, caseName, SPEC.bytes, ours.bytes, reference.bytes, referenceTool),
  ];
}

async function runOperation(ctx: FamilyContext, tools: PdfTools & { gs: string }, source: Source, operation: Operation, classRows: PublicClassRows): Promise<BenchRow[]> {
  if (operation === 'split') return runSplit(ctx, tools, source, classRows);
  const { sample } = source;
  const caseName = caseOf(sample, operation);
  const referenceTool = REFERENCE_OF(operation);
  const run = runOf(ctx, tools, source, operation, caseName);
  if (run === null) return [];
  ctx.log(`pdf-ops ${caseName}`);
  const rows: BenchRow[] = [];
  let converted = true;
  if (ctx.quality) {
    classRows.expect(sample.class, `->${operation}`, [...OPERATION_SPECS[operation], CONVERTS_SPEC].map((spec) => spec.metric));
    const attemptOursRun = await attemptOurs(run.ours);
    converted = attemptOursRun.ok;
    const referenceFile = ctx.scratch(`${operation}-reference.pdf`);
    let referenceConverted = true;
    try {
      run.reference(referenceFile);
    } catch (error) {
      if (!(error instanceof ToolRunError)) throw error;
      referenceConverted = false;
      ctx.log(`pdf-ops ${caseName}: the reference tool does not convert it (${error.message.slice(0, 160)})`);
    }
    if (!attemptOursRun.ok) ctx.log(`pdf-ops ${caseName}: the product does not convert it (${attemptOursRun.reason})`);
    rows.push(convertsRow(FAMILY, caseName, attemptOursRun.ok, referenceConverted, referenceTool));
    if (attemptOursRun.ok && referenceConverted) {
      const oursFile = ctx.scratch(`${operation}-ours.pdf`);
      fs.writeFileSync(oursFile, attemptOursRun.value);
      const truth = run.expected.map((page) => source.texts[page - 1] ?? '');
      rows.push(...qualityRows(caseName, scoreOutput(tools, oursFile, truth), scoreOutput(tools, referenceFile, truth), referenceTool), ...run.extra(oursFile, referenceFile));
    }
    classRows.addCases(sample.class, sample.id, rows);
  }
  if (ctx.speed && converted && publicSpeedSample(FAMILY, sample.id)) {
    const out = ctx.scratch(`${operation}-timing.pdf`);
    const timing = await ctx.time(
      speedRowId(FAMILY, caseName),
      async () => {
        await run.ours();
      },
      () => run.reference(out),
      'light'
    );
    rows.push(throughputRow(FAMILY, caseName, source.bytes.length, timing, referenceTool));
  }
  return rows;
}

/** The pages of a sample are only known once it is fetched; the quality rows of its cases need them. */
async function loadSource(ctx: FamilyContext, tools: PdfTools, sample: PublicSample): Promise<Source | null> {
  const cached = await publicFile(ctx, sample);
  if (cached === null) return null;
  const file = ctx.scratch(sample.id);
  fs.copyFileSync(cached, file);
  const pages = pageCountOf(tools, file);
  return { sample, file, bytes: fs.readFileSync(file), pages, texts: pageTexts(tools, file) };
}

const COMMON_TOOLS = ['qpdf', 'pdftotext', 'pdftoppm', 'pdfinfo', 'ffmpeg'] as const;

export async function runPdfOpsPublic(ctx: FamilyContext): Promise<BenchRow[]> {
  const samples = publicSamples('pdf-ops');
  const wanted = samples.flatMap((sample) => OPERATIONS.filter((operation) => ctx.inScope(FAMILY, caseOf(sample, operation))).map((operation) => ({ sample, operation })));
  if (wanted.length === 0) return [];
  const plan = ctx.plan([...COMMON_TOOLS, 'gs'], 'pdf-ops public');
  if (!plan.ok) return wanted.flatMap(({ sample, operation }) => skippedGroup(FAMILY, caseOf(sample, operation), [...OPERATION_SPECS[operation], SPEC.throughput], REFERENCE_OF(operation), plan));
  const tools = plan.paths as unknown as PdfTools & { gs: string };
  const rows: BenchRow[] = [];
  const classRows = new PublicClassRows();
  for (const sample of samples) {
    const mine = wanted.filter((item) => item.sample === sample);
    if (mine.length === 0) continue;
    const source = await loadSource(ctx, tools, sample);
    if (source === null) {
      for (const { operation } of mine) rows.push(...unavailableRows(FAMILY, caseOf(sample, operation), OPERATION_SPECS[operation], REFERENCE_OF(operation), `public sample ${sample.id} is not available`));
      continue;
    }
    for (const { operation } of mine) {
      if (applies(operation, sample, source.pages)) rows.push(...(await runOperation(ctx, tools, source, operation, classRows))); // NOSONAR S9382 sequential
    }
  }
  if (ctx.quality) {
    for (const row of classRows.rows(FAMILY, (suffix) => (suffix === '->compress' ? GHOSTSCRIPT_TOOL : REFERENCE_TOOL))) {
      if (ctx.inScope(FAMILY, row.case)) rows.push(row);
    }
  }
  return rows;
}
