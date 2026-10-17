import fs from 'node:fs';
import type { ConversionOptions } from '../types';
import { probeStreamLayout, resolveFfprobeBinary } from './media-ffprobe';
import { planStreamMapping, type VideoContainer } from './media-stream-plan';

/**
 * Names the input streams a video-container conversion left out, for the result metadata. The conversion keeps
 * going (a target that cannot hold a stream is the usual case, not an error); this makes the loss visible.
 */

/** Targets whose streams are mapped by planStreamMapping. */
const VIDEO_CONTAINER_TARGETS: ReadonlySet<string> = new Set<VideoContainer>(['mp4', 'mov', 'mkv', 'webm', 'avi']);

/**
 * `{ droppedStreams }` for the conversion of `inputPath` to `tgt`, or `{}` when every stream was carried, the
 * target is not a video container (an audio or image target keeps one kind of stream by definition) or the
 * request does not map streams (a thumbnail or a subtitle extraction).
 */
export function describeDroppedStreams(
  inputPath: string,
  tgt: string,
  options: ConversionOptions,
  ffmpegBin: string | null | undefined
): Record<string, unknown> {
  const mapsStreams =
    VIDEO_CONTAINER_TARGETS.has(tgt) && !options.thumbnail && options.subtitles?.mode !== 'extract' && fs.existsSync(inputPath);
  if (!mapsStreams) return {};
  const layout = probeStreamLayout(inputPath, resolveFfprobeBinary(ffmpegBin), options);
  const plan = planStreamMapping({
    streams: layout.streams,
    container: tgt as VideoContainer,
    audioTrack: options.audio?.track,
    burnSubtitles: options.subtitles?.mode === 'burn',
    hasChapters: layout.chapters !== undefined,
  });
  return plan.dropped.length > 0 ? { droppedStreams: plan.dropped } : {};
}
