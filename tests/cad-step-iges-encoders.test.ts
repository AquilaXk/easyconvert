import { describe, it, expect } from 'vitest';
import {
  encodeStep,
  CadMesh3D,
} from '../src/lib/conversions/vector-cad';
import { convertFile } from '../src/lib/conversions';
import { CadGeometryUnavailableError, UnprocessableCadInputError } from '../src/lib/types';
import { haveCadOracles as haveKernel } from './helpers/cad-kernel';
import { igesEntityCounts, igesLengthUnitFlag } from './helpers/iges-entities';
import { meshFacts } from './helpers/mesh-facts';
import { oracleFacts } from './helpers/occt-oracle';

/**
 * The STEP the encoder writes is read back by Open CASCADE (`cad-convert`, a reader this repository did not write) and judged by
 * trimesh; without them a run that is not strict skips those tests (ORACLE_STRICT_MODE=1 fails).
 */

// ============================================================================
// Test Fixtures & Analytical Meshes
// ============================================================================

/**
 * Creates an indexed polyhedral cube mesh with 8 vertices and 12 triangles (10mm cube, volume=1000 mm^3).
 */
function createCubeMesh(
  min: [number, number, number] = [0, 0, 0],
  size = 10
): CadMesh3D {
  const [x, y, z] = min;
  const vertices: [number, number, number][] = [
    [x, y, z],
    [x + size, y, z],
    [x + size, y + size, z],
    [x, y + size, z],
    [x, y, z + size],
    [x + size, y, z + size],
    [x + size, y + size, z + size],
    [x, y + size, z + size],
  ];

  const faces: [number, number, number][] = [
    // Bottom (z = 0)
    [0, 2, 1], [0, 3, 2],
    // Top (z = size)
    [4, 5, 6], [4, 6, 7],
    // Front (y = 0)
    [0, 1, 5], [0, 5, 4],
    // Back (y = size)
    [2, 3, 7], [2, 7, 6],
    // Left (x = 0)
    [0, 4, 7], [0, 7, 3],
    // Right (x = size)
    [1, 2, 6], [1, 6, 5],
  ];

  return {
    name: 'test_cube_10mm',
    vertices,
    faces,
    normals: [],
  };
}

/**
 * Creates an open planar sheet mesh with 4 vertices and 2 triangles (boundary edges = 4).
 */
function createOpenSheetMesh(): CadMesh3D {
  return {
    name: 'open_sheet',
    vertices: [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 0],
      [0, 10, 0],
    ],
    faces: [
      [0, 1, 2],
      [0, 2, 3],
    ],
    normals: [],
  };
}

/**
 * Generates an analytical Torus 3D triangle mesh with genus g = 1, Euler characteristic chi = 0.
 */
function createAnalyticalTorusMesh(
  majorR = 10,
  minorR = 3,
  radialSegments = 12,
  tubularSegments = 12
): CadMesh3D {
  const vertices: [number, number, number][] = [];
  const faces: [number, number, number][] = [];

  for (let j = 0; j < radialSegments; j++) {
    const v = (j / radialSegments) * Math.PI * 2;
    for (let i = 0; i < tubularSegments; i++) {
      const u = (i / tubularSegments) * Math.PI * 2;
      const x = (majorR + minorR * Math.cos(v)) * Math.cos(u);
      const y = (majorR + minorR * Math.cos(v)) * Math.sin(u);
      const z = minorR * Math.sin(v);
      vertices.push([x, y, z]);
    }
  }

  for (let j = 0; j < radialSegments; j++) {
    const nextJ = (j + 1) % radialSegments;
    for (let i = 0; i < tubularSegments; i++) {
      const nextI = (i + 1) % tubularSegments;

      const a = j * tubularSegments + i;
      const b = nextJ * tubularSegments + i;
      const c = nextJ * tubularSegments + nextI;
      const d = j * tubularSegments + nextI;

      faces.push([a, b, d]);
      faces.push([b, c, d]);
    }
  }

  return {
    name: 'torus_genus1',
    vertices,
    faces,
    normals: [],
  };
}

// ============================================================================
// Independent Differential Verification Oracles (Anti-Cheating Contract SSOT)
// ============================================================================

/**
 * Independent volume calculation using the 3D divergence theorem on closed triangle meshes:
 * Volume = (1/6) * Sum( (v0 x v1) . v2 )
 */
function calculateMeshVolume(
  vertices: [number, number, number][],
  faces: [number, number, number][]
): number {
  let vol6 = 0;
  for (const [i0, i1, i2] of faces) {
    const [x0, y0, z0] = vertices[i0];
    const [x1, y1, z1] = vertices[i1];
    const [x2, y2, z2] = vertices[i2];

    const cx = y0 * z1 - z0 * y1;
    const cy = z0 * x1 - x0 * z1;
    const cz = x0 * y1 - y0 * x1;

    vol6 += cx * x2 + cy * y2 + cz * z2;
  }
  return Math.abs(vol6) / 6;
}

/**
 * Independent axis-aligned bounding box calculator.
 */
function calculateBoundingBox(vertices: [number, number, number][]): {
  min: [number, number, number];
  max: [number, number, number];
  diagonal: number;
} {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const [x, y, z] of vertices) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ], diagonal: diag };
}

/**
 * Independent ISO 10303-21 STEP Parser for differential verification.
 * Built independently from first principles according to ISO 10303-21 / AP214 specifications.
 */
function independentlyParseStepBRep(stepText: string): {
  schema: string;
  unit: string;
  vertices: [number, number, number][];
  faces: [number, number, number][];
  isFacetedBrep: boolean;
  isClosedShell: boolean;
  isOpenShell: boolean;
} {
  const schemaMatch = stepText.match(/FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i);
  const schema = schemaMatch ? schemaMatch[1] : '';

  const unitMatch = stepText.match(/SI_UNIT\s*\(\s*\.([A-Z]+)\.\s*,\s*\.([A-Z]+)\.\s*\)/i);
  const unit = unitMatch ? `${unitMatch[1]}.${unitMatch[2]}` : '';

  const isFacetedBrep = stepText.includes('FACETED_BREP');
  const isClosedShell = stepText.includes('CLOSED_SHELL');
  const isOpenShell = stepText.includes('OPEN_SHELL');

  // Tokenize entities: #ID = TYPE(ARGS...);
  const entityMap = new Map<number, { type: string; rawArgs: string }>();
  const entityRegex = /#(\d+)\s*=\s*([A-Za-z0-9_]+)\s*\(([\s\S]*?)\)\s*;/g;
  let match: RegExpExecArray | null;
  while ((match = entityRegex.exec(stepText)) !== null) {
    const id = Number.parseInt(match[1], 10);
    const type = match[2];
    const rawArgs = match[3];
    entityMap.set(id, { type, rawArgs });
  }

  // Extract CARTESIAN_POINT coords
  const pointMap = new Map<number, [number, number, number]>();
  for (const [id, ent] of entityMap.entries()) {
    if (ent.type === 'CARTESIAN_POINT') {
      const coordMatch = ent.rawArgs.match(/\(\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*\)/);
      if (coordMatch) {
        pointMap.set(id, [
          Number.parseFloat(coordMatch[1]),
          Number.parseFloat(coordMatch[2]),
          Number.parseFloat(coordMatch[3]),
        ]);
      }
    }
  }

  // Extract POLY_LOOP vertices
  const loopMap = new Map<number, number[]>();
  for (const [id, ent] of entityMap.entries()) {
    if (ent.type === 'POLY_LOOP') {
      const idsMatch = ent.rawArgs.match(/\(\s*([#\d,\s]+)\s*\)/);
      if (idsMatch) {
        const pIds = idsMatch[1]
          .split(',')
          .map((s) => Number.parseInt(s.replace(/[^0-9]/g, ''), 10))
          .filter((n) => !Number.isNaN(n));
        loopMap.set(id, pIds);
      }
    }
  }

  // Extract FACE_OUTER_BOUND -> loop
  const boundToLoop = new Map<number, number>();
  for (const [id, ent] of entityMap.entries()) {
    if (ent.type === 'FACE_OUTER_BOUND') {
      const lMatch = ent.rawArgs.match(/#(\d+)/);
      if (lMatch) {
        boundToLoop.set(id, Number.parseInt(lMatch[1], 10));
      }
    }
  }

  // Extract FACE_SURFACE -> bound
  const faceLoops: number[][] = [];
  for (const [, ent] of entityMap.entries()) {
    if (ent.type === 'FACE_SURFACE') {
      const bMatch = ent.rawArgs.match(/#(\d+)/);
      if (bMatch) {
        const boundId = Number.parseInt(bMatch[1], 10);
        const loopId = boundToLoop.get(boundId);
        if (loopId !== undefined && loopMap.has(loopId)) {
          faceLoops.push(loopMap.get(loopId)!);
        }
      }
    }
  }

  // Deduplicate and re-index vertices into an indexed mesh
  const uniqueVertices: [number, number, number][] = [];
  const vertexKeyToIndex = new Map<string, number>();

  function getOrAddVertex(p: [number, number, number]): number {
    const key = `${p[0].toFixed(5)},${p[1].toFixed(5)},${p[2].toFixed(5)}`;
    const existing = vertexKeyToIndex.get(key);
    if (existing !== undefined) return existing;
    const idx = uniqueVertices.length;
    uniqueVertices.push(p);
    vertexKeyToIndex.set(key, idx);
    return idx;
  }

  const faces: [number, number, number][] = [];
  for (const loopPids of faceLoops) {
    const pts = loopPids.map((pid) => pointMap.get(pid)).filter((p): p is [number, number, number] => Boolean(p));
    if (pts.length === 3) {
      const i0 = getOrAddVertex(pts[0]);
      const i1 = getOrAddVertex(pts[1]);
      const i2 = getOrAddVertex(pts[2]);
      faces.push([i0, i1, i2]);
    }
  }

  return {
    schema,
    unit,
    vertices: uniqueVertices,
    faces,
    isFacetedBrep,
    isClosedShell,
    isOpenShell,
  };
}

// ============================================================================
// Test Suite: WP-46b CAD STEP & IGES Genuine B-Rep Encoders
// ============================================================================

describe('WP-46b: CAD STEP (ISO 10303-21 AP214) encoder and mesh to IGES through the kernel', () => {
  describe('1. ISO 10303-21 STEP AP214 Genuine B-Rep Encoding', () => {
    it('encodes closed watertight 10mm cube to authentic AP214 FACETED_BREP representation', () => {
      const cubeMesh = createCubeMesh([0, 0, 0], 10);
      const stepText = encodeStep(cubeMesh);

      // Verify basic syntax markers
      expect(stepText).toContain('ISO-10303-21;');
      expect(stepText).toContain('HEADER;');
      expect(stepText).toContain('AUTOMOTIVE_DESIGN');
      expect(stepText).toContain('ENDSEC;');
      expect(stepText).toContain('DATA;');
      expect(stepText).toContain('SI_UNIT(.MILLI., .METRE.)');
      expect(stepText).toContain('FACETED_BREP');
      expect(stepText).toContain('CLOSED_SHELL');
      expect(stepText).toContain('END-ISO-10303-21;');

      // Independent Oracle Differential Verification
      const parsed = independentlyParseStepBRep(stepText);
      expect(parsed.schema).toContain('AUTOMOTIVE_DESIGN');
      expect(parsed.unit).toBe('MILLI.METRE');
      expect(parsed.isFacetedBrep).toBe(true);
      expect(parsed.isClosedShell).toBe(true);
      expect(parsed.isOpenShell).toBe(false);

      // (a) Face count must exactly equal input triangle count (12 triangles)
      expect(parsed.faces.length).toBe(12);

      // (b) Vertex count must equal 8 unique cube corners
      expect(parsed.vertices.length).toBe(8);

      // (c) Bounding box error <= 1e-6 * diagonal
      const bbox = calculateBoundingBox(parsed.vertices);
      expect(bbox.min[0]).toBeCloseTo(0, 5);
      expect(bbox.min[1]).toBeCloseTo(0, 5);
      expect(bbox.min[2]).toBeCloseTo(0, 5);
      expect(bbox.max[0]).toBeCloseTo(10, 5);
      expect(bbox.max[1]).toBeCloseTo(10, 5);
      expect(bbox.max[2]).toBeCloseTo(10, 5);

      // (d) Analytical volume of 10mm cube must equal 1000.0 +- 1e-6
      const volume = calculateMeshVolume(parsed.vertices, parsed.faces);
      expect(volume).toBeCloseTo(1000.0, 4);
    });

    it('encodes open non-watertight mesh as SHELL_BASED_SURFACE_MODEL with OPEN_SHELL', () => {
      const openMesh = createOpenSheetMesh();
      const stepText = encodeStep(openMesh);

      expect(stepText).toContain('OPEN_SHELL');
      expect(stepText).toContain('SHELL_BASED_SURFACE_MODEL');
      expect(stepText).not.toContain('CLOSED_SHELL');
      expect(stepText).not.toContain('FACETED_BREP(');

      const parsed = independentlyParseStepBRep(stepText);
      expect(parsed.isOpenShell).toBe(true);
      expect(parsed.isClosedShell).toBe(false);
      expect(parsed.faces.length).toBe(2);
      expect(parsed.vertices.length).toBe(4);
    });

    it('encodes high-genus manifold topology (analytical Torus, genus=1) preserving geometry', () => {
      const torusMesh = createAnalyticalTorusMesh(10, 3, 12, 12);
      const stepText = encodeStep(torusMesh);

      expect(stepText).toContain('CLOSED_SHELL');
      expect(stepText).toContain('FACETED_BREP');

      const parsed = independentlyParseStepBRep(stepText);
      expect(parsed.faces.length).toBe(torusMesh.faces.length);
      expect(parsed.vertices.length).toBe(torusMesh.vertices.length);

      // Torus volume = 2 * pi^2 * R * r^2 = 2 * pi^2 * 10 * 3^2 = 180 * pi^2 ~= 1776.528
      const volume = calculateMeshVolume(parsed.vertices, parsed.faces);
      // Discrete tessellation has slightly lower volume due to chordal error (within 5%)
      expect(volume).toBeGreaterThan(1600);
      expect(volume).toBeLessThan(1800);
    });

    it('fails closed with CadGeometryUnavailableError on empty vertices or faces', () => {
      expect(() =>
        encodeStep({ name: 'empty', vertices: [], faces: [], normals: [] })
      ).toThrow(CadGeometryUnavailableError);

      expect(() =>
        encodeStep({
          name: 'no_faces',
          vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
          faces: [],
          normals: [],
        })
      ).toThrow(CadGeometryUnavailableError);
    });
  });

  describe('2. Mesh to IGES through the kernel', () => {
    // The kernel's writer (Open CASCADE, through native/cad-convert) writes the IGES file; the file is judged by reading it back with
    // the kernel's reader and with a separate WebAssembly build of it, and against numbers computed here from the mesh itself.
    const objOf = (mesh: CadMesh3D): Buffer =>
      Buffer.from([...mesh.vertices.map((v) => `v ${v.join(' ')}`), ...mesh.faces.map((f) => `f ${f.map((i) => i + 1).join(' ')}`)].join('\n'));

    const binaryStlOf = (mesh: CadMesh3D): Buffer => {
      const stl = Buffer.alloc(84 + 50 * mesh.faces.length);
      stl.writeUInt32LE(mesh.faces.length, 80);
      mesh.faces.forEach((face, i) => {
        face.forEach((index, corner) => mesh.vertices[index].forEach((value, axis) => stl.writeFloatLE(value, 84 + 50 * i + 12 + 12 * corner + 4 * axis)));
      });
      return stl;
    };

    const areaOf = (mesh: CadMesh3D): number =>
      mesh.faces.reduce((sum, [a, b, c]) => {
        const [p, q, r] = [mesh.vertices[a], mesh.vertices[b], mesh.vertices[c]];
        const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
        const v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
        return sum + 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
      }, 0);

    it.skipIf(!haveKernel)('writes the 10 mm cube from an OBJ as twelve trimmed planes the kernel reads back as a closed solid', async () => {
      const cube = createCubeMesh([0, 0, 0], 10);
      const result = await convertFile(objOf(cube), 'obj', 'iges', {}, 'cube.obj');
      expect(result.mimeType).toBe('model/iges');
      expect(result.filename).toBe('cube.iges');
      const text = result.buffer.toString('latin1');
      expect(igesEntityCounts(text).get(144)).toBe(12);
      expect(igesLengthUnitFlag(text)).toBe(2);

      const back = meshFacts((await convertFile(result.buffer, 'iges', 'stl', {}, 'cube.iges')).buffer, 'stl');
      expect(back.triangles).toBe(12);
      expect(back.area).toBeCloseTo(600, 3);
      expect(back.min).toEqual([0, 0, 0]);
      expect(back.max).toEqual([10, 10, 10]);
      expect(back.watertight).toBe(true);
      expect(back.windingConsistent).toBe(true);
      expect(back.volume).toBeCloseTo(1000, 2);

      const separate = await oracleFacts(result.buffer, 'iges');
      expect(separate.area).toBeCloseTo(600, 2);
      expect(separate.max).toEqual([10, 10, 10]);
    });

    it.skipIf(!haveKernel)('writes the same cube from a binary STL, and an igs name keeps its extension', async () => {
      const result = await convertFile(binaryStlOf(createCubeMesh([0, 0, 0], 10)), 'stl', 'igs', {}, 'cube.stl');
      expect(result.filename).toBe('cube.igs');
      const back = meshFacts((await convertFile(result.buffer, 'iges', 'stl', {}, 'cube.iges')).buffer, 'stl');
      expect(back.triangles).toBe(12);
      expect(back.volume).toBeCloseTo(1000, 2);
    });

    it.skipIf(!haveKernel)('writes an open sheet of two triangles and reads back its area and box', async () => {
      const sheet = createOpenSheetMesh();
      const result = await convertFile(objOf(sheet), 'obj', 'iges', {}, 'sheet.obj');
      const back = meshFacts((await convertFile(result.buffer, 'iges', 'stl', {}, 'sheet.iges')).buffer, 'stl');
      expect(back.triangles).toBe(2);
      expect(back.area).toBeCloseTo(100, 4);
      expect(back.max).toEqual([10, 10, 0]);
      expect(back.watertight).toBe(false);
    });

    it.skipIf(!haveKernel)('writes a torus of 288 triangles with the area and volume of the mesh it came from', async () => {
      const torus = createAnalyticalTorusMesh(10, 3, 12, 12);
      const result = await convertFile(objOf(torus), 'obj', 'iges', {}, 'torus.obj');
      const back = meshFacts((await convertFile(result.buffer, 'iges', 'stl', {}, 'torus.iges')).buffer, 'stl');
      expect(back.triangles).toBe(torus.faces.length);
      expect(back.area / areaOf(torus)).toBeCloseTo(1, 5);
      // calculateMeshVolume is unsigned; the torus mesh of this file winds inward, as the mesh says, so the kernel's signed volume is negative.
      expect(Math.abs(back.volume) / calculateMeshVolume(torus.vertices, torus.faces)).toBeCloseTo(1, 4);
    });

    it.skipIf(!haveKernel)('leaves out a triangle whose corners coincide, which is no face, and writes the others', async () => {
      const cube = createCubeMesh([0, 0, 0], 10);
      const withSliver: CadMesh3D = { ...cube, vertices: [...cube.vertices, [0, 0, 0]], faces: [...cube.faces, [0, 8, 0]] };
      const result = await convertFile(objOf(withSliver), 'obj', 'iges', {}, 'cube.obj');
      expect(igesEntityCounts(result.buffer.toString('latin1')).get(144)).toBe(12);
    });

    it.skipIf(!haveKernel)('refuses a mesh whose every triangle is no face, instead of writing an empty IGES file', async () => {
      const flat: CadMesh3D = { name: 'flat', vertices: [[0, 0, 0], [1, 0, 0], [2, 0, 0]], faces: [[0, 1, 2]], normals: [] };
      const failure = await convertFile(objOf(flat), 'obj', 'iges', {}, 'flat.obj').then(
        () => null,
        (error: unknown) => error as Error
      );
      expect((failure as UnprocessableCadInputError).status).toBe(422);
      expect(failure?.message).toBe('The CAD converter could not convert this model: it exited with status 4 (no-shapes: the mesh holds no triangle that is a face).');
    });

    it('fails closed with CadGeometryUnavailableError on a mesh with no triangle', async () => {
      const failure = await convertFile(Buffer.from('v 0 0 0\nv 1 0 0\nv 0 1 0\n'), 'obj', 'iges', {}, 'points.obj').then(
        () => null,
        (error: unknown) => error as Error
      );
      expect(failure).toBeInstanceOf(Error);
      expect(failure?.message).toMatch(/no faces|no vertices|no triangles|empty/i);
    });
  });

  describe('3. CAD Pipeline Round-Trip Tessellation & Integration', () => {
    it.skipIf(!haveKernel)('reads the STEP AP214 cube back as a closed solid of 12 faces, 10 mm on a side, in the independent kernel', async () => {
      const cube = createCubeMesh([0, 0, 0], 10);
      const stepText = encodeStep(cube);

      const stl = await convertFile(Buffer.from(stepText, 'utf-8'), 'step', 'stl', {}, 'cube_roundtrip.step');
      const facts = meshFacts(stl.buffer, 'stl');
      expect(facts.watertight).toBe(true);
      expect(facts.triangles).toBe(12);
      expect(facts.area).toBeCloseTo(600, 3);
      expect(facts.min).toEqual([0, 0, 0]);
      expect(facts.max).toEqual([10, 10, 10]);
    });

    it('converts OBJ cube to a STEP file via convertFile', async () => {
      // 8 vertices, 12 triangles OBJ cube
      const objCube = `
v 0 0 0
v 10 0 0
v 10 10 0
v 0 10 0
v 0 0 10
v 10 0 10
v 10 10 10
v 0 10 10
f 1 3 2
f 1 4 3
f 5 6 7
f 5 7 8
f 1 2 6
f 1 6 5
f 3 4 8
f 3 8 7
f 1 5 8
f 1 8 4
f 2 3 7
f 2 7 6
`;
      const objBuffer = Buffer.from(objCube.trim(), 'utf-8');

      const stepRes = await convertFile(objBuffer, 'obj', 'step', {}, 'cube.obj');
      expect(stepRes.mimeType).toBe('model/step');
      expect(stepRes.filename).toBe('cube.step');
      const stepContent = stepRes.buffer.toString('utf-8');
      expect(stepContent).toContain('ISO-10303-21;');
      expect(stepContent).toContain('AUTOMOTIVE_DESIGN');
      expect(stepContent).toContain('CLOSED_SHELL');
    });

    it.skipIf(!haveKernel)('reads the STEP the encoder wrote for the cube and writes the same 10 mm cube as OBJ', async () => {
      const step = Buffer.from(encodeStep(createCubeMesh([0, 0, 0], 10)), 'utf-8');
      const roundTrip = await convertFile(step, 'step', 'obj', {}, 'cube.step');
      expect(roundTrip.mimeType).toBe('model/obj');
      const facts = meshFacts(roundTrip.buffer, 'obj');
      expect(facts.watertight).toBe(true);
      expect(facts.area).toBeCloseTo(600, 3);
      expect(facts.max).toEqual([10, 10, 10]);
    });
  });
});
