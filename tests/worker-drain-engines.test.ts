import { afterEach, describe, expect, it, vi } from 'vitest';
import * as qpdfRunner from '../src/lib/conversions/pdf-postprocess/qpdf-runner';
import * as pdfTextHost from '../src/lib/conversions/pdf-text-host';
import { libreOfficePool } from '../src/worker/engines';
import { drainWorker, ENGINE_SHUTDOWN_TIMEOUT_MS, resetWorkerLifecycleState, shutdownEngines } from '../src/worker/index';

/**
 * The drain of a recycled or stopped worker stops the engines that outlive a job (docs/policy-decisions.md, entry 232): the LibreOffice
 * pool removes its profile directories only when it is shut down, and the qpdf runner and the PDF text threads are child processes and
 * threads of this process.
 */

afterEach(() => {
  resetWorkerLifecycleState();
  vi.restoreAllMocks();
});

function spyOnEngines() {
  return {
    pool: vi.spyOn(libreOfficePool, 'shutdown').mockResolvedValue(undefined),
    runner: vi.spyOn(qpdfRunner, 'stopQpdfRunner').mockImplementation(() => undefined),
    threads: vi.spyOn(pdfTextHost, 'shutdownPdfTextThreads').mockImplementation(() => undefined),
  };
}

describe('drainWorker', () => {
  it('stops the LibreOffice pool, the qpdf runner and the PDF text threads', async () => {
    const engines = spyOnEngines();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await drainWorker('RECYCLE', 50);
    expect(engines.pool).toHaveBeenCalledTimes(1);
    expect(engines.runner).toHaveBeenCalledTimes(1);
    expect(engines.threads).toHaveBeenCalledTimes(1);
  });
});

describe('shutdownEngines', () => {
  it('stops the other engines when one throws, and says which one', async () => {
    const engines = spyOnEngines();
    engines.pool.mockRejectedValue(new Error('soffice is stuck'));
    engines.runner.mockImplementation(() => {
      throw new Error('no runner');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await shutdownEngines();
    expect(engines.threads).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('The LibreOffice pool did not stop cleanly: soffice is stuck'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('The qpdf runner did not stop cleanly: no runner'));
  });

  it('gives up waiting after the timeout, so an engine that hangs cannot keep a recycled worker alive', async () => {
    const engines = spyOnEngines();
    engines.pool.mockImplementation(() => new Promise<void>(() => {}));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const started = Date.now();
    await shutdownEngines(50);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(engines.runner).toHaveBeenCalledTimes(1);
    expect(engines.threads).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('still stopping after 50ms'));
  });

  it('waits for an engine that finishes within the timeout', async () => {
    const engines = spyOnEngines();
    let finished = false;
    engines.pool.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      finished = true;
    });
    await shutdownEngines(5000);
    expect(finished).toBe(true);
  });

  it('is bounded well below the stop grace period of the production worker container', () => {
    expect(ENGINE_SHUTDOWN_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
  });
});
