import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const TESTS = __dirname;
const SELF = path.relative(TESTS, __filename);
const LIVENESS_PROBE = /process\.kill\(\s*(?!process\.pid\b)[^,()]+,\s*0\s*\)|\bkill\s+-0\b/;
const PROBES_ON_PURPOSE = new Set(['helpers/process-state.ts', 'process-state.test.ts', 'sandbox-isolation.test.ts']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'fixtures' ? [] : sourceFiles(full);
    return /\.(ts|mts|sh)$/.test(entry.name) ? [full] : [];
  });
}

function probes(file: string): string[] {
  return readFileSync(file, 'utf-8')
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => !/^\s*(\*|\/\/)/.test(line) && LIVENESS_PROBE.test(line))
    .map(({ line, number }) => `${path.relative(TESTS, file)}:${number}: ${line.trim()}`);
}

describe('whether a test asks if a process is still running', () => {
  it('goes through the zombie-aware helper, not a signal of 0', () => {
    const offenders = sourceFiles(TESTS)
      .filter((file) => !PROBES_ON_PURPOSE.has(path.relative(TESTS, file)) && path.relative(TESTS, file) !== SELF)
      .flatMap(probes);
    expect(offenders).toEqual([]);
  });

  it('sees a signal of 0 where one is written, so the scan above is not empty by accident', () => {
    expect(probes(path.join(TESTS, 'process-state.test.ts'))).toEqual(['process-state.test.ts:11: process.kill(pid, 0);']);
    expect(probes(path.join(TESTS, 'sandbox-isolation.test.ts'))).toEqual([
      'sandbox-isolation.test.ts:44: try { process.kill(parentPid, 0); } catch (err) { parentVisible = err.code === \'EPERM\'; }',
    ]);
  });
});
