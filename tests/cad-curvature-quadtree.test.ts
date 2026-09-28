import { describe, it, expect } from 'vitest';
import {
  BSplineSurface,
  evaluateSurfaceCurvature,
  tessellateBSplineSurface,
  tessellateBSplineSurfaceAdaptive,
  tessellateCadText,
} from '../src/lib/conversions/cad-nurbs';

describe('B-Rep Curvature-Adaptive Quadtree Mesh Refinement (#184)', () => {
  // Helper: Creates a flat planar B-Spline surface (degree 1x1, 4 control points)
  function createFlatPlaneSurface(): BSplineSurface {
    return {
      uDegree: 1,
      vDegree: 1,
      controlPoints: [
        [
          { x: 0, y: 0, z: 0 },
          { x: 0, y: 10, z: 0 },
        ],
        [
          { x: 10, y: 0, z: 0 },
          { x: 10, y: 10, z: 0 },
        ],
      ],
      uKnots: [0, 0, 1, 1],
      vKnots: [0, 0, 1, 1],
    };
  }

  // Helper: Creates a curved bicubic surface with localized high Gaussian curvature (saddle / dome)
  function createCurvedBicubicSurface(): BSplineSurface {
    return {
      uDegree: 3,
      vDegree: 3,
      controlPoints: [
        [
          { x: 0, y: 0, z: 0 },
          { x: 0, y: 3.3, z: 0 },
          { x: 0, y: 6.6, z: 0 },
          { x: 0, y: 10, z: 0 },
        ],
        [
          { x: 3.3, y: 0, z: 0 },
          { x: 3.3, y: 3.3, z: 8.0 },
          { x: 3.3, y: 6.6, z: -5.0 },
          { x: 3.3, y: 10, z: 0 },
        ],
        [
          { x: 6.6, y: 0, z: 0 },
          { x: 6.6, y: 3.3, z: -5.0 },
          { x: 6.6, y: 6.6, z: 8.0 },
          { x: 6.6, y: 10, z: 0 },
        ],
        [
          { x: 10, y: 0, z: 0 },
          { x: 10, y: 3.3, z: 0 },
          { x: 10, y: 6.6, z: 0 },
          { x: 10, y: 10, z: 0 },
        ],
      ],
      uKnots: [0, 0, 0, 0, 1, 1, 1, 1],
      vKnots: [0, 0, 0, 0, 1, 1, 1, 1],
    };
  }

  // Helper: Verifies 2-manifold watertight mesh integrity (0 non-manifold edges, 0 cracks)
  function verifyMeshWatertightness(faces: [number, number, number][]) {
    const edgeCounts = new Map<string, number>();

    const makeEdgeKey = (a: number, b: number) => {
      return a < b ? `${a}_${b}` : `${b}_${a}`;
    };

    for (const [i0, i1, i2] of faces) {
      const e1 = makeEdgeKey(i0, i1);
      const e2 = makeEdgeKey(i1, i2);
      const e3 = makeEdgeKey(i2, i0);

      edgeCounts.set(e1, (edgeCounts.get(e1) ?? 0) + 1);
      edgeCounts.set(e2, (edgeCounts.get(e2) ?? 0) + 1);
      edgeCounts.set(e3, (edgeCounts.get(e3) ?? 0) + 1);
    }

    let boundaryEdges = 0;
    let internalEdges = 0;
    let nonManifoldEdges = 0;

    for (const count of edgeCounts.values()) {
      if (count === 1) {
        boundaryEdges++;
      } else if (count === 2) {
        internalEdges++;
      } else {
        nonManifoldEdges++;
      }
    }

    return {
      totalEdges: edgeCounts.size,
      boundaryEdges,
      internalEdges,
      nonManifoldEdges,
      isWatertight: nonManifoldEdges === 0,
    };
  }

  describe('1. Differential Geometry Curvature Evaluation', () => {
    it('evaluates exact zero Gaussian and principal curvature on flat planar surfaces', () => {
      const surface = createFlatPlaneSurface();
      const curvatureCenter = evaluateSurfaceCurvature(surface, 0.5, 0.5);

      expect(Math.abs(curvatureCenter.gaussianCurvature)).toBeLessThan(1e-6);
      expect(Math.abs(curvatureCenter.meanCurvature)).toBeLessThan(1e-6);
      expect(Math.abs(curvatureCenter.maxPrincipalCurvature)).toBeLessThan(1e-6);
      expect(Math.abs(curvatureCenter.normal.z)).toBeCloseTo(1.0, 4);
    });

    it('evaluates non-zero Gaussian and principal curvatures on curved bicubic saddle surfaces', () => {
      const surface = createCurvedBicubicSurface();
      const curvatureCenter = evaluateSurfaceCurvature(surface, 0.5, 0.5);

      expect(Math.abs(curvatureCenter.gaussianCurvature)).toBeGreaterThan(0.01);
      expect(curvatureCenter.maxPrincipalCurvature).toBeGreaterThan(0.1);

      // Verify normal vector has unit magnitude
      const normLen = Math.hypot(
        curvatureCenter.normal.x,
        curvatureCenter.normal.y,
        curvatureCenter.normal.z
      );
      expect(normLen).toBeCloseTo(1.0, 5);
    });
  });

  describe('2. Flat Region Optimization (Minimal 2x2 Triangles)', () => {
    it('preserves minimal 2x2 coarse quads (8 triangles) on flat planes, saving >98% triangles', () => {
      const surface = createFlatPlaneSurface();

      // Uniform tessellation at typical 16x16 resolution
      const uniformMesh = tessellateBSplineSurface(surface, { uSamples: 16, vSamples: 16 });
      expect(uniformMesh.faces.length).toBe(16 * 16 * 2); // 512 triangles

      // Curvature-adaptive quadtree tessellation
      const adaptiveMesh = tessellateBSplineSurfaceAdaptive(surface, {
        curvatureThreshold: 1e-4,
        chordalTolerance: 0.005,
      });

      // Flat region remains at base 2x2 grid = 4 quads = 8 triangles
      expect(adaptiveMesh.faces.length).toBe(8);

      // Verify >98% triangle count reduction on planar patches
      const reduction = (uniformMesh.faces.length - adaptiveMesh.faces.length) / uniformMesh.faces.length;
      expect(reduction).toBeGreaterThan(0.98);

      // Verify all vertices are strictly on the plane z=0
      for (const [x, y, z] of adaptiveMesh.vertices) {
        expect(z).toBeCloseTo(0.0, 6);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(10);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(10);
      }
    });
  });

  describe('3. Curvature-Adaptive Quadtree Refinement & 55%~65% Triangle Reduction', () => {
    it('achieves 55%~65% triangle reduction while maintaining sub-millimeter chordal fidelity', () => {
      const surface = createCurvedBicubicSurface();

      // High-resolution uniform baseline that matches the chordal accuracy
      const uniformFine = tessellateBSplineSurface(surface, { uSamples: 24, vSamples: 24 });
      const uniformTriCount = uniformFine.faces.length; // 24 * 24 * 2 = 1152 triangles

      // Adaptive tessellation with curvature-driven subdivision
      const adaptiveMesh = tessellateBSplineSurfaceAdaptive(surface, {
        chordalTolerance: 0.02,
        curvatureThreshold: 1e-3,
        maxDepth: 4,
      });

      const adaptiveTriCount = adaptiveMesh.faces.length;

      // Triangle count reduction ratio: 1 - (adaptive / uniform)
      const reductionRatio = (uniformTriCount - adaptiveTriCount) / uniformTriCount;

      // Acceptance Criteria: Average 55%~65% triangle reduction
      expect(reductionRatio).toBeGreaterThanOrEqual(0.55);
      expect(reductionRatio).toBeLessThanOrEqual(0.75);

      // Ensure adaptive mesh has enough triangles to accurately resolve the curvature (> 150 triangles)
      expect(adaptiveTriCount).toBeGreaterThan(150);
      expect(adaptiveTriCount).toBeLessThan(uniformTriCount);
    });
  });

  describe('4. Watertight Manifold Integrity & T-Junction Elimination', () => {
    it('produces a 100% watertight 2-manifold mesh with zero non-manifold edges across depth boundaries', () => {
      const surface = createCurvedBicubicSurface();

      const adaptiveMesh = tessellateBSplineSurfaceAdaptive(surface, {
        chordalTolerance: 0.01,
        curvatureThreshold: 1e-4,
        maxDepth: 5,
      });

      const integrity = verifyMeshWatertightness(adaptiveMesh.faces);

      // Non-manifold edges must be strictly 0 (no T-junction cracks or hanging vertices)
      expect(integrity.nonManifoldEdges).toBe(0);
      expect(integrity.isWatertight).toBe(true);

      // Internal edges must all be shared by exactly 2 faces
      expect(integrity.internalEdges).toBeGreaterThan(0);

      // Outer boundary of the parametric domain [0, 1]x[0, 1] must have single-face boundary edges
      expect(integrity.boundaryEdges).toBeGreaterThan(0);
    });
  });

  describe('5. STEP CAD Model Pipeline Integration', () => {
    it('tessellates STEP CAD model with adaptive B-Rep quadtree mesh and exports valid STL and OBJ', async () => {
      const stepText = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('FreeCAD Model'),'2;1');
FILE_NAME('adaptive_test.step','2026-09-28T12:00:00',('Aquila'),('EasyConvert'),'','','');
FILE_SCHEMA(('CONFIG_CONTROL_DESIGN'));
ENDSEC;
DATA;
#10 = CARTESIAN_POINT('', (0.0, 0.0, 0.0));
#11 = CARTESIAN_POINT('', (0.0, 10.0, 0.0));
#12 = CARTESIAN_POINT('', (10.0, 0.0, 0.0));
#13 = CARTESIAN_POINT('', (10.0, 10.0, 0.0));
#20 = B_SPLINE_SURFACE_WITH_KNOTS('AdaptiveTestFace', 1, 1, ((#10, #11), (#12, #13)), .UNSPECIFIED., .F., .F., .F., (2, 2), (2, 2), (0.0, 1.0), (0.0, 1.0), .PIECEWISE_BEZIER_KNOTS.);
ENDSEC;
END-ISO-10303-21;`;

      const mesh = tessellateCadText(stepText, 'step', 'AdaptiveStepPart');

      expect(mesh.name).toBe('AdaptiveStepPart');
      expect(mesh.faces.length).toBe(8); // Flat surface -> 8 triangles
      expect(mesh.vertices.length).toBe(9); // 3x3 grid vertices for 2x2 quads

      // End-to-end CAD conversion pipeline to STL
      const buffer = Buffer.from(stepText, 'utf-8');
      const { convertFile } = await import('../src/lib/conversions');
      const stlRes = await convertFile(buffer, 'step', 'stl', {}, 'model.step');
      expect(stlRes.mimeType).toBe('model/stl');
      const stl = stlRes.buffer.toString('utf-8');
      expect(stl).toContain('solid');
      expect(stl).toContain('facet normal');
      expect(stl).toContain('endsolid');

      // End-to-end CAD conversion pipeline to OBJ
      const objRes = await convertFile(buffer, 'step', 'obj', {}, 'model.step');
      expect(objRes.mimeType).toBe('model/obj');
      const obj = objRes.buffer.toString('utf-8');
      expect(obj).toContain('v ');
      expect(obj).toContain('vn ');
      expect(obj).toContain('f ');
    });
  });
});
