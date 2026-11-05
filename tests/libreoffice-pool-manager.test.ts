import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  LibreOfficePoolManager,
  LibreOfficePoolTimeoutError,
  WorkerLifecycleState,
  resolveLibreOfficeFilter,
} from '../src/worker/libreoffice-pool';
import {
  convertWithHeadlessOffice,
  getLibreOfficePool,
  libreOfficePool,
} from '../src/worker/engines';
import { UnsupportedOptionError } from '../src/lib/types';

// A real soffice run includes the pool readiness probe, which takes several seconds on a loaded host.
const REAL_SOFFICE_TIMEOUT_MS = 60_000;

describe('Pre-warmed LibreOffice worker pool', () => {
  const activePools: LibreOfficePoolManager[] = [];

  afterEach(async () => {
    while (activePools.length > 0) {
      const pool = activePools.pop()!;
      await pool.shutdown();
    }
  });

  describe('1. Pool Initialization & Lifecycle State Machine', () => {
    it('initializes pool with custom concurrency bounds and pre-warms minWorkers', async () => {
      const pool = new LibreOfficePoolManager({
        minWorkers: 2,
        maxWorkers: 4,
        maxJobsPerWorker: 10,
        acquireTimeoutMs: 500,
        sofficePath: '/mock/path/soffice',
        enabled: true,
      });
      activePools.push(pool);

      await pool.init();

      const stats = pool.getStats();
      expect(stats.totalWorkers).toBe(2);
      expect(stats.readyWorkers).toBe(2);
      expect(stats.busyWorkers).toBe(0);
      expect(stats.queueLength).toBe(0);
      expect(stats.totalJobsProcessed).toBe(0);
    });

    it('transitions worker through INITIALIZING -> READY -> BUSY -> READY states', async () => {
      const pool = new LibreOfficePoolManager({
        minWorkers: 1,
        maxWorkers: 2,
        enabled: true,
      });
      activePools.push(pool);

      await pool.init();
      expect(pool.getStats().readyWorkers).toBe(1);

      // Acquire worker -> becomes BUSY
      const worker = await pool.acquireWorker();
      expect(worker.state).toBe('BUSY');
      expect(pool.getStats().busyWorkers).toBe(1);
      expect(pool.getStats().readyWorkers).toBe(0);

      // Profile directory exists on disk and is isolated
      expect(fs.existsSync(worker.userProfileDir)).toBe(true);
      expect(fs.existsSync(worker.workDir)).toBe(true);

      // Release worker -> becomes READY
      await pool.releaseWorker(worker);
      expect(worker.state).toBe('READY');
      expect(pool.getStats().busyWorkers).toBe(0);
      expect(pool.getStats().readyWorkers).toBe(1);
      expect(worker.jobCount).toBe(1);
    });

    it('creates workers on demand up to maxWorkers bound', async () => {
      const pool = new LibreOfficePoolManager({
        minWorkers: 1,
        maxWorkers: 3,
        enabled: true,
      });
      activePools.push(pool);

      const w1 = await pool.acquireWorker();
      const w2 = await pool.acquireWorker();
      const w3 = await pool.acquireWorker();

      expect(pool.getStats().totalWorkers).toBe(3);
      expect(pool.getStats().busyWorkers).toBe(3);
      expect(w1.id).not.toBe(w2.id);
      expect(w2.id).not.toBe(w3.id);

      await pool.releaseWorker(w1);
      await pool.releaseWorker(w2);
      await pool.releaseWorker(w3);

      expect(pool.getStats().readyWorkers).toBe(3);
      expect(pool.getStats().busyWorkers).toBe(0);
    });
  });

  describe('2. FIFO Concurrency Queueing & Timeout Throttling', () => {
    it('queues requests in strict FIFO order when all workers are busy', async () => {
      const pool = new LibreOfficePoolManager({
        maxWorkers: 1,
        acquireTimeoutMs: 2000,
        enabled: true,
      });
      activePools.push(pool);

      const worker1 = await pool.acquireWorker();
      expect(worker1.state).toBe('BUSY');

      const dispatchOrder: number[] = [];

      // Queue 3 requests
      const p1 = pool.acquireWorker().then(async (w) => {
        dispatchOrder.push(1);
        await pool.releaseWorker(w);
      });
      const p2 = pool.acquireWorker().then(async (w) => {
        dispatchOrder.push(2);
        await pool.releaseWorker(w);
      });
      const p3 = pool.acquireWorker().then(async (w) => {
        dispatchOrder.push(3);
        await pool.releaseWorker(w);
      });

      expect(pool.getStats().queueLength).toBe(3);

      // Releasing worker1 dispatches p1, which releases to p2, which releases to p3
      await pool.releaseWorker(worker1);
      await Promise.all([p1, p2, p3]);

      expect(dispatchOrder).toEqual([1, 2, 3]);
      expect(pool.getStats().queueLength).toBe(0);
    });

    it('rejects with LibreOfficePoolTimeoutError when acquire times out in saturated queue', async () => {
      const pool = new LibreOfficePoolManager({
        maxWorkers: 1,
        acquireTimeoutMs: 50,
        enabled: true,
      });
      activePools.push(pool);

      const worker = await pool.acquireWorker();

      await expect(pool.acquireWorker(50)).rejects.toThrow(LibreOfficePoolTimeoutError);

      await pool.releaseWorker(worker);
    });
  });

  describe('3. Automated Worker Recycling & Memory Leak Mitigation', () => {
    it('automatically recycles worker after maxJobsPerWorker threshold and spawns fresh instance', async () => {
      const pool = new LibreOfficePoolManager({
        maxWorkers: 1,
        maxJobsPerWorker: 3,
        enabled: true,
      });
      activePools.push(pool);

      const w1 = await pool.acquireWorker();
      const oldProfileDir = w1.userProfileDir;
      const oldWorkDir = w1.workDir;
      const oldId = w1.id;

      // Job 1
      await pool.releaseWorker(w1);
      expect(w1.jobCount).toBe(1);

      // Job 2
      const w2 = await pool.acquireWorker();
      expect(w2.id).toBe(oldId);
      await pool.releaseWorker(w2);
      expect(w2.jobCount).toBe(2);

      // Job 3 (Threshold hit -> triggers recycleWorker)
      const w3 = await pool.acquireWorker();
      expect(w3.id).toBe(oldId);
      await pool.releaseWorker(w3); // 3 >= 3 -> recycled!

      // Old directories cleaned up
      expect(fs.existsSync(oldProfileDir)).toBe(false);
      expect(fs.existsSync(oldWorkDir)).toBe(false);

      // Next acquired worker is a fresh replacement instance
      const wFresh = await pool.acquireWorker();
      expect(wFresh.id).not.toBe(oldId);
      expect(wFresh.jobCount).toBe(0);
      expect(fs.existsSync(wFresh.userProfileDir)).toBe(true);

      await pool.releaseWorker(wFresh);
    });

    it('recycles worker immediately when an error is reported', async () => {
      const pool = new LibreOfficePoolManager({
        maxWorkers: 1,
        maxJobsPerWorker: 50,
        enabled: true,
      });
      activePools.push(pool);

      const worker = await pool.acquireWorker();
      const faultyProfileDir = worker.userProfileDir;
      const faultyId = worker.id;

      // Release with hasError = true
      await pool.releaseWorker(worker, true);

      // Old worker destroyed
      expect(fs.existsSync(faultyProfileDir)).toBe(false);

      // New replacement ready
      const freshWorker = await pool.acquireWorker();
      expect(freshWorker.id).not.toBe(faultyId);
      expect(freshWorker.jobCount).toBe(0);

      await pool.releaseWorker(freshWorker);
    });

    it('bounds concurrent cold spawns by maxWorkers using spawningWorkers accounting', async () => {
      let spawnCount = 0;
      const slowExecutor = vi.fn(async () => {
        spawnCount++;
        await new Promise((r) => setTimeout(r, 40));
        return {
          stdout: Buffer.from(''),
          stderr: Buffer.from(''),
          exitCode: 0,
          durationMs: 40,
          sandboxed: true,
          sandboxType: 'host' as const,
        };
      });

      const pool = new LibreOfficePoolManager({
        maxWorkers: 2,
        sofficePath: '/usr/bin/soffice',
        enabled: true,
        executor: slowExecutor,
      });
      activePools.push(pool);

      const p1 = pool.acquireWorker();
      const p2 = pool.acquireWorker();
      const p3 = pool.acquireWorker();
      const p4 = pool.acquireWorker();

      const [w1, w2] = await Promise.all([p1, p2]);
      expect(pool.getStats().totalWorkers).toBe(2);
      expect(spawnCount).toBe(2);

      await pool.releaseWorker(w1);
      await pool.releaseWorker(w2);

      const [w3, w4] = await Promise.all([p3, p4]);
      expect(pool.getStats().totalWorkers).toBe(2);
      expect(spawnCount).toBe(2);

      await pool.releaseWorker(w3);
      await pool.releaseWorker(w4);
    });

    it('rejects the next queued waiter immediately when replacement worker creation fails during recycle', async () => {
      const pool = new LibreOfficePoolManager({
        maxWorkers: 1,
        maxJobsPerWorker: 1,
        acquireTimeoutMs: 10_000,
        enabled: true,
      });
      activePools.push(pool);

      const w1 = await pool.acquireWorker();
      w1.jobCount = 1;
      const queuedWaiter = pool.acquireWorker();
      vi.spyOn(pool, 'createWorker').mockRejectedValueOnce(
        new Error('ENOSPC: failed to create replacement sandbox dir')
      );

      await pool.releaseWorker(w1);
      await expect(queuedWaiter).rejects.toThrow(/ENOSPC: failed to create replacement sandbox dir/);
    });

    it('drains and rejects all queued waiters when a cold spawn fails with zero remaining workers', async () => {
      const pool = new LibreOfficePoolManager({
        maxWorkers: 1,
        acquireTimeoutMs: 10_000,
        enabled: true,
      });
      activePools.push(pool);

      vi.spyOn(pool, 'createWorker').mockImplementationOnce(async () => {
        await new Promise((r) => setTimeout(r, 20));
        throw new Error('ENOMEM: cold worker creation failed');
      });

      const p1 = pool.acquireWorker();
      const p2 = pool.acquireWorker();
      const p3 = pool.acquireWorker();

      await expect(p1).rejects.toThrow(/ENOMEM: cold worker creation failed/);
      await expect(p2).rejects.toThrow(/ENOMEM: cold worker creation failed/);
      await expect(p3).rejects.toThrow(/ENOMEM: cold worker creation failed/);
    });

    it('wakes queued acquireWorker callers when init finishes pre-warming up to maxWorkers', async () => {
      const pool = new LibreOfficePoolManager({
        minWorkers: 1,
        maxWorkers: 1,
        acquireTimeoutMs: 2_000,
        enabled: true,
      });
      activePools.push(pool);

      const originalCreateWorker = pool.createWorker.bind(pool);
      vi.spyOn(pool, 'createWorker').mockImplementationOnce(async () => {
        await new Promise((r) => setTimeout(r, 25));
        return originalCreateWorker();
      });

      const initPromise = pool.init();
      const acquirePromise = pool.acquireWorker();
      await initPromise;
      const acquired = await acquirePromise;
      expect(acquired.state).toBe('BUSY');
      await pool.releaseWorker(acquired);
    });
  });

  describe('4. Conversion Execution & Profile Sandbox Security', () => {
    it('executes sandboxed conversion via executor and properly cleans up job directories', async () => {
      // Mock executor that writes a real dummy output file in the jobSubdir
      const mockExecutor = vi.fn(async (bin: string, args: string[], opts?: any) => {
        const cwd = opts?.cwd;
        if (cwd && fs.existsSync(cwd)) {
          // Output file matches input.pdf
          fs.writeFileSync(path.join(cwd, 'input.pdf'), Buffer.from('%PDF-1.7 mock output'));
        }
        return {
          stdout: Buffer.from(''),
          stderr: Buffer.from(''),
          exitCode: 0,
          durationMs: 15,
          sandboxed: true,
          sandboxType: 'host' as const,
        };
      });

      const pool = new LibreOfficePoolManager({
        maxWorkers: 2,
        sofficePath: '/usr/bin/soffice',
        enabled: true,
        executor: mockExecutor,
      });
      activePools.push(pool);

      const inputBuffer = Buffer.from('Hello LibreOffice Pool');
      const result = await pool.convert(inputBuffer, 'docx', 'pdf', { timeoutMs: 5000 }, 'sample.docx');

      expect(result).not.toBeNull();
      expect(result!.buffer.toString('utf-8')).toContain('%PDF-1.7 mock output');
      expect(result!.filename).toBe('sample.pdf');
      expect(result!.mimeType).toBe('application/pdf');
      expect(result!.engineUsed).toBe('native-soffice-pool');
      expect(result!.executionTimeMs).toBeGreaterThanOrEqual(0);

      // Verify executor was invoked for pre-warming and conversion
      expect(mockExecutor).toHaveBeenCalledTimes(2);

      // Call 1: Pre-warming user profile
      const prewarmArgs = mockExecutor.mock.calls[0][1];
      expect(prewarmArgs).toContain('--help');
      expect(prewarmArgs.some((arg: string) => arg.startsWith('-env:UserInstallation=file://'))).toBe(true);

      // Call 2: Conversion execution
      const convertArgs = mockExecutor.mock.calls[1][1];
      expect(convertArgs).toContain('--headless');
      expect(convertArgs).toContain('--norestore');
      expect(convertArgs).toContain('--nofirststartwizard');
      expect(convertArgs).toContain('--convert-to');
      expect(convertArgs[convertArgs.indexOf('--convert-to') + 1]).toMatch(/^pdf:\w+_pdf_Export:\{/);
      expect(convertArgs.some((arg: string) => arg.startsWith('-env:UserInstallation=file://'))).toBe(true);

      // Verify worker was returned to READY
      expect(pool.getStats().readyWorkers).toBe(1);
      expect(pool.getStats().busyWorkers).toBe(0);
      expect(pool.getStats().totalJobsProcessed).toBe(1);
    });

    it('rejects command injection or invalid format characters in convert', async () => {
      const pool = new LibreOfficePoolManager({
        maxWorkers: 1,
        sofficePath: '/usr/bin/soffice',
        enabled: true,
      });
      activePools.push(pool);

      const dummy = Buffer.from('test');
      await expect(pool.convert(dummy, 'docx; rm -rf /', 'pdf')).rejects.toThrow(/Invalid format identifier/);
      await expect(pool.convert(dummy, 'docx', 'pdf && malicious')).rejects.toThrow(/Invalid format identifier/);

      const wBefore = await pool.acquireWorker();
      await pool.releaseWorker(wBefore);
      const totalBefore = pool.getStats().totalJobsProcessed;
      await expect(
        pool.convert(dummy, 'docx', 'pdf', { libreOfficeFilter: 'custom_filter' })
      ).rejects.toThrow(UnsupportedOptionError);
      expect(pool.getStats().totalJobsProcessed).toBe(totalBefore);
    });
  });

  describe('5. Graceful Pool Shutdown & Resource Teardown', () => {
    it('shuts down pool, rejects queued jobs, and purges all worker directories', async () => {
      const pool = new LibreOfficePoolManager({
        maxWorkers: 1,
        acquireTimeoutMs: 5000,
        enabled: true,
      });

      const worker = await pool.acquireWorker();
      const profileDir = worker.userProfileDir;
      const workDir = worker.workDir;

      expect(fs.existsSync(profileDir)).toBe(true);
      expect(fs.existsSync(workDir)).toBe(true);

      // Queue a job
      const queuedPromise = pool.acquireWorker();

      // Shutdown
      await pool.shutdown();

      // Queued job rejected
      await expect(queuedPromise).rejects.toThrow('LibreOfficePoolManager has been shut down.');

      // Sandbox directories destroyed
      expect(fs.existsSync(profileDir)).toBe(false);
      expect(fs.existsSync(workDir)).toBe(false);

      expect(pool.isEnabled()).toBe(false);
      expect(pool.getStats().totalWorkers).toBe(0);
    });
  });

  describe('6. Engine Integration & Fallback Parity', () => {
    it('exposes global LibreOffice pool instance from engines module', () => {
      const pool = getLibreOfficePool();
      expect(pool).toBe(libreOfficePool);
      expect(typeof pool.getStats).toBe('function');
      expect(typeof pool.convert).toBe('function');
    });

    it('falls back cleanly when soffice binary is absent in host environment', async () => {
      const dummyDoc = Buffer.from('Dummy document');
      const res = await convertWithHeadlessOffice(dummyDoc, 'docx', 'pdf', {}, 'test.docx');

      // On host without soffice installed, fail-closed returns null
      // (or native conversion result if soffice is available in CI/container)
      if (res === null) {
        expect(res).toBeNull();
      } else {
        expect(['native-soffice', 'native-soffice-pool']).toContain(res.engineUsed);
      }
    }, REAL_SOFFICE_TIMEOUT_MS);

    it('resolves compliant LibreOffice PDF export filter specifications according to document domain and options', () => {
      // Hand-written goldens: JSON FilterData as LibreOffice's --convert-to syntax defines it.
      const keepJpegData =
        '"ReduceImageResolution":{"type":"boolean","value":"false"},"Quality":{"type":"long","value":"100"},' +
        '"ExportBookmarks":{"type":"boolean","value":"true"},"ExportNotes":{"type":"boolean","value":"false"}';

      // 1. The default export keeps JPEG streams (no downsampling, quality 100), writes the outline and leaves comments out as note annotations
      expect(resolveLibreOfficeFilter('pdf', 'docx')).toBe(`pdf:writer_pdf_Export:{${keepJpegData}}`);
      expect(resolveLibreOfficeFilter('pdf', 'xlsx')).toBe(`pdf:calc_pdf_Export:{${keepJpegData}}`);
      expect(resolveLibreOfficeFilter('pdf', 'pptx')).toBe(`pdf:impress_pdf_Export:{${keepJpegData}}`);

      // 2. PDF/A-1b profile for document
      expect(resolveLibreOfficeFilter('pdf', 'docx', { pdfStandard: 'pdfa-1b' })).toBe(
        `pdf:writer_pdf_Export:{${keepJpegData},"SelectPdfVersion":{"type":"long","value":"1"}}`
      );

      // 3. PDF/A-2b profile for spreadsheet, requested through the pdfa option
      expect(resolveLibreOfficeFilter('pdf', 'xlsx', { pdfa: { conformance: 'pdfa-2b' } })).toBe(
        `pdf:calc_pdf_Export:{${keepJpegData},"SelectPdfVersion":{"type":"long","value":"2"}}`
      );

      // 4. PDF/A-3b profile for presentation
      expect(resolveLibreOfficeFilter('pdf', 'pptx', { pdfStandard: 'pdfa-3b' })).toBe(
        `pdf:impress_pdf_Export:{${keepJpegData},"SelectPdfVersion":{"type":"long","value":"3"}}`
      );

      // 5. A watermarked PDF/A request exports plain: the PDF/A conversion runs after the watermark
      expect(
        resolveLibreOfficeFilter('pdf', 'docx', { pdfa: { conformance: 'pdfa-2b' }, watermark: { text: 'DRAFT' } })
      ).toBe(`pdf:writer_pdf_Export:{${keepJpegData}}`);

      // 6. Lossless image compression
      expect(resolveLibreOfficeFilter('pdf', 'docx', { losslessImageCompression: true })).toBe(
        `pdf:writer_pdf_Export:{${keepJpegData},"UseLosslessCompression":{"type":"boolean","value":"true"}}`
      );

      // 6b. Compression profile: downsample and re-encode only when asked
      expect(resolveLibreOfficeFilter('pdf', 'docx', { imageDpi: 150, jpegQuality: 60 })).toBe(
        'pdf:writer_pdf_Export:{"ReduceImageResolution":{"type":"boolean","value":"true"},' +
          '"Quality":{"type":"long","value":"60"},"ExportBookmarks":{"type":"boolean","value":"true"},"ExportNotes":{"type":"boolean","value":"false"},' +
          '"MaxImageResolution":{"type":"long","value":"150"}}'
      );

      expect(resolveLibreOfficeFilter('pdf', 'odt', { libreOfficeFilter: 'writer_pdf_Export' })).toBe(
        'pdf:writer_pdf_Export'
      );
      expect(resolveLibreOfficeFilter('xls', 'xlsx', { libreOfficeFilter: 'MS Excel 97' })).toBe(
        'xls:MS Excel 97'
      );
      expect(() => resolveLibreOfficeFilter('pdf', 'odt', { libreOfficeFilter: 'custom_filter' })).toThrow(
        UnsupportedOptionError
      );
      expect(() => resolveLibreOfficeFilter('pdf', 'odt', { libreOfficeFilter: 'MS Excel 97' })).toThrow(
        UnsupportedOptionError
      );
      expect(() => resolveLibreOfficeFilter('png', 'docx', { libreOfficeFilter: 'writer_pdf_Export' })).toThrow(
        UnsupportedOptionError
      );

      // 8. Non-PDF target formats pass through untouched
      expect(resolveLibreOfficeFilter('html', 'docx')).toBe('html');
    });
  });
});
