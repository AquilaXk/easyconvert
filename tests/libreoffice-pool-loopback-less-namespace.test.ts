import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  LibreOfficePoolManager,
  LIBREOFFICE_READINESS_TIMEOUT_MS,
  type SandboxedProcessRunner,
} from '../src/worker/libreoffice-pool';
import { getUnshareCapability, SandboxedTimeoutError } from '../src/lib/security/process-sandbox';
import { EngineUnavailableError } from '../src/lib/types';
import { extractTextWithExternalPdftotext, getOracleToolPath } from './helpers/differential-oracle';
import { HAS_PDFTOTEXT, HAS_SOFFICE } from './helpers/native-tools';

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
/** A real docx -> pdf conversion takes a few seconds; anything near the timeout means the hang is back. */
const FAST_CONVERSION_BUDGET_MS = 25_000;
const TEST_TIMEOUT_MS = 120_000;
const FAILED_PROBE_BUDGET_MS = 1_000;
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

describe.skipIf(!HAS_SOFFICE || !HAS_PDFTOTEXT || !HAS_NET_NAMESPACE)(
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
        expect(elapsedMs).toBeLessThan(FAST_CONVERSION_BUDGET_MS);

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
    expect(Date.now() - started).toBeLessThan(FAILED_PROBE_BUDGET_MS);

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
