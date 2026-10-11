import fs from 'node:fs';
import path from 'node:path';
import { convertWithProject } from '../convert';
import type { FamilyContext, FamilyRunner } from '../context';
import { emfViolations, wmfViolations } from '../metafile-check';
import { measureSsimPsnr } from '../measure';
import { numberRecord } from '../ref-cache';
import type { BenchRow } from '../report';
import { capPsnr, measuredRow, type MetricSpec, skippedGroup, skippedRow, SPEC, throughputRow, speedRowId } from '../rows';
import { characterErrorRatePercent, wordF1 } from '../text-metrics';
import { runTool } from '../tools';
import { cropToContent, renderPdfPage } from '../vector-raster';

/**
 * Vector graphics family: SVG, EPS, an Illustrator file and the Windows metafiles we write, against librsvg
 * (`rsvg-convert`), Ghostscript and the office suite's drawing export, each judged by an oracle that is none of them.
 *
 * - `shapes.svg` and `shapes.eps` draw one list of solid shapes; `shapes.truth.png` is that list rasterised analytically
 *   (bench/corpus/generate-vector-cad.ts), so SSIM and PSNR score a renderer against the geometry itself.
 * - A PDF is drawn by Poppler at the width of the truth; `pdfimages` counts the raster pictures in it (a vector drawing
 *   that was rasterised into the PDF shows up there), and `label.svg` is read back with `pdftotext` and scored against
 *   the words it was written with.
 * - EMF and WMF are checked against their specifications by an independent reader (bench/metafile-check.ts) and drawn
 *   by the office suite, cropped to their content on both sides because the suite places a metafile on a page.
 * - An Illustrator file is a PDF with private data; the sample is shapes.eps written as a PDF by Ghostscript.
 */

const TRUTH = 'vector/shapes.truth.png';
const TRUTH_SIZE = { width: 400, height: 300 };
const RSVG = 'rsvg-convert';
const GHOSTSCRIPT = 'Ghostscript';
const OFFICE = 'soffice';
const RENDER_DPI = 72;
const ANTIALIAS_BITS = '4';
const PICTURE_SPECS: readonly MetricSpec[] = [SPEC.ssim, SPEC.psnr, SPEC.throughput];
const PDF_SPECS: readonly MetricSpec[] = [SPEC.ssim, SPEC.psnr, SPEC.pdfEmbeddedImages, SPEC.throughput];
const METAFILE_SPECS: readonly MetricSpec[] = [SPEC.ssim, SPEC.metafileViolations, SPEC.throughput];
const LABEL_SPECS: readonly MetricSpec[] = [SPEC.wordF1, SPEC.cer];
const parsePicture = numberRecord(['ssim', 'psnr']);
const parsePdf = numberRecord(['ssim', 'psnr', 'images']);
const parseMetafile = numberRecord(['ssim', 'violations']);
const parseLabel = numberRecord(['wordF1', 'cer']);
/** Failures that say the pair is not supported, as opposed to a harness or tool failure. */
const UNSUPPORTED_ERRORS: ReadonlySet<string> = new Set(['ConversionFailedError', 'UnsupportedTargetError', 'CadGeometryUnavailableError']);

function scoreAgainstTruth(ffmpeg: string, picture: string, truth: string): { ssim: number; psnr: number } {
  const score = measureSsimPsnr(ffmpeg, picture, truth, TRUTH_SIZE);
  return { ssim: score.ssim, psnr: capPsnr(score.psnr) };
}

/** Number of raster pictures in a PDF, from the listing of `pdfimages` (two header lines, then one line per picture). */
function pdfImageCount(pdfimages: string, pdf: string): number {
  const header = 2;
  const lines = runTool(pdfimages, ['-list', pdf]).stdout.toString('utf8').split('\n').filter((line) => line.trim() !== '');
  return Math.max(0, lines.length - header);
}

function pdfText(pdftotext: string, pdf: string): string {
  return runTool(pdftotext, ['-enc', 'UTF-8', pdf, '-']).stdout.toString('utf8');
}

function sofficeProfile(ctx: FamilyContext): string {
  return `file://${path.join(ctx.work, 'soffice-profile-vector')}`;
}

function sofficeConvert(soffice: string, profile: string, input: string, target: string, outDir: string): string {
  fs.mkdirSync(outDir, { recursive: true });
  runTool(soffice, [`-env:UserInstallation=${profile}`, '--headless', '--convert-to', target, '--outdir', outDir, input]);
  return path.join(outDir, `${path.parse(input).name}.${target}`);
}

/** Interleaved timing of two actions whose results are not needed. */
function timeBoth(ctx: FamilyContext, rowId: string, ours: () => Promise<unknown>, reference: () => unknown, weight: 'light' | 'heavy'): ReturnType<FamilyContext['time']> {
  return ctx.time(
    rowId,
    async () => {
      await ours();
    },
    () => {
      reference();
    },
    weight
  );
}

function wanted(ctx: FamilyContext, ...cases: string[]): boolean {
  return cases.some((name) => ctx.inScope('vector', name));
}

/** shapes.svg to PNG and PDF against librsvg. */
async function runShapesSvg(ctx: FamilyContext): Promise<BenchRow[]> {
  const png = 'shapes.svg->png';
  const pdf = 'shapes.svg->pdf';
  if (!wanted(ctx, png, pdf)) return [];
  const plan = ctx.plan(['ffmpeg', RSVG, 'pdftoppm', 'pdfimages'], 'vector shapes.svg');
  if (!plan.ok) {
    return [...skippedGroup('vector', png, PICTURE_SPECS, RSVG, plan), ...skippedGroup('vector', pdf, PDF_SPECS, RSVG, plan)];
  }
  ctx.log('vector shapes.svg');
  const { ffmpeg, pdftoppm, pdfimages } = plan.paths;
  const rsvg = plan.paths[RSVG];
  const svg = ctx.corpusBuffer('vector/shapes.svg');
  const svgFile = ctx.corpusPath('vector/shapes.svg');
  const truth = ctx.corpusPath(TRUTH);
  const tools = ['ffmpeg', RSVG, 'pdftoppm', 'pdfimages'];
  const files = ['vector/shapes.svg', TRUTH];
  const rows: BenchRow[] = [];

  const oursPng = async (): Promise<Buffer> => (await convertWithProject(svg, 'svg', 'png', { dpi: RENDER_DPI }, 'shapes.svg')).buffer;
  const referencePng = (out: string): void => {
    runTool(rsvg, ['--format', 'png', '--output', out, svgFile]);
  };
  if (wanted(ctx, png)) {
    if (ctx.quality) {
      const oursFile = ctx.scratch('ours-shapes.png');
      fs.writeFileSync(oursFile, await oursPng());
      const reference = await ctx.refCache.value('vector', { kind: 'rsvg-png', tools, files, settings: { case: png } }, parsePicture, () => {
        const out = ctx.scratch('ref-shapes.png');
        referencePng(out);
        return scoreAgainstTruth(ffmpeg, out, truth);
      });
      const ours = scoreAgainstTruth(ffmpeg, oursFile, truth);
      rows.push(measuredRow('vector', png, SPEC.ssim, ours.ssim, reference.ssim, RSVG), measuredRow('vector', png, SPEC.psnr, ours.psnr, reference.psnr, RSVG));
    }
    if (ctx.speed) {
      const out = ctx.scratch('timing-shapes.png');
      rows.push(throughputRow('vector', png, svg.length, await timeBoth(ctx, speedRowId('vector', png), oursPng, () => referencePng(out), 'light'), RSVG));
    }
  }

  const oursPdf = async (): Promise<Buffer> => (await convertWithProject(svg, 'svg', 'pdf', {}, 'shapes.svg')).buffer;
  const referencePdf = (out: string): void => {
    runTool(rsvg, ['--format', 'pdf', '--output', out, svgFile]);
  };
  const pdfMeasure = (file: string): { ssim: number; psnr: number; images: number } => {
    const page = renderPdfPage(pdftoppm, file, ctx.scratch('page.png'), TRUTH_SIZE.width);
    return { ...scoreAgainstTruth(ffmpeg, page, truth), images: pdfImageCount(pdfimages, file) };
  };
  if (wanted(ctx, pdf)) {
    if (ctx.quality) {
      const oursFile = ctx.scratch('ours-shapes.pdf');
      fs.writeFileSync(oursFile, await oursPdf());
      const reference = await ctx.refCache.value('vector', { kind: 'rsvg-pdf', tools, files, settings: { case: pdf, width: TRUTH_SIZE.width } }, parsePdf, () => {
        const out = ctx.scratch('ref-shapes.pdf');
        referencePdf(out);
        return pdfMeasure(out);
      });
      const ours = pdfMeasure(oursFile);
      rows.push(
        measuredRow('vector', pdf, SPEC.ssim, ours.ssim, reference.ssim, RSVG),
        measuredRow('vector', pdf, SPEC.psnr, ours.psnr, reference.psnr, RSVG),
        measuredRow('vector', pdf, SPEC.pdfEmbeddedImages, ours.images, reference.images, RSVG)
      );
    }
    if (ctx.speed) {
      const out = ctx.scratch('timing-shapes.pdf');
      rows.push(throughputRow('vector', pdf, svg.length, await timeBoth(ctx, speedRowId('vector', pdf), oursPdf, () => referencePdf(out), 'light'), RSVG));
    }
  }
  return rows;
}

/** label.svg to PDF: the words of the drawing must survive as text, as they do in librsvg's PDF. */
async function runLabel(ctx: FamilyContext): Promise<BenchRow[]> {
  const caseName = 'label.svg->pdf';
  if (!wanted(ctx, caseName) || !ctx.quality) return [];
  const plan = ctx.plan(['pdftotext', RSVG], caseName);
  if (!plan.ok) return skippedGroup('vector', caseName, LABEL_SPECS, RSVG, plan);
  ctx.log(`vector ${caseName}`);
  const { pdftotext } = plan.paths;
  const rsvg = plan.paths[RSVG];
  const truth = fs.readFileSync(ctx.corpusPath('vector/label.gt.txt'), 'utf8');
  const oursFile = ctx.scratch('ours-label.pdf');
  fs.writeFileSync(oursFile, (await convertWithProject(ctx.corpusBuffer('vector/label.svg'), 'svg', 'pdf', {}, 'label.svg')).buffer);
  const oursText = pdfText(pdftotext, oursFile);
  const reference = await ctx.refCache.value(
    'vector',
    { kind: 'rsvg-label-text', tools: ['pdftotext', RSVG], files: ['vector/label.svg', 'vector/label.gt.txt'], settings: { case: caseName } },
    parseLabel,
    () => {
      const out = ctx.scratch('ref-label.pdf');
      runTool(rsvg, ['--format', 'pdf', '--output', out, ctx.corpusPath('vector/label.svg')]);
      const text = pdfText(pdftotext, out);
      return { wordF1: wordF1(truth, text), cer: characterErrorRatePercent(truth, text) };
    }
  );
  return [
    measuredRow('vector', caseName, SPEC.wordF1, wordF1(truth, oursText), reference.wordF1, RSVG),
    measuredRow('vector', caseName, SPEC.cer, characterErrorRatePercent(truth, oursText), reference.cer, RSVG),
  ];
}

/** shapes.svg to EMF and WMF against the office suite's drawing export. */
async function runMetafiles(ctx: FamilyContext): Promise<BenchRow[]> {
  const rows: BenchRow[] = [];
  const profile = sofficeProfile(ctx);
  for (const target of ['emf', 'wmf'] as const) {
    const caseName = `shapes.svg->${target}`;
    if (!wanted(ctx, caseName)) continue;
    const plan = ctx.plan(['ffmpeg', 'magick', OFFICE], caseName);
    if (!plan.ok) {
      rows.push(...skippedGroup('vector', caseName, METAFILE_SPECS, OFFICE, plan));
      continue;
    }
    ctx.log(`vector ${caseName}`);
    const { ffmpeg, magick, soffice } = plan.paths;
    const svg = ctx.corpusBuffer('vector/shapes.svg');
    const svgFile = ctx.corpusPath('vector/shapes.svg');
    const check = target === 'emf' ? emfViolations : wmfViolations;
    const oursMetafile = async (): Promise<Buffer> => (await convertWithProject(svg, 'svg', target, {}, 'shapes.svg')).buffer;
    const referenceMetafile = (outDir: string): string => sofficeConvert(soffice, profile, svgFile, target, outDir);
    /** The metafile drawn by the office suite, cropped to its content, scored against the truth cropped the same way. */
    const measure = (metafile: string): { ssim: number; violations: number } => {
      const violations = check(fs.readFileSync(metafile)).length;
      const drawn = sofficeConvert(soffice, profile, metafile, 'png', ctx.scratch('metafile-png'));
      const cropped = cropToContent(magick, drawn, ctx.scratch('cropped.png'), TRUTH_SIZE.width, TRUTH_SIZE.height);
      const truth = cropToContent(magick, ctx.corpusPath(TRUTH), ctx.scratch('truth-cropped.png'), TRUTH_SIZE.width, TRUTH_SIZE.height);
      return { ssim: measureSsimPsnr(ffmpeg, cropped, truth, TRUTH_SIZE).ssim, violations };
    };
    if (ctx.quality) {
      const oursFile = path.join(ctx.scratch(`ours-${target}`), `ours-shapes.${target}`);
      fs.mkdirSync(path.dirname(oursFile), { recursive: true });
      fs.writeFileSync(oursFile, await oursMetafile());
      const reference = await ctx.refCache.value(
        'vector',
        { kind: `soffice-${target}`, tools: ['ffmpeg', 'magick', OFFICE], files: ['vector/shapes.svg', TRUTH], settings: { case: caseName } },
        parseMetafile,
        () => measure(referenceMetafile(ctx.scratch(`ref-${target}`)))
      );
      const ours = measure(oursFile);
      rows.push(
        measuredRow('vector', caseName, SPEC.ssim, ours.ssim, reference.ssim, OFFICE),
        measuredRow('vector', caseName, SPEC.metafileViolations, ours.violations, reference.violations, OFFICE)
      );
    }
    if (ctx.speed) {
      rows.push(throughputRow('vector', caseName, svg.length, await timeBoth(ctx, speedRowId('vector', caseName), oursMetafile, () => referenceMetafile(ctx.scratch(`timing-${target}`)), 'heavy'), OFFICE));
    }
  }
  return rows;
}

/** shapes.eps to PNG and PDF against Ghostscript. */
async function runEps(ctx: FamilyContext): Promise<BenchRow[]> {
  const png = 'shapes.eps->png';
  const pdf = 'shapes.eps->pdf';
  if (!wanted(ctx, png, pdf)) return [];
  const plan = ctx.plan(['ffmpeg', 'gs', 'pdftoppm', 'pdfimages'], 'vector shapes.eps');
  if (!plan.ok) return [...skippedGroup('vector', png, PICTURE_SPECS, GHOSTSCRIPT, plan), ...skippedGroup('vector', pdf, PDF_SPECS, GHOSTSCRIPT, plan)];
  ctx.log('vector shapes.eps');
  const { ffmpeg, gs, pdftoppm, pdfimages } = plan.paths;
  const eps = ctx.corpusBuffer('vector/shapes.eps');
  const epsFile = ctx.corpusPath('vector/shapes.eps');
  const truth = ctx.corpusPath(TRUTH);
  const tools = ['ffmpeg', 'gs', 'pdftoppm', 'pdfimages'];
  const files = ['vector/shapes.eps', TRUTH];
  const device = (name: string, out: string): string[] => ['-q', '-dBATCH', '-dNOPAUSE', '-dSAFER', '-dEPSCrop', `-sDEVICE=${name}`, `-dGraphicsAlphaBits=${ANTIALIAS_BITS}`, `-dTextAlphaBits=${ANTIALIAS_BITS}`, `-sOutputFile=${out}`, epsFile];
  const rows: BenchRow[] = [];

  const oursPng = async (): Promise<Buffer> => (await convertWithProject(eps, 'eps', 'png', { dpi: RENDER_DPI }, 'shapes.eps')).buffer;
  const referencePng = (out: string): void => {
    runTool(gs, [...device('png16m', out), `-r${RENDER_DPI}`]);
  };
  if (wanted(ctx, png)) {
    if (ctx.quality) {
      const oursFile = ctx.scratch('ours-eps.png');
      fs.writeFileSync(oursFile, await oursPng());
      const reference = await ctx.refCache.value('vector', { kind: 'gs-png', tools, files, settings: { case: png, dpi: RENDER_DPI, alphaBits: ANTIALIAS_BITS } }, parsePicture, () => {
        const out = ctx.scratch('ref-eps.png');
        referencePng(out);
        return scoreAgainstTruth(ffmpeg, out, truth);
      });
      const ours = scoreAgainstTruth(ffmpeg, oursFile, truth);
      rows.push(measuredRow('vector', png, SPEC.ssim, ours.ssim, reference.ssim, GHOSTSCRIPT), measuredRow('vector', png, SPEC.psnr, ours.psnr, reference.psnr, GHOSTSCRIPT));
    }
    if (ctx.speed) {
      const out = ctx.scratch('timing-eps.png');
      rows.push(throughputRow('vector', png, eps.length, await timeBoth(ctx, speedRowId('vector', png), oursPng, () => referencePng(out), 'heavy'), GHOSTSCRIPT));
    }
  }

  const oursPdf = async (): Promise<Buffer> => (await convertWithProject(eps, 'eps', 'pdf', {}, 'shapes.eps')).buffer;
  const referencePdf = (out: string): void => {
    runTool(gs, ['-q', '-dBATCH', '-dNOPAUSE', '-dSAFER', '-dEPSCrop', '-sDEVICE=pdfwrite', `-sOutputFile=${out}`, epsFile]);
  };
  const pdfMeasure = (file: string): { ssim: number; psnr: number; images: number } => {
    const page = renderPdfPage(pdftoppm, file, ctx.scratch('page.png'), TRUTH_SIZE.width);
    return { ...scoreAgainstTruth(ffmpeg, page, truth), images: pdfImageCount(pdfimages, file) };
  };
  if (wanted(ctx, pdf)) {
    if (ctx.quality) {
      const oursFile = ctx.scratch('ours-eps.pdf');
      fs.writeFileSync(oursFile, await oursPdf());
      const reference = await ctx.refCache.value('vector', { kind: 'gs-pdf', tools, files, settings: { case: pdf, width: TRUTH_SIZE.width } }, parsePdf, () => {
        const out = ctx.scratch('ref-eps.pdf');
        referencePdf(out);
        return pdfMeasure(out);
      });
      const ours = pdfMeasure(oursFile);
      rows.push(
        measuredRow('vector', pdf, SPEC.ssim, ours.ssim, reference.ssim, GHOSTSCRIPT),
        measuredRow('vector', pdf, SPEC.psnr, ours.psnr, reference.psnr, GHOSTSCRIPT),
        measuredRow('vector', pdf, SPEC.pdfEmbeddedImages, ours.images, reference.images, GHOSTSCRIPT)
      );
    }
    if (ctx.speed) {
      const out = ctx.scratch('timing-eps.pdf');
      rows.push(throughputRow('vector', pdf, eps.length, await timeBoth(ctx, speedRowId('vector', pdf), oursPdf, () => referencePdf(out), 'heavy'), GHOSTSCRIPT));
    }
  }
  return rows;
}

/** An Illustrator file (a PDF with private data) to PNG against Poppler. A pair the engine does not read is listed as unsupported. */
async function runIllustrator(ctx: FamilyContext): Promise<BenchRow[]> {
  const caseName = 'shapes.ai->png';
  if (!wanted(ctx, caseName)) return [];
  const plan = ctx.plan(['ffmpeg', 'gs', 'pdftoppm'], caseName);
  if (!plan.ok) return skippedGroup('vector', caseName, PICTURE_SPECS, 'pdftoppm', plan);
  ctx.log(`vector ${caseName}`);
  const { ffmpeg, gs, pdftoppm } = plan.paths;
  const aiFile = path.join(ctx.scratch('ai'), 'shapes.ai');
  fs.mkdirSync(path.dirname(aiFile), { recursive: true });
  runTool(gs, ['-q', '-dBATCH', '-dNOPAUSE', '-dSAFER', '-dEPSCrop', '-sDEVICE=pdfwrite', `-sOutputFile=${aiFile}`, ctx.corpusPath('vector/shapes.eps')]);
  const ai = fs.readFileSync(aiFile);
  const oursPng = async (): Promise<Buffer> => (await convertWithProject(ai, 'ai', 'png', { dpi: RENDER_DPI }, 'shapes.ai')).buffer;
  let oursBytes: Buffer;
  try {
    oursBytes = await oursPng();
  } catch (error) {
    if (!(error instanceof Error) || !UNSUPPORTED_ERRORS.has(error.name)) throw error;
    const reason = `the engine does not read an Illustrator file (${error.name}: ${error.message.slice(0, 160)})`;
    return PICTURE_SPECS.filter((spec) => (spec.kind === 'throughput' ? ctx.speed : ctx.quality)).map((spec) => skippedRow('vector', caseName, spec, 'pdftoppm', 'unsupported', reason));
  }
  const referencePng = (out: string): void => {
    renderPdfPage(pdftoppm, aiFile, out, TRUTH_SIZE.width);
  };
  const truth = ctx.corpusPath(TRUTH);
  const rows: BenchRow[] = [];
  if (ctx.quality) {
    const oursFile = ctx.scratch('ours-ai.png');
    fs.writeFileSync(oursFile, oursBytes);
    const refFile = ctx.scratch('ref-ai.png');
    referencePng(refFile);
    const ours = scoreAgainstTruth(ffmpeg, oursFile, truth);
    const reference = scoreAgainstTruth(ffmpeg, refFile, truth);
    rows.push(measuredRow('vector', caseName, SPEC.ssim, ours.ssim, reference.ssim, 'pdftoppm'), measuredRow('vector', caseName, SPEC.psnr, ours.psnr, reference.psnr, 'pdftoppm'));
  }
  if (ctx.speed) {
    const out = ctx.scratch('timing-ai.png');
    rows.push(throughputRow('vector', caseName, ai.length, await timeBoth(ctx, speedRowId('vector', caseName), oursPng, () => referencePng(out), 'heavy'), 'pdftoppm'));
  }
  return rows;
}

export const runVector: FamilyRunner = async (ctx) => [
  ...(await runShapesSvg(ctx)),
  ...(await runLabel(ctx)),
  ...(await runMetafiles(ctx)),
  ...(await runEps(ctx)),
  ...(await runIllustrator(ctx)),
];
