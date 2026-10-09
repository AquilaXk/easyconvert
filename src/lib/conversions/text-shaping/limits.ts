import { ShapingLimitError } from '../../types';

/**
 * Bounds on text shaping and line breaking, which are driven by the (untrusted) text of a document.
 * Every loop in this directory is linear in the text length and every allocation is bounded by these constants.
 */

/** Most code points handed to the shaping engine in one call; a longer run is cut at a break opportunity. */
export const SHAPE_MAX_CODEPOINTS = 16_384;
/** Most code points in one paragraph that is itemized, shaped and broken into lines. */
export const SHAPE_MAX_PARAGRAPH_CODEPOINTS = 200_000;
/** Most glyphs shaped for one document, summed over all its paragraphs. */
export const SHAPE_MAX_GLYPHS_PER_DOCUMENT = 2_000_000;
/** Most font faces loaded into the shaping engine at once; each copies the font file into WebAssembly memory. */
export const SHAPE_MAX_LOADED_FACES = 24;
/** Most lines one paragraph may break into; a width too narrow for any glyph would otherwise make one line per glyph. */
export const SHAPE_MAX_LINES_PER_PARAGRAPH = 100_000;

/** Counts the glyphs shaped for one document against SHAPE_MAX_GLYPHS_PER_DOCUMENT. */
export class ShapingBudget {
  private glyphs = 0;

  /** Records `count` more glyphs, or throws ShapingLimitError (413) when the document would pass the cap. */
  spend(count: number): void {
    this.glyphs += count;
    if (this.glyphs > SHAPE_MAX_GLYPHS_PER_DOCUMENT) {
      throw new ShapingLimitError(
        `The document needs more than ${SHAPE_MAX_GLYPHS_PER_DOCUMENT} shaped glyphs; split it into smaller documents`
      );
    }
  }

  get spent(): number {
    return this.glyphs;
  }
}

/** Throws ShapingLimitError (413) for a paragraph longer than SHAPE_MAX_PARAGRAPH_CODEPOINTS code points. */
export function assertParagraphWithinLimit(codePoints: number): void {
  if (codePoints > SHAPE_MAX_PARAGRAPH_CODEPOINTS) {
    throw new ShapingLimitError(
      `A paragraph of ${codePoints} characters is longer than the ${SHAPE_MAX_PARAGRAPH_CODEPOINTS} the shaper accepts; insert paragraph breaks`
    );
  }
}
