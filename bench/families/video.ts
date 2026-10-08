import fs from 'node:fs';
import { bdRate, type RdPoint } from '../bd-rate';
import { BITS_PER_BYTE, BITS_PER_KILOBIT } from '../config';
import { convertWithProject } from '../convert';
import type { FamilyRunner } from '../context';
import { fileSize, measureVmaf, pictureQuality, probeFile } from '../measure';
import type { BenchRow } from '../report';
import { capPsnr, measuredRow, type MetricSpec, skippedGroup, skippedRow, SPEC, ssimDb, throughputRow } from '../rows';
import { interleavedTiming } from '../stats';
import { LIBVMAF_PSEUDO_TOOL, runTool } from '../tools';

/**
 * Video family: the mp4 clip to H.264, H.265 and VP9 at four constant-quality settings each, against ffmpeg's
 * libx264, libx265 and libvpx-vp9 at the same CRF and the project's documented encoder speed.
 */

interface Codec {
  name: 'h264' | 'hevc' | 'vp9';
  target: 'mp4' | 'webm';
  /** Reference encoder name for reports. */
  tool: string;
  /** Four CRF values, low to high; the second one is the headline point. */
  crfs: readonly [number, number, number, number];
  encoderArgs: readonly string[];
}

/** The libvpx-vp9 speed settings the project documents for its VP9 path; the reference uses the same ones. */
const VP9_SPEED_ARGS = ['-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-tile-columns', '2'];
/** x264 and x265 preset when the request names none. */
const X26X_PRESET = 'medium';

const CODECS: readonly Codec[] = [
  { name: 'h264', target: 'mp4', tool: 'ffmpeg libx264', crfs: [20, 24, 28, 32], encoderArgs: ['-c:v', 'libx264', '-preset', X26X_PRESET] },
  { name: 'hevc', target: 'mp4', tool: 'ffmpeg libx265', crfs: [20, 24, 28, 32], encoderArgs: ['-c:v', 'libx265', '-preset', X26X_PRESET, '-x265-params', 'log-level=error'] },
  { name: 'vp9', target: 'webm', tool: 'ffmpeg libvpx-vp9', crfs: [28, 34, 40, 46], encoderArgs: ['-c:v', 'libvpx-vp9', ...VP9_SPEED_ARGS, '-b:v', '0'] },
];

const HEADLINE_INDEX = 1;
const GROUP_SPECS: readonly MetricSpec[] = [SPEC.ssim, SPEC.psnr, SPEC.bitrate, SPEC.bdRatePsnr, SPEC.bdRateSsim, SPEC.throughput];

interface Encoded {
  kbps: number;
  ssim: number;
  psnr: number;
  file: string;
}

export const runVideo: FamilyRunner = async (ctx) => {
  const rows: BenchRow[] = [];
  const clipFile = ctx.corpusPath('clip.mp4');
  const clip = ctx.corpusBuffer('clip.mp4');
  const vmafPlan = ctx.plan([LIBVMAF_PSEUDO_TOOL], 'video VMAF', { optional: true });

  for (const codec of CODECS) {
    const caseName = `clip.mp4->${codec.name}`;
    const plan = ctx.plan(['ffmpeg', 'ffprobe'], caseName);
    if (!plan.ok) {
      rows.push(...skippedGroup('video', caseName, GROUP_SPECS, codec.tool, plan));
      continue;
    }
    ctx.log(`video ${caseName}`);
    const ffmpeg = plan.paths.ffmpeg;
    const referenceEncode = (crf: number, output: string): void => {
      runTool(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', clipFile, ...codec.encoderArgs, '-crf', String(crf), '-pix_fmt', 'yuv420p', '-an', output]);
    };
    const oursEncode = async (crf: number): Promise<Buffer> => {
      const preset = ctx.injection === 'x264-ultrafast' && codec.name === 'h264' ? 'ultrafast' : undefined;
      const out = await convertWithProject(clip, 'mp4', codec.target, { video: { codec: codec.name, rateControl: { mode: 'crf', crf }, ...(preset ? { preset } : {}) } }, 'clip.mp4');
      return out.buffer;
    };
    const measure = (file: string): Encoded => {
      const seconds = Number(probeFile(plan.paths.ffprobe, file).format.duration);
      const quality = pictureQuality(ffmpeg, file, clipFile);
      return { kbps: (fileSize(file) * BITS_PER_BYTE) / seconds / BITS_PER_KILOBIT, ssim: quality.ssim, psnr: capPsnr(quality.psnr), file };
    };

    const ours: Encoded[] = [];
    const reference: Encoded[] = [];
    for (const crf of codec.crfs) {
      const oursFile = ctx.scratch(`ours-crf${crf}.${codec.target}`);
      fs.writeFileSync(oursFile, await oursEncode(crf));
      ours.push(measure(oursFile));
      const refFile = ctx.scratch(`ref-crf${crf}.${codec.target}`);
      referenceEncode(crf, refFile);
      reference.push(measure(refFile));
    }

    const o = ours[HEADLINE_INDEX];
    const r = reference[HEADLINE_INDEX];
    rows.push(measuredRow('video', caseName, SPEC.ssim, o.ssim, r.ssim, codec.tool));
    rows.push(measuredRow('video', caseName, SPEC.psnr, o.psnr, r.psnr, codec.tool));
    rows.push(measuredRow('video', caseName, SPEC.bitrate, o.kbps, r.kbps, codec.tool));
    const curve = (points: Encoded[], quality: (e: Encoded) => number): RdPoint[] => points.map((e) => ({ rate: e.kbps, quality: quality(e) }));
    rows.push(measuredRow('video', caseName, SPEC.bdRatePsnr, bdRate(curve(reference, (e) => e.psnr), curve(ours, (e) => e.psnr)), 0, codec.tool));
    rows.push(measuredRow('video', caseName, SPEC.bdRateSsim, bdRate(curve(reference, (e) => ssimDb(e.ssim)), curve(ours, (e) => ssimDb(e.ssim))), 0, codec.tool));

    if (vmafPlan.ok) {
      rows.push(measuredRow('video', caseName, SPEC.vmaf, measureVmaf(vmafPlan.paths[LIBVMAF_PSEUDO_TOOL], o.file, clipFile), measureVmaf(vmafPlan.paths[LIBVMAF_PSEUDO_TOOL], r.file, clipFile), codec.tool));
    } else {
      rows.push(skippedRow('video', caseName, SPEC.vmaf, codec.tool, 'optional-tool', vmafPlan.reason));
    }

    const timingOut = ctx.scratch(`timing.${codec.target}`);
    const headlineCrf = codec.crfs[HEADLINE_INDEX];
    const timing = await interleavedTiming(
      async () => {
        await oursEncode(headlineCrf);
      },
      () => referenceEncode(headlineCrf, timingOut),
      ctx.heavyRuns,
      ctx.warmup
    );
    rows.push(throughputRow('video', caseName, clip.length, timing, codec.tool));
  }
  return rows;
};
