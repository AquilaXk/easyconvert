import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertFile, parseBiff8Workbook } from '../src/lib/conversions';
import { buildCompoundFile } from './helpers/cfb-craft';
import { requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { sofficeConvert } from './helpers/soffice-office';

/**
 * Legacy workbooks to PDF keep every worksheet apart and every word whole. The first expectations are worked out from the
 * BIFF8 record layout of [MS-XLS] (BOUNDSHEET 2.4.28, LABELSST 2.4.149, COLINFO 2.4.48); the office-suite cases let LibreOffice
 * author a workbook and compare the words of the PDF with the words that were put in.
 */

const BOF = 0x0809;
const EOF = 0x000a;
const SST = 0x00fc;
const LABELSST = 0x00fd;
const BOUNDSHEET = 0x0085;
const BIFF8_VERSION = 0x0600;
const GLOBALS = 0x0005;
const WORKSHEET = 0x0010;
const WORD = /[\p{L}\p{N}]+/gu;

const record = (id: number, data: Buffer): Buffer => {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(id, 0);
  header.writeUInt16LE(data.length, 2);
  return Buffer.concat([header, data]);
};

const bof = (substream: number): Buffer => {
  const data = Buffer.alloc(16);
  data.writeUInt16LE(BIFF8_VERSION, 0);
  data.writeUInt16LE(substream, 2);
  return record(BOF, data);
};

const eof = (): Buffer => record(EOF, Buffer.alloc(0));

/** A BOUNDSHEET: the stream position of the sheet's BOF, visible worksheet, then the name as a BIFF8 short unicode string. */
const boundSheet = (position: number, name: string): Buffer => {
  const data = Buffer.alloc(8 + name.length);
  data.writeUInt32LE(position, 0);
  data[6] = name.length;
  data[7] = 0;
  data.write(name, 8, 'latin1');
  return record(BOUNDSHEET, data);
};

const sst = (strings: readonly string[]): Buffer => {
  const parts = strings.map((text) => Buffer.concat([Buffer.from([text.length & 0xff, text.length >> 8, 0]), Buffer.from(text, 'latin1')]));
  const head = Buffer.alloc(8);
  head.writeUInt32LE(strings.length, 0);
  head.writeUInt32LE(strings.length, 4);
  return record(SST, Buffer.concat([head, ...parts]));
};

const labelSst = (row: number, col: number, index: number): Buffer => {
  const data = Buffer.alloc(10);
  data.writeUInt16LE(row, 0);
  data.writeUInt16LE(col, 2);
  data.writeUInt32LE(index, 6);
  return record(LABELSST, data);
};

/** A workbook stream with one worksheet per entry of `sheets` (name and the SST indexes of its cells in row 0). */
function workbookStream(strings: readonly string[], sheets: ReadonlyArray<{ name: string; cells: readonly number[] }>): Buffer {
  const globalsLength = (positions: readonly number[]): Buffer =>
    Buffer.concat([bof(GLOBALS), ...sheets.map((sheet, i) => boundSheet(positions[i], sheet.name)), sst(strings), eof()]);
  const bodies = sheets.map((sheet) => Buffer.concat([bof(WORKSHEET), ...sheet.cells.map((index, col) => labelSst(0, col, index)), eof()]));
  const globalsSize = globalsLength(sheets.map(() => 0)).length;
  const positions: number[] = [];
  let at = globalsSize;
  for (const body of bodies) {
    positions.push(at);
    at += body.length;
  }
  return Buffer.concat([globalsLength(positions), ...bodies]);
}

function pdfWords(pdf: Buffer): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xls-pdf-'));
  try {
    fs.writeFileSync(path.join(dir, 'out.pdf'), pdf);
    const text = execFileSync(requireOracleTool('pdftotext'), ['-enc', 'UTF-8', path.join(dir, 'out.pdf'), '-'], { encoding: 'utf-8' });
    return (text.toLowerCase().match(WORD) ?? []).sort();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const sortedWords = (text: string): string[] => (text.toLowerCase().match(WORD) ?? []).sort();

describe('legacy workbook to PDF keeps every worksheet', () => {
  const strings = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];
  const stream = workbookStream(strings, [
    { name: 'First', cells: [0, 1, 2] },
    { name: 'Second', cells: [3, 4, 5] },
  ]);
  const workbook = buildCompoundFile([{ name: 'Workbook', data: stream }]);

  it('overlays the worksheets for the text targets as before', () => {
    expect(parseBiff8Workbook(stream)).toEqual([['Delta', 'Echo', 'Foxtrot']]);
  });

  oracleTest('writes the words of the second worksheet beside the first, not over it', ['pdftotext'], async () => {
    const result = await convertFile(workbook, 'xls', 'pdf', {}, 'two-sheets.xls');
    expect(pdfWords(result.buffer)).toEqual(sortedWords(strings.join(' ')));
  });
});

describe('legacy workbook to PDF never breaks a word', () => {
  const PARTS = ['063W', '50V', 'SOT23', 'MAX6626PMUT', '08055A101JAT2A', 'MC7805ACD2T', 'Aircore', 'Kyocera'];
  const cell = (text: string): string => `<table:table-cell office:value-type="string"><text:p>${text}</text:p></table:table-cell>`;
  const row = (texts: readonly string[]): string => `<table:table-row>${texts.map(cell).join('')}</table:table-row>`;
  const table = (name: string, rows: readonly string[]): string => `<table:table table:name="${name}">${rows.join('')}</table:table>`;
  const flatOds = (...tables: string[]): Buffer =>
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
        'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
        'office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.spreadsheet"><office:body><office:spreadsheet>' +
        `${tables.join('')}</office:spreadsheet></office:body></office:document>`,
      'utf-8'
    );

  oracleTest('keeps part numbers whole in a workbook with more columns than a page holds', ['soffice', 'pdftotext'], async () => {
    // Seventeen columns of unbroken part numbers cannot all be squeezed into one page width without cutting a word.
    const wide = Array.from({ length: 6 }, (_, r) => row(Array.from({ length: 17 }, (_, c) => `${PARTS[(r + c) % PARTS.length]}${c}`)));
    const second = [row(['Philips', 'Rohm', 'Resist']), row(['Kyocera', 'Trans', 'Sensor'])];
    const workbook = sofficeConvert(flatOds(table('Parts', wide), table('Notes', second)), 'fods', 'xls', 'xls');
    const result = await convertFile(workbook, 'xls', 'pdf', {}, 'parts.xls');
    const expected = [...wide.flatMap((r) => [...r.matchAll(/<text:p>([^<]*)<\/text:p>/g)].map((m) => m[1])), 'Philips', 'Rohm', 'Resist', 'Kyocera', 'Trans', 'Sensor'];
    expect(pdfWords(result.buffer)).toEqual(sortedWords(expected.join(' ')));
  }, 180_000);
});
