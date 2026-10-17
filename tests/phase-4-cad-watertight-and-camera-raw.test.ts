import { describe, it, expect } from 'vitest';
import {
  verifyWatertightManifoldMesh,
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

    it('detects non-manifold edges, non-manifold vertices (pinched pinch-points), and degenerate faces', () => {
      // 1. T-junction (3 triangles sharing one edge)
      const tJunctionVertices: [number, number, number][] = [
        [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1],
      ];
      const tJunctionFaces: [number, number, number][] = [
        [0, 1, 2],
        [0, 1, 3],
        [0, 1, 4],
      ];
      const reportTJunction = verifyWatertightManifoldMesh(tJunctionVertices, tJunctionFaces);
      expect(reportTJunction.isManifold).toBe(false);
      expect(reportTJunction.nonManifoldEdges).toBeGreaterThan(0);

      // 2. Pinched non-manifold vertex (two tetrahedra meeting at a single shared apex vertex [0, 0, 0])
      const hourglassVertices: [number, number, number][] = [
        // Apex vertex 0
        [0, 0, 0],
        // Pyramid 1 base (Z = -1)
        [-1, -1, -1], [1, -1, -1], [0, 1, -1],
        // Pyramid 2 base (Z = 1)
        [-1, -1, 1], [1, -1, 1], [0, 1, 1],
      ];
      const hourglassFaces: [number, number, number][] = [
        // Tetrahedron 1: base + 3 sides
        [1, 2, 3],
        [0, 2, 1], [0, 3, 2], [0, 1, 3],
        // Tetrahedron 2: base + 3 sides
        [4, 6, 5],
        [0, 4, 5], [0, 5, 6], [0, 6, 4],
      ];
      const reportHourglass = verifyWatertightManifoldMesh(hourglassVertices, hourglassFaces);
      expect(reportHourglass.isManifold).toBe(false);

      // 3. Degenerate face with collapsed edge [0, 1, 1]
      const degenerateVertices: [number, number, number][] = [
        [0, 0, 0], [1, 0, 0], [0, 1, 0],
      ];
      const degenerateFaces: [number, number, number][] = [
        [0, 1, 1],
      ];
      const reportDegenerate = verifyWatertightManifoldMesh(degenerateVertices, degenerateFaces);
      expect(reportDegenerate.isManifold).toBe(false);
      expect(reportDegenerate.hasDegenerateFace).toBe(true);
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

    it('preserves boundary CFA parity without channel cross-bleed at frame borders', () => {
      // Create an 8x8 RGGB pattern with uniform pure colors:
      // Red sensors = 200, Green sensors = 100, Blue sensors = 50
      const width = 8;
      const height = 8;
      const bayer = new Uint8Array(width * height);

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const isRed = (y % 2 === 0) && (x % 2 === 0);
          const isBlue = (y % 2 === 1) && (x % 2 === 1);
          if (isRed) {
            bayer[y * width + x] = 200;
          } else if (isBlue) {
            bayer[y * width + x] = 50;
          } else {
            bayer[y * width + x] = 100;
          }
        }
      }

      const sensor: BayerSensorData = {
        width,
        height,
        pattern: 'RGGB',
        data: bayer,
      };

      const result = demosaicAmazeBayerCfa(sensor);

      // Check corner pixel (0, 0): top-left corner
      // Before fix: clamp(-1) flipped parity causing G to blend with R -> G was ~150, B was ~131
      // After fix: parity-preserving reflection keeps R = 200, G = 100, B = 50
      const idx00 = 0;
      const r0 = result.data[idx00];
      const g0 = result.data[idx00 + 1];
      const b0 = result.data[idx00 + 2];

      expect(r0).toBe(200);
      expect(Math.abs(g0 - 100)).toBeLessThanOrEqual(2);
      expect(Math.abs(b0 - 50)).toBeLessThanOrEqual(2);

      // Check bottom-right corner (7, 7) (blue pixel)
      const idx77 = (7 * width + 7) * 3;
      const r7 = result.data[idx77];
      const g7 = result.data[idx77 + 1];
      const b7 = result.data[idx77 + 2];

      expect(b7).toBe(50);
      expect(Math.abs(g7 - 100)).toBeLessThanOrEqual(2);
      expect(Math.abs(r7 - 200)).toBeLessThanOrEqual(2);
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

    it('safely handles NaN CCT, single colorMatrix1, and validates buffer dimensions', () => {
      // 1. NaN CCT input defaults to Standard Illuminant D65 matrix without producing NaN
      const matNan = interpolateDualIlluminantColorMatrix(Number.NaN);
      for (let i = 0; i < 9; i++) {
        expect(Number.isFinite(matNan[i])).toBe(true);
        expect(matNan[i]).toBeCloseTo(DEFAULT_D65_COLOR_MATRIX[i], 5);
      }

      // 2. Single colorMatrix1 provided (no colorMatrix2): returns colorMatrix1
      const singleMatrix: [number, number, number, number, number, number, number, number, number] = [
        1.1, 0.2, 0.3,
        0.4, 1.2, 0.5,
        0.6, 0.7, 1.3,
      ];
      const matSingle = interpolateDualIlluminantColorMatrix(3000, singleMatrix);
      for (let i = 0; i < 9; i++) {
        expect(matSingle[i]).toBeCloseTo(singleMatrix[i], 5);
      }

      // 3. Buffer dimension non-parity and buffer underflow fail closed
      expect(() => {
        demosaicAmazeBayerCfa({
          width: 5, // Odd width is invalid for 2x2 Bayer CFA
          height: 4,
          pattern: 'RGGB',
          data: new Uint8Array(20),
        });
      }).toThrow();

      expect(() => {
        demosaicAmazeBayerCfa({
          width: 4,
          height: 4,
          pattern: 'RGGB',
          data: new Uint8Array(10), // Underflow: 10 < 16
        });
      }).toThrow();
    });
  });
});
