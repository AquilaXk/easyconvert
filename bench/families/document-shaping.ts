import fs from 'node:fs';
import path from 'node:path';
import type { FamilyRunner } from '../context';
import { REPO_ROOT } from '../config';
import type { BenchRow } from '../report';
import { measuredRow, type MetricSpec, skippedGroup, SPEC, throughputRow } from '../rows';
import { interleavedTiming } from '../stats';
import { characterErrorRatePercent } from '../text-metrics';
import { runTool } from '../tools';

/**
 * Complex-script text to PDF, on the six paragraphs of tests/fixtures/complex-script (Arabic, Hebrew, Hindi, Thai,
 * Korean, Japanese). Each paragraph is converted by the in-process shaper and by the office suite's HTML import and
 * PDF export; Poppler `pdftotext` reads both back and the text is scored against the paragraph itself, with spaces
 * and bidi marks removed (they depend on the extraction tool's own line heuristics, not on the PDF writer). The
 * end-to-end time of the same conversions is measured interleaved.
 */

const SAMPLE_FILE = path.join(REPO_ROOT, 'tests', 'fixtures', 'complex-script', 'samples.json');
const CASE = 'complex-script txt->pdf';
const REFERENCE = 'soffice';
const SPECS: readonly MetricSpec[] = [SPEC.cer, SPEC.throughput];
const PAGE_MARGIN_PT = 50;
const FONT_SIZE_PT = 10;

interface Sample {
  name: string;
  text: string;
  rtl: boolean;
  referenceFamily: string;
}

const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;

function comparable(text: string): string {
  return text.normalize('NFC').replace(/\p{Cf}/gu, '').replace(/\s+/g, '');
}

function referenceHtml(sample: Sample): string {
  const direction = sample.rtl ? ' dir="rtl"' : '';
  return `<!DOCTYPE html><html${direction}><head><meta charset="utf-8"><style>@page{size:210mm 297mm;margin:${PAGE_MARGIN_PT}pt}body{margin:0;font-family:'${sample.referenceFamily}';font-size:${FONT_SIZE_PT}pt}p{margin:0}</style></head><body><p>${sample.text}</p></body></html>`;
}

export const runDocumentShaping: FamilyRunner = async (ctx) => {
  const plan = ctx.plan(['pdftotext', 'soffice'], CASE);
  if (!plan.ok) return skippedGroup('document', CASE, SPECS, REFERENCE, plan);
  ctx.log(`document ${CASE}`);
  const { pdftotext, soffice } = plan.paths;
  const samples = JSON.parse(fs.readFileSync(SAMPLE_FILE, 'utf8')) as Sample[];
  const profile = `file://${path.join(ctx.work, 'soffice-profile-shaping')}`;
  const { loadFontCoverageIndex } = await import('../../src/lib/conversions/pdf-fonts');
  const { convertDocument } = await import('../../src/lib/conversions/document');
  await loadFontCoverageIndex();

  const htmlFiles = samples.map((sample) => {
    const file = ctx.scratch(`${sample.name}.html`);
    fs.writeFileSync(file, referenceHtml(sample), 'utf8');
    return file;
  });
  const oursPdf = async (sample: Sample): Promise<Buffer> =>
    (await convertDocument(Buffer.from(sample.text, 'utf8'), 'txt', 'pdf', {}, `${sample.name}.txt`)).buffer;
  const referencePdf = (index: number, outDir: string): string => {
    fs.mkdirSync(outDir, { recursive: true });
    runTool(soffice, [`-env:UserInstallation=${profile}`, '--headless', '--convert-to', 'pdf', '--outdir', outDir, htmlFiles[index]]);
    return path.join(outDir, `${path.basename(htmlFiles[index], '.html')}.pdf`);
  };
  const textOf = (pdf: string): string => runTool(pdftotext, ['-enc', 'UTF-8', pdf, '-']).stdout.toString('utf8');

  const oursScores: number[] = [];
  const referenceScores: number[] = [];
  for (const [index, sample] of samples.entries()) {
    const oursFile = ctx.scratch(`${sample.name}-ours.pdf`);
    fs.writeFileSync(oursFile, await oursPdf(sample));
    oursScores.push(characterErrorRatePercent(comparable(sample.text), comparable(textOf(oursFile))));
    referenceScores.push(characterErrorRatePercent(comparable(sample.text), comparable(textOf(referencePdf(index, ctx.scratch('shaping-reference'))))));
  }
  const rows: BenchRow[] = [measuredRow('document', CASE, SPEC.cer, mean(oursScores), mean(referenceScores), REFERENCE)];

  const timing = await interleavedTiming(
    async () => {
      for (const sample of samples) await oursPdf(sample);
    },
    () => {
      // One office process per document, as a user converting one file runs it.
      for (const index of samples.keys()) referencePdf(index, ctx.scratch('shaping-timing'));
    },
    ctx.heavyRuns,
    ctx.warmup
  );
  rows.push(throughputRow('document', CASE, samples.reduce((sum, sample) => sum + Buffer.byteLength(sample.text), 0), timing, REFERENCE));
  return rows;
};
