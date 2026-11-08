import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { convertOffice } from '../src/lib/conversions/office';
import { ooxmlVariantToPlainFormat } from '../src/lib/conversions/ooxml-variants';
import { stripOfficeMacros } from '../src/lib/conversions/office-macro-strip';
import { resolveZipPath } from '../src/lib/conversions/office/zip-path';
import { PayloadLimitError } from '../src/lib/types';
import { executeWorkerConversion, libreOfficePool } from '../src/worker/engines';
import { assertOfficeEmbeddedImagesWithinLimit, officeInputWithoutMacros } from '../src/worker/office-input-checks';
import { buildCompoundFile } from './helpers/cfb-craft';
import { craftDocx, paragraph } from './helpers/docx-craft';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * The gaps found in a review of the macro removal: every run of the office suite gets the package without its macros, whatever the
 * package calls its parts (an absolute target, a `.` or `..` segment, quotes, an open-and-close element), and a package the removal cannot
 * read as a whole is refused instead of being handed over unchecked.
 */

const TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const VBA_RELATIONSHIP = 'http://schemas.microsoft.com/office/2006/relationships/vbaProject';
const VBA_TYPE = 'application/vnd.ms-office.vbaProject';
const REL_TYPES = '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>';
const WORD_MAIN = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const WORD_TEMPLATE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml';
const WORD_MACRO_TEMPLATE = 'application/vnd.ms-word.template.macroEnabledTemplate.main+xml';
const names = (zip: JSZip): string[] => Object.values(zip.files).filter((entry) => !entry.dir).map((entry) => entry.name);

async function wordPackage(options: { mainType?: string; types?: string; relationships: string; parts: Record<string, string> }): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await craftDocx({ body: paragraph('Body text') }));
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="${TYPES_NS}">${REL_TYPES}<Override PartName="/word/document.xml" ContentType="${options.mainType ?? WORD_MAIN}"/>${options.types ?? ''}</Types>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0"?><Relationships xmlns="${PACKAGE_REL_NS}">${options.relationships}</Relationships>`);
  for (const [name, text] of Object.entries(options.parts)) zip.file(name, text);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function readText(buffer: Buffer, name: string): Promise<string> {
  return (await JSZip.loadAsync(buffer)).file(name)!.async('string');
}

describe('the package path of a target', () => {
  it('is normalised whether it starts at the package root or not', () => {
    expect(resolveZipPath('word', '/word/./vbaProject.bin')).toBe('word/vbaProject.bin');
    expect(resolveZipPath('word', '/word/sub/../macros.bin')).toBe('word/macros.bin');
    expect(resolveZipPath('word', './macros.bin')).toBe('word/macros.bin');
    expect(resolveZipPath('word/sub', '../macros.bin')).toBe('word/macros.bin');
  });
});

describe('a macro part reached by an unnormalised absolute target', () => {
  it.each(['/word/./blob.dat', '/word/sub/../blob.dat', '/word//blob.dat'])('is removed with the relationship that names it as %s', async (target) => {
    const buffer = await wordPackage({
      relationships: `<Relationship Id="r1" Type="${VBA_RELATIONSHIP}" Target="${target}"/>`,
      parts: { 'word/blob.dat': 'macro' },
    });
    const result = await stripOfficeMacros(buffer);
    expect(result.droppedMacros).toBe(true);
    expect(names(await JSZip.loadAsync(result.buffer))).not.toContain('word/blob.dat');
    expect(await readText(result.buffer, 'word/_rels/document.xml.rels')).not.toContain('blob.dat');
  });

  it('is removed from the plain-format write of a macro-enabled document too', async () => {
    const buffer = await wordPackage({
      mainType: 'application/vnd.ms-word.document.macroEnabled.main+xml',
      types: `<Override PartName="/word/macros.bin" ContentType="${VBA_TYPE}"/>`,
      relationships: `<Relationship Id="r1" Type="${VBA_RELATIONSHIP}" Target="/word/macros.bin"/>`,
      parts: { 'word/macros.bin': 'macro' },
    });
    for (const target of ['/word/macros.bin', './macros.bin']) {
      const variant = await JSZip.loadAsync(buffer);
      variant.file('word/_rels/document.xml.rels', `<Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="r1" Type="${VBA_RELATIONSHIP}" Target="${target}"/></Relationships>`);
      const result = await ooxmlVariantToPlainFormat(await variant.generateAsync({ type: 'nodebuffer' }), 'docm', 'docx', 'letter');
      expect(names(await JSZip.loadAsync(result.buffer)).filter((name) => name.includes('macros'))).toEqual([]);
      expect(await readText(result.buffer, 'word/_rels/document.xml.rels')).not.toContain('macros.bin');
      expect(result.metadata).toEqual({ droppedMacros: true });
    }
  });
});

describe('the plain-format write of a macro-enabled document', () => {
  it('removes what the removal for the office suite removes: quotes, open-and-close elements, vbaData, sub-part relationships', async () => {
    const buffer = await wordPackage({
      mainType: 'application/vnd.ms-word.document.macroEnabled.main+xml',
      types: `<Override ContentType='${VBA_TYPE}' PartName='/word/vbaProject.bin'></Override><Override PartName="/word/vbaData.xml" ContentType="application/vnd.ms-word.vbaData+xml"/>`,
      relationships: `<Relationship Id='r1' Type='${VBA_RELATIONSHIP}' Target='vbaProject.bin'></Relationship><Relationship Id="r2" Type="http://schemas.microsoft.com/office/2006/relationships/wordVbaData" Target="vbaData.xml"/>`,
      parts: {
        'word/vbaProject.bin': 'macro',
        'word/vbaData.xml': '<data/>',
        'word/_rels/vbaProject.bin.rels': `<Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="s1" Type="${VBA_RELATIONSHIP}" Target="signature.bin"/></Relationships>`,
        'word/signature.bin': 'signature',
      },
    });
    const result = await ooxmlVariantToPlainFormat(buffer, 'docm', 'docx', 'letter');
    const left = names(await JSZip.loadAsync(result.buffer));
    expect(left.filter((name) => /vba|signature/i.test(name))).toEqual([]);
    expect(await readText(result.buffer, '[Content_Types].xml')).not.toMatch(/vba/i);
    expect(await readText(result.buffer, '[Content_Types].xml')).toContain(`ContentType="${WORD_MAIN}"`);
  });

  it('removes the Excel 4.0 macro sheets of a macro-enabled workbook', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', `<Types xmlns="${TYPES_NS}"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/><Override PartName="/xl/macrosheets/sheet1.xml" ContentType="application/vnd.ms-excel.macrosheet+xml"/></Types>`);
    zip.file('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Macro" sheetId="1" r:id="rId1"/></sheets></workbook>');
    zip.file('xl/_rels/workbook.xml.rels', `<Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="rId1" Type="http://schemas.microsoft.com/office/2006/relationships/xlMacrosheet" Target="macrosheets/sheet1.xml"/></Relationships>`);
    zip.file('xl/macrosheets/sheet1.xml', '<worksheet/>');
    const result = await ooxmlVariantToPlainFormat(await zip.generateAsync({ type: 'nodebuffer' }), 'xlsm', 'xlsx', 'book');
    expect(names(await JSZip.loadAsync(result.buffer)).filter((name) => name.includes('macrosheet'))).toEqual([]);
    expect(await readText(result.buffer, 'xl/workbook.xml')).not.toContain('Macro');
  });

  it.each([
    ['dotx', 'docx', WORD_TEMPLATE, 'word/document.xml', 'wordprocessingml.document.main+xml'],
    ['dotm', 'docx', WORD_MACRO_TEMPLATE, 'word/document.xml', 'wordprocessingml.document.main+xml'],
  ])('writes a .%s as a package whose main part is the plain document (%s)', async (variant, family, mainType, part, expected) => {
    const buffer = await wordPackage({ mainType, relationships: '', parts: {} });
    const result = await convertOffice(buffer, variant, family, {}, `letter.${variant}`);
    expect(await readText(result.buffer, '[Content_Types].xml')).toContain(`PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.${expected}"`);
  });
});

describe('a template or slide show written as its own plain format', () => {
  it.each([
    ['xltx', 'xlsx', '/xl/workbook.xml', 'xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'],
    ['xltm', 'xlsx', '/xl/workbook.xml', 'xl/workbook.xml', 'application/vnd.ms-excel.template.macroEnabled.main+xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'],
    ['ppsx', 'pptx', '/ppt/presentation.xml', 'ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'],
    ['potm', 'pptx', '/ppt/presentation.xml', 'ppt/presentation.xml', 'application/vnd.ms-powerpoint.template.macroEnabled.main+xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'],
  ])('is rewritten by convertOffice for .%s to .%s with the main content type of the plain format', async (variant, family, partName, part, variantType, plainType) => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', `<Types xmlns="${TYPES_NS}"><Default Extension="xml" ContentType="application/xml"/><Override PartName="${partName}" ContentType="${variantType}"/></Types>`);
    zip.file(part, '<root/>');
    const result = await convertOffice(await zip.generateAsync({ type: 'nodebuffer' }), variant, family, {}, `file.${variant}`);
    expect(await readText(result.buffer, '[Content_Types].xml')).toContain(`PartName="${partName}" ContentType="${plainType}"`);
    expect(result.filename).toBe(`file.${family}`);
  });
});

describe('officeInputWithoutMacros keeps the family of a template or slide show', () => {
  it.each([
    ['dotm', WORD_MACRO_TEMPLATE, WORD_TEMPLATE],
    ['docm', 'application/vnd.ms-word.document.macroEnabled.main+xml', WORD_MAIN],
  ])('strips a .%s to the macro-free content type of its own kind', async (_variant, mainType, expected) => {
    const buffer = await wordPackage({
      mainType,
      types: `<Override PartName="/word/macros.bin" ContentType="${VBA_TYPE}"/>`,
      relationships: `<Relationship Id="r1" Type="${VBA_RELATIONSHIP}" Target="/word/macros.bin"/>`,
      parts: { 'word/macros.bin': 'macro' },
    });
    const handed = (await officeInputWithoutMacros(buffer)) as Buffer;
    expect(await readText(handed, '[Content_Types].xml')).toContain(`PartName="/word/document.xml" ContentType="${expected}"`);
    expect(names(await JSZip.loadAsync(handed)).filter((name) => name.includes('macros'))).toEqual([]);
  });
});

describe('an OpenDocument package', () => {
  const MANIFEST = (entries: string) =>
    `<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>${entries}</manifest:manifest>`;

  it('without a mimetype entry loses its Basic libraries, and so does a sub-document of any name', async () => {
    const zip = new JSZip();
    zip.file('META-INF/manifest.xml', MANIFEST('<manifest:file-entry manifest:full-path="Basic/Standard/m.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="subdoc/Basic/x.xml" manifest:media-type="text/xml"/>'));
    zip.file('content.xml', '<c/>');
    zip.file('Basic/Standard/m.xml', '<m/>');
    zip.file('subdoc/Basic/x.xml', '<x/>');
    zip.file('subdoc/Dialogs/d.xml', '<d/>');
    zip.file('subdoc/content.xml', '<c/>');
    const result = await stripOfficeMacros(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    expect(result.droppedMacros).toBe(true);
    const out = await JSZip.loadAsync(result.buffer);
    expect(names(out).sort()).toEqual(['META-INF/manifest.xml', 'content.xml', 'subdoc/content.xml']);
    expect(await out.file('META-INF/manifest.xml')!.async('string')).not.toContain('Basic');
  });
});

const sofficeMissing = skipWithoutTools('soffice');
describe.skipIf(sofficeMissing)('every run of the office suite gets the package without its macros', () => {
  afterEach(() => vi.restoreAllMocks());
  const macroDocm = () =>
    wordPackage({
      mainType: 'application/vnd.ms-word.document.macroEnabled.main+xml',
      types: `<Override PartName="/word/vbaProject.bin" ContentType="${VBA_TYPE}"/>`,
      relationships: `<Relationship Id="r1" Type="${VBA_RELATIONSHIP}" Target="vbaProject.bin"/>`,
      parts: { 'word/vbaProject.bin': 'macro' },
    });
  const openDocumentWithBasic = async () => {
    const zip = new JSZip();
    zip.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet', { compression: 'STORE' });
    zip.file('META-INF/manifest.xml', '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="Basic/Standard/m.xml" manifest:media-type="text/xml"/></manifest:manifest>');
    zip.file('content.xml', '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>');
    zip.file('Basic/Standard/m.xml', '<m/>');
    return zip.generateAsync({ type: 'nodebuffer' });
  };

  type SuiteInput = Buffer | { inputBuffer?: Buffer; inputPath?: string };
  async function inputsOfSuiteRuns(buffer: Buffer, source: string, target: string): Promise<SuiteInput[]> {
    const seen: SuiteInput[] = [];
    vi.spyOn(libreOfficePool, 'isEnabled').mockReturnValue(true);
    vi.spyOn(libreOfficePool, 'convert').mockImplementation(async (input) => {
      seen.push(input);
      throw new Error('stop after the input is seen');
    });
    await executeWorkerConversion(buffer, source, target, {}, `file.${source}`).catch(() => undefined);
    return seen;
  }

  async function hasMacros(input: SuiteInput): Promise<boolean> {
    const bytes = Buffer.isBuffer(input) ? input : (input.inputBuffer ?? fs.readFileSync(input.inputPath!));
    return Object.keys((await JSZip.loadAsync(bytes)).files).some((name) => /vbaProject|^Basic\//.test(name));
  }

  it.each([
    ['a target the suite writes', 'docm', 'pdf', macroDocm],
    ['a presentation written as Markdown through a PDF', 'pptm', 'md', macroDocm],
    ['a spreadsheet written as .xls through an XLSX workbook', 'ods', 'xls', openDocumentWithBasic],
  ])('is the case for %s', async (_what, source, target, make) => {
    const seen = await inputsOfSuiteRuns(await make(), source, target);
    expect(seen.length).toBeGreaterThan(0);
    for (const input of seen) expect(await hasMacros(input)).toBe(false);
  });
});

describe('the macro-removal of a package the removal cannot hold', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'macro-strip-limit-'));
  const original = process.env.MAX_IN_MEMORY_BYTES;
  afterEach(() => {
    if (original === undefined) delete process.env.MAX_IN_MEMORY_BYTES;
    else process.env.MAX_IN_MEMORY_BYTES = original;
  });
  afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

  it('refuses a ZIP package larger than the in-memory limit with the 413 of the other limits, and hands over a larger file that is no package', async () => {
    const bytes = await craftDocx({ body: paragraph('x'.repeat(2000)) });
    const zipFile = path.join(scratch, 'big.bin');
    fs.writeFileSync(zipFile, bytes);
    const legacy = path.join(scratch, 'old.bin');
    fs.writeFileSync(legacy, Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(bytes.length)]));
    process.env.MAX_IN_MEMORY_BYTES = String(Math.floor(bytes.length / 2));
    await expect(officeInputWithoutMacros({ inputPath: zipFile })).rejects.toBeInstanceOf(PayloadLimitError);
    await expect(assertOfficeEmbeddedImagesWithinLimit({ inputPath: zipFile })).rejects.toBeInstanceOf(PayloadLimitError);
    const handedLegacy = { inputPath: legacy };
    expect(await officeInputWithoutMacros(handedLegacy)).toBe(handedLegacy);
    await expect(assertOfficeEmbeddedImagesWithinLimit(handedLegacy)).resolves.toBeUndefined();
  });
});

describe.skipIf(sofficeMissing)('a package past the in-memory limit handed to the office suite', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'macro-strip-limit-run-'));
  const original = process.env.MAX_IN_MEMORY_BYTES;
  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
    if (original === undefined) delete process.env.MAX_IN_MEMORY_BYTES;
    else process.env.MAX_IN_MEMORY_BYTES = original;
  });

  it.each([
    ['docx', 'pdf'],
    ['docm', 'pdf'],
    ['pptm', 'md'],
  ])('is refused with the 413 of the other limits for a .%s written as %s', async (format, target) => {
    const bytes = await craftDocx({ body: paragraph('x'.repeat(2000)) });
    const zipFile = path.join(scratch, `big-${format}.bin`);
    fs.writeFileSync(zipFile, bytes);
    process.env.MAX_IN_MEMORY_BYTES = String(Math.floor(bytes.length / 2));
    await expect(executeWorkerConversion({ inputPath: zipFile }, format, target, {}, `big.${format}`)).rejects.toMatchObject({ name: 'PayloadLimitError', status: 413 });
  });
});

describe('an encrypted package under the name of a macro-enabled format', () => {
  const encrypted = buildCompoundFile([
    { name: 'EncryptionInfo', data: Buffer.alloc(224, 3) },
    { name: 'EncryptedPackage', data: Buffer.alloc(3000, 7) },
  ]);

  it.each(['docm', 'xlsm', 'pptm', 'dotx', 'xltm', 'ppsx'])('is handed on as it is under .%s, not refused as a damaged package', async () => {
    expect(await officeInputWithoutMacros(encrypted)).toBe(encrypted);
  });

  it.each(['docm', 'xlsm', 'dotx'])('is answered with the 422 of an encrypted document by a conversion of a .%s', async (format) => {
    await expect(executeWorkerConversion(encrypted, format, 'pdf', {}, `locked.${format}`)).rejects.toMatchObject({ name: 'EncryptedOfficeDocumentError', status: 422 });
  });
});
