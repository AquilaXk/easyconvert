import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPythonHelper } from './python-oracle';

/**
 * What trimesh, an independent mesh library, reads from the bytes of an STL or OBJ file: triangle count, surface area, bounding
 * box (in the units of the file), whether the surface is closed, and how many vertices the file lists before trimesh merges equal ones.
 */
export interface FileMeshFacts {
  triangles: number;
  area: number;
  min: number[];
  max: number[];
  watertight: boolean;
  /** Whether every shared edge is walked in opposite directions by its two triangles. */
  windingConsistent: boolean;
  /** Signed volume: positive when the triangles face outward, negative when they are turned inside out. */
  volume: number;
  unmergedVertices: number;
}

export function meshFacts(bytes: Buffer, extension: 'stl' | 'obj'): FileMeshFacts {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-facts-'));
  try {
    const file = path.join(dir, `model.${extension}`);
    fs.writeFileSync(file, bytes);
    return runPythonHelper<FileMeshFacts>('mesh_facts.py', [file]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
