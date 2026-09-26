import { describe, it, expect } from 'vitest';
import {
  coxDeBoorBasis,
  coxDeBoorBasisDerivative,
  evaluateBSplineCurve,
  evaluateBSplineSurface,
  tessellateBSplineSurface,
  parseStepEntities,
  extractStepBSplineSurfaces,
  expandKnotsWithMultiplicities,
  tessellateCadBuffer,
  tessellateSvgArc,
  parseIgesBSplineCurves,
  BSplineSurface,
  BSplineCurve,
} from '../src/lib/conversions/cad-nurbs';
import { convertFile } from '../src/lib/conversions/index';

describe('CAD NURBS Engine & de Boor-Cox Tessellator', () => {
  describe('Mathematical de Boor-Cox Basis Algorithm', () => {
    it('satisfies partition of unity: sum of basis functions equals 1.0', () => {
      // Clamped cubic B-spline knot vector with 4 control points (n=3, p=3, m=7)
      const knots = [0, 0, 0, 0, 1, 1, 1, 1];
      const p = 3;
      const n = 3;

      const testUValues = [0.0, 0.25, 0.5, 0.75, 1.0];
      for (const u of testUValues) {
        let sum = 0.0;
        for (let i = 0; i <= n; i++) {
          const val = coxDeBoorBasis(i, p, u, knots);
          expect(val).toBeGreaterThanOrEqual(0.0);
          sum += val;
        }
        expect(sum).toBeCloseTo(1.0, 8);
      }
    });

    it('correctly calculates basis function derivatives N\'_{i,p}(u)', () => {
      const knots = [0, 0, 0, 1, 2, 2, 2]; // Quadratic B-spline
      const p = 2;
      const u = 0.5;

      // Numerical finite difference comparison
      const eps = 1e-6;
      for (let i = 0; i <= 3; i++) {
        const analytical = coxDeBoorBasisDerivative(i, p, u, knots);
        const numerical = (coxDeBoorBasis(i, p, u + eps, knots) - coxDeBoorBasis(i, p, u - eps, knots)) / (2 * eps);
        expect(analytical).toBeCloseTo(numerical, 4);
      }
    });
  });

  describe('B-Spline & NURBS Surface Evaluation', () => {
    it('evaluates flat planar surface with exact unit Z normal (0, 0, 1)', () => {
      // Bilinear planar surface from (0,0,0) to (10,10,0)
      const surface: BSplineSurface = {
        uDegree: 1,
        vDegree: 1,
        uKnots: [0, 0, 1, 1],
        vKnots: [0, 0, 1, 1],
        controlPoints: [
          [{ x: 0, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }],
          [{ x: 10, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }],
        ],
      };

      const mid = evaluateBSplineSurface(surface, 0.5, 0.5);
      expect(mid.point.x).toBeCloseTo(5.0);
      expect(mid.point.y).toBeCloseTo(5.0);
      expect(mid.point.z).toBeCloseTo(0.0);

      // Exact normal for XY plane must be unit Z (0, 0, 1)
      expect(mid.normal.x).toBeCloseTo(0.0);
      expect(mid.normal.y).toBeCloseTo(0.0);
      expect(mid.normal.z).toBeCloseTo(1.0);
    });

    it('tessellates curved bicubic surface into triangular mesh with valid normals', () => {
      // 4x4 control points for a parabolic dome
      const cp: { x: number; y: number; z: number }[][] = [];
      for (let u = 0; u < 4; u++) {
        cp[u] = [];
        for (let v = 0; v < 4; v++) {
          const x = u * 5;
          const y = v * 5;
          const z = 10 - ((u - 1.5) ** 2 + (v - 1.5) ** 2) * 2;
          cp[u][v] = { x, y, z };
        }
      }

      const surface: BSplineSurface = {
        uDegree: 3,
        vDegree: 3,
        uKnots: [0, 0, 0, 0, 1, 1, 1, 1],
        vKnots: [0, 0, 0, 0, 1, 1, 1, 1],
        controlPoints: cp,
      };

      const mesh = tessellateBSplineSurface(surface, { uSamples: 8, vSamples: 8 }, 'dome');
      expect(mesh.vertices.length).toBe(9 * 9); // (8 + 1) * (8 + 1) = 81
      expect(mesh.faces.length).toBe(8 * 8 * 2); // 8 * 8 quads * 2 = 128 triangles
      expect(mesh.normals.length).toBe(mesh.vertices.length);

      // Every normal must be a unit vector
      mesh.normals.forEach(([nx, ny, nz]) => {
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        expect(len).toBeCloseTo(1.0, 5);
      });
    });
  });

  describe('STEP (ISO 10303-21) NURBS Entity Parsing & Conversions', () => {
    it('expands knot multiplicities correctly into clamped knot vectors', () => {
      const knots = [0.0, 0.5, 1.0];
      const mults = [4, 1, 4];
      const expanded = expandKnotsWithMultiplicities(knots, mults);
      expect(expanded).toEqual([0.0, 0.0, 0.0, 0.0, 0.5, 1.0, 1.0, 1.0, 1.0]);
    });

    it('parses STEP B_SPLINE_SURFACE_WITH_KNOTS and tessellates to STL and OBJ', async () => {
      const stepContent = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('EasyConvert Test Surface'),'2;1');
FILE_NAME('test.step','2026-09-26T00:00:00','','','EasyConvert','','');
FILE_SCHEMA(('CONFIG_CONTROL_DESIGN'));
ENDSEC;
DATA;
#10 = CARTESIAN_POINT('', (0.0, 0.0, 0.0));
#11 = CARTESIAN_POINT('', (0.0, 10.0, 2.0));
#12 = CARTESIAN_POINT('', (10.0, 0.0, 2.0));
#13 = CARTESIAN_POINT('', (10.0, 10.0, 5.0));
#20 = B_SPLINE_SURFACE_WITH_KNOTS('surface1', 1, 1, ((#10, #11), (#12, #13)), .UNSPECIFIED., .F., .F., .F., (2, 2), (2, 2), (0.0, 1.0), (0.0, 1.0), .PIECEWISE_BEZIER_KNOTS.);
#30 = ADVANCED_FACE('face1', (), #20, .T.);
ENDSEC;
END-ISO-10303-21;
`;

      const buffer = Buffer.from(stepContent, 'utf-8');

      // 1. STEP -> STL
      const stlRes = await convertFile(buffer, 'step', 'stl', {}, 'model.step');
      expect(stlRes.mimeType).toBe('model/stl');
      expect(stlRes.filename).toBe('model.stl');
      const stlText = stlRes.buffer.toString('utf-8');
      expect(stlText).toContain('solid');
      expect(stlText).toContain('facet normal');
      expect(stlText).toContain('vertex');
      expect(stlText).toContain('endsolid');

      // 2. STEP -> OBJ
      const objRes = await convertFile(buffer, 'step', 'obj', {}, 'model.step');
      expect(objRes.mimeType).toBe('model/obj');
      expect(objRes.filename).toBe('model.obj');
      const objText = objRes.buffer.toString('utf-8');
      expect(objText).toContain('v ');
      expect(objText).toContain('vn '); // Exact normals included!
      expect(objText).toContain('f ');

      // 3. STEP -> DXF (3DFACE entities)
      const dxfRes = await convertFile(buffer, 'step', 'dxf', {}, 'model.step');
      expect(dxfRes.mimeType).toBe('image/vnd.dxf');
      expect(dxfRes.filename).toBe('model.dxf');
      const dxfText = dxfRes.buffer.toString('utf-8');
      expect(dxfText).toContain('3DFACE');
      expect(dxfText).toContain('AC1015');
    });

    it('parses IGES Entity 128 Rational B-Spline Surface and tessellates to STL', async () => {
      // Construct a minimal IGES with Entity 128 (B-Spline Surface)
      const iges = `S      1
EasyConvert IGES Model                                                  G      1
1H,,1H;,sample,,20260925.120000,1.0,1,1,1,,1.0,1,,,;                    G      2
     128       1       0       0       0       0       0       000010001D      1
     128       0       1       1       0                               0D      2
128,1,1,1,1,0,0,1,0,0,0.0,0.0,1.0,1.0,0.0,0.0,1.0,1.0,1.0,1.0,1.0,1.0,  1P      1
0.0,0.0,0.0,0.0,10.0,0.0,10.0,0.0,0.0,10.0,10.0,5.0;                   1P      2
S      1G      2D      2P      2                                        T      1
`;

      const buffer = Buffer.from(iges, 'utf-8');
      const res = await convertFile(buffer, 'iges', 'stl', {}, 'curved.iges');
      expect(res.mimeType).toBe('model/stl');
      const stlText = res.buffer.toString('utf-8');
      expect(stlText).toContain('facet normal');
      expect(stlText).toContain('vertex');
    });

    it('accurately tessellates SVG elliptical arcs using W3C endpoint-to-center parameterization', () => {
      // 90-degree circular arc from (10, 0) to (0, 10) with radius 10
      const arcPts = tessellateSvgArc(10, 0, 10, 10, 0, 0, 1, 0, 10);
      expect(arcPts.length).toBeGreaterThan(2);

      // Verify that intermediate points lie on the circle x^2 + y^2 = 100
      for (const pt of arcPts) {
        const radius = Math.sqrt(pt.x * pt.x + pt.y * pt.y);
        expect(radius).toBeCloseTo(10, 1);
      }

      // Final point must match (0, 10)
      const last = arcPts[arcPts.length - 1];
      expect(last.x).toBeCloseTo(0, 1);
      expect(last.y).toBeCloseTo(10, 1);
    });

    it('parses IGES Entity 126 B-Spline Curve and tessellates wireframe models', () => {
      // Minimal IGES with Entity 126 (B-spline curve)
      const igesCurve = `S      1
EasyConvert IGES Curve                                                  G      1
1H,,1H;,sample,,20260925.120000,1.0,1,1,1,,1.0,1,,,;                    G      2
     126       1       0       0       0       0       0       000010001D      1
     126       0       1       1       0                               0D      2
126,2,2,0,0,1,0,0.0,0.0,0.0,1.0,1.0,1.0,1.0,1.0,1.0,0.0,0.0,0.0,5.0,10.0,0.0,1P      1
10.0,0.0,0.0,0.0,1.0,0.0,0.0,1.0;                                       1P      2
S      1G      2D      2P      2                                        T      1
`;
      const curves = parseIgesBSplineCurves(igesCurve);
      expect(curves.length).toBe(1);
      expect(curves[0].degree).toBe(2);
      expect(curves[0].controlPoints.length).toBe(3);

      const buffer = Buffer.from(igesCurve, 'utf-8');
      const mesh = tessellateCadBuffer(buffer, 'iges', 'wireframe');
      expect(mesh.vertices.length).toBeGreaterThanOrEqual(3);
      expect(mesh.faces.length).toBeGreaterThanOrEqual(1);
    });

    it('parses complex/composite STEP entities with nested B_SPLINE_SURFACE and KNOTS', async () => {
      // Composite STEP entity instance: #100 = ( BOUNDED_SURFACE() B_SPLINE_SURFACE(...) B_SPLINE_SURFACE_WITH_KNOTS(...) GEOMETRIC_REPRESENTATION_ITEM() SURFACE() );
      const stepComplex = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Composite STEP'),'2;1');
FILE_NAME('composite.step','2026-09-26T00:00:00','','','EasyConvert','','');
FILE_SCHEMA(('CONFIG_CONTROL_DESIGN'));
ENDSEC;
DATA;
#1 = CARTESIAN_POINT('', (0.0, 0.0, 0.0));
#2 = CARTESIAN_POINT('', (10.0, 0.0, 0.0));
#3 = CARTESIAN_POINT('', (0.0, 10.0, 0.0));
#4 = CARTESIAN_POINT('', (10.0, 10.0, 0.0));
#100 = ( BOUNDED_SURFACE() B_SPLINE_SURFACE(1, 1, ((#1, #2), (#3, #4)), .UNSPECIFIED., .F., .F., .F.) B_SPLINE_SURFACE_WITH_KNOTS((2, 2), (2, 2), (0.0, 1.0), (0.0, 1.0), .UNSPECIFIED.) GEOMETRIC_REPRESENTATION_ITEM() SURFACE() );
ENDSEC;
END-ISO-10303-21;
`;
      const entityMap = parseStepEntities(stepComplex);
      expect(entityMap.has(100)).toBe(true);

      const surfaces = extractStepBSplineSurfaces(entityMap);
      expect(surfaces.length).toBe(1);
      expect(surfaces[0].uDegree).toBe(1);
      expect(surfaces[0].vDegree).toBe(1);
      expect(surfaces[0].controlPoints.length).toBe(2);

      const buf = Buffer.from(stepComplex, 'utf-8');
      const mesh = tessellateCadBuffer(buf, 'step', 'composite_surface');
      expect(mesh.faces.length).toBeGreaterThan(0);
      expect(mesh.vertices.length).toBeGreaterThan(0);
    });

    it('generates non-degenerate ribbon mesh with valid unit normals from 3D curves', () => {
      const crv1: BSplineCurve = {
        degree: 1,
        controlPoints: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }],
        knots: [0, 0, 1, 1],
      };
      const crv2: BSplineCurve = {
        degree: 1,
        controlPoints: [{ x: 0, y: 5, z: 2 }, { x: 10, y: 5, z: 2 }],
        knots: [0, 0, 1, 1],
      };

      const mesh = tessellateCadBuffer(
        Buffer.from(`ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Curves'),'2;1');
FILE_NAME('curves.step','2026-09-26T00:00:00','','','','','');
FILE_SCHEMA(('CONFIG_CONTROL_DESIGN'));
ENDSEC;
DATA;
#1 = CARTESIAN_POINT('', (0.0, 0.0, 0.0));
#2 = CARTESIAN_POINT('', (10.0, 0.0, 0.0));
#3 = CARTESIAN_POINT('', (0.0, 5.0, 2.0));
#4 = CARTESIAN_POINT('', (10.0, 5.0, 2.0));
#10 = B_SPLINE_CURVE_WITH_KNOTS('c1', 1, (#1, #2), .UNSPECIFIED., .F., .F., (2, 2), (0.0, 1.0), .PIECEWISE_BEZIER_KNOTS.);
#20 = B_SPLINE_CURVE_WITH_KNOTS('c2', 1, (#3, #4), .UNSPECIFIED., .F., .F., (2, 2), (0.0, 1.0), .PIECEWISE_BEZIER_KNOTS.);
ENDSEC;
END-ISO-10303-21;`),
        'step',
        'ruled_strip'
      );

      expect(mesh.faces.length).toBeGreaterThan(0);
      expect(mesh.normals.length).toBe(mesh.vertices.length);

      // Verify no NaN or [0, 0, 0] normals
      for (const [nx, ny, nz] of mesh.normals) {
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        expect(len).toBeGreaterThan(0.9);
      }
    });
  });
});
