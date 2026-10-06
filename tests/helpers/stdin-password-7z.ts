import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The engines hand a password to 7-Zip through a bare `-p` switch and stdin, which relies on the
 * interactive prompt of p7zip. Newer 7-Zip builds treat a bare `-p` on extraction as an empty
 * password and never read stdin, so encrypted-archive tests cannot decrypt anything on them.
 *
 * `resolveStdinPasswordSevenZip` returns the host binary untouched when it supports the stdin
 * prompt, and otherwise a small wrapper that performs the same hand-off (first stdin line becomes
 * `-p<line>`) before running the real binary. The wrapper changes only how the password reaches 7z;
 * the archives and every containment check under test are unchanged.
 */

const PROBE_PASSWORD = 'probe-Password-1';
const PROBE_CONTENT = 'stdin password probe';
const PROBE_TIMEOUT_MS = 30_000;

function supportsStdinPassword(sevenZip: string): boolean {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-7z-probe-'));
  try {
    fs.writeFileSync(path.join(work, 'probe.txt'), PROBE_CONTENT);
    execFileSync(sevenZip, ['a', '-tzip', '-mem=AES256', `-p${PROBE_PASSWORD}`, '-y', 'probe.zip', 'probe.txt'], {
      cwd: work,
      stdio: 'pipe',
      timeout: PROBE_TIMEOUT_MS,
    });
    fs.rmSync(path.join(work, 'probe.txt'));
    try {
      execFileSync(sevenZip, ['x', '-y', '-p', '-oout', 'probe.zip'], {
        cwd: work,
        input: `${PROBE_PASSWORD}\n`,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: PROBE_TIMEOUT_MS,
      });
    } catch {
      return false;
    }
    const extracted = path.join(work, 'out', 'probe.txt');
    return fs.existsSync(extracted) && fs.readFileSync(extracted, 'utf-8') === PROBE_CONTENT;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

const WRAPPER_SOURCE = (realBinary: string): string => `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
const at = args.indexOf('-p');
if (at !== -1) {
  const firstLine = fs.readFileSync(0, 'utf-8').split('\\n')[0];
  args[at] = '-p' + firstLine;
}
const result = spawnSync(${JSON.stringify(realBinary)}, args, { stdio: ['ignore', 'inherit', 'inherit'] });
process.exit(result.status === null ? 1 : result.status);
`;

export interface StdinPasswordSevenZip {
  /** Absolute path the engines should use as their 7z binary. */
  binary: string;
  /** True when the wrapper was needed because the host binary lacks the stdin prompt. */
  wrapped: boolean;
  cleanup(): void;
}

export function resolveStdinPasswordSevenZip(realBinary: string): StdinPasswordSevenZip {
  if (supportsStdinPassword(realBinary)) {
    return { binary: realBinary, wrapped: false, cleanup: () => undefined };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-7z-shim-'));
  const wrapperPath = path.join(dir, '7z');
  fs.writeFileSync(wrapperPath, WRAPPER_SOURCE(realBinary), { mode: 0o755 });
  return {
    binary: wrapperPath,
    wrapped: true,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
