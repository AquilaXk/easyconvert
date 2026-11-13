import type { Inline } from '../document-model/model';
import { hexOf } from '../pdf-content-colours';
import { FillIndex, isLightColour, itemBox } from '../pdf-content-shapes';
import type { PdfContentRule, PdfContentShape, PdfPageContent } from '../pdf-text-types';
import type { Box, DetectedTable } from './types';

/**
 * What a page paints under and around its text: the fill of the rectangle behind a box of text, and the colour and width of the
 * rules that make up a table's grid. Both come from the page's operator list (`PdfContentShape`, `PdfContentRule`).
 */

const HEX_RADIX = 16;
/** A rule belongs to a table when it lies inside its box with this much room (points). */
const RULE_SLACK = 2;

export { hexOf, isLightColour };

/** Rules of one colour make up at least this share of a table's rules for the table to be ruled in that colour. */
export const UNIFORM_RULE_SHARE = 0.9;

/** The colour and width a table's rules are drawn in, and the share of their length that has that colour. */
export interface RuleInk {
  /** 0xRRGGBB. */
  color: number;
  /** Median thickness in points. */
  width: number;
  share: number;
}

/** Whether a rule lies inside a box. */
export function ruleInside(rule: PdfContentRule, box: Box): boolean {
  return rule.x0 >= box.x0 - RULE_SLACK && rule.x1 <= box.x1 + RULE_SLACK && rule.y0 >= box.y0 - RULE_SLACK && rule.y1 <= box.y1 + RULE_SLACK;
}

/** The colour of most of the length of the rules inside a box and their median thickness; null when there are none. */
export function dominantRuleInk(rules: readonly PdfContentRule[], box: Box): RuleInk | null {
  const inside = rules.filter((rule) => ruleInside(rule, box));
  if (inside.length === 0) return null;
  const length = new Map<number, number>();
  let total = 0;
  for (const rule of inside) {
    const long = Math.hypot(rule.x1 - rule.x0, rule.y1 - rule.y0);
    length.set(rule.color ?? 0, (length.get(rule.color ?? 0) ?? 0) + long);
    total += long;
  }
  const [color, most] = [...length].sort((a, b) => b[1] - a[1])[0];
  const thicknesses = inside.map((rule) => rule.thickness).sort((a, b) => a - b);
  return { color, width: thicknesses[Math.floor(thicknesses.length / 2)], share: total === 0 ? 1 : most / total };
}

/** The fills and rules of every page of a document, by page number. A document read without colour has none, and nothing here applies. */
export class PageInk {
  private readonly fills = new Map<number, FillIndex>();
  private readonly rules = new Map<number, readonly PdfContentRule[]>();

  constructor(pages: readonly PdfPageContent[]) {
    for (const page of pages) {
      if (page.shapes === undefined) continue;
      const fills = new FillIndex(page.shapes);
      // A highlight a run carries as its own background is not drawn again as a shape.
      for (const item of page.items) if (item.fill !== undefined) fills.behind(itemBox(item));
      this.fills.set(page.pageNumber, fills);
      this.rules.set(page.pageNumber, page.rules);
    }
  }

  /** The page was read with colour. */
  get active(): boolean {
    return this.fills.size > 0;
  }

  /** The fill (0xRRGGBB) behind a box of text that is not paper, so that it is carried with the text; undefined when there is none. */
  fillBehind(pageNumber: number, box: Box): number | undefined {
    const fill = this.fills.get(pageNumber)?.behind(box);
    return fill === undefined || isLightColour(fill) ? undefined : fill;
  }

  /** The colour and width a table's rules are drawn in; null for a table without rules. */
  borderOf(table: DetectedTable): RuleInk | null {
    return dominantRuleInk(this.rules.get(table.pageNumber) ?? [], table.box);
  }

  /** A ruled table whose rules are drawn in several colours: no grid in one colour, but boxes and lines of a figure. */
  boxesInColours(table: DetectedTable): boolean {
    const ink = table.kind === 'lattice' ? this.borderOf(table) : null;
    return ink !== null && ink.share < UNIFORM_RULE_SHARE;
  }

  /** The shapes of a page that no paragraph or cell carries as its fill. */
  uncarried(page: PdfPageContent): PdfContentShape[] {
    const used = this.fills.get(page.pageNumber)?.used;
    return (page.shapes ?? []).filter((shape) => !used?.has(shape));
  }
}

/**
 * The runs of a paragraph with colours a reader can still read. Text in a colour as light as paper is white text on a fill; where the
 * fill is not carried with the text (`filled` is false), the text would vanish on the white page, so it is left in the default colour.
 */
export function readableRuns(runs: Inline[], filled: boolean): Inline[] {
  // The fill the paragraph or cell carries is the one behind its runs, so a run needs none of its own.
  if (filled) return runs.map(({ shading: _own, ...rest }) => rest);
  return runs.map((run) => {
    // A run with a fill of its own carries it, so its light colour stays.
    if (run.color === undefined || run.shading !== undefined || !isLightColour(Number.parseInt(run.color, HEX_RADIX))) return run;
    const { color: _light, ...rest } = run;
    return rest;
  });
}
