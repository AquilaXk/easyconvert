import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { officeFiles } from '../bench/corpus/generate-office';
import { vectorCadFiles } from '../bench/corpus/generate-vector-cad';

/**
 * The generators of the vector, CAD and office parts of the benchmark corpus are pure functions of their constants:
 * what they write now is what is committed (and listed in manifest.json, which tests/bench-corpus.test.ts checks), so the
 * ground truth the rows are scored by cannot drift from the files without this test failing.
 */

const CORPUS_DIR = path.join(__dirname, '..', 'bench', 'corpus');
/** The analytic rasterisation takes a few seconds, and a loaded runner takes longer. */
const GENERATOR_TIMEOUT_MS = 120_000;

/** Each generator runs once for all the checks of this file. */
const once = <T>(make: () => Promise<T>): (() => Promise<T>) => {
  let pending: Promise<T> | undefined;
  return () => (pending ??= make());
};
const vectorCad = once(vectorCadFiles);
const office = once(officeFiles);

async function pixels(file: Buffer): Promise<Buffer> {
  return sharp(file).raw().toBuffer();
}

describe.each([
  ['vector and CAD', vectorCad],
  ['office', office],
])('the %s generator', (_name, generate) => {
  it('writes the committed files', async () => {
    const files = await generate();
    expect(files.size).toBeGreaterThan(0);
    for (const [relative, data] of files) {
      const committed = fs.readFileSync(path.join(CORPUS_DIR, relative));
      if (relative.endsWith('.png')) expect((await pixels(committed)).equals(await pixels(data as Buffer)), relative).toBe(true);
      else if (relative.endsWith('.xlsx')) expect(committed.length, relative).toBe((data as Buffer).length);
      else expect(committed.toString('utf8'), relative).toBe(data.toString());
    }
  }, GENERATOR_TIMEOUT_MS);
});

describe('the ground truth of the vector and CAD parts', () => {
  it('draws the shapes the SVG and the EPS name, with exact coverage at the edges', async () => {
    const files = await vectorCad();
    const { data, info } = await sharp(files.get('vector/shapes.truth.png') as Buffer).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height, info.channels]).toEqual([400, 300, 3]);
    const at = (x: number, y: number): number[] => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)];
    expect(at(50, 100)).toEqual([214, 39, 40]);
    expect(at(10, 10)).toEqual([255, 255, 255]);
    expect(at(200, 150)).toEqual([255, 255, 255]);
    // The left edge of the red rectangle lies on x = 20: pixel 19 is white and pixel 20 is fully red.
    expect(at(19, 60)).toEqual([255, 255, 255]);
    expect(at(20, 60)).toEqual([214, 39, 40]);
    expect(files.get('vector/shapes.svg')).toContain('<rect x="20" y="20" width="160" height="120" fill="#d62728"/>');
    expect(files.get('vector/shapes.eps')).toContain('0.84 0.15 0.16 setrgbcolor 20 160 160 120 rectfill');
  }, GENERATOR_TIMEOUT_MS);

  it('lists in the truth of each plate every outline of its DXF, ellipse, spline and block included only in the full plate', async () => {
    const files = await vectorCad();
    const count = (name: string): number => (JSON.parse(files.get(name) as string) as { strokes: unknown[] }).strokes.length;
    const entities = (name: string, type: string): number => (files.get(name) as string).split('\n').filter((line, i, lines) => line === type && lines[i - 1]?.trim() === '0').length;
    expect(count('cad/plate-basic.truth.json')).toBe(['LINE', 'ARC', 'CIRCLE', 'LWPOLYLINE'].reduce((sum, type) => sum + entities('cad/plate-basic.dxf', type), 0));
    expect(entities('cad/plate-basic.dxf', 'ELLIPSE') + entities('cad/plate-basic.dxf', 'SPLINE') + entities('cad/plate-basic.dxf', 'INSERT')).toBe(0);
    expect(entities('cad/plate-full.dxf', 'ELLIPSE')).toBe(1);
    expect(entities('cad/plate-full.dxf', 'SPLINE')).toBe(1);
    expect(entities('cad/plate-full.dxf', 'INSERT')).toBe(2);
    expect(entities('cad/plate-full.dxf', 'POLYLINE')).toBe(1);
    // Two block references of two outlines each, a spline, an ellipse and a polyline are strokes of the full plate only.
    expect(count('cad/plate-full.truth.json') - count('cad/plate-basic.truth.json')).toBe(2 * 2 + 1 + 1 + 1);
  }, GENERATOR_TIMEOUT_MS);
});
