import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxedExecutionOptions } from '../src/lib/security/process-sandbox';
import { PdfPostprocessError, SandboxUnavailableError } from '../src/lib/types';
import { QPDF_MEMORY_LIMIT_MB } from '../src/lib/conversions/pdf-postprocess/qpdf-run';

/**
 * Every qpdf the compression starts runs under the signal of the job and inside the time left to its deadline: the check that decides
 * whether the input is already clean, the question whether qpdf lists the pages, and the lossless rewrite that follows a failed check, as
 * well as the first rewrite. The runs are recorded at the two places that start a program (the launcher that holds the qpdf jobs and the
 * sandbox), so what is read is what the sandbox would be given, whatever the programs would have printed.
 */

const launched: Array<{ args: string[]; options: SandboxedExecutionOptions }> = [];
const ghostscript: Array<{ args: string[]; options: SandboxedExecutionOptions }> = [];
const executed: Array<{ args: string[]; options: SandboxedExecutionOptions }> = [];

vi.mock('../src/lib/conversions/pdf-postprocess/qpdf-runner', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/conversions/pdf-postprocess/qpdf-runner')>();
  return {
    ...original,
    launchQpdf: vi.fn(async (_binary: string, args: string[], options: SandboxedExecutionOptions) => {
      launched.push({ args, options });
      // As the launcher does: a run that is asked for after the job was stopped is not started.
      if (options.signal?.aborted) throw options.signal.reason;
      // A "document" that is no smaller than the input, so that the profile gains nothing and the later steps run.
      return { stdout: Buffer.from(STAND_IN_PDF), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 0, sandboxed: true, sandboxType: 'host' };
    }),
  };
});

vi.mock('../src/lib/security/process-sandbox', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/security/process-sandbox')>();
  return {
    ...original,
    executeSandboxedBinary: vi.fn(async (_binary: string, args: string[], options: SandboxedExecutionOptions) => {
      executed.push({ args, options });
      if (options.signal?.aborted) throw options.signal.reason;
      // `qpdf --check` reports the input damaged, which sends the compression to its last, lossless rewrite.
      throw new original.SandboxedProcessError('damaged', 2, 'damaged');
    }),
  };
});

/** A one-page PDF written by hand, with a classic cross-reference table: the compression opens it, and no program reads it here. */
function bareOnePagePdf(): string {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Resources << >> >>'];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefAt = body.length;
  const entries = offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return `${body}xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
}

const STAND_IN_PDF = bareOnePagePdf();

vi.mock('../src/lib/security/sandbox-launcher', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/security/sandbox-launcher')>();
  return {
    ...original,
    // Ghostscript writes the document to the file it is given; here it writes one no smaller than the input.
    launchSandboxedBinary: vi.fn(async (_binary: string, args: string[], options: SandboxedExecutionOptions) => {
      ghostscript.push({ args, options });
      if (options.signal?.aborted) throw options.signal.reason;
      const output = args.find((arg) => arg.startsWith('-sOutputFile='))!.slice('-sOutputFile='.length);
      fs.writeFileSync(output, STAND_IN_PDF);
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 0, sandboxed: true, sandboxType: 'host' };
    }),
  };
});

vi.mock('../src/lib/conversions/pdf-postprocess/gs-path', () => ({ getGhostscriptBinaryPath: () => '/usr/bin/gs' }));
const DEADLINE_MS = 8_000;

describe('the qpdf steps of the PDF compression', () => {
  beforeEach(() => {
    launched.length = 0;
    executed.length = 0;
    ghostscript.length = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function compressWith(run: { signal?: AbortSignal; remainingMs?: number }, profile: 'archive' | 'web' = 'web') {
    const { compressPdf } = await import('../src/lib/conversions/pdf-postprocess/compress');
    return compressPdf(Buffer.from(STAND_IN_PDF), { profile }, {}, run);
  }

  it('runs every qpdf under the signal of the job and inside the time left to its deadline', async () => {
    const controller = new AbortController();
    await compressWith({ signal: controller.signal, remainingMs: DEADLINE_MS });
    const runs = [...launched, ...executed, ...ghostscript];
    // Ghostscript's rewrite, the page listing, the check and the lossless rewrite after it.
    expect(runs.length).toBe(4);
    expect(executed.map((run) => run.args)).toEqual([expect.arrayContaining(['--check'])]);
    for (const { args, options } of runs) {
      // The limit handed to the step, not a measured time: it may not reach past the deadline of the job.
      expect(Math.min(options.timeoutMs ?? Infinity, DEADLINE_MS), `timeout of qpdf ${args.join(' ')}`).toBe(options.timeoutMs);
      expect(options.signal, `signal of qpdf ${args.join(' ')}`).toBeDefined();
      expect(options.signal!.aborted).toBe(false);
    }
    controller.abort(new Error('job cancelled'));
    for (const { args, options } of runs) expect(options.signal!.aborted, `abort reaches qpdf ${args.join(' ')}`).toBe(true);
  });

  it('starts no qpdf after the signal fired, and none after the deadline passed', async () => {
    const aborted = new AbortController();
    aborted.abort(new Error('job cancelled'));
    await expect(compressWith({ signal: aborted.signal, remainingMs: DEADLINE_MS })).rejects.toThrow('job cancelled');
    expect([...launched, ...executed, ...ghostscript].every((run) => run.options.signal?.aborted)).toBe(true);

    launched.length = 0;
    executed.length = 0;
    ghostscript.length = 0;
    await expect(compressWith({ remainingMs: 0 })).rejects.toBeInstanceOf(PdfPostprocessError);
    expect([...launched, ...executed, ...ghostscript]).toEqual([]);
  });

  it('runs the check under the memory limit of the other qpdf runs, not the default of the sandbox', async () => {
    await compressWith({ remainingMs: DEADLINE_MS });
    expect(executed.map((run) => run.options.memoryLimitMb)).toEqual([QPDF_MEMORY_LIMIT_MB]);
    expect(launched.map((run) => run.options.memoryLimitMb)).toEqual(launched.map(() => QPDF_MEMORY_LIMIT_MB));
  });

  it('does not take a sandbox that cannot be made for a damaged input: the check fails closed', async () => {
    const process = await import('../src/lib/security/process-sandbox');
    vi.mocked(process.executeSandboxedBinary).mockImplementationOnce(async () => {
      throw new SandboxUnavailableError('no namespace for the check');
    });
    await expect(compressWith({ remainingMs: DEADLINE_MS })).rejects.toBeInstanceOf(SandboxUnavailableError);
    // The lossless rewrite a damaged input gets is not started on a host that cannot confine its programs.
    expect(launched.filter((run) => run.args.includes('--compress-streams=y'))).toEqual([]);
  });

  it('does not take a check that ended because the job was cancelled for a damaged input', async () => {
    const controller = new AbortController();
    const process = await import('../src/lib/security/process-sandbox');
    vi.mocked(process.executeSandboxedBinary).mockImplementationOnce(async () => {
      controller.abort(new Error('job cancelled'));
      throw controller.signal.reason;
    });
    await expect(compressWith({ signal: controller.signal, remainingMs: DEADLINE_MS })).rejects.toThrow('job cancelled');
    // Nothing is started after the cancel: not the lossless rewrite the damaged-input path would run.
    const afterCheck = launched.filter((run) => !run.options.signal?.aborted);
    expect(afterCheck).toEqual([]);
  });
});
