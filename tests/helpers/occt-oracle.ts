import { createRequire } from 'node:module';

/**
 * An independent reader and mesher of STEP and IGES: occt-import-js, a separate WebAssembly build of the Open CASCADE kernel
 * with its own tessellation settings, shared with nothing of this repository. A test reads a source file (or the file a
 * converter wrote) with it and compares the surface area and bounding box of what it meshes. Lengths come out in
 * millimetres whatever unit the file declares.
 */

const requireModule = createRequire(import.meta.url);

/** Chord deviation of 0.1 percent of the model's bounding box, and 0.5 radian between neighbouring triangles. */
const MESH_PARAMETERS = {
  linearUnit: 'millimeter',
  linearDeflectionType: 'bounding_box_ratio',
  linearDeflection: 0.001,
  angularDeflection: 0.5,
};

interface RawMesh {
  attributes: { position: { array: ArrayLike<number> } };
  index: { array: ArrayLike<number> };
  brep_faces?: unknown[];
}

interface RawResult {
  success: boolean;
  meshes: RawMesh[];
}

interface OcctImportModule {
  ReadStepFile(content: Uint8Array, params: object): RawResult;
  ReadIgesFile(content: Uint8Array, params: object): RawResult;
}

export interface OracleMesh {
  /** B-rep faces that were meshed. */
  faces: number;
  triangles: number;
  /** Surface area in square millimetres. */
  area: number;
  min: [number, number, number];
  max: [number, number, number];
}

let module: Promise<OcctImportModule> | undefined;

function loadModule(): Promise<OcctImportModule> {
  module ??= (requireModule('occt-import-js') as () => Promise<OcctImportModule>)();
  return module;
}

function triangleArea(p: ArrayLike<number>, a: number, b: number, c: number): number {
  const ux = p[3 * b] - p[3 * a];
  const uy = p[3 * b + 1] - p[3 * a + 1];
  const uz = p[3 * b + 2] - p[3 * a + 2];
  const vx = p[3 * c] - p[3 * a];
  const vy = p[3 * c + 1] - p[3 * a + 1];
  const vz = p[3 * c + 2] - p[3 * a + 2];
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

/** Reads a STEP or IGES file and returns the facts of its mesh; fails when the file is not read. */
export async function oracleFacts(bytes: Uint8Array, kind: 'step' | 'iges'): Promise<OracleMesh> {
  const occt = await loadModule();
  const result = kind === 'step' ? occt.ReadStepFile(bytes, MESH_PARAMETERS) : occt.ReadIgesFile(bytes, MESH_PARAMETERS);
  if (!result.success) throw new Error(`the independent reader did not read the ${kind} file`);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let area = 0;
  let triangles = 0;
  let faces = 0;
  for (const mesh of result.meshes) {
    const positions = mesh.attributes.position.array;
    const indices = mesh.index.array;
    faces += mesh.brep_faces?.length ?? 0;
    for (let i = 0; i < positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], positions[i + axis]);
        max[axis] = Math.max(max[axis], positions[i + axis]);
      }
    }
    for (let i = 0; i < indices.length; i += 3) {
      area += triangleArea(positions, indices[i], indices[i + 1], indices[i + 2]);
      triangles++;
    }
  }
  return { faces, triangles, area, min, max };
}
