import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { OutputIntegrityError, ToolRunError } from './errors';
import { measureLoudness, measureSsimPsnr, probeFile } from '../tests/helpers/ffmpeg-measure';
import { runTool } from './tools';
import { TOOL_MAX_BUFFER_BYTES, TOOL_TIMEOUT_MS } from './config';

/**
 * Independent measurements, all taken with reference executables: ffmpeg `ssim`, `psnr`, `ebur128`, `asdr` and
 * `libvmaf`, ssimulacra2, and the reference decoders of each image format. SSIM, PSNR and loudness reuse the
 * test-suite helpers, which import nothing from the conversion engines.
 */

export { measureLoudness, measureSsimPsnr, probeFile };

/** Largest sample offset the audio aligner searches between a decoded output and its source. */
const MAX_ALIGN_LAG_SAMPLES = 4_096;
/** Samples per channel the aligner correlates; enough to pin the lag without a long search. */
const ALIGN_WINDOW_SAMPLES = 16_384;
const PCM16_BYTES = 2;

export type ImageKind = 'webp' | 'avif' | 'jpg' | 'png';

export interface ImageDecoders {
  ffmpeg: string;
  dwebp: string | null;
  avifdec: string | null;
}

/** Decodes an image file to PNG with the reference decoder of its format. */
export function decodeImageToPng(kind: ImageKind, input: string, output: string, tools: ImageDecoders): void {
  if (kind === 'webp') {
    if (!tools.dwebp) throw new ToolRunError('dwebp is required to decode WebP');
    runTool(tools.dwebp, ['-nodither', '-quiet', input, '-o', output]);
  } else if (kind === 'avif') {
    if (!tools.avifdec) throw new ToolRunError('avifdec is required to decode AVIF');
    // The picture is compared by its pixels. avifdec would also copy an embedded ICC profile into the PNG, and libpng refuses a grey profile on the RGB picture avifdec writes.
    runTool(tools.avifdec, ['--ignore-icc', input, output]);
    dropExifChunk(output);
  } else {
    runTool(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', input, '-frames:v', '1', output]);
  }
  if (!fs.existsSync(output)) throw new OutputIntegrityError(`${kind} decoder wrote no picture for ${path.basename(input)}`);
}

const PNG_SIGNATURE_BYTES = 8;
const PNG_CHUNK_OVERHEAD_BYTES = 12;

/**
 * Removes the `eXIf` chunk from a PNG. avifdec copies the Exif item of an AVIF into the PNG it writes, and ffmpeg's PNG
 * reader then rejects the whole picture when that item does not start with a TIFF header the way it expects. The benchmark
 * measures pixels, so metadata is not part of what the picture is compared on; the chunk is dropped before the comparison.
 */
export function dropExifChunk(file: string): void {
  const data = fs.readFileSync(file);
  const kept: Buffer[] = [data.subarray(0, PNG_SIGNATURE_BYTES)];
  let at = PNG_SIGNATURE_BYTES;
  let dropped = false;
  while (at + PNG_CHUNK_OVERHEAD_BYTES <= data.length) {
    const length = data.readUInt32BE(at);
    const end = at + PNG_CHUNK_OVERHEAD_BYTES + length;
    if (end > data.length) throw new OutputIntegrityError(`${path.basename(file)} has a truncated PNG chunk`);
    if (data.toString('latin1', at + 4, at + 8) === 'eXIf') dropped = true;
    else kept.push(data.subarray(at, end));
    at = end;
  }
  if (dropped) fs.writeFileSync(file, Buffer.concat(kept));
}

/** Mean video quality scores of `distorted` against `reference`: SSIM (All) and PSNR (average). */
export function pictureQuality(ffmpeg: string, distorted: string, reference: string): { ssim: number; psnr: number } {
  return measureSsimPsnr(ffmpeg, distorted, reference);
}

/** VMAF pooled mean of a distorted video against its reference, via ffmpeg's libvmaf filter. */
export function measureVmaf(ffmpeg: string, distorted: string, reference: string): number {
  const run = spawnSync(
    ffmpeg,
    ['-hide_banner', '-nostdin', '-i', distorted, '-i', reference, '-lavfi', '[0:v]format=yuv420p[d];[1:v]format=yuv420p[r];[d][r]libvmaf', '-f', 'null', '-'],
    { encoding: 'utf8', timeout: TOOL_TIMEOUT_MS, maxBuffer: TOOL_MAX_BUFFER_BYTES }
  );
  const match = /VMAF score:\s*([0-9.]+)/.exec(run.stderr ?? '');
  if (run.status !== 0 || !match) throw new ToolRunError(`libvmaf printed no score: ${(run.stderr ?? '').slice(-400)}`);
  return Number.parseFloat(match[1]);
}

/** ssimulacra2 score of `distorted` against `reference`, from the standalone executable. */
export function measureSsimulacra2(binary: string, reference: string, distorted: string): number {
  const out = runTool(binary, [reference, distorted]).stdout.toString('utf8');
  const match = /(-?[0-9]+(?:\.[0-9]+)?)/.exec(out);
  if (!match) throw new ToolRunError(`ssimulacra2 printed no score: ${out.slice(0, 200)}`);
  return Number.parseFloat(match[1]);
}

/** Decodes audio to interleaved signed 16-bit PCM at the given rate and channel count. */
export function decodePcm(ffmpeg: string, file: string, sampleRate: number, channels: number): Int16Array {
  const out = runTool(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-map', '0:a:0', '-f', 's16le', '-ac', String(channels), '-ar', String(sampleRate), '-']).stdout;
  return new Int16Array(out.buffer, out.byteOffset, Math.floor(out.length / PCM16_BYTES));
}

/**
 * Sample offset at which `distorted` best lines up with `source` (positive: the decoded output starts late). Lossy
 * encoders add priming samples that some containers do not signal, and SNR is meaningless unless the two are
 * aligned; this only finds the offset, the SNR itself is measured by ffmpeg.
 */
export function estimateLagSamples(source: Int16Array, distorted: Int16Array, channels: number): number {
  const searchStart = MAX_ALIGN_LAG_SAMPLES * channels;
  const sourceFrames = Math.floor(source.length / channels);
  const distortedFrames = Math.floor(distorted.length / channels);
  const windowFrames = Math.min(ALIGN_WINDOW_SAMPLES, sourceFrames - MAX_ALIGN_LAG_SAMPLES, distortedFrames - 2 * MAX_ALIGN_LAG_SAMPLES);
  if (windowFrames <= 0) return 0;
  let bestLag = 0;
  let bestScore = -Infinity;
  for (let lag = -MAX_ALIGN_LAG_SAMPLES; lag <= MAX_ALIGN_LAG_SAMPLES; lag++) {
    let score = 0;
    for (let frame = 0; frame < windowFrames; frame++) {
      const at = searchStart + frame * channels;
      score += source[at] * distorted[at + lag * channels];
    }
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  return bestLag;
}

/**
 * Signal-to-noise ratio of a decoded output against its source in dB, taken with ffmpeg's `asdr` (signal to
 * distortion ratio, 10 log10 of source energy over error energy) after the two are aligned and brought to the
 * source's rate and channel layout. The `apsnr` filter reports figures near 166 dB for a 64 kbit/s lossy encode
 * in this ffmpeg build, which no waveform comparison supports, so it is not used for the score.
 */
export function measureAudioSnr(ffmpeg: string, distorted: string, source: string, sampleRate: number, channels: number): number {
  const lag = estimateLagSamples(decodePcm(ffmpeg, source, sampleRate, channels), decodePcm(ffmpeg, distorted, sampleRate, channels), channels);
  const common = `aresample=${sampleRate},aformat=sample_fmts=s16:channel_layouts=${channels === 1 ? 'mono' : 'stereo'}`;
  const align = lag >= 0 ? `atrim=start_sample=${lag},asetpts=PTS-STARTPTS` : `adelay=${-lag}S:all=1`;
  const run = spawnSync(
    ffmpeg,
    ['-hide_banner', '-nostdin', '-i', distorted, '-i', source, '-filter_complex', `[0:a]${common},${align}[d];[1:a]${common}[s];[d][s]asdr`, '-f', 'null', '-'],
    { encoding: 'utf8', timeout: TOOL_TIMEOUT_MS, maxBuffer: TOOL_MAX_BUFFER_BYTES }
  );
  const text = run.stderr ?? '';
  if (run.status !== 0) throw new ToolRunError(`asdr run exited with ${run.status}: ${text.slice(-400)}`);
  const values = [...text.matchAll(/SDR ch\d+:\s*(inf|-?[0-9.]+) dB/g)].map((m) => (m[1] === 'inf' ? Infinity : Number.parseFloat(m[1])));
  if (values.length === 0) throw new ToolRunError(`asdr printed no per-channel score: ${text.slice(-400)}`);
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** MD5 of the decoded PCM of an audio file, from ffmpeg's md5 muxer: equal hashes mean bit-exact audio. */
export function decodedPcmHash(ffmpeg: string, file: string, pcmCodec: 'pcm_s16le' | 'pcm_s24le' = 'pcm_s16le'): string {
  const out = runTool(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-map', '0:a:0', '-c:a', pcmCodec, '-f', 'md5', '-']).stdout.toString('utf8');
  const match = /MD5=([0-9a-f]{32})/.exec(out);
  if (!match) throw new ToolRunError(`ffmpeg printed no PCM hash for ${path.basename(file)}`);
  return match[1];
}

export function fileSize(file: string): number {
  return fs.statSync(file).size;
}

const FLATTEN_BACKGROUND = '0x808080';

/**
 * Writes `input` composited over a mid-grey background as an opaque 8-bit PNG. SSIM and PSNR compare opaque pixels, so a
 * picture with transparency is compared on what a viewer sees over a fixed background: both sides are judged on the same
 * flattened pictures, and transparency that an encoder drops or keeps wrongly shows as a difference.
 */
export function flattenOnGrey(ffmpeg: string, ffprobe: string, input: string, output: string): void {
  const stream = probeFile(ffprobe, input).streams[0];
  const size = `${stream.width}x${stream.height}`;
  runTool(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${FLATTEN_BACKGROUND}:s=${size}`, '-i', input, '-filter_complex', '[0:v][1:v]overlay=format=auto,format=rgb24', '-frames:v', '1', output]);
  if (!fs.existsSync(output)) throw new OutputIntegrityError(`ffmpeg wrote no flattened picture for ${path.basename(input)}`);
}
