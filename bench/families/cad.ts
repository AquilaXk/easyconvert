import fs from 'node:fs';
import path from 'node:path';
import { type CadTruth, scoreInk } from '../cad-ink';
import { IN_PROCESS_REPEATS } from '../config';
import { convertWithProject } from '../convert';
import type { FamilyContext, FamilyRunner } from '../context';
import { ToolRunError } from '../errors';
import { PublicClassRows } from '../public-classes';
import { publicFile, publicSamples, type PublicSample } from '../public-samples';
import { publicSpeedSample } from '../public-scope';
import { attemptOurs, CONVERTS_SPEC, convertsRow, unavailableRows } from '../public-support';
import { numberRecord } from '../ref-cache';
import { ReferenceServer } from '../reference-server';
import type { BenchRow } from '../report';
import { measuredRow, type MetricSpec, skippedGroup, skippedRow, SPEC, speedRowId, throughputRow } from '../rows';
import { wordF1 } from '../text-metrics';
import { EZDXF_PSEUDO_TOOL, runTool } from '../tools';
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
 *
 * The public samples (bench/corpus/public-manifest.json) are drawings from several authoring programs and versions (AutoCAD
 * R12 to 2018, OpenSCAD, BricsCAD, LibreCAD, ezdxf) in the content classes basic geometry, curves, blocks, text and
 * architecture. Their truth is not written by this repository: ezdxf (an independent DXF library) reads each file and
 * `cad.truth` of bench/reference-server.py returns its strokes (blocks inserted, arrays and nested blocks expanded, hidden
 * layers left out, curves flattened) and its text, which the same ink score then compares with each output. A drawing the
 * product refuses, or one the office suite cannot import, is a `converts` row instead of a stopped run.
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

/** A drawing the family measures: a generated plate (the name is the file stem) or a public sample (the name is its id). */
interface Subject {
  name: string;
  sample: PublicSample | null;
}

const fixtureSubject = (name: string): Subject => ({ name, sample: null });
const publicSubject = (sample: PublicSample): Subject => ({ name: sample.id, sample });
const caseOf = (subject: Subject, target: Target): string => (subject.sample ? `${subject.sample.id}->${target}` : `${subject.name}.dxf->${target}`);

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

interface Shared {
  classRows: PublicClassRows;
  /** The reference server that reads public drawings with ezdxf; started on the first public drawing. */
  server: () => ReferenceServer;
}

export const runCad: FamilyRunner = async (ctx) => {
  const rows: BenchRow[] = [];
  const subjects = [...SAMPLES.map(fixtureSubject), ...publicSamples('cad').map(publicSubject)];
  let server: ReferenceServer | null = null;
  const shared: Shared = {
    classRows: new PublicClassRows(),
    server: () => {
      if (server === null) {
        const plan = ctx.plan(['python3', EZDXF_PSEUDO_TOOL], 'cad truth');
        if (!plan.ok) throw new ToolRunError(plan.reason);
        server = ReferenceServer.start(plan.paths.python3);
      }
      return server;
    },
  };
  try {
    for (const subject of subjects) {
      for (const target of TARGETS) {
        if (!ctx.inScope('cad', caseOf(subject, target))) continue;
        rows.push(...(await runDrawing(ctx, subject, target, shared)));
      }
    }
    if (ctx.quality) {
      for (const row of shared.classRows.rows('cad', () => REFERENCE)) {
        if (ctx.inScope('cad', row.case)) rows.push(row);
      }
    }
  } finally {
    await (server as ReferenceServer | null)?.close();
  }
  rows.push(...dwgRows(ctx));
  return rows;
};

const QUALITY_SPECS = (target: Target): MetricSpec[] => specsOf(target).filter((spec) => spec.kind !== 'throughput');
const textlessSpecs = (target: Target): MetricSpec[] => QUALITY_SPECS(target).filter((spec) => spec.metric !== SPEC.wordF1.metric);

async function runDrawing(ctx: FamilyContext, subject: Subject, target: Target, shared: Shared): Promise<BenchRow[]> {
  const { sample } = subject;
  const caseName = caseOf(subject, target);
  const tools = ['ffmpeg', 'rsvg-convert', 'pdftoppm', 'pdftotext', REFERENCE, ...(sample ? ['python3', EZDXF_PSEUDO_TOOL] : [])];
  const plan = ctx.plan(tools, caseName);
  if (!plan.ok) return skippedGroup('cad', caseName, specsOf(target), REFERENCE, plan);
  const { ffmpeg, pdftoppm, pdftotext, soffice } = plan.paths;
  const rsvg = plan.paths['rsvg-convert'];
  const dxfName = `cad/${subject.name}.dxf`;
  let dxfFile: string;
  let truth: CadTruth;
  if (sample === null) {
    dxfFile = ctx.corpusPath(dxfName);
    truth = JSON.parse(fs.readFileSync(ctx.corpusPath(`cad/${subject.name}.truth.json`), 'utf8')) as CadTruth;
  } else {
    const cached = await publicFile(ctx, sample);
    if (cached === null) return unavailableRows('cad', caseName, specsOf(target), REFERENCE, `public sample ${sample.id} is not available`);
    // The office suite takes the format from the extension, so it reads the drawing under its own name.
    dxfFile = ctx.scratch(sample.id);
    fs.copyFileSync(cached, dxfFile);
    truth = await shared.server().call<CadTruth>('cad.truth', { file: dxfFile });
  }
  ctx.log(`cad ${caseName}`);
  const dxf = fs.readFileSync(dxfFile);
  const profile = `file://${path.join(ctx.work, 'soffice-profile-cad')}`;
  const rows: BenchRow[] = [];
  const hasText = truth.words.length > 0;

  const ours = async (): Promise<Buffer> => (await convertWithProject(dxf, 'dxf', target, {}, sample ? sample.id : `${subject.name}.dxf`)).buffer;
  const reference = (outDir: string): string => sofficeConvert(soffice, profile, dxfFile, target, outDir);
  const measure = (file: string): Measured => {
    const picture = ctx.scratch(`drawn-${target}.png`);
    if (target === 'svg') renderSvg(rsvg, file, picture, RENDER_WIDTH_PX);
    else if (target === 'pdf') renderPdfPage(pdftoppm, file, picture, RENDER_WIDTH_PX);
    else fs.copyFileSync(file, picture);
    const score = scoreInk(readRaster(ffmpeg, picture), truth);
    const words = target === 'pdf' && hasText ? wordF1(truth.words.join(' '), runTool(pdftotext, ['-enc', 'UTF-8', file, '-']).stdout.toString('utf8')) : 0;
    return { ...score, wordF1: words };
  };
  const rowsOf = (name: string, o: Measured, r: Measured): BenchRow[] => [
    measuredRow('cad', name, SPEC.inkRecall, o.recall, r.recall, REFERENCE),
    measuredRow('cad', name, SPEC.inkPrecision, o.precision, r.precision, REFERENCE),
    measuredRow('cad', name, SPEC.extentError, o.extentError, r.extentError, REFERENCE),
    ...(target === 'pdf' && (sample === null || hasText) ? [measuredRow('cad', name, SPEC.wordF1, o.wordF1, r.wordF1, REFERENCE)] : []),
  ];

  let converted = true;
  if (ctx.quality) {
    const classSpecs = hasText ? QUALITY_SPECS(target) : textlessSpecs(target);
    if (sample) shared.classRows.expect(sample.class, `->${target}`, [...classSpecs, CONVERTS_SPEC].map((spec) => spec.metric));
    const attempt = await attemptOurs(ours, sample !== null);
    converted = attempt.ok;
    if (sample === null) {
      const oursFile = path.join(ctx.scratch(`ours-${subject.name}`), `ours.${target}`);
      fs.mkdirSync(path.dirname(oursFile), { recursive: true });
      fs.writeFileSync(oursFile, (attempt as { value: Buffer }).value);
      const measuredReference = await ctx.refCache.value(
        'cad',
        { kind: `soffice-${target}`, tools: ['ffmpeg', 'rsvg-convert', 'pdftoppm', 'pdftotext', REFERENCE], files: [dxfName, `cad/${subject.name}.truth.json`], settings: { case: caseName, width: RENDER_WIDTH_PX } },
        parseInk,
        () => measure(reference(ctx.scratch(`ref-${subject.name}`)))
      );
      rows.push(...rowsOf(caseName, measure(oursFile), measuredReference));
    } else {
      let measuredReference: Measured | null = null;
      try {
        measuredReference = measure(reference(ctx.scratch(`ref-${subject.name}`)));
      } catch (error) {
        if (!(error instanceof ToolRunError)) throw error;
        ctx.log(`cad ${caseName}: the office suite does not convert it (${error.message.slice(0, 160)})`);
      }
      if (!attempt.ok) ctx.log(`cad ${caseName}: the product does not convert it (${attempt.reason})`);
      rows.push(convertsRow('cad', caseName, attempt.ok, measuredReference !== null, REFERENCE));
      if (attempt.ok && measuredReference !== null) {
        const oursFile = path.join(ctx.scratch(`ours-${subject.name}`), `ours.${target}`);
        fs.mkdirSync(path.dirname(oursFile), { recursive: true });
        fs.writeFileSync(oursFile, attempt.value);
        rows.push(...rowsOf(caseName, measure(oursFile), measuredReference));
      }
      shared.classRows.addRows(sample.class, `->${target}`, rows, [...classSpecs, CONVERTS_SPEC]);
    }
  }

  if (ctx.speed && converted && (sample === null || publicSpeedSample('cad', sample.id))) {
    const timing = await ctx.time(
      speedRowId('cad', caseName),
      async () => {
        await ours();
      },
      () => {
        reference(ctx.scratch(`timing-${subject.name}`));
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
