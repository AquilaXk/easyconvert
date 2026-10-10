import type { PdfFontFace } from '../pdf-fonts';
import type { LayoutLine, LayoutPiece } from './paragraph-layout';

/**
 * Draws laid-out lines into a pdfkit document. pdfkit embeds the font subset, writes the width array and the
 * ToUnicode map, and emits the TJ operator with per-glyph advances and offsets. This module only replaces the step
 * where pdfkit shapes a string: the embedded font's `layout` hands pdfkit the glyphs the shaping engine chose.
 *
 * Text that is displayed in a different order than it is read (reordered Indic vowel signs, ligatures that stand for
 * several characters) is wrapped in marked content with ActualText, so that extraction tools return the characters in
 * logical order. Right-to-left runs are not wrapped: they are drawn in display order with one ToUnicode entry per
 * glyph, which is the form text extraction tools reorder themselves.
 */

const PDF_THOUSANDTHS_PER_EM = 1000;

/** The glyph record pdfkit reads from a layout result. */
interface PdfkitGlyph {
  readonly id: number;
  /** Nominal advance in font units. */
  readonly advanceWidth: number;
  readonly codePoints: number[];
}

interface PdfkitPosition {
  xAdvance: number;
  yAdvance: number;
  xOffset: number;
  yOffset: number;
  advanceWidth: number;
}

interface PdfkitRun {
  glyphs: PdfkitGlyph[];
  positions: PdfkitPosition[];
  advanceWidth: number;
}

type PdfkitLayout = (text: string, features?: unknown, onlyWidth?: boolean) => PdfkitRun;

/** The parts of pdfkit's embedded font object this module relies on. */
interface PdfkitEmbeddedFont {
  layout: PdfkitLayout;
  readonly scale: number;
  readonly font: { getGlyph(id: number): { advanceWidth: number } };
}

interface PdfkitDocumentInternals {
  _font: PdfkitEmbeddedFont;
  _fontSize: number;
}

interface PendingRun {
  readonly text: string;
  readonly run: PdfkitRun;
}

/** Layout functions already replaced, with the run the next doc.text() call must use. */
const installed = new WeakMap<PdfkitEmbeddedFont, { pending: PendingRun | null }>();

function installLayout(font: PdfkitEmbeddedFont): { pending: PendingRun | null } {
  const existing = installed.get(font);
  if (existing) return existing;
  const state: { pending: PendingRun | null } = { pending: null };
  const original = font.layout.bind(font);
  font.layout = (text, features, onlyWidth) => {
    if (state.pending && state.pending.text === text) return state.pending.run;
    return original(text, features, onlyWidth);
  };
  installed.set(font, state);
  return state;
}

/** Code points of the characters each glyph stands for: the text from its cluster up to the next cluster. */
function glyphCodePoints(piece: LayoutPiece): number[][] {
  const clusters = Array.from(new Set(piece.glyphs.map((glyph) => glyph.cluster))).sort((a, b) => a - b);
  const next = new Map<number, number>();
  clusters.forEach((cluster, index) => next.set(cluster, index + 1 < clusters.length ? clusters[index + 1] : piece.text.length));
  const rightToLeft = piece.level % 2 === 1;
  return piece.glyphs.map((glyph) => {
    const end = next.get(glyph.cluster) ?? piece.text.length;
    const codePoints = Array.from(piece.text.slice(glyph.cluster, end), (ch) => ch.codePointAt(0) as number);
    // Extraction tools reverse whole right-to-left lines of glyph text, entries of ligature glyphs included, so a
    // ligature (lam-alef) lists its characters in display order to come out in reading order.
    return rightToLeft ? codePoints.reverse() : codePoints;
  });
}

interface PdfkitEmbeddedFontSource {
  getGlyph(id: number): { advanceWidth: number };
}

function toPdfkitRun(piece: LayoutPiece): PdfkitRun {
  const font = piece.face.font as unknown as PdfkitEmbeddedFontSource;
  const scale = PDF_THOUSANDTHS_PER_EM / piece.unitsPerEm;
  const codePoints = glyphCodePoints(piece);
  const glyphs: PdfkitGlyph[] = [];
  const positions: PdfkitPosition[] = [];
  let total = 0;
  piece.glyphs.forEach((glyph, index) => {
    const nominal = font.getGlyph(glyph.id).advanceWidth;
    glyphs.push({ id: glyph.id, advanceWidth: nominal, codePoints: codePoints[index] });
    positions.push({
      xAdvance: glyph.advance * scale,
      yAdvance: 0,
      xOffset: glyph.xOffset * scale,
      yOffset: glyph.yOffset * scale,
      advanceWidth: nominal * scale,
    });
    total += glyph.advance * scale;
  });
  return { glyphs, positions, advanceWidth: total };
}

/**
 * Whether extraction by ToUnicode alone would return the wrong characters: the glyphs are left to right and either
 * not one per character, or not in the order of the characters.
 */
function needsActualText(piece: LayoutPiece): boolean {
  if (piece.level % 2 === 1) return false;
  if (piece.glyphs.length !== Array.from(piece.text).length) return true;
  let previous = -1;
  for (const glyph of piece.glyphs) {
    if (glyph.cluster <= previous) return true;
    previous = glyph.cluster;
  }
  return false;
}

export interface DrawOptions {
  readonly underline?: boolean;
}

/** Draws shaped pieces and lines with a pdfkit document. */
export class ShapedTextDrawer {
  constructor(
    private readonly doc: PDFKit.PDFDocument,
    private readonly useFace: (face: PdfFontFace) => void
  ) {}

  /** Draws one piece with its left edge at x and its baseline at `baseline` (page coordinates, y down). */
  drawPiece(piece: LayoutPiece, x: number, baseline: number, options: DrawOptions): void {
    this.useFace(piece.face);
    const internals = this.doc as unknown as PdfkitDocumentInternals;
    const font = internals._font;
    const state = installLayout(font);
    const ascent = (piece.face.font as unknown as { ascent: number }).ascent;
    const top = baseline - (ascent * internals._fontSize) / piece.unitsPerEm;
    state.pending = { text: piece.text, run: toPdfkitRun(piece) };
    const actualText = needsActualText(piece);
    try {
      if (actualText) this.doc.markContent('Span', { actual: piece.text });
      // Without a wrapping width pdfkit does not measure the line; its link and underline rectangles read these two.
      const measured = { textWidth: piece.width, wordCount: 1 };
      this.doc.text(piece.text, x, top, {
        lineBreak: false,
        link: piece.link ?? null,
        underline: Boolean(piece.link) || Boolean(options.underline),
        ...measured,
      } as PDFKit.Mixins.TextOptions);
      if (actualText) this.doc.endMarkedContent();
    } finally {
      state.pending = null;
    }
  }

  /** Draws a line whose box starts at (left, top); returns nothing, the caller advances the cursor. */
  drawLine(line: LayoutLine, left: number, top: number, options: DrawOptions): void {
    const baseline = top + line.ascent;
    let x = left + line.x;
    for (const piece of line.pieces) {
      this.drawPiece(piece, x, baseline, options);
      x += piece.width;
    }
  }
}
