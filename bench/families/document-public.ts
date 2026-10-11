import fs from 'node:fs';
import path from 'node:path';
import { normalizeOcrText } from '../../tests/helpers/ocr-cer';
import type { FamilyContext } from '../context';
import { convertInProcess } from '../convert';
import { OutputIntegrityError, ToolRunError } from '../errors';
import { sourceText } from '../office-words';
import { ClassRows } from '../class-rows';
import { remoteSamples, type RemoteSample } from '../corpora';
import { attemptOurs, convertsRow, speedSample } from '../public-support';
import { ReferenceServer } from '../reference-server';
import type { BenchRow } from '../report';
import { measuredRow, type MetricSpec, skippedGroup, SPEC, speedRowId, throughputRow, unavailableSampleRows } from '../rows';
import { OLEFILE_PSEUDO_TOOL, runTool, XLRD_PSEUDO_TOOL } from '../tools';
import { pdfText, sofficePdf, structuralFaults, unembeddedFonts } from './document-office';

/**
 * Public office documents (bench/corpus/remote-manifest.json) converted to PDF by the project's in-process engine and by the
 * office suite's own export. The documents are chosen by feature (tables, pictures, charts, footnotes, tracked changes, fields,
 * right-to-left and CJK text, embedded fonts, macros) from the test files of an open-source office suite, an Apache-licensed
 * office-format library and an MIT-licensed Open XML test set, plus real-world files of the government corpus, in
 * DOCX, XLSX, PPTX, ODT, DOC, XLS, PPT, RTF and HTML.
 *
 * The truth is the text of the document as its format holds it (bench/office-words.ts: XML of the package, olefile and xlrd
 * for the binary formats, small readers for RTF and HTML), so a conversion is scored by the share of those words that survive in
 * the PDF (`pdftotext`), and by the fonts the PDF leaves out (`pdffonts`) and the structural faults `qpdf --check` finds. A word is a
 * run of letters or digits, and every CJK character counts as a word of its own. The in-process engine is called directly:
 * the dispatcher prefers the office suite when it is installed, which would measure the suite against itself. A document the
 * product refuses, or the suite cannot open, is a `converts` row.
 */

const FAMILY = 'document';
const REFERENCE = 'soffice';
const SPECS: readonly MetricSpec[] = [SPEC.wordRecall, SPEC.unembeddedFonts, SPEC.pdfCheckFailures];
const ALL_SPECS: readonly MetricSpec[] = [...SPECS, SPEC.throughput];
/** A truth with fewer words than this cannot tell a conversion from an empty page; the manifest holds no such sample. */
const MIN_TRUTH_WORDS = 10;
const TOKEN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}]+/gu;

const caseOf = (sample: RemoteSample): string => `${sample.id}->pdf`;
const tokensOf = (text: string): string[] => normalizeOcrText(text).toLowerCase().match(TOKEN) ?? [];

/** Share of the words of `truth` found in `text`, each occurrence counted once. */
export function wordRecallOf(truth: readonly string[], text: string): number {
  const available = new Map<string, number>();
  for (const word of tokensOf(text)) available.set(word, (available.get(word) ?? 0) + 1);
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

export const truthWordsOf = (text: string): string[] => tokensOf(text);

interface Measured {
  recall: number | null;
  fonts: number;
  faults: number;
}

export async function runDocumentPublic(ctx: FamilyContext): Promise<BenchRow[]> {
  // A speed-only run times a few public samples; the others have only quality rows, which it does not measure.
  const samples = remoteSamples('document').filter((sample) => (ctx.quality || speedSample(FAMILY, sample.id)) && ctx.inScope(FAMILY, caseOf(sample)));
  if (samples.length === 0) return [];
  const binary = samples.some((sample) => ['doc', 'xls', 'ppt'].includes(String(sample.meta.format)));
  const plan = ctx.plan(['soffice', 'pdftotext', 'pdffonts', 'qpdf', ...(binary ? ['python3', OLEFILE_PSEUDO_TOOL, XLRD_PSEUDO_TOOL] : [])], 'document public');
  if (!plan.ok) return samples.flatMap((sample) => skippedGroup(FAMILY, caseOf(sample), ALL_SPECS, REFERENCE, plan));
  const { soffice, pdftotext, pdffonts, qpdf } = plan.paths;
  let server: ReferenceServer | null = null;
  const readers = {
    server: (): ReferenceServer => {
      server ??= ReferenceServer.start(plan.paths.python3);
      return server;
    },
  };
  const profile = `file://${path.join(ctx.work, 'soffice-profile-public')}`;
  const rows: BenchRow[] = [];
  const classRows = new ClassRows();
  try {
    for (const sample of samples) {
      const caseName = caseOf(sample);
      const cached = await ctx.remote(sample);
      if (cached === null) {
        rows.push(...unavailableSampleRows(FAMILY, caseName, ALL_SPECS, REFERENCE, sample.id));
        continue;
      }
      ctx.log(`document ${caseName}`);
      const format = String(sample.meta.format);
      // The office suite takes the format from the extension, so it reads the document under its own name.
      const file = ctx.scratch(sample.id);
      fs.copyFileSync(cached, file);
      const input = fs.readFileSync(file);
      // A document whose text is too short to tell a conversion from an empty page is kept for its fonts and structure only (`recall: false`).
      const recallMeasured = sample.meta.recall !== false;
      const truth = truthWordsOf(await sourceText(format, file, readers));
      if (recallMeasured && truth.length < MIN_TRUTH_WORDS) throw new OutputIntegrityError(`${sample.id}: the text read from the file has ${truth.length} words, fewer than the ${MIN_TRUTH_WORDS} a truth needs`);
      const ours = async (): Promise<Buffer> => convertInProcess(input, format, 'pdf', {}, sample.id);
      const reference = (outDir: string): string => {
        const out = sofficePdf(soffice, profile, file, outDir);
        if (!fs.existsSync(out)) throw new ToolRunError(`the office suite wrote no PDF for ${sample.id}`);
        return out;
      };
      const measure = (pdf: string): Measured => ({ recall: recallMeasured ? wordRecallOf(truth, pdfText(pdftotext, pdf)) : null, fonts: unembeddedFonts(pdffonts, pdf), faults: structuralFaults(qpdf, pdf) });

      let converted = true;
      if (ctx.quality) {
        classRows.expect(sample.class, '->pdf', [...SPECS, SPEC.converts].filter((spec) => recallMeasured || spec.metric !== SPEC.wordRecall.metric).map((spec) => spec.metric));
        const attempt = await attemptOurs(ours);
        converted = attempt.ok;
        let referenceMeasured: Measured | null = null;
        try {
          referenceMeasured = measure(reference(ctx.scratch('ref-public')));
        } catch (error) {
          if (!(error instanceof ToolRunError)) throw error;
          ctx.log(`document ${caseName}: the office suite does not convert it (${error.message.slice(0, 160)})`);
        }
        if (!attempt.ok) ctx.log(`document ${caseName}: the product does not convert it (${attempt.reason})`);
        const sampleRows: BenchRow[] = [convertsRow(FAMILY, caseName, attempt.ok, referenceMeasured !== null, REFERENCE)];
        if (attempt.ok && referenceMeasured !== null) {
          const oursFile = ctx.scratch('ours-public.pdf');
          fs.writeFileSync(oursFile, attempt.value);
          const o = measure(oursFile);
          if (o.recall !== null && referenceMeasured.recall !== null) sampleRows.push(measuredRow(FAMILY, caseName, SPEC.wordRecall, o.recall, referenceMeasured.recall, REFERENCE));
          sampleRows.push(
            measuredRow(FAMILY, caseName, SPEC.unembeddedFonts, o.fonts, referenceMeasured.fonts, REFERENCE),
            measuredRow(FAMILY, caseName, SPEC.pdfCheckFailures, o.faults, referenceMeasured.faults, REFERENCE)
          );
        }
        classRows.addCases(sample.class, sample.id, sampleRows);
        rows.push(...sampleRows);
      }
      if (ctx.speed && converted && speedSample(FAMILY, sample.id)) {
        const timing = await ctx.time(
          speedRowId(FAMILY, caseName),
          async () => void (await ours()),
          () => void reference(ctx.scratch('timing-public')),
          'heavy'
        );
        rows.push(throughputRow(FAMILY, caseName, input.length, timing, REFERENCE));
      }
    }
  } finally {
    await (server as ReferenceServer | null)?.close();
  }
  if (ctx.quality) {
    for (const row of classRows.rows(FAMILY, () => REFERENCE)) {
      if (ctx.inScope(FAMILY, row.case)) rows.push(row);
    }
  }
  return rows;
}
