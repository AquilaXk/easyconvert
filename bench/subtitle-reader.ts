/**
 * An independent reader of the subtitle formats, for judging the subtitle conversions: it parses SubRip, WebVTT, SubStation
 * Alpha (SSA and ASS) and MicroDVD from the format descriptions with code of its own, so a conversion is read back by something
 * that is not FFmpeg (which wrote the output and read the input) and not the product's structure check. It reads cues: start
 * and end in milliseconds, and the text as the words a viewer sees (markup, override blocks and entities removed, white space
 * collapsed). Styling and positioning are not compared; the conversions keep some of them as markup and drop the rest.
 */

export type SubtitleKind = 'srt' | 'vtt' | 'ass' | 'ssa' | 'sub';

export interface Cue {
  startMs: number;
  /** Null for a MicroDVD cue that names no end (it lasts until the next cue). */
  endMs: number | null;
  text: string;
}

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
/** The frame rate FFmpeg assumes for a MicroDVD file that sets none. */
export const MICRODVD_DEFAULT_FPS = 23.976;

const ENTITIES: Readonly<Record<string, string>> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ', '&lrm;': '', '&rlm;': '', '&quot;': '"', '&apos;': "'" };

/**
 * The words of a cue's text: markup removed, entities decoded, white space collapsed. SubRip and WebVTT mark text with `<...>` tags
 * (and SubRip files often carry `{\an8}`-style override blocks, which are removed too, while any other braces are text); the
 * SubStation Alpha and MicroDVD texts mark it with `{...}` blocks, and SubStation Alpha writes line breaks and hard spaces as `\N`
 * and `\h`.
 */
export function plainText(raw: string, kind: SubtitleKind): string {
  const braced = kind === 'srt' || kind === 'vtt' ? /\{\\[^}]*\}/g : /\{[^}]*\}/g;
  // SubStation Alpha writes a brace that is text as `\{` and `\}`; the escape is set aside while the blocks are removed.
  const unescaped = kind === 'ass' || kind === 'ssa' ? raw.replace(/\\\{/g, '\u0001').replace(/\\\}/g, '\u0002') : raw;
  const withoutMarkup = unescaped.replace(braced, '').replace(/<[^>]*>/g, '').replaceAll('\u0001', '{').replaceAll('\u0002', '}');
  const escaped = kind === 'ass' || kind === 'ssa' ? withoutMarkup.replace(/\\[Nn]/g, ' ').replace(/\\h/g, ' ') : withoutMarkup;
  return escaped
    .replace(/&(?:amp|lt|gt|nbsp|lrm|rlm|quot|apos);/g, (entity) => ENTITIES[entity])
    .replace(/[\u200E\u200F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function lines(text: string): string[] {
  return text.replace(/^﻿/, '').replace(/\r+\n/g, '\n').split(/\r|\n/);
}

function timeMs(hours: string | undefined, minutes: string, seconds: string, fraction: string): number {
  const millis = Number(fraction.padEnd(3, '0').slice(0, 3));
  return Number(hours ?? 0) * MS_PER_HOUR + Number(minutes) * MS_PER_MINUTE + Number(seconds) * MS_PER_SECOND + millis;
}

const SRT_TIMING = /^\s*(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})/;
const VTT_TIMING = /^\s*(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})/;

/** SubRip: a timing line opens a cue, whose text runs to the next empty line (or to a number line that precedes the next timing line). */
function readSubRip(text: string): Cue[] {
  const all = lines(text);
  const cues: Cue[] = [];
  for (let at = 0; at < all.length; at++) {
    const timing = SRT_TIMING.exec(all[at]);
    if (timing === null) continue;
    const body: string[] = [];
    let next = at + 1;
    while (next < all.length && all[next].trim() !== '' && SRT_TIMING.exec(all[next]) === null) {
      const numberBeforeTiming = /^\s*\d+\s*$/.test(all[next]) && next + 1 < all.length && SRT_TIMING.exec(all[next + 1]) !== null;
      if (numberBeforeTiming) break;
      body.push(all[next]);
      next++;
    }
    cues.push({ startMs: timeMs(timing[1], timing[2], timing[3], timing[4]), endMs: timeMs(timing[5], timing[6], timing[7], timing[8]), text: plainText(body.join(' '), 'srt') });
    at = next - 1;
  }
  return cues;
}

/** WebVTT: blocks split by empty lines; the first is the header; NOTE, STYLE and REGION blocks are not cues; a cue block has an optional identifier and a timing line. */
function readWebVtt(text: string): Cue[] {
  const blocks = lines(text).reduce<string[][]>(
    (found, line) => {
      if (line.trim() === '') found.push([]);
      else found[found.length - 1].push(line);
      return found;
    },
    [[]]
  );
  const cues: Cue[] = [];
  for (const block of blocks.slice(1)) {
    if (block.length === 0 || /^(NOTE|STYLE|REGION)(\s|$)/.test(block[0])) continue;
    const timingAt = block.findIndex((line) => VTT_TIMING.test(line));
    if (timingAt < 0 || timingAt > 1) continue;
    const timing = VTT_TIMING.exec(block[timingAt]);
    if (timing === null) continue;
    cues.push({ startMs: timeMs(timing[1], timing[2], timing[3], timing[4]), endMs: timeMs(timing[5], timing[6], timing[7], timing[8]), text: plainText(block.slice(timingAt + 1).join(' '), 'vtt') });
  }
  return cues;
}

const ASS_TIME = /^\s*(\d+):(\d{2}):(\d{2})[.:](\d{1,3})\s*$/;

function assTimeMs(field: string): number | null {
  const time = ASS_TIME.exec(field);
  if (time === null) return null;
  // The fraction is hundredths of a second: `.5` and `.50` are 500 ms, `.05` is 50 ms (a third digit, which some writers add, is milliseconds).
  const fraction = time[4].length === 3 ? time[4] : String(Number(time[4].padEnd(2, '0')) * 10).padStart(3, '0');
  return timeMs(time[1], time[2], time[3], fraction);
}

/** SubStation Alpha: the `Format:` line of `[Events]` names the columns; each `Dialogue:` line splits at commas into that many fields, the last (Text) keeping its commas. */
function readSubStation(text: string, kind: 'ass' | 'ssa'): Cue[] {
  let inEvents = false;
  let columns: string[] = [];
  const cues: Cue[] = [];
  for (const line of lines(text)) {
    const section = /^\s*\[(.+)\]\s*$/.exec(line);
    if (section !== null) {
      inEvents = section[1].trim().toLowerCase() === 'events';
      continue;
    }
    if (!inEvents) continue;
    const format = /^\s*Format:\s*(.*)$/i.exec(line);
    if (format !== null) {
      columns = format[1].split(',').map((name) => name.trim().toLowerCase());
      continue;
    }
    const dialogue = /^\s*Dialogue:\s?(.*)$/i.exec(line);
    if (dialogue === null || columns.length === 0) continue;
    const parts = dialogue[1].split(',');
    const fields = [...parts.slice(0, columns.length - 1), parts.slice(columns.length - 1).join(',')];
    const start = assTimeMs(fields[columns.indexOf('start')] ?? '');
    const end = assTimeMs(fields[columns.indexOf('end')] ?? '');
    if (start === null || end === null) continue;
    cues.push({ startMs: start, endMs: end, text: plainText(fields[columns.indexOf('text')] ?? '', kind) });
  }
  return cues;
}

const MICRODVD_RATE = /^\s*\{[01]\}\{[01]?\}\s*(\d+(?:\.\d+)?)/;
const MICRODVD_CUE = /^\s*\{(\d+)\}\{(\d*)\}(.*)$/;

/** MicroDVD: `{start}{end}text` in frames, `|` between lines; a first line `{1}{1}25.000` or `{0}{}25.000` sets the rate. */
function readMicroDvd(text: string): Cue[] {
  const all = lines(text);
  const rate = all.map((line) => MICRODVD_RATE.exec(line)).find((found) => found !== null);
  const fps = rate ? Number(rate[1]) : MICRODVD_DEFAULT_FPS;
  const cues: Cue[] = [];
  for (const line of all) {
    const cue = MICRODVD_CUE.exec(line);
    if (cue === null || MICRODVD_RATE.test(line)) continue;
    const start = Math.round((Number(cue[1]) / fps) * MS_PER_SECOND);
    const end = cue[2] === '' ? null : Math.round((Number(cue[2]) / fps) * MS_PER_SECOND);
    cues.push({ startMs: start, endMs: end, text: plainText(cue[3].replace(/\|/g, ' '), 'sub') });
  }
  return cues;
}

/** The cues of a subtitle text, in file order, without the cues that show no words (an empty cue has nothing to compare). */
export function readSubtitle(kind: SubtitleKind, text: string): Cue[] {
  const read = { srt: readSubRip, vtt: readWebVtt, ass: (t: string) => readSubStation(t, 'ass'), ssa: (t: string) => readSubStation(t, 'ssa'), sub: readMicroDvd }[kind];
  return read(text).filter((cue) => cue.text !== '');
}

/** Cues in the order a player shows them: by start, then end, then text. */
export function inPlayOrder(cues: readonly Cue[]): Cue[] {
  return [...cues].sort((a, b) => a.startMs - b.startMs || (a.endMs ?? 0) - (b.endMs ?? 0) || a.text.localeCompare(b.text));
}

export interface CueComparison {
  sourceCues: number;
  outputCues: number;
  /** 1 when the numbers of cues differ, else 0. */
  countMismatch: number;
  /** Cues whose start or end is further from the source's than the tolerance allows. */
  timingMismatches: number;
  /** The largest start or end error seen, in milliseconds. */
  maxTimingErrorMs: number;
  /** Cues whose words differ from the source's. */
  textMismatches: number;
}

export interface Tolerance {
  /** Largest allowed error of a start time, in milliseconds. */
  startMs: number;
  /** Largest allowed error of an end time, in milliseconds. */
  endMs: number;
}

/** One millisecond between SubRip, WebVTT and the formats of milliseconds. */
export const MILLISECOND_TOLERANCE: Tolerance = { startMs: 1, endMs: 1 };
/**
 * Into ASS, whose times are hundredths of a second: FFmpeg writes the start rounded to the nearest hundredth and the end as that
 * start plus the rounded duration, so the start is within 5 ms and the end within 10 ms of the source's.
 */
export const CENTISECOND_TOLERANCE: Tolerance = { startMs: 5 + 1, endMs: 10 + 1 };

/** Compares the cues a conversion wrote with the cues of its source, pair by pair in play order. */
export function compareCues(source: readonly Cue[], output: readonly Cue[], tolerance: Tolerance): CueComparison {
  const expected = inPlayOrder(source);
  const actual = inPlayOrder(output);
  const comparison: CueComparison = {
    sourceCues: expected.length,
    outputCues: actual.length,
    countMismatch: expected.length === actual.length ? 0 : 1,
    timingMismatches: 0,
    maxTimingErrorMs: 0,
    textMismatches: 0,
  };
  for (let at = 0; at < Math.min(expected.length, actual.length); at++) {
    const want = expected[at];
    const got = actual[at];
    const startError = Math.abs(want.startMs - got.startMs);
    const endError = want.endMs === null || got.endMs === null ? 0 : Math.abs(want.endMs - got.endMs);
    comparison.maxTimingErrorMs = Math.max(comparison.maxTimingErrorMs, startError, endError);
    if (startError > tolerance.startMs || endError > tolerance.endMs) comparison.timingMismatches++;
    if (want.text !== got.text) comparison.textMismatches++;
  }
  return comparison;
}

/** The tolerance a target format allows: hundredths of a second for ASS, milliseconds otherwise. */
export function toleranceFor(target: SubtitleKind): Tolerance {
  return target === 'ass' || target === 'ssa' ? CENTISECOND_TOLERANCE : MILLISECOND_TOLERANCE;
}
