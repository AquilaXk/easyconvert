import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { Queue, Worker } from '../src/lib/queue/bullmq-engine';
import {
  resourceQueues,
  conversionQueue,
  allConversionQueues,
  defaultQueueOwnJobCounts,
  getQueueForResourceClass,
  getQueueForJob,
  getJobAcrossQueues,
  cancelJobAcrossQueues,
  processConversionJob,
  attachJobLifecycleListeners,
  attachInputCleanupOnCompletion,
} from '../src/lib/queue/conversion-queue';
import {
  resolveResourceClass,
  resolveNodeResourceClass,
  resolveQueueName,
  tierToPriority,
  RESOURCE_CLASSES,
} from '../src/lib/queue/resource-class';
import { resolveSubscribedQueues, ociWorker, stopHeartbeat } from '../src/worker';
import { POST as createJobPost } from '../src/app/api/v1/jobs/route';
import { GET as getJobGet } from '../src/app/api/v1/jobs/[id]/route';
import { POST as queueJobsPost } from '../src/app/api/queue/jobs/route';
import { GET as queueJobGet } from '../src/app/api/queue/jobs/[id]/route';
import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import { POST as toolsJobsPost } from '../src/app/api/tools/jobs/route';
import { GET as toolsJobGet } from '../src/app/api/tools/jobs/[id]/route';
import { dispatchSyncWebTool } from '../src/lib/queue/wait-for-job';
import {
  registerLiveWorkerHeartbeat,
  unregisterLiveWorkerHeartbeat,
  resetLocalLiveWorkersForTests,
} from '../src/lib/queue/worker-presence';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { graphScheduler } from '../src/lib/queue/graph/scheduler';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { NextRequest } from 'next/server';
import { s3Storage } from '../src/lib/storage/s3-storage';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

describe('WP-33: Resource-Class Queues and Priority Scheduling', () => {
  const activeWorkers: Worker<any, any>[] = [];

  beforeAll(async () => {
    await ociWorker.close();
    stopHeartbeat();
    resetLocalLiveWorkersForTests();
  });

  afterEach(async () => {
    while (activeWorkers.length > 0) {
      const w = activeWorkers.pop();
      if (w) {
        await w.close().catch(() => {});
      }
    }
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. HOL (Head-of-Line) Blocking Prevention
  // =========================================================================
  describe('1. HOL Blocking Prevention across Dedicated Queues', () => {
    it('ensures 50 light jobs complete and their p95 latency finishes before a slow CPU job finishes', async () => {
      const lightQueue = new Queue<{ id: number; delayMs: number }, { done: boolean }>('test-light-queue');
      const cpuQueue = new Queue<{ id: number; delayMs: number }, { done: boolean }>('test-cpu-queue');

      const lightCompletionTimestamps: number[] = [];
      let cpuCompletionTimestamp = 0;
      const startTime = Date.now();

      // CPU Worker: concurrency = 1 (simulating slow CPU transcode engine)
      const cpuWorker = new Worker<{ id: number; delayMs: number }, { done: boolean }>(
        cpuQueue,
        async (job) => {
          await new Promise((resolve) => setTimeout(resolve, job.data.delayMs));
          return { done: true };
        },
        { concurrency: 1 }
      );
      cpuWorker.on('completed', () => {
        cpuCompletionTimestamp = Date.now();
      });
      activeWorkers.push(cpuWorker);

      // Light Worker: concurrency = 5 (processing light jobs concurrently)
      const lightWorker = new Worker<{ id: number; delayMs: number }, { done: boolean }>(
        lightQueue,
        async (job) => {
          await new Promise((resolve) => setTimeout(resolve, job.data.delayMs));
          return { done: true };
        },
        { concurrency: 5 }
      );
      lightWorker.on('completed', () => {
        lightCompletionTimestamps.push(Date.now());
      });
      activeWorkers.push(lightWorker);

      // Enqueue 1 heavy CPU job (300ms simulated duration)
      await cpuQueue.add('cpu_heavy', { id: 999, delayMs: 300 });

      // Enqueue 50 lightweight jobs (each 2ms simulated duration)
      const lightJobPromises = [];
      for (let i = 0; i < 50; i++) {
        lightJobPromises.push(lightQueue.add('light_fast', { id: i, delayMs: 2 }));
      }
      await Promise.all(lightJobPromises);

      // Wait until all 50 light jobs are completed
      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (lightCompletionTimestamps.length >= 50) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 10);
      });

      // Calculate p95 completion duration of light jobs
      const lightDurations = lightCompletionTimestamps
        .map((t) => t - startTime)
        .sort((a, b) => a - b);
      const p95Index = Math.floor(lightDurations.length * 0.95);
      const p95Duration = lightDurations[p95Index];

      // Wait for CPU job to finish
      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (cpuCompletionTimestamp > 0) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 10);
      });

      const cpuDuration = cpuCompletionTimestamp - startTime;

      // Assert: All 50 light jobs finished
      expect(lightCompletionTimestamps).toHaveLength(50);

      // Assert: Zero HOL Blocking! Light jobs p95 finished strictly BEFORE the CPU job finished
      expect(p95Duration).toBeLessThan(cpuDuration);
      expect(lightDurations[lightDurations.length - 1]).toBeLessThan(cpuDuration);
    });
  });

  // =========================================================================
  // 2. Resource Class Resolution Matrix
  // =========================================================================
  describe('2. Resource Class Resolution Matrix', () => {
    it('exhaustively categorizes CAD, RAW, OCR, Docs, Archives, Video, and Text formats', () => {
      // 1. GPU Acceleration & Video
      expect(resolveResourceClass('mp4', 'webm')).toBe('gpu');
      expect(resolveResourceClass('mov', 'mp4')).toBe('gpu');
      expect(resolveResourceClass('mkv', 'avi')).toBe('gpu');
      expect(resolveResourceClass('png', 'jpg', 100, { useWebGpu: true })).toBe('gpu');
      expect(resolveResourceClass('png', 'jpg', 100, { gpuAcceleration: true })).toBe('gpu');

      // 2. Memory-Bound (CAD, RAW, OCR, or Payloads > 50 MiB)
      expect(resolveResourceClass('step', 'stl')).toBe('memory');
      expect(resolveResourceClass('iges', 'obj')).toBe('memory');
      expect(resolveResourceClass('brep', 'ply')).toBe('memory');
      expect(resolveResourceClass('dng', 'jpg')).toBe('memory');
      expect(resolveResourceClass('cr2', 'png')).toBe('memory');
      expect(resolveResourceClass('nef', 'webp')).toBe('memory');
      expect(resolveResourceClass('png', 'txt', 100, { ocrEnabled: true })).toBe('memory');
      expect(resolveResourceClass('pdf', 'txt', 100, { dpi: 300 })).toBe('memory');
      expect(resolveResourceClass('json', 'csv', 55 * 1024 * 1024)).toBe('memory'); // > 50 MiB

      // 3. CPU-Bound (Office/Heavy Docs, Archives, Audio, or Payloads > 10 MiB)
      expect(resolveResourceClass('docx', 'pdf')).toBe('cpu');
      expect(resolveResourceClass('xlsx', 'csv')).toBe('cpu');
      expect(resolveResourceClass('pptx', 'pdf')).toBe('cpu');
      expect(resolveResourceClass('hwp', 'pdf')).toBe('cpu');
      expect(resolveResourceClass('zip', 'tar')).toBe('cpu');
      expect(resolveResourceClass('7z', 'zip')).toBe('cpu');
      expect(resolveResourceClass('tar.gz', 'zip')).toBe('cpu');
      expect(resolveResourceClass('mp3', 'wav')).toBe('cpu');
      expect(resolveResourceClass('flac', 'aac')).toBe('cpu');
      expect(resolveResourceClass('json', 'csv', 12 * 1024 * 1024)).toBe('cpu'); // > 10 MiB

      // 4. Lightweight (Text, Data, Markdown, Web Images <= 10 MiB)
      expect(resolveResourceClass('json', 'yaml', 1024)).toBe('light');
      expect(resolveResourceClass('csv', 'json', 1024)).toBe('light');
      expect(resolveResourceClass('txt', 'md', 1024)).toBe('light');
      expect(resolveResourceClass('png', 'webp', 500 * 1024)).toBe('light');
      expect(resolveResourceClass('svg', 'png', 100 * 1024)).toBe('light');
    });

    it('resolves graph node operations to corresponding resource classes', () => {
      expect(resolveNodeResourceClass({ op: 'import.upload' })).toBe('light');
      expect(resolveNodeResourceClass({ op: 'import.url' })).toBe('light');
      expect(resolveNodeResourceClass({ op: 'export.url' })).toBe('light');
      expect(resolveNodeResourceClass({ op: 'export.internal' })).toBe('light');
      expect(resolveNodeResourceClass({ op: 'ocr' })).toBe('memory');
      expect(resolveNodeResourceClass({ op: 'archive.create', targetFormat: 'zip' })).toBe('cpu');
      expect(resolveNodeResourceClass({ op: 'archive.extract' })).toBe('cpu');
      expect(resolveNodeResourceClass({ op: 'convert', targetFormat: 'mp4' })).toBe('gpu');
      expect(resolveNodeResourceClass({ op: 'convert', targetFormat: 'stl' })).toBe('memory');
      expect(resolveNodeResourceClass({ op: 'convert', targetFormat: 'pdf' })).toBe('cpu');
      expect(resolveNodeResourceClass({ op: 'convert', targetFormat: 'json' })).toBe('light');
    });

    it('maps canonical queue names and account tiers accurately', () => {
      expect(resolveQueueName('light')).toBe('easyconvert-jobs:light');
      expect(resolveQueueName('cpu')).toBe('easyconvert-jobs:cpu');
      expect(resolveQueueName('memory')).toBe('easyconvert-jobs:memory');
      expect(resolveQueueName('gpu')).toBe('easyconvert-jobs:gpu');

      expect(tierToPriority('paid')).toBe(1);
      expect(tierToPriority('Paid')).toBe(1);
      expect(tierToPriority('free')).toBe(3);
      expect(tierToPriority(undefined)).toBe(3);
      expect(tierToPriority('unknown')).toBe(3);
    });
  });

  // =========================================================================
  // 3. Priority-Based Scheduling
  // =========================================================================
  describe('3. Priority-Based Scheduling in Queue Engine', () => {
    it('pops Enterprise (1) before Pro (2) before Free (3) regardless of insertion order', async () => {
      const priorityQueue = new Queue<{ label: string }, { done: boolean }>('priority-test-queue');

      // Enqueue in reverse order: Free (3) -> Pro (2) -> Enterprise (1)
      await priorityQueue.add('free_job', { label: 'Free' }, { priority: 3 });
      await priorityQueue.add('pro_job', { label: 'Pro' }, { priority: 2 });
      await priorityQueue.add('enterprise_job', { label: 'Enterprise' }, { priority: 1 });

      const executionOrder: string[] = [];

      // Concurrency 1 guarantees strict serial popping in priority order
      const worker = new Worker<{ label: string }, { done: boolean }>(
        priorityQueue,
        async (job) => {
          executionOrder.push(job.data.label);
          return { done: true };
        },
        { concurrency: 1 }
      );
      activeWorkers.push(worker);

      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (executionOrder.length === 3) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 10);
      });

      expect(executionOrder).toEqual(['Enterprise', 'Pro', 'Free']);
    });

    it('maintains strict FIFO order for jobs with identical priority', async () => {
      const queue = new Queue<{ label: string }, { done: boolean }>('fifo-priority-queue');

      await queue.add('job1', { label: 'Pro_First' }, { priority: 2 });
      await queue.add('job2', { label: 'Pro_Second' }, { priority: 2 });
      await queue.add('job3', { label: 'Pro_Third' }, { priority: 2 });

      const executionOrder: string[] = [];
      const worker = new Worker<{ label: string }, { done: boolean }>(
        queue,
        async (job) => {
          executionOrder.push(job.data.label);
          return { done: true };
        },
        { concurrency: 1 }
      );
      activeWorkers.push(worker);

      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (executionOrder.length === 3) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 10);
      });

      expect(executionOrder).toEqual(['Pro_First', 'Pro_Second', 'Pro_Third']);
    });
  });

  // =========================================================================
  // 4. Worker Multi-Queue Subscription & Filtering
  // =========================================================================
  describe('4. Worker Multi-Queue Subscription and Filtering', () => {
    it('subscribes a worker to multiple designated queues and processes jobs from both', async () => {
      const queueA = new Queue<{ origin: string }, string>('queue-a');
      const queueB = new Queue<{ origin: string }, string>('queue-b');

      const processedOrigins: string[] = [];
      const worker = new Worker<{ origin: string }, string>(
        [queueA, queueB],
        async (job) => {
          processedOrigins.push(job.data.origin);
          return 'ok';
        },
        { concurrency: 2 }
      );
      activeWorkers.push(worker);

      await queueA.add('job_a', { origin: 'A' });
      await queueB.add('job_b', { origin: 'B' });

      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (processedOrigins.length === 2) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 10);
      });

      expect(processedOrigins).toHaveLength(2);
      expect(processedOrigins.sort()).toEqual(['A', 'B']);
    });

    it('worker with filtered subscription only processes its designated queues and ignores others', async () => {
      const targetLightQueue = new Queue<{ text: string }, string>('filtered-light');
      const targetCpuQueue = new Queue<{ text: string }, string>('filtered-cpu');

      const processed: string[] = [];
      // Dedicated light worker subscribes ONLY to targetLightQueue
      const lightWorker = new Worker<{ text: string }, string>(
        targetLightQueue,
        async (job) => {
          processed.push(job.data.text);
          return 'ok';
        },
        { concurrency: 1 }
      );
      activeWorkers.push(lightWorker);

      const cpuJob = await targetCpuQueue.add('cpu_task', { text: 'heavy_cpu' });
      const lightJob = await targetLightQueue.add('light_task', { text: 'fast_light' });

      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (processed.includes('fast_light')) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 10);
      });

      expect(processed).toEqual(['fast_light']);
      // CPU job was untouched and remains in waiting state
      expect(cpuJob.state).toBe('waiting');
    });

    it('correctly parses WORKER_QUEUES environment variable', () => {
      const prev = process.env.WORKER_QUEUES;
      try {
        process.env.WORKER_QUEUES = 'light,cpu';
        const q1 = resolveSubscribedQueues();
        expect(q1.map((q) => q.name)).toEqual(['easyconvert-jobs:light', 'easyconvert-jobs:cpu']);

        process.env.WORKER_QUEUES = 'gpu';
        const q2 = resolveSubscribedQueues();
        expect(q2.map((q) => q.name)).toEqual(['easyconvert-jobs:gpu']);

        delete process.env.WORKER_QUEUES;
        const qDefault = resolveSubscribedQueues();
        expect(qDefault).toHaveLength(5); // default + light, cpu, memory, gpu
      } finally {
        if (prev !== undefined) {
          process.env.WORKER_QUEUES = prev;
        } else {
          delete process.env.WORKER_QUEUES;
        }
      }
    });
  });

  // =========================================================================
  // 5. Cross-Queue Job Retrieval and Cancellation
  // =========================================================================
  describe('5. Cross-Queue Job Retrieval and Cancellation', () => {
    it('retrieves jobs across all resource queues via getJobAcrossQueues and conversionQueue.getJob', async () => {
      const jobLight = await resourceQueues.light.add('test_light', {
        jobId: '',
        originalFilename: 'test.json',
        sourceFormat: 'json',
        targetFormat: 'yaml',
        fileSize: 100,
        options: {},
        userId: 'u1',
      });

      const jobGpu = await resourceQueues.gpu.add('test_gpu', {
        jobId: '',
        originalFilename: 'test.mp4',
        sourceFormat: 'mp4',
        targetFormat: 'webm',
        fileSize: 1000,
        options: {},
        userId: 'u1',
      });

      // Direct cross-queue helper
      const foundLight = await getJobAcrossQueues(jobLight.id);
      expect(foundLight).toBeDefined();
      expect(foundLight?.id).toBe(jobLight.id);

      // Transparent delegated lookup on conversionQueue
      const foundGpu = await conversionQueue.getJob(jobGpu.id);
      expect(foundGpu).toBeDefined();
      expect(foundGpu?.id).toBe(jobGpu.id);
    });

    it('cancels jobs across resource queues and triggers quota rollback', async () => {
      const testUser = await redisUserStore.createUser({
        emailVerified: true,
        name: 'Queue Test User',
        email: `queue-test-${Date.now()}@example.com`,
        tier: 'paid',
      });

      const usedToday = async () => (await redisKeyStore.getQuotaUsage(testUser.id)).usedToday;
      const before = await usedToday();
      const reservation = await redisKeyStore.reserveQuota(testUser.id, 1);
      expect(reservation.allowed).toBe(true);
      expect(await usedToday()).toBe(before + 1);

      const job = await resourceQueues.memory.add('test_cad', {
        jobId: '',
        originalFilename: 'part.step',
        sourceFormat: 'step',
        targetFormat: 'stl',
        fileSize: 200,
        options: {},
        userId: testUser.id,
        reservationId: reservation.reservationId,
        resourceClass: 'memory',
      });

      // Cancel via delegated conversionQueue.cancelJob
      const cancelled = await conversionQueue.cancelJob(job.id, 'User cancelled');
      expect(cancelled).toBe(true);
      expect(job.state).toBe('cancelled');

      await vi.waitFor(async () => expect(await usedToday()).toBe(before));
      expect(await redisKeyStore.rollbackQuota(reservation.reservationId!)).toBe(false);
    });

    it('tells the graph scheduler once that a graph node job cancelled on its resource queue ended', async () => {
      const reported = vi.spyOn(graphScheduler, 'onNodeFailed').mockResolvedValue({ graphFailed: false, graphStatus: 'running', cancelledJobIds: [], skippedNodeIds: [] });
      try {
        const jobId = `graph_cancel_once_${Date.now()}:n1`;
        await resourceQueues.light.add('graph-node', {
          jobId,
          originalFilename: 'a.csv',
          sourceFormat: 'bin',
          targetFormat: 'bin',
          fileSize: 0,
          options: {},
          graphId: jobId.split(':')[0],
          graphNodeId: 'n1',
          resourceClass: 'light',
        }, { jobId });

        expect(await conversionQueue.cancelJob(jobId, 'Cancelled by an operator')).toBe(true);
        expect(reported).toHaveBeenCalledTimes(1);
      } finally {
        reported.mockRestore();
      }
    });
  });

  // =========================================================================
  // 6. Jobs API Route Priority and Resource Routing Integration
  // =========================================================================
  describe('6. Jobs API Route Priority and Resource Routing Integration', () => {
    async function createTestApiKey(tier: 'paid' | 'free') {
      const uid = `user_${tier}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      const user = await redisUserStore.createUser({
        emailVerified: true,
        name: `User ${tier}`,
        email: `${uid}@example.com`,
        tier,
      });
      const key = await redisKeyStore.generateApiKey(user.id, `Key ${uid}`, {
        scopes: ['convert:write', 'convert:read'],
      });
      return { uid: user.id, key: key.secretKey };
    }

    it('enqueues paid jobs with priority 1 and free jobs with priority 3', async () => {
      const { key: enterpriseKey } = await createTestApiKey('paid');
      const { key: freeKey } = await createTestApiKey('free');

      s3Storage.saveObject('uploads/data_ent.csv', Buffer.from('name,score\nAlice,100\n'), 'text/csv', 'data_ent.csv');
      s3Storage.saveObject('uploads/data_free.csv', Buffer.from('name,score\nBob,90\n'), 'text/csv', 'data_free.csv');

      // 1. Enterprise request (csv to json -> light queue, priority 1)
      const enterpriseReq = new NextRequest('https://easyconvert.app/api/v1/jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${enterpriseKey}`,
        },
        body: JSON.stringify({
          sourceFormat: 'csv',
          targetFormat: 'json',
          filename: 'data_ent.csv',
          storageKey: 'uploads/data_ent.csv',
        }),
      });

      const resEnterprise = await createJobPost(enterpriseReq);
      expect(resEnterprise.status).toBe(202);
      const dataEnterprise = await resEnterprise.json();
      expect(dataEnterprise.success).toBe(true);

      const jobEnterprise = await resourceQueues.light.getJob(dataEnterprise.jobId);
      expect(jobEnterprise).toBeDefined();
      expect(jobEnterprise?.opts.priority).toBe(1);
      expect(jobEnterprise?.data.resourceClass).toBe('light');

      // 2. Free request (csv to json -> light queue, priority 3)
      const freeReq = new NextRequest('https://easyconvert.app/api/v1/jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${freeKey}`,
        },
        body: JSON.stringify({
          sourceFormat: 'csv',
          targetFormat: 'json',
          filename: 'data_free.csv',
          storageKey: 'uploads/data_free.csv',
        }),
      });

      const resFree = await createJobPost(freeReq);
      expect(resFree.status).toBe(202);
      const dataFree = await resFree.json();
      expect(dataFree.success).toBe(true);

      const jobFree = await resourceQueues.light.getJob(dataFree.jobId);
      expect(jobFree).toBeDefined();
      expect(jobFree?.opts.priority).toBe(3);
      expect(jobFree?.data.resourceClass).toBe('light');
    });

    it('routes CAD conversions to memory queue and Video conversions to gpu queue via API', async () => {
      const { key: proKey } = await createTestApiKey('paid');

      // CAD Job (stl -> obj)
      const STL_DATA = Buffer.from(
        'solid test\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid test\n'
      );
      s3Storage.saveObject('uploads/model.stl', STL_DATA, 'model/stl', 'model.stl');

      const cadReq = new NextRequest('https://easyconvert.app/api/v1/jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${proKey}`,
        },
        body: JSON.stringify({
          sourceFormat: 'stl',
          targetFormat: 'obj',
          filename: 'model.stl',
          storageKey: 'uploads/model.stl',
        }),
      });

      const resCad = await createJobPost(cadReq);
      expect(resCad.status).toBe(202);
      const dataCad = await resCad.json();
      expect(dataCad.success).toBe(true);

      const jobCad = await resourceQueues.memory.getJob(dataCad.jobId);
      expect(jobCad).toBeDefined();
      expect(jobCad?.data.resourceClass).toBe('memory');
      expect(jobCad?.opts.priority).toBe(1); // paid priority

      // Video Job (mp4 -> webm)
      const MP4_DATA = Buffer.from([
        0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70,
        0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
        0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
        0x61, 0x76, 0x63, 0x31, 0x6d, 0x70, 0x34, 0x31,
      ]);
      s3Storage.saveObject('uploads/clip.mp4', MP4_DATA, 'video/mp4', 'clip.mp4');

      const videoReq = new NextRequest('https://easyconvert.app/api/v1/jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${proKey}`,
        },
        body: JSON.stringify({
          sourceFormat: 'mp4',
          targetFormat: 'webm',
          filename: 'clip.mp4',
          storageKey: 'uploads/clip.mp4',
        }),
      });

      const resVideo = await createJobPost(videoReq);
      expect(resVideo.status).toBe(202);
      const dataVideo = await resVideo.json();
      expect(dataVideo.success).toBe(true);

      const jobVideo = await resourceQueues.gpu.getJob(dataVideo.jobId);
      expect(jobVideo).toBeDefined();
      expect(jobVideo?.data.resourceClass).toBe('gpu');
      expect(jobVideo?.opts.priority).toBe(1);
    });
  });

  // =========================================================================
  // 7. All Enqueue Sites and SSE Streams Bound to Resource-Class Queues
  // =========================================================================
  describe('7. All Enqueue Sites and SSE Streams Bound to Resource-Class Queues', () => {
    const CSV_BYTES = Buffer.from('name,score\nAlice,100\nBob,95\n', 'utf8');
    const DOCX_BYTES = fs.readFileSync(path.join(__dirname, 'fixtures', 'document', 'rich-structure.docx'));
    const createdJobIds: string[] = [];
    const registeredHeartbeats: string[] = [];

    beforeAll(async () => {
      for (const q of allConversionQueues) {
        const leftover = await q.getJobs(['waiting', 'delayed', 'active']);
        await Promise.all(leftover.map((job) => q.remove(job.id).catch(() => {})));
      }
    });

    afterEach(async () => {
      vi.unstubAllEnvs();
      for (const workerId of registeredHeartbeats.splice(0)) {
        await unregisterLiveWorkerHeartbeat(workerId).catch(() => {});
      }
      resetLocalLiveWorkersForTests();
      for (const jobId of createdJobIds.splice(0)) {
        await conversionQueue.remove(jobId).catch(() => {});
      }
    });

    async function createUserWithKey(tier: 'paid' | 'free') {
      const uid = `routing_${tier}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const user = await redisUserStore.createUser({
        emailVerified: true,
        name: `Routing ${tier}`,
        email: `${uid}@example.com`,
        tier,
      });
      const key = await redisKeyStore.generateApiKey(user.id, `Routing Key ${uid}`, {
        scopes: ['convert:write', 'convert:read'],
      });
      return { userId: user.id, key: key.secretKey };
    }

    async function makeSinglePagePdf(): Promise<Buffer> {
      const doc = await PDFDocument.create();
      doc.addPage([200, 200]);
      return Buffer.from(await doc.save());
    }

    function startSplitResourceWorker(): Worker<ConversionJobData, ConversionJobResult> {
      vi.stubEnv('WORKER_QUEUES', 'light,cpu,memory,gpu');
      const splitQueues = resolveSubscribedQueues();
      expect(splitQueues.map((q) => q.name)).toEqual([
        'easyconvert-jobs:light',
        'easyconvert-jobs:cpu',
        'easyconvert-jobs:memory',
        'easyconvert-jobs:gpu',
      ]);
      const worker = new Worker(splitQueues, processConversionJob, { concurrency: 2 });
      attachJobLifecycleListeners(worker);
      attachInputCleanupOnCompletion(worker);
      activeWorkers.push(worker);
      return worker;
    }

    it('POST /api/queue/jobs routes csv->json to light and docx->pdf to cpu with tier priority, leaves default empty, and completes on a split worker', async () => {
      const paid = await createUserWithKey('paid');
      const free = await createUserWithKey('free');
      const defaultBefore = await defaultQueueOwnJobCounts();

      const csvRes = await queueJobsPost(
        new NextRequest('https://easyconvert.app/api/queue/jobs', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${paid.key}`,
          },
          body: JSON.stringify({
            filename: 'scores.csv',
            targetFormat: 'json',
            inputBufferBase64: CSV_BYTES.toString('base64'),
            fileSize: CSV_BYTES.length,
          }),
        })
      );
      expect(csvRes.status).toBe(200);
      const csvBody = (await csvRes.json()) as { success: boolean; jobId: string; queue: string };
      createdJobIds.push(csvBody.jobId);
      expect(csvBody.success).toBe(true);
      expect(csvBody.queue).toBe('easyconvert-jobs:light');

      const lightJob = await resourceQueues.light.getJob(csvBody.jobId);
      expect(lightJob?.data.resourceClass).toBe('light');
      expect(lightJob?.opts.priority).toBe(tierToPriority('paid'));

      const docxForm = new FormData();
      docxForm.append(
        'file',
        new File([new Uint8Array(DOCX_BYTES)], 'report.docx', {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        })
      );
      docxForm.append('targetFormat', 'pdf');

      const docxRes = await queueJobsPost(
        new NextRequest('https://easyconvert.app/api/queue/jobs', {
          method: 'POST',
          headers: { Authorization: `Bearer ${free.key}` },
          body: docxForm,
        })
      );
      expect(docxRes.status).toBe(200);
      const docxBody = (await docxRes.json()) as { success: boolean; jobId: string; queue: string };
      createdJobIds.push(docxBody.jobId);
      expect(docxBody.success).toBe(true);
      expect(docxBody.queue).toBe('easyconvert-jobs:cpu');

      const cpuJob = await resourceQueues.cpu.getJob(docxBody.jobId);
      expect(cpuJob?.data.resourceClass).toBe('cpu');
      expect(cpuJob?.opts.priority).toBe(tierToPriority('free'));

      const defaultAfterEnqueue = await defaultQueueOwnJobCounts();
      expect(defaultAfterEnqueue.waiting).toBe(0);
      expect(defaultAfterEnqueue.waiting).toBe(defaultBefore.waiting);

      startSplitResourceWorker();

      await vi.waitFor(
        async () => {
          const doneLight = await resourceQueues.light.getJob(csvBody.jobId);
          const doneCpu = await resourceQueues.cpu.getJob(docxBody.jobId);
          expect(doneLight?.state).toBe('completed');
          expect(doneCpu?.state).toBe('completed');
        },
        { timeout: 15_000, interval: 40 }
      );

      const finishedLight = await resourceQueues.light.getJob(csvBody.jobId);
      const finishedCpu = await resourceQueues.cpu.getJob(docxBody.jobId);
      expect(finishedLight?.returnvalue?.mimeType).toBe('application/json');
      expect(finishedCpu?.returnvalue?.mimeType).toBe('application/pdf');
    }, 30_000);

    it('POST /api/v1/convert with Prefer: respond-async routes to resourceQueues.light with tierToPriority and leaves default empty', async () => {
      const paid = await createUserWithKey('paid');
      const free = await createUserWithKey('free');
      const defaultBefore = await defaultQueueOwnJobCounts();

      const sendAsyncConvert = async (apiKey: string) => {
        const form = new FormData();
        form.append('file', new File([new Uint8Array(CSV_BYTES)], 'scores.csv', { type: 'text/csv' }));
        form.append('targetFormat', 'json');
        return v1ConvertPost(
          new NextRequest('https://easyconvert.app/api/v1/convert', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              Prefer: 'respond-async',
            },
            body: form,
          })
        );
      };

      const paidRes = await sendAsyncConvert(paid.key);
      expect(paidRes.status).toBe(202);
      const paidBody = (await paidRes.json()) as { jobId: string };
      createdJobIds.push(paidBody.jobId);

      const freeRes = await sendAsyncConvert(free.key);
      expect(freeRes.status).toBe(202);
      const freeBody = (await freeRes.json()) as { jobId: string };
      createdJobIds.push(freeBody.jobId);

      const paidJob = await resourceQueues.light.getJob(paidBody.jobId);
      const freeJob = await resourceQueues.light.getJob(freeBody.jobId);
      expect(paidJob?.data.resourceClass).toBe('light');
      expect(paidJob?.opts.priority).toBe(tierToPriority('paid'));
      expect(freeJob?.data.resourceClass).toBe('light');
      expect(freeJob?.opts.priority).toBe(tierToPriority('free'));

      const defaultAfter = await defaultQueueOwnJobCounts();
      expect(defaultAfter.waiting).toBe(0);
      expect(defaultAfter.waiting).toBe(defaultBefore.waiting);
    });

    it('POST /api/tools/jobs (merge and archive-create) and dispatchSyncWebTool (merge) in queue-only mode route to resourceQueues.cpu and complete on a split worker', async () => {
      vi.stubEnv('WEB_EXECUTION_MODE', 'queue-only');
      const paid = await createUserWithKey('paid');
      const free = await createUserWithKey('free');
      const workerId = `split_tools_worker_${Date.now()}`;
      await registerLiveWorkerHeartbeat(workerId);
      registeredHeartbeats.push(workerId);

      const pdfA = await makeSinglePagePdf();
      const pdfB = await makeSinglePagePdf();

      const mergeForm = new FormData();
      mergeForm.set('tool', 'merge');
      mergeForm.append('files', new File([new Uint8Array(pdfA)], 'a.pdf', { type: 'application/pdf' }));
      mergeForm.append('files', new File([new Uint8Array(pdfB)], 'b.pdf', { type: 'application/pdf' }));

      const mergePost = await toolsJobsPost(
        new NextRequest('https://easyconvert.app/api/tools/jobs', {
          method: 'POST',
          headers: { Authorization: `Bearer ${paid.key}` },
          body: mergeForm,
        })
      );
      expect(mergePost.status).toBe(201);
      const mergeCreated = (await mergePost.json()) as { id: string; status: string };
      createdJobIds.push(mergeCreated.id);

      const archiveForm = new FormData();
      archiveForm.set('tool', 'archive-create');
      archiveForm.set('options', JSON.stringify({ format: 'zip' }));
      archiveForm.append('files', new File([Buffer.from('archive note', 'utf8')], 'note.txt', { type: 'text/plain' }));

      const archivePost = await toolsJobsPost(
        new NextRequest('https://easyconvert.app/api/tools/jobs', {
          method: 'POST',
          headers: { Authorization: `Bearer ${free.key}` },
          body: archiveForm,
        })
      );
      expect(archivePost.status).toBe(201);
      const archiveCreated = (await archivePost.json()) as { id: string; status: string };
      createdJobIds.push(archiveCreated.id);

      const mergeJob = await resourceQueues.cpu.getJob(mergeCreated.id);
      const archiveJob = await resourceQueues.cpu.getJob(archiveCreated.id);
      expect(mergeJob?.data.resourceClass).toBe('cpu');
      expect(mergeJob?.opts.priority).toBe(tierToPriority('paid'));
      expect(archiveJob?.data.resourceClass).toBe('cpu');
      expect(archiveJob?.opts.priority).toBe(tierToPriority('free'));
      expect((await defaultQueueOwnJobCounts()).waiting).toBe(0);

      startSplitResourceWorker();

      await vi.waitFor(
        async () => {
          const pollMerge = await toolsJobGet(
            new NextRequest(`https://easyconvert.app/api/tools/jobs/${mergeCreated.id}`, {
              headers: { Authorization: `Bearer ${paid.key}` },
            }),
            { params: Promise.resolve({ id: mergeCreated.id }) }
          );
          const mergeStatus = (await pollMerge.json()) as { status: string; result?: { size: number } };
          expect(mergeStatus.status).toBe('completed');
          expect(mergeStatus.result?.size).toBeGreaterThan(100);

          const pollArchive = await toolsJobGet(
            new NextRequest(`https://easyconvert.app/api/tools/jobs/${archiveCreated.id}`, {
              headers: { Authorization: `Bearer ${free.key}` },
            }),
            { params: Promise.resolve({ id: archiveCreated.id }) }
          );
          const archiveStatus = (await pollArchive.json()) as { status: string; result?: { size: number } };
          expect(archiveStatus.status).toBe('completed');
          expect(archiveStatus.result?.size).toBeGreaterThan(20);
        },
        { timeout: 15_000, interval: 40 }
      );

      const defaultAddSpy = vi.spyOn(conversionQueue, 'add');
      const cpuAddSpy = vi.spyOn(resourceQueues.cpu, 'add');

      const syncMerge = await dispatchSyncWebTool({
        tool: 'merge',
        files: [
          { name: 'a.pdf', buffer: pdfA },
          { name: 'b.pdf', buffer: pdfB },
        ],
        options: {},
        userId: paid.userId,
        tier: 'paid',
      });
      expect(syncMerge.kind).toBe('file');
      if (syncMerge.kind === 'file') {
        expect(syncMerge.mimeType).toBe('application/pdf');
        expect(syncMerge.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      }
      expect(defaultAddSpy).not.toHaveBeenCalled();
      expect(cpuAddSpy).toHaveBeenCalledTimes(1);
      expect(cpuAddSpy.mock.calls[0][1].resourceClass).toBe('cpu');
      expect(cpuAddSpy.mock.calls[0][2]?.priority).toBe(tierToPriority('paid'));
      expect((await defaultQueueOwnJobCounts()).waiting).toBe(0);
    });

    it('GET /api/queue/jobs/[id]?stream=true delivers completed SSE telemetry emitted directly on targetQueue when conversionQueue does not emit', async () => {
      const paid = await createUserWithKey('paid');

      const cases = [
        {
          queue: resourceQueues.light,
          resourceClass: 'light' as const,
          filename: 'scores.csv',
          sourceFormat: 'csv',
          targetFormat: 'json',
          outFilename: 'scores.json',
          mimeType: 'application/json',
        },
        {
          queue: resourceQueues.cpu,
          resourceClass: 'cpu' as const,
          filename: 'report.docx',
          sourceFormat: 'docx',
          targetFormat: 'pdf',
          outFilename: 'report.pdf',
          mimeType: 'application/pdf',
        },
      ];

      for (const item of cases) {
        const job = await item.queue.add('convert', {
          jobId: '',
          originalFilename: item.filename,
          sourceFormat: item.sourceFormat,
          targetFormat: item.targetFormat,
          fileSize: 128,
          options: {},
          userId: paid.userId,
          resourceClass: item.resourceClass,
          inputBufferBase64: Buffer.from('a,b\n1,2\n', 'utf8').toString('base64'),
        });
        createdJobIds.push(job.id);

        const sseRes = await queueJobGet(
          new NextRequest(`https://easyconvert.app/api/queue/jobs/${job.id}?stream=true`, {
            headers: { Authorization: `Bearer ${paid.key}` },
          }),
          { params: Promise.resolve({ id: job.id }) }
        );
        expect(sseRes.status).toBe(200);
        expect(sseRes.headers.get('content-type')).toBe('text/event-stream');

        const reader = sseRes.body!.getReader();
        const decoder = new TextDecoder();
        const firstChunk = await reader.read();
        expect(firstChunk.done).toBe(false);
        const firstText = decoder.decode(firstChunk.value);
        expect(firstText).toContain('event: initial');

        // Simulate cross-process Redis Pub/Sub delivering telemetry on the resource queue without touching conversionQueue.
        item.queue.emit(`telemetry:${job.id}`, {
          event: 'completed',
          data: {
            jobId: job.id,
            progress: 100,
            state: 'completed',
            result: {
              jobId: job.id,
              status: 'completed',
              resultKey: `results/${job.id}/${item.outFilename}`,
              downloadUrl: `/api/storage/file/${encodeURIComponent(`results/${job.id}/${item.outFilename}`)}`,
              filename: item.outFilename,
              mimeType: item.mimeType,
              size: 42,
              durationMs: 7,
              engineUsed: 'ts-engine',
            },
          },
        });

        let restText = '';
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          restText += decoder.decode(next.value, { stream: true });
        }
        restText += decoder.decode();

        expect(restText).toContain('event: completed');
        const dataLine = restText
          .split('\n')
          .find((line) => line.startsWith('data: '));
        expect(dataLine).toBeDefined();
        const parsed = JSON.parse(dataLine!.slice('data: '.length)) as {
          jobId: string;
          state: string;
          result?: Record<string, unknown>;
        };
        expect(parsed.jobId).toBe(job.id);
        expect(parsed.state).toBe('completed');
        expect(parsed.result?.filename).toBe(item.outFilename);
        expect(parsed.result).not.toHaveProperty('engineUsed');
      }
    });
  });
});
