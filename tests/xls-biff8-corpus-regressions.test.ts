import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { convertFile, decodeRk, parseBiff8Workbook } from '../src/lib/conversions';
import { XLSX_MAX_CELL_TEXT_CHARS, XLS_MAX_GRID_CELLS } from '../src/lib/conversions/office';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { ConversionFailedError, EncryptedOfficeDocumentError, PayloadLimitError } from '../src/lib/types';
import { buildCompoundFile } from './helpers/cfb-craft';
import { oracleTest } from './helpers/oracle-test';
import { parseCsvWithPython } from './helpers/sheet-rows';
import { sofficeConvert } from './helpers/soffice-office';

/**
 * Regressions from the real-world corpus (issue 668): legacy Excel files that crashed the conversion.
 * Inputs are written by hand from the BIFF8 record layout of [MS-XLS]; expected values are worked out from the
 * specification (IEEE 754 bit patterns, record fields), not by calling the code under test.
 */

const BOF_RECORD = 0x0809;
const EOF_RECORD = 0x000a;
const FILEPASS_RECORD = 0x002f;
const NUMBER_RECORD = 0x0203;
const RK_RECORD = 0x027e;
const MULRK_RECORD = 0x00bd;
const SST_RECORD = 0x00fc;
const CONTINUE_RECORD = 0x003c;
const LABELSST_RECORD = 0x00fd;
const LABEL_RECORD = 0x0204;
const BIFF5_VERSION = 0x0500;
const BIFF8_VERSION = 0x0600;
const GLOBALS_SUBSTREAM = 0x0005;
const WORKSHEET_SUBSTREAM = 0x0010;

function record(id: number, data: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(id, 0);
  header.writeUInt16LE(data.length, 2);
  return Buffer.concat([header, data]);
}

function bof(substream: number, version = BIFF8_VERSION): Buffer {
  const data = Buffer.alloc(16);
  data.writeUInt16LE(version, 0);
  data.writeUInt16LE(substream, 2);
  return record(BOF_RECORD, data);
}

function rkCell(row: number, col: number, rk: number): Buffer {
  const data = Buffer.alloc(10);
  data.writeUInt16LE(row, 0);
  data.writeUInt16LE(col, 2);
  data.writeUInt32LE(rk, 6);
  return record(RK_RECORD, data);
}

function numberCell(row: number, col: number, value: number): Buffer {
  const data = Buffer.alloc(14);
  data.writeUInt16LE(row, 0);
  data.writeUInt16LE(col, 2);
  data.writeDoubleLE(value, 6);
  return record(NUMBER_RECORD, data);
}

function workbookStream(...cells: Buffer[]): Buffer {
  return Buffer.concat([bof(GLOBALS_SUBSTREAM), record(EOF_RECORD, Buffer.alloc(0)), bof(WORKSHEET_SUBSTREAM), ...cells, record(EOF_RECORD, Buffer.alloc(0))]);
}

/** FilePass bodies from [MS-XLS] 2.4.117: wEncryptionType, then the XOR key and hash or the RC4 header version. */
const XOR_FILEPASS = Buffer.from([0x00, 0x00, 0x34, 0x12, 0x78, 0x56]);
const RC4_FILEPASS = Buffer.concat([Buffer.from([0x01, 0x00, 0x01, 0x00, 0x01, 0x00]), Buffer.alloc(48, 0xab)]);
const CRYPTOAPI_FILEPASS = Buffer.concat([Buffer.from([0x01, 0x00, 0x04, 0x00, 0x02, 0x00]), Buffer.alloc(194, 0xcd)]);

/** The record that made the old reader allocate a 65536 by 256 grid when it decoded encrypted bytes as cells. */
const CORNER_CELL = numberCell(65535, 255, 1);

function encryptedWorkbook(filePass: Buffer): Buffer {
  return Buffer.concat([bof(GLOBALS_SUBSTREAM), record(FILEPASS_RECORD, filePass), CORNER_CELL, record(EOF_RECORD, Buffer.alloc(0))]);
}

describe('RK numbers (issue 668: RangeError on negative values)', () => {
  // -1.5 is 0xBFF8000000000000; an RK keeps the upper 30 bits of the double, so the word is 0xBFF80000.
  it('decodes a negative floating point RK', () => {
    expect(decodeRk(0xbff80000)).toBe(-1.5);
  });

  // -2.5 is 0xC004000000000000.
  it('decodes a negative floating point RK divided by 100', () => {
    expect(decodeRk(0xc0040001)).toBe(-2.5 / 100);
  });

  // fInt = 1, num = -3 as a 30-bit signed integer: (-3 << 2) | 2 = 0xFFFFFFF6.
  it('decodes a negative integer RK', () => {
    expect(decodeRk(0xfffffff6)).toBe(-3);
  });

  it('reads negative RK cells from RK and MULRK records into the sheet rows', () => {
    const mulrk = Buffer.alloc(4 + 12 + 2);
    mulrk.writeUInt16LE(1, 0);
    mulrk.writeUInt16LE(0, 2);
    mulrk.writeUInt32LE(0xbff80000, 6);
    mulrk.writeUInt32LE(0xfffffff6, 12);
    mulrk.writeUInt16LE(1, 16);
    const rows = parseBiff8Workbook(workbookStream(rkCell(0, 0, 0xc0040000), rkCell(0, 1, 0xfffffff6), record(MULRK_RECORD, mulrk)));
    expect(rows).toEqual([
      ['-2.5', '-3'],
      ['-1.5', '-3'],
    ]);
  });

  it('converts a raw BIFF8 workbook with negative RK cells to CSV', async () => {
    const converted = await convertFile(workbookStream(rkCell(0, 0, 0xbff80000), rkCell(0, 1, 0xfffffff6)), 'xls', 'csv', {}, 'negative.xls');
    expect(converted.buffer.toString('utf-8')).toBe('-1.5,-3');
  });

  oracleTest('negative numbers written by an office suite are read back as the same text', ['soffice', 'python3'], async () => {
    const workbook = sofficeConvert(Buffer.from('-1.5,-3,-0.25\n-1000000.5,2,-7\n'), 'csv', 'xls', 'xls');
    const converted = await convertFile(workbook, 'xls', 'csv', {}, 'written.xls');
    expect(parseCsvWithPython(converted.buffer.toString('utf-8'))).toEqual([
      ['-1.5', '-3', '-0.25'],
      ['-1000000.5', '2', '-7'],
    ]);
  });
});

describe('encrypted workbooks (issue 668: the job server aborted)', () => {
  const variants: Array<[string, Buffer]> = [
    ['XOR obfuscation', XOR_FILEPASS],
    ['RC4 encryption', RC4_FILEPASS],
    ['RC4 CryptoAPI encryption', CRYPTOAPI_FILEPASS],
  ];

  it.each(variants)('a raw BIFF8 stream with %s is refused as encrypted instead of its bytes being read as cells', (_name, filePass) => {
    expect(() => parseBiff8Workbook(encryptedWorkbook(filePass))).toThrow(EncryptedOfficeDocumentError);
  });

  describe.each(variants)('%s inside a compound file', (_name, filePass) => {
    const workbook = buildCompoundFile([{ name: 'Workbook', data: encryptedWorkbook(filePass) }]);

    it.each(['csv', 'tsv', 'json', 'html', 'ods', 'xlsx', 'pdf'])('is refused with status 422 for the .%s target', async (target) => {
      const failure = await convertFile(workbook, 'xls', target, {}, 'locked.xls').catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(EncryptedOfficeDocumentError);
      expect((failure as EncryptedOfficeDocumentError).status).toBe(422);
      expect((failure as Error).message).toMatch(/encrypted/i);
    });
  });
});

describe('oversized sheets and expansions (issue 668)', () => {
  it('refuses a sheet whose used range would need a 65536 by 256 grid for one cell', () => {
    expect(() => parseBiff8Workbook(workbookStream(numberCell(65535, 255, 1)))).toThrow(
      `The XLS sheet spans 65536 rows by 256 columns (16777216 cells); at most ${XLS_MAX_GRID_CELLS} are supported.`
    );
  });

  it('still reads a wide sheet that stays inside the cell limit', () => {
    const rows = parseBiff8Workbook(workbookStream(numberCell(1023, 255, 7)));
    expect(rows).toHaveLength(1024);
    expect(rows[1023][255]).toBe('7');
  });

  it('refuses a workbook whose shared string is repeated into more cell text than the limit', async () => {
    const hugeString = 'x'.repeat(1024 * 1024);
    const cells = Array.from({ length: 100 }, (_, i) => `<c r="A${i + 1}" t="s"><v>0</v></c>`);
    const sheet = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${cells
      .map((cell, i) => `<row r="${i + 1}">${cell}</row>`)
      .join('')}</sheetData></worksheet>`;
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
    zip.file('xl/workbook.xml', '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>');
    zip.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
    zip.file('xl/sharedStrings.xml', `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="100" uniqueCount="1"><si><t>${hugeString}</t></si></sst>`);
    zip.file('xl/worksheets/sheet1.xml', sheet);
    const workbook = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

    const failure = await convertFile(workbook, 'xlsx', 'csv', {}, 'amplified.xlsx').catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(PayloadLimitError);
    expect((failure as PayloadLimitError).status).toBe(413);
    expect((failure as Error).message).toBe(`The XLSX cells expand to more than ${XLSX_MAX_CELL_TEXT_CHARS} characters.`);
  });
});

describe('shared strings that continue in a CONTINUE record (issue 668: garbled text)', () => {
  /** An SST body: total and unique counts, then the strings as written by the caller. */
  const sstBody = (unique: number, ...strings: Buffer[]): Buffer => {
    const counts = Buffer.alloc(8);
    counts.writeUInt32LE(unique, 0);
    counts.writeUInt32LE(unique, 4);
    return Buffer.concat([counts, ...strings]);
  };
  /** An XLUnicodeRichExtendedString header: character count and the option flags (bit 0: UTF-16 characters). */
  const stringHeader = (chars: number, flags: number): Buffer => {
    const header = Buffer.alloc(3);
    header.writeUInt16LE(chars, 0);
    header.writeUInt8(flags, 2);
    return header;
  };
  const labelSst = (row: number, index: number): Buffer => {
    const data = Buffer.alloc(10);
    data.writeUInt16LE(row, 0);
    data.writeUInt32LE(index, 6);
    return record(LABELSST_RECORD, data);
  };
  const sstWorkbook = (sst: Buffer[], cells: Buffer[]): Buffer =>
    Buffer.concat([bof(GLOBALS_SUBSTREAM), ...sst, record(EOF_RECORD, Buffer.alloc(0)), bof(WORKSHEET_SUBSTREAM), ...cells, record(EOF_RECORD, Buffer.alloc(0))]);

  it('rejoins an 8-bit string split across records, where the continuation starts with its own flag byte', () => {
    // "Hello World" (11 characters): "Hello" ends the SST record, " World" follows in CONTINUE after a 0x00 flag.
    const first = sstBody(2, stringHeader(11, 0x00), Buffer.from('Hello', 'latin1'));
    const second = Buffer.concat([Buffer.from([0x00]), Buffer.from(' World', 'latin1'), stringHeader(2, 0x00), Buffer.from('ok', 'latin1')]);
    const rows = parseBiff8Workbook(sstWorkbook([record(SST_RECORD, first), record(CONTINUE_RECORD, second)], [labelSst(0, 0), labelSst(1, 1)]));
    expect(rows).toEqual([['Hello World'], ['ok']]);
  });

  it('switches character width at the continuation when the flag byte says so', () => {
    // "AB" + "\u00e9\u4e2d" in one string: "AB" as 8-bit before the split, the rest as UTF-16 after the 0x01 flag.
    const first = sstBody(1, stringHeader(4, 0x00), Buffer.from('AB', 'latin1'));
    const second = Buffer.concat([Buffer.from([0x01]), Buffer.from('\u00e9\u4e2d', 'utf16le')]);
    const rows = parseBiff8Workbook(sstWorkbook([record(SST_RECORD, first), record(CONTINUE_RECORD, second)], [labelSst(0, 0)]));
    expect(rows).toEqual([['AB\u00e9\u4e2d']]);
  });

  it('refuses a shared string table that ends in the middle of a string', () => {
    const truncated = sstBody(1, stringHeader(11, 0x00), Buffer.from('Hello', 'latin1'));
    expect(() => parseBiff8Workbook(sstWorkbook([record(SST_RECORD, truncated)], [labelSst(0, 0)]))).toThrow(/shared string/i);
  });

  oracleTest('strings that an office suite splits over CONTINUE records are read back unchanged', ['soffice', 'python3'], async () => {
    const lines = Array.from({ length: 1500 }, (_, i) => `item ${i} \u00e9\u4e2d\u6587 ${'x'.repeat(i % 37)}`);
    const workbook = sofficeConvert(Buffer.from(lines.join('\n') + '\n', 'utf-8'), 'csv', 'xls', 'xls');
    const converted = await convertFile(workbook, 'xls', 'csv', {}, 'strings.xls');
    expect(parseCsvWithPython(converted.buffer.toString('utf-8')).map((row) => row[0])).toEqual(lines);
  });
});

describe('BIFF5 workbooks and files that hold both streams (issue 668: first letters lost, text turned to CJK)', () => {
  /** A BIFF5 LABEL: row, column, XF index, character count, then the characters with no flag byte. */
  const biff5Label = (row: number, col: number, text: string): Buffer => {
    const data = Buffer.alloc(8 + text.length);
    data.writeUInt16LE(row, 0);
    data.writeUInt16LE(col, 2);
    data.writeUInt16LE(text.length, 6);
    data.write(text, 8, 'latin1');
    return record(LABEL_RECORD, data);
  };
  const biff5Stream = (...labels: Buffer[]): Buffer =>
    Buffer.concat([bof(GLOBALS_SUBSTREAM, BIFF5_VERSION), record(EOF_RECORD, Buffer.alloc(0)), bof(WORKSHEET_SUBSTREAM, BIFF5_VERSION), ...labels, record(EOF_RECORD, Buffer.alloc(0))]);

  it('reads the text of a BIFF5 LABEL without taking its first character for a flag byte', () => {
    expect(parseBiff8Workbook(biff5Stream(biff5Label(0, 0, 'Latitude'), biff5Label(0, 1, 'Private')))).toEqual([['Latitude', 'Private']]);
  });

  it('converts a BIFF5 workbook stored under the Book stream name', async () => {
    const workbook = buildCompoundFile([{ name: 'Book', data: biff5Stream(biff5Label(0, 0, 'Latitude')) }]);
    const converted = await convertFile(workbook, 'xls', 'csv', {}, 'old.xls');
    expect(converted.buffer.toString('utf-8')).toBe('Latitude');
  });

  it('reads the BIFF8 Workbook stream when the file also keeps a BIFF5 Book stream for old readers', async () => {
    const biff8 = Buffer.concat([
      bof(GLOBALS_SUBSTREAM),
      record(SST_RECORD, Buffer.concat([Buffer.from([1, 0, 0, 0, 1, 0, 0, 0, 8, 0, 0]), Buffer.from('Latitude', 'latin1')])),
      record(EOF_RECORD, Buffer.alloc(0)),
      bof(WORKSHEET_SUBSTREAM),
      record(LABELSST_RECORD, Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
      record(EOF_RECORD, Buffer.alloc(0)),
    ]);
    // The BIFF5 copy comes first in the directory and holds different text, so reading it would be visible.
    const workbook = buildCompoundFile([
      { name: 'Book', data: biff5Stream(biff5Label(0, 0, 'Old copy')) },
      { name: 'Workbook', data: biff8 },
    ]);
    const converted = await convertFile(workbook, 'xls', 'csv', {}, 'both.xls');
    expect(converted.buffer.toString('utf-8')).toBe('Latitude');
  });
});

describe('an encrypted workbook handed to the office suite (issue 668)', () => {
  oracleTest('is a typed error for a target the suite writes, not an untyped process failure', ['soffice'], async () => {
    const workbook = buildCompoundFile([{ name: 'Workbook', data: encryptedWorkbook(CRYPTOAPI_FILEPASS) }]);
    for (const target of ['ods', 'xlsx', 'png']) {
      const failure = await dispatchConversion(workbook, 'xls', target, {}, 'locked.xls').catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(ConversionFailedError);
      expect((failure as Error).message).toBe('LibreOffice could not read the .xls file: it is damaged, encrypted or not a valid XLS document.');
    }
  }, 120_000);
});
