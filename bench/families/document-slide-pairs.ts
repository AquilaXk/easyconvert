import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { convertWithProject } from '../convert';
import type { FamilyContext, FamilyRunner } from '../context';
import type { BenchRow } from '../report';
import { measuredRow, type MetricSpec, skippedGroup, SPEC } from '../rows';
import { runTool, TESSDATA_PSEUDO_TOOL } from '../tools';
import { byNumberedName, goldenFile, pages, pdfText, slideWords, sofficePdf, wordRecall, wordsOf } from './document-office';

/**
 * Presentation, workbook and table pairs added by entry 185 of docs/policy-decisions.md, scored by the share of the words of a
 * source written for this repository that survive, against the office suite's own export of the same source:
 * - page pictures (PNG) from slide shows, templates and macro presentations, from a macro workbook and from a CSV table: the pages
 *   of the output (a ZIP of PNG pages when there are several) read back by Tesseract, against the office suite's PDF drawn by
 *   `pdftoppm` at its default 150 dpi, read the same way;
 * - PostScript pictures from every presentation format: the first picture drawn by Ghostscript and read back by Tesseract, against
 *   the picture the office suite's own PostScript export draws of the first slide, read the same way (the suite writes the first
 *   slide only; the product writes one picture for every slide, so the first is the one that is compared);
 * - Markdown: the text of the output against the text of the PDF the office suite prints of the same source, because the suite has no
 *   Markdown filter for a presentation (its filter is a word processor's) and so has no export of its own to compare with;
 * - the other presentation formats (PowerPoint 97-2003, OpenDocument, PowerPoint) from templates, slide shows and macro presentations,
 *   and the PDF, HTML and text of a macro presentation: the output is printed to a PDF by the office suite and read by `pdftotext`,
 *   against the office suite's own export of the same source printed the same way (against its PDF text for HTML and text, which the
 *   suite does not write for a presentation).
 * The sources are the golden deck of the document family (tests/fixtures/golden/office) and its workbook (bench/corpus/office) saved
 * as the other formats by the office suite, or given the content type of the macro, slide show and template variants of the package.
 * Keynote and Kingsoft files have no authored source; they are converted from real files by tests/presentation-pairs.test.ts and
 * tests/office-suite-real-samples.test.ts.
 */

const REFERENCE = 'soffice';
const DECK = 'drawingml-shapes-presentation.pptx';
const PDFTOPPM_DPI = '150';
const SPECS: readonly MetricSpec[] = [SPEC.wordRecall];
const PRESENTATION_MAIN = 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
const WORKBOOK_MAIN = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
/** The main-part content types of the package variants of a PowerPoint deck and an Excel workbook. */
const VARIANT_MAIN: Readonly<Record<string, string>> = {
  ppsx: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml',
  potx: 'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml',
  pptm: 'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
};
/** The office suite's filters that save a deck again in another format. */
const RESAVE_FILTER: Readonly<Record<string, string>> = { ppt: 'ppt:MS PowerPoint 97', pps: 'ppt:MS PowerPoint 97', dps: 'ppt:MS PowerPoint 97', pot: 'pot:MS PowerPoint 97 Vorlage', odp: 'odp:impress8' };
const WRITE_FILTER: Readonly<Record<string, string>> = { ppt: 'ppt:MS PowerPoint 97', odp: 'odp:impress8', pptx: 'pptx:Impress MS PowerPoint 2007 XML' };
const CSV_ROWS = 90;

interface Tools {
  soffice: string;
  pdftotext: string;
  pdftoppm: string;
  tesseract: string;
  tessdata: string;
  gs?: string;
}

/** The package with the main part of its content types changed: how a macro, slide show or template variant differs from the plain format. */
async function retyped(bytes: Buffer, from: string, to: string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(bytes);
  const types = await (zip.file('[Content_Types].xml') as JSZip.JSZipObject).async('string');
  if (!types.includes(from)) throw new Error(`the package has no main part of type ${from}`);
  zip.file('[Content_Types].xml', types.replace(from, to));
  return zip.generateAsync({ type: 'nodebuffer' });
}

function sofficeSave(tools: Tools, profile: string, input: string, target: string, outDir: string): string {
  fs.mkdirSync(outDir, { recursive: true });
  runTool(tools.soffice, [`-env:UserInstallation=${profile}`, '--headless', '--convert-to', target, '--outdir', outDir, input]);
  return path.join(outDir, `${path.parse(input).name}.${target.split(':')[0]}`);
}

/** The deck as a file of `extension`, written for this repository: the golden deck, a package variant of it, or the office suite's save of it. */
async function deckAs(ctx: FamilyContext, tools: Tools, profile: string, extension: string): Promise<Buffer> {
  const golden = fs.readFileSync(goldenFile(DECK));
  if (extension === 'pptx') return golden;
  if (VARIANT_MAIN[extension] !== undefined) return retyped(golden, PRESENTATION_MAIN, VARIANT_MAIN[extension]);
  const source = ctx.scratch(`deck-source.pptx`);
  fs.writeFileSync(source, golden);
  return fs.readFileSync(sofficeSave(tools, profile, source, RESAVE_FILTER[extension], ctx.scratch(`deck-as-${extension}`)));
}

function planFor(ctx: FamilyContext, caseName: string, needs: readonly string[]): { tools: Tools } | { rows: BenchRow[] } {
  const plan = ctx.plan([REFERENCE, 'pdftotext', 'pdftoppm', 'tesseract', TESSDATA_PSEUDO_TOOL, ...needs], caseName);
  if (!plan.ok) return { rows: skippedGroup('document', caseName, SPECS, REFERENCE, plan) };
  const { soffice, pdftotext, pdftoppm, tesseract, gs } = plan.paths;
  return { tools: { soffice, pdftotext, pdftoppm, tesseract, tessdata: plan.paths[TESSDATA_PSEUDO_TOOL], gs } };
}

const ocrOf = (tools: Tools) => (picture: string): string =>
  runTool(tools.tesseract, [picture, 'stdout', '-l', 'eng', '--tessdata-dir', tools.tessdata, '--psm', '3'], { env: { ...process.env, OMP_THREAD_LIMIT: '1' } }).stdout.toString('utf8');

/** The PNG pages of an output: the file itself, or the entries of the ZIP that several pages arrive in. */
async function pngPages(output: Buffer, directory: string): Promise<string[]> {
  fs.mkdirSync(directory, { recursive: true });
  if (output.subarray(0, 2).toString('latin1') !== 'PK') {
    const file = path.join(directory, 'page-1.png');
    fs.writeFileSync(file, output);
    return [file];
  }
  const archive = await JSZip.loadAsync(output);
  const files: string[] = [];
  for (const name of Object.keys(archive.files).filter((entry) => entry.endsWith('.png')).sort(byNumberedName)) {
    const file = path.join(directory, path.basename(name));
    fs.writeFileSync(file, await (archive.file(name) as JSZip.JSZipObject).async('nodebuffer'));
    files.push(file);
  }
  return files;
}

async function runPictures(ctx: FamilyContext, caseName: string, source: { extension: string; bytes: Buffer; truth: readonly string[] }, rows: BenchRow[]): Promise<void> {
  const planned = planFor(ctx, caseName, []);
  if ('rows' in planned) return void rows.push(...planned.rows);
  ctx.log(`document ${caseName}`);
  if (!ctx.quality) return;
  const { tools } = planned;
  const profile = `file://${path.join(ctx.work, 'soffice-profile-slide-pairs')}`;
  const ocr = ocrOf(tools);
  const read = (files: string[]): string => files.map(ocr).join('\n');
  const file = ctx.scratch(`source.${source.extension}`);
  fs.writeFileSync(file, source.bytes);
  const ours = (await convertWithProject(source.bytes, source.extension, 'png', {}, `source.${source.extension}`)).buffer;
  const oursRecall = wordRecall(source.truth, read(await pngPages(ours, ctx.scratch(`ours-pictures-${source.extension}`))));
  const referencePages = pages(tools.pdftoppm, sofficePdf(tools.soffice, profile, file, ctx.scratch(`ref-pdf-${source.extension}`)), ctx.scratch(`ref-pictures-${source.extension}`));
  rows.push(measuredRow('document', caseName, SPEC.wordRecall, oursRecall, wordRecall(source.truth, read(referencePages)), REFERENCE));
}

/** The first slide of a deck: its text runs. */
async function firstSlideWords(file: string): Promise<string[]> {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const xml = await (zip.file('ppt/slides/slide1.xml') as JSZip.JSZipObject).async('string');
  return wordsOf([...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((match) => match[1]).join(' '));
}

function drawnEps(tools: Tools, eps: string, png: string): string {
  runTool(tools.gs as string, ['-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-dEPSCrop', '-sDEVICE=png16m', `-r${PDFTOPPM_DPI}`, `-sOutputFile=${png}`, eps]);
  return png;
}

async function runPostScript(ctx: FamilyContext, extension: string, rows: BenchRow[]): Promise<void> {
  const caseName = `deck.${extension}->eps`;
  if (!ctx.inScope('document', caseName)) return;
  const planned = planFor(ctx, caseName, ['gs']);
  if ('rows' in planned) return void rows.push(...planned.rows);
  ctx.log(`document ${caseName}`);
  if (!ctx.quality) return;
  const { tools } = planned;
  const profile = `file://${path.join(ctx.work, 'soffice-profile-slide-pairs')}`;
  const ocr = ocrOf(tools);
  const truth = await firstSlideWords(goldenFile(DECK));
  const bytes = await deckAs(ctx, tools, profile, extension);
  const file = ctx.scratch(`deck.${extension}`);
  fs.writeFileSync(file, bytes);
  const output = (await convertWithProject(bytes, extension, 'eps', {}, `deck.${extension}`)).buffer;
  const first = output.subarray(0, 2).toString('latin1') === 'PK' ? await (await JSZip.loadAsync(output)).file(/\.eps$/).sort((a, b) => byNumberedName(a.name, b.name))[0].async('nodebuffer') : output;
  const oursEps = ctx.scratch('ours-deck.eps');
  fs.writeFileSync(oursEps, first);
  const oursText = ocr(drawnEps(tools, oursEps, ctx.scratch('ours-deck-eps.png')));
  const referenceEps = sofficeSave(tools, profile, file, 'eps', ctx.scratch(`ref-eps-${extension}`));
  const referenceText = ocr(drawnEps(tools, referenceEps, ctx.scratch('ref-deck-eps.png')));
  rows.push(measuredRow('document', caseName, SPEC.wordRecall, wordRecall(truth, oursText), wordRecall(truth, referenceText), REFERENCE));
}

async function runMarkdown(ctx: FamilyContext, extension: string, rows: BenchRow[]): Promise<void> {
  const caseName = `deck.${extension}->md`;
  if (!ctx.inScope('document', caseName)) return;
  const planned = planFor(ctx, caseName, []);
  if ('rows' in planned) return void rows.push(...planned.rows);
  ctx.log(`document ${caseName}`);
  if (!ctx.quality) return;
  const { tools } = planned;
  const profile = `file://${path.join(ctx.work, 'soffice-profile-slide-pairs')}`;
  const truth = await slideWords(goldenFile(DECK));
  const bytes = await deckAs(ctx, tools, profile, extension);
  const file = ctx.scratch(`deck.${extension}`);
  fs.writeFileSync(file, bytes);
  const markdown = (await convertWithProject(bytes, extension, 'md', {}, `deck.${extension}`)).buffer.toString('utf8');
  const printed = pdfText(tools.pdftotext, sofficePdf(tools.soffice, profile, file, ctx.scratch(`ref-md-${extension}`)));
  rows.push(measuredRow('document', caseName, SPEC.wordRecall, wordRecall(truth, markdown), wordRecall(truth, printed), REFERENCE));
}

/** The words of an output: its text for HTML and plain text, else what the office suite prints of the file, read by `pdftotext`. */
function outputText(tools: Tools, profile: string, output: Buffer, target: string, directory: string): string {
  if (target === 'txt') return output.toString('utf8');
  if (target === 'html') return output.toString('utf8').replace(/<[^>]*>/g, ' ');
  const file = path.join(directory, `ours.${target}`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(file, output);
  return pdfText(tools.pdftotext, target === 'pdf' ? file : sofficePdf(tools.soffice, profile, file, path.join(directory, 'printed')));
}

async function runOfficeFormat(ctx: FamilyContext, extension: string, target: string, rows: BenchRow[]): Promise<void> {
  const caseName = `deck.${extension}->${target}`;
  if (!ctx.inScope('document', caseName)) return;
  const planned = planFor(ctx, caseName, []);
  if ('rows' in planned) return void rows.push(...planned.rows);
  ctx.log(`document ${caseName}`);
  if (!ctx.quality) return;
  const { tools } = planned;
  const profile = `file://${path.join(ctx.work, 'soffice-profile-slide-pairs')}`;
  const truth = await slideWords(goldenFile(DECK));
  const bytes = await deckAs(ctx, tools, profile, extension);
  const file = ctx.scratch(`deck.${extension}`);
  fs.writeFileSync(file, bytes);
  const ours = (await convertWithProject(bytes, extension, target, {}, `deck.${extension}`)).buffer;
  const oursRecall = wordRecall(truth, outputText(tools, profile, ours, target, ctx.scratch(`ours-${extension}-${target}`)));
  // The suite writes a presentation in another presentation format; for the PDF, HTML and text of a deck its own export is the PDF.
  let referenceText: string;
  if (WRITE_FILTER[target] === undefined) {
    referenceText = pdfText(tools.pdftotext, sofficePdf(tools.soffice, profile, file, ctx.scratch(`ref-${extension}-${target}`)));
  } else {
    const written = sofficeSave(tools, profile, file, WRITE_FILTER[target], ctx.scratch(`ref-${extension}-${target}`));
    referenceText = pdfText(tools.pdftotext, sofficePdf(tools.soffice, profile, written, ctx.scratch(`ref-print-${extension}-${target}`)));
  }
  rows.push(measuredRow('document', caseName, SPEC.wordRecall, oursRecall, wordRecall(truth, referenceText), REFERENCE));
}

const tableCsv = (): { bytes: Buffer; truth: string[] } => {
  const lines = ['city,country,population', ...Array.from({ length: CSV_ROWS }, (_, row) => `Harbourtown${row + 1},Lanternia,${1000 + row}`)];
  return { bytes: Buffer.from(`${lines.join('\n')}\n`), truth: wordsOf(lines.join(' ')) };
};

export const runDocumentSlidePairs: FamilyRunner = async (ctx) => {
  const rows: BenchRow[] = [];
  const preparing = planFor(ctx, 'deck.pptx->png', []);
  const tools = 'tools' in preparing ? preparing.tools : undefined;
  const profile = `file://${path.join(ctx.work, 'soffice-profile-slide-pairs')}`;

  for (const extension of ['ppsx', 'potx', 'pptm', 'pot']) {
    const caseName = `deck.${extension}->png`;
    if (!ctx.inScope('document', caseName)) continue;
    if (tools === undefined) {
      rows.push(...(preparing as { rows: BenchRow[] }).rows);
      continue;
    }
    await runPictures(ctx, caseName, { extension, bytes: await deckAs(ctx, tools, profile, extension), truth: await slideWords(goldenFile(DECK)) }, rows);
  }

  const workbookCase = 'workbook.xlsm->png';
  if (ctx.inScope('document', workbookCase)) {
    const workbook = fs.readFileSync(ctx.corpusPath('office/workbook.xlsx'));
    await runPictures(ctx, workbookCase, { extension: 'xlsm', bytes: await retyped(workbook, WORKBOOK_MAIN, VARIANT_MAIN.xlsm), truth: wordsOf(fs.readFileSync(ctx.corpusPath('office/workbook.gt.txt'), 'utf8')) }, rows);
  }

  const tableCase = 'table.csv->png';
  if (ctx.inScope('document', tableCase)) {
    const table = tableCsv();
    await runPictures(ctx, tableCase, { extension: 'csv', bytes: table.bytes, truth: table.truth }, rows);
  }

  for (const extension of ['pptx', 'ppt', 'odp', 'ppsx', 'pptm', 'pps', 'dps']) {
    await runPostScript(ctx, extension, rows);
    await runMarkdown(ctx, extension, rows);
  }
  for (const [extension, target] of [['pot', 'ppt'], ['potx', 'odp'], ['potx', 'ppt'], ['ppsx', 'ppt'], ['pptm', 'odp'], ['pptm', 'ppt'], ['pptm', 'pptx'], ['pptm', 'pdf'], ['pptm', 'html'], ['pptm', 'txt']]) {
    await runOfficeFormat(ctx, extension, target, rows);
  }
  return rows;
};
