import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { MACRO_STRIP_MAX_ENTRIES, MACRO_STRIP_MAX_TYPE_ELEMENTS, stripOfficeMacros } from '../src/lib/conversions/office-macro-strip';
import { ConversionFailedError } from '../src/lib/types';
import { officeInputWithoutMacros } from '../src/worker/office-input-checks';
import { craftDocx, paragraph } from './helpers/docx-craft';

/**
 * The macros of an office package are removed by what the package holds, not by the name of its format: a `.docx` with a VBA project
 * and an OpenDocument file with a Basic library lose them like a `.docm` does. The packages are written here part by part, so what the
 * checks read back (the parts that are left, the content types, the relationships, the manifest) is independent of the code under test.
 */

const TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const VBA_RELATIONSHIP = 'http://schemas.microsoft.com/office/2006/relationships/vbaProject';
const WORD_MACRO_MAIN = 'application/vnd.ms-word.document.macroEnabled.main+xml';
const WORD_MAIN = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';

const names = (zip: JSZip): string[] => Object.values(zip.files).filter((entry) => !entry.dir).map((entry) => entry.name);

/** A Word package that carries a VBA project at a name of its own choosing, declared by content type and by relationship. */
async function wordWithMacro(options: { mainType?: string; projectName?: string } = {}): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await craftDocx({ body: paragraph('Body text') }));
  const projectName = options.projectName ?? 'vbaProject.bin';
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="${TYPES_NS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${options.mainType ?? WORD_MAIN}"/><Override PartName="/word/${projectName}" ContentType="application/vnd.ms-office.vbaProject"/></Types>`
  );
  zip.file(`word/${projectName}`, Buffer.from('never read'));
  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="rId9" Type="${VBA_RELATIONSHIP}" Target="${projectName}"/></Relationships>`
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const ODF_MANIFEST = (entries: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>${entries}</manifest:manifest>`;

async function openDocument(withBasic: boolean): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });
  const entries = withBasic
    ? '<manifest:file-entry manifest:full-path="Basic/" manifest:media-type="application/binary"/><manifest:file-entry manifest:full-path="Basic/Standard/Module1.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="Scripts/python/run.py" manifest:media-type=""/>'
    : '';
  zip.file('META-INF/manifest.xml', ODF_MANIFEST(entries));
  zip.file('content.xml', '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>');
  if (withBasic) {
    zip.file('Basic/script-lc.xml', '<library/>');
    zip.file('Basic/Standard/Module1.xml', '<script:module/>');
    zip.file('Scripts/python/run.py', 'print("never run")');
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

describe('stripOfficeMacros', () => {
  it('removes the VBA project of a package whatever the format is called, with its content type and its relationship', async () => {
    const result = await stripOfficeMacros(await wordWithMacro());
    expect(result.droppedMacros).toBe(true);
    const zip = await JSZip.loadAsync(result.buffer);
    expect(names(zip).filter((name) => name.includes('vba'))).toEqual([]);
    expect(await zip.file('[Content_Types].xml')!.async('string')).not.toContain('vbaProject');
    expect(await zip.file('word/_rels/document.xml.rels')!.async('string')).not.toContain('vbaProject');
    expect(await zip.file('word/document.xml')!.async('string')).toContain('Body text');
  });

  it('finds a VBA project by its relationship and content type when the part has another name', async () => {
    const zip = await JSZip.loadAsync(await stripOfficeMacros(await wordWithMacro({ projectName: 'project-data.bin' })).then((r) => r.buffer));
    expect(names(zip).filter((name) => name.endsWith('.bin'))).toEqual([]);
  });

  it('writes the main part of a macro-enabled package with the plain content type', async () => {
    const result = await stripOfficeMacros(await wordWithMacro({ mainType: WORD_MACRO_MAIN }));
    const types = await (await JSZip.loadAsync(result.buffer)).file('[Content_Types].xml')!.async('string');
    expect(types).toContain(`PartName="/word/document.xml" ContentType="${WORD_MAIN}"`);
    expect(types).not.toContain('macroEnabled');
  });

  it('removes the Basic, dialog and script libraries of an OpenDocument file and their manifest entries, keeping the mimetype stored and first', async () => {
    const result = await stripOfficeMacros(await openDocument(true));
    expect(result.droppedMacros).toBe(true);
    const zip = await JSZip.loadAsync(result.buffer);
    expect(names(zip).sort()).toEqual(['META-INF/manifest.xml', 'content.xml', 'mimetype']);
    const manifest = await zip.file('META-INF/manifest.xml')!.async('string');
    expect(manifest).toContain('manifest:full-path="content.xml"');
    expect(manifest).not.toMatch(/Basic|Scripts/);
    // The package starts with the local header of `mimetype`, stored: its name and then its text follow the header at fixed offsets.
    expect(result.buffer.subarray(30, 38).toString('latin1')).toBe('mimetype');
    expect(result.buffer.readUInt16LE(8)).toBe(0);
    expect(result.buffer.subarray(38, 38 + 'application/vnd.oasis.opendocument.text'.length).toString('latin1')).toBe('application/vnd.oasis.opendocument.text');
  });

  it('returns the very buffer of a package without macros, of a file that is no package, and of a package it cannot open', async () => {
    const plain = await craftDocx({ body: paragraph('plain') });
    expect((await stripOfficeMacros(plain)).buffer).toBe(plain);
    const document = await openDocument(false);
    expect((await stripOfficeMacros(document)).buffer).toBe(document);
    const notPackage = Buffer.from('{\\rtf1 not a package}');
    expect((await stripOfficeMacros(notPackage)).buffer).toBe(notPackage);
    const damaged = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('damaged')]);
    expect(await stripOfficeMacros(damaged)).toEqual({ buffer: damaged, droppedMacros: false });
  });
});

/** A Word package whose content types and document relationships are the given markup, with the given extra parts. */
async function packageWith(options: { types: string; relationships?: string; parts?: Record<string, string> }): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await craftDocx({ body: paragraph('Body text') }));
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="${TYPES_NS}">${options.types}</Types>`);
  if (options.relationships !== undefined) {
    zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PACKAGE_REL_NS}">${options.relationships}</Relationships>`);
  }
  for (const [name, text] of Object.entries(options.parts ?? {})) zip.file(name, text);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const BASE_TYPES = `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${WORD_MAIN}"/>`;

describe('stripOfficeMacros on packages written in other ways', () => {
  it('removes a part that an Override or a Relationship names in the open-and-close form, with single quotes, attributes in any order and a ">" in a value', async () => {
    const buffer = await packageWith({
      types: `${BASE_TYPES}<Override ContentType='application/vnd.ms-office.vbaProject' PartName='/word/a.dat'></Override><Override Note="a > b" PartName="/word/b.dat" ContentType="application/vnd.ms-office.vbaProject" ></Override >`,
      relationships: `<Relationship Id="r1" Note="x>y" Type="${VBA_RELATIONSHIP}" Target="a.dat"></Relationship><Relationship Target='b.dat' Id='r2' Type='${VBA_RELATIONSHIP}'></Relationship>`,
      parts: { 'word/a.dat': 'macro a', 'word/b.dat': 'macro b' },
    });
    const result = await stripOfficeMacros(buffer);
    const zip = await JSZip.loadAsync(result.buffer);
    expect(result.droppedMacros).toBe(true);
    expect(names(zip).filter((name) => name.endsWith('.dat'))).toEqual([]);
    expect(await zip.file('[Content_Types].xml')!.async('string')).not.toMatch(/vbaProject|\.dat/);
    expect(await zip.file('word/_rels/document.xml.rels')!.async('string')).not.toMatch(/vbaProject|\.dat/);
    expect(await zip.file('[Content_Types].xml')!.async('string')).toContain(`PartName="/word/document.xml" ContentType="${WORD_MAIN}"`);
  });

  it('removes a part that another relationship also points at, even when that relationship has another type and comes first', async () => {
    const buffer = await packageWith({
      types: BASE_TYPES,
      relationships: `<Relationship Id="r0" Type="http://example.org/other" Target="shared.dat"/><Relationship Id="r1" Type="${VBA_RELATIONSHIP}" Target="shared.dat"/>`,
      parts: { 'word/shared.dat': 'macro' },
    });
    const zip = await JSZip.loadAsync((await stripOfficeMacros(buffer)).buffer);
    expect(names(zip).includes('word/shared.dat')).toBe(false);
    expect((await zip.file('word/_rels/document.xml.rels')!.async('string')).includes('shared.dat')).toBe(false);
  });

  it('removes the relationships part of a removed part', async () => {
    const buffer = await packageWith({
      types: `${BASE_TYPES}<Override PartName="/word/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/>`,
      parts: { 'word/vbaProject.bin': 'macro', 'word/_rels/vbaProject.bin.rels': `<Relationships xmlns="${PACKAGE_REL_NS}"/>` },
    });
    expect(names(await JSZip.loadAsync((await stripOfficeMacros(buffer)).buffer)).includes('word/_rels/vbaProject.bin.rels')).toBe(false);
  });

  it('removes the Excel 4.0 macro sheets of a workbook with their relationships, the sheet entries and the sheet scope of defined names', async () => {
    const zip = new JSZip();
    const sheetType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';
    zip.file('[Content_Types].xml', `<Types xmlns="${TYPES_NS}"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="${sheetType}"/><Override PartName="/xl/macrosheets/sheet2.xml" ContentType="application/vnd.ms-excel.macrosheet+xml"/><Override PartName="/xl/worksheets/sheet3.xml" ContentType="${sheetType}"/></Types>`);
    zip.file('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="A" sheetId="1" r:id="rId1"/><sheet name="Macro" sheetId="2" r:id="rId2"/><sheet name="C" sheetId="3" r:id="rId3"/></sheets><definedNames><definedName name="n0" localSheetId="0">A!$A$1</definedName><definedName name="n1" localSheetId="1">Macro!$A$1</definedName><definedName name="n2" localSheetId="2">C!$A$1</definedName></definedNames></workbook>');
    zip.file('xl/_rels/workbook.xml.rels', `<Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.microsoft.com/office/2006/relationships/xlMacrosheet" Target="macrosheets/sheet2.xml"/><Relationship Id="rId3" Type="x/worksheet" Target="worksheets/sheet3.xml"/></Relationships>`);
    for (const sheet of ['worksheets/sheet1.xml', 'macrosheets/sheet2.xml', 'worksheets/sheet3.xml']) zip.file(`xl/${sheet}`, '<worksheet/>');
    const result = await stripOfficeMacros(await zip.generateAsync({ type: 'nodebuffer' }));
    const out = await JSZip.loadAsync(result.buffer);
    expect(result.droppedMacros).toBe(true);
    expect(names(out).filter((name) => name.includes('macrosheet'))).toEqual([]);
    const workbook = await out.file('xl/workbook.xml')!.async('string');
    expect(workbook).not.toContain('Macro');
    expect(workbook).toContain('<sheet name="A" sheetId="1" r:id="rId1"/>');
    expect(workbook).toContain('<sheet name="C" sheetId="3" r:id="rId3"/>');
    expect(workbook).toContain('<definedName name="n0" localSheetId="0">');
    expect(workbook).not.toContain('name="n1"');
    // The defined name of the sheet after the removed one follows its sheet to index 1.
    expect(workbook).toContain('<definedName name="n2" localSheetId="1">');
    expect(await out.file('xl/_rels/workbook.xml.rels')!.async('string')).not.toContain('acrosheet');
    expect(await out.file('[Content_Types].xml')!.async('string')).not.toContain('acrosheet');
  });

  it('removes the Basic and script libraries of an embedded object of an OpenDocument file, by path segment', async () => {
    const zip = await JSZip.loadAsync(await openDocument(false));
    zip.file('META-INF/manifest.xml', ODF_MANIFEST('<manifest:file-entry manifest:full-path="Object 1/Basic/Standard/m.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="Object 1/Scripts/py/x.py" manifest:media-type=""/><manifest:file-entry manifest:full-path="MyBasic/keep.xml" manifest:media-type="text/xml"/>'));
    zip.file('Object 1/Basic/Standard/m.xml', '<m/>');
    zip.file('Object 1/Scripts/py/x.py', 'x');
    zip.file('Object 1/content.xml', '<c/>');
    zip.file('MyBasic/keep.xml', '<keep/>');
    zip.file('Pictures/Scripts-notes.png', 'png');
    const result = await stripOfficeMacros(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    const out = await JSZip.loadAsync(result.buffer);
    expect(names(out).sort()).toEqual(['META-INF/manifest.xml', 'MyBasic/keep.xml', 'Object 1/content.xml', 'Pictures/Scripts-notes.png', 'content.xml', 'mimetype']);
    const manifest = await out.file('META-INF/manifest.xml')!.async('string');
    expect(manifest).toContain('MyBasic/keep.xml');
    expect(manifest).not.toMatch(/Object 1\/(Basic|Scripts)/);
  });
});

describe('the cost of stripOfficeMacros does not depend on how the package is built', () => {
  /** Well under the 33 s the quadratic scan took on the same package, and the floor of a hang guard. */
  const MACRO_STRIP_HANG_GUARD_MS = 10_000;
  it('reads a package with 10,000 macro Default elements and 20,000 entries in a single pass (it took 33 s with a scan of the entries for each Default)', async () => {
    const defaults = Array.from({ length: 10_000 }, () => '<Default Extension="zz" ContentType="application/vnd.ms-office.vbaProject"/>').join('');
    const parts: Record<string, string> = {};
    for (let index = 0; index < 20_000; index++) parts[`word/p${index}.${index % 2 === 0 ? 'zz' : 'xml'}`] = 'x';
    const buffer = await packageWith({ types: BASE_TYPES + defaults, parts });
    const started = Date.now();
    const result = await stripOfficeMacros(buffer);
    const elapsed = Date.now() - started;
    expect(result.droppedMacros).toBe(true);
    expect(names(await JSZip.loadAsync(result.buffer)).filter((name) => name.endsWith('.zz'))).toEqual([]);
    // A scan of the entries for each Default took 33 s on this package; one pass ends far below that.
    expect(elapsed, `${elapsed} ms`).toBeLessThan(MACRO_STRIP_HANG_GUARD_MS);
  }, 60_000);

  it('refuses, as a typed error, a content types part past the element limit and a package past the entry limit', async () => {
    const elements = '<Default Extension="a" ContentType="application/xml"/>'.repeat(MACRO_STRIP_MAX_TYPE_ELEMENTS + 1);
    await expect(stripOfficeMacros(await packageWith({ types: BASE_TYPES + elements }))).rejects.toThrow(/more than the \d+ an office file may/);
    const zip = await JSZip.loadAsync(await packageWith({ types: BASE_TYPES }));
    for (let index = 0; index <= MACRO_STRIP_MAX_ENTRIES; index++) zip.file(`word/e${index}.xml`, '', { compression: 'STORE' });
    await expect(stripOfficeMacros(await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }))).rejects.toThrow(/more than the \d+ an office file may/);
  }, 120_000);
});

describe('officeInputWithoutMacros', () => {
  it('strips a package declared as a plain format, from memory and from a file', async () => {
    const withMacro = await wordWithMacro();
    for (const input of [withMacro, { inputBuffer: withMacro }]) {
      const handed = await officeInputWithoutMacros(input);
      const zip = await JSZip.loadAsync(Buffer.isBuffer(handed) ? handed : handed.inputBuffer!);
      expect(names(zip).filter((name) => name.includes('vba'))).toEqual([]);
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macro-strip-'));
    try {
      const file = path.join(dir, 'input.odt');
      fs.writeFileSync(file, await openDocument(true));
      const handed = await officeInputWithoutMacros({ inputPath: file });
      expect(Buffer.isBuffer(handed)).toBe(false);
      expect((handed as { inputPath?: string }).inputPath).toBeUndefined();
      expect(names(await JSZip.loadAsync((handed as { inputBuffer: Buffer }).inputBuffer))).not.toContain('Basic/script-lc.xml');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hands over the input itself when there is nothing to remove, and does not read a file that is no package', async () => {
    const plain = await craftDocx({ body: paragraph('plain') });
    expect(await officeInputWithoutMacros(plain)).toBe(plain);
    const payload = { inputBuffer: plain };
    expect(await officeInputWithoutMacros(payload)).toBe(payload);
    const legacy = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3]);
    expect(await officeInputWithoutMacros(legacy)).toBe(legacy);
    const missing = { inputPath: path.join(os.tmpdir(), 'macro-strip-no-such-file.docx') };
    expect(await officeInputWithoutMacros(missing)).toBe(missing);
  });
});

describe('a package that carries the macro parts of both families', () => {
  it('loses the OpenDocument Basic library as well as the VBA project', async () => {
    const zip = await JSZip.loadAsync(await wordWithMacro());
    zip.file('META-INF/manifest.xml', '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>');
    zip.file('Basic/Standard/Module1.xml', 'Sub Main\nEnd Sub');
    const result = await stripOfficeMacros(await zip.generateAsync({ type: 'nodebuffer' }));
    const left = names(await JSZip.loadAsync(result.buffer));
    expect(result.droppedMacros).toBe(true);
    expect(left.filter((name) => name.startsWith('Basic/') || name.endsWith('vbaProject.bin'))).toEqual([]);
  });
});

