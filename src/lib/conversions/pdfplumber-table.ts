/*
 * A literal translation to TypeScript of the table finder of pdfplumber: the edges of a page (`snap_edges`, `join_edge_group`,
 * `merge_edges`, `words_to_edges_h`, `words_to_edges_v`), their crossings (`edges_to_intersections`), the cells those crossings
 * enclose (`intersections_to_cells`), the tables the cells make (`cells_to_tables`), and `TableSettings`, `TableFinder`, `Table`, `Row`
 * and `Column` that run them, with the helpers they call in `pdfplumber/utils` (clustering and geometry).
 *
 * Source: https://github.com/jsvine/pdfplumber, commit 4c64b92d5caccd71c645e98e0fabb0c4dba7ff45 (version 0.11.10, 2026-06-14, MIT), files
 *   pdfplumber/table.py             (SHA-256 d3557440...d0eff)  the whole file but `Table.extract`
 *   pdfplumber/utils/clustering.py  (SHA-256 66ea35aa...ebef51) `cluster_list`, `make_cluster_dict`, `cluster_objects`
 *   pdfplumber/utils/geometry.py    (SHA-256 9f60a4a4...36243)  `objects_to_rect`, `objects_to_bbox`, `bbox_getter`, `obj_to_bbox`, `bbox_to_rect`,
 *                                                               `merge_bboxes`, `get_bbox_overlap`, `move_object`, `snap_objects`, `resize_object`,
 *                                                               `curve_to_edges`, `rect_to_edges`, `line_to_edge`, `obj_to_edges`, `filter_edges`
 *
 * The translation keeps the structure, the names, the branches, the comments and the constants of the Python, function by function: the
 * identifiers stay in snake_case, a Python dict of an edge or a word is a TypeScript object with the same keys, a tuple is an array, and
 * the standard-library calls (`sorted` with a tuple key, `itertools.groupby`, `set` of bounding boxes) are small helpers named for what
 * they do. What is not translated: `Table.extract`, which reads the characters of a page and calls `utils.extract_text`; `Table.page` is
 * kept for the finder's `page.edges`, `page.bbox` and `page.extract_words`, which the caller of this file gives (the page reader of this
 * repository has no characters, so it gives its rules and shapes as edges and its runs as words). Three things differ in form: an
 * argument that Python fills with `UNSET` (a float subclass compared with `is`) is `undefined`; a point used as a dict key is the
 * string of its two coordinates; the error classes of Python (`ValueError`, `TypeError`) are `RangeError` and `TypeError`. Changes for
 * this repository are made in other files and other commits, each with its reason in its message.
 *
 * Copyright (c) 2015, Jeremy Singer-Vine
 *
 * The MIT License (MIT)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * See NOTICE and docs/licensing.md.
 */
/* eslint-disable camelcase -- the identifiers are those of the Python source */

// pdfplumber/_typing.py

export type T_num = number;
export type T_point = readonly [number, number];
export type T_bbox = readonly [number, number, number, number];
/** The keys of a pdfplumber object that hold numbers, as the Python reads them with `obj[key]`. */
export type T_numkey = 'x0' | 'x1' | 'top' | 'bottom' | 'width' | 'height' | 'doctop' | 'y0' | 'y1';
/** A pdfplumber object (an edge, a rectangle, a word or a curve): a dict with these keys. */
export interface T_obj {
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  width?: number;
  height?: number;
  doctop?: number;
  y0?: number;
  y1?: number;
  orientation?: string | null;
  object_type?: string;
  pts?: readonly T_point[];
}
export type T_obj_list = T_obj[];
export type T_obj_iter = Iterable<T_obj>;

// Helpers for what Python writes with its standard library

/** A key of an object that must be there: Python's `obj[key]` raises `KeyError` when it is not. */
function item(obj: T_obj, key: T_numkey): number {
  const value = obj[key];
  if (value === undefined) throw new RangeError(`KeyError: '${key}'`);
  return value;
}

/** Python's comparison of two tuples of numbers (or strings): the first pair that differs decides. */
function compare_tuples(a: readonly (number | string)[], b: readonly (number | string)[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

/** Python's `itertools.groupby`: the runs of consecutive items with the same key. */
function groupby<T, K>(items: readonly T[], key: (value: T) => K, same: (a: K, b: K) => boolean): [K, T[]][] {
  const groups: [K, T[]][] = [];
  for (const value of items) {
    const k = key(value);
    const last = groups[groups.length - 1];
    if (last !== undefined && same(last[0], k)) last[1].push(value);
    else groups.push([k, [value]]);
  }
  return groups;
}

/** Python's `x in set` of bounding boxes, which are tuples: the four numbers are the key. */
function bbox_key(bbox: T_bbox): string {
  return bbox.join(',');
}

function point_key(point: T_point): string {
  return `${point[0]},${point[1]}`;
}

/**
 * Python's `sum` of floats. Since Python 3.12 it adds with Neumaier's compensation (`builtin_sum_impl` in Python/bltinmodule.c), so the
 * average of a cluster has the last digits that pdfplumber on a current Python gives, not those of a plain left to right sum.
 */
function sum(values: readonly number[]): number {
  let f_result = 0;
  let c = 0;
  for (const x of values) {
    const t = f_result + x;
    if (Math.abs(f_result) >= Math.abs(x)) c += f_result - t + x;
    else c += x - t + f_result;
    f_result = t;
  }
  if (c !== 0 && Number.isFinite(c)) f_result += c;
  return f_result;
}

// pdfplumber/utils/clustering.py

export function cluster_list(xs: number[], tolerance: T_num = 0): number[][] {
  if (tolerance === 0) return [...xs].sort((a, b) => a - b).map((x) => [x]);
  if (xs.length < 2) return [...xs].sort((a, b) => a - b).map((x) => [x]);
  const groups: number[][] = [];
  xs = [...xs].sort((a, b) => a - b);
  let current_group = [xs[0]];
  let last = xs[0];
  for (const x of xs.slice(1)) {
    if (x <= last + tolerance) {
      current_group.push(x);
    } else {
      groups.push(current_group);
      current_group = [x];
    }
    last = x;
  }
  groups.push(current_group);
  return groups;
}

export function make_cluster_dict(values: Iterable<number>, tolerance: T_num): Map<number, number> {
  const clusters = cluster_list([...new Set(values)], tolerance);

  const nested_tuples = clusters.map((value_cluster, i) => value_cluster.map((val): [number, number] => [val, i]));

  return new Map(nested_tuples.flat());
}

export function cluster_objects<T>(xs: T[], key_fn: T_numkey | ((x: T) => number), tolerance: T_num, preserve_order = false): T[][] {
  const get_key: (x: T) => number = typeof key_fn === 'function' ? key_fn : (x) => item(x as unknown as T_obj, key_fn);

  const values = xs.map(get_key);
  const cluster_dict = make_cluster_dict(values, tolerance);

  let cluster_tuples: [T, number][];
  if (preserve_order) {
    cluster_tuples = xs.map((x): [T, number] => [x, cluster_dict.get(get_key(x)) as number]);
  } else {
    cluster_tuples = xs.map((x): [T, number] => [x, cluster_dict.get(get_key(x)) as number]).sort((a, b) => a[1] - b[1]);
  }

  const grouped = groupby(cluster_tuples, (tuple) => tuple[1], (a, b) => a === b);

  return grouped.map(([, v]) => v.map((tuple) => tuple[0]));
}

// pdfplumber/utils/geometry.py

export function objects_to_rect(objects: Iterable<T_obj>): { x0: number; top: number; x1: number; bottom: number } {
  /** Given an iterable of objects, return the smallest rectangle (i.e. a dict with "x0", "top", "x1", and "bottom" keys) that contains them all. */
  return bbox_to_rect(objects_to_bbox(objects));
}

export function objects_to_bbox(objects: Iterable<T_obj>): T_bbox {
  /** Given an iterable of objects, return the smallest bounding box that contains them all. */
  return merge_bboxes([...objects].map(bbox_getter));
}

export function bbox_getter(obj: T_obj): T_bbox {
  return [item(obj, 'x0'), item(obj, 'top'), item(obj, 'x1'), item(obj, 'bottom')];
}

export function obj_to_bbox(obj: T_obj): T_bbox {
  /** Return the bounding box for an object. */
  const bbox: T_bbox = bbox_getter(obj);
  return bbox;
}

export function bbox_to_rect(bbox: T_bbox): { x0: number; top: number; x1: number; bottom: number } {
  /** Return the rectangle (i.e a dict with keys "x0", "top", "x1", "bottom") for an object. */
  return { x0: bbox[0], top: bbox[1], x1: bbox[2], bottom: bbox[3] };
}

export function merge_bboxes(bboxes: Iterable<T_bbox>): T_bbox {
  /** Given an iterable of bounding boxes, return the smallest bounding box that contains them all. */
  const list = [...bboxes];
  if (list.length === 0) throw new RangeError('ValueError: not enough values to unpack (expected 4, got 0)');
  return [Math.min(...list.map((b) => b[0])), Math.min(...list.map((b) => b[1])), Math.max(...list.map((b) => b[2])), Math.max(...list.map((b) => b[3]))];
}

export function get_bbox_overlap(a: T_bbox, b: T_bbox): T_bbox | null {
  const [a_left, a_top, a_right, a_bottom] = a;
  const [b_left, b_top, b_right, b_bottom] = b;
  const o_left = Math.max(a_left, b_left);
  const o_right = Math.min(a_right, b_right);
  const o_bottom = Math.min(a_bottom, b_bottom);
  const o_top = Math.max(a_top, b_top);
  const o_width = o_right - o_left;
  const o_height = o_bottom - o_top;
  if (o_height >= 0 && o_width >= 0 && o_height + o_width > 0) {
    return [o_left, o_top, o_right, o_bottom];
  }
  return null;
}

export function move_object(obj: T_obj, axis: string, value: T_num): T_obj {
  if (axis !== 'h' && axis !== 'v') throw new RangeError('AssertionError');
  let new_items: Partial<T_obj> = {};
  if (axis === 'h') {
    new_items = { x0: obj.x0 + value, x1: obj.x1 + value };
  }
  if (axis === 'v') {
    new_items = { top: obj.top + value, bottom: obj.bottom + value };
    if ('doctop' in obj) new_items.doctop = item(obj, 'doctop') + value;
    if ('y0' in obj) {
      new_items.y0 = item(obj, 'y0') - value;
      new_items.y1 = item(obj, 'y1') - value;
    }
  }
  return { ...obj, ...new_items };
}

export function snap_objects(objs: Iterable<T_obj>, attr: 'x0' | 'x1' | 'top' | 'bottom', tolerance: T_num): T_obj_list {
  const axis = { x0: 'h', x1: 'h', top: 'v', bottom: 'v' }[attr];
  const list_objs = [...objs];
  const clusters = cluster_objects(list_objs, attr, tolerance);
  const avgs = clusters.map((cluster) => sum(cluster.map((o) => item(o, attr))) / cluster.length);
  const snapped_clusters = clusters.map((cluster, index) => cluster.map((obj) => move_object(obj, axis, avgs[index] - item(obj, attr))));
  return snapped_clusters.flat();
}

export function resize_object(obj: T_obj, key: 'x0' | 'x1' | 'top' | 'bottom', value: T_num): T_obj {
  const old_value = item(obj, key);
  const diff = value - old_value;
  const new_items: Partial<T_obj> = { [key]: value };
  if (key === 'x0') {
    if (!(value <= obj.x1)) throw new RangeError('AssertionError');
    new_items.width = obj.x1 - value;
  } else if (key === 'x1') {
    if (!(value >= obj.x0)) throw new RangeError('AssertionError');
    new_items.width = value - obj.x0;
  } else if (key === 'top') {
    if (!(value <= obj.bottom)) throw new RangeError('AssertionError');
    new_items.doctop = item(obj, 'doctop') + diff;
    new_items.height = item(obj, 'height') - diff;
    if ('y1' in obj) new_items.y1 = item(obj, 'y1') - diff;
  } else if (key === 'bottom') {
    if (!(value >= obj.top)) throw new RangeError('AssertionError');
    new_items.height = item(obj, 'height') + diff;
    if ('y0' in obj) new_items.y0 = item(obj, 'y0') - diff;
  }
  return { ...obj, ...new_items };
}

export function curve_to_edges(curve: T_obj): T_obj_list {
  const pts = curve.pts as readonly T_point[];
  const edges: T_obj_list = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const p0 = pts[i];
    const p1 = pts[i + 1];
    edges.push({
      object_type: 'curve_edge',
      x0: Math.min(p0[0], p1[0]),
      x1: Math.max(p0[0], p1[0]),
      top: Math.min(p0[1], p1[1]),
      doctop: Math.min(p0[1], p1[1]) + (item(curve, 'doctop') - curve.top),
      bottom: Math.max(p0[1], p1[1]),
      width: Math.abs(p0[0] - p1[0]),
      height: Math.abs(p0[1] - p1[1]),
      orientation: p0[0] === p1[0] ? 'v' : p0[1] === p1[1] ? 'h' : null,
    });
  }
  return edges;
}

export function rect_to_edges(rect: T_obj): T_obj_list {
  const [top, bottom, left, right] = [0, 1, 2, 3].map(() => ({ ...rect }));
  Object.assign(top, {
    object_type: 'rect_edge',
    height: 0,
    y0: item(rect, 'y1'),
    bottom: rect.top,
    orientation: 'h',
  });
  Object.assign(bottom, {
    object_type: 'rect_edge',
    height: 0,
    y1: item(rect, 'y0'),
    top: rect.top + item(rect, 'height'),
    doctop: item(rect, 'doctop') + item(rect, 'height'),
    orientation: 'h',
  });
  Object.assign(left, {
    object_type: 'rect_edge',
    width: 0,
    x1: rect.x0,
    orientation: 'v',
  });
  Object.assign(right, {
    object_type: 'rect_edge',
    width: 0,
    x0: rect.x1,
    orientation: 'v',
  });
  return [top, bottom, left, right];
}

export function line_to_edge(line: T_obj): T_obj {
  const edge = { ...line };
  edge.orientation = line.top === line.bottom ? 'h' : 'v';
  return edge;
}

export function obj_to_edges(obj: T_obj): T_obj_list {
  const t = obj.object_type as string;
  if (t.includes('_edge')) {
    return [obj];
  } else if (t === 'line') {
    return [line_to_edge(obj)];
  }
  const convert = ({ rect: rect_to_edges, curve: curve_to_edges } as Record<string, (o: T_obj) => T_obj_list>)[t];
  if (convert === undefined) throw new RangeError(`KeyError: '${t}'`);
  return convert(obj);
}

export function filter_edges(edges: Iterable<T_obj>, orientation: string | null = null, edge_type: string | null = null, min_length: T_num = 1): T_obj_list {
  if (orientation !== 'v' && orientation !== 'h' && orientation !== null) {
    throw new RangeError("ValueError: Orientation must be 'v' or 'h'");
  }

  function test(e: T_obj): boolean {
    const dim = e.orientation === 'v' ? 'height' : 'width';
    const et_correct = edge_type !== null ? e.object_type === edge_type : true;
    const orient_correct = orientation === null || e.orientation === orientation;
    return Boolean(et_correct && orient_correct && item(e, dim) >= min_length);
  }

  return [...edges].filter(test);
}

// pdfplumber/table.py

export const DEFAULT_SNAP_TOLERANCE = 3;
export const DEFAULT_JOIN_TOLERANCE = 3;
export const DEFAULT_MIN_WORDS_VERTICAL = 3;
export const DEFAULT_MIN_WORDS_HORIZONTAL = 1;

export interface T_intersection {
  v: T_obj_list;
  h: T_obj_list;
}
/** The points of the crossings, by the string of their two coordinates (`point_key`); the point is kept with its edges. */
export type T_intersections = Map<string, { point: T_point; edges: T_intersection }>;
export type T_table_settings = TableSettingsInit | TableSettings;

/** What `TableFinder` asks of a page: its box, its edges (`page.edges`) and the words of `page.extract_words`. */
export interface Page {
  bbox: T_bbox;
  edges: T_obj_list;
  extract_words?: (settings: Record<string, unknown>) => T_obj_list;
}

export function snap_edges(edges: T_obj_list, x_tolerance: T_num = DEFAULT_SNAP_TOLERANCE, y_tolerance: T_num = DEFAULT_SNAP_TOLERANCE): T_obj_list {
  /**
   * Given a list of edges, snap any within `tolerance` pixels of one another
   * to their positional average.
   */
  const by_orientation: { v: T_obj_list; h: T_obj_list } = { v: [], h: [] };
  for (const e of edges) {
    by_orientation[e.orientation as 'v' | 'h'].push(e);
  }

  const snapped_v = snap_objects(by_orientation.v, 'x0', x_tolerance);
  const snapped_h = snap_objects(by_orientation.h, 'top', y_tolerance);
  return [...snapped_v, ...snapped_h];
}

export function join_edge_group(edges: T_obj_iter, orientation: string, tolerance: T_num = DEFAULT_JOIN_TOLERANCE): T_obj_list {
  /**
   * Given a list of edges along the same infinite line, join those that
   * are within `tolerance` pixels of one another.
   */
  let min_prop: 'x0' | 'top';
  let max_prop: 'x1' | 'bottom';
  if (orientation === 'h') {
    [min_prop, max_prop] = ['x0', 'x1'];
  } else if (orientation === 'v') {
    [min_prop, max_prop] = ['top', 'bottom'];
  } else {
    throw new RangeError("ValueError: Orientation must be 'v' or 'h'");
  }

  const sorted_edges = [...edges].sort((a, b) => item(a, min_prop) - item(b, min_prop));
  const joined = [sorted_edges[0]];
  for (const e of sorted_edges.slice(1)) {
    const last = joined[joined.length - 1];
    if (item(e, min_prop) <= item(last, max_prop) + tolerance) {
      if (item(e, max_prop) > item(last, max_prop)) {
        // Extend current edge to new extremity
        joined[joined.length - 1] = resize_object(last, max_prop, item(e, max_prop));
      }
    } else {
      // Edge is separate from previous edges
      joined.push(e);
    }
  }

  return joined;
}

export function merge_edges(
  edges: T_obj_list,
  snap_x_tolerance: T_num,
  snap_y_tolerance: T_num,
  join_x_tolerance: T_num,
  join_y_tolerance: T_num
): T_obj_list {
  /**
   * Using the `snap_edges` and `join_edge_group` methods above,
   * merge a list of edges into a more "seamless" list.
   */

  function get_group(edge: T_obj): [string, T_num] {
    if (edge.orientation === 'h') {
      return ['h', edge.top];
    }
    return ['v', edge.x0];
  }

  if (snap_x_tolerance > 0 || snap_y_tolerance > 0) {
    edges = snap_edges(edges, snap_x_tolerance, snap_y_tolerance);
  }

  const _sorted = [...edges].sort((a, b) => compare_tuples(get_group(a), get_group(b)));
  const edge_groups = groupby(_sorted, get_group, (a, b) => a[0] === b[0] && a[1] === b[1]);
  const edge_gen = edge_groups.map(([k, items]) => join_edge_group(items, k[0], k[0] === 'h' ? join_x_tolerance : join_y_tolerance));
  return edge_gen.flat();
}

export function words_to_edges_h(words: T_obj_list, word_threshold: number = DEFAULT_MIN_WORDS_HORIZONTAL): T_obj_list {
  /**
   * Find (imaginary) horizontal lines that connect the tops
   * of at least `word_threshold` words.
   */
  const by_top = cluster_objects(words, 'top', 1);
  const large_clusters = by_top.filter((x) => x.length >= word_threshold);
  const rects = large_clusters.map(objects_to_rect);
  if (rects.length === 0) {
    return [];
  }
  const min_x0 = Math.min(...rects.map((r) => r.x0));
  const max_x1 = Math.max(...rects.map((r) => r.x1));

  const edges: T_obj_list = [];
  for (const r of rects) {
    edges.push(
      // Top of text
      {
        x0: min_x0,
        x1: max_x1,
        top: r.top,
        bottom: r.top,
        width: max_x1 - min_x0,
        orientation: 'h',
      },
      // For each detected row, we also add the 'bottom' line.  This will
      // generate extra edges, (some will be redundant with the next row
      // 'top' line), but this catches the last row of every table.
      {
        x0: min_x0,
        x1: max_x1,
        top: r.bottom,
        bottom: r.bottom,
        width: max_x1 - min_x0,
        orientation: 'h',
      }
    );
  }

  return edges;
}

export function words_to_edges_v(words: T_obj_list, word_threshold: number = DEFAULT_MIN_WORDS_VERTICAL): T_obj_list {
  /**
   * Find (imaginary) vertical lines that connect the left, right, or
   * center of at least `word_threshold` words.
   */
  // Find words that share the same left, right, or centerpoints
  const by_x0 = cluster_objects(words, 'x0', 1);
  const by_x1 = cluster_objects(words, 'x1', 1);

  function get_center(word: T_obj): T_num {
    return (word.x0 + word.x1) / 2;
  }

  const by_center = cluster_objects(words, get_center, 1);
  const clusters = [...by_x0, ...by_x1, ...by_center];

  // Find the points that align with the most words
  const sorted_clusters = [...clusters].sort((a, b) => b.length - a.length);
  const large_clusters = sorted_clusters.filter((x) => x.length >= word_threshold);

  // For each of those points, find the bboxes fitting all matching words
  const bboxes = large_clusters.map(objects_to_bbox);

  // Iterate through those bboxes, condensing overlapping bboxes
  const condensed_bboxes: T_bbox[] = [];
  for (const bbox of bboxes) {
    const overlap = condensed_bboxes.some((c) => Boolean(get_bbox_overlap(bbox, c)));
    if (!overlap) {
      condensed_bboxes.push(bbox);
    }
  }

  if (condensed_bboxes.length === 0) {
    return [];
  }

  const condensed_rects = condensed_bboxes.map(bbox_to_rect);
  const sorted_rects = [...condensed_rects].sort((a, b) => a.x0 - b.x0);

  const max_x1 = Math.max(...sorted_rects.map((r) => r.x1));
  const min_top = Math.min(...sorted_rects.map((r) => r.top));
  const max_bottom = Math.max(...sorted_rects.map((r) => r.bottom));

  return [
    ...sorted_rects.map(
      (b): T_obj => ({
        x0: b.x0,
        x1: b.x0,
        top: min_top,
        bottom: max_bottom,
        height: max_bottom - min_top,
        orientation: 'v',
      })
    ),
    {
      x0: max_x1,
      x1: max_x1,
      top: min_top,
      bottom: max_bottom,
      height: max_bottom - min_top,
      orientation: 'v',
    },
  ];
}

export function edges_to_intersections(edges: T_obj_list, x_tolerance: T_num = 1, y_tolerance: T_num = 1): T_intersections {
  /**
   * Given a list of edges, return the points at which they intersect
   * within `tolerance` pixels.
   */
  const intersections: T_intersections = new Map();
  const [v_edges, h_edges] = ['v', 'h'].map((o) => edges.filter((x) => x.orientation === o));
  const by_x0_top = (a: T_obj, b: T_obj): number => compare_tuples([a.x0, a.top], [b.x0, b.top]);
  const by_top_x0 = (a: T_obj, b: T_obj): number => compare_tuples([a.top, a.x0], [b.top, b.x0]);
  for (const v of [...v_edges].sort(by_x0_top)) {
    for (const h of [...h_edges].sort(by_top_x0)) {
      if (v.top <= h.top + y_tolerance && v.bottom >= h.top - y_tolerance && v.x0 >= h.x0 - x_tolerance && v.x0 <= h.x1 + x_tolerance) {
        const vertex: T_point = [v.x0, h.top];
        const key = point_key(vertex);
        let entry = intersections.get(key);
        if (entry === undefined) {
          entry = { point: vertex, edges: { v: [], h: [] } };
          intersections.set(key, entry);
        }
        entry.edges.v.push(v);
        entry.edges.h.push(h);
      }
    }
  }
  return intersections;
}

export function intersections_to_cells(intersections: T_intersections): T_bbox[] {
  /**
   * Given a list of points (`intersections`), return all rectangular "cells"
   * that those points describe.
   *
   * `intersections` should be a dictionary with (x0, top) tuples as keys,
   * and a list of edge objects as values. The edge objects should correspond
   * to the edges that touch the intersection.
   */

  function edge_connects(p1: T_point, p2: T_point): boolean {
    function edges_to_set(edges: T_obj_list): Set<string> {
      return new Set(edges.map((edge) => bbox_key(obj_to_bbox(edge))));
    }

    const at = (point: T_point): T_intersection => (intersections.get(point_key(point)) as { edges: T_intersection }).edges;

    if (p1[0] === p2[0]) {
      const other = edges_to_set(at(p2).v);
      const common = [...edges_to_set(at(p1).v)].filter((key) => other.has(key));
      if (common.length) {
        return true;
      }
    }

    if (p1[1] === p2[1]) {
      const other = edges_to_set(at(p2).h);
      const common = [...edges_to_set(at(p1).h)].filter((key) => other.has(key));
      if (common.length) {
        return true;
      }
    }
    return false;
  }

  const points = [...intersections.values()].map((entry) => entry.point).sort(compare_tuples);
  const n_points = points.length;

  function find_smallest_cell(points: T_point[], i: number): T_bbox | null {
    if (i === n_points - 1) {
      return null;
    }
    const pt = points[i];
    const rest = points.slice(i + 1);
    // Get all the points directly below and directly right
    const below = rest.filter((x) => x[0] === pt[0]);
    const right = rest.filter((x) => x[1] === pt[1]);
    for (const below_pt of below) {
      if (!edge_connects(pt, below_pt)) {
        continue;
      }

      for (const right_pt of right) {
        if (!edge_connects(pt, right_pt)) {
          continue;
        }

        const bottom_right: T_point = [right_pt[0], below_pt[1]];

        if (intersections.has(point_key(bottom_right)) && edge_connects(bottom_right, right_pt) && edge_connects(bottom_right, below_pt)) {
          return [pt[0], pt[1], bottom_right[0], bottom_right[1]];
        }
      }
    }
    return null;
  }

  const cells: T_bbox[] = [];
  for (let i = 0; i < n_points; i++) {
    const cell = find_smallest_cell(points, i);
    if (cell) cells.push(cell);
  }
  return cells;
}

export function cells_to_tables(cells: T_bbox[]): T_bbox[][] {
  /**
   * Given a list of bounding boxes (`cells`), return a list of tables that
   * hold those cells most simply (and contiguously).
   */

  function bbox_to_corners(bbox: T_bbox): [T_point, T_point, T_point, T_point] {
    const [x0, top, x1, bottom] = bbox;
    return [
      [x0, top],
      [x0, bottom],
      [x1, top],
      [x1, bottom],
    ];
  }

  const remaining_cells = [...cells];

  // Iterate through the cells found above, and assign them
  // to contiguous tables

  const current_corners = new Set<string>();
  const current_cells: T_bbox[] = [];

  const tables: T_bbox[][] = [];
  while (remaining_cells.length) {
    const initial_cell_count = current_cells.length;
    for (const cell of [...remaining_cells]) {
      const cell_corners = bbox_to_corners(cell);
      // If we're just starting a table ...
      if (current_cells.length === 0) {
        // ... immediately assign it to the empty group
        for (const corner of cell_corners) current_corners.add(point_key(corner));
        current_cells.push(cell);
        remaining_cells.splice(remaining_cells.indexOf(cell), 1);
      } else {
        // How many corners does this table share with the current group?
        const corner_count = cell_corners.filter((c) => current_corners.has(point_key(c))).length;

        // If touching on at least one corner...
        if (corner_count > 0) {
          // ... assign it to the current group
          for (const corner of cell_corners) current_corners.add(point_key(corner));
          current_cells.push(cell);
          remaining_cells.splice(remaining_cells.indexOf(cell), 1);
        }
      }
    }

    // If this iteration did not find any more cells to append...
    if (current_cells.length === initial_cell_count) {
      // ... start a new cell group
      tables.push([...current_cells]);
      current_corners.clear();
      current_cells.length = 0;
    }
  }

  // Once we have exhausting the list of cells ...

  // ... and we have a cell group that has not been stored
  if (current_cells.length) {
    // ... store it.
    tables.push([...current_cells]);
  }

  // Sort the tables top-to-bottom-left-to-right based on the value of the
  // topmost-and-then-leftmost coordinate of a table.
  const topmost_leftmost = (t: T_bbox[]): [number, number] =>
    t.map((c): [number, number] => [c[1], c[0]]).reduce((least, next) => (compare_tuples(next, least) < 0 ? next : least));
  const _sorted = [...tables].sort((a, b) => compare_tuples(topmost_leftmost(a), topmost_leftmost(b)));
  const filtered = _sorted.filter((t) => t.length > 1);
  return filtered;
}

export class CellGroup {
  cells: (T_bbox | null)[];
  bbox: T_bbox;

  constructor(cells: (T_bbox | null)[]) {
    this.cells = cells;
    const present = cells.filter((cell): cell is T_bbox => Boolean(cell));
    this.bbox = [Math.min(...present.map((c) => c[0])), Math.min(...present.map((c) => c[1])), Math.max(...present.map((c) => c[2])), Math.max(...present.map((c) => c[3]))];
  }
}

export class Row extends CellGroup {}

export class Column extends CellGroup {}

export class Table {
  page: Page;
  cells: T_bbox[];

  constructor(page: Page, cells: T_bbox[]) {
    this.page = page;
    this.cells = cells;
  }

  get bbox(): T_bbox {
    const c = this.cells;
    return [Math.min(...c.map((x) => x[0])), Math.min(...c.map((x) => x[1])), Math.max(...c.map((x) => x[2])), Math.max(...c.map((x) => x[3]))];
  }

  _get_rows_or_cols(kind: typeof Row | typeof Column): CellGroup[] {
    const axis = kind === Row ? 0 : 1;
    const antiaxis = Number(!axis);

    // Sort first by top/x0, then by x0/top
    const _sorted = [...this.cells].sort((a, b) => compare_tuples([a[antiaxis], a[axis]], [b[antiaxis], b[axis]]));

    // Sort get all x0s/tops
    const xs = [...new Set(this.cells.map((c) => c[axis]))].sort((a, b) => a - b);

    // Group by top/x0
    const grouped = groupby(_sorted, (c) => c[antiaxis], (a, b) => a === b);

    const rows: CellGroup[] = [];
    // for y/x, row/column-cells ...
    for (const [, row_cells] of grouped) {
      const xdict = new Map(row_cells.map((cell): [number, T_bbox] => [cell[axis], cell]));
      const row = new kind(xs.map((x) => xdict.get(x) ?? null));
      rows.push(row);
    }
    return rows;
  }

  get rows(): CellGroup[] {
    return this._get_rows_or_cols(Row);
  }

  get columns(): CellGroup[] {
    return this._get_rows_or_cols(Column);
  }
}

export const TABLE_STRATEGIES = ['lines', 'lines_strict', 'text', 'explicit'];
export const NON_NEGATIVE_SETTINGS = [
  'snap_tolerance',
  'snap_x_tolerance',
  'snap_y_tolerance',
  'join_tolerance',
  'join_x_tolerance',
  'join_y_tolerance',
  'edge_min_length',
  'edge_min_length_prefilter',
  'min_words_vertical',
  'min_words_horizontal',
  'intersection_tolerance',
  'intersection_x_tolerance',
  'intersection_y_tolerance',
] as const;

/** The fields `TableSettings` takes; a field left out has its default, and `undefined` is `UNSET` for the tolerances that fall back. */
export interface TableSettingsInit {
  vertical_strategy?: string;
  horizontal_strategy?: string;
  explicit_vertical_lines?: (T_obj | T_num)[] | null;
  explicit_horizontal_lines?: (T_obj | T_num)[] | null;
  snap_tolerance?: T_num;
  snap_x_tolerance?: T_num;
  snap_y_tolerance?: T_num;
  join_tolerance?: T_num;
  join_x_tolerance?: T_num;
  join_y_tolerance?: T_num;
  edge_min_length?: T_num;
  edge_min_length_prefilter?: T_num;
  min_words_vertical?: number;
  min_words_horizontal?: number;
  intersection_tolerance?: T_num;
  intersection_x_tolerance?: T_num;
  intersection_y_tolerance?: T_num;
  text_settings?: Record<string, unknown> | null;
}

const TABLE_SETTINGS_FIELDS = [
  'vertical_strategy',
  'horizontal_strategy',
  'explicit_vertical_lines',
  'explicit_horizontal_lines',
  'snap_tolerance',
  'snap_x_tolerance',
  'snap_y_tolerance',
  'join_tolerance',
  'join_x_tolerance',
  'join_y_tolerance',
  'edge_min_length',
  'edge_min_length_prefilter',
  'min_words_vertical',
  'min_words_horizontal',
  'intersection_tolerance',
  'intersection_x_tolerance',
  'intersection_y_tolerance',
  'text_settings',
];

export class TableSettings {
  vertical_strategy: string;
  horizontal_strategy: string;
  explicit_vertical_lines: (T_obj | T_num)[] | null;
  explicit_horizontal_lines: (T_obj | T_num)[] | null;
  snap_tolerance: T_num;
  snap_x_tolerance: T_num;
  snap_y_tolerance: T_num;
  join_tolerance: T_num;
  join_x_tolerance: T_num;
  join_y_tolerance: T_num;
  edge_min_length: T_num;
  edge_min_length_prefilter: T_num;
  min_words_vertical: number;
  min_words_horizontal: number;
  intersection_tolerance: T_num;
  intersection_x_tolerance: T_num;
  intersection_y_tolerance: T_num;
  text_settings: Record<string, unknown>;

  constructor(init: TableSettingsInit = {}) {
    // Python's dataclass takes no keyword it does not have
    for (const key of Object.keys(init)) {
      if (!TABLE_SETTINGS_FIELDS.includes(key)) throw new TypeError(`TableSettings.__init__() got an unexpected keyword argument '${key}'`);
    }
    this.vertical_strategy = init.vertical_strategy ?? 'lines';
    this.horizontal_strategy = init.horizontal_strategy ?? 'lines';
    this.explicit_vertical_lines = init.explicit_vertical_lines ?? null;
    this.explicit_horizontal_lines = init.explicit_horizontal_lines ?? null;
    this.snap_tolerance = init.snap_tolerance ?? DEFAULT_SNAP_TOLERANCE;
    this.snap_x_tolerance = init.snap_x_tolerance as number;
    this.snap_y_tolerance = init.snap_y_tolerance as number;
    this.join_tolerance = init.join_tolerance ?? DEFAULT_JOIN_TOLERANCE;
    this.join_x_tolerance = init.join_x_tolerance as number;
    this.join_y_tolerance = init.join_y_tolerance as number;
    this.edge_min_length = init.edge_min_length ?? 3;
    this.edge_min_length_prefilter = init.edge_min_length_prefilter ?? 1;
    this.min_words_vertical = init.min_words_vertical ?? DEFAULT_MIN_WORDS_VERTICAL;
    this.min_words_horizontal = init.min_words_horizontal ?? DEFAULT_MIN_WORDS_HORIZONTAL;
    this.intersection_tolerance = init.intersection_tolerance ?? 3;
    this.intersection_x_tolerance = init.intersection_x_tolerance as number;
    this.intersection_y_tolerance = init.intersection_y_tolerance as number;
    this.text_settings = (init.text_settings ?? null) as Record<string, unknown>;
    this.__post_init__();
  }

  __post_init__(): void {
    /**
     * Clean up user-provided table settings.
     *
     * Validates that the table settings provided consists of acceptable values and
     * returns a cleaned up version. The cleaned up version fills out the missing
     * values with the default values in the provided settings.
     *
     * TODO: Can be further used to validate that the values are of the correct
     *     type. For example, raising a value error when a non-boolean input is
     *     provided for the key ``keep_blank_chars``.
     *
     * :param table_settings: User-provided table settings.
     * :returns: A cleaned up version of the user-provided table settings.
     * :raises ValueError: When an unrecognised key is provided.
     */

    for (const setting of NON_NEGATIVE_SETTINGS) {
      if ((this[setting] || 0) < 0) {
        throw new RangeError(`ValueError: Table setting '${setting}' cannot be negative`);
      }
    }

    for (const orientation of ['horizontal', 'vertical'] as const) {
      const strategy = this[`${orientation}_strategy`];
      if (!TABLE_STRATEGIES.includes(strategy)) {
        throw new RangeError(`ValueError: ${orientation}_strategy must be one of{${TABLE_STRATEGIES.join(',')}}`);
      }
    }

    if (this.text_settings === null) {
      this.text_settings = {};
    }

    // This next section is for backwards compatibility
    for (const attr of ['x_tolerance', 'y_tolerance']) {
      if (!(attr in this.text_settings)) {
        this.text_settings[attr] = 'tolerance' in this.text_settings ? this.text_settings.tolerance : 3;
      }
    }

    if ('tolerance' in this.text_settings) {
      delete this.text_settings.tolerance;
    }
    // End of that section

    for (const [attr, fallback] of [
      ['snap_x_tolerance', 'snap_tolerance'],
      ['snap_y_tolerance', 'snap_tolerance'],
      ['join_x_tolerance', 'join_tolerance'],
      ['join_y_tolerance', 'join_tolerance'],
      ['intersection_x_tolerance', 'intersection_tolerance'],
      ['intersection_y_tolerance', 'intersection_tolerance'],
    ] as const) {
      if (this[attr] === undefined) {
        this[attr] = this[fallback];
      }
    }
  }

  static resolve(settings: T_table_settings | null | undefined): TableSettings {
    if (settings === null || settings === undefined) {
      return new TableSettings();
    } else if (settings instanceof TableSettings) {
      return settings;
    } else if (typeof settings === 'object' && !Array.isArray(settings)) {
      const core_settings: Record<string, unknown> = {};
      const text_settings: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(settings)) {
        if (k.slice(0, 5) === 'text_') {
          text_settings[k.slice(5)] = v;
        } else {
          core_settings[k] = v;
        }
      }
      core_settings.text_settings = text_settings;
      return new TableSettings(core_settings as TableSettingsInit);
    }
    throw new RangeError(`ValueError: Cannot resolve settings: ${JSON.stringify(settings)}`);
  }
}

export class TableFinder {
  /**
   * Given a PDF page, find plausible table structures.
   *
   * Largely borrowed from Anssi Nurminen's master's thesis:
   * http://dspace.cc.tut.fi/dpub/bitstream/handle/123456789/21520/Nurminen.pdf?sequence=3
   *
   * ... and inspired by Tabula:
   * https://github.com/tabulapdf/tabula-extractor/issues/16
   */
  page: Page;
  settings: TableSettings;
  edges: T_obj_list;
  intersections: T_intersections;
  cells: T_bbox[];
  tables: Table[];

  constructor(page: Page, settings?: T_table_settings | null) {
    this.page = page;
    this.settings = TableSettings.resolve(settings);
    this.edges = this.get_edges();
    this.intersections = edges_to_intersections(this.edges, this.settings.intersection_x_tolerance, this.settings.intersection_y_tolerance);
    this.cells = intersections_to_cells(this.intersections);
    this.tables = cells_to_tables(this.cells).map((cell_group) => new Table(this.page, cell_group));
  }

  get_edges(): T_obj_list {
    const settings = this.settings;

    for (const orientation of ['vertical', 'horizontal'] as const) {
      const strategy = settings[`${orientation}_strategy`];
      if (strategy === 'explicit') {
        const lines = settings[`explicit_${orientation}_lines`] ?? [];
        if (lines.length < 2) {
          throw new RangeError(`ValueError: If ${orientation}_strategy == 'explicit', explicit_${orientation}_lines must be specified as a list/tuple of two or more floats/ints.`);
        }
      }
    }

    const v_strat = settings.vertical_strategy;
    const h_strat = settings.horizontal_strategy;

    let words: T_obj_list = [];
    if (v_strat === 'text' || h_strat === 'text') {
      words = (this.page.extract_words as NonNullable<Page['extract_words']>)(settings.text_settings);
    }

    const v_explicit: T_obj_list = [];
    for (const desc of settings.explicit_vertical_lines ?? []) {
      if (typeof desc === 'object') {
        for (const e of obj_to_edges(desc)) {
          if (e.orientation === 'v') {
            v_explicit.push(e);
          }
        }
      } else {
        v_explicit.push({
          x0: desc,
          x1: desc,
          top: this.page.bbox[1],
          bottom: this.page.bbox[3],
          height: this.page.bbox[3] - this.page.bbox[1],
          orientation: 'v',
        });
      }
    }

    let v_base: T_obj_list = [];
    if (v_strat === 'lines') {
      v_base = filter_edges(this.page.edges, 'v', null, settings.edge_min_length_prefilter);
    } else if (v_strat === 'lines_strict') {
      v_base = filter_edges(this.page.edges, 'v', 'line', settings.edge_min_length_prefilter);
    } else if (v_strat === 'text') {
      v_base = words_to_edges_v(words, settings.min_words_vertical);
    } else if (v_strat === 'explicit') {
      v_base = [];
    }

    const v = [...v_base, ...v_explicit];

    const h_explicit: T_obj_list = [];
    for (const desc of settings.explicit_horizontal_lines ?? []) {
      if (typeof desc === 'object') {
        for (const e of obj_to_edges(desc)) {
          if (e.orientation === 'h') {
            h_explicit.push(e);
          }
        }
      } else {
        h_explicit.push({
          x0: this.page.bbox[0],
          x1: this.page.bbox[2],
          width: this.page.bbox[2] - this.page.bbox[0],
          top: desc,
          bottom: desc,
          orientation: 'h',
        });
      }
    }

    let h_base: T_obj_list = [];
    if (h_strat === 'lines') {
      h_base = filter_edges(this.page.edges, 'h', null, settings.edge_min_length_prefilter);
    } else if (h_strat === 'lines_strict') {
      h_base = filter_edges(this.page.edges, 'h', 'line', settings.edge_min_length_prefilter);
    } else if (h_strat === 'text') {
      h_base = words_to_edges_h(words, settings.min_words_horizontal);
    } else if (h_strat === 'explicit') {
      h_base = [];
    }

    const h = [...h_base, ...h_explicit];

    let edges = [...v, ...h];

    edges = merge_edges(edges, settings.snap_x_tolerance, settings.snap_y_tolerance, settings.join_x_tolerance, settings.join_y_tolerance);

    return filter_edges(edges, null, null, settings.edge_min_length);
  }
}
