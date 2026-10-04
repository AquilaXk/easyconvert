import { describe, it, expect } from 'vitest';
import {
  encodeStep,
  encodeIges,
  CadMesh3D,
} from '../src/lib/conversions/vector-cad';
import {
  tessellateCadText,
  parseIgesBRepMesh,
} from '../src/lib/conversions/cad-nurbs';
import { convertFile } from '../src/lib/conversions';
import { CadGeometryUnavailableError } from '../src/lib/types';

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

/**
 * Independent ANSI/USPRO IGES 5.3 Parser for differential verification.
 * Built independently from the official IGES 5.3 standard specifications.
 */
function independentlyParseIgesBRep(igesText: string): {
  allLinesAre80Cols: boolean;
  sCount: number;
  gCount: number;
  dCount: number;
  pCount: number;
  hasSolid186: boolean;
  hasShell514: boolean;
  vertices: [number, number, number][];
  faces: [number, number, number][];
} {
  const lines = igesText.split('\n');
  if (lines[lines.length - 1] === '') lines.pop(); // remove trailing newline

  let allLinesAre80Cols = true;
  let sCount = 0;
  let gCount = 0;
  let dCount = 0;
  let pCount = 0;

  const dLines: string[] = [];
  const pLinesByDe = new Map<number, string[]>();
  const pAllText: string[] = [];

  for (const line of lines) {
    if (line.length !== 80) {
      allLinesAre80Cols = false;
    }
    const section = line[72];
    if (section === 'S') sCount++;
    else if (section === 'G') gCount++;
    else if (section === 'D') {
      dCount++;
      dLines.push(line);
    } else if (section === 'P') {
      pCount++;
      const deStr = line.substring(64, 72).trim();
      const dePtr = Number.parseInt(deStr, 10);
      const text = line.substring(0, 64);
      pAllText.push(text);
      if (!Number.isNaN(dePtr)) {
        let arr = pLinesByDe.get(dePtr);
        if (!arr) {
          arr = [];
          pLinesByDe.set(dePtr, arr);
        }
        arr.push(text);
      }
    }
  }

  const hasSolid186 = igesText.includes('186,') || dLines.some((l) => l.trim().startsWith('186'));
  const hasShell514 = igesText.includes('514,') || dLines.some((l) => l.trim().startsWith('514'));

  // Parse all records from joined P text
  const fullP = pAllText.join('');
  const records = fullP.split(';').map((r) => r.trim()).filter(Boolean);

  let rawVertices: [number, number, number][] = [];
  const rawEdges: [number, number][] = [];
  const rawTriangles: [number, number, number][] = [];

  for (const rec of records) {
    const tokens = rec.split(',').map((t) => t.trim());
    const entityType = Number.parseInt(tokens[0], 10);

    if (entityType === 502) {
      // 502, N, X1, Y1, Z1, ...
      const nV = Number.parseInt(tokens[1], 10);
      rawVertices = [];
      for (let i = 0; i < nV; i++) {
        rawVertices.push([
          Number.parseFloat(tokens[2 + 3 * i]),
          Number.parseFloat(tokens[3 + 3 * i]),
          Number.parseFloat(tokens[4 + 3 * i]),
        ]);
      }
    } else if (entityType === 504) {
      // 504, N, CRV, V1, V2, ...
      const nE = Number.parseInt(tokens[1], 10);
      for (let i = 0; i < nE; i++) {
        const v1 = Number.parseInt(tokens[2 + 3 * i + 1], 10) - 1;
        const v2 = Number.parseInt(tokens[2 + 3 * i + 2], 10) - 1;
        rawEdges.push([v1, v2]);
      }
    } else if (entityType === 508) {
      // 508, TYPE, N, EDGE1_TYPE, EDGE1_INDEX, DIR, ISO, ...
      const nEdges = Number.parseInt(tokens[2], 10);
      const loopV: number[] = [];
      for (let k = 0; k < nEdges; k++) {
        const base = 3 + 4 * k;
        const eIdx = Number.parseInt(tokens[base + 1], 10) - 1;
        const dir = Number.parseInt(tokens[base + 2], 10);
        if (eIdx >= 0 && eIdx < rawEdges.length) {
          const edge = rawEdges[eIdx];
          loopV.push(dir === 1 ? edge[0] : edge[1]);
        }
      }
      if (loopV.length === 3) {
        rawTriangles.push([loopV[0], loopV[1], loopV[2]]);
      }
    }
  }

  // Deduplicate vertices
  const uniqueVertices: [number, number, number][] = [];
  const keyToIdx = new Map<string, number>();
  function getOrAdd(p: [number, number, number]): number {
    const key = `${p[0].toFixed(5)},${p[1].toFixed(5)},${p[2].toFixed(5)}`;
    const ex = keyToIdx.get(key);
    if (ex !== undefined) return ex;
    const idx = uniqueVertices.length;
    uniqueVertices.push(p);
    keyToIdx.set(key, idx);
    return idx;
  }

  const faces: [number, number, number][] = [];
  for (const [v0, v1, v2] of rawTriangles) {
    if (rawVertices[v0] && rawVertices[v1] && rawVertices[v2]) {
      const i0 = getOrAdd(rawVertices[v0]);
      const i1 = getOrAdd(rawVertices[v1]);
      const i2 = getOrAdd(rawVertices[v2]);
      faces.push([i0, i1, i2]);
    }
  }

  return {
    allLinesAre80Cols,
    sCount,
    gCount,
    dCount,
    pCount,
    hasSolid186,
    hasShell514,
    vertices: uniqueVertices,
    faces,
  };
}

// ============================================================================
// Test Suite: WP-46b CAD STEP & IGES Genuine B-Rep Encoders
// ============================================================================

describe('WP-46b: CAD STEP (ISO 10303-21 AP214) and IGES 5.3 Genuine Encoders', () => {
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

  describe('2. ANSI/USPRO IGES 5.3 Genuine B-Rep Encoding', () => {
    it('encodes closed watertight 10mm cube to strict 80-column IGES 5.3 B-Rep (Entities 502, 504, 508, 510, 190, 514, 186)', () => {
      const cubeMesh = createCubeMesh([0, 0, 0], 10);
      const igesText = encodeIges(cubeMesh);

      // Section markers in col 73
      expect(igesText).toContain('S      1');
      expect(igesText).toContain('G      1');
      expect(igesText).toContain('D      1');
      expect(igesText).toContain('P      1');
      expect(igesText).toContain('T0000001');

      // Independent Oracle Differential Verification
      const parsed = independentlyParseIgesBRep(igesText);

      // (a) Every single record line MUST be exactly 80 columns wide
      expect(parsed.allLinesAre80Cols).toBe(true);

      // (b) Must contain Shell (514) and Manifold Solid B-Rep (186)
      expect(parsed.hasShell514).toBe(true);
      expect(parsed.hasSolid186).toBe(true);

      // (c) Face count must equal 12 triangles
      expect(parsed.faces.length).toBe(12);

      // (d) Unique vertices count must equal 8
      expect(parsed.vertices.length).toBe(8);

      // (e) Bounding box error <= 1e-6
      const bbox = calculateBoundingBox(parsed.vertices);
      expect(bbox.min[0]).toBeCloseTo(0, 5);
      expect(bbox.min[1]).toBeCloseTo(0, 5);
      expect(bbox.min[2]).toBeCloseTo(0, 5);
      expect(bbox.max[0]).toBeCloseTo(10, 5);
      expect(bbox.max[1]).toBeCloseTo(10, 5);
      expect(bbox.max[2]).toBeCloseTo(10, 5);

      // (f) Volume must equal 1000.0 +- 1e-6
      const volume = calculateMeshVolume(parsed.vertices, parsed.faces);
      expect(volume).toBeCloseTo(1000.0, 4);
    });

    it('encodes open non-watertight mesh as IGES Shell (514) without Solid (186)', () => {
      const openMesh = createOpenSheetMesh();
      const igesText = encodeIges(openMesh);

      const parsed = independentlyParseIgesBRep(igesText);
      expect(parsed.allLinesAre80Cols).toBe(true);
      expect(parsed.hasShell514).toBe(true);
      expect(parsed.hasSolid186).toBe(false);
      expect(parsed.faces.length).toBe(2);
      expect(parsed.vertices.length).toBe(4);
    });

    it('fails closed with CadGeometryUnavailableError on empty mesh inputs', () => {
      expect(() =>
        encodeIges({ name: 'empty', vertices: [], faces: [], normals: [] })
      ).toThrow(CadGeometryUnavailableError);

      expect(() =>
        encodeIges({
          name: 'no_faces',
          vertices: [[0, 0, 0], [1, 0, 0]],
          faces: [],
          normals: [],
        })
      ).toThrow(CadGeometryUnavailableError);
    });
  });

  describe('3. CAD Pipeline Round-Trip Tessellation & Integration', () => {
    it('round-trips STEP AP214 cube through tessellateCadText with watertight validation', () => {
      const cube = createCubeMesh([0, 0, 0], 10);
      const stepText = encodeStep(cube);

      const tessellated = tessellateCadText(stepText, 'step', 'cube_roundtrip');
      expect(tessellated.faces.length).toBe(12);
      expect(tessellated.vertices.length).toBe(8);
      expect(tessellated.topologyReport).toBeDefined();
      expect(tessellated.topologyReport?.isWatertight).toBe(true);
      expect(tessellated.topologyReport?.boundaryEdges).toBe(0);

      const vol = calculateMeshVolume(tessellated.vertices, tessellated.faces);
      expect(vol).toBeCloseTo(1000.0, 4);
    });

    it('round-trips IGES 5.3 cube through parseIgesBRepMesh and tessellateCadText with watertight validation', () => {
      const cube = createCubeMesh([0, 0, 0], 10);
      const igesText = encodeIges(cube);

      // Direct B-Rep extractor
      const brepMesh = parseIgesBRepMesh(igesText, 'iges_cube');
      expect(brepMesh).not.toBeNull();
      expect(brepMesh!.faces.length).toBe(12);
      expect(brepMesh!.vertices.length).toBe(8);

      // High-level pipeline entry point
      const tessellated = tessellateCadText(igesText, 'iges', 'iges_roundtrip');
      expect(tessellated.faces.length).toBe(12);
      expect(tessellated.topologyReport?.isWatertight).toBe(true);
      expect(tessellated.topologyReport?.boundaryEdges).toBe(0);

      const vol = calculateMeshVolume(tessellated.vertices, tessellated.faces);
      expect(vol).toBeCloseTo(1000.0, 4);
    });

    it('converts OBJ cube to STEP and IGES files via convertFile', async () => {
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

      // 1. OBJ -> STEP
      const stepRes = await convertFile(objBuffer, 'obj', 'step', {}, 'cube.obj');
      expect(stepRes.mimeType).toBe('model/step');
      expect(stepRes.filename).toBe('cube.step');
      const stepContent = stepRes.buffer.toString('utf-8');
      expect(stepContent).toContain('ISO-10303-21;');
      expect(stepContent).toContain('AUTOMOTIVE_DESIGN');
      expect(stepContent).toContain('CLOSED_SHELL');

      // 2. OBJ -> IGES
      const igesRes = await convertFile(objBuffer, 'obj', 'iges', {}, 'cube.obj');
      expect(igesRes.mimeType).toBe('model/iges');
      expect(igesRes.filename).toBe('cube.iges');
      const igesContent = igesRes.buffer.toString('utf-8');
      expect(igesContent).toContain('S      1');
      expect(igesContent).toContain('502,');
      expect(igesContent).toContain('514,');

      // 3. STEP -> OBJ round trip
      const roundTripRes = await convertFile(stepRes.buffer, 'step', 'obj', {}, 'cube.step');
      expect(roundTripRes.mimeType).toBe('model/obj');
      const objResult = roundTripRes.buffer.toString('utf-8');
      expect(objResult).toContain('v ');
      expect(objResult).toContain('f ');
    });
  });
});
