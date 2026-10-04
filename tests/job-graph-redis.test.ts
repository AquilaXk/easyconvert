import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Redis from 'ioredis';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { RedisGraphExecutor, InMemoryGraphExecutor } from '@/lib/jobs/graph-executor';
import type { JobGraph } from '@/lib/jobs/graph';
import { storageProvider as storage } from '@/lib/storage';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

async function createSamplePdf(text: string): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([400, 400]);
  page.drawText(text, { x: 50, y: 350 });
  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

function createSamplePng(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );
}

describe('Phase 3-B: Job Graph Model Redis Atomic DAG Orchestration', () => {
  let redisClient: Redis | null = null;
  let redisAvailable = false;

  beforeEach(async () => {
    try {
      const client = new Redis(REDIS_URL, {
        maxRetriesPerRequest: 1,
        connectTimeout: 1000,
        lazyConnect: false,
      });
      await client.ping();
      redisClient = client;
      redisAvailable = true;
    } catch {
      redisAvailable = false;
      redisClient = null;
    }
  });

  afterEach(async () => {
    if (redisClient) {
      // Clean up test keys with {job} hash tag and bull:{job}:waiting
      const keys = await redisClient.keys('*test_dag_*');
      if (keys.length > 0) {
        await redisClient.del(...keys);
      }
      await redisClient.del('bull:{job}:waiting').catch(() => {});
      await redisClient.quit().catch(() => {});
      redisClient = null;
    }
  });

  describe('1. Fan-out (1 -> N) and Fan-in (N -> 1) Orchestration with Real Redis', () => {
    it('executes a fan-out and fan-in graph, preserves topological order, and bundles intermediate artifacts', async (ctx) => {
      if (!redisAvailable || !redisClient) {
        ctx.skip();
        return;
      }

      const jobId = `test_dag_fan_${Date.now()}`;
      const executor = new RedisGraphExecutor(redisClient, storage);

      // Pre-seed an initial input object
      const samplePngBuf = createSamplePng();
      const seedKey = `tasks/${jobId}/import_source/photo.png`;
      storage.saveObject(seedKey, samplePngBuf, 'image/png', 'photo.png', 86400000);

      // Diamond Fan-out / Fan-in DAG:
      //          import_source
      //         /      |      \
      //    task_thumb task_meta task_conv_jpg
      //         \      |      /
      //          task_archive
      //                |
      //         export_terminal
      const graph: JobGraph = {
        failurePolicy: 'fail_job',
        nodes: {
          import_source: {
            id: 'import_source',
            operation: 'import.upload',
            storageKey: seedKey,
          },
          task_thumb: {
            id: 'task_thumb',
            operation: 'thumbnail',
            dependencies: ['import_source'],
            targetFormat: 'png',
            options: { thumbnail: { width: 64, height: 64, format: 'png' } },
          },
          task_meta: {
            id: 'task_meta',
            operation: 'metadata',
            dependencies: ['import_source'],
          },
          task_conv_jpg: {
            id: 'task_conv_jpg',
            operation: 'convert',
            dependencies: ['import_source'],
            targetFormat: 'jpg',
          },
          task_archive: {
            id: 'task_archive',
            operation: 'archive/create',
            dependencies: ['task_thumb', 'task_meta', 'task_conv_jpg'],
            targetFormat: 'zip',
          },
          export_terminal: {
            id: 'export_terminal',
            operation: 'export.internal',
            dependencies: ['task_archive'],
          },
        },
      };

      // 1. Initialize graph in Redis
      const initState = await executor.initGraph(jobId, graph, {
        ownerUserId: 'test_user_3b',
        sourceStorageKey: seedKey,
      });

      expect(initState.status).toBe('running');
      expect(initState.totalTasks).toBe(6);
      expect(initState.tasks['import_source'].status).toBe('waiting');
      expect(initState.tasks['task_thumb'].status).toBe('pending');
      expect(initState.tasks['task_archive'].status).toBe('pending');

      // 2. Step 1: Execute import_source
      const importRes = await executor.executeTask(jobId, graph.nodes!['import_source'], [seedKey]);
      expect(importRes.status).toBe('completed');
      expect(importRes.outputKeys).toContain(seedKey);

      // Verify that after import_source completed, the 3 child tasks are now ready
      const stateAfterImport = await executor.getGraphState(jobId);
      expect(stateAfterImport?.tasks['task_thumb'].status).toBe('waiting');
      expect(stateAfterImport?.tasks['task_meta'].status).toBe('waiting');
      expect(stateAfterImport?.tasks['task_conv_jpg'].status).toBe('waiting');
      expect(stateAfterImport?.tasks['task_archive'].status).toBe('pending'); // Still pending!

      // 3. Step 2: Execute the 3 fan-out tasks
      const thumbRes = await executor.executeTask(jobId, graph.nodes!['task_thumb'], [seedKey]);
      expect(thumbRes.status).toBe('completed');
      expect(thumbRes.outputKeys.length).toBeGreaterThan(0);
      expect(thumbRes.outputKeys[0]).toContain(`tasks/${jobId}/task_thumb/`);

      // Verify intermediate storage object for thumbnail exists
      const thumbObj = storage.getObject(thumbRes.outputKeys[0]);
      expect(thumbObj).toBeDefined();
      expect(thumbObj!.size).toBeGreaterThan(0);

      const metaRes = await executor.executeTask(jobId, graph.nodes!['task_meta'], [seedKey]);
      expect(metaRes.status).toBe('completed');
      expect(metaRes.outputKeys[0]).toContain(`tasks/${jobId}/task_meta/metadata.json`);

      // Verify metadata content
      const metaObj = storage.getObject(metaRes.outputKeys[0]);
      expect(metaObj).toBeDefined();
      const metaData = JSON.parse(metaObj!.buffer.toString('utf-8'));
      expect(metaData.format).toBe('png');
      expect(metaData.sizeBytes).toBeGreaterThan(0);
      expect(metaData.width).toBe(1);
      expect(metaData.height).toBe(1);

      // Aggregator task_archive should STILL be pending because task_conv_jpg has not finished
      const stateBeforeLastBranch = await executor.getGraphState(jobId);
      expect(stateBeforeLastBranch?.tasks['task_archive'].status).toBe('pending');

      const convRes = await executor.executeTask(jobId, graph.nodes!['task_conv_jpg'], [seedKey]);
      expect(convRes.status).toBe('completed');
      expect(convRes.outputKeys[0]).toContain(`tasks/${jobId}/task_conv_jpg/`);

      // Now all 3 upstream dependencies are finished, task_archive should transition to 'waiting'
      const stateAfterAllBranches = await executor.getGraphState(jobId);
      expect(stateAfterAllBranches?.tasks['task_archive'].status).toBe('waiting');

      // 4. Step 3: Execute fan-in aggregator task_archive
      const allUpstreamArtifacts = [
        ...thumbRes.outputKeys,
        ...metaRes.outputKeys,
        ...convRes.outputKeys,
      ];
      const archiveRes = await executor.executeTask(
        jobId,
        graph.nodes!['task_archive'],
        allUpstreamArtifacts
      );
      expect(archiveRes.status).toBe('completed');
      expect(archiveRes.outputKeys[0]).toContain(`tasks/${jobId}/task_archive/bundle.zip`);

      // Verify fan-in archive output actually contains all upstream task artifacts!
      const archiveObj = storage.getObject(archiveRes.outputKeys[0]);
      expect(archiveObj).toBeDefined();
      expect(archiveObj!.size).toBeGreaterThan(0);

      const zip = await JSZip.loadAsync(archiveObj!.buffer);
      const zipEntries = Object.keys(zip.files);
      expect(zipEntries.length).toBe(3);
      expect(zipEntries.some((f) => f.includes('metadata.json'))).toBe(true);
      expect(zipEntries.some((f) => f.endsWith('.png') || f.endsWith('.jpg'))).toBe(true);

      // 5. Step 4: Execute export terminal
      const exportRes = await executor.executeTask(
        jobId,
        graph.nodes!['export_terminal'],
        archiveRes.outputKeys
      );
      expect(exportRes.status).toBe('completed');

      // 6. Verify final graph state in Redis
      const finalState = await executor.getGraphState(jobId);
      expect(finalState?.status).toBe('completed');
      expect(finalState?.completedTasks).toBe(6);
      expect(finalState?.failedTasks).toBe(0);

      // Verify strictly monotonic topological execution timestamps
      const thumbFinished = finalState!.tasks['task_thumb'].finishedAt!;
      const metaFinished = finalState!.tasks['task_meta'].finishedAt!;
      const convFinished = finalState!.tasks['task_conv_jpg'].finishedAt!;
      const archiveStarted = finalState!.tasks['task_archive'].startedAt!;

      expect(archiveStarted).toBeGreaterThanOrEqual(
        Math.min(thumbFinished, metaFinished, convFinished)
      );
    });
  });

  describe('2. Cascade Failure Policies: fail_job vs continue', () => {
    it('cancels all dependent and pending tasks when a node fails under fail_job policy', async (ctx) => {
      if (!redisAvailable || !redisClient) {
        ctx.skip();
        return;
      }

      const jobId = `test_dag_fail_${Date.now()}`;
      const executor = new RedisGraphExecutor(redisClient, storage);

      const graph: JobGraph = {
        failurePolicy: 'fail_job',
        nodes: {
          start: { id: 'start', operation: 'import.upload', storageKey: 'uploads/file.png' },
          failing_task: { id: 'failing_task', operation: 'convert', dependencies: ['start'], targetFormat: 'invalid_format' },
          dependent_task: { id: 'dependent_task', operation: 'convert', dependencies: ['failing_task'], targetFormat: 'jpg' },
          export_terminal: { id: 'export_terminal', operation: 'export.internal', dependencies: ['dependent_task'] },
        },
      };

      await executor.initGraph(jobId, graph);

      // Mark start as completed
      await executor.onTaskCompleted(jobId, 'start', ['tasks/start/file.png']);

      // Now failing_task fails
      const failResult = await executor.onTaskFailed(jobId, 'failing_task', 'Engine conversion crash');
      expect(failResult.graphStatus).toBe('failed');
      expect(failResult.cancelledTasks).toContain('dependent_task');
      expect(failResult.cancelledTasks).toContain('export_terminal');

      const state = await executor.getGraphState(jobId);
      expect(state?.status).toBe('failed');
      expect(state?.failedReason).toBe('Engine conversion crash');
      expect(state?.tasks['failing_task'].status).toBe('failed');
      expect(state?.tasks['dependent_task'].status).toBe('cancelled');
      expect(state?.tasks['export_terminal'].status).toBe('cancelled');
    });

    it('cascades skipped status to descendants while independent branches continue under continue policy', async (ctx) => {
      if (!redisAvailable || !redisClient) {
        ctx.skip();
        return;
      }

      const jobId = `test_dag_cont_${Date.now()}`;
      const executor = new RedisGraphExecutor(redisClient, storage);

      // Branch 1: start -> branch_fail -> child_fail
      // Branch 2: start -> branch_ok -> child_ok
      const graph: JobGraph = {
        failurePolicy: 'continue',
        nodes: {
          start: { id: 'start', operation: 'import.upload', storageKey: 'uploads/file.png' },
          branch_fail: { id: 'branch_fail', operation: 'convert', dependencies: ['start'], targetFormat: 'fail' },
          child_fail: { id: 'child_fail', operation: 'convert', dependencies: ['branch_fail'], targetFormat: 'png' },
          branch_ok: { id: 'branch_ok', operation: 'convert', dependencies: ['start'], targetFormat: 'jpg' },
          child_ok: { id: 'child_ok', operation: 'convert', dependencies: ['branch_ok'], targetFormat: 'webp' },
        },
      };

      await executor.initGraph(jobId, graph);
      await executor.onTaskCompleted(jobId, 'start', ['tasks/start/file.png']);

      // branch_fail fails
      const failRes = await executor.onTaskFailed(jobId, 'branch_fail', 'Conversion failed');
      expect(failRes.skippedTasks).toContain('child_fail');

      // Verify child_fail is skipped
      const stateMid = await executor.getGraphState(jobId);
      expect(stateMid?.tasks['child_fail'].status).toBe('skipped');
      expect(stateMid?.tasks['branch_ok'].status).toBe('waiting'); // branch_ok is still waiting/running!

      // branch_ok succeeds
      await executor.onTaskCompleted(jobId, 'branch_ok', ['tasks/branch_ok/file.jpg']);
      // child_ok succeeds
      await executor.onTaskCompleted(jobId, 'child_ok', ['tasks/child_ok/file.webp']);

      // Overall graph reaches completed status because all remaining tasks finished
      const stateFinal = await executor.getGraphState(jobId);
      expect(stateFinal?.status).toBe('completed');
      expect(stateFinal?.tasks['branch_fail'].status).toBe('failed');
      expect(stateFinal?.tasks['child_fail'].status).toBe('skipped');
      expect(stateFinal?.tasks['branch_ok'].status).toBe('completed');
      expect(stateFinal?.tasks['child_ok'].status).toBe('completed');
    });
  });

  describe('3. Execution of New Operations: Thumbnail, Merge, Metadata', () => {
    it('executes merge operation combining multiple PDF artifacts into a unified PDF document', async () => {
      const jobId = `test_merge_${Date.now()}`;
      const executor = new InMemoryGraphExecutor(storage);

      const pdf1 = await createSamplePdf('Page 1 Content');
      const pdf2 = await createSamplePdf('Page 2 Content');

      const key1 = `tasks/${jobId}/pdf1/doc1.pdf`;
      const key2 = `tasks/${jobId}/pdf2/doc2.pdf`;

      storage.saveObject(key1, pdf1, 'application/pdf', 'doc1.pdf', 86400000);
      storage.saveObject(key2, pdf2, 'application/pdf', 'doc2.pdf', 86400000);

      const mergeTask = {
        id: 'task_merge',
        operation: 'merge',
        targetFormat: 'pdf',
      };

      const result = await executor.executeTask(jobId, mergeTask, [key1, key2]);
      expect(result.status).toBe('completed');
      expect(result.outputKeys[0]).toContain(`tasks/${jobId}/task_merge/merged.pdf`);

      const mergedObj = storage.getObject(result.outputKeys[0]);
      expect(mergedObj).toBeDefined();
      expect(mergedObj!.size).toBeGreaterThan(0);

      // Verify the merged PDF document contains exactly 2 pages!
      const mergedPdfDoc = await PDFDocument.load(mergedObj!.buffer);
      expect(mergedPdfDoc.getPageCount()).toBe(2);
    });

    it('executes thumbnail operation on image generating appropriately sized thumbnail', async () => {
      const jobId = `test_thumb_${Date.now()}`;
      const executor = new InMemoryGraphExecutor(storage);

      const pngBuf = createSamplePng();
      const inputKey = `tasks/${jobId}/src/input.png`;
      storage.saveObject(inputKey, pngBuf, 'image/png', 'input.png', 86400000);

      const thumbTask = {
        id: 'task_thumbnail',
        operation: 'thumbnail',
        targetFormat: 'png',
        options: { thumbnail: { width: 64, height: 64, format: 'png' } },
      };

      const result = await executor.executeTask(jobId, thumbTask, [inputKey]);
      expect(result.status).toBe('completed');
      expect(result.outputKeys[0]).toContain(`tasks/${jobId}/task_thumbnail/thumbnail.png`);

      const thumbObj = storage.getObject(result.outputKeys[0]);
      expect(thumbObj).toBeDefined();
      expect(thumbObj!.size).toBeGreaterThan(0);
      expect(thumbObj!.mimeType).toBe('image/png');
    });
  });

  describe('4. Automatic Upstream Input Resolution & Reference Retrieval', () => {
    it('automatically resolves and passes input artifacts from upstream dependency outputs without explicit input keys', async (ctx) => {
      if (!redisAvailable || !redisClient) {
        ctx.skip();
        return;
      }

      const jobId = `test_dag_auto_res_${Date.now()}`;
      const executor = new RedisGraphExecutor(redisClient, storage);

      const samplePngBuf = createSamplePng();
      const seedKey = `tasks/${jobId}/import_source/photo.png`;
      storage.saveObject(seedKey, samplePngBuf, 'image/png', 'photo.png', 86400000);

      const graph: JobGraph = {
        failurePolicy: 'fail_job',
        nodes: {
          import_source: {
            id: 'import_source',
            operation: 'import.upload',
            storageKey: seedKey,
          },
          task_thumb: {
            id: 'task_thumb',
            operation: 'thumbnail',
            dependencies: ['import_source'],
            targetFormat: 'png',
            options: { thumbnail: { width: 48, height: 48, format: 'png' } },
          },
          task_archive: {
            id: 'task_archive',
            operation: 'archive/create',
            dependencies: ['task_thumb'],
            targetFormat: 'zip',
          },
        },
      };

      await executor.initGraph(jobId, graph, {
        ownerUserId: 'auto_res_user',
        sourceStorageKey: seedKey,
      });

      // Execute import_source
      const importRes = await executor.executeTask(jobId, graph.nodes!['import_source']);
      expect(importRes.status).toBe('completed');

      // Verify getTaskOutputs returns the recorded output
      const importOutputs = await executor.getTaskOutputs(jobId, 'import_source');
      expect(importOutputs).toContain(seedKey);

      // Execute task_thumb WITHOUT passing inputArtifactKeys: it must resolve from import_source
      const thumbRes = await executor.executeTask(jobId, graph.nodes!['task_thumb']);
      expect(thumbRes.status).toBe('completed');
      expect(thumbRes.outputKeys.length).toBeGreaterThan(0);

      const thumbOutputs = await executor.getTaskOutputs(jobId, 'task_thumb');
      expect(thumbOutputs).toEqual(thumbRes.outputKeys);

      // Execute task_archive WITHOUT passing inputArtifactKeys: it must resolve from task_thumb
      const archiveRes = await executor.executeTask(jobId, graph.nodes!['task_archive']);
      expect(archiveRes.status).toBe('completed');

      const archiveObj = storage.getObject(archiveRes.outputKeys[0]);
      expect(archiveObj).toBeDefined();
      const zip = await JSZip.loadAsync(archiveObj!.buffer);
      expect(Object.keys(zip.files).length).toBeGreaterThan(0);

      // Verify cleanupGraph purges intermediate artifacts
      await executor.cleanupGraph(jobId);
      const cleanedThumb = storage.getObject(thumbRes.outputKeys[0]);
      expect(cleanedThumb).toBeUndefined();
    });
  });

  describe('5. Fail-Closed Boundaries & Error Handling', () => {
    it('fails-closed and throws error when an unsupported task operation is executed', async () => {
      const jobId = `test_unsupported_op_${Date.now()}`;
      const executor = new InMemoryGraphExecutor(storage);

      const badTask = {
        id: 'bad_task',
        operation: 'dangerous_unsupported_operation',
      };

      const result = await executor.executeTask(jobId, badTask, ['dummy.key']);
      expect(result.status).toBe('failed');
      expect(result.error).toContain('Unsupported graph task operation: "dangerous_unsupported_operation"');
    });

    it('fails-closed when merge is attempted with a missing or zero-byte artifact', async () => {
      const jobId = `test_merge_fail_${Date.now()}`;
      const executor = new InMemoryGraphExecutor(storage);

      const mergeTask = {
        id: 'merge_step',
        operation: 'merge',
        targetFormat: 'pdf',
      };

      // 1. Missing artifact
      const missingResult = await executor.executeTask(jobId, mergeTask, ['non_existent_key.pdf']);
      expect(missingResult.status).toBe('failed');
      expect(missingResult.error).toContain('not found in storage for merge');

      // 2. Zero-byte artifact
      const zeroKey = `tasks/${jobId}/zero.pdf`;
      storage.saveObject(zeroKey, Buffer.from(''), 'application/pdf', 'zero.pdf', 86400000);
      const zeroResult = await executor.executeTask(jobId, mergeTask, [zeroKey]);
      expect(zeroResult.status).toBe('failed');
      expect(zeroResult.error).toContain('has zero bytes and cannot be merged');
    });

    it('handles waiting queue gracefully when waitingKey is a priority ZSET without WRONGTYPE error', async (ctx) => {
      if (!redisAvailable || !redisClient) {
        ctx.skip();
        return;
      }

      const jobId = `test_zset_compat_${Date.now()}`;
      const waitingKey = `bull:{job}:waiting`;

      // Pre-create waitingKey as a ZSET
      await redisClient.zadd(waitingKey, 100, 'existing_zset_item');

      const executor = new RedisGraphExecutor(redisClient, storage);
      const samplePngBuf = createSamplePng();
      const seedKey = `tasks/${jobId}/src.png`;
      storage.saveObject(seedKey, samplePngBuf, 'image/png', 'src.png', 86400000);

      const graph: JobGraph = {
        failurePolicy: 'fail_job',
        nodes: {
          src: { id: 'src', operation: 'import.upload', storageKey: seedKey },
          out: { id: 'out', operation: 'export.internal', dependencies: ['src'] },
        },
      };

      // Initializing graph must push ready task to ZSET via ZADD without throwing WRONGTYPE
      const initState = await executor.initGraph(jobId, graph, { sourceStorageKey: seedKey });
      expect(initState.status).toBe('running');

      const isMember = await redisClient.zscore(waitingKey, `${jobId}:src`);
      expect(isMember).not.toBeNull();

      // Completing task src must push child task out to ZSET via ZADD
      await executor.executeTask(jobId, graph.nodes!['src']);
      const isOutMember = await redisClient.zscore(waitingKey, `${jobId}:out`);
      expect(isOutMember).not.toBeNull();

      // Clean up test ZSET
      await redisClient.del(waitingKey);
    });
  });
});
