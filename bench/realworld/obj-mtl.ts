/**
 * Line reader for the OBJ and MTL files that the CAD conversions write, shared by the real-world output check and the tests that read a colour back.
 *
 * Statement grammar: the Wavefront OBJ and MTL specifications (Paul Bourke's file format notes). A line is blank, a `#` comment, or a keyword
 * followed by whitespace-separated fields; vertex, texture and normal indices of a face are 1-based, and a negative index counts back from the last one
 * defined so far.
 *
 * Vocabulary: what the writers in this repository emit, nothing else.
 * - OBJ: `native/cad-convert/cad-convert.cpp` writeObj writes `#`, `mtllib`, `v`, `usemtl` and `f` with plain vertex indices. The Open CASCADE
 *   writer (RWObj_ObjWriterContext.cxx, V7_8_1, lines 118-286) also writes `vn`, `vt`, `g`, a bare `usemtl`, and the `v/vt/vn`, `v//vn` and `v/vt` face forms. The
 *   pure engine (src/lib/edge/pure/pure-cad.ts encodeObj) writes `o`, `vn` and `v//vn`. The union is the vocabulary.
 * - MTL: RWObj_ObjMaterialMap.cxx (V7_8_1, identical in V7_6_3) DefineMaterial, lines 65-151, writes `#`, `newmtl`, `Ka`, `Kd`, `Ks`, `Ns` and `Tr`, and
 *   `map_Kd` for a texture. The converter's archive holds no image, so a `map_Kd` would name a file that is not there, and it is not in the vocabulary.
 */

type Rgb = readonly [number, number, number];

const OBJ_VOCABULARY: ReadonlySet<string> = new Set(['mtllib', 'usemtl', 'o', 'g', 'v', 'vn', 'vt', 'f']);
const MTL_COLOURS: ReadonlySet<string> = new Set(['Ka', 'Kd', 'Ks']);
const MTL_SCALARS: ReadonlySet<string> = new Set(['Ns', 'Tr']);
const INTEGER = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

export type ObjReading = { ok: true; mtllibs: string[]; usedMaterials: string[] } | { ok: false; problem: string };
export type MtlReading = { ok: true; materials: Map<string, Rgb | null> } | { ok: false; problem: string };

/** The keyword and fields of a line, or null for a blank line and a comment. */
export function statementOf(line: string): { keyword: string; fields: string[] } | null {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;
  const [keyword, ...fields] = trimmed.split(/\s+/);
  return { keyword, fields };
}

function isNumbers(fields: readonly string[], least: number, most: number): boolean {
  return fields.length >= least && fields.length <= most && fields.every((field) => DECIMAL.test(field) && Number.isFinite(Number(field)));
}

/** Whether `field` is an index into the `count` items defined so far: 1..count, or -count..-1 counting back from the last. */
function isIndexWithin(field: string, count: number): boolean {
  if (!INTEGER.test(field)) return false;
  const index = Number(field);
  return index !== 0 && Math.abs(index) <= count;
}

/** Why a face corner (`v`, `v/vt`, `v//vn` or `v/vt/vn`) is not valid, or null. */
function cornerProblem(corner: string, counts: { v: number; vt: number; vn: number }): string | null {
  const parts = corner.split('/');
  if (parts.length > 3) return `corner ${corner} has more than three indices`;
  if (!isIndexWithin(parts[0], counts.v)) return `vertex index ${parts[0]} is not within the ${counts.v} vertices defined so far`;
  if (parts[1] !== undefined && parts[1] !== '' && !isIndexWithin(parts[1], counts.vt)) return `texture index ${parts[1]} is not within the ${counts.vt} texture coordinates defined so far`;
  if (parts[2] !== undefined && !isIndexWithin(parts[2], counts.vn)) return `normal index ${parts[2]} is not within the ${counts.vn} normals defined so far`;
  return null;
}

/** Why one statement of an OBJ is not valid, or null; counts the vertices, textures and normals as they are defined. */
function objStatementProblem(keyword: string, fields: readonly string[], counts: { v: number; vt: number; vn: number; f: number }, found: { mtllibs: string[]; usedMaterials: string[] }): string | null {
  switch (keyword) {
    case 'v':
      counts.v++;
      return isNumbers(fields, 3, 4) ? null : 'a vertex needs three or four numbers';
    case 'vn':
      counts.vn++;
      return isNumbers(fields, 3, 3) ? null : 'a normal needs three numbers';
    case 'vt':
      counts.vt++;
      return isNumbers(fields, 1, 3) ? null : 'a texture coordinate needs one to three numbers';
    case 'f': {
      counts.f++;
      if (fields.length < 3) return 'a face needs at least three corners';
      for (const corner of fields) {
        const problem = cornerProblem(corner, counts);
        if (problem !== null) return problem;
      }
      return null;
    }
    case 'mtllib':
      found.mtllibs.push(...fields);
      return fields.length > 0 ? null : 'mtllib names no file';
    case 'usemtl':
      if (fields.length > 0) found.usedMaterials.push(fields.join(' '));
      return null;
    default:
      return null;
  }
}

/**
 * Reads an OBJ line by line. It is readable when its statements are all in the writers' vocabulary, it has a vertex and a face, and every face
 * index refers to something already defined. Returns the `mtllib` file names and the `usemtl` material names for the cross-check with the MTL file.
 */
export function readObj(buffer: Buffer): ObjReading {
  const counts = { v: 0, vt: 0, vn: 0, f: 0 };
  const found = { mtllibs: [] as string[], usedMaterials: [] as string[] };
  const lines = buffer.toString('utf-8').split(/\r?\n/);
  for (let number = 0; number < lines.length; number++) {
    const statement = statementOf(lines[number]);
    if (statement === null) continue;
    if (!OBJ_VOCABULARY.has(statement.keyword)) return { ok: false, problem: `line ${number + 1}: statement ${statement.keyword} is not one the converter writes` };
    const problem = objStatementProblem(statement.keyword, statement.fields, counts, found);
    if (problem !== null) return { ok: false, problem: `line ${number + 1}: ${problem}` };
  }
  if (counts.v === 0) return { ok: false, problem: 'the OBJ defines no vertex' };
  if (counts.f === 0) return { ok: false, problem: 'the OBJ defines no face' };
  return { ok: true, ...found };
}

/** Why one statement of an MTL is not valid, or null; `current` is the material it belongs to (null before the first `newmtl`). */
function mtlStatementProblem(keyword: string, fields: readonly string[], current: string | null): string | null {
  if (keyword === 'newmtl') return fields.length > 0 ? null : 'newmtl names no material';
  if (!MTL_COLOURS.has(keyword) && !MTL_SCALARS.has(keyword)) return `statement ${keyword} is not one the converter writes`;
  if (current === null) return `${keyword} comes before any newmtl`;
  if (MTL_COLOURS.has(keyword)) return isNumbers(fields, 3, 3) ? null : `${keyword} needs three numbers`;
  return isNumbers(fields, 1, 1) ? null : `${keyword} needs one number`;
}

/** Reads an MTL line by line: its statements must all be in the writers' vocabulary, and it must define a material. The result maps each material to its `Kd`, null when it has none. */
export function readMtl(buffer: Buffer): MtlReading {
  const materials = new Map<string, Rgb | null>();
  let current: string | null = null;
  const lines = buffer.toString('utf-8').split(/\r?\n/);
  for (let number = 0; number < lines.length; number++) {
    const statement = statementOf(lines[number]);
    if (statement === null) continue;
    const problem = mtlStatementProblem(statement.keyword, statement.fields, current);
    if (problem !== null) return { ok: false, problem: `line ${number + 1}: ${problem}` };
    if (statement.keyword === 'newmtl') {
      current = statement.fields.join(' ');
      materials.set(current, null);
    } else if (statement.keyword === 'Kd' && current !== null) {
      const [red, green, blue] = statement.fields.map(Number);
      materials.set(current, [red, green, blue]);
    }
  }
  if (materials.size === 0) return { ok: false, problem: 'the MTL defines no material' };
  return { ok: true, materials };
}
