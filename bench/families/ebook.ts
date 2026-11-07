import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import type { FamilyContext, FamilyRunner } from '../context';
import { convertWithProject } from '../convert';
import { OutputIntegrityError, ToolRunError } from '../errors';
import { ClassRows } from '../class-rows';
import { companionOf, remoteSamples, type RemoteSample } from '../corpora';
import { attemptOurs, convertsRow, speedSample } from '../public-support';
import type { BenchRow, SkipKind } from '../report';
import { measuredRow, type MetricSpec, skippedRow, SPEC, speedRowId, throughputRow, unavailableSampleRows } from '../rows';
import { structureOfEpub } from '../structure-extract';
import { emptyStructure, scoreStructure, type DocumentStructure } from '../structure-metrics';
import { wordF1 } from '../text-metrics';
import { runTool } from '../tools';

/**
 * Ebook family: the conversions the product advertises from EPUB, MOBI, FB2 and PRC, on one short book (ten chapters, a list, a
 * table and a picture; 5,300 words; the EPUB is authored for the benchmark, the FB2 is written from the same text, the MOBI
 * is the EPUB converted by the reference tool, and the PRC is the same MOBI under its Palm name), and from a CBZ comic archive
 * of three pictures. The Palm, Kindle, Sony and Open eBook targets (AZW3, MOBI, PDB, LRF, OEB) are written by the reference tool
 * itself on both sides: the row measures what the product's route (its own EPUB of the source, handed to the program) loses
 * against the program reading the source directly. Those books are read back by the reference tool (as text, or as an EPUB for the
 * pictures), the RTF by the office suite.
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
 * The public samples (bench/corpus/remote-manifest.json) are public-domain books with images and linked tables of contents in
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

/** The targets only the reference tool writes (docs/policy-decisions.md, "E-book targets written by calibre"). */
const CALIBRE_BOOK_TARGETS = ['azw3', 'mobi', 'pdb', 'lrf', 'oeb'] as const;
type CalibreBookTarget = (typeof CALIBRE_BOOK_TARGETS)[number];
const isCalibreBookTarget = (target: string): target is CalibreBookTarget => (CALIBRE_BOOK_TARGETS as readonly string[]).includes(target);
/** A PDB book (PalmDOC) holds no pictures. */
const PICTURE_TARGETS = new Set<string>(['pdf', 'epub', 'azw3', 'mobi', 'lrf', 'oeb']);
/** Pages of the generated comic archive. */
const COMIC_PAGES = ['photo-a.jpg', 'photo-b.png', 'lineart.png'] as const;

interface BookCase {
  source: 'epub' | 'mobi' | 'fb2' | 'prc' | 'cbz';
  target: 'txt' | 'pdf' | 'epub' | 'rtf' | CalibreBookTarget;
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
  // The pairs added to the registry (docs/policy-decisions.md, "E-book pairs added").
  { source: 'epub', target: 'rtf' },
  { source: 'mobi', target: 'rtf' },
  { source: 'fb2', target: 'rtf' },
  ...(['epub', 'fb2', 'prc'] as const).flatMap((source) => CALIBRE_BOOK_TARGETS.map((target) => ({ source, target }))),
  ...(['txt', 'pdf', 'epub', 'rtf'] as const).map((target) => ({ source: 'prc' as const, target })),
  { source: 'cbz', target: 'pdf' },
  { source: 'cbz', target: 'epub' },
  ...CALIBRE_BOOK_TARGETS.map((target) => ({ source: 'cbz' as const, target })),
];
const caseName = (item: BookCase): string => `book.${item.source}->${item.target}`;
/** The conversions a public book gets, by its format (the targets of the generated book's cases). */
const PUBLIC_TARGETS: Readonly<Record<'epub' | 'mobi' | 'fb2', readonly BookCase['target'][]>> = { epub: ['txt', 'pdf', 'rtf'], mobi: ['epub', 'txt', 'pdf', 'rtf'], fb2: ['epub', 'txt', 'pdf', 'rtf'] };

/** A book the family converts: the generated one (three formats under the name `book`) or a public sample. */
interface Book {
  /** The name of the case: `book.<format>` or the sample id. */
  name: string;
  item: BookCase;
  sample: RemoteSample | null;
}

const bookCaseName = (book: Book): string => (book.sample ? `${book.sample.id}->${book.item.target}` : caseName(book.item));

/** The rows of a case: the case id each metric is reported under, and its spec. */
function rowPlan(book: Book): Array<{ caseId: string; spec: MetricSpec }> {
  const { item } = book;
  const name = bookCaseName(book);
  const plan: Array<{ caseId: string; spec: MetricSpec }> = item.source === 'cbz' ? [] : [{ caseId: name, spec: SPEC.wordF1 }];
  if (PICTURE_TARGETS.has(item.target) && item.target !== 'epub') plan.push({ caseId: `${name}:images`, spec: SPEC.structureRecall });
  if (item.target === 'epub') {
    plan.push({ caseId: name, spec: SPEC.epubcheckErrors });
    if (headingsMeasured(book)) plan.push({ caseId: `${name}:headings`, spec: SPEC.structurePrecision }, { caseId: `${name}:headings`, spec: SPEC.structureRecall });
    plan.push({ caseId: `${name}:images`, spec: SPEC.structureRecall });
  }
  if (measuresSpeed(item)) plan.push({ caseId: name, spec: SPEC.throughput });
  return plan;
}

/**
 * The speed of a pair is measured when the product writes it itself. A book the reference tool writes on both sides would time
 * the product's staging against the program reading the source directly, a ratio that has no backing measurement on the
 * runner yet (docs/policy-decisions.md, "E-book pairs added").
 */
const measuresSpeed = (item: BookCase): boolean => !isCalibreBookTarget(item.target);

/** Headings are scored when the truth has them: the generated book, and an EPUB source (a Kindle or FictionBook file has no heading truth to read). */
const headingsMeasured = (book: Book): boolean => book.item.source !== 'cbz' && (book.sample === null || book.sample.meta.format === 'epub');

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
  soffice: string;
}

interface Truth {
  text: string;
  structure: DocumentStructure;
  /** Pictures of the book, the denominator of the picture recall. */
  pictures: number;
}

interface Output {
  /** The file a reader opens: for an OEB book, the package file of its folder. */
  file: string;
  bytes: Buffer;
}

const CALIBRE_ENV = { ...process.env, QT_QPA_PLATFORM: 'offscreen' };

/** The book as the reference tool reads it back: its plain text, or an EPUB (for the pictures). */
function calibreReadBack(tools: Tools, scratch: (name: string) => string, output: Output, as: 'txt' | 'epub'): Buffer {
  const back = scratch(`readback.${as}`);
  runTool(tools.ebookConvert, [output.file, back], { env: CALIBRE_ENV });
  return fs.readFileSync(back);
}

/** The text LibreOffice reads from an RTF file, in a throwaway profile. */
function textOfRtf(tools: Tools, scratch: (name: string) => string, rtf: Buffer): string {
  const dir = scratch('rtf-read');
  fs.mkdirSync(dir, { recursive: true });
  const input = path.join(dir, 'in.rtf');
  fs.writeFileSync(input, rtf);
  runTool(tools.soffice, ['--headless', `-env:UserInstallation=file://${dir}/profile`, '--convert-to', 'txt:Text', '--outdir', dir, input], { env: { ...process.env, HOME: dir } });
  return fs.readFileSync(path.join(dir, 'in.txt'), 'utf8');
}

async function textOf(tools: Tools, scratch: (name: string) => string, target: BookCase['target'], output: Output): Promise<string> {
  if (target === 'txt') return output.bytes.toString('utf8');
  if (target === 'epub') return textOfEpub(output.bytes);
  if (target === 'rtf') return textOfRtf(tools, scratch, output.bytes);
  if (isCalibreBookTarget(target)) return calibreReadBack(tools, scratch, output, 'txt').toString('utf8');
  return runTool(tools.pdftotext, ['-layout', '-enc', 'UTF-8', output.file, '-']).stdout.toString('utf8');
}

/** Pictures an output holds: a PDF's by `pdfimages`, a book's by the EPUB the reference tool reads it back as. */
async function picturesOf(tools: Tools, scratch: (name: string) => string, target: BookCase['target'], output: Output): Promise<number> {
  if (target === 'pdf') return pdfImageCount(tools.pdfimages, output.file);
  if (target === 'epub') return (await structureOfEpub(output.bytes)).images.length;
  return (await structureOfEpub(calibreReadBack(tools, scratch, output, 'epub'))).images.length;
}

/** The text of a FictionBook 2 file: the `body` elements (the notes included), markup and the pictures' base64 removed. */
export function textOfFb2(xml: string): string {
  const bodies = [...xml.matchAll(/<body\b[^>]*>([\s\S]*?)<\/body>/g)].map((match) => match[1]);
  return decodeEntities(bodies.join('\n').replace(/<binary\b[\s\S]*?<\/binary>/g, ' ').replace(/<[^>]+>/g, ' '));
}

/** The pictures of a FictionBook 2 file: its `binary` parts with an image type. */
export const picturesOfFb2 = (xml: string): number => [...xml.matchAll(/<binary\b[^>]*content-type="image\/[^"]*"/gi)].length;

/** The truth of a public book, read from the file or, for a Kindle file, from the EPUB of the same book. */
async function publicTruth(ctx: FamilyContext, sample: RemoteSample, file: string): Promise<Truth | null> {
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
  const twin = await ctx.remote(companionOf(sample, 'text'));
  if (twin === null) return null;
  const bytes = fs.readFileSync(twin);
  const structure = await structureOfEpub(bytes);
  return { text: await textOfEpub(bytes), structure, pictures: structure.images.length };
}

async function qualityRows(ctx: FamilyContext, tools: Tools, truth: Truth, book: Book, ours: Output, reference: Output): Promise<BenchRow[]> {
  const { item } = book;
  const name = bookCaseName(book);
  const rows: BenchRow[] = [];
  // A comic archive has no text: its pages are the content, and they are scored as pictures below.
  if (item.source !== 'cbz') {
    rows.push(measuredRow('ebook', name, SPEC.wordF1, wordF1(truth.text, await textOf(tools, ctx.scratch, item.target, ours)), wordF1(truth.text, await textOf(tools, ctx.scratch, item.target, reference)), REFERENCE));
  }
  const recall = (found: number): number => Math.min(found, truth.pictures) / truth.pictures;
  if (PICTURE_TARGETS.has(item.target) && item.target !== 'epub' && truth.pictures > 0) {
    rows.push(measuredRow('ebook', `${name}:images`, SPEC.structureRecall, recall(await picturesOf(tools, ctx.scratch, item.target, ours)), recall(await picturesOf(tools, ctx.scratch, item.target, reference)), REFERENCE));
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

const CALIBRE_ENGINE = 'native-calibre';
const OEB_PACKAGE_FILE = /\.opf$/i;

/** The package file of an OEB folder, wherever the writer put it. */
function oebPackageFile(folder: string): string {
  const pending = [folder];
  while (pending.length > 0) {
    const directory = pending.shift() as string;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (OEB_PACKAGE_FILE.test(entry.name)) return entryPath;
    }
  }
  throw new OutputIntegrityError(`the OEB folder ${folder} holds no package file`);
}

/** Writes the product's output where a reader opens it. An OEB book is delivered as a ZIP of its folder, which is unpacked here. */
async function stageOurs(ctx: FamilyContext, target: BookCase['target'], bytes: Buffer): Promise<Output> {
  if (target !== 'oeb') {
    const file = ctx.scratch(`ours.${target}`);
    fs.writeFileSync(file, bytes);
    return { file, bytes };
  }
  const folder = ctx.scratch('ours.oeb');
  const zip = await JSZip.loadAsync(bytes);
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const destination = path.join(folder, entry.name);
    if (path.relative(folder, destination).startsWith('..')) throw new OutputIntegrityError(`the OEB ZIP holds an entry outside its folder: ${entry.name}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, await entry.async('nodebuffer'));
  }
  return { file: oebPackageFile(folder), bytes };
}

/** The reference tool's output: a file, or for OEB a folder. */
function stageReference(target: BookCase['target'], written: string): Output {
  if (target === 'oeb') return { file: oebPackageFile(written), bytes: Buffer.alloc(0) };
  return { file: written, bytes: fs.readFileSync(written) };
}

interface BookFiles {
  file: string;
  /** The name the product is told the file has. */
  filename: string;
  truth: Truth;
}

async function runCase(ctx: FamilyContext, tools: Tools, files: BookFiles, book: Book, classRows: ClassRows): Promise<BenchRow[]> {
  const { item, sample } = book;
  const name = bookCaseName(book);
  ctx.log(`ebook ${name}`);
  const sourceFile = files.file;
  const input = fs.readFileSync(sourceFile);
  const convertOurs = async (): Promise<Buffer> => {
    const converted = await convertWithProject(input, item.source, item.target, {}, files.filename);
    // A book of the five targets is written by the reference tool on both sides; the row measures the product's route to it. Anything else must be the in-process engine.
    const expectedEngine = isCalibreBookTarget(item.target) ? CALIBRE_ENGINE : undefined;
    if (expectedEngine === undefined ? converted.engineUsed.startsWith(NATIVE_ENGINE_PREFIX) : converted.engineUsed !== expectedEngine) {
      throw new OutputIntegrityError(`${name} ran on ${converted.engineUsed}; ${expectedEngine === undefined ? 'an ebook row compares the in-process engine with the reference tool, not a native engine with itself' : `a book of this target is written by ${expectedEngine}`}`);
    }
    return converted.buffer;
  };
  const convertReference = (out: string): void => {
    // The renderer behind the PDF output needs no display.
    runTool(tools.ebookConvert, [sourceFile, out], { env: CALIBRE_ENV });
  };

  const rows: BenchRow[] = [];
  let converted = true;
  if (ctx.quality) {
    if (sample) classRows.expectCases(sample.class, [...rowPlan(book).filter((entry) => entry.spec.kind !== 'throughput').map((entry) => ({ suffix: entry.caseId.slice(sample.id.length), metric: entry.spec.metric })), { suffix: `->${item.target}`, metric: SPEC.converts.metric }]);
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
      rows.push(...(await qualityRows(ctx, tools, files.truth, book, await stageOurs(ctx, item.target, attempt.value), stageReference(item.target, referenceFile))));
    }
    if (sample) classRows.addCases(sample.class, sample.id, rows);
  }
  if (ctx.speed && converted && measuresSpeed(item) && (sample === null || speedSample('ebook', sample.id))) {
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

/** The generated book in the form a source format reads: the corpus files, the MOBI under its Palm name, the pictures of the corpus bound as a comic archive. */
async function generatedFiles(ctx: FamilyContext, source: BookCase['source'], bookTruth: Truth, comicTruth: Truth): Promise<BookFiles> {
  const filename = `book.${source}`;
  if (source === 'prc') {
    // The reference tool picks its reader by the extension.
    const file = ctx.scratch(filename);
    fs.copyFileSync(ctx.corpusPath('ebooks/book.mobi'), file);
    return { file, filename, truth: bookTruth };
  }
  if (source === 'cbz') {
    const file = ctx.scratch(filename);
    const archive = new JSZip();
    // A name that sorts by the position of the page, as the tools order the pages of a comic.
    COMIC_PAGES.forEach((page, index) => archive.file(`page-${index + 1}${path.extname(page)}`, ctx.corpusBuffer(page)));
    fs.writeFileSync(file, await archive.generateAsync({ type: 'nodebuffer' }));
    return { file, filename, truth: comicTruth };
  }
  return { file: ctx.corpusPath(`ebooks/book.${source}`), filename, truth: bookTruth };
}

export const runEbook: FamilyRunner = async (ctx) => {
  const generated: Book[] = CASES.map((item) => ({ name: `book.${item.source}`, item, sample: null }));
  // A speed-only run times a few public samples; the others have only quality rows, which it does not measure.
  const published: Book[] = remoteSamples('ebook').filter((sample) => ctx.quality || speedSample('ebook', sample.id)).flatMap((sample) => {
    const source = String(sample.meta.format) as keyof typeof PUBLIC_TARGETS;
    return PUBLIC_TARGETS[source].map((target) => ({ name: sample.id, item: { source, target }, sample }));
  });
  const books = [...generated, ...published].filter((book) => ctx.inScope('ebook', bookCaseName(book)));
  if (books.length === 0) return [];
  const plan = ctx.plan(['ebook-convert', 'pdftotext', 'pdfimages', 'epubcheck', 'soffice'], 'ebook');
  if (!plan.ok) {
    const kind: SkipKind = plan.optional ? 'optional-tool' : 'missing-tool';
    return books.flatMap((book) => rowPlan(book).map(({ caseId, spec }) => skippedRow('ebook', caseId, spec, REFERENCE, kind, plan.reason)));
  }
  const tools: Tools = { ebookConvert: plan.paths['ebook-convert'], pdftotext: plan.paths.pdftotext, pdfimages: plan.paths.pdfimages, epubcheck: plan.paths.epubcheck, soffice: plan.paths.soffice };
  // The product's worker finds the program the way the reference side does.
  process.env.EBOOK_CONVERT_PATH ??= tools.ebookConvert;
  const generatedTruth: Truth = { text: fs.readFileSync(ctx.corpusPath('ebooks/book.gt.txt'), 'utf8'), structure: await structureOfEpub(ctx.corpusBuffer('ebooks/book.epub')), pictures: BOOK_PICTURES };
  const comicTruth: Truth = { text: '', structure: emptyStructure(), pictures: COMIC_PAGES.length };
  const rows: BenchRow[] = [];
  const classRows = new ClassRows();
  const publicFiles = new Map<string, BookFiles | null>();
  for (const book of books) {
    const { sample } = book;
    if (sample === null) {
      rows.push(...(await runCase(ctx, tools, await generatedFiles(ctx, book.item.source, generatedTruth, comicTruth), book, classRows)));
      continue;
    }
    if (!publicFiles.has(sample.id)) {
      const cached = await ctx.remote(sample);
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
      rows.push(...rowPlan(book).flatMap((entry) => unavailableSampleRows('ebook', entry.caseId, [entry.spec], REFERENCE, sample.id)));
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
