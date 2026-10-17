import { describe, it, expect } from 'vitest';
import { verifyWatertightManifoldMesh } from '../src/lib/conversions/cad-nurbs';
import { encode3dCadToDxf } from '../src/lib/conversions/vector-cad';
import { CadGeometryUnavailableError } from '../src/lib/types';

/**
 * Generates an analytical Torus 3D triangle mesh with genus g = 1,
 * Euler characteristic chi = 0, boundaryEdges = 0, and 0 isolated vertices.
 */
function createAnalyticalTorusMesh(
  majorR = 10,
  minorR = 3,
  radialSegments = 16,
  tubularSegments = 16
): { vertices: [number, number, number][]; faces: [number, number, number][] } {
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

  return { vertices, faces };
}

/**
 * Creates an indexed polyhedral cube mesh with 8 vertices and 12 triangles.
 */
function createCubeMesh(
  min = [0, 0, 0],
  size = 10
): { vertices: [number, number, number][]; faces: [number, number, number][] } {
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

  return { vertices, faces };
}

describe('WP-46a: CAD Topology Validation and Fail-Closed Mesh Writers', () => {
  describe('1. Topological Watertightness & Genus Calculation (Defect N10 Remediation)', () => {
    it('accurately verifies Torus (genus=1, chi=0, 0 boundary edges) as watertight 2-manifold', () => {
      const { vertices, faces } = createAnalyticalTorusMesh(10, 3, 16, 16);
      const report = verifyWatertightManifoldMesh(vertices, faces);

      expect(report.isManifold).toBe(true);
      expect(report.boundaryEdges).toBe(0);
      expect(report.nonManifoldEdges).toBe(0);
      expect(report.hasDegenerateFace).toBe(false);
      expect(report.hasNonManifoldVertex).toBe(false);
      expect(report.eulerCharacteristic).toBe(0); // V - E + F = 256 - 768 + 512 = 0
      expect(report.genus).toBe(1); // 2(1 - 1) = 0
      expect(report.componentsCount).toBe(1);
      // Under defect N10, chi === 2 was incorrectly required, failing tori.
      // With WP-46a, boundaryEdges === 0 && isManifold ensures watertightness!
      expect(report.isWatertight).toBe(true);
    });

    it('accurately verifies multi-component disconnected solids (c=2 cubes, chi=4) as watertight', () => {
      const cube1 = createCubeMesh([0, 0, 0], 10);
      const cube2 = createCubeMesh([30, 30, 30], 10);

      const vertices = [...cube1.vertices, ...cube2.vertices];
      const offset = cube1.vertices.length;
      const faces: [number, number, number][] = [
        ...cube1.faces,
        ...cube2.faces.map(([a, b, c]) => [a + offset, b + offset, c + offset] as [number, number, number]),
      ];

      const report = verifyWatertightManifoldMesh(vertices, faces);
      expect(report.isManifold).toBe(true);
      expect(report.boundaryEdges).toBe(0);
      expect(report.componentsCount).toBe(2);
      expect(report.eulerCharacteristic).toBe(4); // 2 + 2 = 4
      expect(report.genus).toBe(0); // 2*2 - 4 = 0
      expect(report.isWatertight).toBe(true);
    });

    it('rejects open boundaries and orphan isolated vertices fail-closed', () => {
      // 1. Open boundary sheet
      const openSheet: [number, number, number][] = [
        [0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0],
      ];
      const openFaces: [number, number, number][] = [
        [0, 1, 2], [0, 2, 3],
      ];
      const reportOpen = verifyWatertightManifoldMesh(openSheet, openFaces);
      expect(reportOpen.isWatertight).toBe(false);
      expect(reportOpen.boundaryEdges).toBe(4);

      // 2. Closed cube with an isolated unreferenced floating vertex
      const cube = createCubeMesh([0, 0, 0], 10);
      const verticesWithOrphan: [number, number, number][] = [
        ...cube.vertices,
        [999, 999, 999], // floating orphan
      ];
      const reportOrphan = verifyWatertightManifoldMesh(verticesWithOrphan, cube.faces);
      expect(reportOrphan.isWatertight).toBe(false); // Isolated vertex violates watertightness
    });
  });

  describe('2. Fail-Closed Anti-Cheating Invariants in Vector CAD (Defect N8 Remediation)', () => {
    it('encode3dCadToDxf throws CadGeometryUnavailableError on empty geometry instead of synthesizing fake LINE', () => {
      expect(() => {
        encode3dCadToDxf({
          name: 'empty',
          vertices: [],
          normals: [],
          faces: [],
        });
      }).toThrow(CadGeometryUnavailableError);
    });
  });
});
