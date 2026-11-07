import fs from 'node:fs';
import path from 'node:path';
import { convertWithProject } from '../convert';
import type { FamilyContext, FamilyRunner } from '../context';
import { measureSsimPsnr } from '../measure';
import type { BenchRow } from '../report';
import { measuredRow, type MetricSpec, skippedGroup, SPEC } from '../rows';
import { runTool } from '../tools';
import { cropToContent } from '../vector-raster';

/**
 * Raster pictures and SVG written from vector sources, added by entry 187 of docs/policy-decisions.md. The sources draw the list of
 * solid shapes of the vector family (bench/corpus/vector/shapes.*), and the truth is that list rasterised analytically
 * (`shapes.truth.png`), so SSIM scores a picture against the geometry itself:
 * - SVG and EPS written as an icon and as a Photoshop file, against ImageMagick, which writes the same formats from a picture that
 *   librsvg (SVG) or Ghostscript (EPS) drew. The icon is the reference's default of 32 by 32 pixels; the product's icon is the
 *   square canvas of the shared image writer (up to 256 by 256), so the row compares how much of the geometry each icon keeps;
 * - a Windows metafile (the office suite saves `shapes.svg` as EMF) written as BMP, GIF, TIFF, WebP, AVIF, ICO and PSD, against
 *   the same formats written by ImageMagick from the picture the office suite draws of that metafile;
 * - an Illustrator file (the sample of the vector family) written as SVG, against the SVG that Poppler's `pdftocairo` writes of it.
 * Both sides draw an SVG or an EPS at the reference's default density of 300 dpi (the product's default too, 1/72 inch to a user unit or a point), so that
 * neither is scored on a coarser render than the other. Every output, ours and the reference's, is read back by the same decoder (ImageMagick for the raster formats, librsvg for SVG),
 * cropped to its content and scored against the truth cropped the same way, because the formats place the geometry on canvases of
 * different sizes. The ODD target has no tool that writes it, so it is checked by tests/vector-pairs.test.ts alone.
 */

const TRUTH = 'vector/shapes.truth.png';
const TRUTH_SIZE = { width: 400, height: 300 };
const RSVG = 'rsvg-convert';
const IMAGEMAGICK = 'ImageMagick';
const OFFICE = 'soffice';
const POPPLER = 'pdftocairo';
const SPECS: readonly MetricSpec[] = [SPEC.ssim];
/** The icon the reference writes without options (its `width` and `height` default to 32). */
const REFERENCE_ICON_SIDE = 32;
/** The density the reference draws a vector source at without options (its `pixel_density` defaults to 300); the product's default is 300 dpi too. */
const REFERENCE_DENSITY = 300;
/** One user unit of an SVG or one PostScript point is 1/72 inch at the density the product and the reference draw at. */
const POINTS_PER_INCH = 72;
const RENDER_WIDTH_PX = 400;
const METAFILE_RASTERS = ['bmp', 'gif', 'tiff', 'webp', 'avif', 'ico', 'psd'] as const;
const SVG_AND_EPS_RASTERS = ['ico', 'psd'] as const;
const IMAGEMAGICK_FORMAT: Readonly<Record<string, string>> = { psd: 'psd', ico: 'ico', bmp: 'bmp', gif: 'gif', tiff: 'tiff', webp: 'webp', avif: 'avif' };

function sofficeProfile(ctx: FamilyContext): string {
  return `file://${path.join(ctx.work, 'soffice-profile-vector-pairs')}`;
}

function sofficeConvert(soffice: string, profile: string, input: string, target: string, outDir: string): string {
  fs.mkdirSync(outDir, { recursive: true });
  runTool(soffice, [`-env:UserInstallation=${profile}`, '--headless', '--convert-to', target, '--outdir', outDir, input]);
  return path.join(outDir, `${path.parse(input).name}.${target}`);
}

/** The picture ImageMagick writes in `format` from `png`; an icon is written at the reference's size, a picture of another size is left as it is. */
function magickWrite(magick: string, png: string, format: string, out: string): string {
  const args = format === 'ico' ? [png, '-resize', `${REFERENCE_ICON_SIDE}x${REFERENCE_ICON_SIDE}`, `${IMAGEMAGICK_FORMAT[format]}:${out}`] : [png, `${IMAGEMAGICK_FORMAT[format]}:${out}`];
  runTool(magick, args);
  return out;
}

/** The first picture of a file in any raster format, as a PNG, decoded by ImageMagick (a Photoshop file is read as its flattened image). */
function magickRead(magick: string, file: string, format: string, out: string): string {
  runTool(magick, [`${IMAGEMAGICK_FORMAT[format]}:${file}[0]`, '-background', 'white', '-alpha', 'remove', '-alpha', 'off', out]);
  return out;
}

/** SSIM of a PNG cropped to its content against the truth cropped the same way. */
function ssimAgainstTruth(ctx: FamilyContext, tools: { ffmpeg: string; magick: string }, png: string, truth: string): number {
  const cropped = cropToContent(tools.magick, png, ctx.scratch('cropped.png'), TRUTH_SIZE.width, TRUTH_SIZE.height);
  const truthCropped = cropToContent(tools.magick, truth, ctx.scratch('truth-cropped.png'), TRUTH_SIZE.width, TRUTH_SIZE.height);
  return measureSsimPsnr(tools.ffmpeg, cropped, truthCropped, TRUTH_SIZE).ssim;
}

interface Source {
  extension: 'svg' | 'eps' | 'emf';
  /** The source file the product converts, written in the scratch directory when the source is made by another program. */
  file: (drawer: string) => string;
  /** The picture the reference tool of the source (the program at `drawer`) draws of it, a PNG, which ImageMagick then writes in the target format. */
  drawn: (out: string, drawer: string) => string;
  /** The tool that draws the source for the reference. */
  drawer: string;
}

async function oursRow(ctx: FamilyContext, source: Source, target: string, tools: { ffmpeg: string; magick: string; drawer: string }): Promise<number> {
  const bytes = fs.readFileSync(source.file(tools.drawer));
  const output = (await convertWithProject(bytes, source.extension, target, {}, `shapes.${source.extension}`)).buffer;
  const file = ctx.scratch(`ours.${target}`);
  fs.writeFileSync(file, output);
  const png = magickRead(tools.magick, file, target, ctx.scratch('ours-read.png'));
  return ssimAgainstTruth(ctx, tools, png, ctx.corpusPath(TRUTH));
}

function referenceScore(ctx: FamilyContext, source: Source, target: string, tools: { ffmpeg: string; magick: string; drawer: string }): number {
  const drawn = source.drawn(ctx.scratch('reference-drawn.png'), tools.drawer);
  const written = magickWrite(tools.magick, drawn, target, ctx.scratch(`reference.${target}`));
  const png = magickRead(tools.magick, written, target, ctx.scratch('reference-read.png'));
  return ssimAgainstTruth(ctx, tools, png, ctx.corpusPath(TRUTH));
}

async function runRaster(ctx: FamilyContext, source: Source, targets: readonly string[], referenceTool: string, rows: BenchRow[]): Promise<void> {
  for (const target of targets) {
    const caseName = `shapes.${source.extension}->${target}`;
    if (!ctx.inScope('vector', caseName) || !ctx.quality) continue;
    const plan = ctx.plan(['ffmpeg', 'magick', source.drawer], caseName);
    if (!plan.ok) {
      rows.push(...skippedGroup('vector', caseName, SPECS, referenceTool, plan));
      continue;
    }
    ctx.log(`vector ${caseName}`);
    const tools = { ffmpeg: plan.paths.ffmpeg, magick: plan.paths.magick, drawer: plan.paths[source.drawer] };
    rows.push(measuredRow('vector', caseName, SPEC.ssim, await oursRow(ctx, source, target, tools), referenceScore(ctx, source, target, tools), referenceTool));
  }
}

function svgSource(ctx: FamilyContext): Source {
  return {
    extension: 'svg',
    file: () => ctx.corpusPath('vector/shapes.svg'),
    drawn: (out, rsvg) => {
      runTool(rsvg, ['--format', 'png', '--background-color', 'white', '--zoom', String(REFERENCE_DENSITY / POINTS_PER_INCH), '--output', out, ctx.corpusPath('vector/shapes.svg')]);
      return out;
    },
    drawer: RSVG,
  };
}

function epsSource(ctx: FamilyContext): Source {
  return {
    extension: 'eps',
    file: () => ctx.corpusPath('vector/shapes.eps'),
    drawn: (out, gs) => {
      runTool(gs, ['-q', '-dBATCH', '-dNOPAUSE', '-dSAFER', '-dEPSCrop', '-sDEVICE=png16m', `-r${REFERENCE_DENSITY}`, '-dGraphicsAlphaBits=4', '-dTextAlphaBits=4', `-sOutputFile=${out}`, ctx.corpusPath('vector/shapes.eps')]);
      return out;
    },
    drawer: 'gs',
  };
}

/** `shapes.svg` saved as EMF by the office suite: a metafile written by a program that is not the product. */
function emfSource(ctx: FamilyContext): Source {
  const profile = sofficeProfile(ctx);
  const emf = (soffice: string): string => sofficeConvert(soffice, profile, ctx.corpusPath('vector/shapes.svg'), 'emf', ctx.scratch('source-emf'));
  return {
    extension: 'emf',
    file: emf,
    drawn: (out, soffice) => {
      const drawn = sofficeConvert(soffice, profile, emf(soffice), 'png', ctx.scratch('reference-emf-png'));
      fs.copyFileSync(drawn, out);
      return out;
    },
    drawer: OFFICE,
  };
}

/** An Illustrator file written as SVG, against the SVG that Poppler writes of it. */
async function runIllustrator(ctx: FamilyContext, rows: BenchRow[]): Promise<void> {
  const caseName = 'shapes.ai->svg';
  if (!ctx.inScope('vector', caseName) || !ctx.quality) return;
  const plan = ctx.plan(['ffmpeg', 'magick', 'gs', POPPLER, RSVG], caseName);
  if (!plan.ok) return void rows.push(...skippedGroup('vector', caseName, SPECS, POPPLER, plan));
  ctx.log(`vector ${caseName}`);
  const { ffmpeg, magick, gs, pdftocairo } = plan.paths;
  const rsvg = plan.paths[RSVG];
  const aiFile = path.join(ctx.scratch('ai'), 'shapes.ai');
  fs.mkdirSync(path.dirname(aiFile), { recursive: true });
  runTool(gs, ['-q', '-dBATCH', '-dNOPAUSE', '-dSAFER', '-dEPSCrop', '-sDEVICE=pdfwrite', `-sOutputFile=${aiFile}`, ctx.corpusPath('vector/shapes.eps')]);
  const tools = { ffmpeg, magick };
  const drawn = (svg: string, out: string): string => {
    runTool(rsvg, ['--format', 'png', '--background-color', 'white', '--width', String(RENDER_WIDTH_PX), '--output', out, svg]);
    return out;
  };
  const oursSvg = ctx.scratch('ours-ai.svg');
  fs.writeFileSync(oursSvg, (await convertWithProject(fs.readFileSync(aiFile), 'ai', 'svg', {}, 'shapes.ai')).buffer);
  const referenceSvg = ctx.scratch('reference-ai.svg');
  runTool(pdftocairo, ['-svg', '-f', '1', '-l', '1', aiFile, referenceSvg]);
  const truth = ctx.corpusPath(TRUTH);
  const ours = ssimAgainstTruth(ctx, tools, drawn(oursSvg, ctx.scratch('ours-ai.png')), truth);
  const reference = ssimAgainstTruth(ctx, tools, drawn(referenceSvg, ctx.scratch('reference-ai.png')), truth);
  rows.push(measuredRow('vector', caseName, SPEC.ssim, ours, reference, POPPLER));
}

export const runVectorPairs: FamilyRunner = async (ctx) => {
  const rows: BenchRow[] = [];
  await runRaster(ctx, svgSource(ctx), SVG_AND_EPS_RASTERS, IMAGEMAGICK, rows);
  await runRaster(ctx, epsSource(ctx), SVG_AND_EPS_RASTERS, IMAGEMAGICK, rows);
  await runRaster(ctx, emfSource(ctx), METAFILE_RASTERS, OFFICE, rows);
  await runIllustrator(ctx, rows);
  return rows;
};
