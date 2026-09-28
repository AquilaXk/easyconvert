import { describe, it, expect } from 'vitest';
import {
  tessellateTrimmedFaceCDT,
  consolidatePolygonLoopsWithBridges,
  refineCurvatureAdaptiveQuadtree,
  buildLoopHierarchy,
  verifyWatertightManifoldMesh,
  BSplineSurface,
  Parametric2DPoint,
} from '../src/lib/conversions/cad-nurbs';
import { robustSegmentsIntersect } from '../src/lib/conversions/cad-predicates';

describe('CAD B-Rep Watertight CDT with Shewchuk Predicates & Nested Islands', () => {
  it('tessellates deeply nested mold islands (Outer -> Hole -> Island -> Hole) without non-manifold edges', () => {
    // Flat planar surface for baseline geometric validation
    const surface: BSplineSurface = {
      uDegree: 1,
      vDegree: 1,
      uKnots: [0, 0, 100, 100],
      vKnots: [0, 0, 100, 100],
      controlPoints: [
        [
          { x: 0, y: 0, z: 0 },
          { x: 0, y: 100, z: 0 },
        ],
        [
          { x: 100, y: 0, z: 0 },
          { x: 100, y: 100, z: 0 },
        ],
      ],
    };

    // Deeply nested injection mold core/cavity loops:
    // Outer boundary: [0, 100] x [0, 100] (Area = 10000)
    const outerBoundary: Parametric2DPoint[] = [
      { u: 0, v: 0 },
      { u: 100, v: 0 },
      { u: 100, v: 100 },
      { u: 0, v: 100 },
    ];

    // Hole 1: [20, 80] x [20, 80] (Area = 3600)
    const hole1: Parametric2DPoint[] = [
      { u: 20, v: 20 },
      { u: 80, v: 20 },
      { u: 80, v: 80 },
      { u: 20, v: 80 },
    ];

    // Island 1 (inside Hole 1): [30, 70] x [30, 70] (Area = 1600)
    const island1: Parametric2DPoint[] = [
      { u: 30, v: 30 },
      { u: 70, v: 30 },
      { u: 70, v: 70 },
      { u: 30, v: 70 },
    ];

    // Hole 2 (inside Island 1): [40, 60] x [40, 60] (Area = 400)
    const hole2: Parametric2DPoint[] = [
      { u: 40, v: 40 },
      { u: 60, v: 40 },
      { u: 60, v: 60 },
      { u: 40, v: 60 },
    ];

    // Island 2 (inside Hole 2): [45, 55] x [45, 55] (Area = 100)
    const island2: Parametric2DPoint[] = [
      { u: 45, v: 45 },
      { u: 55, v: 45 },
      { u: 55, v: 55 },
      { u: 45, v: 55 },
    ];

    // Hole 3 (inside Island 2): [48, 52] x [48, 52] (Area = 16)
    const hole3: Parametric2DPoint[] = [
      { u: 48, v: 48 },
      { u: 52, v: 48 },
      { u: 52, v: 52 },
      { u: 48, v: 52 },
    ];

    // Theoretical expected solid area:
    // (10000 - 3600) + (1600 - 400) + (100 - 16) = 6400 + 1200 + 84 = 7684
    const expectedSolidArea =
      10000 - 3600 + (1600 - 400) + (100 - 16);

    const loops = [outerBoundary, hole1, island1, hole2, island2, hole3];

    const mesh = tessellateTrimmedFaceCDT({ surface, loops });

    expect(mesh.faces.length).toBeGreaterThan(0);
    expect(mesh.vertices.length).toBeGreaterThan(0);

    // Sum area of 3D triangles
    let totalMeshArea = 0;
    for (const [v0, v1, v2] of mesh.faces) {
      const p0 = mesh.vertices[v0];
      const p1 = mesh.vertices[v1];
      const p2 = mesh.vertices[v2];

      // Cross product for triangle area
      const ux = p1[0] - p0[0];
      const uy = p1[1] - p0[1];
      const uz = p1[2] - p0[2];
      const vx = p2[0] - p0[0];
      const vy = p2[1] - p0[1];
      const vz = p2[2] - p0[2];

      const cx = uy * vz - uz * vy;
      const cy = uz * vx - ux * vz;
      const cz = ux * vy - uy * vx;

      totalMeshArea += 0.5 * Math.hypot(cx, cy, cz);
    }

    // Anti-cheating check: area must match theoretical solid area within floating-point tolerance
    expect(totalMeshArea).toBeCloseTo(expectedSolidArea, 1);

    // Verify 2-manifold properties: 0 non-manifold edges
    const topology = verifyWatertightManifoldMesh(mesh.vertices, mesh.faces);
    expect(topology.isManifold).toBe(true);
    expect(topology.nonManifoldEdges).toBe(0);
  });

  it('guarantees mutual visibility bridge cuts without self-intersecting segments via Shewchuk predicates', () => {
    // Outer loop
    const outer: Parametric2DPoint[] = [
      { u: 0, v: 0 },
      { u: 20, v: 0 },
      { u: 20, v: 20 },
      { u: 0, v: 20 },
    ];

    // Two side-by-side holes with near-collinear boundary points
    const hole1: Parametric2DPoint[] = [
      { u: 2, v: 2 },
      { u: 8, v: 2 },
      { u: 8, v: 18 },
      { u: 2, v: 18 },
    ];

    const hole2: Parametric2DPoint[] = [
      { u: 12, v: 2 },
      { u: 18, v: 2 },
      { u: 18, v: 18 },
      { u: 12, v: 18 },
    ];

    const { consolidated2D, allSegments } = consolidatePolygonLoopsWithBridges(outer, [hole1, hole2]);

    expect(consolidated2D.length).toBeGreaterThan(outer.length + hole1.length + hole2.length);

    // Verify no bridge segment intersects with any other perimeter or bridge segment
    for (let i = 0; i < allSegments.length; i++) {
      for (let j = i + 1; j < allSegments.length; j++) {
        const [a1, a2] = allSegments[i];
        const [b1, b2] = allSegments[j];

        // Shared endpoints are valid in polygon loops, strictly interior crossings are invalid
        const shareEndpoint =
          (a1.u === b1.u && a1.v === b1.v) ||
          (a1.u === b2.u && a1.v === b2.v) ||
          (a2.u === b1.u && a2.v === b1.v) ||
          (a2.u === b2.u && a2.v === b2.v);

        if (!shareEndpoint) {
          const intersects = robustSegmentsIntersect(a1, a2, b1, b2, true);
          expect(intersects).toBe(false);
        }
      }
    }
  });

  it('executes curvature-adaptive 2:1 balanced quadtree refinement on curved NURBS surfaces', () => {
    // Spherical dome surface with high curvature
    const curvedSurface: BSplineSurface = {
      uDegree: 2,
      vDegree: 2,
      uKnots: [0, 0, 0, 1, 1, 1],
      vKnots: [0, 0, 0, 1, 1, 1],
      controlPoints: [
        [
          { x: 0, y: 0, z: 0 },
          { x: 0, y: 50, z: 25 },
          { x: 0, y: 100, z: 0 },
        ],
        [
          { x: 50, y: 0, z: 25 },
          { x: 50, y: 50, z: 50 },
          { x: 50, y: 100, z: 25 },
        ],
        [
          { x: 100, y: 0, z: 0 },
          { x: 100, y: 50, z: 25 },
          { x: 100, y: 100, z: 0 },
        ],
      ],
    };

    const outer: Parametric2DPoint[] = [
      { u: 0, v: 0 },
      { u: 1, v: 0 },
      { u: 1, v: 1 },
      { u: 0, v: 1 },
    ];

    const steinerPoints = refineCurvatureAdaptiveQuadtree(curvedSurface, outer, [], {
      maxDepth: 3,
      angleToleranceDeg: 10.0,
      chordTolerance: 0.02,
    });

    // Curvature is high, quadtree must generate refinement Steiner points
    expect(steinerPoints.length).toBeGreaterThan(0);

    // Tessellate with curvature refinement
    const mesh = tessellateTrimmedFaceCDT({ surface: curvedSurface, loops: [outer] });
    expect(mesh.faces.length).toBeGreaterThan(2); // More than 2 triangles for flat quad

    const topology = verifyWatertightManifoldMesh(mesh.vertices, mesh.faces);
    expect(topology.isManifold).toBe(true);
    expect(topology.nonManifoldEdges).toBe(0);
  });
});
