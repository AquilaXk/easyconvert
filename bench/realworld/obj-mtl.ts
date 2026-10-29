/**
 * Line reader for the OBJ and MTL files that the CAD conversions write, shared by the real-world output check and the tests that read a colour back.
 *
 * Statement grammar: the Wavefront OBJ and MTL specifications (Paul Bourke's file format notes). A line is blank, a `#` comment, or a keyword
 * followed by whitespace-separated fields; vertex and normal indices of a face are 1-based, and a negative index counts back from the last one
 * defined so far. A material set by `usemtl` applies to the faces that follow it, until the next `usemtl`. The MTL colours `Ka`, `Kd` and `Ks`
 * are RGB in 0 to 1, `Tr` is a transparency in 0 to 1 and `Ns` is a specular exponent, never negative.
 *
 * Vocabulary: what the two OBJ writers shipped here emit, nothing else.
 * - `native/cad-convert/cad-convert.cpp` writeObj writes `#`, one `mtllib` when the model has colours, `v`, then `usemtl` with a material name before
 *   the faces of that material, and `f` with plain vertex indices. The kernel's own OBJ writer body is not used (the comment above writeObj, line 521).
 * - `src/lib/edge/pure/pure-cad.ts` encodeObj writes `#`, `o`, `v`, `vn` and `f` with `v//vn` corners (plain `v` corners without normals).
 * - MTL: RWObj_ObjMaterialMap.cxx (V7_8_1, identical in V7_6_3) DefineMaterial, lines 65-151, writes `#`, `newmtl`, `Ka`, `Kd`, `Ks`, `Ns` and `Tr`, and
 *   `map_Kd` for a texture. The converter's archive holds no image, so a `map_Kd` would name a file that is not there, and it is not in the vocabulary.
 *
 * Writer policy, stricter than the format:
 * - A face index must name a vertex or normal defined before it. The format lets a positive index name a later one; both writers put every `v` before
 *   the first `f`, so a forward index in an output means the file is damaged.
 * - Material and file names are the writers' set `[A-Za-z0-9._-]` (isSafeMaterialName in cad-convert.cpp, outputStem in cad-occt.ts), one word each.
 * - The OBJ has at most one `mtllib` line, and an MTL gives each attribute at most once per material.
 *
 * Threat model: this check judges what the repository's own writers produce (writeObj, encodeObj and the ZIP that convertCadWithOcct builds with
 * createDeflatedZipBuffer). It does not judge uploads or archives made by an attacker; a guard against a shape the writers cannot produce is out of scope.
 *
 * Bounds on the text layer, so that reading a file costs no more than its size, in lines, fields and tokens a message quotes. Each is marked as taken
 * from a writer or as this check's own; neither writer has a reference limit for the check's own. They do not bound what a ZIP inflates to: the
 * archive is the converter's own output.
 * - MAX_LINE_BYTES, 1 MiB, is the check's own. A line is checked before it is decoded. writeObj's longest line is under 100 bytes (a vertex of about 60
 *   bytes, an mtllib of at most 75). encodeObj has no cap on the corners of a face nor on the `o` name; a corner is at most 23 bytes (`i//i` with two
 *   10-digit indices and a blank), so 1 MiB holds a face of about 45,000 corners, and the faces of the 14 corpus models have 3 corners. No realistic
 *   model reaches the bound.
 * - MAX_NUMBER_CHARS, 64, is the check's own: the longest number, and the longest index of a face corner. The number pattern has one way to match each
 *   string, so it runs in time linear in the field, and the field length is checked first.
 * - MAX_LIBRARY_NAME_CHARS is derived from a writer: outputStem caps the stem at MAX_OUTPUT_NAME_CHARS (cad-occt.ts) and `.mtl` follows.
 * - MAX_NAME_CHARS, 255, is the check's own, the longest name a file system holds. No writer caps a material name (isSafeMaterialName only checks its
 *   characters), so a `usemtl` or `newmtl` name is held to it.
 * - MAX_MATERIALS, 100,000, is the check's own: the most distinct materials in an OBJ or an MTL.
 * - MAX_SHOWN_CHARS, 40, is the check's own: a token that a refusal quotes is cut to that many code points, with its control, format and line-separator
 *   characters replaced.
 */

import { MAX_OUTPUT_NAME_CHARS } from '../../src/lib/conversions/cad-occt';

export type Point = readonly [number, number, number];
export type Colour = readonly [number, number, number];
export type Statement = { keyword: string; fields: string[] };
type CornerForm = 'v' | 'v//vn';
type Resolved = { index: number } | { problem: string };
type IndexKind = 'vertex' | 'normal';

const MTL_COLOURS: ReadonlySet<string> = new Set(['Ka', 'Kd', 'Ks']);
const MTL_SCALARS: ReadonlySet<string> = new Set(['Ns', 'Tr']);
const INTEGER = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const NAME = /^[A-Za-z0-9._-]+$/;
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const NEWLINE = 0x0a;
const MTL_EXTENSION = '.mtl';
export const MAX_LINE_BYTES = 1024 * 1024;
export const MAX_NUMBER_CHARS = 64;
export const MAX_LIBRARY_NAME_CHARS = MAX_OUTPUT_NAME_CHARS + MTL_EXTENSION.length;
export const MAX_NAME_CHARS = 255;
export const MAX_MATERIALS = 100_000;
export const MAX_SHOWN_CHARS = 40;
const NO_MATERIAL = -1;
const DEFINED_ITEMS: Readonly<Record<IndexKind, string>> = { vertex: 'vertices', normal: 'normals' };

/** Receives the geometry of an OBJ as it is read, for a caller that needs it; the gate passes none and the reader keeps nothing. */
export interface ObjObserver {
  onVertex?(point: Point): void;
  /** `material` is `''` before the first `usemtl`; `corners` are 0-based vertex indices with the negative ones resolved. */
  onFace?(material: string, corners: readonly number[]): void;
}

export type ObjReading =
  | {
      ok: true;
      /** The file name of the `mtllib` line, null when there is none. */
      mtllib: string | null;
      /** The names of the materials a `usemtl` line sets, in order of first use. */
      usedMaterials: readonly string[];
      /** The names of the materials that at least one face takes: set by a `usemtl` before the face. */
      facedMaterials: ReadonlySet<string>;
    }
  | { ok: false; problem: string };
/** The successful read of an OBJ. */
export type ObjScan = Extract<ObjReading, { ok: true }>;
export type MtlReading = { ok: true; materials: Map<string, Colour | null> } | { ok: false; problem: string };

/** Whether an archive entry name has the extension, in any case. */
export function hasExtension(name: string, extension: 'obj' | 'mtl'): boolean {
  return name.toLowerCase().endsWith(`.${extension}`);
}

/** A message as a refusal may quote it: cut to `limit` code points (MAX_SHOWN_CHARS for a token of the file) and without control, format or line-separator characters. */
export function shown(token: string, limit: number = MAX_SHOWN_CHARS): string {
  let end = 0;
  let count = 0;
  for (const point of token) {
    if (count === limit) return `${token.slice(0, end).replace(UNPRINTABLE, '?')}...`;
    end += point.length;
    count++;
  }
  return token.replace(UNPRINTABLE, '?');
}

/**
 * Hands the statements of a buffer to `take` one line at a time, blank lines and comments skipped, and returns the first problem with its line number.
 * A line over MAX_LINE_BYTES is refused before it is decoded.
 */
export function readStatements(buffer: Buffer, take: (statement: Statement) => string | null): string | null {
  let start = 0;
  let number = 0;
  while (start < buffer.length) {
    const found = buffer.indexOf(NEWLINE, start);
    const end = found === -1 ? buffer.length : found;
    number++;
    if (end - start > MAX_LINE_BYTES) return `line ${number}: ${end - start} bytes is over the ${MAX_LINE_BYTES} byte line limit`;
    const trimmed = buffer.toString('utf-8', start, end).trim();
    if (trimmed !== '' && !trimmed.startsWith('#')) {
      const [keyword, ...fields] = trimmed.split(/\s+/);
      const problem = take({ keyword, fields });
      if (problem !== null) return `line ${number}: ${problem}`;
    }
    start = end + 1;
  }
  return null;
}

function isDecimal(field: string): boolean {
  return field.length <= MAX_NUMBER_CHARS && DECIMAL.test(field);
}

/** The three channels of a colour field list, or null when it is not three finite decimal numbers; the range of a channel is left to the caller. */
export function parseColour(fields: readonly string[]): Colour | null {
  if (!isNumbers(fields, 3, 3)) return null;
  return [Number(fields[0]), Number(fields[1]), Number(fields[2])];
}

function isNumbers(fields: readonly string[], least: number, most: number): boolean {
  return fields.length >= least && fields.length <= most && fields.every((field) => isDecimal(field) && Number.isFinite(Number(field)));
}

/** Why `fields` is not the one name of at most `limit` characters that `keyword` takes, or null. */
function nameProblem(keyword: string, fields: readonly string[], limit: number): string | null {
  if (fields.length !== 1) return `${keyword} needs exactly one name, not ${fields.length}`;
  const [name] = fields;
  if (name.length > limit || !NAME.test(name)) return `${keyword} name ${shown(name)} is not letters, digits, '.', '_' and '-' in at most ${limit} characters`;
  return null;
}

/** The 0-based position of the item that the 1-based or negative `part` names among the `count` items defined so far, or why it names none. */
function resolveIndex(part: string, count: number, what: IndexKind, corner: string): Resolved {
  if (part === '') return { problem: `corner ${shown(corner)} has an empty index` };
  if (part.length > MAX_NUMBER_CHARS) return { problem: `an index of corner ${shown(corner)} is over ${MAX_NUMBER_CHARS} characters` };
  if (!INTEGER.test(part)) return { problem: `unrecognised token ${shown(part)} in corner ${shown(corner)}` };
  const index = Number(part);
  if (index === 0 || Math.abs(index) > count) return { problem: `${what} index ${shown(part)} is not within the ${count} ${DEFINED_ITEMS[what]} defined so far` };
  return { index: index > 0 ? index - 1 : count + index };
}

function cornerForm(parts: readonly string[], corner: string): CornerForm | { problem: string } {
  if (parts.length === 1) return 'v';
  if (parts.length === 3 && parts[1] === '') return 'v//vn';
  return { problem: `corner ${shown(corner)} is not written as v or v//vn` };
}

/**
 * Takes the statements of an OBJ one at a time. It owns the counts of what is defined so far, the current material and what it has found, so each
 * statement is judged against everything before it and nothing else.
 */
class ObjScanner {
  private vertexCount = 0;
  private faceCount = 0;
  private normalCount = 0;
  private mtllib: string | null = null;
  private readonly materialNames: string[] = [];
  private readonly materialIds = new Map<string, number>();
  private readonly facedIds = new Set<number>();
  private material = NO_MATERIAL;

  constructor(private readonly observer: ObjObserver) {}

  /** Why the statement is not valid in this place, or null once it has been taken in. After a problem the scanner is not to be used again. */
  accept({ keyword, fields }: Statement): string | null {
    switch (keyword) {
      case 'o':
        return null;
      case 'v':
        if (!isNumbers(fields, 3, 4)) return 'a vertex needs three or four numbers';
        this.vertexCount++;
        this.observer.onVertex?.([Number(fields[0]), Number(fields[1]), Number(fields[2])]);
        return null;
      case 'vn':
        if (!isNumbers(fields, 3, 3)) return 'a normal needs three numbers';
        this.normalCount++;
        return null;
      case 'f':
        return this.takeFace(fields);
      case 'mtllib':
        return this.takeLibrary(fields);
      case 'usemtl':
        return this.takeMaterial(fields);
      default:
        return `statement ${shown(keyword)} is not one the converter writes`;
    }
  }

  private takeLibrary(fields: readonly string[]): string | null {
    const problem = nameProblem('mtllib', fields, MAX_LIBRARY_NAME_CHARS);
    if (problem !== null) return problem;
    if (this.mtllib !== null) return 'a second mtllib line';
    this.mtllib = fields[0];
    return null;
  }

  private takeMaterial(fields: readonly string[]): string | null {
    const problem = nameProblem('usemtl', fields, MAX_NAME_CHARS);
    if (problem !== null) return problem;
    let id = this.materialIds.get(fields[0]);
    if (id === undefined) {
      if (this.materialNames.length >= MAX_MATERIALS) return `the OBJ names more than ${MAX_MATERIALS} materials`;
      id = this.materialNames.length;
      this.materialNames.push(fields[0]);
      this.materialIds.set(fields[0], id);
    }
    this.material = id;
    return null;
  }

  private takeFace(fields: readonly string[]): string | null {
    if (fields.length < 3) return 'a face needs at least three corners';
    const corners: number[] | null = this.observer.onFace === undefined ? null : [];
    let first: CornerForm | null = null;
    for (const corner of fields) {
      const parts = corner.split('/');
      const form = cornerForm(parts, corner);
      if (typeof form !== 'string') return form.problem;
      first ??= form;
      if (form !== first) return `corner ${shown(corner)} is written as ${form}, the first corner as ${first}`;
      const vertex = resolveIndex(parts[0], this.vertexCount, 'vertex', corner);
      if ('problem' in vertex) return vertex.problem;
      if (form === 'v//vn') {
        const normal = resolveIndex(parts[2], this.normalCount, 'normal', corner);
        if ('problem' in normal) return normal.problem;
      }
      corners?.push(vertex.index);
    }
    this.faceCount++;
    if (this.material !== NO_MATERIAL) this.facedIds.add(this.material);
    if (corners !== null) this.observer.onFace?.(this.material === NO_MATERIAL ? '' : this.materialNames[this.material], corners);
    return null;
  }

  finish(): ObjReading {
    if (this.vertexCount === 0) return { ok: false, problem: 'the OBJ defines no vertex' };
    if (this.faceCount === 0) return { ok: false, problem: 'the OBJ defines no face' };
    return { ok: true, mtllib: this.mtllib, usedMaterials: this.materialNames, facedMaterials: new Set([...this.facedIds].map((id) => this.materialNames[id])) };
  }
}

/**
 * Reads an OBJ line by line. It is readable when its statements are all in the writers' vocabulary, it has a vertex and a face, and every face
 * index refers to something already defined. Returns the `mtllib` file name, the `usemtl` material names and the materials that faces take, for the
 * cross-check with the MTL file. The geometry goes to the observer when there is one and is kept nowhere, so the cost in memory does not grow with
 * the model.
 */
export function readObj(buffer: Buffer, observer: ObjObserver = {}): ObjReading {
  const scanner = new ObjScanner(observer);
  const problem = readStatements(buffer, (statement) => scanner.accept(statement));
  return problem === null ? scanner.finish() : { ok: false, problem };
}

/** Why one statement of an MTL is not valid, or null; `current` is the material it belongs to (null before the first `newmtl`) and `given` its attributes so far. */
function mtlStatementProblem(keyword: string, fields: readonly string[], current: string | null, given: ReadonlySet<string>): string | null {
  if (keyword === 'newmtl') return nameProblem(keyword, fields, MAX_NAME_CHARS);
  if (!MTL_COLOURS.has(keyword) && !MTL_SCALARS.has(keyword)) return `statement ${shown(keyword)} is not one the converter writes`;
  if (current === null) return `${keyword} comes before any newmtl`;
  if (given.has(keyword)) return `${keyword} is given twice for material ${shown(current)}`;
  if (MTL_COLOURS.has(keyword)) {
    const colour = parseColour(fields);
    if (colour === null) return `${keyword} needs three numbers`;
    return colour.every((channel) => channel >= 0 && channel <= 1) ? null : `${keyword} ${shown(fields.join(' '))} has a channel outside 0 to 1`;
  }
  if (fields.length !== 1 || !isDecimal(fields[0])) return `${keyword} needs one number`;
  const value = Number(fields[0]);
  if (!Number.isFinite(value)) return `${keyword} ${shown(fields[0])} is not a finite number`;
  if (keyword === 'Tr') return value >= 0 && value <= 1 ? null : `Tr ${shown(fields[0])} is outside 0 to 1`;
  return value >= 0 ? null : `Ns ${shown(fields[0])} is negative`;
}

/**
 * Reads an MTL line by line: its statements must all be in the writers' vocabulary with values in their ranges, each material is defined once and
 * gives each attribute once, and it must define a material. The result maps each material to its `Kd`, null when it has none.
 */
export function readMtl(buffer: Buffer): MtlReading {
  const materials = new Map<string, Colour | null>();
  let current: string | null = null;
  let given = new Set<string>();
  const problem = readStatements(buffer, ({ keyword, fields }) => {
    const statementProblem = mtlStatementProblem(keyword, fields, current, given);
    if (statementProblem !== null) return statementProblem;
    if (keyword === 'newmtl') {
      current = fields[0];
      if (materials.has(current)) return `material ${shown(current)} is defined twice`;
      if (materials.size >= MAX_MATERIALS) return `the MTL defines more than ${MAX_MATERIALS} materials`;
      materials.set(current, null);
      given = new Set();
    } else if (current !== null) {
      given.add(keyword);
      if (keyword === 'Kd') materials.set(current, parseColour(fields));
    }
    return null;
  });
  if (problem !== null) return { ok: false, problem };
  if (materials.size === 0) return { ok: false, problem: 'the MTL defines no material' };
  return { ok: true, materials };
}
