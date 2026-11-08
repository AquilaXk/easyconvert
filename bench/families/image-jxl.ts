import fs from 'node:fs';
import { convertWithProject } from '../convert';
import type { FamilyContext } from '../context';
import { remoteSamples } from '../corpora';
import { decodeImageToPng, fileSize, pictureQuality } from '../measure';
import type { BenchRow } from '../report';
import { measuredRow, skippedGroup, SPEC, type MetricSpec } from '../rows';
import { runTool } from '../tools';

/**
 * The PNG target of the JPEG XL samples of the image family (the lossy targets are cases of bench/families/image.ts). Both sides start from
 * the picture libjxl's `djxl` decodes: the reference writes it with ImageMagick at its defaults, as the reference service's converter does
 * for a picture it can read, and ours is the product's conversion of the file. PNG is lossless on both sides, so the SSIM against the
 * decoded picture says whether the pixels survive (1 for both), and the size of the file is what the encoders differ in.
 */

const REFERENCE = 'ImageMagick';
const PNG_SPECS: readonly MetricSpec[] = [SPEC.ssim, SPEC.bytes];

export async function runImageJxlPng(ctx: FamilyContext): Promise<BenchRow[]> {
  const rows: BenchRow[] = [];
  for (const sample of remoteSamples('image').filter((candidate) => candidate.id.endsWith('.jxl'))) {
    const caseName = `${sample.id}->png`;
    if (!ctx.inScope('image', caseName)) continue;
    const plan = ctx.plan(['ffmpeg', 'djxl', 'magick'], caseName);
    if (!plan.ok) {
      rows.push(...skippedGroup('image', caseName, PNG_SPECS, REFERENCE, plan));
      continue;
    }
    const sourcePath = await ctx.remote(sample);
    if (sourcePath === null) continue;
    ctx.log(`image ${caseName}`);
    const decoders = { ffmpeg: plan.paths.ffmpeg, dwebp: null, avifdec: null, djxl: plan.paths.djxl };
    const decoded = ctx.scratch(`${sample.id}.decoded.png`);
    decodeImageToPng('jxl', sourcePath, decoded, decoders);

    const oursFile = ctx.scratch(`${sample.id}.ours.png`);
    fs.writeFileSync(oursFile, (await convertWithProject(fs.readFileSync(sourcePath), 'jxl', 'png', {}, sample.id)).buffer);
    const referenceFile = ctx.scratch(`${sample.id}.reference.png`);
    runTool(plan.paths.magick, [decoded, referenceFile]);

    const measure = (file: string): { ssim: number; bytes: number } => {
      const picture = `${file}.read.png`;
      decodeImageToPng('png', file, picture, decoders);
      return { ssim: pictureQuality(plan.paths.ffmpeg, picture, decoded).ssim, bytes: fileSize(file) };
    };
    const ours = measure(oursFile);
    const reference = measure(referenceFile);
    rows.push(measuredRow('image', caseName, SPEC.ssim, ours.ssim, reference.ssim, REFERENCE));
    rows.push(measuredRow('image', caseName, SPEC.bytes, ours.bytes, reference.bytes, REFERENCE));
  }
  return rows;
}
