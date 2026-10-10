import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { convertFile } from '../src/lib/conversions';
import { ConversionFailedError } from '../src/lib/types';
import { OOXML_VARIANT_FAMILY, ooxmlVariantToPlainFormat } from '../src/lib/conversions/ooxml-variants';
import { craftDocx, paragraph } from './helpers/docx-craft';
import { pythonModuleAvailable, runPythonHelper } from './helpers/python-oracle';

/**
 * Macro-enabled, template and slideshow Office Open XML variants are read like their plain formats (#670). The packages
 * are written here from ECMA-376 markup with the fixture text known in advance, so the expected text and cells are
 * independent of the readers; python-docx refuses a package whose main part is not a document, which makes it the
 * oracle for the rewritten content type.
 */

const WORD_TEMPLATE_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml';
const WORD_DOCUMENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const EXCEL_MACRO_TYPE = 'application/vnd.ms-excel.sheet.macroEnabled.main+xml';
const EXCEL_WORKBOOK_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
const VBA_TYPE = 'application/vnd.ms-office.vbaProject';
const VBA_RELATIONSHIP = 'http://schemas.microsoft.com/office/2006/relationships/vbaProject';
const PARAGRAPHS = ['Quarterly review heading', 'Second paragraph about revenue growth'];
const SHEET_ROWS = [
  ['Region', 'Units', 'Note'],
  ['North', '12', 'plain'],
  ['South', '7', 'has, comma'],
];
const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';

async function wordVariant(mainType: string, withMacros: boolean): Promise<Buffer> {
  const plain = await craftDocx({ body: PARAGRAPHS.map(paragraph).join('') });
  const zip = await JSZip.loadAsync(plain);
  const macro = withMacros ? `<Default Extension="bin" ContentType="${VBA_TYPE}"/>` : '';
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="${TYPES_NS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${macro}<Override PartName="/word/document.xml" ContentType="${mainType}"/></Types>`
  );
  if (withMacros) {
    zip.file('word/vbaProject.bin', Buffer.from('not executed, never read'));
    zip.file(
      'word/_rels/document.xml.rels',
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="rId9" Type="${VBA_RELATIONSHIP}" Target="vbaProject.bin"/></Relationships>`
    );
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function cell(ref: string, text: string, strings: string[]): string {
  strings.push(text);
  return `<c r="${ref}" t="s"><v>${strings.length - 1}</v></c>`;
}

async function excelVariant(mainType: string, withMacros: boolean): Promise<Buffer> {
  const strings: string[] = [];
  const rows = SHEET_ROWS.map((row, r) => `<row r="${r + 1}">${row.map((text, c) => cell(`${'ABC'[c]}${r + 1}`, text, strings)).join('')}</row>`).join('');
  const zip = new JSZip();
  const macro = withMacros ? `<Default Extension="bin" ContentType="${VBA_TYPE}"/>` : '';
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="${TYPES_NS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${macro}<Override PartName="/xl/workbook.xml" ContentType="${mainType}"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`
  );
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL_NS}/sharedStrings" Target="sharedStrings.xml"/>${withMacros ? `<Relationship Id="rId3" Type="${VBA_RELATIONSHIP}" Target="vbaProject.bin"/>` : ''}</Relationships>`
  );
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${SHEET_NS}"><sheetData>${rows}</sheetData></worksheet>`);
  zip.file('xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="${SHEET_NS}" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((text) => `<si><t>${text}</t></si>`).join('')}</sst>`);
  if (withMacros) zip.file('xl/vbaProject.bin', Buffer.from('not executed, never read'));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const parseCsv = (text: string): string[][] => text.trim().split(/\r?\n/).map((line) => line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.filter((part) => part !== '').map((part) => part.replace(/,$/, '').replace(/^"(.*)"$/, '$1').replace(/""/g, '"')));

describe('Office Open XML variants are read like their plain formats', () => {
  it('reads a Word template as text and HTML, never as raw package bytes', async () => {
    const dotx = await wordVariant(WORD_TEMPLATE_TYPE, false);
    const text = await convertFile(dotx, 'dotx', 'txt', {}, 'resume.dotx');
    expect(text.buffer.toString('utf-8').trim().split(/\r?\n+/)).toEqual(PARAGRAPHS);
    const html = await convertFile(dotx, 'dotx', 'html', {}, 'resume.dotx');
    for (const line of PARAGRAPHS) expect(html.buffer.toString('utf-8')).toContain(line);
  });

  it('reads a macro-enabled workbook and a template workbook into the cells they hold', async () => {
    for (const [format, mainType] of [['xlsm', EXCEL_MACRO_TYPE], ['xltx', EXCEL_WORKBOOK_TYPE]] as const) {
      const variant = await excelVariant(mainType, format === 'xlsm');
      const csv = await convertFile(variant, format, 'csv', {}, `book.${format}`);
      expect(parseCsv(csv.buffer.toString('utf-8'))).toEqual(SHEET_ROWS);
    }
  });

  it('writes a template or macro-enabled document as a plain docx without the macro project', async () => {
    for (const [format, mainType] of [['dotx', WORD_TEMPLATE_TYPE], ['docm', 'application/vnd.ms-word.document.macroEnabled.main+xml']] as const) {
      const variant = await wordVariant(mainType, format === 'docm');
      const result =
        format === 'dotx'
          ? await convertFile(variant, format, 'docx', {}, `letter.${format}`)
          : await ooxmlVariantToPlainFormat(variant, format, 'docx', 'letter');
      const zip = await JSZip.loadAsync(result.buffer);
      const types = await zip.file('[Content_Types].xml')!.async('string');
      expect(types).toContain(`PartName="/word/document.xml" ContentType="${WORD_DOCUMENT_TYPE}"`);
      expect(types).not.toContain('vbaProject');
      expect(Object.keys(zip.files).filter((name) => name.includes('vbaProject'))).toEqual([]);
      expect(await zip.file('word/_rels/document.xml.rels')!.async('string')).not.toContain('vbaProject');
      expect(result.filename).toBe(`letter.docx`);
      expect(result.mimeType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      if (format === 'docm') expect(result.metadata).toEqual({ droppedMacros: true });
      if (pythonModuleAvailable('docx')) {
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ooxml-variant-')), 'out.docx');
        fs.writeFileSync(file, result.buffer);
        expect(runPythonHelper<{ text: string[] }>('docx_facts.py', [file]).text).toEqual(PARAGRAPHS);
      }
    }
  });

  it('refuses a variant without its main part with a typed error', async () => {
    const zip = await JSZip.loadAsync(await wordVariant(WORD_TEMPLATE_TYPE, false));
    zip.remove('word/document.xml');
    const broken = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(convertFile(broken, 'dotx', 'docx', {}, 'broken.dotx')).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(convertFile(Buffer.from('not a package'), 'xlsm', 'csv', {}, 'junk.xlsm')).rejects.toBeInstanceOf(ConversionFailedError);
  });

  it('names every variant family in the registry', () => {
    expect(Object.keys(OOXML_VARIANT_FAMILY).sort()).toEqual(['docm', 'dotm', 'dotx', 'pptm', 'potm', 'ppsm', 'ppsx', 'xltm', 'xltx', 'xlsm'].sort());
  });
});
