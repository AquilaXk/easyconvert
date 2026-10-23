import { UnsupportedOptionError } from '../types';
import type { AffineMatrix } from './svg-geometry';

/**
 * Bitmap glyphs in the SVG that Poppler draws. A page set in a bitmap font (dvips output: Type 3 fonts of 1-bit pictures)
 * reaches the geometry readers as one `<rect mask="url(#mask-N)"/>` per character, which is what cairo's SVG surface writes
 * for such a glyph (`_cairo_svg_document_emit_bitmap_glyph_data` in cairo-svg-surface.c): a rectangle painted through a mask
 * that holds the glyph picture, as `<mask><use href="#source-M"/></mask>` with `<image id="source-M">` in the definitions.
 * The rectangle sits in the glyph's own group, whose origin is the glyph origin on the baseline: cairo draws each character
 * as `<use href="#glyph-F-G" x y>` at its pen position.
 *
 * The rectangle is the extent of the picture, not an outline, and a format with no bitmaps cannot hold the character. A reader
 * refuses it and says what it is, or, for the DXF writer, which writes the character again as text, sets it aside: its origin
 * and the extent of its picture are recorded and nothing is drawn. Any other mask keeps the plain mask refusal.
 */

export interface BitmapGlyphNode {
  name: string;
  attrs: Map<string, string>;
  children: BitmapGlyphNode[];
}

/** One drawn character of a bitmap font, in device space (y down), set aside instead of drawn. */
export interface BitmapGlyphMark {
  /** The same number for every use of one glyph picture. */
  glyph: number;
  /** The glyph origin: the pen position on the baseline. */
  x: number;
  y: number;
  /** The picture's extent: device x of its left and right edge, device y of its top and bottom edge. */
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const MASK_URL_PATTERN = /^url\(\s*#([^)\s"']+)\s*\)$/i;
const STYLE_MASK_PATTERN = /(?:^|;)\s*mask\s*:\s*([^;]+)/i;
const RECT_EDGES = ['x', 'y', 'width', 'height'] as const;

/** True when the node is a picture: an `<image>`, or a `<use>` of one. */
function isPicture(node: BitmapGlyphNode, ids: ReadonlyMap<string, BitmapGlyphNode>): boolean {
  if (node.name === 'image') return true;
  if (node.name !== 'use') return false;
  const href = (node.attrs.get('href') ?? node.attrs.get('xlink:href') ?? '').trim();
  return href.startsWith('#') && ids.get(href.slice(1))?.name === 'image';
}

/** The id a `<rect>` takes its mask from (the style declaration wins over the attribute), or undefined. */
function maskId(node: BitmapGlyphNode): string | undefined {
  const value = STYLE_MASK_PATTERN.exec(node.attrs.get('style') ?? '')?.[1] ?? node.attrs.get('mask');
  return value === undefined ? undefined : MASK_URL_PATTERN.exec(value.trim())?.[1];
}

/** Whether the node is a bitmap glyph: a `<rect>` whose mask holds nothing but pictures. */
function isBitmapGlyph(node: BitmapGlyphNode, ids: ReadonlyMap<string, BitmapGlyphNode>): boolean {
  if (node.name !== 'rect') return false;
  const id = maskId(node);
  const mask = id === undefined ? undefined : ids.get(id);
  return mask?.name === 'mask' && mask.children.length > 0 && mask.children.every((child) => isPicture(child, ids));
}

function apply(m: AffineMatrix, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** The device extent of a glyph rectangle drawn under `ctm`; a value that is not a finite number has no extent. */
function extent(node: BitmapGlyphNode, ctm: AffineMatrix): Pick<BitmapGlyphMark, 'left' | 'right' | 'top' | 'bottom'> {
  const [x, y, width, height] = RECT_EDGES.map((edge) => Number(node.attrs.get(edge) ?? '0'));
  const corners = [apply(ctm, x, y), apply(ctm, x + width, y), apply(ctm, x, y + height), apply(ctm, x + width, y + height)];
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  if (![...xs, ...ys].every(Number.isFinite)) {
    throw new UnsupportedOptionError('SVG bitmap glyph (a character of a bitmap font, drawn as a picture) has no finite extent.');
  }
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}

/**
 * The bitmap glyphs of one document: a new instance per document refuses them, one made with `setAside` records them (the DXF
 * writer reads `marks` and writes the characters again as text). Which `<rect>` is a glyph is decided once per element (a glyph
 * is drawn by every `<use>` of it, and its mask may hold many pictures), so no page costs more than one pass over the children
 * of each mask.
 */
export class BitmapGlyphs {
  readonly marks: BitmapGlyphMark[] = [];
  private readonly glyphNumbers = new Map<BitmapGlyphNode, number | null>();

  constructor(private readonly setAside = false) {}

  /**
   * True when the node is a bitmap glyph, which is then recorded and must not be drawn; throws when glyphs are refused.
   * `originCtm` places the glyph's group (its origin is the glyph origin), `ctm` the rectangle itself.
   */
  take(node: BitmapGlyphNode, ids: ReadonlyMap<string, BitmapGlyphNode>, originCtm: AffineMatrix, ctm: AffineMatrix): boolean {
    if (node.name !== 'rect') return false;
    let glyph = this.glyphNumbers.get(node);
    if (glyph === undefined) {
      glyph = isBitmapGlyph(node, ids) ? this.glyphNumbers.size : null;
      this.glyphNumbers.set(node, glyph);
    }
    if (glyph === null) return false;
    if (!this.setAside) {
      throw new UnsupportedOptionError('SVG bitmap glyph (a character of a bitmap font, drawn as a picture) is not supported by metafile encoders.');
    }
    this.marks.push({ glyph, ...apply(originCtm, 0, 0), ...extent(node, ctm) });
    return true;
  }
}
