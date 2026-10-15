import fs from 'node:fs';
import path from 'node:path';
import { convertWithProject } from '../convert';
import type { FamilyRunner } from '../context';
import { sha256Hex, stringValue } from '../ref-cache';
import type { BenchRow } from '../report';
import { measuredRow, type MetricSpec, skippedGroup, SPEC, throughputRow, speedRowId } from '../rows';
import { characterErrorRatePercent, wordF1 } from '../text-metrics';
import { runTool, TESSDATA_PSEUDO_TOOL } from '../tools';

/**
 * OCR family: a scanned page converted to a searchable PDF, its text layer read back with pdftotext and scored
 * against the ground truth the page was drawn from, next to the tesseract command-line engine reading the same
 * image with the same page segmentation.
 */

const CASE = 'scan.png->pdf';
const REFERENCE = 'tesseract';
const PAGE_SEGMENTATION_AUTO = '3';
const NEURAL_ENGINE = '1';
const LANGUAGE_DATA_FILE = 'eng.traineddata';
const SPECS: readonly MetricSpec[] = [SPEC.cer, SPEC.wordF1, SPEC.throughput];

export const runOcr: FamilyRunner = async (ctx) => {
  if (!ctx.inScope('ocr', CASE)) return [];
  const plan = ctx.plan(['pdftotext', 'tesseract', TESSDATA_PSEUDO_TOOL], CASE);
  if (!plan.ok) return skippedGroup('ocr', CASE, SPECS, REFERENCE, plan);
  ctx.log(`ocr ${CASE}`);
  const { pdftotext, tesseract } = plan.paths;
  const tessdata = plan.paths[TESSDATA_PSEUDO_TOOL];
  const scan = ctx.corpusBuffer('scan.png');
  const scanFile = ctx.corpusPath('scan.png');
  const env = { ...process.env, OMP_THREAD_LIMIT: '1' };

  const oursPdf = async (): Promise<Buffer> => (await convertWithProject(scan, 'png', 'pdf', { ocrEnabled: true }, 'scan.png')).buffer;

  const rows: BenchRow[] = [];
  if (ctx.quality) {
    const truth = fs.readFileSync(ctx.corpusPath('scan.gt.txt'), 'utf8');
    const textOf = (pdf: string): string => runTool(pdftotext, ['-enc', 'UTF-8', pdf, '-']).stdout.toString('utf8');
    const oursFile = ctx.scratch('ours.pdf');
    fs.writeFileSync(oursFile, await oursPdf());
    const oursText = textOf(oursFile);
    // The engine's text depends on the tesseract build, its language data, the page and the segmentation settings.
    const referenceText = await ctx.refCache.value(
      'ocr',
      {
        kind: 'tesseract-text',
        tools: ['tesseract'],
        files: ['scan.png'],
        settings: { case: CASE, language: 'eng', psm: PAGE_SEGMENTATION_AUTO, oem: NEURAL_ENGINE, languageData: sha256Hex(fs.readFileSync(path.join(tessdata, LANGUAGE_DATA_FILE))) },
      },
      stringValue,
      () => runTool(tesseract, [scanFile, 'stdout', '-l', 'eng', '--tessdata-dir', tessdata, '--psm', PAGE_SEGMENTATION_AUTO, '--oem', NEURAL_ENGINE], { env }).stdout.toString('utf8')
    );
    rows.push(
      measuredRow('ocr', CASE, SPEC.cer, characterErrorRatePercent(truth, oursText), characterErrorRatePercent(truth, referenceText), REFERENCE),
      measuredRow('ocr', CASE, SPEC.wordF1, wordF1(truth, oursText), wordF1(truth, referenceText), REFERENCE)
    );
  }

  if (ctx.speed) {
    const referenceBase = path.join(ctx.work, 'timing-ocr');
    const timing = await ctx.time(
      speedRowId('ocr', CASE),
      async () => {
        await oursPdf();
      },
      () => {
        runTool(tesseract, [scanFile, referenceBase, '-l', 'eng', '--tessdata-dir', tessdata, '--psm', PAGE_SEGMENTATION_AUTO, '--oem', NEURAL_ENGINE, 'pdf'], { env });
      },
      'heavy'
    );
    rows.push(throughputRow('ocr', CASE, scan.length, timing, REFERENCE));
  }
  return rows;
};
