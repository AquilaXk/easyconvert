import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import { GET as getV1JobRoute } from '../src/app/api/v1/jobs/[id]/route';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { Worker } from '../src/lib/queue/bullmq-engine';
import { conversionQueue, processConversionJob } from '../src/lib/queue/conversion-queue';
import { graphScheduler } from '../src/lib/queue/graph';
import { s3Storage } from '../src/lib/storage/s3-storage';
import type { ConversionJobData } from '../src/lib/types';
import { AES_256, RC4_128, pdfinfoPages, plainPdf, qpdfEncrypt, pdftotext } from './helpers/encrypted-pdf-fixtures';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * #571 at HTTP level. The sync convert route answers 422 for an encrypted PDF whatever the target, and a watermark or
 * merge node of a queued graph fails once, as a non-retryable 422 that the job status route reports as `failedStatus`.
 */

const HTTP_UNPROCESSABLE = 422;
const BASE_URL = 'http://localhost:3000';
const ARTIFACT_TTL_MS = 60 * 60 * 1000;
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 20;
const USER_PASSWORD = 'user-secret-1';
const OWNER_PASSWORD = 'owner-secret-1';

const toolsMissing = skipWithoutTools('qpdf', 'pdftotext');

let counter = 0;

async function apiKeyHeaders(): Promise<{ headers: Record<string, string>; userId: string }> {
  counter += 1;
  const user = await userStore.createUser({
    name: 'Encrypted Pdf Tester',
    email: `encrypted_pdf_${Date.now()}_${counter}@easyconvert.local`,
    tier: 'pro',
  });
  const key = await redisKeyStore.generateApiKey(user.id, 'Encrypted pdf key', { scopes: ['convert:write', 'convert:read'] });
  return { headers: { Authorization: `Bearer ${key.secretKey}` }, userId: user.id };
}

function convertForm(file: Buffer, target: string, options?: Record<string, unknown>): FormData {
  const data = new FormData();
  data.append('file', new Blob([new Uint8Array(file)]), 'locked.pdf');
  data.append('targetFormat', target);
  if (options) data.append('options', JSON.stringify(options));
  return data;
}

async function postConvert(headers: Record<string, string>, body: FormData): Promise<Response> {
  return v1ConvertPost(new NextRequest(`${BASE_URL}/api/v1/convert`, { method: 'POST', headers, body }));
}

describe.skipIf(toolsMissing)('POST /api/v1/convert with an encrypted PDF', () => {
  for (const variant of [AES_256, RC4_128]) {
    for (const target of ['txt', 'md', 'html', 'docx']) {
      it(`${variant.name} to ${target} without a password answers a 422 problem document`, async () => {
        const { headers } = await apiKeyHeaders();
        const pdf = qpdfEncrypt(await plainPdf(['Locked body']), { variant, userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD });
        const res = await postConvert(headers, convertForm(pdf, target));
        expect(res.status).toBe(HTTP_UNPROCESSABLE);
        expect(res.headers.get('content-type')).toContain('application/problem+json');
        expect((await res.json()).detail).toMatch(/password/i);
      });
    }
  }

  it('answers 422 for a wrong password and converts with the right one', async () => {
    const { headers } = await apiKeyHeaders();
    const pdf = qpdfEncrypt(await plainPdf(['Locked body']), { variant: AES_256, userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD });

    const wrong = await postConvert(headers, convertForm(pdf, 'txt', { password: 'not-the-password' }));
    expect(wrong.status).toBe(HTTP_UNPROCESSABLE);
    const wrongBody = JSON.stringify(await wrong.json());
    expect(wrongBody).not.toContain('not-the-password');

    const right = await postConvert(headers, convertForm(pdf, 'txt', { password: USER_PASSWORD }));
    expect(right.status).toBe(200);
    const { dataUri } = (await right.json()) as { dataUri: string };
    expect(Buffer.from(dataUri.split(',')[1], 'base64').toString('utf-8')).toContain('Locked body');
  });

  it('answers 422 for a watermarked pdf to pdf request on an encrypted input', async () => {
    const { headers } = await apiKeyHeaders();
    const pdf = qpdfEncrypt(await plainPdf(), { variant: AES_256, userPassword: '', ownerPassword: OWNER_PASSWORD, modify: 'none' });
    const res = await postConvert(headers, convertForm(pdf, 'pdf', { watermark: { text: 'MARK' } }));
    expect(res.status).toBe(HTTP_UNPROCESSABLE);
  });
});

describe.skipIf(toolsMissing)('a queued watermark or merge node on an encrypted PDF', () => {
  function seed(name: string, buffer: Buffer): string {
    counter += 1;
    const key = `tests/pdf-encryption-routes/${Date.now()}_${counter}_${name}`;
    s3Storage.saveObject(key, buffer, 'application/pdf', name, ARTIFACT_TTL_MS);
    return key;
  }

  async function failedJob(graphNode: Record<string, unknown>, inputArtifacts: string[]): Promise<Record<string, unknown>> {
    const { headers, userId } = await apiKeyHeaders();
    counter += 1;
    const graphId = `g_enc571_${Date.now()}_${counter}`;
    vi.spyOn(graphScheduler, 'onNodeFailed').mockResolvedValue(undefined as never);
    const worker = new Worker(conversionQueue, processConversionJob, { concurrency: 1 });
    const failed = new Promise<void>((resolve) => worker.on('failed', () => resolve()));
    const data: ConversionJobData = {
      jobId: `${graphId}:n1`,
      originalFilename: 'locked.pdf',
      sourceFormat: 'bin',
      targetFormat: 'pdf',
      fileSize: 0,
      options: {},
      userId,
      graphId,
      graphNodeId: 'n1',
      graphNode: graphNode as unknown as ConversionJobData['graphNode'],
      inputArtifacts,
    };
    const job = await conversionQueue.add('graph-node', data, {
      jobId: `${graphId}:n1`,
      attempts: ATTEMPTS,
      backoff: { type: 'fixed', delay: RETRY_DELAY_MS },
    });
    await failed;
    await worker.close();
    vi.restoreAllMocks();
    const res = await getV1JobRoute(new NextRequest(`${BASE_URL}/api/v1/jobs/${job.id}`, { headers }), { params: { id: job.id } });
    return res.json();
  }

  it('fails a pdf.watermark node once with failedStatus 422 and PdfPasswordRequiredError', async () => {
    const key = seed('locked.pdf', qpdfEncrypt(await plainPdf(), { variant: AES_256, userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD }));
    const body = await failedJob({ op: 'pdf.watermark', options: { watermark: { text: 'MARK' } } }, [key]);
    expect(body).toMatchObject({ status: 'failed', attemptsMade: 1, failedStatus: HTTP_UNPROCESSABLE, failedCode: 'PdfPasswordRequiredError' });
  });

  it('fails a pdf.watermark node on a modify-restricted file with an empty user password as 422 as well', async () => {
    const key = seed('restricted.pdf', qpdfEncrypt(await plainPdf(), { variant: RC4_128, userPassword: '', ownerPassword: OWNER_PASSWORD, modify: 'none' }));
    const body = await failedJob({ op: 'pdf.watermark', options: { watermark: { text: 'MARK' } } }, [key]);
    expect(body).toMatchObject({ status: 'failed', failedStatus: HTTP_UNPROCESSABLE });
  });

  it('fails a merge node with an encrypted input once with failedStatus 422', async () => {
    const encrypted = seed('locked.pdf', qpdfEncrypt(await plainPdf(['Locked']), { variant: RC4_128, userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD }));
    const open = seed('open.pdf', await plainPdf(['Open']));
    const body = await failedJob({ op: 'merge', targetFormat: 'pdf' }, [open, encrypted]);
    expect(body).toMatchObject({ status: 'failed', attemptsMade: 1, failedStatus: HTTP_UNPROCESSABLE, failedCode: 'PdfPasswordRequiredError' });
  });

  it('still merges two unencrypted PDFs through the same worker path', async () => {
    const first = seed('a.pdf', await plainPdf(['Alpha body']));
    const second = seed('b.pdf', await plainPdf(['Beta body']));
    const { processGraphNodeJob } = await import('../src/lib/queue/graph/node-executor');
    counter += 1;
    const graphId = `g_enc571_ok_${Date.now()}_${counter}`;
    const job = {
      id: `${graphId}:n1`,
      data: {
        jobId: `${graphId}:n1`,
        sourceFormat: 'bin',
        targetFormat: 'pdf',
        fileSize: 0,
        options: {},
        graphId,
        graphNodeId: 'n1',
        graphNode: { op: 'merge', targetFormat: 'pdf' },
        inputArtifacts: [first, second],
      },
      opts: { attempts: 1 },
      attemptsMade: 1,
      signal: new AbortController().signal,
      log: async () => {},
      updateProgress: async () => {},
    } as never;
    const result = await processGraphNodeJob(job, undefined, s3Storage);
    const merged = s3Storage.getObject(result.resultKey)?.buffer as Buffer;
    expect(pdfinfoPages(merged)).toBe(2);
    const text = pdftotext(merged);
    expect(text).toContain('Alpha body');
    expect(text).toContain('Beta body');
  });
});
