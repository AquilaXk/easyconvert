import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * File-level measurements taken with the reference ffmpeg and ffprobe: a strict full decode (every
 * stream, `-xerror`), SSIM and PSNR against a reference, EBU R128 loudness and ffprobe JSON. The
 * tool paths are parameters, so this module imports nothing from the oracle that resolves them and
 * nothing from the conversion engines under test.
 */

/** A decode that has not finished in this time is a hang, not a slow conversion of a short clip. */
export const ORACLE_DECODE_TIMEOUT_MS = 120_000;
/** Raw decode output above this is an oracle misuse (a long clip), not a conversion result. */
export const ORACLE_DECODE_MAX_BYTES = 256 * 1024 * 1024;
const PROBE_MAX_BYTES = 64 * 1024 * 1024;
const PCM16_BYTES = 2;
const RGB24_BYTES_PER_PIXEL = 3;

/**
 * Appends one measured quality number to the JSON-lines file named by MEDIA_METRICS_FILE, when set, so a run
 * can report what it measured next to what it asserted. Without the variable it does nothing.
 */
export function recordMetric(name: string, value: number | string): void {
  const file = process.env.MEDIA_METRICS_FILE;
  if (file) fs.appendFileSync(file, `${JSON.stringify({ name, value })}\n`);
}

export class MediaDecodeError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr = '') {
    super(stderr ? `${message}: ${stderr.slice(-600)}` : message);
    this.name = 'MediaDecodeError';
    this.stderr = stderr;
  }
}

export interface ProbedStream {
  index: number;
  codec_type: string;
  codec_name?: string;
  codec_tag_string?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  sample_rate?: string;
  channels?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  bit_rate?: string;
  start_time?: string;
  duration?: string;
  nb_frames?: string;
  tags?: Record<string, string>;
  disposition?: Record<string, number>;
  side_data_list?: Array<Record<string, unknown>>;
}

export interface ProbedChapter {
  id: number;
  start_time: string;
  end_time: string;
  tags?: Record<string, string>;
}

export interface ProbedFile {
  streams: ProbedStream[];
  chapters: ProbedChapter[];
  format: { format_name: string; duration?: string; bit_rate?: string; size?: string; tags?: Record<string, string> };
}

/** `ffprobe -show_streams -show_format -show_chapters` as JSON. */
export function probeFile(ffprobe: string, file: string): ProbedFile {
  const out = execFileSync(
    ffprobe,
    ['-v', 'error', '-of', 'json', '-show_streams', '-show_format', '-show_chapters', file],
    { encoding: 'utf8', maxBuffer: PROBE_MAX_BYTES, timeout: ORACLE_DECODE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const parsed = JSON.parse(out) as Partial<ProbedFile>;
  return {
    streams: parsed.streams ?? [],
    chapters: parsed.chapters ?? [],
    format: parsed.format ?? { format_name: '' },
  };
}

export interface StreamCounts {
  video: number;
  audio: number;
  subtitle: number;
  data: number;
}

export function countStreams(probed: ProbedFile): StreamCounts {
  const counts: StreamCounts = { video: 0, audio: 0, subtitle: 0, data: 0 };
  for (const stream of probed.streams) {
    if (stream.codec_type === 'video') counts.video++;
    else if (stream.codec_type === 'audio') counts.audio++;
    else if (stream.codec_type === 'subtitle') counts.subtitle++;
    else counts.data++;
  }
  return counts;
}

function runDecode(ffmpeg: string, args: string[]): { stdout: Buffer; stderr: string } {
  const run = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', ...args], {
    maxBuffer: ORACLE_DECODE_MAX_BYTES,
    timeout: ORACLE_DECODE_TIMEOUT_MS,
  });
  const stderr = run.stderr?.toString('utf8').trim() ?? '';
  if (run.error) throw new MediaDecodeError(`ffmpeg could not run (${run.error.message})`, stderr);
  if (run.status !== 0) throw new MediaDecodeError(`ffmpeg exited with status ${run.status}`, stderr);
  if (stderr !== '') throw new MediaDecodeError('ffmpeg reported decode errors', stderr);
  return { stdout: run.stdout, stderr };
}

export interface AudioDecode {
  /** Interleaved signed 16-bit little-endian samples. */
  pcm: Buffer;
  sampleRate: number;
  channels: number;
  samplesPerChannel: number;
}

/** Fully decodes audio stream `a:<streamIndex>` to s16le at the given layout; any decode error throws. */
export function decodeAudioStream(
  ffmpeg: string,
  file: string,
  sampleRate: number,
  channels: number,
  streamIndex = 0
): AudioDecode {
  const { stdout } = runDecode(ffmpeg, [
    '-i', file, '-map', `0:a:${streamIndex}`, '-f', 's16le', '-ac', String(channels), '-ar', String(sampleRate), '-',
  ]);
  return { pcm: stdout, sampleRate, channels, samplesPerChannel: Math.floor(stdout.length / (PCM16_BYTES * channels)) };
}

export interface VideoDecode {
  /** Concatenated rgb24 frames, in presentation order, with no frame dropped or duplicated. */
  frames: Buffer;
  width: number;
  height: number;
  frameCount: number;
}

/** Fully decodes video stream `v:0` to rgb24 without frame-rate conversion; any decode error throws. */
export function decodeVideoFrames(ffmpeg: string, file: string, width: number, height: number): VideoDecode {
  const { stdout } = runDecode(ffmpeg, [
    '-i', file, '-map', '0:v:0', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ]);
  const frameBytes = width * height * RGB24_BYTES_PER_PIXEL;
  if (stdout.length % frameBytes !== 0) {
    throw new MediaDecodeError(`decoded ${stdout.length} bytes are not a whole number of ${width}x${height} frames`);
  }
  return { frames: stdout, width, height, frameCount: stdout.length / frameBytes };
}

/** Decodes every stream of the file to nothing: throws on the first decode error of any stream. */
export function decodeEveryStream(ffmpeg: string, file: string): void {
  runDecode(ffmpeg, ['-i', file, '-map', '0:v?', '-map', '0:a?', '-f', 'null', '-']);
}

export interface SsimPsnr {
  ssim: number;
  psnr: number;
}

/**
 * Whole-clip SSIM (All) and mean PSNR of `actual` against `reference` with ffmpeg's own filters. When
 * `scaleActualToReference` is set the actual stream is first scaled to the reference geometry.
 */
export function measureSsimPsnr(
  ffmpeg: string,
  actualFile: string,
  referenceFile: string,
  referenceSize?: { width: number; height: number }
): SsimPsnr {
  const align = referenceSize ? `scale=${referenceSize.width}:${referenceSize.height}:flags=bicubic,` : '';
  const graph =
    `[0:v]${align}format=yuv420p,split=2[a1][a2];[1:v]format=yuv420p,split=2[r1][r2];` +
    '[a1][r1]ssim[s];[a2][r2]psnr[p]';
  const run = spawnSync(
    ffmpeg,
    [
      '-hide_banner', '-nostdin', '-i', actualFile, '-i', referenceFile, '-filter_complex', graph,
      '-map', '[s]', '-f', 'null', '-', '-map', '[p]', '-f', 'null', '-',
    ],
    { encoding: 'utf8', maxBuffer: ORACLE_DECODE_MAX_BYTES, timeout: ORACLE_DECODE_TIMEOUT_MS }
  );
  const output = `${run.stderr ?? ''}${run.stdout ?? ''}`;
  if (run.status !== 0) throw new MediaDecodeError(`ssim/psnr run exited with ${run.status}`, output);
  const ssim = output.match(/SSIM .*All:([0-9.]+)/);
  const psnr = output.match(/PSNR .*average:(inf|[0-9.]+)/);
  if (!ssim || !psnr) throw new MediaDecodeError('ffmpeg printed no SSIM/PSNR summary', output);
  return { ssim: parseFloat(ssim[1]), psnr: psnr[1] === 'inf' ? Infinity : parseFloat(psnr[1]) };
}

export interface Loudness {
  /** Integrated loudness, LUFS (ITU-R BS.1770-4, gated). */
  integrated: number;
  /** Loudness range, LU. */
  range: number;
  /** True peak, dBTP. */
  truePeak: number;
}

/** EBU R128 loudness of the first audio stream, measured by ffmpeg's ebur128 filter with true-peak. */
export function measureLoudness(ffmpeg: string, file: string): Loudness {
  const run = spawnSync(
    ffmpeg,
    ['-hide_banner', '-nostdin', '-nostats', '-i', file, '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: ORACLE_DECODE_MAX_BYTES, timeout: ORACLE_DECODE_TIMEOUT_MS }
  );
  const output = run.stderr ?? '';
  if (run.status !== 0) throw new MediaDecodeError(`ebur128 run exited with ${run.status}`, output);
  const summary = output.slice(output.lastIndexOf('Summary:'));
  const integrated = summary.match(/I:\s+(-?[0-9.]+|-inf)\s+LUFS/);
  const range = summary.match(/LRA:\s+(-?[0-9.]+)\s+LU/);
  const peak = summary.match(/Peak:\s+(-?[0-9.]+|-inf)\s+dBFS/);
  if (!integrated || !range || !peak) throw new MediaDecodeError('ebur128 printed no summary', output);
  return {
    integrated: parseFloat(integrated[1]),
    range: parseFloat(range[1]),
    truePeak: parseFloat(peak[1]),
  };
}

/** Writes `bytes` to a temporary file with `extension`, runs `run(file)` and removes the directory. */
export function withMediaFile<T>(bytes: Uint8Array, extension: string, run: (file: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-measure-'));
  try {
    const file = path.join(dir, `input.${extension}`);
    fs.writeFileSync(file, bytes);
    return run(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
