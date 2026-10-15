import { splitIntoFontRuns, type PdfFontFace } from './pdf-fonts';

/**
 * Line breaking by measured advance widths, for the writers that place text themselves (XPS pages, SVG
 * pages): the width of a string is the sum of the advances of the fonts that cover it, so text wraps where it
 * stops fitting, not at a guessed character count.
 */

const GLYPH_CLUSTER = /\P{M}\p{M}*/gu;
const SPACE_RUNS = /( +)/;
const TRAILING_SPACES = / +$/;

export interface PlacedRun {
  text: string;
  face: PdfFontFace;
  /** Horizontal origin of the run, from the origin given to `place`. */
  x: number;
}

/** Measures text with the installed fonts that cover it; advances are cached per font and string. */
export class TextMeter {
  private readonly advances = new Map<string, number>();

  runsOf(text: string): { text: string; face: PdfFontFace }[] {
    return splitIntoFontRuns([{ text }]).map(({ text: runText, face }) => ({ text: runText, face }));
  }

  /** Advance of the text in the face's own units per em, scaled to `size`. */
  private runWidth(face: PdfFontFace, text: string, size: number): number {
    const key = `${face.id}\u0000${text}`;
    let advance = this.advances.get(key);
    if (advance === undefined) {
      advance = face.font.layout(text).advanceWidth / face.font.unitsPerEm;
      this.advances.set(key, advance);
    }
    return advance * size;
  }

  width(text: string, size: number): number {
    return this.runsOf(text).reduce((sum, run) => sum + this.runWidth(run.face, run.text, size), 0);
  }

  /** The runs of one line, each with its horizontal origin starting at `x`. */
  place(text: string, x: number, size: number): PlacedRun[] {
    const placed: PlacedRun[] = [];
    let cursor = x;
    for (const run of this.runsOf(text)) {
      placed.push({ text: run.text, face: run.face, x: cursor });
      cursor += this.runWidth(run.face, run.text, size);
    }
    return placed;
  }
}

/**
 * Breaks one line of text into lines no wider than `limit` at `size`: at spaces, and inside a word that is
 * wider than a whole line. Spaces at a wrap point end the line and are dropped; nothing else is lost.
 */
export function wrapText(text: string, meter: TextMeter, limit: number, size: number): string[] {
  const lines: string[] = [];
  let line = '';
  let lineWidth = 0;
  const flush = (): void => {
    lines.push(line.replace(TRAILING_SPACES, ''));
    line = '';
    lineWidth = 0;
  };
  for (const token of text.split(SPACE_RUNS)) {
    if (token === '') continue;
    const width = meter.width(token, size);
    if (lineWidth + width <= limit) {
      line += token;
      lineWidth += width;
    } else if (token.trim() === '') {
      if (line) flush();
    } else {
      if (line) flush();
      if (width <= limit) {
        line = token;
        lineWidth = width;
      } else {
        for (const [cluster] of token.matchAll(GLYPH_CLUSTER)) {
          const clusterWidth = meter.width(cluster, size);
          if (line && lineWidth + clusterWidth > limit) flush();
          line += cluster;
          lineWidth += clusterWidth;
        }
      }
    }
  }
  if (line || lines.length === 0) flush();
  return lines;
}
