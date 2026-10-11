import fs from 'node:fs';
import { type RdPoint, tryBdRate } from '../bd-rate';
import { ClassRows } from '../class-rows';
import { BITS_PER_BYTE, BITS_PER_KILOBIT, PUBLIC_SPEED_SAMPLES } from '../config';
import { convertWithProject } from '../convert';
import type { FamilyContext, FamilyRunner } from '../context';
import { type RemoteSample, remoteSamples } from '../corpora';
import { OutputIntegrityError } from '../errors';
import { fileSize, measureVmaf, pictureQuality, probeFile } from '../measure';
import { numberRecord } from '../ref-cache';
import type { BenchRow } from '../report';
import { capPsnr, measuredRow, type MetricSpec, skippedGroup, skippedRow, SPEC, ssimDb, throughputRow, speedRowId, undeterminedBdRows } from '../rows';
import { LIBVMAF_PSEUDO_TOOL, runTool } from '../tools';

/**
 * Video family: the mp4 clip to H.264, H.265 and VP9 at four constant-quality settings each, against ffmpeg's
 * libx264, libx265 and libvpx-vp9 at the same CRF and the project's documented encoder speed. The public sample sets
 * (bench/corpus/remote-manifest.json) add the first frames of the sequences of the AV1 common test conditions: natural
 * scenes at several resolutions, fast motion, screen content, animation and film grain. A sequence is uncompressed 4:2:0
 * video; it is stored once as a lossless H.264 file (the product reads mp4), which decodes to the very frames of the
 * sequence, and both sides encode that file. Every sample has its own rows, and each class has rows that average the
 * BD-rates of its samples (bench/class-rows.ts).
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

/** What is cached of a reference encode: the numbers, not the file. */
const parseReference = numberRecord(['kbps', 'ssim', 'psnr']);
const parseReferenceWithVmaf = numberRecord(['kbps', 'ssim', 'psnr', 'vmaf']);

interface VideoSample {
  file: string;
  contentClass: string | null;
  remote: RemoteSample | null;
}

const CORE_SAMPLES: readonly VideoSample[] = [{ file: 'clip.mp4', contentClass: null, remote: null }];

/** Our side failed to convert a public sample; the sample's rows say so instead of ending the run. */
class OursConversionError extends Error {}

/**
 * The mp4 both sides encode: the generated clip itself, or for a public sequence a lossless H.264 file made from it. Lossless
 * coding of 8-bit 4:2:0 frames decodes to the same frames, so the quality of an encode is judged against the sequence.
 */
async function sourceClip(ctx: FamilyContext, sample: VideoSample, ffmpeg: string, ffprobe: string, made: Map<string, string>): Promise<string | null> {
  if (sample.remote === null) return ctx.corpusPath(sample.file);
  const known = made.get(sample.file);
  if (known !== undefined) return known;
  const raw = await ctx.remote(sample.remote);
  if (raw === null) return null;
  const clip = ctx.scratch(`${sample.file}.mp4`);
  runTool(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', raw, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '0', '-pix_fmt', 'yuv420p', '-an', clip]);
  const probed = probeFile(ffprobe, clip).streams[0];
  const frames = Number(sample.remote.meta.frames);
  const decodedFrames = Number(runTool(ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', clip]).stdout.toString('utf8').trim());
  if (probed.width !== sample.remote.meta.width || probed.height !== sample.remote.meta.height || decodedFrames !== frames) {
    throw new OutputIntegrityError(`${sample.file}: the lossless copy is ${probed.width}x${probed.height} with ${decodedFrames} frames, the manifest says ${String(sample.remote.meta.width)}x${String(sample.remote.meta.height)} with ${frames}`);
  }
  made.set(sample.file, clip);
  return clip;
}

export const runVideo: FamilyRunner = async (ctx) => {
  const rows: BenchRow[] = [];
  const classes = new ClassRows();
  const samples: VideoSample[] = [...CORE_SAMPLES, ...remoteSamples('video').map((sample) => ({ file: sample.id, contentClass: sample.class, remote: sample }))];
  for (const sample of samples) {
    if (sample.contentClass !== null) for (const codec of CODECS) classes.expect(sample.contentClass, `->${codec.name}`, [SPEC.bdRatePsnr.metric, SPEC.bdRateSsim.metric]);
  }
  const vmafPlan = ctx.plan([LIBVMAF_PSEUDO_TOOL], 'video VMAF', { optional: true });
  const madeClips = new Map<string, string>();

  for (const sample of samples) {
    // A speed-only run times a few public samples; the others have only quality rows, which it does not measure.
    if (!ctx.quality && sample.remote !== null && !PUBLIC_SPEED_SAMPLES.video.includes(sample.file)) continue;
    for (const codec of CODECS) {
      const caseName = `${sample.file}->${codec.name}`;
      if (!ctx.inScope('video', caseName)) continue;
      const plan = ctx.plan(['ffmpeg', 'ffprobe'], caseName);
      if (!plan.ok) {
        rows.push(...skippedGroup('video', caseName, GROUP_SPECS, codec.tool, plan));
        continue;
      }
      const clipFile = await sourceClip(ctx, sample, plan.paths.ffmpeg, plan.paths.ffprobe, madeClips);
      if (clipFile === null) {
        rows.push(...GROUP_SPECS.map((spec) => skippedRow('video', caseName, spec, codec.tool, 'optional-tool', `public sample ${sample.file} could not be fetched`)));
        continue;
      }
      const clip = fs.readFileSync(clipFile);
      ctx.log(`video ${caseName}`);
      const ffmpeg = plan.paths.ffmpeg;
      const referenceEncode = (crf: number, output: string): void => {
        runTool(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', clipFile, ...codec.encoderArgs, '-crf', String(crf), '-pix_fmt', 'yuv420p', '-an', output]);
      };
      const oursEncode = async (crf: number): Promise<Buffer> => {
        const preset = ctx.injection === 'x264-ultrafast' && codec.name === 'h264' ? 'ultrafast' : undefined;
        try {
          const out = await convertWithProject(clip, 'mp4', codec.target, { video: { codec: codec.name, rateControl: { mode: 'crf', crf }, ...(preset ? { preset } : {}) } }, 'clip.mp4');
          return out.buffer;
        } catch (error) {
          if (sample.remote === null) throw error;
          throw new OursConversionError(error instanceof Error ? error.message : String(error));
        }
      };
      const headlineCrf = codec.crfs[HEADLINE_INDEX];

      if (ctx.quality) {
        try {
          const measure = (file: string): Encoded => {
            const seconds = Number(probeFile(plan.paths.ffprobe, file).format.duration);
            const quality = pictureQuality(ffmpeg, file, clipFile);
            return { kbps: (fileSize(file) * BITS_PER_BYTE) / seconds / BITS_PER_KILOBIT, ssim: quality.ssim, psnr: capPsnr(quality.psnr), file };
          };
          const vmafBinary = vmafPlan.ok ? vmafPlan.paths[LIBVMAF_PSEUDO_TOOL] : null;

          const ours: Encoded[] = [];
          const reference: Omit<Encoded, 'file'>[] = [];
          let referenceVmaf: number | null = null;
          for (const crf of codec.crfs) {
            const oursFile = ctx.scratch(`ours-crf${crf}.${codec.target}`);
            fs.writeFileSync(oursFile, await oursEncode(crf));
            ours.push(measure(oursFile));
            // The reference encode and its scores are functions of ffmpeg's encoder, the clip and the rate alone. The
            // headline point also carries the reference's VMAF when the metric is available.
            const withVmaf = crf === headlineCrf && vmafBinary !== null;
            const point = await ctx.refCache.value(
              'video',
              {
                kind: withVmaf ? 'encode-measure-vmaf' : 'encode-measure',
                tools: ['ffmpeg', 'ffprobe'],
                files: [sample.file],
                settings: { case: caseName, crf, encoder: codec.encoderArgs.join(' '), vmaf: withVmaf },
              },
              withVmaf ? parseReferenceWithVmaf : parseReference,
              () => {
                const refFile = ctx.scratch(`ref-crf${crf}.${codec.target}`);
                referenceEncode(crf, refFile);
                const { file, ...measured } = measure(refFile);
                return withVmaf && vmafBinary !== null ? { ...measured, vmaf: measureVmaf(vmafBinary, file, clipFile) } : measured;
              }
            );
            reference.push(point);
            if (withVmaf) referenceVmaf = (point as { vmaf: number }).vmaf;
          }

          const o = ours[HEADLINE_INDEX];
          const r = reference[HEADLINE_INDEX];
          rows.push(measuredRow('video', caseName, SPEC.ssim, o.ssim, r.ssim, codec.tool));
          rows.push(measuredRow('video', caseName, SPEC.psnr, o.psnr, r.psnr, codec.tool));
          rows.push(measuredRow('video', caseName, SPEC.bitrate, o.kbps, r.kbps, codec.tool));
          const curve = (points: { kbps: number; ssim: number; psnr: number }[], quality: (e: { ssim: number; psnr: number }) => number): RdPoint[] =>
            points.map((e) => ({ rate: e.kbps, quality: quality(e) }));
          const bdPsnr = tryBdRate(curve(reference, (e) => e.psnr), curve(ours, (e) => e.psnr));
          const bdSsim = tryBdRate(curve(reference, (e) => ssimDb(e.ssim)), curve(ours, (e) => ssimDb(e.ssim)));
          for (const [spec, bd] of [[SPEC.bdRatePsnr, bdPsnr], [SPEC.bdRateSsim, bdSsim]] as const) {
            if ('value' in bd) {
              rows.push(measuredRow('video', caseName, spec, bd.value, 0, codec.tool));
              if (sample.contentClass !== null) classes.add(sample.contentClass, `->${codec.name}`, spec, bd.value, 0);
            } else {
              rows.push(...undeterminedBdRows('video', caseName, [spec], codec.tool, bd.reason));
              if (sample.contentClass !== null) classes.exclude(sample.contentClass, `->${codec.name}`, spec.metric);
            }
          }

          if (vmafBinary !== null && referenceVmaf !== null) {
            rows.push(measuredRow('video', caseName, SPEC.vmaf, measureVmaf(vmafBinary, o.file, clipFile), referenceVmaf, codec.tool));
          } else if (!vmafPlan.ok) {
            rows.push(skippedRow('video', caseName, SPEC.vmaf, codec.tool, 'optional-tool', vmafPlan.reason));
          }
        } catch (error) {
          if (!(error instanceof OursConversionError)) throw error;
          ctx.log(`video ${caseName}: the product could not convert the sample: ${error.message.slice(0, 300)}`);
          rows.push(measuredRow('video', caseName, SPEC.converts, 0, 1, codec.tool));
          continue;
        }
      }

      if (ctx.speed && (sample.remote === null || PUBLIC_SPEED_SAMPLES.video.includes(sample.file))) {
        const timingOut = ctx.scratch(`timing.${codec.target}`);
        const timing = await ctx.time(
          speedRowId('video', caseName),
          async () => {
            await oursEncode(headlineCrf);
          },
          () => referenceEncode(headlineCrf, timingOut),
          'heavy'
        );
        rows.push(throughputRow('video', caseName, clip.length, timing, codec.tool));
      }
    }
  }
  rows.push(...classes.rows('video', (suffix) => CODECS.find((codec) => suffix === `->${codec.name}`)?.tool ?? 'ffmpeg').filter((row) => ctx.inScope('video', row.case)));
  return rows;
};
