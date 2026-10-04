import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

import {
  getPrlimitCapability,
  buildPrlimitArgs,
  resolveSandboxedCommand,
  executeSandboxedBinary,
  killProcessGroup,
  SandboxedTimeoutError,
} from '../src/lib/security/process-sandbox';
import {
  checkRecycleNeeded,
  writeHeartbeatSync,
  stopHeartbeat,
  activeJobs,
  setProcessedJobsCount,
  resetWorkerLifecycleState,
  drainWorker,
  isDraining,
  ociWorker,
} from '../src/worker/index';
import { Job, Queue } from '../src/lib/queue/bullmq-engine';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

describe('Phase 5: Zero-Trust Container Sandboxing & Worker Lifecycle Drain', () => {
  const tmpDir = os.tmpdir();
  const testHeartbeatPath = path.join(tmpDir, `test-worker-heartbeat-${Date.now()}.json`);

  beforeEach(() => {
    resetWorkerLifecycleState();
    try {
      if (fs.existsSync(testHeartbeatPath)) {
        fs.unlinkSync(testHeartbeatPath);
      }
    } catch {}
  });

  afterEach(() => {
    resetWorkerLifecycleState();
    try {
      if (fs.existsSync(testHeartbeatPath)) {
        fs.unlinkSync(testHeartbeatPath);
      }
    } catch {}
  });

  // ============================================================================
  // Gate 1: Docker Compose & Dockerfile Configuration Integrity
  // ============================================================================
  describe('Container Specification & Runtime Least Privilege', () => {
    it('enforces read-only rootfs, tmpfs mounts, ulimits, and profile separation in docker-compose.yml', () => {
      const composePath = path.join(process.cwd(), 'docker-compose.yml');
      expect(fs.existsSync(composePath)).toBe(true);

      const composeContent = fs.readFileSync(composePath, 'utf-8');
      const compose = yaml.load(composeContent) as any;

      expect(compose.services).toBeDefined();
      const worker = compose.services.worker;
      expect(worker).toBeDefined();

      // Read-only root filesystem
      expect(worker.read_only).toBe(true);

      // cap_add MUST NOT contain SYS_ADMIN (vulnerability elimination)
      expect(worker.cap_add).toBeUndefined();
      expect(worker.cap_drop).toContain('ALL');

      // Secure tmpfs mounts with noexec and nosuid
      expect(worker.tmpfs).toBeDefined();
      expect(worker.tmpfs).toContain('/tmp:size=8g,noexec,nosuid');
      expect(worker.tmpfs).toContain('/home/easyconvert:size=512m,nosuid,nodev');

      // PID limits and Ulimits
      expect(worker.pids_limit).toBe(256);
      expect(worker.ulimits).toBeDefined();
      expect(worker.ulimits.nproc).toBe(256);
      expect(worker.ulimits.nofile.soft).toBe(65536);
      expect(worker.ulimits.nofile.hard).toBe(65536);
      expect(worker.ulimits.fsize).toBe(10737418240);

      // Grace period
      expect(worker.stop_grace_period).toBe('120s');

      // CPU default worker does NOT mount GPU devices
      expect(worker.devices).toBeUndefined();

      // GPU profile worker verification
      const workerGpu = compose.services['worker-gpu'];
      expect(workerGpu).toBeDefined();
      expect(workerGpu.profiles).toContain('gpu');
      expect(workerGpu.devices).toContain('/dev/dri:/dev/dri');
      expect(workerGpu.read_only).toBe(true);
      expect(workerGpu.cap_drop).toContain('ALL');
      expect(workerGpu.cap_add).toBeUndefined();
      expect(workerGpu.stop_grace_period).toBe('120s');
    });

    it('enforces multi-stage build, non-root user 10001, tini init, and compiled runtime in Dockerfile.worker', () => {
      const dockerfilePath = path.join(process.cwd(), 'Dockerfile.worker');
      expect(fs.existsSync(dockerfilePath)).toBe(true);

      const dockerfile = fs.readFileSync(dockerfilePath, 'utf-8');

      // Multi-stage builder & runner
      expect(dockerfile).toContain('AS builder');
      expect(dockerfile).toContain('AS runner');

      // Compiles worker bundle and prunes devDependencies
      expect(dockerfile).toContain('npm run build:worker');
      expect(dockerfile).toContain('npm prune --omit=dev');
      expect(dockerfile).toContain('COPY --from=builder --chown=easyconvert:easyconvert /app/dist ./dist');

      // util-linux installed for prlimit support
      expect(dockerfile).toContain('util-linux');

      // Non-root UID 10001 (easyconvert:easyconvert)
      expect(dockerfile).toContain('groupadd -g 10001 -r easyconvert');
      expect(dockerfile).toContain('useradd -u 10001 -r -g easyconvert');
      expect(dockerfile).toContain('USER easyconvert:easyconvert');

      // Tini init with process group forwarding
      expect(dockerfile).toContain('ENTRYPOINT ["/usr/bin/tini", "--"]');

      // Direct node execution (no npm or tsx runtime in runner)
      expect(dockerfile).toContain('CMD ["node", "dist/worker.js"]');
      expect(dockerfile).not.toContain('CMD ["npm", "run", "worker"]');
      expect(dockerfile).not.toContain('CMD ["tsx"');

      // Healthcheck script configured
      expect(dockerfile).toContain('HEALTHCHECK');
      expect(dockerfile).toContain('scripts/worker-healthcheck.js');
    });
  });

  // ============================================================================
  // Gate 2: Per-Child Process Confinement & Rlimits
  // ============================================================================
  describe('Per-Child Process Confinement & Rlimits', () => {
    it('correctly constructs prlimit CLI arguments', () => {
      const cap = { available: true, path: '/usr/bin/prlimit' };
      const args = buildPrlimitArgs(cap, {
        asBytes: 512 * 1024 * 1024,
        fsizeBytes: 10 * 1024 * 1024 * 1024,
        nproc: 128,
        cpuSeconds: 60,
      });

      expect(args.length).toBe(4);
      expect(args).toEqual([
        '--as=536870912',
        '--fsize=10737418240',
        '--nproc=128',
        '--cpu=60',
      ]);
    });

    it('resolves sandboxed command with memoryLimitMb mapped to address space rlimit', () => {
      const resolved = resolveSandboxedCommand('/usr/bin/ffmpeg', ['-version'], {
        memoryLimitMb: 512,
        maxFileSize: 1024 * 1024,
      });

      expect(resolved.binary.length).toBeGreaterThan(5);
      if (getPrlimitCapability().available && process.platform === 'linux') {
        expect(resolved.wrapped).toBe(true);
        expect(resolved.args[0]).toBe('--as=536870912');
        expect(resolved.args[1]).toBe('--fsize=1048576');
      } else {
        expect(resolved.args).toEqual(['-version']);
      }
    });

    it('terminates full process group on execution timeout', async () => {
      // Run an intentional sleep process with small 150ms timeout
      const start = Date.now();
      await expect(
        executeSandboxedBinary(
          process.execPath,
          ['-e', 'setInterval(() => {}, 1000)'],
          { timeoutMs: 150 }
        )
      ).rejects.toThrow('timed out after 150ms');
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(140);
      expect(elapsed).toBeLessThan(1000);
    });

    it('terminates full process group immediately upon AbortSignal trigger', async () => {
      const controller = new AbortController();
      const start = Date.now();

      const execPromise = executeSandboxedBinary(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        { signal: controller.signal, timeoutMs: 5000 }
      );

      setTimeout(() => {
        controller.abort(new Error('Manual cancellation test'));
      }, 100);

      await expect(execPromise).rejects.toThrow('Manual cancellation test');
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1500);
    });

    it('killProcessGroup gracefully handles null, undefined, or dead process IDs without throwing', () => {
      let threw = false;
      try {
        killProcessGroup(undefined);
        killProcessGroup(-1);
        killProcessGroup(0);
        killProcessGroup(9999999);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
    });
  });

  // ============================================================================
  // Gate 3: Worker Lifecycle, Heartbeat & Graceful Drain
  // ============================================================================
  describe('Worker Lifecycle, Heartbeat & Self-Recycling', () => {
    it('detects worker self-recycling trigger on processed job count threshold', () => {
      const config = {
        concurrency: 2,
        maxJobsBeforeRecycle: 5,
        maxRssMbBeforeRecycle: 4096,
        drainTimeoutMs: 1000,
        heartbeatIntervalMs: 1000,
        heartbeatFilePath: testHeartbeatPath,
      };

      setProcessedJobsCount(4);
      expect(checkRecycleNeeded(config)).toEqual({ needed: false });

      setProcessedJobsCount(5);
      expect(checkRecycleNeeded(config)).toEqual({ needed: true, reason: 'job_count' });
    });

    it('detects worker self-recycling trigger on RSS memory threshold', () => {
      const currentRssMb = process.memoryUsage().rss / (1024 * 1024);
      const config = {
        concurrency: 2,
        maxJobsBeforeRecycle: 1000,
        maxRssMbBeforeRecycle: Math.floor(currentRssMb - 1), // Below current RSS to trigger
        drainTimeoutMs: 1000,
        heartbeatIntervalMs: 1000,
        heartbeatFilePath: testHeartbeatPath,
      };

      setProcessedJobsCount(1);
      const result = checkRecycleNeeded(config);
      expect(result.needed).toBe(true);
      expect(result.reason).toBe('rss_memory');
    });

    it('writes and updates worker heartbeat file with process metadata', () => {
      writeHeartbeatSync('healthy', testHeartbeatPath);
      expect(fs.existsSync(testHeartbeatPath)).toBe(true);

      const content = JSON.parse(fs.readFileSync(testHeartbeatPath, 'utf-8'));
      expect(content.pid).toBe(process.pid);
      expect(content.status).toBe('healthy');
      expect(content.timestamp).toBeGreaterThan(0);
      expect(content.rssMb).toBeGreaterThan(0);
      expect(content.activeJobs).toBe(0);

      stopHeartbeat(testHeartbeatPath);
      const updated = JSON.parse(fs.readFileSync(testHeartbeatPath, 'utf-8'));
      expect(updated.status).toBe('stopped');
    });

    it('executes graceful drain on shutdown signal and waits for active jobs or aborts on timeout', async () => {
      expect(isDraining).toBe(false);

      const fakeQueue = new Queue('test-drain-queue');
      const fakeJob = new Job(
        'test_job_1',
        'test_conversion',
        {
          jobId: 'test_job_1',
          sourceFormat: 'txt',
          targetFormat: 'pdf',
          inputKey: 'uploads/test.txt',
          outputKey: 'outputs/test.pdf',
        },
        {},
        fakeQueue
      );

      // Track active job
      activeJobs.add(fakeJob);
      expect(activeJobs.size).toBe(1);

      // Drain with very short timeout (100ms)
      const drainPromise = drainWorker('SIGTERM', 100);

      // Job should be aborted when grace timeout expires
      await drainPromise;

      expect(isDraining).toBe(true);
      expect(fakeJob.signal.aborted).toBe(true);
    });
  });

  // ============================================================================
  // Gate 4: Worker Healthcheck Script Execution
  // ============================================================================
  describe('Standalone Healthcheck Script Verification', () => {
    const healthcheckScript = path.join(process.cwd(), 'scripts', 'worker-healthcheck.js');

    it('healthcheck exits with 0 when heartbeat file is active and fresh', () => {
      writeHeartbeatSync('healthy', testHeartbeatPath);

      const res = spawnSync(process.execPath, [healthcheckScript], {
        env: {
          ...process.env,
          WORKER_HEARTBEAT_FILE: testHeartbeatPath,
          REDIS_HOST: '', // Skip remote Redis connection in local test
        },
        encoding: 'utf-8',
      });

      expect(res.status).toBe(0);
      expect(res.stdout).toContain('[Healthcheck] Healthy');
    });

    it('healthcheck exits with 1 when heartbeat file does not exist', () => {
      const missingPath = path.join(tmpDir, `missing-heartbeat-${Date.now()}.json`);

      const res = spawnSync(process.execPath, [healthcheckScript], {
        env: {
          ...process.env,
          WORKER_HEARTBEAT_FILE: missingPath,
          REDIS_HOST: '',
        },
        encoding: 'utf-8',
      });

      expect(res.status).toBe(1);
      expect(res.stderr).toContain('Heartbeat file not found');
    });

    it('healthcheck exits with 1 when heartbeat file is stale', () => {
      const stalePayload = {
        pid: process.pid,
        timestamp: Date.now() - 60000, // 60s ago (> 35s max stale)
        status: 'healthy',
        activeJobs: 0,
        processedJobs: 10,
        rssMb: 120,
      };
      fs.writeFileSync(testHeartbeatPath, JSON.stringify(stalePayload));

      const res = spawnSync(process.execPath, [healthcheckScript], {
        env: {
          ...process.env,
          WORKER_HEARTBEAT_FILE: testHeartbeatPath,
          REDIS_HOST: '',
        },
        encoding: 'utf-8',
      });

      expect(res.status).toBe(1);
      expect(res.stderr).toContain('Heartbeat is stale');
    });
  });
});
