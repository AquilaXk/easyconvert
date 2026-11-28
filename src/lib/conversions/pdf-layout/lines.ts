import { hexOf } from '../pdf-content-colours';
import type { PdfContentItem } from '../pdf-text-types';
import { withoutDuplicates } from './duplicates';
import { LayoutBudget } from './limits';
import { directionBalance, isDigit, isLetter, isRightToLeftLetter, isUnspacedScript, isWhitespace, firstChar, lastChar } from './text-chars';
import type { FontList, LayoutLine, Row, StyledRun } from './types';

/**
 * Rows and lines from positioned text runs (ISO 32000-2 section 9.4: a run is a string shown at one origin).
 *
 * Runs on one baseline form a row. A gap wider than SEGMENT_GAP_EM inside a row splits it into segments, which are
 * the pieces columns and table cells are made of; a gap wider than SPACE_GAP_EM inside a segment is a word space.
 * Within a segment the runs are put in logical order: right-to-left text is drawn in visual order, so a segment
 * with right-to-left letters is reordered by directional runs (the two-level case of UAX #9 rule L2), not by one
 * reversal.
 */

/** A gap wider than this many em between two runs is a word space. */
const SPACE_GAP_EM = 0.15;
/** A gap wider than this many em between two runs of unspaced script is a word space. */
const CJK_SPACE_GAP_EM = 0.6;
/** A gap wider than this many em splits a row into segments. */
const SEGMENT_GAP_EM = 1.0;
/** Share of a text run's em box above and below the baseline. */
const ASCENT_EM = 0.8;
const DESCENT_EM = 0.2;
/** Two runs are on one row when their vertical extents overlap by at least this share of the smaller one. */
const ROW_OVERLAP_SHARE = 0.5;
/** How many recent rows a run is compared with before it starts a new row. */
const OPEN_ROWS = 8;

type Direction = 'L' | 'R';

interface Pending {
  items: PdfContentItem[];
  top: number;
  bottom: number;
}

function intervalOf(item: PdfContentItem): { top: number; bottom: number } {
  return { top: item.baseline - ASCENT_EM * item.size, bottom: item.baseline + DESCENT_EM * item.size };
}

function overlapShare(top: number, bottom: number, other: { top: number; bottom: number }): number {
  const overlap = Math.min(bottom, other.bottom) - Math.max(top, other.top);
  const smaller = Math.min(bottom - top, other.bottom - other.top);
  return smaller > 0 ? overlap / smaller : 0;
}

function clusterRuns(items: PdfContentItem[], budget: LayoutBudget): PdfContentItem[][] {
  const sorted = [...items].sort((a, b) => a.baseline - b.baseline || a.x - b.x);
  const rows: Pending[] = [];
  for (const item of sorted) {
    const { top, bottom } = intervalOf(item);
    let target: Pending | undefined;
    for (let i = rows.length - 1; i >= 0 && i >= rows.length - OPEN_ROWS; i--) {
      budget.tick();
      if (overlapShare(top, bottom, rows[i]) >= ROW_OVERLAP_SHARE) {
        target = rows[i];
        break;
      }
    }
    if (target) {
      // The row keeps the extent of its first run: letting it grow would let a tall run in one column chain the
      // lines of its neighbour column into one row.
      target.items.push(item);
    } else {
      rows.push({ items: [item], top, bottom });
    }
  }
  return rows.map((row) => row.items);
}

// ---------------------------------------------------------------------------------------------
// Logical order
// ---------------------------------------------------------------------------------------------

/** Strong direction of one run: R when it has right-to-left letters, L when it has other letters or digits. */
function strongDirection(text: string): Direction | null {
  let sawLeft = false;
  for (const char of text) {
    if (isRightToLeftLetter(char)) return 'R';
    if (isLetter(char) || isDigit(char)) sawLeft = true;
  }
  return sawLeft ? 'L' : null;
}

/**
 * Runs of a visually ordered segment in logical order. Neutral runs (white space, punctuation) take the direction
 * of their neighbours when both agree and the base direction otherwise; the visual sequence is split into
 * directional groups, the groups are reversed when the base direction is right to left, and a right-to-left group
 * is reversed inside.
 */
function logicalOrder(visual: PdfContentItem[], base: Direction): PdfContentItem[] {
  const strong = visual.map((item) => strongDirection(item.text));
  const resolved: Direction[] = strong.map((direction) => direction ?? base);
  for (let i = 0; i < visual.length; i++) {
    if (strong[i] !== null) continue;
    let before: Direction | null = null;
    for (let j = i - 1; j >= 0 && before === null; j--) before = strong[j];
    let after: Direction | null = null;
    for (let j = i + 1; j < visual.length && after === null; j++) after = strong[j];
    resolved[i] = before !== null && before === after ? before : base;
  }
  const groups: { direction: Direction; items: PdfContentItem[] }[] = [];
  visual.forEach((item, index) => {
    const last = groups[groups.length - 1];
    if (last && last.direction === resolved[index]) last.items.push(item);
    else groups.push({ direction: resolved[index], items: [item] });
  });
  const ordered = base === 'R' ? groups.slice().reverse() : groups;
  const result: PdfContentItem[] = [];
  for (const group of ordered) {
    result.push(...(group.direction === 'R' ? group.items.slice().reverse() : group.items));
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------------------------

/** Distance between the nearest edges of two runs on a row; negative when they overlap. */
function gapBetween(a: PdfContentItem, b: PdfContentItem): number {
  return Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width));
}

/** Space to put between two runs that are neighbours in reading order. */
function separator(before: PdfContentItem, after: PdfContentItem): string {
  if (before.text === '' || after.text === '') return '';
  const left = lastChar(before.text);
  const right = firstChar(after.text);
  if (isWhitespace(left) || isWhitespace(right)) return '';
  const size = Math.max(before.size, after.size);
  const gap = gapBetween(before, after);
  if (isUnspacedScript(left) && isUnspacedScript(right)) return gap > CJK_SPACE_GAP_EM * size ? ' ' : '';
  return gap > SPACE_GAP_EM * size ? ' ' : '';
}

function styleOf(item: PdfContentItem, fonts: FontList): Omit<StyledRun, 'text'> {
  const font = item.font >= 0 ? fonts[item.font] : undefined;
  return { bold: font?.bold ?? false, italic: font?.italic ?? false, monospace: font?.monospace ?? false };
}

function sameStyle(a: Omit<StyledRun, 'text'>, b: Omit<StyledRun, 'text'>): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.monospace === b.monospace &&
    a.color === b.color &&
    a.fill === b.fill &&
    Boolean(a.superscript) === Boolean(b.superscript) &&
    Boolean(a.subscript) === Boolean(b.subscript)
  );
}

/** Upper ratio to the dominant line size for superscripts and subscripts. */
const SCRIPT_MAX_SIZE_RATIO = 0.82;
/** Minimum baseline shift (in dominant em) separating a script mark from baseline text. */
const SCRIPT_MIN_SHIFT_EM = 0.15;
/** Maximum non-space characters for a small shifted run to count as a script mark rather than a subheading. */
const SCRIPT_MAX_CHARS = 6;
const SIZE_PRECISION = 10;

function scriptOf(item: PdfContentItem, dominantSize: number, baseline: number): Pick<StyledRun, 'superscript' | 'subscript'> {
  const trimmed = item.text.trim();
  if (dominantSize <= 0 || trimmed === '' || trimmed.length > SCRIPT_MAX_CHARS || /\s/u.test(trimmed) || item.size > SCRIPT_MAX_SIZE_RATIO * dominantSize) {
    return {};
  }
  const rise = baseline - item.baseline;
  if (rise >= SCRIPT_MIN_SHIFT_EM * dominantSize) return { superscript: true };
  if (-rise >= SCRIPT_MIN_SHIFT_EM * dominantSize) return { subscript: true };
  return {};
}

/** The pieces of an item's text with their colours (black pieces have none): the whole text when the item has no colour. */
function colouredPieces(item: PdfContentItem): { text: string; color?: string }[] {
  if (!item.colors) return [{ text: item.text }];
  const pieces: { text: string; color?: string }[] = [];
  let from = 0;
  for (const { end, color } of item.colors) {
    if (end > from) pieces.push(color === 0 ? { text: item.text.slice(from, end) } : { text: item.text.slice(from, end), color: hexOf(color) });
    from = end;
  }
  return from < item.text.length ? [...pieces, { text: item.text.slice(from) }] : pieces;
}

interface DominantLineStyle {
  size: number;
  bold: boolean;
  italic: boolean;
  monospace: boolean;
  name: string;
}

function dominantStyleOf(logical: readonly PdfContentItem[], fonts: FontList): DominantLineStyle {
  const weight = new Map<string, { chars: number } & DominantLineStyle>();
  for (const item of logical) {
    const style = styleOf(item, fonts);
    const font = item.font >= 0 ? fonts[item.font] : undefined;
    const key = `${Math.round(item.size * SIZE_PRECISION)}|${font?.name ?? ''}`;
    const entry = weight.get(key) ?? { chars: 0, size: item.size, ...style, name: font?.name ?? '' };
    entry.chars += item.text.trim().length;
    weight.set(key, entry);
  }
  let dominant: { chars: number } & DominantLineStyle = { chars: -1, size: logical[0]?.size ?? 0, bold: false, italic: false, monospace: false, name: '' };
  for (const entry of weight.values()) if (entry.chars > dominant.chars) dominant = entry;
  return dominant;
}

/** Appends a styled piece to `runs`, merging matching styles and baseline spaces. */
function pushStyledPiece(runs: StyledRun[], pieceText: string, pieceStyle: Omit<StyledRun, 'text'>): void {
  const previous = runs[runs.length - 1];
  const isBaseline = !previous?.superscript && !previous?.subscript && !pieceStyle.superscript && !pieceStyle.subscript;
  if (previous && (sameStyle(previous, pieceStyle) || (pieceText.trim() === '' && isBaseline && sameStyle(previous, { ...pieceStyle, color: previous.color })))) {
    previous.text += pieceText;
  } else {
    runs.push({ text: pieceText, ...pieceStyle });
  }
}

/** The line a segment of runs makes: text in logical order, style runs, box and the style most characters have. */
export function lineFromItems(items: PdfContentItem[], fonts: FontList): LayoutLine {
  const visual = [...items].sort((a, b) => a.x - b.x);
  const rtl = directionBalance(visual.map((item) => item.text).join('')) > 0;
  const logical = logicalOrder(visual, rtl ? 'R' : 'L');
  const dominant = dominantStyleOf(logical, fonts);
  const baseline = dominantBaseline(items, dominant.size);
  const runs: StyledRun[] = [];
  let text = '';
  logical.forEach((item, index) => {
    const joint = index === 0 ? '' : separator(logical[index - 1], item);
    const baseStyle = styleOf(item, fonts);
    const script = scriptOf(item, dominant.size, baseline);
    if (joint !== '' && runs.length > 0) {
      const last = runs[runs.length - 1];
      if (!last.superscript && !last.subscript) last.text += joint;
      else pushStyledPiece(runs, joint, baseStyle);
    }
    for (const part of colouredPieces(item)) {
      const partBase = { ...baseStyle, ...(part.color === undefined ? {} : { color: part.color }), ...(item.fill === undefined || part.color === undefined ? {} : { fill: hexOf(item.fill) }) };
      const partStyle = { ...partBase, ...script };
      if ((script.superscript || script.subscript) && /\s/u.test(part.text)) {
        const split = /^(\s*)(\S+)(\s*)$/u.exec(part.text);
        if (split) {
          if (split[1] !== '') pushStyledPiece(runs, split[1], partBase);
          pushStyledPiece(runs, split[2], partStyle);
          if (split[3] !== '') pushStyledPiece(runs, split[3], partBase);
        } else {
          pushStyledPiece(runs, part.text, partBase);
        }
      } else {
        pushStyledPiece(runs, part.text, partStyle);
      }
    }
    text += joint + item.text;
  });
  const x0 = Math.min(...items.map((item) => item.x));
  const x1 = Math.max(...items.map((item) => item.x + item.width));
  return {
    runs,
    text,
    box: { x0, x1, y0: baseline - ASCENT_EM * dominant.size, y1: baseline + DESCENT_EM * dominant.size },
    baseline,
    size: dominant.size,
    bold: dominant.bold,
    italic: dominant.italic,
    monospace: dominant.monospace,
    rtl,
    fontKey: dominant.name,
    vertical: false,
  };
}

/** The baseline of the runs that have the dominant size (a superscript or subscript must not move the line). */
function dominantBaseline(items: PdfContentItem[], size: number): number {
  const main = items.filter((item) => Math.abs(item.size - size) < size / SIZE_PRECISION + 1e-6);
  const source = main.length > 0 ? main : items;
  return source.reduce((sum, item) => sum + item.baseline, 0) / source.length;
}

export function splitSegments(row: PdfContentItem[], gapEm: number = SEGMENT_GAP_EM): PdfContentItem[][] {
  const sorted = [...row].sort((a, b) => a.x - b.x);
  const segments: PdfContentItem[][] = [];
  let reach = Number.NEGATIVE_INFINITY;
  for (const item of sorted) {
    const current = segments[segments.length - 1];
    if (current && item.x - reach <= gapEm * Math.max(item.size, current[current.length - 1].size)) {
      current.push(item);
    } else {
      segments.push([item]);
    }
    reach = Math.max(reach, item.x + item.width);
  }
  return segments;
}

/**
 * Rows of a page's horizontal runs, top to bottom, each with its segments left to right. White-space-only runs are
 * dropped: the gaps between the remaining runs decide where spaces go.
 */
export function buildRows(items: PdfContentItem[], fonts: FontList, budget: LayoutBudget): Row[] {
  const usable = items.filter((item) => !item.angled && !item.vertical && item.text.trim() !== '');
  const clusters = clusterRuns(withoutDuplicates(usable, budget), budget);
  const rows: Row[] = clusters.map((cluster) => {
    const segments = splitSegments(cluster).map((segment) => lineFromItems(segment, fonts));
    budget.tick(cluster.length);
    const dominant = segments.reduce((best, line) => (line.size > best.size ? line : best), segments[0]);
    return {
      segments,
      baseline: dominant.baseline,
      top: Math.min(...segments.map((line) => line.box.y0)),
      bottom: Math.max(...segments.map((line) => line.box.y1)),
      items: cluster,
    };
  });
  return rows.sort((a, b) => a.baseline - b.baseline);
}
