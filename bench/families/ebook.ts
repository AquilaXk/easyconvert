import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import type { FamilyContext, FamilyRunner } from '../context';
import { convertWithProject } from '../convert';
import { OutputIntegrityError, ToolRunError } from '../errors';
import { PublicClassRows } from '../public-classes';
import { publicCompanionFile, publicFile, publicSamples, type PublicSample } from '../public-samples';
import { publicSpeedSample } from '../public-scope';
import { attemptOurs, CONVERTS_SPEC, convertsRow, unavailableRows } from '../public-support';
import type { BenchRow, SkipKind } from '../report';
import { measuredRow, type MetricSpec, skippedRow, SPEC, speedRowId, throughputRow } from '../rows';
import { structureOfEpub } from '../structure-extract';
import { emptyStructure, scoreStructure, type DocumentStructure } from '../structure-metrics';
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
 *
 * The public samples (bench/corpus/public-manifest.json) are public-domain books with images and linked tables of contents in
 * EPUB, Kindle and FictionBook form, and the EPUB 3 sample publications of an open standards group (right-to-left text,
 * MathML, specification text). The truth is read from the source by this file: the text of an EPUB's spine and its headings and
 * pictures; the text of the `body` elements of an FB2 file and its pictures; for a Kindle file, the text and pictures of the
 * EPUB of the same book, which the same publisher builds from the same source. The reference side is the same calibre process,
 * and a file the product refuses is a `converts` row instead of a stopped run.
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
/** The conversions a public book gets, by its format (the targets of the generated book's cases). */
const PUBLIC_TARGETS: Readonly<Record<BookCase['source'], readonly BookCase['target'][]>> = { epub: ['txt', 'pdf'], mobi: ['epub', 'txt', 'pdf'], fb2: ['epub', 'txt', 'pdf'] };

/** A book the family converts: the generated one (three formats under the name `book`) or a public sample. */
interface Book {
  /** The name of the case: `book.<format>` or the sample id. */
  name: string;
  item: BookCase;
  sample: PublicSample | null;
}

const bookCaseName = (book: Book): string => (book.sample ? `${book.sample.id}->${book.item.target}` : caseName(book.item));

/** The rows of a case: the case id each metric is reported under, and its spec. */
function rowPlan(book: Book): Array<{ caseId: string; spec: MetricSpec }> {
  const { item } = book;
  const name = bookCaseName(book);
  const plan: Array<{ caseId: string; spec: MetricSpec }> = [{ caseId: name, spec: SPEC.wordF1 }];
  if (item.target === 'pdf') plan.push({ caseId: `${name}:images`, spec: SPEC.structureRecall });
  if (item.target === 'epub') {
    plan.push({ caseId: name, spec: SPEC.epubcheckErrors });
    if (headingsMeasured(book)) plan.push({ caseId: `${name}:headings`, spec: SPEC.structurePrecision }, { caseId: `${name}:headings`, spec: SPEC.structureRecall });
    plan.push({ caseId: `${name}:images`, spec: SPEC.structureRecall });
  }
  plan.push({ caseId: name, spec: SPEC.throughput });
  return plan;
}

/** Headings are scored when the truth has them: the generated book, and an EPUB source (a Kindle or FictionBook file has no heading truth to read). */
const headingsMeasured = (book: Book): boolean => book.sample === null || book.sample.meta.format === 'epub';

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


interface Tools {
  ebookConvert: string;
  pdftotext: string;
  pdfimages: string;
  epubcheck: string;
}

interface Truth {
  text: string;
  structure: DocumentStructure;
  /** Pictures of the book, the denominator of the picture recall. */
  pictures: number;
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

/** The text of a FictionBook 2 file: the `body` elements (the notes included), markup and the pictures' base64 removed. */
export function textOfFb2(xml: string): string {
  const bodies = [...xml.matchAll(/<body\b[^>]*>([\s\S]*?)<\/body>/g)].map((match) => match[1]);
  return decodeEntities(bodies.join('\n').replace(/<binary\b[\s\S]*?<\/binary>/g, ' ').replace(/<[^>]+>/g, ' '));
}

/** The pictures of a FictionBook 2 file: its `binary` parts with an image type. */
export const picturesOfFb2 = (xml: string): number => [...xml.matchAll(/<binary\b[^>]*content-type="image\/[^"]*"/gi)].length;

/** The truth of a public book, read from the file or, for a Kindle file, from the EPUB of the same book. */
async function publicTruth(ctx: FamilyContext, sample: PublicSample, file: string): Promise<Truth | null> {
  const format = String(sample.meta.format);
  if (format === 'epub') {
    const bytes = fs.readFileSync(file);
    const structure = await structureOfEpub(bytes);
    return { text: await textOfEpub(bytes), structure, pictures: structure.images.length };
  }
  if (format === 'fb2') {
    const xml = fs.readFileSync(file, 'utf8');
    return { text: textOfFb2(xml), structure: emptyStructure(), pictures: picturesOfFb2(xml) };
  }
  const twin = await publicCompanionFile(ctx, sample, 'text');
  if (twin === null) return null;
  const bytes = fs.readFileSync(twin);
  const structure = await structureOfEpub(bytes);
  return { text: await textOfEpub(bytes), structure, pictures: structure.images.length };
}

async function qualityRows(ctx: FamilyContext, tools: Tools, truth: Truth, book: Book, ours: Output, reference: Output): Promise<BenchRow[]> {
  const { item } = book;
  const name = bookCaseName(book);
  const rows: BenchRow[] = [measuredRow('ebook', name, SPEC.wordF1, wordF1(truth.text, await textOf(tools, item.target, ours)), wordF1(truth.text, await textOf(tools, item.target, reference)), REFERENCE)];
  const recall = (found: number): number => Math.min(found, truth.pictures) / truth.pictures;
  if (item.target === 'pdf' && truth.pictures > 0) {
    rows.push(measuredRow('ebook', `${name}:images`, SPEC.structureRecall, recall(pdfImageCount(tools.pdfimages, ours.file)), recall(pdfImageCount(tools.pdfimages, reference.file)), REFERENCE));
  }
  if (item.target === 'epub') {
    const oursStructure = await structureOfEpub(ours.bytes);
    const referenceStructure = await structureOfEpub(reference.bytes);
    rows.push(measuredRow('ebook', name, SPEC.epubcheckErrors, epubcheckErrors(tools.epubcheck, ctx.scratch, ours.bytes), epubcheckErrors(tools.epubcheck, ctx.scratch, reference.bytes), REFERENCE));
    if (headingsMeasured(book)) {
      const oursScores = scoreStructure(truth.structure, oursStructure);
      const referenceScores = scoreStructure(truth.structure, referenceStructure);
      rows.push(
        measuredRow('ebook', `${name}:headings`, SPEC.structurePrecision, oursScores.headings.precision, referenceScores.headings.precision, REFERENCE),
        measuredRow('ebook', `${name}:headings`, SPEC.structureRecall, oursScores.headings.recall, referenceScores.headings.recall, REFERENCE)
      );
    }
    if (truth.pictures > 0) rows.push(measuredRow('ebook', `${name}:images`, SPEC.structureRecall, recall(oursStructure.images.length), recall(referenceStructure.images.length), REFERENCE));
  }
  return rows;
}

interface BookFiles {
  file: string;
  /** The name the product is told the file has. */
  filename: string;
  truth: Truth;
}

async function runCase(ctx: FamilyContext, tools: Tools, files: BookFiles, book: Book, classRows: PublicClassRows): Promise<BenchRow[]> {
  const { item, sample } = book;
  const name = bookCaseName(book);
  ctx.log(`ebook ${name}`);
  const sourceFile = files.file;
  const input = fs.readFileSync(sourceFile);
  const convertOurs = async (): Promise<Buffer> => {
    const converted = await convertWithProject(input, item.source, item.target, {}, files.filename);
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
  let converted = true;
  if (ctx.quality) {
    if (sample) classRows.expectCases(sample.class, [...rowPlan(book).filter((entry) => entry.spec.kind !== 'throughput').map((entry) => ({ suffix: entry.caseId.slice(sample.id.length), metric: entry.spec.metric })), { suffix: `->${item.target}`, metric: CONVERTS_SPEC.metric }]);
    const attempt = await attemptOurs(convertOurs, sample !== null);
    converted = attempt.ok;
    const referenceFile = ctx.scratch(`reference.${item.target}`);
    let referenceConverted = true;
    try {
      convertReference(referenceFile);
    } catch (error) {
      if (sample === null || !(error instanceof ToolRunError)) throw error;
      referenceConverted = false;
      ctx.log(`ebook ${name}: the reference tool does not convert it (${error.message.slice(0, 160)})`);
    }
    if (sample) {
      if (!attempt.ok) ctx.log(`ebook ${name}: the product does not convert it (${attempt.reason})`);
      rows.push(convertsRow('ebook', name, attempt.ok, referenceConverted, REFERENCE));
    }
    if (attempt.ok && referenceConverted) {
      const oursFile = ctx.scratch(`ours.${item.target}`);
      fs.writeFileSync(oursFile, attempt.value);
      rows.push(...(await qualityRows(ctx, tools, files.truth, book, { file: oursFile, bytes: attempt.value }, { file: referenceFile, bytes: fs.readFileSync(referenceFile) })));
    }
    if (sample) classRows.addCases(sample.class, sample.id, rows);
  }
  if (ctx.speed && converted && (sample === null || publicSpeedSample('ebook', sample.id))) {
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
  const generated: Book[] = CASES.map((item) => ({ name: `book.${item.source}`, item, sample: null }));
  const published: Book[] = publicSamples('ebook').flatMap((sample) => {
    const source = String(sample.meta.format) as BookCase['source'];
    return PUBLIC_TARGETS[source].map((target) => ({ name: sample.id, item: { source, target }, sample }));
  });
  const books = [...generated, ...published].filter((book) => ctx.inScope('ebook', bookCaseName(book)));
  if (books.length === 0) return [];
  const plan = ctx.plan(['ebook-convert', 'pdftotext', 'pdfimages', 'epubcheck'], 'ebook');
  if (!plan.ok) {
    const kind: SkipKind = plan.optional ? 'optional-tool' : 'missing-tool';
    return books.flatMap((book) => rowPlan(book).map(({ caseId, spec }) => skippedRow('ebook', caseId, spec, REFERENCE, kind, plan.reason)));
  }
  const tools: Tools = { ebookConvert: plan.paths['ebook-convert'], pdftotext: plan.paths.pdftotext, pdfimages: plan.paths.pdfimages, epubcheck: plan.paths.epubcheck };
  const generatedTruth: Truth = { text: fs.readFileSync(ctx.corpusPath('ebooks/book.gt.txt'), 'utf8'), structure: await structureOfEpub(ctx.corpusBuffer('ebooks/book.epub')), pictures: BOOK_PICTURES };
  const rows: BenchRow[] = [];
  const classRows = new PublicClassRows();
  const publicFiles = new Map<string, BookFiles | null>();
  for (const book of books) {
    const { sample } = book;
    if (sample === null) {
      const file = ctx.corpusPath(`ebooks/book.${book.item.source}`);
      rows.push(...(await runCase(ctx, tools, { file, filename: `book.${book.item.source}`, truth: generatedTruth }, book, classRows)));
      continue;
    }
    if (!publicFiles.has(sample.id)) {
      const cached = await publicFile(ctx, sample);
      const truth = cached === null ? null : await publicTruth(ctx, sample, cached);
      let staged: string | null = null;
      if (cached !== null) {
        // The reference tool takes the format from the extension.
        staged = ctx.scratch(sample.id);
        fs.copyFileSync(cached, staged);
      }
      publicFiles.set(sample.id, staged === null || truth === null ? null : { file: staged, filename: sample.id, truth });
    }
    const files = publicFiles.get(sample.id) ?? null;
    if (files === null) {
      rows.push(...rowPlan(book).flatMap((entry) => unavailableRows('ebook', entry.caseId, [entry.spec], REFERENCE, `public sample ${sample.id} is not available`)));
      continue;
    }
    rows.push(...(await runCase(ctx, tools, files, book, classRows)));
  }
  if (ctx.quality) {
    for (const row of classRows.rows('ebook', () => REFERENCE)) {
      if (ctx.inScope('ebook', row.case)) rows.push(row);
    }
  }
  return rows;
};
