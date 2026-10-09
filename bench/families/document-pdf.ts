import fs from 'node:fs';
import path from 'node:path';
import { convertWithProject } from '../convert';
import type { FamilyRunner } from '../context';
import { REPO_ROOT } from '../config';
import type { BenchRow } from '../report';
import { measuredRow, type MetricSpec, skippedGroup, SPEC, throughputRow } from '../rows';
import { interleavedTiming } from '../stats';
import { characterErrorRatePercent, wordF1 } from '../text-metrics';
import { runTool } from '../tools';
import { readDocxStructure } from '../../tests/helpers/docx-structure';
import { aggregate, scoreStructure, type StructureTruth } from '../../tests/helpers/structure-metrics';

/**
 * PDF cases of the document family, measured on the committed golden sets (tests/fixtures/pdf-text and
 * pdf-structure, rendered by LibreOffice from sources written for this repository, with the expected text and
 * structure written from the same strings):
 *  - pdf -> txt: character error rate and word F1 of the in-process text extractor against the source text, next to
 *    Poppler `pdftotext` in its reading-order mode on the same files;
 *  - pdf -> docx: structure scores (heading, list, table, column, paragraph and reading-order) of the DOCX read back
 *    with an independent DOCX reader, next to LibreOffice's own PDF import converted to DOCX on the same files.
 * Both cases also time the end-to-end conversion of the same documents, interleaved with the reference.
 */

const TEXT_FIXTURE_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'pdf-text');
const STRUCTURE_FIXTURE_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'pdf-structure');
const TEXT_FIXTURES = ['latin', 'cjk', 'rtl', 'two-column', 'hyphenated', 'multipage', 'vertical'] as const;
const STRUCTURE_FIXTURE_COUNT = 24;
/** Documents timed one by one against the office suite, whose start-up per document is part of using it. */
const STRUCTURE_TIMED = ['doc-02', 'doc-22'] as const;
const TEXT_CASE = 'pdf-text->txt';
const STRUCTURE_CASE = 'pdf-structure->docx';
const TEXT_REFERENCE = 'pdftotext';
const STRUCTURE_REFERENCE = 'soffice';
const TEXT_SPECS: readonly MetricSpec[] = [SPEC.cer, SPEC.wordF1, SPEC.throughput];
const STRUCTURE_SPECS: readonly MetricSpec[] = [
  SPEC.headingF1,
  SPEC.listF1,
  SPEC.tableTeds,
  SPEC.columnAccuracy,
  SPEC.paragraphCountError,
  SPEC.readingOrderTau,
  SPEC.throughput,
];
const NAME_WIDTH = 2;

const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;

async function oursText(pdf: Buffer, name: string): Promise<string> {
  // The in-process engine, not the dispatcher: the dispatcher answers pdf -> txt with Poppler when it is installed.
  const { convertFile } = await import('../../src/lib/conversions/index');
  return (await convertFile(pdf, 'pdf', 'txt', {}, `${name}.pdf`)).buffer.toString('utf8');
}

const runText: FamilyRunner = async (ctx) => {
  const plan = ctx.plan(['pdftotext'], TEXT_CASE);
  if (!plan.ok) return skippedGroup('document', TEXT_CASE, TEXT_SPECS, TEXT_REFERENCE, plan);
  ctx.log(`document ${TEXT_CASE}`);
  const { pdftotext } = plan.paths;
  const documents = TEXT_FIXTURES.map((name) => ({
    name,
    file: path.join(TEXT_FIXTURE_DIR, `${name}.pdf`),
    pdf: fs.readFileSync(path.join(TEXT_FIXTURE_DIR, `${name}.pdf`)),
    truth: fs.readFileSync(path.join(TEXT_FIXTURE_DIR, `${name}.truth.txt`), 'utf8'),
  }));
  const referenceText = (file: string): string => runTool(pdftotext, ['-enc', 'UTF-8', file, '-']).stdout.toString('utf8');

  const ours = await Promise.all(documents.map((document) => oursText(document.pdf, document.name)));
  const reference = documents.map((document) => referenceText(document.file));
  const score = (texts: string[], metric: (truth: string, text: string) => number): number =>
    mean(documents.map((document, index) => metric(document.truth, texts[index])));

  const rows: BenchRow[] = [
    measuredRow('document', TEXT_CASE, SPEC.cer, score(ours, characterErrorRatePercent), score(reference, characterErrorRatePercent), TEXT_REFERENCE),
    measuredRow('document', TEXT_CASE, SPEC.wordF1, score(ours, wordF1), score(reference, wordF1), TEXT_REFERENCE),
  ];
  const timing = await interleavedTiming(
    async () => {
      for (const document of documents) await oursText(document.pdf, document.name);
    },
    () => {
      for (const document of documents) referenceText(document.file);
    },
    ctx.runs,
    ctx.warmup
  );
  rows.push(throughputRow('document', TEXT_CASE, documents.reduce((sum, document) => sum + document.pdf.length, 0), timing, TEXT_REFERENCE));
  return rows;
};

function officeImport(soffice: string, profile: string, files: string[], outDir: string): void {
  fs.mkdirSync(outDir, { recursive: true });
  runTool(soffice, [`-env:UserInstallation=${profile}`, '--headless', '--infilter=writer_pdf_import', '--convert-to', 'docx:MS Word 2007 XML', '--outdir', outDir, ...files]);
}

const runStructure: FamilyRunner = async (ctx) => {
  const plan = ctx.plan(['soffice'], STRUCTURE_CASE);
  if (!plan.ok) return skippedGroup('document', STRUCTURE_CASE, STRUCTURE_SPECS, STRUCTURE_REFERENCE, plan);
  ctx.log(`document ${STRUCTURE_CASE}`);
  const { soffice } = plan.paths;
  const profile = `file://${path.join(ctx.work, 'soffice-profile-pdf')}`;
  const names = Array.from({ length: STRUCTURE_FIXTURE_COUNT }, (_, index) => `doc-${String(index + 1).padStart(NAME_WIDTH, '0')}`);
  const files = names.map((name) => path.join(STRUCTURE_FIXTURE_DIR, `${name}.pdf`));
  const truths = names.map((name) => JSON.parse(fs.readFileSync(path.join(STRUCTURE_FIXTURE_DIR, `${name}.truth.json`), 'utf8')) as StructureTruth);

  const oursScores = [];
  for (const [index, name] of names.entries()) {
    const converted = await convertWithProject(fs.readFileSync(files[index]), 'pdf', 'docx', {}, `${name}.pdf`);
    oursScores.push(scoreStructure(truths[index], await readDocxStructure(converted.buffer)));
  }
  const referenceDir = ctx.scratch('structure-reference');
  officeImport(soffice, profile, files, referenceDir);
  const referenceScores = [];
  for (const [index, name] of names.entries()) {
    referenceScores.push(scoreStructure(truths[index], await readDocxStructure(fs.readFileSync(path.join(referenceDir, `${name}.docx`)))));
  }
  const ours = aggregate(oursScores);
  const reference = aggregate(referenceScores);

  const rows: BenchRow[] = [
    measuredRow('document', STRUCTURE_CASE, SPEC.headingF1, ours.heading.f1, reference.heading.f1, STRUCTURE_REFERENCE),
    measuredRow('document', STRUCTURE_CASE, SPEC.listF1, ours.list.f1, reference.list.f1, STRUCTURE_REFERENCE),
    measuredRow('document', STRUCTURE_CASE, SPEC.tableTeds, ours.tableTeds, reference.tableTeds, STRUCTURE_REFERENCE),
    measuredRow('document', STRUCTURE_CASE, SPEC.columnAccuracy, ours.columnAccuracy, reference.columnAccuracy, STRUCTURE_REFERENCE),
    measuredRow('document', STRUCTURE_CASE, SPEC.paragraphCountError, ours.paragraphCountError, reference.paragraphCountError, STRUCTURE_REFERENCE),
    measuredRow('document', STRUCTURE_CASE, SPEC.readingOrderTau, ours.readingOrderTau, reference.readingOrderTau, STRUCTURE_REFERENCE),
  ];

  const timed = STRUCTURE_TIMED.map((name) => ({ name, file: path.join(STRUCTURE_FIXTURE_DIR, `${name}.pdf`) }));
  const timing = await interleavedTiming(
    async () => {
      for (const document of timed) await convertWithProject(fs.readFileSync(document.file), 'pdf', 'docx', {}, `${document.name}.pdf`);
    },
    () => {
      // One office process per document, as a user converting one file runs it.
      for (const document of timed) officeImport(soffice, profile, [document.file], ctx.scratch('structure-timing'));
    },
    ctx.heavyRuns,
    ctx.warmup
  );
  const bytes = timed.reduce((sum, document) => sum + fs.statSync(document.file).size, 0);
  rows.push(throughputRow('document', STRUCTURE_CASE, bytes, timing, STRUCTURE_REFERENCE));
  return rows;
};

export const runDocumentPdf: FamilyRunner = async (ctx) => [...(await runText(ctx)), ...(await runStructure(ctx))];
