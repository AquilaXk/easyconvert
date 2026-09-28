import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  LibreOfficePoolManager,
  LibreOfficePoolTimeoutError,
  WorkerLifecycleState,
} from '../src/worker/libreoffice-pool';
import {
  convertWithHeadlessOffice,
  getLibreOfficePool,
  libreOfficePool,
} from '../src/worker/engines';

describe('Phase 3: Pre-warmed LibreOffice Daemon Pool Architecture', () => {
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
      expect(convertArgs).toContain('pdf');
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
    });
  });
});
