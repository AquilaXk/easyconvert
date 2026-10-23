import type { ConversionOptions } from '../types';
import { probeFfmpegBuild } from './media-audio-quality';
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
 * Arguments that put the samples through a resampler, a mixer or a filter. Those keep the default packets: the dither
 * of a 16-bit reduction, soxr and swresample resampling and `loudnorm` carry state from one chunk to the next, so the same
 * file in other chunks decodes to other (equally correct) samples. A conversion without them is a change of container and
 * codec, and the encoders write the same bytes whatever the packet size.
 */
const CHUNK_SENSITIVE_AUDIO_ARGS: ReadonlySet<string> = new Set(['-filter:a', '-af', '-ar', '-ac']);

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
export function wavPacketSizeKeepsOutput(version: { major: number; minor: number } | undefined): boolean {
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

/**
 * Puts the packet size ahead of the input, unless the conversion keeps the default packets: a trimmed file (a cut at `-to` falls on
 * a packet boundary, the side effect the upstream commit names), a conversion that resamples, mixes or filters, a build whose
 * output the option would change, and an input the header does not describe.
 */
export function addWavPacketSize(
  inputArgs: string[],
  wav: WavPcmInfo | null,
  options: ConversionOptions,
  outputArgs: readonly string[],
  ffmpegBin: string | null | undefined
): void {
  if (wav === null || !ffmpegBin || options.trim?.start || options.trim?.end) return;
  if (outputArgs.some((arg) => CHUNK_SENSITIVE_AUDIO_ARGS.has(arg))) return;
  if (!wavPacketSizeKeepsOutput(probeFfmpegBuild(ffmpegBin).version)) return;
  const bytes = wavPacketBytes(wav.dataBytes);
  if (bytes !== undefined) inputArgs.splice(inputArgs.indexOf('-i'), 0, '-max_size', String(bytes));
}
