import { describe, expect, it } from 'vitest';
import { graphNodeCharge, graphReservationUnits } from '../src/lib/jobs/graph-operations';

/** The charge rule of a graph node (docs/policy-decisions.md, entry 15), in the one module that owns it. */

const NOTHING_OPTIMIZED: never[] = [];

describe('what a graph node charges once it ended', () => {
  const PER_INPUT_OPERATIONS = [
    'convert',
    'ocr',
    'thumbnail',
    'media.package',
    'watermark',
    'pdf.watermark',
    'pdf.protect',
    'pdf.unlock',
    'pdf.split-pages',
    'pdf.extract-pages',
    'pdf.delete-pages',
    'pdf.reorder-pages',
    'pdf.rotate-pages',
  ];

  it.each(PER_INPUT_OPERATIONS)('charges a %s node, which makes one output of each input, one unit for each output', (op) => {
    expect(graphNodeCharge(op, { outputs: 3, optimizations: NOTHING_OPTIMIZED })).toBe(3);
  });

  it('charges an optimize node one unit for each output it made smaller', () => {
    const optimizations = [{ optimized: true }, { optimized: false }, { optimized: true }];
    expect(graphNodeCharge('optimize', { outputs: 3, optimizations })).toBe(2);
  });

  it.each(['merge', 'metadata', 'archive.create', 'archive.extract'])('charges a %s node, one job over all its inputs, one unit', (op) => {
    expect(graphNodeCharge(op, { outputs: 4, optimizations: NOTHING_OPTIMIZED })).toBe(1);
  });

  it('charges nothing for a node that produced nothing, an optimize node that gained nothing, an import or an export', () => {
    expect(graphNodeCharge('convert', { outputs: 0, optimizations: NOTHING_OPTIMIZED })).toBe(0);
    expect(graphNodeCharge('optimize', { outputs: 0, optimizations: NOTHING_OPTIMIZED })).toBe(0);
    expect(graphNodeCharge('optimize', { outputs: 2, optimizations: [{ optimized: false }, { optimized: false }] })).toBe(0);
    expect(graphNodeCharge('import.url', { outputs: 1, optimizations: NOTHING_OPTIMIZED })).toBe(0);
    expect(graphNodeCharge('export.internal', { outputs: 1, optimizations: NOTHING_OPTIMIZED })).toBe(0);
  });

  it('refuses an operation it does not know instead of charging it nothing', () => {
    expect(() => graphNodeCharge('teleport', { outputs: 1, optimizations: NOTHING_OPTIMIZED })).toThrow(/teleport/);
  });
});

describe('what a graph reserves when it is submitted', () => {
  it('reserves a node charged per output one unit for each input it declares, a one-job node one unit, and a move nothing', () => {
    expect(
      graphReservationUnits({
        a: { op: 'import.upload' },
        b: { op: 'import.url' },
        conv: { op: 'convert', input: ['a', 'b'] },
        text: { op: 'ocr', input: 'a' },
        thumb: { op: 'thumbnail', input: ['a', 'b'] },
        opt: { op: 'optimize', input: ['a', 'b'] },
        both: { op: 'merge', input: ['conv', 'text'] },
        out: { op: 'export.internal', input: ['both', 'thumb', 'opt'] },
      })
    ).toBe(8);
  });

  it('reserves nothing for a graph that only moves files', () => {
    expect(graphReservationUnits({ link: { op: 'import.url' }, out: { op: 'export.url', input: 'link' } })).toBe(0);
  });

  it('refuses an operation it does not know', () => {
    expect(() => graphReservationUnits({ odd: { op: 'teleport' } })).toThrow(/teleport/);
  });
});
