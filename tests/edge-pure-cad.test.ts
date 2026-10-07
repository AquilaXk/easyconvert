import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/conversions/cad-nurbs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/conversions/cad-nurbs')>();
  return { ...actual, tessellateCadText: vi.fn(actual.tessellateCadText) };
});

import { tessellateCadText, type TessellatedMesh } from '../src/lib/conversions/cad-nurbs';
import { convertPureCad, encodeObj, encodeStl } from '../src/lib/edge/pure/pure-cad';
import { EdgeUnsupportedError } from '../src/lib/edge/workers/worker-errors';

function failureOf(work: () => unknown): Error {
  try {
    work();
  } catch (error) {
    return error as Error;
  }
  throw new Error('the call returned but was expected to throw');
}

const TRIANGLE: TessellatedMesh = {
  name: 'tri',
  vertices: [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
  ],
  faces: [[0, 1, 2]],
};

/** Hand-written from the STL format: the normal is the unit cross product (0, 0, 1). */
const TRIANGLE_STL = [
  'solid tri',
  '  facet normal 0 0 1',
  '    outer loop',
  '      vertex 0 0 0',
  '      vertex 1 0 0',
  '      vertex 0 1 0',
  '    endloop',
  '  endfacet',
  'endsolid tri',
  '',
].join('\n');

describe('pure CAD encoders refuse a face that points at no vertex (issue #480)', () => {
  it('writes a valid triangle as the ASCII STL of the specification', () => {
    expect(encodeStl(TRIANGLE)).toBe(TRIANGLE_STL);
  });

  it.each([
    ['past the last vertex', 3],
    ['far past the last vertex', 1_000_000],
    ['negative', -1],
    ['fractional', 1.5],
    ['not a number', Number.NaN],
  ])('refuses an STL face whose index is %s instead of drawing it at the origin', (_name, index) => {
    const mesh: TessellatedMesh = { ...TRIANGLE, faces: [[0, 1, index]] };
    const error = failureOf(() => encodeStl(mesh));
    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect(error.message).toMatch(/face 0 .*vertex index/);
    expect(error.message).toContain(`${index}`);
  });

  it('names the face and the vertex count when a later face dangles', () => {
    const mesh: TessellatedMesh = { ...TRIANGLE, faces: [[0, 1, 2], [2, 1, 0], [0, 2, 9]] };
    const error = failureOf(() => encodeStl(mesh));
    expect(error.message).toMatch(/face 2 .*9.* 3 vertices/);
  });

  it('refuses a dangling index in the first corner of a polygon fan too', () => {
    const quad: TessellatedMesh = { ...TRIANGLE, faces: [[7, 0, 1, 2]] };
    const error = failureOf(() => encodeStl(quad));
    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect(error.message).toMatch(/face 0 has vertex index 7, but the mesh has 3 vertices/);
  });

  it('refuses a dangling index in OBJ instead of writing a face that points past the vertices', () => {
    const mesh: TessellatedMesh = { ...TRIANGLE, faces: [[0, 1, 5]] };
    const error = failureOf(() => encodeObj(mesh));
    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect(error.message).toMatch(/face 0 .*vertex index 5/);
  });

  it('refuses a vertex that is not three numbers', () => {
    const mesh = { ...TRIANGLE, vertices: [[0, 0], [1, 0, 0], [0, 1, 0]] } as unknown as TessellatedMesh;
    const error = failureOf(() => encodeStl(mesh));
    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect(error.message).toMatch(/vertex 0/);
  });

  it('still skips a face of fewer than three corners, which has no area to write', () => {
    const mesh: TessellatedMesh = { ...TRIANGLE, faces: [[0, 1], [0, 1, 2]] };
    expect(encodeStl(mesh).match(/facet normal/g)).toHaveLength(1);
  });

  it.each(['stl', 'obj'])('stops a STEP conversion to %s when the tessellated mesh has a dangling index', (target) => {
    vi.mocked(tessellateCadText).mockReturnValueOnce({ ...TRIANGLE, faces: [[0, 1, 4]] });
    const error = failureOf(() => convertPureCad('ISO-10303-21;', 'step', target, 'part'));
    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect(error.message).toMatch(/vertex index 4/);
  });

  it('converts a valid mesh to the STL it describes', () => {
    vi.mocked(tessellateCadText).mockReturnValueOnce(TRIANGLE);
    const result = convertPureCad('ISO-10303-21;', 'step', 'stl', 'part');
    expect(result.text).toBe(TRIANGLE_STL);
    expect(Buffer.from(result.data).toString('utf8')).toBe(TRIANGLE_STL);
  });
});
