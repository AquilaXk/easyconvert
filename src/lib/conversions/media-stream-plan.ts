import { InvalidMediaOptionError } from '../types';
import { firstVideoStream, type InputStream } from './media-ffprobe';

/**
 * Which streams of the input a video-container conversion keeps. The plan is a pure function of the
 * probed stream list and the target container, so every rule is tested without running ffmpeg.
 */

export type VideoContainer = 'mp4' | 'mov' | 'mkv' | 'webm' | 'avi';

/** Subtitle codecs that store pictures, not text. A container that only holds text cannot carry them. */
export const BITMAP_SUBTITLE_CODECS: ReadonlySet<string> = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle']);

export interface ContainerSubtitleCodecs {
  /** Output codec of a text subtitle stream (`copy` keeps the input codec). */
  text: string;
  /** Output codec of a bitmap subtitle stream, or null when the container cannot carry one. */
  bitmap: string | null;
}

/** Subtitle codecs per container. A container missing here (avi) carries no subtitle stream at all. */
export const SUBTITLE_CODEC_BY_CONTAINER: Readonly<Record<string, ContainerSubtitleCodecs>> = {
  mp4: { text: 'mov_text', bitmap: null },
  mov: { text: 'mov_text', bitmap: null },
  webm: { text: 'webvtt', bitmap: null },
  mkv: { text: 'copy', bitmap: 'copy' },
};

/** Containers that carry attachment streams (fonts, cover files). */
export const ATTACHMENT_CONTAINERS: ReadonlySet<string> = new Set(['mkv']);
/** Containers whose muxer writes chapters. */
export const CHAPTER_CONTAINERS: ReadonlySet<string> = new Set(['mp4', 'mov', 'mkv', 'webm']);
/** Containers that store per-frame timestamps, so a variable frame rate survives (`-fps_mode passthrough`). */
export const VARIABLE_FRAME_RATE_CONTAINERS: ReadonlySet<string> = new Set(['mp4', 'mov', 'mkv', 'webm']);

/** Containers that name a track only through its handler name, not a `title` tag (ISO/IEC 14496-12 hdlr box). */
export const HANDLER_NAME_CONTAINERS: ReadonlySet<string> = new Set(['mp4', 'mov']);
/** Longest track name kept as a handler name: the hdlr name is a short, NUL-terminated string. */
export const MAX_TRACK_NAME_BYTES = 255;

export interface StreamMapPlan {
  /** `-map` operands, in output order: the video track, audio tracks, subtitle tracks, attachments. */
  maps: string[];
  /** The `-map` operands of the mapped audio tracks. */
  audioMaps: string[];
  /** Track titles to write as handler names, by output stream index (mp4 and mov only). */
  handlerNames: Array<{ outputIndex: number; name: string }>;
  /** Absolute input index of the mapped video stream, when the input has one. */
  videoIndex?: number;
  /** Number of subtitle streams of the input that are mapped to the output. */
  subtitleCount: number;
  /** Codec for `-c:s` of the mapped input subtitle streams; undefined when none is mapped. */
  subtitleCodec?: string;
}

export interface StreamPlanInput {
  streams: readonly InputStream[];
  container: VideoContainer;
  /** Index among the audio streams, or all of them (the default). */
  audioTrack?: number | 'all';
  /** Subtitles are rendered into the picture, so none is carried as a stream. */
  burnSubtitles: boolean;
}

function selectAudio(audio: readonly InputStream[], track: number | 'all' | undefined): InputStream[] {
  if (track === undefined || track === 'all') return [...audio];
  if (!Number.isInteger(track) || track < 0) {
    throw new InvalidMediaOptionError('Audio track index must be a non-negative integer.');
  }
  if (track >= audio.length) {
    throw new InvalidMediaOptionError(`Audio track ${track} does not exist; the input has ${audio.length} audio stream(s).`);
  }
  return [audio[track]];
}

function carriableSubtitles(subtitles: readonly InputStream[], container: VideoContainer): InputStream[] {
  const codecs = Object.hasOwn(SUBTITLE_CODEC_BY_CONTAINER, container) ? SUBTITLE_CODEC_BY_CONTAINER[container] : undefined;
  if (!codecs) return [];
  for (const stream of subtitles) {
    if (BITMAP_SUBTITLE_CODECS.has(stream.codecName) && codecs.bitmap === null) {
      throw new InvalidMediaOptionError(
        `Subtitle stream #${stream.index} (${stream.codecName}) is a bitmap subtitle that ${container} cannot carry. ` +
          'Set subtitles.mode to "burn" to render it into the picture, or convert to mkv.'
      );
    }
  }
  return [...subtitles];
}

/**
 * Plans the streams of a video-container target: the first real video track, every audio track (or the
 * chosen one), every subtitle the container can carry, and attachments for mkv. A bitmap subtitle that a
 * text-only container cannot hold is rejected with the stream named, unless the caller burns it in.
 */
export function planStreamMapping(input: StreamPlanInput): StreamMapPlan {
  const { streams, container } = input;
  const video = firstVideoStream(streams);
  const audio = selectAudio(streams.filter((s) => s.type === 'audio'), input.audioTrack);
  const subtitles = input.burnSubtitles ? [] : carriableSubtitles(streams.filter((s) => s.type === 'subtitle'), container);
  const attachments = ATTACHMENT_CONTAINERS.has(container) ? streams.filter((s) => s.type === 'attachment') : [];

  const ordered = [...(video ? [video] : []), ...audio, ...subtitles, ...attachments];
  const codecs = Object.hasOwn(SUBTITLE_CODEC_BY_CONTAINER, container) ? SUBTITLE_CODEC_BY_CONTAINER[container] : undefined;
  const handlerNames = HANDLER_NAME_CONTAINERS.has(container)
    ? ordered.flatMap((stream, outputIndex) =>
        stream.title ? [{ outputIndex, name: truncateUtf8(stream.title, MAX_TRACK_NAME_BYTES) }] : []
      )
    : [];
  return {
    maps: ordered.map((stream) => `0:${stream.index}`),
    audioMaps: audio.map((stream) => `0:${stream.index}`),
    handlerNames,
    videoIndex: video?.index,
    subtitleCount: subtitles.length,
    subtitleCodec: subtitles.length > 0 && codecs ? codecs.text : undefined,
  };
}

/** `text` cut to at most `maxBytes` UTF-8 bytes without splitting a character. */
function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let out = '';
  for (const char of text) {
    bytes += Buffer.byteLength(char, 'utf8');
    if (bytes > maxBytes) break;
    out += char;
  }
  return out;
}
