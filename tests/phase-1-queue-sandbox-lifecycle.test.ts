import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  Queue,
  Worker,
  Job,
  DistributedBullMQAdapter,
  createQueueEngine,
} from '../src/lib/queue/bullmq-engine';
import {
  conversionQueue,
  startConversionWorker,
  stopConversionWorker,
  attachJobLifecycleListeners,
  conversionWorker,
} from '../src/lib/queue/conversion-queue';
import {
  resolveSandboxedCommand,
  getSanitizedEnvironment,
  buildUnshareIsolationArgs,
  SandboxedProcessError,
} from '../src/lib/security/process-sandbox';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { webhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';

/**
 * High-fidelity in-memory Redis mock supporting Hashes, Lists, Sets, and Sorted Sets
 * for deterministic multi-process queue lifecycle verification.
 */
class InMemoryRedisMock {
  public hashes = new Map<string, Map<string, string>>();
  public lists = new Map<string, string[]>();
  public sets = new Map<string, Set<string>>();
  public sortedSets = new Map<string, Map<string, number>>();
  public publishedMessages: { channel: string; message: string }[] = [];

  async hset(key: string, ...args: any[]): Promise<number> {
    if (!this.hashes.has(key)) {
      this.hashes.set(key, new Map());
    }
    const map = this.hashes.get(key)!;
    if (args.length === 1 && typeof args[0] === 'object') {
      for (const [k, v] of Object.entries(args[0])) {
        map.set(k, String(v));
      }
      return Object.keys(args[0]).length;
    }
    for (let i = 0; i < args.length; i += 2) {
      map.set(String(args[i]), String(args[i + 1]));
    }
    return Math.floor(args.length / 2);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const map = this.hashes.get(key);
    if (!map) return {};
    const obj: Record<string, string> = {};
    for (const [k, v] of map.entries()) {
      obj[k] = v;
    }
    return obj;
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    if (!this.lists.has(key)) {
      this.lists.set(key, []);
    }
    const list = this.lists.get(key)!;
    list.push(...values);
    return list.length;
  }

  async lpop(key: string): Promise<string | null> {
    const list = this.lists.get(key);
    if (!list || list.length === 0) return null;
    return list.shift() ?? null;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) || [];
    const end = stop === -1 ? list.length : stop + 1;
    return list.slice(start, end);
  }

  async llen(key: string): Promise<number> {
    return (this.lists.get(key) || []).length;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    if (!this.sets.has(key)) {
      this.sets.set(key, new Set());
    }
    const set = this.sets.get(key)!;
    let added = 0;
    for (const m of members) {
      if (!set.has(m)) {
        set.add(m);
        added++;
      }
    }
    return added;
  }

  async smembers(key: string): Promise<string[]> {
    const set = this.sets.get(key);
    return set ? Array.from(set) : [];
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const m of members) {
      if (set.delete(m)) removed++;
    }
    return removed;
  }

  async scard(key: string): Promise<number> {
    return (this.sets.get(key) || new Set()).size;
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    if (!this.sortedSets.has(key)) {
      this.sortedSets.set(key, new Map());
    }
    const zset = this.sortedSets.get(key)!;
    const isNew = !zset.has(member);
    zset.set(member, score);
    return isNew ? 1 : 0;
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    const zset = this.sortedSets.get(key);
    if (!zset) return [];
    const sorted = Array.from(zset.entries()).sort((a, b) => a[1] - b[1]);
    const end = stop === -1 ? sorted.length : stop + 1;
    return sorted.slice(start, end).map((e) => e[0]);
  }

  async zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]> {
    const zset = this.sortedSets.get(key);
    if (!zset) return [];
    const minVal = min === '-inf' ? -Infinity : Number(min);
    const maxVal = max === '+inf' ? Infinity : Number(max);
    return Array.from(zset.entries())
      .filter(([_, score]) => score >= minVal && score <= maxVal)
      .sort((a, b) => a[1] - b[1])
      .map(([member]) => member);
  }

  async zrem(key: string, member: string): Promise<number> {
    const zset = this.sortedSets.get(key);
    if (!zset) return 0;
    return zset.delete(member) ? 1 : 0;
  }

  async zcard(key: string): Promise<number> {
    return (this.sortedSets.get(key) || new Map()).size;
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const k of keys) {
      if (this.hashes.delete(k)) count++;
      if (this.lists.delete(k)) count++;
      if (this.sets.delete(k)) count++;
      if (this.sortedSets.delete(k)) count++;
    }
    return count;
  }

  async ping(): Promise<string> {
    return 'PONG';
  }

  async publish(channel: string, message: string): Promise<number> {
    this.publishedMessages.push({ channel, message });
    return 1;
  }

  duplicate(): this {
    return this;
  }

  async subscribe(): Promise<void> {}
  on(): this {
    return this;
  }
  async quit(): Promise<'OK'> {
    return 'OK';
  }
}

describe('Phase 1: Distributed BullMQ Queue Decoupling & Container Airgap Remediation', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await stopConversionWorker();
  });

  // ==========================================================================
  // 1. Authentic Distributed BullMQ Queue Engine
  // ==========================================================================
  describe('1. DistributedBullMQAdapter Redis Storage Engine', () => {
    it('persists job state, progress, and logs to authentic Redis hashes', async () => {
      const mockRedis = new InMemoryRedisMock();
      const adapter = new DistributedBullMQAdapter('transcode-cluster', {
        redisClient: mockRedis as any,
        keyPrefix: 'testqueue:',
      });

      expect(adapter.isDistributed).toBe(true);
      expect(adapter.isConnected).toBe(true);

      const job = await adapter.add('document_conversion', {
        sourceFormat: 'docx',
        targetFormat: 'pdf',
        filename: 'report.docx',
      });

      expect(job.id).toBeDefined();
      expect(job.state).toBe('waiting');

      // Verify Redis Hash
      const hashKey = `testqueue:transcode-cluster:job:${job.id}`;
      const hash = await mockRedis.hgetall(hashKey);
      expect(hash.id).toBe(job.id);
      expect(hash.name).toBe('document_conversion');
      expect(hash.state).toBe('waiting');
      expect(JSON.parse(hash.data)).toEqual({
        sourceFormat: 'docx',
        targetFormat: 'pdf',
        filename: 'report.docx',
      });

      // Verify waiting list
      const waitingList = await mockRedis.lrange('testqueue:transcode-cluster:waiting', 0, -1);
      expect(waitingList).toContain(job.id);

      // Verify pub/sub publish event
      expect(mockRedis.publishedMessages.length).toBeGreaterThan(0);
      expect(mockRedis.publishedMessages[0].channel).toBe('testqueue:transcode-cluster:events');
      expect(JSON.parse(mockRedis.publishedMessages[0].message)).toEqual({
        event: 'waiting',
        jobId: job.id,
      });

      // Update progress and verify synchronization to Redis hash
      await job.updateProgress(45);
      const updatedHash = await mockRedis.hgetall(hashKey);
      expect(updatedHash.progress).toBe('45');

      // Add log entry and verify synchronization
      await job.log('Extracting Word XML drawing structures');
      const hashWithLogs = await mockRedis.hgetall(hashKey);
      const logs = JSON.parse(hashWithLogs.logs);
      expect(logs.length).toBe(1);
      expect(logs[0]).toContain('Extracting Word XML drawing structures');

      await adapter.close();
    });

    it('pops waiting jobs and tracks active, completed, and failed counts accurately', async () => {
      const mockRedis = new InMemoryRedisMock();
      const adapter = new DistributedBullMQAdapter('analytics-queue', {
        redisClient: mockRedis as any,
        keyPrefix: 'testqueue:',
      });

      const job = await adapter.add('compute-metrics', { count: 100 });

      // Check initial counts
      let counts = await adapter.getJobCounts();
      expect(counts.waiting).toBe(1);
      expect(counts.active).toBe(0);

      // Pop next waiting
      const popped = await adapter._popNextWaiting();
      expect(popped).toBeDefined();
      expect(popped?.id).toBe(job.id);
      expect(popped?.state).toBe('active');

      // Active state in Redis
      counts = await adapter.getJobCounts();
      expect(counts.waiting).toBe(0);
      expect(counts.active).toBe(1);

      // Complete job
      if (adapter._onJobCompleted) {
        await adapter._onJobCompleted(popped!, { result: 'done' });
      }

      counts = await adapter.getJobCounts();
      expect(counts.active).toBe(0);
      expect(counts.completed).toBe(1);

      // Retrieve completed job
      const completedJob = await adapter.getJob(job.id);
      expect(completedJob).toBeDefined();
      expect(completedJob?.state).toBe('completed');
      expect(completedJob?.progress).toBe(100);
      expect(completedJob?.returnvalue).toEqual({ result: 'done' });

      await adapter.close();
    });

    it('schedules delayed jobs in sorted sets and promotes them when due', async () => {
      const mockRedis = new InMemoryRedisMock();
      const adapter = new DistributedBullMQAdapter('delayed-queue', {
        redisClient: mockRedis as any,
        keyPrefix: 'testqueue:',
      });

      // Add delayed job
      const delayMs = 50;
      const job = await adapter.add('delayed-task', { retryCount: 1 }, { delay: delayMs });
      expect(job.state).toBe('delayed');

      let counts = await adapter.getJobCounts();
      expect(counts.delayed).toBe(1);
      expect(counts.waiting).toBe(0);

      // Immediately popping should return undefined (not yet due)
      let popped = await adapter._popNextWaiting();
      expect(popped).toBeUndefined();

      // Wait until due
      await new Promise((r) => setTimeout(r, delayMs + 10));

      // Next pop should promote and return the job
      popped = await adapter._popNextWaiting();
      expect(popped).toBeDefined();
      expect(popped?.id).toBe(job.id);
      expect(popped?.state).toBe('active');

      counts = await adapter.getJobCounts();
      expect(counts.delayed).toBe(0);
      expect(counts.active).toBe(1);

      await adapter.close();
    });

    it('supports Dead-Letter Queue (DLQ) operations on Redis backend', async () => {
      const mockRedis = new InMemoryRedisMock();
      const adapter = new DistributedBullMQAdapter('dlq-test-queue', {
        redisClient: mockRedis as any,
        keyPrefix: 'testqueue:',
      });

      const job = await adapter.add('corrupt-payload', { bad: true });
      await adapter.moveToDlq(job, 'Unrecoverable syntax corruption in stream');

      const dlqEntries = await adapter.getDlqEntries();
      expect(dlqEntries.length).toBe(1);
      expect(dlqEntries[0].jobId).toBe(job.id);
      expect(dlqEntries[0].failedReason).toBe('Unrecoverable syntax corruption in stream');

      const purged = await adapter.purgeDlq();
      expect(purged).toBe(1);

      const emptyEntries = await adapter.getDlqEntries();
      expect(emptyEntries.length).toBe(0);

      await adapter.close();
    });

    it('falls back seamlessly to in-memory queue when Redis is offline or not configured', async () => {
      // Create adapter without Redis options or env
      const fallbackAdapter = new DistributedBullMQAdapter('offline-queue');
      expect(fallbackAdapter.isConnected).toBe(false);

      const job = await fallbackAdapter.add('local-task', { local: true });
      expect(job.id).toBeDefined();
      expect(job.state).toBe('waiting');

      const counts = await fallbackAdapter.getJobCounts();
      expect(counts.waiting).toBe(1);

      const ping = await fallbackAdapter.ping();
      expect(ping.ok).toBe(true);

      await fallbackAdapter.close();
    });
  });

  // ==========================================================================
  // 2. Producer / Consumer Lifecycle Decoupling
  // ==========================================================================
  describe('2. Producer / Consumer Decoupling Contract', () => {
    it('conversionQueue behaves as a pure producer without starting background workers', async () => {
      // Adding a job to conversionQueue does NOT automatically process it unless worker is started
      const job = await conversionQueue.add('producer-test', {
        jobId: 'test_producer_job',
        originalFilename: 'sample.txt',
        sourceFormat: 'txt',
        targetFormat: 'pdf',
        fileSize: 11,
        options: {},
        inputBufferBase64: Buffer.from('hello world').toString('base64'),
      });

      expect(job.id).toBeDefined();
      // Without worker started, job must remain waiting
      const retrieved = await conversionQueue.getJob(job.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.state).toBe('waiting');
    });

    it('startConversionWorker explicitly boots consumer worker and stopConversionWorker terminates cleanly', async () => {
      const worker = startConversionWorker({ concurrency: 2 });
      expect(worker).toBeDefined();
      expect(worker.name).toBe(conversionQueue.name);

      // Second start call returns singleton instance
      const sameWorker = startConversionWorker();
      expect(sameWorker).toBe(worker);

      await stopConversionWorker();
    });

    it('conversionWorker proxy lazily instantiates consumer worker on access', async () => {
      expect(typeof conversionWorker.on).toBe('function');
      expect(typeof conversionWorker.close).toBe('function');
      await stopConversionWorker();
    });
  });

  // ==========================================================================
  // 3. Worker Lifecycle Integration (Quota & Webhooks)
  // ==========================================================================
  describe('3. Unified Worker Lifecycle Quota & Webhook Attacher', () => {
    it('commits quota reservation and dispatches webhook on job completion', async () => {
      const commitSpy = vi.spyOn(redisKeyStore, 'commitQuota').mockResolvedValue(true as any);
      const webhookSpy = vi.spyOn(webhookDispatcher, 'dispatch').mockResolvedValue(true as any);

      const testQueue = new Queue('lifecycle-test-queue');
      const testWorker = new Worker(
        testQueue,
        async (job) => {
          return {
            jobId: job.id,
            status: 'completed',
            filename: 'out.pdf',
            size: 1024,
            mimeType: 'application/pdf',
            downloadUrl: '/api/storage/file/out.pdf',
            resultKey: 'results/out.pdf',
            durationMs: 120,
          };
        },
        { concurrency: 1 }
      );

      // Attach unified lifecycle
      attachJobLifecycleListeners(testWorker as any);

      const job = await testQueue.add('transcode', {
        originalFilename: 'test.docx',
        reservationId: 'res_quota_commit_123',
        webhookUrl: 'https://api.example.com/webhooks/easyconvert',
        webhookSecret: 'test-secret-key',
      } as any);

      // Wait for completion
      await new Promise<void>((resolve) => {
        testWorker.on('completed', () => resolve());
      });

      expect(commitSpy).toHaveBeenCalledWith('res_quota_commit_123');
      expect(webhookSpy).toHaveBeenCalledWith(
        'https://api.example.com/webhooks/easyconvert',
        'job.completed',
        expect.objectContaining({ status: 'completed', filename: 'out.pdf' }),
        'test-secret-key'
      );

      await testWorker.close();
      await testQueue.close();
    });

    it('rolls back quota reservation and dispatches failure webhook on unrecoverable job failure', async () => {
      const rollbackSpy = vi.spyOn(redisKeyStore, 'rollbackQuota').mockResolvedValue(true as any);
      const webhookSpy = vi.spyOn(webhookDispatcher, 'dispatch').mockResolvedValue(true as any);

      const testQueue = new Queue('lifecycle-fail-queue');
      const testWorker = new Worker(
        testQueue,
        async () => {
          throw new Error('Fatal native transcoding engine failure');
        },
        { concurrency: 1 }
      );

      attachJobLifecycleListeners(testWorker as any);

      const job = await testQueue.add(
        'transcode-fail',
        {
          originalFilename: 'broken.cad',
          reservationId: 'res_quota_rollback_456',
          webhookUrl: 'https://api.example.com/webhooks/failures',
          webhookSecret: 'fail-secret-key',
        } as any,
        { attempts: 1 }
      );

      await new Promise<void>((resolve) => {
        testWorker.on('failed', () => resolve());
      });

      expect(rollbackSpy).toHaveBeenCalledWith('res_quota_rollback_456');
      expect(webhookSpy).toHaveBeenCalledWith(
        'https://api.example.com/webhooks/failures',
        'job.failed',
        expect.objectContaining({
          jobId: job.id,
          error: 'Fatal native transcoding engine failure',
          originalFilename: 'broken.cad',
        }),
        'fail-secret-key'
      );

      await testWorker.close();
      await testQueue.close();
    });
  });

  // ==========================================================================
  // 4. Process Sandbox Hardening & Fail-Closed Strict Isolation
  // ==========================================================================
  describe('4. Process Sandbox Hardening & Airgap', () => {
    it('fails closed when strictIsolation is enabled and platform cannot provide namespace isolation', () => {
      if (process.platform !== 'linux') {
        expect(() => {
          resolveSandboxedCommand('/bin/echo', ['test'], {
            networkIsolated: true,
            strictIsolation: true,
          });
        }).toThrow(SandboxedProcessError);

        expect(() => {
          resolveSandboxedCommand('/bin/echo', ['test'], {
            networkIsolated: true,
            strictIsolation: true,
          });
        }).toThrow(/Strict network isolation failed/);
      }
    });

    it('strictly poisons proxy environment variables for network egress mitigation', () => {
      const sanitized = getSanitizedEnvironment({}, true);
      expect(sanitized.HTTP_PROXY).toBe('http://127.0.0.1:0');
      expect(sanitized.HTTPS_PROXY).toBe('http://127.0.0.1:0');
      expect(sanitized.ALL_PROXY).toBe('socks5://127.0.0.1:0');
      expect(sanitized.http_proxy).toBe('http://127.0.0.1:0');
      expect(sanitized.https_proxy).toBe('http://127.0.0.1:0');
      expect(sanitized.all_proxy).toBe('socks5://127.0.0.1:0');
      expect(sanitized.NO_PROXY).toBe('');
      expect(sanitized.no_proxy).toBe('');
    });

    it('assembles unshare isolation arguments with network namespace flags', () => {
      const mockCap = {
        available: true,
        path: '/usr/bin/unshare',
        args: ['-r'],
      };
      const args = buildUnshareIsolationArgs(mockCap, {
        netNamespace: true,
        pidNamespace: true,
      });
      expect(args).toContain('-r');
      expect(args).toContain('-n');
      expect(args).toContain('-p');
      expect(args).toContain('--fork');
    });
  });
});
