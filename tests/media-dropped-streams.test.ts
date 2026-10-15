import { describe, it, expect } from 'vitest';
import { oracleTest } from './helpers/oracle-test';
import {
  FIXTURE_CHAPTERS,
  FIXTURE_FRAMES,
  aacChapterMkv,
  coverArtMp4,
  expectedDrop,
  libraryMkv,
  probeBuffer,
  timecodeMov,
  twoVideoTrackMp4,
  withFixtureDirAsync,
} from './helpers/dropped-stream-fixtures';
import { assertDecodedMedia } from './oracles/product/media-oracle';
import { convertMedia } from '../src/lib/conversions/media';
import { planStreamMapping } from '../src/lib/conversions/media-stream-plan';
import type { InputStream } from '../src/lib/conversions/media-ffprobe';
import type { DroppedStream } from '../src/lib/types';

/**
 * A conversion to a container that cannot carry a stream still succeeds, and the result says what was left out:
 * `metadata.droppedStreams`, one entry per stream with its input index, kind, codec, language, title and the
 * reason. Oracles: the reference ffprobe's listing of the source streams (expected entries are built from it,
 * never from the engine) and a full ffmpeg decode of every output.
 */

const CHAPTER_TOLERANCE_SEC = 0.001;
const TRIM_START_SEC = 1;
const ENCODE_TIMEOUT_MS = 120_000;
/** The avi target encodes MPEG-4 Part 2 at constant quality; held to the same floor as every video target. */
const AVI_MIN_SSIM = 0.95;

function dropped(result: { metadata?: Record<string, unknown> }): DroppedStream[] {
  return (result.metadata?.droppedStreams as DroppedStream[] | undefined) ?? [];
}

describe('planStreamMapping dropped streams (pure)', () => {
  const stream = (index: number, type: InputStream['type'], codecName: string, extra: Partial<InputStream> = {}): InputStream => ({
    index,
    type,
    codecName,
    attachedPicture: false,
    rotation: 0,
    ...extra,
  });
  const library: InputStream[] = [
    stream(0, 'video', 'h264'),
    stream(1, 'audio', 'aac'),
    stream(2, 'subtitle', 'subrip', { language: 'eng', title: 'English cues' }),
    stream(3, 'subtitle', 'ass', { language: 'kor' }),
    stream(4, 'attachment', 'ttf', { title: 'font.ttf' }),
    stream(5, 'data', 'bin_data'),
    stream(6, 'video', 'mjpeg', { attachedPicture: true }),
    stream(7, 'video', 'h264'),
  ];

  it('lists subtitles, attachments, data, cover art, a second video and chapters an avi cannot carry, in input order', () => {
    const plan = planStreamMapping({ streams: library, container: 'avi', burnSubtitles: false, hasChapters: true });
    expect(plan.dropped).toEqual([
      { index: 2, kind: 'subtitle', codec: 'subrip', language: 'eng', title: 'English cues', reason: 'container_unsupported' },
      { index: 3, kind: 'subtitle', codec: 'ass', language: 'kor', reason: 'container_unsupported' },
      { index: 4, kind: 'attachment', codec: 'ttf', title: 'font.ttf', reason: 'container_unsupported' },
      { index: 5, kind: 'data', codec: 'bin_data', reason: 'stream_type_unsupported' },
      { index: 6, kind: 'attached_picture', codec: 'mjpeg', reason: 'stream_type_unsupported' },
      { index: 7, kind: 'video', codec: 'h264', reason: 'additional_video_track' },
      { kind: 'chapters', reason: 'container_unsupported' },
    ]);
  });

  it('keeps text subtitles and chapters for mp4 and drops only what mp4 cannot hold', () => {
    const plan = planStreamMapping({ streams: library, container: 'mp4', burnSubtitles: false, hasChapters: true });
    expect(plan.dropped.map((d) => [d.index, d.kind, d.reason])).toEqual([
      [4, 'attachment', 'container_unsupported'],
      [5, 'data', 'stream_type_unsupported'],
      [6, 'attached_picture', 'stream_type_unsupported'],
      [7, 'video', 'additional_video_track'],
    ]);
  });

  it('drops no attachment and no chapter for mkv', () => {
    const plan = planStreamMapping({ streams: library, container: 'mkv', burnSubtitles: false, hasChapters: true });
    expect(plan.dropped.map((d) => d.kind)).toEqual(['data', 'attached_picture', 'video']);
  });

  it('lists nothing for a plain video and audio input, and does not list subtitles that are burned in', () => {
    const plain = [stream(0, 'video', 'h264'), stream(1, 'audio', 'aac')];
    expect(planStreamMapping({ streams: plain, container: 'avi', burnSubtitles: false }).dropped).toEqual([]);
    const burned = [stream(0, 'video', 'h264'), stream(1, 'subtitle', 'subrip')];
    expect(planStreamMapping({ streams: burned, container: 'avi', burnSubtitles: true }).dropped).toEqual([]);
  });

  it('does not list audio tracks the request did not choose', () => {
    const twoAudio = [stream(0, 'video', 'h264'), stream(1, 'audio', 'aac'), stream(2, 'audio', 'aac')];
    expect(planStreamMapping({ streams: twoAudio, container: 'mp4', audioTrack: 1, burnSubtitles: false }).dropped).toEqual([]);
  });

  it('bounds the list by the mapped stream limit plus the chapter entry', () => {
    const many = Array.from({ length: 64 }, (_, i) => stream(i, 'data', 'bin_data'));
    const plan = planStreamMapping({ streams: many, container: 'mp4', burnSubtitles: false, hasChapters: false });
    expect(plan.dropped).toHaveLength(64);
  });
});

describe('convertMedia reports the streams the target container cannot carry', () => {
  oracleTest(
    'mkv with 2 subtitle tracks and an attachment converts to a decodable avi that reports exactly those 3 streams',
    ['ffmpeg', 'ffprobe'],
    async () => {
      await withFixtureDirAsync(async (dir) => {
        const mkv = libraryMkv(dir);
        const source = probeBuffer(mkv, 'mkv');
        const expected = [
          ...source.streams.filter((s) => s.codec_type === 'subtitle').map((s) => expectedDrop(s, 'subtitle', 'container_unsupported')),
          ...source.streams.filter((s) => s.codec_type === 'attachment').map((s) => expectedDrop(s, 'attachment', 'container_unsupported')),
        ];
        // The fixture really has the streams the oracle expects to see reported.
        expect(expected.map((e) => e.kind)).toEqual(['subtitle', 'subtitle', 'attachment']);

        const result = await convertMedia(mkv, 'mkv', 'avi', {}, 'library.mkv');

        expect(dropped(result)).toEqual(expected);
        // The output is a real avi: every stream decodes, the picture is the source, and only video and audio remain.
        assertDecodedMedia(result.buffer, 'avi', 'video', {
          streams: { video: 1, audio: 1, subtitle: 0 },
          video: { frameCount: FIXTURE_FRAMES, reference: { bytes: mkv, extension: 'mkv' }, minSsim: AVI_MIN_SSIM },
        });
        expect(probeBuffer(result.buffer, 'avi').streams.map((s) => s.codec_type).sort()).toEqual(['audio', 'video']);
      });
    },
    ENCODE_TIMEOUT_MS
  );

  oracleTest(
    'the same mkv with chapters also reports the chapter list that avi cannot hold, and mp4 reports the attachment only',
    ['ffmpeg', 'ffprobe'],
    async () => {
      await withFixtureDirAsync(async (dir) => {
        const mkv = libraryMkv(dir, { chapters: true });
        const source = probeBuffer(mkv, 'mkv');
        expect(source.chapters).toHaveLength(FIXTURE_CHAPTERS.length);

        const toAvi = await convertMedia(mkv, 'mkv', 'avi', {}, 'library.mkv');
        expect(dropped(toAvi).map((d) => d.kind)).toEqual(['subtitle', 'subtitle', 'attachment', 'chapters']);
        expect(dropped(toAvi).at(-1)).toEqual({ kind: 'chapters', reason: 'container_unsupported' });
        expect(probeBuffer(toAvi.buffer, 'avi').chapters).toHaveLength(0);

        const toMp4 = await convertMedia(mkv, 'mkv', 'mp4', {}, 'library.mkv');
        const attachment = source.streams.find((s) => s.codec_type === 'attachment')!;
        expect(dropped(toMp4)).toEqual([expectedDrop(attachment, 'attachment', 'container_unsupported')]);
        const out = probeBuffer(toMp4.buffer, 'mp4');
        expect(out.chapters).toHaveLength(FIXTURE_CHAPTERS.length);
        expect(out.streams.filter((s) => s.codec_type === 'subtitle')).toHaveLength(2);

        const toMkv = await convertMedia(mkv, 'mkv', 'mkv', {}, 'library.mkv');
        expect(dropped(toMkv)).toEqual([]);
        expect(toMkv.metadata).not.toHaveProperty('droppedStreams');
      });
    },
    ENCODE_TIMEOUT_MS
  );

  oracleTest(
    'a second video track, cover art and a timecode data track are reported with the reference ffprobe indices',
    ['ffmpeg', 'ffprobe'],
    async () => {
      await withFixtureDirAsync(async (dir) => {
        const twoVideo = twoVideoTrackMp4(dir);
        const twoVideoProbe = probeBuffer(twoVideo, 'mp4');
        const secondVideo = twoVideoProbe.streams.filter((s) => s.codec_type === 'video')[1];
        const toMkv = await convertMedia(twoVideo, 'mp4', 'mkv', {}, 'two-video.mp4');
        expect(dropped(toMkv)).toEqual([expectedDrop(secondVideo, 'video', 'additional_video_track')]);
        expect(probeBuffer(toMkv.buffer, 'mkv').streams.filter((s) => s.codec_type === 'video')).toHaveLength(1);

        const cover = coverArtMp4(dir);
        const coverProbe = probeBuffer(cover, 'mp4');
        const picture = coverProbe.streams.find((s) => s.disposition?.attached_pic === 1)!;
        const toMov = await convertMedia(cover, 'mp4', 'mov', {}, 'cover.mp4');
        expect(dropped(toMov)).toEqual([expectedDrop(picture, 'attached_picture', 'stream_type_unsupported')]);

        const timecode = timecodeMov(dir);
        const timecodeProbe = probeBuffer(timecode, 'mov');
        const data = timecodeProbe.streams.find((s) => s.codec_type === 'data')!;
        const toMp4 = await convertMedia(timecode, 'mov', 'mp4', {}, 'timecode.mov');
        expect(dropped(toMp4)).toEqual([expectedDrop(data, 'data', 'stream_type_unsupported')]);
      });
    },
    ENCODE_TIMEOUT_MS
  );

  oracleTest(
    'a source without unsupported streams reports nothing',
    ['ffmpeg', 'ffprobe'],
    async () => {
      await withFixtureDirAsync(async (dir) => {
        const mkv = libraryMkv(dir);
        const toMkv = await convertMedia(mkv, 'mkv', 'mkv', {}, 'library.mkv');
        expect(toMkv.metadata).not.toHaveProperty('droppedStreams');
      });
    },
    ENCODE_TIMEOUT_MS
  );
});

describe('chapters of a source whose audio starts before zero', () => {
  oracleTest(
    'an AAC mkv keeps every chapter at the time the source marks, with and without a trim',
    ['ffmpeg', 'ffprobe'],
    async () => {
      await withFixtureDirAsync(async (dir) => {
        const mkv = aacChapterMkv(dir);
        const source = probeBuffer(mkv, 'mkv');
        // The fixture has the property this test is about: AAC priming puts the container start before zero.
        expect(probeStart(source)).toBeLessThan(0);
        const sourceStarts = source.chapters.map((c) => Number(c.start_time));
        expect(sourceStarts).toEqual(FIXTURE_CHAPTERS.map((c) => c.startMs / 1000));

        for (const target of ['mp4', 'mkv'] as const) {
          const result = await convertMedia(mkv, 'mkv', target, {}, 'aac-chapters.mkv');
          const out = probeBuffer(result.buffer, target);
          expect(out.chapters, target).toHaveLength(FIXTURE_CHAPTERS.length);
          out.chapters.forEach((chapter, i) => {
            expect(Math.abs(Number(chapter.start_time) - sourceStarts[i]), `${target} chapter ${i}`).toBeLessThanOrEqual(CHAPTER_TOLERANCE_SEC);
            expect(chapter.tags?.title).toBe(FIXTURE_CHAPTERS[i].title);
          });
        }

        // A trim moves every chapter earlier by the trimmed amount and drops the ones that end before it.
        const trimmed = await convertMedia(mkv, 'mkv', 'mp4', { trim: { start: String(TRIM_START_SEC) } }, 'aac-chapters.mkv');
        const kept = probeBuffer(trimmed.buffer, 'mp4').chapters.map((c) => Number(c.start_time));
        // ffmpeg keeps a chapter that ends at or after the trim point and clamps its start to zero.
        const expectedStarts = FIXTURE_CHAPTERS.filter((c) => c.endMs / 1000 >= TRIM_START_SEC).map((c) =>
          Math.max(0, c.startMs / 1000 - TRIM_START_SEC)
        );
        expect(kept).toHaveLength(expectedStarts.length);
        kept.forEach((start, i) => expect(Math.abs(start - expectedStarts[i]), `trimmed chapter ${i}`).toBeLessThanOrEqual(CHAPTER_TOLERANCE_SEC));
      });
    },
    ENCODE_TIMEOUT_MS
  );
});

function probeStart(source: ReturnType<typeof probeBuffer>): number {
  return Math.min(...source.streams.map((s) => Number(s.start_time ?? 0)));
}
