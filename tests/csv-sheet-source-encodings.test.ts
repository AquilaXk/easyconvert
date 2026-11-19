import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions/index';

/**
 * CSV written as a spreadsheet by the office engine (XLSX, ODS) read its source as UTF-8, so a delimited text in UTF-16 or in a legacy
 * encoding came out as junk cells (U+0000 and U+FFFD), where CSV to JSON read it by the rule of the data engine: a byte order mark, the
 * `encoding` option, BOM-less UTF-16, UTF-8, then the scored legacy candidates. Both now use one decoder. The fixtures are
 * `tests/fixtures/data-text/PROVENANCE`: the same table as UTF-8 and transcoded by GNU iconv.
 */

const FIXTURES = path.join(__dirname, 'fixtures', 'data-text');
const read = (name: string): Buffer => fs.readFileSync(path.join(FIXTURES, name));

/** [encoded fixture, its UTF-8 original]. */
const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['korean.utf16le-bom.csv', 'korean.utf8.csv'],
  ['korean.cp949.csv', 'korean.utf8.csv'],
  ['japanese.utf16be-bom.csv', 'japanese.utf8.csv'],
  ['japanese.shift_jis.csv', 'japanese.utf8.csv'],
  ['chinese.gbk.csv', 'chinese.utf8.csv'],
  ['english.utf16le.csv', 'english.utf8.csv'],
  ['english.utf16be.csv', 'english.utf8.csv'],
  ['korean.utf8-bom.csv', 'korean.utf8.csv'],
];

/** The text of the cells of a workbook: the shared strings of an XLSX, or the content of an ODS. */
async function cellTextOf(workbook: Buffer, target: 'xlsx' | 'ods'): Promise<string> {
  const zip = await JSZip.loadAsync(workbook);
  const part = target === 'xlsx' ? 'xl/sharedStrings.xml' : 'content.xml';
  const xml = await zip.file(part)!.async('string');
  return target === 'ods' ? xml.slice(xml.indexOf('<office:body>')) : xml;
}

describe('delimited text of another encoding written as a spreadsheet', () => {
  it.each(PAIRS.flatMap(([encoded, original]) => (['xlsx', 'ods'] as const).map((target) => [encoded, original, target] as const)))(
    'reads %s as %s does, for .%s',
    async (encoded, original, target) => {
      const converted = await convertFile(read(encoded), 'csv', target, {}, 'data.csv');
      const expected = await convertFile(read(original), 'csv', target, {}, 'data.csv');
      const cells = await cellTextOf(converted.buffer, target);
      expect(cells).toBe(await cellTextOf(expected.buffer, target));
      expect(cells).not.toMatch(/�|_x0000_|\u0000/);
    }
  );

  it('reads a UTF-16LE .tsv with a byte order mark', async () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('이름\t나이\n홍길동\t30\n', 'utf16le')]);
    const cells = await cellTextOf((await convertFile(bytes, 'tsv', 'xlsx', {}, 'data.tsv')).buffer, 'xlsx');
    expect(cells).toBe(await cellTextOf((await convertFile(Buffer.from('이름\t나이\n홍길동\t30\n'), 'tsv', 'xlsx', {}, 'data.tsv')).buffer, 'xlsx'));
  });
});
