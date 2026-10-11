import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { REPO_ROOT } from '../config';
import { convertWithProject } from '../convert';
import type { FamilyContext, FamilyRunner } from '../context';
import { OutputIntegrityError } from '../errors';
import type { BenchRow } from '../report';
import { measuredRow, type MetricSpec, skippedGroup, SPEC, throughputRow, speedRowId } from '../rows';
import { normalizeOcrText } from '../../tests/helpers/ocr-cer';
import { runTool, TESSDATA_PSEUDO_TOOL } from '../tools';

/**
 * Presentations and spreadsheets to PDF and images, against the office suite's own export. The sources are authored for
 * this repository: a three-slide deck with shapes and a table (tests/fixtures/golden/office, checked against the SHA-256 of
 * the golden corpus manifest) and a two-sheet workbook with column widths, number formats, SUM formulas and wrapped text
 * (bench/corpus/office, written by bench/corpus/generate-office.ts together with the text it displays). The words of
 * the deck are read from its XML by this file and those of the workbook from the text written with it, which makes the
 * truth independent of both converters, and a conversion is scored by the share of those words that survive:
 * - PDF: `pdftotext` of the output; `pdffonts` counts fonts that are not embedded; `qpdf --check` counts structural faults;
 * - images: the pages of the output (a ZIP of PNG pages, which is what the product returns for a multi-page file) read back
 *   by Tesseract, against the office suite's PDF drawn by `pdftoppm` at its default 150 dpi, read the same way.
 * The office suite is the reference for the time as well: one cold `soffice --convert-to pdf` per document, plus
 * `pdftoppm` for the images. The product keeps a warm office process, which is the point of measuring it.
 */

const REFERENCE = 'soffice';
const GOLDEN_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'golden');
const GOLDEN_MANIFEST = path.join(GOLDEN_DIR, 'corpus-manifest.json');
const PDFTOPPM_DPI = '150';
const SOURCES = [
  { file: 'drawingml-shapes-presentation.pptx', format: 'pptx', origin: 'golden' },
  { file: 'workbook.xlsx', format: 'xlsx', origin: 'corpus' },
] as const;
const TARGETS = ['pdf', 'png'] as const;
type Target = (typeof TARGETS)[number];
const PDF_SPECS: readonly MetricSpec[] = [SPEC.wordRecall, SPEC.unembeddedFonts, SPEC.pdfCheckFailures, SPEC.throughput];
const IMAGE_SPECS: readonly MetricSpec[] = [SPEC.wordRecall, SPEC.throughput];
const XML_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const WORD_PATTERN = /[\p{L}\p{N}]+/gu;

interface GoldenEntry {
  relativePath: string;
  sha256: string;
}

/** The source file, verified against the SHA-256 of the golden corpus manifest. */
function goldenFile(name: string): string {
  const entries = (JSON.parse(fs.readFileSync(GOLDEN_MANIFEST, 'utf8')) as { files: GoldenEntry[] }).files;
  const entry = entries.find((candidate) => path.basename(candidate.relativePath) === name);
  if (!entry) throw new OutputIntegrityError(`${name} is not in the golden corpus manifest`);
  const file = path.join(REPO_ROOT, entry.relativePath);
  if (createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== entry.sha256) {
    throw new OutputIntegrityError(`${name} does not match the SHA-256 of tests/fixtures/golden/corpus-manifest.json`);
  }
  return file;
}

/** Names in reading order: slide2 before slide10, page-9 before page-10. */
const byNumberedName = (a: string, b: string): number => a.localeCompare(b, 'en', { numeric: true });

const decodeEntities = (text: string): string => text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => XML_ENTITIES[name]);

function textOf(xml: string, element: RegExp): string[] {
  return [...xml.matchAll(element)].map((match) => decodeEntities(match[1].replace(/<[^>]+>/g, '')));
}

/** The words of a deck, read from the text runs of its slides. */
async function slideWords(file: string): Promise<string[]> {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort(byNumberedName);
  const texts = await Promise.all(slides.map(async (name) => textOf((await zip.file(name)?.async('string')) ?? '', /<a:t>([^<]*)<\/a:t>/g)));
  return wordsOf(texts.flat().join(' '));
}

function wordsOf(text: string): string[] {
  return normalizeOcrText(text).toLowerCase().match(WORD_PATTERN) ?? [];
}

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

function pdfText(pdftotext: string, pdf: string): string {
  return runTool(pdftotext, ['-enc', 'UTF-8', pdf, '-']).stdout.toString('utf8');
}

/** Fonts a PDF does not embed, from the `emb` column of `pdffonts` (two header lines, one line per font). */
function unembeddedFonts(pdffonts: string, pdf: string): number {
  const lines = runTool(pdffonts, [pdf]).stdout.toString('utf8').split('\n').slice(2).filter((line) => line.trim() !== '');
  return lines.filter((line) => /\sno\s+(?:yes|no)\s+(?:yes|no)\s+\d+\s+\d+\s*$/.test(line)).length;
}

/** 1 when `qpdf --check` reports an error or a warning, else 0. */
function structuralFaults(qpdf: string, pdf: string): number {
  try {
    runTool(qpdf, ['--check', pdf]);
    return 0;
  } catch {
    return 1;
  }
}

function sofficePdf(soffice: string, profile: string, input: string, outDir: string): string {
  fs.mkdirSync(outDir, { recursive: true });
  runTool(soffice, [`-env:UserInstallation=${profile}`, '--headless', '--convert-to', 'pdf', '--outdir', outDir, input]);
  return path.join(outDir, `${path.parse(input).name}.pdf`);
}

function pages(pdftoppm: string, pdf: string, outDir: string): string[] {
  fs.mkdirSync(outDir, { recursive: true });
  runTool(pdftoppm, ['-r', PDFTOPPM_DPI, '-png', pdf, path.join(outDir, 'page')]);
  return fs.readdirSync(outDir).filter((name) => name.endsWith('.png')).sort(byNumberedName).map((name) => path.join(outDir, name));
}

export const runDocumentOffice: FamilyRunner = async (ctx) => {
  const rows: BenchRow[] = [];
  for (const source of SOURCES) {
    for (const target of TARGETS) {
      if (ctx.inScope('document', `${source.file}->${target}`)) rows.push(...(await runCase(ctx, source, target)));
    }
  }
  return rows;
};

async function runCase(ctx: FamilyContext, source: (typeof SOURCES)[number], target: Target): Promise<BenchRow[]> {
  const { file: name, format } = source;
  const caseName = `${name}->${target}`;
  const needs = target === 'pdf' ? ['soffice', 'pdftotext', 'pdffonts', 'qpdf'] : ['soffice', 'pdftoppm', 'tesseract', TESSDATA_PSEUDO_TOOL];
  const plan = ctx.plan(needs, caseName);
  if (!plan.ok) return skippedGroup('document', caseName, target === 'pdf' ? PDF_SPECS : IMAGE_SPECS, REFERENCE, plan);
  ctx.log(`document ${caseName}`);
  const { soffice } = plan.paths;
  const file = source.origin === 'golden' ? goldenFile(name) : ctx.corpusPath(`office/${name}`);
  const input = fs.readFileSync(file);
  const truth = source.origin === 'golden' ? await slideWords(file) : wordsOf(fs.readFileSync(ctx.corpusPath('office/workbook.gt.txt'), 'utf8'));
  const profile = `file://${path.join(ctx.work, 'soffice-profile-office')}`;
  const rows: BenchRow[] = [];

  const ours = async (): Promise<Buffer> => (await convertWithProject(input, format, target, {}, name)).buffer;
  if (target === 'pdf') {
    const { pdftotext, pdffonts, qpdf } = plan.paths;
    const reference = (outDir: string): string => sofficePdf(soffice, profile, file, outDir);
    if (ctx.quality) {
      const measure = (pdf: string): { recall: number; fonts: number; faults: number } => ({ recall: wordRecall(truth, pdfText(pdftotext, pdf)), fonts: unembeddedFonts(pdffonts, pdf), faults: structuralFaults(qpdf, pdf) });
      const oursFile = ctx.scratch('ours-office.pdf');
      fs.writeFileSync(oursFile, await ours());
      const o = measure(oursFile);
      const r = measure(reference(ctx.scratch('ref-office')));
      rows.push(
        measuredRow('document', caseName, SPEC.wordRecall, o.recall, r.recall, REFERENCE),
        measuredRow('document', caseName, SPEC.unembeddedFonts, o.fonts, r.fonts, REFERENCE),
        measuredRow('document', caseName, SPEC.pdfCheckFailures, o.faults, r.faults, REFERENCE)
      );
    }
    if (ctx.speed) {
      const timing = await ctx.time(speedRowId('document', caseName), async () => void (await ours()), () => void reference(ctx.scratch('timing-office')), 'heavy');
      rows.push(throughputRow('document', caseName, input.length, timing, REFERENCE));
    }
    return rows;
  }

  const { pdftoppm, tesseract } = plan.paths;
  const tessdata = plan.paths[TESSDATA_PSEUDO_TOOL];
  const env = { ...process.env, OMP_THREAD_LIMIT: '1' };
  const ocr = (picture: string): string => runTool(tesseract, [picture, 'stdout', '-l', 'eng', '--tessdata-dir', tessdata, '--psm', '3'], { env }).stdout.toString('utf8');
  const reference = (outDir: string): string[] => pages(pdftoppm, sofficePdf(soffice, profile, file, outDir), path.join(outDir, 'pages'));
  if (ctx.quality) {
    const archive = await JSZip.loadAsync(await ours());
    const oursDir = ctx.scratch('ours-pages');
    fs.mkdirSync(oursDir, { recursive: true });
    const oursPages = await Promise.all(
      Object.keys(archive.files)
        .filter((entry) => entry.endsWith('.png'))
        .sort(byNumberedName)
        .map(async (entry) => {
          const target = path.join(oursDir, path.basename(entry));
          fs.writeFileSync(target, await (archive.file(entry) as JSZip.JSZipObject).async('nodebuffer'));
          return target;
        })
    );
    const read = (files: string[]): string => files.map(ocr).join('\n');
    rows.push(measuredRow('document', caseName, SPEC.wordRecall, wordRecall(truth, read(oursPages)), wordRecall(truth, read(reference(ctx.scratch('ref-office-images')))), REFERENCE));
  }
  if (ctx.speed) {
    const timing = await ctx.time(speedRowId('document', caseName), async () => void (await ours()), () => void reference(ctx.scratch('timing-office-images')), 'heavy');
    rows.push(throughputRow('document', caseName, input.length, timing, REFERENCE));
  }
  return rows;
}
