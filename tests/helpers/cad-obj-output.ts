import JSZip from 'jszip';
import { readMtl, statementOf } from '../../bench/realworld/obj-mtl';
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

/** Surface area of the triangles that each material (`usemtl`) of an OBJ covers, by plain text parsing of the OBJ; faces before any `usemtl` count under ''. */
export function objMaterialAreas(obj: Buffer): Map<string, number> {
  const vertices: Array<[number, number, number]> = [];
  const areas = new Map<string, number>();
  let material = '';
  for (const line of obj.toString('utf-8').split('\n')) {
    const statement = statementOf(line);
    if (statement === null) continue;
    const { keyword, fields } = statement;
    if (keyword === 'v') vertices.push([Number(fields[0]), Number(fields[1]), Number(fields[2])]);
    else if (keyword === 'usemtl') material = fields.join(' ');
    else if (keyword === 'f') {
      const corners = fields.map((field) => vertices[Number(field.split('/')[0]) - 1]);
      for (let i = 1; i + 1 < corners.length; i++) {
        const [a, b, c] = [corners[0], corners[i], corners[i + 1]];
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const area = 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
        areas.set(material, (areas.get(material) ?? 0) + area);
      }
    }
  }
  return areas;
}

/** The materials (`newmtl`) of an MTL file with their diffuse colour (`Kd`), null for a material that gives none; the file is read by the line reader of the real-world output check. */
export function mtlMaterials(mtl: Buffer): ReadonlyMap<string, readonly [number, number, number] | null> {
  const reading = readMtl(mtl);
  if (!reading.ok) throw new Error(`the MTL file is not readable: ${reading.problem}`);
  return reading.materials;
}
