import fs from 'node:fs';
import path from 'node:path';
import { type CadTruth, scoreInk } from '../cad-ink';
import { IN_PROCESS_REPEATS } from '../config';
import { convertWithProject } from '../convert';
import type { FamilyContext, FamilyRunner } from '../context';
import { numberRecord } from '../ref-cache';
import type { BenchRow } from '../report';
import { measuredRow, type MetricSpec, skippedGroup, skippedRow, SPEC, speedRowId, throughputRow } from '../rows';
import { wordF1 } from '../text-metrics';
import { runTool } from '../tools';
import { readRaster, renderPdfPage, renderSvg } from '../vector-raster';

/**
 * CAD family: 2D drawings (DXF) converted to SVG, PDF and PNG, against the office suite's drawing import and export (the
 * open-source suite that reads DXF without a CAD vendor's runtime), judged by the geometry the drawings were written from
 * (bench/cad-ink.ts): recall of the strokes, precision of the marks and the aspect ratio of the drawn box, and for PDF the
 * words of the text entities read back with `pdftotext`.
 *
 * - `plate-basic.dxf` uses only LINE, ARC, CIRCLE, LWPOLYLINE and TEXT.
 * - `plate-full.dxf` adds what drawings from the field contain: ELLIPSE, SPLINE, POLYLINE, INSERT of a block and MTEXT.
 * - DWG is listed with its reason: the engine has no binary DWG reader, and no reference converter is packaged for the
 *   runner image, so there is neither an output nor a reference to measure.
 */

const REFERENCE = 'soffice';
const SAMPLES = ['plate-basic', 'plate-full'] as const;
const TARGETS = ['svg', 'pdf', 'png'] as const;
type Target = (typeof TARGETS)[number];
/** Width the vector outputs are drawn at: the drawing fills a third of an A4 page in the reference's output. */
const RENDER_WIDTH_PX = 2400;
const INK_SPECS: readonly MetricSpec[] = [SPEC.inkRecall, SPEC.inkPrecision, SPEC.extentError];
const parseInk = numberRecord(['precision', 'recall', 'extentError', 'wordF1']);
const DWG_REASON =
  'the engine has no binary DWG reader (it fails closed; issue #728), no licensed DWG sample is committed, and no open-source DWG converter is packaged for the runner image; the bar for DWG is the Open Design Specification once a reader exists';

interface Measured {
  precision: number;
  recall: number;
  extentError: number;
  /** Word F1 of the text of a PDF; 0 for the other targets, which carry no text row. */
  wordF1: number;
}

function specsOf(target: Target): MetricSpec[] {
  return target === 'pdf' ? [...INK_SPECS, SPEC.wordF1, SPEC.throughput] : [...INK_SPECS, SPEC.throughput];
}

function sofficeConvert(soffice: string, profile: string, input: string, target: string, outDir: string): string {
  fs.mkdirSync(outDir, { recursive: true });
  runTool(soffice, [`-env:UserInstallation=${profile}`, '--headless', '--convert-to', target, '--outdir', outDir, input]);
  return path.join(outDir, `${path.parse(input).name}.${target}`);
}

export const runCad: FamilyRunner = async (ctx) => {
  const rows: BenchRow[] = [];
  const caseOf = (sample: string, target: Target): string => `${sample}.dxf->${target}`;
  for (const sample of SAMPLES) {
    for (const target of TARGETS) {
      const caseName = caseOf(sample, target);
      if (!ctx.inScope('cad', caseName)) continue;
      rows.push(...(await runDrawing(ctx, sample, target)));
    }
  }
  rows.push(...dwgRows(ctx));
  return rows;
};

async function runDrawing(ctx: FamilyContext, sample: string, target: Target): Promise<BenchRow[]> {
  const caseName = `${sample}.dxf->${target}`;
  const plan = ctx.plan(['ffmpeg', 'rsvg-convert', 'pdftoppm', 'pdftotext', REFERENCE], caseName);
  if (!plan.ok) return skippedGroup('cad', caseName, specsOf(target), REFERENCE, plan);
  ctx.log(`cad ${caseName}`);
  const { ffmpeg, pdftoppm, pdftotext, soffice } = plan.paths;
  const rsvg = plan.paths['rsvg-convert'];
  const dxfName = `cad/${sample}.dxf`;
  const dxf = ctx.corpusBuffer(dxfName);
  const dxfFile = ctx.corpusPath(dxfName);
  const truth = JSON.parse(fs.readFileSync(ctx.corpusPath(`cad/${sample}.truth.json`), 'utf8')) as CadTruth;
  const profile = `file://${path.join(ctx.work, 'soffice-profile-cad')}`;
  const rows: BenchRow[] = [];

  const ours = async (): Promise<Buffer> => (await convertWithProject(dxf, 'dxf', target, {}, `${sample}.dxf`)).buffer;
  const reference = (outDir: string): string => sofficeConvert(soffice, profile, dxfFile, target, outDir);
  const measure = (file: string): Measured => {
    const picture = ctx.scratch(`drawn-${target}.png`);
    if (target === 'svg') renderSvg(rsvg, file, picture, RENDER_WIDTH_PX);
    else if (target === 'pdf') renderPdfPage(pdftoppm, file, picture, RENDER_WIDTH_PX);
    else fs.copyFileSync(file, picture);
    const score = scoreInk(readRaster(ffmpeg, picture), truth);
    const words = target === 'pdf' ? wordF1(truth.words.join(' '), runTool(pdftotext, ['-enc', 'UTF-8', file, '-']).stdout.toString('utf8')) : 0;
    return { ...score, wordF1: words };
  };

  if (ctx.quality) {
    const oursFile = path.join(ctx.scratch(`ours-${sample}`), `ours.${target}`);
    fs.mkdirSync(path.dirname(oursFile), { recursive: true });
    fs.writeFileSync(oursFile, await ours());
    const measuredReference = await ctx.refCache.value(
      'cad',
      { kind: `soffice-${target}`, tools: ['ffmpeg', 'rsvg-convert', 'pdftoppm', 'pdftotext', REFERENCE], files: [dxfName, `cad/${sample}.truth.json`], settings: { case: caseName, width: RENDER_WIDTH_PX } },
      parseInk,
      () => measure(reference(ctx.scratch(`ref-${sample}`)))
    );
    const measuredOurs = measure(oursFile);
    rows.push(
      measuredRow('cad', caseName, SPEC.inkRecall, measuredOurs.recall, measuredReference.recall, REFERENCE),
      measuredRow('cad', caseName, SPEC.inkPrecision, measuredOurs.precision, measuredReference.precision, REFERENCE),
      measuredRow('cad', caseName, SPEC.extentError, measuredOurs.extentError, measuredReference.extentError, REFERENCE)
    );
    if (target === 'pdf') rows.push(measuredRow('cad', caseName, SPEC.wordF1, measuredOurs.wordF1, measuredReference.wordF1, REFERENCE));
  }

  if (ctx.speed) {
    const timing = await ctx.time(
      speedRowId('cad', caseName),
      async () => {
        await ours();
      },
      () => {
        reference(ctx.scratch(`timing-${sample}`));
      },
      'heavy',
      IN_PROCESS_REPEATS
    );
    rows.push(throughputRow('cad', caseName, dxf.length, timing, REFERENCE));
  }
  return rows;
}

/** DWG sources are listed, not measured: see DWG_REASON. */
function dwgRows(ctx: FamilyContext): BenchRow[] {
  const rows: BenchRow[] = [];
  for (const target of TARGETS) {
    const caseName = `plate.dwg->${target}`;
    if (!ctx.inScope('cad', caseName)) continue;
    for (const spec of specsOf(target)) {
      if (spec.kind === 'throughput' ? ctx.speed : ctx.quality) rows.push(skippedRow('cad', caseName, spec, REFERENCE, 'unsupported', DWG_REASON));
    }
  }
  return rows;
}
