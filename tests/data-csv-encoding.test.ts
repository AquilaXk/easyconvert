import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { convertFile } from '../src/lib/conversions';
import { convertData } from '../src/lib/conversions/data';
import { ConversionOptionsSchema, validateOrProblem } from '../src/lib/api/contracts';
import {
  ConversionFailedError,
  DataEncodingError,
  DataParseError,
  UnsupportedOptionError,
} from '../src/lib/types';
import { requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

/**
 * Delimited-text input decoding (encoding and delimiter detection, BOM handling) and output
 * hardening (UTF-8 BOM, formula escaping), plus fail-closed parse errors.
 *
 * Oracles: the legacy-encoded fixtures were produced by GNU iconv from hand-authored UTF-8
 * sources (tests/fixtures/data-text/PROVENANCE); the expected records come from Python's csv
 * module reading those UTF-8 sources, never from the converter. Output bytes are compared
 * with hand-written expectations.
 */

const FIXTURE_DIR = path.resolve(__dirname, 'fixtures/data-text');
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

type CsvRecord = Record<string, string>;

function fixture(name: string): Buffer {
  return readFileSync(path.join(FIXTURE_DIR, name));
}

/** Records of a UTF-8 delimited file as Python's csv module reads them (header row as keys). */
function pythonCsvRecords(file: string, delimiter = ','): CsvRecord[] {
  const python = requireOracleTool('python3');
  const script = [
    'import csv, json, sys',
    'with open(sys.argv[1], newline="", encoding="utf-8-sig") as handle:',
    '    rows = list(csv.reader(handle, delimiter=sys.argv[2]))',
    'header, body = rows[0], rows[1:]',
    'assert all(len(row) == len(header) for row in body), "ragged fixture"',
    'print(json.dumps([dict(zip(header, row)) for row in body], ensure_ascii=False))',
  ].join('\n');
  const out = execFileSync(python, ['-c', script, path.join(FIXTURE_DIR, file), delimiter], { encoding: 'utf-8' });
  return JSON.parse(out) as CsvRecord[];
}

async function csvToRecords(input: Buffer, name: string, options: Record<string, unknown> = {}): Promise<CsvRecord[]> {
  const result = await convertFile(input, 'csv', 'json', options, name);
  expect(result.mimeType).toBe('application/json');
  expect(result.buffer[0]).toBe('['.charCodeAt(0));
  return JSON.parse(result.buffer.toString('utf-8')) as CsvRecord[];
}

/** The bytes GNU iconv produces for UTF-8 text in another encoding (an independent encoder). */
function iconvEncode(text: string, encoding: string): Buffer {
  return execFileSync(requireOracleTool('iconv'), ['-f', 'UTF-8', '-t', encoding], { input: Buffer.from(text, 'utf-8') });
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the conversion to be rejected');
}

describe('CSV input encoding detection', () => {
  const DETECTION_CASES: readonly [encoded: string, source: string][] = [
    ['korean.cp949.csv', 'korean.utf8.csv'],
    ['korean-basic.euc-kr.csv', 'korean-basic.utf8.csv'],
    ['japanese.shift_jis.csv', 'japanese.utf8.csv'],
    ['chinese.gbk.csv', 'chinese.utf8.csv'],
    ['english.utf16le.csv', 'english.utf8.csv'],
    ['english.utf16be.csv', 'english.utf8.csv'],
    ['korean.utf16le-bom.csv', 'korean.utf8.csv'],
    ['japanese.utf16be-bom.csv', 'japanese.utf8.csv'],
    ['korean.utf8-bom.csv', 'korean.utf8.csv'],
    ['korean.utf8.csv', 'korean.utf8.csv'],
  ];

  for (const [encoded, source] of DETECTION_CASES) {
    oracleTest(`decodes ${encoded} to the records Python reads from ${source}`, ['python3'], async () => {
      const expected = pythonCsvRecords(source);
      expect(expected.length).toBeGreaterThanOrEqual(2);
      const records = await csvToRecords(fixture(encoded), encoded);
      expect(records).toEqual(expected);
      // The BOM never leaks into the first header name.
      expect(Object.keys(records[0])[0].charCodeAt(0)).not.toBe(0xfeff);
    });
  }

  it('keeps RFC 4180 quoting, quoted delimiters and CRLF line breaks inside quoted fields', async () => {
    const records = await csvToRecords(fixture('korean.cp949.csv'), 'korean.cp949.csv');
    expect(records[0]).toEqual({ 이름: '김민준', 도시: '서울', 메모: '고객 "VIP" 등급' });
    expect(records[1].메모).toBe('두 줄로\r\n쓴 메모');
    expect(records[2].메모).toBe('똠방각하');
    expect(records[3].메모).toBe('쉼표, 포함');
  });

  oracleTest('committed legacy-encoded fixtures are the bytes iconv produces', ['iconv'], () => {
    const iconv = requireOracleTool('iconv');
    const conversions: readonly [target: string, source: string, encoding: string][] = [
      ['korean.cp949.csv', 'korean.utf8.csv', 'CP949'],
      ['korean-basic.euc-kr.csv', 'korean-basic.utf8.csv', 'EUC-KR'],
      ['japanese.shift_jis.csv', 'japanese.utf8.csv', 'SHIFT_JIS'],
      ['chinese.gbk.csv', 'chinese.utf8.csv', 'GBK'],
      ['latin1.iso-8859-1.csv', 'latin1.utf8.csv', 'ISO-8859-1'],
      ['english.utf16le.csv', 'english.utf8.csv', 'UTF-16LE'],
      ['english.utf16be.csv', 'english.utf8.csv', 'UTF-16BE'],
    ];
    for (const [target, source, encoding] of conversions) {
      const produced = execFileSync(iconv, ['-f', 'UTF-8', '-t', encoding, path.join(FIXTURE_DIR, source)]);
      expect(fixture(target).equals(produced)).toBe(true);
    }
  });

  oracleTest('detects ISO-8859-1 text as Windows-1252, its WHATWG decoder', ['python3'], async () => {
    const records = await csvToRecords(fixture('latin1.iso-8859-1.csv'), 'latin1.csv');
    expect(records).toEqual(pythonCsvRecords('latin1.utf8.csv'));
  });

  oracleTest('detects Windows-1252 punctuation and the euro sign', ['iconv'], async () => {
    const bytes = iconvEncode('label,price\n\u201cbest\u201d,\u20ac5\n\u2018ok\u2019,\u20ac7\n', 'WINDOWS-1252');
    const expected = [
      { label: '\u201cbest\u201d', price: '\u20ac5' },
      { label: '\u2018ok\u2019', price: '\u20ac7' },
    ];
    expect(await csvToRecords(bytes, 'quotes.csv')).toEqual(expected);
    // The explicit label decodes 0x80-0x9F as Windows-1252 too, not as ISO-8859-1 C1 controls.
    for (const encoding of ['windows-1252', 'latin1']) {
      expect(await csvToRecords(bytes, 'quotes.csv', { encoding })).toEqual(expected);
    }
  });

  oracleTest('detects Big5 traditional Chinese', ['iconv'], async () => {
    const bytes = iconvEncode('姓名,年齡\n張三,30\n李四,25\n', 'BIG5');
    expect(await csvToRecords(bytes, 'big5.csv')).toEqual([
      { 姓名: '張三', 年齡: '30' },
      { 姓名: '李四', 年齡: '25' },
    ]);
  });

  oracleTest('decodes Big5-HKSCS characters under the WHATWG big5 label without dropping any', ['iconv'], async () => {
    const bytes = iconvEncode('村,邨\n香港,1\n', 'BIG5-HKSCS');
    expect(await csvToRecords(bytes, 'hk.csv', { encoding: 'big5' })).toEqual([{ 村: '香港', 邨: '1' }]);
  });

  oracleTest('detects Hanja-only EUC-KR text as Korean, not as GB 18030', ['iconv'], async () => {
    // The GB 18030 reading of these bytes holds private-use characters, which real Chinese text does not.
    const bytes = iconvEncode('漢字,字\n水,火\n', 'EUC-KR');
    expect(bytes.toString('hex')).toBe('f9d3edae2cedae0ae2a92cfbfd0a');
    expect(await csvToRecords(bytes, 'hanja.csv')).toEqual([{ 漢字: '水', 字: '火' }]);
  });

  oracleTest('asks for the encoding when too few non-ASCII characters support a legacy guess', ['iconv'], async () => {
    for (const [text, encoding] of [['a,b\n가,1\n', 'EUC-KR'], ['name\nCafé Müller\n', 'ISO-8859-1'], ['x,y\nー,名前\n', 'SHIFT_JIS']]) {
      const err = await rejection(csvToRecords(iconvEncode(text, encoding), 'short.csv'));
      expect(err).toBeInstanceOf(DataEncodingError);
      expect(err.message).toMatch(
        /^Too little non-ASCII text \([1-3] characters, at least 4 needed\) to detect the text encoding; pass the "encoding" option\.$/
      );
    }
  });

  it('rejects input that no candidate encoding decodes with a typed error', async () => {
    // 0x81 0x01 is no legacy CJK sequence, and Windows-1252 text has no C0 or C1 control characters.
    const err = await rejection(csvToRecords(Buffer.from([0x61, 0x2c, 0x62, 0x0a, 0x81, 0x01, 0x2c, 0x63, 0x0a]), 'bin.csv'));
    expect(err).toBeInstanceOf(DataEncodingError);
    expect(err).toBeInstanceOf(ConversionFailedError);
    expect(err.message).toBe(
      'Could not detect the text encoding (tried UTF-8, UTF-16, EUC-KR/CP949, Shift_JIS, GBK, Big5 and Windows-1252); pass the "encoding" option.'
    );
  });

  oracleTest('decodes with an explicit encoding option', ['python3'], async () => {
    const records = await csvToRecords(fixture('latin1.iso-8859-1.csv'), 'latin1.csv', { encoding: 'iso-8859-1' });
    expect(records).toEqual(pythonCsvRecords('latin1.utf8.csv'));
    expect(records[1]).toEqual({ name: 'Müller', city: 'Köln' });
  });

  oracleTest('decodes CP949 extension syllables under the WHATWG euc-kr label', ['python3'], async () => {
    // The WHATWG euc-kr decoder is CP949; a decoder limited to KS X 1001 turns 똠 (0x8C 0x63) into a C1 control.
    expect(fixture('korean.cp949.csv').includes(Buffer.from([0x8c, 0x63]))).toBe(true);
    const records = await csvToRecords(fixture('korean.cp949.csv'), 'korean.csv', { encoding: 'euc-kr' });
    expect(records).toEqual(pythonCsvRecords('korean.utf8.csv'));
  });

  it('fails closed when the explicit encoding cannot decode the bytes', async () => {
    const err = await rejection(csvToRecords(fixture('korean.cp949.csv'), 'korean.csv', { encoding: 'utf-8' }));
    expect(err).toBeInstanceOf(DataEncodingError);
    expect(err.message).toMatch(/utf-8/i);
  });

  it('rejects an unknown encoding label as an unsupported option', async () => {
    const err = await rejection(csvToRecords(fixture('korean.utf8.csv'), 'korean.csv', { encoding: 'no-such-charset' }));
    expect(err).toBeInstanceOf(UnsupportedOptionError);
    expect(err.message).toMatch(/no-such-charset/);
  });
});

describe('CSV delimiter detection', () => {
  const DELIMITER_CASES: readonly [file: string, delimiter: string][] = [
    ['semicolon.csv', ';'],
    ['pipe.csv', '|'],
    ['tab.csv', '\t'],
  ];

  for (const [file, delimiter] of DELIMITER_CASES) {
    oracleTest(`detects the ${JSON.stringify(delimiter)} delimiter in ${file}`, ['python3'], async () => {
      const expected = pythonCsvRecords(file, delimiter);
      const records = await csvToRecords(fixture(file), file);
      expect(records).toEqual(expected);
      expect(Object.keys(records[0])).toHaveLength(3);
    });
  }

  it('reads quoted delimiters inside fields of a semicolon file', async () => {
    const records = await csvToRecords(fixture('semicolon.csv'), 'semicolon.csv');
    expect(records[0]).toEqual({ produit: 'pomme', prix: '1,50', quantité: '10' });
    expect(records[2].prix).toBe('0,75; en vrac');
  });

  it('uses an explicit delimiter option instead of detection', async () => {
    const records = await csvToRecords(fixture('semicolon.csv'), 'semicolon.csv', { delimiter: ';' });
    expect(records.map((r) => r.produit)).toEqual(['pomme', 'poire', 'cerise']);

    // Forcing the wrong delimiter must not silently produce a reshaped table.
    const err = await rejection(csvToRecords(fixture('semicolon.csv'), 'semicolon.csv', { delimiter: ',' }));
    expect(err).toBeInstanceOf(DataParseError);
    expect((err as DataParseError).row).toBe(2);
  });

  it('keeps the tab delimiter for TSV input', async () => {
    const result = await convertFile(Buffer.from('a\tb\n1,5\t2;3\n', 'utf-8'), 'tsv', 'json', {}, 'data.tsv');
    expect(JSON.parse(result.buffer.toString('utf-8'))).toEqual([{ a: '1,5', b: '2;3' }]);
  });
});

describe('CSV parse errors fail closed', () => {
  it('reports a record with too many fields with its row number', async () => {
    const err = await rejection(csvToRecords(Buffer.from('a,b\r\n1,2\r\n3,4,5\r\n6,7\r\n'), 'extra.csv'));
    expect(err).toBeInstanceOf(DataParseError);
    expect((err as DataParseError).row).toBe(3);
    expect(err.message).toMatch(/row 3/);
  });

  it('reports a record with too few fields with its row number', async () => {
    const err = await rejection(csvToRecords(Buffer.from('a,b,c\n1,2,3\n4,5,6\n7,8\n'), 'short.csv'));
    expect(err).toBeInstanceOf(DataParseError);
    expect((err as DataParseError).row).toBe(4);
  });

  it('reports an unterminated quoted field with its row and line number', async () => {
    const err = await rejection(csvToRecords(Buffer.from('a,b\n1,2\n"3,4\n5,6\n'), 'quote.csv'));
    expect(err).toBeInstanceOf(DataParseError);
    expect((err as DataParseError).row).toBe(3);
    expect((err as DataParseError).line).toBe(3);
  });
});

describe('CSV output BOM and formula escaping', () => {
  const RECORDS = [
    { name: 'A', value: '=SUM(A1:A2)' },
    { name: 'B', value: '-5' },
    { name: 'C', value: '@cmd' },
    { name: 'D', value: '+1.5e3' },
    { name: 'E', value: '\t=x' },
    { name: 'F', value: '\r=x' },
    { name: 'G', value: '-2+3' },
    { name: 'H', value: '=1\n=2' },
    { name: 'I', value: -7 },
  ];
  const JSON_INPUT = Buffer.from(JSON.stringify(RECORDS), 'utf-8');

  // Hand-written: a leading ' neutralizes = + - @ TAB CR, the escaped cell is quoted, and
  // plain numeric literals (-5, +1.5e3, -7) are values, not formulas, so they stay as they are.
  const ESCAPED_ROWS = [
    'name,value',
    `A,"'=SUM(A1:A2)"`,
    'B,-5',
    `C,"'@cmd"`,
    'D,+1.5e3',
    `E,"'\t=x"`,
    `F,"'\r=x"`,
    `G,"'-2+3"`,
    `H,"'=1\n=2"`,
    'I,-7',
  ];

  it('writes a UTF-8 BOM and escapes formula cells by default for CSV', async () => {
    const result = await convertFile(JSON_INPUT, 'json', 'csv', {}, 'cells.json');
    expect(result.buffer.subarray(0, 3).equals(UTF8_BOM)).toBe(true);
    expect(result.buffer.subarray(3).toString('utf-8')).toBe(ESCAPED_ROWS.join('\r\n'));
  });

  it('writes no BOM for TSV by default but still escapes formula cells', async () => {
    const result = await convertFile(JSON_INPUT, 'json', 'tsv', {}, 'cells.json');
    expect(result.buffer[0]).toBe('n'.charCodeAt(0));
    const text = result.buffer.toString('utf-8');
    expect(text.split('\r\n')[1]).toBe(`A\t"'=SUM(A1:A2)"`);
    expect(text.split('\r\n')[2]).toBe('B\t-5');
  });

  it('honours explicit bom and escapeFormulas options', async () => {
    const raw = await convertFile(JSON_INPUT, 'json', 'csv', { bom: false, escapeFormulas: false }, 'cells.json');
    expect(raw.buffer[0]).toBe('n'.charCodeAt(0));
    expect(raw.buffer.toString('utf-8').split('\r\n').slice(1, 3)).toEqual(['A,=SUM(A1:A2)', 'B,-5']);

    const tsvWithBom = await convertFile(JSON_INPUT, 'json', 'tsv', { bom: true }, 'cells.json');
    expect(tsvWithBom.buffer.subarray(0, 3).equals(UTF8_BOM)).toBe(true);
  });

  it('applies the same output rules when re-delimiting CSV input', async () => {
    const input = Buffer.from('name\tformula\r\nA\t=HYPERLINK("http://x")\r\nB\t-12\r\n', 'utf-8');
    const result = await convertFile(input, 'tsv', 'csv', {}, 'sheet.tsv');
    expect(result.buffer.subarray(0, 3).equals(UTF8_BOM)).toBe(true);
    expect(result.buffer.subarray(3).toString('utf-8')).toBe(
      ['name,formula', `A,"'=HYPERLINK(""http://x"")"`, 'B,-12'].join('\r\n')
    );
  });

  it('rejects a delimiter option that cannot separate fields', async () => {
    const err = await rejection(convertFile(Buffer.from('a,b\n1,2\n'), 'csv', 'json', { delimiter: '"' }, 'x.csv'));
    expect(err).toBeInstanceOf(UnsupportedOptionError);
    expect(err.message).toMatch(/"delimiter"/);
  });
});

describe('data conversion options are type-checked', () => {
  // Options arrive as parsed request JSON, so any JSON type can reach the engine.
  const INVALID_OPTIONS: readonly [label: string, options: Record<string, unknown>][] = [
    ['numeric delimiter', { delimiter: 5 }],
    ['object delimiter', { delimiter: {} }],
    ['array delimiter', { delimiter: ['a'] }],
    ['null delimiter', { delimiter: null }],
    ['multi-character delimiter', { delimiter: '::' }],
    ['delimiter outside , ; TAB |', { delimiter: ':' }],
    ['numeric encoding', { encoding: 5 }],
    ['null encoding', { encoding: null }],
    ['string bom', { bom: 'no' }],
    ['numeric escapeFormulas', { escapeFormulas: 1 }],
  ];

  for (const [label, options] of INVALID_OPTIONS) {
    it(`rejects a ${label} with a typed option error`, async () => {
      const err = await rejection(convertFile(Buffer.from('a,b\n1,2\n'), 'csv', 'json', options, 'x.csv'));
      expect(err).toBeInstanceOf(UnsupportedOptionError);
      expect(err.message).toMatch(new RegExp(`"${Object.keys(options)[0]}"`));
    });
  }

  it('rejects options that are not an object', async () => {
    const err = await rejection(convertData(Buffer.from('[{"a":1}]'), 'json', 'csv', null as never, 'x.json'));
    expect(err).toBeInstanceOf(UnsupportedOptionError);
    expect(err.message).toBe('Conversion options must be a JSON object.');
  });

  it('declares encoding, bom and escapeFormulas with their types in the v1 options contract', () => {
    const valid = validateOrProblem(ConversionOptionsSchema, { encoding: 'euc-kr', bom: false, escapeFormulas: true });
    expect(valid.ok).toBe(true);
    for (const options of [{ encoding: 5 }, { bom: 'no' }, { escapeFormulas: 1 }]) {
      const result = validateOrProblem(ConversionOptionsSchema, options);
      expect(result.ok).toBe(false);
      expect(result.problem?.status).toBe(422);
    }
  });

  it('accepts each allowed delimiter character', async () => {
    for (const delimiter of [',', ';', '\t', '|']) {
      const records = await csvToRecords(Buffer.from(`a${delimiter}b\n1${delimiter}2\n`), 'x.csv', { delimiter });
      expect(records).toEqual([{ a: '1', b: '2' }]);
    }
  });
});
