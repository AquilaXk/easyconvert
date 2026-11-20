import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { rewrapContainerFor, rewrapStreamArgs } from '../src/lib/conversions/media-ffmpeg-rewrap';
import type { InputStream } from '../src/lib/conversions/media-ffprobe';
import { getOracleToolPath } from './helpers/differential-oracle';
import { requireEncoders, runFfmpeg, sineInput, testPatternInput } from './helpers/ffmpeg-media-fixtures';
import { probeFile, withMediaFile } from './helpers/ffmpeg-measure';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipWithoutTools } from './helpers/strict-skip';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { ConversionFailedError } from '../src/lib/types';

/**
 * A file converted to its own format is written again into its own container. These containers failed before: their
 * extension is no FFmpeg muxer name (`.3gpp`, `.dvr`, `.mod`, `.rmvb`), or the AAC audio the transcode picked is refused by
 * the muxer (MPEG program stream, Ogg, RealMedia) or cannot be decoded from the file (RealMedia `.rm`, Windows recorded TV). The oracle is ffprobe on the output: the container it names, the codecs
 * of its streams and the length of the sound or picture against the input.
 */

const skip = skipWithoutTools('ffmpeg', 'ffprobe');
const TIMEOUT_MS = 120_000;
const DURATION_TOLERANCE_SECONDS = 0.5;

const ffprobe = (): string => getOracleToolPath('ffprobe') as string;
const ffmpeg = (): string => getOracleToolPath('ffmpeg') as string;

interface Facts {
  container: string;
  codecs: string[];
  duration: number;
}

function factsOf(bytes: Uint8Array, extension: string): Facts {
  return withMediaFile(bytes, extension, (file) => {
    const probed = probeFile(ffprobe(), file);
    return {
      container: probed.format.format_name,
      codecs: probed.streams.map((stream) => stream.codec_name ?? ''),
      duration: Number(probed.format.duration ?? 0),
    };
  });
}

/**
 * ffmpeg's exit status for decoding the first seconds of every stream. The corpus files are pieces cut out of longer files
 * and their own streams report decode warnings, so the status is the oracle, not the silence of stderr.
 */
function decodeStatus(file: string): number | null {
  return spawnSync(ffmpeg(), ['-v', 'error', '-i', file, '-t', '3', '-map', '0:v?', '-map', '0:a?', '-f', 'null', '-'], { timeout: TIMEOUT_MS }).status;
}

async function rewrap(bytes: Buffer, format: string): Promise<Buffer> {
  const converted = await convertFile(bytes, format, format, {}, `sample.${format}`);
  return converted.buffer;
}

function expectRewritten(output: Facts, container: string, codecs: readonly string[]): void {
  expect(output.container).toContain(container);
  expect(output.codecs).toEqual(codecs);
}

/** The header length of a generated input is true; the corpus files are cut pieces whose headers state the length of the whole film. */
function expectSameLength(source: Facts, output: Facts): void {
  expect(Math.abs(output.duration - source.duration)).toBeLessThan(DURATION_TOLERANCE_SECONDS);
}

const mobile = (): Buffer => {
  requireEncoders('mpeg4', 'aac');
  return runFfmpeg(
    [...testPatternInput({ width: 320, height: 240, fps: 15, seconds: 2 }), ...sineInput(44100, 2), '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest'],
    'mp4'
  );
};

describe.skipIf(skip)('a same-format conversion writes the container again', () => {
  it('3gpp: the file is written with the 3GP muxer, as .3gpp is no muxer name', async () => {
    const source = mobile();
    const output = await rewrap(source, '3gpp');
    expectRewritten(factsOf(output, '3gp'), '3gp', ['mpeg4', 'aac']);
    expectSameLength(factsOf(source, 'mp4'), factsOf(output, '3gp'));
  }, TIMEOUT_MS);

  it('mod: a camcorder file is an MPEG program stream', async () => {
    requireEncoders('mpeg2video', 'mp2');
    const source = runFfmpeg(
      [...testPatternInput({ width: 320, height: 240, fps: 25, seconds: 2 }), ...sineInput(44100, 2), '-c:v', 'mpeg2video', '-c:a', 'mp2', '-f', 'mpeg'],
      'mod'
    );
    const output = await rewrap(source, 'mod');
    expectRewritten(factsOf(output, 'mpg'), 'mpeg', ['mpeg2video', 'mp2']);
    expectSameLength(factsOf(source, 'mpg'), factsOf(output, 'mpg'));
  }, TIMEOUT_MS);

  it.for([
    ['3g2', 'ffs-650vid.3g2', '3g2', ['mpeg4', 'aac']],
    ['dvr', 'ffs-ss2.dvr', 'asf', ['mpeg2video', 'ac3']],
    ['mpeg', 'samples-eof.mpeg', 'mpeg', ['mpeg1video', 'mp2']],
    ['mpg', 'fate-pcm_aud.mpg', 'mpeg', ['pcm_dvd']],
    ['ogv', 'fate-bear.ogv', 'ogg', ['theora', 'vorbis']],
    ['amr', 'fate-12.2k.amr', 'amr', ['amr_nb']],
    ['rmvb', 'fate-spygames-2mb.rmvb', 'rm', ['rv20', 'ac3']],
    ['wtv', 'fate-law-and-order-partial.wtv', 'wtv', ['mpeg2video', 'mp2']],
  ] as const)('%s: a real sample keeps its container and the codecs the muxer carries', { timeout: TIMEOUT_MS }, async ([format, sample, container, codecs], ctx) => {
    const real = await requireRealworldSample(ctx, sample);
    const output = await rewrap(real.bytes, format);
    // QCELP (3GPP2) is written as AAC, Cook and RealVideo 4 (RealMedia) as AC-3 and RealVideo 2; every other stream is copied.
    expectRewritten(factsOf(output, format), container, codecs);
    expect(withMediaFile(output, format, (file) => decodeStatus(file))).toBe(0);
  });

  it('rm: the sound keeps its length (the transcode wrote AAC sound of no length) and the picture its frames', async (ctx) => {
    const real = await requireRealworldSample(ctx, 'fate-sipr_5k0.rm');
    const output = await rewrap(real.bytes, 'rm');
    const facts = factsOf(output, 'rm');
    expectRewritten(facts, 'rm', ['rv10', 'ac3']);
    expectSameLength(factsOf(real.bytes, 'rm'), facts);
    // Every stream of the output decodes to its full length: RealVideo 1.0 packets carry their own times (77 frames over 19 s), and AC-3 is not cut short.
    expect(withMediaFile(output, 'rm', (file) => decodeStatus(file))).toBe(0);
    expect(withMediaFile(output, 'rm', (file) => {
      const probed = probeFile(ffprobe(), file);
      return probed.streams.map((stream) => Math.round(Number((stream as { duration?: string }).duration ?? 0)));
    })).toEqual([19, 20]);
  }, TIMEOUT_MS);

  it('a request that asks for another sound is not a rewrap and keeps its earlier answer', async () => {
    const source = mobile();
    const failure = await convertFile(source, '3gpp', '3gpp', { audioVolume: 50 }, 'sample.3gpp').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect((failure as Error).message).toBe('Native FFmpeg transcoding failed for 3gpp -> 3gpp: the target container has no FFmpeg muxer.');
  }, TIMEOUT_MS);
});

describe('which streams a rewrap copies', () => {
  const stream = (type: InputStream['type'], codecName: string): InputStream => ({ index: 0, type, codecName, attachedPicture: false, rotation: 0 });

  it('copies a stream the muxer carries and writes another codec for one it does not', () => {
    const container = rewrapContainerFor('3g2', '3g2', {});
    expect(container).toBeDefined();
    expect(rewrapStreamArgs(container!, [stream('video', 'mpeg4'), stream('audio', 'aac')])).toEqual(['-map', '0:v:0?', '-map', '0:a:0?', '-c:v', 'copy', '-c:a', 'copy']);
    expect(rewrapStreamArgs(container!, [stream('video', 'mpeg4'), stream('audio', 'qcelp')])).toEqual(['-map', '0:v:0?', '-map', '0:a:0?', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k']);
  });

  it('writes RealMedia pictures and sound again with the codecs the muxer writes', () => {
    const container = rewrapContainerFor('rmvb', 'rmvb', {})!;
    expect(rewrapStreamArgs(container, [stream('video', 'rv40'), stream('audio', 'cook')])).toEqual(['-map', '0:v:0?', '-map', '0:a:0?', '-c:v', 'rv20', '-c:a', 'ac3', '-b:a', '192k']);
    // The muxer copies no RealMedia stream usably: RealVideo 1.0 and SIPR are written again too.
    expect(rewrapStreamArgs(container, [stream('video', 'rv10'), stream('audio', 'sipr')])).toEqual(['-map', '0:v:0?', '-map', '0:a:0?', '-c:v', 'rv20', '-c:a', 'ac3', '-b:a', '192k']);
    expect(rewrapStreamArgs(rewrapContainerFor('rm', 'rm', {})!, [stream('video', 'rv10'), stream('audio', 'sipr')])).toEqual(['-map', '0:v:0?', '-map', '0:a:0?', '-c:v', 'rv10', '-c:a', 'ac3', '-b:a', '192k']);
  });

  it('maps no picture for an audio-only container', () => {
    expect(rewrapStreamArgs(rewrapContainerFor('amr', 'amr', {})!, [stream('audio', 'amr_nb')])).toEqual(['-map', '0:a:0', '-c:a', 'copy']);
  });

  it('applies only to the same format and to a request that keeps the streams', () => {
    expect(rewrapContainerFor('mp4', '3gpp', {})).toBeUndefined();
    expect(rewrapContainerFor('3gpp', '3gpp', { audioBitrate: '64k' })).toBeUndefined();
    expect(rewrapContainerFor('3gpp', '3gpp', { trim: { start: 1 } })).toBeDefined();
    expect(rewrapContainerFor('mp4', 'mp4', {})).toBeUndefined();
  });
});

describe('the DSS pair is withdrawn', () => {
  it('lists no target for a DSS recording that FFmpeg has no muxer to write', () => {
    expect(FORMAT_REGISTRY.dss.targetFormats).toEqual(['aac', 'aiff', 'flac', 'm4a', 'mp3', 'wav', 'wma']);
  });
});
