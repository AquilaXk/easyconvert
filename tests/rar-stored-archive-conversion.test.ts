import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertFile } from '../src/lib/conversions';
import { isOracleToolAvailable } from './helpers/differential-oracle';
import { buildStoredRar4, type StoredRarEntry } from './helpers/rar4-stored';

/**
 * RAR sources convert to every archive target the registry lists, with each entry's bytes intact. The
 * input is a stored RAR 4.x archive written by an independent helper and accepted by `unrar t`; each
 * output is unpacked by 7z or tar, never by the engine under test.
 */
const HAS_TOOLS = isOracleToolAvailable('unrar') && isOracleToolAvailable('7z') && isOracleToolAvailable('tar');
const ENTRIES: readonly StoredRarEntry[] = [
  { name: 'notes.txt', data: Buffer.from('stored entry one\n', 'utf-8') },
  { name: 'data/values.csv', data: Buffer.from('id,value\n1,alpha\n2,beta\n', 'utf-8') },
];
const TARGETS = ['7z', 'tar', 'tar.bz2', 'tar.gz', 'zip'] as const;
/** Targets unpacked with tar (which detects gzip and bzip2 itself); the rest with 7z. */
const TAR_TARGETS: ReadonlySet<string> = new Set(['tar', 'tar.bz2', 'tar.gz']);

function withTempDir<T>(work: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rar-conversion-'));
  try {
    return work(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function unpack(archive: Buffer, target: string): Map<string, Buffer> {
  return withTempDir((dir) => {
    const file = path.join(dir, `archive.${target}`);
    const out = path.join(dir, 'out');
    writeFileSync(file, archive);
    execFileSync('mkdir', ['-p', out]);
    if (TAR_TARGETS.has(target)) execFileSync('tar', ['-xf', file, '-C', out]);
    else execFileSync('7z', ['x', '-y', `-o${out}`, file], { stdio: 'ignore' });
    return new Map(ENTRIES.map((entry) => [entry.name, readFileSync(path.join(out, entry.name))]));
  });
}

describe('stored RAR 4.x archive conversion', () => {
  const rar = buildStoredRar4(ENTRIES);

  it.skipIf(!HAS_TOOLS)('builds an input that unrar verifies (needs unrar, 7z, tar)', () => {
    withTempDir((dir) => {
      const file = path.join(dir, 'input.rar');
      writeFileSync(file, rar);
      expect(execFileSync('unrar', ['t', file], { encoding: 'utf-8' })).toContain('All OK');
      for (const entry of ENTRIES) expect(execFileSync('unrar', ['p', '-inul', file, entry.name]).equals(entry.data)).toBe(true);
    });
  });

  it.skipIf(!HAS_TOOLS).each(TARGETS)('rar -> %s keeps every entry byte for byte (needs unrar, 7z, tar)', async (target) => {
    const result = await convertFile(rar, 'rar', target, {}, 'input.rar');
    const unpacked = unpack(result.buffer, target);
    for (const entry of ENTRIES) expect(unpacked.get(entry.name)?.equals(entry.data)).toBe(true);
  });
});
