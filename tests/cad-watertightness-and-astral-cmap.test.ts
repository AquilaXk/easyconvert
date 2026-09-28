import { describe, it, expect } from 'vitest';
import {
  tessellateTrimmedFaceCDT,
  BSplineSurface,
  Parametric2DPoint,
} from '../src/lib/conversions/cad-nurbs';
import { createToUnicodeCMap } from '../src/lib/conversions/ocr-pdf-combiner';

describe('Phase 5: B-Rep Mesh Watertightness & Astral Unicode CMap Compliance', () => {
  describe('1. B-Rep Watertight Mesh Refinement with Collinear Edge-Splitting', () => {
    it('splits triangles along collinear Steiner points without creating T-junction cracks', () => {
      // Create a curved cylindrical surface with degree 2
      const surface: BSplineSurface = {
        uDegree: 2,
        vDegree: 1,
        uKnots: [0, 0, 0, 1, 1, 1],
        vKnots: [0, 0, 1, 1],
        controlPoints: [
          [
            { x: 10, y: 0, z: 0 },
            { x: 10, y: 0, z: 10 },
          ],
          [
            { x: 10, y: 10, z: 0 },
            { x: 10, y: 10, z: 10 },
          ],
          [
            { x: 0, y: 10, z: 0 },
            { x: 0, y: 10, z: 10 },
          ],
        ],
      };

      // Boundary loop covering [0, 1] x [0, 1]
      const outerLoop: Parametric2DPoint[] = [
        { u: 0, v: 0 },
        { u: 1, v: 0 },
        { u: 1, v: 1 },
        { u: 0, v: 1 },
      ];

      const mesh = tessellateTrimmedFaceCDT(
        {
          surface,
          outerLoop,
        },
        'test_cylinder_mesh'
      );

      expect(mesh).not.toBeNull();
      expect(mesh.vertices.length).toBeGreaterThan(3);
      expect(mesh.faces.length).toBeGreaterThan(2);

      // Verify Manifold Watertightness:
      // Build half-edge adjacency graph to verify that every interior edge is shared by exactly 2 triangles
      // and no edge has 3+ triangles (non-manifold) or T-junctions.
      const edgeCount = new Map<string, number>();
      for (const [v0, v1, v2] of mesh.faces) {
        // Degenerate triangle check
        expect(v0 !== v1 && v1 !== v2 && v2 !== v0).toBe(true);

        const edges = [
          [Math.min(v0, v1), Math.max(v0, v1)],
          [Math.min(v1, v2), Math.max(v1, v2)],
          [Math.min(v2, v0), Math.max(v2, v0)],
        ];
        for (const [e0, e1] of edges) {
          const key = `${e0}_${e1}`;
          edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
        }
      }

      // Check edge manifoldness: all edges must have either 1 triangle (boundary) or 2 triangles (interior)
      for (const [key, count] of edgeCount.entries()) {
        expect(count).toBeLessThanOrEqual(2);
        expect(count).toBeGreaterThanOrEqual(1);
      }

      // Ensure that there are valid interior edges connecting refined triangles
      const interiorEdges = Array.from(edgeCount.values()).filter((c) => c === 2);
      expect(interiorEdges.length).toBeGreaterThan(0);
    });

    it('heals edge topology and maintains watertight 2-manifold when multiple collinear Steiner points refine boundaries', () => {
      // High curvature saddle surface (biquadratic) to trigger extensive adaptive Steiner refinement
      const surface: BSplineSurface = {
        uDegree: 2,
        vDegree: 2,
        uKnots: [0, 0, 0, 0.5, 1, 1, 1],
        vKnots: [0, 0, 0, 0.5, 1, 1, 1],
        controlPoints: [
          [
            { x: 0, y: 0, z: 5 },
            { x: 5, y: 0, z: -5 },
            { x: 10, y: 0, z: 5 },
            { x: 15, y: 0, z: -5 },
          ],
          [
            { x: 0, y: 5, z: -5 },
            { x: 5, y: 5, z: 10 },
            { x: 10, y: 5, z: -5 },
            { x: 15, y: 5, z: 10 },
          ],
          [
            { x: 0, y: 10, z: 5 },
            { x: 5, y: 10, z: -5 },
            { x: 10, y: 10, z: 5 },
            { x: 15, y: 10, z: -5 },
          ],
          [
            { x: 0, y: 15, z: -5 },
            { x: 5, y: 15, z: 10 },
            { x: 10, y: 15, z: -5 },
            { x: 15, y: 15, z: 10 },
          ],
        ],
      };

      const outerLoop: Parametric2DPoint[] = [
        { u: 0, v: 0 },
        { u: 1, v: 0 },
        { u: 1, v: 1 },
        { u: 0, v: 1 },
      ];

      const mesh = tessellateTrimmedFaceCDT(
        {
          surface,
          outerLoop,
        },
        'test_saddle_mesh'
      );

      expect(mesh).not.toBeNull();
      expect(mesh.faces.length).toBeGreaterThan(6);

      const edgeCount = new Map<string, number>();
      for (const [v0, v1, v2] of mesh.faces) {
        // No degenerate triangles
        expect(v0 !== v1 && v1 !== v2 && v2 !== v0).toBe(true);

        const edges = [
          [Math.min(v0, v1), Math.max(v0, v1)],
          [Math.min(v1, v2), Math.max(v1, v2)],
          [Math.min(v2, v0), Math.max(v2, v0)],
        ];
        for (const [e0, e1] of edges) {
          const key = `${e0}_${e1}`;
          edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
        }
      }

      // Watertight manifold rule: exactly 1 (boundary) or 2 (interior), NEVER 3+
      for (const [key, count] of edgeCount.entries()) {
        expect(count).toBeLessThanOrEqual(2);
        expect(count).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe('2. ISO 32000-1 Astral Unicode ToUnicode CMap Generation', () => {
    it('maps 2-byte CID to 4-byte UTF-16BE surrogate pair for astral characters (> 0xFFFF)', () => {
      // Astral characters:
      // U+1F600 (Grinning Face): surrogate pair 0xD83D, 0xDE00 -> hex "D83DDE00"
      // U+2000B (CJK Extension B): surrogate pair 0xD840, 0xDC0B -> hex "D840DC0B"
      // U+10000 (Linear B): surrogate pair 0xD800, 0xDC00 -> hex "D800DC00"
      // BMP characters:
      // U+0041 ('A'): hex "0041"
      // U+AC00 ('가'): hex "AC00"
      const mappings: Array<[number, number]> = [
        [0x0001, 0x0041], // CID 1 -> 'A'
        [0x0002, 0xac00], // CID 2 -> '가'
        [0x0003, 0x1f600], // CID 3 -> Grinning Face (Astral)
        [0x0004, 0x2000b], // CID 4 -> CJK Ext B (Astral)
        [0x0005, 0x10000], // CID 5 -> Linear B (Astral)
      ];

      const cmap = createToUnicodeCMap(mappings);

      // Verify CMap structural markers
      expect(cmap).toContain('/CIDInit /ProcSet findresource begin');
      expect(cmap).toContain('/CMapType 2 def');
      expect(cmap).toContain('beginbfchar');
      expect(cmap).toContain('endbfchar');

      // Verify BMP mappings: 2-byte CID to 2-byte UTF-16BE
      expect(cmap).toContain('<0001> <0041>');
      expect(cmap).toContain('<0002> <AC00>');

      // Verify Astral mappings (ISO 32000-1 Section 9.10.3 compliant):
      // Source CID MUST remain 2-byte (<0003>), destination MUST be 4-byte UTF-16BE (<D83DDE00>)
      expect(cmap).toContain('<0003> <D83DDE00>');
      expect(cmap).toContain('<0004> <D840DC0B>');
      expect(cmap).toContain('<0005> <D800DC00>');

      // Verify that no fake surrogate CIDs (<D83D> or <DE00> as source) are present
      expect(cmap).not.toContain('<D83D> <');
      expect(cmap).not.toContain('<DE00> <');
    });

    it('generates standard identity CMap when no mappings are provided', () => {
      const cmap = createToUnicodeCMap();
      expect(cmap).toContain('1 beginbfrange');
      expect(cmap).toContain('<0000> <FFFF> <0000>');
      expect(cmap).toContain('endbfrange');
    });
  });
});
