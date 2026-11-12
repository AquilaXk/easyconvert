import { execFile } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EasyConvertApiError, EasyConvertClient } from '../sdk/typescript/src/client';

/**
 * The TypeScript SDK against a stub server: the hand-written layer (sdk/typescript/src/client.ts) over the types and operations
 * generated from the OpenAPI document. POST /api/v1/convert answers 202 with the queued job when the file is over the synchronous
 * limit or the request sends `Prefer: respond-async`, and takes the webhook of that job in the form (docs/policy-decisions.md,
 * entry 245); the SDK sends all three and does not read the JSON of a 202 as the bytes of a result.
 */

const API_KEY = 'ec_live_test_dummy_key_1234567890';
const ACCEPTED = { success: true, status: 'accepted', jobId: 'job_1', statusUrl: '/api/v1/jobs/job_1' };
const RESULT = { downloadUrl: '/api/storage/file/out-key', filename: 'a.json', mimeType: 'application/json', size: 3 };
const RESULT_BYTES = new Uint8Array([1, 2, 3]);
const SDK_DIR = path.resolve(__dirname, '../sdk/typescript');
const TSC = path.resolve(__dirname, '../node_modules/.bin/tsc');

interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

const requests: RecordedRequest[] = [];
let jobPolls = 0;
let server: http.Server;
let baseUrl: string;

function reply(res: http.ServerResponse, status: number, body: unknown, contentType = 'application/json'): void {
  res.writeHead(status, { 'content-type': contentType });
  res.end(Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
}

function route(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://stub');
  const wantsAsync = req.headers.prefer === 'respond-async';
  if (url.pathname === '/api/v1/convert' && wantsAsync) return reply(res, 202, ACCEPTED);
  if (url.pathname === '/api/v1/convert' && url.searchParams.get('raw') === 'true') return reply(res, 200, Buffer.from(RESULT_BYTES), 'application/octet-stream');
  if (url.pathname === '/api/v1/convert') return reply(res, 200, { success: true, fileId: 'f1', fileName: 'a.json', targetFormat: 'json', size: 3 });
  if (url.pathname === '/api/v1/jobs' && req.method === 'POST') return reply(res, 202, ACCEPTED);
  if (url.pathname === '/api/v1/jobs/job_1') {
    jobPolls += 1;
    return reply(res, 200, jobPolls < 2 ? { jobId: 'job_1', status: 'active' } : { jobId: 'job_1', status: 'completed', result: RESULT });
  }
  if (url.pathname === RESULT.downloadUrl) return reply(res, 200, Buffer.from(RESULT_BYTES), 'application/octet-stream');
  return reply(res, 404, { type: 'about:blank', title: 'Not Found', status: 404, detail: 'No such job.', instance: '/api/v1/jobs/missing' }, 'application/problem+json');
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      route(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function client(): EasyConvertClient {
  return new EasyConvertClient({ apiKey: API_KEY, baseUrl });
}

async function formOf(request: RecordedRequest): Promise<FormData> {
  return new Response(new Uint8Array(request.body), { headers: { 'content-type': String(request.headers['content-type']) } }).formData();
}

describe('the TypeScript client over a stub server', () => {
  it('uploads the file with its fields as multipart and answers the result of a synchronous conversion', async () => {
    const answer = await client().convert({
      file: new Blob(['a,b\n1,2\n']),
      filename: 'a.csv',
      targetFormat: 'json',
      options: { quality: 80 },
    });
    expect(answer).toMatchObject({ success: true, fileId: 'f1', targetFormat: 'json' });
    const sent = requests.at(-1)!;
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe('/api/v1/convert');
    expect(sent.headers.authorization).toBe(`Bearer ${API_KEY}`);
    const form = await formOf(sent);
    expect((form.get('file') as File).name).toBe('a.csv');
    expect(await (form.get('file') as File).text()).toBe('a,b\n1,2\n');
    expect(form.get('targetFormat')).toBe('json');
    expect(JSON.parse(form.get('options') as string)).toEqual({ quality: 80 });
  });

  it('sends Prefer: respond-async and the webhook fields, and returns the queued job', async () => {
    const answer = await client().convert({
      file: new Blob(['x']),
      filename: 'a.csv',
      targetFormat: 'json',
      respondAsync: true,
      webhookUrl: 'https://hooks.example.test/in',
      webhookSecret: 'whsec_test',
    });
    expect(answer).toEqual(ACCEPTED);
    const sent = requests.at(-1)!;
    expect(sent.headers.prefer).toBe('respond-async');
    const form = await formOf(sent);
    expect(form.get('webhookUrl')).toBe('https://hooks.example.test/in');
    expect(form.get('webhookSecret')).toBe('whsec_test');
  });

  it('returns the queued job, not its JSON as bytes, when raw is set and the server queued the conversion', async () => {
    expect(await client().convert({ file: new Blob(['x']), targetFormat: 'pdf', raw: true, respondAsync: true })).toEqual(ACCEPTED);
  });

  it('returns the bytes of a finished raw conversion, and sends no Prefer header by default', async () => {
    const answer = await client().convert({ file: new Blob(['x']), targetFormat: 'pdf', raw: true });
    expect(new Uint8Array(answer as ArrayBuffer)).toEqual(RESULT_BYTES);
    const sent = requests.at(-1)!;
    expect(sent.url).toBe('/api/v1/convert?raw=true');
    expect(sent.headers).not.toHaveProperty('prefer');
  });

  it('queues a job, waits for it to complete and downloads its result', async () => {
    jobPolls = 0;
    const sdk = client();
    const { jobId } = await sdk.createJob({ file: new Blob(['x']), filename: 'a.csv', targetFormat: 'json' });
    expect(jobId).toBe('job_1');
    const job = await sdk.waitForJob(jobId, { intervalMs: 5 });
    expect(job.status).toBe('completed');
    expect(jobPolls).toBe(2);
    expect(new Uint8Array(await sdk.download(job.result!.downloadUrl!))).toEqual(RESULT_BYTES);
  });

  it('raises the problem document of an error answer', async () => {
    const failure = await client().getJob('missing').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EasyConvertApiError);
    expect(failure).toMatchObject({ status: 404, problem: { detail: 'No such job.', instance: '/api/v1/jobs/missing' } });
  });

  it('typechecks the SDK sources against the generated types', async () => {
    await promisify(execFile)(TSC, ['-p', SDK_DIR, '--noEmit']);
  }, 60_000);
});
