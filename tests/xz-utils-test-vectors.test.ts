import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { unpackXz } from '../src/lib/conversions/archive';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

/**
 * The test files of XZ Utils 5.4.5 (`tests/files`, public domain): every good file must decode to the bytes the
 * reference decoder gives, and every bad or unsupported file must be refused. `expected.json` holds the SHA-256 of what
 * `xz -dc` wrote for each good file and `refused` for each file it refused, so the verdicts come from outside this
 * code. Files named `.lz` and `.lzma` of that directory are not read by this decoder and are not copied.
 */

const VECTOR_DIR = path.join(__dirname, 'fixtures', 'xz-utils-vectors');
const EXPECTED: Record<string, string> = JSON.parse(fs.readFileSync(path.join(VECTOR_DIR, 'expected.json'), 'utf8'));
const NAMES = Object.keys(EXPECTED).sort();
const REFUSED = 'refused';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function verdictOf(file: string): string {
  try {
    return sha256(unpackXz(fs.readFileSync(path.join(VECTOR_DIR, file))));
  } catch {
    return REFUSED;
  }
}

describe('XZ Utils test vectors', () => {
  it('lists every vector of the directory', () => {
    const onDisk = fs.readdirSync(VECTOR_DIR).filter((name) => name.endsWith('.xz')).sort();
    expect(onDisk).toEqual(NAMES);
    expect(NAMES.filter((name) => name.startsWith('good-'))).toHaveLength(24);
    expect(NAMES.filter((name) => !name.startsWith('good-'))).toHaveLength(47);
  });

  it.each(NAMES.filter((name) => name.startsWith('good-')))('decodes %s to the reference bytes', (file) => {
    expect(EXPECTED[file]).not.toBe(REFUSED);
    expect(verdictOf(file)).toBe(EXPECTED[file]);
  });

  it.each(NAMES.filter((name) => !name.startsWith('good-')))('refuses %s as the reference does', (file) => {
    expect(EXPECTED[file]).toBe(REFUSED);
    expect(verdictOf(file)).toBe(REFUSED);
  });

  oracleTest('agrees with the installed xz on every vector', ['xz'], () => {
    const xz = getOracleToolPath('xz')!;
    const disagreements: string[] = [];
    for (const file of NAMES) {
      const run = spawnSync(xz, ['-dc', path.join(VECTOR_DIR, file)], { maxBuffer: 1 << 28 });
      const reference = run.status === 0 ? sha256(run.stdout) : REFUSED;
      if (reference !== verdictOf(file)) disagreements.push(file);
    }
    expect(disagreements).toEqual([]);
  });
});
