import { describe, expect, it } from 'vitest';
import { graphNodeCharge, graphReservationUnits } from '../src/lib/jobs/graph-operations';

/** The charge rule of a graph node (docs/policy-decisions.md, entry 15), in the one module that owns it. */

const NOTHING_OPTIMIZED: never[] = [];

describe('what a graph node charges once it ended', () => {
  it('charges a convert or ocr node one unit for each output it produced', () => {
    expect(graphNodeCharge('convert', { outputs: 3, optimizations: NOTHING_OPTIMIZED })).toBe(3);
    expect(graphNodeCharge('ocr', { outputs: 2, optimizations: NOTHING_OPTIMIZED })).toBe(2);
  });

  it('charges any other conversion one unit when it produced an output', () => {
    expect(graphNodeCharge('thumbnail', { outputs: 4, optimizations: NOTHING_OPTIMIZED })).toBe(1);
    expect(graphNodeCharge('optimize', { outputs: 2, optimizations: [{ optimized: true }, { optimized: false }] })).toBe(1);
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
  it('reserves a convert or ocr node one unit for each input it declares, any other conversion one unit, and a move nothing', () => {
    expect(
      graphReservationUnits({
        a: { op: 'import.upload' },
        b: { op: 'import.url' },
        conv: { op: 'convert', input: ['a', 'b'] },
        text: { op: 'ocr', input: 'a' },
        thumb: { op: 'thumbnail', input: ['a', 'b'] },
        out: { op: 'export.internal', input: ['conv', 'text', 'thumb'] },
      })
    ).toBe(4);
  });

  it('reserves nothing for a graph that only moves files', () => {
    expect(graphReservationUnits({ link: { op: 'import.url' }, out: { op: 'export.url', input: 'link' } })).toBe(0);
  });

  it('refuses an operation it does not know', () => {
    expect(() => graphReservationUnits({ odd: { op: 'teleport' } })).toThrow(/teleport/);
  });
});
