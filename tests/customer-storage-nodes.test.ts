import dns, { type LookupAddress } from 'node:dns';
import fs from 'node:fs';
import os from 'node:os';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../src/lib/queue/bullmq-engine';
import { exportToCustomerStorage, importFromCustomerStorage } from '../src/lib/queue/graph/node-storage-io';
import { graphNodeJobId, sealGraph } from '../src/lib/queue/graph/node-jobs';
import { sealGraphNode } from '../src/lib/queue/graph/sealed-nodes';
import type { ExportS3Node, ImportS3Node, ImportSftpNode } from '../src/lib/queue/graph/types';
import type { IStorageBackend } from '../src/lib/storage/oci-storage';
import { storageProvider } from '../src/lib/storage';
import { credentialsVault } from '../src/lib/storage/credentials-vault';
import { S3_DEV_ENDPOINT_ALLOWLIST_ENV } from '../src/lib/storage/adapters/s3';
import { SFTP_DEV_ENDPOINT_ALLOWLIST_ENV } from '../src/lib/storage/adapters/sftp';
import { refusalCodeOf } from '../src/lib/refusal-codes';
import { DEFAULT_STORAGE_IMPORT_OBJECTS } from '../src/lib/storage/customer-storage-limits';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';
import { startS3StubServer, type S3StubServer } from './helpers/s3-stub-server';
import { startSftpStub } from './helpers/sftp-stub-server';
import testCredentials from './fixtures/sigv4/test-credentials.json';

/**
 * The nodes that read from and write to the customer's own S3-compatible bucket, run as a worker runs them: the files a node
 * takes in and puts out, its caps, the owner check of a saved credential, a failure of the store told from a verdict on the
 * request, and the refusal of an endpoint that is not a public address, also when the name answers differently at connect time.
 */

const BUCKET = 'customer-bucket';
const ACCESS_KEY = testCredentials.roundtripStub.accessKeyId;
const SECRET = testCredentials.roundtripStub.secretAccessKey;
const OWNER = 'user_storage_owner';
const GRAPH_ID = 'graph_storage';
const NODE_ID = 'node';
const JOB_ID = graphNodeJobId(GRAPH_ID, NODE_ID);
const PUBLIC_ADDRESS: LookupAddress = { address: '93.184.215.14', family: 4 };

const planLimit = vi.hoisted(() => ({ fileBytes: undefined as number | undefined }));
vi.mock('../src/lib/plan-limits', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/plan-limits')>();
  return { ...actual, maxFileBytes: (plan: Parameters<typeof actual.maxFileBytes>[0]) => planLimit.fileBytes ?? actual.maxFileBytes(plan) };
});

type StorageJob = Job<ConversionJobData, ConversionJobResult>;

function fakeJob(userId: string | undefined = OWNER): { job: StorageJob; logs: string[]; abort: () => void } {
  const logs: string[] = [];
  const controller = new AbortController();
  const job = {
    id: JOB_ID,
    data: { graphId: GRAPH_ID, graphNodeId: NODE_ID, userId },
    opts: { attempts: 1, timeout: 60_000 },
    attemptsMade: 1,
    signal: controller.signal,
    log: async (line: string) => {
      logs.push(line);
    },
    updateProgress: async () => undefined,
  } as unknown as StorageJob;
  return { job, logs, abort: () => controller.abort() };
}

describe('customer storage nodes against an S3-compatible bucket', () => {
  let stub: S3StubServer;
  let keys: string[];

  beforeAll(async () => {
    stub = await startS3StubServer({ bucket: BUCKET, credentials: { [ACCESS_KEY]: SECRET } });
  });

  afterAll(async () => {
    await stub.close();
  });

  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv(S3_DEV_ENDPOINT_ALLOWLIST_ENV, stub.host);
    stub.objects.clear();
    stub.requests.length = 0;
    stub.faults.length = 0;
    keys = [];
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    planLimit.fileBytes = undefined;
    await Promise.all(keys.map((key) => storageProvider.deleteObject(key)));
  });

  const inlineCredentials = (overrides: Record<string, unknown> = {}) => ({
    bucket: BUCKET,
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET,
    region: 'us-west-2',
    endpoint: stub.url,
    ...overrides,
  });

  /** The node as the worker receives it: its inline credentials sealed under its job id. */
  function sealed<N extends ImportS3Node | ExportS3Node>(node: N): N {
    return sealGraphNode(node, JOB_ID);
  }

  function put(key: string, body: string, contentType = 'text/csv'): void {
    stub.objects.set(key, { body: Buffer.from(body), contentType, etag: '"x"' });
  }

  async function stored(key: string): Promise<string | undefined> {
    return (await storageProvider.getObject(key))?.buffer.toString('utf8');
  }

  async function artifact(name: string, body: string, mime = 'application/json'): Promise<string> {
    const key = `intermediate/${GRAPH_ID}/src/0/${name}`;
    await storageProvider.saveObject(key, Buffer.from(body), mime, name, 60_000);
    keys.push(key);
    return key;
  }

  async function importKeys(node: ImportS3Node, userId?: string): Promise<string[]> {
    const run = fakeJob(userId);
    const outputs = await importFromCustomerStorage(run.job, storageProvider, node, JOB_ID);
    keys.push(...outputs);
    return outputs;
  }

  describe('import.s3', () => {
    it('brings in one object, signed with the customer key, under the name and type of its key', async () => {
      put('reports/q3.csv', 'id,total\n1,99.50\n');

      const [key] = await importKeys(sealed({ op: 'import.s3', credentials: inlineCredentials(), key: 'reports/q3.csv' } as ImportS3Node));

      expect(key).toBe(`intermediate/${GRAPH_ID}/${NODE_ID}/0/q3.csv`);
      expect(await stored(key)).toBe('id,total\n1,99.50\n');
      expect((await storageProvider.stat(key))?.mimeType).toBe('text/csv');
      expect(stub.requests.every((request) => request.auth.ok && request.auth.accessKeyId === ACCESS_KEY)).toBe(true);
    });

    it('brings in the objects under a prefix in key order, flattening the folders into the name and skipping folder markers', async () => {
      put('in/b.csv', 'b');
      put('in/a.csv', 'a');
      put('in/sub/c.csv', 'c');
      put('in/sub/', '');
      put('elsewhere/d.csv', 'd');

      const outputs = await importKeys(sealed({ op: 'import.s3', credentials: inlineCredentials(), prefix: 'in/' } as ImportS3Node));

      expect(outputs.map((key) => key.split('/').slice(3).join('/'))).toEqual(['0/a.csv', '1/b.csv', '2/sub_c.csv']);
      expect(await Promise.all(outputs.map(stored))).toEqual(['a', 'b', 'c']);
    });

    it('refuses a prefix with more objects than maxObjects, and the default of the node, instead of cutting it short', async () => {
      for (let i = 0; i < 4; i++) put(`in/f${i}.csv`, 'x');
      const node = { op: 'import.s3', credentials: inlineCredentials(), prefix: 'in/', maxObjects: 3 } as ImportS3Node;

      const failure = await importKeys(sealed(node)).catch((err: unknown) => err);

      expect(refusalCodeOf(failure)).toBe('storage_too_many_objects');
      expect(stub.requests.some((request) => request.method === 'GET' && request.key !== '')).toBe(false);

      for (let i = 4; i < DEFAULT_STORAGE_IMPORT_OBJECTS; i++) put(`in/f${i}.csv`, 'x');
      expect(refusalCodeOf(await importKeys(sealed({ ...node, maxObjects: undefined })).catch((err: unknown) => err))).toBeUndefined();
      put('in/zzz.csv', 'x');
      expect(refusalCodeOf(await importKeys(sealed({ ...node, maxObjects: undefined })).catch((err: unknown) => err))).toBe('storage_too_many_objects');
    });

    it('lists a long prefix page by page and stops at the first object past the limit', async () => {
      for (let i = 0; i < 30; i++) put(`in/f${String(i).padStart(2, '0')}.csv`, 'x');

      const failure = await importKeys(sealed({ op: 'import.s3', credentials: inlineCredentials(), prefix: 'in/', maxObjects: 5 } as ImportS3Node)).catch((err: unknown) => err);

      expect(refusalCodeOf(failure)).toBe('storage_too_many_objects');
      const listings = stub.requests.filter((request) => request.query.get('list-type') === '2');
      expect(listings).toHaveLength(1);
      expect(listings[0].query.get('max-keys')).toBe('6');
    });

    it('fails with storage_object_not_found for a missing key and for an empty prefix', async () => {
      const missing = await importKeys(sealed({ op: 'import.s3', credentials: inlineCredentials(), key: 'nope.csv' } as ImportS3Node)).catch((err: unknown) => err);
      const empty = await importKeys(sealed({ op: 'import.s3', credentials: inlineCredentials(), prefix: 'nothing/' } as ImportS3Node)).catch((err: unknown) => err);

      expect(refusalCodeOf(missing)).toBe('storage_object_not_found');
      expect(refusalCodeOf(empty)).toBe('storage_object_not_found');
    });

    it('refuses an object larger than the file limit of the plan before it reads a byte of it', async () => {
      put('big.bin', 'x'.repeat(2048));
      planLimit.fileBytes = 1024;

      const failure = await importKeys(sealed({ op: 'import.s3', credentials: inlineCredentials(), key: 'big.bin' } as ImportS3Node)).catch((err: unknown) => err);

      expect(refusalCodeOf(failure)).toBe('input_over_limit');
      expect(stub.requests.map((request) => request.method)).toEqual(['HEAD']);
    });

    it('fails with storage_access_denied, without a second try, when the bucket refuses the key', async () => {
      put('a.csv', 'a');
      stub.faults.push({ match: () => true, status: 403, code: 'AccessDenied', times: Infinity });

      const failure = await importKeys(sealed({ op: 'import.s3', credentials: inlineCredentials(), key: 'a.csv' } as ImportS3Node)).catch((err: unknown) => err);

      expect(refusalCodeOf(failure)).toBe('storage_access_denied');
      expect(stub.requests).toHaveLength(1);
    });

    it('tries again when the store fails now and then, and gives up as storage_unavailable when it keeps failing', async () => {
      put('a.csv', 'a');
      stub.faults.push({ match: (request) => request.method === 'GET' && request.key === 'a.csv', status: 503, code: 'SlowDown', times: 2 });
      const [key] = await importKeys(sealed({ op: 'import.s3', credentials: inlineCredentials(), key: 'a.csv' } as ImportS3Node));
      expect(await stored(key)).toBe('a');

      stub.requests.length = 0;
      stub.faults.push({ match: (request) => request.method === 'HEAD', status: 500, code: 'InternalError', times: Infinity });
      const failure = await importKeys(sealed({ op: 'import.s3', credentials: inlineCredentials(), key: 'a.csv' } as ImportS3Node)).catch((err: unknown) => err);
      expect(refusalCodeOf(failure)).toBe('storage_unavailable');
      expect((failure as { retryable: boolean }).retryable).toBe(true);
    }, 30_000);

    it('judges the file limit on the bytes of one try, so a retry of a file under the limit is not misjudged', async () => {
      put('a.csv', 'x'.repeat(600));
      planLimit.fileBytes = 605;
      stub.faults.push({ match: (request) => request.method === 'GET' && request.key === 'a.csv', status: 200, truncateBody: true, times: 1 });

      const [key] = await importKeys(sealed({ op: 'import.s3', credentials: inlineCredentials(), key: 'a.csv' } as ImportS3Node));

      expect((await stored(key))?.length).toBe(600);
      expect(stub.requests.filter((request) => request.method === 'GET' && request.key === 'a.csv')).toHaveLength(2);
    }, 30_000);

    it('classifies a stream failure that the storage backend wrapped as the store not answering, and tries again', async () => {
      put('a.csv', 'x'.repeat(600));
      stub.faults.push({ match: (request) => request.method === 'GET' && request.key === 'a.csv', status: 200, truncateBody: true, times: Infinity });
      const wrapping = Object.create(storageProvider, {
        saveObjectFromStream: {
          value: async (...args: Parameters<IStorageBackend['saveObjectFromStream']>) => {
            try {
              return await storageProvider.saveObjectFromStream(...args);
            } catch (err) {
              throw new Error('the storage backend failed to save the stream', { cause: err });
            }
          },
        },
      }) as IStorageBackend;

      const failure = await importFromCustomerStorage(fakeJob().job, wrapping, sealed({ op: 'import.s3', credentials: inlineCredentials(), key: 'a.csv' } as ImportS3Node), JOB_ID).catch((err: unknown) => err);

      expect(refusalCodeOf(failure)).toBe('storage_unavailable');
      expect(stub.requests.filter((request) => request.method === 'GET' && request.key === 'a.csv')).toHaveLength(3);
    }, 30_000);

    it('gives up at once, with the abort reason, when the job is cancelled while it waits to try again', async () => {
      put('a.csv', 'a');
      stub.faults.push({ match: (request) => request.method === 'HEAD', status: 500, code: 'InternalError', times: Infinity });
      const run = fakeJob();
      const pending = importFromCustomerStorage(run.job, storageProvider, sealed({ op: 'import.s3', credentials: inlineCredentials(), key: 'a.csv' } as ImportS3Node), JOB_ID).catch((err: unknown) => err);
      await vi.waitFor(() => expect(stub.requests.length).toBeGreaterThan(0));
      run.abort();

      expect((await pending as Error).name).toBe('AbortError');
    }, 30_000);
  });

  describe('export.s3', () => {
    it('writes each input under the prefix with its content type and reports each file', async () => {
      const first = await artifact('people.json', '[{"a":1}]');
      const second = await artifact('notes.txt', 'hello', 'text/plain');
      const run = fakeJob();

      const handedOn = await exportToCustomerStorage(run.job, storageProvider, sealed({ op: 'export.s3', input: 'x', credentials: inlineCredentials(), prefix: 'out/2026/' } as ExportS3Node), [first, second], JOB_ID);

      expect(handedOn).toEqual([first, second]);
      expect(stub.objects.get('out/2026/people.json')).toMatchObject({ contentType: 'application/json' });
      expect(stub.objects.get('out/2026/people.json')?.body.toString()).toBe('[{"a":1}]');
      expect(stub.objects.get('out/2026/notes.txt')).toMatchObject({ contentType: 'text/plain' });
      expect(run.logs).toEqual([
        `Exported "people.json" (9 bytes) to the customer's s3 store`,
        `Exported "notes.txt" (5 bytes) to the customer's s3 store`,
      ]);
      expect(stub.requests.every((request) => request.auth.ok)).toBe(true);
    });

    it('takes the prefix literally and writes to the bucket root without one', async () => {
      const input = await artifact('people.json', '{}');
      await exportToCustomerStorage(fakeJob().job, storageProvider, sealed({ op: 'export.s3', input: 'x', credentials: inlineCredentials(), prefix: 'out/report-' } as ExportS3Node), [input], JOB_ID);
      await exportToCustomerStorage(fakeJob().job, storageProvider, sealed({ op: 'export.s3', input: 'x', credentials: inlineCredentials() } as ExportS3Node), [input], JOB_ID);

      expect([...stub.objects.keys()].sort()).toEqual(['out/report-people.json', 'people.json']);
    });

    it('keeps two inputs of one name apart instead of overwriting the first', async () => {
      const first = await artifact('a/page.json', '1');
      const second = await artifact('b/page.json', '2');

      await exportToCustomerStorage(fakeJob().job, storageProvider, sealed({ op: 'export.s3', input: 'x', credentials: inlineCredentials(), prefix: 'o/' } as ExportS3Node), [first, second], JOB_ID);

      expect([...stub.objects.keys()].sort()).toEqual(['o/page-2.json', 'o/page.json']);
    });

    it('fails the node with the file that failed in the log and leaves the files before it', async () => {
      const first = await artifact('one.json', '1');
      const second = await artifact('two.json', '2');
      stub.faults.push({ match: (request) => request.method === 'PUT' && request.key === 'o/two.json', status: 403, code: 'AccessDenied', times: Infinity });
      const run = fakeJob();

      const failure = await exportToCustomerStorage(run.job, storageProvider, sealed({ op: 'export.s3', input: 'x', credentials: inlineCredentials(), prefix: 'o/' } as ExportS3Node), [first, second], JOB_ID).catch((err: unknown) => err);

      expect(refusalCodeOf(failure)).toBe('storage_access_denied');
      expect(stub.objects.has('o/one.json')).toBe(true);
      expect(run.logs.at(-1)).toBe(`Export of "two.json" to the customer's s3 store failed after 1 of 2 file(s) were written`);
    });

    it('sends the whole file again, from the start, when a write fails now and then', async () => {
      const input = await artifact('one.json', '{"ok":true}');
      stub.faults.push({ match: (request) => request.method === 'PUT', status: 503, code: 'SlowDown', times: 2 });

      await exportToCustomerStorage(fakeJob().job, storageProvider, sealed({ op: 'export.s3', input: 'x', credentials: inlineCredentials(), prefix: 'o/' } as ExportS3Node), [input], JOB_ID);

      expect(stub.objects.get('o/one.json')?.body.toString()).toBe('{"ok":true}');
      expect(stub.requests.filter((request) => request.method === 'PUT')).toHaveLength(3);
    }, 30_000);
  });

  describe('saved credentials', () => {
    const savedCredentials = () => ({ type: 's3' as const, ...inlineCredentials() });

    it('reads with a saved credential of the job owner', async () => {
      put('a.csv', 'a');
      const credentialRef = await credentialsVault.store(OWNER, savedCredentials());

      const [key] = await importKeys({ op: 'import.s3', credentialRef, key: 'a.csv' });

      expect(await stored(key)).toBe('a');
      await credentialsVault.delete(credentialRef, OWNER);
    });

    it('answers a credential of another account, an unknown one and one of another kind alike, and sends nothing', async () => {
      put('a.csv', 'a');
      const other = await credentialsVault.store('user_someone_else', savedCredentials());
      const sftp = await credentialsVault.store(OWNER, { type: 'sftp', host: 'sftp.example.org', username: 'u', privateKey: 'k' });
      const refs = [other, sftp, `cred_${'0'.repeat(32)}`];

      for (const credentialRef of refs) {
        const failure = await importKeys({ op: 'import.s3', credentialRef, key: 'a.csv' }).catch((err: unknown) => err);
        expect(refusalCodeOf(failure), credentialRef).toBe('storage_credential_not_found');
      }
      expect(stub.requests).toEqual([]);

      await credentialsVault.delete(other, 'user_someone_else');
      await credentialsVault.delete(sftp, OWNER);
    });

    it('refuses a saved credential for export as it does for import, and for a job that has no owner', async () => {
      const other = await credentialsVault.store('user_someone_else', savedCredentials());
      const mine = await credentialsVault.store(OWNER, savedCredentials());
      const input = await artifact('one.json', '1');

      const another = await exportToCustomerStorage(fakeJob().job, storageProvider, { op: 'export.s3', input: 'x', credentialRef: other }, [input], JOB_ID).catch((err: unknown) => err);
      const ownerless = await exportToCustomerStorage(fakeJob('').job, storageProvider, { op: 'export.s3', input: 'x', credentialRef: mine }, [input], JOB_ID).catch((err: unknown) => err);

      expect(refusalCodeOf(another)).toBe('storage_credential_not_found');
      expect(refusalCodeOf(ownerless)).toBe('storage_credential_not_found');
      expect(stub.requests).toEqual([]);
      await credentialsVault.delete(other, 'user_someone_else');
      await credentialsVault.delete(mine, OWNER);
    });
  });

  describe('endpoints that are not public', () => {
    beforeEach(() => {
      vi.stubEnv('NODE_ENV', 'test');
    });

    it.each([
      ['the metadata address', 'https://169.254.169.254'],
      ['a loopback address', 'https://127.0.0.1:9443'],
      ['a private address', 'https://10.0.0.5'],
      ['a plain http endpoint', 'http://s3.example.org'],
    ])('refuses %s as storage_endpoint_blocked before any request', async (_label, endpoint) => {
      const lookups = vi.spyOn(dns.promises, 'lookup');
      const credentialRef = await credentialsVault.store(OWNER, { type: 's3', ...inlineCredentials({ endpoint }) });

      const failure = await importKeys({ op: 'import.s3', credentialRef, key: 'a.csv' }).catch((err: unknown) => err);

      expect(refusalCodeOf(failure)).toBe('storage_endpoint_blocked');
      expect((failure as { retryable: boolean }).retryable).toBe(false);
      expect(lookups).not.toHaveBeenCalled();
      await credentialsVault.delete(credentialRef, OWNER);
    });

    it('refuses a name that resolves to a private address', async () => {
      vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '10.1.2.3', family: 4 }] as never);
      const credentialRef = await credentialsVault.store(OWNER, { type: 's3', ...inlineCredentials({ endpoint: 'https://store.internal.example' }) });

      const failure = await importKeys({ op: 'import.s3', credentialRef, key: 'a.csv' }).catch((err: unknown) => err);

      expect(refusalCodeOf(failure)).toBe('storage_endpoint_blocked');
      await credentialsVault.delete(credentialRef, OWNER);
    });

    it('refuses a name that answers a public address to the check and a loopback address to the connection, with no second try', async () => {
      vi.spyOn(dns.promises, 'lookup').mockResolvedValue([PUBLIC_ADDRESS] as never);
      const connectTime = vi.spyOn(dns, 'lookup').mockImplementation(((_host: string, _options: unknown, callback: (err: null, addresses: LookupAddress[]) => void) => {
        process.nextTick(() => callback(null, [{ address: '127.0.0.1', family: 4 }]));
      }) as never);
      const credentialRef = await credentialsVault.store(OWNER, { type: 's3', ...inlineCredentials({ endpoint: 'https://rebind.customer-store.org' }) });

      const failure = await importKeys({ op: 'import.s3', credentialRef, key: 'a.csv' }).catch((err: unknown) => err);

      expect(refusalCodeOf(failure)).toBe('storage_endpoint_blocked');
      expect((failure as { retryable: boolean }).retryable).toBe(false);
      expect(connectTime).toHaveBeenCalledTimes(1);
      expect(stub.requests).toEqual([]);
      await credentialsVault.delete(credentialRef, OWNER);
    });

    it('refuses the same endpoint in inline credentials at run time', async () => {
      const failure = await importKeys(sealed({ op: 'import.s3', credentials: inlineCredentials({ endpoint: 'https://169.254.169.254' }), key: 'a.csv' } as ImportS3Node)).catch((err: unknown) => err);

      expect(refusalCodeOf(failure)).toBe('storage_endpoint_blocked');
    });
  });

  describe('credentials are never shown', () => {
    it('keeps the inline credentials out of the stored node, the failure text and the log', async () => {
      const graph = sealGraph(GRAPH_ID, { nodes: { [NODE_ID]: { op: 'import.s3', credentials: inlineCredentials(), key: 'a.csv' } } } as never);
      const node = graph.nodes[NODE_ID] as unknown as Record<string, unknown>;

      expect(JSON.stringify(graph)).not.toContain(SECRET);
      expect(JSON.stringify(graph)).not.toContain(ACCESS_KEY);
      expect(node.credentials).toBeUndefined();
      expect(typeof node.sealed).toBe('string');

      stub.faults.push({ match: () => true, status: 403, code: 'AccessDenied', times: Infinity });
      const run = fakeJob();
      const failure = await importFromCustomerStorage(run.job, storageProvider, sealGraphNode(node as unknown as ImportS3Node, JOB_ID), JOB_ID).catch((err: unknown) => err);

      for (const text of [String((failure as Error).message), String((failure as Error).stack), run.logs.join('\n')]) {
        expect(text).not.toContain(SECRET);
        expect(text).not.toContain(ACCESS_KEY);
      }
    });
  });
});

// skip-ok: environment probe; a host without the OpenSSH client has no real client to drive (CI images carry it).
describe.skipIf(!fs.existsSync('/usr/bin/sftp'))('import.sftp from a server that states a size it does not keep to', () => {
  const scratch = () => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('easyconvert-sftp-down-'));

  afterEach(() => {
    vi.unstubAllEnvs();
    planLimit.fileBytes = undefined;
  });

  it('stops the download at the plan limit, charges nothing past it to the disk, and fails as input_over_limit', async () => {
    const sftp = await startSftpStub();
    try {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv(SFTP_DEV_ENDPOINT_ALLOWLIST_ENV, `${sftp.host}:${sftp.port}`);
      for (const dir of ['/data', '/data/in']) sftp.directories.add(dir);
      sftp.files.set('/data/in/big.bin', Buffer.alloc(3 * 1024 * 1024, 1));
      sftp.statedSizes.set('/data/in/big.bin', 100);
      planLimit.fileBytes = 1024;
      const before = scratch();
      const node = sealGraphNode(
        { op: 'import.sftp', credentials: { host: sftp.host, port: sftp.port, username: 'tester', privateKey: sftp.clientPrivateKey, hostKey: sftp.hostPublicKey, basePath: '/data' }, path: 'in/big.bin' } as ImportSftpNode,
        JOB_ID
      );

      const failure = await importFromCustomerStorage(fakeJob().job, storageProvider, node, JOB_ID).catch((err: unknown) => err);

      expect(refusalCodeOf(failure)).toBe('input_over_limit');
      expect((failure as { retryable: boolean }).retryable).toBe(false);
      expect(scratch()).toEqual(before);
      expect(await storageProvider.stat(`intermediate/${GRAPH_ID}/${NODE_ID}/0/big.bin`)).toBeNull();
    } finally {
      await sftp.close();
    }
  });
});
