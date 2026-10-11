import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import type { FamilyContext, FamilyRunner } from '../context';
import { convertWithProject } from '../convert';
import { OutputIntegrityError } from '../errors';
import type { BenchRow, SkipKind } from '../report';
import { measuredRow, type MetricSpec, skippedRow, SPEC, speedRowId, throughputRow } from '../rows';
import { structureOfEpub } from '../structure-extract';
import { scoreStructure, type DocumentStructure } from '../structure-metrics';
import { wordF1 } from '../text-metrics';
import { runTool } from '../tools';

/**
 * Ebook family: the conversions the product advertises from EPUB, MOBI and FB2, on one short book (ten chapters, a list, a
 * table and a picture; 5,300 words; the EPUB is authored for the benchmark, the FB2 is written from the same text, and the MOBI
 * is the EPUB converted by the reference tool).
 *
 * Reference: calibre's `ebook-convert`, the standard ebook converter (GPL-3.0; run as a separate command-line process, the
 * release archive checked against a pinned SHA-256 in CI). A cold process per conversion, as for the office suite.
 *
 * Quality oracles, none of which is this project's code: the text of every output is read back by an independent reader (the
 * plain text itself; `pdftotext` for PDF; the spine of the package, read by the benchmark, for EPUB) and scored with word F1
 * against the text the book was written from; an EPUB output is validated with EPUBCheck and its headings are read with a
 * WHATWG HTML parser and scored for precision and recall against the headings of the source package; the pictures of a PDF
 * (`pdfimages`) and of an EPUB are counted against the one picture of the book.
 */

const REFERENCE = 'ebook-convert (calibre)';
const BOOK_PICTURES = 1;
const NATIVE_ENGINE_PREFIX = 'native-';
const EPUB_ERROR_SEVERITIES = new Set(['FATAL', 'ERROR']);
const PDF_LIST_HEADER_LINES = 2;
const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

interface BookCase {
  source: 'epub' | 'mobi' | 'fb2';
  target: 'txt' | 'pdf' | 'epub';
}

const CASES: readonly BookCase[] = [
  { source: 'epub', target: 'txt' },
  { source: 'epub', target: 'pdf' },
  { source: 'mobi', target: 'epub' },
  { source: 'mobi', target: 'txt' },
  { source: 'mobi', target: 'pdf' },
  { source: 'fb2', target: 'epub' },
  { source: 'fb2', target: 'txt' },
  { source: 'fb2', target: 'pdf' },
];
const caseName = (item: BookCase): string => `book.${item.source}->${item.target}`;

/** The rows of a case: the case id each metric is reported under, and its spec. */
function rowPlan(item: BookCase): Array<{ caseId: string; spec: MetricSpec }> {
  const name = caseName(item);
  const plan: Array<{ caseId: string; spec: MetricSpec }> = [{ caseId: name, spec: SPEC.wordF1 }];
  if (item.target === 'pdf') plan.push({ caseId: `${name}:images`, spec: SPEC.structureRecall });
  if (item.target === 'epub') {
    plan.push(
      { caseId: name, spec: SPEC.epubcheckErrors },
      { caseId: `${name}:headings`, spec: SPEC.structurePrecision },
      { caseId: `${name}:headings`, spec: SPEC.structureRecall },
      { caseId: `${name}:images`, spec: SPEC.structureRecall }
    );
  }
  plan.push({ caseId: name, spec: SPEC.throughput });
  return plan;
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name.startsWith('#x')) return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(parseInt(name.slice(1), 10));
    return ENTITIES[name.toLowerCase()] ?? match;
  });
}

/** The text of an EPUB's content documents in spine order, markup removed. */
export async function textOfEpub(epub: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(epub);
  const container = (await zip.file('META-INF/container.xml')?.async('string')) ?? '';
  const opfPath = /full-path="([^"]+)"/.exec(container)?.[1];
  if (!opfPath) return '';
  const opf = (await zip.file(opfPath)?.async('string')) ?? '';
  const manifest = new Map<string, { href: string; nav: boolean }>();
  for (const match of opf.matchAll(/<item\b[^>]*>/g)) {
    const id = /\bid="([^"]+)"/.exec(match[0])?.[1];
    const href = /\bhref="([^"]+)"/.exec(match[0])?.[1];
    if (id && href) manifest.set(id, { href, nav: /\bproperties="[^"]*\bnav\b/.test(match[0]) });
  }
  const base = path.posix.dirname(opfPath);
  const parts: string[] = [];
  for (const itemref of opf.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"/g)) {
    const item = manifest.get(itemref[1]);
    if (!item || item.nav) continue;
    const html = await zip.file(path.posix.normalize(path.posix.join(base, decodeURIComponent(item.href))))?.async('string');
    if (html) parts.push(decodeEntities(html.replace(/<(?:head|script|style)\b[\s\S]*?<\/(?:head|script|style)>/gi, ' ').replace(/<[^>]+>/g, ' ')));
  }
  return parts.join('\n');
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
  const messages = (JSON.parse(fs.readFileSync(report, 'utf8')) as { messages: Array<{ severity: string }> }).messages;
  return messages.filter((message) => EPUB_ERROR_SEVERITIES.has(message.severity)).length;
}

/** Number of pictures in a PDF, from pdfimages' listing (two header lines, then one line per picture). */
function pdfImageCount(pdfimages: string, pdf: string): number {
  const lines = runTool(pdfimages, ['-list', pdf]).stdout.toString('utf8').split('\n').filter((line) => line.trim() !== '');
  return Math.max(0, lines.length - PDF_LIST_HEADER_LINES);
}

/** Share of the pictures of the book that an output holds; more pictures than the book has do not raise it. */
const pictureRecall = (found: number): number => Math.min(found, BOOK_PICTURES) / BOOK_PICTURES;

interface Tools {
  ebookConvert: string;
  pdftotext: string;
  pdfimages: string;
  epubcheck: string;
}

interface Truth {
  text: string;
  structure: DocumentStructure;
}

interface Output {
  file: string;
  bytes: Buffer;
}

async function textOf(tools: Tools, target: BookCase['target'], output: Output): Promise<string> {
  if (target === 'txt') return output.bytes.toString('utf8');
  if (target === 'epub') return textOfEpub(output.bytes);
  return runTool(tools.pdftotext, ['-layout', '-enc', 'UTF-8', output.file, '-']).stdout.toString('utf8');
}

async function qualityRows(ctx: FamilyContext, tools: Tools, truth: Truth, item: BookCase, ours: Output, reference: Output): Promise<BenchRow[]> {
  const name = caseName(item);
  const rows: BenchRow[] = [measuredRow('ebook', name, SPEC.wordF1, wordF1(truth.text, await textOf(tools, item.target, ours)), wordF1(truth.text, await textOf(tools, item.target, reference)), REFERENCE)];
  if (item.target === 'pdf') {
    rows.push(measuredRow('ebook', `${name}:images`, SPEC.structureRecall, pictureRecall(pdfImageCount(tools.pdfimages, ours.file)), pictureRecall(pdfImageCount(tools.pdfimages, reference.file)), REFERENCE));
  }
  if (item.target === 'epub') {
    const oursStructure = await structureOfEpub(ours.bytes);
    const referenceStructure = await structureOfEpub(reference.bytes);
    const oursScores = scoreStructure(truth.structure, oursStructure);
    const referenceScores = scoreStructure(truth.structure, referenceStructure);
    rows.push(
      measuredRow('ebook', name, SPEC.epubcheckErrors, epubcheckErrors(tools.epubcheck, ctx.scratch, ours.bytes), epubcheckErrors(tools.epubcheck, ctx.scratch, reference.bytes), REFERENCE),
      measuredRow('ebook', `${name}:headings`, SPEC.structurePrecision, oursScores.headings.precision, referenceScores.headings.precision, REFERENCE),
      measuredRow('ebook', `${name}:headings`, SPEC.structureRecall, oursScores.headings.recall, referenceScores.headings.recall, REFERENCE),
      measuredRow('ebook', `${name}:images`, SPEC.structureRecall, pictureRecall(oursStructure.images.length), pictureRecall(referenceStructure.images.length), REFERENCE)
    );
  }
  return rows;
}

async function runCase(ctx: FamilyContext, tools: Tools, truth: Truth, item: BookCase): Promise<BenchRow[]> {
  const name = caseName(item);
  ctx.log(`ebook ${name}`);
  const sourceFile = ctx.corpusPath(`ebooks/book.${item.source}`);
  const input = fs.readFileSync(sourceFile);
  const convertOurs = async (): Promise<Buffer> => {
    const converted = await convertWithProject(input, item.source, item.target, {}, `book.${item.source}`);
    if (converted.engineUsed.startsWith(NATIVE_ENGINE_PREFIX)) {
      throw new OutputIntegrityError(`${name} ran on ${converted.engineUsed}; an ebook row compares the in-process engine with the reference tool, not a native engine with itself`);
    }
    return converted.buffer;
  };
  const convertReference = (out: string): void => {
    // The renderer behind the PDF output needs no display.
    runTool(tools.ebookConvert, [sourceFile, out], { env: { ...process.env, QT_QPA_PLATFORM: 'offscreen' } });
  };

  const rows: BenchRow[] = [];
  if (ctx.quality) {
    const oursBytes = await convertOurs();
    const oursFile = ctx.scratch(`ours.${item.target}`);
    fs.writeFileSync(oursFile, oursBytes);
    const referenceFile = ctx.scratch(`reference.${item.target}`);
    convertReference(referenceFile);
    rows.push(...(await qualityRows(ctx, tools, truth, item, { file: oursFile, bytes: oursBytes }, { file: referenceFile, bytes: fs.readFileSync(referenceFile) })));
  }
  if (ctx.speed) {
    const timing = await ctx.time(
      speedRowId('ebook', name),
      async () => {
        await convertOurs();
      },
      () => {
        convertReference(ctx.scratch(`timing.${item.target}`));
      },
      'heavy'
    );
    rows.push(throughputRow('ebook', name, input.length, timing, REFERENCE));
  }
  return rows;
}

export const runEbook: FamilyRunner = async (ctx) => {
  const cases = CASES.filter((item) => ctx.inScope('ebook', caseName(item)));
  if (cases.length === 0) return [];
  const plan = ctx.plan(['ebook-convert', 'pdftotext', 'pdfimages', 'epubcheck'], 'ebook');
  if (!plan.ok) {
    const kind: SkipKind = plan.optional ? 'optional-tool' : 'missing-tool';
    return cases.flatMap((item) => rowPlan(item).map(({ caseId, spec }) => skippedRow('ebook', caseId, spec, REFERENCE, kind, plan.reason)));
  }
  const tools: Tools = { ebookConvert: plan.paths['ebook-convert'], pdftotext: plan.paths.pdftotext, pdfimages: plan.paths.pdfimages, epubcheck: plan.paths.epubcheck };
  const truth: Truth = { text: fs.readFileSync(ctx.corpusPath('ebooks/book.gt.txt'), 'utf8'), structure: await structureOfEpub(ctx.corpusBuffer('ebooks/book.epub')) };
  const rows: BenchRow[] = [];
  for (const item of cases) rows.push(...(await runCase(ctx, tools, truth, item)));
  return rows;
};
