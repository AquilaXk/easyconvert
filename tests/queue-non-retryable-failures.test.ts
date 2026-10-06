import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { Queue, Worker } from '../src/lib/queue/bullmq-engine';
import { conversionQueue } from '../src/lib/queue/conversion-queue';
import { InputPixelLimitError } from '../src/lib/conversions/image-input-limits';
import {
  CadGeometryUnavailableError,
  ComplexScriptRequiresNativeEngineError,
  EngineUnavailableError,
  OcrEngineUnavailableError,
  OcrLanguageUnavailableError,
  RawEngineRequiredError,
  UnsupportedOptionError,
} from '../src/lib/types';
import type { ConversionJobData } from '../src/lib/types';
import { GET as getV1JobRoute } from '../src/app/api/v1/jobs/[id]/route';
import { GET as getQueueJobRoute } from '../src/app/api/queue/jobs/[id]/route';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';

const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_BAD_REQUEST = 400;
const HTTP_SERVICE_UNAVAILABLE = 503;
const RETRY_DELAY_MS = 20;
const ATTEMPTS = 3;
const BASE_URL = 'http://localhost:3000';
const OVER_LIMIT_SIDE = 15_000;
const INPUT_LIMIT = 100_000_000;

interface RunResult {
  calls: number;
  job: Awaited<ReturnType<Queue<{ n: number }, string>['add']>>;
}

/** Runs one job that always throws `error` and waits until the queue gives up on it. */
async function runFailingJob(name: string, error: Error): Promise<RunResult> {
  const queue = new Queue<{ n: number }, string>(name);
  let calls = 0;
  const worker = new Worker(
    queue,
    async () => {
      calls++;
      throw error;
    },
    { concurrency: 1 }
  );
  const failed = new Promise<void>((resolve) => worker.on('failed', () => resolve()));
  const job = await queue.add('convert', { n: 1 }, { attempts: ATTEMPTS, backoff: { type: 'fixed', delay: RETRY_DELAY_MS } });
  await failed;
  await worker.close();
  await queue.close();
  return { calls, job };
}

describe('jobs that fail on their input are not retried', () => {
  it('runs a job refused for its pixel count once and records the typed 413', async () => {
    const { calls, job } = await runFailingJob('nonretry-pixels', new InputPixelLimitError(INPUT_LIMIT, OVER_LIMIT_SIDE, OVER_LIMIT_SIDE));
    expect(calls).toBe(1);
    expect(job.state).toBe('failed');
    expect(job.attemptsMade).toBe(1);
    expect(job.failedStatus).toBe(HTTP_PAYLOAD_TOO_LARGE);
    expect(job.failedCode).toBe('InputPixelLimitError');
    expect(job.failedReason).toContain(`over the input limit of ${INPUT_LIMIT} pixels`);
  });

  it('does not retry any other typed input rejection and records its 400', async () => {
    const { calls, job } = await runFailingJob('nonretry-option', new UnsupportedOptionError('Unsupported width "x"'));
    expect(calls).toBe(1);
    expect(job.attemptsMade).toBe(1);
    expect(job.failedStatus).toBe(HTTP_BAD_REQUEST);
    expect(job.failedCode).toBe('UnsupportedOptionError');
  });

  it('still retries a missing engine, which another worker may have', async () => {
    const { calls, job } = await runFailingJob('retry-engine', new EngineUnavailableError('soffice'));
    expect(calls).toBe(ATTEMPTS);
    expect(job.attemptsMade).toBe(ATTEMPTS);
    expect(job.failedStatus).toBe(HTTP_SERVICE_UNAVAILABLE);
    expect(job.failedCode).toBe('EngineUnavailableError');
  });

  it.each([
    ['OcrEngineUnavailableError', new OcrEngineUnavailableError('tesseract missing')],
    ['OcrLanguageUnavailableError', new OcrLanguageUnavailableError('traineddata missing')],
    ['RawEngineRequiredError', new RawEngineRequiredError('native RAW decoder required')],
    ['CadGeometryUnavailableError', new CadGeometryUnavailableError('CAD kernel missing')],
    ['ComplexScriptRequiresNativeEngineError', new ComplexScriptRequiresNativeEngineError()],
  ])('retries %s, since a mixed worker pool may have the engine', async (name, error) => {
    const { calls, job } = await runFailingJob(`retry-${name}`, error);
    expect(calls).toBe(ATTEMPTS);
    expect(job.attemptsMade).toBe(ATTEMPTS);
    expect(job.failedCode).toBe(name);
  });

  it('still retries an untyped failure, which says nothing about the input', async () => {
    const { calls, job } = await runFailingJob('retry-untyped', new Error('socket hang up'));
    expect(calls).toBe(ATTEMPTS);
    expect(job.failedStatus).toBeUndefined();
    expect(job.failedCode).toBeUndefined();
  });
});

describe('job status responses carry the typed failure', () => {
  async function failedJob(): Promise<{ jobId: string; headers: Record<string, string> }> {
    const user = await userStore.createUser({
      name: 'Failure Reader',
      email: `failure_reader_${Date.now()}_${Math.random().toString(36).slice(2)}@queue.test`,
      tier: 'pro',
    });
    const key = await redisKeyStore.generateApiKey(user.id, 'Failure key', { scopes: ['convert:read', 'convert:write'] });
    const data: ConversionJobData = {
      jobId: '',
      originalFilename: 'bomb.png',
      sourceFormat: 'png',
      targetFormat: 'jpg',
      fileSize: 123,
      options: {},
      inputBufferBase64: Buffer.from('x').toString('base64'),
      userId: user.id,
    };
    const job = await conversionQueue.add('convert', data);
    const error = new InputPixelLimitError(INPUT_LIMIT, OVER_LIMIT_SIDE, OVER_LIMIT_SIDE);
    job.state = 'failed';
    job.failedReason = error.message;
    job.failedCode = error.name;
    job.failedStatus = error.status;
    return { jobId: job.id, headers: { Authorization: `Bearer ${key.secretKey}` } };
  }

  it('GET /api/v1/jobs/{id} exposes failedStatus and failedCode next to failedReason', async () => {
    const { jobId, headers } = await failedJob();
    const res = await getV1JobRoute(new NextRequest(`${BASE_URL}/api/v1/jobs/${jobId}`, { headers }), { params: { id: jobId } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'failed', failedStatus: HTTP_PAYLOAD_TOO_LARGE, failedCode: 'InputPixelLimitError' });
    expect(body.failedReason).toContain(`${INPUT_LIMIT} pixels`);
  });

  it('GET /api/queue/jobs/{id} exposes the same fields', async () => {
    const { jobId, headers } = await failedJob();
    const res = await getQueueJobRoute(new NextRequest(`${BASE_URL}/api/queue/jobs/${jobId}`, { headers }), { params: { id: jobId } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ failedStatus: HTTP_PAYLOAD_TOO_LARGE, failedCode: 'InputPixelLimitError' });
  });
});
