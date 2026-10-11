import { describe, expect, it } from 'vitest';
import { parseDxfDrawing } from '../src/lib/conversions/cad-dxf';
import { CadExpansionLimitError, CadGeometryError, ConversionFailedError } from '../src/lib/types';

/**
 * A DXF is untrusted input read by a synchronous walk: what it can make that walk visit, allocate or loop over must be
 * bounded by the file's size, not by numbers inside it. Every case below is a small file; each must end in a typed refusal or
 * a finite drawing within a time and a heap growth that the assertions state.
 */

const pairs = (...items: Array<[number, string | number]>): string => `${items.map(([code, value]) => `${String(code).padStart(3, ' ')}\n${value}`).join('\n')}\n`;
const section = (name: string, body: string): string => `${pairs([0, 'SECTION'], [2, name])}${body}${pairs([0, 'ENDSEC'])}`;
const dxf = (entities: string, blocks = ''): string => `${blocks ? section('BLOCKS', blocks) : ''}${section('ENTITIES', entities)}${pairs([0, 'EOF'])}`;
const block = (name: string, body: string): string => pairs([0, 'BLOCK'], [2, name], [10, 0], [20, 0]) + body + pairs([0, 'ENDBLK']);
const insertArray = (name: string, columns: number, rows: number): string => pairs([0, 'INSERT'], [2, name], [70, columns], [71, rows], [44, 1], [45, 1]);
const LINE = pairs([0, 'LINE'], [10, 0], [20, 0], [11, 1], [21, 1]);

const FAST_MS = 3_000;
const HEAP_GROWTH_BYTES = 300 * 1024 * 1024;

function bounded<T>(run: () => T): { value?: T; error?: unknown; ms: number; heap: number } {
  const heapBefore = process.memoryUsage().heapUsed;
  const started = Date.now();
  try {
    return { value: run(), ms: Date.now() - started, heap: process.memoryUsage().heapUsed - heapBefore };
  } catch (error) {
    return { error, ms: Date.now() - started, heap: process.memoryUsage().heapUsed - heapBefore };
  }
}

describe('the expansion budget of a drawing', () => {
  it('refuses nested 1000 x 500 arrays of a block that draws nothing, fast and with a typed 422', () => {
    const file = dxf(insertArray('A', 1000, 500), block('E', '') + block('A', insertArray('E', 1000, 500)));
    const result = bounded(() => parseDxfDrawing(file));
    expect(result.error).toBeInstanceOf(CadExpansionLimitError);
    expect((result.error as CadExpansionLimitError).status).toBe(422);
    expect(result.ms).toBeLessThan(FAST_MS);
    expect(result.heap).toBeLessThan(HEAP_GROWTH_BYTES);
  });

  it('refuses nested arrays of a block that holds one TEXT, before the text fills the heap', () => {
    const text = pairs([0, 'TEXT'], [10, 0], [20, 0], [40, 1], [1, 'label']);
    const file = dxf(insertArray('A', 1000, 500), block('T', text) + block('A', insertArray('T', 1000, 500)));
    const result = bounded(() => parseDxfDrawing(file));
    expect(result.error).toBeInstanceOf(CadExpansionLimitError);
    expect(result.ms).toBeLessThan(FAST_MS);
    expect(result.heap).toBeLessThan(HEAP_GROWTH_BYTES);
  });

  it('refuses a pyramid of blocks of lines past the stroke and visit budget, and still draws a large honest drawing', () => {
    const pyramid = dxf(insertArray('A', 100, 100), block('B', LINE) + block('A', insertArray('B', 100, 100)));
    expect(bounded(() => parseDxfDrawing(pyramid)).error).toBeInstanceOf(CadExpansionLimitError);
    // 20,000 lines in one block array is an honest drawing (a hatch pattern, a perforated plate) and is drawn.
    const honest = dxf(insertArray('B', 200, 100), block('B', LINE));
    expect(parseDxfDrawing(honest).strokes).toHaveLength(20_000);
  });
});

describe('numbers that are not what they claim to be', () => {
  it('reduces a very large ARC angle into one turn, so the extents are finite and found at once', () => {
    const result = bounded(() => parseDxfDrawing(dxf(pairs([0, 'ARC'], [10, 0], [20, 0], [40, 5], [50, 1e20], [51, 1e20 + 1e4]))));
    expect(result.error).toBeUndefined();
    const { extents } = result.value as ReturnType<typeof parseDxfDrawing>;
    for (const value of Object.values(extents)) expect(Number.isFinite(value)).toBe(true);
    expect(result.ms).toBeLessThan(FAST_MS);
  });

  it.each([
    ['a degree no CAD program writes', 20_000],
    ['a degree above the bound', 26],
  ])('refuses a SPLINE of %s with a typed geometry error, without evaluating it', (_name, degree) => {
    const count = degree + 2;
    const knots = Array.from({ length: count + degree + 1 }, (_, i) => i);
    const spline = pairs([0, 'SPLINE'], [70, 8], [71, degree], ...knots.map((k): [number, number] => [40, k])) + Array.from({ length: count }, (_, i) => pairs([10, i], [20, i % 7])).join('');
    const result = bounded(() => parseDxfDrawing(dxf(spline)));
    expect(result.error).toBeInstanceOf(CadGeometryError);
    expect(result.ms).toBeLessThan(FAST_MS);
  });

  it('refuses a SPLINE whose knots decrease, whose knot count is wrong, or whose control points do not exceed the degree', () => {
    const control = [[0, 0], [1, 3], [4, 3], [5, 0]].map(([x, y]) => pairs([10, x], [20, y])).join('');
    const spline = (degree: number, knots: number[], controlPoints = control): string => dxf(pairs([0, 'SPLINE'], [70, 8], [71, degree], ...knots.map((k): [number, number] => [40, k])) + controlPoints);
    expect(() => parseDxfDrawing(spline(3, [0, 0, 0, 0, 1, 1, 1, 1]))).not.toThrow();
    expect(() => parseDxfDrawing(spline(3, [0, 0, 0, 1, 0, 1, 1, 1]))).toThrow(CadGeometryError);
    expect(() => parseDxfDrawing(spline(3, [0, 0, 0, 0, 1, 1, 1]))).toThrow(CadGeometryError);
    expect(() => parseDxfDrawing(spline(4, [0, 0, 0, 0, 0, 1, 1, 1, 1]))).toThrow(CadGeometryError);
  });

  it.each([
    ['text in an LWPOLYLINE vertex', pairs([0, 'LWPOLYLINE'], [90, 2], [70, 0], [10, 'abc'], [20, 0], [10, 1], [20, 1])],
    ['an overflowing LWPOLYLINE vertex', pairs([0, 'LWPOLYLINE'], [90, 2], [70, 0], [10, '1e999'], [20, 1], [10, 1], [20, 1])],
    ['an overflowing LINE end', pairs([0, 'LINE'], [10, 0], [20, 0], [11, '1e999'], [21, 0])],
    ['a circle radius that is not a number', pairs([0, 'CIRCLE'], [10, 0], [20, 0], [40, 'NaN'])],
  ])('refuses %s with a typed error, and never writes NaN into a drawing', (_name, entity) => {
    expect(() => parseDxfDrawing(dxf(entity))).toThrow(CadGeometryError);
  });

  it('refuses a drawing whose coordinates are finite but whose extent overflows', () => {
    const entity = pairs([0, 'LINE'], [10, -1.7e308], [20, 0], [11, 1.7e308], [21, 0]);
    expect(() => parseDxfDrawing(dxf(entity))).toThrow(ConversionFailedError);
  });
});

describe('a damaged DXF', () => {
  const sample = dxf(
    pairs([0, 'ARC'], [10, 5], [20, 5], [40, 10], [50, 90], [51, 180]) +
      pairs([0, 'LWPOLYLINE'], [90, 3], [70, 1], [10, 0], [20, 0], [42, 0.5], [10, 4], [20, 0], [10, 4], [20, 3]) +
      pairs([0, 'ELLIPSE'], [10, 1], [20, 1], [11, 3], [21, 0], [40, 0.5], [41, 0], [42, 6.28]) +
      pairs([0, 'SPLINE'], [70, 8], [71, 3], ...[0, 0, 0, 0, 1, 1, 1, 1].map((k): [number, number] => [40, k]), [10, 0], [20, 0], [10, 1], [20, 3], [10, 4], [20, 3], [10, 5], [20, 0]) +
      pairs([0, 'INSERT'], [2, 'B'], [10, 2], [20, 2], [41, 2], [42, 2], [50, 30], [70, 3], [71, 2], [44, 5], [45, 5]) +
      pairs([0, 'TEXT'], [10, 1], [20, 2], [40, 3], [1, 'plate']) +
      pairs([0, 'MTEXT'], [10, 1], [20, 9], [40, 2], [1, 'A\\PB']),
    block('B', LINE + pairs([0, 'CIRCLE'], [10, 0], [20, 0], [40, 1]))
  );
  /** The outcome classes a damaged file may have: a finite drawing within the budget, or a typed refusal. */
  function outcome(text: string): 'drawn' | 'refused' {
    const result = bounded(() => parseDxfDrawing(text));
    expect(result.ms, 'time of one damaged file').toBeLessThan(FAST_MS);
    if (result.error !== undefined) {
      expect(result.error, 'a damaged file ends in a typed refusal').toBeInstanceOf(ConversionFailedError);
      return 'refused';
    }
    const drawing = result.value as ReturnType<typeof parseDxfDrawing>;
    for (const value of Object.values(drawing.extents)) expect(Number.isFinite(value)).toBe(true);
    expect(drawing.strokes.length).toBeLessThanOrEqual(500_000);
    return 'drawn';
  }

  function prng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  it('is drawn when whole, and ends in a drawn or typed outcome when cut at any point', () => {
    expect(outcome(sample)).toBe('drawn');
    for (let cut = 0; cut < sample.length; cut += Math.ceil(sample.length / 120)) outcome(sample.slice(0, cut));
  });

  it('ends in a drawn or typed outcome for 400 files with bytes flipped or digits replaced', () => {
    const random = prng(2026);
    const classes = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const bytes = Buffer.from(sample, 'latin1');
      for (let flips = 1 + Math.floor(random() * 4); flips > 0; flips--) {
        const at = Math.floor(random() * bytes.length);
        bytes[at] = random() < 0.5 ? bytes[at] ^ (1 << Math.floor(random() * 8)) : '0123456789e.-+N'.charCodeAt(Math.floor(random() * 15));
      }
      classes.add(outcome(bytes.toString('latin1')));
    }
    expect(classes.has('drawn')).toBe(true);
  });
});
