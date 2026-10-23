import { describe, expect, it } from 'vitest';
import { annotationTextItems, type AnnotationWalk, type OperatorListLike } from '../src/lib/conversions/pdf-annotation-text';

/**
 * The walk over a pdf.js operator list, on lists written by hand. Expected positions are worked out from ISO 32000-1
 * sections 8.3.4 (matrices), 9.3 (text state) and 9.4 (text objects), and the gaps from the constants of
 * pdf.js's evaluator.js `getTextContent` (a gap over 0.102 em is a space, over 0.6 em it ends the item).
 */

const OPS = {
  save: 10,
  restore: 11,
  transform: 12,
  beginText: 31,
  setFont: 37,
  setCharSpacing: 38,
  setWordSpacing: 39,
  setHScale: 40,
  setLeading: 41,
  setTextRise: 42,
  moveText: 43,
  setLeadingMoveText: 44,
  nextLine: 45,
  setTextMatrix: 46,
  showText: 48,
  nextLineShowText: 50,
  nextLineSetSpacingShowText: 51,
  paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75,
  beginAnnotation: 80,
  endAnnotation: 81,
};

interface Glyph {
  unicode: string;
  width: number;
  isSpace?: boolean;
}

const glyphs = (text: string, width = 500): Glyph[] => [...text].map((unicode) => ({ unicode, width, isSpace: unicode === ' ' }));
const IDENTITY = [1, 0, 0, 1, 0, 0];

const walk = (vertical = false, fontMatrix?: number[]): AnnotationWalk => ({
  ops: OPS,
  fontOf: () => ({ vertical, fontMatrix }),
  normalize: (text) => text,
});

function list(ops: Array<[number, unknown[]?]>): OperatorListLike {
  return { fnArray: ops.map(([fn]) => fn), argsArray: ops.map(([, args]) => args ?? []) };
}

const annotation = (inside: Array<[number, unknown[]?]>, placement = [1, 0, 0, 1, 100, 200], own = IDENTITY): Array<[number, unknown[]?]> => [
  [OPS.beginAnnotation, ['1R', [0, 0, 1, 1], placement, own, false]],
  ...inside,
  [OPS.endAnnotation],
];

const read = (ops: Array<[number, unknown[]?]>, options: { vertical?: boolean; fontMatrix?: number[]; limit?: number } = {}) =>
  annotationTextItems(list(ops), walk(options.vertical, options.fontMatrix), options.limit ?? 100);

describe('annotation text items', () => {
  it('places a run under the box-to-rectangle matrix and the appearance matrix, and sizes it by the font', () => {
    const items = read(
      annotation([[OPS.beginText], [OPS.setFont, ['f1', 10]], [OPS.moveText, [3, 4]], [OPS.showText, [glyphs('abc')]]], [2, 0, 0, 2, 100, 200], [1, 0, 0, 1, 5, 0])
    );
    // ctm = own matrix, then placement: x = (3 + 5) * 2 + 100 = 116, y = 4 * 2 + 200 = 208; the font size 10 is doubled.
    expect(items).toHaveLength(1);
    expect(items[0].str).toBe('abc');
    expect(items[0].transform).toEqual([20, 0, 0, 20, 116, 208]);
    expect(items[0].fontName).toBe('f1');
    // three glyphs of 0.5 em at 10 units: 15 text-space units, 30 page units.
    expect(items[0].width).toBeCloseTo(30);
    expect(items[0].height).toBeCloseTo(20);
  });

  it('leaves out everything outside an annotation', () => {
    const ops: Array<[number, unknown[]?]> = [[OPS.beginText], [OPS.setFont, ['f1', 10]], [OPS.showText, [glyphs('page')]], ...annotation([[OPS.beginText], [OPS.setFont, ['f1', 10]], [OPS.showText, [glyphs('note')]]])];
    expect(read(ops).map((item) => item.str)).toEqual(['note']);
  });

  it('follows the text state: line matrix, leading, rise, horizontal scale and spacing', () => {
    const items = read(
      annotation(
        [
          [OPS.beginText],
          [OPS.setFont, ['f1', 10]],
          [OPS.setLeadingMoveText, [0, -12]],
          [OPS.setTextRise, [2]],
          [OPS.setHScale, [50]],
          [OPS.setCharSpacing, [1]],
          [OPS.showText, [glyphs('ab')]],
          [OPS.nextLine],
          [OPS.nextLineShowText, [glyphs('c')]],
        ],
        IDENTITY
      )
    );
    expect(items.map((item) => item.str)).toEqual(['ab', 'c']);
    // The first line is at y = -12 (rise 2 lifts the glyphs to -10); the leading is 12, so T* and the next line step to -24 and -36.
    expect(items[0].transform).toEqual([5, 0, 0, 10, 0, -10]);
    expect(items[1].transform[5]).toBeCloseTo(-36 + 2);
    // (500/1000 * 10 + 1) * 0.5 = 3 per glyph.
    expect(items[0].width).toBeCloseTo(6);
  });

  it('adds word spacing to a space glyph only', () => {
    const [item] = read(annotation([[OPS.beginText], [OPS.setFont, ['f1', 10]], [OPS.setWordSpacing, [4]], [OPS.showText, [glyphs('a b')]]], IDENTITY));
    expect(item.width).toBeCloseTo(3 * 5 + 4);
  });

  it('keeps saved state apart: a font set inside q and Q does not leak out', () => {
    const items = read(
      annotation(
        [
          [OPS.beginText],
          [OPS.setFont, ['f1', 10]],
          [OPS.save],
          [OPS.setFont, ['f2', 20]],
          [OPS.showText, [glyphs('x')]],
          [OPS.restore],
          [OPS.showText, [glyphs('y')]],
        ],
        IDENTITY
      )
    );
    expect(items.map((item) => [item.str, item.fontName, item.transform[0]])).toEqual([
      ['x', 'f2', 20],
      ['y', 'f1', 10],
    ]);
  });

  it('applies the matrix of a form XObject drawn inside the appearance', () => {
    const [item] = read(
      annotation([[OPS.paintFormXObjectBegin, [[1, 0, 0, 1, 7, 0], [0, 0, 10, 10]]], [OPS.beginText], [OPS.setFont, ['f1', 10]], [OPS.showText, [glyphs('f')]], [OPS.paintFormXObjectEnd]], IDENTITY)
    );
    expect(item.transform[4]).toBe(7);
  });

  it('adds a space for a TJ gap of a fifth of an em and ends the item at a gap past six tenths', () => {
    const shown = [...glyphs('ab'), -200, ...glyphs('cd'), -800, ...glyphs('ef')];
    const items = read(annotation([[OPS.beginText], [OPS.setFont, ['f1', 10]], [OPS.showText, [shown]]], IDENTITY));
    expect(items.map((item) => item.str)).toEqual(['ab cd', 'ef']);
    // The second item starts after four glyphs (20), the 0.2 em gap (2) and the 0.8 em gap (8).
    expect(items[1].transform[4]).toBeCloseTo(30);
  });

  it('keeps a small TJ kerning gap inside the item', () => {
    const [item] = read(annotation([[OPS.beginText], [OPS.setFont, ['f1', 10]], [OPS.showText, [[...glyphs('A'), 50, ...glyphs('V')]]]], IDENTITY));
    expect(item.str).toBe('AV');
  });

  it('scales glyph widths by a Type 3 font matrix', () => {
    const [item] = read(annotation([[OPS.beginText], [OPS.setFont, ['t3', 10]], [OPS.showText, [glyphs('t', 50)]]], IDENTITY), { fontMatrix: [0.01, 0, 0, 0.01, 0, 0] });
    expect(item.width).toBeCloseTo(50 * 0.01 * 10);
  });

  it('leaves out right-to-left letters, vertical fonts and runs of white space', () => {
    const run = (text: string, options: { vertical?: boolean } = {}) =>
      read(annotation([[OPS.beginText], [OPS.setFont, ['f1', 10]], [OPS.showText, [glyphs(text)]]], IDENTITY), options);
    expect(run('שלום')).toEqual([]);
    expect(run('abc', { vertical: true })).toEqual([]);
    expect(run('   ')).toEqual([]);
    expect(run('a')).toHaveLength(1);
  });

  it('ignores operators with missing or non-numeric operands instead of throwing', () => {
    const items = read(
      annotation([[OPS.beginText], [OPS.setFont, ['f1']], [OPS.setFont, ['f1', 10]], [OPS.moveText, ['x', 1]], [OPS.setTextMatrix, [[1, 2]]], [OPS.showText, [[null, 'x', ...glyphs('ok')]]]], IDENTITY)
    );
    expect(items.map((item) => item.str)).toEqual(['ok']);
  });

  it('stops at the limit it is given', () => {
    const inside: Array<[number, unknown[]?]> = [[OPS.beginText], [OPS.setFont, ['f1', 10]]];
    for (let i = 0; i < 50; i++) inside.push([OPS.showText, [glyphs('a')]]);
    expect(read(annotation(inside, IDENTITY), { limit: 7 })).toHaveLength(7);
  });
});
