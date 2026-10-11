import fs from 'node:fs';
import path from 'node:path';
import { convertWithProject } from '../convert';
import type { FamilyContext } from '../context';
import { OutputIntegrityError, ToolRunError } from '../errors';
import { measureSsimPsnr } from '../measure';
import { PublicClassRows } from '../public-classes';
import { publicCompanionFile, publicFile, publicSamples, type PublicSample } from '../public-samples';
import { publicSpeedSample } from '../public-scope';
import { attemptOurs, CONVERTS_SPEC, convertsRow, unavailableRows } from '../public-support';
import type { BenchRow } from '../report';
import { capPsnr, measuredRow, type MetricSpec, skippedGroup, SPEC, speedRowId, throughputRow } from '../rows';
import { runTool } from '../tools';
import { pngSize, renderPdfPage } from '../vector-raster';

/**
 * Public SVG rendering tests (bench/corpus/public-manifest.json): the 200 by 200 cases of an open SVG rendering suite, each
 * with the reference picture that the suite keeps for it (checked against browsers by its maintainers), converted to PNG and to
 * PDF by the product and by librsvg. A PDF is drawn by Poppler. Every picture, the reference included, is composited on white at
 * the size of the reference and scored with SSIM and PSNR against it, so a renderer is judged by how close it gets to the suite's
 * picture and not by how close it gets to another renderer. An SVG the product refuses is a `converts` row.
 */

const FAMILY = 'vector';
const RSVG = 'rsvg-convert';
const TARGETS = ['png', 'pdf'] as const;
type Target = (typeof TARGETS)[number];
const SPECS: readonly MetricSpec[] = [SPEC.ssim, SPEC.psnr];
const RENDER_DPI = 72;

const caseOf = (sample: PublicSample, target: Target): string => `${sample.id}->${target}`;
const ALL_SPECS: readonly MetricSpec[] = [...SPECS, SPEC.throughput];

/** The picture composited on white and scaled to the size of the reference, as an opaque 8-bit PNG. */
function flattened(ffmpeg: string, input: string, output: string, size: { width: number; height: number }): string {
  const filter = `[1:v]scale=${size.width}:${size.height}:flags=bicubic[picture];[0:v][picture]overlay=format=auto,format=rgb24`;
  runTool(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=white:s=${size.width}x${size.height}`, '-i', input, '-filter_complex', filter, '-frames:v', '1', output]);
  if (!fs.existsSync(output)) throw new OutputIntegrityError(`ffmpeg wrote no flattened picture for ${path.basename(input)}`);
  return output;
}

export async function runVectorPublic(ctx: FamilyContext): Promise<BenchRow[]> {
  const rows: BenchRow[] = [];
  const classRows = new PublicClassRows();
  for (const sample of publicSamples('vector')) {
    for (const target of TARGETS) {
      if (!ctx.inScope(FAMILY, caseOf(sample, target))) continue;
      rows.push(...(await runCase(ctx, sample, target, classRows)));
    }
  }
  if (ctx.quality) {
    for (const row of classRows.rows(FAMILY, () => RSVG)) {
      if (ctx.inScope(FAMILY, row.case)) rows.push(row);
    }
  }
  return rows;
}

async function runCase(ctx: FamilyContext, sample: PublicSample, target: Target, classRows: PublicClassRows): Promise<BenchRow[]> {
  const caseName = caseOf(sample, target);
  const plan = ctx.plan(['ffmpeg', RSVG, ...(target === 'pdf' ? ['pdftoppm'] : [])], caseName);
  if (!plan.ok) return skippedGroup(FAMILY, caseName, ALL_SPECS, RSVG, plan);
  const cached = await publicFile(ctx, sample);
  const truthFile = cached === null ? null : await publicCompanionFile(ctx, sample, 'truth');
  if (cached === null || truthFile === null) return unavailableRows(FAMILY, caseName, ALL_SPECS, RSVG, `public sample ${sample.id} is not available`);
  ctx.log(`vector ${caseName}`);
  const { ffmpeg, pdftoppm } = plan.paths;
  const rsvg = plan.paths[RSVG];
  const svgFile = ctx.scratch(sample.id);
  fs.copyFileSync(cached, svgFile);
  const svg = fs.readFileSync(svgFile);
  const size = pngSize(truthFile);
  const truth = flattened(ffmpeg, truthFile, ctx.scratch('truth.png'), size);
  const rows: BenchRow[] = [];

  const ours = async (): Promise<Buffer> => (await convertWithProject(svg, 'svg', target, { dpi: RENDER_DPI }, sample.id)).buffer;
  const referenceFile = (out: string): void => {
    runTool(rsvg, ['--format', target, '--output', out, svgFile]);
  };
  /** The score of an output file against the reference picture of the suite. */
  const score = (file: string, label: string): { ssim: number; psnr: number } => {
    let picture = file;
    if (target === 'pdf') picture = renderPdfPage(pdftoppm, file, ctx.scratch(`${label}-page.png`), size.width);
    const measured = measureSsimPsnr(ffmpeg, flattened(ffmpeg, picture, ctx.scratch(`${label}-flat.png`), size), truth);
    return { ssim: measured.ssim, psnr: capPsnr(measured.psnr) };
  };

  let converted = true;
  if (ctx.quality) {
    classRows.expect(sample.class, `->${target}`, [...SPECS, CONVERTS_SPEC].map((spec) => spec.metric));
    const attempt = await attemptOurs(ours);
    converted = attempt.ok;
    let referenceConverted = true;
    const referenceOut = ctx.scratch(`reference.${target}`);
    try {
      referenceFile(referenceOut);
    } catch (error) {
      if (!(error instanceof ToolRunError)) throw error;
      referenceConverted = false;
      ctx.log(`vector ${caseName}: librsvg does not convert it (${error.message.slice(0, 160)})`);
    }
    if (!attempt.ok) ctx.log(`vector ${caseName}: the product does not convert it (${attempt.reason})`);
    rows.push(convertsRow(FAMILY, caseName, attempt.ok, referenceConverted, RSVG));
    if (attempt.ok && referenceConverted) {
      const oursFile = ctx.scratch(`ours.${target}`);
      fs.writeFileSync(oursFile, attempt.value);
      const o = score(oursFile, 'ours');
      const r = score(referenceOut, 'reference');
      rows.push(measuredRow(FAMILY, caseName, SPEC.ssim, o.ssim, r.ssim, RSVG), measuredRow(FAMILY, caseName, SPEC.psnr, o.psnr, r.psnr, RSVG));
    }
    classRows.addRows(sample.class, `->${target}`, rows, [...SPECS, CONVERTS_SPEC]);
  }
  if (ctx.speed && converted && publicSpeedSample(FAMILY, sample.id)) {
    const out = ctx.scratch(`timing.${target}`);
    const timing = await ctx.time(
      speedRowId(FAMILY, caseName),
      async () => {
        await ours();
      },
      () => referenceFile(out),
      'light'
    );
    rows.push(throughputRow(FAMILY, caseName, svg.length, timing, RSVG));
  }
  return rows;
}
