import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import {
  MAX_LIBRARY_NAME_CHARS,
  MAX_LINE_BYTES,
  MAX_MATERIALS,
  MAX_NAME_CHARS,
  MAX_NUMBER_CHARS,
  MAX_SHOWN_CHARS,
  parseColour,
  readObj,
  shown,
} from '../bench/realworld/obj-mtl';
import { outputProblem } from '../bench/realworld/output-check';
import { MAX_OUTPUT_NAME_CHARS, convertCadWithOcct } from '../src/lib/conversions/cad-occt';
import { createDeflatedZipBuffer } from '../src/lib/conversions/zip-writer';
import { haveCadConverter } from './helpers/cad-kernel';
import { mtlMaterials, objFiles, objMaterialAreas } from './helpers/cad-obj-output';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * The real-world gate's verdict on an OBJ output: a plain OBJ, and the ZIP of an OBJ and its MTL file that a CAD conversion
 * delivers for a model with colours (the shape convertCadWithOcct returns). The gate judges by the OBJ and MTL formats and the
 * statements their writers emit; the ZIPs here come from the writer's own function and from JSZip, an independent writer.
 */

const ZIP_MIME = 'application/zip';
const CONVERSION_TIMEOUT_MS = 120_000;
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'realworld-output-check-'));
const MAX_TOOL_MESSAGE_CHARS = 200;
const LOCAL_HEADER = Buffer.from('PK\u0003\u0004', 'latin1');
const CENTRAL_HEADER = Buffer.from('PK\u0001\u0002', 'latin1');
const LOCAL_CRC_OFFSET = 14;
const CENTRAL_CRC_OFFSET = 16;
const OBJ = Buffer.from('# model\nmtllib x.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl Mat_1\nf 1 2 3\n');
const MTL = Buffer.from(
  '# Exported by Open CASCADE Technology [dev.opencascade.org]\nnewmtl Mat_1\nKa 0.200000 0.025000 0.025000\nKd 0.800000 0.100000 0.100000\nKs 0.000000 0.000000 0.000000\nNs 0.000000\nTr 0.500000\n'
);
const PLAIN_OBJ = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';
const TRIANGLE = 'v 0 0 0\nv 1 0 0\nv 0 1 0\n';

/** The ZIP of `files` by JSZip; a name that ends in a slash becomes a folder entry. */
async function zipOf(files: Record<string, Buffer | string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith('/')) zip.folder(name.slice(0, -1));
    else zip.file(name, data);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function check(buffer: Buffer, { mimeType, emptyInput }: { mimeType?: string; emptyInput?: boolean } = {}): Promise<string | null> {
  return outputProblem(buffer, 'obj', WORK_DIR, { pdfinfo: '', identify: '', mimeType, emptyInput });
}

afterAll(() => {
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
});

describe('a plain OBJ', () => {
  it.each([
    ['the form cad-convert writes for a model with no colour', '# Wavefront OBJ, coordinates in mm\nv 0 0 0\nv 1.5e-3 0 0\nv 0 -1 0\nf 1 2 3\nf -3 -2 -1\n'],
    ['the form the pure engine writes with normals', '# Wavefront OBJ\no model\n\nv 0 0 0\nv 1 0 0\nv 0 1 0\n\nvn 0 0 1\nvn 0 0 1\nvn 0 0 1\n\nf 1//1 2//2 3//3\n'],
    ['a polygon of 2,000 corners, longer than 8 KiB (robustness: encodeObj writes triangles, but the OBJ format allows any polygon)', `v 0 0 0\nv 1 0 0\nv 0 1 0\nvn 0 0 1\nvn 0 0 1\nvn 0 0 1\nf ${'1//1 2//2 3//3 '.repeat(667).trim()}\n`],
    ['a face index of MAX_NUMBER_CHARS characters', `${TRIANGLE}f 1 2 ${'0'.repeat(MAX_NUMBER_CHARS - 1)}3\n`],
    ['an o name of 20,000 characters, which encodeObj writes without a cap', `o ${'n'.repeat(20_000)}\n${PLAIN_OBJ}`],
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
    ['a face index that is not an integer', 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 1.5\n', /unrecognised token 1\.5/],
    ['a face corner that is not a number', 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 abc\n', /unrecognised token abc in corner abc/],
    ['corners written in different forms', TRIANGLE + 'vn 0 0 1\nf 1//1 2//1 3\n', /corner 3 is written as v, the first corner as v\/\/vn/],
    ['a corner with a slash and no texture index', TRIANGLE + 'f 1/ 2/ 3/\n', /corner 1\/ is not written as v or v\/\/vn/],
    ['a corner with a slash and no normal index', TRIANGLE + 'vn 0 0 1\nf 1// 2// 3//\n', /corner 1\/\/ has an empty index/],
    ['a corner with a texture index, which neither writer emits', TRIANGLE + 'f 1/1 2/2 3/3\n', /corner 1\/1 is not written as v or v\/\/vn/],
    ['a corner with a texture and a normal index, which neither writer emits', TRIANGLE + 'vn 0 0 1\nf 1/1/1 2/2/1 3/3/1\n', /corner 1\/1\/1 is not written as v or v\/\/vn/],
    ['a texture coordinate, which neither writer emits', TRIANGLE + 'vt 0 0\nf 1 2 3\n', /statement vt is not one the converter writes/],
    ['a group, which neither writer emits', 'g part\n' + PLAIN_OBJ, /statement g is not one the converter writes/],
    ['a bare usemtl, which neither writer emits', TRIANGLE + 'usemtl\nf 1 2 3\n', /usemtl needs exactly one name, not 0/],
    ['a normal index past the normals', 'v 0 0 0\nv 1 0 0\nv 0 1 0\nvn 0 0 1\nf 1//1 2//1 3//2\n', /normal index 2 is not within the 1 normals/],
    ['a face of two corners', 'v 0 0 0\nv 1 0 0\nf 1 2\n', /at least three corners/],
    ['a vertex that is not a number', 'v 0 0 nan\nv 1 0 0\nv 0 1 0\nf 1 2 3\n', /vertex needs three or four numbers/],
    ['a statement the writers do not emit', 'v 0 0 0\nv 1 0 0\nv 0 1 0\ncstype bspline\nf 1 2 3\n', /statement cstype is not one the converter writes/],
    ['an mtllib line, whose material file comes only in a ZIP', 'mtllib a.mtl\n' + PLAIN_OBJ, /names material file a\.mtl, which comes only in a ZIP/],
    ['a named usemtl, whose material file comes only in a ZIP', TRIANGLE + 'usemtl Mat_1\nf 1 2 3\n', /uses material Mat_1, whose material file comes only in a ZIP/],
    ['a usemtl with two names', TRIANGLE + 'usemtl Mat_1 Mat_2\nf 1 2 3\n', /usemtl needs exactly one name, not 2/],
    ['a usemtl with two names and a double space', TRIANGLE + 'usemtl A  B\nf 1 2 3\n', /usemtl needs exactly one name, not 2/],
    ['an mtllib with two names', 'mtllib x.mtl y.mtl\n' + PLAIN_OBJ, /mtllib needs exactly one name, not 2/],
    ['an mtllib with no name', 'mtllib\n' + PLAIN_OBJ, /mtllib needs exactly one name, not 0/],
    ['a second mtllib line', 'mtllib x.mtl\nmtllib y.mtl\n' + PLAIN_OBJ, /line 2: a second mtllib line/],
    ['a usemtl name with a slash', TRIANGLE + 'usemtl a/b\nf 1 2 3\n', /usemtl name a\/b is not letters, digits/],
    ['an mtllib name with a slash', 'mtllib ../x.mtl\n' + PLAIN_OBJ, /mtllib name \.\.\/x\.mtl is not letters, digits/],
    ['a usemtl name over MAX_NAME_CHARS', TRIANGLE + `usemtl ${'m'.repeat(MAX_NAME_CHARS + 1)}\nf 1 2 3\n`, new RegExp(`usemtl name m{${MAX_SHOWN_CHARS}}\\.\\.\\. is not letters, digits`)],
    [
      'an mtllib name over MAX_LIBRARY_NAME_CHARS, the stem cap of outputStem and .mtl',
      `mtllib ${'m'.repeat(MAX_OUTPUT_NAME_CHARS + 1)}.mtl\n` + PLAIN_OBJ,
      new RegExp(`mtllib name m{${MAX_SHOWN_CHARS}}\\.\\.\\. is not letters, digits, '\\.', '_' and '-' in at most ${MAX_LIBRARY_NAME_CHARS} characters`),
    ],
    ['a face index over MAX_NUMBER_CHARS characters', TRIANGLE + `f 1 2 ${'0'.repeat(MAX_NUMBER_CHARS)}3\n`, new RegExp(`an index of corner 0{${MAX_SHOWN_CHARS}}\\.\\.\\. is over ${MAX_NUMBER_CHARS} characters`)],
    ['the form cad-convert writes for a model with colours, which is a ZIP', OBJ.toString(), /names material file x\.mtl, which comes only in a ZIP/],
    ['an executable', '\u007fELF\u0002\u0001\u0001\u0000 binary', /not readable/],
  ])('is refused with %s', async (_name, text, reason) => {
    expect(await check(Buffer.from(text))).toMatch(reason);
  });

  it('is refused when it is empty, unless the corpus marks the input as having no content', async () => {
    expect(await check(Buffer.alloc(0))).toBe('empty output');
    expect(await check(Buffer.alloc(0), { emptyInput: true })).toBeNull();
  });

  it('is still judged as an OBJ when the conversion declares model/obj, and a ZIP that is not declared as one is refused', async () => {
    expect(await check(Buffer.from(PLAIN_OBJ), { mimeType: 'model/obj' })).toBeNull();
    expect(await check(await zipOf({ 'x.obj': OBJ, 'x.mtl': MTL }))).toMatch(/obj is not readable/);
  });
});

describe('an OBJ beyond the bounds of the check', () => {
  const lineOf = (length: number) => Buffer.from(`${PLAIN_OBJ}# ${'c'.repeat(length - 2)}\n`);

  it('is refused at a number of MAX_NUMBER_CHARS + 1 characters, and a number of MAX_NUMBER_CHARS is read', async () => {
    expect(await check(Buffer.from(`v 0 0 ${'1'.repeat(MAX_NUMBER_CHARS + 1)}\nv 1 0 0\nv 0 1 0\nf 1 2 3\n`))).toMatch(/line 1: a vertex needs three or four numbers/);
    expect(await check(Buffer.from(`v 0 0 ${'1'.repeat(MAX_NUMBER_CHARS)}\nv 1 0 0\nv 0 1 0\nf 1 2 3\n`))).toBeNull();
    expect(await check(Buffer.from(`v 0 0 0.${'1'.repeat(40)}e-5\nv 1 0 0\nv 0 1 0\nf 1 2 3\n`))).toBeNull();
  });

  it.each([
    ['a plain', (n: number) => Buffer.alloc(n, 'a')],
    ['a spaced', (n: number) => Buffer.from(`v ${'1 '.repeat(Math.floor(n / 2))}`.slice(0, n))],
  ])('is refused for %s line over the line bound before it is decoded, with a short message', async (_name, line) => {
    const problem = await check(line(MAX_LINE_BYTES + 1));
    expect(problem).toBe(`obj is not readable, line 1: ${MAX_LINE_BYTES + 1} bytes is over the ${MAX_LINE_BYTES} byte line limit`);
  });

  it('is refused at the line number of a line one byte over the bound, and a line at the bound is read', async () => {
    expect(await check(lineOf(MAX_LINE_BYTES))).toBeNull();
    expect(await check(lineOf(MAX_LINE_BYTES + 1))).toMatch(new RegExp(`line 5: ${MAX_LINE_BYTES + 1} bytes is over the ${MAX_LINE_BYTES} byte line limit`));
  });

  it('is refused with a message that quotes at most MAX_SHOWN_CHARS characters of a token and no control byte', async () => {
    const keyword = await check(Buffer.from(`${'k'.repeat(3000)} 1\n`));
    expect(keyword).toBe(`obj is not readable, line 1: statement ${'k'.repeat(MAX_SHOWN_CHARS)}... is not one the converter writes`);
    const zip = await check(await zipOf({ 'x.obj': OBJ, 'x.mtl': MTL }));
    expect(zip).toMatch(/^obj is not readable, line 1: statement PK/);
    expect(zip).not.toMatch(/\p{Cc}/u);
    expect(zip?.length).toBeLessThan(200);
  });

  it('is quoted by code points, with format and line-separator characters replaced', async () => {
    const emoji = await check(Buffer.from(`${'\u{1F600}'.repeat(60)} 1\n`));
    expect(emoji).toBe(`obj is not readable, line 1: statement ${'\u{1F600}'.repeat(MAX_SHOWN_CHARS)}... is not one the converter writes`);
    expect(shown('a\u202Eb\u200Bc\u2028d\u2029e\u0007f')).toBe('a?b?c?d?e?f');
    expect(shown('\u{1F600}'.repeat(MAX_SHOWN_CHARS))).toBe('\u{1F600}'.repeat(MAX_SHOWN_CHARS));
  });

  it('quotes an entry name through the same cut in a page archive', async () => {
    const archive = await zipOf({ [`${'n'.repeat(300)}.png`]: 'not an image' });
    const problem = await outputProblem(archive, 'png', WORK_DIR, { pdfinfo: '', identify: '', mimeType: ZIP_MIME });
    expect(problem).toMatch(new RegExp(`^page ${'n'.repeat(MAX_SHOWN_CHARS)}\\.\\.\\.: `));
  });

  it('is refused for more than MAX_MATERIALS distinct materials, in the OBJ and in the MTL, and the last one the bound allows is read', async () => {
    const usemtl = (count: number) => Array.from({ length: count }, (_, i) => `usemtl m${i}\nf 1 2 3\n`).join('');
    const newmtl = (count: number) => Array.from({ length: count }, (_, i) => `newmtl m${i}\nKd 1 1 1\n`).join('');
    expect(await check(Buffer.from(TRIANGLE + usemtl(MAX_MATERIALS + 1)))).toMatch(new RegExp(`line \\d+: the OBJ names more than ${MAX_MATERIALS} materials`));
    expect(await check(Buffer.from(TRIANGLE + usemtl(MAX_MATERIALS)))).toMatch(/uses material m0, whose material file comes only in a ZIP/);
    expect(await check(await zipOf({ 'x.obj': OBJ, 'x.mtl': newmtl(MAX_MATERIALS + 1) }), { mimeType: ZIP_MIME })).toMatch(new RegExp(`the MTL defines more than ${MAX_MATERIALS} materials`));
    expect(await check(await zipOf({ 'x.obj': `mtllib x.mtl\n${TRIANGLE}${usemtl(MAX_MATERIALS)}`, 'x.mtl': newmtl(MAX_MATERIALS) }), { mimeType: ZIP_MIME })).toBeNull();
  });
});

describe('a reference reader that refuses the output', () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const readerPrinting = (name: string, message: string): string => {
    const script = path.join(WORK_DIR, name);
    fs.writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' '${message}' >&2\nexit 1\n`, { mode: 0o755 });
    return script;
  };
  const problemOf = (identify: string) => outputProblem(PNG, 'png', WORK_DIR, { pdfinfo: '', identify });

  it('is quoted beyond the 40 characters of a token of the file, so the tail that names the cause survives', async () => {
    const message = `identify: ${'a'.repeat(100)} @ error/png.c/ReadPNGImage/3962`;
    expect(message.length).toBeGreaterThan(MAX_SHOWN_CHARS);
    expect(await problemOf(readerPrinting('long-reader', message))).toBe(`reference reader refused the output: ${message}`);
  });

  it('is cut at MAX_TOOL_MESSAGE_CHARS characters', async () => {
    const problem = await problemOf(readerPrinting('longer-reader', 'x'.repeat(MAX_TOOL_MESSAGE_CHARS * 2)));
    expect(problem).toBe(`reference reader refused the output: ${'x'.repeat(MAX_TOOL_MESSAGE_CHARS)}...`);
  });

  it('names the error code when the reader is missing and prints nothing', async () => {
    expect(await problemOf(path.join(WORK_DIR, 'no-such-reader'))).toBe('reference reader refused the output: ENOENT');
  });
});

describe('an OBJ delivered as a ZIP', () => {
  it('is accepted when createDeflatedZipBuffer, the writer convertCadWithOcct builds its archive with, wrote it', async () => {
    const archive = await createDeflatedZipBuffer([
      { name: 'part.obj', data: Buffer.from(OBJ.toString().replace('x.mtl', 'part.mtl')) },
      { name: 'part.mtl', data: MTL },
    ]);
    expect(await check(archive, { mimeType: ZIP_MIME })).toBeNull();
  });

  it('is accepted when an independent ZIP writer built it', async () => {
    expect(await check(await zipOf({ 'x.obj': OBJ, 'x.mtl': MTL }), { mimeType: ZIP_MIME })).toBeNull();
  });

  it('is accepted when two materials each take faces and faces come before the first usemtl', async () => {
    const obj = `mtllib my_model-1.mtl\n${TRIANGLE}v 1 1 0\nf 1 2 3\nusemtl Mat_1\nf 1 2 3\nusemtl Red.paint\nf 2 4 3\nusemtl Mat_2\nf -4 -3 -1\n`;
    const mtl = `${MTL}newmtl Red.paint\nKd 1 0 0\nnewmtl Mat_2\nKd 0 1 0\nTr 0\nNs 1000\n`;
    expect(await check(await zipOf({ 'my_model-1.obj': obj, 'my_model-1.mtl': mtl }), { mimeType: ZIP_MIME })).toBeNull();
  });

  it.each([
    ['an mtllib line and no usemtl, which loads as a grey mesh', { 'x.obj': OBJ.toString().replace('usemtl Mat_1\n', ''), 'x.mtl': MTL }, /no face of the obj takes a material/],
    ['a usemtl after the last face, which no face takes', { 'x.obj': OBJ.toString().replace('usemtl Mat_1\nf 1 2 3\n', 'f 1 2 3\nusemtl Mat_1\n'), 'x.mtl': MTL }, /no face of the obj takes a material/],
    ['a material that no face takes next to one that a face takes', { 'x.obj': OBJ, 'x.mtl': `${MTL}newmtl Spare\nKd 0 0 1\n` }, /x\.mtl defines material Spare, which no face of the obj takes/],
    ['a used material that has no Kd', { 'x.obj': OBJ, 'x.mtl': 'newmtl Mat_1\nKa 0.2 0.2 0.2\nTr 0\n' }, /material Mat_1 has no Kd/],
    ['a material defined twice', { 'x.obj': OBJ, 'x.mtl': `${MTL}newmtl Mat_1\nKd 0 0 1\n` }, /line \d+: material Mat_1 is defined twice/],
    ['a Kd channel outside 0 to 1', { 'x.obj': OBJ, 'x.mtl': 'newmtl Mat_1\nKd 9 -3 400\n' }, /Kd 9 -3 400 has a channel outside 0 to 1/],
    ['a Ka channel outside 0 to 1', { 'x.obj': OBJ, 'x.mtl': 'newmtl Mat_1\nKa 0 0 1.01\nKd 1 1 1\n' }, /Ka 0 0 1\.01 has a channel outside 0 to 1/],
    ['a Ks channel below 0', { 'x.obj': OBJ, 'x.mtl': 'newmtl Mat_1\nKd 1 1 1\nKs -0.1 0 0\n' }, /Ks -0\.1 0 0 has a channel outside 0 to 1/],
    ['a Tr outside 0 to 1', { 'x.obj': OBJ, 'x.mtl': 'newmtl Mat_1\nKd 1 1 1\nTr 5\n' }, /Tr 5 is outside 0 to 1/],
    ['a negative Ns', { 'x.obj': OBJ, 'x.mtl': 'newmtl Mat_1\nKd 1 1 1\nNs -1\n' }, /Ns -1 is negative/],
    ['an Ns that is not finite', { 'x.obj': OBJ, 'x.mtl': 'newmtl Mat_1\nKd 1 1 1\nNs 1e999\n' }, /Ns 1e999 is not a finite number/],
    ['an Ns that is not a number', { 'x.obj': OBJ, 'x.mtl': 'newmtl Mat_1\nKd 1 1 1\nNs high\n' }, /Ns needs one number/],
    ['a Kd given twice for one material', { 'x.obj': OBJ, 'x.mtl': `${MTL}Kd 0 0 1\n` }, /line 8: Kd is given twice for material Mat_1/],
    ['a Ka given twice for one material', { 'x.obj': OBJ, 'x.mtl': 'newmtl Mat_1\nKa 0 0 0\nKa 1 1 1\nKd 1 1 1\n' }, /Ka is given twice for material Mat_1/],
    ['a Tr given twice for one material', { 'x.obj': OBJ, 'x.mtl': 'newmtl Mat_1\nKd 1 1 1\nTr 0\nTr 0.5\n' }, /Tr is given twice/],
    ['a Ns given twice for one material', { 'x.obj': OBJ, 'x.mtl': 'newmtl Mat_1\nKd 1 1 1\nNs 0\nNs 5\n' }, /Ns is given twice/],
    ['a newmtl with two names', { 'x.obj': OBJ, 'x.mtl': 'newmtl Mat_1 Mat_2\nKd 1 1 1\n' }, /newmtl needs exactly one name, not 2/],
    ['a newmtl with no name', { 'x.obj': OBJ, 'x.mtl': 'newmtl\nKd 1 1 1\n' }, /newmtl needs exactly one name, not 0/],
    ['a newmtl name with a slash', { 'x.obj': OBJ, 'x.mtl': 'newmtl a/b\nKd 1 1 1\n' }, /newmtl name a\/b is not letters, digits/],
    ['a usemtl that the MTL file does not define', { 'x.obj': OBJ, 'x.mtl': 'newmtl Other\nKd 1 1 1\n' }, /uses material Mat_1, which x\.mtl does not define/],
    ['an MTL file that no mtllib line names', { 'x.obj': OBJ.toString().replace('mtllib x.mtl\n', ''), 'x.mtl': MTL }, /x\.mtl is not named by an mtllib line/],
    ['an MTL file that the mtllib line names under another name', { 'x.obj': OBJ, 'y.mtl': MTL }, /names material file x\.mtl, which the archive lacks/],
    ['an mtllib line that names a second file', { 'x.obj': OBJ.toString().replace('mtllib x.mtl', 'mtllib x.mtl y.mtl'), 'x.mtl': MTL }, /mtllib needs exactly one name, not 2/],
    ['a second mtllib line', { 'x.obj': OBJ.toString().replace('mtllib x.mtl', 'mtllib x.mtl\nmtllib x.mtl'), 'x.mtl': MTL }, /line 3: a second mtllib line/],
    ['a usemtl with two names, whatever the MTL file defines', { 'x.obj': OBJ.toString().replace('usemtl Mat_1', 'usemtl A B'), 'x.mtl': 'newmtl A_B\nKd 1 1 1\n' }, /model x\.obj: obj is not readable, line 6: usemtl needs exactly one name, not 2/],
    ['a folder entry', { 'x.obj': OBJ, 'x.mtl': MTL, 'docs/': '' }, /holds the folder docs\//],
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
    ['an OBJ that is an executable', { 'x.obj': Buffer.from('7f454c46020101000000000000000000', 'hex'), 'x.mtl': MTL }, /model x\.obj: obj is not readable/],
    ['a zero-byte OBJ', { 'x.obj': Buffer.alloc(0), 'x.mtl': MTL }, /model x\.obj: empty output/],
  ])('is refused with %s', async (_name, files, reason) => {
    expect(await check(await zipOf(files), { mimeType: ZIP_MIME })).toMatch(reason);
  });

  it('is refused for a zero-byte OBJ entry even when the corpus marks the input as having no content', async () => {
    expect(await check(await zipOf({ 'x.obj': Buffer.alloc(0), 'x.mtl': MTL }), { mimeType: ZIP_MIME, emptyInput: true })).toBe('model x.obj: empty output');
  });

  it('is accepted with the longest stem outputStem writes, MAX_OUTPUT_NAME_CHARS characters, and .mtl', async () => {
    const stem = 's'.repeat(MAX_OUTPUT_NAME_CHARS);
    const archive = await zipOf({ [`${stem}.obj`]: OBJ.toString().replace('x.mtl', `${stem}.mtl`), [`${stem}.mtl`]: MTL });
    expect(`${stem}.mtl`.length).toBe(MAX_LIBRARY_NAME_CHARS);
    expect(await check(archive, { mimeType: ZIP_MIME })).toBeNull();
  });

  it('is accepted with material names of MAX_NAME_CHARS characters, and refused one character over', async () => {
    const accepted = 'm'.repeat(MAX_NAME_CHARS);
    const ok = await zipOf({ 'x.obj': OBJ.toString().replace('Mat_1', accepted), 'x.mtl': MTL.toString().replace('Mat_1', accepted) });
    expect(await check(ok, { mimeType: ZIP_MIME })).toBeNull();
    const over = 'm'.repeat(MAX_NAME_CHARS + 1);
    const refused = await zipOf({ 'x.obj': OBJ.toString().replace('Mat_1', over), 'x.mtl': MTL.toString().replace('Mat_1', over) });
    expect(await check(refused, { mimeType: ZIP_MIME })).toMatch(/is not letters, digits/);
  });

  it('is refused when the CRC-32 of its entries is wrong, and accepted when it is right', async () => {
    const files = [
      { name: 'part.obj', data: Buffer.from(OBJ.toString().replace('x.mtl', 'part.mtl')) },
      { name: 'part.mtl', data: MTL },
    ];
    const archive = await createDeflatedZipBuffer(files);
    expect(await check(archive, { mimeType: ZIP_MIME })).toBeNull();
    const damaged = Buffer.from(archive);
    for (const [signature, offset] of [[LOCAL_HEADER, LOCAL_CRC_OFFSET], [CENTRAL_HEADER, CENTRAL_CRC_OFFSET]] as const) {
      for (let at = damaged.indexOf(signature); at !== -1; at = damaged.indexOf(signature, at + 1)) damaged[at + offset] ^= 0xff;
    }
    expect(await check(damaged, { mimeType: ZIP_MIME })).toBe('obj archive has an entry whose CRC-32 is wrong');
  });

  it('is refused with an entry name cut to MAX_SHOWN_CHARS characters', async () => {
    expect(await check(await zipOf({ 'x.obj': OBJ, 'x.mtl': MTL, [`${'n'.repeat(300)}.txt`]: 'hello' }), { mimeType: ZIP_MIME })).toBe(
      `obj archive holds an unexpected entry ${'n'.repeat(MAX_SHOWN_CHARS)}...`
    );
  });

  it('is refused when the bytes are not a ZIP, and when the output is empty', async () => {
    expect(await check(Buffer.from('PK\u0003\u0004 corrupt archive'), { mimeType: ZIP_MIME })).toBe('obj archive is not a readable ZIP');
    expect(await check(Buffer.alloc(0), { mimeType: ZIP_MIME })).toBe('empty output');
  });
});

describe.skipIf(!haveCadConverter)('the archive convertCadWithOcct returns for a coloured real model', () => {
  for (const id of ['cq-red_cube_blue_cylinder.step', 'pyocc-testfile.igs']) {
    it(`passes the gate: ${id}`, { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
      const { bytes, format } = await requireRealworldSample(ctx, id);
      const result = await convertCadWithOcct(bytes, format, 'obj');
      expect(result.mimeType).toBe(ZIP_MIME);
      expect(await check(result.buffer, { mimeType: result.mimeType })).toBeNull();
    });
  }
});

describe.skipIf(!haveCadConverter)('the archive convertCadWithOcct returns for a long outputName', () => {
  it('passes the gate with the stem cut to MAX_OUTPUT_NAME_CHARS', { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
    const { bytes, format } = await requireRealworldSample(ctx, 'cq-red_cube_blue_cylinder.step');
    const result = await convertCadWithOcct(bytes, format, 'obj', { outputName: 'n'.repeat(200) });
    expect(result.mimeType).toBe(ZIP_MIME);
    const names = (await objFiles(result)).names;
    expect(names).toEqual([`${'n'.repeat(MAX_OUTPUT_NAME_CHARS)}.mtl`, `${'n'.repeat(MAX_OUTPUT_NAME_CHARS)}.obj`]);
    expect(await check(result.buffer, { mimeType: result.mimeType })).toBeNull();
  });
});

describe('the helpers that read an OBJ and an MTL file back in tests', () => {
  it('sum the area under each material with the face indices resolved by the gate, negative ones included', () => {
    const obj = Buffer.from(`${TRIANGLE}v 1 1 0\nf 1 2 3\nusemtl Mat_1\nf -4 -3 -2\nf 2 4 3\nusemtl Mat_2\nf -3 -1 -2\n`);
    const areas = objMaterialAreas(obj);
    expect([...areas.keys()]).toEqual(['', 'Mat_1', 'Mat_2']);
    expect(areas.get('')).toBeCloseTo(0.5);
    expect(areas.get('Mat_1')).toBeCloseTo(1);
    expect(areas.get('Mat_2')).toBeCloseTo(0.5);
  });

  it('throw for an OBJ the gate refuses instead of reading it another way', () => {
    expect(() => objMaterialAreas(Buffer.from(`${TRIANGLE}f 1 2 4\n`))).toThrow(/vertex index 4/);
  });

  it('keep no vertex and no face in the reading the gate takes, only the materials', () => {
    const reading = readObj(OBJ);
    expect(reading).toEqual({ ok: true, mtllib: 'x.mtl', usedMaterials: ['Mat_1'], facedMaterials: new Set(['Mat_1']) });
    expect(Object.keys(reading).sort()).toEqual(['facedMaterials', 'mtllib', 'ok', 'usedMaterials']);
  });

  it('give the vertices and the faces with their materials to an observer, negative indices resolved', () => {
    const faces: Array<[string, readonly number[]]> = [];
    let vertices = 0;
    readObj(Buffer.from(`${TRIANGLE}f 1 2 3\nusemtl Mat_1\nf -1 -2 -3\n`), { onVertex: () => vertices++, onFace: (material, corners) => faces.push([material, corners]) });
    expect(vertices).toBe(3);
    expect(faces).toEqual([
      ['', [0, 1, 2]],
      ['Mat_1', [2, 1, 0]],
    ]);
  });

  it('read the Kd of each material, null for a material without one, and leave the vocabulary and the ranges to the gate', () => {
    const colours = mtlMaterials(Buffer.from('newmtl A\nKd 0.25 0.5 1\nmap_Kd wood.png\nnewmtl B\nKa 9 9 9\nnewmtl C\nKd 7 7 7\n'));
    expect([...colours]).toEqual([
      ['A', [0.25, 0.5, 1]],
      ['B', null],
      ['C', [7, 7, 7]],
    ]);
  });

  it('refuse the colours the gate refuses: hexadecimal, infinite and overflowing channels', () => {
    for (const channel of ['0x1', 'Infinity', '1e999', 'NaN']) {
      expect(parseColour([channel, '0', '0'])).toBeNull();
      expect(() => mtlMaterials(Buffer.from(`newmtl A\nKd ${channel} 0 0\n`))).toThrow(/Kd needs three numbers/);
    }
    expect(parseColour(['0.25', '1e-1', '+1'])).toEqual([0.25, 0.1, 1]);
  });

  it('throw for a material with no name and for a Kd that is not three numbers, instead of keying or reading them', () => {
    expect(() => mtlMaterials(Buffer.from('newmtl\nKd 1 1 1\n'))).toThrow(/newmtl needs one name, not 0/);
    expect(() => mtlMaterials(Buffer.from('newmtl A\nKd 1 x 1\n'))).toThrow(/Kd needs three numbers/);
    expect(() => mtlMaterials(Buffer.from('newmtl A\nKd 1 1\n'))).toThrow(/Kd needs three numbers/);
  });
});
