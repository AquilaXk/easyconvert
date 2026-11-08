import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import JSZip from 'jszip';
import { REPO_ROOT } from '../config';
import { convertWithProject } from '../convert';
import type { FamilyContext, FamilyRunner } from '../context';
import type { BenchRow } from '../report';
import { measuredRow, type MetricSpec, skippedGroup, SPEC } from '../rows';
import { normalizeOcrText } from '../../tests/helpers/ocr-cer';
import { runTool, TESSDATA_PSEUDO_TOOL } from '../tools';

/**
 * Document pairs added by entry 183 of docs/policy-decisions.md, scored by the share of the words of a text written for this
 * repository that survive, against the tool the same conversion would use without this product:
 * - Word 97-2003 and RTF from text, Markdown, HTML, reStructuredText, AbiWord (plain and gzip) and Word macro-enabled
 *   and template files (`docm`, `dotx`): the output is printed to a PDF by the office suite, read
 *   by `pdftotext`, and the reference is the office suite's own export of the same source (Markdown and reStructuredText,
 *   which it does not import, are read by it as plain text);
 * - page pictures from text, HTML, AbiWord and Word macro-enabled files: the pages are read back by Tesseract, against the
 *   office suite's PDF of the same source drawn by `pdftoppm` at its default 150 dpi, read the same way;
 * - PDF as Word 97-2003: printed and read like the Word outputs, against the office suite's own PDF import saved in the same
 *   format (PDF as PowerPoint 97-2003 was measured and is not offered: entry 183);
 * - PDF pages as WebP, AVIF, GIF, BMP and PSD: the first page read back by Tesseract after FFmpeg decodes it, against the
 *   page drawn by Ghostscript at 150 dpi, which is the renderer behind a PDF import of ImageMagick; as PostScript: the first page
 *   drawn by Ghostscript and read back by Tesseract, against the PostScript Ghostscript writes of the same PDF.
 * The pairs of Apple Pages, Palm databases and XPS have no authored source; they are converted from real files by
 * tests/office-suite-real-samples.test.ts and tests/document-pairs.test.ts.
 */

const REFERENCE = 'soffice';
const GHOSTSCRIPT = 'gs';
const SPECS: readonly MetricSpec[] = [SPEC.wordRecall];
const WORD_PATTERN = /[\p{L}\p{N}]+/gu;
const PDFTOPPM_DPI = '150';
const SECTIONS = 12;
const PDF_FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures', 'pdf-text');
/** The export filters of the office suite: an HTML page opens in its web writer, which has no export to either format unless the filter is named. */
const WORD_97_FILTER = { doc: 'doc:MS Word 97', rtf: 'rtf:Rich Text Format' } as const;
type WordTarget = keyof typeof WORD_97_FILTER;

const SENTENCES = [
  'The harbour master counted seventeen lanterns along the northern breakwater.',
  'Each lantern burned a different colour of oil, and the pilots learned the order by heart.',
  'During the storm of the third winter the keeper relit them one by one with a borrowed ladder.',
];
const sectionText = (number: number): string => SENTENCES.map((sentence) => `${sentence} (${number})`).join(' ');
const sections = Array.from({ length: SECTIONS }, (_, index) => ({ heading: `Section ${index + 1}`, text: sectionText(index + 1) }));
const TRUTH = sections.map((section) => `${section.heading} ${section.text}`).join(' ');

const XML_ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const escapeXml = (text: string): string => text.replace(/[&<>]/g, (character) => XML_ESCAPES[character]);

function abiwordXml(): string {
  const paragraphs = sections.map((section) => `<p style="Normal"><c>${escapeXml(section.heading)}</c></p>\n<p style="Normal"><c>${escapeXml(section.text)}</c></p>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<abiword xmlns="http://www.abisource.com/awml.dtd" version="0.99.2" fileformat="1.0" xml:space="preserve">\n<pagesize pagetype="Letter" orientation="portrait" width="8.500000" height="11.000000" units="in" page-scale="1.000000"/>\n<section>\n${paragraphs}\n</section>\n</abiword>\n`;
}

async function wordDocument(contentType?: string): Promise<Buffer> {
  const zip = new JSZip();
  const main = contentType ?? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${main}"/></Types>`);
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const body = sections.map((section) => `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>${escapeXml(section.heading)}</w:t></w:r></w:p><w:p><w:r><w:t>${escapeXml(section.text)}</w:t></w:r></w:p>`).join('');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

interface Source {
  extension: string;
  /** The source, written for this repository. */
  bytes: () => Promise<Buffer>;
  /** The import filter the reference names: plain text for the formats the suite has no import for, the Writer HTML import for a page. */
  infilter?: string;
  targets: readonly (WordTarget | 'png')[];
}

const PLAIN_TEXT_IMPORT = 'Text (encoded):UTF8';

const SOURCES: readonly Source[] = [
  { extension: 'txt', bytes: async () => Buffer.from(sections.map((section) => `${section.heading}\n\n${section.text}\n\n`).join('')), targets: ['doc', 'rtf', 'png'] },
  { extension: 'md', bytes: async () => Buffer.from(sections.map((section) => `## ${section.heading}\n\n${section.text}\n\n`).join('')), infilter: PLAIN_TEXT_IMPORT, targets: ['doc', 'rtf'] },
  {
    extension: 'html',
    bytes: async () => Buffer.from(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Lanterns</title></head><body>${sections.map((section) => `<h2>${section.heading}</h2><p>${section.text}</p>`).join('')}</body></html>`),
    infilter: 'HTML (StarWriter)',
    targets: ['doc', 'rtf', 'png'],
  },
  { extension: 'rst', bytes: async () => Buffer.from(sections.map((section) => `${section.heading}\n${'='.repeat(section.heading.length)}\n\n${section.text}\n\n`).join('')), infilter: PLAIN_TEXT_IMPORT, targets: ['rtf'] },
  { extension: 'abw', bytes: async () => Buffer.from(abiwordXml()), targets: ['doc', 'rtf', 'png'] },
  { extension: 'zabw', bytes: async () => gzipSync(Buffer.from(abiwordXml())), targets: ['doc', 'rtf'] },
  { extension: 'docm', bytes: () => wordDocument('application/vnd.ms-word.document.macroEnabled.main+xml'), targets: ['doc', 'rtf', 'png'] },
  { extension: 'dotx', bytes: () => wordDocument('application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml'), targets: ['doc', 'rtf'] },
];

const wordsOf = (text: string): string[] => normalizeOcrText(text).toLowerCase().match(WORD_PATTERN) ?? [];

/** Share of the words of `truth` found in `text`, each occurrence counted once. */
function wordRecall(truth: readonly string[], text: string): number {
  const available = new Map<string, number>();
  for (const word of wordsOf(text)) available.set(word, (available.get(word) ?? 0) + 1);
  let found = 0;
  for (const word of truth) {
    const left = available.get(word) ?? 0;
    if (left > 0) {
      found++;
      available.set(word, left - 1);
    }
  }
  return found / truth.length;
}

const byNumberedName = (a: string, b: string): number => a.localeCompare(b, 'en', { numeric: true });

interface Tools {
  soffice: string;
  pdftotext: string;
}

function sofficeConvert(soffice: string, profile: string, input: string, target: string, outDir: string, infilter?: string): string {
  fs.mkdirSync(outDir, { recursive: true });
  runTool(soffice, [`-env:UserInstallation=${profile}`, '--headless', ...(infilter ? [`--infilter=${infilter}`] : []), '--convert-to', target, '--outdir', outDir, input]);
  return path.join(outDir, `${path.parse(input).name}.${target.split(':')[0]}`);
}

/** The words the office suite prints on the pages of a file, read by `pdftotext`. */
function printedText(tools: Tools, profile: string, file: string, outDir: string): string {
  const pdf = sofficeConvert(tools.soffice, profile, file, 'pdf', outDir);
  return runTool(tools.pdftotext, ['-enc', 'UTF-8', pdf, '-']).stdout.toString('utf8');
}

export async function pngPages(output: Buffer, directory: string): Promise<string[]> {
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

async function runWordTargets(ctx: FamilyContext, source: Source, rows: BenchRow[]): Promise<void> {
  for (const target of source.targets.filter((candidate): candidate is WordTarget => candidate !== 'png')) {
    const caseName = `lanterns.${source.extension}->${target}`;
    if (!ctx.inScope('document', caseName)) continue;
    const plan = ctx.plan([REFERENCE, 'pdftotext'], caseName);
    if (!plan.ok) {
      rows.push(...skippedGroup('document', caseName, SPECS, REFERENCE, plan));
      continue;
    }
    ctx.log(`document ${caseName}`);
    if (!ctx.quality) continue;
    const tools: Tools = { soffice: plan.paths.soffice, pdftotext: plan.paths.pdftotext };
    const profile = `file://${path.join(ctx.work, 'soffice-profile-pairs')}`;
    const input = await source.bytes();
    const file = ctx.scratch(`lanterns.${source.extension}`);
    fs.writeFileSync(file, input);
    const truth = wordsOf(TRUTH);

    const ours = (await convertWithProject(input, source.extension, target, {}, `lanterns.${source.extension}`)).buffer;
    const oursFile = ctx.scratch(`ours-lanterns.${target}`);
    fs.writeFileSync(oursFile, ours);
    const oursRecall = wordRecall(truth, printedText(tools, profile, oursFile, ctx.scratch(`ours-${source.extension}-${target}`)));

    const referenceOut = sofficeConvert(tools.soffice, profile, file, WORD_97_FILTER[target], ctx.scratch(`ref-${source.extension}-${target}`), source.infilter);
    const referenceRecall = wordRecall(truth, printedText(tools, profile, referenceOut, ctx.scratch(`ref-print-${source.extension}-${target}`)));
    rows.push(measuredRow('document', caseName, SPEC.wordRecall, oursRecall, referenceRecall, REFERENCE));
  }
}

async function runPictures(ctx: FamilyContext, source: Source, rows: BenchRow[]): Promise<void> {
  if (!source.targets.includes('png')) return;
  const caseName = `lanterns.${source.extension}->png`;
  if (!ctx.inScope('document', caseName)) return;
  const plan = ctx.plan([REFERENCE, 'pdftoppm', 'tesseract', TESSDATA_PSEUDO_TOOL], caseName);
  if (!plan.ok) {
    rows.push(...skippedGroup('document', caseName, SPECS, REFERENCE, plan));
    return;
  }
  ctx.log(`document ${caseName}`);
  if (!ctx.quality) return;
  const { soffice, pdftoppm, tesseract } = plan.paths;
  const tessdata = plan.paths[TESSDATA_PSEUDO_TOOL];
  const profile = `file://${path.join(ctx.work, 'soffice-profile-pairs')}`;
  const env = { ...process.env, OMP_THREAD_LIMIT: '1' };
  const ocr = (picture: string): string => runTool(tesseract, [picture, 'stdout', '-l', 'eng', '--tessdata-dir', tessdata, '--psm', '3'], { env }).stdout.toString('utf8');
  const read = (files: string[]): string => files.map(ocr).join('\n');
  const input = await source.bytes();
  const file = ctx.scratch(`lanterns.${source.extension}`);
  fs.writeFileSync(file, input);
  const truth = wordsOf(TRUTH);

  const ours = (await convertWithProject(input, source.extension, 'png', {}, `lanterns.${source.extension}`)).buffer;
  const oursRecall = wordRecall(truth, read(await pngPages(ours, ctx.scratch(`ours-pictures-${source.extension}`))));

  const pdf = sofficeConvert(soffice, profile, file, 'pdf', ctx.scratch(`ref-pdf-${source.extension}`), source.infilter === PLAIN_TEXT_IMPORT ? source.infilter : undefined);
  const referenceDir = ctx.scratch(`ref-pictures-${source.extension}`);
  fs.mkdirSync(referenceDir, { recursive: true });
  runTool(pdftoppm, ['-r', PDFTOPPM_DPI, '-png', pdf, path.join(referenceDir, 'page')]);
  const referencePages = fs.readdirSync(referenceDir).filter((name) => name.endsWith('.png')).sort(byNumberedName).map((name) => path.join(referenceDir, name));
  rows.push(measuredRow('document', caseName, SPEC.wordRecall, oursRecall, wordRecall(truth, read(referencePages)), REFERENCE));
}

/** The text of the PDF fixture and its truth, the way the PDF cases of the family read them. */
function pdfFixture(name: string): { file: string; bytes: Buffer; truth: string[] } {
  const file = path.join(PDF_FIXTURES, `${name}.pdf`);
  return { file, bytes: fs.readFileSync(file), truth: wordsOf(fs.readFileSync(path.join(PDF_FIXTURES, `${name}.truth.txt`), 'utf8')) };
}

async function runPdfOffice(ctx: FamilyContext, target: 'doc', rows: BenchRow[]): Promise<void> {
  const caseName = `latin.pdf->${target}`;
  if (!ctx.inScope('document', caseName)) return;
  const plan = ctx.plan([REFERENCE, 'pdftotext'], caseName);
  if (!plan.ok) {
    rows.push(...skippedGroup('document', caseName, SPECS, REFERENCE, plan));
    return;
  }
  ctx.log(`document ${caseName}`);
  if (!ctx.quality) return;
  const tools: Tools = { soffice: plan.paths.soffice, pdftotext: plan.paths.pdftotext };
  const profile = `file://${path.join(ctx.work, 'soffice-profile-pairs')}`;
  const latin = pdfFixture('latin');
  const ours = (await convertWithProject(latin.bytes, 'pdf', target, {}, 'latin.pdf')).buffer;
  const oursFile = ctx.scratch(`ours-latin.${target}`);
  fs.writeFileSync(oursFile, ours);
  const oursRecall = wordRecall(latin.truth, printedText(tools, profile, oursFile, ctx.scratch(`ours-pdf-${target}`)));
  const referenceOut = sofficeConvert(tools.soffice, profile, latin.file, WORD_97_FILTER.doc, ctx.scratch(`ref-pdf-${target}`), 'writer_pdf_import');
  rows.push(measuredRow('document', caseName, SPEC.wordRecall, oursRecall, wordRecall(latin.truth, printedText(tools, profile, referenceOut, ctx.scratch(`ref-pdf-print-${target}`))), REFERENCE));
}

const PAGE_TARGETS = ['webp', 'avif', 'gif', 'bmp', 'psd'] as const;
/** The fixture holds a heading and a paragraph on each of its three pages. */
const FIRST_PAGE_PARAGRAPHS = 2;

async function runPdfPages(ctx: FamilyContext, target: (typeof PAGE_TARGETS)[number] | 'ps', rows: BenchRow[]): Promise<void> {
  const caseName = `multipage.pdf->${target}`;
  if (!ctx.inScope('document', caseName)) return;
  const plan = ctx.plan([GHOSTSCRIPT, ...(target === 'ps' ? [] : ['ffmpeg']), 'tesseract', TESSDATA_PSEUDO_TOOL], caseName);
  if (!plan.ok) {
    rows.push(...skippedGroup('document', caseName, SPECS, GHOSTSCRIPT, plan));
    return;
  }
  ctx.log(`document ${caseName}`);
  if (!ctx.quality) return;
  const { gs, tesseract } = plan.paths;
  const tessdata = plan.paths[TESSDATA_PSEUDO_TOOL];
  const document = fs.readFileSync(path.join(PDF_FIXTURES, 'multipage.pdf'));
  const firstPageTruth = wordsOf(fs.readFileSync(path.join(PDF_FIXTURES, 'multipage.truth.txt'), 'utf8').split(/\n\s*\n/).slice(0, FIRST_PAGE_PARAGRAPHS).join(' '));
  const ours = (await convertWithProject(document, 'pdf', target, { multiPageOutput: 'first' }, 'multipage.pdf')).buffer;
  const oursFile = ctx.scratch(`ours-multipage.${target}`);
  fs.writeFileSync(oursFile, ours);
  const source = ctx.scratch('multipage.pdf');
  fs.writeFileSync(source, document);
  const env = { ...process.env, OMP_THREAD_LIMIT: '1' };
  const ocr = (file: string): string => runTool(tesseract, [file, 'stdout', '-l', 'eng', '--tessdata-dir', tessdata, '--psm', '3'], { env }).stdout.toString('utf8');
  /** The first page of a PDF or PostScript file drawn by Ghostscript at 150 dpi. */
  const render = (file: string, png: string): string => {
    runTool(gs, ['-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-dFirstPage=1', '-dLastPage=1', '-sDEVICE=png16m', `-r${PDFTOPPM_DPI}`, `-sOutputFile=${png}`, file]);
    return png;
  };

  if (target === 'ps') {
    const referenceFile = ctx.scratch('ref-multipage.ps');
    runTool(gs, ['-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-dFirstPage=1', '-dLastPage=1', '-sDEVICE=ps2write', `-sOutputFile=${referenceFile}`, source]);
    const oursText = ocr(render(oursFile, ctx.scratch('ours-ps-page.png')));
    rows.push(measuredRow('document', caseName, SPEC.wordRecall, wordRecall(firstPageTruth, oursText), wordRecall(firstPageTruth, ocr(render(referenceFile, ctx.scratch('ref-ps-page.png')))), GHOSTSCRIPT));
    return;
  }

  const decoded = ctx.scratch(`ours-multipage-${target}.png`);
  runTool(plan.paths.ffmpeg, ['-v', 'error', '-y', '-i', oursFile, '-frames:v', '1', decoded]);
  rows.push(measuredRow('document', caseName, SPEC.wordRecall, wordRecall(firstPageTruth, ocr(decoded)), wordRecall(firstPageTruth, ocr(render(source, ctx.scratch('ref-multipage.png')))), GHOSTSCRIPT));
}

export const runDocumentPairs: FamilyRunner = async (ctx) => {
  const rows: BenchRow[] = [];
  for (const source of SOURCES) {
    await runWordTargets(ctx, source, rows);
    await runPictures(ctx, source, rows);
  }
  await runPdfOffice(ctx, 'doc', rows);
  for (const target of PAGE_TARGETS) await runPdfPages(ctx, target, rows);
  await runPdfPages(ctx, 'ps', rows);
  return rows;
};
