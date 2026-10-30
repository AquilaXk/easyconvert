import type { ConversionOptions } from '../types';
import { type FfmpegVersion, probeFfmpegBuild } from './media-process';
import { isAudioOnlyTarget } from './media-audio-targets';
import { readWavPcmInfo, type WavPcmInfo } from './wav-header';

/**
 * How ffmpeg is given a WAVE file that an audio conversion starts from: the header already states the audio format, so ffmpeg
 * needs no analysis of the stream, and the demuxer cuts the file into packets of a size that keeps ffmpeg's threads busy.
 */

/**
 * Bytes ffmpeg may read to analyse an input whose header already states its audio format (the smallest value it
 * accepts). Its default analysis reads and decodes up to 5 s of the file before the encoder starts; for an
 * uncompressed WAVE that only repeats what the header says, so it is skipped and the encoder sees the same samples.
 */
const HEADER_DESCRIBED_PROBE_BYTES = 32;

/**
 * Packets of a WAVE file. The default packet of ffmpeg's WAV demuxer is 4096 bytes (`max_size`, libavformat/wavdec.c line 76),
 * and ffmpeg 6.1 hands every packet over queues from its demuxer thread to the decoder, the filter graph and the encoder: twelve
 * seconds of 24-bit stereo are 776 packets and about 2,500 thread switches, a third of a 63 ms FLAC encode. FFmpeg 7.0 raised the
 * default to 100 ms of audio for this reason (commit 44b2769619, "demux bigger packets, which is more efficient"). Here a
 * file is cut into about 32 packets, between that default and 128 KiB: the time stops falling past 128 KiB, and a file of a few
 * packets loses the overlap of the four stages. The demuxer rounds the packet down to whole sample frames and declares the
 * option from 1024 to 1 << 22 bytes.
 */
const WAV_DEFAULT_PACKET_BYTES = 4096;
const WAV_MAX_PACKET_BYTES = 128 * 1024;
const WAV_MIN_PACKETS = 32;

/**
 * Arguments that mix or filter the samples. Those keep the default packets: a channel count (`-ac`) and any filter list that is
 * more than rate changes (`volume`, `loudnorm`, a dither or a format filter) are not shown to leave the samples as they are
 * when the same file reaches them in other chunks.
 */
const CHUNK_SENSITIVE_AUDIO_ARGS: ReadonlySet<string> = new Set(['-af', '-ac']);
/** The one filter a rate change adds: swresample's resampler or soxr, with no dither and no format. */
const RATE_CHANGE_FILTER = /^aresample=\d+(?::resampler=soxr:precision=\d+)?$/;
/**
 * Encoders that take planar float and nothing else (libavcodec/aacenc.c line 1444, libvorbisenc.c line 388): the resampler's
 * output is handed over as it is, whatever the depth of the source.
 */
const FLOAT_ONLY_ENCODERS: ReadonlySet<string> = new Set(['aac', 'libvorbis']);
/**
 * Encoders that take 16-bit samples and deeper ones (libopusenc.c line 594, libmp3lame.c line 350, flacenc.c line 1763). FFmpeg
 * gives such an encoder samples of the source's own width or the nearest deeper one (`get_fmt_score` charges 100 a byte for
 * fewer bytes and 10 for more, `find_best_sample_fmt_of_2`, libavfilter/avfiltergraph.c lines 566 to 599), so a source deeper
 * than 16 bits never meets the 16-bit conversion.
 */
const DEEP_SAMPLE_ENCODERS: ReadonlySet<string> = new Set(['libopus', 'libmp3lame', 'flac']);
const SIXTEEN_BITS = 16;

/** The `max_size` for a WAVE file of `dataBytes` of samples, or undefined when the demuxer's own packet is already that size. */
export function wavPacketBytes(dataBytes: number): number | undefined {
  const bytes = Math.min(WAV_MAX_PACKET_BYTES, Math.floor(dataBytes / WAV_MIN_PACKETS));
  return bytes > WAV_DEFAULT_PACKET_BYTES ? bytes : undefined;
}

/**
 * Whether `-max_size` leaves the output as it was. The WAV demuxer has the option from FFmpeg 4.4 (n4.0 has none). From the
 * development branch after 8.0 (so 8.1 and 9.x) the command line tool gives an encoder without a frame size the length of the
 * first frame it receives (fftools/ffmpeg_enc.c, `enc_ctx->frame_size = frame->nb_samples`), which the FLAC encoder takes as
 * its block size: the packet size then sets the block size of the file. A development build and a release outside the range
 * keep the default packets.
 */
export function wavPacketSizeKeepsOutput(version: FfmpegVersion | undefined): boolean {
  if (version === undefined) return false;
  const { major, minor } = version;
  return (major === 4 && minor >= 4) || (major >= 5 && major <= 7) || (major === 8 && minor === 0);
}

/**
 * The header facts of a WAVE input of an audio target, or null when the target is not audio or the header cannot describe the
 * samples. Adds the minimal analysis to the input arguments in the first case.
 */
export function readWavInputFacts(tgt: string, inputPath: string, inputArgs: string[]): WavPcmInfo | null {
  const wav = isAudioOnlyTarget(tgt) ? readWavPcmInfo(inputPath) : null;
  if (wav !== null) inputArgs.push('-probesize', String(HEADER_DESCRIBED_PROBE_BYTES));
  return wav;
}

function outputArgValue(outputArgs: readonly string[], flag: string): string | undefined {
  const at = outputArgs.indexOf(flag);
  return at === -1 ? undefined : outputArgs[at + 1];
}

/**
 * Whether the output arguments leave the samples the same when the file arrives in other packets. A rate change does (swresample
 * and soxr keep their filter position and history in the stream, not in the chunk: libswresample/resample.c `multiple_resample`,
 * soxr's `stage_process` in src/cr.c), with one exception. FFmpeg's aarch64 converter from planar float to 16 bits rounds the
 * first `len & ~15` samples of a call with `fcvtzs`/`sqrshrn` and the rest with `lrintf` (libswresample/audioconvert.c lines
 * 221 to 250, aarch64/audio_convert_neon.S line 25), so a rate change that ends in 16-bit samples decodes to other samples (by
 * one step) with other packets. The output stays out of 16 bits for an encoder that takes float only, and for one that takes
 * deeper samples when the source is deeper than 16 bits.
 */
function packetSizeKeepsSamples(outputArgs: readonly string[], wav: WavPcmInfo): boolean {
  if (outputArgs.some((arg) => CHUNK_SENSITIVE_AUDIO_ARGS.has(arg))) return false;
  const filterList = outputArgValue(outputArgs, '-filter:a');
  const filters = filterList === undefined ? [] : filterList.split(',');
  if (!filters.every((filter) => RATE_CHANGE_FILTER.test(filter))) return false;
  if (!outputArgs.includes('-ar') && filters.length === 0) return true;
  const encoder = outputArgValue(outputArgs, '-c:a') ?? '';
  return FLOAT_ONLY_ENCODERS.has(encoder) || (DEEP_SAMPLE_ENCODERS.has(encoder) && wav.bitsPerSample > SIXTEEN_BITS);
}

/**
 * Puts the packet size ahead of the input, unless the conversion keeps the default packets: a trimmed file (a cut at `-to` falls on
 * a packet boundary, the side effect the upstream commit names), a conversion that mixes, filters or changes the rate into 16-bit
 * samples, a build whose output the option would change, and an input the header does not describe.
 */
export function addWavPacketSize(
  inputArgs: string[],
  wav: WavPcmInfo | null,
  options: ConversionOptions,
  outputArgs: readonly string[],
  ffmpegBin: string | null | undefined
): void {
  if (wav === null || !ffmpegBin || options.trim?.start || options.trim?.end) return;
  if (!packetSizeKeepsSamples(outputArgs, wav)) return;
  if (!wavPacketSizeKeepsOutput(probeFfmpegBuild(ffmpegBin).version)) return;
  const bytes = wavPacketBytes(wav.dataBytes);
  if (bytes !== undefined) inputArgs.splice(inputArgs.indexOf('-i'), 0, '-max_size', String(bytes));
}
