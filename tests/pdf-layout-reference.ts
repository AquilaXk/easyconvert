import type { OpenParagraph } from '../src/lib/conversions/pdf-layout/paragraphs';
import { firstChar, isLetter, isLowercase, lastChar, needsSpaceBetween } from '../src/lib/conversions/pdf-layout/text-chars';
import type { LayoutLine, Paragraph, StyledRun } from '../src/lib/conversions/pdf-layout/types';

/**
 * The paragraph join and the reading of a finished paragraph as they were before `ParagraphBuilder` (`joinLines`, `paragraphOf`
 * and `continuesInNextFlow` of the commit before #930), and a seeded generator of lines, for the tests that hold the builder and the
 * joining of runs to them. A line holds text: the old join did not end on a line of no text that follows a hyphen.
 */

export const HYPHENS = new Set(['-', '­', '‐', '‑']);
const SENTENCE_END = /[.!?:;。！？…”"')\]]$/u;
const TAIL_UNITS = 8;

function trailingHyphen(tail: string): string | null {
  const last = lastChar(tail);
  if (!HYPHENS.has(last)) return null;
  const before = Array.from(tail.slice(0, tail.length - last.length));
  const letter = before.length >= 1 ? before[before.length - 1] : '';
  return isLetter(letter) ? last : null;
}

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
        // kept: a hyphen before a capital letter or a digit is part of the compound
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

export function paragraphOf(lines: LayoutLine[], flow: number, pageNumber: number, full: boolean): Paragraph {
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

/** What `continuesInNextFlow` read of a finished paragraph. */
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
    endsSentence: SENTENCE_END.test(paragraph.text.trimEnd()),
  };
}

export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LOWER = ['the', 'tower', 'and', 'administration', 'of', 'copying', 'one', 'two', 'six', 'ten', 'a', 'x'];
const CAPITAL = ['Anglo', 'Saxon', 'Tower', 'The', 'Zed', 'Ant'];
const DIGITS = ['42', '3.14', '1999', '7'];
const RIGHT_TO_LEFT = ['שלום', 'עולם', 'مرحبا', 'كتاب'];
const UNSPACED = ['日本語', '한국어', '文章', 'ひらがな'];
const ASTRAL = ['𝒳𝒴', '𝔄𝔅', 'a𝒳'];
const WORDS = [LOWER, LOWER, LOWER, CAPITAL, DIGITS, RIGHT_TO_LEFT, UNSPACED, ASTRAL];
/** What a line ends with: plain, a sentence end, white space, and the four hyphens a break inside a word leaves. */
const ENDINGS = ['', '', '', '', '.', '. ', '?', ':', ')', '”', ' ', '   ', '-', '-', '‐', '­', '‑', '.)'];
/** What a line starts with after a line that ended in a hyphen: a lower-case letter (the word rejoins), a capital or a digit (the compound stays). */
const STARTS = ['', '', '', '', ' ', '(', '“', '-'];

interface Style {
  bold: boolean;
  italic: boolean;
  monospace: boolean;
}

const STYLES: Style[] = [0, 1, 2, 3, 4, 5, 6, 7].map((bits) => ({ bold: (bits & 1) !== 0, italic: (bits & 2) !== 0, monospace: (bits & 4) !== 0 }));

export function generateLine(random: () => number, index: number): LayoutLine {
  const pick = <T,>(values: readonly T[]): T => values[Math.floor(random() * values.length)];
  const roll = random();
  let text: string;
  if (roll < 0.04) text = ' ';
  else if (roll < 0.15) text = pick(['-', '.', 'a', '3', '‐', '?']);
  else {
    const words = Array.from({ length: 1 + Math.floor(random() * 5) }, () => pick(pick(WORDS)));
    text = pick(STARTS) + words.join(random() < 0.9 ? ' ' : '') + pick(ENDINGS);
  }
  const units = Array.from(text);
  const cuts = new Set<number>();
  const pieceCount = Math.min(units.length, 1 + Math.floor(random() * 3));
  while (cuts.size < pieceCount - 1) cuts.add(1 + Math.floor(random() * (units.length - 1)));
  const bounds = [0, ...[...cuts].sort((a, b) => a - b), units.length];
  const base = pick(STYLES);
  const runs: StyledRun[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    runs.push({ text: units.slice(bounds[i], bounds[i + 1]).join(''), ...(random() < 0.6 ? base : pick(STYLES)) });
  }
  const lineStyle = random() < 0.7 ? base : pick(STYLES);
  const x0 = Math.floor(random() * 40);
  const y0 = index * 14 + Math.floor(random() * 3);
  return {
    runs,
    text,
    box: { x0, x1: x0 + Math.floor(random() * 400), y0, y1: y0 + 10 + Math.floor(random() * 3) },
    baseline: y0 + 9,
    size: pick([10, 12, 12, 14]),
    ...lineStyle,
    rtl: random() < 0.2,
    fontKey: pick(['Body', 'Body', 'Other']),
    vertical: false,
  };
}

/** Lines in pages: a run that goes on over several pages is added a page at a time, as `joinContinuations` adds it. */
export function generateRun(random: () => number): LayoutLine[][] {
  const pageCount = 1 + Math.floor(random() * 6);
  let index = 0;
  return Array.from({ length: pageCount }, () => Array.from({ length: 1 + Math.floor(random() * (random() < 0.1 ? 40 : 6)) }, () => generateLine(random, index++)));
}


/** A line of running prose: one size and weight and a full measure, so that paragraphs of such lines carry on into one another. */
export function generateProseLine(random: () => number, index: number): LayoutLine {
  const line = generateLine(random, index);
  const x0 = Math.floor(random() * 6);
  return {
    ...line,
    runs: line.runs.map((run) => ({ ...run, bold: false, italic: false, monospace: false })),
    box: { ...line.box, x0, x1: 380 + Math.floor(random() * 20) },
    size: 12,
    bold: false,
    italic: false,
    monospace: false,
    rtl: false,
    fontKey: 'Body',
  };
}
