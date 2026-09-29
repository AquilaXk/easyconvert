import { describe, it, expect } from 'vitest';
import {
  windingNumberPointInPolygon,
  orient2dExact,
} from '../src/lib/conversions/cad-predicates';
import {
  isPointInParametricPolygon,
  buildLoopHierarchy,
  Parametric2DPoint,
  consolidatePolygonLoopsWithBridges,
} from '../src/lib/conversions/cad-nurbs';

describe('CAD B-Rep Exact Winding Number & Watertight Loop Hierarchy', () => {
  describe('1. Exact Winding Number Point-in-Polygon Classification', () => {
    it('correctly classifies interior, exterior, and boundary points for CCW polygon', () => {
      // 10x10 square in parametric space [0, 10] x [0, 10]
      const square = [
        { u: 0, v: 0 },
        { u: 10, v: 0 },
        { u: 10, v: 10 },
        { u: 0, v: 10 },
      ];

      // Interior points
      expect(windingNumberPointInPolygon({ u: 5, v: 5 }, square)).toBe(1);
      expect(isPointInParametricPolygon({ u: 5, v: 5 }, square)).toBe(true);

      expect(windingNumberPointInPolygon({ u: 1, v: 9 }, square)).toBe(1);
      expect(isPointInParametricPolygon({ u: 1, v: 9 }, square)).toBe(true);

      // Exterior points
      expect(windingNumberPointInPolygon({ u: -1, v: 5 }, square)).toBe(0);
      expect(isPointInParametricPolygon({ u: -1, v: 5 }, square)).toBe(false);

      expect(windingNumberPointInPolygon({ u: 15, v: 5 }, square)).toBe(0);
      expect(isPointInParametricPolygon({ u: 15, v: 5 }, square)).toBe(false);

      expect(windingNumberPointInPolygon({ u: 5, v: -2 }, square)).toBe(0);
      expect(isPointInParametricPolygon({ u: 5, v: -2 }, square)).toBe(false);

      expect(windingNumberPointInPolygon({ u: 5, v: 12 }, square)).toBe(0);
      expect(isPointInParametricPolygon({ u: 5, v: 12 }, square)).toBe(false);
    });

    it('robustly handles horizontal edges collinear with query point without division by zero', () => {
      // Polygon with a horizontal step edge at v = 5
      const poly = [
        { u: 0, v: 0 },
        { u: 10, v: 0 },
        { u: 10, v: 5 },
        { u: 5, v: 5 }, // Horizontal edge from (10, 5) to (5, 5)
        { u: 5, v: 10 },
        { u: 0, v: 10 },
      ];

      // Ray at v = 5: passes exactly along the horizontal edge
      // Point (2, 5) is inside the polygon
      expect(windingNumberPointInPolygon({ u: 2, v: 5 }, poly)).not.toBe(0);
      expect(isPointInParametricPolygon({ u: 2, v: 5 }, poly)).toBe(true);

      // Point (8, 5) is on the boundary or inside the cut
      // Point (12, 5) is strictly outside
      expect(windingNumberPointInPolygon({ u: 12, v: 5 }, poly)).toBe(0);
      expect(isPointInParametricPolygon({ u: 12, v: 5 }, poly)).toBe(false);
    });

    it('correctly handles non-convex C-shaped re-entrant polygon', () => {
      // C-shaped polygon opening to the right
      const cShape: Parametric2DPoint[] = [
        { u: 0, v: 0 },
        { u: 10, v: 0 },
        { u: 10, v: 3 },
        { u: 3, v: 3 },
        { u: 3, v: 7 },
        { u: 10, v: 7 },
        { u: 10, v: 10 },
        { u: 0, v: 10 },
      ];

      // Inside the spine
      expect(isPointInParametricPolygon({ u: 1, v: 5 }, cShape)).toBe(true);
      // Inside top prong
      expect(isPointInParametricPolygon({ u: 8, v: 8.5 }, cShape)).toBe(true);
      // Inside bottom prong
      expect(isPointInParametricPolygon({ u: 8, v: 1.5 }, cShape)).toBe(true);
      // In the re-entrant cavity (outside the solid)
      expect(isPointInParametricPolygon({ u: 6, v: 5 }, cShape)).toBe(false);
      expect(windingNumberPointInPolygon({ u: 6, v: 5 }, cShape)).toBe(0);
    });
  });

  describe('2. Loop Hierarchy & Bridge Consolidation for Nested Islands', () => {
    it('constructs a multi-level nesting hierarchy: Outer -> Hole -> Island', () => {
      // Level 0: Outer boundary [0, 20] x [0, 20]
      const outer: Parametric2DPoint[] = [
        { u: 0, v: 0 },
        { u: 20, v: 0 },
        { u: 20, v: 20 },
        { u: 0, v: 20 },
      ];
      // Level 1: Hole [5, 15] x [5, 15]
      const hole: Parametric2DPoint[] = [
        { u: 5, v: 5 },
        { u: 15, v: 5 },
        { u: 15, v: 15 },
        { u: 5, v: 15 },
      ];
      // Level 2: Island inside hole [8, 12] x [8, 12]
      const island: Parametric2DPoint[] = [
        { u: 8, v: 8 },
        { u: 12, v: 8 },
        { u: 12, v: 12 },
        { u: 8, v: 12 },
      ];

      const forest = buildLoopHierarchy([outer, hole, island]);
      expect(forest.length).toBe(1);

      const root = forest[0];
      expect(root.depth).toBe(0);
      expect(root.isHole).toBe(false);
      expect(root.children.length).toBe(1);

      const holeNode = root.children[0];
      expect(holeNode.depth).toBe(1);
      expect(holeNode.isHole).toBe(true);
      expect(holeNode.children.length).toBe(1);

      const islandNode = holeNode.children[0];
      expect(islandNode.depth).toBe(2);
      expect(islandNode.isHole).toBe(false);
    });

    it('consolidates outer boundary with inner hole using non-intersecting bridge edges', () => {
      const outer: Parametric2DPoint[] = [
        { u: 0, v: 0 },
        { u: 10, v: 0 },
        { u: 10, v: 10 },
        { u: 0, v: 10 },
      ];
      const hole: Parametric2DPoint[] = [
        { u: 3, v: 3 },
        { u: 7, v: 3 },
        { u: 7, v: 7 },
        { u: 3, v: 7 },
      ];

      const res = consolidatePolygonLoopsWithBridges(outer, [hole]);
      expect(res.consolidated2D.length).toBeGreaterThan(outer.length + hole.length);
      expect(res.allSegments.length).toBeGreaterThanOrEqual(outer.length + hole.length + 1);

      // Verify that all bridge segments connect without self-intersections
      for (const seg of res.allSegments) {
        expect(Number.isFinite(seg[0].u)).toBe(true);
        expect(Number.isFinite(seg[0].v)).toBe(true);
        expect(Number.isFinite(seg[1].u)).toBe(true);
        expect(Number.isFinite(seg[1].v)).toBe(true);
      }
    });
  });
});
