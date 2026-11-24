/**
 * Pure mesh encoders: a triangle mesh as ASCII STL or Wavefront OBJ, in plain strings and arrays (no raster, PDF or
 * archive module). STEP and IGES are not read here, because they need a B-rep kernel: the worker runs the Open CASCADE
 * program for them (src/lib/conversions/cad-occt.ts), and the browser sends those files to the server.
 */

import { EdgeUnsupportedError } from '../workers/worker-errors';

/** A mesh of vertices (x, y, z), faces of vertex indices, and optional per-vertex normals. */
export interface TessellatedMesh {
  name: string;
  vertices: [number, number, number][];
  normals: [number, number, number][];
  faces: [number, number, number][];
}

const VERTEX_COMPONENTS = 3;
const MIN_FACE_CORNERS = 3;
const BINARY_STL_HEADER_BYTES = 80;
const BINARY_STL_FACET_BYTES = 50;
export const MAX_PURE_CAD_TRIANGLES = 1_000_000;
export const MAX_PURE_CAD_VERTICES = 3_000_000;

function computeUnitNormal(
  v1: readonly number[],
  v2: readonly number[],
  v3: readonly number[]
): [number, number, number] {
  const ax = v2[0] - v1[0];
  const ay = v2[1] - v1[1];
  const az = v2[2] - v1[2];
  const bx = v3[0] - v1[0];
  const by = v3[1] - v1[1];
  const bz = v3[2] - v1[2];

  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

/**
 * Checks that vertex and expanded-triangle counts fit the edge bounds, every vertex is three finite numbers, and
 * every corner of every face names a vertex that exists. Returns the fan-triangulated triangle count.
 */
function assertWritableMesh(mesh: TessellatedMesh): number {
  const count = mesh.vertices.length;
  if (count > MAX_PURE_CAD_VERTICES) {
    throw new EdgeUnsupportedError(
      `Mesh lists ${count} vertices, exceeding the ${MAX_PURE_CAD_VERTICES}-vertex edge limit.`
    );
  }
  for (let at = 0; at < count; at++) {
    const vertex = mesh.vertices[at];
    if (!Array.isArray(vertex) || vertex.length !== VERTEX_COMPONENTS || !vertex.every(Number.isFinite)) {
      throw new EdgeUnsupportedError(`Mesh vertex ${at} is not three finite coordinates; the server engine converts this file.`);
    }
  }
  let triangleCount = 0;
  for (let at = 0; at < mesh.faces.length; at++) {
    const face = mesh.faces[at];
    if (face.length < MIN_FACE_CORNERS) continue;
    triangleCount += face.length - 2;
    if (triangleCount > MAX_PURE_CAD_TRIANGLES) {
      throw new EdgeUnsupportedError(
        `Mesh contains ${triangleCount} triangles, exceeding the ${MAX_PURE_CAD_TRIANGLES}-triangle edge limit.`
      );
    }
    for (let c = 0; c < face.length; c++) {
      const index = face[c];
      if (!Number.isInteger(index) || index < 0 || index >= count) {
        throw new EdgeUnsupportedError(
          `Mesh face ${at} has vertex index ${index}, but the mesh has ${count} vertices; the server engine converts this file.`
        );
      }
    }
  }
  return triangleCount;
}

/**
 * Encodes 3D TessellatedMesh to ASCII Stereolithography (STL) format.
 */
export function encodeStl(mesh: TessellatedMesh): string {
  assertWritableMesh(mesh);
  const safeName = (mesh.name || 'EasyConvert_Model').replace(/[\r\n]+/g, ' ').trim();
  const chunks: string[] = [`solid ${safeName}\n`];

  const addFacet = (v1: number[], v2: number[], v3: number[]) => {
    const [nx, ny, nz] = computeUnitNormal(v1, v2, v3);
    chunks.push(
      `  facet normal ${nx} ${ny} ${nz}\n    outer loop\n      vertex ${v1[0]} ${v1[1]} ${v1[2]}\n      vertex ${v2[0]} ${v2[1]} ${v2[2]}\n      vertex ${v3[0]} ${v3[1]} ${v3[2]}\n    endloop\n  endfacet\n`
    );
  };

  mesh.faces.forEach((face) => {
    if (face.length < MIN_FACE_CORNERS) return;
    const v0 = mesh.vertices[face[0]];
    for (let i = 1; i < face.length - 1; i++) {
      const v1 = mesh.vertices[face[i]];
      const v2 = mesh.vertices[face[i + 1]];
      addFacet(v0, v1, v2);
    }
  });

  chunks.push(`endsolid ${safeName}\n`);
  return chunks.join('');
}

/**
 * Encodes 3D TessellatedMesh to little-endian binary Stereolithography (STL) format.
 */
export function encodeBinaryStl(mesh: TessellatedMesh): Uint8Array {
  const triangleCount = assertWritableMesh(mesh);

  const totalBytes = BINARY_STL_HEADER_BYTES + 4 + triangleCount * BINARY_STL_FACET_BYTES;
  const out = new Uint8Array(totalBytes);
  const safeName = (mesh.name || 'EasyConvert_Model').replace(/[\r\n]+/g, ' ').trim();
  const headerLabel = `Binary STL: ${safeName}`;
  const headerLen = Math.min(BINARY_STL_HEADER_BYTES, headerLabel.length);
  for (let i = 0; i < headerLen; i++) {
    const code = headerLabel.charCodeAt(i);
    out[i] = code >= 0x20 && code <= 0x7e ? code : 0x5f;
  }

  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(BINARY_STL_HEADER_BYTES, triangleCount, true);

  let offset = BINARY_STL_HEADER_BYTES + 4;
  for (let f = 0; f < mesh.faces.length; f++) {
    const face = mesh.faces[f];
    if (face.length < MIN_FACE_CORNERS) continue;
    const v0 = mesh.vertices[face[0]];
    for (let i = 1; i < face.length - 1; i++) {
      const v1 = mesh.vertices[face[i]];
      const v2 = mesh.vertices[face[i + 1]];
      const [nx, ny, nz] = computeUnitNormal(v0, v1, v2);
      view.setFloat32(offset, nx, true);
      view.setFloat32(offset + 4, ny, true);
      view.setFloat32(offset + 8, nz, true);
      view.setFloat32(offset + 12, v0[0], true);
      view.setFloat32(offset + 16, v0[1], true);
      view.setFloat32(offset + 20, v0[2], true);
      view.setFloat32(offset + 24, v1[0], true);
      view.setFloat32(offset + 28, v1[1], true);
      view.setFloat32(offset + 32, v1[2], true);
      view.setFloat32(offset + 36, v2[0], true);
      view.setFloat32(offset + 40, v2[1], true);
      view.setFloat32(offset + 44, v2[2], true);
      view.setUint16(offset + 48, 0, true);
      offset += BINARY_STL_FACET_BYTES;
    }
  }

  return out;
}

/**
 * Encodes 3D TessellatedMesh to Wavefront OBJ format.
 */
export function encodeObj(mesh: TessellatedMesh): string {
  assertWritableMesh(mesh);
  const safeName = (mesh.name || 'model').replace(/[\r\n]+/g, ' ').trim();
  const chunks: string[] = [`# Wavefront OBJ generated by EasyConvert Pure Engine\no ${safeName}\n\n`];

  mesh.vertices.forEach((v) => {
    chunks.push(`v ${v[0]} ${v[1]} ${v[2]}\n`);
  });

  const hasNormals = Boolean(mesh.normals && mesh.normals.length === mesh.vertices.length);
  if (hasNormals && mesh.normals) {
    chunks.push('\n');
    mesh.normals.forEach((n) => {
      chunks.push(`vn ${n[0]} ${n[1]} ${n[2]}\n`);
    });
  }

  chunks.push('\n');

  mesh.faces.forEach((f) => {
    if (f.length < 3) return;
    const tokens = f.map((idx) => (hasNormals ? `${idx + 1}//${idx + 1}` : `${idx + 1}`));
    chunks.push(`f ${tokens.join(' ')}\n`);
  });

  return chunks.join('');
}
