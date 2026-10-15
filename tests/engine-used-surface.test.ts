import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import JSZip from 'jszip';
import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import { GET as getV1JobRoute } from '../src/app/api/v1/jobs/[id]/route';
import { GET as getOpenApiSpec } from '../src/app/api/openapi.json/route';
import { Worker } from '../src/lib/queue/bullmq-engine';
import { conversionQueue, processConversionJob } from '../src/lib/queue/conversion-queue';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { MAX_FALLBACK_REASON_CHARS, publicFallbackReason } from '../src/lib/api/engine-trace';
import { withMissingBinary } from './helpers/native-tools';
import { oracleTest } from './helpers/oracle-test';

/**
 * Issue #484: which engine converted a file, and why a fallback happened, was invisible to API clients.
 * `engineUsed` is on every conversion result and job view; `fallbackReason` only when a fallback happened.
 *
 * Oracle: the expected engine names come from the worker's documented engine identifiers, and the 7-Zip
 * binary is made absent through its environment override, which the engine resolves on every conversion.
 */

const BASE_URL = 'http://localhost:3000';
const HTTP_OK = 200;
const SEVEN_ZIP_ENV = 'P7ZIP_PATH';
const NATIVE_ENGINE = 'native-7z';
const IN_PROCESS_ENGINE = 'internal-fallback';
const TAR_BLOCK_BYTES = 512;
const TAR_NAME_FIELD_BYTES = 100;

let secretKey: string;
let userId: string;

beforeEach(async () => {
  const user = await userStore.createUser({
    name: 'Engine Trace Tester',
    email: `engine_trace_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
    tier: 'pro',
  });
  userId = user.id;
  const key = await redisKeyStore.generateApiKey(user.id, 'Engine Trace Key', { scopes: ['convert:write', 'convert:read'] });
  secretKey = key.secretKey;
});

async function zipWithOneEntry(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('hello.txt', 'hello engine trace');
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function convertRequest(headers: Record<string, string> = {}): Promise<NextRequest> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(await zipWithOneEntry())]), 'bundle.zip');
  form.append('targetFormat', 'tar');
  return new NextRequest(`${BASE_URL}/api/v1/convert`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secretKey}`, ...headers },
    body: form,
  });
}

/** Queues a zip -> tar job for the user, runs it through the real worker and answers the job view. */
async function jobView(): Promise<Record<string, any>> {
  const input = await zipWithOneEntry();
  const worker = new Worker(conversionQueue, processConversionJob, { concurrency: 1 });
  const done = new Promise<void>((resolve) => {
    worker.on('completed', () => resolve());
    worker.on('failed', () => resolve());
  });
  const job = await conversionQueue.add('convert', {
    jobId: '',
    originalFilename: 'bundle.zip',
    sourceFormat: 'zip',
    targetFormat: 'tar',
    fileSize: input.length,
    options: {},
    inputBufferBase64: input.toString('base64'),
    userId,
  });
  await done;
  await worker.close();
  const res = await getV1JobRoute(
    new NextRequest(`${BASE_URL}/api/v1/jobs/${job.id}`, { headers: { Authorization: `Bearer ${secretKey}` } }),
    { params: { id: job.id } }
  );
  expect(res.status).toBe(HTTP_OK);
  return res.json();
}

describe('POST /api/v1/convert', () => {
  oracleTest('names the native engine and sends no fallbackReason when no fallback happened', ['7z'], async () => {
    const res = await v1ConvertPost(await convertRequest());
    expect(res.status).toBe(HTTP_OK);
    const body = await res.json();
    expect(body.engineUsed).toBe(NATIVE_ENGINE);
    expect(body).not.toHaveProperty('fallbackReason');
  });

  it('names the in-process engine and the redacted reason when the native engine was missing', async () => {
    const res = await withMissingBinary(SEVEN_ZIP_ENV, async () => v1ConvertPost(await convertRequest()));
    expect(res.status).toBe(HTTP_OK);
    const body = await res.json();
    expect(body.engineUsed).toBe(IN_PROCESS_ENGINE);
    expect(body.fallbackReason).toMatch(/7-Zip binary is not installed/);
    expect(body.fallbackReason.length).toBeLessThanOrEqual(MAX_FALLBACK_REASON_CHARS);
    expect(body.fallbackReason).not.toContain('/nonexistent');
  });

  it('sends the engine and the reason as headers of a raw response', async () => {
    const res = await withMissingBinary(SEVEN_ZIP_ENV, async () =>
      v1ConvertPost(await convertRequest({ Accept: 'application/octet-stream' }))
    );
    expect(res.status).toBe(HTTP_OK);
    expect(res.headers.get('X-Engine-Used')).toBe(IN_PROCESS_ENGINE);
    expect(res.headers.get('X-Fallback-Reason')).toMatch(/7-Zip binary is not installed/);
    // The raw body is a real tar archive that holds the zip's entry, whichever engine wrote it.
    const tar = Buffer.from(await res.arrayBuffer());
    expect(tar.length % TAR_BLOCK_BYTES).toBe(0);
    expect(tar.subarray(0, TAR_NAME_FIELD_BYTES).toString('latin1').replace(/\0+$/, '')).toBe('hello.txt');
  });
});

describe('GET /api/v1/jobs/{id}', () => {
  oracleTest('carries engineUsed in the view and the result, without a fallbackReason', ['7z'], async () => {
    const body = await jobView();
    expect(body.status).toBe('completed');
    expect(body.engineUsed).toBe(NATIVE_ENGINE);
    expect(body.result.engineUsed).toBe(NATIVE_ENGINE);
    expect(body).not.toHaveProperty('fallbackReason');
    expect(body.result).not.toHaveProperty('fallbackReason');
  });

  it('carries the redacted fallbackReason when the worker fell back to the in-process engine', async () => {
    const body = await withMissingBinary(SEVEN_ZIP_ENV, jobView);
    expect(body.status).toBe('completed');
    expect(body.engineUsed).toBe(IN_PROCESS_ENGINE);
    expect(body.fallbackReason).toMatch(/7-Zip binary is not installed/);
    expect(body.result.engineUsed).toBe(IN_PROCESS_ENGINE);
    expect(body.result.fallbackReason).toBe(body.fallbackReason);
  });
});

describe('publicFallbackReason', () => {
  it('leaves nothing for a missing or blank reason', () => {
    expect(publicFallbackReason(undefined)).toBeUndefined();
    expect(publicFallbackReason('')).toBeUndefined();
    expect(publicFallbackReason('  \n\t ')).toBeUndefined();
  });

  it('keeps a short plain reason as it is', () => {
    expect(publicFallbackReason("Engine 'ffmpeg' is unavailable: FFmpeg binary is not installed or not in PATH")).toBe(
      "Engine 'ffmpeg' is unavailable: FFmpeg binary is not installed or not in PATH"
    );
  });

  it('replaces file system paths of every platform with a placeholder', () => {
    expect(
      publicFallbackReason(
        'LibreOffice failed on /tmp/easyconvert-vfs/easyconvert-out-1f2e3d.pdf (see C:\\Users\\bob\\AppData\\x.docx and ~/work/in.docx)'
      )
    ).toBe('LibreOffice failed on <path> (see <path> and <path>)');
  });

  it('keeps a slash inside a word and a lone slash', () => {
    expect(publicFallbackReason('PDF/A export failed / retried')).toBe('PDF/A export failed / retried');
  });

  it('masks credentials', () => {
    expect(publicFallbackReason('retry with password=hunter2')).toBe('retry with password=***');
    const withUrl = publicFallbackReason('upload to https://user:swordfish@example.com/path failed') as string;
    expect(withUrl).not.toContain('swordfish');
    expect(withUrl.startsWith('upload to https://')).toBe(true);
  });

  it('keeps only the first line, where a tool stderr follows it', () => {
    expect(publicFallbackReason('soffice exited with code 81\nstderr: /var/lib/secret-dir/trace.log\nmore')).toBe(
      'soffice exited with code 81'
    );
  });

  it('bounds the length and keeps the text printable ASCII for use in a header', () => {
    const reason = publicFallbackReason(`caf\u00e9 ${'x'.repeat(MAX_FALLBACK_REASON_CHARS * 3)}`) as string;
    expect(reason.length).toBe(MAX_FALLBACK_REASON_CHARS);
    expect(reason).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe('OpenAPI document', () => {
  it('documents engineUsed and fallbackReason on the convert response, the job view and the headers', async () => {
    const spec = await (await getOpenApiSpec()).json();
    const response = spec.components.schemas.ConversionResponse.properties;
    expect(response.engineUsed.type).toBe('string');
    expect(response.fallbackReason.type).toBe('string');
    expect(response.fallbackReason.maxLength).toBe(MAX_FALLBACK_REASON_CHARS);

    const job = spec.components.schemas.JobResource.properties;
    expect(job.engineUsed.type).toBe('string');
    expect(job.fallbackReason.maxLength).toBe(MAX_FALLBACK_REASON_CHARS);
    expect(job.result.properties.engineUsed.type).toBe('string');
    expect(job.result.properties.fallbackReason.type).toBe('string');

    const headers = spec.paths['/api/v1/convert'].post.responses['200'].headers;
    expect(headers['X-Engine-Used'].schema.type).toBe('string');
    expect(headers['X-Fallback-Reason'].schema.maxLength).toBe(MAX_FALLBACK_REASON_CHARS);
  });
});
