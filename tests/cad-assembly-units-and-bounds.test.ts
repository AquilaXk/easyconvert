import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  OCCT_MAX_ASSEMBLY_SHAPES,
  OCCT_MAX_EXPANDED_FACES,
  OCCT_MAX_INPUT_BYTES,
  OCCT_MAX_OUTPUT_TRIANGLES,
  OCCT_MESH_MAX_TRIANGLES,
  OCCT_MESH_MAX_VERTICES,
  convertCadWithOcct,
  convertMeshToIgesWithOcct,
} from '../src/lib/conversions/cad-occt';
import { MAX_IGES_INPUT_BYTES, MAX_IGES_RECORDS, prepareIgesForKernel } from '../src/lib/conversions/cad-iges-preflight';
import {
  MAX_ASCII_STL_WORDS,
  MAX_CGM_ELEMENTS,
  MAX_CGM_POINTS,
  MAX_CGM_TEXT_CHARS,
  MAX_CGM_VDC_EXTENT,
  MAX_MESH_TRIANGLES,
  MAX_MESH_VERTICES,
  MAX_OBJ_FACE_CORNERS,
  MAX_OBJ_LINES,
  MAX_STEP_MESH_TRIANGLES,
  MAX_STEP_MESH_VERTICES,
  MAX_TEXT_MESH_BYTES,
  convertVectorCad,
  encode3dCadToDxf,
  encodeStep,
  parse3dCad,
  parseCgmToSvg,
  type CadMesh3D,
} from '../src/lib/conversions/vector-cad';
import {
  MAX_PURE_CAD_TRIANGLES,
  MAX_PURE_CAD_VERTICES,
  encodeBinaryStl,
  encodeObj as pureEncodeObj,
  encodeStl as pureEncodeStl,
  type TessellatedMesh,
} from '../src/lib/edge/pure/pure-cad';
import { EdgeUnsupportedError } from '../src/lib/edge/workers/worker-errors';
import {
  CadExpansionLimitError,
  CadGeometryUnavailableError,
  ConversionFailedError,
  PayloadLimitError,
  UnprocessableCadInputError,
  isTypedRefusal,
  typedFailureOf,
} from '../src/lib/types';
import { haveCadOracles } from './helpers/cad-kernel';
import { igesLengthUnitFlag } from './helpers/iges-entities';
import { meshFacts } from './helpers/mesh-facts';
import { oracleFacts } from './helpers/occt-oracle';
import { runWithoutFileConfinement } from './helpers/unconfined-files';

runWithoutFileConfinement();

const scratchDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of scratchDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function withCadProgram<T>(program: string, body: () => Promise<T>): Promise<T> {
  const before = process.env.CAD_CONVERT_PATH;
  process.env.CAD_CONVERT_PATH = program;
  try {
    return await body();
  } finally {
    if (before === undefined) delete process.env.CAD_CONVERT_PATH;
    else process.env.CAD_CONVERT_PATH = before;
  }
}

function makeStandInProgram(scriptBody: string): string {
  const dir = makeTempDir('cad-p115-');
  const file = path.join(dir, 'cad-convert');
  fs.writeFileSync(file, `#!/bin/sh\n${scriptBody}\n`, { mode: 0o755 });
  return file;
}

function makeCubeMesh(size = 10): CadMesh3D {
  const vertices: [number, number, number][] = [
    [0, 0, 0],
    [size, 0, 0],
    [size, size, 0],
    [0, size, 0],
    [0, 0, size],
    [size, 0, size],
    [size, size, size],
    [0, size, size],
  ];
  const faces: [number, number, number][] = [
    [0, 2, 1], [0, 3, 2],
    [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4],
    [2, 3, 7], [2, 7, 6],
    [0, 4, 7], [0, 7, 3],
    [1, 2, 6], [1, 6, 5],
  ];
  return { name: 'cube_10mm', vertices, faces, normals: [] };
}

function cubeObjBuffer(size = 10): Buffer {
  const mesh = makeCubeMesh(size);
  const lines = [
    ...mesh.vertices.map((v) => `v ${v[0]} ${v[1]} ${v[2]}`),
    ...mesh.faces.map((f) => `f ${f[0] + 1} ${f[1] + 1} ${f[2] + 1}`),
  ];
  return Buffer.from(`${lines.join('\n')}\n`, 'utf-8');
}

function cubeBinaryStlBuffer(size = 10, headerText = 'binary STL cube'): Buffer {
  const mesh = makeCubeMesh(size);
  const out = Buffer.alloc(84 + 50 * mesh.faces.length);
  out.write(headerText.slice(0, 80), 0, 'ascii');
  out.writeUInt32LE(mesh.faces.length, 80);
  for (let i = 0; i < mesh.faces.length; i++) {
    const off = 84 + 50 * i;
    const [a, b, c] = mesh.faces[i];
    const p0 = mesh.vertices[a];
    const p1 = mesh.vertices[b];
    const p2 = mesh.vertices[c];
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    out.writeFloatLE(nx, off);
    out.writeFloatLE(ny, off + 4);
    out.writeFloatLE(nz, off + 8);
    const pts = [p0, p1, p2];
    for (let k = 0; k < 3; k++) {
      out.writeFloatLE(pts[k][0], off + 12 + k * 12);
      out.writeFloatLE(pts[k][1], off + 16 + k * 12);
      out.writeFloatLE(pts[k][2], off + 20 + k * 12);
    }
  }
  return out;
}

/** Single-quoted AP214 STEP assembly DAG with 2^levels leaf triangles. */
function makeStepAssemblyDag(levels: number): Buffer {
  const lines: string[] = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('STEP assembly DAG'),'2;1');",
    "FILE_NAME('dag.step','2026-11-24T00:00:00',('EasyConvert'),('EasyConvert'),'OCCT','OCCT','');",
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    'ENDSEC;',
    'DATA;',
    "#1 = APPLICATION_CONTEXT('automotive design');",
    "#2 = APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#1);",
    "#3 = PRODUCT_CONTEXT('',#1,'mechanical');",
    "#4 = PRODUCT_DEFINITION_CONTEXT('part definition',#1,'design');",
    '#5 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );',
    '#6 = ( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) );',
    '#7 = ( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() );',
    "#8 = UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#5,'distance_accuracy_value','confusion accuracy');",
    "#9 = ( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#8)) GLOBAL_UNIT_ASSIGNED_CONTEXT((#5,#6,#7)) REPRESENTATION_CONTEXT('','') );",
    "#10 = CARTESIAN_POINT('',(0.,0.,0.));",
    "#11 = DIRECTION('',(0.,0.,1.));",
    "#12 = DIRECTION('',(1.,0.,0.));",
    "#13 = AXIS2_PLACEMENT_3D('',#10,#11,#12);",
  ];
  let nextId = 20;
  const add = (entity: string): number => {
    const id = nextId++;
    lines.push(`#${id} = ${entity};`);
    return id;
  };
  const p0 = add("CARTESIAN_POINT('',(0.,0.,0.))");
  const p1 = add("CARTESIAN_POINT('',(10.,0.,0.))");
  const p2 = add("CARTESIAN_POINT('',(0.,10.,0.))");
  const vp0 = add(`VERTEX_POINT('',#${p0})`);
  const vp1 = add(`VERTEX_POINT('',#${p1})`);
  const vp2 = add(`VERTEX_POINT('',#${p2})`);
  const dx = add("DIRECTION('',(1.,0.,0.))");
  const dy = add("DIRECTION('',(0.,1.,0.))");
  const dDiag = add("DIRECTION('',(-0.707106781187,0.707106781187,0.))");
  const v0 = add(`VECTOR('',#${dx},1.)`);
  const v1 = add(`VECTOR('',#${dDiag},1.)`);
  const v2 = add(`VECTOR('',#${dy},1.)`);
  const l0 = add(`LINE('',#${p0},#${v0})`);
  const l1 = add(`LINE('',#${p1},#${v1})`);
  const l2 = add(`LINE('',#${p2},#${v2})`);
  const ec0 = add(`EDGE_CURVE('',#${vp0},#${vp1},#${l0},.T.)`);
  const ec1 = add(`EDGE_CURVE('',#${vp1},#${vp2},#${l1},.T.)`);
  const ec2 = add(`EDGE_CURVE('',#${vp2},#${vp0},#${l2},.T.)`);
  const oe0 = add(`ORIENTED_EDGE('',*,*,#${ec0},.T.)`);
  const oe1 = add(`ORIENTED_EDGE('',*,*,#${ec1},.T.)`);
  const oe2 = add(`ORIENTED_EDGE('',*,*,#${ec2},.T.)`);
  const loop = add(`EDGE_LOOP('',(#${oe0},#${oe1},#${oe2}))`);
  const bound = add(`FACE_OUTER_BOUND('',#${loop},.T.)`);
  const plane = add("PLANE('',#13)");
  const face = add(`ADVANCED_FACE('',(#${bound}),#${plane},.T.)`);
  const shell = add(`OPEN_SHELL('',(#${face}))`);
  const surfaceModel = add(`SHELL_BASED_SURFACE_MODEL('',(#${shell}))`);
  const leafSr = add(`SHAPE_REPRESENTATION('',(#13,#${surfaceModel}),#9)`);
  const leafProd = add("PRODUCT('leaf','leaf','',(#3))");
  const leafPdf = add(`PRODUCT_DEFINITION_FORMATION('','',#${leafProd})`);
  const leafPd = add(`PRODUCT_DEFINITION('design','',#${leafPdf},#4)`);
  const leafPds = add(`PRODUCT_DEFINITION_SHAPE('','',#${leafPd})`);
  add(`SHAPE_DEFINITION_REPRESENTATION(#${leafPds},#${leafSr})`);
  add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#${leafProd}))`);

  let prevPd = leafPd;
  let prevSr = leafSr;
  for (let lvl = 1; lvl <= levels; lvl++) {
    const prod = add(`PRODUCT('lvl_${lvl}','lvl_${lvl}','',(#3))`);
    const pdf = add(`PRODUCT_DEFINITION_FORMATION('','',#${prod})`);
    const pd = add(`PRODUCT_DEFINITION('design','',#${pdf},#4)`);
    const pds = add(`PRODUCT_DEFINITION_SHAPE('','',#${pd})`);
    const sr = add('SHAPE_REPRESENTATION(\'\',(#13),#9)');
    add(`SHAPE_DEFINITION_REPRESENTATION(#${pds},#${sr})`);
    add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#${prod}))`);
    for (let branch = 0; branch < 2; branch++) {
      const pt = add(`CARTESIAN_POINT('',(${branch === 0 ? 0 : 12},0.,${lvl * 2}.))`);
      const ax = add(`AXIS2_PLACEMENT_3D('',#${pt},#11,#12)`);
      const nauo = add(`NEXT_ASSEMBLY_USAGE_OCCURRENCE('u_${lvl}_${branch}','','',#${pd},#${prevPd},$)`);
      const nauoPds = add(`PRODUCT_DEFINITION_SHAPE('','',#${nauo})`);
      const tr = add(`ITEM_DEFINED_TRANSFORMATION('','',#13,#${ax})`);
      const rr = add(`( REPRESENTATION_RELATIONSHIP('','',#${prevSr},#${sr}) REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#${tr}) SHAPE_REPRESENTATION_RELATIONSHIP() )`);
      add(`CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#${rr},#${nauoPds})`);
    }
    prevPd = pd;
    prevSr = sr;
  }

  lines.push('ENDSEC;', 'END-ISO-10303-21;', '');
  return Buffer.from(lines.join('\n'), 'utf-8');
}

describe('P1-15: CAD assembly limits, unit forwarding, and mesh/CGM bounds', () => {
  describe('OCCT wrapper and IGES preflight bounds', () => {
    it('exports documented OCCT and IGES preflight limits', () => {
      expect(OCCT_MAX_INPUT_BYTES).toBe(256 * 1024 * 1024);
      expect(OCCT_MAX_ASSEMBLY_SHAPES).toBe(100_000);
      expect(OCCT_MAX_EXPANDED_FACES).toBe(500_000);
      expect(OCCT_MAX_OUTPUT_TRIANGLES).toBe(1_000_000);
      expect(MAX_IGES_INPUT_BYTES).toBe(256 * 1024 * 1024);
      expect(MAX_IGES_RECORDS).toBe(4_000_000);
      expect(MAX_STEP_MESH_TRIANGLES).toBe(OCCT_MESH_MAX_TRIANGLES);
      expect(MAX_STEP_MESH_VERTICES).toBe(OCCT_MESH_MAX_VERTICES);
    });

    it('rejects STEP/IGES inputs larger than 256 MiB with PayloadLimitError before running cad-convert', async () => {
      const marker = path.join(makeTempDir('cad-byte-cap-'), 'ran');
      const oversized = Buffer.alloc(OCCT_MAX_INPUT_BYTES + 1, 0x20);
      await withCadProgram(makeStandInProgram(`touch ${marker}`), async () => {
        await expect(convertCadWithOcct(oversized, 'step', 'stl')).rejects.toMatchObject({
          name: 'PayloadLimitError',
          status: 413,
        });
        expect(() => prepareIgesForKernel(oversized)).toThrow(PayloadLimitError);
      });
      expect(fs.existsSync(marker)).toBe(false);
    });

    it('maps cad-convert expansion refusal to CadExpansionLimitError (HTTP 422, input_over_limit)', async () => {
      const program = makeStandInProgram(
        'echo "cad-convert: error: expansion: the assembly expands to more than 100000 shape instances" >&2; exit 5'
      );
      await withCadProgram(program, async () => {
        const failure = await convertCadWithOcct(Buffer.from('ISO-10303-21;\nEND-ISO-10303-21;\n'), 'step', 'stl').catch(
          (err: unknown) => err
        );
        expect(failure).toBeInstanceOf(CadExpansionLimitError);
        expect(typedFailureOf(failure)).toEqual({ status: 422, code: 'input_over_limit' });
        expect(isTypedRefusal(failure)).toBe(true);
        expect((failure as Error).message).toContain('100000 shape instances');
      });
    });

    it('forwards options.outputUnit on convertMeshToIgesWithOcct and STL/OBJ -> IGES', async () => {
      const dir = makeTempDir('cad-mesh-unit-');
      const recordedPath = path.join(dir, 'args.txt');
      const program = makeStandInProgram(
        `printf '%s %s %s %s %s %s' "$1" "$2" "$3" "$4" "$5" "$6" > ${recordedPath}\nprintf 'S      1\\n' > "$8"`
      );
      const mesh = { vertices: [[0, 0, 0], [10, 0, 0], [0, 10, 0]], faces: [[0, 1, 2]] } as const;

      await withCadProgram(program, async () => {
        for (const unit of ['mm', 'cm', 'm', 'in'] as const) {
          await convertMeshToIgesWithOcct(mesh, { outputUnit: unit });
          expect(fs.readFileSync(recordedPath, 'utf-8')).toBe(`--from mesh --to iges --unit ${unit}`);
        }
        await convertVectorCad(cubeObjBuffer(10), 'obj', 'iges', { outputUnit: 'in' }, 'cube.obj');
        expect(fs.readFileSync(recordedPath, 'utf-8')).toBe('--from mesh --to iges --unit in');

        await convertVectorCad(cubeBinaryStlBuffer(10), 'stl', 'iges', { outputUnit: 'cm' }, 'cube.stl');
        expect(fs.readFileSync(recordedPath, 'utf-8')).toBe('--from mesh --to iges --unit cm');

        const badUnit = await convertMeshToIgesWithOcct(mesh, { outputUnit: 'yard' as never }).catch((e: unknown) => e);
        expect(badUnit).toBeInstanceOf(UnprocessableCadInputError);
        expect((badUnit as UnprocessableCadInputError).status).toBe(422);
      });
    });
  });

  describe('Pure edge CAD encoders (pure-cad.ts)', () => {
    it('exports MAX_PURE_CAD_VERTICES = 3,000,000 and MAX_PURE_CAD_TRIANGLES = 1,000,000', () => {
      expect(MAX_PURE_CAD_VERTICES).toBe(3_000_000);
      expect(MAX_PURE_CAD_TRIANGLES).toBe(1_000_000);
    });

    it('rejects meshes exceeding MAX_PURE_CAD_VERTICES across encodeStl, encodeBinaryStl, and encodeObj', () => {
      const pt: [number, number, number] = [0, 0, 0];
      const vertices = new Array<[number, number, number]>(MAX_PURE_CAD_VERTICES + 1).fill(pt);
      const mesh: TessellatedMesh = { name: 'over_verts', vertices, normals: [], faces: [[0, 0, 0]] };
      for (const encode of [pureEncodeStl, encodeBinaryStl, pureEncodeObj]) {
        expect(() => encode(mesh)).toThrow(EdgeUnsupportedError);
      }
    });

    it('rejects meshes exceeding MAX_PURE_CAD_TRIANGLES by face count or polygon fan expansion', () => {
      const tri: [number, number, number] = [0, 1, 2];
      const tooManyFaces: TessellatedMesh = {
        name: 'over_tris',
        vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
        normals: [],
        faces: new Array<[number, number, number]>(MAX_PURE_CAD_TRIANGLES + 1).fill(tri),
      };
      const hugeFanFace = {
        name: 'over_fan',
        vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
        normals: [],
        faces: [new Array<number>(MAX_PURE_CAD_TRIANGLES + 3).fill(0)],
      } as unknown as TessellatedMesh;

      for (const encode of [pureEncodeStl, encodeBinaryStl, pureEncodeObj]) {
        expect(() => encode(tooManyFaces)).toThrow(EdgeUnsupportedError);
        expect(() => encode(hugeFanFace)).toThrow(EdgeUnsupportedError);
      }
    });
  });

  describe('STL, OBJ, and STEP parser/encoder bounds and unit scaling', () => {
    it('exports tightened mesh parser bounds', () => {
      expect(MAX_MESH_TRIANGLES).toBe(1_000_000);
      expect(MAX_MESH_VERTICES).toBe(3_000_000);
      expect(MAX_TEXT_MESH_BYTES).toBe(256 * 1024 * 1024);
      expect(MAX_OBJ_LINES).toBe(10_000_000);
      expect(MAX_OBJ_FACE_CORNERS).toBe(256);
      expect(MAX_ASCII_STL_WORDS).toBe(25_000_000);
    });

    it('distinguishes ASCII STL from binary STL starting with "solid" in the first 512 bytes', () => {
      const asciiStl = Buffer.from(
        'solid big_name_here\n' +
          '  facet normal 0 0 1\n' +
          '    outer loop\n' +
          '      vertex 0 0 0\n' +
          '      vertex 10 0 0\n' +
          '      vertex 0 10 0\n' +
          '    endloop\n' +
          '  endfacet\n' +
          'endsolid big_name_here\n',
        'utf-8'
      );
      const parsedAscii = parse3dCad(asciiStl, 'stl', 'ascii');
      expect(parsedAscii.faces).toHaveLength(1);
      expect(parsedAscii.vertices[1]).toEqual([10, 0, 0]);

      const binarySolidHeader = cubeBinaryStlBuffer(10, 'solid binary header without facet');
      const parsedBinary = parse3dCad(binarySolidHeader, 'stl', 'bin');
      expect(parsedBinary.faces).toHaveLength(12);
    });

    it('rejects oversized, truncated, and non-finite binary STL files', () => {
      const overCountHeader = Buffer.alloc(84);
      overCountHeader.write('Binary STL header', 0, 'ascii');
      overCountHeader.writeUInt32LE(MAX_MESH_TRIANGLES + 1, 80);
      expect(() => parse3dCad(overCountHeader, 'stl', 'over')).toThrow(PayloadLimitError);

      const truncatedBinary = cubeBinaryStlBuffer(10).subarray(0, 84 + 50);
      expect(() => parse3dCad(truncatedBinary, 'stl', 'trunc')).toThrow(CadGeometryUnavailableError);

      const nanVertexStl = cubeBinaryStlBuffer(10);
      nanVertexStl.writeFloatLE(Number.NaN, 84 + 12);
      expect(() => parse3dCad(nanVertexStl, 'stl', 'nan')).toThrow(UnprocessableCadInputError);

      const badNormalStl = cubeBinaryStlBuffer(10);
      badNormalStl.writeFloatLE(Number.POSITIVE_INFINITY, 84);
      badNormalStl.writeFloatLE(Number.NaN, 88);
      const sanitized = parse3dCad(badNormalStl, 'stl', 'badnorm');
      expect(sanitized.normals[0]).toEqual([0, 0, -1]);
    });

    it('rejects text meshes over MAX_TEXT_MESH_BYTES and ASCII STLs over MAX_ASCII_STL_WORDS or 2e100', () => {
      const hugeText = Buffer.alloc(MAX_TEXT_MESH_BYTES + 1, 0x20);
      hugeText.write('solid ', 0, 'ascii');
      expect(() => parse3dCad(hugeText, 'stl', 'huge')).toThrow(PayloadLimitError);

      const tooManyWords = Buffer.from(`solid w\n${'x '.repeat(MAX_ASCII_STL_WORDS + 1)}`, 'ascii');
      expect(() => parse3dCad(tooManyWords, 'stl', 'words')).toThrow(PayloadLimitError);

      const overCoordStl = Buffer.from(
        'solid c\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 2.5e100 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid c\n',
        'utf-8'
      );
      expect(() => parse3dCad(overCoordStl, 'stl', 'hugecoord')).toThrow(UnprocessableCadInputError);
    });

    it('enforces OBJ line count, finite coordinates, negative relative indices, corner cap, and fan triangulation limits', () => {
      const tooManyLines = Buffer.from('\n'.repeat(MAX_OBJ_LINES + 1), 'ascii');
      expect(() => parse3dCad(tooManyLines, 'obj', 'lines')).toThrow(PayloadLimitError);

      for (const badCoord of ['NaN', 'Infinity', '2.5e100', 'abc']) {
        const obj = Buffer.from(`# comment\n\nv 0 0 0\nv ${badCoord} 0 0\nv 0 1 0\nf 1 2 3\n`, 'utf-8');
        expect(() => parse3dCad(obj, 'obj', 'badcoord'), badCoord).toThrow(UnprocessableCadInputError);
      }

      const relativeObj = Buffer.from('v 0 0 0\nv 10 0 0\nv 10 10 0\nv 0 10 0\nf -4 -3 -2 -1\n', 'utf-8');
      const parsedRelative = parse3dCad(relativeObj, 'obj', 'rel');
      expect(parsedRelative.faces).toEqual([
        [0, 1, 2],
        [0, 2, 3],
      ]);

      for (const badFace of ['f 0 1 2', 'f 4 1 2', 'f -4 1 2', 'f 1.5 2 3', 'f a 2 3']) {
        const obj = Buffer.from(`v 0 0 0\nv 1 0 0\nv 0 1 0\n${badFace}\n`, 'utf-8');
        expect(() => parse3dCad(obj, 'obj', 'badface'), badFace).toThrow(UnprocessableCadInputError);
      }

      const maxCornersFace = `f ${Array.from({ length: MAX_OBJ_FACE_CORNERS }, (_, i) => (i % 3) + 1).join(' ')}`;
      const parsed256 = parse3dCad(Buffer.from(`v 0 0 0\nv 1 0 0\nv 0 1 0\n${maxCornersFace}\n`, 'utf-8'), 'obj', 'fan');
      expect(parsed256.faces).toHaveLength(MAX_OBJ_FACE_CORNERS - 2);

      const tooManyCorners = `f ${Array.from({ length: MAX_OBJ_FACE_CORNERS + 1 }, (_, i) => (i % 3) + 1).join(' ')}`;
      expect(() =>
        parse3dCad(Buffer.from(`v 0 0 0\nv 1 0 0\nv 0 1 0\n${tooManyCorners}\n`, 'utf-8'), 'obj', 'overfan')
      ).toThrow(UnprocessableCadInputError);

      const fanBudgetOverflow = Buffer.from(
        `v 0 0 0\nv 1 0 0\nv 0 1 0\n${`${maxCornersFace}\n`.repeat(3938)}`,
        'utf-8'
      );
      expect(() => parse3dCad(fanBudgetOverflow, 'obj', 'fanbudget')).toThrow(PayloadLimitError);
    });

    it('emits exact ISO 10303-21 units and scales coordinates in encodeStep + convertVectorCad, verified by occt-import-js', async () => {
      const cube = makeCubeMesh(10);
      const expectedUnits = [
        { unit: 'mm', unitMarker: 'SI_UNIT(.MILLI., .METRE.)', uncertainty: '1.E-07', scaledCoord: '10.0', vertexStartId: 20 },
        { unit: 'cm', unitMarker: 'SI_UNIT(.CENTI., .METRE.)', uncertainty: '1.E-08', scaledCoord: '1.0', vertexStartId: 20 },
        { unit: 'm', unitMarker: 'SI_UNIT($, .METRE.)', uncertainty: '1.E-10', scaledCoord: '0.01', vertexStartId: 20 },
        { unit: 'in', unitMarker: "CONVERSION_BASED_UNIT('INCH', #21)", uncertainty: '3.937007874016E-09', scaledCoord: '0.393700787', vertexStartId: 23 },
      ] as const;

      for (const spec of expectedUnits) {
        const step = encodeStep(cube, spec.unit);
        expect(step, spec.unit).toContain(spec.unitMarker);
        expect(step, spec.unit).toContain(`LENGTH_MEASURE(${spec.uncertainty})`);
        expect(step, spec.unit).toContain(`#${spec.vertexStartId} = CARTESIAN_POINT('', (0.0, 0.0, 0.0));`);
        expect(step, spec.unit).toContain(`CARTESIAN_POINT('', (${spec.scaledCoord}, ${spec.scaledCoord}, ${spec.scaledCoord}));`);
        if (spec.unit === 'in') {
          expect(step).toContain('#20 = DIMENSIONAL_EXPONENTS(1., 0., 0., 0., 0., 0., 0.);');
          expect(step).toContain('#21 = LENGTH_MEASURE_WITH_UNIT(25.4, #22);');
          expect(step).toContain('#22 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI., .METRE.) );');
        }

        const fromStep = await oracleFacts(Buffer.from(step, 'utf-8'), 'step');
        expect(fromStep.area, `${spec.unit} encodeStep area`).toBeCloseTo(600, 2);
        for (let axis = 0; axis < 3; axis++) {
          expect(fromStep.min[axis], `${spec.unit} min[${axis}]`).toBeCloseTo(0, 4);
          expect(fromStep.max[axis], `${spec.unit} max[${axis}]`).toBeCloseTo(10, 4);
        }

        const fromObj = await convertVectorCad(cubeObjBuffer(10), 'obj', 'step', { outputUnit: spec.unit }, 'cube.obj');
        const objFacts = await oracleFacts(fromObj.buffer, 'step');
        expect(objFacts.area, `${spec.unit} obj->step area`).toBeCloseTo(600, 2);
        expect(objFacts.max[0], `${spec.unit} obj->step max[0]`).toBeCloseTo(10, 4);

        const fromStl = await convertVectorCad(cubeBinaryStlBuffer(10), 'stl', 'step', { outputUnit: spec.unit }, 'cube.stl');
        const stlFacts = await oracleFacts(fromStl.buffer, 'step');
        expect(stlFacts.area, `${spec.unit} stl->step area`).toBeCloseTo(600, 2);
        expect(stlFacts.max[0], `${spec.unit} stl->step max[0]`).toBeCloseTo(10, 4);
      }
    });

    it('enforces STEP encoder bounds, rejects bad units/indices/coords, and formats large coordinates cleanly', () => {
      expect(() => encodeStep({ name: 'empty', vertices: [], faces: [], normals: [] })).toThrow(CadGeometryUnavailableError);
      expect(() => encodeStep(makeCubeMesh(10), 'furlong')).toThrow(UnprocessableCadInputError);

      const overTriangles: CadMesh3D = {
        name: 'over_tris',
        vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
        faces: new Array<[number, number, number]>(MAX_STEP_MESH_TRIANGLES + 1).fill([0, 1, 2]),
        normals: [],
      };
      expect(() => encodeStep(overTriangles)).toThrow(UnprocessableCadInputError);

      const overVertices: CadMesh3D = {
        name: 'over_verts',
        vertices: new Array<[number, number, number]>(MAX_STEP_MESH_VERTICES + 1).fill([0, 0, 0]),
        faces: [[0, 1, 2]],
        normals: [],
      };
      expect(() => encodeStep(overVertices)).toThrow(UnprocessableCadInputError);

      expect(() =>
        encodeStep({ name: 'bad_idx', vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces: [[0, 1, 9]], normals: [] })
      ).toThrow(UnprocessableCadInputError);

      expect(() =>
        encodeStep({ name: 'huge_coord', vertices: [[0, 0, 0], [2.5e100, 0, 0], [0, 1, 0]], faces: [[0, 1, 2]], normals: [] })
      ).toThrow(UnprocessableCadInputError);

      const largeValid = encodeStep({
        name: 'large_valid',
        vertices: [[0, 0, 0], [1e30, 0, 0], [0, 1e30, 0]],
        faces: [[0, 1, 2]],
        normals: [],
      });
      expect(largeValid).toContain('1.0E+30');
      expect(largeValid).not.toContain('1e+30.0');

      expect(() =>
        encode3dCadToDxf({ name: 'nan_dxf_face', vertices: [[0, 0, 0], [Number.NaN, 0, 0], [0, 1, 0]], faces: [[0, 1, 2]], normals: [] })
      ).toThrow(UnprocessableCadInputError);
      expect(() =>
        encode3dCadToDxf({ name: 'huge_dxf_face', vertices: [[0, 0, 0], [2.5e100, 0, 0], [0, 1, 0]], faces: [[0, 1, 2]], normals: [] })
      ).toThrow(UnprocessableCadInputError);
      expect(() =>
        encode3dCadToDxf({ name: 'nan_dxf_point', vertices: [[Number.NaN, 0, 0]], faces: [], normals: [] })
      ).toThrow(UnprocessableCadInputError);
      expect(() =>
        encode3dCadToDxf({ name: 'huge_dxf_point', vertices: [[2.5e100, 0, 0]], faces: [], normals: [] })
      ).toThrow(UnprocessableCadInputError);
    });
  });

  describe('Clear-text CGM bounds (parseCgmToSvg)', () => {
    it('exports CGM bounds and parses finite signed floats in VDCEXT', () => {
      expect(MAX_CGM_VDC_EXTENT).toBe(1_000_000);
      expect(MAX_CGM_ELEMENTS).toBe(100_000);
      expect(MAX_CGM_POINTS).toBe(500_000);
      expect(MAX_CGM_TEXT_CHARS).toBe(1_000_000);

      const svg = parseCgmToSvg('BEGMF "signed";\nVDCEXT (-100,-50.5) (100,49.5);\nLINE (0,0) (10,10);\nENDMF;\n');
      expect(svg).toContain('viewBox="0 0 200 100"');

      const sciSvg = parseCgmToSvg('BEGMF "sci";\nVDCEXT (-1e2,0) (1e2,5e1);\nLINE (0,0) (10,10);\nENDMF;\n');
      expect(sciSvg).toContain('viewBox="0 0 200 50"');
    });

    it('rejects oversized VDCEXT with PayloadLimitError and non-finite/missing/empty VDCEXT with ConversionFailedError', () => {
      expect(() => parseCgmToSvg('BEGMF "x";\nLINE (0,0) (10,10);\nENDMF;\n')).toThrow(ConversionFailedError);
      expect(() => parseCgmToSvg('BEGMF "x";\nVDCEXT (5,0) (5,200);\nENDMF;\n')).toThrow(ConversionFailedError);
      expect(() => parseCgmToSvg('BEGMF "x";\nVDCEXT (0,0) (1e400,200);\nENDMF;\n')).toThrow(ConversionFailedError);
      expect(() => parseCgmToSvg('BEGMF "x";\nVDCEXT (0,0) (1000001,200);\nENDMF;\n')).toThrow(PayloadLimitError);
    });

    it('enforces shared element, point, and text character budgets across LINE, TEXT, POLYLINE, and POLYGON', () => {
      const tooManyLines = `BEGMF "x";\nVDCEXT (0,0) (100,100);\n${'LINE (0,0) (1,1);\n'.repeat(MAX_CGM_ELEMENTS + 1)}ENDMF;`;
      expect(() => parseCgmToSvg(tooManyLines)).toThrow(PayloadLimitError);

      const tooManyMixedElements = `BEGMF "x";\nVDCEXT (0,0) (100,100);\n${'LINE (0,0) (1,1);\n'.repeat(50_000)}${'TEXT (1,1) "a";\n'.repeat(50_001)}ENDMF;`;
      expect(() => parseCgmToSvg(tooManyMixedElements)).toThrow(PayloadLimitError);

      const pointChunk = `POLYLINE ${'(1,2) '.repeat(1000)};\n`;
      const tooManyPoints = `BEGMF "x";\nVDCEXT (0,0) (100,100);\n${pointChunk.repeat(501)}ENDMF;`;
      expect(() => parseCgmToSvg(tooManyPoints)).toThrow(PayloadLimitError);

      const textChunk = `TEXT (1,1) "${'A'.repeat(10_000)}";\n`;
      const tooManyTextChars = `BEGMF "x";\nVDCEXT (0,0) (100,100);\n${textChunk.repeat(101)}ENDMF;`;
      expect(() => parseCgmToSvg(tooManyTextChars)).toThrow(PayloadLimitError);
    });
  });

  describe.skipIf(!haveCadOracles)('Real OpenCASCADE assembly bounds and STL/OBJ unit conversions', () => {
    it('rejects a 20-level single-quoted STEP assembly DAG bomb with CadExpansionLimitError', { timeout: 60_000 }, async () => {
      const bomb = makeStepAssemblyDag(20);
      for (const target of ['stl', 'obj', 'step', 'iges'] as const) {
        const failure = await convertVectorCad(bomb, 'step', target, {}, 'dag20.step').catch((err: unknown) => err);
        expect(failure, target).toBeInstanceOf(CadExpansionLimitError);
        expect(typedFailureOf(failure), target).toEqual({ status: 422, code: 'input_over_limit' });
      }
    });

    it('converts a bounded 4-level STEP assembly DAG into 16 triangles', { timeout: 60_000 }, async () => {
      const dag4 = makeStepAssemblyDag(4);
      const stl = await convertVectorCad(dag4, 'step', 'stl', {}, 'dag4.step');
      const facts = meshFacts(stl.buffer, 'stl');
      expect(facts.triangles).toBe(16);
      expect(facts.area).toBeCloseTo(16 * 50, 2);

      const oracle = await oracleFacts(dag4, 'step');
      expect(oracle.area).toBeCloseTo(facts.area, 2);
    });

    it('writes STL and OBJ to IGES and STEP in mm, cm, m, and in with matching physical scale in oracleFacts and meshFacts', { timeout: 120_000 }, async () => {
      const expectedFlags = { mm: 2, cm: 10, m: 6, in: 1 } as const;
      const sources = [
        { format: 'stl', bytes: cubeBinaryStlBuffer(10), name: 'cube.stl' },
        { format: 'obj', bytes: cubeObjBuffer(10), name: 'cube.obj' },
      ] as const;

      for (const source of sources) {
        for (const unit of ['mm', 'cm', 'm', 'in'] as const) {
          const iges = await convertVectorCad(source.bytes, source.format, 'iges', { outputUnit: unit }, source.name);
          expect(igesLengthUnitFlag(iges.buffer.toString('latin1')), `${source.format}->iges ${unit}`).toBe(expectedFlags[unit]);
          const igesOracle = await oracleFacts(iges.buffer, 'iges');
          expect(igesOracle.area, `${source.format}->iges ${unit} area`).toBeCloseTo(600, 2);
          for (let axis = 0; axis < 3; axis++) {
            expect(igesOracle.min[axis]).toBeCloseTo(0, 4);
            expect(igesOracle.max[axis]).toBeCloseTo(10, 4);
          }
          const igesRoundTrip = await convertVectorCad(iges.buffer, 'iges', 'stl', {}, 'roundtrip.iges');
          const igesMesh = meshFacts(igesRoundTrip.buffer, 'stl');
          expect(igesMesh.triangles).toBe(12);
          expect(igesMesh.area).toBeCloseTo(600, 2);

          const step = await convertVectorCad(source.bytes, source.format, 'step', { outputUnit: unit }, source.name);
          const stepOracle = await oracleFacts(step.buffer, 'step');
          expect(stepOracle.area, `${source.format}->step ${unit} area`).toBeCloseTo(600, 2);
          const stepRoundTrip = await convertVectorCad(step.buffer, 'step', 'stl', {}, 'roundtrip.step');
          const stepMesh = meshFacts(stepRoundTrip.buffer, 'stl');
          expect(stepMesh.triangles).toBe(12);
          expect(stepMesh.area).toBeCloseTo(600, 2);
        }
      }
    });
  });
});
