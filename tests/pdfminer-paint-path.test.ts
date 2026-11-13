/* eslint-disable camelcase -- the identifiers are those of the Python source */
import { describe, expect, it } from 'vitest';
import {
  apply_matrix_pt,
  LTContainer,
  LTCurve,
  LTLine,
  LTRect,
  mult_matrix,
  PDFGraphicState,
  PDFLayoutAnalyzer,
  type Matrix,
  type PathSegment,
  type Point,
} from '../src/lib/conversions/pdfminer-paint-path';

/*
 * The tests of pdfminer.six for `paint_path`, translated from `TestPaintPath` of tests/test_converter.py (SHA-256 44c4f418...84bd15d) and the cases
 * of `test_mult_matrix` and `test_apply_matrix_pt` of tests/test_utils.py, at tag 20250506, commit 51683b2528e2aa685dd8b9e61f6ccf9f76a59a62
 * (MIT, Copyright (c) 2004-2016 Yusuke Shinyama; see NOTICE and docs/licensing.md). The paths and the expected results are the original's.
 * The last check of `test_paint_path_quadrilaterals` (the six lines of `samples/contrib/pr-00530-ml-lines.pdf`, read through pdfminer's
 * interpreter) is not here: it needs a PDF reader, which this module does not have.
 */

function _get_analyzer(): PDFLayoutAnalyzer {
  const analyzer = new PDFLayoutAnalyzer();
  analyzer.set_ctm([1, 0, 0, 1, 0, 0]);
  return analyzer;
}

describe('TestPaintPath', () => {
  it('test_paint_path', () => {
    const path: PathSegment[] = [
      ['m', 6, 7],
      ['l', 7, 7],
    ];
    const analyzer = _get_analyzer();
    analyzer.cur_item = new LTContainer([0, 100, 0, 100]);
    analyzer.paint_path(new PDFGraphicState(), false, false, false, path);
    expect(analyzer.cur_item._objs.length).toBe(1);
  });

  it('test_paint_path_mlllh', () => {
    const path: PathSegment[] = [['m', 6, 7], ['l', 7, 7], ['l', 7, 91], ['l', 6, 91], ['h']];
    const analyzer = _get_analyzer();
    analyzer.cur_item = new LTContainer([0, 100, 0, 100]);
    analyzer.paint_path(new PDFGraphicState(), false, false, false, path);
    expect(analyzer.cur_item.length).toBe(1);
  });

  it('test_paint_path_multiple_mlllh', () => {
    // Path from samples/contrib/issue-00369-excel.pdf
    const path: PathSegment[] = [
      ['m', 6, 7],
      ['l', 7, 7],
      ['l', 7, 91],
      ['l', 6, 91],
      ['h'],
      ['m', 4, 7],
      ['l', 6, 7],
      ['l', 6, 91],
      ['l', 4, 91],
      ['h'],
      ['m', 67, 2],
      ['l', 68, 2],
      ['l', 68, 3],
      ['l', 67, 3],
      ['h'],
    ];
    const analyzer = _get_analyzer();
    analyzer.cur_item = new LTContainer([0, 100, 0, 100]);
    analyzer.paint_path(new PDFGraphicState(), false, false, false, path);
    expect(analyzer.cur_item._objs.length).toBe(3);
  });

  it('test_paint_path_quadrilaterals', () => {
    // Via https://github.com/pdfminer/pdfminer.six/issues/473
    function parse(path: PathSegment[]) {
      const analyzer = _get_analyzer();
      analyzer.cur_item = new LTContainer([0, 1000, 0, 1000]);
      analyzer.paint_path(new PDFGraphicState(), false, false, false, path);
      return analyzer.cur_item._objs;
    }

    function get_types(path: PathSegment[]) {
      return parse(path).map((item) => item.constructor);
    }

    // Standard rect
    expect(get_types([['m', 10, 90], ['l', 90, 90], ['l', 90, 10], ['l', 10, 10], ['h']])).toEqual([LTRect]);

    // Same but mllll variation
    expect(get_types([['m', 10, 90], ['l', 90, 90], ['l', 90, 10], ['l', 10, 10], ['l', 10, 90]])).toEqual([LTRect]);

    // Same but mllllh variation
    expect(get_types([['m', 10, 90], ['l', 90, 90], ['l', 90, 10], ['l', 10, 10], ['l', 10, 90], ['h']])).toEqual([LTRect]);

    // Bowtie shape
    expect(get_types([['m', 110, 90], ['l', 190, 10], ['l', 190, 90], ['l', 110, 10], ['h']])).toEqual([LTCurve]);

    // Quadrilateral with one slanted side
    expect(get_types([['m', 210, 90], ['l', 290, 60], ['l', 290, 10], ['l', 210, 10], ['h']])).toEqual([LTCurve]);

    // Path with two rect subpaths
    expect(
      get_types([
        ['m', 310, 90],
        ['l', 350, 90],
        ['l', 350, 10],
        ['l', 310, 10],
        ['h'],
        ['m', 350, 90],
        ['l', 390, 90],
        ['l', 390, 10],
        ['l', 350, 10],
        ['h'],
      ])
    ).toEqual([LTRect, LTRect]);

    // Path with one rect subpath and one pentagon
    expect(
      get_types([
        ['m', 410, 90],
        ['l', 445, 90],
        ['l', 445, 10],
        ['l', 410, 10],
        ['h'],
        ['m', 455, 70],
        ['l', 475, 90],
        ['l', 490, 70],
        ['l', 490, 10],
        ['l', 455, 10],
        ['h'],
      ])
    ).toEqual([LTRect, LTCurve]);

    // Three types of simple lines
    expect(
      get_types([
        // Vertical line
        ['m', 10, 30],
        ['l', 10, 40],
        ['h'],
        // Horizontal line
        ['m', 10, 50],
        ['l', 70, 50],
        ['h'],
        // Diagonal line
        ['m', 10, 10],
        ['l', 30, 30],
        ['h'],
      ])
    ).toEqual([LTLine, LTLine, LTLine]);

    // Same as above, but 'ml' variation
    expect(
      get_types([
        // Vertical line
        ['m', 10, 30],
        ['l', 10, 40],
        // Horizontal line
        ['m', 10, 50],
        ['l', 70, 50],
        // Diagonal line
        ['m', 10, 10],
        ['l', 30, 30],
      ])
    ).toEqual([LTLine, LTLine, LTLine]);
  });

  // See section 4.4, table 4.9 of the PDF reference manual
  function parse_beziers(path: PathSegment[], graphicstate = new PDFGraphicState()) {
    const analyzer = _get_analyzer();
    analyzer.cur_item = new LTContainer([0, 1000, 0, 1000]);
    analyzer.paint_path(graphicstate, false, false, false, path);
    return analyzer.cur_item._objs as LTCurve[];
  }

  it('test_paint_path_beziers', () => {
    const expected: Point[] = [
      [72.41, 433.89],
      [71.41, 434.89],
    ];
    // "c" operator
    expect(
      parse_beziers([
        ['m', 72.41, 433.89],
        ['c', 72.41, 434.45, 71.96, 434.89, 71.41, 434.89],
      ])[0].pts
    ).toEqual(expected);

    // "v" operator
    expect(
      parse_beziers([
        ['m', 72.41, 433.89],
        ['v', 71.96, 434.89, 71.41, 434.89],
      ])[0].pts
    ).toEqual(expected);

    // "y" operator
    expect(
      parse_beziers([
        ['m', 72.41, 433.89],
        ['y', 72.41, 434.45, 71.41, 434.89],
      ])[0].pts
    ).toEqual(expected);
  });

  it('test_paint_path_beziers_check_raw', () => {
    // "c" operator
    expect(
      parse_beziers([
        ['m', 72.41, 433.89],
        ['c', 72.41, 434.45, 71.96, 434.89, 71.41, 434.89],
      ])[0].original_path
    ).toEqual([
      ['m', [72.41, 433.89]],
      ['c', [72.41, 434.45], [71.96, 434.89], [71.41, 434.89]],
    ]);
  });

  it('test_paint_path_dashed', () => {
    const graphicstate = new PDFGraphicState();
    graphicstate.dash = [[1, 1], 0];
    // "c" operator
    expect(
      parse_beziers(
        [
          ['m', 72.41, 433.89],
          ['c', 72.41, 434.45, 71.96, 434.89, 71.41, 434.89],
        ],
        graphicstate
      )[0].dashing_style
    ).toEqual([[1, 1], 0]);
  });

  it('test_paint_path_without_starting_m', () => {
    const gs = new PDFGraphicState();
    const analyzer = _get_analyzer();
    analyzer.cur_item = new LTContainer([0, 100, 0, 100]);
    const paths: PathSegment[][] = [
      [['h']],
      [['l', 72.41, 433.89], ['l', 82.41, 433.89], ['h']],
    ];
    for (const path of paths) {
      analyzer.paint_path(gs, false, false, false, path);
    }
    expect(analyzer.cur_item._objs.length).toBe(0);
  });
});

describe('the helpers of pdfminer/utils.py', () => {
  it.each<[Matrix, Matrix, Matrix]>([
    [[1, 0, 0, 1, 0, 0], [1, 0, 0, 1, 0, 0], [1, 0, 0, 1, 0, 0]],
    [[1, 2, 3, 2, -4, 1], [1, 0, 0, 1, 0, 0], [1, 2, 3, 2, -4, 1]],
    [[1, 2, 3, 2, -4, 1], [3, 4, 1, 2, -2, 1], [5, 8, 11, 16, -13, -13]],
    [[1, -1, 1, -1, 1, -1], [1, 1, 1, 1, 1, 1], [0, 0, 0, 0, 1, 1]],
  ])('test_mult_matrix', (m0, m1, expected) => {
    expect(mult_matrix(m0, m1)).toEqual(expected);
  });

  it.each<[Matrix, Point, Point]>([
    [[1, 0, 0, 1, 0, 0], [0, 0], [0, 0]],
    [[1, 0, 0, 1, 0, 0], [33, 21], [33, 21]],
    [[1, 2, 3, 2, -4, 1], [0, 0], [-4, 1]],
  ])('test_apply_matrix_pt', (m0, p0, expected) => {
    expect(apply_matrix_pt(m0, p0)).toEqual(expected);
  });
});
