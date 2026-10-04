import { describe, it, expect } from 'vitest';
import {
  verifyWatertightManifoldMesh,
  splitNormalsByCreaseAngle,
  scaleMeshCoordinates,
  parseStepUnit,
  parseIgesUnit,
  tessellateCadText,
  TessellatedMesh,
} from '../src/lib/conversions/cad-nurbs';
import { encode3dCadToDxf } from '../src/lib/conversions/vector-cad';
import { CadTopologyError, CadGeometryUnavailableError } from '../src/lib/types';

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

describe('WP-46a: CAD Topology Validation, Watertightness Gate, Units & Normal Splitting', () => {
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

  describe('2. Watertightness Gate on Solid B-Rep Tessellation', () => {
    it('throws CadTopologyError on non-watertight solid B-Rep when allowOpenMesh is not set', () => {
      // STEP document containing a MANIFOLD_SOLID_BREP, but with only 5 faces of a cube (open box)
      const openStepSolid = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Open Box Solid'),'2;1');
FILE_NAME('open_box.step','2026-10-04T00:00:00','','','EasyConvert','','');
FILE_SCHEMA(('CONFIG_CONTROL_DESIGN'));
ENDSEC;
DATA;
#10=MANIFOLD_SOLID_BREP('OpenSolid',#11);
#11=CLOSED_SHELL('Shell',(#20,#21,#22,#23,#24));
#100=CARTESIAN_POINT('',(0.,0.,0.));
#101=CARTESIAN_POINT('',(10.,0.,0.));
#102=CARTESIAN_POINT('',(10.,10.,0.));
#103=CARTESIAN_POINT('',(0.,10.,0.));
#104=CARTESIAN_POINT('',(0.,0.,10.));
#105=CARTESIAN_POINT('',(10.,0.,10.));
#106=CARTESIAN_POINT('',(10.,10.,10.));
#107=CARTESIAN_POINT('',(0.,10.,10.));
#200=VERTEX_POINT('',#100);
#201=VERTEX_POINT('',#101);
#202=VERTEX_POINT('',#102);
#203=VERTEX_POINT('',#103);
#204=VERTEX_POINT('',#104);
#205=VERTEX_POINT('',#105);
#206=VERTEX_POINT('',#106);
#207=VERTEX_POINT('',#107);
#301=EDGE_CURVE('',#200,#201,#400,.T.);
#302=EDGE_CURVE('',#201,#202,#400,.T.);
#303=EDGE_CURVE('',#202,#203,#400,.T.);
#304=EDGE_CURVE('',#203,#200,#400,.T.);
#400=LINE('',#100,#500);
#500=VECTOR('',#600,10.);
#600=DIRECTION('',(1.,0.,0.));
#501=ORIENTED_EDGE('',*,*,#301,.T.);
#502=ORIENTED_EDGE('',*,*,#302,.T.);
#503=ORIENTED_EDGE('',*,*,#303,.T.);
#504=ORIENTED_EDGE('',*,*,#304,.T.);
#601=EDGE_LOOP('',(#501,#502,#503,#504));
#701=FACE_OUTER_BOUND('',#601,.T.);
#20=ADVANCED_FACE('Face_Bottom',(#701),#800,.F.);
#800=PLANE('',#900);
#900=AXIS2_PLACEMENT_3D('',#100,#600,#600);
ENDSEC;
END-ISO-10303-21;`;

      // Should fail closed with CadTopologyError
      expect(() => {
        tessellateCadText(openStepSolid, 'step', 'open_box');
      }).toThrow(CadTopologyError);

      // Should bypass when allowOpenMesh: true is explicitly provided
      const mesh = tessellateCadText(openStepSolid, 'step', 'open_box', { allowOpenMesh: true });
      expect(mesh).toBeDefined();
      expect(mesh.topologyReport).toBeDefined();
      expect(mesh.topologyReport?.isWatertight).toBe(false);
    });
  });

  describe('3. STEP & IGES Units Parsing and Scaling', () => {
    it('parses STEP units (CONVERSION_BASED_UNIT for INCH) and scales coordinates accurately', () => {
      const stepInch = `ISO-10303-21;
HEADER;
FILE_NAME('test.step','2026-10-04','','','','','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));
ENDSEC;
DATA;
#1=CONVERSION_BASED_UNIT('INCH',#2);
#2=LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),#3);
#3=( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );
#10=B_SPLINE_CURVE_WITH_KNOTS('Line',1,(#20,#21),.UNSPECIFIED.,.F.,.F.,(2,2),(0.,1.),.PIECEWISE_BEZIER_KNOTS.);
#20=CARTESIAN_POINT('',(1.0, 2.0, 3.0));
#21=CARTESIAN_POINT('',(4.0, 5.0, 6.0));
ENDSEC;
END-ISO-10303-21;`;

      const unit = parseStepUnit(stepInch);
      expect(unit).toBe('in');

      // Tessellate with outputUnit: 'mm' -> 1 inch * 25.4 = 25.4 mm
      const meshMm = tessellateCadText(stepInch, 'step', 'line_inch', { outputUnit: 'mm' });
      expect(meshMm.unit).toBe('mm');
      // The curve spans from x=1.0 to x=4.0 inches (scaled by 25.4 -> ~25.4 to ~101.6 mm)
      const minX = Math.min(...meshMm.vertices.map((v) => v[0]));
      const maxX = Math.max(...meshMm.vertices.map((v) => v[0]));
      expect(minX).toBeGreaterThan(24);
      expect(minX).toBeLessThan(26);
      expect(maxX).toBeGreaterThan(100);
      expect(maxX).toBeLessThan(104);
    });

    it('parses IGES Global section units flag and scales coordinates accurately', () => {
      const igesInch = `S      1
EasyConvert IGES Curve                                                  G      1
1H,,1H;,sample,,20260925.120000,1.0,1,1,1,,1.0,1,1,1,4HINCH;             G      2
     126       1       0       0       0       0       0       000010001D      1
     126       0       1       1       0                               0D      2
126,2,2,0,0,1,0,0.0,0.0,0.0,1.0,1.0,1.0,1.0,1.0,1.0,0.0,0.0,0.0,5.0,10.0,0.0,1P      1
10.0,0.0,0.0,0.0,1.0,0.0,0.0,1.0;                                       1P      2
S      1G      2D      2P      2                                        T      1
`;

      const unit = parseIgesUnit(igesInch);
      expect(unit).toBe('in');

      const meshMm = tessellateCadText(igesInch, 'iges', 'iges_line', { outputUnit: 'mm' });
      expect(meshMm.unit).toBe('mm');
      // Peak Y coordinate in inches was 5.0 inches -> scaled to 127.0 mm
      const maxY = Math.max(...meshMm.vertices.map((v) => v[1]));
      expect(maxY).toBeCloseTo(127.0, 0);
    });

    it('preserves native coordinates and sets unit to unknown when unparseable', () => {
      const mesh: TessellatedMesh = {
        name: 'test',
        vertices: [[10, 20, 30]],
        normals: [[0, 0, 1]],
        faces: [],
      };
      const scaled = scaleMeshCoordinates(mesh, null, 'mm');
      expect(scaled.unit).toBe('unknown');
      expect(scaled.vertices[0]).toEqual([10, 20, 30]);
    });
  });

  describe('4. Crease-Angle Dihedral Vertex Normal Splitting', () => {
    it('splits sharp 90-degree cube corner vertices into 24 distinct facet vertices when smoothingAngleDeg=30', () => {
      const cube = createCubeMesh([0, 0, 0], 10);
      const mesh: TessellatedMesh = {
        name: 'sharp_cube',
        vertices: cube.vertices,
        normals: cube.vertices.map(() => [0, 0, 1]),
        faces: cube.faces,
      };

      // With smoothingAngleDeg = 30, the 90 degree edges between orthogonal faces must split.
      // 6 faces * 4 vertices = 24 unique vertices with crisp face normals
      const splitMesh = splitNormalsByCreaseAngle(mesh, 30);
      expect(splitMesh.vertices.length).toBe(24);
      expect(splitMesh.normals.length).toBe(24);
      expect(splitMesh.faces.length).toBe(12);

      // Verify that every normal belongs to one of the 6 canonical cube face normals:
      // (±1, 0, 0), (0, ±1, 0), (0, 0, ±1)
      for (const norm of splitMesh.normals) {
        const isOrthogonal =
          (Math.abs(norm[0]) > 0.99 && Math.abs(norm[1]) < 0.01 && Math.abs(norm[2]) < 0.01) ||
          (Math.abs(norm[1]) > 0.99 && Math.abs(norm[0]) < 0.01 && Math.abs(norm[2]) < 0.01) ||
          (Math.abs(norm[2]) > 0.99 && Math.abs(norm[0]) < 0.01 && Math.abs(norm[1]) < 0.01);
        expect(isOrthogonal).toBe(true);
      }
    });

    it('does not split vertices when smoothingAngleDeg exceeds dihedral angle (smooth shading)', () => {
      const cube = createCubeMesh([0, 0, 0], 10);
      const mesh: TessellatedMesh = {
        name: 'smooth_cube',
        vertices: cube.vertices,
        normals: cube.vertices.map(() => [0, 0, 1]),
        faces: cube.faces,
      };

      // With smoothingAngleDeg = 100, the 90 degree cube edges are considered smooth
      const smoothMesh = splitNormalsByCreaseAngle(mesh, 100);
      expect(smoothMesh.vertices.length).toBe(8); // Kept 8 corner vertices
      expect(smoothMesh.faces.length).toBe(12);
    });
  });

  describe('5. Fail-Closed Anti-Cheating Invariants in Vector CAD (Defect N8 Remediation)', () => {
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
