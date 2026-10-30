import { UnprocessableMediaInputError, UnsupportedMediaCodecError } from '../types';
import { type MediaInput, runFfprobe } from './media-process';

/**
 * What a decoder says when it cannot decode a stream, turned into an error that names the stream or the codec. FFmpeg's own
 * log is the only report of these conditions: a build without a coding tool makes ffprobe fail with no output (6.1) or makes
 * ffmpeg exit with status 0 after writing a fraction of the stream (7.1), and a stream of damaged packets makes it stop with
 * a page of messages. Nothing here changes what is converted; it classifies the conversions that cannot succeed.
 */

/** AAC audio object types FFmpeg names in its error, by the name people know the codec under. */
const AAC_OBJECT_TYPE_NAMES: Readonly<Record<number, string>> = { 42: 'xHE-AAC (USAC)' };

/** `Audio object type 42 is not implemented`: FFmpeg 6.1 stops at the first xHE-AAC packet it is asked to open. */
const OBJECT_TYPE_NOT_IMPLEMENTED = /Audio object type (\d{1,6}) is not implemented/;
/** `[dec:aac @ 0x...] Error submitting packet to decoder: Not yet implemented in FFmpeg`: FFmpeg 7.1 skips the packets of an xHE-AAC stream whose coding tools it lacks. */
const DECODER_NOT_IMPLEMENTED = /\[dec:(\w{1,32})[^\]\n]{0,64}\] Error (?:submitting|processing) packet(?: in| to) decoder: Not yet implemented in FFmpeg/;
/** `[aist#0:1/aac @ 0x...] Decode error rate 1 exceeds maximum 0.666667`: ffmpeg gives up on a stream of which most packets are invalid. */
const DECODE_ERROR_RATE = /\[(a|v)ist#\d{1,6}:(\d{1,6})\/(\w{1,32}) @[^\]\n]{0,64}\](?: \[dec:[^\]\n]{0,64}\])? Decode error rate [\d.]{1,32} exceeds maximum/;
/*
 * The log echoes the input's metadata tags, which the uploader writes. Every quantifier above stays within one line and has
 * an upper bound, so a tag of repeated pattern starts costs linear time instead of a rescan to the end of the log per start.
 */
const FFMPEG_VERSION = /^ff(?:mpeg|probe) version (\S+)/m;
const KIND_NAMES: Readonly<Record<string, string>> = { a: 'audio', v: 'video' };

const DIAGNOSIS_TIMEOUT_MS = 10_000;
const DIAGNOSIS_MAX_BYTES = 256 * 1024;

function buildName(log: string): string {
  const version = FFMPEG_VERSION.exec(log)?.[1];
  return version === undefined ? 'The installed FFmpeg' : `FFmpeg ${version}`;
}

/**
 * The refusal for a run whose decoder skipped packets for a coding tool FFmpeg lacks, so that its output holds only a part of
 * the stream; undefined when the log shows no such thing.
 */
export function partialDecodeIn(log: string): UnsupportedMediaCodecError | undefined {
  const decoder = DECODER_NOT_IMPLEMENTED.exec(log)?.[1];
  if (decoder === undefined) return undefined;
  return new UnsupportedMediaCodecError(
    decoder,
    `${buildName(log)} cannot decode this stream completely: its ${decoder} decoder does not implement a coding tool the stream uses (xHE-AAC is the usual case), so it would write only a part of the stream; a newer FFmpeg build is needed.`
  );
}

/**
 * The refusal for a stream whose codec FFmpeg cannot open, or whose decoder lacks a coding tool of it; undefined when the log
 * shows neither. The first is only a statement about a stream that was opened, so it belongs to a failed run or a failed probe.
 */
export function unsupportedCodecIn(log: string): UnsupportedMediaCodecError | undefined {
  const objectType = OBJECT_TYPE_NOT_IMPLEMENTED.exec(log);
  if (objectType === null) return partialDecodeIn(log);
  const number = Number(objectType[1]);
  const name = AAC_OBJECT_TYPE_NAMES[number] ?? `AAC audio object type ${number}`;
  return new UnsupportedMediaCodecError(
    name,
    `The audio stream is ${name}, which the installed FFmpeg cannot decode (it does not implement AAC audio object type ${number}); a build with a decoder for it is needed.`
  );
}

/** The refusal for a stream of which ffmpeg could decode too few packets to continue; undefined when the log shows no such thing. */
export function undecodableStreamIn(log: string): UnprocessableMediaInputError | undefined {
  const match = DECODE_ERROR_RATE.exec(log);
  if (match === null) return undefined;
  const [, kind, index, codec] = match;
  return new UnprocessableMediaInputError(
    `The ${KIND_NAMES[kind]} stream #${index} (${codec}) cannot be decoded: nearly every packet of it is invalid, so the data is damaged or is not ${codec}.`
  );
}

/** The typed error a failed ffmpeg run's log explains, or undefined when it explains none. */
export function explainFfmpegFailure(log: string): UnprocessableMediaInputError | undefined {
  return unsupportedCodecIn(log) ?? undecodableStreamIn(log);
}

/**
 * Why ffprobe could not open `filePath`, when the reason is a codec the build lacks. ffprobe prints that reason only at the
 * warning level, below the level the probes run at, so it is asked again here with a bounded log; undefined when the file
 * fails for any other reason.
 */
export function explainProbeFailure(ffprobe: string, input: MediaInput): UnsupportedMediaCodecError | undefined {
  const run = runFfprobe(ffprobe, ['-v', 'warning', '-show_entries', 'stream=index', '-of', 'csv'], input, {
    timeoutMs: DIAGNOSIS_TIMEOUT_MS,
    maxBuffer: DIAGNOSIS_MAX_BYTES,
  });
  return unsupportedCodecIn(run.stderr);
}
