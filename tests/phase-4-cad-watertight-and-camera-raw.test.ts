import { describe, it, expect } from 'vitest';
import {
  weldCoincidentVertices,
  glueBRepTopologicalEdges,
  verifyWatertightManifoldMesh,
  tessellateTrimmedFaceCDT,
  buildLoopHierarchy,
  calculateParametricSignedArea,
  isPointInParametricPolygon,
  parseStepEntities,
  extractStepBRepMesh,
  BSplineSurface,
  TrimmedParametricFace,
  TessellatedMesh,
} from '../src/lib/conversions/cad-nurbs';
import {
  demosaicAmazeBayerCfa,
  demosaicAhdBayerCfa,
  demosaicBayerCfa,
  interpolateDualIlluminantColorMatrix,
  estimateCctFromWhiteBalance,
  STANDARD_ILLUMINANT_A_COLOR_MATRIX,
  DEFAULT_D65_COLOR_MATRIX,
  STANDARD_ILLUMINANT_A_CCT,
  STANDARD_ILLUMINANT_D65_CCT,
  BayerSensorData,
} from '../src/lib/conversions/image';

describe('Phase 4: CAD Watertight Meshing & Camera RAW SOTA Processing', () => {
  // ==========================================================================
  // 1. CAD B-Rep Topological Boundary Edge Gluing & Watertight Meshing
  // ==========================================================================
  describe('B-Rep Topological Boundary Edge Gluing & Manifold Verification', () => {
    it('welds coincident vertices within epsilon tolerance and eliminates duplicate seam points', () => {
      // Create two adjacent triangles sharing an edge, with slightly perturbed coincident vertices within 1e-7
      const vertices: [number, number, number][] = [
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        // Second triangle with coincident shared vertices (1, 0, 0) and (0, 1, 0)
        [1.0 + 1e-7, 0.0 - 1e-7, 0.0],
        [1.0, 1.0, 0.0],
        [0.0 - 1e-7, 1.0 + 1e-7, 0.0],
      ];
      const faces: [number, number, number][] = [
        [0, 1, 2],
        [3, 4, 5],
      ];

      const welded = weldCoincidentVertices(vertices, faces, { epsilon: 1e-6 });

      // 6 original vertices should weld down to 4 unique vertices
      expect(welded.vertices.length).toBe(4);
      expect(welded.faces.length).toBe(2);

      // Verify that shared edge uses identical vertex indices
      const f0 = welded.faces[0];
      const f1 = welded.faces[1];
      const sharedVertices = f0.filter((v) => f1.includes(v));
      expect(sharedVertices.length).toBe(2);
    });

    it('enforces Euler characteristic V - E + F = 2 and 0 open boundary edges on closed polyhedral solid', () => {
      // Construct a cube of size 10x10x10 with 6 independent quad faces (12 triangles),
      // initially having 24 completely disjoint vertices (4 vertices per face).
      const rawVertices: [number, number, number][] = [
        // Front face (Z = 10)
        [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10],
        // Back face (Z = 0)
        [10, 0, 0], [0, 0, 0], [0, 10, 0], [10, 10, 0],
        // Left face (X = 0)
        [0, 0, 0], [0, 0, 10], [0, 10, 10], [0, 10, 0],
        // Right face (X = 10)
        [10, 0, 10], [10, 0, 0], [10, 10, 0], [10, 10, 10],
        // Top face (Y = 10)
        [0, 10, 10], [10, 10, 10], [10, 10, 0], [0, 10, 0],
        // Bottom face (Y = 0)
        [0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10],
      ];

      const rawFaces: [number, number, number][] = [
        // Front (0..3)
        [0, 1, 2], [0, 2, 3],
        // Back (4..7)
        [4, 5, 6], [4, 6, 7],
        // Left (8..11)
        [8, 9, 10], [8, 10, 11],
        // Right (12..15)
        [12, 13, 14], [12, 14, 15],
        // Top (16..19)
        [16, 17, 18], [16, 18, 19],
        // Bottom (20..23)
        [20, 21, 22], [20, 22, 23],
      ];

      const rawMesh: TessellatedMesh = {
        name: 'unwelded_box',
        vertices: rawVertices,
        normals: rawVertices.map(() => [0, 0, 1]),
        faces: rawFaces,
      };

      // Before gluing: vertices are duplicated, perimeter quad edges are unshared
      const beforeReport = verifyWatertightManifoldMesh(rawMesh.vertices, rawMesh.faces);
      expect(beforeReport.isWatertight).toBe(false);
      expect(beforeReport.boundaryEdges).toBe(24); // 6 quad faces * 4 perimeter edges = 24 unshared boundary edges

      // Apply topological edge gluing
      const gluedMesh = glueBRepTopologicalEdges(rawMesh, { epsilon: 1e-6, enforceOrientedManifold: true });

      // After gluing:
      // V = 8, F = 12, E = 18
      // Euler characteristic chi = V - E + F = 8 - 18 + 12 = 2
      const afterReport = verifyWatertightManifoldMesh(gluedMesh.vertices, gluedMesh.faces);
      expect(afterReport.isManifold).toBe(true);
      expect(afterReport.isWatertight).toBe(true);
      expect(afterReport.verticesCount).toBe(8);
      expect(afterReport.facesCount).toBe(12);
      expect(afterReport.edgesCount).toBe(18);
      expect(afterReport.boundaryEdges).toBe(0);
      expect(afterReport.nonManifoldEdges).toBe(0);
      expect(afterReport.eulerCharacteristic).toBe(2);
      expect(afterReport.genus).toBe(0);
      expect(afterReport.componentsCount).toBe(1);
    });

    it('extracts and glues STEP B-Rep solid into a watertight 2-manifold mesh', () => {
      // Minimal STEP solid file: CLOSED_SHELL with 6 ADVANCED_FACE entities forming a closed unit box
      const stepBoxText = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Watertight Box Test'),'2;1');
FILE_NAME('box.step','2026-09-28T00:00:00','','','EasyConvert','','');
FILE_SCHEMA(('CONFIG_CONTROL_DESIGN'));
ENDSEC;
DATA;
#1 = CARTESIAN_POINT('', (0.0, 0.0, 0.0));
#2 = CARTESIAN_POINT('', (1.0, 0.0, 0.0));
#3 = CARTESIAN_POINT('', (1.0, 1.0, 0.0));
#4 = CARTESIAN_POINT('', (0.0, 1.0, 0.0));
#5 = CARTESIAN_POINT('', (0.0, 0.0, 1.0));
#6 = CARTESIAN_POINT('', (1.0, 0.0, 1.0));
#7 = CARTESIAN_POINT('', (1.0, 1.0, 1.0));
#8 = CARTESIAN_POINT('', (0.0, 1.0, 1.0));

#11 = VERTEX_POINT('', #1);
#12 = VERTEX_POINT('', #2);
#13 = VERTEX_POINT('', #3);
#14 = VERTEX_POINT('', #4);
#15 = VERTEX_POINT('', #5);
#16 = VERTEX_POINT('', #6);
#17 = VERTEX_POINT('', #7);
#18 = VERTEX_POINT('', #8);

#21 = EDGE_CURVE('', #11, #12, .T.);
#22 = EDGE_CURVE('', #12, #13, .T.);
#23 = EDGE_CURVE('', #13, #14, .T.);
#24 = EDGE_CURVE('', #14, #11, .T.);

#25 = EDGE_CURVE('', #15, #16, .T.);
#26 = EDGE_CURVE('', #16, #17, .T.);
#27 = EDGE_CURVE('', #17, #18, .T.);
#28 = EDGE_CURVE('', #18, #15, .T.);

#29 = EDGE_CURVE('', #11, #15, .T.);
#30 = EDGE_CURVE('', #12, #16, .T.);
#31 = EDGE_CURVE('', #13, #17, .T.);
#32 = EDGE_CURVE('', #14, #18, .T.);

#41 = EDGE_LOOP('', (#21, #22, #23, #24));
#42 = EDGE_LOOP('', (#25, #26, #27, #28));
#43 = EDGE_LOOP('', (#21, #30, #25, #29));
#44 = EDGE_LOOP('', (#22, #31, #26, #30));
#45 = EDGE_LOOP('', (#23, #32, #27, #31));
#46 = EDGE_LOOP('', (#24, #29, #28, #32));

#51 = FACE_OUTER_BOUND('', #41, .T.);
#52 = FACE_OUTER_BOUND('', #42, .T.);
#53 = FACE_OUTER_BOUND('', #43, .T.);
#54 = FACE_OUTER_BOUND('', #44, .T.);
#55 = FACE_OUTER_BOUND('', #45, .T.);
#56 = FACE_OUTER_BOUND('', #46, .T.);

#61 = ADVANCED_FACE('', (#51));
#62 = ADVANCED_FACE('', (#52));
#63 = ADVANCED_FACE('', (#53));
#64 = ADVANCED_FACE('', (#54));
#65 = ADVANCED_FACE('', (#55));
#66 = ADVANCED_FACE('', (#56));

#70 = CLOSED_SHELL('', (#61, #62, #63, #64, #65, #66));
#80 = MANIFOLD_SOLID_BREP('', #70);
ENDSEC;
END-ISO-10303-21;
`;

      const entityMap = parseStepEntities(stepBoxText);
      expect(entityMap.size).toBeGreaterThan(0);

      const brepMesh = extractStepBRepMesh(entityMap, 'step_box');
      expect(brepMesh).not.toBeNull();
      expect(brepMesh!.faces.length).toBeGreaterThan(0);

      // Verify watertight manifold topology invariants
      const report = verifyWatertightManifoldMesh(brepMesh!.vertices, brepMesh!.faces);
      expect(report.isManifold).toBe(true);
      expect(report.isWatertight).toBe(true);
      expect(report.verticesCount).toBe(8);
      expect(report.boundaryEdges).toBe(0);
      expect(report.nonManifoldEdges).toBe(0);
      expect(report.eulerCharacteristic).toBe(2);
    });

    it('correctly reports boundary edges and manifold status for open sheets', () => {
      // Single open square sheet composed of 2 triangles
      const vertices: [number, number, number][] = [
        [0, 0, 0],
        [10, 0, 0],
        [10, 10, 0],
        [0, 10, 0],
      ];
      const faces: [number, number, number][] = [
        [0, 1, 2],
        [0, 2, 3],
      ];

      const report = verifyWatertightManifoldMesh(vertices, faces);
      expect(report.isManifold).toBe(true);
      expect(report.isWatertight).toBe(false); // Open boundary -> not watertight
      expect(report.boundaryEdges).toBe(4); // 4 perimeter edges
      expect(report.nonManifoldEdges).toBe(0);
      expect(report.eulerCharacteristic).toBe(1); // 4 - 5 + 2 = 1
    });
  });

  // ==========================================================================
  // 2. Robust Loop Hierarchy Constrained Delaunay Triangulation (CDT)
  // ==========================================================================
  describe('Robust Loop Hierarchy CDT (Nested Holes & Islands)', () => {
    const planarSurface: BSplineSurface = {
      uDegree: 1,
      vDegree: 1,
      uKnots: [0, 0, 1, 1],
      vKnots: [0, 0, 1, 1],
      controlPoints: [
        [{ x: 0, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }],
        [{ x: 10, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }],
      ],
    };

    it('constructs loop hierarchy tree with correct nesting depths and hole flags', () => {
      // Depth 0: Outer box [0, 10] x [0, 10] (area 100)
      const outer = [
        { u: 0, v: 0 }, { u: 10, v: 0 }, { u: 10, v: 10 }, { u: 0, v: 10 },
      ];
      // Depth 1: Hole 1 [2, 8] x [2, 8] (area 36)
      const hole1 = [
        { u: 2, v: 2 }, { u: 8, v: 2 }, { u: 8, v: 8 }, { u: 2, v: 8 },
      ];
      // Depth 2: Island 1 inside Hole 1 [4, 6] x [4, 6] (area 4)
      const island1 = [
        { u: 4, v: 4 }, { u: 6, v: 4 }, { u: 6, v: 6 }, { u: 4, v: 6 },
      ];
      // Depth 3: Sub-hole 2 inside Island 1 [4.6, 5.4] x [4.6, 5.4] (area 0.64)
      const hole2 = [
        { u: 4.6, v: 4.6 }, { u: 5.4, v: 4.6 }, { u: 5.4, v: 5.4 }, { u: 4.6, v: 5.4 },
      ];

      const forest = buildLoopHierarchy([outer, hole1, island1, hole2]);
      expect(forest.length).toBe(1);

      const root = forest[0];
      expect(root.depth).toBe(0);
      expect(root.isHole).toBe(false);
      expect(calculateParametricSignedArea(root.loop)).toBeGreaterThan(0); // CCW

      expect(root.children.length).toBe(1);
      const childHole1 = root.children[0];
      expect(childHole1.depth).toBe(1);
      expect(childHole1.isHole).toBe(true);
      expect(calculateParametricSignedArea(childHole1.loop)).toBeLessThan(0); // CW

      expect(childHole1.children.length).toBe(1);
      const childIsland1 = childHole1.children[0];
      expect(childIsland1.depth).toBe(2);
      expect(childIsland1.isHole).toBe(false);
      expect(calculateParametricSignedArea(childIsland1.loop)).toBeGreaterThan(0); // CCW

      expect(childIsland1.children.length).toBe(1);
      const childHole2 = childIsland1.children[0];
      expect(childHole2.depth).toBe(3);
      expect(childHole2.isHole).toBe(true);
      expect(calculateParametricSignedArea(childHole2.loop)).toBeLessThan(0); // CW
    });

    it('triangulates complex nested island and sub-hole trimmed faces without degenerate slivers', () => {
      // Face with outer boundary [0, 1] x [0, 1], hole at [0.2, 0.8], island at [0.4, 0.6]
      // In 3D (mapped by planarSurface 10x10):
      // Outer box: Area = 100
      // Hole 1: [2, 8] x [2, 8] -> Area = 36
      // Island 1: [4, 6] x [4, 6] -> Area = 4
      // Expected theoretical area = 100 - 36 + 4 = 68
      const face: TrimmedParametricFace = {
        surface: planarSurface,
        outerLoop: [
          { u: 0, v: 0 },
          { u: 1, v: 0 },
          { u: 1, v: 1 },
          { u: 0, v: 1 },
        ],
        innerHoles: [
          [
            { u: 0.2, v: 0.2 },
            { u: 0.8, v: 0.2 },
            { u: 0.8, v: 0.8 },
            { u: 0.2, v: 0.8 },
          ],
        ],
        islands: [
          [
            { u: 0.4, v: 0.4 },
            { u: 0.6, v: 0.4 },
            { u: 0.6, v: 0.6 },
            { u: 0.4, v: 0.6 },
          ],
        ],
      };

      const mesh = tessellateTrimmedFaceCDT(face, 'nested_island_face');
      expect(mesh.faces.length).toBeGreaterThan(0);

      // Verify no centroids fall in the cutout region between hole boundary and island boundary
      // Cutout region: inside [2, 8] x [2, 8] but outside [4, 6] x [4, 6]
      let centroidsInHoleCutout = 0;
      let totalArea = 0;

      for (const [i0, i1, i2] of mesh.faces) {
        const p0 = mesh.vertices[i0];
        const p1 = mesh.vertices[i1];
        const p2 = mesh.vertices[i2];

        const cx = (p0[0] + p1[0] + p2[0]) / 3;
        const cy = (p0[1] + p1[1] + p2[1]) / 3;

        const inHole = cx > 2.01 && cx < 7.99 && cy > 2.01 && cy < 7.99;
        const inIsland = cx >= 3.99 && cx <= 6.01 && cy >= 3.99 && cy <= 6.01;

        if (inHole && !inIsland) {
          centroidsInHoleCutout++;
        }

        // Triangle area
        const ax = p1[0] - p0[0], ay = p1[1] - p0[1];
        const bx = p2[0] - p0[0], by = p2[1] - p0[1];
        const triArea = 0.5 * Math.abs(ax * by - ay * bx);
        expect(triArea).toBeGreaterThan(1e-10); // Zero-area slivers must be eliminated
        totalArea += triArea;
      }

      expect(centroidsInHoleCutout).toBe(0);
      expect(totalArea).toBeCloseTo(68.0, 1);
    });
  });

  // ==========================================================================
  // 3. Camera RAW SOTA Processing & Demosaicing (AHD / AMaZE)
  // ==========================================================================
  describe('Camera RAW Bayer CFA Demosaicing (AHD / AMaZE)', () => {
    it('demosaics synthetic Bayer CFA frame with high PSNR against ground truth', () => {
      // 16x16 test pattern with smooth color ramp
      const width = 16;
      const height = 16;
      const groundTruthR = new Float32Array(width * height);
      const groundTruthG = new Float32Array(width * height);
      const groundTruthB = new Float32Array(width * height);

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = y * width + x;
          groundTruthR[idx] = Math.round(50 + (x / width) * 150);
          groundTruthG[idx] = Math.round(60 + (y / height) * 140);
          groundTruthB[idx] = Math.round(70 + ((x + y) / (width + height)) * 130);
        }
      }

      // Sample into RGGB Bayer CFA pattern
      const bayerData = new Uint8Array(width * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = y * width + x;
          const rx = x & 1;
          const ry = y & 1;
          if (ry === 0) {
            bayerData[idx] = rx === 0 ? groundTruthR[idx] : groundTruthG[idx];
          } else {
            bayerData[idx] = rx === 0 ? groundTruthG[idx] : groundTruthB[idx];
          }
        }
      }

      const sensor: BayerSensorData = {
        width,
        height,
        pattern: 'RGGB',
        data: bayerData,
        bitsPerSample: 8,
      };

      const resultAmaze = demosaicAmazeBayerCfa(sensor);
      expect(resultAmaze.data.length).toBe(width * height * 3);

      const resultAhd = demosaicAhdBayerCfa(sensor);
      expect(resultAhd.data.length).toBe(width * height * 3);

      // Compute Peak Signal-to-Noise Ratio (PSNR) on interior region
      let mse = 0;
      let count = 0;
      for (let y = 2; y < height - 2; y++) {
        for (let x = 2; x < width - 2; x++) {
          const pIdx = y * width + x;
          const r = resultAmaze.data[pIdx * 3];
          const g = resultAmaze.data[pIdx * 3 + 1];
          const b = resultAmaze.data[pIdx * 3 + 2];

          const diffR = r - groundTruthR[pIdx];
          const diffG = g - groundTruthG[pIdx];
          const diffB = b - groundTruthB[pIdx];

          mse += (diffR * diffR + diffG * diffG + diffB * diffB) / 3;
          count++;
        }
      }
      mse /= count;
      const psnr = 10 * Math.log10((255 * 255) / Math.max(1e-6, mse));

      // Standard demosaicing on smooth gradient achieves > 35 dB PSNR
      expect(psnr).toBeGreaterThan(35.0);
    });

    it('eliminates zipper artifacts across sharp step edges using direction-filtered gradient interpolation', () => {
      // 16x16 image with a sharp vertical edge at x = 8
      const width = 16;
      const height = 16;
      const bayerData = new Uint8Array(width * height);

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = y * width + x;
          // Step transition: left is dark (40), right is bright (220)
          bayerData[idx] = x < 8 ? 40 : 220;
        }
      }

      const sensor: BayerSensorData = {
        width,
        height,
        pattern: 'RGGB',
        data: bayerData,
        bitsPerSample: 8,
      };

      const demosaiced = demosaicBayerCfa(sensor);

      // Across the vertical step edge (y from 3 to 12 at x = 7 and x = 8),
      // verify that neighboring pixels along the same vertical line do not oscillate (zipper effect)
      let maxZipperDelta = 0;
      for (let y = 3; y < height - 4; y++) {
        const curG = demosaiced.data[(y * width + 8) * 3 + 1];
        const nextG = demosaiced.data[((y + 1) * width + 8) * 3 + 1];
        const delta = Math.abs(curG - nextG);
        if (delta > maxZipperDelta) maxZipperDelta = delta;
      }

      // Zipper oscillation along a uniform vertical edge must be minimal (< 10 levels)
      expect(maxZipperDelta).toBeLessThan(10);
    });
  });

  // ==========================================================================
  // 4. Dual Illuminant CCT Weighted Color Matrix Interpolation
  // ==========================================================================
  describe('Dual Illuminant CCT Weighted Interpolation', () => {
    it('exact calibration match at Standard Illuminant A (2856K) and D65 (6504K)', () => {
      // Target CCT = 2856K -> exactly matches Illuminant A matrix
      const matA = interpolateDualIlluminantColorMatrix(STANDARD_ILLUMINANT_A_CCT);
      for (let i = 0; i < 9; i++) {
        expect(matA[i]).toBeCloseTo(STANDARD_ILLUMINANT_A_COLOR_MATRIX[i], 5);
      }

      // Target CCT = 6504K -> exactly matches Illuminant D65 matrix
      const matD65 = interpolateDualIlluminantColorMatrix(STANDARD_ILLUMINANT_D65_CCT);
      for (let i = 0; i < 9; i++) {
        expect(matD65[i]).toBeCloseTo(DEFAULT_D65_COLOR_MATRIX[i], 5);
      }

      // Out-of-bounds clamps:
      // Below 2856K clamps to pure Illuminant A
      const matCold = interpolateDualIlluminantColorMatrix(2000);
      for (let i = 0; i < 9; i++) {
        expect(matCold[i]).toBeCloseTo(STANDARD_ILLUMINANT_A_COLOR_MATRIX[i], 5);
      }

      // Above 6504K clamps to pure Illuminant D65
      const matWarm = interpolateDualIlluminantColorMatrix(9000);
      for (let i = 0; i < 9; i++) {
        expect(matWarm[i]).toBeCloseTo(DEFAULT_D65_COLOR_MATRIX[i], 5);
      }
    });

    it('interpolates monotonically in reciprocal temperature (Mired) space at intermediate CCTs', () => {
      // 4000K and 5000K intermediate temperatures
      const mat4000 = interpolateDualIlluminantColorMatrix(4000);
      const mat5000 = interpolateDualIlluminantColorMatrix(5000);

      // Verify that every component of mat4000 and mat5000 lies strictly between matA and matD65
      for (let i = 0; i < 9; i++) {
        const valA = STANDARD_ILLUMINANT_A_COLOR_MATRIX[i];
        const valD65 = DEFAULT_D65_COLOR_MATRIX[i];
        const minVal = Math.min(valA, valD65);
        const maxVal = Math.max(valA, valD65);

        expect(mat4000[i]).toBeGreaterThanOrEqual(minVal - 1e-6);
        expect(mat4000[i]).toBeLessThanOrEqual(maxVal + 1e-6);

        expect(mat5000[i]).toBeGreaterThanOrEqual(minVal - 1e-6);
        expect(mat5000[i]).toBeLessThanOrEqual(maxVal + 1e-6);
      }
    });

    it('accurately estimates CCT from sensor white balance gain ratios', () => {
      // Incandescent / Tungsten scene: high blue gain relative to red gain -> CCT ~ 2800K
      const cctTungsten = estimateCctFromWhiteBalance([1.0, 1.0, 2.0]);
      expect(cctTungsten).toBeGreaterThanOrEqual(2500);
      expect(cctTungsten).toBeLessThanOrEqual(3500);

      // Daylight scene: lower blue/red gain ratio -> CCT ~ 5500 - 7500K
      const cctDaylight = estimateCctFromWhiteBalance([2.0, 1.0, 1.2]);
      expect(cctDaylight).toBeGreaterThanOrEqual(5500);
      expect(cctDaylight).toBeLessThanOrEqual(8000);
    });

    it('applies dual illuminant interpolated color matrix during Bayer demosaicing', () => {
      const width = 4;
      const height = 4;
      const bayer = new Uint8Array(width * height).fill(128);

      const customMatrixA: [number, number, number, number, number, number, number, number, number] = [
        1.5, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 0.8,
      ];
      const customMatrixD65: [number, number, number, number, number, number, number, number, number] = [
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.2,
      ];

      const sensor: BayerSensorData = {
        width,
        height,
        pattern: 'RGGB',
        data: bayer,
        colorMatrix1: customMatrixA,
        colorMatrix2: customMatrixD65,
        cctKelvin: STANDARD_ILLUMINANT_A_CCT, // 2856K -> should use customMatrixA
      };

      const resultA = demosaicAmazeBayerCfa(sensor);
      expect(resultA.data.length).toBe(width * height * 3);

      // Under customMatrixA (red scale 1.5, blue scale 0.8):
      // red value must be significantly greater than blue value
      const midIdx = (2 * width + 2) * 3;
      const rA = resultA.data[midIdx];
      const bA = resultA.data[midIdx + 2];
      expect(rA).toBeGreaterThan(bA);

      // Now switch to D65 (red scale 1.0, blue scale 1.2)
      const sensorD65: BayerSensorData = {
        ...sensor,
        cctKelvin: STANDARD_ILLUMINANT_D65_CCT,
      };
      const resultD65 = demosaicAmazeBayerCfa(sensorD65);
      const rD65 = resultD65.data[midIdx];
      const bD65 = resultD65.data[midIdx + 2];
      expect(bD65).toBeGreaterThan(rD65);
    });
  });
});
