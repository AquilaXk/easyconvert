import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  LibreOfficePoolManager,
  LIBREOFFICE_READINESS_TIMEOUT_MS,
  LIBREOFFICE_READINESS_TIMEOUT_ENV,
  LIBREOFFICE_READINESS_TIMEOUT_MAX_MS,
  LIBREOFFICE_READINESS_FAILURE_TTL_MS,
  type SandboxedProcessRunner,
} from '../src/worker/libreoffice-pool';
import { getUnshareCapability, SandboxedTimeoutError } from '../src/lib/security/process-sandbox';
import { EngineUnavailableError } from '../src/lib/types';
import { extractTextWithExternalPdftotext, getOracleToolPath } from './helpers/differential-oracle';
import { skipWithoutTools } from './helpers/strict-skip';

/** Real engine, CLI or large-input work: the 5 s default fails on a loaded CI shard without any regression; 60 s only stops a hang. */
const ENGINE_TEST_TIMEOUT_MS = 60_000;
vi.setConfig({ testTimeout: ENGINE_TEST_TIMEOUT_MS });

/**
 * Issue #396: the pool sandboxes soffice in a fresh network namespace whose loopback interface is
 * down. A TCP UNO listener (`--accept=socket,host=127.0.0.1,...`) cannot bind there, so soffice
 * never exits and every pooled conversion waits for the full execution timeout.
 */

const SAMPLE_DOCX = fs.readFileSync(path.resolve(__dirname, 'fixtures', 'sample.docx'));
const PDF_MAGIC = '%PDF-';
const PDF_MAGIC_LENGTH = PDF_MAGIC.length;
/** The sandbox default execution timeout the hang used to burn; the fixed pool must stay far below it. */
const LEGACY_HANG_TIMEOUT_MS = 45_000;
/** Hang guard: a real docx -> pdf conversion takes a few seconds; anything near the legacy timeout means the hang is back. */
const FAST_CONVERSION_HANG_GUARD_MS = 25_000;
const TEST_TIMEOUT_MS = 120_000;
/** Hang guard: a failed probe is refused in milliseconds; the legacy behaviour waited the full 45 s. */
const FAILED_PROBE_HANG_GUARD_MS = 15_000;
const SAMPLE_PHRASES = ['EasyConvert Golden DOCX Standard', 'Header A', 'Header B'];

const HAS_NET_NAMESPACE = getUnshareCapability().supportsNetNamespace;

const activePools: LibreOfficePoolManager[] = [];

afterEach(async () => {
  while (activePools.length > 0) {
    await activePools.pop()!.shutdown();
  }
});

function trackPool(pool: LibreOfficePoolManager): LibreOfficePoolManager {
  activePools.push(pool);
  return pool;
}

function okResult() {
  return {
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    exitCode: 0,
    durationMs: 1,
    sandboxed: true,
    sandboxType: 'host' as const,
  };
}

// skip-ok: an unprivileged network namespace is a kernel setting some hosts forbid, not a missing tool.
describe.skipIf(skipWithoutTools('soffice', 'pdftotext', 'unshare') || !HAS_NET_NAMESPACE)(
  'pooled LibreOffice inside the loopback-less sandbox namespace (needs soffice, pdftotext, unshare -n)',
  () => {
    it(
      'converts docx to pdf promptly through the default sandboxed executor',
      async () => {
        const pool = trackPool(
          new LibreOfficePoolManager({
            sofficePath: getOracleToolPath('soffice'),
            minWorkers: 1,
            maxWorkers: 1,
            enabled: true,
          })
        );

        const started = Date.now();
        const result = await pool.convert(SAMPLE_DOCX, 'docx', 'pdf', { timeoutMs: LEGACY_HANG_TIMEOUT_MS }, 'sample.docx');
        const elapsedMs = Date.now() - started;

        expect(result).not.toBeNull();
        expect(result!.engineUsed).toBe('native-soffice-pool');
        expect(elapsedMs).toBeLessThan(FAST_CONVERSION_HANG_GUARD_MS);

        const pdf = result!.buffer;
        expect(pdf.subarray(0, PDF_MAGIC_LENGTH).toString('latin1')).toBe(PDF_MAGIC);
        const text = extractTextWithExternalPdftotext(pdf) ?? '';
        for (const phrase of SAMPLE_PHRASES) {
          expect(text).toContain(phrase);
        }
      },
      TEST_TIMEOUT_MS
    );

    it(
      'serves two concurrent jobs on separate workers without UNO pipe collisions',
      async () => {
        const pool = trackPool(
          new LibreOfficePoolManager({
            sofficePath: getOracleToolPath('soffice'),
            minWorkers: 1,
            maxWorkers: 2,
            enabled: true,
          })
        );

        const jobs = await Promise.all(
          [0, 1].map(() => pool.convert(SAMPLE_DOCX, 'docx', 'pdf', { timeoutMs: LEGACY_HANG_TIMEOUT_MS }, 'sample.docx'))
        );

        for (const job of jobs) {
          expect(job).not.toBeNull();
          expect(job!.buffer.subarray(0, PDF_MAGIC_LENGTH).toString('latin1')).toBe(PDF_MAGIC);
          expect(extractTextWithExternalPdftotext(job!.buffer) ?? '').toContain('Header A');
        }
      },
      TEST_TIMEOUT_MS
    );
  }
);

describe('LibreOffice pool readiness probe fails fast with a typed error', () => {
  it('uses a network-free pipe for the UNO accept string', async () => {
    const accepts: string[] = [];
    const executor: SandboxedProcessRunner = async (_bin, args, options) => {
      accepts.push(...args.filter((arg) => arg.startsWith('--accept=')));
      if (options?.cwd && args.includes('--convert-to')) {
        fs.writeFileSync(path.join(options.cwd, 'input.pdf'), Buffer.from('%PDF-1.7 stub'));
      }
      return okResult();
    };
    const pool = trackPool(
      new LibreOfficePoolManager({ sofficePath: '/usr/bin/soffice', minWorkers: 1, maxWorkers: 1, executor, enabled: true })
    );
    await pool.init();
    await pool.convert(Buffer.from('x'), 'docx', 'pdf');

    expect(accepts.length).toBeGreaterThanOrEqual(2);
    for (const accept of accepts) {
      expect(accept).toMatch(/^--accept=pipe,name=[A-Za-z0-9_-]+;urp;$/);
      expect(accept).not.toContain('socket');
      expect(accept).not.toContain('127.0.0.1');
    }
  });

  it('throws EngineUnavailableError within the probe budget instead of waiting for the job timeout', async () => {
    const seenTimeouts: Array<number | undefined> = [];
    const executor: SandboxedProcessRunner = async (_bin, args, options) => {
      seenTimeouts.push(options?.timeoutMs);
      if (args.includes('--convert-to')) {
        // The listener cannot start, so soffice never exits: the sandbox reports its own timeout.
        throw new SandboxedTimeoutError(options?.timeoutMs ?? 0);
      }
      return okResult();
    };
    const pool = trackPool(
      new LibreOfficePoolManager({
        sofficePath: '/usr/bin/soffice',
        minWorkers: 1,
        maxWorkers: 1,
        executor,
        enabled: true,
        readinessProbe: true,
      })
    );

    const started = Date.now();
    const run = pool.convert(Buffer.from('x'), 'docx', 'pdf', { timeoutMs: LEGACY_HANG_TIMEOUT_MS });
    await expect(run).rejects.toBeInstanceOf(EngineUnavailableError);
    await expect(run).rejects.toMatchObject({ engineName: 'libreoffice-pool' });
    await expect(run).rejects.toThrow(/readiness probe/);
    expect(Date.now() - started).toBeLessThan(FAILED_PROBE_HANG_GUARD_MS);

    // Only the bounded probe ran; the 45 s job conversion was never attempted.
    expect(seenTimeouts.filter((t) => t === LEGACY_HANG_TIMEOUT_MS)).toHaveLength(0);
    expect(seenTimeouts).toContain(LIBREOFFICE_READINESS_TIMEOUT_MS);
    expect(LIBREOFFICE_READINESS_TIMEOUT_MS).toBeLessThan(LEGACY_HANG_TIMEOUT_MS);
  });

  it('rejects a probe that exits cleanly without producing a PDF', async () => {
    const executor: SandboxedProcessRunner = async () => okResult();
    const pool = trackPool(
      new LibreOfficePoolManager({
        sofficePath: '/usr/bin/soffice',
        minWorkers: 1,
        maxWorkers: 1,
        executor,
        enabled: true,
        readinessProbe: true,
      })
    );

    await expect(pool.convert(Buffer.from('x'), 'docx', 'pdf')).rejects.toMatchObject({
      name: 'EngineUnavailableError',
      engineName: 'libreoffice-pool',
    });
  });

  it('probes once and then reuses the verified pool for later jobs', async () => {
    let probeRuns = 0;
    let jobRuns = 0;
    const executor: SandboxedProcessRunner = async (_bin, args, options) => {
      if (args.includes('--convert-to') && options?.cwd) {
        const inputArg = args[args.length - 1];
        if (inputArg.endsWith('probe.txt')) {
          probeRuns++;
        } else {
          jobRuns++;
        }
        const outName = path.basename(inputArg).replace(/\.[^.]+$/, '.pdf');
        fs.writeFileSync(path.join(path.dirname(inputArg), outName), Buffer.from('%PDF-1.7 stub'));
      }
      return okResult();
    };
    const pool = trackPool(
      new LibreOfficePoolManager({
        sofficePath: '/usr/bin/soffice',
        minWorkers: 1,
        maxWorkers: 1,
        executor,
        enabled: true,
        readinessProbe: true,
      })
    );

    await pool.convert(Buffer.from('a'), 'docx', 'pdf');
    await pool.convert(Buffer.from('b'), 'docx', 'pdf');

    expect(probeRuns).toBe(1);
    expect(jobRuns).toBe(2);
  });
});

function probePool(executor: SandboxedProcessRunner): LibreOfficePoolManager {
  return trackPool(
    new LibreOfficePoolManager({
      sofficePath: '/usr/bin/soffice',
      minWorkers: 1,
      maxWorkers: 1,
      executor,
      enabled: true,
      readinessProbe: true,
    })
  );
}

function isProbeCall(args: string[]): boolean {
  return args[args.length - 1].endsWith('probe.txt');
}

describe('LibreOffice pool readiness probe lifecycle', () => {
  it('passes its own network-free pipe accept string, unique per process, to the probe', async () => {
    const probeAccepts: string[] = [];
    const executor: SandboxedProcessRunner = async (_bin, args, options) => {
      if (isProbeCall(args)) {
        probeAccepts.push(...args.filter((arg) => arg.startsWith('--accept=')));
        fs.writeFileSync(path.join(options!.cwd!, 'probe.pdf'), Buffer.from('%PDF-1.7 stub'));
      } else if (args.includes('--convert-to')) {
        fs.writeFileSync(path.join(options!.cwd!, 'input.pdf'), Buffer.from('%PDF-1.7 stub'));
      }
      return okResult();
    };
    await probePool(executor).convert(Buffer.from('x'), 'docx', 'pdf');

    expect(probeAccepts).toHaveLength(1);
    expect(probeAccepts[0]).toMatch(new RegExp(`^--accept=pipe,name=ec_probe_${process.pid}_[0-9a-f]{8};urp;$`));
  });

  it('names worker pipes with the process id for cross-process uniqueness', async () => {
    const pool = trackPool(
      new LibreOfficePoolManager({ sofficePath: '/usr/bin/soffice', executor: async () => okResult(), enabled: true })
    );
    const worker = await pool.createWorker();
    expect(worker.unoPipeName).toMatch(new RegExp(`^ec_${process.pid}_worker_[0-9a-f]{8}$`));
    expect(worker.unoAccept).toBe(`pipe,name=${worker.unoPipeName};urp;`);
  });

  describe('failure caching', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('runs a failing probe once within the failure TTL and again after it expires', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      let probeRuns = 0;
      const executor: SandboxedProcessRunner = async (_bin, args) => {
        if (isProbeCall(args)) {
          probeRuns++;
          throw new SandboxedTimeoutError(LIBREOFFICE_READINESS_TIMEOUT_MS);
        }
        return okResult();
      };
      const pool = probePool(executor);

      for (let call = 0; call < 3; call++) {
        await expect(pool.convert(Buffer.from('x'), 'docx', 'pdf')).rejects.toBeInstanceOf(EngineUnavailableError);
      }
      expect(probeRuns).toBe(1);

      vi.setSystemTime(Date.now() + LIBREOFFICE_READINESS_FAILURE_TTL_MS + 1);
      await expect(pool.convert(Buffer.from('x'), 'docx', 'pdf')).rejects.toBeInstanceOf(EngineUnavailableError);
      expect(probeRuns).toBe(2);
    });

    it('recovers after the TTL once the probe succeeds', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      let healthy = false;
      const executor: SandboxedProcessRunner = async (_bin, args, options) => {
        if (isProbeCall(args) && !healthy) {
          throw new SandboxedTimeoutError(LIBREOFFICE_READINESS_TIMEOUT_MS);
        }
        if (args.includes('--convert-to')) {
          const inputArg = args[args.length - 1];
          const outName = path.basename(inputArg).replace(/\.[^.]+$/, '.pdf');
          fs.writeFileSync(path.join(options!.cwd!, outName), Buffer.from('%PDF-1.7 stub'));
        }
        return okResult();
      };
      const pool = probePool(executor);

      await expect(pool.convert(Buffer.from('x'), 'docx', 'pdf')).rejects.toBeInstanceOf(EngineUnavailableError);
      healthy = true;
      vi.setSystemTime(Date.now() + LIBREOFFICE_READINESS_FAILURE_TTL_MS + 1);
      const result = await pool.convert(Buffer.from('x'), 'docx', 'pdf');
      expect(result!.buffer.subarray(0, PDF_MAGIC_LENGTH).toString('latin1')).toBe(PDF_MAGIC);
    });
  });

  describe('error reporting', () => {
    it('reports the budget only for timeouts and keeps the original message for other failures', async () => {
      const failures: Error[] = [new SandboxedTimeoutError(LIBREOFFICE_READINESS_TIMEOUT_MS), new Error('spawn EACCES')];
      const messages: string[] = [];
      for (const failure of failures) {
        const pool = probePool(async (_bin, args) => {
          if (isProbeCall(args)) throw failure;
          return okResult();
        });
        const err = await pool.convert(Buffer.from('x'), 'docx', 'pdf').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(EngineUnavailableError);
        messages.push((err as EngineUnavailableError).reason);
      }
      expect(messages[0]).toContain(`within ${LIBREOFFICE_READINESS_TIMEOUT_MS}ms`);
      expect(messages[1]).toContain('spawn EACCES');
      expect(messages[1]).not.toContain('within');
    });
  });

  describe('probe budget override', () => {
    const previous = process.env[LIBREOFFICE_READINESS_TIMEOUT_ENV];

    afterEach(() => {
      if (previous === undefined) {
        delete process.env[LIBREOFFICE_READINESS_TIMEOUT_ENV];
      } else {
        process.env[LIBREOFFICE_READINESS_TIMEOUT_ENV] = previous;
      }
    });

    it('defaults to 30 s, below the 45 s job timeout', () => {
      expect(LIBREOFFICE_READINESS_TIMEOUT_MS).toBe(30_000);
      expect(LIBREOFFICE_READINESS_TIMEOUT_MAX_MS).toBeLessThan(LEGACY_HANG_TIMEOUT_MS);
    });

    it('applies a valid override to the probe timeout', async () => {
      const override = 12_345;
      process.env[LIBREOFFICE_READINESS_TIMEOUT_ENV] = String(override);
      const seen: number[] = [];
      const pool = probePool(async (_bin, args, options) => {
        if (isProbeCall(args)) {
          seen.push(options!.timeoutMs!);
          fs.writeFileSync(path.join(options!.cwd!, 'probe.pdf'), Buffer.from('%PDF-1.7 stub'));
        } else if (args.includes('--convert-to')) {
          fs.writeFileSync(path.join(options!.cwd!, 'input.pdf'), Buffer.from('%PDF-1.7 stub'));
        }
        return okResult();
      });
      await pool.convert(Buffer.from('x'), 'docx', 'pdf');
      expect(seen).toEqual([override]);
    });

    it.each(['abc', '1.5', '-1', '100', String(LIBREOFFICE_READINESS_TIMEOUT_MAX_MS + 1), '45000'])(
      'rejects the invalid override %s with a typed error and never starts soffice',
      async (value) => {
        process.env[LIBREOFFICE_READINESS_TIMEOUT_ENV] = value;
        let calls = 0;
        const pool = probePool(async () => {
          calls++;
          return okResult();
        });
        const run = pool.convert(Buffer.from('x'), 'docx', 'pdf');
        await expect(run).rejects.toBeInstanceOf(EngineUnavailableError);
        await expect(run).rejects.toThrow(new RegExp(LIBREOFFICE_READINESS_TIMEOUT_ENV));
        expect(calls).toBe(0);
      }
    );
  });

  describe('caller abort', () => {
    it('returns promptly when the caller aborts while the shared probe is still running', async () => {
      let releaseProbe: (() => void) | undefined;
      const probeGate = new Promise<void>((resolve) => {
        releaseProbe = resolve;
      });
      let probeSignal: AbortSignal | undefined;
      const executor: SandboxedProcessRunner = async (_bin, args, options) => {
        if (isProbeCall(args)) {
          probeSignal = options?.signal;
          await probeGate;
        }
        return okResult();
      };
      const pool = probePool(executor);
      const controller = new AbortController();
      const reason = new Error('caller gave up');

      try {
        const started = Date.now();
        const run = pool.convert(Buffer.from('x'), 'docx', 'pdf', { signal: controller.signal });
        setTimeout(() => controller.abort(reason), 20);
        await expect(run).rejects.toBe(reason);
        expect(Date.now() - started).toBeLessThan(FAILED_PROBE_HANG_GUARD_MS);
        // One caller's signal must never be wired into the probe other callers share.
        expect(probeSignal).toBeUndefined();
      } finally {
        releaseProbe?.();
      }
    });

    it('rejects immediately for an already aborted signal', async () => {
      const pool = probePool(async () => okResult());
      const controller = new AbortController();
      controller.abort(new Error('already aborted'));
      await expect(
        pool.convert(Buffer.from('x'), 'docx', 'pdf', { signal: controller.signal })
      ).rejects.toThrow('already aborted');
    });
  });
});
