import { describe, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertFile } from '../src/lib/conversions';
import { requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

/**
 * Header names that are also Object.prototype members (__proto__, constructor, prototype,
 * toString, hasOwnProperty) are ordinary CSV columns: every value under them must survive the
 * conversion. Oracle: Python's csv module reads the input; Python's json module, csv module and a
 * zipfile + ElementTree reader of the XLSX sheet read the outputs.
 */

const RISKY_HEADERS = ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'name'];
const CSV_INPUT = `${RISKY_HEADERS.join(',')}\r\n1,2,3,4,5,Alice\r\n6,7,8,9,10,Bob\r\n`;

function withTemp<T>(content: Buffer | string, suffix: string, use: (file: string) => T): T {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'csv-header-keys-'));
  try {
    const file = path.join(dir, `data${suffix}`);
    writeFileSync(file, content);
    return use(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function python(script: string, file: string, ...args: string[]): unknown {
  return JSON.parse(execFileSync(requireOracleTool('python3'), ['-c', script, file, ...args], { encoding: 'utf-8' }));
}

/** Rows (header first) as Python's csv module reads them. */
function pythonCsvRows(content: Buffer | string, delimiter: string): string[][] {
  const script = 'import csv, json, sys\nprint(json.dumps(list(csv.reader(open(sys.argv[1], newline="", encoding="utf-8-sig"), delimiter=sys.argv[2]))))';
  return withTemp(content, '.txt', (file) => python(script, file, delimiter) as string[][]);
}

/** Records as Python's json module reads them, as [key, value] pairs in document order. */
function pythonJsonPairs(content: Buffer): [string, string][][] {
  const script = 'import json, sys\nprint(json.dumps([list(r.items()) for r in json.load(open(sys.argv[1], encoding="utf-8"))]))';
  return withTemp(content, '.json', (file) => python(script, file) as [string, string][][]);
}

/** Cell text of the first worksheet, row by row, read straight from the XLSX package XML. */
function pythonXlsxRows(content: Buffer): string[][] {
  const script = [
    'import json, re, sys, zipfile',
    'import xml.etree.ElementTree as ET',
    'NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"',
    'z = zipfile.ZipFile(sys.argv[1])',
    'shared = []',
    'if "xl/sharedStrings.xml" in z.namelist():',
    '    for si in ET.fromstring(z.read("xl/sharedStrings.xml")).iter(NS + "si"):',
    '        shared.append("".join(t.text or "" for t in si.iter(NS + "t")))',
    'sheet = sorted(n for n in z.namelist() if re.match(r"xl/worksheets/sheet\\d+\\.xml$", n))[0]',
    'rows = []',
    'for row in ET.fromstring(z.read(sheet)).iter(NS + "row"):',
    '    cells = []',
    '    for c in row.iter(NS + "c"):',
    '        kind = c.get("t")',
    '        if kind == "s": cells.append(shared[int(c.find(NS + "v").text)])',
    '        elif kind == "inlineStr": cells.append("".join(t.text or "" for t in c.iter(NS + "t")))',
    '        else:',
    '            v = c.find(NS + "v")',
    '            cells.append("" if v is None else v.text)',
    '    rows.append(cells)',
    'print(json.dumps(rows))',
  ].join('\n');
  return withTemp(content, '.xlsx', (file) => python(script, file) as string[][]);
}

describe('CSV headers named like Object.prototype members keep their values', () => {
  oracleTest('CSV -> JSON keeps every column, including __proto__', ['python3'], async () => {
    const [header, ...body] = pythonCsvRows(CSV_INPUT, ',');
    const expected = body.map((row) => header.map((name, index) => [name, row[index]]));
    const result = await convertFile(Buffer.from(CSV_INPUT, 'utf-8'), 'csv', 'json', {}, 'risky.csv');
    expect(pythonJsonPairs(result.buffer)).toEqual(expected);
  });

  oracleTest('CSV -> TSV and TSV -> CSV keep every column', ['python3'], async () => {
    const expected = pythonCsvRows(CSV_INPUT, ',');
    const tsv = await convertFile(Buffer.from(CSV_INPUT, 'utf-8'), 'csv', 'tsv', {}, 'risky.csv');
    expect(pythonCsvRows(tsv.buffer, '\t')).toEqual(expected);
    const csv = await convertFile(tsv.buffer, 'tsv', 'csv', {}, 'risky.tsv');
    expect(pythonCsvRows(csv.buffer, ',')).toEqual(expected);
  });

  oracleTest('CSV -> XLSX keeps every column', ['python3'], async () => {
    const expected = pythonCsvRows(CSV_INPUT, ',');
    const xlsx = await convertFile(Buffer.from(CSV_INPUT, 'utf-8'), 'csv', 'xlsx', {}, 'risky.csv');
    expect(pythonXlsxRows(xlsx.buffer)).toEqual(expected);
  });
});
