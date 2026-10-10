import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import { POST as createJobPost } from '../src/app/api/v1/jobs/route';
import { sealGraphNode } from '../src/lib/queue/graph/sealed-nodes';
import { GET as getV1JobRoute } from '../src/app/api/v1/jobs/[id]/route';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { Worker } from '../src/lib/queue/bullmq-engine';
import { conversionQueue, processConversionJob } from '../src/lib/queue/conversion-queue';
import { graphScheduler } from '../src/lib/queue/graph';
import { s3Storage } from '../src/lib/storage/s3-storage';
import type { ConversionJobData } from '../src/lib/types';
import { AES_256, RC4_128, pdfinfoPages, plainPdf, qpdfEncrypt, qpdfEncryptionReport, pdftotext } from './helpers/encrypted-pdf-fixtures';
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

describe.skipIf(toolsMissing)('a queued watermark, merge or unlock node on an encrypted PDF', () => {
  function seed(name: string, buffer: Buffer): string {
    counter += 1;
    const key = `tests/pdf-encryption-routes/${Date.now()}_${counter}_${name}`;
    s3Storage.saveObject(key, buffer, 'application/pdf', name, ARTIFACT_TTL_MS);
    return key;
  }

  function nodeJob(graphNode: Record<string, unknown>, inputArtifacts: string[], userId?: string) {
    counter += 1;
    const graphId = `g_enc571_${Date.now()}_${counter}`;
    const jobId = `${graphId}:n1`;
    const data: ConversionJobData = {
      jobId,
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
    return { graphId, jobId, data };
  }

  async function failedJob(graphNode: Record<string, unknown>, inputArtifacts: string[]): Promise<Record<string, unknown>> {
    const { headers, userId } = await apiKeyHeaders();
    const { jobId, data } = nodeJob(graphNode, inputArtifacts, userId);
    vi.spyOn(graphScheduler, 'onNodeFailed').mockResolvedValue(undefined as never);
    const worker = new Worker(conversionQueue, processConversionJob, { concurrency: 1 });
    const failed = new Promise<void>((resolve) => worker.on('failed', () => resolve()));
    const job = await conversionQueue.add('graph-node', data, {
      jobId,
      attempts: ATTEMPTS,
      backoff: { type: 'fixed', delay: RETRY_DELAY_MS },
    });
    await failed;
    await worker.close();
    vi.restoreAllMocks();
    const res = await getV1JobRoute(new NextRequest(`${BASE_URL}/api/v1/jobs/${job.id}`, { headers }), { params: { id: job.id } });
    return res.json();
  }

  async function runNode(graphNode: Record<string, unknown>, inputArtifacts: string[], seal = false): Promise<Buffer> {
    const { processGraphNodeJob } = await import('../src/lib/queue/graph/node-executor');
    const { data, jobId } = nodeJob(graphNode, inputArtifacts);
    // The queue stores a node sealed under its job id; the executor must open it at the point of use.
    if (seal) data.graphNode = sealGraphNode(graphNode as never, jobId);
    if (seal) expect(JSON.stringify(data.graphNode)).not.toContain(USER_PASSWORD);
    const job = {
      id: jobId,
      data,
      opts: { attempts: 1 },
      attemptsMade: 1,
      signal: new AbortController().signal,
      log: async () => {},
      updateProgress: async () => {},
    } as never;
    const result = await processGraphNodeJob(job, undefined, s3Storage);
    return s3Storage.getObject(result.resultKey)?.buffer as Buffer;
  }

  const watermarkNode = (options: Record<string, unknown> = {}) => ({
    op: 'pdf.watermark',
    options: { watermark: { text: 'MARK', rotation: 0 }, ...options },
  });

  it('fails a pdf.watermark node once with failedStatus 422 and PdfPasswordRequiredError when a user password is needed', async () => {
    const key = seed('locked.pdf', qpdfEncrypt(await plainPdf(), { variant: AES_256, userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD }));
    const body = await failedJob(watermarkNode(), [key]);
    expect(body).toMatchObject({ status: 'failed', attemptsMade: 1, failedStatus: HTTP_UNPROCESSABLE, failedCode: 'PdfPasswordRequiredError' });
  });

  it('fails a pdf.watermark node on an owner-restricted file once with PdfPermissionDeniedError and a hint', async () => {
    const key = seed('restricted.pdf', qpdfEncrypt(await plainPdf(), { variant: RC4_128, userPassword: '', ownerPassword: OWNER_PASSWORD, modify: 'none' }));
    const body = await failedJob(watermarkNode(), [key]);
    expect(body).toMatchObject({ status: 'failed', attemptsMade: 1, failedStatus: HTTP_UNPROCESSABLE, failedCode: 'PdfPermissionDeniedError' });
    expect(String(body.failedReason)).toMatch(/confirmEditRights/);
  });

  it('fails a merge node with an input that needs a user password once with failedStatus 422', async () => {
    const encrypted = seed('locked.pdf', qpdfEncrypt(await plainPdf(['Locked']), { variant: RC4_128, userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD }));
    const open = seed('open.pdf', await plainPdf(['Open']));
    const body = await failedJob({ op: 'merge', targetFormat: 'pdf' }, [open, encrypted]);
    expect(body).toMatchObject({ status: 'failed', attemptsMade: 1, failedStatus: HTTP_UNPROCESSABLE, failedCode: 'PdfPasswordRequiredError' });
  });

  it('fails a pdf.unlock node on a file with a user password once with failedStatus 422', async () => {
    const key = seed('locked.pdf', qpdfEncrypt(await plainPdf(), { variant: AES_256, userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD }));
    const body = await failedJob({ op: 'pdf.unlock', options: { confirmEditRights: true } }, [key]);
    expect(body).toMatchObject({ status: 'failed', failedStatus: HTTP_UNPROCESSABLE, failedCode: 'PdfPasswordRequiredError' });
  });

  it('watermarks with node options password, and with a confirmation on an owner-restricted file', async () => {
    const userKey = seed('user.pdf', qpdfEncrypt(await plainPdf(['User body']), { variant: AES_256, userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD }));
    const viaPassword = await runNode(watermarkNode({ password: USER_PASSWORD }), [userKey]);
    expect(pdftotext(viaPassword)).toContain('MARK');

    const restrictedKey = seed('restricted.pdf', qpdfEncrypt(await plainPdf(['Restricted body']), { variant: RC4_128, userPassword: '', ownerPassword: OWNER_PASSWORD, modify: 'none' }));
    const viaConfirm = await runNode(watermarkNode({ confirmEditRights: true }), [restrictedKey]);
    expect(pdftotext(viaConfirm)).toContain('MARK');
    expect(pdftotext(viaConfirm)).toContain('Restricted body');
    expect(pdfinfoPages(viaConfirm)).toBe(1);
  });

  it('merges with the passwords of the encrypted inputs, in input order, and with a confirmation', async () => {
    const locked = seed('locked.pdf', qpdfEncrypt(await plainPdf(['Locked body']), { variant: AES_256, userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD, modify: 'none' }));
    const open = seed('open.pdf', await plainPdf(['Open body']));
    const merged = await runNode(
      { op: 'merge', targetFormat: 'pdf', options: { passwords: [USER_PASSWORD, null], confirmEditRights: true } },
      [locked, open]
    );
    expect(pdfinfoPages(merged)).toBe(2);
    expect(pdftotext(merged)).toContain('Locked body');
    expect(pdftotext(merged)).toContain('Open body');
  });

  it('unlocks with a pdf.unlock node and stores a PDF qpdf reports as unencrypted', async () => {
    const key = seed('restricted.pdf', qpdfEncrypt(await plainPdf(['Unlock me']), { variant: AES_256, userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD, modify: 'none' }));
    const out = await runNode({ op: 'pdf.unlock', options: { password: USER_PASSWORD, confirmEditRights: true } }, [key]);
    expect(qpdfEncryptionReport(out).encrypted).toBe(false);
    expect(pdftotext(out)).toContain('Unlock me');
  });

  it('runs a node whose passwords were sealed for the queue, which holds no plaintext password', async () => {
    const locked = seed('sealed.pdf', qpdfEncrypt(await plainPdf(['Sealed body']), { variant: AES_256, userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD }));
    const open = seed('plain.pdf', await plainPdf(['Plain body']));
    const merged = await runNode({ op: 'merge', targetFormat: 'pdf', options: { passwords: [USER_PASSWORD, null] } }, [locked, open], true);
    expect(pdfinfoPages(merged)).toBe(2);
    expect(pdftotext(merged)).toContain('Sealed body');

    const watermarked = await runNode(watermarkNode({ password: USER_PASSWORD }), [locked], true);
    expect(pdftotext(watermarked)).toContain('MARK');
  });
});

describe.skipIf(toolsMissing)('a sealed pdf.protect node', () => {
  it('protects the PDF with the sealed passwords, in the nested and the flat form', async () => {
    counter += 1;
    const key = `tests/pdf-encryption-routes/${Date.now()}_${counter}_plain.pdf`;
    s3Storage.saveObject(key, await plainPdf(['Sealed protect body']), 'application/pdf', 'plain.pdf', ARTIFACT_TTL_MS);
    const { processGraphNodeJob } = await import('../src/lib/queue/graph/node-executor');
    for (const options of [
      { protect: { userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD, keyLength: 256 } },
      { userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD, keyLength: 256 },
    ]) {
      counter += 1;
      const graphId = `g_enc571_protect_${Date.now()}_${counter}`;
      const jobId = `${graphId}:n1`;
      const sealed = sealGraphNode({ op: 'pdf.protect', options } as never, jobId);
      expect(JSON.stringify(sealed)).not.toContain(USER_PASSWORD);
      const job = {
        id: jobId,
        data: { jobId, sourceFormat: 'bin', targetFormat: 'pdf', fileSize: 0, options: {}, graphId, graphNodeId: 'n1', graphNode: sealed, inputArtifacts: [key] },
        opts: { attempts: 1 },
        attemptsMade: 1,
        signal: new AbortController().signal,
        log: async () => {},
        updateProgress: async () => {},
      } as never;
      const result = await processGraphNodeJob(job, undefined, s3Storage);
      const out = s3Storage.getObject(result.resultKey)?.buffer as Buffer;
      expect(qpdfEncryptionReport(out, USER_PASSWORD)).toMatchObject({ encrypted: true, userPasswordMatched: true, R: 6 });
      expect(qpdfEncryptionReport(out, OWNER_PASSWORD).ownerPasswordMatched).toBe(true);
      expect(pdftotext(out, USER_PASSWORD)).toContain('Sealed protect body');
    }
  });
});

describe('graph submission validation of the new options', () => {
  async function submit(nodeOptions: Record<string, unknown>, op = 'pdf.watermark'): Promise<Response> {
    const { headers } = await apiKeyHeaders();
    s3Storage.saveObject('uploads/enc571-input.pdf', Buffer.from('%PDF-1.4'), 'application/pdf', 'enc571-input.pdf');
    return createJobPost(
      new NextRequest(`${BASE_URL}/api/v1/jobs`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: 'enc571-input.pdf',
          targetFormat: 'pdf',
          storageKey: 'uploads/enc571-input.pdf',
          graph: {
            nodes: {
              src: { op: 'import.upload', storageKey: 'uploads/enc571-input.pdf' },
              step: { op, input: 'src', options: nodeOptions },
              out: { op: 'export.internal', input: 'step' },
            },
          },
        }),
      })
    );
  }

  it('accepts a pdf.unlock node with a boolean confirmEditRights and a password', async () => {
    const res = await submit({ confirmEditRights: true, password: 'pw' }, 'pdf.unlock');
    const text = await res.clone().text();
    expect(res.status, text).toBe(202);
    const body = await res.json();
    expect(body.nodes.step).toBeDefined();
  });

  it('rejects a confirmEditRights that is not a boolean with a 422 schema problem', async () => {
    const res = await submit({ confirmEditRights: 'yes' });
    expect(res.status).toBe(HTTP_UNPROCESSABLE);
    expect(JSON.stringify(await res.json())).toMatch(/confirmEditRights/);
  });
});

describe('the OpenAPI document describes the editing options', () => {
  it('publishes confirmEditRights as a boolean, passwords as a list, and pdf.unlock as a graph operation', async () => {
    const { GET: getOpenApi } = await import('../src/app/api/openapi.json/route');
    const spec = await (await getOpenApi()).json();
    const options = spec.components.schemas.ConversionOptions.properties;
    expect(options.confirmEditRights.type).toBe('boolean');
    expect(options.confirmEditRights.description).toMatch(/owner restrictions/i);
    expect(options.passwords.type).toBe('array');
    expect(spec.components.schemas.JobGraph.properties.nodes.additionalProperties.properties.op.enum).toContain('pdf.unlock');
  });
});
