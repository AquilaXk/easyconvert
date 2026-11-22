import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withQpdfDecryptedPdf } from '../src/worker/pdf-decrypt';
import type { LaunchedExecutionOptions } from '../src/lib/security/sandbox-launcher';

/**
 * The decrypted copy qpdf writes for Poppler is a result of a sandboxed program. The program is the seam here (`launchQpdf` is replaced), so
 * what it leaves at the path of the copy is the test's to say, and the cleanup that runs when the operation settles is what is read.
 */

let leave: (decryptedPath: string) => void = () => undefined;

vi.mock('../src/lib/conversions/pdf-postprocess/qpdf-path', () => ({ getQpdfBinaryPath: () => '/usr/bin/qpdf' }));
vi.mock('../src/lib/conversions/pdf-postprocess/qpdf-runner', () => ({
  launchQpdf: vi.fn(async (_binary: string, args: string[], _options: LaunchedExecutionOptions) => {
    leave(args[args.length - 1]);
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 0, sandboxed: true, sandboxType: 'host' };
  }),
}));

let tempDir: string;
let inputPath: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-decrypt-cleanup-'));
  inputPath = path.join(tempDir, 'input.pdf');
  fs.writeFileSync(inputPath, '%PDF-1.4\n');
});

afterEach(() => {
  leave = () => undefined;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const decryptedCopies = (): string[] => fs.readdirSync(tempDir).filter((name) => name.startsWith('decrypted-'));

describe('the decrypted copy of a PDF', () => {
  it('is removed when qpdf leaves a directory at its path, and the operation does not run', async () => {
    leave = (decryptedPath) => {
      fs.rmSync(decryptedPath);
      fs.mkdirSync(decryptedPath);
      fs.writeFileSync(path.join(decryptedPath, 'inner'), 'x');
    };
    const operation = vi.fn(async () => 'ran');

    const failure = await withQpdfDecryptedPdf({ inputPath, tempDir, password: 'pw', timeoutMs: 5000 }, operation).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(operation).not.toHaveBeenCalled();
    expect(decryptedCopies()).toEqual([]);
  });
});
