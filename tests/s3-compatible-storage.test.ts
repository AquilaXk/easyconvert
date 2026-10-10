import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { PayloadTooLargeForMemoryError } from '../src/lib/storage/errors';
import { StorageAdapterError } from '../src/lib/storage/adapters/adapter-interface';
import { S3_MIN_PART_BYTES } from '../src/lib/storage/adapters/s3';
import { S3CompatibleStorage } from '../src/lib/storage/s3-compatible-storage';
import { resolveStorageConfig } from '../src/lib/storage/storage-config';
import { startS3StubServer, s3EtagMd5, type S3StubServer } from './helpers/s3-stub-server';

/**
 * The provider behind STORAGE_DRIVER=oci|s3, run against the signature-verifying stub S3 server
 * (independent SigV4 verifier, see tests/helpers). Nothing is spooled to local disk: every
 * assertion reads what the server stored.
 */

const BUCKET = 'internal-objects';
const REGION = 'ap-seoul-1';
const ACCESS_KEY = 'AKIASTUBEXAMPLE00001';
const SECRET = 'stub/Secret+Key/EXAMPLEKEY0000000000000';
const HTTP_OK = 200;

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

describe('S3CompatibleStorage (IObjectStorage over a real S3 protocol)', () => {
  let server: S3StubServer;
  let storage: S3CompatibleStorage;

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
    storage = new S3CompatibleStorage({
      endpoint: server.url,
      region: REGION,
      bucketName: BUCKET,
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET,
      providerName: 'oci',
      retryBaseDelayMs: 0,
      requestTimeoutMs: 5_000,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('stores a stream on the server with filename, expiry and custom metadata, and reads it back', async () => {
    const body = crypto.randomBytes(70_000);
    const before = Date.now();
    const stored = await storage.putStream('conversions/user_1/report ü.pdf', Readable.from([body]), {
      contentType: 'application/pdf',
      filename: 'Quarterly report ü.pdf',
      customMetadata: { origin: 'unit-test', tenant: 'a b' },
      ttlSeconds: 120,
    });

    expect(stored).toMatchObject({
      key: 'conversions/user_1/report ü.pdf',
      size: body.length,
      etag: `"${s3EtagMd5(body).toString('hex')}"`,
      mimeType: 'application/pdf',
      filename: 'Quarterly report ü.pdf',
      metadata: { origin: 'unit-test', tenant: 'a b' },
    });
    expect(stored.uploadedAt).toBeGreaterThanOrEqual(before);
    expect(stored.expiresAt).toBe(stored.uploadedAt + 120_000);

    // The server holds the bytes and the attributes as ASCII headers.
    const onServer = server.objects.get('conversions/user_1/report ü.pdf');
    expect(onServer?.body.equals(body)).toBe(true);
    expect(onServer?.contentType).toBe('application/pdf');
    expect(onServer?.metadata?.filename).toBe(encodeURIComponent('Quarterly report ü.pdf'));
    expect(onServer?.metadata?.['expires-at']).toBe(String(stored.expiresAt));

    const head = await storage.head('conversions/user_1/report ü.pdf');
    expect(head).toEqual(stored);

    const read = await storage.getStream('conversions/user_1/report ü.pdf');
    expect(read?.metadata).toEqual(stored);
    expect((await readAll(read!.stream)).equals(body)).toBe(true);
  });

  it('serves byte ranges with the whole-object size in the metadata', async () => {
    const body = Buffer.from('S3_COMPATIBLE_BINARY_STREAM_CONTENT_1234567890');
    await storage.putBuffer('s3/payload.bin', body, { contentType: 'application/octet-stream' });

    const read = await storage.getStream('s3/payload.bin', { start: 0, end: 12 });
    expect(read?.range).toEqual({ start: 0, end: 12 });
    expect(read?.metadata.size).toBe(body.length);
    expect((await readAll(read!.stream)).toString('utf-8')).toBe('S3_COMPATIBLE');
  });

  it('returns null for a missing object and reports deletion', async () => {
    expect(await storage.head('nope')).toBeNull();
    expect(await storage.getStream('nope')).toBeNull();
    expect(await storage.getBuffer('nope')).toBeNull();

    await storage.putBuffer('gone', Buffer.from('x'));
    expect(await storage.delete('gone')).toBe(true);
    expect(await storage.head('gone')).toBeNull();
    expect(server.objects.has('gone')).toBe(false);
  });

  it('reads small objects into a buffer and refuses objects over the in-memory limit', async () => {
    await storage.putBuffer('buf/small.bin', Buffer.from('0123456789'));
    expect((await storage.getBuffer('buf/small.bin'))?.toString()).toBe('0123456789');

    vi.stubEnv('MAX_IN_MEMORY_BYTES', '5');
    await expect(storage.getBuffer('buf/small.bin')).rejects.toBeInstanceOf(PayloadTooLargeForMemoryError);
  });

  it('treats an expired object as missing and removes it', async () => {
    await storage.putBuffer('ttl/object.bin', Buffer.from('short lived'), { ttlSeconds: 60 });
    const onServer = server.objects.get('ttl/object.bin');
    expect(onServer).toBeDefined();
    onServer!.metadata = { ...onServer!.metadata, 'expires-at': String(Date.now() - 1) };

    expect(await storage.head('ttl/object.bin')).toBeNull();
    expect(server.objects.has('ttl/object.bin')).toBe(false);

    await storage.putBuffer('ttl/other.bin', Buffer.from('also short'), { ttlSeconds: 60 });
    server.objects.get('ttl/other.bin')!.metadata!['expires-at'] = String(Date.now() - 1);
    expect(await storage.getStream('ttl/other.bin')).toBeNull();
    expect(server.objects.has('ttl/other.bin')).toBe(false);
  });

  it('never expires an object that carries no expires-at attribute', async () => {
    server.objects.set('foreign/object.bin', {
      body: Buffer.from('written by someone else'),
      contentType: 'text/plain',
      etag: `"${s3EtagMd5(Buffer.from('written by someone else')).toString('hex')}"`,
      metadata: {},
    });
    const head = await storage.head('foreign/object.bin');
    expect(head).toMatchObject({ key: 'foreign/object.bin', filename: 'object.bin', expiresAt: 0 });
  });

  it('rejects custom metadata that would not fit in the request headers', async () => {
    await expect(
      storage.putBuffer('meta/huge', Buffer.from('x'), { customMetadata: { blob: 'v'.repeat(2000) } })
    ).rejects.toBeInstanceOf(StorageAdapterError);
    expect(server.requests).toHaveLength(0);
  });

  describe('multipart', () => {
    it('presigns each part against the object store and completes the upload server-side', async () => {
      const key = 'uploads/direct.bin';
      const partA = crypto.randomBytes(S3_MIN_PART_BYTES);
      const partB = crypto.randomBytes(777);

      const session = await storage.createMultipart(key, { contentType: 'application/x-multi', filename: 'direct.bin' });
      expect(session).toMatchObject({ key, partSize: 8 * 1024 * 1024 });
      expect(session.expiresAt).toBeGreaterThan(session.createdAt);

      const etags: string[] = [];
      for (const [index, part] of [partA, partB].entries()) {
        const presigned = await storage.presignPart(key, session.uploadId, index + 1, 300);
        expect(presigned.method).toBe('PUT');
        const url = new URL(presigned.url);
        expect(url.origin).toBe(server.url);
        expect(url.pathname).toBe(`/${BUCKET}/${key}`);
        expect(url.searchParams.get('X-Amz-Credential')?.startsWith(`${ACCESS_KEY}/`)).toBe(true);
        const res = await fetch(presigned.url, { method: 'PUT', body: part });
        expect(res.status).toBe(HTTP_OK);
        etags.push(res.headers.get('etag') as string);
      }

      // Parts may arrive in any order; the provider orders them for S3.
      const stored = await storage.completeMultipart(
        key,
        session.uploadId,
        [
          { partNumber: 2, etag: etags[1] },
          { partNumber: 1, etag: etags[0] },
        ],
        partA.length + partB.length
      );
      expect(stored).toMatchObject({ key, size: partA.length + partB.length, mimeType: 'application/x-multi', filename: 'direct.bin' });
      expect(server.objects.get(key)?.body.equals(Buffer.concat([partA, partB]))).toBe(true);
      for (const request of server.requests) expect(request.auth.ok).toBe(true);
    });

    it('deletes the assembled object and fails when its size differs from the expected size', async () => {
      const key = 'uploads/short.bin';
      const session = await storage.createMultipart(key);
      const presigned = await storage.presignPart(key, session.uploadId, 1, 300);
      const res = await fetch(presigned.url, { method: 'PUT', body: Buffer.from('twelve bytes') });
      const etag = res.headers.get('etag') as string;

      await expect(
        storage.completeMultipart(key, session.uploadId, [{ partNumber: 1, etag }], 1000)
      ).rejects.toThrow('Completed object is 12 bytes but 1000 bytes were expected');
      expect(server.objects.has(key)).toBe(false);
    });

    it('aborts a session so the server forgets its parts', async () => {
      const session = await storage.createMultipart('uploads/abort.bin');
      const presigned = await storage.presignPart('uploads/abort.bin', session.uploadId, 1, 300);
      await fetch(presigned.url, { method: 'PUT', body: Buffer.from('p') });
      expect(server.uploads.size).toBe(1);
      expect(await storage.abortMultipart('uploads/abort.bin', session.uploadId)).toBe(true);
      expect(server.uploads.size).toBe(0);
    });

    it('rejects an out-of-range part number when presigning', async () => {
      await expect(storage.presignPart('uploads/x.bin', 'upload', 0, 300)).rejects.toThrow(
        'Part number must be an integer between 1 and 10000'
      );
      await expect(storage.presignPart('uploads/x.bin', 'upload', 10_001, 300)).rejects.toThrow(
        'Part number must be an integer between 1 and 10000'
      );
    });
  });

  describe('presigned GET', () => {
    it('signs with the configured access key, region and endpoint, and the server accepts it', async () => {
      const body = crypto.randomBytes(2048);
      await storage.putBuffer('dl/file.bin', body);
      const presigned = await storage.presignGet('dl/file.bin', 1200);

      const url = new URL(presigned.url);
      expect(url.origin).toBe(server.url);
      expect(url.searchParams.get('X-Amz-Credential')).toMatch(new RegExp(`^${ACCESS_KEY}/\\d{8}/${REGION}/s3/aws4_request$`));
      expect(url.searchParams.get('X-Amz-Expires')).toBe('1200');
      expect(presigned.method).toBe('GET');
      expect(presigned.signature).toHaveLength(64);
      expect(presigned.expiresAt).toBeGreaterThan(Date.now());

      const res = await fetch(presigned.url);
      expect(res.status).toBe(HTTP_OK);
      expect(Buffer.from(await res.arrayBuffer()).equals(body)).toBe(true);
    });

    it('has no local signature check: the object store verifies its own URLs', () => {
      expect((storage as { verifyPresignedSignature?: unknown }).verifyPresignedSignature).toBeUndefined();
    });
  });

  describe('construction', () => {
    it('is built from validated driver configuration and labels errors with the driver', () => {
      const config = resolveStorageConfig({
        STORAGE_DRIVER: 'oci',
        OCI_NAMESPACE: 'axyz123namespace',
        OCI_REGION: 'ap-seoul-1',
        OCI_BUCKET: 'easyconvert-internal',
        OCI_ACCESS_KEY_ID: ACCESS_KEY,
        OCI_SECRET_ACCESS_KEY: SECRET,
      });
      if (config.driver === 'local') throw new Error('expected a remote configuration');
      const oci = S3CompatibleStorage.fromConfig(config);
      expect(oci.providerName).toBe('oci');
      expect(oci.endpoint).toBe('https://axyz123namespace.compat.objectstorage.ap-seoul-1.oraclecloud.com');
      expect(oci.bucketName).toBe('easyconvert-internal');
    });

    it('refuses to be built without credentials instead of signing with a placeholder', () => {
      expect(
        () =>
          new S3CompatibleStorage({
            endpoint: server.url,
            region: REGION,
            bucketName: BUCKET,
            accessKeyId: '',
            secretAccessKey: '',
          })
      ).toThrow(/accessKeyId and secretAccessKey are required/);
    });
  });
});
