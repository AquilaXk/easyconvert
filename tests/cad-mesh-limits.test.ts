import { describe, expect, it, vi } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { MAX_MESH_TRIANGLES, MAX_MESH_VERTICES } from '../src/lib/conversions/vector-cad';
import { PayloadLimitError } from '../src/lib/types';

/**
 * The size of the meshes the in-process STL and OBJ readers build. A JavaScript array is made for every vertex and every face,
 * so a file of a few hundred megabytes would cost gigabytes: the limit of a binary STL (1,000,000 triangles) holds for every form.
 */

/** Hang guard only: a mesh at the limit parses in a few seconds; a reader with no limit runs out of memory instead. */
const MESH_HANG_GUARD_MS = 60_000;
vi.setConfig({ testTimeout: MESH_HANG_GUARD_MS });

const FACET = 'facet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\n';

const toDxf = (input: string, source: 'stl' | 'obj'): Promise<unknown> => convertFile(Buffer.from(input), source, 'dxf', {}, `mesh.${source}`);

describe('an ASCII STL', () => {
  it('is read up to the triangle limit', async () => {
    const result = await convertFile(Buffer.from(`solid m\n${FACET.repeat(1000)}endsolid m\n`), 'stl', 'dxf', {}, 'm.stl');
    expect(result.buffer.length).toBeGreaterThan(0);
  });

  it('with more facets than the triangle limit is refused with the 413 of the other input limits', async () => {
    await expect(toDxf(`solid m\n${FACET.repeat(MAX_MESH_TRIANGLES + 1)}endsolid m\n`, 'stl')).rejects.toBeInstanceOf(PayloadLimitError);
  });
});

describe('an OBJ', () => {
  it('with more vertices than the vertex limit is refused', async () => {
    await expect(toDxf(`${'v 0 0 0\n'.repeat(MAX_MESH_VERTICES + 1)}f 1 1 1\n`, 'obj')).rejects.toBeInstanceOf(PayloadLimitError);
  });

  it('with more faces than the triangle limit is refused', async () => {
    await expect(toDxf(`v 0 0 0\n${'f 1 1 1\n'.repeat(MAX_MESH_TRIANGLES + 1)}`, 'obj')).rejects.toBeInstanceOf(PayloadLimitError);
  });

  it('is read line by line as before, with Windows line ends', async () => {
    const result = await convertFile(Buffer.from('v 0 0 0\r\nv 1 0 0\r\nv 0 1 0\r\nf 1 2 3\r\n'), 'obj', 'stl', {}, 'tri.obj');
    expect(result.buffer.toString('utf8')).toContain('vertex');
  });
});
