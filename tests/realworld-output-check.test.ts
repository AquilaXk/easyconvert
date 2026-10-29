import { describe, expect, it } from 'vitest';
import os from 'node:os';
import JSZip from 'jszip';
import { outputProblem } from '../bench/realworld/output-check';

/**
 * The real-world gate's verdict on an OBJ that a CAD conversion delivers as a ZIP of the OBJ and its MTL file (the shape
 * convertCadWithOcct returns for a model with colours). ZIPs come from JSZip, an independent writer.
 */

const ZIP_MIME = 'application/zip';
const OBJ = Buffer.from('# model\nmtllib x.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl Mat_1\nf 1 2 3\n');
const OBJ_WITHOUT_COLOURS = Buffer.from('# model\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
const MTL = Buffer.from('newmtl Mat_1\nKd 0.8 0.1 0.1\nillum 2\n');

async function zipOf(files: Record<string, Buffer | string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(files)) zip.file(name, data);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const check = (buffer: Buffer, mimeType?: string) => outputProblem(buffer, 'obj', os.tmpdir(), { pdfinfo: '', identify: '', mimeType });

describe('OBJ archive output check', () => {
  it('accepts the ZIP of an OBJ and the MTL file its mtllib line names', async () => {
    expect(await check(await zipOf({ 'x.obj': OBJ, 'x.mtl': MTL }), ZIP_MIME)).toBeNull();
  });

  it('accepts an archive of the OBJ alone when the OBJ names no material file', async () => {
    expect(await check(await zipOf({ 'x.obj': OBJ_WITHOUT_COLOURS }), ZIP_MIME)).toBeNull();
  });

  it('still accepts a plain OBJ and refuses a ZIP that is not declared as one', async () => {
    expect(await check(OBJ_WITHOUT_COLOURS)).toBeNull();
    expect(await check(OBJ_WITHOUT_COLOURS, 'model/obj')).toBeNull();
    expect(await check(await zipOf({ 'x.obj': OBJ, 'x.mtl': MTL }))).toBe('output bytes do not match obj');
  });

  it.each([
    ['no OBJ', { 'x.mtl': MTL }, 'obj archive holds 0 .obj files, not one'],
    ['two OBJs', { 'x.obj': OBJ, 'y.obj': OBJ, 'x.mtl': MTL }, 'obj archive holds 2 .obj files, not one'],
    ['two MTL files', { 'x.obj': OBJ, 'x.mtl': MTL, 'y.mtl': MTL }, 'obj archive holds 2 .mtl files, at most one is expected'],
    ['an mtllib naming a missing file', { 'x.obj': OBJ, 'other.mtl': MTL }, 'obj names material file x.mtl, which the archive lacks'],
    ['an mtllib with no MTL in the archive', { 'x.obj': OBJ }, 'obj names material file x.mtl, which the archive lacks'],
    ['an MTL without a material', { 'x.obj': OBJ, 'x.mtl': '# nothing\nKd 1 1 1\n' }, 'material file x.mtl defines no material'],
    ['an unexpected extra entry', { 'x.obj': OBJ, 'x.mtl': MTL, 'notes.txt': 'hello' }, 'obj archive holds an unexpected entry notes.txt'],
    ['a texture the MTL names but the archive lacks', { 'x.obj': OBJ, 'x.mtl': `${MTL}map_Kd wood.png\n` }, 'material file x.mtl names texture wood.png, which the archive lacks'],
    ['an OBJ entry that is an executable', { 'x.obj': Buffer.from('7f454c46020101000000000000000000', 'hex'), 'x.mtl': MTL }, 'model x.obj: output bytes do not match obj'],
  ])('refuses %s', async (_name, files, problem) => {
    expect(await check(await zipOf(files), ZIP_MIME)).toBe(problem);
  });

  it('refuses bytes that are not a ZIP, and an empty output', async () => {
    expect(await check(Buffer.from('PK\u0003\u0004 corrupt archive'), ZIP_MIME)).toBe('obj archive is not a readable ZIP');
    expect(await check(Buffer.alloc(0), ZIP_MIME)).toBe('empty output');
  });
});
