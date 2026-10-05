import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertFile } from '../src/lib/conversions';
import { convertData } from '../src/lib/conversions/data';
import { FORMAT_REGISTRY, isFormatCompatibleWithMagicBytes } from '../src/lib/registry';
import { ConversionFailedError, DataRepresentationError } from '../src/lib/types';
import { requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

/**
 * TOML v1.0.0 support checked against two independent oracles: the toml-test vectors
 * (tests/fixtures/toml-test, see PROVENANCE) and Python's tomllib. Python also reads every
 * JSON, YAML and TOML document the converter writes.
 */

const VECTOR_ROOT = path.resolve(__dirname, 'fixtures/toml-test');
const SLOW_BATCH_TIMEOUT_MS = 120_000;

function listVectors(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listVectors(full));
    else if (name.endsWith('.toml')) out.push(full);
  }
  return out.sort();
}

const VALID_VECTORS = listVectors(path.join(VECTOR_ROOT, 'valid'));
const INVALID_VECTORS = listVectors(path.join(VECTOR_ROOT, 'invalid'));

/** Comparators run by Python: toml-test's tagged JSON and tomllib's native values are the expectations. */
const TOML_ORACLE = String.raw`
import datetime, json, math, sys, tomllib
import yaml

def truncate(value):
    if isinstance(value, (datetime.datetime, datetime.time)):
        return value.replace(microsecond=value.microsecond // 1000 * 1000)
    return value

def temporal(text, kind):
    if kind == 'date-local':
        return datetime.date.fromisoformat(text)
    if kind == 'time-local':
        return truncate(datetime.time.fromisoformat(text))
    return truncate(datetime.datetime.fromisoformat(text.upper().replace(' ', 'T')))

def is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)

def same_float(actual, want):
    return is_number(actual) and ((math.isnan(want) and math.isnan(actual)) or actual == want)

def is_tag(node):
    return isinstance(node, dict) and set(node) == {'type', 'value'} and all(isinstance(v, str) for v in node.values())

def check_tagged(actual, expected, where, out):
    if is_tag(expected):
        kind, text = expected['type'], expected['value']
        if kind == 'string': ok = actual == text
        elif kind == 'integer': ok = type(actual) is int and actual == int(text)
        elif kind == 'float': ok = same_float(actual, float(text))
        elif kind == 'bool': ok = actual is (text == 'true')
        else: ok = isinstance(actual, str) and temporal(actual, kind) == temporal(text, kind)
        if not ok: out.append('%s: %r is not %s %r' % (where, actual, kind, text))
    elif isinstance(expected, list):
        if not isinstance(actual, list) or len(actual) != len(expected):
            out.append('%s: %r is not a list of %d' % (where, actual, len(expected)))
        else:
            for i, (a, e) in enumerate(zip(actual, expected)): check_tagged(a, e, '%s[%d]' % (where, i), out)
    else:
        if not isinstance(actual, dict) or set(actual) != set(expected):
            out.append('%s: keys %r != %r' % (where, sorted(actual) if isinstance(actual, dict) else actual, sorted(expected)))
        else:
            for k in expected: check_tagged(actual[k], expected[k], '%s.%s' % (where, k), out)

def check_native(actual, native, where, out):
    if isinstance(native, bool): ok = actual is native
    elif isinstance(native, int): ok = type(actual) is int and actual == native
    elif isinstance(native, float): ok = same_float(actual, native)
    elif isinstance(native, str): ok = actual == native
    elif isinstance(native, datetime.datetime):
        ok = isinstance(actual, str) and temporal(actual, 'datetime') == truncate(native)
    elif isinstance(native, datetime.date): ok = isinstance(actual, str) and temporal(actual, 'date-local') == native
    elif isinstance(native, datetime.time): ok = isinstance(actual, str) and temporal(actual, 'time-local') == truncate(native)
    elif isinstance(native, list):
        if not isinstance(actual, list) or len(actual) != len(native):
            out.append('%s: %r is not a list of %d' % (where, actual, len(native))); return
        for i, (a, n) in enumerate(zip(actual, native)): check_native(a, n, '%s[%d]' % (where, i), out)
        return
    else:
        if not isinstance(actual, dict) or set(actual) != set(native):
            out.append('%s: keys differ' % where); return
        for k in native: check_native(actual[k], native[k], '%s.%s' % (where, k), out)
        return
    if not ok: out.append('%s: %r != tomllib %r' % (where, actual, native))

def check_plain(native, plain, where, out):
    # plain is the JSON written for the writer; native is what tomllib reads from its TOML output.
    if isinstance(plain, bool): ok = native is plain
    elif isinstance(plain, int): ok = type(native) is int and native == plain
    elif isinstance(plain, float): ok = same_float(native, plain)
    elif isinstance(plain, str): ok = native == plain
    elif isinstance(plain, list):
        if not isinstance(native, list) or len(native) != len(plain):
            out.append('%s: %r is not a list of %d' % (where, native, len(plain))); return
        for i, (n, p) in enumerate(zip(native, plain)): check_plain(n, p, '%s[%d]' % (where, i), out)
        return
    else:
        if not isinstance(native, dict) or set(native) != set(plain):
            out.append('%s: keys differ' % where); return
        for k in plain: check_plain(native[k], plain[k], '%s.%s' % (where, k), out)
        return
    if not ok: out.append('%s: tomllib read %r for %r' % (where, native, plain))

def untag(node):
    if is_tag(node):
        kind, text = node['type'], node['value']
        if kind == 'integer': return int(text)
        if kind == 'float': return float(text)
        if kind == 'bool': return text == 'true'
        return text
    if isinstance(node, list): return [untag(n) for n in node]
    return {k: untag(v) for k, v in node.items()}

def load(path):
    return open(path, encoding='utf-8').read()

mode, manifest = sys.argv[1], json.load(open(sys.argv[2], encoding='utf-8'))
failures = []
for case in manifest:
    out = []
    if mode in ('json', 'yaml'):
        actual = json.loads(load(case['actual'])) if mode == 'json' else yaml.safe_load(load(case['actual']))
        check_tagged(actual, json.loads(load(case['expected'])), '$', out)
        check_native(actual, tomllib.loads(load(case['source'])), '$', out)
    elif mode == 'untag':
        open(case['plain'], 'w', encoding='utf-8').write(json.dumps(untag(json.loads(load(case['expected'])))))
    elif mode == 'toml':
        check_plain(tomllib.loads(load(case['actual'])), json.loads(load(case['plain'])), '$', out)
    failures.extend('%s %s' % (case['name'], line) for line in out)
print(json.dumps(failures))
`;

interface OracleCase {
  name: string;
  source?: string;
  expected?: string;
  actual?: string;
  plain?: string;
}

function runPythonOracle(mode: 'json' | 'yaml' | 'untag' | 'toml', cases: OracleCase[], workDir: string): string[] {
  const manifest = path.join(workDir, `${mode}-manifest.json`);
  writeFileSync(manifest, JSON.stringify(cases));
  const result = spawnSync(requireOracleTool('python3'), ['-c', TOML_ORACLE, mode, manifest], { encoding: 'utf-8' });
  if (result.status !== 0 || result.stderr !== '') {
    throw new Error(`python3 TOML oracle (${mode}) failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as string[];
}

/** The platform rejects empty uploads before any engine runs, so 0-byte vectors go to the data engine directly. */
function convertVector(file: string, target: string): ReturnType<typeof convertFile> {
  const bytes = readFileSync(file);
  return bytes.length === 0 ? convertData(bytes, 'toml', target, {}, 'v.toml') : convertFile(bytes, 'toml', target, {}, 'v.toml');
}

function vectorName(file: string): string {
  return path.relative(VECTOR_ROOT, file).replace(/\.toml$/, '');
}

function expectedJsonPath(file: string): string {
  return file.replace(/\.toml$/, '.json');
}

/** toml-test encodes inf and nan as tagged float strings; JSON has no spelling for them. */
function hasNonFiniteFloat(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasNonFiniteFloat);
  if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    if (record.type === 'float' && typeof record.value === 'string') return /inf|nan/.test(record.value);
    return Object.values(record).some(hasNonFiniteFloat);
  }
  return false;
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the conversion to be rejected');
}

describe('TOML registry entry', () => {
  it('registers TOML as a data format with JSON, YAML, XML and text targets', () => {
    const toml = FORMAT_REGISTRY.toml;
    expect(toml).toMatchObject({ id: 'toml', extension: 'toml', mimeType: 'application/toml', category: 'data' });
    expect([...toml.targetFormats].sort()).toEqual(['json', 'txt', 'xml', 'yaml', 'zip']);
    for (const source of ['json', 'yaml', 'yml']) {
      expect(FORMAT_REGISTRY[source].targetFormats).toContain('toml');
    }
  });

  it('treats a .toml upload with binary magic bytes as spoofed', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect(isFormatCompatibleWithMagicBytes(png, 'toml')).toBe(false);
    expect(isFormatCompatibleWithMagicBytes(Buffer.from('a = 1\n'), 'toml')).toBe(true);
  });
});

describe('TOML input against toml-test and tomllib', () => {
  it('ships a toml-test subset with both valid and invalid vectors', () => {
    expect(VALID_VECTORS.length).toBeGreaterThanOrEqual(100);
    expect(INVALID_VECTORS.length).toBeGreaterThanOrEqual(90);
  });

  oracleTest(
    'converts every valid vector to JSON that both oracles accept',
    ['python3'],
    async () => {
      const workDir = mkdtempSync(path.join(os.tmpdir(), 'toml-json-'));
      try {
        const cases: OracleCase[] = [];
        for (const file of VALID_VECTORS) {
          const expected = JSON.parse(readFileSync(expectedJsonPath(file), 'utf-8'));
          if (hasNonFiniteFloat(expected)) {
            const err = await rejection(convertVector(file, 'json'));
            expect(err).toBeInstanceOf(DataRepresentationError);
            continue;
          }
          const result = await convertVector(file, 'json');
          const actual = path.join(workDir, `${cases.length}.json`);
          writeFileSync(actual, result.buffer);
          cases.push({ name: vectorName(file), source: file, expected: expectedJsonPath(file), actual });
        }
        expect(cases.length).toBeGreaterThanOrEqual(90);
        expect(runPythonOracle('json', cases, workDir)).toEqual([]);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    },
    SLOW_BATCH_TIMEOUT_MS
  );

  oracleTest(
    'converts every valid vector, inf and nan included, to YAML that both oracles accept',
    ['python3'],
    async () => {
      const workDir = mkdtempSync(path.join(os.tmpdir(), 'toml-yaml-'));
      try {
        const cases: OracleCase[] = [];
        for (const file of VALID_VECTORS) {
          const result = await convertVector(file, 'yaml');
          const actual = path.join(workDir, `${cases.length}.yaml`);
          writeFileSync(actual, result.buffer);
          cases.push({ name: vectorName(file), source: file, expected: expectedJsonPath(file), actual });
        }
        expect(runPythonOracle('yaml', cases, workDir)).toEqual([]);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    },
    SLOW_BATCH_TIMEOUT_MS
  );

  it('rejects every invalid vector with a typed error', async () => {
    const untyped: string[] = [];
    for (const file of INVALID_VECTORS) {
      const err = await rejection(convertVector(file, 'json'));
      if (!(err instanceof ConversionFailedError) || !['DataParseError', 'DataEncodingError'].includes(err.name)) {
        untyped.push(`${vectorName(file)}: ${err.name}: ${err.message}`);
      }
    }
    expect(untyped).toEqual([]);
  });

  it('reports the line of a TOML syntax error', async () => {
    const err = await rejection(convertFile(Buffer.from('a = 1\nb = = 2\n'), 'toml', 'json', {}, 'bad.toml'));
    expect(err.name).toBe('DataParseError');
    expect((err as Error & { line?: number }).line).toBe(2);
  });
});

describe('TOML output', () => {
  oracleTest(
    'writes TOML that tomllib reads back to the JSON values of every finite vector',
    ['python3'],
    async () => {
      const workDir = mkdtempSync(path.join(os.tmpdir(), 'toml-write-'));
      try {
        const cases: OracleCase[] = [];
        for (const file of VALID_VECTORS) {
          const expected = JSON.parse(readFileSync(expectedJsonPath(file), 'utf-8'));
          if (hasNonFiniteFloat(expected)) continue;
          cases.push({ name: vectorName(file), expected: expectedJsonPath(file), plain: path.join(workDir, `${cases.length}.plain.json`) });
        }
        expect(runPythonOracle('untag', cases, workDir)).toEqual([]);
        for (const testCase of cases) {
          const result = await convertFile(readFileSync(testCase.plain!), 'json', 'toml', {}, 'v.json');
          expect(result.mimeType).toBe('application/toml');
          testCase.actual = path.join(workDir, `${testCase.name.replace(/\W/g, '_')}.toml`);
          writeFileSync(testCase.actual, result.buffer);
        }
        // JSON has a single number type, so an integral float such as 1e06 is written as the TOML integer
        // 1000000: the comparator requires the exact type for integers and the same value for floats.
        expect(runPythonOracle('toml', cases, workDir)).toEqual([]);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    },
    SLOW_BATCH_TIMEOUT_MS
  );

  oracleTest('writes big integers and nested tables from YAML as TOML', ['python3'], async () => {
    const yamlText = 'title: demo\nid: 9223372036854775807\nowner:\n  name: Tom\n  tags: [a, b]\nservers:\n  - {ip: 10.0.0.1}\n  - {ip: 10.0.0.2}\n';
    const result = await convertFile(Buffer.from(yamlText, 'utf-8'), 'yaml', 'toml', {}, 'cfg.yaml');
    const workDir = mkdtempSync(path.join(os.tmpdir(), 'toml-yaml-src-'));
    try {
      const actual = path.join(workDir, 'out.toml');
      const plain = path.join(workDir, 'plain.json');
      writeFileSync(actual, result.buffer);
      writeFileSync(
        plain,
        '{"title":"demo","id":9223372036854775807,"owner":{"name":"Tom","tags":["a","b"]},"servers":[{"ip":"10.0.0.1"},{"ip":"10.0.0.2"}]}'
      );
      expect(runPythonOracle('toml', [{ name: 'yaml-source', actual, plain }], workDir)).toEqual([]);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('refuses JSON that TOML cannot represent', async () => {
    const topArray = await rejection(convertFile(Buffer.from('[1, 2]'), 'json', 'toml', {}, 'a.json'));
    expect(topArray).toBeInstanceOf(DataRepresentationError);
    expect(topArray.message).toMatch(/table/);

    const withNull = await rejection(convertFile(Buffer.from('{"a": {"b": null}}'), 'json', 'toml', {}, 'n.json'));
    expect(withNull).toBeInstanceOf(DataRepresentationError);
    expect(withNull.message).toMatch(/a\.b/);

    const tooBig = await rejection(convertFile(Buffer.from('{"a": 9223372036854775808}'), 'json', 'toml', {}, 'b.json'));
    expect(tooBig).toBeInstanceOf(DataRepresentationError);
    expect(tooBig.message).toMatch(/64-bit/);
  });

  it('returns the TOML text itself for a text target', async () => {
    const source = readFileSync(path.join(VECTOR_ROOT, 'valid/spec-example-1.toml'));
    const result = await convertFile(source, 'toml', 'txt', {}, 'example.toml');
    expect(result.mimeType).toBe('text/plain');
    expect(result.buffer.equals(source)).toBe(true);
  });

  oracleTest('writes well-formed XML from TOML', ['xmllint'], async () => {
    const source = readFileSync(path.join(VECTOR_ROOT, 'valid/spec-example-1.toml'));
    const result = await convertFile(source, 'toml', 'xml', {}, 'example.toml');
    const workDir = mkdtempSync(path.join(os.tmpdir(), 'toml-xml-'));
    try {
      const file = path.join(workDir, 'out.xml');
      writeFileSync(file, result.buffer);
      const check = spawnSync(requireOracleTool('xmllint'), ['--xpath', 'string(/root/owner/name)', file], { encoding: 'utf-8' });
      expect(check.stderr).toBe('');
      expect(check.stdout).toBe('Lance Uppercut\n');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
