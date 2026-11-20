import type { ConversionOptions } from '../types';
import { resolveOutputDuration } from './media-ffmpeg-container-args';
import { probeInputStreams, resolveFfprobeBinary, type InputStream } from './media-ffprobe';
import { mediaInputArgs, type MediaInput } from './media-process';

/**
 * Same-format pairs of containers FFmpeg has no ready encoder settings for: the file is written again into its own
 * container, which is what the options of these pairs allow (`video_codec` is `copy` only). Writing them as a
 * transcode failed twice over: an extension that is not a muxer name (`.3gpp`, `.dvr`, `.mod`, `.rmvb`) leaves
 * FFmpeg without an output format, and the AAC audio the transcode picks is refused by the MPEG program stream and
 * Ogg muxers. The muxer is named here, and each stream is copied when the muxer carries its codec and written with the
 * codec the muxer does carry where it cannot (QCELP in 3GPP2, Cook in RealMedia).
 */
interface RewrapContainer {
  /** The FFmpeg muxer that writes the container (`-f`). */
  muxer: string;
  /** The container holds sound only, so no picture is mapped. */
  audioOnly?: boolean;
  /** Codecs the muxer carries as they are; absent when the container carries whatever it was read with. */
  carriedAudio?: ReadonlySet<string>;
  carriedVideo?: ReadonlySet<string>;
  /** Encoder arguments for a stream the muxer cannot carry as it is. */
  audioFallback?: readonly string[];
  videoFallback?: readonly string[];
}

/** The mov family muxers tag only these audio codecs; others (QCELP, EVRC) are written as AAC. */
const MOBILE_CONTAINER = {
  carriedAudio: new Set(['aac', 'amr_nb', 'amr_wb']),
  audioFallback: ['-c:a', 'aac', '-b:a', '192k'],
} as const;

/** The audio codecs the MPEG program stream muxer writes (libavformat/mpegenc.c). */
const MPEG_PROGRAM_STREAM = {
  muxer: 'mpeg',
  carriedAudio: new Set(['mp1', 'mp2', 'mp3', 'pcm_dvd', 'pcm_s16be', 'ac3', 'dts']),
  audioFallback: ['-c:a', 'mp2', '-b:a', '192k'],
} as const;

const REWRAP_CONTAINERS: ReadonlyMap<string, RewrapContainer> = new Map<string, RewrapContainer>([
  ['3g2', { muxer: '3g2', ...MOBILE_CONTAINER }],
  ['3gpp', { muxer: '3gp', ...MOBILE_CONTAINER }],
  // A Windows Media Center recording is an ASF file.
  ['dvr', { muxer: 'asf' }],
  // A camcorder MOD file is an MPEG program stream.
  ['mod', MPEG_PROGRAM_STREAM],
  ['mpeg', MPEG_PROGRAM_STREAM],
  ['mpg', MPEG_PROGRAM_STREAM],
  ['ogv', { muxer: 'ogv', carriedAudio: new Set(['vorbis', 'opus', 'flac', 'speex']), audioFallback: ['-c:a', 'libvorbis', '-q:a', '4'] }],
  // The RealMedia muxer writes both extensions, but carries only RealVideo 1.0 and 2.0 and a few sound codecs
  // (rmenc.c); Cook and RealVideo 3 and 4, which RealMedia files hold, are written as RealVideo 2.0 and AC-3.
  [
    'rmvb',
    {
      muxer: 'rm',
      carriedVideo: new Set(['rv10', 'rv20']),
      carriedAudio: new Set(['ac3', 'sipr', 'ra_144', 'ra_288']),
      videoFallback: ['-c:v', 'rv20'],
      audioFallback: ['-c:a', 'ac3', '-b:a', '192k'],
    },
  ],
  // The AMR encoder is not in every build; the narrowband stream itself is copied.
  ['amr', { muxer: 'amr', audioOnly: true }],
]);

/** Options that ask for a different picture or sound than the one the file holds; a pair carrying one is not a rewrap. */
const REENCODE_OPTIONS = [
  'audio', 'audioBitrate', 'audioChannels', 'audioSampleRate', 'audioVolume',
  'video', 'videoResolution', 'videoFps', 'videoCodec', 'videoBitrate', 'aspectRatio', 'subtitles', 'packaging',
] as const satisfies ReadonlyArray<keyof ConversionOptions>;

/** The container to write when the pair is a same-format rewrap of one of these containers, else undefined. */
export function rewrapContainerFor(source: string, target: string, options: ConversionOptions): RewrapContainer | undefined {
  if (source !== target || REENCODE_OPTIONS.some((name) => options[name] !== undefined)) return undefined;
  return REWRAP_CONTAINERS.get(target);
}

function codecArgs(stream: InputStream | undefined, carried: ReadonlySet<string> | undefined, fallback: readonly string[] | undefined, copy: readonly string[]): readonly string[] {
  const keeps = stream === undefined || carried === undefined || fallback === undefined || carried.has(stream.codecName);
  return keeps ? copy : fallback;
}

/** `-map` and codec arguments: the first picture and the first sound of the input. */
export function rewrapStreamArgs(container: RewrapContainer, streams: readonly InputStream[]): string[] {
  const audio = streams.find((stream) => stream.type === 'audio');
  const audioArgs = codecArgs(audio, container.carriedAudio, container.audioFallback, ['-c:a', 'copy']);
  if (container.audioOnly) return ['-map', '0:a:0', ...audioArgs];
  const video = streams.find((stream) => stream.type === 'video' && !stream.attachedPicture);
  const videoArgs = codecArgs(video, container.carriedVideo, container.videoFallback, ['-c:v', 'copy']);
  return ['-map', '0:v:0?', '-map', '0:a:0?', ...videoArgs, ...audioArgs];
}

/** What a rewrap reads of the argument build: the request and the three argument lists it fills. */
interface RewrapContext {
  input: MediaInput;
  tgt: string;
  options: ConversionOptions;
  ffmpegBin?: string | null;
  globalArgs: string[];
  inputArgs: string[];
  outputArgs: string[];
}

/**
 * The arguments that write a same-format file again into its own container (see above), or undefined when the pair is not such a
 * rewrap. `addTrimInputArgs` adds the trim of the request to the input arguments.
 */
export async function rewrapArguments(ctx: RewrapContext, outputPath: string, addTrimInputArgs: (ctx: RewrapContext) => void): Promise<string[] | undefined> {
  const { input, tgt, options, ffmpegBin, globalArgs, inputArgs, outputArgs } = ctx;
  const container = rewrapContainerFor(input.format, tgt, options);
  if (container === undefined) return undefined;
  addTrimInputArgs(ctx);
  inputArgs.push(...mediaInputArgs(input));
  const outputDuration = await resolveOutputDuration(options, input, ffmpegBin);
  if (outputDuration !== undefined) outputArgs.push('-t', String(outputDuration));
  const streams = await probeInputStreams(input, resolveFfprobeBinary(ffmpegBin), options.signal);
  outputArgs.push(...rewrapStreamArgs(container, streams), '-f', container.muxer);
  return [...globalArgs, ...inputArgs, ...outputArgs, outputPath];
}
