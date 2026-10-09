import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { convertFile } from '../src/lib/conversions';
import { parseCsvWithPython } from './helpers/sheet-rows';
import { xlsxRowsWithPython } from './helpers/xlsx-rows';

/** Cells that RFC 4180 section 2.6 requires to be enclosed in double quotes (delimiter, quote, CR/LF) plus a tab. */
const GRID: string[][] = [
  ['a,b', 'say "hi"', 'line1\nline2', 'tab\there'],
  ['plain', 'x', 'y', 'z'],
];

const BOF_RECORD = 0x0809;
const EOF_RECORD = 0x000a;
const SST_RECORD = 0x00fc;
const LABELSST_RECORD = 0x00fd;

function record(id: number, data: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(id, 0);
  header.writeUInt16LE(data.length, 2);
  return Buffer.concat([header, data]);
}

function bof(substream: number): Buffer {
  const data = Buffer.alloc(16);
  data.writeUInt16LE(0x0600, 0);
  data.writeUInt16LE(substream, 2);
  return record(BOF_RECORD, data);
}

/** A BIFF8 workbook whose cells are LABELSST records over one SST of UTF-16 strings. */
function xlsWorkbook(grid: string[][]): Buffer {
  const flat = grid.flat();
  const counts = Buffer.alloc(8);
  counts.writeUInt32LE(flat.length, 0);
  counts.writeUInt32LE(flat.length, 4);
  const strings = flat.map((text) => {
    const header = Buffer.alloc(3);
    header.writeUInt16LE(text.length, 0);
    header.writeUInt8(1, 2);
    return Buffer.concat([header, Buffer.from(text, 'utf16le')]);
  });
  const labels = flat.map((_, index) => {
    const data = Buffer.alloc(10);
    data.writeUInt16LE(Math.floor(index / grid[0].length), 0);
    data.writeUInt16LE(index % grid[0].length, 2);
    data.writeUInt32LE(index, 6);
    return record(LABELSST_RECORD, data);
  });
  const eof = record(EOF_RECORD, Buffer.alloc(0));
  return Buffer.concat([bof(0x0005), record(SST_RECORD, Buffer.concat([counts, ...strings])), eof, bof(0x0010), ...labels, eof]);
}

const escapeXml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

async function xlsxWorkbook(grid: string[][]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>',
  );
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>');
  const flat = grid.flat();
  zip.file('xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${flat.length}" uniqueCount="${flat.length}">${flat.map((t) => `<si><t xml:space="preserve">${escapeXml(t)}</t></si>`).join('')}</sst>`);
  const rows = grid
    .map((row, r) => `<row r="${r + 1}">${row.map((_, c) => `<c r="${String.fromCharCode(65 + c)}${r + 1}" t="s"><v>${r * row.length + c}</v></c>`).join('')}</row>`)
    .join('');
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`);
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

async function odsWorkbook(grid: string[][]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet', { compression: 'STORE' });
  const rows = grid
    .map((row) => `<table:table-row>${row.map((t) => `<table:table-cell office:value-type="string"><text:p>${escapeXml(t)}</text:p></table:table-cell>`).join('')}</table:table-row>`)
    .join('');
  zip.file(
    'content.xml',
    `<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:spreadsheet><table:table table:name="Sheet1">${rows}</table:table></office:spreadsheet></office:body></office:document-content>`,
  );
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

const SOURCES: Array<{ format: string; build: () => Promise<Buffer> | Buffer }> = [
  { format: 'xls', build: () => xlsWorkbook(GRID) },
  { format: 'xlsx', build: () => xlsxWorkbook(GRID) },
  { format: 'ods', build: () => odsWorkbook(GRID) },
];

describe('spreadsheet to CSV/TSV quotes fields per RFC 4180 (issue 668)', () => {
  for (const { format, build } of SOURCES) {
    for (const target of ['csv', 'tsv'] as const) {
      it(`${format} to ${target} round-trips cells with delimiters, quotes and line breaks`, async () => {
        const converted = await convertFile(await build(), format, target, {}, `quoting.${format}`);
        const rows = parseCsvWithPython(converted.buffer.toString('utf-8'), target === 'tsv' ? '\t' : ',');
        expect(rows).toEqual(GRID);
      });
    }
  }
});

describe('spreadsheet to XLSX keeps awkward cells intact (issue 668)', () => {
  for (const { format, build } of SOURCES.filter((source) => source.format !== 'xlsx')) {
    it(`${format} to xlsx keeps delimiters and quotes inside their cells`, async () => {
      const converted = await convertFile(await build(), format, 'xlsx', {}, `quoting.${format}`);
      expect(xlsxRowsWithPython(converted.buffer)).toEqual(GRID);
    });
  }
});
