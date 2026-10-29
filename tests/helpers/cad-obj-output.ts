import JSZip from 'jszip';
import { readObj, statementsOf } from '../../bench/realworld/obj-mtl';
import type { ConversionResult } from '../../src/lib/types';

/**
 * The files of an OBJ result: the OBJ alone, or the ZIP of the OBJ and its MTL file that a model with colours comes as. The MTL
 * is null when the result is the OBJ alone.
 */
export async function objFiles(result: Pick<ConversionResult, 'buffer' | 'mimeType'>): Promise<{ obj: Buffer; mtl: Buffer | null; names: string[] }> {
  if (result.mimeType !== 'application/zip') return { obj: result.buffer, mtl: null, names: [] };
  const zip = await JSZip.loadAsync(result.buffer);
  const names = Object.keys(zip.files).sort((a, b) => a.localeCompare(b));
  const objName = names.find((name) => name.endsWith('.obj'));
  const mtlName = names.find((name) => name.endsWith('.mtl'));
  if (objName === undefined) throw new Error(`the ZIP holds no OBJ: ${names.join(', ')}`);
  return {
    obj: Buffer.from(await zip.files[objName].async('uint8array')),
    mtl: mtlName === undefined ? null : Buffer.from(await zip.files[mtlName].async('uint8array')),
    names,
  };
}

/**
 * Surface area of the triangles that each material (`usemtl`) of an OBJ covers; faces before any named `usemtl` count under ''. The OBJ is read by the
 * line reader of the real-world output check (bench/realworld/obj-mtl.ts), the one that resolves the face indices, so there is a single index rule; an
 * OBJ the reader refuses throws.
 */
export function objMaterialAreas(obj: Buffer): Map<string, number> {
  const reading = readObj(obj, { geometry: true });
  if (!reading.ok) throw new Error(`the OBJ file is not readable: ${reading.problem}`);
  const areas = new Map<string, number>();
  for (const { material, vertices } of reading.geometry.faces()) {
    for (let i = 1; i + 1 < vertices.length; i++) {
      const [a, b, c] = [vertices[0], vertices[i], vertices[i + 1]];
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const area = 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
      areas.set(material, (areas.get(material) ?? 0) + area);
    }
  }
  return areas;
}

/**
 * The materials (`newmtl`) of an MTL file with their diffuse colour (`Kd`), null for a material that gives none. This read is lenient: it takes the
 * statements of the same tokenizer as the gate (statementsOf) and looks only at `newmtl` and `Kd`, so a test of a colour does not depend on the
 * vocabulary and the ranges that the gate holds the writers to.
 */
export function mtlMaterials(mtl: Buffer): ReadonlyMap<string, readonly [number, number, number] | null> {
  const materials = new Map<string, readonly [number, number, number] | null>();
  let current: string | null = null;
  for (const { keyword, fields } of statementsOf(mtl)) {
    if (keyword === 'newmtl') {
      current = fields.join(' ');
      materials.set(current, null);
    } else if (keyword === 'Kd' && current !== null) {
      materials.set(current, [Number(fields[0]), Number(fields[1]), Number(fields[2])]);
    }
  }
  return materials;
}
