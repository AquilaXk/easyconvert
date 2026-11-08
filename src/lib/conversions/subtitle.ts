import { ConversionFailedError, EngineUnavailableError, InvalidSubtitleInputError, PayloadLimitError } from '../types';
import {
  countSubtitleCues,
  hasNonTextControl,
  hasSubtitleHeader,
  isSubtitleFormat,
  subtitleTextOfBytes,
  type SubtitleFormat,
} from '../subtitle-structure';
import { HEADER_WINDOW_BYTES } from '../format-signatures';
import { reportConversionWarning } from './conversion-warnings';
import { decodeTextInput } from './text-input';

/**
 * Subtitle conversions (docs/policy-decisions.md, entry 188): SubRip, WebVTT, Advanced SubStation Alpha, SubStation Alpha and
 * MicroDVD files are read and written by FFmpeg in the sandbox the media path uses. What is decided here is what FFmpeg is
 * given: a text file of the format it is named after, in UTF-8, of the size a subtitle file has, with at least one cue.
 * FFmpeg's own readers take almost any bytes for some format (a MicroDVD file read as SubRip is an empty subtitle track,
 * a file in a legacy code page is an error of the decoder), so the check is ours and typed.
 */

/** The most bytes of a subtitle file: a feature film's SubRip is about 100 KB, and an ASS file with embedded fonts a few megabytes. */
export const MAX_SUBTITLE_BYTES = 10 * 1024 * 1024;

/** FFmpeg's demuxer for each source format; ssa and ass are one reader that follows the file's own `[V4 Styles]` or `[V4+ Styles]` header. */
const SOURCE_DEMUXERS: Readonly<Record<SubtitleFormat, string>> = { srt: 'srt', vtt: 'webvtt', ass: 'ass', ssa: 'ass', sub: 'microdvd' };

export interface SubtitleWriter {
  /** The muxer and the subtitle encoder FFmpeg writes the target with. */
  muxer: string;
  codec: string;
}

/** The formats FFmpeg writes. MicroDVD needs a frame rate that a file of another format does not have, and SSA is written as ASS, so neither is a target. */
const TARGET_WRITERS: Readonly<Record<string, SubtitleWriter>> = {
  srt: { muxer: 'srt', codec: 'srt' },
  vtt: { muxer: 'webvtt', codec: 'webvtt' },
  ass: { muxer: 'ass', codec: 'ass' },
};

export function subtitleWriterOf(target: string): SubtitleWriter | undefined {
  return Object.hasOwn(TARGET_WRITERS, target) ? TARGET_WRITERS[target] : undefined;
}

export function subtitleDemuxerOf(source: SubtitleFormat): string {
  return SOURCE_DEMUXERS[source];
}

/** Whether the pair is a subtitle conversion this module serves: a subtitle source and a target FFmpeg writes. */
export function isSubtitlePair(source: string, target: string): boolean {
  return isSubtitleFormat(source) && subtitleWriterOf(target) !== undefined && source !== target;
}

/** The in-process engine has no reader or writer of subtitles: FFmpeg's pairs fail here, naming the engine, rather than converting nothing. */
export function assertNotSubtitlePair(sourceFormat: string, targetFormat: string): void {
  const source = sourceFormat.toLowerCase().replace(/^\./, '').trim();
  const target = targetFormat.toLowerCase().replace(/^\./, '').trim();
  if (isSubtitlePair(source, target)) {
    throw new EngineUnavailableError('ffmpeg', `Converting .${source} subtitles to .${target} needs the native FFmpeg engine; the in-process engine has no reader or writer for them.`);
  }
}

/**
 * What FFmpeg is asked to read at most. The largest real subtitle files have a few thousand cues (a film's SubRip about 1,500 to
 * 3,000, a typeset ASS file with karaoke effects up to some tens of thousands), so these limits are far above any real file and
 * only stop a crafted one: the time FFmpeg takes, and the size of what it writes, grow with the cues and with the line breaks
 * (an ASS file of 2 MB made of `\N` takes it 15 s).
 */
export const MAX_SUBTITLE_CUES = 100_000;
/** Line breaks written inside cue text: the `\\N` and `\\n` of SubStation Alpha and the `|` of MicroDVD. */
export const MAX_SUBTITLE_LINE_BREAKS = 100_000;
/** Lines of the file: 100,000 cues of four lines each is 400,000. */
export const MAX_SUBTITLE_LINES = 500_000;
/** Characters of one line: a cue line of a film has under 100, a karaoke or drawing line of typeset ASS a few thousand. FFmpeg took over 2 minutes on a line of 3,000,000 characters that followed many line breaks. */
export const MAX_SUBTITLE_LINE_CHARS = 20_000;
/** The largest frame number of a MicroDVD file: about 11 days at 100 frames per second, and well inside what FFmpeg reads as an integer. */
const MAX_MICRODVD_FRAME = 100_000_000;

/** The frame rate FFmpeg assumes for a MicroDVD file that sets none (`{1}{1}25.000` or `{0}{}25.000` on its first line). */
const MICRODVD_DEFAULT_FPS = 23.976;
const MICRODVD_RATE_LINE = /^\s*\{[01]\}\{[01]?\}\s*(\d+(?:\.\d+)?)/;
/** `[^]*` and not `.*`: a line of a CRLF file still holds its `\r`, which `.` does not match. */
const MICRODVD_OPEN_CUE = /^(\s*\{(\d+)\})\{\}([^]*)$/;
const MICRODVD_FRAMES = /^\s*\{(\d+)\}\{(\d*)\}/;
/** How long the last MicroDVD cue lasts when the file names no end for it, in seconds. */
export const MICRODVD_OPEN_CUE_SECONDS = 5;

function refusal(reason: string, message: string): InvalidSubtitleInputError {
  return new InvalidSubtitleInputError(reason, message);
}

const NOT_TEXT = 'not-text';

function assertHeadIsText(input: Buffer, source: SubtitleFormat): void {
  if (hasNonTextControl(subtitleTextOfBytes(input.subarray(0, HEADER_WINDOW_BYTES)))) {
    throw refusal(NOT_TEXT, `The file is not a .${source} subtitle file: it holds binary data, and subtitle files are text.`);
  }
}

/** The text of the file in Unicode: Unicode as its byte order mark or valid UTF-8 says, a legacy code page as the text reader detects it (and says so in the warnings). */
function decodeSubtitleBytes(input: Buffer, source: SubtitleFormat): string {
  try {
    return decodeTextInput(input).replace(/^﻿/, '');
  } catch (error) {
    if (!(error instanceof ConversionFailedError)) throw error;
    throw refusal(NOT_TEXT, `The file is not a readable .${source} subtitle file: ${error.message}`);
  }
}

/**
 * A MicroDVD cue that names no end lasts until the next cue starts, which FFmpeg works out; the last cue has no next one, and
 * FFmpeg then writes no cue (SubRip) or an end of 1193 hours (WebVTT and ASS). Each such cue is given MICRODVD_OPEN_CUE_SECONDS.
 */
function closeOpenMicroDvdCues(text: string): { text: string; closed: number } {
  const all = text.split('\n');
  let last = -1;
  let rate: number | undefined;
  for (const line of all) {
    const rateLine = MICRODVD_RATE_LINE.exec(line);
    if (rateLine !== null) {
      rate ??= Number(rateLine[1]);
      continue;
    }
    const frames = MICRODVD_FRAMES.exec(line);
    if (frames === null) continue;
    if (Number(frames[1]) > MAX_MICRODVD_FRAME || Number(frames[2]) > MAX_MICRODVD_FRAME) {
      throw refusal('wrong-structure', `A frame number of the MicroDVD file is above ${MAX_MICRODVD_FRAME}.`);
    }
    last = Math.max(last, Number(frames[1]));
  }
  const frames = Math.round((rate ?? MICRODVD_DEFAULT_FPS) * MICRODVD_OPEN_CUE_SECONDS);
  let closed = 0;
  const rewritten = all.map((line) => {
    const open = MICRODVD_OPEN_CUE.exec(line);
    if (open === null || MICRODVD_RATE_LINE.test(line) || Number(open[2]) !== last) return line;
    closed++;
    return `${open[1]}{${last + frames}}${open[3]}`;
  });
  return { text: rewritten.join('\n'), closed };
}

/** How many line breaks the cue text holds: the `\N` and `\n` of SubStation Alpha text and the `|` of MicroDVD. */
function countTextLineBreaks(text: string, source: SubtitleFormat): number {
  if (source === 'ass' || source === 'ssa') return text.match(/\\[Nn]/g)?.length ?? 0;
  return source === 'sub' ? (text.match(/\|/g)?.length ?? 0) : 0;
}

export interface PreparedSubtitle {
  /** The file as UTF-8 text without a byte order mark, which is what FFmpeg reads. */
  utf8: Buffer;
  cues: number;
}

/**
 * Checks a subtitle upload and returns it as UTF-8. Refuses, with `InvalidSubtitleInputError`, a file that is not text, whose
 * text does not open like the format it is named after, or that holds no cue; refuses with `PayloadLimitError` a file over
 * MAX_SUBTITLE_BYTES. Reports through the conversion's warnings the code page of a file that was not Unicode and the frame
 * rate assumed for a MicroDVD file.
 */
export function prepareSubtitleInput(input: Buffer, source: SubtitleFormat): PreparedSubtitle {
  if (input.length > MAX_SUBTITLE_BYTES) {
    throw new PayloadLimitError(`A .${source} subtitle file is at most ${MAX_SUBTITLE_BYTES} bytes; this one has ${input.length}.`);
  }
  assertHeadIsText(input, source);
  const text = decodeSubtitleBytes(input, source);
  if (hasNonTextControl(text)) {
    throw refusal(NOT_TEXT, `The file is not a .${source} subtitle file: it holds control characters that text does not use.`);
  }
  if (!hasSubtitleHeader(source, text)) {
    throw refusal('wrong-structure', `The file does not read as a .${source} subtitle file: ${expectedStructure(source)}.`);
  }
  const cues = countSubtitleCues(source, text);
  if (cues > MAX_SUBTITLE_CUES) throw new PayloadLimitError(`A .${source} subtitle file holds at most ${MAX_SUBTITLE_CUES} cues; this one has ${cues}.`);
  const lines = text.split('\n');
  if (lines.length > MAX_SUBTITLE_LINES) throw new PayloadLimitError(`A .${source} subtitle file holds at most ${MAX_SUBTITLE_LINES} lines; this one has ${lines.length}.`);
  const longest = lines.reduce((most, line) => Math.max(most, line.length), 0);
  if (longest > MAX_SUBTITLE_LINE_CHARS) throw new PayloadLimitError(`A line of a .${source} subtitle file has at most ${MAX_SUBTITLE_LINE_CHARS} characters; this file has one of ${longest}.`);
  const lineBreaks = countTextLineBreaks(text, source);
  if (lineBreaks > MAX_SUBTITLE_LINE_BREAKS) {
    throw new PayloadLimitError(`A .${source} subtitle file holds at most ${MAX_SUBTITLE_LINE_BREAKS} line breaks inside its cues; this one has ${lineBreaks}.`);
  }
  if (cues === 0) throw refusal('no-cues', `The .${source} subtitle file holds no cue, so there is nothing to convert.`);
  if (source === 'sub' && !MICRODVD_RATE_LINE.test(text)) {
    reportConversionWarning(`The MicroDVD file sets no frame rate; its frame numbers were read at ${MICRODVD_DEFAULT_FPS} frames per second.`);
  }
  if (source !== 'sub') return { utf8: Buffer.from(text, 'utf8'), cues };
  const { text: closedText, closed } = closeOpenMicroDvdCues(text);
  if (closed > 0) reportConversionWarning(`${closed} MicroDVD cue(s) named no end and last to the end of the file; each was given ${MICRODVD_OPEN_CUE_SECONDS} seconds.`);
  return { utf8: Buffer.from(closedText, 'utf8'), cues };
}

function expectedStructure(source: SubtitleFormat): string {
  switch (source) {
    case 'srt':
      return 'it has no `hh:mm:ss,mmm --> hh:mm:ss,mmm` timing line';
    case 'vtt':
      return 'it does not open with WEBVTT';
    case 'ass':
    case 'ssa':
      return 'it does not open with a [Script Info] section';
    case 'sub':
      return 'it does not open with a {start}{end} frame cue (VobSub .sub files are pictures and are not read)';
  }
}

/**
 * FFmpeg's arguments for one subtitle conversion: the first subtitle stream of `inputArgs` (built by `mediaInputArgs`, so the
 * demuxer is fixed and only local files open) is written to `outputPath` with the target's encoder and muxer. `-flags +bitexact`
 * (an input option: the decoder writes the ASS header) keeps the build's version out of it, so the same input gives the same bytes on every FFmpeg.
 */
export function subtitleFfmpegArguments(inputArgs: readonly string[], outputPath: string, target: string): string[] {
  const writer = subtitleWriterOf(target);
  if (writer === undefined) throw refusal('wrong-structure', `A subtitle file is not written as .${target}.`);
  return ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-flags', '+bitexact', ...inputArgs, '-map', '0:s:0', '-c:s', writer.codec, '-f', writer.muxer, outputPath];
}

const CUE_TIMING = /^\s*(?:\d+:)?\d{1,2}:\d{2}[.,]\d{3}[ \t]*-->/;
/** A timing line is short; only the start of a line is tested, so a line of a million characters costs no more than a short one. */
const TIMING_PREFIX_CHARS = 200;

function isTimingLine(line: string): boolean {
  return CUE_TIMING.test(line.slice(0, TIMING_PREFIX_CHARS));
}

/** For each line, the index of the first line from it on that holds something other than white space (the number of lines when none does). */
function nextNonBlankLines(all: readonly string[]): number[] {
  const next = new Array<number>(all.length + 1);
  next[all.length] = all.length;
  for (let at = all.length - 1; at >= 0; at--) next[at] = all[at].trim() === '' ? next[at + 1] : at;
  return next;
}

/** Whether the lines from `next` on are the end of a cue: the file ends, a timing line follows, or a cue identifier or number and then a timing line. */
function cueEndsAt(all: readonly string[], next: number): boolean {
  return next >= all.length || isTimingLine(all[next]) || (next + 1 < all.length && isTimingLine(all[next + 1]));
}

/**
 * `line` with each block in braces replaced by `replacement(inner)`, in one pass: the leftmost block that closes, as the pattern
 * `\{[^}]*\}` finds it, and with `allowBackslash` false the pattern `\{[^}\\]*\}`. A brace that closes nowhere ends the search, and
 * the position of the next closing brace and of the next backslash are kept between blocks, so a line of 200,000 open braces costs one pass.
 */
function replaceBraceBlocks(line: string, allowBackslash: boolean, replacement: (inner: string) => string): string {
  let out = '';
  let copied = 0;
  let from = 0;
  let close = -1;
  let backslash = -1;
  for (;;) {
    const open = line.indexOf('{', from);
    if (open < 0) break;
    if (close <= open) {
      close = line.indexOf('}', open + 1);
      if (close < 0) break;
    }
    if (!allowBackslash) {
      if (backslash <= open) {
        const found = line.indexOf('\\', open + 1);
        backslash = found < 0 ? line.length : found;
      }
      if (backslash < close) {
        from = backslash + 1;
        continue;
      }
    }
    out += line.slice(copied, open) + replacement(line.slice(open + 1, close));
    copied = close + 1;
    from = copied;
  }
  return out + line.slice(copied);
}

/** The columns of a `Dialogue:` line up to its text: the text is everything after the ninth comma (Layer, Start, End, Style, Name, three margins, Effect). */
const DIALOGUE_TEXT_COLUMN = 9;

/**
 * SubRip and MicroDVD text has braces of its own (`{braces}`), and FFmpeg copies them into the ASS text, where a block in braces
 * with no backslash is a comment that no player shows. A block that holds a backslash is an override (`{\an8}`) and stays;
 * the braces of any other block are escaped, so the words stay on the screen. WebVTT text is written escaped by FFmpeg already.
 */
function escapeCommentBlocks(text: string, source: string): string {
  if (source !== 'srt' && source !== 'sub') return text;
  return text
    .split('\n')
    .map((line) => {
      if (!line.startsWith('Dialogue:')) return line;
      const parts = line.split(',');
      const words = replaceBraceBlocks(parts.slice(DIALOGUE_TEXT_COLUMN).join(','), false, (inner) => `\\{${inner}}`);
      return [...parts.slice(0, DIALOGUE_TEXT_COLUMN), words].join(',');
    })
    .join('\n');
}

const SUBSTATION_SOURCES: ReadonlySet<string> = new Set(['ass', 'ssa']);
const LITERAL_BRACE_PLACEHOLDER = '\u0001';
const LITERAL_CLOSING_BRACE_PLACEHOLDER = '\u0002';

/**
 * Repairs what FFmpeg leaves wrong in the SubRip and WebVTT text it writes (the other targets are not touched):
 * - FFmpeg writes the text of a cue as it is left after its override blocks are removed, so a cue that opened with `{\an8}` and a
 *   line break starts with an empty line, and a line break twice is an empty line inside the text. In SubRip and WebVTT an empty
 *   line ends the cue: a player shows an empty cue and the words that follow are lost. The empty lines inside a cue are removed.
 * - A brace of the text is written as `\{{}` (`\{` and `\}` before FFmpeg 8), the escape of SubStation Alpha, where SubRip and WebVTT have `{`.
 * - From SubStation Alpha, the comments (`{words}`) and the override blocks FFmpeg does not translate (`{\2c&H5D8FC3&}`) come
 *   through as text; they are not text, and are removed.
 * - From WebVTT, `&nbsp;` comes through as `\h`, the hard space of SubStation Alpha; it is written as U+00A0.
 * - Into ASS (see `escapeCommentBlocks`), braces of SubRip and MicroDVD text that are not override blocks are escaped.
 */
export function repairSubtitleOutput(text: string, target: string, source: string): string {
  if (target === 'ass') return escapeCommentBlocks(text, source);
  if (target !== 'srt' && target !== 'vtt') return text;
  let body = text.replace(/\\\{\{\}/g, LITERAL_BRACE_PLACEHOLDER);
  if (SUBSTATION_SOURCES.has(source) || source === 'vtt') {
    // The escapes of a brace (`\{`, and `\}` in FFmpeg before 8) are kept by FFmpeg as they are; they are set aside before the blocks go.
    body = body.replace(/\\\{/g, LITERAL_BRACE_PLACEHOLDER).replace(/\\\}/g, LITERAL_CLOSING_BRACE_PLACEHOLDER);
  }
  if (SUBSTATION_SOURCES.has(source)) body = body.split('\n').map((line) => replaceBraceBlocks(line, true, () => '')).join('\n');
  if (source === 'vtt') body = body.replace(/\\h/g, '\u00A0');
  const all = body.replace(/\u0001/g, '{').replace(/\u0002/g, '}').split('\n');
  const next = nextNonBlankLines(all);
  const kept: string[] = [];
  let inCue = false;
  // A run of empty lines has one answer, found once for the run.
  let decidedFor = -1;
  let decidedEnds = false;
  for (let at = 0; at < all.length; at++) {
    const line = all[at];
    if (isTimingLine(line)) inCue = true;
    else if (inCue && line.trim() === '') {
      if (decidedFor !== next[at]) {
        decidedFor = next[at];
        decidedEnds = cueEndsAt(all, decidedFor);
      }
      if (!decidedEnds) continue;
      inCue = false;
    }
    kept.push(line);
  }
  return kept.join('\n');
}
