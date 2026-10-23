import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions/index';
import { parseDelimitedRecords, raggedRowWarnings } from '../src/lib/conversions/delimited-detect';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * Delimited text whose records do not all have the header's number of fields (#783: 21 CSV files and one TSV of the government
 * and archive corpora were refused with "Too many fields" / "Too few fields"). RFC 4180 section 2 says each line "should contain
 * the same number of fields", which is a recommendation: the readers in use take the file as it is. Python `csv` returns each
 * record as it has fields; `csv.DictReader` fills a short record with `restval` and keeps the surplus of a long one; pandas'
 * tokenizer (`end_line`) pads a short record with empty fields; LibreOffice's text import (`ScImportExport::ExtText2Doc`)
 * widens the sheet to the widest line and leaves the missing cells empty. So a short record is filled out with empty cells and a
 * long one widens the table, its extra columns named as pandas names a header cell that has no name (`Unnamed: <index>`), and
 * the conversion says so in its warnings.
 *
 * Expected tables come from Python 3.13 `csv.reader` (`python3 -I`), which shares no code with papaparse: the records with blank
 * lines dropped, each padded with '' to the widest record, as the digest of `json.dumps(rows[1:], ensure_ascii=False,
 * separators=(',', ':'))`. Files that are not UTF-8 are decoded as Windows-1252 there, as the data engine reads them.
 */

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

interface Expected {
  /** Fields of the header record. */
  header: number;
  /** Fields of the widest record, the width of the table. */
  width: number;
  records: number;
  sha256: string;
}

const REAL_TABLES: ReadonlyArray<readonly [id: string, expected: Expected]> = [
  ['govdocs1-001283.csv', { header: 18, width: 18, records: 249, sha256: 'b90cac6ddc108318287c85b6fe976c5f8572426924cf506b4597372917361429' }],
  ['govdocs1-006074.csv', { header: 29, width: 32, records: 38, sha256: '4f1913ee90cb032d80baf0060edfdc10cd8f3bb33c29a2352ae2ea296d3f73c8' }],
  ['govdocs1-000689.csv', { header: 10, width: 11, records: 12, sha256: '19e9929a78d12d912e0db6ea110b2ec4014e799d82c85c3538c20786f2cc8e3e' }],
  ['govdocs1-003208.csv', { header: 2, width: 14, records: 117, sha256: '1fa6a18053e9adc4552898bc3327dd30ce0df05aff37cef0ca68c523f91a5cac' }],
  ['govdocs1-004015.csv', { header: 19, width: 19, records: 26, sha256: '43c179dd72e7c9a92459fce92ba7ac5719595bea5f9a423c44cde6090454c643' }],
  ['govdocs1-004862.csv', { header: 18, width: 18, records: 249, sha256: '65546a8464d2f724e6b00c7c9dbecc43fd8a7b64502a2614ade9d45f853a92f1' }],
  ['govdocs1-007714.csv', { header: 11, width: 11, records: 976, sha256: '1c86c59b7f3a6bf7d59260f175b457082de3166fb4b8b0310d54c25adef74dbf' }],
  ['govdocs1-006049.csv', { header: 19, width: 19, records: 32, sha256: 'e95612abed7cafba6c874af4a08bce1601f7faf2fce3b2e9d555eeafb17acbee' }],
  ['govdocs1-007164.csv', { header: 8, width: 10, records: 61, sha256: 'e5a224935b335049d4fcadaa5d4ece44f964b08f8eb41049c771b20ae3e9f748' }],
  ['govdocs1-007166.csv', { header: 16, width: 16, records: 24, sha256: '83c349ad4d2814ff140935a1642a50bed9a9cbe35aae3ce68a85866d518540ff' }],
  ['govdocs1-001219.csv', { header: 49, width: 49, records: 45, sha256: 'c83364726e19764858dd5a8cb3b10290691e278c890484c26c2259d8c3a0902b' }],
  ['govdocs1-001507.csv', { header: 5, width: 8, records: 2399, sha256: '7e1f81ee8a718898eb825ff509683883584979b1d3b253c03f7bf1ec5560f822' }],
  ['govdocs1-008893.csv', { header: 25, width: 27, records: 109, sha256: 'c66b112822d63537539bac97ac0979ad7a0289ffd4fbfca8da6f8d7d2c74367a' }],
  ['govdocs1-001904.csv', { header: 8, width: 10, records: 285, sha256: '72709fc00e945823a5d3807b8d368729884b5b18db7d23d8f0da16d8130eea51' }],
  ['govdocs1-008897.csv', { header: 10, width: 12, records: 43, sha256: '5f72897cadf1db1fa03cf31c1240b0656eaaeb015d06a1e4adf9fb243ae83bb2' }],
  ['govdocs1-000721.csv', { header: 8, width: 8, records: 135, sha256: '83a7f51a659a4b5b9ccb8d32f1dadf0d233ae5e2b2d6f3a5529fe4c384ba6d26' }],
  ['govdocs1-006776.csv', { header: 13, width: 14, records: 95, sha256: '2dc3cb1a324b92586ce9dd907cda04a73d8f160c4d9f3207fa24463ed5d221ee' }],
  ['govdocs1-006857.csv', { header: 13, width: 14, records: 95, sha256: '0abf9da629c009809e9787fc2f634cc45f5fd244722302ea7b3c6a98e12eb31e' }],
  ['govdocs1-008910.csv', { header: 8, width: 9, records: 38, sha256: '407c387307836c24c40c40cb819a9decb8d0c9f226655def6ab5f6e6ccfe1225' }],
  ['govdocs1-000722.csv', { header: 8, width: 9, records: 34, sha256: '7b8004bdf22d68e1abadd4b34e063ae2227b4a8fcc2af228fb4998fa2f657729' }],
  ['govdocs1-001906.csv', { header: 8, width: 10, records: 122, sha256: 'aa143e9aeb3f5ff51fc9d238ac466dc92d20a32c452c383db109d8bca8947ef2' }],
  ['tika-migration-overlay.tsv', { header: 1, width: 3, records: 272, sha256: 'faab3c1eed3010e4f3bc5488addf088911681035bdbe2a4b0cd7c5a87a486374' }],
] as const;

type JsonRecord = Record<string, string>;

async function tableOf(bytes: Buffer, source: string, id: string): Promise<{ keys: string[]; digest: string; warnings: string[] | undefined; records: number }> {
  const result = await convertFile(bytes, source, 'json', {}, id);
  const records = JSON.parse(result.buffer.toString('utf-8')) as JsonRecord[];
  const keys = Object.keys(records[0] ?? {});
  const body = records.map((record) => keys.map((key) => record[key]));
  return { keys, digest: sha256(JSON.stringify(body)), warnings: result.metadata?.warnings as string[] | undefined, records: records.length };
}

describe('real files whose records differ in width', () => {
  it.for(REAL_TABLES)('converts %s to the table Python csv reads, padded to the widest record', { timeout: 60_000 }, async ([id, expected], ctx) => {
    const sample = await requireRealworldSample(ctx, id);
    const table = await tableOf(sample.bytes, sample.format, id);
    expect(table.keys).toHaveLength(expected.width);
    expect(table.keys.slice(expected.header)).toEqual(Array.from({ length: expected.width - expected.header }, (_, index) => `Unnamed: ${expected.header + index}`));
    expect(table.records).toBe(expected.records);
    expect(table.digest).toBe(expected.sha256);
    expect(table.warnings?.length).toBeGreaterThan(0);
  });

  it('names what was added and filled for govdocs1-000722.csv (2 records of 9 fields under a header of 8, 32 of 8)', { timeout: 60_000 }, async (ctx) => {
    const sample = await requireRealworldSample(ctx, 'govdocs1-000722.csv');
    const table = await tableOf(sample.bytes, 'csv', 'govdocs1-000722.csv');
    expect(table.warnings).toEqual([
      'CSV: 2 rows have more fields than the header (the first is row 10); 1 column was added, named Unnamed: 8.',
      'CSV: 32 rows have fewer fields than the widest row (the first is row 2); their missing cells are empty.',
    ]);
  });
});

async function convert(text: string, source: 'csv' | 'tsv', target: string): Promise<{ text: string; warnings: string[] | undefined }> {
  const result = await convertFile(Buffer.from(text, 'utf-8'), source, target, {}, `ragged.${source}`);
  return { text: result.buffer.toString('utf-8'), warnings: result.metadata?.warnings as string[] | undefined };
}

async function recordsOf(text: string, source: 'csv' | 'tsv' = 'csv'): Promise<{ records: JsonRecord[]; warnings: string[] | undefined }> {
  const { text: json, warnings } = await convert(text, source, 'json');
  return { records: JSON.parse(json) as JsonRecord[], warnings };
}

describe('a record shorter than the widest one', () => {
  it('is filled out with empty cells and reported', async () => {
    const { records, warnings } = await recordsOf('a,b,c\n1,2\n3,4,5\n');
    expect(records).toEqual([{ a: '1', b: '2', c: '' }, { a: '3', b: '4', c: '5' }]);
    expect(warnings).toEqual(['CSV: 1 row has fewer fields than the widest row (the first is row 2); its missing cells are empty.']);
  });

  it('is filled out in a TSV file, which the warning names', async () => {
    const { records, warnings } = await recordsOf('a\tb\n1\n', 'tsv');
    expect(records).toEqual([{ a: '1', b: '' }]);
    expect(warnings).toEqual(['TSV: 1 row has fewer fields than the widest row (the first is row 2); its missing cells are empty.']);
  });

  it('is written to another delimited file as a full record', async () => {
    const { text } = await convert('a,b\r\n1\r\n', 'csv', 'tsv');
    expect(text).toBe('a\tb\r\n1\t');
  });
});

describe('a record longer than the header', () => {
  it('widens the table with columns named as pandas names a header cell without a name', async () => {
    const { records, warnings } = await recordsOf('a,b\n1,2,3\n4,5\n');
    expect(records).toEqual([{ a: '1', b: '2', 'Unnamed: 2': '3' }, { a: '4', b: '5', 'Unnamed: 2': '' }]);
    expect(warnings).toEqual([
      'CSV: 1 row has more fields than the header (the first is row 2); 1 column was added, named Unnamed: 2.',
      'CSV: 1 row has fewer fields than the widest row (the first is row 3); its missing cells are empty.',
    ]);
  });

  it('adds several columns and names the span', async () => {
    const { records, warnings } = await recordsOf('a\n1,2,3,4\n');
    expect(records).toEqual([{ a: '1', 'Unnamed: 1': '2', 'Unnamed: 2': '3', 'Unnamed: 3': '4' }]);
    expect(warnings).toEqual(['CSV: 1 row has more fields than the header (the first is row 2); 3 columns were added, named Unnamed: 1 to Unnamed: 3.']);
  });

  it('keeps a header that already has the generated name and renames the new column as duplicates are renamed', async () => {
    const { records } = await recordsOf('a,Unnamed: 2\n1,2,3\n');
    expect(records).toEqual([{ a: '1', 'Unnamed: 2': '2', 'Unnamed: 2_1': '3' }]);
  });

  it('counts a quoted field with line breaks as one record, whatever the widths', async () => {
    const { records, warnings } = await recordsOf('a,b\n"x\ny",2,3\n"z"\n');
    expect(records).toEqual([{ a: 'x\ny', b: '2', 'Unnamed: 2': '3' }, { a: 'z', b: '', 'Unnamed: 2': '' }]);
    expect(warnings).toEqual([
      'CSV: 1 row has more fields than the header (the first is row 2); 1 column was added, named Unnamed: 2.',
      'CSV: 1 row has fewer fields than the widest row (the first is row 3); its missing cells are empty.',
    ]);
  });
});

describe('what stays as it was', () => {
  it('converts a table whose records all have the header width without a warning', async () => {
    const { records, warnings } = await recordsOf('a,b\n\n1,2\n\n3,4\n');
    expect(records).toEqual([{ a: '1', b: '2' }, { a: '3', b: '4' }]);
    expect(warnings).toBeUndefined();
  });

  it('still refuses a quote that never closes, with its row', async () => {
    await expect(convert('a,b\n"x,1\n', 'csv', 'json')).rejects.toMatchObject({ name: 'DataParseError', row: 2 });
  });

  it('reads the records of the pure data engine the same way', () => {
    const { fields, records, ragged } = parseDelimitedRecords('a,b\n1,2,3\n4\n', ',', 'csv');
    expect(fields).toEqual(['a', 'b', 'Unnamed: 2']);
    expect(records).toEqual([{ a: '1', b: '2', 'Unnamed: 2': '3' }, { a: '4', b: '', 'Unnamed: 2': '' }]);
    expect(raggedRowWarnings(ragged, 'csv')).toHaveLength(2);
    expect(parseDelimitedRecords('a,b\n1,2\n', ',', 'csv').ragged).toBeNull();
  });
});
