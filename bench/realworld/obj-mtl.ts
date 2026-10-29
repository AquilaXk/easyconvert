/**
 * Line reader for the OBJ and MTL files that the CAD conversions write, shared by the real-world output check and the tests that read a colour back.
 *
 * Statement grammar: the Wavefront OBJ and MTL specifications (Paul Bourke's file format notes). A line is blank, a `#` comment, or a keyword
 * followed by whitespace-separated fields; vertex, texture and normal indices of a face are 1-based, and a negative index counts back from the last one
 * defined so far. A material set by `usemtl` applies to the faces that follow it, until the next `usemtl`. The MTL colours `Ka`, `Kd` and `Ks` are RGB
 * in 0 to 1, `Tr` is a transparency in 0 to 1 and `Ns` is a specular exponent, never negative.
 *
 * Vocabulary: what the writers in this repository emit, nothing else.
 * - OBJ: `native/cad-convert/cad-convert.cpp` writeObj writes `#`, `mtllib`, `v`, `usemtl` and `f` with plain vertex indices. The Open CASCADE
 *   writer (RWObj_ObjWriterContext.cxx, V7_8_1, lines 118-286) also writes `vn`, `vt`, `g`, a bare `usemtl`, and the `v/vt/vn`, `v//vn` and `v/vt` face forms. The
 *   pure engine (src/lib/edge/pure/pure-cad.ts encodeObj) writes `o`, `vn` and `v//vn`. The union is the vocabulary. A face writes one form for all its corners.
 * - MTL: RWObj_ObjMaterialMap.cxx (V7_8_1, identical in V7_6_3) DefineMaterial, lines 65-151, writes `#`, `newmtl`, `Ka`, `Kd`, `Ks`, `Ns` and `Tr`, and
 *   `map_Kd` for a texture. The converter's archive holds no image, so a `map_Kd` would name a file that is not there, and it is not in the vocabulary.
 */

type Rgb = readonly [number, number, number];
type Statement = { keyword: string; fields: string[] };
type NumberedStatement = Statement & { number: number };
type CornerForm = 'v' | 'v/vt' | 'v//vn' | 'v/vt/vn';
type Resolved = { index: number } | { problem: string };
type IndexKind = 'vertex' | 'texture' | 'normal';

const OBJ_VOCABULARY: ReadonlySet<string> = new Set(['mtllib', 'usemtl', 'o', 'g', 'v', 'vn', 'vt', 'f']);
const MTL_COLOURS: ReadonlySet<string> = new Set(['Ka', 'Kd', 'Ks']);
const MTL_SCALARS: ReadonlySet<string> = new Set(['Ns', 'Tr']);
const INTEGER = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const NEWLINE = 0x0a;
const DEFINED_ITEMS: Readonly<Record<IndexKind, string>> = { vertex: 'vertices', texture: 'texture coordinates', normal: 'normals' };
const NO_MATERIAL = '';

/** The vertices of an OBJ and its faces with the material each takes; the faces hold 0-based vertex indices, negative indices already resolved. */
export class ObjGeometry {
  constructor(
    private readonly coordinates: readonly number[],
    private readonly corners: readonly number[],
    private readonly faceEnds: readonly number[],
    private readonly faceMaterials: readonly number[],
    private readonly materialNames: readonly string[]
  ) {}

  get vertexCount(): number {
    return this.coordinates.length / 3;
  }

  get faceCount(): number {
    return this.faceEnds.length;
  }

  /** Each face with its material (`''` before the first named `usemtl`) and the position of each of its corners. */
  *faces(): Generator<{ material: string; vertices: Rgb[] }> {
    let start = 0;
    for (let face = 0; face < this.faceEnds.length; face++) {
      const vertices: Rgb[] = [];
      for (let corner = start; corner < this.faceEnds[face]; corner++) {
        const at = this.corners[corner] * 3;
        vertices.push([this.coordinates[at], this.coordinates[at + 1], this.coordinates[at + 2]]);
      }
      yield { material: this.materialNames[this.faceMaterials[face]], vertices };
      start = this.faceEnds[face];
    }
  }
}

export type ObjReading<Geometry = null> =
  | {
      ok: true;
      /** The file names of the `mtllib` lines, the fields of a line joined by a space. */
      mtllibs: string[];
      /** The names of the materials a `usemtl` line sets. */
      usedMaterials: ReadonlySet<string>;
      /** The names of the materials that at least one face takes: set by a `usemtl` before the face. */
      facedMaterials: ReadonlySet<string>;
      /** The vertices and the faces when the read was asked to keep them (`{ geometry: true }`), otherwise null. */
      geometry: Geometry;
    }
  | { ok: false; problem: string };
export type MtlReading = { ok: true; materials: Map<string, Rgb | null> } | { ok: false; problem: string };

/** The statements of a buffer with their 1-based line numbers, one line decoded at a time; blank lines and comments are skipped. */
export function* statementsOf(buffer: Buffer): Generator<NumberedStatement> {
  let start = 0;
  let number = 0;
  while (start < buffer.length) {
    const found = buffer.indexOf(NEWLINE, start);
    const end = found === -1 ? buffer.length : found;
    number++;
    const trimmed = buffer.toString('utf-8', start, end).trim();
    if (trimmed !== '' && !trimmed.startsWith('#')) {
      const [keyword, ...fields] = trimmed.split(/\s+/);
      yield { keyword, fields, number };
    }
    start = end + 1;
  }
}

function isNumbers(fields: readonly string[], least: number, most: number): boolean {
  return fields.length >= least && fields.length <= most && fields.every((field) => DECIMAL.test(field) && Number.isFinite(Number(field)));
}

/** The 0-based position of the item that the 1-based or negative `part` names among the `count` items defined so far, or why it names none. */
function resolveIndex(part: string, count: number, what: IndexKind, corner: string): Resolved {
  if (part === '') return { problem: `corner ${corner} has an empty index` };
  if (!INTEGER.test(part)) return { problem: `unrecognised token ${part} in corner ${corner}` };
  const index = Number(part);
  if (index === 0 || Math.abs(index) > count) return { problem: `${what} index ${part} is not within the ${count} ${DEFINED_ITEMS[what]} defined so far` };
  return { index: index > 0 ? index - 1 : count + index };
}

function cornerForm(parts: readonly string[], corner: string): CornerForm | { problem: string } {
  if (parts.length > 3) return { problem: `corner ${corner} has more than three indices` };
  if (parts.length === 1) return 'v';
  if (parts.length === 2) return 'v/vt';
  return parts[1] === '' ? 'v//vn' : 'v/vt/vn';
}

/**
 * Takes the statements of an OBJ one at a time. It owns the counts of what is defined so far, the current material and what it has found, so each
 * statement is judged against everything before it and nothing else.
 */
class ObjScanner {
  private vertexCount = 0;
  private faceCount = 0;
  private textureCount = 0;
  private normalCount = 0;
  private readonly coordinates: number[] = [];
  private readonly corners: number[] = [];
  private readonly faceEnds: number[] = [];
  private readonly faceMaterials: number[] = [];
  private readonly materialNames: string[] = [NO_MATERIAL];
  private readonly materialIds = new Map<string, number>([[NO_MATERIAL, 0]]);
  private material = 0;
  private readonly mtllibs: string[] = [];
  private readonly usedMaterials = new Set<string>();
  private readonly facedMaterials = new Set<string>();

  constructor(private readonly keepGeometry: boolean) {}

  /** Why the statement is not valid in this place, or null once it has been taken in. After a problem the scanner is not to be used again. */
  accept({ keyword, fields }: Statement): string | null {
    switch (keyword) {
      case 'v':
        if (!isNumbers(fields, 3, 4)) return 'a vertex needs three or four numbers';
        this.vertexCount++;
        if (this.keepGeometry) this.coordinates.push(Number(fields[0]), Number(fields[1]), Number(fields[2]));
        return null;
      case 'vn':
        this.normalCount++;
        return isNumbers(fields, 3, 3) ? null : 'a normal needs three numbers';
      case 'vt':
        this.textureCount++;
        return isNumbers(fields, 1, 3) ? null : 'a texture coordinate needs one to three numbers';
      case 'f':
        return this.takeFace(fields);
      case 'mtllib':
        if (fields.length === 0) return 'mtllib names no file';
        this.mtllibs.push(fields.join(' '));
        return null;
      case 'usemtl':
        this.setMaterial(fields.join(' '));
        return null;
      default:
        return null;
    }
  }

  private setMaterial(name: string): void {
    if (name !== NO_MATERIAL) this.usedMaterials.add(name);
    let id = this.materialIds.get(name);
    if (id === undefined) {
      id = this.materialNames.length;
      this.materialNames.push(name);
      this.materialIds.set(name, id);
    }
    this.material = id;
  }

  private takeFace(fields: readonly string[]): string | null {
    if (fields.length < 3) return 'a face needs at least three corners';
    let first: CornerForm | null = null;
    for (const corner of fields) {
      const parts = corner.split('/');
      const form = cornerForm(parts, corner);
      if (typeof form !== 'string') return form.problem;
      first ??= form;
      if (form !== first) return `corner ${corner} is written as ${form}, the first corner as ${first}`;
      const vertex = resolveIndex(parts[0], this.vertexCount, 'vertex', corner);
      if ('problem' in vertex) return vertex.problem;
      if (form === 'v/vt' || form === 'v/vt/vn') {
        const texture = resolveIndex(parts[1], this.textureCount, 'texture', corner);
        if ('problem' in texture) return texture.problem;
      }
      if (form === 'v//vn' || form === 'v/vt/vn') {
        const normal = resolveIndex(parts[2], this.normalCount, 'normal', corner);
        if ('problem' in normal) return normal.problem;
      }
      if (this.keepGeometry) this.corners.push(vertex.index);
    }
    this.faceCount++;
    if (this.keepGeometry) {
      this.faceEnds.push(this.corners.length);
      this.faceMaterials.push(this.material);
    }
    if (this.material !== 0) this.facedMaterials.add(this.materialNames[this.material]);
    return null;
  }

  finish(): ObjReading<ObjGeometry | null> {
    if (this.vertexCount === 0) return { ok: false, problem: 'the OBJ defines no vertex' };
    if (this.faceCount === 0) return { ok: false, problem: 'the OBJ defines no face' };
    return {
      ok: true,
      mtllibs: this.mtllibs,
      usedMaterials: this.usedMaterials,
      facedMaterials: this.facedMaterials,
      geometry: this.keepGeometry ? new ObjGeometry(this.coordinates, this.corners, this.faceEnds, this.faceMaterials, this.materialNames) : null,
    };
  }
}

/**
 * Reads an OBJ line by line. It is readable when its statements are all in the writers' vocabulary, it has a vertex and a face, and every face
 * index refers to something already defined. Returns the `mtllib` file names, the `usemtl` material names and the materials that faces take, for the
 * cross-check with the MTL file. With `{ geometry: true }` it also keeps the vertices and the faces with their materials, which costs memory in
 * proportion to the model, so the gate, which needs only the materials, leaves it off.
 */
export function readObj(buffer: Buffer): ObjReading;
export function readObj(buffer: Buffer, options: { geometry: true }): ObjReading<ObjGeometry>;
export function readObj(buffer: Buffer, options: { geometry?: boolean } = {}): ObjReading<ObjGeometry | null> {
  const scanner = new ObjScanner(options.geometry === true);
  for (const statement of statementsOf(buffer)) {
    if (!OBJ_VOCABULARY.has(statement.keyword)) return { ok: false, problem: `line ${statement.number}: statement ${statement.keyword} is not one the converter writes` };
    const problem = scanner.accept(statement);
    if (problem !== null) return { ok: false, problem: `line ${statement.number}: ${problem}` };
  }
  return scanner.finish();
}

/** Why one statement of an MTL is not valid, or null; `current` is the material it belongs to (null before the first `newmtl`). */
function mtlStatementProblem(keyword: string, fields: readonly string[], current: string | null): string | null {
  if (keyword === 'newmtl') return fields.length > 0 ? null : 'newmtl names no material';
  if (!MTL_COLOURS.has(keyword) && !MTL_SCALARS.has(keyword)) return `statement ${keyword} is not one the converter writes`;
  if (current === null) return `${keyword} comes before any newmtl`;
  if (MTL_COLOURS.has(keyword)) {
    if (!isNumbers(fields, 3, 3)) return `${keyword} needs three numbers`;
    return fields.every((field) => Number(field) >= 0 && Number(field) <= 1) ? null : `${keyword} ${fields.join(' ')} has a channel outside 0 to 1`;
  }
  if (!isNumbers(fields, 1, 1)) return `${keyword} needs one number`;
  const value = Number(fields[0]);
  if (keyword === 'Tr') return value >= 0 && value <= 1 ? null : `Tr ${fields[0]} is outside 0 to 1`;
  return value >= 0 ? null : `Ns ${fields[0]} is negative`;
}

/**
 * Reads an MTL line by line: its statements must all be in the writers' vocabulary with values in their ranges, each material is defined once, and it
 * must define a material. The result maps each material to its `Kd`, null when it has none.
 */
export function readMtl(buffer: Buffer): MtlReading {
  const materials = new Map<string, Rgb | null>();
  let current: string | null = null;
  for (const { keyword, fields, number } of statementsOf(buffer)) {
    const problem = mtlStatementProblem(keyword, fields, current);
    if (problem !== null) return { ok: false, problem: `line ${number}: ${problem}` };
    if (keyword === 'newmtl') {
      current = fields.join(' ');
      if (materials.has(current)) return { ok: false, problem: `line ${number}: material ${current} is defined twice` };
      materials.set(current, null);
    } else if (keyword === 'Kd' && current !== null) {
      const [red, green, blue] = fields.map(Number);
      materials.set(current, [red, green, blue]);
    }
  }
  if (materials.size === 0) return { ok: false, problem: 'the MTL defines no material' };
  return { ok: true, materials };
}
