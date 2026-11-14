import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  readSandboxOutput,
  readSandboxOutputAsync,
  readSandboxOutputFiles,
  readSandboxOutputIfPresent,
  sandboxOutputSize,
  SandboxOutputKindError,
  writeSandboxOutput,
} from '../src/lib/security/sandbox-output';

/**
 * The reads of what a sandboxed program wrote refuse a link, a directory and a named pipe, which a program can make at its output
 * path, and read the regular file the way a plain read would.
 */

let root: string;
let secret: string;
let jobDir: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-output-'));
  secret = path.join(root, 'secret.txt');
  fs.writeFileSync(secret, 'HOST SECRET');
  jobDir = path.join(root, 'job');
  fs.mkdirSync(jobDir);
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function output(name: string): string {
  return path.join(jobDir, name);
}

describe('a regular file', () => {
  it('is read, sized and rewritten like a plain file', async () => {
    const file = output('regular.bin');
    fs.writeFileSync(file, 'abc');

    expect(readSandboxOutput(file).toString()).toBe('abc');
    expect((await readSandboxOutputAsync(file)).toString()).toBe('abc');
    expect(readSandboxOutputIfPresent(file)?.toString()).toBe('abc');
    expect(sandboxOutputSize(file)).toBe(3);

    writeSandboxOutput(file, 'replaced');
    expect(fs.readFileSync(file, 'utf8')).toBe('replaced');
  });

  it('is refused by the guard before a byte is read', () => {
    const file = output('large.bin');
    fs.writeFileSync(file, 'x'.repeat(100));
    const refused = new Error('too large');

    expect(() => readSandboxOutput(file, (size) => { if (size >= 100) throw refused; })).toThrow(refused);
    expect(readSandboxOutput(file, (size) => { if (size > 100) throw refused; })).toHaveLength(100);
  });
});

describe('a missing file', () => {
  it('is null where the caller asks for one that may be missing, and ENOENT where it does not', async () => {
    const file = output('missing.bin');

    expect(readSandboxOutputIfPresent(file)).toBeNull();
    expect(sandboxOutputSize(file)).toBeNull();
    expect(() => readSandboxOutput(file)).toThrow(/ENOENT/);
    await expect(readSandboxOutputAsync(file)).rejects.toThrow(/ENOENT/);
  });
});

describe('a link at the output path', () => {
  it('is refused, not followed to the file it names', async () => {
    const link = output('link.bin');
    fs.symlinkSync(secret, link);

    expect(() => readSandboxOutput(link)).toThrow(SandboxOutputKindError);
    expect(() => readSandboxOutputIfPresent(link)).toThrow(SandboxOutputKindError);
    expect(() => sandboxOutputSize(link)).toThrow(SandboxOutputKindError);
    await expect(readSandboxOutputAsync(link)).rejects.toBeInstanceOf(SandboxOutputKindError);
    expect(() => writeSandboxOutput(link, 'overwritten')).toThrow(SandboxOutputKindError);
    expect(fs.readFileSync(secret, 'utf8')).toBe('HOST SECRET');
  });

  it('is refused when it dangles, and the plain read it replaces reads the file it names', () => {
    const link = output('dangling.bin');
    fs.symlinkSync(path.join(root, 'nothing-here'), link);

    expect(() => readSandboxOutput(link)).toThrow(SandboxOutputKindError);
    expect(fs.readFileSync(path.join(output('link.bin')), 'utf8')).toBe('HOST SECRET');
  });
});

describe('what is not a file at the output path', () => {
  it('refuses a directory', () => {
    const directory = output('directory.bin');
    fs.mkdirSync(directory);

    expect(() => readSandboxOutput(directory)).toThrow(SandboxOutputKindError);
    expect(() => sandboxOutputSize(directory)).toThrow(SandboxOutputKindError);
  });

  describe('the files of a directory', () => {
  it('reads the regular files, skips a subdirectory and refuses a link among them', () => {
    const directory = path.join(root, 'listing');
    fs.mkdirSync(path.join(directory, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'a.ts'), 'a');
    fs.writeFileSync(path.join(directory, 'b.ts'), 'b');

    expect(readSandboxOutputFiles(directory, ['a.ts', 'sub', 'b.ts']).map((file) => [file.name, file.bytes.toString()])).toEqual([['a.ts', 'a'], ['b.ts', 'b']]);

    fs.symlinkSync(secret, path.join(directory, 'c.ts'));
    expect(() => readSandboxOutputFiles(directory, ['a.ts', 'c.ts'])).toThrow(SandboxOutputKindError);
  });
});

// A read that waited for a writer would never return, so this case ends the run instead of failing it.
  it('refuses a named pipe without waiting for a writer', () => {
    const pipe = output('pipe.bin');
    expect(spawnSync('mkfifo', [pipe]).status).toBe(0);

    expect(() => readSandboxOutput(pipe)).toThrow(SandboxOutputKindError);
  });
});
