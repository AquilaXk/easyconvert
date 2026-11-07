import fs from 'node:fs';
import sharp from 'sharp';
import { convertWithProject } from '../convert';
import type { FamilyContext, FamilyRunner } from '../context';
import { remoteSample } from '../corpora';
import { flattenOnGrey, measureSsimPsnr } from '../measure';
import { numberRecord } from '../ref-cache';
import type { BenchRow } from '../report';
import { measuredRow, type MetricSpec, skippedGroup, SPEC, speedRowId, throughputRow, unavailableSampleRows } from '../rows';
import { runTool } from '../tools';

/**
 * Raster pictures traced to SVG, against vtracer run the way the reference converter runs it: the same pinned release program,
 * given the uploaded file itself with the converter's defaults (no option set). The product decodes the picture first and hands
 * the pixels of its first frame to vtracer-pixels (vtracer's own front-end for raw pixels, built from the same source), so the rows
 * measure that staging (the decoders, the 16-bit and colour conversion, the GIF frame), the faster build and the sanitizer.
 *
 * Each SVG is drawn by librsvg at its own size, and the drawing and the source picture are flattened on the same grey, so SSIM
 * scores what a viewer sees over a fixed background. The path count and the byte size of the SVG are compared as they are.
 *
 * The generated corpus gives a flat-colour interface picture, a line drawing (16-bit grey with alpha), a photograph as JPEG and a
 * two-frame GIF made here from the line drawing; the public samples (nightly and full runs) give an icon with transparency, a black
 * and white chart, a photograph and a graph with a transparent background.
 */

const FAMILY = 'vectorize';
const REFERENCE = 'vtracer';
const RSVG = 'rsvg-convert';
const TOOLS = ['ffmpeg', 'ffprobe', RSVG, REFERENCE];
const QUALITY_SPECS: readonly MetricSpec[] = [SPEC.ssim, SPEC.svgPaths, SPEC.bytes];
const parseTrace = numberRecord(['ssim', 'paths', 'bytes']);
const GENERATED = ['screenshot.png', 'lineart.png', 'photo-a.jpg'] as const;
const PUBLIC = ['wm-lineart-containers.png', 'wm-lineart-chart.png', 'kodim23.png', 'wm-alpha-graph.png'] as const;
/** The GIF case: the line drawing followed by its negative, so a trace of any frame but the first shows. */
const ANIMATION = { name: 'lineart.gif', from: 'lineart.png' } as const;

interface Subject {
  caseName: string;
  /** The file the product and the reference read, and its format. */
  file: string;
  format: string;
  /** What keys the cached reference measurement: corpus files, or the digest of a public sample. */
  cacheFiles: string[];
  cacheSettings: Record<string, string>;
  timed: boolean;
}

interface Trace {
  ssim: number;
  paths: number;
  bytes: number;
}

const formatOf = (name: string): string => name.slice(name.lastIndexOf('.') + 1);
const caseOf = (name: string): string => `${name}->svg`;

async function twoFrameGif(ctx: FamilyContext): Promise<string> {
  const { data, info } = await sharp(ctx.corpusBuffer(ANIMATION.from)).flatten({ background: '#ffffff' }).toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const negative = Buffer.from(data.map((value) => 255 - value));
  const file = ctx.scratch(ANIMATION.name);
  await sharp(Buffer.concat([data, negative]), { raw: { width: info.width, height: info.height * 2, channels: info.channels, pageHeight: info.height } }).gif().toFile(file);
  return file;
}

function trace(ctx: FamilyContext, paths: Record<string, string>, svgFile: string, source: string): Trace {
  const svg = fs.readFileSync(svgFile, 'utf8');
  const drawn = ctx.scratch('drawn.png');
  runTool(paths[RSVG], ['--format', 'png', '--output', drawn, svgFile]);
  const flatDrawn = ctx.scratch('drawn-flat.png');
  const flatSource = ctx.scratch('source-flat.png');
  flattenOnGrey(paths.ffmpeg, paths.ffprobe, drawn, flatDrawn);
  flattenOnGrey(paths.ffmpeg, paths.ffprobe, source, flatSource);
  return { ssim: measureSsimPsnr(paths.ffmpeg, flatDrawn, flatSource).ssim, paths: (svg.match(/<path\b/g) ?? []).length, bytes: Buffer.byteLength(svg) };
}

async function runSubject(ctx: FamilyContext, subject: Subject): Promise<BenchRow[]> {
  const plan = ctx.plan(TOOLS, subject.caseName);
  if (!plan.ok) return skippedGroup(FAMILY, subject.caseName, [...QUALITY_SPECS, SPEC.throughput], REFERENCE, plan);
  ctx.log(`${FAMILY} ${subject.caseName}`);
  const input = fs.readFileSync(subject.file);
  const ours = async (): Promise<Buffer> => (await convertWithProject(input, subject.format, 'svg', {}, subject.caseName.replace(/->svg$/, ''))).buffer;
  const reference = (out: string): void => {
    runTool(plan.paths[REFERENCE], ['--input', subject.file, '--output', out]);
  };
  const rows: BenchRow[] = [];
  if (ctx.quality) {
    const oursFile = ctx.scratch('ours.svg');
    fs.writeFileSync(oursFile, await ours());
    const measuredReference = await ctx.refCache.value(
      FAMILY,
      { kind: 'vtracer-defaults', tools: TOOLS, files: subject.cacheFiles, settings: { case: subject.caseName, ...subject.cacheSettings } },
      parseTrace,
      () => {
        const out = ctx.scratch('reference.svg');
        reference(out);
        return trace(ctx, plan.paths, out, subject.file);
      }
    );
    const measuredOurs = trace(ctx, plan.paths, oursFile, subject.file);
    rows.push(
      measuredRow(FAMILY, subject.caseName, SPEC.ssim, measuredOurs.ssim, measuredReference.ssim, REFERENCE),
      measuredRow(FAMILY, subject.caseName, SPEC.svgPaths, measuredOurs.paths, measuredReference.paths, REFERENCE),
      measuredRow(FAMILY, subject.caseName, SPEC.bytes, measuredOurs.bytes, measuredReference.bytes, REFERENCE)
    );
  }
  if (ctx.speed && subject.timed) {
    const out = ctx.scratch('timing.svg');
    const timing = await ctx.time(
      speedRowId(FAMILY, subject.caseName),
      async () => {
        await ours();
      },
      () => reference(out),
      'light'
    );
    rows.push(throughputRow(FAMILY, subject.caseName, input.length, timing, REFERENCE));
  }
  return rows;
}

async function subjects(ctx: FamilyContext): Promise<Array<Subject | BenchRow[]>> {
  const list: Array<Subject | BenchRow[]> = [];
  for (const name of GENERATED) {
    if (!ctx.inScope(FAMILY, caseOf(name))) continue;
    list.push({ caseName: caseOf(name), file: ctx.corpusPath(name), format: formatOf(name), cacheFiles: [name], cacheSettings: {}, timed: true });
  }
  if (ctx.inScope(FAMILY, caseOf(ANIMATION.name))) {
    list.push({ caseName: caseOf(ANIMATION.name), file: await twoFrameGif(ctx), format: 'gif', cacheFiles: [ANIMATION.from], cacheSettings: { frames: '2' }, timed: true });
  }
  for (const id of PUBLIC) {
    const caseName = caseOf(id);
    if (!ctx.inScope(FAMILY, caseName) || !ctx.quality) continue;
    const sample = remoteSample(id);
    const file = sample === undefined ? null : await ctx.remote(sample);
    if (sample === undefined || file === null) {
      list.push(unavailableSampleRows(FAMILY, caseName, QUALITY_SPECS, REFERENCE, id));
      continue;
    }
    // The tracer takes the format from the extension, so it reads the sample under its own name.
    const named = ctx.scratch(id);
    fs.copyFileSync(file, named);
    list.push({ caseName, file: named, format: formatOf(id), cacheFiles: [], cacheSettings: { sha256: sample.sha256 }, timed: false });
  }
  return list;
}

export const runVectorize: FamilyRunner = async (ctx) => {
  const rows: BenchRow[] = [];
  for (const subject of await subjects(ctx)) {
    rows.push(...(Array.isArray(subject) ? subject : await runSubject(ctx, subject)));
  }
  return rows;
};
