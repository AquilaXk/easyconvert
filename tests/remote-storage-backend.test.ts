import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { StorageAdapterError } from '../src/lib/storage/adapters/adapter-interface';
import { S3_MIN_PART_BYTES } from '../src/lib/storage/adapters/s3';
import { PayloadTooLargeForMemoryError, StorageSigningSecretMissingError } from '../src/lib/storage/errors';
import {
  REMOTE_DELETE_BY_PREFIX_MAX_OBJECTS,
  REMOTE_INLINE_OBJECT_MAX_BYTES,
  REMOTE_STAGED_FILE_MAX_AGE_MS,
  RemoteStorageBackend,
} from '../src/lib/storage/remote-storage-backend';
import { S3ObjectClient } from '../src/lib/storage/s3-object-client';
import { scopeStorageObjects } from '../src/lib/storage/scoped-storage';
import { startS3StubServer, s3EtagMd5, type S3StubServer } from './helpers/s3-stub-server';

/**
 * The job-storage backend behind STORAGE_DRIVER=oci|s3, run against the signature-verifying stub
 * S3 server (independent SigV4 verifier, see tests/helpers). Every assertion reads what the
 * server stored; the backend keeps no object or session state of its own.
 */

const BUCKET = 'internal-objects';
const REGION = 'ap-seoul-1';
const ACCESS_KEY = 'AKIASTUBEXAMPLE00001';
const SECRET = 'stub/Secret+Key/EXAMPLEKEY0000000000000';
const SIGNING_SECRET = 'remote-backend-test-signing-secret-0001';
const MIB = 1024 * 1024;
const HTTP_OK = 200;

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

describe('RemoteStorageBackend (IStorageBackend over an S3-compatible object store)', () => {
  let server: S3StubServer;
  let backend: RemoteStorageBackend;
  let scratchDir: string;

  function makeClient(): S3ObjectClient {
    return new S3ObjectClient({
      endpoint: server.url,
      region: REGION,
      bucket: BUCKET,
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET,
      providerName: 'oci',
      retryBaseDelayMs: 0,
      requestTimeoutMs: 10_000,
    });
  }

  beforeAll(async () => {
    server = await startS3StubServer({ bucket: BUCKET, credentials: { [ACCESS_KEY]: SECRET } });
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    server.objects.clear();
    server.uploads.clear();
    server.requests.length = 0;
    server.faults.length = 0;
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-remote-backend-'));
    backend = new RemoteStorageBackend(makeClient(), { signingSecret: SIGNING_SECRET, scratchDir });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it('is a remote backend that holds no object or session counts', async () => {
    expect(backend.kind).toBe('remote');
    expect(backend.providerName).toBe('oci');
    expect(backend.getActiveSessionsCount()).toBeNull();
    expect(backend.getObjectsCount()).toBeNull();
  });

  it('refuses to be built without a signing secret instead of signing session tokens with an invented one', () => {
    expect(() => new RemoteStorageBackend(makeClient(), { signingSecret: '' })).toThrow(StorageSigningSecretMissingError);
  });

  describe('multipart upload sessions', () => {
    it('opens a session on the object store and hands out a self-describing, signed upload id', async () => {
      const init = await backend.initiateMultipartUpload('Quarterly report.pdf', 'application/pdf', 3 * MIB, 'user_7');
      expect(init.key).toMatch(/^conversions\/user_7\/\d+_[0-9a-f]{16}_Quarterly_report\.pdf$/);
      expect(init).toMatchObject({ partSize: S3_MIN_PART_BYTES, totalParts: 1 });
      expect(init.expiresAt).toBeGreaterThan(Date.now());
      expect(init.uploadId).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

      // The session exists on the server, with the content type and filename given at creation.
      expect(server.uploads.size).toBe(1);
      const create = server.requests.find((r) => r.method === 'POST' && r.query.has('uploads'))!;
      expect(create.headers['content-type']).toBe('application/pdf');
      expect(create.headers['x-amz-meta-filename']).toBe(encodeURIComponent('Quarterly report.pdf'));

      expect(backend.getUploadSession(init.uploadId)).toMatchObject({
        uploadId: init.uploadId,
        key: init.key,
        filename: 'Quarterly report.pdf',
        mimeType: 'application/pdf',
        totalSize: 3 * MIB,
        totalParts: 1,
        ownerUserId: 'user_7',
      });
      expect(backend.getUploadOwner(init.uploadId)).toBe('user_7');
    });

    it('puts ownerless uploads in the upload namespace', async () => {
      const init = await backend.initiateMultipartUpload('a.bin', 'application/octet-stream', 10);
      expect(init.key).toMatch(/^uploads\/\d+_[0-9a-f]{16}_a\.bin$/);
      expect(backend.getUploadOwner(init.uploadId)).toBeUndefined();
    });

    it('rejects an upload id that was tampered with, signed with another secret, or has expired', async () => {
      const init = await backend.initiateMultipartUpload('a.bin', 'application/octet-stream', 10, 'user_7');
      const [version, body, mac] = init.uploadId.split('.');

      const forgedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), o: 'user_8' })).toString('base64url');
      expect(backend.getUploadSession(`${version}.${forgedBody}.${mac}`)).toBeUndefined();
      expect(backend.getUploadOwner(`${version}.${body}.${mac.slice(0, -2)}AA`)).toBeUndefined();
      expect(backend.getUploadSession('v1.not-base64.zzzz')).toBeUndefined();
      expect(backend.getUploadSession('')).toBeUndefined();
      expect(backend.getUploadSession('x'.repeat(10_000))).toBeUndefined();

      const other = new RemoteStorageBackend(makeClient(), { signingSecret: 'a-different-signing-secret-for-the-other', scratchDir });
      expect(other.getUploadSession(init.uploadId)).toBeUndefined();

      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
      expect(backend.getUploadSession(init.uploadId)).toBeUndefined();
      await expect(backend.uploadPart(init.uploadId, 1, Buffer.from('late'))).rejects.toThrow(/Invalid or expired multipart upload session/);
    });

    it('uploads parts, lists them, completes with validated parts, and reports the size and multipart ETag', async () => {
      const partA = crypto.randomBytes(S3_MIN_PART_BYTES);
      const partB = crypto.randomBytes(2048);
      const init = await backend.initiateMultipartUpload('doc.pdf', 'application/pdf', partA.length + partB.length, 'user_7');
      expect(init.totalParts).toBe(2);

      const a = await backend.uploadPart(init.uploadId, 1, partA);
      const b = await backend.uploadPart(init.uploadId, 2, partB);
      expect(a).toMatchObject({ partNumber: 1, size: partA.length });
      expect(a.etag.replace(/"/g, '')).toBe(s3EtagMd5(partA).toString('hex'));

      expect(await backend.getUploadedParts(init.uploadId)).toEqual([
        { partNumber: 1, size: partA.length, etag: a.etag },
        { partNumber: 2, size: partB.length, etag: b.etag },
      ]);

      const done = await backend.completeMultipartUpload(init.uploadId, [
        { partNumber: 2, etag: b.etag },
        { partNumber: 1, etag: a.etag.replace(/"/g, '') },
      ]);
      const expectedEtag = s3EtagMd5(Buffer.concat([s3EtagMd5(partA), s3EtagMd5(partB)])).toString('hex');
      expect(done).toEqual({
        location: `/api/storage/file/${encodeURIComponent(init.key)}`,
        key: init.key,
        size: partA.length + partB.length,
        etag: `"${expectedEtag}-2"`,
      });
      const stored = server.objects.get(init.key)!;
      expect(stored.body.equals(Buffer.concat([partA, partB]))).toBe(true);
      expect(stored.contentType).toBe('application/pdf');
      expect(stored.metadata?.filename).toBe('doc.pdf');
      for (const request of server.requests) expect(request.auth.ok).toBe(true);
    });

    it('completes from the parts the object store holds when no list is given', async () => {
      const init = await backend.initiateMultipartUpload('x.bin', 'application/octet-stream', 4);
      await backend.uploadPart(init.uploadId, 1, Buffer.from('abcd'));
      const done = await backend.completeMultipartUpload(init.uploadId);
      expect(done.size).toBe(4);
      expect(server.objects.get(init.key)?.body.toString()).toBe('abcd');
    });

    it.each([
      ['a part that was never uploaded', [{ partNumber: 2 }], /Missing part number 2/],
      ['a wrong ETag', [{ partNumber: 1, etag: '"deadbeef"' }], /ETag mismatch for part number 1/],
      ['a duplicated part number', [{ partNumber: 1 }, { partNumber: 1 }], /listed twice/],
      ['a part number outside 1..10000', [{ partNumber: 0 }], /Invalid part number/],
      ['an empty parts list', [], /zero parts/],
    ])('refuses to complete with %s and leaves the object unwritten', async (_name, expected, message) => {
      const init = await backend.initiateMultipartUpload('x.bin', 'application/octet-stream', 4);
      await backend.uploadPart(init.uploadId, 1, Buffer.from('abcd'));
      await expect(backend.completeMultipartUpload(init.uploadId, expected)).rejects.toThrow(message);
      expect(server.objects.has(init.key)).toBe(false);
    });

    it('refuses to complete a session without parts', async () => {
      const init = await backend.initiateMultipartUpload('x.bin', 'application/octet-stream', 4);
      await expect(backend.completeMultipartUpload(init.uploadId)).rejects.toThrow(/Cannot complete empty multipart upload/);
    });

    it('aborts a session so the object store forgets its parts, and reports an unknown session as not aborted', async () => {
      const init = await backend.initiateMultipartUpload('x.bin', 'application/octet-stream', 4);
      await backend.uploadPart(init.uploadId, 1, Buffer.from('abcd'));
      expect(await backend.abortMultipartUpload(init.uploadId)).toBe(true);
      expect(server.uploads.size).toBe(0);
      expect(await backend.abortMultipartUpload('v1.garbage.garbage')).toBe(false);
    });

    it.each([
      ['more than 10,000 parts', { size: 10_001 * S3_MIN_PART_BYTES, partSize: undefined }, /needs 10001 parts/],
      ['a multi-part upload under the 5 MiB part minimum', { size: 10 * MIB, partSize: 1 * MIB }, /must be between/],
      ['a negative size', { size: -1, partSize: undefined }, /Invalid upload size/],
      ['a fractional size', { size: 1.5, partSize: undefined }, /Invalid upload size/],
    ])('refuses to open a session for %s before touching the object store', async (_name, input, message) => {
      await expect(
        backend.initiateMultipartUpload('x.bin', 'application/octet-stream', input.size, undefined, input.partSize)
      ).rejects.toThrow(message);
      expect(server.requests).toHaveLength(0);
    });

    it.each([
      ['an empty filename', ['', 'text/plain'], /needs a filename/],
      ['a non-string filename', [42, 'text/plain'], /needs a filename/],
      ['a content type with a line break', ['a.txt', 'text/plain\r\nX-Evil: 1'], /printable ASCII content type/],
      ['a content type over 255 characters', ['a.txt', `text/${'x'.repeat(300)}`], /printable ASCII content type/],
      ['a non-string content type', ['a.txt', { toString: () => 'text/plain' }], /printable ASCII content type/],
    ])('refuses to open a session with %s before touching the object store', async (_name, [filename, mimeType], message) => {
      await expect(
        backend.initiateMultipartUpload(filename as string, mimeType as string, 10)
      ).rejects.toThrow(message);
      expect(server.requests).toHaveLength(0);
    });

    it('keeps a very long unicode filename within the attribute and token budgets', async () => {
      const filename = `${'数据'.repeat(400)}.csv`;
      const init = await backend.initiateMultipartUpload(filename, 'text/csv', 10, 'user_7');
      expect(init.uploadId.length).toBeLessThan(4096);
      const create = server.requests.find((r) => r.method === 'POST' && r.query.has('uploads'))!;
      expect((create.headers['x-amz-meta-filename'] as string).length).toBeLessThanOrEqual(1024);
      const session = backend.getUploadSession(init.uploadId);
      expect(session?.filename.length).toBeGreaterThan(0);
      expect(filename.startsWith(session?.filename ?? 'x')).toBe(true);
      await backend.uploadPart(init.uploadId, 1, Buffer.from('0123456789'));
      expect((await backend.completeMultipartUpload(init.uploadId)).size).toBe(10);
    });

    it('accepts a single small part below the 5 MiB minimum', async () => {
      const init = await backend.initiateMultipartUpload('tiny.bin', 'application/octet-stream', 12, undefined, 12);
      expect(init).toMatchObject({ partSize: 12, totalParts: 1 });
    });

    it('receives a part from a request body within the part and session limits', async () => {
      const init = await backend.initiateMultipartUpload('s.bin', 'application/octet-stream', 100, 'user_7');
      const part = await backend.uploadPartStream(init.uploadId, 1, Readable.from([Buffer.from('hello '), Buffer.from('world')]));
      expect(part).toMatchObject({ partNumber: 1, size: 11 });
      await backend.completeMultipartUpload(init.uploadId);
      expect(server.objects.get(init.key)?.body.toString()).toBe('hello world');
    });

    it('rejects an oversized or empty streamed part with a statusCode', async () => {
      const init = await backend.initiateMultipartUpload('s.bin', 'application/octet-stream', 100, 'user_7');
      const tooBig = await backend
        .uploadPartStream(init.uploadId, 1, Readable.from([Buffer.alloc(10), Buffer.alloc(10)]), 15)
        .catch((e: unknown) => e);
      expect(tooBig).toMatchObject({ statusCode: 413, message: expect.stringContaining('maximum allowed part size of 15 bytes') });

      const overSession = await backend
        .uploadPartStream(init.uploadId, 1, Readable.from([Buffer.alloc(10)]), 100, 50, 45)
        .catch((e: unknown) => e);
      expect(overSession).toMatchObject({ statusCode: 413, message: expect.stringContaining('Total upload size exceeds') });

      const empty = await backend.uploadPartStream(init.uploadId, 1, Readable.from([])).catch((e: unknown) => e);
      expect(empty).toMatchObject({ statusCode: 400, message: 'Chunk payload is empty (0 bytes).' });
      expect(server.requests.filter((r) => r.method === 'PUT')).toHaveLength(0);
    });

    it('issues presigned part and general URLs only for the session key and the real endpoint', async () => {
      const init = await backend.initiateMultipartUpload('direct.bin', 'application/octet-stream', 4, 'user_7');
      const presigned = backend.generatePresignedUploadPartUrl(init.key, init.uploadId, 1, 300);
      const url = new URL(presigned.url);
      expect(url.origin).toBe(server.url);
      expect(url.pathname).toBe(`/${BUCKET}/${init.key}`);
      expect(url.searchParams.get('partNumber')).toBe('1');
      expect(url.searchParams.get('X-Amz-Credential')?.startsWith(`${ACCESS_KEY}/`)).toBe(true);
      expect(presigned.url).not.toContain('local-emulation');

      const put = await fetch(presigned.url, { method: 'PUT', body: Buffer.from('abcd') });
      expect(put.status).toBe(HTTP_OK);
      const done = await backend.completeMultipartUpload(init.uploadId, [{ partNumber: 1, etag: put.headers.get('etag') as string }]);
      expect(done.size).toBe(4);

      // The session's own key is the only key a part URL can be issued for.
      expect(() => backend.generatePresignedUploadPartUrl('conversions/user_8/other.bin', init.uploadId, 1, 300)).toThrow(
        /does not belong to this multipart upload session/
      );
      expect(() => backend.generatePresignedUploadUrl(init.key, 1, 'v1.forged.forged', 300)).toThrow(
        /Invalid or expired multipart upload session/
      );
      expect(backend.generatePresignedUploadUrl(init.key, 2, init.uploadId, 300).url).toContain('partNumber=2');
    });
  });

  describe('objects', () => {
    it('saves a buffer with filename and expiry, reads it back whole, and reports its stat', async () => {
      const body = crypto.randomBytes(40_000);
      const saved = await backend.saveObject('results/job_1/out.pdf', body, 'application/pdf', 'out.pdf', 90_000);
      expect(saved).toMatchObject({ key: 'results/job_1/out.pdf', filename: 'out.pdf', mimeType: 'application/pdf', size: body.length });
      expect(saved.buffer.equals(body)).toBe(true);
      expect(saved.expiresAt - saved.uploadedAt).toBe(90_000);

      const onServer = server.objects.get('results/job_1/out.pdf')!;
      expect(onServer.body.equals(body)).toBe(true);
      expect(onServer.contentType).toBe('application/pdf');

      const read = await backend.getObject('results/job_1/out.pdf');
      expect(read).toMatchObject({ filename: 'out.pdf', mimeType: 'application/pdf', size: body.length, filePath: undefined });
      expect(read?.buffer.equals(body)).toBe(true);
      expect(read?.etag).toBe(`"${s3EtagMd5(body).toString('hex')}"`);

      expect(await backend.stat('results/job_1/out.pdf')).toEqual({
        size: body.length,
        etag: `"${s3EtagMd5(body).toString('hex')}"`,
        mimeType: 'application/pdf',
        filename: 'out.pdf',
      });
    });

    it('streams an object from a local file with its length declared up front', async () => {
      const file = path.join(scratchDir, 'result.bin');
      const body = crypto.randomBytes(300_000);
      fs.writeFileSync(file, body);
      const saved = await backend.saveObjectFromFile('results/job_2/result.bin', file, 'application/octet-stream', 'result.bin', 60_000);
      expect(saved.size).toBe(body.length);
      expect(server.objects.get('results/job_2/result.bin')?.body.equals(body)).toBe(true);
      const put = server.requests.find((r) => r.method === 'PUT' && r.key === 'results/job_2/result.bin')!;
      expect(put.headers['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD');
      expect(put.headers['content-length']).toBe(String(body.length));
      // The saved object's content is not retained in memory; reading it goes back to the store.
      expect(() => saved.buffer).toThrow(StorageAdapterError);
    });

    it('streams an object of unknown length as a multipart upload', async () => {
      const body = crypto.randomBytes(9 * MIB);
      const saved = await backend.saveObjectFromStream(
        'intermediate/g1/n1/big.bin',
        Readable.from([body.subarray(0, 4 * MIB), body.subarray(4 * MIB)]),
        { filename: 'big.bin', mimeType: 'application/octet-stream' }
      );
      expect(saved.size).toBe(body.length);
      expect(server.objects.get('intermediate/g1/n1/big.bin')?.body.equals(body)).toBe(true);
    });

    it('serves byte ranges of an object as a stream', async () => {
      const body = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
      await backend.saveObject('range/blob.txt', body, 'text/plain', 'blob.txt');
      const stream = await backend.openReadStream('range/blob.txt', { start: 10, end: 15 });
      expect((await readAll(stream!)).toString()).toBe('abcdef');
      const whole = await backend.getObjectStream('range/blob.txt');
      expect((await readAll(whole!)).equals(body)).toBe(true);
    });

    it('reports a missing object as missing', async () => {
      expect(await backend.getObject('nope')).toBeUndefined();
      expect(await backend.stat('nope')).toBeNull();
      expect(await backend.openReadStream('nope')).toBeNull();
    });

    it.each(['a/../b', './x', ''])('reads the unaddressable key %j as a missing object without a request', async (key) => {
      expect(await backend.getObject(key)).toBeUndefined();
      expect(await backend.stat(key)).toBeNull();
      expect(await backend.openReadStream(key)).toBeNull();
      expect(server.requests).toHaveLength(0);
    });

    it('treats an expired object as missing and deletes it', async () => {
      await backend.saveObject('ttl/a.bin', Buffer.from('x'), 'text/plain', 'a.bin', 60_000);
      server.objects.get('ttl/a.bin')!.metadata!['expires-at'] = String(Date.now() - 1);
      expect(await backend.getObject('ttl/a.bin')).toBeUndefined();
      expect(server.objects.has('ttl/a.bin')).toBe(false);

      await backend.saveObject('ttl/b.bin', Buffer.from('x'), 'text/plain', 'b.bin', 60_000);
      server.objects.get('ttl/b.bin')!.metadata!['expires-at'] = String(Date.now() - 1);
      expect(await backend.openReadStream('ttl/b.bin')).toBeNull();
      expect(server.objects.has('ttl/b.bin')).toBe(false);
    });

    it('deletes one object, and every object under a prefix but nothing else', async () => {
      for (let i = 0; i < 23; i++) {
        await backend.saveObject(`intermediate/g9/n${i}/out.bin`, Buffer.from(`o${i}`), 'text/plain', 'out.bin');
      }
      await backend.saveObject('intermediate/g90/n0/out.bin', Buffer.from('keep'), 'text/plain', 'out.bin');
      await backend.saveObject('results/j/keep.bin', Buffer.from('keep'), 'text/plain', 'keep.bin');

      expect(await backend.deleteByPrefix('intermediate/g9/')).toBe(23);
      expect([...server.objects.keys()].sort()).toEqual(['intermediate/g90/n0/out.bin', 'results/j/keep.bin']);

      expect(await backend.deleteObject('results/j/keep.bin')).toBe(true);
      expect(server.objects.has('results/j/keep.bin')).toBe(false);
    });

    it('refuses to delete by an empty prefix, which would empty the bucket', async () => {
      await backend.saveObject('results/j/keep.bin', Buffer.from('keep'), 'text/plain', 'keep.bin');
      await expect(backend.deleteByPrefix('')).rejects.toThrow('deleteByPrefix needs a non-empty prefix');
      expect(server.objects.has('results/j/keep.bin')).toBe(true);
    });

    it('bounds a prefix delete instead of walking an unbounded listing', () => {
      expect(REMOTE_DELETE_BY_PREFIX_MAX_OBJECTS).toBe(10_000);
    });

    it('issues a presigned download URL on the real endpoint that the object store accepts', async () => {
      const body = crypto.randomBytes(1000);
      await backend.saveObject('results/j1/out.bin', body, 'application/octet-stream', 'out.bin');
      const presigned = backend.generatePresignedDownloadUrl('results/j1/out.bin', 600);
      const url = new URL(presigned.url);
      expect(url.origin).toBe(server.url);
      expect(url.searchParams.get('X-Amz-Credential')?.startsWith(`${ACCESS_KEY}/`)).toBe(true);
      expect(presigned.url).not.toContain('local-emulation');
      const res = await fetch(presigned.url);
      expect(res.status).toBe(HTTP_OK);
      expect(Buffer.from(await res.arrayBuffer()).equals(body)).toBe(true);
    });
  });

  describe('large objects are staged to scratch disk', () => {
    const largeSize = REMOTE_INLINE_OBJECT_MAX_BYTES + 1 * MIB;

    it('downloads an object over the inline limit to a private scratch file and removes it on release', async () => {
      const body = crypto.randomBytes(largeSize);
      await backend.saveObject('uploads/large.bin', body, 'application/octet-stream', 'large.bin', 3_600_000);

      const stored = await backend.getObject('uploads/large.bin');
      expect(stored?.size).toBe(body.length);
      const staged = stored?.filePath as string;
      expect(path.dirname(staged)).toBe(scratchDir);
      expect(staged.endsWith('.staged')).toBe(true);
      expect(fs.statSync(staged).size).toBe(body.length);
      expect(fs.statSync(staged).mode & 0o777).toBe(0o600);
      expect(crypto.createHash('sha256').update(fs.readFileSync(staged)).digest('hex')).toBe(
        crypto.createHash('sha256').update(body).digest('hex')
      );
      expect(stored?.buffer.equals(body)).toBe(true);

      await stored?.release?.();
      expect(fs.existsSync(staged)).toBe(false);
    });

    it('refuses to hand out a buffer for a staged object over the in-memory limit', async () => {
      await backend.saveObject('uploads/large2.bin', crypto.randomBytes(largeSize), 'application/octet-stream', 'large2.bin');
      vi.stubEnv('MAX_IN_MEMORY_BYTES', String(MIB));
      const stored = await backend.getObject('uploads/large2.bin');
      expect(stored?.filePath).toBeDefined();
      expect(() => stored?.buffer).toThrow(PayloadTooLargeForMemoryError);
      await stored?.release?.();
    });

    it('removes staged files older than the age limit and leaves everything else in the directory alone', async () => {
      await backend.saveObject('uploads/large3.bin', crypto.randomBytes(largeSize), 'application/octet-stream', 'large3.bin');
      const stale = path.join(scratchDir, 'stale.staged');
      const fresh = path.join(scratchDir, 'fresh.staged');
      const foreign = path.join(scratchDir, 'notes.txt');
      for (const file of [stale, fresh, foreign]) fs.writeFileSync(file, 'x');
      const old = new Date(Date.now() - REMOTE_STAGED_FILE_MAX_AGE_MS - 60_000);
      fs.utimesSync(stale, old, old);
      fs.utimesSync(foreign, old, old);

      const stored = await backend.getObject('uploads/large3.bin');
      expect(fs.existsSync(stale)).toBe(false);
      expect(fs.existsSync(fresh)).toBe(true);
      expect(fs.existsSync(foreign)).toBe(true);
      await stored?.release?.();
    });

    it('does not leave a partial scratch file behind when the download fails', async () => {
      await backend.saveObject('uploads/large4.bin', crypto.randomBytes(largeSize), 'application/octet-stream', 'large4.bin');
      server.faults.push({
        match: (req) => req.method === 'GET' && req.key === 'uploads/large4.bin',
        status: 200,
        truncateBody: true,
        times: Infinity,
      });
      await expect(backend.getObject('uploads/large4.bin')).rejects.toThrow();
      expect(fs.readdirSync(scratchDir).filter((name) => name.endsWith('.staged'))).toEqual([]);
    });
  });

  describe('scoped storage', () => {
    it('releases the scratch files of every object read through the scope when the work ends', async () => {
      await backend.saveObject('uploads/s1.bin', crypto.randomBytes(REMOTE_INLINE_OBJECT_MAX_BYTES + MIB), 'application/octet-stream', 's1.bin');
      await backend.saveObject('uploads/s2.bin', Buffer.from('small'), 'text/plain', 's2.bin');
      const scope = scopeStorageObjects(backend);

      const big = await scope.storage.getObject('uploads/s1.bin');
      const small = await scope.storage.getObject('uploads/s2.bin');
      expect(big?.filePath && fs.existsSync(big.filePath)).toBe(true);
      expect(small?.filePath).toBeUndefined();
      expect(scope.storage.kind).toBe('remote');
      expect((await scope.storage.stat('uploads/s2.bin'))?.size).toBe(5);

      await scope.releaseAll();
      expect(fs.readdirSync(scratchDir).filter((name) => name.endsWith('.staged'))).toEqual([]);
      // Releasing frees only scratch: the objects are still in storage.
      expect(server.objects.has('uploads/s1.bin')).toBe(true);
    });
  });
});
