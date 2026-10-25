import path from 'node:path';
import { InvalidMediaOptionError, MediaLadderRung, MediaPackagingSegmentType } from '../types';
import type { VideoGeometry } from './media-ffprobe';

/**
 * Planning rules for adaptive-bitrate packaging (HLS, RFC 8216; MPEG-DASH, ISO/IEC 23009-1). They are
 * pure functions of the probed source and the requested ladder, so they are tested without ffmpeg.
 */

/**
 * Peak rate of a rung over the declared rate. The HLS authoring guidance keeps a segment's peak within
 * 10% of the playlist BANDWIDTH; 7% leaves room for container overhead and the audio track.
 */
export const ABR_MAXRATE_FACTOR = 1.07;
/** Rate-control buffer of a rung over its declared rate: 1.5 seconds of video at the declared rate. */
export const ABR_BUFSIZE_FACTOR = 1.5;
/** Lowest video bitrate a rung is capped to when the source itself is lower, matching the schema minimum. */
export const MIN_RUNG_BITRATE_K = 50;

/** Segment containers HLS can carry here: MPEG-2 TS, or fragmented MP4 (CMAF, ISO/IEC 23000-19). */
export const PACKAGING_SEGMENT_TYPES: ReadonlySet<string> = new Set<MediaPackagingSegmentType>(['ts', 'fmp4']);
export const DEFAULT_SEGMENT_TYPE: MediaPackagingSegmentType = 'ts';

/** A segment type the packager supports, or InvalidMediaOptionError for anything else. */
export function resolveSegmentType(requested: unknown, format: 'hls' | 'dash'): MediaPackagingSegmentType {
  if (requested === undefined) {
    return format === 'dash' ? 'fmp4' : DEFAULT_SEGMENT_TYPE;
  }
  if (typeof requested !== 'string' || !PACKAGING_SEGMENT_TYPES.has(requested)) {
    throw new InvalidMediaOptionError(`Invalid segmentType ${JSON.stringify(requested)}. Allowed: "ts", "fmp4".`);
  }
  if (format === 'dash' && requested !== 'fmp4') {
    throw new InvalidMediaOptionError('MPEG-DASH packaging writes ISO BMFF segments; segmentType "ts" applies to HLS only.');
  }
  return requested as MediaPackagingSegmentType;
}

/*
 * The name of the master playlist (HLS) or manifest (DASH) a request may choose: a bare file name in the packaging
 * output directory. The request schema and the argument builder check it with the same rule.
 */
export const PACKAGING_FORMATS = ['hls', 'dash'] as const;
export type PackagingFormat = (typeof PACKAGING_FORMATS)[number];

const MAX_MANIFEST_NAME_CHARS = 128;

/** Letters, digits, `.`, `_` and `-` only, so the name holds no directory separator and no character a shell or URL treats specially. */
const PACKAGING_MANIFEST_NAME_PATTERN = `^[A-Za-z0-9._-]{1,${MAX_MANIFEST_NAME_CHARS}}$`;

const PACKAGING_MANIFEST_EXTENSION: Record<PackagingFormat, string> = { hls: '.m3u8', dash: '.mpd' };

const DEFAULT_MANIFEST_NAME: Record<PackagingFormat, string> = { hls: 'master.m3u8', dash: 'manifest.mpd' };

/** Request schema of `packaging.masterPlaylistName`. */
export const MASTER_PLAYLIST_NAME_SCHEMA = {
  type: 'string',
  pattern: PACKAGING_MANIFEST_NAME_PATTERN,
  description: `File name of the master playlist (HLS, ending in .m3u8) or manifest (DASH, ending in .mpd): 1 to ${MAX_MANIFEST_NAME_CHARS} letters, digits, \`.\`, \`_\` and \`-\`, no directory.`,
} as const;

/** Request schema rules that tie the name's extension to `packaging.format`. */
export const MANIFEST_EXTENSION_BY_FORMAT_SCHEMA = PACKAGING_FORMATS.map((format) => ({
  if: { type: 'object', required: ['format'], properties: { format: { const: format } } },
  then: { type: 'object', properties: { masterPlaylistName: { type: 'string', pattern: `\\${PACKAGING_MANIFEST_EXTENSION[format]}$` } } },
}));

const MANIFEST_NAME = new RegExp(PACKAGING_MANIFEST_NAME_PATTERN);

/** The manifest file name of a packaging run: the requested one once it passes the rule, else the format's default. */
export function packagingManifestName(format: PackagingFormat, requested: string | undefined, outputDir: string): string {
  if (requested === undefined || requested === '') return DEFAULT_MANIFEST_NAME[format];
  const extension = PACKAGING_MANIFEST_EXTENSION[format];
  if (typeof requested !== 'string' || !MANIFEST_NAME.test(requested) || !requested.endsWith(extension)) {
    throw new InvalidMediaOptionError(
      `masterPlaylistName must be 1 to ${MAX_MANIFEST_NAME_CHARS} letters, digits, ".", "_" or "-" ending in "${extension}" for ${format}.`
    );
  }
  const root = path.resolve(outputDir);
  if (path.dirname(path.resolve(root, requested)) !== root) {
    throw new InvalidMediaOptionError(`masterPlaylistName "${requested}" does not name a file in the packaging output directory.`);
  }
  return requested;
}

/**
 * Frames between keyframes: the frames in one segment at the exact rational frame rate, rounded up so the
 * encoder never inserts a keyframe before the forced one at the segment boundary (29.97 fps over 4 s is
 * 120 frames, not 119.88).
 */
export function keyframeIntervalFrames(fpsNum: number, fpsDen: number, segmentSeconds: number): number {
  return Math.ceil((fpsNum * segmentSeconds) / fpsDen);
}

/** `-force_key_frames` expression that places a keyframe on the first frame at or after every segment boundary. */
export function forcedKeyframeExpression(segmentSeconds: number): string {
  return `expr:gte(t,n_forced*${segmentSeconds})`;
}

export interface RateCaps {
  maxrateK: number;
  bufsizeK: number;
}

/** Peak rate and buffer size of a rung, in kbit/s. */
export function rungRateCaps(bitrateK: number): RateCaps {
  return {
    maxrateK: Math.ceil(bitrateK * ABR_MAXRATE_FACTOR),
    bufsizeK: Math.ceil(bitrateK * ABR_BUFSIZE_FACTOR),
  };
}

/**
 * Limits the ladder to what the source can fill: rungs taller than the displayed source are dropped, and no
 * rung asks for more video bitrate than the source carries. When every rung is taller than the source, one
 * rung at the source height (rounded down to an even number) keeps the cheapest requested bitrate.
 */
export function capLadderToSource(ladder: readonly MediaLadderRung[], source: VideoGeometry): MediaLadderRung[] {
  const cap = (rung: MediaLadderRung): MediaLadderRung => {
    if (source.bitrateK === undefined || rung.bitrateK <= source.bitrateK) return { ...rung };
    return { ...rung, bitrateK: Math.max(MIN_RUNG_BITRATE_K, source.bitrateK) };
  };
  const fitting = ladder.filter((rung) => rung.height <= source.height).map(cap);
  if (fitting.length > 0) return fitting;
  const cheapest = ladder.reduce((best, rung) => (rung.bitrateK < best.bitrateK ? rung : best));
  const evenHeight = source.height - (source.height % 2);
  return [cap({ ...cheapest, height: evenHeight })];
}

/** Rungs each cost a full encode of the clip, so the timeout budget grows with the ladder. */
export function packagingBudgetSeconds(durationSec: number, rungCount: number): number {
  return Math.max(0, durationSec) * Math.max(1, rungCount);
}
