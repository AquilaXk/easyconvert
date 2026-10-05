import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertFile } from '../src/lib/conversions';
import { convertData, encodeParquet } from '../src/lib/conversions/data';
import {
  ConversionFailedError,
  DataEncodingError,
  DataLimitExceededError,
  DataParseError,
  DataRepresentationError,
  UnsupportedTargetError,
} from '../src/lib/types';
import { requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

/**
 * Lossless JSON numbers, JSON-to-table flattening, NDJSON line errors, YAML expansion caps and
 * the parquet identity pair. Oracles: jq 1.7 (keeps number literals exactly), Python's json,
 * csv and yaml modules, and hand-written expected rows.
 */

function withTempFile<T>(content: Buffer | string, suffix: string, use: (file: string) => T): T {
  const file = path.join(os.tmpdir(), `data-oracle-${randomUUID()}${suffix}`);
  writeFileSync(file, content);
  try {
    return use(file);
  } finally {
    rmSync(file, { force: true });
  }
}

function runOracle(tool: 'jq' | 'python3', args: string[]): string {
  const result = spawnSync(requireOracleTool(tool), args, { encoding: 'utf-8' });
  if (result.status !== 0 || result.stderr !== '') {
    throw new Error(`${tool} ${args.join(' ')} failed (${result.status}): ${result.stderr}`);
  }
  return result.stdout;
}

/** Number literals exactly as jq reads them from a JSON document. */
function jqLiterals(json: Buffer, filter: string): string[] {
  return withTempFile(json, '.json', (file) => runOracle('jq', ['-r', filter, file]).trimEnd().split('\n'));
}

/** Python compares the YAML document with the JSON document value by value (ints are exact). */
function pythonYamlEqualsJson(yamlText: Buffer, jsonText: string): boolean {
  const script = [
    'import json, sys, yaml',
    'expected = json.loads(open(sys.argv[2], encoding="utf-8").read())',
    'actual = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))',
    'print("equal" if actual == expected else "differ: %r" % (actual,))',
  ].join('\n');
  const out = withTempFile(yamlText, '.yaml', (yamlFile) =>
    withTempFile(jsonText, '.json', (jsonFile) => runOracle('python3', ['-c', script, yamlFile, jsonFile]))
  );
  expect(out.trim()).toBe('equal');
  return true;
}

function pythonCsvRows(csv: Buffer): string[][] {
  const script =
    'import csv, json, sys; print(json.dumps(list(csv.reader(open(sys.argv[1], newline="", encoding="utf-8-sig")))))';
  return withTempFile(csv, '.csv', (file) => JSON.parse(runOracle('python3', ['-c', script, file])) as string[][]);
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the conversion to be rejected');
}

const BIG_NUMBERS =
  '{"id":12345678901234567890123,"neg":-9007199254740993,"safe":9007199254740991,' +
  '"list":[18446744073709551616,1.5,0.1,1e-7],"nested":{"n":123456789012345678}}';

describe('JSON numbers beyond 2^53 stay exact', () => {
  oracleTest('writes every integer literal back exactly (jq reads the output)', ['jq'], async () => {
    const result = await convertFile(Buffer.from(BIG_NUMBERS, 'utf-8'), 'json', 'txt', {}, 'ids.json');
    expect(jqLiterals(result.buffer, '.id, .neg, .safe, .list[0], .nested.n, .list[1], .list[3]')).toEqual([
      '12345678901234567890123',
      '-9007199254740993',
      '9007199254740991',
      '18446744073709551616',
      '123456789012345678',
      '1.5',
      // jq 1.7 prints its decimal literal form.
      '1E-7',
    ]);
  });

  oracleTest('keeps big integers exact in YAML output', ['python3'], async () => {
    const json = '{"id":12345678901234567890123,"neg":-9007199254740993,"__proto__":{"x":[1,"yes","0o17"]}}';
    const result = await convertFile(Buffer.from(json, 'utf-8'), 'json', 'yaml', {}, 'ids.json');
    expect(pythonYamlEqualsJson(result.buffer, json)).toBe(true);
  });

  oracleTest('keeps big integers exact through NDJSON and YAML to JSON', ['jq'], async () => {
    const ndjson = '{"id":18446744073709551617}\n{"id":-18446744073709551617}\n';
    const fromNdjson = await convertFile(Buffer.from(ndjson, 'utf-8'), 'ndjson', 'json', {}, 'ids.ndjson');
    expect(jqLiterals(fromNdjson.buffer, '.[].id')).toEqual(['18446744073709551617', '-18446744073709551617']);

    const fromYaml = await convertFile(Buffer.from('id: 98765432109876543210\nhex: 0x10\n', 'utf-8'), 'yaml', 'json', {}, 'ids.yaml');
    expect(jqLiterals(fromYaml.buffer, '.id, .hex')).toEqual(['98765432109876543210', '16']);
  });

  it('rejects a number outside the double range instead of writing null', async () => {
    const err = await rejection(convertFile(Buffer.from('{"x": 1e400}', 'utf-8'), 'json', 'yaml', {}, 'x.json'));
    expect(err).toBeInstanceOf(DataRepresentationError);
    expect(err.message).toMatch(/1e400/);
  });
});

describe('JSON to CSV flattens nested values', () => {
  oracleTest('writes dot paths for objects and JSON for arrays across the union of keys', ['python3'], async () => {
    const records = [
      { id: 1, user: { name: 'A', address: { city: 'Seoul' } }, tags: ['x', 'y'], empty: {}, none: null },
      { id: 2, extra: 'only here', user: { name: 'B' } },
    ];
    const result = await convertFile(Buffer.from(JSON.stringify(records), 'utf-8'), 'json', 'csv', {}, 'users.json');
    expect(result.buffer.toString('utf-8')).not.toContain('[object Object]');
    expect(pythonCsvRows(result.buffer)).toEqual([
      ['id', 'user.name', 'user.address.city', 'tags', 'empty', 'none', 'extra'],
      ['1', 'A', 'Seoul', '["x","y"]', '{}', '', ''],
      ['2', 'B', '', '', '', '', 'only here'],
    ]);
  });

  it('refuses keys whose dot paths collide', async () => {
    const err = await rejection(
      convertFile(Buffer.from('[{"a.b": 1, "a": {"b": 2}}]', 'utf-8'), 'json', 'csv', {}, 'clash.json')
    );
    expect(err).toBeInstanceOf(DataRepresentationError);
    expect(err.message).toMatch(/"a\.b"/);
  });
});

describe('JSON and NDJSON input fail closed', () => {
  it('names the line of a malformed NDJSON record', async () => {
    const ndjson = '{"a":1}\n\n{"a":2}\n{bad}\n{"a":4}\n';
    const err = await rejection(convertFile(Buffer.from(ndjson, 'utf-8'), 'ndjson', 'json', {}, 'rows.ndjson'));
    expect(err).toBeInstanceOf(DataParseError);
    expect((err as DataParseError).line).toBe(4);
    expect(err.message).toMatch(/line 4/);
  });

  it('skips blank NDJSON lines and keeps every record', async () => {
    const result = await convertFile(Buffer.from('{"a":1}\r\n\r\n  \n{"a":2}', 'utf-8'), 'jsonl', 'json', {}, 'rows.jsonl');
    expect(JSON.parse(result.buffer.toString('utf-8'))).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('reports JSON syntax errors with their position', async () => {
    const err = await rejection(convertFile(Buffer.from('{"a": 1,\n  "b": }', 'utf-8'), 'json', 'yaml', {}, 'bad.json'));
    expect(err).toBeInstanceOf(DataParseError);
    expect(err.message).toMatch(/^JSON parsing failed/);
    expect((err as DataParseError).line).toBe(2);
    expect((err as DataParseError).column).toBe(8);
  });

  it('rejects nesting beyond the depth limit with a typed error', async () => {
    const deep = '['.repeat(100_000) + ']'.repeat(100_000);
    const err = await rejection(convertFile(Buffer.from(deep, 'utf-8'), 'json', 'yaml', {}, 'deep.json'));
    expect(err).toBeInstanceOf(DataLimitExceededError);
    expect(err.message).toMatch(/nesting/i);
  });

  it('rejects bytes that are not UTF-8', async () => {
    const err = await rejection(convertFile(Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]), 'json', 'yaml', {}, 'bin.json'));
    expect(err).toBeInstanceOf(DataEncodingError);
    expect(err.message).toMatch(/utf-8/i);
  });
});

describe('YAML expansion is capped', () => {
  it('rejects an alias bomb with a typed limit error', async () => {
    const lines = ['a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]'];
    const names = 'abcdefghi';
    for (let i = 1; i < names.length; i++) {
      const prev = names[i - 1];
      lines.push(`${names[i]}: &${names[i]} [${Array(9).fill(`*${prev}`).join(',')}]`);
    }
    const err = await rejection(convertFile(Buffer.from(lines.join('\n'), 'utf-8'), 'yaml', 'json', {}, 'bomb.yaml'));
    expect(err).toBeInstanceOf(DataLimitExceededError);
    expect(err).toBeInstanceOf(ConversionFailedError);
    expect(err.message).toMatch(/alias/i);
  });

  it('rejects a document whose aliases expand far beyond its own size', async () => {
    const base = Array.from({ length: 20_000 }, (_, i) => i).join(', ');
    const yamlText = `base: &b [${base}]\nrefs: [${Array(90).fill('*b').join(', ')}]\n`;
    const err = await rejection(convertFile(Buffer.from(yamlText, 'utf-8'), 'yaml', 'json', {}, 'fanout.yaml'));
    expect(err).toBeInstanceOf(DataLimitExceededError);
    expect(err.message).toMatch(/expands to more than/);
  });

  it('rejects a self-referencing alias', async () => {
    const err = await rejection(convertFile(Buffer.from('a: &a [*a]\n', 'utf-8'), 'yaml', 'json', {}, 'cycle.yaml'));
    expect(err).toBeInstanceOf(DataLimitExceededError);
    expect(err.message).toMatch(/refers to itself/);
  });

  it('accepts ordinary aliases and merge keys', async () => {
    const yamlText = 'base: &base {x: 1, y: [a, b]}\nderived:\n  <<: *base\n  z: 3\ncopy: *base\n';
    const result = await convertFile(Buffer.from(yamlText, 'utf-8'), 'yaml', 'json', {}, 'ok.yaml');
    expect(JSON.parse(result.buffer.toString('utf-8'))).toEqual({
      base: { x: 1, y: ['a', 'b'] },
      derived: { x: 1, y: ['a', 'b'], z: 3 },
      copy: { x: 1, y: ['a', 'b'] },
    });
  });

  it('reports YAML syntax errors with their line', async () => {
    const err = await rejection(convertFile(Buffer.from('a: 1\nb: [1, 2\nc: 3\n', 'utf-8'), 'yaml', 'json', {}, 'bad.yaml'));
    expect(err).toBeInstanceOf(DataParseError);
    expect((err as DataParseError).line).toBeGreaterThanOrEqual(2);
    expect(err.message).toMatch(/^YAML parsing failed/);
  });

  it('allows exactly 100 aliases and rejects the 101st', async () => {
    const withAliases = (count: number): Buffer =>
      Buffer.from(`base: &b {x: 1}\nrefs: [${Array(count).fill('*b').join(', ')}]\n`, 'utf-8');
    const ok = await convertFile(withAliases(100), 'yaml', 'json', {}, 'ok.yaml');
    expect(JSON.parse(ok.buffer.toString('utf-8')).refs).toHaveLength(100);
    const err = await rejection(convertFile(withAliases(101), 'yaml', 'json', {}, 'many.yaml'));
    expect(err).toBeInstanceOf(DataLimitExceededError);
    expect(err.message).toBe('YAML document uses 101 aliases; at most 100 are allowed.');
  });

  it('reports an unresolved alias as a parse error', async () => {
    const err = await rejection(convertFile(Buffer.from('a: *nowhere\n', 'utf-8'), 'yaml', 'json', {}, 'alias.yaml'));
    expect(err).toBeInstanceOf(DataParseError);
    expect(err.message).toMatch(/nowhere/);
  });
});

describe('YAML keys are checked in linear time', () => {
  const SMALL_KEY_COUNT = 25_000;
  const LARGE_KEY_COUNT = 100_000;
  /**
   * 4x the keys may cost at most 8x the time: linear work scales by about 4, the pairwise
   * uniqueness check this replaces scaled by 16 (19 s at 40,000 keys, 147 s at 100,000).
   */
  const MAX_SCALING_RATIO = 8;
  /** Ceiling for 100,000 keys on a loaded runner; the pairwise check needed minutes. */
  const LARGE_KEYS_CEILING_MS = 10_000;
  const TIMING_RUNS = 2;

  async function fastestConversionMs(keyCount: number): Promise<number> {
    const yamlText = Buffer.from(Array.from({ length: keyCount }, (_, i) => `k${i}: ${i}`).join('\n'), 'utf-8');
    let fastest = Number.POSITIVE_INFINITY;
    for (let run = 0; run < TIMING_RUNS; run++) {
      const started = performance.now();
      const result = await convertFile(yamlText, 'yaml', 'json', {}, 'keys.yaml');
      fastest = Math.min(fastest, performance.now() - started);
      const parsed = JSON.parse(result.buffer.toString('utf-8')) as Record<string, number>;
      expect(Object.keys(parsed)).toHaveLength(keyCount);
      expect(parsed[`k${keyCount - 1}`]).toBe(keyCount - 1);
    }
    return fastest;
  }

  it('converts YAML maps in time linear in their key count', async () => {
    const small = await fastestConversionMs(SMALL_KEY_COUNT);
    const large = await fastestConversionMs(LARGE_KEY_COUNT);
    expect(large / small).toBeLessThan(MAX_SCALING_RATIO);
    expect(large).toBeLessThan(LARGE_KEYS_CEILING_MS);
  }, 60_000);

  const DUPLICATES: readonly [label: string, yamlText: string, line: number][] = [
    ['a repeated key', 'a: 1\nb: 2\na: 3\n', 3],
    ['keys equal after stringification (1 and "1")', '1: a\n"1": b\n', 2],
    ['a null key and an empty-string key', '~: a\n"": b\n', 2],
    ['a repeated key inside a nested map', 'outer:\n  x: 1\n  x: 2\n', 3],
  ];
  for (const [label, yamlText, line] of DUPLICATES) {
    it(`rejects ${label}`, async () => {
      const err = await rejection(convertFile(Buffer.from(yamlText, 'utf-8'), 'yaml', 'json', {}, 'dup.yaml'));
      expect(err).toBeInstanceOf(DataParseError);
      expect(err.message).toMatch(/duplicate key/i);
      expect((err as DataParseError).line).toBe(line);
    });
  }

  it('rejects a key that is not a scalar', async () => {
    const err = await rejection(convertFile(Buffer.from('? [a, b]\n: 1\n', 'utf-8'), 'yaml', 'json', {}, 'complex.yaml'));
    expect(err).toBeInstanceOf(DataParseError);
    expect(err.message).toMatch(/scalar/);
  });

  it('keeps merge-key semantics: explicit keys override merged ones', async () => {
    const yamlText = 'base: &b {x: 1, y: 2}\nd:\n  <<: *b\n  x: 9\n';
    const result = await convertFile(Buffer.from(yamlText, 'utf-8'), 'yaml', 'json', {}, 'merge.yaml');
    expect(JSON.parse(result.buffer.toString('utf-8'))).toEqual({ base: { x: 1, y: 2 }, d: { x: 9, y: 2 } });
  });
});

describe('YAML input diagnostics', () => {
  it('rejects tags it cannot resolve instead of guessing', async () => {
    const err = await rejection(convertFile(Buffer.from('a: !!int abc\n', 'utf-8'), 'yaml', 'json', {}, 'tag.yaml'));
    expect(err).toBeInstanceOf(DataParseError);
    expect(err.message).toMatch(/^YAML parsing failed/);
  });

  it('describes a multi-document stream without library API names', async () => {
    const err = await rejection(convertFile(Buffer.from('a: 1\n---\nb: 2\n', 'utf-8'), 'yaml', 'json', {}, 'multi.yaml'));
    expect(err).toBeInstanceOf(DataParseError);
    expect(err.message).toBe('YAML parsing failed: the input holds more than one document; convert one document at a time.');
  });

  it('decodes BOM-less UTF-16 YAML from its NUL pattern', async () => {
    const utf16 = Buffer.from('name: alpha\ncount: 2\n', 'utf16le');
    const result = await convertFile(utf16, 'yaml', 'json', {}, 'utf16.yaml');
    expect(JSON.parse(result.buffer.toString('utf-8'))).toEqual({ name: 'alpha', count: 2 });
  });

  it('names BOM-less UTF-16 JSON and TOML as the wrong encoding', async () => {
    const json = await rejection(convertFile(Buffer.from('{"a": 1}', 'utf16le'), 'json', 'yaml', {}, 'utf16.json'));
    expect(json).toBeInstanceOf(DataEncodingError);
    expect(json.message).toBe('JSON input must be UTF-8, but it is UTF-16 text without a byte-order mark.');
    const toml = await rejection(convertFile(Buffer.from('a = 1\n', 'utf16le'), 'toml', 'json', {}, 'utf16.toml'));
    expect(toml).toBeInstanceOf(DataEncodingError);
    expect(toml.message).toBe('TOML input must be UTF-8, but it is UTF-16 text without a byte-order mark.');
  });
});

describe('YAML output for YAML 1.1 readers', () => {
  oracleTest('quotes "=", "<<" and strings carrying U+FEFF so PyYAML reads them back', ['python3'], async () => {
    const json = JSON.stringify({ '=': '=', '﻿key': 'value﻿', '<<': '<<', plain: 'ok' });
    const result = await convertFile(Buffer.from(json, 'utf-8'), 'json', 'yaml', {}, 'keys.json');
    expect(result.buffer.toString('utf-8')).not.toContain('﻿');
    expect(pythonYamlEqualsJson(result.buffer, json)).toBe(true);
  });
});

describe('parquet to parquet', () => {
  it('is not an identity copy of the input', async () => {
    const parquet = encodeParquet([{ id: 1, name: 'alpha' }]);
    const err = await rejection(convertData(parquet, 'parquet', 'parquet', {}, 'rows.parquet'));
    expect(err).toBeInstanceOf(UnsupportedTargetError);
    expect(err.message).toMatch(/parquet/i);
  });
});
