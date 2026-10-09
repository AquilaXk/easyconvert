import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTarEntryHeaders } from '../src/lib/conversions/archive';
import { convertWithNative7z } from '../src/worker/engines';
import { getOracleToolPath } from './helpers/differential-oracle';
import { hostileTarMember, pythonTarEntries, pythonTarMember } from './helpers/hostile-tar';
import { oracleTest } from './helpers/oracle-test';
import { craftSevenZip } from './helpers/seven-zip-craft';
import { createSevenZipSpy, type SevenZipSpy } from './helpers/seven-zip-spy';

/**
 * 7z to tar writes the members 7-Zip would extract. These archives are written byte by byte, because 7-Zip itself
 * would not produce them: a file named like a directory, a symlink that declares gigabytes, a setuid mode. Each is
 * first listed by 7-Zip (what the header says) and the tar is read back with Python's tarfile (what a second
 * reader finds).
 */
const TOOLS = ['7z', 'python3'] as const;
const TEST_TIMEOUT_MS = 120_000;

let workDir = '';
let spy: SevenZipSpy;

function sevenZipFields(archive: Buffer, label: string): Map<string, string>[] {
  const file = path.join(workDir, `${label}.7z`);
  fs.writeFileSync(file, archive);
  const bin = getOracleToolPath('7z') as string;
  return execFileSync(bin, ['l', '-slt', '-ba', file], { encoding: 'utf8' })
    .split('\n\n')
    .filter((block) => block.trim() !== '')
    .map((block) => new Map(block.split('\n').flatMap((line) => (line.includes(' = ') ? [[line.slice(0, line.indexOf(' = ')), line.slice(line.indexOf(' = ') + 3)] as [string, string]] : []))));
}

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seven-zip-hostile-'));
  spy = createSevenZipSpy(workDir);
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  spy.reset();
  spy.install();
});

afterEach(() => {
  spy.restore();
});

describe('a file member whose name ends in a path separator', () => {
  for (const [label, name] of [
    ['slash', 'x/'],
    ['backslash', 'x\\'],
  ] as const) {
    oracleTest(
      `named with a trailing ${label} is refused, so its bytes cannot become tar headers`,
      [...TOOLS],
      async () => {
        const smuggled = hostileTarMember({ name: 'evil.txt' }, Buffer.from('pwned'));
        const archive = craftSevenZip([{ name: 'ok.txt', data: Buffer.from('fine') }, { name, data: smuggled }]);
        const listed = sevenZipFields(archive, `trailing-${label}`);
        expect(listed.map((fields) => [fields.get('Path'), fields.get('Attributes')?.startsWith('A')])).toEqual([
          ['ok.txt', true],
          [name, true],
        ]);

        await expect(convertWithNative7z(archive, '7z', 'tar', {}, 'trailing.7z')).rejects.toMatchObject({
          name: 'UnsafeArchiveError',
          reason: 'invalid-entry-name',
        });
        expect(spy.calls().filter((call) => call[0] === 'x')).toHaveLength(0);
      },
      TEST_TIMEOUT_MS
    );
  }

  oracleTest(
    'does not disturb a directory member named with a trailing slash',
    [...TOOLS],
    async () => {
      const archive = craftSevenZip([{ name: 'docs/', directory: true }, { name: 'docs/a.txt', data: Buffer.from('alpha') }]);
      const result = await convertWithNative7z(archive, '7z', 'tar', {}, 'dirs.7z');
      if (result === null) throw new Error('the native 7-Zip engine declined the conversion');
      expect(pythonTarEntries(result.buffer).map((entry) => [entry.name, entry.type])).toEqual([
        ['docs', '5'],
        ['docs/a.txt', '0'],
      ]);
      expect(pythonTarMember(result.buffer, 'docs/a.txt').toString()).toBe('alpha');
    },
    TEST_TIMEOUT_MS
  );

  it('cannot be written as a file by the tar header builder', () => {
    expect(() => buildTarEntryHeaders({ filename: 'x/', size: 5, directory: false })).toThrow(/ends with a slash/);
    expect(buildTarEntryHeaders({ filename: 'x/', size: 0 }).subarray(156, 157).toString()).toBe('5');
  });
});
