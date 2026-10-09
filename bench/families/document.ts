import fs from 'node:fs';
import path from 'node:path';
import { DOCUMENT_FIXTURES_DIR, HWP_FIXTURES_DIR, IN_PROCESS_REPEATS, REPO_ROOT } from '../config';
import { convertInProcess } from '../convert';
import type { FamilyContext, FamilyRunner } from '../context';
import type { BenchRow } from '../report';
import { measuredRow, type MetricSpec, skippedGroup, SPEC, throughputRow } from '../rows';
import { interleavedTiming } from '../stats';
import { structureOfDocx, structureOfEpub, structureOfOdt } from '../structure-extract';
import { emptyStructure, normalizeText, scoreStructure, STRUCTURE_CATEGORIES, structureOfHtml, type DocumentStructure, type StructureCategory } from '../structure-metrics';
import { characterErrorRatePercent, wordF1 } from '../text-metrics';
import { OLEFILE_PSEUDO_TOOL, runTool } from '../tools';
import { richStructureTruth } from '../../tests/helpers/document-fixtures';
import { runDocumentPdf } from './document-pdf';
import { runDocumentShaping } from './document-shaping';

/**
 * Document family. Three groups of cases:
 *
 * - `report.docx->pdf`: the text of a PDF read back with pdftotext against the text the document was built from,
 *   next to the office suite's own PDF export. Our side is the in-process engine: the production dispatcher
 *   prefers the office suite when it is installed, which would compare the reference with itself.
 * - `rich-structure.docx->html|odt|epub|pdf`: a DOCX authored with headings, nested numbered and bulleted lists, a table
 *   with merged cells, two pictures, a footnote and an endnote, converted by this project's in-process engine and by
 *   the office suite's command-line export. Precision and recall of each structure category are read from both
 *   outputs by the same independent reader and scored against the structure written by hand for the document. EPUB
 *   outputs are also validated with EPUBCheck.
 * - `book.epub->docx` and `noori.hwp->html|txt`: formats the office suite cannot open (it reports "source file
 *   could not be loaded"). The reference there is the truth itself: a structure written by hand for an EPUB authored
 *   with a package writer, and the cell grid, picture hashes and text of an HWP read by an independent OLE2 reader.
 *   Those rows have no speed comparison with the office suite; HWP is timed against the reader script instead.
 */

const REFERENCE = 'soffice';
const REPORT_CASE = 'report.docx->pdf';
const REPORT_SPECS: readonly MetricSpec[] = [SPEC.wordF1, SPEC.cer, SPEC.throughput];
const STRUCTURE_DOCX = 'rich-structure.docx';
const STRUCTURE_TARGETS = ['html', 'odt', 'epub', 'pdf'] as const;
type StructureTarget = (typeof STRUCTURE_TARGETS)[number];
const BOOK_CASE = 'book.epub->docx';
const HWP_FILE = 'noori.hwp';
const HWP_REFERENCE = 'olefile reference reader';
const TRUTH_REFERENCE = 'hand-written truth';
const IDEAL_PRECISION = 1;
const IDEAL_RECALL = 1;
const IDEAL_CER_PERCENT = 0;
const EPUB_ERROR_SEVERITIES = new Set(['FATAL', 'ERROR']);

interface EpubcheckMessage {
  severity: string;
}

/** Structure categories a case scores, in report order. */
type Categories = readonly StructureCategory[];

function categoryCase(caseName: string, category: StructureCategory): string {
  return `${caseName}:${category}`;
}

/** Precision and recall rows for every scored category. */
function structureRows(caseName: string, truth: DocumentStructure, categories: Categories, ours: DocumentStructure, reference: DocumentStructure | null, referenceTool: string): BenchRow[] {
  const oursScores = scoreStructure(truth, ours);
  const referenceScores = reference ? scoreStructure(truth, reference) : null;
  const rows: BenchRow[] = [];
  for (const category of categories) {
    const caseId = categoryCase(caseName, category);
    rows.push(
      measuredRow('document', caseId, SPEC.structurePrecision, oursScores[category].precision, referenceScores ? referenceScores[category].precision : IDEAL_PRECISION, referenceTool),
      measuredRow('document', caseId, SPEC.structureRecall, oursScores[category].recall, referenceScores ? referenceScores[category].recall : IDEAL_RECALL, referenceTool)
    );
  }
  return rows;
}

function categoriesWithTruth(truth: DocumentStructure): StructureCategory[] {
  return STRUCTURE_CATEGORIES.filter((category) => truth[category].length > 0);
}

function sofficeExport(soffice: string, profile: string, input: string, target: string, outDir: string): string {
  fs.mkdirSync(outDir, { recursive: true });
  runTool(soffice, [`-env:UserInstallation=${profile}`, '--headless', '--convert-to', target, '--outdir', outDir, input]);
  return path.join(outDir, `${path.parse(input).name}.${target}`);
}

function epubcheckErrors(epubcheck: string, scratch: (name: string) => string, epub: Buffer): number {
  const file = scratch('check.epub');
  const report = scratch('check.json');
  fs.writeFileSync(file, epub);
  try {
    runTool(epubcheck, [file, '--json', report, '--quiet']);
  } catch (error) {
    // EPUBCheck exits non-zero when it finds errors; its report is still written.
    if (!fs.existsSync(report)) throw error;
  }
  const messages = (JSON.parse(fs.readFileSync(report, 'utf8')) as { messages: EpubcheckMessage[] }).messages;
  return messages.filter((message) => EPUB_ERROR_SEVERITIES.has(message.severity)).length;
}

async function readStructure(target: Exclude<StructureTarget, 'pdf'>, bytes: Buffer, resolveImage?: (src: string) => Buffer | undefined): Promise<DocumentStructure> {
  if (target === 'html') return structureOfHtml(bytes.toString('utf8'), resolveImage);
  if (target === 'odt') return structureOfOdt(bytes);
  return structureOfEpub(bytes);
}

function truthText(truth: DocumentStructure): string {
  return [...truth.headings, ...truth.listItems, ...truth.tableCells, ...truth.notes].map((entry) => entry.split('|').filter((part) => !/^(?:\d+|ol|ul)$/.test(part)).join(' ')).join(' ');
}

/** Number of embedded pictures in a PDF, from pdfimages' listing (two header lines, then one line per picture). */
function pdfImageCount(pdfimages: string, pdf: string): number {
  const header = 2;
  const lines = runTool(pdfimages, ['-list', pdf]).stdout.toString('utf8').split('\n').filter((line) => line.trim() !== '');
  return Math.max(0, lines.length - header);
}

function countStructure(count: number, truth: DocumentStructure): DocumentStructure {
  const found = emptyStructure();
  found.images = truth.images.slice(0, count);
  for (let extra = truth.images.length; extra < count; extra++) found.images.push(`unmatched-${extra}`);
  return found;
}

async function runStructureDocx(ctx: FamilyContext): Promise<BenchRow[]> {
  const caseOf = (target: StructureTarget): string => `${STRUCTURE_DOCX}->${target}`;
  const plan = ctx.plan(['soffice', 'pdftotext', 'pdfimages', 'epubcheck'], caseOf('html'));
  if (!plan.ok) {
    const specs = [SPEC.structurePrecision, SPEC.structureRecall, SPEC.throughput];
    return STRUCTURE_TARGETS.flatMap((target) => skippedGroup('document', caseOf(target), specs, REFERENCE, plan));
  }
  const { soffice, pdftotext, pdfimages, epubcheck } = plan.paths;
  const docxFile = path.join(DOCUMENT_FIXTURES_DIR, STRUCTURE_DOCX);
  const docx = fs.readFileSync(docxFile);
  const truth = await richStructureTruth();
  const categories = categoriesWithTruth(truth);
  const profile = `file://${path.join(ctx.work, 'soffice-profile')}`;
  const rows: BenchRow[] = [];

  for (const target of STRUCTURE_TARGETS) {
    ctx.log(`document ${caseOf(target)}`);
    const caseName = caseOf(target);
    const ours = (): Promise<Buffer> => convertInProcess(docx, 'docx', target, {}, STRUCTURE_DOCX);
    const reference = (outDir: string): string => sofficeExport(soffice, profile, docxFile, target, outDir);
    const oursBytes = await ours();
    const referenceOut = ctx.scratch(`ref-${target}`);
    const referenceFile = reference(referenceOut);

    if (target === 'pdf') {
      const oursPdf = ctx.scratch('ours-structure.pdf');
      fs.writeFileSync(oursPdf, oursBytes);
      const text = (pdf: string): string => runTool(pdftotext, ['-layout', '-enc', 'UTF-8', pdf, '-']).stdout.toString('utf8');
      const expected = truthText(truth);
      rows.push(
        measuredRow('document', caseName, SPEC.wordF1, wordF1(expected, text(oursPdf)), wordF1(expected, text(referenceFile)), REFERENCE),
        ...structureRows(caseName, truth, ['images'], countStructure(pdfImageCount(pdfimages, oursPdf), truth), countStructure(pdfImageCount(pdfimages, referenceFile), truth), REFERENCE)
      );
    } else {
      const resolveReferenceImage = (src: string): Buffer | undefined => {
        const candidate = path.join(referenceOut, decodeURIComponent(src));
        return fs.existsSync(candidate) ? fs.readFileSync(candidate) : undefined;
      };
      const oursStructure = await readStructure(target, oursBytes);
      const referenceStructure = await readStructure(target, fs.readFileSync(referenceFile), resolveReferenceImage);
      rows.push(...structureRows(caseName, truth, categories, oursStructure, referenceStructure, REFERENCE));
      if (target === 'epub') {
        rows.push(
          measuredRow('document', caseName, SPEC.epubcheckErrors, epubcheckErrors(epubcheck, ctx.scratch, oursBytes), epubcheckErrors(epubcheck, ctx.scratch, fs.readFileSync(referenceFile)), REFERENCE)
        );
      }
    }

    const timing = await interleavedTiming(
      async () => {
        await ours();
      },
      () => {
        reference(ctx.scratch(`timing-${target}`));
      },
      ctx.heavyRuns,
      ctx.warmup,
      IN_PROCESS_REPEATS
    );
    rows.push(throughputRow('document', caseName, docx.length, timing, REFERENCE));
  }
  return rows;
}

/** The EPUB authored with ebooklib (tests/fixtures/document/PROVENANCE.md) and the structure written for it by hand. */
async function runBook(ctx: FamilyContext): Promise<BenchRow[]> {
  ctx.log(`document ${BOOK_CASE}`);
  const book = fs.readFileSync(path.join(DOCUMENT_FIXTURES_DIR, 'book.epub'));
  const picture = (await structureOfEpub(book)).images;
  const truth: DocumentStructure = {
    headings: ['1|Opening', '1|Data', '2|Table'],
    listItems: ['0|ol|First step', '1|ul|Detail one', '1|ul|Detail two', '0|ol|Second step'],
    tableCells: ['Name|1|1', 'Values|2|1', 'Alpha|1|2', '1|1|1', '2|1|1', '3|1|1', '4|1|1'],
    images: picture,
    notes: [],
  };
  const docx = await convertInProcess(book, 'epub', 'docx', {}, 'book.epub');
  return structureRows(BOOK_CASE, truth, ['headings', 'listItems', 'tableCells', 'images'], await structureOfDocx(docx), null, TRUTH_REFERENCE);
}

interface HwpReference {
  body: Array<{ kind: 'paragraph'; text: string } | { kind: 'table'; index: number }>;
  tables: Array<{ cells: string[][]; spans: Array<{ row: number; col: number; colSpan: number; rowSpan: number }> }>;
  captions: string[];
  pictures: Array<{ sha256: string }>;
}

async function runHwp(ctx: FamilyContext): Promise<BenchRow[]> {
  const htmlCase = `${HWP_FILE}->html`;
  const txtCase = `${HWP_FILE}->txt`;
  const plan = ctx.plan(['python3', OLEFILE_PSEUDO_TOOL], htmlCase);
  if (!plan.ok) {
    const specs = [SPEC.structurePrecision, SPEC.structureRecall, SPEC.cer, SPEC.throughput];
    return [htmlCase, txtCase].flatMap((name) => skippedGroup('document', name, specs, HWP_REFERENCE, plan));
  }
  ctx.log(`document ${htmlCase}`);
  const python = plan.paths.python3;
  const hwpFile = path.join(HWP_FIXTURES_DIR, HWP_FILE);
  const readerScript = path.join(HWP_FIXTURES_DIR, 'reference-extract.py');
  const hwp = fs.readFileSync(hwpFile);
  const reference = (): HwpReference => JSON.parse(runTool(python, ['-I', readerScript, hwpFile], { cwd: REPO_ROOT }).stdout.toString('utf8')) as HwpReference;
  const read = reference();

  const truth = emptyStructure();
  for (const table of read.tables) {
    for (const span of table.spans) truth.tableCells.push(`${normalizeText(table.cells[span.row][span.col])}|${span.colSpan}|${span.rowSpan}`);
  }
  truth.images = read.pictures.map((picture) => picture.sha256);
  const html = await convertInProcess(hwp, 'hwp', 'html', {}, HWP_FILE);
  const rows = structureRows(htmlCase, truth, ['tableCells', 'images'], structureOfHtml(html.toString('utf8')), null, HWP_REFERENCE);

  const expectedText = [
    ...read.body.map((item) => (item.kind === 'paragraph' ? item.text : read.tables[item.index].cells.flat().filter((cell) => cell !== '').join(' '))),
    ...read.captions,
  ].join(' ');
  const text = (await convertInProcess(hwp, 'hwp', 'txt', {}, HWP_FILE)).toString('utf8');
  rows.push(measuredRow('document', txtCase, SPEC.cer, characterErrorRatePercent(expectedText, text), IDEAL_CER_PERCENT, HWP_REFERENCE));

  const timing = await interleavedTiming(
    async () => {
      await convertInProcess(hwp, 'hwp', 'txt', {}, HWP_FILE);
    },
    () => {
      reference();
    },
    ctx.heavyRuns,
    ctx.warmup,
    IN_PROCESS_REPEATS
  );
  rows.push(throughputRow('document', txtCase, hwp.length, timing, HWP_REFERENCE));
  return rows;
}

async function runReport(ctx: FamilyContext): Promise<BenchRow[]> {
  const plan = ctx.plan(['pdftotext', 'soffice'], REPORT_CASE);
  if (!plan.ok) return skippedGroup('document', REPORT_CASE, REPORT_SPECS, REFERENCE, plan);
  ctx.log(`document ${REPORT_CASE}`);
  const { pdftotext, soffice } = plan.paths;
  const docx = ctx.corpusBuffer('report.docx');
  const docxFile = ctx.corpusPath('report.docx');
  const truth = fs.readFileSync(ctx.corpusPath('report.gt.txt'), 'utf8');
  const profile = `file://${path.join(ctx.work, 'soffice-profile')}`;

  const oursPdf = (): Promise<Buffer> => convertInProcess(docx, 'docx', 'pdf', {}, 'report.docx');
  const referencePdf = (outDir: string): string => sofficeExport(soffice, profile, docxFile, 'pdf', outDir);
  const textOf = (pdf: string): string => runTool(pdftotext, ['-layout', '-enc', 'UTF-8', pdf, '-']).stdout.toString('utf8');

  const oursFile = ctx.scratch('ours.pdf');
  fs.writeFileSync(oursFile, await oursPdf());
  const oursText = textOf(oursFile);
  const referenceText = textOf(referencePdf(ctx.scratch('ref-out')));

  const rows: BenchRow[] = [
    measuredRow('document', REPORT_CASE, SPEC.wordF1, wordF1(truth, oursText), wordF1(truth, referenceText), REFERENCE),
    measuredRow('document', REPORT_CASE, SPEC.cer, characterErrorRatePercent(truth, oursText), characterErrorRatePercent(truth, referenceText), REFERENCE),
  ];

  const timing = await interleavedTiming(
    async () => {
      await oursPdf();
    },
    () => {
      referencePdf(ctx.scratch('timing-out'));
    },
    ctx.heavyRuns,
    ctx.warmup,
    IN_PROCESS_REPEATS
  );
  rows.push(throughputRow('document', REPORT_CASE, docx.length, timing, REFERENCE));
  return rows;
}

export const runDocument: FamilyRunner = async (ctx) => [
  ...(await runReport(ctx)),
  ...(await runStructureDocx(ctx)),
  ...(await runBook(ctx)),
  ...(await runHwp(ctx)),
  ...(await runDocumentPdf(ctx)),
  ...(await runDocumentShaping(ctx)),
];
