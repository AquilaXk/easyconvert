import fs from 'node:fs';
import path from 'node:path';
import { bdRate, type RdPoint } from '../bd-rate';
import { convertWithProject } from '../convert';
import { type FamilyRunner, INJECTED_WEBP_QUALITY_SHARE } from '../context';
import { decodeImageToPng, fileSize, measureSsimulacra2, pictureQuality, type ImageKind } from '../measure';
import type { BenchRow } from '../report';
import { capPsnr, measuredRow, type MetricSpec, skippedGroup, skippedRow, SPEC, ssimDb, throughputRow } from '../rows';
import { interleavedTiming } from '../stats';
import { runTool } from '../tools';

/** Image family: jpg and png sources to webp, avif and jpg, against cwebp, avifenc and ImageMagick at matched quality. */

interface ImageCase {
  file: string;
  format: 'jpg' | 'png';
}

const CASES: readonly ImageCase[] = [
  { file: 'photo-a.jpg', format: 'jpg' },
  { file: 'photo-b.png', format: 'png' },
  { file: 'screenshot.png', format: 'png' },
  { file: 'lineart.png', format: 'png' },
];
const TARGETS = ['webp', 'avif', 'jpg'] as const;
type Target = (typeof TARGETS)[number];

/** Four quality settings for the BD-rate curve; the gated per-point rows use the headline one. */
const QUALITY_POINTS = [40, 55, 70, 85] as const;
const HEADLINE_QUALITY = 70;
/** cwebp -m 4 is the encoder effort the project's WebP path uses; avifenc -s 6 is its AVIF speed. */
const CWEBP_METHOD = '4';
const AVIFENC_SPEED = '6';

const REFERENCE_TOOL: Record<Target, string> = { webp: 'cwebp', avif: 'avifenc', jpg: 'magick' };
const REFERENCE_NAME: Record<Target, string> = { webp: 'cwebp', avif: 'avifenc', jpg: 'ImageMagick' };
const DECODER_TOOLS: Record<Target, readonly string[]> = { webp: ['dwebp'], avif: ['avifdec'], jpg: [] };

const GROUP_SPECS: readonly MetricSpec[] = [SPEC.ssim, SPEC.psnr, SPEC.bytes, SPEC.bdRatePsnr, SPEC.bdRateSsim, SPEC.throughput];

interface Encoded {
  bytes: number;
  ssim: number;
  psnr: number;
}

function referenceEncode(target: Target, binary: string, sourcePng: string, quality: number, output: string): void {
  const q = String(quality);
  if (target === 'webp') {
    runTool(binary, ['-quiet', '-q', q, '-m', CWEBP_METHOD, sourcePng, '-o', output]);
  } else if (target === 'avif') {
    runTool(binary, ['-q', q, '-s', AVIFENC_SPEED, '-j', 'all', sourcePng, output]);
  } else {
    runTool(binary, [sourcePng, '-quality', q, output]);
  }
}

export const runImage: FamilyRunner = async (ctx) => {
  const rows: BenchRow[] = [];
  const ssimulacraPlan = ctx.plan(['ssimulacra2'], 'image ssimulacra2 score', { optional: true });
  if (!ssimulacraPlan.ok) {
    rows.push(skippedRow('image', 'all', SPEC.ssimulacra2, 'ssimulacra2', 'optional-tool', ssimulacraPlan.reason));
  }

  for (const sample of CASES) {
    const input = ctx.corpusBuffer(sample.file);
    for (const target of TARGETS) {
      const caseName = `${sample.file}->${target}`;
      const refTool = REFERENCE_TOOL[target];
      const plan = ctx.plan(['ffmpeg', refTool, ...DECODER_TOOLS[target]], caseName);
      if (!plan.ok) {
        rows.push(...skippedGroup('image', caseName, GROUP_SPECS, REFERENCE_NAME[target], plan));
        continue;
      }
      ctx.log(`image ${caseName}`);
      const decoders = {
        ffmpeg: plan.paths.ffmpeg,
        dwebp: plan.paths.dwebp ?? null,
        avifdec: plan.paths.avifdec ?? null,
      };
      const sourcePng = ctx.scratch(`${sample.file}.png`);
      decodeImageToPng(sample.format, ctx.corpusPath(sample.file), sourcePng, decoders);

      const oursQuality = (quality: number): number =>
        ctx.injection === 'webp-quality' && target === 'webp' ? Math.round(quality * INJECTED_WEBP_QUALITY_SHARE) : quality;
      const oursEncode = async (quality: number): Promise<Buffer> => {
        const out = await convertWithProject(input, sample.format, target, { quality: oursQuality(quality) }, sample.file);
        return out.buffer;
      };
      const measure = (buffer: Buffer | null, file: string): Encoded => {
        if (buffer) fs.writeFileSync(file, buffer);
        const png = `${file}.png`;
        decodeImageToPng(target as ImageKind, file, png, decoders);
        const quality = pictureQuality(plan.paths.ffmpeg, png, sourcePng);
        return { bytes: fileSize(file), ssim: quality.ssim, psnr: capPsnr(quality.psnr) };
      };

      const ours = new Map<number, Encoded>();
      const reference = new Map<number, Encoded>();
      for (const quality of QUALITY_POINTS) {
        const oursFile = ctx.scratch(`ours-q${quality}.${target}`);
        ours.set(quality, measure(await oursEncode(quality), oursFile));
        const refFile = ctx.scratch(`ref-q${quality}.${target}`);
        referenceEncode(target, plan.paths[refTool], sourcePng, quality, refFile);
        reference.set(quality, measure(null, refFile));
      }

      const o = ours.get(HEADLINE_QUALITY) as Encoded;
      const r = reference.get(HEADLINE_QUALITY) as Encoded;
      const tool = REFERENCE_NAME[target];
      rows.push(measuredRow('image', caseName, SPEC.ssim, o.ssim, r.ssim, tool));
      rows.push(measuredRow('image', caseName, SPEC.psnr, o.psnr, r.psnr, tool));
      rows.push(measuredRow('image', caseName, SPEC.bytes, o.bytes, r.bytes, tool));

      const curve = (points: Map<number, Encoded>, quality: (e: Encoded) => number): RdPoint[] =>
        QUALITY_POINTS.map((q) => ({ rate: (points.get(q) as Encoded).bytes, quality: quality(points.get(q) as Encoded) }));
      rows.push(measuredRow('image', caseName, SPEC.bdRatePsnr, bdRate(curve(reference, (e) => e.psnr), curve(ours, (e) => e.psnr)), 0, tool));
      rows.push(measuredRow('image', caseName, SPEC.bdRateSsim, bdRate(curve(reference, (e) => ssimDb(e.ssim)), curve(ours, (e) => ssimDb(e.ssim))), 0, tool));

      if (ssimulacraPlan.ok) {
        const score = (file: string): number => measureSsimulacra2(ssimulacraPlan.paths.ssimulacra2, sourcePng, `${file}.png`);
        const oursFile = ctx.scratch(`ours-ss2.${target}`);
        const refFile = ctx.scratch(`ref-ss2.${target}`);
        measure(await oursEncode(HEADLINE_QUALITY), oursFile);
        referenceEncode(target, plan.paths[refTool], sourcePng, HEADLINE_QUALITY, refFile);
        measure(null, refFile);
        rows.push(measuredRow('image', caseName, SPEC.ssimulacra2, score(oursFile), score(refFile), tool));
      }

      const timingOut = path.join(ctx.work, `timing-${path.basename(sourcePng)}.${target}`);
      const timing = await interleavedTiming(
        async () => {
          await oursEncode(HEADLINE_QUALITY);
        },
        () => referenceEncode(target, plan.paths[refTool], sourcePng, HEADLINE_QUALITY, timingOut),
        ctx.runs,
        ctx.warmup
      );
      rows.push(throughputRow('image', caseName, input.length, timing, tool));
    }
  }
  return rows;
};
