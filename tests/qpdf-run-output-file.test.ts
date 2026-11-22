import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  QPDF_OUTPUT_FILE_MIN_BYTES,
  runQpdfToBuffer,
  withQpdfDocument,
  type QpdfWorkspace,
} from '../src/lib/conversions/pdf-postprocess/qpdf-run';
import type { LaunchedExecutionOptions } from '../src/lib/security/sandbox-launcher';
import { SandboxedProcessError, type SandboxedExecutionResult } from '../src/lib/security/process-sandbox';
import { PdfPostprocessError } from '../src/lib/types';

/**
 * What a qpdf run that writes its document to a file of the job directory does with the file a compromised or failed program leaves
 * behind (entry 391). The program is the seam: `launchQpdf` is replaced by a function that does what the test says to the output path,
 * so no qpdf is needed and the host reads what the sandbox would have left.
 */

type Leave = (output: string, options: LaunchedExecutionOptions) => SandboxedExecutionResult | Promise<SandboxedExecutionResult>;
let leave: Leave = () => ok();
const launched: Array<{ output: string; options: LaunchedExecutionOptions }> = [];

vi.mock('../src/lib/conversions/pdf-postprocess/qpdf-path', () => ({ getQpdfBinaryPath: () => '/usr/bin/qpdf' }));
vi.mock('../src/lib/conversions/pdf-postprocess/qpdf-runner', () => ({
  launchQpdf: vi.fn(async (_binary: string, args: string[], options: LaunchedExecutionOptions) => {
    const output = args[args.length - 1];
    launched.push({ output, options });
    return leave(output, options);
  }),
}));

function ok(): SandboxedExecutionResult {
  return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 0, sandboxed: true, sandboxType: 'host' };
}

const LARGE = Buffer.alloc(QPDF_OUTPUT_FILE_MIN_BYTES, 1);
const invocation = { action: 'Extracting pages', args: (output: string) => ['--empty', output] };

/** Runs one output-file qpdf run in the workspace of a large document; `inspect` sees the workspace while it exists. */
async function run(inspect?: (workspace: QpdfWorkspace) => void): Promise<Buffer> {
  return withQpdfDocument(LARGE, async (workspace) => {
    try {
      return await runQpdfToBuffer(workspace, invocation);
    } finally {
      inspect?.(workspace);
    }
  });
}

/** The job directory is gone after the run, and with it whatever the program left. */
const jobDirGone = (): boolean => launched.every(({ options }) => typeof options.workDir === 'string' && !fs.existsSync(options.workDir));

afterEach(() => {
  leave = () => ok();
  launched.length = 0;
});

describe('the output file of a qpdf run', () => {
  it('is read and removed', async () => {
    let remaining: string[] = [];
    leave = (output) => {
      fs.writeFileSync(output, 'PDF-BYTES');
      return ok();
    };

    const document = await run((workspace) => {
      remaining = fs.readdirSync(workspace.dir).filter((name) => name.startsWith('output-'));
    });

    expect(document.toString()).toBe('PDF-BYTES');
    expect(remaining).toEqual([]);
    expect(jobDirGone()).toBe(true);
  });

  it('is a failure, with the public message of empty output, when the run ends without writing it', async () => {
    const failure = await run().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PdfPostprocessError);
    expect((failure as Error).message).toBe('Extracting pages failed: qpdf produced no output.');
    expect(jobDirGone()).toBe(true);
  });

  it('is the same failure when the file is empty', async () => {
    leave = (output) => {
      fs.writeFileSync(output, '');
      return ok();
    };

    await expect(run()).rejects.toThrow('Extracting pages failed: qpdf produced no output.');
  });

  it('is refused over the size limit, with the file removed', async () => {
    let size = 0;
    leave = (output, options) => {
      size = (options.maxFileSize ?? 0) + 1;
      fs.writeFileSync(output, Buffer.alloc(size));
      return ok();
    };
    const mapped = await run().catch((error: unknown) => error);

    expect(size).toBeGreaterThan(QPDF_OUTPUT_FILE_MIN_BYTES);
    expect(mapped).toBeInstanceOf(PdfPostprocessError);
    expect((mapped as Error).message).toBe('Extracting pages failed: the result exceeds the allowed size.');
    expect(jobDirGone()).toBe(true);
  });

  it('is refused when it is a link, and the file it names is not read', async () => {
    leave = (output) => {
      fs.symlinkSync('/etc/hosts', output);
      return ok();
    };

    const failure = await run().catch((error: unknown) => error);

    expect((failure as Error).name).toBe('SandboxOutputKindError');
    expect(jobDirGone()).toBe(true);
  });

  it('is refused when it is a directory', async () => {
    leave = (output) => {
      fs.mkdirSync(output);
      return ok();
    };

    const failure = await run().catch((error: unknown) => error);

    expect((failure as Error).name).toBe('SandboxOutputKindError');
    expect(jobDirGone()).toBe(true);
  });

  // A read that waited for a writer would block the thread, so a regression ends the run (the job timeout) instead of failing this case.
  it('does not block the worker when it is a named pipe', async () => {
    leave = (output) => {
      expect(spawnSync('mkfifo', [output]).status).toBe(0);
      return ok();
    };

    const failure = await run().catch((error: unknown) => error);

    expect((failure as Error).name).toBe('SandboxOutputKindError');
    expect(jobDirGone()).toBe(true);
  });

  it('is removed, with the job directory, when the run ends abnormally', async () => {
    leave = (output) => {
      fs.writeFileSync(output, 'half a document');
      throw new SandboxedProcessError('qpdf: operation failed', 2, 'killed');
    };

    const failure = await run().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PdfPostprocessError);
    expect((failure as Error).message).toBe('Extracting pages failed: qpdf could not process the document.');
    expect(jobDirGone()).toBe(true);
  });
});
