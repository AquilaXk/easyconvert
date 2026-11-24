import {
  CadGeometryUnavailableError,
  PayloadLimitError,
  UnprocessableCadInputError,
} from '../types';
import { verifyWatertightManifoldMesh } from './cad-nurbs';
import { OCCT_MESH_MAX_TRIANGLES, OCCT_MESH_MAX_VERTICES } from './cad-occt';

export interface CadMesh3D {
  name: string;
  vertices: [number, number, number][];
  faces: [number, number, number][];
  normals: [number, number, number][];
}

/** Most triangles of a mesh read here: what a binary STL may hold, applied to an ASCII STL and to the faces of an OBJ as well. */
export const MAX_MESH_TRIANGLES = 1_000_000;
/** Most vertices (and normals) of a mesh read here: the three corners of every triangle at the limit. */
export const MAX_MESH_VERTICES = 3 * MAX_MESH_TRIANGLES;
export const MAX_TEXT_MESH_BYTES = 256 * 1024 * 1024;
export const MAX_OBJ_LINES = 10_000_000;
export const MAX_OBJ_FACE_CORNERS = 256;
export const MAX_ASCII_STL_WORDS = 25_000_000;
export const MAX_STEP_MESH_TRIANGLES = OCCT_MESH_MAX_TRIANGLES;
export const MAX_STEP_MESH_VERTICES = OCCT_MESH_MAX_VERTICES;

const MAX_MESH_COORDINATE = 2e100;
const BINARY_STL_HEADER_BYTES = 84;
const BINARY_STL_FACET_BYTES = 50;
const STL_SNIFF_BYTES = 512;
const ASCII_STL_FACET_HEAD = /\bfacet\s+normal\b/i;
const INTEGER_TOKEN = /^[+-]?\d+$/;

function meshTooLarge(what: string, limit: number): PayloadLimitError {
  return new PayloadLimitError(`The 3D mesh holds more than ${limit} ${what}, the most that is read.`);
}

function isFiniteCoord(value: number): boolean {
  return Math.abs(value) <= MAX_MESH_COORDINATE;
}

function safeNormalValue(value: number): number {
  return isFiniteCoord(value) ? value : 0;
}

/** Reads the blank-separated words of a text one at a time, with no copy of the text and no array of the words. */
class StlWords {
  private pos = 0;
  private start = 0;
  private wordCount = 0;

  constructor(private readonly text: string) {}

  /** Moves to the next word; false at the end of the text. */
  next(): boolean {
    const { text } = this;
    while (this.pos < text.length && text.charCodeAt(this.pos) <= 32) this.pos++;
    if (this.pos >= text.length) return false;
    if (++this.wordCount > MAX_ASCII_STL_WORDS) {
      throw meshTooLarge('words', MAX_ASCII_STL_WORDS);
    }
    this.start = this.pos;
    while (this.pos < text.length && text.charCodeAt(this.pos) > 32) this.pos++;
    return true;
  }

  mark(): number {
    return this.pos;
  }

  reset(mark: number): void {
    this.pos = mark;
  }

  /** Whether the current word is `keyword`. */
  is(keyword: string): boolean {
    return this.pos - this.start === keyword.length && this.text.startsWith(keyword, this.start);
  }

  /** The number that the next word spells (digits, `.`, `e`, `E`, `+`, `-`), or null, in which case that word is left unread. */
  number(): number | null {
    const before = this.pos;
    if (!this.next()) return null;
    for (let i = this.start; i < this.pos; i++) {
      const code = this.text.charCodeAt(i);
      const spelled = (code >= 48 && code <= 57) || code === 46 || code === 101 || code === 69 || code === 43 || code === 45;
      if (!spelled) {
        this.pos = before;
        return null;
      }
    }
    const value = Number(this.text.slice(this.start, this.pos));
    if (Number.isNaN(value)) {
      this.pos = before;
      return null;
    }
    return value;
  }

  /** Three numbers in a row, or null with the words read on from the first that is not a number. */
  triple(): [number, number, number] | null {
    const x = this.number();
    const y = x === null ? null : this.number();
    const z = y === null ? null : this.number();
    return z === null ? null : [x as number, y as number, z];
  }
}

/**
 * The facets of an ASCII STL, or null when it has none: `facet normal n n n`, then the next three `vertex x y z` lines
 * wherever they stand, read in one pass over the words.
 */
function parseAsciiStl(text: string, name: string): CadMesh3D | null {
  const vertices: [number, number, number][] = [];
  const faces: [number, number, number][] = [];
  const normals: [number, number, number][] = [];
  const words = new StlWords(text);
  let normal: [number, number, number] | null = null;
  let corners = 0;
  while (words.next()) {
    if (normal === null) {
      if (!words.is('facet')) continue;
      const afterFacet = words.mark();
      if (!words.next() || !words.is('normal')) {
        // The word after `facet` may start the next facet, so it is read again.
        words.reset(afterFacet);
        continue;
      }
      const rawNormal = words.triple();
      normal = rawNormal === null ? null : [safeNormalValue(rawNormal[0]), safeNormalValue(rawNormal[1]), safeNormalValue(rawNormal[2])];
    } else if (words.is('vertex')) {
      const corner = words.triple();
      if (corner === null) {
        if (words.next()) {
          throw new UnprocessableCadInputError('The ASCII STL holds a vertex coordinate that is not a finite number.');
        }
        break;
      }
      if (!isFiniteCoord(corner[0]) || !isFiniteCoord(corner[1]) || !isFiniteCoord(corner[2])) {
        throw new UnprocessableCadInputError('The ASCII STL holds a vertex coordinate that is not a finite number or exceeds 2e100.');
      }
      vertices.push(corner);
      if (++corners < 3) continue;
      if (faces.length >= MAX_MESH_TRIANGLES) throw meshTooLarge('triangles', MAX_MESH_TRIANGLES);
      normals.push(normal);
      const vStart = vertices.length - 3;
      faces.push([vStart, vStart + 1, vStart + 2]);
      normal = null;
      corners = 0;
    }
  }
  vertices.length = faces.length * 3;
  return vertices.length > 0 ? { name, vertices, faces, normals } : null;
}

function resolveObjFaceCorner(token: string, vertexCount: number): number {
  const slashAt = token.indexOf('/');
  const rawToken = slashAt === -1 ? token : token.slice(0, slashAt);
  if (!INTEGER_TOKEN.test(rawToken)) {
    throw new UnprocessableCadInputError('The OBJ face contains an invalid vertex index.');
  }
  const raw = Number(rawToken);
  let resolved = -1;
  if (raw > 0) resolved = raw - 1;
  else if (raw < 0) resolved = vertexCount + raw;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved >= vertexCount) {
    throw new UnprocessableCadInputError('The OBJ face references a vertex index that does not exist.');
  }
  return resolved;
}

function appendObjFace(parts: readonly string[], vertexCount: number, faces: [number, number, number][]): void {
  const cornerCount = parts.length - 1;
  if (cornerCount > MAX_OBJ_FACE_CORNERS) {
    throw new UnprocessableCadInputError(`The OBJ face has ${cornerCount} corners; at most ${MAX_OBJ_FACE_CORNERS} are supported.`);
  }
  const triangleDelta = cornerCount - 2;
  if (faces.length + triangleDelta > MAX_MESH_TRIANGLES) {
    throw meshTooLarge('faces', MAX_MESH_TRIANGLES);
  }
  const corners = new Array<number>(cornerCount);
  for (let i = 0; i < cornerCount; i++) {
    corners[i] = resolveObjFaceCorner(parts[i + 1], vertexCount);
  }
  const root = corners[0];
  for (let i = 1; i < cornerCount - 1; i++) {
    faces.push([root, corners[i], corners[i + 1]]);
  }
}

function parseObjVertex(parts: readonly string[]): [number, number, number] {
  const x = Number(parts[1]);
  const y = Number(parts[2]);
  const z = Number(parts[3]);
  if (!isFiniteCoord(x) || !isFiniteCoord(y) || !isFiniteCoord(z)) {
    throw new UnprocessableCadInputError('The OBJ holds a vertex coordinate that is not a finite number or exceeds 2e100.');
  }
  return [x, y, z];
}

/** The vertices, normals and faces of an OBJ, or null when it has no vertex. */
function parseObj(text: string, name: string): CadMesh3D | null {
  const vertices: [number, number, number][] = [];
  const faces: [number, number, number][] = [];
  const normals: [number, number, number][] = [];
  let lineCount = 0;
  for (let lineStart = 0; lineStart < text.length; ) {
    if (++lineCount > MAX_OBJ_LINES) throw meshTooLarge('lines', MAX_OBJ_LINES);
    const lineEnd = text.indexOf('\n', lineStart);
    const rawLine = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
    lineStart = lineEnd === -1 ? text.length : lineEnd + 1;
    let scan = 0;
    while (scan < rawLine.length && rawLine.charCodeAt(scan) <= 32) scan++;
    if (scan >= rawLine.length || rawLine.charCodeAt(scan) === 35) continue;
    const parts = rawLine.slice(scan).trim().split(/\s+/);
    if (parts[0] === 'v' && parts.length >= 4) {
      if (vertices.length >= MAX_MESH_VERTICES) throw meshTooLarge('vertices', MAX_MESH_VERTICES);
      vertices.push(parseObjVertex(parts));
    } else if (parts[0] === 'vn' && parts.length >= 4) {
      if (normals.length >= MAX_MESH_VERTICES) throw meshTooLarge('normals', MAX_MESH_VERTICES);
      normals.push([safeNormalValue(Number(parts[1])), safeNormalValue(Number(parts[2])), safeNormalValue(Number(parts[3]))]);
    } else if (parts[0] === 'f' && parts.length >= 4) {
      appendObjFace(parts, vertices.length, faces);
    }
  }
  return vertices.length > 0 ? { name, vertices, faces, normals } : null;
}

function readBinaryStlMesh(buffer: Buffer, numTriangles: number, defaultName: string): CadMesh3D {
  const vertices: [number, number, number][] = new Array(numTriangles * 3);
  const faces: [number, number, number][] = new Array(numTriangles);
  const normals: [number, number, number][] = new Array(numTriangles);
  for (let i = 0; i < numTriangles; i++) {
    const off = BINARY_STL_HEADER_BYTES + i * BINARY_STL_FACET_BYTES;
    normals[i] = [
      safeNormalValue(buffer.readFloatLE(off)),
      safeNormalValue(buffer.readFloatLE(off + 4)),
      safeNormalValue(buffer.readFloatLE(off + 8)),
    ];
    const vBase = i * 3;
    for (let k = 0; k < 3; k++) {
      const pOff = off + 12 + k * 12;
      const x = buffer.readFloatLE(pOff);
      const y = buffer.readFloatLE(pOff + 4);
      const z = buffer.readFloatLE(pOff + 8);
      if (!isFiniteCoord(x) || !isFiniteCoord(y) || !isFiniteCoord(z)) {
        throw new UnprocessableCadInputError('The binary STL holds a vertex coordinate that is not a finite number or exceeds 2e100.');
      }
      vertices[vBase + k] = [x, y, z];
    }
    faces[i] = [vBase, vBase + 1, vBase + 2];
  }
  return { name: defaultName, vertices, faces, normals };
}

/**
 * 3D mesh parser (STL, OBJ). STEP and IGES are read by the Open CASCADE program (cad-occt.ts), not here.
 */
export function parse3dCad(buffer: Buffer, format: string, defaultName: string): CadMesh3D {
  const headerPrefix = buffer.subarray(0, Math.min(6, buffer.length)).toString('ascii').toLowerCase();
  const isHeaderSolid = headerPrefix.startsWith('solid');
  const headWindow = isHeaderSolid ? buffer.subarray(0, Math.min(STL_SNIFF_BYTES, buffer.length)).toString('latin1') : '';
  const looksLikeAsciiStl = isHeaderSolid && ASCII_STL_FACET_HEAD.test(headWindow);

  if (!looksLikeAsciiStl && (format === 'stl' || format === 'stlb' || isHeaderSolid) && buffer.length >= BINARY_STL_HEADER_BYTES) {
    const numTriangles = buffer.readUInt32LE(80);
    const expectedBytes = BINARY_STL_HEADER_BYTES + numTriangles * BINARY_STL_FACET_BYTES;
    if (numTriangles > MAX_MESH_TRIANGLES && (buffer.length === expectedBytes || !isHeaderSolid)) {
      throw meshTooLarge('triangles', MAX_MESH_TRIANGLES);
    }
    if (numTriangles > 0 && buffer.length === expectedBytes) {
      return readBinaryStlMesh(buffer, numTriangles, defaultName);
    }
  }

  if (buffer.length > MAX_TEXT_MESH_BYTES) {
    throw new PayloadLimitError(`The 3D mesh exceeds the ${MAX_TEXT_MESH_BYTES}-byte limit.`);
  }
  const text = buffer.toString('utf-8');

  if (format === 'stl' || format === 'stlb' || text.startsWith('solid')) {
    const mesh = parseAsciiStl(text, defaultName);
    if (mesh) return mesh;
  }

  if (format === 'obj' || text.includes('v ') || text.includes('f ')) {
    const mesh = parseObj(text, defaultName);
    if (mesh) return mesh;
  }

  throw new CadGeometryUnavailableError(
    `Failed to parse 3D CAD geometry from .${format} file. Payload contains no valid vertices or facets.`
  );
}

interface StepUnitSpec {
  readonly perMillimetre: number;
  readonly unitEntity: string;
  readonly uncertainty: string;
  readonly extraEntities: readonly string[];
  readonly firstVertexId: number;
}

const STEP_UNIT_SPECS: Readonly<Record<string, StepUnitSpec>> = {
  mm: {
    perMillimetre: 1,
    unitEntity: '#11 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI., .METRE.) );',
    uncertainty: '1.E-07',
    extraEntities: [],
    firstVertexId: 20,
  },
  cm: {
    perMillimetre: 0.1,
    unitEntity: '#11 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.CENTI., .METRE.) );',
    uncertainty: '1.E-08',
    extraEntities: [],
    firstVertexId: 20,
  },
  m: {
    perMillimetre: 0.001,
    unitEntity: '#11 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT($, .METRE.) );',
    uncertainty: '1.E-10',
    extraEntities: [],
    firstVertexId: 20,
  },
  in: {
    perMillimetre: 1 / 25.4,
    unitEntity: "#11 = ( CONVERSION_BASED_UNIT('INCH', #21) LENGTH_UNIT() NAMED_UNIT(#20) );",
    uncertainty: '3.937007874016E-09',
    extraEntities: [
      '#20 = DIMENSIONAL_EXPONENTS(1., 0., 0., 0., 0., 0., 0.);',
      '#21 = LENGTH_MEASURE_WITH_UNIT(25.4, #22);',
      '#22 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI., .METRE.) );',
    ],
    firstVertexId: 23,
  },
};

function fmtStepReal(n: number): string {
  if (Object.is(n, -0) || Math.abs(n) < 1e-12) return '0.0';
  if (Math.abs(n) >= 1e-6 && Math.abs(n) < 1e15) {
    const s = n.toFixed(9).replace(/\.?0+$/, '');
    return s.includes('.') ? s : `${s}.0`;
  }
  const exp = n.toExponential(11).replace('e', 'E');
  const [mantissa, exponent] = exp.split('E');
  const trimmed = mantissa.includes('.') ? mantissa.replace(/\.?0+$/, '') : mantissa;
  return `${trimmed.includes('.') ? trimmed : `${trimmed}.0`}E${exponent}`;
}

function assertValidStepMesh(mesh: CadMesh3D, outputUnit: string): StepUnitSpec {
  if (!Object.hasOwn(STEP_UNIT_SPECS, outputUnit)) {
    throw new UnprocessableCadInputError(`The output unit '${outputUnit}' is not one of mm, cm, m and in.`);
  }
  if (!mesh || !mesh.vertices || !mesh.faces || mesh.vertices.length === 0 || mesh.faces.length === 0) {
    throw new CadGeometryUnavailableError('Cannot export 3D CAD mesh to STEP: Mesh contains no faces or vertices.');
  }
  if (mesh.faces.length > MAX_STEP_MESH_TRIANGLES) {
    throw new UnprocessableCadInputError(
      `The mesh has ${mesh.faces.length.toLocaleString('en-US')} triangles; the STEP file takes at most ${MAX_STEP_MESH_TRIANGLES.toLocaleString('en-US')}.`
    );
  }
  if (mesh.vertices.length > MAX_STEP_MESH_VERTICES) {
    throw new UnprocessableCadInputError(
      `The mesh lists ${mesh.vertices.length.toLocaleString('en-US')} vertices; the STEP file takes at most ${MAX_STEP_MESH_VERTICES.toLocaleString('en-US')}.`
    );
  }
  for (const vertex of mesh.vertices) {
    if (!vertex.every(isFiniteCoord)) {
      throw new UnprocessableCadInputError("The mesh holds a coordinate that is not a number or is larger than 2e100 mm, the kernel's limit.");
    }
  }
  for (const face of mesh.faces) {
    if (!face.every((index) => Number.isInteger(index) && index >= 0 && index < mesh.vertices.length)) {
      throw new UnprocessableCadInputError('The mesh holds a triangle that names a vertex it does not list.');
    }
  }
  return STEP_UNIT_SPECS[outputUnit];
}

function computeFaceAxes(
  p0: readonly [number, number, number],
  p1: readonly [number, number, number],
  p2: readonly [number, number, number]
): { normal: [number, number, number]; refDir: [number, number, number] } {
  const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
  const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const nLen = Math.hypot(nx, ny, nz);
  if (Number.isFinite(nLen) && nLen > 1e-12) {
    nx /= nLen;
    ny /= nLen;
    nz /= nLen;
  } else {
    nx = 0;
    ny = 0;
    nz = 1;
  }
  let rx = 1, ry = 0, rz = 0;
  if (Math.abs(nx) >= 0.9 && Math.abs(ny) < 0.9) {
    rx = 0;
    ry = 1;
    rz = 0;
  } else if (Math.abs(nx) >= 0.9 && Math.abs(nz) < 0.9) {
    rx = 0;
    ry = 0;
    rz = 1;
  }
  const dot = rx * nx + ry * ny + rz * nz;
  rx -= dot * nx;
  ry -= dot * ny;
  rz -= dot * nz;
  const rLen = Math.hypot(rx, ry, rz) || 1;
  return { normal: [nx, ny, nz], refDir: [rx / rLen, ry / rLen, rz / rLen] };
}

/**
 * Encodes 3D Mesh to ISO 10303-21 STEP AP214 format with genuine B-Rep topology.
 */
export function encodeStep(mesh: CadMesh3D, outputUnit: string = 'mm'): string {
  const unitSpec = assertValidStepMesh(mesh, outputUnit);
  const cleanName = (mesh.name || 'cad_model').replace(/[^a-zA-Z0-9_-]/g, '_');
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, '');
  const isClosed = verifyWatertightManifoldMesh(mesh.vertices, mesh.faces).isWatertight;

  const lines: string[] = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('EasyConvert CAD STEP AP214 B-Rep Model'), '2;1');",
    `FILE_NAME('${cleanName}.step', '${timestamp}', ('EasyConvert Core'), ('EasyConvert Engine'), 'Processor 2.0', 'EasyConvert', 'Authorization');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    'ENDSEC;',
    'DATA;',
    "#1 = APPLICATION_CONTEXT('core data for automotive mechanical design processes');",
    "#2 = APPLICATION_PROTOCOL_DEFINITION('international standard', 'automotive_design', 1994, #1);",
    "#3 = PRODUCT_CONTEXT('', #1, 'mechanical');",
    `#4 = PRODUCT('${cleanName}', '${cleanName}', '', (#3));`,
    "#5 = PRODUCT_DEFINITION_FORMATION('', '', #4);",
    "#6 = PRODUCT_DEFINITION_CONTEXT('part definition', #1, 'design');",
    "#7 = PRODUCT_DEFINITION('design', '', #5, #6);",
    "#8 = PRODUCT_DEFINITION_SHAPE('', '', #7);",
    '#9 = SHAPE_DEFINITION_REPRESENTATION(#8, #10);',
    unitSpec.unitEntity,
    '#12 = ( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($, .RADIAN.) );',
    '#13 = ( NAMED_UNIT(*) SI_UNIT($, .STERADIAN.) SOLID_ANGLE_UNIT() );',
    `#14 = UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(${unitSpec.uncertainty}), #11, 'distance_accuracy_value', 'confusion accuracy');`,
    "#15 = ( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#14)) GLOBAL_UNIT_ASSIGNED_CONTEXT((#11, #12, #13)) REPRESENTATION_CONTEXT('Context #1', '3D Context with UNIT and UNCERTAINTY') );",
    "#16 = CARTESIAN_POINT('ORIGIN', (0.0, 0.0, 0.0));",
    "#17 = DIRECTION('DIR_Z', (0.0, 0.0, 1.0));",
    "#18 = DIRECTION('DIR_X', (1.0, 0.0, 0.0));",
    "#19 = AXIS2_PLACEMENT_3D('AXIS', #16, #17, #18);",
    ...unitSpec.extraEntities,
  ];

  let nextId = unitSpec.firstVertexId;
  const scale = unitSpec.perMillimetre;
  const vertexPointIds: number[] = new Array(mesh.vertices.length);
  for (let i = 0; i < mesh.vertices.length; i++) {
    const v = mesh.vertices[i];
    const pid = nextId++;
    vertexPointIds[i] = pid;
    lines.push(`#${pid} = CARTESIAN_POINT('', (${fmtStepReal(v[0] * scale)}, ${fmtStepReal(v[1] * scale)}, ${fmtStepReal(v[2] * scale)}));`);
  }

  const faceIds: number[] = [];
  for (let f = 0; f < mesh.faces.length; f++) {
    const [v0, v1, v2] = mesh.faces[f];
    const id0 = vertexPointIds[v0];
    const { normal, refDir } = computeFaceAxes(mesh.vertices[v0], mesh.vertices[v1], mesh.vertices[v2]);
    const loopId = nextId++;
    lines.push(`#${loopId} = POLY_LOOP('', (#${id0}, #${vertexPointIds[v1]}, #${vertexPointIds[v2]}));`);
    const boundId = nextId++;
    lines.push(`#${boundId} = FACE_OUTER_BOUND('', #${loopId}, .T.);`);
    const dirNormId = nextId++;
    lines.push(`#${dirNormId} = DIRECTION('', (${fmtStepReal(normal[0])}, ${fmtStepReal(normal[1])}, ${fmtStepReal(normal[2])}));`);
    const dirRefId = nextId++;
    lines.push(`#${dirRefId} = DIRECTION('', (${fmtStepReal(refDir[0])}, ${fmtStepReal(refDir[1])}, ${fmtStepReal(refDir[2])}));`);
    const axisId = nextId++;
    lines.push(`#${axisId} = AXIS2_PLACEMENT_3D('', #${id0}, #${dirNormId}, #${dirRefId});`);
    const planeId = nextId++;
    lines.push(`#${planeId} = PLANE('', #${axisId});`);
    const faceId = nextId++;
    lines.push(`#${faceId} = FACE_SURFACE('', (#${boundId}), #${planeId}, .T.);`);
    faceIds.push(faceId);
  }

  if (isClosed) {
    const shellId = nextId++;
    lines.push(`#${shellId} = CLOSED_SHELL('', (${faceIds.map((id) => `#${id}`).join(', ')}));`);
    const solidId = nextId++;
    lines.push(`#${solidId} = FACETED_BREP('${cleanName}', #${shellId});`);
    lines.push(`#10 = FACETED_BREP_SHAPE_REPRESENTATION('${cleanName}', (#${solidId}, #19), #15);`);
  } else {
    const shellId = nextId++;
    lines.push(`#${shellId} = OPEN_SHELL('', (${faceIds.map((id) => `#${id}`).join(', ')}));`);
    const modelId = nextId++;
    lines.push(`#${modelId} = SHELL_BASED_SURFACE_MODEL('${cleanName}', (#${shellId}));`);
    lines.push(`#10 = SHAPE_REPRESENTATION('${cleanName}', (#${modelId}, #19), #15);`);
  }
  lines.push('ENDSEC;', 'END-ISO-10303-21;', '');
  return lines.join('\n');
}

/**
 * Encodes 3D Mesh to AutoCAD ASCII DXF using standard 3DFACE entities
 */
export function encode3dCadToDxf(mesh: CadMesh3D): string {
  const entities: string[] = [];
  for (const f of mesh.faces) {
    const v1 = mesh.vertices[f[0]];
    const v2 = mesh.vertices[f[1]];
    const v3 = mesh.vertices[f[2]];
    if (!v1 || !v2 || !v3) {
      throw new UnprocessableCadInputError('The mesh holds a triangle that names a vertex it does not list.');
    }
    if (!v1.every(isFiniteCoord) || !v2.every(isFiniteCoord) || !v3.every(isFiniteCoord)) {
      throw new UnprocessableCadInputError("The mesh holds a coordinate that is not a number or is larger than 2e100 mm, the kernel's limit.");
    }
    entities.push(
      `  0\n3DFACE\n  8\n0\n 10\n${v1[0]}\n 20\n${v1[1]}\n 30\n${v1[2]}\n 11\n${v2[0]}\n 21\n${v2[1]}\n 31\n${v2[2]}\n 12\n${v3[0]}\n 22\n${v3[1]}\n 32\n${v3[2]}\n 13\n${v3[0]}\n 23\n${v3[1]}\n 33\n${v3[2]}\n`
    );
  }
  if (entities.length === 0) {
    for (const v of mesh.vertices) {
      if (!v.every(isFiniteCoord)) {
        throw new UnprocessableCadInputError("The mesh holds a coordinate that is not a number or is larger than 2e100 mm, the kernel's limit.");
      }
      entities.push(`  0\nPOINT\n  8\n0\n 10\n${v[0]}\n 20\n${v[1]}\n 30\n${v[2]}\n`);
    }
  }
  if (entities.length === 0) {
    throw new CadGeometryUnavailableError('Cannot export 3D CAD mesh to DXF: Mesh contains no faces or vertices.');
  }
  return `  0\nSECTION\n  2\nHEADER\n  9\n$ACADVER\n  1\nAC1015\n  0\nENDSEC\n  0\nSECTION\n  2\nTABLES\n  0\nENDSEC\n  0\nSECTION\n  2\nENTITIES\n${entities.join('')}  0\nENDSEC\n  0\nEOF\n`;
}
