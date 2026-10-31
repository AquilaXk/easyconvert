import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { parseAllXlsxWorksheets } from '../src/lib/conversions/office';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { oracleTest } from './helpers/oracle-test';
import { cellKindsViaLibreOffice, sheetRowsViaLibreOffice } from './helpers/sheet-rows';

/**
 * Records in NDJSON, JSON Lines, YAML and XML become the rows of a sheet: a record is a row and a key a column, read with the readers of
 * the data engine's other table targets and not as comma-delimited text. A value that holds a comma, a quote or a newline is the case that
 * a text reader splits. The sheet is read back by an office suite, which is not the code that wrote it.
 */

const SHEET_TARGETS = ['xlsx', 'ods', 'xls'] as const;
const LONG_TIMEOUT_MS = 180_000;

const RECORD_ROWS = [
  ['id', 'name', 'note', 'tags'],
  ['1', 'alpha', 'a,b', ''],
  ['2', 'beta', 'say "hi"\nthen go', '["x","y"]'],
];

const SOURCES: ReadonlyArray<{ format: string; text: string; rows: string[][] }> = [
  {
    format: 'ndjson',
    text: '{"id":1,"name":"alpha","note":"a,b"}\n{"id":2,"name":"beta","note":"say \\"hi\\"\\nthen go","tags":["x","y"]}\n',
    rows: RECORD_ROWS,
  },
  {
    format: 'jsonl',
    text: '{"id":1,"name":"alpha","note":"a,b"}\r\n\r\n{"id":2,"name":"beta","note":"say \\"hi\\"\\nthen go","tags":["x","y"]}\r\n',
    rows: RECORD_ROWS,
  },
  {
    format: 'yaml',
    text: '- id: 1\n  name: alpha\n  note: "a,b"\n- id: 2\n  name: beta\n  note: "say \\"hi\\"\\nthen go"\n  tags: [x, y]\n',
    rows: RECORD_ROWS,
  },
  {
    format: 'yml',
    text: 'items:\n  - {id: 1, name: alpha, note: "a,b"}\n  - {id: 2, name: beta, note: "say \\"hi\\"\\nthen go", tags: [x, y]}\n',
    rows: [
      ['items'],
      ['[{"id":1,"name":"alpha","note":"a,b"},{"id":2,"name":"beta","note":"say \\"hi\\"\\nthen go","tags":["x","y"]}]'],
    ],
  },
  {
    format: 'xml',
    text: '<rows><row><id>1</id><name>alpha</name><note>a,b</note></row><row><id>2</id><name>beta</name><note>say "hi"&#10;then go</note><extra>z</extra></row></rows>',
    rows: [
      ['id', 'name', 'note', 'extra'],
      ['1', 'alpha', 'a,b', ''],
      ['2', 'beta', 'say "hi"\nthen go', 'z'],
    ],
  },
];

describe('the registry offers the sheet targets of the record formats', () => {
  it.each(SOURCES.map((source) => source.format))('%s converts to xlsx, ods and xls', (format) => {
    for (const target of SHEET_TARGETS) expect(FORMAT_REGISTRY[format].targetFormats).toContain(target);
  });
});

describe('records become the rows of a sheet', () => {
  for (const { format, text, rows } of SOURCES) {
    for (const target of SHEET_TARGETS) {
      oracleTest(`${format} to ${target} holds one record per row and one key per column`, ['soffice', 'python3'], async () => {
        const result = await dispatchConversion(Buffer.from(text, 'utf-8'), format, target, {}, `data.${format}`);
        expect(result.filename).toBe(`data.${target}`);
        expect(sheetRowsViaLibreOffice(result.buffer, target)).toEqual(rows);
      }, LONG_TIMEOUT_MS);
    }
  }

  oracleTest('a number and a boolean of a record stay a number and a boolean in an xlsx cell', ['soffice'], async () => {
    const result = await dispatchConversion(Buffer.from('{"n":1.5,"ok":true,"s":"00004"}\n'), 'ndjson', 'xlsx', {}, 'typed.ndjson');
    expect(await cellKindsViaLibreOffice(result.buffer, 'xlsx')).toEqual([['string:', 'string:', 'string:'], ['float:1.5', 'boolean:true', 'string:']]);
  }, LONG_TIMEOUT_MS);
});

describe('a document that is one object around a list is one record in every record format', () => {
  const ITEMS_JSON = '[{"id":1},{"id":2}]';
  const WRAPPED: ReadonlyArray<{ format: string; text: string; header: string }> = [
    { format: 'ndjson', text: `{"items":${ITEMS_JSON}}\n`, header: 'items' },
    { format: 'yaml', text: 'items:\n  - id: 1\n  - id: 2\n', header: 'items' },
    { format: 'xml', text: '<root><items><item><id>1</id></item><item><id>2</id></item></items></root>', header: 'item' },
  ];

  it.each(WRAPPED)('$format to xlsx keeps the wrapper as the row and the list as its cell', async ({ format, text, header }) => {
    const result = await dispatchConversion(Buffer.from(text, 'utf-8'), format, 'xlsx', {}, `wrapped.${format}`);
    const [sheet] = await parseAllXlsxWorksheets(result.buffer);
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[0]).toEqual([header]);
    expect(JSON.parse(sheet.rows[1][0])).toEqual(format === 'xml' ? [{ id: '1' }, { id: '2' }] : [{ id: 1 }, { id: 2 }]);
  });

  it('json to csv does the same, as the json to xlsx route does not take an object for a table at all', async () => {
    const csv = await dispatchConversion(Buffer.from(`{"items":${ITEMS_JSON}}`), 'json', 'csv', {}, 'wrapped.json');
    expect(csv.buffer.toString('utf-8').replace(/^\uFEFF/, '')).toBe(`items\r\n"[{""id"":1},{""id"":2}]"`);
  });

  it.each(WRAPPED)('$format still gives a row for each item of a list that is the document itself', async ({ format }) => {
    const lists: Record<string, string> = {
      ndjson: '{"id":1}\n{"id":2}\n',
      yaml: '- id: 1\n- id: 2\n',
      xml: '<root><item><id>1</id></item><item><id>2</id></item></root>',
    };
    const result = await dispatchConversion(Buffer.from(lists[format], 'utf-8'), format, 'xlsx', {}, `list.${format}`);
    const [sheet] = await parseAllXlsxWorksheets(result.buffer);
    expect(sheet.rows).toEqual([['id'], ['1'], ['2']]);
  });
});
