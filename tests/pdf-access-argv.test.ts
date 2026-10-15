import { describe, expect, it, vi } from 'vitest';
import { applyPdfWatermark } from '../src/lib/conversions/pdf-postprocess';
import { mergePdfBuffers } from '../src/lib/jobs';
import { AES_256, plainPdf, qpdfEncrypt } from './helpers/encrypted-pdf-fixtures';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * #571: the password of an encrypted PDF reaches qpdf through a file, never through argv (readable by every local
 * process). The recorder wraps child_process.spawn, the one call every sandboxed binary goes through, and delegates
 * to the real implementation so qpdf really runs.
 */

const spawned = vi.hoisted(() => ({ active: false, argv: [] as string[][] }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const recordingSpawn = ((command: string, argsOrOptions?: unknown, maybeOptions?: unknown) => {
    if (spawned.active) {
      spawned.argv.push([command, ...(Array.isArray(argsOrOptions) ? argsOrOptions.map(String) : [])]);
    }
    return (actual.spawn as (...a: unknown[]) => unknown)(command, argsOrOptions, maybeOptions);
  }) as typeof actual.spawn;
  return { ...actual, spawn: recordingSpawn, default: { ...actual, spawn: recordingSpawn } };
});

const PASSWORD = 'Argv-Canary-3c9d0e71';

describe.skipIf(skipWithoutTools('qpdf', 'pdftotext'))('the PDF password stays out of every spawned command line', () => {
  async function recorded(run: () => Promise<unknown>): Promise<string[][]> {
    spawned.argv = [];
    spawned.active = true;
    try {
      await run();
    } finally {
      spawned.active = false;
    }
    return spawned.argv;
  }

  it('watermark: qpdf inspects and decrypts through --password-file only', async () => {
    const pdf = qpdfEncrypt(await plainPdf(), { variant: AES_256, userPassword: PASSWORD, ownerPassword: 'owner-secret-1' });
    const calls = await recorded(() => applyPdfWatermark(pdf, { text: 'MARK' }, { password: PASSWORD }));

    const qpdfCalls = calls.filter((argv) => /qpdf$/.test(argv[0]) || argv.some((arg) => arg.startsWith('--password-file=')));
    expect(qpdfCalls.length).toBeGreaterThanOrEqual(2);
    expect(calls.flat().some((arg) => arg.includes(PASSWORD))).toBe(false);
    for (const argv of qpdfCalls) {
      expect(argv.some((arg) => arg.startsWith('--password-file='))).toBe(true);
    }
  });

  it('merge: qpdf receives the password of each input through --password-file only', async () => {
    const pdf = qpdfEncrypt(await plainPdf(), { variant: AES_256, userPassword: PASSWORD, ownerPassword: 'owner-secret-1' });
    const plain = await plainPdf();
    const calls = await recorded(() => mergePdfBuffers([pdf, plain], { passwords: [PASSWORD] }));
    expect(calls.flat().some((arg) => arg.includes(PASSWORD))).toBe(false);
    expect(calls.some((argv) => argv.some((arg) => arg.startsWith('--password-file=')))).toBe(true);
  });
});
