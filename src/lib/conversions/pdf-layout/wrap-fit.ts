import { Encodings, Font, FontNames } from '@pdf-lib/standard-fonts';
import type { Paragraph, StyledRun } from './types';

/**
 * Where a paragraph of a kept page wraps, from the widths of the face the writer sets it in. The writer sets the text in Times New Roman,
 * Arial or Courier New, which the office suite draws with faces of the widths of Adobe's Times, Helvetica and Courier, so how the writer
 * breaks the paragraph's words into lines is known for any right indent. The page broke the paragraph into lines of its own: the right
 * indent is the one at which most of the page's lines start where the writer's start, and among those the one nearest the page's right
 * edge, so a justified line ends where the page's did. A word the page cut with a hyphen is one word in the writer, so the line that
 * starts with its end is no line the writer can start.
 */

export type WriterFamily = 'serif' | 'sans' | 'monospace';

const FACES: Record<WriterFamily, readonly [string, string, string, string]> = {
  serif: [FontNames.TimesRoman, FontNames.TimesRomanBold, FontNames.TimesRomanItalic, FontNames.TimesRomanBoldItalic],
  sans: [FontNames.Helvetica, FontNames.HelveticaBold, FontNames.HelveticaOblique, FontNames.HelveticaBoldOblique],
  monospace: [FontNames.Courier, FontNames.CourierBold, FontNames.CourierOblique, FontNames.CourierBoldOblique],
};
const PER_MILLE = 1000;
const PERCENT = 100;
/** Points either side of a width at which a word fits that the candidate indents are set, so that a width the office suite measures a hair other than the table's does not move a break. */
/** Least width in points of a span of indents that break alike for it to be one an indent is taken in. */
const MIN_SPAN_PT = 0.1;
const FIT_MARGIN_PT = 1.5;
/** A line the page broke inside a word: the hyphen at its end, after a letter. */
/** Lines of the page's starts that an extra line of the writer is worth: an extra line pushes what follows down the page. */
const EXTRA_LINE_COST = 3;
const CUT_WORD = /\p{L}[\p{Pd}­]$/u;

const loaded = new Map<string, Font>();

function faceOf(name: string): Font {
  let face = loaded.get(name);
  if (!face) {
    face = Font.load(name as FontNames);
    loaded.set(name, face);
  }
  return face;
}

/** The width in points of a stretch of text in a face, or undefined when the face has no glyph for one of its characters. */
function widthOf(face: Font, text: string, size: number): number | undefined {
  let units = 0;
  for (const character of text) {
    const code = character.codePointAt(0) as number;
    if (!Encodings.WinAnsi.canEncodeUnicodeCodePoint(code)) return undefined;
    const glyph = face.getWidthOfGlyph(Encodings.WinAnsi.encodeUnicodeCodePoint(code).name);
    if (glyph === undefined) return undefined;
    units += glyph;
  }
  return (units * size) / PER_MILLE;
}

/** A word of a paragraph as the writer sets it: its width, and the width of the space that stands before it. */
interface Word {
  width: number;
  gap: number;
}

/** Measures the words of paragraphs in the face the writer sets a document in. */
export class WrapMetrics {
  constructor(private readonly family: WriterFamily) {}

  private face(run: Pick<StyledRun, 'bold' | 'italic' | 'monospace'>): Font {
    const family = run.monospace ? 'monospace' : this.family;
    return faceOf(FACES[family][(run.bold ? 1 : 0) + (run.italic ? 2 : 0)]);
  }

  /** The width in points of `text` set in the face of a run of that style at `size`, or undefined for a character the faces lack. */
  textWidth(style: Pick<StyledRun, 'bold' | 'italic' | 'monospace'>, text: string, size: number): number | undefined {
    return widthOf(this.face(style), text, size);
  }

  /** The words of the runs, split at white space, or undefined for a character the faces lack. */
  wordsOf(runs: readonly StyledRun[], size: number): Word[] | undefined {
    const words: Word[] = [];
    let open = false;
    let gap = 0;
    for (const run of runs) {
      const face = this.face(run);
      for (const piece of run.text.split(/(\s+)/u)) {
        if (piece === '') continue;
        if (/^\s+$/u.test(piece)) {
          const space = widthOf(face, piece, size);
          if (space === undefined) return undefined;
          gap = (space * (run.widthPercent ?? PERCENT)) / PERCENT;
          open = false;
          continue;
        }
        const natural = widthOf(face, piece, size);
        if (natural === undefined) return undefined;
        const width = (natural * (run.widthPercent ?? PERCENT)) / PERCENT;
        if (open) words[words.length - 1].width += width;
        else words.push({ width, gap: words.length === 0 ? 0 : gap });
        open = true;
      }
    }
    return words;
  }
}

/** The index of the word each line of the page starts with, or undefined where the line starts inside a word the page cut. */
function lineStarts(paragraph: Paragraph): (number | undefined)[] {
  const starts: (number | undefined)[] = [];
  let cursor = 0;
  let continued = false;
  for (const line of paragraph.lines) {
    const count = line.text.trim() === '' ? 0 : line.text.trim().split(/\s+/u).length;
    starts.push(continued ? undefined : cursor);
    cursor += count - (continued ? 1 : 0);
    continued = CUT_WORD.test(line.text.trimEnd());
  }
  return starts;
}

/** The indices at which a greedy wrap of `words` starts a line when each line has `room(index)` points. */
function wrapStarts(words: readonly Word[], room: (line: number) => number): Set<number> {
  const starts = new Set<number>();
  let at = 0;
  let line = 0;
  while (at < words.length) {
    starts.add(at);
    const limit = room(line++);
    let width = words[at].width;
    let next = at + 1;
    while (next < words.length && width + words[next].gap + words[next].width <= limit) width += words[next].gap + words[next++].width;
    at = next;
  }
  return starts;
}

/**
 * The right indent for the paragraph, or undefined where the faces cannot tell.
 * @param baseOf the width the writer has for a line before the right indent: the text area less the left indent, and less the first-line indent for the first
 * @param preferred the right indent that puts the writer's right edge where the page's was, which wins among indents that break equally well
 */
export function wrappingIndent(paragraph: Paragraph, size: number, metrics: WrapMetrics, baseOf: (line: number) => number, preferred: number): number | undefined {
  const words = metrics.wordsOf(paragraph.runs, size);
  if (!words || words.length === 0) return undefined;
  const wanted = lineStarts(paragraph);
  const known = wanted.filter((start): start is number => start !== undefined);
  // The indents at which a line of the writer starts or stops fitting a word: the widths of the page's lines and of the line with the next word.
  const edges: number[] = [];
  let at = 0;
  paragraph.lines.forEach((line, index) => {
    const lineWords = line.text.trim() === '' ? 0 : line.text.trim().split(/\s+/u).length;
    const taken = words.slice(at, at + lineWords);
    if (taken.length > 0) {
      const width = taken.reduce((sum, word, position) => sum + word.width + (position === 0 ? 0 : word.gap), 0);
      const room = baseOf(index);
      edges.push(room - width);
      const after = words[at + lineWords];
      if (after) edges.push(room - width - after.gap - after.width);
    }
    at += lineWords - (wanted[index + 1] === undefined ? 1 : 0);
  });
  edges.sort((a, b) => a - b);
  // Between two edges the writer breaks the paragraph one way; the indent is kept clear of the edges, which the office suite may measure a hair off.
  const bounds = [edges[0] - FIT_MARGIN_PT * 2, ...edges, edges[edges.length - 1] + FIT_MARGIN_PT * 2];
  let best: { indent: number; score: number; distance: number } | undefined;
  for (let index = 0; index + 1 < bounds.length; index++) {
    const [low, high] = [bounds[index], bounds[index + 1]];
    if (high - low < MIN_SPAN_PT) continue;
    const starts = wrapStarts(words, (line) => baseOf(line) - (low + high) / 2);
    const score = known.filter((start) => starts.has(start)).length - EXTRA_LINE_COST * Math.abs(starts.size - paragraph.lines.length);
    const margin = Math.min(FIT_MARGIN_PT, (high - low) / 3);
    const indent = Math.min(high - margin, Math.max(low + margin, preferred));
    const distance = Math.abs(indent - preferred);
    if (!best || score > best.score || (score === best.score && distance < best.distance)) best = { indent, score, distance };
  }
  return best?.indent;
}
