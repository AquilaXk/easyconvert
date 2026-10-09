import type { Inline, ListBlock, ListItem, ListLevelFormat } from '../document-model/model';
import { continues, parseListMarker, reconcileLetterAndRoman, type ListMarker } from './lists';
import type { Paragraph, StyledRun } from './types';

/**
 * Document-level structure from the paragraphs of all pages: the body size, headings by font size and weight, and
 * lists assembled from marker paragraphs.
 */

const SIZE_PRECISION = 2;
/** A paragraph this much bigger than the body text is a heading candidate. */
const HEADING_SIZE_RATIO = 1.12;
/** Bold text at body size is a heading candidate when it is this short. */
const BOLD_HEADING_MAX_CHARS = 120;
const HEADING_MAX_CHARS = 200;
const HEADING_MAX_LINES = 3;
/** Heading sizes within this many points are one level. */
const SIZE_GROUP_POINTS = 0.75;
const MAX_HEADING_LEVEL = 4;
/** Text that ends a sentence; a bold line ending with it is body text. */
const SENTENCE_END = /[.!?。！？]$/u;
/** A list item starts at the same indent as its siblings within this many points. */
const INDENT_TOLERANCE = 4;
const MAX_LIST_LEVELS = 9;
/** Bullet characters that mark a list even on a single paragraph (a hyphen, dash or asterisk does not). */
const STRONG_BULLETS = new Set(['•', '◦', '▪', '▫', '●', '○', '■', '□', '◆', '◇', '‣', '⁃', '∙', '❖', '➢', '✓']);
const MIN_COUNTER_ITEMS = 2;

/** The size most characters of the paragraphs have, rounded to half a point. */
export function bodySizeOf(paragraphs: Paragraph[]): number {
  const weight = new Map<number, number>();
  for (const paragraph of paragraphs) {
    const key = Math.round(paragraph.size * SIZE_PRECISION) / SIZE_PRECISION;
    weight.set(key, (weight.get(key) ?? 0) + paragraph.text.length);
  }
  let best = 0;
  let most = -1;
  for (const [size, chars] of weight) {
    if (chars > most || (chars === most && size > best)) {
      best = size;
      most = chars;
    }
  }
  return best;
}

/** Heading level (1 to 4) of each paragraph that is a heading. */
export function headingLevels(paragraphs: Paragraph[], bodySize: number): Map<Paragraph, number> {
  const candidates: { paragraph: Paragraph; bigger: boolean }[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.lines.length > HEADING_MAX_LINES || paragraph.text.length > HEADING_MAX_CHARS || paragraph.text.trim() === '') continue;
    if (parseListMarker(paragraph.text) !== null) continue;
    if (paragraph.monospace) continue;
    const bigger = paragraph.size >= bodySize * HEADING_SIZE_RATIO;
    const boldBody =
      paragraph.bold &&
      paragraph.size >= bodySize * 0.95 &&
      paragraph.text.length <= BOLD_HEADING_MAX_CHARS &&
      !SENTENCE_END.test(paragraph.text.trim()) &&
      paragraph.lines.every((line) => line.bold);
    if (bigger || boldBody) candidates.push({ paragraph, bigger });
  }
  // Distinct heading sizes, largest first, with sizes a hair apart counted as one.
  const sizes = candidates
    .filter((candidate) => candidate.bigger)
    .map((candidate) => candidate.paragraph.size)
    .sort((a, b) => b - a);
  const groups: number[] = [];
  for (const size of sizes) {
    if (groups.length === 0 || groups[groups.length - 1] - size > SIZE_GROUP_POINTS) groups.push(size);
  }
  const levels = new Map<Paragraph, number>();
  for (const { paragraph, bigger } of candidates) {
    if (bigger) {
      const rank = groups.findIndex((size) => size - paragraph.size <= SIZE_GROUP_POINTS);
      levels.set(paragraph, Math.min(rank + 1, MAX_HEADING_LEVEL));
    } else {
      levels.set(paragraph, Math.min(groups.length + 1, MAX_HEADING_LEVEL));
    }
  }
  return levels;
}

export function inlineRuns(runs: StyledRun[]): Inline[] {
  return runs.filter((run) => run.text !== '').map((run) => ({ text: run.text, bold: run.bold, italic: run.italic, monospace: run.monospace }));
}

/** Runs of a paragraph without its first `count` characters (a list marker). */
function dropPrefix(runs: StyledRun[], count: number): Inline[] {
  let left = count;
  const kept: StyledRun[] = [];
  for (const run of runs) {
    if (left >= run.text.length) {
      left -= run.text.length;
      continue;
    }
    kept.push({ ...run, text: run.text.slice(left) });
    left = 0;
  }
  return inlineRuns(kept);
}

interface MarkedParagraph {
  paragraph: Paragraph;
  marker: ListMarker;
  prefix: number;
}

function markedOf(paragraph: Paragraph): MarkedParagraph | null {
  const marker = parseListMarker(paragraph.text);
  if (marker === null) return null;
  return { paragraph, marker, prefix: paragraph.text.length - marker.rest.length };
}

/** The representative indent of the cluster `x` falls in (the first indent seen within tolerance), or `x` itself. */
function representative(reps: number[], x: number): number {
  return reps.find((candidate) => Math.abs(candidate - x) <= INDENT_TOLERANCE) ?? x;
}

/** The nesting level of an indent among the representatives of a list, left to right. */
function levelOf(reps: number[], x: number): number {
  const sorted = [...reps].sort((a, b) => a - b);
  return sorted.indexOf(representative(sorted, x));
}

export interface ListRun {
  /** Paragraphs [from, to) of the input are this list. */
  from: number;
  to: number;
  list: ListBlock;
}

/**
 * Lists among a paragraph sequence. `eligible` says which paragraphs may be items (not headings, in the same body flow).
 * Consecutive eligible paragraphs with markers that continue each other form one list; nesting follows indentation.
 */
export function assembleLists(paragraphs: Paragraph[], eligible: (paragraph: Paragraph) => boolean, nextId: () => number): ListRun[] {
  const runs: ListRun[] = [];
  let at = 0;
  while (at < paragraphs.length) {
    const start = eligible(paragraphs[at]) ? markedOf(paragraphs[at]) : null;
    if (start === null) {
      at++;
      continue;
    }
    const items: MarkedParagraph[] = [start];
    const reps: number[] = [start.paragraph.firstLineX];
    const lastAt = new Map<number, ListMarker>([[reps[0], start.marker]]);
    const countAt = new Map<number, number>([[reps[0], 1]]);
    let end = at + 1;
    for (; end < paragraphs.length; end++) {
      const next = eligible(paragraphs[end]) ? markedOf(paragraphs[end]) : null;
      if (next === null) break;
      const rep = representative(reps, next.paragraph.firstLineX);
      if (rep < Math.min(...reps) - INDENT_TOLERANCE) break;
      const previous = lastAt.get(rep);
      const deeper = rep > Math.max(...reps) + INDENT_TOLERANCE;
      if (previous !== undefined && !deeper) reconcileLetterAndRoman(previous, next.marker, countAt.get(rep) === 1);
      if (previous !== undefined && !deeper && !continues(previous, next.marker)) break;
      if (!reps.includes(rep)) reps.push(rep);
      // Back at a shallower indent, the deeper levels start over at their next item.
      for (const key of [...lastAt.keys()]) {
        if (key > rep + INDENT_TOLERANCE) {
          lastAt.delete(key);
          countAt.delete(key);
        }
      }
      lastAt.set(rep, next.marker);
      countAt.set(rep, (countAt.get(rep) ?? 0) + 1);
      items.push(next);
    }
    const strongSingle = items.length === 1 && start.marker.kind === 'bullet' && STRONG_BULLETS.has(start.marker.glyph);
    if (items.length < MIN_COUNTER_ITEMS && !strongSingle) {
      at++;
      continue;
    }
    runs.push({ from: at, to: end, list: listOf(items, reps, nextId()) });
    at = end;
  }
  return runs;
}

function listOf(items: MarkedParagraph[], reps: number[], id: number): ListBlock {
  const formats: ListLevelFormat[] = [];
  const listItems: ListItem[] = items.map((item) => {
    const level = Math.min(levelOf(reps, item.paragraph.firstLineX), MAX_LIST_LEVELS - 1);
    if (formats[level] === undefined) {
      formats[level] = { kind: item.marker.kind, punctuation: item.marker.punctuation, glyph: item.marker.glyph };
    }
    return { runs: dropPrefix(item.paragraph.runs, item.prefix), level, rtl: item.paragraph.rtl, value: item.marker.value };
  });
  // A level the list never uses is filled with the format of the level above it.
  for (let level = 0; level < formats.length; level++) {
    formats[level] = formats[level] ?? formats[level - 1] ?? { kind: 'bullet', punctuation: 'dot', glyph: '•' };
  }
  return { type: 'list', id, levels: formats, items: listItems };
}
