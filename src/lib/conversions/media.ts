import { stageTimeoutMs } from './job-time';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import {
  ConversionOptions,
  ConversionResult,
  ConversionFailedError,
  EngineUnavailableError,
  InvalidMediaOptionError,
  MediaPackagingOptions,
} from '../types';
export { ConversionFailedError };
import { executeSandboxedBinary, SandboxedProcessError } from '../security/process-sandbox';
import {
  buildFfmpegArguments,
  buildHlsDashArguments,
  buildTwoPassArguments,
  DEFAULT_PACKAGING_LADDER,
  isTwoPassRequested,
  PackagingSource,
  probePackagingSource,
  usesHardwareVideoEncoder,
} from './media-ffmpeg-args';
import { capLadderToSource, packagingBudgetSeconds } from './media-packaging';
import { describeAudioProcessing, measureLoudnessStage } from './media-audio-run';
import { describeDroppedStreams } from './media-dropped-streams';
import { type FfprobePath, probeInput, resolveFfprobeBinary } from './media-ffprobe';
import { runTwoPass, TWO_PASS_LOG_PREFIX, twoPassBudgetMs } from './media-two-pass';
import { encodeFlacStreamAsync } from './flac-encoder';
import {
  resampleInterleavedInt16,
  resamplePlanarFloat,
  type ResampleOptions,
} from './audio-resampler';
import { readMp4Layout } from './mp4-layout';
import { readWavPcmInfo } from './wav-header';
import {
  decodeAudioBuffer,
  decodeWav,
  decodeFlac,
  decodeMp3,
  DecodedAudio,
} from './media-decoder';

export interface FfmpegEnvironmentInfo {
  available: boolean;
  path: string | null;
  isContainer: boolean;
  version?: string;
}

function findExistingPath(paths: string[]): string | null {
  for (const loc of paths) {
    if (fs.existsSync(loc)) return loc;
  }
  return null;
}

function resolveFfmpegViaWhich(): string | null {
  for (const whichBin of ['/usr/bin/which', '/bin/which']) {
    if (!fs.existsSync(whichBin)) continue;
    try {
      const out = execFileSync(whichBin, ['ffmpeg'], { stdio: 'pipe' }).toString().trim();
      if (out && fs.existsSync(out)) return out;
    } catch {}
  }
  return null;
}

let resolvedFfmpegPath: string | null = null;
export function getFfmpegPath(): string | null {
  if (resolvedFfmpegPath !== null) return resolvedFfmpegPath || null;
  const envPath = process.env.FFMPEG_PATH;
  if (envPath) {
    // An explicit override is authoritative, as in the worker's resolver: a path with no file behind it
    // means the tool is not installed, not that another install should be searched for.
    resolvedFfmpegPath = fs.existsSync(envPath) ? envPath : '';
    return resolvedFfmpegPath || null;
  }
  const fixedLocations = [
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/opt/homebrew/bin/ffmpeg',
    '/bin/ffmpeg',
    '/snap/bin/ffmpeg',
    '/nix/var/nix/profiles/default/bin/ffmpeg',
  ];
  const found = findExistingPath(fixedLocations) || resolveFfmpegViaWhich();
  resolvedFfmpegPath = found || '';
  return found;
}

function resolveFfprobeViaWhich(): string | null {
  for (const whichBin of ['/usr/bin/which', '/bin/which']) {
    if (!fs.existsSync(whichBin)) continue;
    try {
      const out = execFileSync(whichBin, ['ffprobe'], { stdio: 'pipe' }).toString().trim();
      if (out && fs.existsSync(out)) return out;
    } catch {}
  }
  return null;
}

let resolvedFfprobePath: string | null = null;
export function getFfprobePath(): string | null {
  if (resolvedFfprobePath !== null) return resolvedFfprobePath || null;
  const envPath = process.env.FFPROBE_PATH;
  if (envPath && fs.existsSync(envPath)) {
    resolvedFfprobePath = envPath;
    return envPath;
  }
  const fixedLocations = [
    '/usr/bin/ffprobe',
    '/usr/local/bin/ffprobe',
    '/opt/homebrew/bin/ffprobe',
    '/bin/ffprobe',
    '/snap/bin/ffprobe',
    '/nix/var/nix/profiles/default/bin/ffprobe',
  ];
  const found = findExistingPath(fixedLocations) || resolveFfprobeViaWhich();
  resolvedFfprobePath = found || '';
  return found;
}

/**
 * Duration of an audio/video file in seconds, which bounds how long a job may run: from the header of a WAVE file
 * or a plain MP4 when it states one, otherwise from the ffprobe that belongs to `ffmpegBin` (or the one found on
 * the host). That probe is remembered for the file, so the stream planner of the same conversion reads it again at
 * no cost. Returns 0 if ffprobe is unavailable or if parsing fails.
 */
export function probeMediaDuration(filePath: string, options?: ConversionOptions, ffmpegBin?: string | null): number {
  if (typeof options?.duration === 'number' && Number.isFinite(options.duration) && options.duration > 0) {
    return options.duration;
  }
  // The duration of a WAVE file with uncompressed samples is in its header; no prober process is needed.
  const wav = readWavPcmInfo(filePath);
  if (wav !== null) return wav.durationSeconds;
  // So is the length of a plain MP4, in its movie header.
  const header = readMp4Layout(filePath);
  if (header?.durationSec !== undefined) return header.durationSec;
  if (!fs.existsSync(filePath)) return 0;
  try {
    const ffprobe = ffmpegBin ? resolveFfprobeBinary(ffmpegBin) : getFfprobePath();
    if (!ffprobe) return 0;
    return probeInput(filePath, ffprobe as FfprobePath).durationSec ?? 0;
  } catch {
    return 0;
  }
}

/** Longest a media job may run when the caller names no tier ceiling. */
export const DEFAULT_MEDIA_TIER_MAX_MS = 180_000;

/**
 * Computes dynamic transcoding timeout: min(tierMax, 3 * durationSeconds + 60) in milliseconds.
 */
export function computeMediaTimeoutMs(durationSeconds: number, tierMaxMs = DEFAULT_MEDIA_TIER_MAX_MS): number {
  const duration = Math.max(0, durationSeconds || 0);
  const baseTimeoutMs = Math.round((3 * duration + 60) * 1000);
  return Math.max(10000, Math.min(tierMaxMs, baseTimeoutMs));
}

/**
 * Timeout of an adaptive-bitrate package: every rung is a full encode of the clip, so the duration is
 * counted once per rung, under the same tier ceiling as a transcode.
 */
export function computePackagingTimeoutMs(
  durationSeconds: number,
  rungCount: number,
  tierMaxMs = DEFAULT_MEDIA_TIER_MAX_MS
): number {
  return computeMediaTimeoutMs(packagingBudgetSeconds(durationSeconds, rungCount), tierMaxMs);
}

/** Rungs the packager will encode: the requested (or default) ladder cut to what the source can fill. */
export function plannedRungCount(packaging: MediaPackagingOptions, source: PackagingSource): number {
  return capLadderToSource(packaging.ladder ?? DEFAULT_PACKAGING_LADDER, source.geometry).length;
}


export function detectFfmpegEnvironment(): FfmpegEnvironmentInfo {
  const ffmpegPath = getFfmpegPath();
  const isContainer =
    fs.existsSync('/.dockerenv') ||
    fs.existsSync('/run/.containerenv') ||
    Boolean(process.env.KUBERNETES_SERVICE_HOST) ||
    Boolean(process.env.CONTAINER_SANDBOX);

  if (!ffmpegPath) {
    return {
      available: false,
      path: null,
      isContainer,
    };
  }

  let version: string | undefined;
  try {
    const out = execFileSync(ffmpegPath, ['-version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).toString('utf-8');
    const match = out.match(/ffmpeg\s+version\s+([^\s]+)/i);
    if (match) version = match[1];
  } catch {}

  return {
    available: true,
    path: ffmpegPath,
    isContainer,
    version,
  };
}

export function checkFfmpeg(): boolean {
  return getFfmpegPath() !== null;
}

/**
 * Universal Audio & Video Conversion Engine
 * Supports MP3, WAV, AAC, OGG, FLAC, M4A, WMA, OPUS, MP4, WEBM, MKV, AVI, MOV
 */
export async function convertMedia(
  inputBuffer: Buffer,
  sourceFormat: string,
  targetFormat: string,
  options: ConversionOptions = {},
  originalFilename: string
): Promise<ConversionResult> {
  const baseName = originalFilename.replace(/\.[^/.]+$/, '');
  const src = sourceFormat.toLowerCase();
  const tgt = targetFormat.toLowerCase();

  // Thumbnail extraction routing
  const isThumbnail = Boolean(options.thumbnail) || (['jpg', 'jpeg', 'png'].includes(tgt) && Boolean(options.thumbnail));
  if (isThumbnail) {
    if (!checkFfmpeg()) {
      throw new EngineUnavailableError('ffmpeg', 'Native FFmpeg engine is required for thumbnail extraction.');
    }
    return await executeFfmpegThumbnails(inputBuffer, src, tgt, options, baseName);
  }

  // Subtitle extraction routing
  const isSubtitleExtract = options.subtitles?.mode === 'extract' || ['srt', 'vtt', 'ass'].includes(tgt);
  if (isSubtitleExtract && options.subtitles?.mode === 'extract') {
    if (!checkFfmpeg()) {
      throw new EngineUnavailableError('ffmpeg', 'Native FFmpeg engine is required for subtitle extraction.');
    }
    return await executeFfmpegTranscode(inputBuffer, src, tgt, options, baseName);
  }

  // Packaging routing (HLS & MPEG-DASH)
  const isPackaging = Boolean(options.packaging) || tgt === 'hls' || tgt === 'dash';
  if (isPackaging) {
    if (!checkFfmpeg()) {
      throw new EngineUnavailableError('ffmpeg', 'Native FFmpeg engine is required for ABR media packaging.');
    }
    const resolvedPackaging: MediaPackagingOptions = options.packaging || {
      format: (tgt === 'dash' ? 'dash' : 'hls'),
    };
    return await packageHlsDashMedia(inputBuffer, src, { ...options, packaging: resolvedPackaging }, baseName);
  }

  // If FFmpeg is explicitly requested, fail-closed if not available or if execution fails
  if (options.useFfmpeg) {
    if (!checkFfmpeg()) {
      throw new EngineUnavailableError(
        'ffmpeg',
        'Native FFmpeg engine requested via options.useFfmpeg but FFmpeg is not available in execution environment.'
      );
    }
    return await executeFfmpegTranscode(inputBuffer, src, tgt, options, baseName);
  }

  // When system FFmpeg is available and not explicitly disabled, execute native transcoding.
  if (!options.disableNativeEngine && checkFfmpeg()) {
    try {
      return await executeFfmpegTranscode(inputBuffer, src, tgt, options, baseName);
    } catch (err) {
      // Invalid options are the caller's error (HTTP 400); keep their type.
      if (err instanceof InvalidMediaOptionError || err instanceof EngineUnavailableError || isTypedConversionError(err)) {
        throw err;
      }
      throw new ConversionFailedError(
        `Native FFmpeg transcoding failed for ${src} -> ${tgt}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Without native FFmpeg only WAV and FLAC can be produced faithfully. Every other audio or
  // video target fails closed with EngineUnavailableError (HTTP 503) before any decoding; there is
  // no in-process fallback encoder and no opt-in that emits a synthesized stream.
  if (!PURE_LOSSLESS_TARGETS.has(tgt)) {
    const cause = options.disableNativeEngine
      ? 'the native engine is disabled'
      : 'FFmpeg is not installed or not in PATH';
    const product = PURE_UNAVAILABLE_ENCODE_TARGETS.has(tgt)
      ? `authentic lossy ${tgt.toUpperCase()} compression`
      : `${tgt.toUpperCase()} output`;
    throw new EngineUnavailableError(
      'ffmpeg',
      `Native FFmpeg engine is required for ${product} (${cause}); there is no in-process fallback encoder (Fail-Closed).`
    );
  }

  // Pure TypeScript zero-dependency pipeline for the lossless targets (WAV, FLAC)
  return await processMediaPure(inputBuffer, src, tgt, options, baseName);
}

/** A ConversionFailedError subclass (no video stream, too many streams, ...): a verdict on the input that keeps its type. */
function isTypedConversionError(err: unknown): err is ConversionFailedError {
  return err instanceof ConversionFailedError && err.constructor !== ConversionFailedError;
}

export const LOSSY_PSYCHOACOUSTIC_FORMATS = new Set([
  'opus',
  'ogg',
  'vorbis',
  'aac',
  'm4a',
  'mp4',
  'mov',
  'mp3',
  'wma',
  'webm',
  'mkv',
  'avi',
]);

/** The only targets the in-process engine may emit when FFmpeg is unavailable. */
const PURE_LOSSLESS_TARGETS: ReadonlySet<string> = new Set(['wav', 'flac']);

/** Lossy targets plus the raw ADTS alias, used to word the fail-closed message. */
const PURE_UNAVAILABLE_ENCODE_TARGETS: ReadonlySet<string> = new Set([...LOSSY_PSYCHOACOUSTIC_FORMATS, 'adts']);

/** The pure path reproduces only mono and stereo, 16-bit integer PCM faithfully. */
const PURE_MAX_CHANNELS = 2;
const PURE_SOURCE_BITS_PER_SAMPLE = 16;

/**
 * The in-process decoders reduce every source to 16-bit integers and the encoders handle at most
 * two channels. Anything wider would be truncated or have its channels scrambled, so it must go
 * to FFmpeg instead of producing a lossy-looking lossless file.
 */
function assertPureSourceIsFaithful(decoded: DecodedAudio): void {
  if (!Number.isInteger(decoded.channels) || decoded.channels < 1) {
    throw new ConversionFailedError(`Invalid decoded source channel count: ${decoded.channels}`);
  }
  if (decoded.channels > PURE_MAX_CHANNELS) {
    throw new EngineUnavailableError(
      'ffmpeg',
      `Native FFmpeg engine is required to convert ${decoded.channels}-channel audio; the in-process engine reproduces only mono and stereo faithfully (Fail-Closed).`
    );
  }
  const isReducedFormat =
    decoded.sourceBitsPerSample !== undefined &&
    (decoded.sourceBitsPerSample !== PURE_SOURCE_BITS_PER_SAMPLE || decoded.sourceSampleFormat !== 'int');
  if (isReducedFormat) {
    throw new EngineUnavailableError(
      'ffmpeg',
      `Native FFmpeg engine is required to convert ${decoded.sourceBitsPerSample}-bit ${decoded.sourceSampleFormat} audio; the in-process engine reproduces only 16-bit integer PCM faithfully (Fail-Closed).`
    );
  }
}



/**
 * Executes system FFmpeg with configured audio and video options
 */
async function executeFfmpegTranscode(
  inputBuffer: Buffer,
  src: string,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  const tmpDir = os.tmpdir();
  const token = crypto.randomBytes(8).toString('hex');
  const inputPath = path.join(tmpDir, `easyconvert_in_${Date.now()}_${token}.${src}`);
  const outputPath = path.join(tmpDir, `easyconvert_out_${Date.now()}_${token}.${tgt}`);

  fs.writeFileSync(inputPath, inputBuffer);

  try {
    const ffmpegBin = getFfmpegPath() || '/usr/bin/ffmpeg';
    const durationSeconds = probeMediaDuration(inputPath, options, ffmpegBin);
    const timeoutMs = computeMediaTimeoutMs(durationSeconds, stageTimeoutMs(options, DEFAULT_MEDIA_TIER_MAX_MS));
    const runFfmpegWith = (ffmpegArgs: string[], limitMs: number, cwd?: string) =>
      executeSandboxedBinary(ffmpegBin, ffmpegArgs, {
        timeoutMs: limitMs,
        maxBuffer: 50 * 1024 * 1024,
        networkIsolated: true,
        signal: options.signal,
        ...(cwd ? { cwd } : {}),
      });
    const runFfmpeg = (ffmpegArgs: string[]) => runFfmpegWith(ffmpegArgs, timeoutMs);
    // A loudness request measures first (cheap: audio only), so the encode applies real numbers.
    const loudnessStage = await measureLoudnessStage({ inputPath, src, tgt, options, ffmpegBin, run: runFfmpeg });

    if (isTwoPassRequested(options)) {
      // Pass logs live in a job directory of their own, removed whether the passes succeed or fail.
      const passDir = fs.mkdtempSync(path.join(tmpDir, 'easyconvert_pass_'));
      try {
        const passes = buildTwoPassArguments(inputPath, outputPath, src, tgt, options, ffmpegBin, TWO_PASS_LOG_PREFIX, loudnessStage);
        await runTwoPass(passes, twoPassBudgetMs(timeoutMs), (passArgs, limitMs) => runFfmpegWith(passArgs, limitMs, passDir));
      } finally {
        fs.rmSync(passDir, { recursive: true, force: true });
      }
    } else {
      const args = buildFfmpegArguments(inputPath, outputPath, src, tgt, options, ffmpegBin, undefined, loudnessStage);
      try {
        await runFfmpeg(args);
      } catch (err) {
        // An advertised hardware encoder can still fail at runtime (missing device or driver).
        // Retry exactly once in software; every other failure, and a failed retry, reports the original error.
        // Any non-zero exit counts: driver and device messages differ across vendors and versions, so
        // matching them would miss real hardware failures. The cost is a second run for an input that
        // fails in software too, which then reports the original error. A cancelled job is never retried.
        const hardwareEncoderFailed = err instanceof SandboxedProcessError && usesHardwareVideoEncoder(args);
        if (!hardwareEncoderFailed || options.signal?.aborted) {
          throw err;
        }
        const softwareArgs = buildFfmpegArguments(
          inputPath, outputPath, src, tgt, { ...options, disableHwaccel: true }, ffmpegBin, undefined, loudnessStage
        );
        try {
          await runFfmpeg(softwareArgs);
        } catch {
          throw err;
        }
      }
    }

    const outputBuffer = fs.readFileSync(outputPath);
    if (outputBuffer.length === 0) {
      throw new Error(`FFmpeg output is empty (0 bytes) for ${src} -> ${tgt}`);
    }
    return {
      buffer: outputBuffer,
      mimeType: getMimeTypeForMedia(tgt),
      filename: `${baseName}.${tgt}`,
      size: outputBuffer.length,
      metadata: {
        ...describeAudioProcessing(options, ffmpegBin, loudnessStage),
        ...describeDroppedStreams(inputPath, tgt, options, ffmpegBin),
      },
    };
  } finally {
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  }
}

/**
 * Extracts one or more frame thumbnails from video media via native FFmpeg.
 */
async function executeFfmpegThumbnails(
  inputBuffer: Buffer,
  src: string,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  const tmpDir = os.tmpdir();
  const token = crypto.randomBytes(8).toString('hex');
  const inputPath = path.join(tmpDir, `easyconvert_in_${Date.now()}_${token}.${src}`);
  fs.writeFileSync(inputPath, inputBuffer);

  const ffmpegBin = getFfmpegPath() || '/usr/bin/ffmpeg';
  const timestamps = options.thumbnail?.at && options.thumbnail.at.length > 0
    ? options.thumbnail.at
    : ['00:00:01.000'];
  const actualTgt = options.thumbnail?.format || (tgt === 'png' ? 'png' : 'jpg');
  const parts: { filename: string; buffer: Buffer }[] = [];
  const createdFiles: string[] = [inputPath];

  try {
    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i];
      const outputPath = path.join(tmpDir, `easyconvert_thumb_${Date.now()}_${token}_${i}.${actualTgt}`);
      createdFiles.push(outputPath);

      const args = buildFfmpegArguments(inputPath, outputPath, src, actualTgt, options, ffmpegBin, ts);
      await executeSandboxedBinary(ffmpegBin, args, {
        timeoutMs: 30000,
        maxBuffer: 50 * 1024 * 1024,
        networkIsolated: true,
      });

      if (!fs.existsSync(outputPath)) {
        throw new Error(`FFmpeg thumbnail output missing for timestamp ${ts}`);
      }
      const partBuf = fs.readFileSync(outputPath);
      if (partBuf.length === 0) {
        throw new Error(`FFmpeg thumbnail output is 0 bytes for timestamp ${ts}`);
      }
      const partName = timestamps.length === 1 ? `${baseName}.${actualTgt}` : `${baseName}_thumb_${i + 1}.${actualTgt}`;
      parts.push({
        filename: partName,
        buffer: partBuf,
      });
    }

    return {
      buffer: parts[0].buffer,
      mimeType: getMimeTypeForMedia(actualTgt),
      filename: parts[0].filename,
      size: parts[0].buffer.length,
      parts: parts.length > 1 ? parts : undefined,
    };
  } finally {
    for (const p of createdFiles) {
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch {}
      }
    }
  }
}

/**
 * Packages video and audio media into adaptive bitrate (ABR) HLS or MPEG-DASH streaming bundle.
 * Outputs a structured ZIP archive containing master playlist / MPD manifest and all segment chunks.
 */
export async function packageHlsDashMedia(
  inputBuffer: Buffer,
  src: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  const packaging = options.packaging;
  if (!packaging) {
    throw new InvalidMediaOptionError('Packaging options are required for media packaging.');
  }

  const ffmpegBin = getFfmpegPath();
  if (!ffmpegBin) {
    throw new EngineUnavailableError('ffmpeg', 'Native FFmpeg engine is required for ABR media packaging.');
  }

  const tmpDir = os.tmpdir();
  const token = crypto.randomBytes(8).toString('hex');
  const sessionDir = path.join(tmpDir, `easyconvert_pkg_${Date.now()}_${token}`);
  fs.mkdirSync(sessionDir, { recursive: true });

  const inputPath = path.join(sessionDir, `input_${token}.${src}`);
  fs.writeFileSync(inputPath, inputBuffer);

  const outputDir = path.join(sessionDir, 'output');
  fs.mkdirSync(outputDir, { recursive: true });

  try {
    const source = probePackagingSource(inputPath, ffmpegBin);
    const args = buildHlsDashArguments(inputPath, outputDir, packaging, ffmpegBin, source);
    await executeSandboxedBinary(ffmpegBin, args, {
      cwd: outputDir,
      timeoutMs: computePackagingTimeoutMs(source.geometry.durationSec, plannedRungCount(packaging, source), stageTimeoutMs(options, DEFAULT_MEDIA_TIER_MAX_MS)),
      maxBuffer: 100 * 1024 * 1024,
      networkIsolated: true,
      signal: options.signal,
    });

    const outputFiles = fs.readdirSync(outputDir);
    if (outputFiles.length === 0) {
      throw new ConversionFailedError(`Packaging failed: no output files were generated in ${packaging.format} mode.`);
    }

    const expectedManifest = packaging.format === 'hls'
      ? (packaging.masterPlaylistName || 'master.m3u8')
      : (packaging.masterPlaylistName || 'manifest.mpd');

    if (!outputFiles.includes(expectedManifest)) {
      throw new ConversionFailedError(`Packaging failed: expected manifest "${expectedManifest}" was not produced.`);
    }

    const zip = new JSZip();
    const parts: { filename: string; buffer: Buffer }[] = [];

    // Sort files deterministically with manifest first
    outputFiles.sort((a, b) => {
      if (a === expectedManifest) return -1;
      if (b === expectedManifest) return 1;
      return a.localeCompare(b);
    });

    for (const file of outputFiles) {
      const filePath = path.join(outputDir, file);
      if (fs.statSync(filePath).isFile()) {
        const fileBuf = fs.readFileSync(filePath);
        zip.file(file, fileBuf);
        parts.push({ filename: file, buffer: fileBuf });
      }
    }

    const zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    return {
      buffer: zipBuffer,
      mimeType: 'application/zip',
      filename: `${baseName}-${packaging.format}.zip`,
      size: zipBuffer.length,
      parts,
    };
  } finally {
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch {}
  }
}


/**
 * Pure TypeScript Media Processing:
 * Parses RIFF WAV, decodes PCM audio, performs sample rate conversion,
 * applies volume normalization, generates valid audio frames and containers.
 */
async function processMediaPure(
  inputBuffer: Buffer,
  src: string,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  // 1. Extract PCM audio samples from source using pure audio decoder stack
  const decoded = decodeAudioBuffer(inputBuffer, src);
  assertPureSourceIsFaithful(decoded);
  if (!Number.isFinite(decoded.sampleRate) || decoded.sampleRate < 4000 || decoded.sampleRate > 192000) {
    throw new ConversionFailedError(`Invalid decoded source sample rate: ${decoded.sampleRate}`);
  }
  if (options.audioSampleRate !== undefined) {
    if (!Number.isFinite(options.audioSampleRate) || options.audioSampleRate < 4000 || options.audioSampleRate > 192000) {
      throw new ConversionFailedError(`Invalid or unsupported audio sample rate: ${options.audioSampleRate}`);
    }
  }

  let pcmData = decoded.samples;
  let sampleRate = options.audioSampleRate || decoded.sampleRate || 44100;
  let channels =
    options.audioChannels === 'mono'
      ? 1
      : options.audioChannels === 'stereo'
      ? 2
      : decoded.channels;

  // Remap channels if requested count differs from decoded source
  if (channels !== decoded.channels) {
    if (decoded.channels === 2 && channels === 1) {
      // Stereo -> Mono downmix
      const mono = new Int16Array(Math.floor(pcmData.length / 2));
      for (let i = 0; i < mono.length; i++) {
        mono[i] = Math.round((pcmData[i * 2] + pcmData[i * 2 + 1]) / 2);
      }
      pcmData = mono;
    } else if (decoded.channels === 1 && channels === 2) {
      // Mono -> Stereo upmix
      const stereo = new Int16Array(pcmData.length * 2);
      for (let i = 0; i < pcmData.length; i++) {
        stereo[i * 2] = pcmData[i];
        stereo[i * 2 + 1] = pcmData[i];
      }
      pcmData = stereo;
    } else {
      throw new ConversionFailedError(
        `Unsupported channel configuration: cannot remap audio from ${decoded.channels} channels to ${channels} channels (Fail-Closed).`
      );
    }
  }

  // Resample if requested sample rate differs from decoded source (Sinc bandlimited filter)
  if (options.audioSampleRate && options.audioSampleRate !== decoded.sampleRate) {
    pcmData = resampleAudioSinc(pcmData, decoded.sampleRate, options.audioSampleRate, channels);
  }

  // Apply volume adjustment if requested
  if (options.audioVolume !== undefined && options.audioVolume !== 100) {
    const factor = options.audioVolume / 100;
    for (let i = 0; i < pcmData.length; i++) {
      const val = Math.round(pcmData[i] * factor);
      pcmData[i] = Math.max(-32768, Math.min(32767, val));
    }
  }

  // 2. Synthesize target format
  let outputBuffer: Buffer;

  switch (tgt) {
    case 'wav':
      outputBuffer = encodeWav(pcmData, sampleRate, channels);
      break;

    case 'flac':
      outputBuffer = await encodeFlacStreamAsync(pcmData, sampleRate, channels);
      break;

    default:
      throw new ConversionFailedError(
        `Unsupported media target format: .${tgt}. Pure TypeScript engine cannot convert to .${tgt}.`
      );
  }

  return {
    buffer: outputBuffer,
    mimeType: getMimeTypeForMedia(tgt),
    filename: `${baseName}.${tgt}`,
    size: outputBuffer.length,
  };
}

/**
 * Encodes PCM samples into standard RIFF WAV format
 */
function encodeWav(samples: Int16Array, sampleRate: number, channels: number): Buffer {
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // 'fmt ' chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  buffer.writeUInt16LE(1, 20); // AudioFormat (1 for PCM)
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34); // BitsPerSample (16-bit)

  // 'data' chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Write PCM data
  for (let i = 0; i < samples.length; i++) {
    buffer.writeInt16LE(samples[i], 44 + i * 2);
  }

  return buffer;
}

/**
 * Encodes RFC 7845 compliant Ogg Opus container stream
 * with OpusHead identification header, OpusTags comment header, and authentic Opus audio packets.
 * If raw PCM is provided without an authentic encoder, fails closed.
 */
export function encodeOpusContainer(
  packetsOrSamples: Array<Uint8Array | Buffer> | Int16Array,
  sampleRate: number = 48000,
  channels: number = 2,
  title?: string
): Buffer {
  if (packetsOrSamples instanceof Int16Array || !Array.isArray(packetsOrSamples)) {
    throw new ConversionFailedError(
      'Authentic Opus bitstream encoder is required. Pure TypeScript cannot emit raw PCM masquerading as compressed bitstreams (Fail-Closed).'
    );
  }
  if (channels < 1 || channels > 2) {
    throw new Error(
      `Unsupported channel configuration for Ogg Opus: ${channels} channels (mapping family 0 only supports mono and stereo)`
    );
  }
  const chunks: Buffer[] = [];
  const serial = 0x4f505553; // 'OPUS'

  // 1. OggS Page 1: RFC 7845 Section 5.1 OpusHead (BOS)
  const opusHead = Buffer.alloc(19);
  opusHead.write('OpusHead', 0, 8, 'ascii'); // Magic signature
  opusHead.writeUInt8(1, 8); // Version 1
  opusHead.writeUInt8(channels, 9); // Channel count
  opusHead.writeUInt16LE(384, 10); // Pre-skip (384 samples at 48kHz)
  opusHead.writeUInt32LE(sampleRate || 48000, 12); // Input sample rate
  opusHead.writeInt16LE(0, 16); // Output gain (0 dB)
  opusHead.writeUInt8(0, 18); // Channel mapping family 0 (mono or stereo)

  const page1 = createOggPage(opusHead, 0x02, 0, 1, serial);
  chunks.push(page1);

  // 2. OggS Page 2: RFC 7845 Section 5.2 OpusTags
  const vendor = 'EasyConvert Engine';
  const vendorBuf = Buffer.from(vendor, 'utf-8');
  const tagList: Buffer[] = [];
  if (title) {
    tagList.push(Buffer.from(`TITLE=${title}`, 'utf-8'));
  }
  tagList.push(Buffer.from('ENCODER=EasyConvert Pure Opus', 'utf-8'));

  let tagsLen = 8 + 4 + vendorBuf.length + 4;
  for (const t of tagList) {
    tagsLen += 4 + t.length;
  }

  const opusTags = Buffer.alloc(tagsLen);
  let pos = 0;
  opusTags.write('OpusTags', pos, 8, 'ascii');
  pos += 8;
  opusTags.writeUInt32LE(vendorBuf.length, pos);
  pos += 4;
  vendorBuf.copy(opusTags, pos);
  pos += vendorBuf.length;
  opusTags.writeUInt32LE(tagList.length, pos);
  pos += 4;
  for (const t of tagList) {
    opusTags.writeUInt32LE(t.length, pos);
    pos += 4;
    t.copy(opusTags, pos);
    pos += t.length;
  }

  const page2 = createOggPage(opusTags, 0x00, 0, 2, serial);
  chunks.push(page2);

  // 3. OggS Page 3+: RFC 7845 Multi-page Opus Audio Data packets (authentic Opus packets)
  const audioPages = packageAuthenticOpusPages(packetsOrSamples, channels, 3, serial);
  chunks.push(...audioPages);

  return Buffer.concat(chunks);
}

/**
 * Precomputed CRC lookup table for RFC 3533 Ogg page checksum
 * Generator polynomial: 0x04C11DB7
 */
export const OGG_CRC_TABLE = new Uint32Array(256);
(() => {
  for (let i = 0; i < 256; i++) {
    let r = (i << 24) >>> 0;
    for (let j = 0; j < 8; j++) {
      if (r & 0x80000000) {
        r = ((r << 1) ^ 0x04c11db7) >>> 0;
      } else {
        r = (r << 1) >>> 0;
      }
    }
    OGG_CRC_TABLE[i] = r;
  }
})();

/**
 * Calculates RFC 3533 compliant 32-bit CRC checksum for an Ogg page (generator polynomial 0x04C11DB7)
 */
export function computeOggCrc(buffer: Uint8Array | Buffer): number {
  let crc = 0;
  for (let i = 0; i < buffer.length; i++) {
    const idx = ((crc >>> 24) ^ buffer[i]) & 0xff;
    crc = ((crc << 8) ^ OGG_CRC_TABLE[idx]) >>> 0;
  }
  return crc >>> 0;
}

/**
 * Packages discrete authentic Opus audio packets into RFC 3533 / RFC 7845 compliant
 * Ogg audio pages with monotonic granule positions and RFC 3533 CRC-32 checksums.
 * Eliminates fake linear-quantized PCM injections.
 */
export function packageAuthenticOpusPages(
  packets: Array<Uint8Array | Buffer>,
  channels: number = 2,
  startSeq: number = 3,
  serial: number = 0x4f505553
): Buffer[] {
  const pages: Buffer[] = [];
  let seq = startSeq;
  let cumulativeGranule = 0n;

  if (packets.length === 0) {
    const emptyPayload = Buffer.from([0xc0 | (channels === 2 ? 0x04 : 0x00), 0]);
    pages.push(createOggPage(emptyPayload, 0x04, 0n, seq, serial));
    return pages;
  }

  for (let i = 0; i < packets.length; i++) {
    const pkt = packets[i];
    const buf = Buffer.isBuffer(pkt) ? pkt : Buffer.from(pkt);
    const isLast = i === packets.length - 1;
    const flag = isLast ? 0x04 : 0x00;

    cumulativeGranule += 960n; // 20ms frame at 48kHz = 960 samples

    pages.push(createOggPage(buf, flag, cumulativeGranule, seq++, serial));
  }

  return pages;
}

/**
 * Encodes Ogg container stream with Vorbis identification packets, setup header, and multi-page audio payload.
 * If raw PCM is provided without an authentic encoder, fails closed.
 */
export function encodeOggContainer(
  packetsOrSamples: Array<Uint8Array | Buffer> | Int16Array,
  sampleRate: number = 44100,
  channels: number = 2,
  title?: string
): Buffer {
  if (packetsOrSamples instanceof Int16Array || !Array.isArray(packetsOrSamples)) {
    throw new ConversionFailedError(
      'Authentic Vorbis bitstream encoder is required. Pure TypeScript cannot emit raw PCM masquerading as compressed bitstreams (Fail-Closed).'
    );
  }
  if (channels < 1 || channels > 2) {
    throw new Error(
      `Unsupported channel configuration for Ogg Vorbis: ${channels} channels (only mono and stereo supported)`
    );
  }
  const chunks: Buffer[] = [];
  const serial = 0x12345678;

  // OggS Page 1: Vorbis Identification Header (RFC 3533 / Xiph Vorbis I Section 4.2.1)
  const idPacket = Buffer.alloc(30);
  idPacket.writeUInt8(0x01, 0); // Vorbis packet type 1
  idPacket.write('vorbis', 1);
  idPacket.writeUInt32LE(0, 7); // Version 0
  idPacket.writeUInt8(channels, 11);
  idPacket.writeUInt32LE(sampleRate, 12);
  idPacket.writeUInt32LE(192000, 16); // Bitrate nominal
  idPacket.writeUInt8(0xb8, 28); // Framing flag

  const page1 = createOggPage(idPacket, 0x02, 0, 1, serial); // BOS Header page
  chunks.push(page1);

  // OggS Page 2: Vorbis Comment Header (Xiph Vorbis I Section 4.2.2)
  const vendor = 'EasyConvert Engine';
  const commentPacket = Buffer.alloc(50);
  commentPacket.writeUInt8(0x03, 0);
  commentPacket.write('vorbis', 1);
  commentPacket.writeUInt32LE(vendor.length, 7);
  commentPacket.write(vendor, 11);
  const page2 = createOggPage(commentPacket, 0x00, 0, 2, serial);
  chunks.push(page2);

  // OggS Page 3: Vorbis Setup Header (Xiph Vorbis I Section 4.2.4)
  // Contains \x05vorbis magic and codebook framing bit
  const setupPacket = Buffer.alloc(64);
  setupPacket.writeUInt8(0x05, 0); // Vorbis packet type 5 (setup)
  setupPacket.write('vorbis', 1); // 6 bytes 'vorbis'
  setupPacket.writeUInt8(0x00, 7); // Codebook count = 1 (count - 1 = 0)
  setupPacket.writeUInt8(0x42, 8); // 'B'
  setupPacket.writeUInt8(0x43, 9); // 'C'
  setupPacket.writeUInt8(0x56, 10); // 'V'
  setupPacket.writeUInt16LE(1, 11); // Dimensions: 1
  setupPacket.writeUInt16LE(2, 13); // Entries: 2
  setupPacket.writeUInt8(0, 15);
  setupPacket.writeUInt8(0x01, 16);
  setupPacket.writeUInt8(0x01, 63); // Framing bit must be non-zero
  const page3 = createOggPage(setupPacket, 0x00, 0, 3, serial);
  chunks.push(page3);

  // OggS Page 4+: Discrete Vorbis packet pages
  let seq = 4;
  let cumulativeGranule = 0n;
  if (packetsOrSamples.length === 0) {
    const emptyPayload = Buffer.from([0x00, 1]);
    chunks.push(createOggPage(emptyPayload, 0x04, 0n, seq, serial));
  } else {
    for (let i = 0; i < packetsOrSamples.length; i++) {
      const pkt = packetsOrSamples[i];
      const buf = Buffer.isBuffer(pkt) ? pkt : Buffer.from(pkt);
      const isLast = i === packetsOrSamples.length - 1;
      const flag = isLast ? 0x04 : 0x00;
      cumulativeGranule += 1024n;
      chunks.push(createOggPage(buf, flag, cumulativeGranule, seq++, serial));
    }
  }

  return Buffer.concat(chunks);
}

export function createOggPage(
  payload: Buffer,
  headerType: number,
  granulePos: number | bigint,
  sequenceNum: number,
  serial: number
): Buffer {
  const segTable: number[] = [];
  let rem = payload.length;
  while (rem >= 255) {
    segTable.push(255);
    rem -= 255;
  }
  segTable.push(rem);

  if (segTable.length > 255) {
    throw new Error(
      `Ogg page segment table overflow: ${segTable.length} segments exceed RFC 3533 limit of 255 (payload length: ${payload.length})`
    );
  }

  const headerSize = 27 + segTable.length;
  const page = Buffer.alloc(headerSize + payload.length);
  page.write('OggS', 0);
  page.writeUInt8(0, 4); // Structure version
  page.writeUInt8(headerType, 5); // Flags (0x02 = BOS, 0x04 = EOS)
  page.writeBigInt64LE(BigInt(granulePos), 6);
  page.writeUInt32LE(serial, 14);
  page.writeUInt32LE(sequenceNum, 18);
  page.writeUInt32LE(0, 22); // Checksum initialized to 0 for CRC calculation
  page.writeUInt8(segTable.length, 26); // Segment count
  for (let i = 0; i < segTable.length; i++) {
    page.writeUInt8(segTable[i], 27 + i);
  }
  payload.copy(page, headerSize);

  // Calculate and store authentic RFC 3533 CRC-32 checksum
  const crc = computeOggCrc(page);
  page.writeUInt32LE(crc, 22);

  return page;
}

/**
 * Bandlimited polyphase resampler (Kaiser-windowed sinc, cutoff scaled to the lower rate).
 * The implementation lives in ./audio-resampler; this facade keeps the public entry point.
 * 16-bit output is TPDF-dithered; planar float output is left untouched.
 */
export function resampleAudioSinc(
  pcmData: Int16Array,
  srcRate: number,
  tgtRate: number,
  channels: number,
  options?: ResampleOptions
): Int16Array;
export function resampleAudioSinc(
  channels: Float32Array[],
  srcRate: number,
  tgtRate: number,
  options?: ResampleOptions
): Float32Array[];
export function resampleAudioSinc(
  data: Int16Array | Float32Array[],
  srcRate: number,
  tgtRate: number,
  param4?: number | ResampleOptions,
  param5?: ResampleOptions
): Int16Array | Float32Array[] {
  if (Array.isArray(data)) {
    return resamplePlanarFloat(data, srcRate, tgtRate, param4 as ResampleOptions | undefined);
  }
  return resampleInterleavedInt16(data, srcRate, tgtRate, param4 as number, param5);
}

/**
 * Encodes variable-length integer (VINT) for EBML elements
 */
function encodeEbmlVint(value: number): Buffer {
  if (value < 0x7f) {
    return Buffer.from([0x80 | value]);
  } else if (value < 0x3fff) {
    return Buffer.from([0x40 | (value >> 8), value & 0xff]);
  } else if (value < 0x1fffff) {
    return Buffer.from([0x20 | (value >> 16), (value >> 8) & 0xff, value & 0xff]);
  } else {
    return Buffer.from([
      0x10 | (value >> 24),
      (value >> 16) & 0xff,
      (value >> 8) & 0xff,
      value & 0xff,
    ]);
  }
}

function createEbmlElement(idBytes: number[], payload: Buffer): Buffer {
  const idBuf = Buffer.from(idBytes);
  const sizeBuf = encodeEbmlVint(payload.length);
  return Buffer.concat([idBuf, sizeBuf, payload]);
}

function createEbmlString(idBytes: number[], str: string): Buffer {
  return createEbmlElement(idBytes, Buffer.from(str, 'utf-8'));
}

function createEbmlUint(idBytes: number[], val: number): Buffer {
  if (val <= 0xff) {
    return createEbmlElement(idBytes, Buffer.from([val]));
  } else if (val <= 0xffff) {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(val, 0);
    return createEbmlElement(idBytes, b);
  } else {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(val, 0);
    return createEbmlElement(idBytes, b);
  }
}

function createEbmlFloat(idBytes: number[], val: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeFloatBE(val, 0);
  return createEbmlElement(idBytes, b);
}

/**
 * Encodes compliant WebM EBML container containing Info, Tracks (Audio PCM), and Cluster SimpleBlocks
 */
export function encodeWebmContainer(
  samples: Int16Array,
  sampleRate: number,
  channels: number,
  options: ConversionOptions
): Buffer {
  // 1. EBML Header
  const ebmlHeader = createEbmlElement(
    [0x1a, 0x45, 0xdf, 0xa3],
    Buffer.concat([
      createEbmlUint([0x42, 0x86], 1), // EBMLVersion
      createEbmlUint([0x42, 0xf7], 1), // EBMLReadVersion
      createEbmlUint([0x42, 0xf2], 4), // EBMLMaxIDLength
      createEbmlUint([0x42, 0xf3], 8), // EBMLMaxSizeLength
      createEbmlString([0x42, 0x82], 'webm'), // DocType
      createEbmlUint([0x42, 0x87], 2), // DocTypeVersion
      createEbmlUint([0x42, 0x85], 2), // DocTypeReadVersion
    ])
  );

  // 2. Segment -> Info
  const durationMs = Math.round((samples.length / (channels * sampleRate)) * 1000);
  const infoElement = createEbmlElement(
    [0x15, 0x49, 0xa9, 0x66],
    Buffer.concat([
      createEbmlUint([0x2a, 0xd7, 0xb1], 1000000), // TimecodeScale = 1ms
      createEbmlString([0x4d, 0x80], 'EasyConvert'),
      createEbmlString([0x57, 0x41], 'EasyConvert'),
      createEbmlFloat([0x44, 0x89], durationMs),
    ])
  );

  // 3. Segment -> Tracks -> TrackEntry (Audio PCM)
  const audioSettings = createEbmlElement(
    [0xe1],
    Buffer.concat([
      createEbmlFloat([0xb5], sampleRate), // SamplingFrequency
      createEbmlUint([0x9f], channels), // Channels
      createEbmlUint([0x62, 0x64], 16), // BitDepth
    ])
  );

  const trackEntry = createEbmlElement(
    [0xae],
    Buffer.concat([
      createEbmlUint([0xd7], 1), // TrackNumber 1
      createEbmlUint([0x73, 0xc5], 1), // TrackUID 1
      createEbmlUint([0x83], 2), // TrackType 2 (Audio)
      createEbmlString([0x86], 'A_PCM/INT/LIT'), // CodecID
      audioSettings,
    ])
  );

  const tracksElement = createEbmlElement([0x16, 0x54, 0xae, 0x6b], trackEntry);

  // 4. Segment -> Cluster -> SimpleBlock
  const sampleBytes = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    sampleBytes.writeInt16LE(samples[i], i * 2);
  }

  // SimpleBlock header: TrackNumber VINT (0x81), Timecode int16 (0), Flags (0x80 keyframe)
  const blockHeader = Buffer.from([0x81, 0x00, 0x00, 0x80]);
  const simpleBlock = createEbmlElement([0xa3], Buffer.concat([blockHeader, sampleBytes]));

  const clusterElement = createEbmlElement(
    [0x1f, 0x43, 0xb6, 0x75],
    Buffer.concat([createEbmlUint([0xe7], 0), simpleBlock])
  );

  // 5. Assemble Segment
  const segmentPayload = Buffer.concat([infoElement, tracksElement, clusterElement]);
  const segmentSize = encodeEbmlVint(segmentPayload.length);
  const segmentElement = Buffer.concat([
    Buffer.from([0x18, 0x53, 0x80, 0x67]),
    segmentSize,
    segmentPayload,
  ]);

  return Buffer.concat([ebmlHeader, segmentElement]);
}


function getMimeTypeForMedia(ext: string): string {
  const map: Record<string, string> = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    aac: 'audio/aac',
    flac: 'audio/flac',
    ogg: 'audio/ogg',
    wma: 'audio/x-ms-wma',
    m4a: 'audio/mp4',
    opus: 'audio/opus',
    aiff: 'audio/x-aiff',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
    mov: 'video/quicktime',
    wmv: 'video/x-ms-wmv',
    flv: 'video/x-flv',
    '3gp': 'video/3gpp',
    gif: 'image/gif',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    srt: 'application/x-subrip',
    vtt: 'text/vtt',
    ass: 'text/x-ssa',
  };
  return map[ext.toLowerCase()] || 'application/octet-stream';
}

export {
  decodeAudioBuffer,
  decodeWav,
  decodeFlac,
  decodeMp3,
  type DecodedAudio,
};
