import { ShapingLimitError } from '../../types';
import type { PdfFontFace } from '../pdf-fonts';
import { itemizeParagraph, visualOrder, type ItemizedRun, type ScriptTag } from './itemize';
import { breakOpportunities } from './linebreak';
import { SHAPE_MAX_LINES_PER_PARAGRAPH, type ShapingBudget } from './limits';
import { shapeRun, type ShapedGlyph } from './shape';

/**
 * Lays out text that needs shaping: itemize into bidi/script runs, pick a font per run, shape, find break
 * opportunities (UAX #14 plus word dictionaries), fill lines greedily with the shaped advances, and put the pieces of
 * each line in display order (UAX #9 L2). Pure computation: no drawing and no document state, so the result can be
 * measured or drawn by any writer.
 */

export interface LayoutSegment {
  readonly text: string;
  readonly link?: string;
}

/** A partition of `text` into stretches that one face draws. */
export type FontRunProvider = (text: string) => Array<{ start: number; end: number; face: PdfFontFace }>;

export type LayoutAlign = 'left' | 'right' | 'center' | 'justify';

export interface LayoutRequest {
  readonly segments: readonly LayoutSegment[];
  readonly fontSize: number;
  /** Line width in points; 0 lays each paragraph out on one line. */
  readonly width: number;
  /** Physical alignment; absent means the paragraph's start side (right for right-to-left text). */
  readonly align?: LayoutAlign;
  readonly fonts: FontRunProvider;
  /** Face whose metrics size a line with no text. */
  readonly blankLineFace: PdfFontFace;
  readonly budget: ShapingBudget;
}

/** A stretch of one line drawn with one face in one direction. */
export interface LayoutPiece {
  readonly face: PdfFontFace;
  readonly unitsPerEm: number;
  readonly level: number;
  readonly script: ScriptTag;
  /** Logical text of the piece. */
  readonly text: string;
  /** Glyphs in display order; `cluster` is an offset into `text`. Advances are in font units. */
  readonly glyphs: ShapedGlyph[];
  readonly link?: string;
  /** Width in points. */
  width: number;
}

export interface LayoutLine {
  /** In display order, left to right. */
  readonly pieces: LayoutPiece[];
  /** Width of the drawn text in points. */
  readonly width: number;
  /** Offset of the first piece from the left edge of the box, in points. */
  readonly x: number;
  /** Distances above and below the baseline, and the extra gap the font asks for, in points. */
  readonly ascent: number;
  readonly descent: number;
  readonly gap: number;
}

export interface TextLayout {
  readonly lines: LayoutLine[];
}

interface ShapedPiece {
  readonly face: PdfFontFace;
  readonly unitsPerEm: number;
  readonly level: number;
  readonly script: ScriptTag;
  readonly start: number;
  readonly end: number;
  readonly glyphs: ShapedGlyph[];
  readonly link?: string;
}

const LINE_FEED = '\n';
const WIDTH_TOLERANCE = 0.01;
/** Space separators a line may end with: the ones that break (not the no-break spaces). */
const BREAKABLE_SPACE = /^[   -  -  　]$/;

/** Index of the first glyph whose cluster satisfies `pred`, for glyphs ordered by `ascending` cluster values. */
function firstIndex(glyphs: readonly ShapedGlyph[], pred: (cluster: number) => boolean): number {
  let low = 0;
  let high = glyphs.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (pred(glyphs[mid].cluster)) high = mid;
    else low = mid + 1;
  }
  return low;
}

/** The glyphs of `piece` whose clusters start in [from, to) (offsets in paragraph text), in display order. */
function glyphSlice(piece: ShapedPiece, from: number, to: number): ShapedGlyph[] {
  const lo = from - piece.start;
  const hi = to - piece.start;
  if (piece.level % 2 === 0) {
    const begin = firstIndex(piece.glyphs, (cluster) => cluster >= lo);
    const end = firstIndex(piece.glyphs, (cluster) => cluster >= hi);
    return piece.glyphs.slice(begin, end);
  }
  // Right to left: clusters descend along the display order.
  const begin = firstIndex(piece.glyphs, (cluster) => cluster < hi);
  const end = firstIndex(piece.glyphs, (cluster) => cluster < lo);
  return piece.glyphs.slice(begin, end);
}

function isBreakableSpaceAt(text: string, offset: number): boolean {
  const codePoint = text.codePointAt(offset);
  return codePoint !== undefined && BREAKABLE_SPACE.test(String.fromCodePoint(codePoint));
}

/** Splits the paragraph into pieces: bidi/script runs cut at link boundaries and font changes, each shaped. */
function shapePiecesOf(
  paragraph: string,
  runs: readonly ItemizedRun[],
  links: ReadonlyArray<{ end: number; link?: string }>,
  request: LayoutRequest
): ShapedPiece[] {
  const pieces: ShapedPiece[] = [];
  let linkIndex = 0;
  for (const run of runs) {
    let cursor = run.start;
    while (cursor < run.end) {
      while (links[linkIndex].end <= cursor) linkIndex++;
      const stop = Math.min(run.end, links[linkIndex].end);
      const text = paragraph.slice(cursor, stop);
      for (const fontRun of request.fonts(text)) {
        const start = cursor + fontRun.start;
        const end = cursor + fontRun.end;
        const shaped = shapeRun(fontRun.face, paragraph.slice(start, end), run.level, run.script, request.budget);
        pieces.push({
          face: fontRun.face,
          unitsPerEm: shaped.unitsPerEm,
          level: run.level,
          script: run.script,
          start,
          end,
          glyphs: shaped.glyphs,
          link: links[linkIndex].link,
        });
      }
      cursor = stop;
    }
  }
  return pieces;
}

interface ParagraphMetrics {
  /** Offsets where a glyph cluster starts: the only places a line may break. */
  readonly clusterStarts: Uint8Array;
  /** prefix[i] = width in points of the text before offset i. */
  readonly prefix: Float64Array;
}

function measureParagraph(length: number, pieces: readonly ShapedPiece[], fontSize: number): ParagraphMetrics {
  const clusterStarts = new Uint8Array(length + 1);
  const widthAt = new Float64Array(length + 1);
  for (const piece of pieces) {
    const scale = fontSize / piece.unitsPerEm;
    for (const glyph of piece.glyphs) {
      const offset = piece.start + glyph.cluster;
      clusterStarts[offset] = 1;
      widthAt[offset] += glyph.advance * scale;
    }
    clusterStarts[piece.start] = 1;
  }
  const prefix = new Float64Array(length + 1);
  for (let index = 0; index < length; index++) prefix[index + 1] = prefix[index] + widthAt[index];
  return { clusterStarts, prefix };
}

/** The end of the drawn text of the line [start, end): trailing breakable spaces hang outside the line. */
function trimTrailingSpaces(text: string, start: number, end: number): number {
  let contentEnd = end;
  while (contentEnd > start && isBreakableSpaceAt(text, contentEnd - 1)) contentEnd--;
  return contentEnd;
}

/** Line [start, end) boundaries of one paragraph, filled greedily with the shaped advances. */
function breakLines(paragraph: string, metrics: ParagraphMetrics, width: number): Array<[number, number]> {
  const length = paragraph.length;
  if (width <= 0) return [[0, length]];
  const lines: Array<[number, number]> = [];
  const opportunities = breakOpportunities(paragraph).filter((opportunity) => metrics.clusterStarts[opportunity.offset] === 1);
  opportunities.push({ offset: length, required: true });
  const limit = width + WIDTH_TOLERANCE;
  let lineStart = 0;
  let lastFit = -1;
  let index = 0;
  const pushLine = (end: number): void => {
    if (lines.length >= SHAPE_MAX_LINES_PER_PARAGRAPH) {
      throw new ShapingLimitError(`A paragraph breaks into more than ${SHAPE_MAX_LINES_PER_PARAGRAPH} lines at this width`);
    }
    lines.push([lineStart, end]);
    lineStart = end;
    lastFit = -1;
  };
  while (index < opportunities.length) {
    const opportunity = opportunities[index];
    const contentEnd = trimTrailingSpaces(paragraph, lineStart, opportunity.offset);
    const fits = metrics.prefix[contentEnd] - metrics.prefix[lineStart] <= limit;
    if (fits) {
      lastFit = opportunity.offset;
      // A forced cut can leave the line start at this opportunity already: no empty line is added after it.
      if (opportunity.required && (opportunity.offset > lineStart || lines.length === 0)) pushLine(opportunity.offset);
      index++;
    } else if (lastFit > lineStart) {
      pushLine(lastFit);
    } else {
      pushLine(forcedBreak(metrics, lineStart, opportunity.offset, limit));
    }
  }
  return lines;
}

/** Where to cut a segment that is wider than a line: the last cluster boundary that fits, or the first one after it. */
function forcedBreak(metrics: ParagraphMetrics, start: number, end: number, limit: number): number {
  let cut = -1;
  let next = -1;
  for (let offset = start + 1; offset < end; offset++) {
    if (metrics.clusterStarts[offset] !== 1) continue;
    if (next < 0) next = offset;
    if (metrics.prefix[offset] - metrics.prefix[start] > limit) break;
    cut = offset;
  }
  if (cut > start) return cut;
  return next > start ? next : end;
}

function pieceWidth(glyphs: readonly ShapedGlyph[], unitsPerEm: number, fontSize: number): number {
  let units = 0;
  for (const glyph of glyphs) units += glyph.advance;
  return (units * fontSize) / unitsPerEm;
}

function faceMetrics(face: PdfFontFace, fontSize: number): { ascent: number; descent: number; gap: number } {
  const unitsPerEm = face.font.unitsPerEm;
  const scale = fontSize / unitsPerEm;
  const font = face.font as unknown as { ascent: number; descent: number; lineGap: number };
  return { ascent: font.ascent * scale, descent: -font.descent * scale, gap: font.lineGap * scale };
}

/** Builds the display-ordered line [start, end) of one paragraph from its shaped pieces. */
function buildLine(
  paragraph: string,
  pieces: readonly ShapedPiece[],
  start: number,
  end: number,
  request: LayoutRequest,
  baseLevel: number,
  lastLine: boolean
): LayoutLine {
  const contentEnd = trimTrailingSpaces(paragraph, start, end);
  const logical: LayoutPiece[] = [];
  for (const piece of pieces) {
    const from = Math.max(start, piece.start);
    const to = Math.min(contentEnd, piece.end);
    if (from >= to) continue;
    const glyphs = glyphSlice(piece, from, to).map((glyph) => ({ ...glyph, cluster: glyph.cluster - (from - piece.start) }));
    logical.push({
      face: piece.face,
      unitsPerEm: piece.unitsPerEm,
      level: piece.level,
      script: piece.script,
      text: paragraph.slice(from, to),
      glyphs,
      link: piece.link,
      width: pieceWidth(glyphs, piece.unitsPerEm, request.fontSize),
    });
  }
  const ordered = visualOrder(logical.map((piece) => piece.level)).map((index) => logical[index]);
  let width = ordered.reduce((sum, piece) => sum + piece.width, 0);

  const align = request.align ?? (baseLevel % 2 === 1 ? 'right' : 'left');
  if (align === 'justify' && !lastLine && request.width > width) width = justify(ordered, request.width - width, request.fontSize, width);

  let ascent = 0;
  let descent = 0;
  let gap = 0;
  const faces = ordered.length > 0 ? ordered.map((piece) => piece.face) : [request.blankLineFace];
  for (const face of faces) {
    const metrics = faceMetrics(face, request.fontSize);
    ascent = Math.max(ascent, metrics.ascent);
    descent = Math.max(descent, metrics.descent);
    gap = Math.max(gap, metrics.gap);
  }
  let x = 0;
  if (request.width > 0) {
    if (align === 'right') x = request.width - width;
    else if (align === 'center') x = (request.width - width) / 2;
  }
  return { pieces: ordered, width, x, ascent, descent, gap };
}

/** Spreads `extra` points over the spaces of the line; returns the line's new width. */
function justify(pieces: LayoutPiece[], extra: number, fontSize: number, width: number): number {
  let spaces = 0;
  for (const piece of pieces) {
    for (const glyph of piece.glyphs) if (piece.text[glyph.cluster] === ' ') spaces++;
  }
  if (spaces === 0) return width;
  for (const piece of pieces) {
    const unitsPerSpace = ((extra / spaces) * piece.unitsPerEm) / fontSize;
    piece.glyphs.forEach((glyph, index) => {
      if (piece.text[glyph.cluster] === ' ') piece.glyphs[index] = { ...glyph, advance: glyph.advance + unitsPerSpace };
    });
    piece.width = pieceWidth(piece.glyphs, piece.unitsPerEm, fontSize);
  }
  return width + extra;
}

/**
 * Lays the segments out. Paragraphs are separated by line feeds; a paragraph that is empty is one blank line. Throws
 * ShapingLimitError (413) past the paragraph and document limits, and FontCoverageError (400) for a character no font
 * covers.
 */
export function layoutShapedText(request: LayoutRequest): TextLayout {
  // Concatenate and split into paragraphs while keeping each character's segment (link) membership.
  const lines: LayoutLine[] = [];
  const owners: Array<{ end: number; link?: string }> = [];
  let full = '';
  for (const segment of request.segments) {
    full += segment.text;
    owners.push({ end: full.length, link: segment.link });
  }
  let paragraphStart = 0;
  while (paragraphStart <= full.length) {
    const lineFeed = full.indexOf(LINE_FEED, paragraphStart);
    const paragraphEnd = lineFeed < 0 ? full.length : lineFeed;
    lines.push(...layoutParagraph(full.slice(paragraphStart, paragraphEnd), paragraphStart, owners, request));
    paragraphStart = paragraphEnd + 1;
    if (lineFeed < 0) break;
  }
  return { lines };
}

function layoutParagraph(
  paragraph: string,
  paragraphStart: number,
  owners: ReadonlyArray<{ end: number; link?: string }>,
  request: LayoutRequest
): LayoutLine[] {
  if (paragraph.length === 0) {
    const metrics = faceMetrics(request.blankLineFace, request.fontSize);
    return [{ pieces: [], width: 0, x: 0, ascent: metrics.ascent, descent: metrics.descent, gap: metrics.gap }];
  }
  const links = owners.map((owner) => ({ end: owner.end - paragraphStart, link: owner.link })).filter((entry) => entry.end > 0);
  const { runs, baseLevel } = itemizeParagraph(paragraph);
  const pieces = shapePiecesOf(paragraph, runs, links, request);
  const metrics = measureParagraph(paragraph.length, pieces, request.fontSize);
  const boundaries = breakLines(paragraph, metrics, request.width);
  return boundaries.map(([start, end], index) =>
    buildLine(paragraph, pieces, start, end, request, baseLevel, index === boundaries.length - 1)
  );
}
