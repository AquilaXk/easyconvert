import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as convertPost } from '../src/app/api/convert/route';
import { POST as batchPost } from '../src/app/api/convert/batch/route';
import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import { GET as getV1JobRoute } from '../src/app/api/v1/jobs/[id]/route';
import { Worker } from '../src/lib/queue/bullmq-engine';
import { conversionQueue, processConversionJob } from '../src/lib/queue/conversion-queue';
import { classifyJobFailure } from '../src/lib/queue/job-failure';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { EncryptedOfficeDocumentError } from '../src/lib/types';
import type { ConversionJobData } from '../src/lib/types';
import { buildWordBinary } from './helpers/word-binary-builder';

/**
 * An encrypted or DRM-protected document is intact, its content is just not readable: the convert routes, the batch
 * route and the failed job all answer 422 with the typed error's own status, where a malformed input answers 400.
 * The input is a real Word 97-2003 file with its encryption flag set, converted by the production dispatcher.
 */

const HTTP_UNPROCESSABLE = 422;
const HTTP_BAD_REQUEST = 400;
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 20;
const BASE_URL = 'http://localhost:3000';

const ENCRYPTED_DOC = buildWordBinary({ pieces: [{ text: 'Secret paragraph\r', compressed: true }], encrypted: true });
const PLAIN_DOC = buildWordBinary({ pieces: [{ text: 'Open paragraph\r', compressed: true }] });
const MALFORMED_DOC = Buffer.concat([ENCRYPTED_DOC.subarray(0, 512), Buffer.alloc(64)]);

function form(file: Buffer, name: string, fieldName = 'file'): FormData {
  const data = new FormData();
  data.append(fieldName, new Blob([new Uint8Array(file)]), name);
  data.append('targetFormat', 'txt');
  return data;
}

async function apiKeyHeaders(): Promise<Record<string, string>> {
  const user = await userStore.createUser({
    name: 'Encrypted Route Tester',
    email: `encrypted_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
    tier: 'pro',
  });
  const key = await redisKeyStore.generateApiKey(user.id, 'Encrypted key', { scopes: ['convert:write', 'convert:read'] });
  return { Authorization: `Bearer ${key.secretKey}` };
}

describe('an encrypted document answers 422 on the convert routes', () => {
  it('POST /api/convert answers 422 with the reason, and 400 for a malformed file', async () => {
    const res = await convertPost(new NextRequest(`${BASE_URL}/api/convert`, { method: 'POST', body: form(ENCRYPTED_DOC, 'secret.doc') }));
    expect(res.status).toBe(HTTP_UNPROCESSABLE);
    const problem = await res.json();
    expect(problem.title).toBe('Unprocessable Entity');
    expect(problem.detail).toMatch(/encrypted|password/i);

    const malformed = await convertPost(new NextRequest(`${BASE_URL}/api/convert`, { method: 'POST', body: form(MALFORMED_DOC, 'broken.doc') }));
    expect(malformed.status).toBe(HTTP_BAD_REQUEST);
  });

  it('POST /api/v1/convert answers a 422 problem document, and converts the same file unencrypted', async () => {
    const headers = await apiKeyHeaders();
    const res = await v1ConvertPost(new NextRequest(`${BASE_URL}/api/v1/convert`, { method: 'POST', headers, body: form(ENCRYPTED_DOC, 'secret.doc') }));
    expect(res.status).toBe(HTTP_UNPROCESSABLE);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const problem = await res.json();
    expect(problem).toMatchObject({ status: HTTP_UNPROCESSABLE, title: 'Unprocessable Entity' });
    expect(problem.detail).toMatch(/encrypted|password/i);

    const open = await v1ConvertPost(new NextRequest(`${BASE_URL}/api/v1/convert`, { method: 'POST', headers, body: form(PLAIN_DOC, 'open.doc') }));
    expect(open.status).toBe(200);
  });

  it('POST /api/convert/batch answers 422 for an encrypted file', async () => {
    const body = form(ENCRYPTED_DOC, 'secret.doc', 'files');
    body.append('targetFormats', JSON.stringify({ default: 'txt' }));
    const res = await batchPost(new NextRequest(`${BASE_URL}/api/convert/batch`, { method: 'POST', body }));
    expect(res.status).toBe(HTTP_UNPROCESSABLE);
    expect((await res.json()).detail).toMatch(/encrypted|password/i);
  });
});

describe('an encrypted document fails a job once, with status 422', () => {
  it('classifies the typed error as a non-retryable 422', () => {
    expect(classifyJobFailure(new EncryptedOfficeDocumentError('locked'))).toEqual({
      code: 'EncryptedOfficeDocumentError',
      status: HTTP_UNPROCESSABLE,
      retryable: false,
    });
  });

  it('runs a worker end to end and the job status route reports failedStatus 422', async () => {
    const user = await userStore.createUser({
      name: 'Encrypted Job Tester',
      email: `encrypted_job_${Date.now()}_${Math.random().toString(36).slice(2)}@queue.test`,
      tier: 'pro',
    });
    const key = await redisKeyStore.generateApiKey(user.id, 'Encrypted job key', { scopes: ['convert:read', 'convert:write'] });
    const readHeaders = { Authorization: `Bearer ${key.secretKey}` };
    const worker = new Worker(conversionQueue, processConversionJob, { concurrency: 1 });
    const failed = new Promise<void>((resolve) => worker.on('failed', () => resolve()));
    const data: ConversionJobData = {
      jobId: '',
      originalFilename: 'secret.doc',
      sourceFormat: 'doc',
      targetFormat: 'txt',
      fileSize: ENCRYPTED_DOC.length,
      options: {},
      inputBufferBase64: ENCRYPTED_DOC.toString('base64'),
      userId: user.id,
    };
    const job = await conversionQueue.add('convert', data, { attempts: ATTEMPTS, backoff: { type: 'fixed', delay: RETRY_DELAY_MS } });
    await failed;
    await worker.close();

    const res = await getV1JobRoute(new NextRequest(`${BASE_URL}/api/v1/jobs/${job.id}`, { headers: readHeaders }), { params: { id: job.id } });
    const body = await res.json();
    expect(body).toMatchObject({ status: 'failed', attemptsMade: 1, failedStatus: HTTP_UNPROCESSABLE, failedCode: 'EncryptedOfficeDocumentError' });
  });
});
