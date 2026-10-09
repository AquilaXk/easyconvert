import fs from 'node:fs';
import path from 'node:path';
import { convertWithProject } from '../convert';
import type { FamilyRunner } from '../context';
import { stringValue } from '../ref-cache';
import type { BenchRow } from '../report';
import { measuredRow, type MetricSpec, skippedGroup, SPEC, throughputRow } from '../rows';
import { characterErrorRatePercent, wordF1 } from '../text-metrics';
import { runTool } from '../tools';

/**
 * Document family: a docx converted to PDF, its text read back with pdftotext and scored against the text the
 * document was built from, next to the office suite's own command-line PDF export of the same file.
 */

const CASE = 'report.docx->pdf';
const REFERENCE = 'soffice';
const SPECS: readonly MetricSpec[] = [SPEC.wordF1, SPEC.cer, SPEC.throughput];

export const runDocument: FamilyRunner = async (ctx) => {
  if (!ctx.inScope('document', CASE)) return [];
  const plan = ctx.plan(['pdftotext', 'soffice'], CASE);
  if (!plan.ok) return skippedGroup('document', CASE, SPECS, REFERENCE, plan);
  ctx.log(`document ${CASE}`);
  const { pdftotext, soffice } = plan.paths;
  const docx = ctx.corpusBuffer('report.docx');
  const docxFile = ctx.corpusPath('report.docx');
  const profile = `file://${path.join(ctx.work, 'soffice-profile')}`;

  const oursPdf = async (): Promise<Buffer> => (await convertWithProject(docx, 'docx', 'pdf', {}, 'report.docx')).buffer;
  const referencePdf = (outDir: string): string => {
    fs.mkdirSync(outDir, { recursive: true });
    runTool(soffice, [`-env:UserInstallation=${profile}`, '--headless', '--convert-to', 'pdf', '--outdir', outDir, docxFile]);
    return path.join(outDir, 'report.pdf');
  };
  const textOf = (pdf: string): string => runTool(pdftotext, ['-layout', '-enc', 'UTF-8', pdf, '-']).stdout.toString('utf8');

  const rows: BenchRow[] = [];
  if (ctx.quality) {
    const truth = fs.readFileSync(ctx.corpusPath('report.gt.txt'), 'utf8');
    const oursFile = ctx.scratch('ours.pdf');
    fs.writeFileSync(oursFile, await oursPdf());
    const oursText = textOf(oursFile);
    // The reference's text is a function of the office suite, pdftotext and the document alone.
    const referenceText = await ctx.refCache.value(
      'document',
      { kind: 'soffice-pdf-text', tools: ['soffice', 'pdftotext'], files: ['report.docx'], settings: { case: CASE, layout: true, encoding: 'UTF-8' } },
      stringValue,
      () => textOf(referencePdf(ctx.scratch('ref-out')))
    );
    rows.push(
      measuredRow('document', CASE, SPEC.wordF1, wordF1(truth, oursText), wordF1(truth, referenceText), REFERENCE),
      measuredRow('document', CASE, SPEC.cer, characterErrorRatePercent(truth, oursText), characterErrorRatePercent(truth, referenceText), REFERENCE)
    );
  }

  if (ctx.speed) {
    const timing = await ctx.time(
      async () => {
        await oursPdf();
      },
      () => {
        referencePdf(ctx.scratch('timing-out'));
      },
      'heavy'
    );
    rows.push(throughputRow('document', CASE, docx.length, timing, REFERENCE));
  }
  return rows;
};
