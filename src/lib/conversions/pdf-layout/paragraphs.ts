import { parseListMarker } from './lists';
import type { LayoutLine, Paragraph, StyledRun } from './types';
import { firstChar, isLetter, isLowercase, lastChar, needsSpaceBetween } from './text-chars';

/**
 * Paragraphs from the lines of one flow (a column, or a full-width block): consecutive lines belong together unless
 * the vertical gap, the first-line indent, a short previous line, a change of size or weight, or a list marker says a
 * new paragraph begins. Words broken by a hyphen at the end of a line are rejoined.
 */

/** A baseline step above this many times the flow's line pitch starts a paragraph. */
const GAP_FACTOR = 1.35;
/** A first line indented this many em more than the flow's left edge starts a paragraph. */
const INDENT_EM = 0.9;
/** A line ending this share of the flow's width before its right edge ends its paragraph (when the next line starts at the left). */
const SHORT_LINE_SHARE = 0.2;
/** Sizes differing by more than this share belong to different paragraphs (a heading above its text). */
const SIZE_CHANGE_SHARE = 0.12;
/** Steps within this share of the smallest step are one pitch. */
const PITCH_SPREAD = 1.15;
/** Without a measured pitch a line is this many em from the next. */
const DEFAULT_PITCH_EM = 1.2;
/** Steps needed before the measured pitch is trusted; with fewer, the pitch is capped at a typical single-spaced leading. */
const MIN_STEPS_FOR_PITCH = 3;
const TYPICAL_LEADING_CAP_EM = 1.25;
/** Lines shorter than this many characters do not count as a "short line" signal (headings, list items). */
const MIN_SHORT_LINE_CHARS = 1;
/** Word widths are estimated from the average character; a word must fit with this much room to spare to count as fitting. */
const WORD_WIDTH_MARGIN = 1.3;
const HYPHENS = new Set(['-', '­', '‐', '‑']);
/** Terminal punctuation of a sentence; a paragraph that does not end with it may continue in the next column. */
const SENTENCE_END = /[.!?:;。！？…”"')\]]$/u;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** The line pitch of a flow: the typical step between consecutive lines of one size. */
export function linePitch(lines: LayoutLine[]): number {
  const steps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const step = lines[i].baseline - lines[i - 1].baseline;
    const sameSize = Math.abs(lines[i].size - lines[i - 1].size) <= SIZE_CHANGE_SHARE * lines[i].size;
    if (sameSize && step > 0.5 * lines[i].size) steps.push(step);
  }
  if (steps.length === 0) return DEFAULT_PITCH_EM * (lines[0]?.size ?? 0);
  const smallest = Math.min(...steps);
  const pitch = median(steps.filter((step) => step <= PITCH_SPREAD * smallest));
  if (steps.length >= MIN_STEPS_FOR_PITCH) return pitch;
  return Math.min(pitch, TYPICAL_LEADING_CAP_EM * (lines[0]?.size ?? pitch));
}

function sameWeight(a: LayoutLine, b: LayoutLine): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.monospace === b.monospace;
}

interface FlowMetrics {
  pitch: number;
  left: number;
  right: number;
}

function flowMetrics(lines: LayoutLine[]): FlowMetrics {
  return {
    pitch: linePitch(lines),
    // The left edge is the most common line start, not the extreme one: an indented block must not move it.
    left: modeOf(lines.map((line) => line.box.x0)),
    right: Math.max(...lines.map((line) => line.box.x1)),
  };
}

function modeOf(values: number[]): number {
  const buckets = new Map<number, number>();
  for (const value of values) {
    const key = Math.round(value);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  let best = Math.round(values[0] ?? 0);
  let count = 0;
  for (const [key, hits] of buckets) {
    if (hits > count || (hits === count && key < best)) {
      best = key;
      count = hits;
    }
  }
  return best;
}

/**
 * Whether the previous line stopped short of the right edge on purpose: it left more than a fifth of the width free
 * and the first word of the next line would have fitted there. A line of ragged text that stops before a long word
 * leaves a gap of at most that word.
 */
function endedEarly(previous: LayoutLine, next: LayoutLine, free: number, width: number): boolean {
  if (previous.text.length < MIN_SHORT_LINE_CHARS || free <= SHORT_LINE_SHARE * width) return false;
  const advance = (previous.box.x1 - previous.box.x0) / Math.max(1, previous.text.length);
  const firstWord = next.text.split(/\s+/, 1)[0] ?? '';
  return (firstWord.length + 1) * advance * WORD_WIDTH_MARGIN <= free;
}

/** Whether `line` starts a new paragraph after `previous`. */
function startsParagraph(previous: LayoutLine, line: LayoutLine, flow: FlowMetrics): boolean {
  const step = line.baseline - previous.baseline;
  if (step > GAP_FACTOR * Math.max(flow.pitch, previous.size)) return true;
  if (Math.abs(line.size - previous.size) > SIZE_CHANGE_SHARE * previous.size) return true;
  if (!sameWeight(previous, line)) return true;
  if (line.vertical !== previous.vertical) return true;
  const marker = parseListMarker(line.text);
  if (marker !== null && marker.kind !== 'lowerLetter' && marker.kind !== 'upperLetter') return true;
  const width = flow.right - flow.left;
  const indent = line.box.x0 - flow.left;
  if (indent > INDENT_EM * line.size && !previous.rtl) return true;
  const previousShort = endedEarly(previous, line, flow.right - previous.box.x1, width);
  if (previousShort && !previous.rtl && indent <= INDENT_EM * line.size) return true;
  if (previous.rtl && line.rtl) {
    const rightIndent = flow.right - line.box.x1;
    if (rightIndent > INDENT_EM * line.size) return true;
    const previousShortRtl = previous.box.x0 - flow.left > SHORT_LINE_SHARE * width;
    if (previousShortRtl && rightIndent <= INDENT_EM * line.size) return true;
  }
  return false;
}

/** The hyphen that ends `tail` when it is a line-end break inside a word, or null. `tail` holds the end of the text. */
function trailingHyphen(tail: string): string | null {
  const last = lastChar(tail);
  if (!HYPHENS.has(last)) return null;
  const before = Array.from(tail.slice(0, tail.length - last.length));
  const letter = before.length >= 1 ? before[before.length - 1] : '';
  return isLetter(letter) ? last : null;
}

/**
 * Characters of the text so far that the joining rules look at (the last two code points). The text itself is kept in
 * pieces and joined once: testing the end of one ever-growing string line by line would flatten it every time.
 */
const TAIL_UNITS = 8;

/** Joins the lines of a paragraph, rejoining words that a hyphen broke at the end of a line. */
function joinLines(lines: LayoutLine[]): { runs: StyledRun[]; text: string } {
  const runs: StyledRun[] = [];
  const pieces: string[] = [];
  let tail = '';
  const append = (piece: string): void => {
    pieces.push(piece);
    tail = (tail + piece).slice(-TAIL_UNITS);
  };
  lines.forEach((line, index) => {
    const lineRuns = line.runs.map((run) => ({ ...run }));
    const lineText = line.text;
    if (index > 0) {
      const hyphen = trailingHyphen(tail);
      const startsLower = isLowercase(firstChar(lineText));
      if (hyphen !== null && startsLower) {
        // Rejoin "adminis-" and "tration": drop the hyphen from the previous run and the text so far.
        let remaining = hyphen.length;
        while (remaining > 0 && pieces.length > 0) {
          const piece = pieces[pieces.length - 1];
          const keep = Math.max(0, piece.length - remaining);
          remaining -= piece.length - keep;
          pieces[pieces.length - 1] = piece.slice(0, keep);
        }
        tail = tail.slice(0, tail.length - hyphen.length);
        const last = runs[runs.length - 1];
        last.text = last.text.slice(0, last.text.length - hyphen.length);
      } else if (hyphen !== null) {
        // A hyphen before a capital letter or a digit is part of the compound ("Anglo-Saxon"): kept, with no space after it.
      } else if (needsSpaceBetween(tail, lineText)) {
        append(' ');
        runs[runs.length - 1].text += ' ';
      }
    }
    for (const run of lineRuns) {
      const last = runs[runs.length - 1];
      if (last && last.bold === run.bold && last.italic === run.italic && last.monospace === run.monospace) last.text += run.text;
      else runs.push(run);
    }
    append(lineText);
  });
  return { runs, text: pieces.join('') };
}

function paragraphOf(lines: LayoutLine[], flow: number, pageNumber: number, full: boolean): Paragraph {
  const { runs, text } = joinLines(lines);
  const first = lines[0];
  const dominant = lines.reduce((best, line) => (line.text.length > best.text.length ? line : best), first);
  return {
    runs,
    text,
    lines,
    box: {
      x0: Math.min(...lines.map((line) => line.box.x0)),
      x1: Math.max(...lines.map((line) => line.box.x1)),
      y0: Math.min(...lines.map((line) => line.box.y0)),
      y1: Math.max(...lines.map((line) => line.box.y1)),
    },
    size: dominant.size,
    bold: dominant.bold,
    italic: dominant.italic,
    monospace: dominant.monospace,
    rtl: dominant.rtl,
    fontKey: dominant.fontKey,
    firstLineX: first.box.x0,
    leftX: Math.min(...lines.map((line) => line.box.x0)),
    flow,
    pageNumber,
    full,
  };
}

/** Paragraphs of one flow of lines (top to bottom). */
export function paragraphsOfFlow(lines: LayoutLine[], flow: number, pageNumber: number, full: boolean): Paragraph[] {
  if (lines.length === 0) return [];
  const metrics = flowMetrics(lines);
  const paragraphs: Paragraph[] = [];
  let current: LayoutLine[] = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    if (startsParagraph(lines[i - 1], lines[i], metrics)) {
      paragraphs.push(paragraphOf(current, flow, pageNumber, full));
      current = [lines[i]];
    } else {
      current.push(lines[i]);
    }
  }
  paragraphs.push(paragraphOf(current, flow, pageNumber, full));
  return paragraphs;
}

/**
 * Whether a paragraph that ends a flow carries on in the next flow (the next column or page): it filled its lines to the
 * right edge, did not end a sentence (or the next one starts in lower case), and both share size and weight.
 */
export function continuesInNextFlow(last: Paragraph, next: Paragraph, flowRight: number): boolean {
  if (last.full || next.full) return false;
  if (Math.abs(last.size - next.size) > SIZE_CHANGE_SHARE * last.size) return false;
  if (last.bold !== next.bold || last.italic !== next.italic || last.monospace !== next.monospace) return false;
  if (last.lines.length < 2 && last.text.length < 40) return false;
  const lastLine = last.lines[last.lines.length - 1];
  const reachesEdge = flowRight - lastLine.box.x1 <= SHORT_LINE_SHARE * (flowRight - last.leftX);
  if (!reachesEdge) return false;
  if (parseListMarker(next.text) !== null) return false;
  const lowerStart = isLowercase(firstChar(next.text));
  const open = !SENTENCE_END.test(last.text.trimEnd());
  return open || lowerStart;
}

/** Appends `next` to `last` as one paragraph. */
export function mergeParagraphs(last: Paragraph, next: Paragraph): Paragraph {
  const lines = [...last.lines, ...next.lines];
  return paragraphOf(lines, last.flow, last.pageNumber, last.full);
}
