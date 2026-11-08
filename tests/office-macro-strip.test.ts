import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { stripOfficeMacros } from '../src/lib/conversions/office-macro-strip';
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

describe('officeInputWithoutMacros', () => {
  it('strips a package declared as a plain format, from memory and from a file', async () => {
    const withMacro = await wordWithMacro();
    for (const input of [withMacro, { inputBuffer: withMacro }]) {
      const handed = await officeInputWithoutMacros(input, 'docx');
      const zip = await JSZip.loadAsync(Buffer.isBuffer(handed) ? handed : handed.inputBuffer!);
      expect(names(zip).filter((name) => name.includes('vba'))).toEqual([]);
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macro-strip-'));
    try {
      const file = path.join(dir, 'input.odt');
      fs.writeFileSync(file, await openDocument(true));
      const handed = await officeInputWithoutMacros({ inputPath: file }, 'odt');
      expect(Buffer.isBuffer(handed) ? handed.length : 0).toBeGreaterThan(0);
      expect(names(await JSZip.loadAsync(handed as Buffer))).not.toContain('Basic/script-lc.xml');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hands over the input itself when there is nothing to remove, and does not read a file that is no package', async () => {
    const plain = await craftDocx({ body: paragraph('plain') });
    expect(await officeInputWithoutMacros(plain, 'docx')).toBe(plain);
    const payload = { inputBuffer: plain };
    expect(await officeInputWithoutMacros(payload, 'docx')).toBe(payload);
    const legacy = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3]);
    expect(await officeInputWithoutMacros(legacy, 'doc')).toBe(legacy);
    const missing = { inputPath: path.join(os.tmpdir(), 'macro-strip-no-such-file.docx') };
    expect(await officeInputWithoutMacros(missing, 'docx')).toBe(missing);
  });
});
