import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { requireOracleTool } from './helpers/differential-oracle';
import { countStreams, probeFile, withMediaFile, type ProbedStream } from './helpers/ffmpeg-measure';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * Bitmap subtitle streams (PGS from a Blu-ray, XSUB from a DivX file) in real files, converted to MP4, MOV and Matroska.
 * A bitmap stream is carried as it is where the container has a codec id for it and is left out where it has none; it is never
 * handed to the text subtitle encoder, which refused the whole file. ffprobe lists the streams of the source and of each
 * output, and the dropped streams the result reports are checked against what the output lacks.
 */

const skip = skipWithoutTools('ffmpeg', 'ffprobe');
const CONVERSION_TIMEOUT_MS = 240_000;
/** Matroska codec ids exist for these; the codec names are ffprobe's. */
const MATROSKA_BITMAP_CODECS: ReadonlySet<string> = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle']);

const SAMPLES: Array<{ id: string; format: string; targets: string[] }> = [
  { id: 'samples-00001-2.mts', format: 'mts', targets: ['mp4', 'mov', 'mkv'] },
  { id: 'samples-wrong-size-vc1.m2ts', format: 'm2ts', targets: ['mp4', 'mov', 'mkv'] },
  { id: 'samples-small.divx', format: 'divx', targets: ['mp4', 'mkv'] },
];

function subtitleStreams(file: string): ProbedStream[] {
  return probeFile(requireOracleTool('ffprobe'), file).streams.filter((stream) => stream.codec_type === 'subtitle');
}

describe.skipIf(skip)('bitmap subtitle streams of real files', () => {
  for (const { id, format, targets } of SAMPLES) {
    for (const target of targets) {
      it(`${id} to ${target} converts, and a subtitle stream is carried only where ${target} has a codec id for it`, { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
        const sample = await requireRealworldSample(ctx, id);
        const source = subtitleStreams(sample.path);
        expect(source.length, `subtitle streams of ${id}`).toBeGreaterThan(0);
        const result = await dispatchConversion(sample.bytes, format, target, {}, id);

        const output = withMediaFile(result.buffer, target, (file) => {
          const probed = probeFile(requireOracleTool('ffprobe'), file);
          return { subtitles: probed.streams.filter((stream) => stream.codec_type === 'subtitle'), counts: countStreams(probed) };
        });
        expect(output.counts.video, 'video streams of the output').toBe(1);
        expect(output.counts.audio, 'audio streams of the output').toBeGreaterThan(0);

        const carriedByCopy = target === 'mkv' ? source.filter((stream) => MATROSKA_BITMAP_CODECS.has(stream.codec_name ?? '')) : [];
        expect(output.subtitles.map((stream) => stream.codec_name)).toEqual(carriedByCopy.map((stream) => stream.codec_name));

        const lost = source.filter((stream) => !carriedByCopy.includes(stream));
        const reported = (result.metadata?.droppedStreams ?? []) as Array<{ index?: number; kind: string; codec?: string; reason: string }>;
        const reportedSubtitles = reported.filter((entry) => entry.kind === 'subtitle');
        expect(reportedSubtitles).toEqual(
          lost.map((stream) => ({
            index: stream.index,
            kind: 'subtitle',
            codec: stream.codec_name,
            ...(stream.tags?.language ? { language: stream.tags.language } : {}),
            ...(stream.tags?.title ? { title: stream.tags.title } : {}),
            reason: 'container_unsupported',
          }))
        );
      });
    }
  }
});
