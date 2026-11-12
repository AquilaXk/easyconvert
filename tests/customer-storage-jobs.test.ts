import fs from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as createJob } from '../src/app/api/v1/jobs/route';
import { GET as getJob } from '../src/app/api/v1/jobs/[id]/route';
import { POST as saveCredentials } from '../src/app/api/v1/storage/credentials/route';
import { userStore } from '../src/lib/auth/user-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { webhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';
import { graphScheduler, InMemoryGraphScheduler } from '../src/lib/queue/graph';
import { Worker } from '../src/lib/queue/bullmq-engine';
import { allConversionQueues, attachJobLifecycleListeners, processConversionJob } from '../src/lib/queue/conversion-queue';
import { S3_DEV_ENDPOINT_ALLOWLIST_ENV } from '../src/lib/storage/adapters/s3';
import { SFTP_DEV_ENDPOINT_ALLOWLIST_ENV } from '../src/lib/storage/adapters/sftp';
import { sealGraph } from '../src/lib/queue/graph/node-jobs';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';
import { startS3StubServer, type S3StubServer } from './helpers/s3-stub-server';
import { startSftpStub, type SftpStub } from './helpers/sftp-stub-server';
import testCredentials from './fixtures/sigv4/test-credentials.json';

/**
 * Jobs through the public API that bring files in from the customer's own store, convert them, and write the result back:
 * a graph of `import.s3` or `import.sftp`, `convert` and `export.s3` or `export.sftp`, run by a worker against an S3 server and an
 * SFTP server. The credentials go in by a saved reference or inline, and appear in no answer, queue record, webhook or log.
 */

const BUCKET = 'customer-bucket';
const ACCESS_KEY = testCredentials.roundtripStub.accessKeyId;
const SECRET = testCredentials.roundtripStub.secretAccessKey;
const CSV = 'name,score\nAlice,100\nBob,95\n';
const GRAPH_TIMEOUT_MS = 30_000;
const SFTP_AVAILABLE = fs.existsSync('/usr/bin/sftp');
const BASE_URL = 'https://easyconvert.app';
const DATA = '/data';

describe('jobs that read from and write to the customer store', () => {
  let s3: S3StubServer;
  let sftp: SftpStub;
  let worker: Worker<ConversionJobData, ConversionJobResult> | undefined;
  let authorization: string;
  let userId: string;
  const consoleOutput: string[] = [];

  beforeAll(async () => {
    s3 = await startS3StubServer({ bucket: BUCKET, credentials: { [ACCESS_KEY]: SECRET } });
    sftp = await startSftpStub();
  });

  afterAll(async () => {
    await s3.close();
    await sftp.close();
  });

  async function newAccount(): Promise<{ id: string; authorization: string }> {
    const user = await userStore.createUser({ email: `byos_${Date.now()}_${Math.random().toString(36).slice(2)}@byos.test`, name: 'byos', tier: 'pro' });
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'byos', { scopes: ['convert:read', 'convert:write'] });
    return { id: user.id, authorization: `Bearer ${secretKey}` };
  }

  beforeEach(async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv(S3_DEV_ENDPOINT_ALLOWLIST_ENV, s3.host);
    vi.stubEnv(SFTP_DEV_ENDPOINT_ALLOWLIST_ENV, `${sftp.host}:${sftp.port}`);
    s3.objects.clear();
    s3.requests.length = 0;
    s3.faults.length = 0;
    sftp.files.clear();
    sftp.directories.clear();
    for (const dir of [DATA, `${DATA}/in`, `${DATA}/out`]) sftp.directories.add(dir);
    sftp.dropConnections = 0;
    sftp.log.writes.length = 0;
    ({ id: userId, authorization } = await newAccount());
    consoleOutput.length = 0;
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleOutput.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(' '));
      });
    }
    worker = new Worker<ConversionJobData, ConversionJobResult>([...allConversionQueues] as never, processConversionJob, { concurrency: 2 });
    attachJobLifecycleListeners(worker);
  });

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const s3Credentials = () => ({ bucket: BUCKET, accessKeyId: ACCESS_KEY, secretAccessKey: SECRET, region: 'us-west-2', endpoint: s3.url });
  const sftpCredentials = () => ({ host: sftp.host, port: sftp.port, username: 'tester', privateKey: sftp.clientPrivateKey, hostKey: sftp.hostPublicKey, basePath: DATA });

  async function save(providerType: 's3' | 'sftp', credentials: object, bearer = authorization): Promise<string> {
    const res = await saveCredentials(
      new NextRequest(`${BASE_URL}/api/v1/storage/credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: bearer },
        body: JSON.stringify({ providerType, credentials: { type: providerType, ...credentials } }),
      })
    );
    expect(res.status).toBe(201);
    return (await res.json()).credentialRef;
  }

  function submit(graph: object, extra: object = {}, bearer = authorization): Promise<Response> {
    return createJob(
      new NextRequest(`${BASE_URL}/api/v1/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: bearer },
        body: JSON.stringify({ graph, ...extra }),
      })
    );
  }

  function submitTasks(tasks: object, extra: object = {}, bearer = authorization): Promise<Response> {
    return createJob(
      new NextRequest(`${BASE_URL}/api/v1/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: bearer },
        body: JSON.stringify({ tasks, ...extra }),
      })
    );
  }

  async function ended(jobId: string) {
    await vi.waitFor(async () => expect(['completed', 'failed']).toContain((await graphScheduler.getGraphState(jobId))?.status), { timeout: GRAPH_TIMEOUT_MS, interval: 100 });
    return (await graphScheduler.getGraphState(jobId))!;
  }

  async function view(jobId: string): Promise<{ text: string; body: Record<string, unknown> }> {
    const res = await getJob(new NextRequest(`${BASE_URL}/api/v1/jobs/${jobId}`, { headers: { Authorization: authorization } }), { params: Promise.resolve({ id: jobId }) });
    const text = await res.text();
    return { text, body: JSON.parse(text) };
  }

  const NO_SECRETS = [SECRET, ACCESS_KEY];

  function expectNoSecret(label: string, text: string, secrets: readonly string[] = NO_SECRETS): void {
    for (const secret of secrets) expect(text.includes(secret), `${label} shows a credential`).toBe(false);
  }

  it('imports a key, converts it and exports it under a prefix, with the credential saved by reference', async () => {
    s3.objects.set('in/people.csv', { body: Buffer.from(CSV), contentType: 'text/csv', etag: '"x"' });
    const ref = await save('s3', s3Credentials());

    const res = await submit({
      nodes: {
        in: { op: 'import.s3', credentialRef: ref, key: 'in/people.csv' },
        conv: { op: 'convert', input: 'in', targetFormat: 'json' },
        out: { op: 'export.s3', input: 'conv', credentialRef: ref, prefix: 'converted/' },
      },
    });
    expect(res.status).toBe(202);
    const { jobId } = await res.json();
    const state = await ended(jobId);

    expect(Object.values(state.nodes).map((node) => node.error).filter(Boolean)).toEqual([]);
    expect(state.status).toBe('completed');
    const written = s3.objects.get('converted/people.json');
    expect(written?.contentType).toBe('application/json');
    expect((JSON.parse(written!.body.toString()) as Array<{ name: string }>).map((row) => row.name)).toEqual(['Alice', 'Bob']);
    expect(s3.requests.every((request) => request.auth.ok && request.auth.accessKeyId === ACCESS_KEY)).toBe(true);

    const shown = await view(jobId);
    expect(shown.body.status).toBe('completed');
    expectNoSecret('job view', shown.text);
    expectNoSecret('graph state', JSON.stringify(state));
    expectNoSecret('console', consoleOutput.join('\n'));
  }, GRAPH_TIMEOUT_MS + 10_000);

  it('takes inline credentials, seals them, and shows them nowhere, not even in the webhook of the job', async () => {
    s3.objects.set('in/people.csv', { body: Buffer.from(CSV), contentType: 'text/csv', etag: '"x"' });
    const dispatched = vi.spyOn(webhookDispatcher, 'dispatch').mockResolvedValue(undefined as never);
    const graph = {
      nodes: {
        in: { op: 'import.s3', credentials: s3Credentials(), key: 'in/people.csv' },
        conv: { op: 'convert', input: 'in', targetFormat: 'json' },
        out: { op: 'export.s3', input: 'conv', credentials: s3Credentials(), prefix: 'o/' },
      },
    };
    const graphId = `inline_${Date.now()}`;
    const scheduler = graphScheduler;
    await scheduler.initGraph(graphId, sealGraph(graphId, graph as never), { ownerUserId: userId, webhookUrl: 'https://hooks.example.com/job', webhookSecret: 'whsec_byos_inline' });
    const state = await ended(graphId);

    expect(state.status).toBe('completed');
    expect(s3.objects.has('o/people.json')).toBe(true);
    await vi.waitFor(() => expect(dispatched).toHaveBeenCalled());
    const payloads = JSON.stringify(dispatched.mock.calls.map((call) => call[2]));
    for (const [label, text] of [['webhook', payloads], ['graph state', JSON.stringify(state)], ['console', consoleOutput.join('\n')]] as const) {
      expectNoSecret(label, text);
    }
  }, GRAPH_TIMEOUT_MS + 10_000);

  it('is accepted through the API with inline credentials and never queues them as sent', async () => {
    s3.objects.set('in/people.csv', { body: Buffer.from(CSV), contentType: 'text/csv', etag: '"x"' });
    const res = await submit({
      nodes: {
        in: { op: 'import.s3', credentials: s3Credentials(), key: 'in/people.csv' },
        conv: { op: 'convert', input: 'in', targetFormat: 'json' },
        out: { op: 'export.s3', input: 'conv', credentials: s3Credentials(), prefix: 'o/' },
      },
    });
    expect(res.status).toBe(202);
    const accepted = await res.text();
    expectNoSecret('the acceptance', accepted);
    const { jobId } = JSON.parse(accepted);
    const state = await ended(jobId);

    expect(state.status).toBe('completed');
    expect(s3.objects.has('o/people.json')).toBe(true);
    expectNoSecret('job view', (await view(jobId)).text);
    expectNoSecret('graph state', JSON.stringify(state));
    expectNoSecret('console', consoleOutput.join('\n'));
  }, GRAPH_TIMEOUT_MS + 10_000);

  it('converts every object under a prefix and writes each result', async () => {
    for (const name of ['a', 'b', 'c']) s3.objects.set(`in/${name}.csv`, { body: Buffer.from(CSV), contentType: 'text/csv', etag: '"x"' });
    const ref = await save('s3', s3Credentials());

    const res = await submit({
      nodes: {
        in: { op: 'import.s3', credentialRef: ref, prefix: 'in/' },
        conv: { op: 'convert', input: 'in', targetFormat: 'json' },
        out: { op: 'export.s3', input: 'conv', credentialRef: ref, prefix: 'out/' },
      },
    }, { sourceFormat: 'csv' });
    expect(res.status).toBe(202);
    const state = await ended((await res.json()).jobId);

    expect(state.status).toBe('completed');
    expect([...s3.objects.keys()].filter((key) => key.startsWith('out/')).sort()).toEqual(['out/a.json', 'out/b.json', 'out/c.json']);
  }, GRAPH_TIMEOUT_MS + 10_000);

  it('fails the job with the code of the cause when the prefix holds more objects than maxObjects', async () => {
    for (let i = 0; i < 4; i++) s3.objects.set(`in/f${i}.csv`, { body: Buffer.from(CSV), contentType: 'text/csv', etag: '"x"' });
    const ref = await save('s3', s3Credentials());

    const res = await submit({
      nodes: {
        in: { op: 'import.s3', credentialRef: ref, prefix: 'in/', maxObjects: 3 },
        conv: { op: 'convert', input: 'in', targetFormat: 'json' },
        out: { op: 'export.s3', input: 'conv', credentialRef: ref, prefix: 'out/' },
      },
    }, { sourceFormat: 'csv' });
    const state = await ended((await res.json()).jobId);

    expect(state.status).toBe('failed');
    expect(state.nodes.in.errorCode).toBe('storage_too_many_objects');
    expect(state.nodes.in.error).toMatch(/more than 3 files; narrow the prefix/);
    expect([...s3.objects.keys()].filter((key) => key.startsWith('out/'))).toEqual([]);
  }, GRAPH_TIMEOUT_MS + 10_000);

  describe('as named tasks', () => {
    it('runs import/s3, convert and export/s3 by name and reports the files the export wrote', async () => {
      s3.objects.set('in/people.csv', { body: Buffer.from(CSV), contentType: 'text/csv', etag: '"x"' });
      const ref = await save('s3', s3Credentials());

      const res = await submitTasks({
        fetch: { operation: 'import/s3', credential_ref: ref, key: 'in/people.csv' },
        'to-json': { operation: 'convert', input: 'fetch', output_format: 'json' },
        deliver: { operation: 'export/s3', input: 'to-json', credential_ref: ref, prefix: 'converted/' },
      });
      expect(res.status).toBe(202);
      const { jobId } = await res.json();
      expect((await ended(jobId)).status).toBe('completed');

      const { body, text } = await view(jobId);
      expect((body.tasks as Record<string, { operation: string; status: string; result?: unknown }>).fetch).toMatchObject({ operation: 'import/s3', status: 'completed' });
      expect((body.tasks as Record<string, { result?: unknown }>).deliver).toMatchObject({
        operation: 'export/s3',
        status: 'completed',
        result: { fileCount: 1, files: [{ filename: 'people.json', destination: 'converted/people.json' }] },
      });
      expect(s3.objects.has('converted/people.json')).toBe(true);
      expectNoSecret('job view', text);
    }, GRAPH_TIMEOUT_MS + 10_000);

    it('reports the cause by code on the task that failed, and the tasks that read it as dependency_failed', async () => {
      for (let i = 0; i < 3; i++) s3.objects.set(`in/f${i}.csv`, { body: Buffer.from(CSV), contentType: 'text/csv', etag: '"x"' });
      const ref = await save('s3', s3Credentials());

      const res = await submitTasks({
        fetch: { operation: 'import/s3', credential_ref: ref, prefix: 'in/', max_objects: 2 },
        'to-json': { operation: 'convert', input: 'fetch', output_format: 'json' },
        deliver: { operation: 'export/s3', input: 'to-json', credential_ref: ref, prefix: 'out/' },
      }, { sourceFormat: 'csv' });
      expect(res.status).toBe(202);
      const { jobId } = await res.json();
      await ended(jobId);

      const tasks = (await view(jobId)).body.tasks as Record<string, { status: string; error?: { code: string } }>;
      expect(tasks.fetch).toMatchObject({ status: 'failed', error: { code: 'storage_too_many_objects' } });
      expect(tasks.deliver).toMatchObject({ status: 'failed', error: { code: 'dependency_failed' } });
    }, GRAPH_TIMEOUT_MS + 10_000);

    it('words a refusal with the fields of a task, and refuses a field the operation does not take', async () => {
      const unknown = await submitTasks({
        fetch: { operation: 'import/s3', credential_ref: `cred_${'0'.repeat(32)}`, key: 'in/people.csv' },
        'to-json': { operation: 'convert', input: 'fetch', output_format: 'json' },
        deliver: { operation: 'export/s3', input: 'to-json', credentials: s3Credentials(), key: 'x' },
      });
      expect(unknown.status).toBe(422);
      expect(JSON.parse(await unknown.text()).invalidParams.map((p: { name: string }) => p.name)).toEqual(['tasks.deliver.key']);

      const missing = await submitTasks({
        fetch: { operation: 'import/s3', credential_ref: `cred_${'0'.repeat(32)}`, key: 'in/people.csv' },
        'to-json': { operation: 'convert', input: 'fetch', output_format: 'json' },
        deliver: { operation: 'export/s3', input: 'to-json', credentials: s3Credentials() },
      });
      expect(missing.status).toBe(422);
      expect(JSON.parse(await missing.text()).invalidParams.map((p: { name: string }) => p.name)).toEqual(['tasks.fetch.credential_ref']);
    });
  });

  describe('refusals at submission', () => {
    const graphWith = (credential: object) => ({
      nodes: {
        in: { op: 'import.s3', key: 'in/people.csv', ...credential },
        conv: { op: 'convert', input: 'in', targetFormat: 'json' },
        out: { op: 'export.s3', input: 'conv', prefix: 'o/', ...credential },
      },
    });

    it('answers 422 for a saved credential that is not the caller\'s, and the same for one that does not exist', async () => {
      const other = await newAccount();
      const theirs = await save('s3', s3Credentials(), other.authorization);

      for (const credentialRef of [theirs, `cred_${'0'.repeat(32)}`]) {
        const res = await submit(graphWith({ credentialRef }));
        expect(res.status).toBe(422);
        const body = await res.text();
        expect(JSON.parse(body).invalidParams.map((p: { name: string }) => p.name)).toEqual(['nodes.in.credentialRef', 'nodes.out.credentialRef']);
        expect(body).not.toContain(theirs);
      }
      expect(s3.requests).toEqual([]);
    });

    it.each([
      ['a private endpoint', 'https://10.0.0.5'],
      ['the metadata address', 'https://169.254.169.254'],
      ['a plain http endpoint', 'http://objects.example.org'],
    ])('answers 422 for inline credentials with %s, before anything is reserved or sent', async (_label, endpoint) => {
      vi.stubEnv('NODE_ENV', 'test');
      const res = await submit(graphWith({ credentials: { ...s3Credentials(), endpoint } }));

      expect(res.status).toBe(422);
      expect(JSON.parse(await res.text()).invalidParams.map((p: { name: string }) => p.name)).toContain('nodes.in.credentials');
      expect(s3.requests).toEqual([]);
    });

    it('answers 422 for a key that leaves the bucket, and for credentials sent with a reference', async () => {
      const ref = await save('s3', s3Credentials());
      const climbing = await submit({ ...graphWith({ credentialRef: ref }), nodes: { ...graphWith({ credentialRef: ref }).nodes, in: { op: 'import.s3', credentialRef: ref, key: '../other-bucket/secret.csv' } } });
      const both = await submit(graphWith({ credentialRef: ref, credentials: s3Credentials() }));

      expect([climbing.status, both.status]).toEqual([422, 422]);
    });
  });

  // skip-ok: environment probe; a host without the OpenSSH client has no real client to drive (CI images carry it).
  describe.skipIf(!SFTP_AVAILABLE)('with an SFTP server', () => {
    it('imports a file over SFTP, converts it and writes the result back over SFTP, with a saved credential', async () => {
      sftp.files.set(`${DATA}/in/people.csv`, Buffer.from(CSV));
      const ref = await save('sftp', sftpCredentials());

      const res = await submit({
        nodes: {
          in: { op: 'import.sftp', credentialRef: ref, path: 'in/people.csv' },
          conv: { op: 'convert', input: 'in', targetFormat: 'json' },
          out: { op: 'export.sftp', input: 'conv', credentialRef: ref, directory: 'out' },
        },
      });
      expect(res.status).toBe(202);
      const { jobId } = await res.json();
      const state = await ended(jobId);

      expect(Object.values(state.nodes).map((node) => node.error).filter(Boolean)).toEqual([]);
      expect(state.status).toBe('completed');
      const written = sftp.files.get(`${DATA}/out/people.json`);
      expect((JSON.parse(written!.toString()) as Array<{ name: string }>).map((row) => row.name)).toEqual(['Alice', 'Bob']);
      expectNoSecret('job view', (await view(jobId)).text, [sftp.clientPrivateKey.split('\n')[1]]);
      expectNoSecret('console', consoleOutput.join('\n'), [sftp.clientPrivateKey.split('\n')[1]]);
    }, GRAPH_TIMEOUT_MS + 10_000);

    it('takes the files of an SFTP directory with inline credentials and writes them to a bucket, and tries again after a dropped connection', async () => {
      sftp.files.set(`${DATA}/in/a.csv`, Buffer.from(CSV));
      sftp.files.set(`${DATA}/in/b.csv`, Buffer.from(CSV));
      sftp.directories.add(`${DATA}/in/archive`);
      sftp.dropConnections = 1;
      const privateKeyLine = sftp.clientPrivateKey.split('\n')[1];

      const res = await submit({
        nodes: {
          in: { op: 'import.sftp', credentials: sftpCredentials(), directory: 'in' },
          conv: { op: 'convert', input: 'in', targetFormat: 'json' },
          out: { op: 'export.s3', input: 'conv', credentials: s3Credentials(), prefix: 'from-sftp/' },
        },
      }, { sourceFormat: 'csv' });
      expect(res.status).toBe(202);
      const accepted = await res.text();
      expectNoSecret('the acceptance', accepted, [privateKeyLine, ...NO_SECRETS]);
      const state = await ended(JSON.parse(accepted).jobId);

      expect(state.status).toBe('completed');
      expect([...s3.objects.keys()].sort()).toEqual(['from-sftp/a.json', 'from-sftp/b.json']);
      expect(sftp.log.connections).toBeGreaterThan(2);
      expectNoSecret('graph state', JSON.stringify(state), [privateKeyLine, ...NO_SECRETS]);
      expectNoSecret('console', consoleOutput.join('\n'), [privateKeyLine, ...NO_SECRETS]);
    }, GRAPH_TIMEOUT_MS + 10_000);

    it('fails the job as storage_access_denied when the server does not know the key', async () => {
      const other = await startSftpStub();
      try {
        sftp.files.set(`${DATA}/in/people.csv`, Buffer.from(CSV));
        const res = await submit({
          nodes: {
            in: { op: 'import.sftp', credentials: { ...sftpCredentials(), privateKey: other.clientPrivateKey }, path: 'in/people.csv' },
            conv: { op: 'convert', input: 'in', targetFormat: 'json' },
            out: { op: 'export.sftp', input: 'conv', credentials: { ...sftpCredentials(), privateKey: other.clientPrivateKey }, directory: 'out' },
          },
        });
        const state = await ended((await res.json()).jobId);

        expect(state.status).toBe('failed');
        expect(state.nodes.in.errorCode).toBe('storage_access_denied');
        expect(sftp.log.writes).toEqual([]);
      } finally {
        await other.close();
      }
    }, GRAPH_TIMEOUT_MS + 10_000);
  });
});

// The scheduler of these tests is the in-memory one; Redis keeps jobs between test files, so a worker here would run another file's leftovers.
describe('the scheduler of these tests', () => {
  it('is the in-memory scheduler', () => {
    // skip-ok: mode guard; the shards run without REDIS_URL, which is the mode this file covers.
    expect(process.env.REDIS_URL ? true : graphScheduler instanceof InMemoryGraphScheduler).toBe(true);
  });
});
