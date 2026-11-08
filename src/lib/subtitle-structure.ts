/**
 * The structure of the five subtitle text formats (SubRip, WebVTT, Advanced SubStation Alpha, SubStation Alpha and MicroDVD),
 * as far as the upload check and the conversion need it: whether a text is one of them, and how many cues it holds. It has no
 * dependency, because the registry (which the browser components import) uses it to tell a subtitle file from other bytes.
 *
 * The rules come from the format descriptions: SubRip is a timing line `hh:mm:ss,mmm --> hh:mm:ss,mmm` per cue; WebVTT opens
 * with `WEBVTT` and writes `(hh:)mm:ss.mmm --> (hh:)mm:ss.mmm` (W3C WebVTT, 4.1 and 4.3); SubStation Alpha files open with the
 * `[Script Info]` section and keep their cues in `Dialogue:` lines of `[Events]`; MicroDVD writes each cue as `{start}{end}text`
 * in frames.
 */

export type SubtitleFormat = 'srt' | 'vtt' | 'ass' | 'ssa' | 'sub';

export const SUBTITLE_FORMATS: readonly SubtitleFormat[] = ['srt', 'vtt', 'ass', 'ssa', 'sub'];

export function isSubtitleFormat(format: string): format is SubtitleFormat {
  return (SUBTITLE_FORMATS as readonly string[]).includes(format);
}

const UTF16LE_BOM = [0xff, 0xfe] as const;
const UTF16BE_BOM = [0xfe, 0xff] as const;
const UTF8_BOM_CHARACTER = '﻿';
/** The C0 controls and DEL that text never holds, as libmagic's `text_chars` table has it (BEL to SI, SUB and ESC are allowed). */
const NON_TEXT_CONTROL = /[\u0000-\u0006\u0010-\u0019\u001c-\u001f\u007f]/;

/** A time may be negative: editors that shift a file write `-00:00:06,843`, and FFmpeg reads it (the cue before zero is not shown). */
const SRT_TIMING = /-?\d{1,3}:\d{2}:\d{2}[,.]\d{1,3}[ \t]*-->[ \t]*-?\d{1,3}:\d{2}:\d{2}[,.]\d{1,3}/g;
const VTT_TIMING = /(?:\d{2,}:)?\d{2}:\d{2}\.\d{3}[ \t]*-->[ \t]*(?:\d{2,}:)?\d{2}:\d{2}\.\d{3}/g;
const VTT_SIGNATURE = /^WEBVTT(?:[ \t\r\n]|$)/;
const SCRIPT_INFO_FIRST = /^\s*\[Script Info\]/i;
const DIALOGUE_LINE = /^[ \t]*Dialogue:/gim;
const MICRODVD_CUE = /^[ \t]*\{-?\d+\}\{-?\d*\}/gm;
const MICRODVD_FIRST = /^\s*\{-?\d+\}\{-?\d*\}/;
/** The first line of a MicroDVD file may set the frame rate, as `{1}{1}25.000` or `{0}{}25.000 FPS`: it is not a cue. */
const MICRODVD_RATE_FIRST_LINE = /^\s*\{[01]\}\{[01]?\}\s*\d+(?:\.\d+)?(?:[ \t]*fps)?[ \t]*(?:\r?\n|$)/i;

/** The text of the first bytes of a file for the structure checks: UTF-16 as its byte order mark says, else one character per byte. */
export function subtitleTextOfBytes(bytes: Uint8Array): string {
  const utf16 = (label: 'utf-16le' | 'utf-16be') => new TextDecoder(label).decode(bytes.subarray(2));
  if (bytes[0] === UTF16LE_BOM[0] && bytes[1] === UTF16LE_BOM[1]) return utf16('utf-16le');
  if (bytes[0] === UTF16BE_BOM[0] && bytes[1] === UTF16BE_BOM[1]) return utf16('utf-16be');
  return new TextDecoder('latin1').decode(bytes).replace(/^ï»¿/, '');
}

/** Whether the text holds a control character that text does not use (a NUL byte first: a binary file has one in its first bytes). */
export function hasNonTextControl(text: string): boolean {
  return NON_TEXT_CONTROL.test(text);
}

function withoutBom(text: string): string {
  return text.startsWith(UTF8_BOM_CHARACTER) ? text.slice(1) : text;
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/**
 * How many cues the text holds. A file of another format holds none: a WebVTT file has no SubRip timing line only when its
 * times lack the hours, and a SubRip file never opens with `WEBVTT`.
 */
export function countSubtitleCues(format: SubtitleFormat, text: string): number {
  const body = withoutBom(text);
  switch (format) {
    case 'srt':
      return VTT_SIGNATURE.test(body) ? 0 : countMatches(body, SRT_TIMING);
    case 'vtt':
      return VTT_SIGNATURE.test(body) ? countMatches(body, VTT_TIMING) : 0;
    case 'ass':
    case 'ssa':
      return SCRIPT_INFO_FIRST.test(body) ? countMatches(body, DIALOGUE_LINE) : 0;
    case 'sub':
      return MICRODVD_FIRST.test(body) ? countMatches(body, MICRODVD_CUE) - (MICRODVD_RATE_FIRST_LINE.test(body) ? 1 : 0) : 0;
  }
}

/**
 * Whether the text opens like a file of the format. SubRip has no signature, so a timing line anywhere in the text stands for
 * one; the others open with their header (WebVTT, the Script Info section) or with their first cue (MicroDVD).
 */
export function hasSubtitleHeader(format: SubtitleFormat, text: string): boolean {
  const body = withoutBom(text);
  switch (format) {
    case 'srt':
      return !VTT_SIGNATURE.test(body) && countMatches(body, SRT_TIMING) > 0;
    case 'vtt':
      return VTT_SIGNATURE.test(body);
    case 'ass':
    case 'ssa':
      return SCRIPT_INFO_FIRST.test(body);
    case 'sub':
      return MICRODVD_FIRST.test(body);
  }
}

/** Whether the first bytes of a file are plausibly a subtitle file of the format named: text with the header of the format. */
export function isSubtitleHead(format: SubtitleFormat, bytes: Uint8Array): boolean {
  const text = subtitleTextOfBytes(bytes);
  return !hasNonTextControl(text) && hasSubtitleHeader(format, text);
}
