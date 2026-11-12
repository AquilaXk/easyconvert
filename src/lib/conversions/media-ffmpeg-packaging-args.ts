import path from 'node:path';
import { InvalidMediaOptionError, MediaLadderRung, MediaPackagingOptions } from '../types';
import { probeAudioChannels, resolveFfprobeBinary, probeVideoGeometry, VideoGeometry } from './media-ffprobe';
import { type MediaInput, mediaInputArgs } from './media-process';
import { resolveVideoCodec } from './media-video-codec';
import { capLadderToSource, forcedKeyframeExpression, keyframeIntervalFrames, packagingManifestName, resolveSegmentType, rungRateCaps, MIN_RUNG_BITRATE_K } from './media-packaging';

export const DEFAULT_PACKAGING_LADDER: readonly MediaLadderRung[] = [
  { height: 1080, bitrateK: 4500, audioBitrateK: 192 },
  { height: 720, bitrateK: 2500, audioBitrateK: 128 },
  { height: 480, bitrateK: 1000, audioBitrateK: 96 },
] as const;

export const PACKAGING_VIDEO_ENCODERS: Record<string, string> = {
  h264: 'libx264',
  hevc: 'libx265',
  vp9: 'libvpx-vp9',
  av1: 'libsvtav1',
};

export const PACKAGING_AUDIO_ENCODERS: Record<string, string> = {
  aac: 'aac',
  opus: 'libopus',
};

const DEFAULT_SEGMENT_SECONDS = 4;
const MIN_SEGMENT_SECONDS = 2;
const MAX_SEGMENT_SECONDS = 10;
const MIN_RUNG_HEIGHT = 144;
const MAX_RUNG_HEIGHT = 4320;
const MAX_RUNG_BITRATE_K = 50_000;
const MAX_RUNG_FPS = 240;
/** Most rungs a ladder may have: every rung is a full encode, so the count bounds the work a request can ask for. */
export const MAX_LADDER_RUNGS = 10;
const MIN_RUNG_AUDIO_BITRATE_K = 16;
const MAX_RUNG_AUDIO_BITRATE_K = 1024;
/** Audio bitrate of the first, second and later rungs when the ladder gives none. */
const DEFAULT_RUNG_AUDIO_BITRATE_K = [192, 128, 96] as const;
const TS_SEGMENT_PATTERN = 'stream_%v_%03d.ts';
const FMP4_SEGMENT_PATTERN = 'stream_%v_%03d.m4s';
const FMP4_INIT_PATTERN = 'init_%v.mp4';
const PACKAGING_PIX_FMT = 'yuv420p';
const HEVC_PACKAGING_TAG = 'hvc1';

/** What packaging needs to know about the input before it plans a ladder. */
export interface PackagingSource {
  geometry: VideoGeometry;
  hasAudio: boolean;
}

/** Probes the first video stream (exact frame rate, displayed size, duration) and whether the input has audio. */
export async function probePackagingSource(input: MediaInput, ffmpegBin?: string | null, signal?: AbortSignal): Promise<PackagingSource> {
  const ffprobe = resolveFfprobeBinary(ffmpegBin);
  return {
    geometry: await probeVideoGeometry(input, ffprobe, signal),
    hasAudio: (await probeAudioChannels(input, ffprobe, 0, signal)) > 0,
  };
}

function validateLadder(ladder: readonly MediaLadderRung[]): void {
  if (!Array.isArray(ladder) || ladder.length === 0) {
    throw new InvalidMediaOptionError('Packaging ladder must be a non-empty array of rungs.');
  }
  if (ladder.length > MAX_LADDER_RUNGS) {
    throw new InvalidMediaOptionError(`Packaging ladder has ${ladder.length} rungs; it may have at most ${MAX_LADDER_RUNGS} rungs.`);
  }
  const seenHeights = new Set<number>();
  for (const rung of ladder) {
    if (typeof rung.height !== 'number' || !Number.isInteger(rung.height) || rung.height < MIN_RUNG_HEIGHT || rung.height > MAX_RUNG_HEIGHT) {
      throw new InvalidMediaOptionError(
        `Invalid ladder rung height: ${rung.height}. Must be an integer between ${MIN_RUNG_HEIGHT} and ${MAX_RUNG_HEIGHT}.`
      );
    }
    if (rung.height % 2 !== 0) {
      throw new InvalidMediaOptionError(`Invalid ladder rung height: ${rung.height}. 4:2:0 video needs an even height.`);
    }
    if (seenHeights.has(rung.height)) {
      throw new InvalidMediaOptionError(`Duplicate ladder rung height ${rung.height}; each rung names its playlist by height.`);
    }
    seenHeights.add(rung.height);
    if (typeof rung.bitrateK !== 'number' || !Number.isInteger(rung.bitrateK) || rung.bitrateK < MIN_RUNG_BITRATE_K || rung.bitrateK > MAX_RUNG_BITRATE_K) {
      throw new InvalidMediaOptionError(
        `Invalid ladder rung bitrateK: ${rung.bitrateK}. Must be an integer between ${MIN_RUNG_BITRATE_K} and ${MAX_RUNG_BITRATE_K}.`
      );
    }
    if (rung.fps !== undefined && (typeof rung.fps !== 'number' || !Number.isFinite(rung.fps) || rung.fps <= 0 || rung.fps > MAX_RUNG_FPS)) {
      throw new InvalidMediaOptionError(`Invalid ladder rung fps: ${rung.fps}. Must be a number between 1 and ${MAX_RUNG_FPS}.`);
    }
    if (
      rung.audioBitrateK !== undefined &&
      (typeof rung.audioBitrateK !== 'number' ||
        !Number.isInteger(rung.audioBitrateK) ||
        rung.audioBitrateK < MIN_RUNG_AUDIO_BITRATE_K ||
        rung.audioBitrateK > MAX_RUNG_AUDIO_BITRATE_K)
    ) {
      throw new InvalidMediaOptionError(
        `Invalid ladder rung audioBitrateK: ${rung.audioBitrateK}. Must be an integer between ${MIN_RUNG_AUDIO_BITRATE_K} and ${MAX_RUNG_AUDIO_BITRATE_K}.`
      );
    }
  }
}

/**
 * Encoder arguments that put an IDR frame at every segment boundary on every rung: the GOP spans one
 * segment, a keyframe is forced at each boundary time, and scene-cut keyframes are off so no keyframe
 * lands elsewhere and the rungs cut at the same instants (RFC 8216, section 6.2.3).
 */
function segmentKeyframeArgs(codec: string, rungIndex: number, gopFrames: number, segmentSeconds: number): string[] {
  const at = (option: string) => `${option}:v:${rungIndex}`;
  const common = [at('-g'), String(gopFrames), at('-force_key_frames'), forcedKeyframeExpression(segmentSeconds)];
  switch (codec) {
    case 'libx264':
      return [...common, at('-keyint_min'), String(gopFrames), at('-sc_threshold'), '0', at('-forced-idr'), '1'];
    case 'libx265':
      return [
        ...common,
        at('-keyint_min'), String(gopFrames),
        at('-forced-idr'), '1',
        at('-x265-params'), 'scenecut=0:open-gop=0',
      ];
    case 'libsvtav1':
      return [...common, at('-svtav1-params'), 'scd=0'];
    default:
      return [...common, at('-keyint_min'), String(gopFrames)];
  }
}

/**
 * Builds FFmpeg command-line arguments for multi-bitrate ABR packaging (HLS and MPEG-DASH).
 *
 * `source` is what was probed from the input (exact frame rate, displayed size, audio presence); when it is
 * left out the input file is probed here. The ladder is cut to what the source can fill and every rung
 * gets a capped peak rate, so the declared BANDWIDTH holds.
 */
export async function buildHlsDashArguments(
  input: MediaInput,
  outputDir: string,
  packaging: MediaPackagingOptions,
  ffmpegBin?: string | null,
  source?: PackagingSource
): Promise<string[]> {
  if (!packaging || !packaging.format) {
    throw new InvalidMediaOptionError('Packaging format is required ("hls" or "dash").');
  }

  const format = packaging.format.toLowerCase();
  if (format !== 'hls' && format !== 'dash') {
    throw new InvalidMediaOptionError(
      `Unsupported packaging format "${packaging.format}". Allowed: "hls", "dash".`
    );
  }
  const manifestName = packagingManifestName(format, packaging.masterPlaylistName, outputDir);

  let segmentSeconds = DEFAULT_SEGMENT_SECONDS;
  if (packaging.segmentSeconds !== undefined) {
    if (
      typeof packaging.segmentSeconds !== 'number' ||
      !Number.isInteger(packaging.segmentSeconds) ||
      packaging.segmentSeconds < MIN_SEGMENT_SECONDS ||
      packaging.segmentSeconds > MAX_SEGMENT_SECONDS
    ) {
      throw new InvalidMediaOptionError(
        `Invalid segmentSeconds: ${packaging.segmentSeconds}. Allowed range: ${MIN_SEGMENT_SECONDS} to ${MAX_SEGMENT_SECONDS} seconds integer.`
      );
    }
    segmentSeconds = packaging.segmentSeconds;
  }
  const segmentType = resolveSegmentType(packaging.segmentType, format);

  const requestedLadder: readonly MediaLadderRung[] = packaging.ladder ?? DEFAULT_PACKAGING_LADDER;
  validateLadder(requestedLadder);

  // Video codec
  const videoCodecKey = resolveVideoCodec((packaging.videoCodec || 'h264').toLowerCase());
  const vEncoder = PACKAGING_VIDEO_ENCODERS[videoCodecKey];
  if (!vEncoder) {
    throw new InvalidMediaOptionError(
      `Unsupported video codec "${packaging.videoCodec}". Allowed: h264, hevc (h265), vp9, av1.`
    );
  }

  // Audio codec
  const audioCodecKey = (packaging.audioCodec || 'aac').toLowerCase();
  const aEncoder = PACKAGING_AUDIO_ENCODERS[audioCodecKey];
  if (!aEncoder) {
    throw new InvalidMediaOptionError(
      `Unsupported audio codec "${packaging.audioCodec}". Allowed: aac, opus.`
    );
  }

  const probed = source ?? (await probePackagingSource(input, ffmpegBin));
  const ladder = capLadderToSource(requestedLadder, probed.geometry);
  const hasAudio = probed.hasAudio;
  const { fpsNum, fpsDen } = probed.geometry;

  const globalArgs: string[] = ['-y', '-loglevel', 'error'];
  const inputArgs: string[] = mediaInputArgs(input);

  // Construct filter_complex
  const filterParts: string[] = [];

  // Video split & scale
  const vSplitOuts = ladder.map((_, i) => `[v_in${i}]`).join('');
  filterParts.push(`[0:v]split=${ladder.length}${vSplitOuts}`);
  for (let i = 0; i < ladder.length; i++) {
    const rung = ladder[i];
    const fpsFilter = rung.fps ? `,fps=${rung.fps}` : '';
    filterParts.push(`[v_in${i}]scale=w=-2:h=${rung.height}${fpsFilter}[v_out${i}]`);
  }

  // Audio split
  if (hasAudio) {
    const aSplitOuts = ladder.map((_, i) => `[a_out${i}]`).join('');
    filterParts.push(`[0:a]asplit=${ladder.length}${aSplitOuts}`);
  }

  const complexFilter = filterParts.join('; ');
  const streamArgs: string[] = ['-filter_complex', complexFilter];

  // Map each rung
  for (let i = 0; i < ladder.length; i++) {
    const rung = ladder[i];
    const caps = rungRateCaps(rung.bitrateK);
    streamArgs.push(
      '-map', `[v_out${i}]`,
      `-c:v:${i}`, vEncoder,
      `-b:v:${i}`, `${rung.bitrateK}k`,
      `-maxrate:v:${i}`, `${caps.maxrateK}k`,
      `-bufsize:v:${i}`, `${caps.bufsizeK}k`,
      `-pix_fmt:v:${i}`, PACKAGING_PIX_FMT
    );
    if (videoCodecKey === 'hevc') {
      streamArgs.push(`-tag:v:${i}`, HEVC_PACKAGING_TAG);
    }

    // The rung's own rate when it names one, otherwise the source's exact rational rate.
    const gopFrames = rung.fps
      ? keyframeIntervalFrames(rung.fps, 1, segmentSeconds)
      : keyframeIntervalFrames(fpsNum, fpsDen, segmentSeconds);
    streamArgs.push(...segmentKeyframeArgs(vEncoder, i, gopFrames, segmentSeconds));

    if (hasAudio) {
      const audioBitrate = rung.audioBitrateK || DEFAULT_RUNG_AUDIO_BITRATE_K[Math.min(i, DEFAULT_RUNG_AUDIO_BITRATE_K.length - 1)];
      streamArgs.push(
        '-map', `[a_out${i}]`,
        `-c:a:${i}`, aEncoder,
        `-b:a:${i}`, `${audioBitrate}k`
      );
    }
  }

  if (format === 'hls') {
    const varStreamMap = ladder
      .map((rung, i) => {
        const streamName = `${rung.height}p`;
        return hasAudio ? `v:${i},a:${i},name:${streamName}` : `v:${i},name:${streamName}`;
      })
      .join(' ');

    // ffmpeg expands %v in the init name only when there are several variants; with one it keeps the
    // literal "%v", so a single rung names its init section directly.
    const initName = ladder.length === 1 ? `init_${ladder[0].height}p.mp4` : FMP4_INIT_PATTERN;
    const segmentArgs =
      segmentType === 'fmp4'
        ? [
            '-hls_segment_type', 'fmp4',
            '-hls_fmp4_init_filename', initName,
            '-hls_segment_filename', path.join(outputDir, FMP4_SEGMENT_PATTERN),
          ]
        : ['-hls_segment_filename', path.join(outputDir, TS_SEGMENT_PATTERN)];

    const hlsArgs: string[] = [
      '-f', 'hls',
      '-hls_time', String(segmentSeconds),
      '-hls_playlist_type', 'vod',
      '-hls_flags', 'independent_segments',
      '-master_pl_name', manifestName,
      ...segmentArgs,
      '-var_stream_map', varStreamMap,
      path.join(outputDir, 'stream_%v.m3u8'),
    ];

    return [...globalArgs, ...inputArgs, ...streamArgs, ...hlsArgs];
  } else {
    // DASH
    const adaptationSets = hasAudio
      ? 'id=0,streams=v id=1,streams=a'
      : 'id=0,streams=v';

    const dashArgs: string[] = [
      '-f', 'dash',
      '-seg_duration', String(segmentSeconds),
      '-use_template', '1',
      '-use_timeline', '1',
      '-init_seg_name', 'init_$RepresentationID$.m4s',
      '-media_seg_name', 'chunk_$RepresentationID$_$Number%05d$.m4s',
      '-adaptation_sets', adaptationSets,
      path.join(outputDir, manifestName),
    ];

    return [...globalArgs, ...inputArgs, ...streamArgs, ...dashArgs];
  }
}
