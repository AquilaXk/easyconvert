import type { PdfContentShape } from '../pdf-text-types';
import type { PageShape } from './model';

/**
 * DrawingML for the painted shapes of a PDF page: a rectangle is a `rect` preset, any other outline a custom geometry of the same
 * segments (ECMA-376 20.1.9.8, `a:custGeom`), each with its solid fill, its outline and its opacity.
 */

const PATH_MOVE = 0;
const PATH_LINE = 1;
const PATH_CURVE = 2;
const PATH_QUADRATIC = 3;
const PATH_CLOSE = 4;
const HEX_DIGITS = 6;
const HEX_RADIX = 16;
/** DrawingML opacity is in thousandths of a percent. */
const ALPHA_UNITS = 100_000;

export const rgbHex = (color: number): string => color.toString(HEX_RADIX).toUpperCase().padStart(HEX_DIGITS, '0');

/** Page points to the slide's EMU: the position of a point and the length of an extent. */
export interface SlideScale {
  x(points: number): number;
  y(points: number): number;
  length(points: number): number;
}

function solidFill(color: number, alpha?: number): string {
  const colour = alpha === undefined ? `<a:srgbClr val="${rgbHex(color)}"/>` : `<a:srgbClr val="${rgbHex(color)}"><a:alpha val="${Math.round(alpha * ALPHA_UNITS)}"/></a:srgbClr>`;
  return `<a:solidFill>${colour}</a:solidFill>`;
}

/** The segments of a path as DrawingML path commands, in EMU relative to the shape's corner. */
function pathCommands(path: readonly number[], to: (x: number, y: number) => string): string {
  const point = (at: number): string => to(path[at], path[at + 1]);
  let out = '';
  let at = 0;
  while (at < path.length) {
    const code = path[at++];
    if (code === PATH_MOVE) {
      out += `<a:moveTo>${point(at)}</a:moveTo>`;
      at += 2;
    } else if (code === PATH_LINE) {
      out += `<a:lnTo>${point(at)}</a:lnTo>`;
      at += 2;
    } else if (code === PATH_CURVE) {
      out += `<a:cubicBezTo>${point(at)}${point(at + 2)}${point(at + 4)}</a:cubicBezTo>`;
      at += 6;
    } else if (code === PATH_QUADRATIC) {
      out += `<a:quadBezTo>${point(at)}${point(at + 2)}</a:quadBezTo>`;
      at += 4;
    } else if (code === PATH_CLOSE) {
      out += '<a:close/>';
    } else {
      break;
    }
  }
  return out;
}

/** The corners of the box of all the coordinates of a path, control points included. */
function extentOf(path: readonly number[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let at = 0;
  const counts = [2, 2, 6, 4, 0];
  while (at < path.length) {
    const count = counts[path[at++]] ?? 0;
    for (let i = 0; i < count; i += 2) {
      x0 = Math.min(x0, path[at + i]);
      x1 = Math.max(x1, path[at + i]);
      y0 = Math.min(y0, path[at + i + 1]);
      y1 = Math.max(y1, path[at + i + 1]);
    }
    at += count;
  }
  return { x0, y0, x1, y1 };
}

/** The rectangle of all the coordinates of a path, control points included. */
export { extentOf };

/** The children of a shape's `spPr`: its place, geometry, fill and outline. */
export function shapeProperties(shape: PdfContentShape, scale: SlideScale, tag = 'p:spPr'): string {
  const line = shape.stroke === undefined ? '<a:ln><a:noFill/></a:ln>' : `<a:ln w="${Math.max(scale.length(shape.strokeWidth ?? 0), 1)}">${solidFill(shape.stroke)}</a:ln>`;
  const fill = shape.fill === undefined ? '<a:noFill/>' : solidFill(shape.fill, shape.alpha);
  if (shape.kind === 'rect' || !shape.path) {
    return (
      `<${tag}><a:xfrm><a:off x="${scale.x(shape.x0)}" y="${scale.y(shape.y0)}"/><a:ext cx="${scale.length(shape.x1 - shape.x0)}" cy="${scale.length(shape.y1 - shape.y0)}"/></a:xfrm>` +
      `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fill}${line}</${tag}>`
    );
  }
  const box = extentOf(shape.path);
  const width = Math.max(scale.length(box.x1 - box.x0), 1);
  const height = Math.max(scale.length(box.y1 - box.y0), 1);
  const to = (x: number, y: number): string => `<a:pt x="${scale.length(x - box.x0)}" y="${scale.length(y - box.y0)}"/>`;
  const unfilled = shape.fill === undefined ? ' fill="none"' : '';
  return (
    `<${tag}><a:xfrm><a:off x="${scale.x(box.x0)}" y="${scale.y(box.y0)}"/><a:ext cx="${width}" cy="${height}"/></a:xfrm>` +
    `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="${width}" h="${height}"${unfilled}>${pathCommands(shape.path, to)}</a:path></a:pathLst></a:custGeom>` +
    `${fill}${line}</${tag}>`
  );
}

/** The namespace of Word's drawing shapes (`wps:wsp`), which Word 2010 and later and the office suite read. */
export const NS_WPS = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape';
const EMU_PER_POINT = 12_700;

const inEmu = (points: number): number => Math.round(points * EMU_PER_POINT);
/** A shape's own coordinates are relative to its corner, so the place in its `xfrm` is the origin. */
const OWN_FRAME: SlideScale = { x: () => 0, y: () => 0, length: inEmu };

/**
 * A shape of a page as a floating drawing that Word lays behind the text (`wp:anchor` with `wrapNone`): its left edge is the page's
 * and its top is the paragraph's it hangs on (or the page's, for a shape that keeps its page position), so it stays against that text. `z` orders the shapes of a document.
 */
export function wordShapeAnchor(shape: PageShape, drawingId: number): string {
  const content: PdfContentShape = {
    kind: shape.kind,
    x0: 0,
    y0: 0,
    x1: shape.width,
    y1: shape.height,
    ...(shape.fill === undefined ? {} : { fill: Number.parseInt(shape.fill, HEX_RADIX) }),
    ...(shape.stroke === undefined ? {} : { stroke: Number.parseInt(shape.stroke, HEX_RADIX), strokeWidth: shape.strokeWidthPt ?? 0 }),
    ...(shape.alpha === undefined ? {} : { alpha: shape.alpha }),
    ...(shape.path === undefined ? {} : { path: shape.path }),
    z: drawingId,
  };
  const cx = Math.max(inEmu(shape.width), 1);
  const cy = Math.max(inEmu(shape.height), 1);
  return (
    `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${drawingId}" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1">` +
    '<wp:simplePos x="0" y="0"/>' +
    `<wp:positionH relativeFrom="page"><wp:posOffset>${inEmu(shape.x)}</wp:posOffset></wp:positionH>` +
    `<wp:positionV relativeFrom="${shape.pageRelative ? 'page' : 'paragraph'}"><wp:posOffset>${inEmu(shape.y)}</wp:posOffset></wp:positionV>` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>` +
    `<wp:docPr id="${drawingId}" name="Shape ${drawingId}"/><wp:cNvGraphicFramePr/>` +
    `<a:graphic><a:graphicData uri="${NS_WPS}"><wps:wsp><wps:cNvSpPr/>${shapeProperties(content, OWN_FRAME, 'wps:spPr')}<wps:bodyPr/></wps:wsp></a:graphicData></a:graphic>` +
    '</wp:anchor></w:drawing></w:r>'
  );
}
