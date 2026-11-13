/*
 * A literal translation to TypeScript of the part of pdfminer.six that sorts a painted path into a line, a rectangle or a curve:
 * `PDFLayoutAnalyzer.paint_path`, the layout objects it makes (`LTCurve`, `LTLine`, `LTRect`, with the `LTComponent` bounding box and the
 * `LTContainer` they are added to), the graphics state it reads (`PDFGraphicState`) and the helpers it calls (`get_bound`,
 * `apply_matrix_pt`, `mult_matrix`).
 *
 * Source: https://github.com/pdfminer/pdfminer.six, tag 20250506, commit 51683b2528e2aa685dd8b9e61f6ccf9f76a59a62 (MIT), files
 *   pdfminer/converter.py   (SHA-256 cc5a3c0c...fc468) lines 112 to 233: `PDFLayoutAnalyzer.paint_path`
 *   pdfminer/layout.py      (SHA-256 dd983371...5164da) `LTComponent` (`__init__`, `set_bbox`), `LTCurve`, `LTLine`, `LTRect` (lines 214 to 314),
 *                                                       `LTContainer` (`__init__`, `__len__`, `add`)
 *   pdfminer/utils.py       (SHA-256 51eb49b9...60812d) `INF`, `Point`, `Rect`, `Matrix`, `PathSegment`, `mult_matrix`, `apply_matrix_pt`, `get_bound`
 *   pdfminer/pdfinterp.py   (SHA-256 d2439dd0...b3cac)  `PDFGraphicState.__init__` (read, for the segment forms, also `do_m`, `do_l`, `do_c`, `do_v`,
 *                                                       `do_y`, `do_h` and `do_re`, which give `paint_path` its path)
 *   pdfminer/pdfdevice.py   (SHA-256 e46938f9...98266ed) `PDFDevice.set_ctm`
 *
 * The translation keeps the structure, the names, the branches, the comments and the constants of the Python, line by line: the identifiers
 * stay in snake_case, a Python tuple is a TypeScript array, `zip`, the slices with a step and the equality of two tuples are small helpers
 * named for what they do (`zip`, `every_other`, `same_point`). Two things differ in form: the optional arguments of `LTCurve`, `LTLine` and
 * `LTRect` (seven after the geometry) are one options object with the Python keyword names, because the repository's code-smell gate allows
 * six parameters, and the seven arguments `paint_path` repeats in each of its four calls are written once as `options`. What is not translated is what `paint_path` does not reach: the page and
 * figure handling, the text and image objects and the layout analysis of the rest of the classes, and the operator handlers of the
 * interpreter, since the page reader of this repository gets the segments of a path from pdf.js instead (where a rectangle is already
 * `m`, `l`, `l`, `l` and a close, as `do_re` writes it). Changes for this repository are made in other files and other commits,
 * each with its reason in its message.
 *
 * Copyright (c) 2004-2016  Yusuke Shinyama <yusuke at shinyama dot jp>
 *
 * Permission is hereby granted, free of charge, to any person
 * obtaining a copy of this software and associated documentation
 * files (the "Software"), to deal in the Software without
 * restriction, including without limitation the rights to use,
 * copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following
 * conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
 * KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
 * WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
 * PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
 * COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 * OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * See NOTICE and docs/licensing.md.
 */
/* eslint-disable camelcase -- the identifiers are those of the Python source */

// pdfminer/utils.py

// from sys import maxint as INF doesn't work anymore under Python3, but PDF
// still uses 32 bits ints
const INF = 2 ** 31 - 1;

export type Point = readonly [number, number];
export type Rect = readonly [number, number, number, number];
export type Matrix = readonly [number, number, number, number, number, number];
/** ('h',), ('m', x, y), ('l', x, y), ('v', x2, y2, x3, y3), ('y', x1, y1, x3, y3) or ('c', x1, y1, x2, y2, x3, y3). */
export type PathSegment = readonly [string, ...number[]];
/** The segments of `original_path`: the operator and its points, each one transformed. */
export type TransformedPathSegment = readonly [string, ...Point[]];
export type Color = number | readonly number[];

/** Python's `zip` of two sequences: the pairs, as many as the shorter one has. */
function zip<A, B>(a: readonly A[], b: readonly B[]): [A, B][] {
  const pairs: [A, B][] = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) pairs.push([a[i], b[i]]);
  return pairs;
}

/** Python's `seq[start::2]`. */
function every_other<T>(seq: readonly T[], start: number): T[] {
  return seq.filter((_, index) => index >= start && (index - start) % 2 === 0);
}

/** Python's `==` of two points (tuples of numbers). */
function same_point(a: Point, b: Point): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** Returns the multiplication of two matrices. */
export function mult_matrix(m1: Matrix, m0: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a0, b0, c0, d0, e0, f0] = m0;
  return [a0 * a1 + c0 * b1, b0 * a1 + d0 * b1, a0 * c1 + c0 * d1, b0 * c1 + d0 * d1, a0 * e1 + c0 * f1 + e0, b0 * e1 + d0 * f1 + f0];
}

/** Applies a matrix to a point. */
export function apply_matrix_pt(m: Matrix, v: Point): Point {
  const [a, b, c, d, e, f] = m;
  const [x, y] = v;
  return [a * x + c * y + e, b * x + d * y + f];
}

/** Compute a minimal rectangle that covers all the points. */
export function get_bound(pts: Iterable<Point>): Rect {
  let [x0, y0, x1, y1] = [INF, INF, -INF, -INF];
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

// pdfminer/pdfinterp.py

export class PDFGraphicState {
  linewidth: number = 0;
  linecap: unknown = null;
  linejoin: unknown = null;
  miterlimit: unknown = null;
  dash: readonly [unknown, unknown] | null = null;
  intent: unknown = null;
  flatness: unknown = null;

  // stroking color
  scolor: Color = 0;

  // non stroking color
  ncolor: Color = 0;
}

// pdfminer/layout.py

/** Object with a bounding box */
export class LTComponent {
  x0!: number;
  y0!: number;
  x1!: number;
  y1!: number;
  width!: number;
  height!: number;
  bbox!: Rect;

  constructor(bbox: Rect) {
    this.set_bbox(bbox);
  }

  set_bbox(bbox: Rect): void {
    const [x0, y0, x1, y1] = bbox;
    this.x0 = x0;
    this.y0 = y0;
    this.x1 = x1;
    this.y1 = y1;
    this.width = x1 - x0;
    this.height = y1 - y0;
    this.bbox = bbox;
  }
}

/** The optional arguments of `LTCurve`, `LTLine` and `LTRect`, which Python passes by position or by keyword and here are keywords. */
export interface LTCurveOptions {
  stroke?: boolean;
  fill?: boolean;
  evenodd?: boolean;
  stroking_color?: Color | null;
  non_stroking_color?: Color | null;
  original_path?: TransformedPathSegment[] | null;
  dashing_style?: readonly [unknown, unknown] | null;
}

/** A generic Bezier curve
 *
 * The parameter `original_path` contains the original
 * pathing information from the pdf (e.g. for reconstructing Bezier Curves).
 *
 * `dashing_style` contains the Dashing information if any.
 */
export class LTCurve extends LTComponent {
  pts: Point[];
  linewidth: number;
  stroke: boolean;
  fill: boolean;
  evenodd: boolean;
  stroking_color: Color | null;
  non_stroking_color: Color | null;
  original_path: TransformedPathSegment[] | null;
  dashing_style: readonly [unknown, unknown] | null;

  constructor(
    linewidth: number,
    pts: Point[],
    {
      stroke = false,
      fill = false,
      evenodd = false,
      stroking_color = null,
      non_stroking_color = null,
      original_path = null,
      dashing_style = null,
    }: LTCurveOptions = {}
  ) {
    super(get_bound(pts));
    this.pts = pts;
    this.linewidth = linewidth;
    this.stroke = stroke;
    this.fill = fill;
    this.evenodd = evenodd;
    this.stroking_color = stroking_color;
    this.non_stroking_color = non_stroking_color;
    this.original_path = original_path;
    this.dashing_style = dashing_style;
  }
}

/** A single straight line.
 *
 * Could be used for separating text or figures.
 */
export class LTLine extends LTCurve {
  constructor(linewidth: number, p0: Point, p1: Point, options: LTCurveOptions = {}) {
    super(linewidth, [p0, p1], options);
  }
}

/** A rectangle.
 *
 * Could be used for framing another pictures or figures.
 */
export class LTRect extends LTCurve {
  constructor(linewidth: number, bbox: Rect, options: LTCurveOptions = {}) {
    const [x0, y0, x1, y1] = bbox;
    super(
      linewidth,
      [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ],
      options
    );
  }
}

/** Object that can be extended and analyzed */
export class LTContainer<LTItemT extends LTComponent = LTComponent> extends LTComponent {
  _objs: LTItemT[] = [];

  get length(): number {
    return this._objs.length;
  }

  add(obj: LTItemT): void {
    this._objs.push(obj);
  }
}

// pdfminer/pdfdevice.py and pdfminer/converter.py

export class PDFLayoutAnalyzer {
  cur_item!: LTContainer;
  ctm!: Matrix;

  set_ctm(ctm: Matrix): void {
    this.ctm = ctm;
  }

  /** Paint paths described in section 4.4 of the PDF reference manual */
  paint_path(gstate: PDFGraphicState, stroke: boolean, fill: boolean, evenodd: boolean, path: readonly PathSegment[]): void {
    let shape = path.map((x) => x[0]).join('');

    if (shape.slice(0, 1) !== 'm') {
      // Per PDF Reference Section 4.4.1, "path construction operators may
      // be invoked in any sequence, but the first one invoked must be m
      // or re to begin a new subpath." Since pdfminer.six already
      // converts all `re` (rectangle) operators to their equivelent
      // `mlllh` representation, paths ingested by `.paint_path(...)` that
      // do not begin with the `m` operator are invalid.
    } else if (shape.split('m').length - 1 > 1) {
      // recurse if there are multiple m's in this shape
      for (const m of shape.matchAll(/m[^m]+/g)) {
        const subpath = path.slice(m.index, m.index + m[0].length);
        this.paint_path(gstate, stroke, fill, evenodd, subpath);
      }
    } else {
      // Although the 'h' command does not not literally provide a
      // point-position, its position is (by definition) equal to the
      // subpath's starting point.
      //
      // And, per Section 4.4's Table 4.9, all other path commands place
      // their point-position in their final two arguments. (Any preceding
      // arguments represent control points on Bézier curves.)
      const raw_pts = path.map((p) => (p[0] !== 'h' ? p.slice(-2) : path[0].slice(-2)) as unknown as Point);
      const pts = raw_pts.map((pt) => apply_matrix_pt(this.ctm, pt));

      const operators = path.map((operation) => String(operation[0]));
      const transformed_points = path.map((operation) =>
        zip(every_other(operation, 1), every_other(operation, 2)).map(([operand1, operand2]) =>
          apply_matrix_pt(this.ctm, [Number(operand1), Number(operand2)])
        )
      );
      const transformed_path = zip(operators, transformed_points).map(([o, p]) => [o, ...p] as TransformedPathSegment);

      // Drop a redundant "l" on a path closed with "h"
      if (shape.length > 3 && shape.slice(-2) === 'lh' && same_point(pts[pts.length - 2], pts[0])) {
        shape = shape.slice(0, -2) + 'h';
        pts.pop();
      }

      // The arguments `paint_path` gives each `LT` object after its geometry, which Python writes out in each call.
      const options: LTCurveOptions = {
        stroke,
        fill,
        evenodd,
        stroking_color: gstate.scolor,
        non_stroking_color: gstate.ncolor,
        original_path: transformed_path,
        dashing_style: gstate.dash,
      };

      if (shape === 'mlh' || shape === 'ml') {
        // single line segment
        //
        // Note: 'ml', in conditional above, is a frequent anomaly
        // that we want to support.
        const line = new LTLine(gstate.linewidth, pts[0], pts[1], options);
        this.cur_item.add(line);
      } else if (shape === 'mlllh' || shape === 'mllll') {
        const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = pts;

        const is_closed_loop = same_point(pts[0], pts[4]);
        const has_square_coordinates = (x0 === x1 && y1 === y2 && x2 === x3 && y3 === y0) || (y0 === y1 && x1 === x2 && y2 === y3 && x3 === x0);
        if (is_closed_loop && has_square_coordinates) {
          const rect = new LTRect(gstate.linewidth, [...pts[0], ...pts[2]] as unknown as Rect, options);
          this.cur_item.add(rect);
        } else {
          const curve = new LTCurve(gstate.linewidth, pts, options);
          this.cur_item.add(curve);
        }
      } else {
        const curve = new LTCurve(gstate.linewidth, pts, options);
        this.cur_item.add(curve);
      }
    }
  }
}
