import { continues, parseListMarker, reconcileLetterAndRoman, type ListMarker } from './lists';
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

/**
 * Whether a letter marker (which prose can also start a line with) starts a list item: it counts on from the marker of
 * the paragraph it would join ("b." after "a.", or "v." after "iv." read as roman).
 */
function continuesOpeningMarker(opening: LayoutLine, marker: ListMarker): boolean {
  const open = parseListMarker(opening.text);
  if (open === null) return false;
  reconcileLetterAndRoman(open, marker, false);
  return continues(open, marker);
}

/** Whether `line` starts a new paragraph after `previous`; `opening` is the first line of the paragraph it would join. */
function startsParagraph(previous: LayoutLine, line: LayoutLine, opening: LayoutLine, flow: FlowMetrics): boolean {
  const step = line.baseline - previous.baseline;
  if (step > GAP_FACTOR * Math.max(flow.pitch, previous.size)) return true;
  if (Math.abs(line.size - previous.size) > SIZE_CHANGE_SHARE * previous.size) return true;
  if (!sameWeight(previous, line)) return true;
  if (line.vertical !== previous.vertical) return true;
  const marker = parseListMarker(line.text);
  if (marker !== null && marker.kind !== 'lowerLetter' && marker.kind !== 'upperLetter') return true;
  if (marker !== null && continuesOpeningMarker(opening, marker)) return true;
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

/** What `continuesInNextFlow` reads of the paragraph that ends a flow. */
export interface OpenParagraph {
  full: boolean;
  size: number;
  bold: boolean;
  italic: boolean;
  monospace: boolean;
  lineCount: number;
  lastLine: LayoutLine;
  leftX: number;
  x1: number;
  /** The text, white space at its end aside, ends in terminal punctuation. */
  endsSentence: boolean;
}

function endsSentence(text: string): boolean {
  return SENTENCE_END.test(text.trimEnd());
}

/** The end of a paragraph that is built already. */
export function openParagraph(paragraph: Paragraph): OpenParagraph {
  return {
    full: paragraph.full,
    size: paragraph.size,
    bold: paragraph.bold,
    italic: paragraph.italic,
    monospace: paragraph.monospace,
    lineCount: paragraph.lines.length,
    lastLine: paragraph.lines[paragraph.lines.length - 1],
    leftX: paragraph.leftX,
    x1: paragraph.box.x1,
    endsSentence: endsSentence(paragraph.text),
  };
}

/**
 * A paragraph built line by line: the lines are joined (rejoining words that a hyphen broke at the end of a line) and the
 * box and the dominant style kept as each line comes. A run of paragraphs that continue into one another is added to one
 * builder and finished once, so a continuation costs its own lines and not those before it.
 */
export class ParagraphBuilder {
  private readonly lines: LayoutLine[] = [];
  private readonly runs: StyledRun[] = [];
  /** The text of each run as the pieces it was given, joined once in `finish`: cutting a hyphen then costs the last piece, not the run. */
  private readonly runPieces: string[][] = [];
  private readonly pieces: string[] = [];
  private tail = '';
  private sentenceEnd = false;
  private dominant: LayoutLine | undefined;
  private x0 = 0;
  private x1 = 0;
  private y0 = 0;
  private y1 = 0;

  constructor(
    private readonly flow: number,
    private readonly pageNumber: number,
    private readonly full: boolean
  ) {}

  private append(piece: string): void {
    this.pieces.push(piece);
    this.tail = (this.tail + piece).slice(-TAIL_UNITS);
    const visible = piece.trimEnd();
    if (visible !== '') this.sentenceEnd = endsSentence(visible.slice(-2));
  }

  /** Drops the hyphen that ends the text so far: "adminis-" and "tration" are one word. */
  private dropHyphen(hyphen: string): void {
    cutEnd(this.pieces, hyphen.length);
    this.tail = this.tail.slice(0, this.tail.length - hyphen.length);
    cutEnd(this.runPieces[this.runPieces.length - 1], hyphen.length);
  }

  add(line: LayoutLine): void {
    const lineText = line.text;
    if (this.lines.length > 0) {
      const hyphen = trailingHyphen(this.tail);
      const startsLower = isLowercase(firstChar(lineText));
      if (hyphen !== null && startsLower) {
        this.dropHyphen(hyphen);
      } else if (hyphen !== null) {
        // A hyphen before a capital letter or a digit is part of the compound ("Anglo-Saxon"): kept, with no space after it.
      } else if (needsSpaceBetween(this.tail, lineText)) {
        this.append(' ');
        this.runPieces[this.runPieces.length - 1].push(' ');
      }
    }
    for (const run of line.runs) {
      const last = this.runs[this.runs.length - 1];
      if (last && last.bold === run.bold && last.italic === run.italic && last.monospace === run.monospace) {
        this.runPieces[this.runPieces.length - 1].push(run.text);
      } else {
        this.runs.push({ ...run });
        this.runPieces.push([run.text]);
      }
    }
    this.append(lineText);
    if (this.lines.length === 0) {
      this.x0 = line.box.x0;
      this.x1 = line.box.x1;
      this.y0 = line.box.y0;
      this.y1 = line.box.y1;
    } else {
      this.x0 = Math.min(this.x0, line.box.x0);
      this.x1 = Math.max(this.x1, line.box.x1);
      this.y0 = Math.min(this.y0, line.box.y0);
      this.y1 = Math.max(this.y1, line.box.y1);
    }
    if (!this.dominant || line.text.length > this.dominant.text.length) this.dominant = line;
    this.lines.push(line);
  }

  addAll(lines: readonly LayoutLine[]): void {
    for (const line of lines) this.add(line);
  }

  /** The end of the paragraph so far, as `continuesInNextFlow` reads it. */
  end(): OpenParagraph {
    const dominant = this.dominant!;
    return {
      full: this.full,
      size: dominant.size,
      bold: dominant.bold,
      italic: dominant.italic,
      monospace: dominant.monospace,
      lineCount: this.lines.length,
      lastLine: this.lines[this.lines.length - 1],
      leftX: this.x0,
      x1: this.x1,
      endsSentence: this.sentenceEnd,
    };
  }

  finish(): Paragraph {
    const dominant = this.dominant!;
    return {
      runs: this.runs.map((run, index) => ({ ...run, text: this.runPieces[index].join('') })),
      text: this.pieces.join(''),
      lines: this.lines,
      box: { x0: this.x0, x1: this.x1, y0: this.y0, y1: this.y1 },
      size: dominant.size,
      bold: dominant.bold,
      italic: dominant.italic,
      monospace: dominant.monospace,
      rtl: dominant.rtl,
      fontKey: dominant.fontKey,
      firstLineX: this.lines[0].box.x0,
      leftX: this.x0,
      flow: this.flow,
      pageNumber: this.pageNumber,
      full: this.full,
    };
  }
}

/** Removes the last `count` code units of the text that `parts` joins to, dropping parts it empties. */
function cutEnd(parts: string[], count: number): void {
  let remaining = count;
  while (remaining > 0 && parts.length > 0) {
    const last = parts[parts.length - 1];
    if (last.length <= remaining) {
      remaining -= last.length;
      parts.pop();
    } else {
      parts[parts.length - 1] = last.slice(0, last.length - remaining);
      remaining = 0;
    }
  }
}

function paragraphOf(lines: LayoutLine[], flow: number, pageNumber: number, full: boolean): Paragraph {
  const builder = new ParagraphBuilder(flow, pageNumber, full);
  builder.addAll(lines);
  return builder.finish();
}

/** Paragraphs of one flow of lines (top to bottom). */
export function paragraphsOfFlow(lines: LayoutLine[], flow: number, pageNumber: number, full: boolean): Paragraph[] {
  if (lines.length === 0) return [];
  const metrics = flowMetrics(lines);
  const paragraphs: Paragraph[] = [];
  let current: LayoutLine[] = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    if (startsParagraph(lines[i - 1], lines[i], current[0], metrics)) {
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
export function continuesInNextFlow(last: OpenParagraph, next: Paragraph, flowRight: number): boolean {
  if (last.full || next.full) return false;
  if (Math.abs(last.size - next.size) > SIZE_CHANGE_SHARE * last.size) return false;
  if (last.bold !== next.bold || last.italic !== next.italic || last.monospace !== next.monospace) return false;
  if (last.lineCount < 2 && last.lastLine.text.length < 40) return false;
  const reachesEdge = flowRight - last.lastLine.box.x1 <= SHORT_LINE_SHARE * (flowRight - last.leftX);
  if (!reachesEdge) return false;
  if (parseListMarker(next.text) !== null) return false;
  const lowerStart = isLowercase(firstChar(next.text));
  const open = !last.endsSentence;
  return open || lowerStart;
}
