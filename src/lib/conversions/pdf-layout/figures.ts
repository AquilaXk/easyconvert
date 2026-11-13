import type { Block, PageShape, ParagraphBlock } from '../document-model/model';
import { extentOf } from '../document-model/shape-xml';
import { COORDINATES_OF } from '../pdf-content-shapes';
import type { PdfContentRule, PdfContentShape, PdfPageContent } from '../pdf-text-types';
import { hexOf, type PageInk, ruleInside } from './ink';
import type { Box } from './types';

/**
 * The shapes a page paints that no paragraph or cell carries as its fill (outlines, bars, rules, figures) hung on the document's
 * paragraphs. A Word document flows the text of the pages, so a shape cannot keep a page position of its own; it keeps its place
 * against text. Shapes that lie over the text of a paragraph hang on it and are drawn behind that text. A group of shapes clear of all
 * text (a chart, a diagram) is a paragraph of its own, in the flow where the group stood, holding open as much height as the group has.
 */

/** Shapes whose vertical extents are this close (points) are one group. */
const GROUP_GAP = 6;
/** A group taller than this share of its page does not hold open its height: it is a frame or a backdrop, not a figure. */
const FIGURE_MAX_SHARE = 0.5;
/** A paragraph is under a group when they share this share of the paragraph's height. */
const OVER_TEXT_SHARE = 0.3;
/** Rules at most this thick (points) are lines; thicker ones are bars. */
const LINE_MAX_THICKNESS = 3;

/** Where a block of the model stood on its page. */
export interface BlockOrigin {
  pageNumber: number;
  box: Box;
}

/** A rule as a shape: a stroked line, or a filled bar when it is thicker than a line. */
function ruleShape(rule: PdfContentRule): PdfContentShape {
  const z = rule.z ?? -1;
  const color = rule.color ?? 0;
  if (rule.thickness <= LINE_MAX_THICKNESS) {
    return { kind: 'path', x0: rule.x0, y0: rule.y0, x1: rule.x1, y1: rule.y1, stroke: color, strokeWidth: rule.thickness, path: [0, rule.x0, rule.y0, 1, rule.x1, rule.y1], z };
  }
  const half = rule.thickness / 2;
  const horizontal = rule.x1 - rule.x0 >= rule.y1 - rule.y0;
  return {
    kind: 'rect',
    x0: horizontal ? rule.x0 : rule.x0 - half,
    x1: horizontal ? rule.x1 : rule.x1 + half,
    y0: horizontal ? rule.y0 - half : rule.y0,
    y1: horizontal ? rule.y1 + half : rule.y1,
    fill: color,
    z,
  };
}

/** The shapes of a page to hang on the document: the ones no text carries and the rules outside the tables, in paint order. */
function decorationsOf(page: PdfPageContent, ink: PageInk, tables: readonly Box[]): PdfContentShape[] {
  const rules = page.rules.filter((rule) => rule.inShape !== true && !tables.some((table) => ruleInside(rule, table)));
  return [...ink.uncarried(page), ...rules.map(ruleShape)].sort((a, b) => a.z - b.z);
}

/** The hull of a shape: its box, or the box of all the coordinates of its path (control points included). */
function hullOf(shape: PdfContentShape): Box {
  return shape.path ? extentOf(shape.path) : { x0: shape.x0, y0: shape.y0, x1: shape.x1, y1: shape.y1 };
}

/** The shape as a `PageShape` whose top is `top` points under the top of the paragraph it hangs on, or at its own place on the page when `top` is null. */
function pageShapeOf(shape: PdfContentShape, hull: Box, top: number | null): PageShape {
  return {
    kind: shape.path ? 'path' : 'rect',
    x: hull.x0,
    y: hull.y0 - (top ?? 0),
    ...(top === null ? { pageRelative: true as const } : {}),
    width: hull.x1 - hull.x0,
    height: hull.y1 - hull.y0,
    ...(shape.fill === undefined ? {} : { fill: hexOf(shape.fill) }),
    ...(shape.stroke === undefined ? {} : { stroke: hexOf(shape.stroke), strokeWidthPt: shape.strokeWidth ?? 0 }),
    ...(shape.alpha === undefined ? {} : { alpha: shape.alpha }),
    ...(shape.path ? { path: relativePath(shape.path, hull) } : {}),
  };
}

const POINT_COORDINATES = 2;

/** The segments of a path with their coordinates taken from the corner of the hull. */
function relativePath(path: readonly number[], hull: Box): number[] {
  const out: number[] = [];
  let at = 0;
  while (at < path.length) {
    const code = path[at++];
    out.push(code);
    const count = COORDINATES_OF[code] ?? 0;
    for (let i = 0; i < count; i += POINT_COORDINATES) out.push(path[at + i] - hull.x0, path[at + i + 1] - hull.y0);
    at += count;
  }
  return out;
}

interface Group {
  box: Box;
  shapes: { shape: PdfContentShape; hull: Box }[];
}

/** Groups of shapes that stand one above the other with gaps no bigger than `GROUP_GAP`, top to bottom. */
function groupsOf(shapes: readonly PdfContentShape[]): Group[] {
  const hulls = shapes.map((shape) => ({ shape, hull: hullOf(shape) })).sort((a, b) => a.hull.y0 - b.hull.y0);
  const groups: Group[] = [];
  for (const entry of hulls) {
    const last = groups[groups.length - 1];
    if (last && entry.hull.y0 <= last.box.y1 + GROUP_GAP) {
      last.shapes.push(entry);
      last.box = { x0: Math.min(last.box.x0, entry.hull.x0), y0: last.box.y0, x1: Math.max(last.box.x1, entry.hull.x1), y1: Math.max(last.box.y1, entry.hull.y1) };
    } else {
      groups.push({ box: { ...entry.hull }, shapes: [entry] });
    }
  }
  return groups;
}

const isHost = (block: Block): block is ParagraphBlock | Extract<Block, { type: 'heading' }> => block.type === 'paragraph' || block.type === 'heading';

/** The index of the first paragraph or heading of the page that the group lies over, or -1. */
function hostOf(group: Group, pageNumber: number, model: readonly Block[], origins: readonly (BlockOrigin | null)[]): number {
  return model.findIndex((block, index) => {
    const origin = origins[index];
    if (!origin || origin.pageNumber !== pageNumber || !isHost(block)) return false;
    const height = origin.box.y1 - origin.box.y0;
    const shared = Math.min(origin.box.y1, group.box.y1) - Math.max(origin.box.y0, group.box.y0);
    return shared >= OVER_TEXT_SHARE * height && origin.box.x0 < group.box.x1 && group.box.x0 < origin.box.x1;
  });
}

/** Where the paragraph of a figure goes: before the first block of the page that starts under the group, else after the page's last block. */
function figureIndex(group: Group, pageNumber: number, origins: readonly (BlockOrigin | null)[]): number {
  const below = origins.findIndex((origin) => origin !== null && origin.pageNumber === pageNumber && origin.box.y0 >= group.box.y1 - GROUP_GAP / 2);
  if (below >= 0) return below;
  let last = -1;
  origins.forEach((origin, index) => {
    if (origin !== null && origin.pageNumber <= pageNumber) last = index;
  });
  return last + 1;
}

/**
 * Hangs the uncarried shapes of the pages on the blocks of `model`, adding a paragraph for each figure. `model`, `columnsOf` and
 * `origins` run in step, and stay in step. `grids` are the boxes of the tables each page draws (their rules are the tables' own).
 */
export function hangShapes(model: Block[], columnsOf: number[], origins: (BlockOrigin | null)[], pages: readonly PdfPageContent[], ink: PageInk, grids: ReadonlyMap<number, readonly Box[]>): void {
  const insertions: { index: number; order: number; block: ParagraphBlock; columns: number }[] = [];
  for (const page of pages) {
    for (const group of groupsOf(decorationsOf(page, ink, grids.get(page.pageNumber) ?? []))) {
      const host = hostOf(group, page.pageNumber, model, origins);
      if (host >= 0) {
        const block = model[host] as ParagraphBlock;
        const top = (origins[host] as BlockOrigin).box.y0;
        block.shapes = [...(block.shapes ?? []), ...group.shapes.map(({ shape, hull }) => pageShapeOf(shape, hull, top))];
        continue;
      }
      const height = group.box.y1 - group.box.y0;
      if (height > FIGURE_MAX_SHARE * page.height) {
        // A frame or a backdrop holds no height open: it hangs on the first paragraph of its page and keeps its place on the page.
        const first = model.findIndex((block, index) => isHost(block) && origins[index]?.pageNumber === page.pageNumber);
        if (first >= 0) {
          const target = model[first] as ParagraphBlock;
          target.shapes = [...(target.shapes ?? []), ...group.shapes.map(({ shape, hull }) => pageShapeOf(shape, hull, null))];
        }
        continue;
      }
      const index = figureIndex(group, page.pageNumber, origins);
      const block: ParagraphBlock = { type: 'paragraph', runs: [], rtl: false, align: 'left', shapes: group.shapes.map(({ shape, hull }) => pageShapeOf(shape, hull, group.box.y0)), spacerPt: height };
      insertions.push({ index, order: insertions.length, block, columns: columnsOf[Math.min(index, columnsOf.length - 1)] ?? 1 });
    }
  }
  // Inserted from the back, so that an index still names the block it was found for, and the groups of one index in reverse, so that they end up in page order.
  for (const { index, block, columns } of insertions.sort((a, b) => b.index - a.index || b.order - a.order)) {
    model.splice(index, 0, block);
    columnsOf.splice(index, 0, columns);
    origins.splice(index, 0, null);
  }
}
