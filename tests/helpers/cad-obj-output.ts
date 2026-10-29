import JSZip from 'jszip';
import { hasExtension, readMtl, readObj, type Colour, type Point } from '../../bench/realworld/obj-mtl';
import type { ConversionResult } from '../../src/lib/types';

/**
 * The files of an OBJ result: the OBJ alone, or the ZIP of the OBJ and its MTL file that a model with colours comes as. The MTL
 * is null when the result is the OBJ alone.
 */
export async function objFiles(result: Pick<ConversionResult, 'buffer' | 'mimeType'>): Promise<{ obj: Buffer; mtl: Buffer | null; names: string[] }> {
  if (result.mimeType !== 'application/zip') return { obj: result.buffer, mtl: null, names: [] };
  const zip = await JSZip.loadAsync(result.buffer);
  const names = Object.keys(zip.files).sort((a, b) => a.localeCompare(b));
  const objName = names.find((name) => hasExtension(name, 'obj'));
  const mtlName = names.find((name) => hasExtension(name, 'mtl'));
  if (objName === undefined) throw new Error(`the ZIP holds no OBJ: ${names.join(', ')}`);
  return {
    obj: Buffer.from(await zip.files[objName].async('uint8array')),
    mtl: mtlName === undefined ? null : Buffer.from(await zip.files[mtlName].async('uint8array')),
    names,
  };
}

/** The area of the triangle with the corners a, b and c. */
function triangleArea(a: Point, b: Point, c: Point): number {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
}

/**
 * Surface area of the triangles that each material (`usemtl`) of an OBJ covers; faces before any `usemtl` count under ''. The OBJ is read by the
 * line reader of the real-world output check (bench/realworld/obj-mtl.ts), the one that resolves the face indices, so there is a single index rule; an
 * OBJ the reader refuses throws.
 */
export function objMaterialAreas(obj: Buffer): Map<string, number> {
  const points: Point[] = [];
  const areas = new Map<string, number>();
  const reading = readObj(obj, {
    onVertex: (point) => points.push(point),
    onFace: (material, corners) => {
      for (let i = 1; i + 1 < corners.length; i++) {
        areas.set(material, (areas.get(material) ?? 0) + triangleArea(points[corners[0]], points[corners[i]], points[corners[i + 1]]));
      }
    },
  });
  if (!reading.ok) throw new Error(`the OBJ file is not readable: ${reading.problem}`);
  return areas;
}

/**
 * The materials (`newmtl`) of an MTL file with their diffuse colour (`Kd`), null for a material that gives none. This read is lenient (see readMtl): it
 * looks only at `newmtl` and `Kd`, so a test of a colour does not depend on the vocabulary and the ranges that the gate holds the writers to.
 */
export function mtlMaterials(mtl: Buffer): ReadonlyMap<string, Colour | null> {
  const reading = readMtl(mtl, { lenient: true });
  if (!reading.ok) throw new Error(`the MTL file is not readable: ${reading.problem}`);
  return reading.materials;
}
