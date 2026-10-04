import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  processNodeJob,
  tsEngine,
  nativeEngine,
  type ConversionEnginePort,
} from '../src/lib/queue/node-processor';
import { Queue, JobCancelledError } from '../src/lib/queue/bullmq-engine';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { globalSharedObjects } from '../src/lib/storage/shared-store';
import * as errorsModule from '../src/lib/storage/errors';
import { PayloadTooLargeForMemoryError } from '../src/lib/storage/errors';
import * as memoryShredder from '../src/lib/security/memory-shredder';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';
import type { JobGraph } from '../src/lib/queue/graph/types';
import { graphScheduler } from '../src/lib/queue/graph';

describe('WP-32: Unified Shared Node Processor', () => {
  let queue: Queue<ConversionJobData, ConversionJobResult>;
  const createdTempFiles: string[] = [];

  beforeEach(() => {
    queue = new Queue<ConversionJobData, ConversionJobResult>('test-shared-processor-queue');
    globalSharedObjects.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    for (const p of createdTempFiles) {
      try {
        if (fs.existsSync(p)) {
          fs.rmSync(p, { force: true });
        }
      } catch {}
    }
    createdTempFiles.length = 0;
  });

  describe('1. Regression: Multi-stage pipeline tasks run identically on native worker', () => {
    it('executes all pipeline stages to completion using nativeEngine without rejection', async () => {
      const csvContent = 'id,name,role\n101,Ada Lovelace,Mathematician\n102,Alan Turing,Computer Scientist\n';
      const inputBuf = Buffer.from(csvContent, 'utf-8');
      const storageKey = 'uploads/users.csv';
      s3Storage.saveObject(storageKey, inputBuf, 'text/csv', 'users.csv');

      const jobData: ConversionJobData = {
        jobId: 'job_pipeline_native_1',
        sourceFormat: 'csv',
        targetFormat: 'yaml',
        originalFilename: 'users.csv',
        fileSize: inputBuf.length,
        storageKey,
        options: {},
        tasks: [
          {
            name: 'stage-1-csv-to-json',
            operation: 'convert',
            targetFormat: 'json',
          },
          {
            name: 'stage-2-json-to-yaml',
            operation: 'convert',
            targetFormat: 'yaml',
          },
        ],
      };

      const job = await queue.add('convert', jobData);

      // Process via nativeEngine (the engine used by the dedicated OCI worker)
      const result = await processNodeJob(job, nativeEngine, s3Storage);

      expect(result.status).toBe('completed');
      expect(result.filename).toMatch(/\.yaml$/i);
      expect(result.mimeType).toContain('yaml');
      expect(result.size).toBeGreaterThan(0);

      // Verify the final artifact persisted in storage
      const stored = s3Storage.getObject(result.resultKey);
      expect(stored).toBeDefined();
      const yamlOutput = stored!.buffer.toString('utf-8');
      expect(yamlOutput).toContain('Ada Lovelace');
      expect(yamlOutput).toContain('Alan Turing');
      expect(yamlOutput).toContain('101');
      expect(yamlOutput).toContain('102');

      // Verify job progress was updated through all stages to 100%
      expect(job.progress).toBe(100);
      expect(job.logs.some((l) => l.includes('Stage 1/2'))).toBe(true);
      expect(job.logs.some((l) => l.includes('Stage 2/2'))).toBe(true);
    });
  });

  describe('2. Parity: 3-stage DAG graph execution parity between tsEngine and nativeEngine', () => {
    it('produces identical node status transitions and artifact counts in both engines', async () => {
      const csvInput = 'item,quantity\nWidget,42\nGadget,99\n';
      const inputBuffer = Buffer.from(csvInput, 'utf-8');

      const testGraph: JobGraph = {
        failurePolicy: 'fail_fast',
        nodes: {
          n_upload: { op: 'import.upload', storageKey: 'uploads/inventory.csv' },
          n_convert: { op: 'convert', input: 'n_upload', targetFormat: 'json' },
          n_export: { op: 'export.internal', input: 'n_convert' },
        },
      };

      // Run A: tsEngine
      s3Storage.saveObject('uploads/inventory.csv', inputBuffer, 'text/csv', 'inventory.csv');
      const graphIdA = `parity_graph_ts_${Date.now()}`;
      await graphScheduler.initGraph(graphIdA, testGraph);

      // Node 1: n_upload
      const jobA1 = await queue.add('graph_node', {
        jobId: `job_${graphIdA}_n_upload`,
        sourceFormat: 'csv',
        targetFormat: 'csv',
        originalFilename: 'inventory.csv',
        fileSize: inputBuffer.length,
        options: {},
        graphId: graphIdA,
        graphNodeId: 'n_upload',
        graphNode: testGraph.nodes.n_upload,
      });
      await processNodeJob(jobA1, tsEngine, s3Storage);

      // Node 2: n_convert
      const jobA2 = await queue.add('graph_node', {
        jobId: `job_${graphIdA}_n_convert`,
        sourceFormat: 'csv',
        targetFormat: 'json',
        originalFilename: 'inventory.csv',
        fileSize: inputBuffer.length,
        options: {},
        graphId: graphIdA,
        graphNodeId: 'n_convert',
        graphNode: testGraph.nodes.n_convert,
      });
      await processNodeJob(jobA2, tsEngine, s3Storage);

      // Node 3: n_export
      const jobA3 = await queue.add('graph_node', {
        jobId: `job_${graphIdA}_n_export`,
        sourceFormat: 'json',
        targetFormat: 'json',
        originalFilename: 'inventory.json',
        fileSize: inputBuffer.length,
        options: {},
        graphId: graphIdA,
        graphNodeId: 'n_export',
        graphNode: testGraph.nodes.n_export,
      });
      await processNodeJob(jobA3, tsEngine, s3Storage);

      const stateA = await graphScheduler.getGraphState(graphIdA);
      expect(stateA?.status).toBe('completed');
      expect(stateA?.nodes.n_upload.status).toBe('completed');
      expect(stateA?.nodes.n_convert.status).toBe('completed');
      expect(stateA?.nodes.n_export.status).toBe('completed');

      const outputsA = await graphScheduler.getNodeOutputs(graphIdA, 'n_export');
      expect(outputsA).toHaveLength(1);
      const contentA = s3Storage.getObject(outputsA[0])!.buffer.toString('utf-8');
      const parsedA = JSON.parse(contentA);
      expect(parsedA).toEqual([
        { item: 'Widget', quantity: '42' },
        { item: 'Gadget', quantity: '99' },
      ]);

      // Run B: nativeEngine
      const graphIdB = `parity_graph_native_${Date.now()}`;
      await graphScheduler.initGraph(graphIdB, testGraph);

      const jobB1 = await queue.add('graph_node', {
        jobId: `job_${graphIdB}_n_upload`,
        sourceFormat: 'csv',
        targetFormat: 'csv',
        originalFilename: 'inventory.csv',
        fileSize: inputBuffer.length,
        options: {},
        graphId: graphIdB,
        graphNodeId: 'n_upload',
        graphNode: testGraph.nodes.n_upload,
      });
      await processNodeJob(jobB1, nativeEngine, s3Storage);

      const jobB2 = await queue.add('graph_node', {
        jobId: `job_${graphIdB}_n_convert`,
        sourceFormat: 'csv',
        targetFormat: 'json',
        originalFilename: 'inventory.csv',
        fileSize: inputBuffer.length,
        options: {},
        graphId: graphIdB,
        graphNodeId: 'n_convert',
        graphNode: testGraph.nodes.n_convert,
      });
      await processNodeJob(jobB2, nativeEngine, s3Storage);

      const jobB3 = await queue.add('graph_node', {
        jobId: `job_${graphIdB}_n_export`,
        sourceFormat: 'json',
        targetFormat: 'json',
        originalFilename: 'inventory.json',
        fileSize: inputBuffer.length,
        options: {},
        graphId: graphIdB,
        graphNodeId: 'n_export',
        graphNode: testGraph.nodes.n_export,
      });
      await processNodeJob(jobB3, nativeEngine, s3Storage);

      const stateB = await graphScheduler.getGraphState(graphIdB);
      expect(stateB?.status).toBe('completed');
      expect(stateB?.nodes.n_upload.status).toBe('completed');
      expect(stateB?.nodes.n_convert.status).toBe('completed');
      expect(stateB?.nodes.n_export.status).toBe('completed');

      const outputsB = await graphScheduler.getNodeOutputs(graphIdB, 'n_export');
      expect(outputsB).toHaveLength(outputsA.length);
      const contentB = s3Storage.getObject(outputsB[0])!.buffer.toString('utf-8');
      const parsedB = JSON.parse(contentB);
      expect(parsedB).toEqual(parsedA);
    });
  });

  describe('3. Abort Handling & Temporary File Discarding', () => {
    it('aborts immediately when signal is cancelled and cleans up temporary disk files', async () => {
      const tempOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-abort-test-'));
      const tempOutputFile = path.join(tempOutDir, 'test-produced-output.bin');
      createdTempFiles.push(tempOutputFile);
      createdTempFiles.push(tempOutDir);

      // Create an engine adapter that produces a disk file, then cancels the job before finish
      let engineCalled = false;
      const abortingEngine: ConversionEnginePort = {
        name: 'mock-aborting-engine',
        async convert(_input, _src, _tgt, options, _filename) {
          engineCalled = true;
          // Simulate producing an output file on disk
          fs.writeFileSync(tempOutputFile, Buffer.from('partial-output-content'));
          // Abort the job during conversion
          (job as any)._abortAttempt(new JobCancelledError('Job aborted during execution'));
          return {
            buffer: Buffer.from('partial-output-content'),
            size: 22,
            mimeType: 'application/octet-stream',
            filename: 'test-produced-output.bin',
            filePath: tempOutputFile,
          };
        },
      };

      const job = await queue.add('convert', {
        jobId: 'job_abort_clean_1',
        sourceFormat: 'txt',
        targetFormat: 'bin',
        originalFilename: 'input.txt',
        fileSize: 10,
        options: {},
        inputBufferBase64: Buffer.from('hello').toString('base64'),
      });

      await expect(processNodeJob(job, abortingEngine, s3Storage)).rejects.toThrow(
        /Job aborted during execution/i
      );

      expect(engineCalled).toBe(true);
      // Verify that discardConversionOutput cleaned up the temporary file on disk
      expect(fs.existsSync(tempOutputFile)).toBe(false);
    });

    it('cleans up intermediate pipeline files when a chained multi-stage task is aborted mid-pipeline', async () => {
      const tempOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-pipeline-abort-'));
      const stage1File = path.join(tempOutDir, 'stage1-output.bin');
      createdTempFiles.push(stage1File);
      createdTempFiles.push(tempOutDir);

      let stageCount = 0;
      const pipelineAbortingEngine: ConversionEnginePort = {
        name: 'mock-pipeline-abort-engine',
        async convert(_input, _src, _tgt, options, _filename) {
          stageCount++;
          if (stageCount === 1) {
            fs.writeFileSync(stage1File, Buffer.from('stage-1-intermediate-data'));
            return {
              buffer: Buffer.from('stage-1-intermediate-data'),
              size: 25,
              mimeType: 'application/octet-stream',
              filename: 'stage1-output.bin',
              filePath: stage1File,
            };
          }
          // Stage 2: abort the job
          (job as any)._abortAttempt(new JobCancelledError('Pipeline aborted at stage 2'));
          options.signal?.throwIfAborted();
          throw new Error('Should not reach here');
        },
      };

      const job = await queue.add('convert', {
        jobId: 'job_pipeline_abort_clean_2',
        sourceFormat: 'txt',
        targetFormat: 'bin',
        originalFilename: 'pipeline.txt',
        fileSize: 10,
        options: {},
        inputBufferBase64: Buffer.from('initial-data').toString('base64'),
        tasks: [
          { name: 'stage-1', operation: 'convert', targetFormat: 'json' },
          { name: 'stage-2', operation: 'convert', targetFormat: 'bin' },
        ],
      });

      await expect(processNodeJob(job, pipelineAbortingEngine, s3Storage)).rejects.toThrow(
        /Pipeline aborted at stage 2/i
      );

      expect(stageCount).toBe(2);
      // Verify intermediate file from stage 1 was cleaned up from disk on abort
      expect(fs.existsSync(stage1File)).toBe(false);
    });
  });

  describe('4. In-Memory Limits & Memory Shredding', () => {
    it('throws PayloadTooLargeForMemoryError when payload exceeds in-memory limits in tsEngine', async () => {
      // Mock memory limit to 50 bytes so we can test without allocating huge strings
      const mockLimit = 50;
      const oversizedSize = 100;
      vi.spyOn(errorsModule, 'getMaxInMemoryBytes').mockReturnValue(mockLimit);

      // Case A: Storage-backed object exceeds in-memory limit
      s3Storage.saveObject(
        'uploads/large.dat',
        Buffer.from('placeholder'),
        'application/octet-stream',
        'large.dat'
      );
      vi.spyOn(s3Storage, 'stat').mockReturnValue({
        size: oversizedSize,
        lastModified: Date.now(),
      } as any);

      const jobA = await queue.add('convert', {
        jobId: 'job_large_storage',
        sourceFormat: 'dat',
        targetFormat: 'bin',
        originalFilename: 'large.dat',
        fileSize: oversizedSize,
        storageKey: 'uploads/large.dat',
        options: {},
      });

      await expect(processNodeJob(jobA, tsEngine, s3Storage)).rejects.toThrow(
        PayloadTooLargeForMemoryError
      );

      // Case B: Base64 payload exceeds in-memory limit
      const jobB = await queue.add('convert', {
        jobId: 'job_large_base64',
        sourceFormat: 'dat',
        targetFormat: 'bin',
        originalFilename: 'large.dat',
        fileSize: oversizedSize,
        inputBufferBase64: Buffer.alloc(oversizedSize).toString('base64'),
        options: {},
      });

      await expect(processNodeJob(jobB, tsEngine, s3Storage)).rejects.toThrow(
        PayloadTooLargeForMemoryError
      );
    });

    it('securely shreds input Buffer after processing completes', async () => {
      const shredSpy = vi.spyOn(memoryShredder, 'secureShredBuffer');
      const secret = 'sensitive_credit_card_data_12345';
      const inputBuffer = Buffer.from(secret, 'utf-8');

      const job = await queue.add('convert', {
        jobId: 'job_shred_test',
        sourceFormat: 'csv',
        targetFormat: 'json',
        fileSize: inputBuffer.length,
        originalFilename: 'sensitive.csv',
        inputBufferBase64: inputBuffer.toString('base64'),
        options: {},
      });

      const res = await processNodeJob(job, tsEngine, s3Storage);
      expect(res.status).toBe('completed');

      // Verify that secureShredBuffer was called to clear sensitive memory
      expect(shredSpy).toHaveBeenCalledTimes(1);
      const passedBuffer = shredSpy.mock.calls[0][0];
      expect(Buffer.isBuffer(passedBuffer)).toBe(true);
      // Shredded buffer should no longer contain plaintext secret
      expect((passedBuffer as Buffer).toString('utf-8')).not.toBe(secret);
    });

    it('cleans up uploaded storage key on final attempt failure', async () => {
      const storageKey = 'uploads/failing_upload.csv';
      s3Storage.saveObject(storageKey, Buffer.from('corrupt_data'), 'text/csv', 'failing_upload.csv');
      expect(s3Storage.getObject(storageKey)).toBeDefined();

      const failingEngine: ConversionEnginePort = {
        name: 'mock-failing-engine',
        async convert() {
          throw new Error('Fatal conversion failure in underlying parser');
        },
      };

      const job = await queue.add('convert', {
        jobId: 'job_fail_cleanup',
        sourceFormat: 'csv',
        targetFormat: 'json',
        originalFilename: 'failing_upload.csv',
        fileSize: 12,
        storageKey,
        options: {},
      });

      // Mark as final attempt
      job.opts.attempts = 1;
      job.attemptsMade = 1;

      await expect(processNodeJob(job, failingEngine, s3Storage)).rejects.toThrow(
        /Fatal conversion failure/
      );

      // Verify uploaded input was removed from storage upon final attempt failure
      expect(s3Storage.getObject(storageKey)).toBeUndefined();
    });
  });
});
