import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import JSZip from 'jszip';
import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import { GET as getV1JobRoute } from '../src/app/api/v1/jobs/[id]/route';
import { POST as createJob } from '../src/app/api/v1/jobs/route';
import { GET as getFormats } from '../src/app/api/formats/route';
import { GET as getOpenApiSpec } from '../src/app/api/openapi.json/route';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { graphScheduler } from '../src/lib/queue/graph';
import { Worker } from '../src/lib/queue/bullmq-engine';
import { allConversionQueues, attachJobLifecycleListeners, conversionQueue, processConversionJob } from '../src/lib/queue/conversion-queue';
import { installedEngineVersion } from '../src/worker/engine-registry';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';

/**
 * The engine of a conversion over HTTP: `options.engine` and `options.engineVersion` of a convert request, a job, a pipeline task and
 * a graph node; the refusals with the engines of the pair; the engine and its version on the result and the job; and the formats API
 * that lists the engines of each pair. The oracle for the versions is the installed program or the release (read by the same probe the
 * worker uses, which tests/engine-registry.test.ts holds to the output of each program).
 */

const BASE_URL = 'http://localhost:3000';
const HTTP_OK = 200;
const HTTP_ACCEPTED = 202;
const HTTP_UNPROCESSABLE = 422;
const WAIT_MS = 30_000;

let secretKey: string;
let userId: string;
let worker: Worker<ConversionJobData, ConversionJobResult> | undefined;

beforeEach(async () => {
  const user = await userStore.createUser({
    name: 'Engine Choice Tester',
    email: `engine_choice_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
    tier: 'pro',
  });
  userId = user.id;
  secretKey = (await redisKeyStore.generateApiKey(user.id, 'Engine Choice Key', { scopes: ['convert:write', 'convert:read'] })).secretKey;
});

afterEach(async () => {
  await worker?.close();
  worker = undefined;
  vi.restoreAllMocks();
});

async function zipBytes(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('hello.txt', 'hello engine choice');
  return zip.generateAsync({ type: 'nodebuffer' });
}

const CSV = 'name,score\nAlice,100\nBob,95\n';

async function convertRequest(options: Record<string, unknown> | undefined, headers: Record<string, string> = {}): Promise<NextRequest> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(await zipBytes())]), 'bundle.zip');
  form.append('targetFormat', 'tar');
  if (options) form.append('options', JSON.stringify(options));
  return new NextRequest(`${BASE_URL}/api/v1/convert`, { method: 'POST', headers: { Authorization: `Bearer ${secretKey}`, ...headers }, body: form });
}

const remaining = async (): Promise<number> => (await redisKeyStore.getQuotaUsage(userId)).remaining;

describe('POST /api/v1/convert with an engine', () => {
  it('converts with the in-process engine and names it, with its version', async () => {
    const res = await v1ConvertPost(await convertRequest({ engine: 'easyconvert' }));
    expect(res.status).toBe(HTTP_OK);
    const body = await res.json();
    expect(body.engine).toBe('easyconvert');
    expect(body.engineVersion).toBe(await installedEngineVersion('easyconvert'));
    expect(body.engineUsed).toBe('internal-fallback');
  });

  oracleTest('converts with the program of the pair and names it, with the installed version', ['7z'], async () => {
    const res = await v1ConvertPost(await convertRequest({ engine: '7zip', engineVersion: await installedEngineVersion('7zip') }));
    expect(res.status).toBe(HTTP_OK);
    const body = await res.json();
    expect(body).toMatchObject({ engine: '7zip', engineUsed: 'native-7z', engineVersion: await installedEngineVersion('7zip') });
  });

  it('reports the engine of a conversion that named none', async () => {
    const res = await v1ConvertPost(await convertRequest(undefined));
    expect(res.status).toBe(HTTP_OK);
    const body = await res.json();
    expect(['7zip', 'easyconvert']).toContain(body.engine);
    expect(body.engineVersion).toBe(await installedEngineVersion(body.engine));
  });

  it('sends the engine and its version as headers of a raw response', async () => {
    const res = await v1ConvertPost(await convertRequest({ engine: 'easyconvert' }, { Accept: 'application/octet-stream' }));
    expect(res.status).toBe(HTTP_OK);
    expect(res.headers.get('X-Engine')).toBe('easyconvert');
    expect(res.headers.get('X-Engine-Version')).toBe(await installedEngineVersion('easyconvert'));
  });

  it('refuses an engine the pair does not list with the code and the engines of the pair, and charges nothing', async () => {
    const before = await remaining();
    const res = await v1ConvertPost(await convertRequest({ engine: 'libreoffice' }));
    expect(res.status).toBe(HTTP_UNPROCESSABLE);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const body = await res.json();
    expect(body).toMatchObject({ status: 422, code: 'engine_not_offered', engines: ['7zip', 'easyconvert'] });
    expect(body.detail).toContain("'libreoffice'");
    expect(await remaining()).toBe(before);
  });

  it('refuses an engine nobody knows with the same code', async () => {
    const res = await v1ConvertPost(await convertRequest({ engine: 'word' }));
    expect(res.status).toBe(HTTP_UNPROCESSABLE);
    expect(await res.json()).toMatchObject({ code: 'engine_not_offered', engines: ['7zip', 'easyconvert'] });
  });

  it('refuses a version other than the installed one, names the installed one, and charges nothing', async () => {
    const before = await remaining();
    const res = await v1ConvertPost(await convertRequest({ engine: 'easyconvert', engineVersion: '0.0.1' }));
    expect(res.status).toBe(HTTP_UNPROCESSABLE);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'engine_version_unavailable', engine: 'easyconvert', installedVersion: await installedEngineVersion('easyconvert') });
    expect(await remaining()).toBe(before);
  });

  it('refuses a version without an engine', async () => {
    const res = await v1ConvertPost(await convertRequest({ engineVersion: '1.0' }));
    expect(res.status).toBe(HTTP_UNPROCESSABLE);
    expect(await res.json()).toMatchObject({ code: 'engine_not_offered' });
  });

  it('refuses an engine that is not a string by the options contract', async () => {
    const res = await v1ConvertPost(await convertRequest({ engine: 7 }));
    expect(res.status).toBe(HTTP_UNPROCESSABLE);
    const body = await res.json();
    expect(body.invalidParams?.map((p: { name: string }) => p.name)).toContain('engine');
  });
});

function runWorker(): ConversionJobResult[] {
  const results: ConversionJobResult[] = [];
  worker = new Worker<ConversionJobData, ConversionJobResult>([...allConversionQueues] as never, processConversionJob, { concurrency: 2 });
  attachJobLifecycleListeners(worker);
  worker.on('completed', (_job: unknown, result: ConversionJobResult) => results.push(result));
  return results;
}

async function submit(body: Record<string, unknown>): Promise<Response> {
  return createJob(
    new NextRequest(`${BASE_URL}/api/v1/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secretKey}` },
      body: JSON.stringify(body),
    })
  );
}

async function jobView(jobId: string): Promise<Record<string, any>> {
  const res = await getV1JobRoute(new NextRequest(`${BASE_URL}/api/v1/jobs/${jobId}`, { headers: { Authorization: `Bearer ${secretKey}` } }), { params: Promise.resolve({ id: jobId }) });
  expect(res.status).toBe(HTTP_OK);
  return res.json();
}

describe('POST /api/v1/jobs with an engine', () => {
  it('runs the job with the engine and reports it on the job and its result', async () => {
    runWorker();
    const res = await submit({ filename: 'bundle.zip', inputBufferBase64: (await zipBytes()).toString('base64'), targetFormat: 'tar', options: { engine: 'easyconvert' } });
    expect(res.status).toBe(HTTP_ACCEPTED);
    const { jobId } = await res.json();
    await vi.waitFor(async () => expect((await jobView(jobId)).status).toBe('completed'), { timeout: WAIT_MS, interval: 100 });
    const view = await jobView(jobId);
    const version = await installedEngineVersion('easyconvert');
    expect(view).toMatchObject({ engine: 'easyconvert', engineVersion: version, engineUsed: 'internal-fallback' });
    expect(view.result).toMatchObject({ engine: 'easyconvert', engineVersion: version });
  }, WAIT_MS + 10_000);

  it('refuses an engine the pair does not list before a job exists, with the engines of the pair', async () => {
    const before = await remaining();
    const enqueued = vi.spyOn(conversionQueue, 'add');
    const res = await submit({ filename: 'bundle.zip', inputBufferBase64: (await zipBytes()).toString('base64'), targetFormat: 'tar', options: { engine: 'poppler' } });
    expect(res.status).toBe(HTTP_UNPROCESSABLE);
    expect(await res.json()).toMatchObject({ code: 'engine_not_offered', engines: ['7zip', 'easyconvert'] });
    expect(enqueued).not.toHaveBeenCalled();
    expect(await remaining()).toBe(before);
  });

  it('refuses an engine version that is not installed', async () => {
    const res = await submit({ filename: 'bundle.zip', inputBufferBase64: (await zipBytes()).toString('base64'), targetFormat: 'tar', options: { engine: 'easyconvert', engineVersion: '9.9.9' } });
    expect(res.status).toBe(HTTP_UNPROCESSABLE);
    expect(await res.json()).toMatchObject({ code: 'engine_version_unavailable' });
  });
});

describe('a task of a pipeline with an engine', () => {
  const tasks = (engine: string) => [{ name: 'to-json', operation: 'convert', targetFormat: 'json', options: { engine } }];

  it('is checked against its own pair before anything is reserved', async () => {
    const res = await submit({ filename: 'scores.csv', inputBufferBase64: Buffer.from(CSV).toString('base64'), tasks: tasks('libreoffice') });
    expect(res.status).toBe(HTTP_UNPROCESSABLE);
    expect(await res.json()).toMatchObject({ code: 'engine_not_offered', engines: ['easyconvert'] });
  });

  it('converts with the engine it names', async () => {
    const results = runWorker();
    const res = await submit({ filename: 'scores.csv', inputBufferBase64: Buffer.from(CSV).toString('base64'), tasks: tasks('easyconvert') });
    expect(res.status).toBe(HTTP_ACCEPTED);
    const { jobId } = await res.json();
    await vi.waitFor(async () => expect((await graphScheduler.getGraphState(jobId))?.status).toBe('completed'), { timeout: WAIT_MS, interval: 100 });
    expect(results.map((r) => r.engine)).toContain('easyconvert');
  }, WAIT_MS + 10_000);
});

describe('a node of a graph with an engine', () => {
  const graph = (engine: string) => ({
    nodes: {
      source: { op: 'import.upload', storageKey: 'inline' },
      convert: { op: 'convert', input: 'source', targetFormat: 'json', options: { engine } },
      keep: { op: 'export.internal', input: 'convert' },
    },
  });

  it('runs the engine it names and the job record of the node reports it', async () => {
    const results = runWorker();
    const res = await submit({ filename: 'scores.csv', inputBufferBase64: Buffer.from(CSV).toString('base64'), graph: graph('easyconvert') });
    expect(res.status).toBe(HTTP_ACCEPTED);
    const { jobId } = await res.json();
    await vi.waitFor(async () => expect((await graphScheduler.getGraphState(jobId))?.status).toBe('completed'), { timeout: WAIT_MS, interval: 100 });
    const node = results.find((r) => r.engine !== undefined);
    expect(node).toMatchObject({ engine: 'easyconvert', engineVersion: await installedEngineVersion('easyconvert') });
  }, WAIT_MS + 10_000);

  it('refuses an engine id nobody knows when the graph is submitted', async () => {
    const res = await submit({ filename: 'scores.csv', inputBufferBase64: Buffer.from(CSV).toString('base64'), graph: graph('word') });
    expect(res.status).toBe(HTTP_UNPROCESSABLE);
    expect(await res.json()).toMatchObject({ code: 'engine_not_offered' });
  });

  it('fails the node, with the refusal, when the engine does not list the pair the node reads and writes', async () => {
    runWorker();
    const res = await submit({ filename: 'scores.csv', inputBufferBase64: Buffer.from(CSV).toString('base64'), graph: graph('libreoffice') });
    expect(res.status).toBe(HTTP_ACCEPTED);
    const { jobId } = await res.json();
    await vi.waitFor(async () => expect((await graphScheduler.getGraphState(jobId))?.status).toBe('failed'), { timeout: WAIT_MS, interval: 100 });
    const state = await graphScheduler.getGraphState(jobId);
    expect(state?.nodes.convert.error).toMatch(/Engine 'libreoffice' does not convert \.csv to \.json/);
  }, WAIT_MS + 10_000);
});

describe('GET /api/formats with engines', () => {
  const get = async (query = ''): Promise<Response> => getFormats(new NextRequest(`${BASE_URL}/api/formats${query}`));

  it('lists every engine of the deployment with its installed version, and keeps the format catalogue', async () => {
    const body = await (await get()).json();
    expect(body.formats.length).toBeGreaterThan(100);
    expect(body).not.toHaveProperty('pairs');
    const easyconvert = body.engines.find((e: { id: string }) => e.id === 'easyconvert');
    expect(easyconvert).toMatchObject({ name: 'EasyConvert (built-in)', installed: true, version: await installedEngineVersion('easyconvert') });
    expect(body.engines.map((e: { id: string }) => e.id)).toEqual(expect.arrayContaining(['libreoffice', 'ffmpeg', 'poppler', '7zip']));
  });

  it('lists the engines of one pair with the version, the default and whether the program is installed', async () => {
    const res = await get('?source=docx&target=pdf');
    expect(res.status).toBe(HTTP_OK);
    const { pairs } = await res.json();
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ source: 'docx', target: 'pdf' });
    expect(pairs[0].engines.map((e: { id: string; default: boolean }) => [e.id, e.default])).toEqual([['libreoffice', true], ['easyconvert', false]]);
    expect(pairs[0].engines[1]).toMatchObject({ version: await installedEngineVersion('easyconvert'), available: true });
    expect(pairs[0].engines[0].available).toBe((await installedEngineVersion('libreoffice')) !== undefined);
  });

  it('lists one engine for a pair that one engine converts', async () => {
    const { pairs } = await (await get('?source=png&target=jpg')).json();
    expect(pairs[0].engines.map((e: { id: string }) => e.id)).toEqual(['easyconvert']);
  });

  it('lists every target of a source, and the pairs of an engine', async () => {
    const bySource = await (await get('?source=pdf')).json();
    expect(bySource.pairs.length).toBeGreaterThan(10);
    expect(bySource.pairs.every((p: { source: string }) => p.source === 'pdf')).toBe(true);
    const byEngine = await (await get('?engine=poppler&source=pdf')).json();
    expect(byEngine.pairs.length).toBeGreaterThan(0);
    expect(byEngine.pairs.every((p: { engines: Array<{ id: string }> }) => p.engines.some((e) => e.id === 'poppler'))).toBe(true);
    expect(byEngine.pairs.length).toBeLessThan(bySource.pairs.length);
  });

  it('refuses a format or an engine it does not know', async () => {
    expect((await get('?source=nope')).status).toBe(400);
    expect((await get('?source=docx&target=nope')).status).toBe(400);
    const unknown = await get('?engine=word');
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).engines).toContain('libreoffice');
  });
});

describe('the OpenAPI document', () => {
  it('names the engine options, the engine fields of a result, the refusal codes and the formats parameters', async () => {
    const spec = await (await getOpenApiSpec()).json();
    const options = spec.components.schemas.ConversionOptions.properties;
    expect(options.engine).toMatchObject({ type: 'string' });
    expect(options.engineVersion).toMatchObject({ type: 'string' });
    expect(spec.components.schemas.ConversionResponse.properties.engine).toBeDefined();
    expect(spec.components.schemas.ConversionResponse.properties.engineVersion).toBeDefined();
    expect(spec.components.schemas.JobResource.properties.result.properties.engine).toBeDefined();
    const problem = JSON.stringify(spec.paths['/api/v1/convert'].post.responses['422']);
    expect(problem).toContain('engine_not_offered');
    expect(problem).toContain('engine_version_unavailable');
    const formats = spec.paths['/api/formats'].get;
    expect(formats.parameters.map((p: { name: string }) => p.name)).toEqual(['source', 'target', 'engine']);
    expect(spec.components.schemas.Engine.properties.id.enum).toContain('libreoffice');
    expect(Object.keys(spec.paths['/api/v1/convert'].post.responses['200'].headers)).toEqual(expect.arrayContaining(['X-Engine', 'X-Engine-Version']));
  });
});
