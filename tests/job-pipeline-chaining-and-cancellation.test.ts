import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { conversionQueue, processConversionJob } from '../src/lib/queue/conversion-queue';
import { Queue } from '../src/lib/queue/bullmq-engine';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { POST as createJobHandler } from '../src/app/api/v1/jobs/route';
import { GET as getJobHandler, DELETE as cancelJobHandler } from '../src/app/api/v1/jobs/[id]/route';
import { GET as getOpenApiHandler } from '../src/app/api/v1/openapi/route';
import { GET as getOpenApiJsonHandler } from '../src/app/api/v1/openapi.json/route';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';
import type { ApiKeyScope } from '../src/lib/api-keys/types';
import { s3Storage } from '../src/lib/storage/s3-storage';

async function createTestUserWithKey(opts: {
  userId?: string;
  scopes?: ApiKeyScope[];
  tier?: 'free' | 'pro' | 'enterprise';
} = {}) {
  const userId = opts.userId || `user_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const user = await redisUserStore.createUser({
    id: userId,
    email: `${userId}@example.com`,
    name: `Test User ${userId}`,
    tier: opts.tier || 'pro',
    provider: 'email',
    passwordHash: 'dummy_hash',
    salt: 'dummy_salt',
  });
  const key = await redisKeyStore.generateApiKey(user.id, `Key for ${user.id}`, {
    scopes: opts.scopes || ['convert:write', 'convert:read'],
  });
  return { user, key };
}

describe('Phase 3: Job Pipeline Chaining, Cancellation, and API DX', () => {
  beforeEach(() => {
    redisKeyStore.resetStore();
    redisUserStore.resetStore();
    vi.restoreAllMocks();
  });

  describe('1. Engine-Level Job Cancellation (Queue & Adapter)', () => {
    it('cancels a waiting job and transitions state to failed with reason', async () => {
      const queue = new Queue<ConversionJobData, ConversionJobResult>('test-cancel-queue');
      const job = await queue.add('convert', {
        jobId: 'job_wait_123',
        sourceFormat: 'csv',
        targetFormat: 'json',
        fileSize: 100,
        options: {},
        originalFilename: 'data.csv',
      });

      expect(job.state).toBe('waiting');

      const cancelled = await queue.cancelJob(job.id, 'User requested cancellation');
      expect(cancelled).toBe(true);

      const updated = await queue.getJob(job.id);
      expect(updated).toBeDefined();
      expect(updated?.state).toBe('failed');
      expect(updated?.failedReason).toBe('User requested cancellation');
      expect(updated?.finishedOn).toBeDefined();
      expect(updated?.logs.some((l) => l.includes('Job cancelled: User requested cancellation'))).toBe(true);

      // Subsequent cancellation attempt should return false
      const cancelAgain = await queue.cancelJob(job.id);
      expect(cancelAgain).toBe(false);
    });

    it('cancels a delayed job and clears active delay timer', async () => {
      const queue = new Queue<ConversionJobData, ConversionJobResult>('test-delay-cancel-queue');
      const job = await queue.add(
        'convert',
        {
          jobId: 'job_delay_123',
          sourceFormat: 'csv',
          targetFormat: 'json',
          fileSize: 100,
          options: {},
          originalFilename: 'data.csv',
        },
        { delay: 60000 }
      );

      expect(job.state).toBe('delayed');

      const cancelled = await queue.cancelJob(job.id, 'Abort delayed task');
      expect(cancelled).toBe(true);

      const updated = await queue.getJob(job.id);
      expect(updated?.state).toBe('failed');
      expect(updated?.failedReason).toBe('Abort delayed task');
    });

    it('fails closed when attempting to cancel non-existent or completed jobs', async () => {
      const queue = new Queue<ConversionJobData, ConversionJobResult>('test-edge-queue');
      const job = await queue.add('convert', {
        jobId: 'job_completed_123',
        sourceFormat: 'csv',
        targetFormat: 'json',
        fileSize: 50,
        options: {},
      });

      job.state = 'completed';
      job.finishedOn = Date.now();

      const cancelCompleted = await queue.cancelJob(job.id);
      expect(cancelCompleted).toBe(false);

      const cancelNonExistent = await queue.cancelJob('non_existent_id');
      expect(cancelNonExistent).toBe(false);
    });
  });

  describe('2. DELETE /api/v1/jobs/[id] API Endpoint & Quota Refund', () => {
    it('rejects cancellation when unauthorized or lacking write scope', async () => {
      // 1. No auth
      const noAuthReq = new NextRequest('https://easyconvert.app/api/v1/jobs/job_123', {
        method: 'DELETE',
      });
      const noAuthRes = await cancelJobHandler(noAuthReq, { params: { id: 'job_123' } });
      expect(noAuthRes.status).toBe(401);

      // 2. Read-only key (scope: convert:read)
      const { key: readKey } = await createTestUserWithKey({
        userId: 'user_reader',
        scopes: ['convert:read'],
      });
      const readReq = new NextRequest('https://easyconvert.app/api/v1/jobs/job_123', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${readKey.secretKey}` },
      });
      const readRes = await cancelJobHandler(readReq, { params: { id: 'job_123' } });
      expect(readRes.status).toBe(403);
    });

    it('returns 404 for non-existent job ID', async () => {
      const { key } = await createTestUserWithKey({
        userId: 'user_writer',
        scopes: ['convert:write'],
      });
      const req = new NextRequest('https://easyconvert.app/api/v1/jobs/job_nonexistent', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${key.secretKey}` },
      });
      const res = await cancelJobHandler(req, { params: { id: 'job_nonexistent' } });
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.detail).toContain('not found');
    });

    it('enforces tenant boundary (user cannot cancel other tenant job)', async () => {
      const { key: userAKey } = await createTestUserWithKey({
        userId: 'tenant_a',
        scopes: ['convert:write'],
      });
      const { key: userBKey } = await createTestUserWithKey({
        userId: 'tenant_b',
        scopes: ['convert:write'],
      });

      const job = await conversionQueue.add('convert', {
        jobId: 'job_tenant_a_1',
        userId: 'tenant_a',
        sourceFormat: 'csv',
        targetFormat: 'json',
        fileSize: 100,
        options: {},
      });

      const crossTenantReq = new NextRequest(`https://easyconvert.app/api/v1/jobs/${job.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${userBKey.secretKey}` },
      });
      const res = await cancelJobHandler(crossTenantReq, { params: { id: job.id } });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.detail).toContain('Access denied');
    });

    it('cancels job, refunds reserved quota unit, and returns 200', async () => {
      const { user, key } = await createTestUserWithKey({
        userId: 'user_client',
        scopes: ['convert:write', 'convert:read'],
      });
      const reservation = await redisKeyStore.reserveQuota(user.id, 1);
      expect(reservation.allowed).toBe(true);
      expect(reservation.reservationId).toBeDefined();

      const usageBefore = await redisKeyStore.getQuotaUsage(user.id);
      expect(usageBefore.usedToday).toBe(1);

      const job = await conversionQueue.add('convert', {
        jobId: 'job_cancel_refund_test',
        userId: user.id,
        reservationId: reservation.reservationId,
        sourceFormat: 'csv',
        targetFormat: 'json',
        fileSize: 100,
        options: {},
      });

      const cancelReq = new NextRequest(`https://easyconvert.app/api/v1/jobs/${job.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${key.secretKey}` },
      });
      const res = await cancelJobHandler(cancelReq, { params: { id: job.id } });
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.cancelled).toBe(true);
      expect(json.status).toBe('failed');

      // Check quota was refunded
      const usageAfter = await redisKeyStore.getQuotaUsage(user.id);
      expect(usageAfter.usedToday).toBe(0);
    });

    it('returns 409 Conflict if the job is already completed', async () => {
      const { user, key } = await createTestUserWithKey({
        userId: 'user_client',
        scopes: ['convert:write'],
      });
      const job = await conversionQueue.add('convert', {
        jobId: 'job_already_done',
        userId: user.id,
        sourceFormat: 'csv',
        targetFormat: 'json',
        fileSize: 100,
        options: {},
      });

      job.state = 'completed';
      job.finishedOn = Date.now();

      const req = new NextRequest(`https://easyconvert.app/api/v1/jobs/${job.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${key.secretKey}` },
      });
      const res = await cancelJobHandler(req, { params: { id: job.id } });
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.detail).toContain('already completed');
    });
  });

  describe('3. Multi-Stage Pipeline Task Chaining', () => {
    it('executes sequential tasks and passes intermediate buffers between stages', async () => {
      const csvData = 'name,score\nAlice,100\nBob,95\n';
      const inputBuffer = Buffer.from(csvData, 'utf-8');

      const jobData: ConversionJobData = {
        jobId: 'job_chain_1',
        sourceFormat: 'csv',
        targetFormat: 'yaml',
        originalFilename: 'scores.csv',
        fileSize: inputBuffer.length,
        options: {},
        inputBufferBase64: inputBuffer.toString('base64'),
        tasks: [
          {
            name: 'csv-to-json-stage',
            operation: 'convert',
            targetFormat: 'json',
          },
          {
            name: 'json-to-yaml-stage',
            operation: 'convert',
            targetFormat: 'yaml',
          },
        ],
      };

      const job = await conversionQueue.add('convert', jobData);

      const result = await processConversionJob(job);
      expect(result.status).toBe('completed');
      expect(result.filename).toMatch(/\.yaml$/i);
      expect(result.mimeType).toContain('yaml');
      expect(result.size).toBeGreaterThan(0);

      // Verify the persisted storage object
      const storedObj = s3Storage.getObject(result.resultKey);
      expect(storedObj).toBeDefined();
      const outputText = storedObj!.buffer.toString('utf-8');
      expect(outputText).toContain('Alice');
      expect(outputText).toContain('100');
      expect(outputText).toContain('Bob');
      expect(outputText).toContain('95');
    });

    it('records task progress sequentially during multi-stage execution', async () => {
      const csvData = 'id,value\n1,alpha\n2,beta\n';
      const inputBuffer = Buffer.from(csvData, 'utf-8');

      const jobData: ConversionJobData = {
        jobId: 'job_chain_progress',
        sourceFormat: 'csv',
        targetFormat: 'yaml',
        originalFilename: 'data.csv',
        fileSize: inputBuffer.length,
        options: {},
        inputBufferBase64: inputBuffer.toString('base64'),
        tasks: [
          { name: 'step1', operation: 'convert', targetFormat: 'json' },
          { name: 'step2', operation: 'convert', targetFormat: 'yaml' },
        ],
      };

      const job = await conversionQueue.add('convert', jobData);
      const progressSpy = vi.spyOn(job, 'updateProgress');

      await processConversionJob(job);

      // Check that progress was updated for intermediate tasks, completion, and finalization
      expect(progressSpy).toHaveBeenCalled();
      const progressCalls = progressSpy.mock.calls.map((c) => c[0]);
      expect(progressCalls.some((p) => p >= 30 && p <= 50)).toBe(true);
      expect(progressCalls.some((p) => p >= 70 && p <= 85)).toBe(true);
      expect(progressCalls).toContain(100);
    });
  });

  describe('4. Asynchronous Job Creation with Pipeline Tasks', () => {
    it('accepts tasks array in POST /api/v1/jobs JSON payload and defaults targetFormat', async () => {
      const { key } = await createTestUserWithKey({
        userId: 'user_pipeline',
        scopes: ['convert:write', 'convert:read'],
      });
      const csvContent = 'fruit,qty\napple,5\nbanana,12\n';

      const req = new NextRequest('https://easyconvert.app/api/v1/jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key.secretKey}`,
        },
        body: JSON.stringify({
          filename: 'inventory.csv',
          inputBufferBase64: Buffer.from(csvContent).toString('base64'),
          tasks: [
            { name: 'to-json', operation: 'convert', targetFormat: 'json' },
            { name: 'to-yaml', operation: 'convert', targetFormat: 'yaml' },
          ],
        }),
      });

      const res = await createJobHandler(req);
      expect(res.status).toBe(202);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.jobId).toBeDefined();

      // Retrieve job via GET /api/v1/jobs/[id]
      const getReq = new NextRequest(`https://easyconvert.app/api/v1/jobs/${json.jobId}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${key.secretKey}` },
      });
      const getRes = await getJobHandler(getReq, { params: { id: json.jobId } });
      expect(getRes.status).toBe(200);
      const getJson = await getRes.json();
      expect(getJson.targetFormat).toBe('yaml');
      expect(getJson.tasks).toHaveLength(2);
      expect(getJson.tasks[0].targetFormat).toBe('json');
      expect(getJson.tasks[1].targetFormat).toBe('yaml');
    });

    it('accepts stringified tasks in multipart/form-data POST /api/v1/jobs', async () => {
      const { key } = await createTestUserWithKey({
        userId: 'user_form',
        scopes: ['convert:write', 'convert:read'],
      });
      const formData = new FormData();
      formData.append('file', new Blob(['name,age\nAlice,30\n'], { type: 'text/csv' }), 'people.csv');
      formData.append(
        'tasks',
        JSON.stringify([
          { name: 't1', operation: 'convert', targetFormat: 'json' },
          { name: 't2', operation: 'convert', targetFormat: 'yaml' },
        ])
      );

      const req = new NextRequest('https://easyconvert.app/api/v1/jobs', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key.secretKey}` },
        body: formData,
      });

      const res = await createJobHandler(req);
      expect(res.status).toBe(202);
      const json = await res.json();
      expect(json.jobId).toBeDefined();

      const queuedJob = await conversionQueue.getJob(json.jobId);
      expect(queuedJob).toBeDefined();
      expect(queuedJob?.data.tasks).toHaveLength(2);
      expect(queuedJob?.data.targetFormat).toBe('yaml');
    });
  });

  describe('5. OpenAPI 3.1 Specification Parity', () => {
    it('exposes DELETE /api/v1/jobs/{id} and PipelineTask schema in /api/v1/openapi', async () => {
      const res = await getOpenApiHandler();
      expect(res.status).toBe(200);
      const spec = await res.json();

      expect(spec.openapi).toBe('3.1.0');
      expect(spec.paths['/api/v1/jobs/{id}']).toBeDefined();
      expect(spec.paths['/api/v1/jobs/{id}'].delete).toBeDefined();
      expect(spec.paths['/api/v1/jobs/{id}'].delete.operationId).toBe('cancelJobV1');

      expect(spec.paths['/api/v1/jobs'].post.requestBody.content['application/json'].schema.properties.tasks).toBeDefined();
      expect(spec.components.schemas.PipelineTask).toBeDefined();
      expect(spec.components.schemas.JobDetails.properties.tasks).toBeDefined();
    });

    it('returns consistent OpenAPI 3.1 specification via /api/v1/openapi.json', async () => {
      const res = await getOpenApiJsonHandler();
      expect(res.status).toBe(200);
      const spec = await res.json();
      expect(spec.paths['/api/v1/jobs/{id}'].delete).toBeDefined();
    });
  });
});
