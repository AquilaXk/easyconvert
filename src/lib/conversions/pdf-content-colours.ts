import type { PdfContentColour } from './pdf-text-types';

/**
 * The colour of shown text. pdf.js reports text content without colour, so the colours are taken from the page's operator
 * list: each shown glyph is recorded with the fill colour in force when it was shown (the stroke colour when the text render
 * mode strokes only), in drawing order, and the text items of `getTextContent()` (which follow the same order) are spelled
 * from that list the way the word geometry of `pdf-text-geometry.ts` spells them from its glyph list.
 */

/** A colour as 0xRRGGBB. */
export type Rgb = number;

export const BLACK: Rgb = 0;
const HEX_COLOR = /^#([0-9a-f]{6})$/i;
const HEX_RADIX = 16;
/** pdf.js passes `#rrggbb` for every device colour it has converted (RGB, gray, CMYK, ICC, Lab, indexed, separation). */
export function parseColour(value: unknown): Rgb | null {
  if (typeof value !== 'string') return null;
  const match = HEX_COLOR.exec(value);
  return match ? Number.parseInt(match[1], HEX_RADIX) : null;
}

/** A glyph of the page with its text, the same text in compatibility form (pdf.js folds ligatures) and its colour. */
interface ColouredGlyph {
  text: string;
  folded: string;
  color: Rgb;
}

/** The text render modes that only stroke the outlines (1 and 5) paint with the stroke colour. */
const STROKE_ONLY_MODES: ReadonlySet<number> = new Set([1, 5]);
/** How far ahead of the last match a text item may start (glyphs that no item spells: annotations, left-out glyphs). */
const RESYNC_WINDOW = 256;
const MAX_CONSECUTIVE_MISMATCHES = 16;
const STEPS_PER_CHAR = 8;
const STEPS_MIN = 4096;
const STEPS_PER_PAGE = 5_000_000;

/** The glyphs of the text-showing operators of a page, in drawing order, with their colours. */
export class GlyphColours {
  readonly glyphs: ColouredGlyph[] = [];

  /** Records the glyphs of one shown string (an entry of pdf.js's `showText` operand list; numbers are TJ adjustments). */
  show(shown: unknown, fill: Rgb | null, stroke: Rgb | null, renderMode: number): void {
    if (!Array.isArray(shown)) return;
    const color = (STROKE_ONLY_MODES.has(renderMode) ? stroke : fill) ?? BLACK;
    for (const entry of shown) {
      const unicode = (entry as { unicode?: unknown } | null)?.unicode;
      if (typeof unicode === 'string') this.glyphs.push({ text: unicode, folded: unicode.normalize('NFKC'), color });
    }
  }
}

const isSpace = (char: string): boolean => char === ' ' || char === ' ' || char === '\t' || char === '\n';

/** The glyph's text where `text` has it at `at`, or null. */
function spelling(text: string, glyph: ColouredGlyph, at: number): string | null {
  if (text.startsWith(glyph.text, at)) return glyph.text;
  return glyph.folded !== glyph.text && text.startsWith(glyph.folded, at) ? glyph.folded : null;
}

/**
 * Walks the glyphs from `start` over `text`, writing the colour of each unit into `colors` when it is given. Returns the index
 * after the last glyph used, or -1 when the glyphs do not spell the text. A space pdf.js put between glyphs has no glyph of its own.
 */
function walk(text: string, glyphs: readonly ColouredGlyph[], start: number, colors: Rgb[] | null, budget: { left: number }): number {
  let at = 0;
  let index = start;
  while (at < text.length) {
    if (index >= glyphs.length || budget.left-- <= 0) return -1;
    const glyph = glyphs[index];
    const shown = spelling(text, glyph, at);
    if (shown === '') {
      index++;
    } else if (shown !== null) {
      if (colors) colors.fill(glyph.color, at, at + shown.length);
      at += shown.length;
      index++;
    } else if (isSpace(text[at])) {
      if (colors) colors[at] = at > 0 ? colors[at - 1] : glyph.color;
      at++;
    } else {
      return -1;
    }
  }
  return index;
}

/** The stretches of one colour in a per-unit colour list; undefined when the whole text is black. */
function stretchesOf(colors: readonly Rgb[]): PdfContentColour[] | undefined {
  const stretches: PdfContentColour[] = [];
  for (let i = 0; i < colors.length; i++) {
    const last = stretches[stretches.length - 1];
    if (last && last.color === colors[i]) last.end = i + 1;
    else stretches.push({ end: i + 1, color: colors[i] });
  }
  return stretches.every((stretch) => stretch.color === BLACK) ? undefined : stretches;
}

/** Reads the colours of the text items of a page one after another, in the order the page shows them. */
export class ItemColours {
  private next = 0;
  private failures = 0;
  private steps = 0;

  constructor(private readonly glyphs: readonly ColouredGlyph[]) {}

  /** The colour stretches of an item's text; undefined when the text is black or the glyphs do not spell it. */
  of(text: string): PdfContentColour[] | undefined {
    if (this.glyphs.length === 0 || this.failures >= MAX_CONSECUTIVE_MISMATCHES || text.length === 0) return undefined;
    const budget = { left: Math.min(Math.max(STEPS_MIN, STEPS_PER_CHAR * text.length), STEPS_PER_PAGE - this.steps) };
    const allowed = budget.left;
    let found = -1;
    let from = this.next;
    for (let offset = 0; offset <= RESYNC_WINDOW && budget.left > 0; offset++) {
      from = this.next + offset;
      found = walk(text, this.glyphs, from, null, budget);
      if (found >= 0) break;
    }
    this.steps += allowed - Math.max(budget.left, 0);
    if (found < 0) {
      this.failures++;
      return undefined;
    }
    const colors = new Array<Rgb>(text.length).fill(BLACK);
    walk(text, this.glyphs, from, colors, { left: Number.POSITIVE_INFINITY });
    this.failures = 0;
    this.next = found;
    return stretchesOf(colors);
  }
}
