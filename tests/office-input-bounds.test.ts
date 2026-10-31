import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CFBF_MAX_FILE_BYTES } from '../src/lib/compound-file-kind';
import { boundedInput, isEncryptedLegacyOffice, legacyOfficeInput } from '../src/worker/office-input-checks';

/**
 * The one reader of an office input that the worker's checks share: an input held in memory is used as it is, a file is read only up
 * to the size the caller bounds it by, and a file past it is not read at all but goes to the office suite as it is; a missing file is the job's fault and is thrown as itself, not mistaken for a large one.
 * Legacy binary documents are bounded by what the in-process readers of those formats read.
 */

let directory = '';

beforeAll(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'office-input-bounds-'));
});

afterAll(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

function fileOfSize(name: string, bytes: number): string {
  const file = path.join(directory, name);
  fs.writeFileSync(file, '');
  fs.truncateSync(file, bytes);
  return file;
}

describe('boundedInput', () => {
  const outputPath = '/unused/out';

  it('uses an input that is held in memory as it is, whatever the bound', () => {
    const held = Buffer.from('held');
    expect(boundedInput(held, 1)).toBe(held);
    expect(boundedInput({ inputBuffer: held, outputPath }, 1)).toBe(held);
  });

  it('reads a file up to the bound, at the bound included', () => {
    const file = path.join(directory, 'small.bin');
    fs.writeFileSync(file, Buffer.from('0123456789'));
    expect(boundedInput({ inputPath: file, outputPath }, 10)?.toString()).toBe('0123456789');
    expect(boundedInput({ inputPath: file, outputPath }, 9)).toBeUndefined();
  });

  it('does not read a file past the bound nor an input with no source, and throws a missing file as itself', () => {
    expect(boundedInput({ inputPath: fileOfSize('past.bin', 11), outputPath }, 10)).toBeUndefined();
    expect(() => boundedInput({ inputPath: path.join(directory, 'missing.bin'), outputPath }, 10)).toThrow(/ENOENT/);
    expect(boundedInput({ outputPath }, 10)).toBeUndefined();
  });
});

describe('the input of a legacy binary Office document', () => {
  const outputPath = '/unused/out';

  it('is not read past the size the legacy readers accept', () => {
    expect(legacyOfficeInput({ inputPath: fileOfSize('past-limit.xls', CFBF_MAX_FILE_BYTES + 1), outputPath })).toBeUndefined();
  });

  it('is not judged encrypted when it is a file past that size', () => {
    const file = path.join(directory, 'past-limit-encrypted.xls');
    fs.writeFileSync(file, Buffer.from('d0cf11e0a1b11ae1', 'hex'));
    fs.truncateSync(file, CFBF_MAX_FILE_BYTES + 1);
    expect(isEncryptedLegacyOffice({ inputPath: file, outputPath }, 'xls')).toBe(false);
    expect(isEncryptedLegacyOffice({ inputPath: file, outputPath }, 'doc')).toBe(false);
  });
});
