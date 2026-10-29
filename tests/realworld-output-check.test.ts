import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { outputProblem } from '../bench/realworld/output-check';
import { convertCadWithOcct } from '../src/lib/conversions/cad-occt';
import { createDeflatedZipBuffer } from '../src/lib/conversions/zip-writer';
import { haveCadConverter } from './helpers/cad-kernel';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * The real-world gate's verdict on an OBJ output: a plain OBJ, and the ZIP of an OBJ and its MTL file that a CAD conversion
 * delivers for a model with colours (the shape convertCadWithOcct returns). The gate judges by the OBJ and MTL formats and the
 * statements their writers emit; the ZIPs here come from the writer's own function and from JSZip, an independent writer.
 */

const ZIP_MIME = 'application/zip';
const CONVERSION_TIMEOUT_MS = 120_000;
const OBJ = Buffer.from('# model\nmtllib x.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl Mat_1\nf 1 2 3\n');
const MTL = Buffer.from(
  '# Exported by Open CASCADE Technology [dev.opencascade.org]\nnewmtl Mat_1\nKa 0.200000 0.025000 0.025000\nKd 0.800000 0.100000 0.100000\nKs 0.000000 0.000000 0.000000\nNs 0.000000\nTr 0.500000\n'
);
const PLAIN_OBJ = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';

let workDir = '';
beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obj-check-'));
});
afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

async function zipOf(files: Record<string, Buffer | string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(files)) zip.file(name, data);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const check = (buffer: Buffer, mimeType?: string, emptyInput?: boolean) => outputProblem(buffer, 'obj', workDir, { pdfinfo: '', identify: '', mimeType, emptyInput });

describe('a plain OBJ', () => {
  it.each([
    ['the form cad-convert writes', '# Wavefront OBJ, coordinates in mm\nmtllib a.mtl\nv 0 0 0\nv 1.5e-3 0 0\nv 0 -1 0\nusemtl Mat_1\nf 1 2 3\nf -3 -2 -1\n'],
    ['the form the kernel writes, with normals, texture coordinates and groups', 'g part\nv 0 0 0\nv 1 0 0\nv 0 1 0\nvn 0 0 1\nvt 0 0\nvt 1 0\nvt 0 1\nusemtl\nf 1/1/1 2/2/1 3/3/1\nf 1//1 2//1 3//1\nf 1/1 2/2 3/3\n'],
    ['the form the pure engine writes', '# Wavefront OBJ\no model\n\nv 0 0 0\nv 1 0 0\nv 0 1 0\n\nvn 0 0 1\nvn 0 0 1\nvn 0 0 1\n\nf 1//1 2//2 3//3\n'],
    ['a quad, a vertex with a weight and Windows line ends', 'v 0 0 0 1\r\nv 1 0 0\r\nv 1 1 0\r\nv 0 1 0\r\nf 1 2 3 4\r\n'],
  ])('is accepted in %s', async (_name, text) => {
    expect(await check(Buffer.from(text))).toBeNull();
  });

  it.each([
    ['plain text', 'hello world, not an obj', /not readable/],
    ['only a comment', '# Wavefront OBJ\n', /not readable/],
    ['vertices and no face', 'v 0 0 0\nv 1 0 0\nv 0 1 0\n', /defines no face/],
    ['a face and no vertex', '# Wavefront OBJ\nusemtl x\nf 1 2 3\n', /vertex index 1 is not within the 0 vertices/],
    ['a face index past the vertex count', 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 4\n', /line 4: vertex index 4 is not within the 3 vertices/],
    ['a face that names a vertex defined after it', 'v 0 0 0\nv 1 0 0\nf 1 2 3\nv 0 1 0\n', /line 3: vertex index 3/],
    ['a negative face index past the vertex count', 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf -1 -2 -4\n', /vertex index -4/],
    ['a face index of zero', 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 0 1 2\n', /vertex index 0/],
    ['a face index that is not an integer', 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 1.5\n', /vertex index 1.5/],
    ['a normal index past the normals', 'v 0 0 0\nv 1 0 0\nv 0 1 0\nvn 0 0 1\nf 1//1 2//1 3//2\n', /normal index 2 is not within the 1 normals/],
    ['a face of two corners', 'v 0 0 0\nv 1 0 0\nf 1 2\n', /at least three corners/],
    ['a vertex that is not a number', 'v 0 0 nan\nv 1 0 0\nv 0 1 0\nf 1 2 3\n', /vertex needs three or four numbers/],
    ['a statement the writers do not emit', 'v 0 0 0\nv 1 0 0\nv 0 1 0\ncstype bspline\nf 1 2 3\n', /statement cstype is not one the converter writes/],
  ])('is refused with %s', async (_name, text, reason) => {
    expect(await check(Buffer.from(text))).toMatch(reason);
  });

  it('is refused when it is empty, unless the corpus marks the input as having no content', async () => {
    expect(await check(Buffer.alloc(0))).toBe('empty output');
    expect(await check(Buffer.alloc(0), undefined, true)).toBeNull();
  });

  it('is still judged as an OBJ when the conversion declares model/obj, and a ZIP that is not declared as one is refused', async () => {
    expect(await check(Buffer.from(PLAIN_OBJ), 'model/obj')).toBeNull();
    expect(await check(await zipOf({ 'x.obj': OBJ, 'x.mtl': MTL }))).toBe('output bytes do not match obj');
  });
});

describe('an OBJ delivered as a ZIP', () => {
  it('is accepted when it is the archive convertCadWithOcct builds from the OBJ and the MTL file', async () => {
    const archive = await createDeflatedZipBuffer([
      { name: 'part.obj', data: Buffer.from(OBJ.toString().replace('x.mtl', 'part.mtl')) },
      { name: 'part.mtl', data: MTL },
    ]);
    expect(await check(archive, ZIP_MIME)).toBeNull();
  });

  it('is accepted when an independent ZIP writer built it', async () => {
    expect(await check(await zipOf({ 'x.obj': OBJ, 'x.mtl': MTL }), ZIP_MIME)).toBeNull();
  });

  it.each([
    ['a usemtl that the MTL file does not define', { 'x.obj': OBJ, 'x.mtl': 'newmtl Other\nKd 1 1 1\n' }, /uses material Mat_1, which x\.mtl does not define/],
    ['an MTL file that no mtllib line names', { 'x.obj': OBJ.toString().replace('mtllib x.mtl\n', ''), 'x.mtl': MTL }, /x\.mtl is not named by an mtllib line/],
    ['an MTL file that the mtllib line names under another name', { 'x.obj': OBJ, 'y.mtl': MTL }, /names material file x\.mtl, which the archive lacks/],
    ['an mtllib line that names a second file the archive lacks', { 'x.obj': OBJ.toString().replace('mtllib x.mtl', 'mtllib x.mtl y.mtl'), 'x.mtl': MTL }, /names material file y\.mtl/],
    ['no MTL file', { 'x.obj': OBJ }, /holds 0 \.mtl files, not one/],
    ['two MTL files', { 'x.obj': OBJ, 'x.mtl': MTL, 'y.mtl': MTL }, /holds 2 \.mtl files, not one/],
    ['no OBJ', { 'x.mtl': MTL }, /holds 0 \.obj files, not one/],
    ['two OBJs', { 'x.obj': OBJ, 'y.obj': OBJ, 'x.mtl': MTL }, /holds 2 \.obj files, not one/],
    ['an entry in a subdirectory', { 'x.obj': OBJ, 'sub/x.mtl': MTL }, /entry sub\/x\.mtl is not at the archive root/],
    ['an entry whose name holds a backslash', { 'x.obj': OBJ, 'sub\\x.mtl': MTL }, /entry sub\\x\.mtl is not at the archive root/],
    ['a further entry', { 'x.obj': OBJ, 'x.mtl': MTL, 'notes.txt': 'hello' }, /unexpected entry notes\.txt/],
    ['an MTL file without a material', { 'x.obj': OBJ, 'x.mtl': '# nothing\n' }, /defines no material/],
    ['an MTL file with a texture map', { 'x.obj': OBJ, 'x.mtl': `${MTL}map_Kd wood.png\n` }, /statement map_Kd is not one the converter writes/],
    ['an MTL file with a bump map', { 'x.obj': OBJ, 'x.mtl': `${MTL}bump wood.png\n` }, /statement bump is not one the converter writes/],
    ['an MTL file with a reflection map', { 'x.obj': OBJ, 'x.mtl': `${MTL}refl -type sphere wood.png\n` }, /statement refl is not one/],
    ['an MTL file with a displacement map', { 'x.obj': OBJ, 'x.mtl': `${MTL}disp wood.png\n` }, /statement disp is not one/],
    ['an MTL colour with two numbers', { 'x.obj': OBJ, 'x.mtl': 'newmtl Mat_1\nKd 1 1\n' }, /Kd needs three numbers/],
    ['an MTL colour before any material', { 'x.obj': OBJ, 'x.mtl': 'Kd 1 1 1\nnewmtl Mat_1\n' }, /Kd comes before any newmtl/],
    ['an OBJ that is a plain text', { 'x.obj': 'hello world, not an obj', 'x.mtl': MTL }, /model x\.obj: obj is not readable/],
    ['an OBJ with a face index past the vertex count', { 'x.obj': OBJ.toString().replace('f 1 2 3', 'f 1 2 9'), 'x.mtl': MTL }, /model x\.obj: .*vertex index 9/],
    ['an OBJ that is an executable', { 'x.obj': Buffer.from('7f454c46020101000000000000000000', 'hex'), 'x.mtl': MTL }, /model x\.obj: output bytes do not match obj/],
    ['a zero-byte OBJ', { 'x.obj': Buffer.alloc(0), 'x.mtl': MTL }, /model x\.obj: empty output/],
  ])('is refused with %s', async (_name, files, reason) => {
    expect(await check(await zipOf(files), ZIP_MIME)).toMatch(reason);
  });

  it('is refused for a zero-byte OBJ entry even when the corpus marks the input as having no content', async () => {
    expect(await check(await zipOf({ 'x.obj': Buffer.alloc(0), 'x.mtl': MTL }), ZIP_MIME, true)).toBe('model x.obj: empty output');
  });

  it('is refused when the bytes are not a ZIP, and when the output is empty', async () => {
    expect(await check(Buffer.from('PK\u0003\u0004 corrupt archive'), ZIP_MIME)).toBe('obj archive is not a readable ZIP');
    expect(await check(Buffer.alloc(0), ZIP_MIME)).toBe('empty output');
  });
});

describe.skipIf(!haveCadConverter)('the archive convertCadWithOcct returns for a coloured real model', () => {
  for (const id of ['cq-red_cube_blue_cylinder.step', 'pyocc-testfile.igs']) {
    it(`passes the gate: ${id}`, { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
      const { bytes, format } = await requireRealworldSample(ctx, id);
      const result = await convertCadWithOcct(bytes, format, 'obj');
      expect(result.mimeType).toBe(ZIP_MIME);
      expect(await outputProblem(result.buffer, 'obj', workDir, { pdfinfo: '', identify: '', mimeType: result.mimeType })).toBeNull();
    });
  }
});
