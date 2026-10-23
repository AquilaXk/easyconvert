import { UnsupportedOptionError } from '../types';

/**
 * Bitmap glyphs in the SVG that Poppler draws. A page set in a bitmap font (dvips output: Type 3 fonts of 1-bit pictures)
 * reaches the geometry readers as one `<rect mask="url(#mask-N)"/>` per character, which is what cairo's SVG surface writes
 * for such a glyph (`_cairo_svg_document_emit_bitmap_glyph_data` in cairo-svg-surface.c): a rectangle painted through a mask
 * that holds the glyph picture, as `<mask><use href="#source-M"/></mask>` with `<image id="source-M">` in the definitions.
 * The rectangle is the extent of the picture, not an outline, and a format with no bitmaps cannot hold the character, so the
 * readers refuse it and say what it is. Any other mask keeps the plain mask refusal.
 */

export interface BitmapGlyphNode {
  name: string;
  attrs: Map<string, string>;
  children: BitmapGlyphNode[];
}

const MASK_URL_PATTERN = /^url\(\s*#([^)\s"']+)\s*\)$/i;
const STYLE_MASK_PATTERN = /(?:^|;)\s*mask\s*:\s*([^;]+)/i;

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

/**
 * Throws when the node is a bitmap glyph: a `<rect>` whose mask holds nothing but pictures. The mask is read once, here, and
 * the refusal ends the document, so no page costs more than one pass over the children of one mask.
 */
export function assertNotBitmapGlyph(node: BitmapGlyphNode, ids: ReadonlyMap<string, BitmapGlyphNode>): void {
  if (node.name !== 'rect') return;
  const id = maskId(node);
  const mask = id === undefined ? undefined : ids.get(id);
  if (mask?.name === 'mask' && mask.children.length > 0 && mask.children.every((child) => isPicture(child, ids))) {
    throw new UnsupportedOptionError('SVG bitmap glyph (a character of a bitmap font, drawn as a picture) is not supported by metafile encoders.');
  }
}
