import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { OBJECT_HEADER_BYTES, readObjectHeader } from '../src/lib/storage/object-header';
import { RemoteStorageBackend } from '../src/lib/storage/remote-storage-backend';
import { S3ObjectClient } from '../src/lib/storage/s3-object-client';
import { S3ObjectStorageService } from '../src/lib/storage/s3-storage';
import { startS3StubServer, type S3StubServer } from './helpers/s3-stub-server';

/**
 * readObjectHeader gives the magic-byte check the first bytes of a stored object without reading
 * the rest, on local disk and on an object store alike. The remote leg runs against the
 * signature-verifying stub S3 server and inspects the Range header it received.
 */

const BUCKET = 'internal-objects';
const ACCESS_KEY = 'AKIASTUBEXAMPLE00001';
const SECRET = 'stub/Secret+Key/EXAMPLEKEY0000000000000';

describe('readObjectHeader', () => {
  let server: S3StubServer;
  let remote: RemoteStorageBackend;
  let local: S3ObjectStorageService;

  beforeAll(async () => {
    server = await startS3StubServer({ bucket: BUCKET, credentials: { [ACCESS_KEY]: SECRET } });
    local = new S3ObjectStorageService({ signingSecret: 'object-header-test-signing-secret-0001' });
  });

  afterAll(async () => {
    local.stopGc();
    await server.close();
  });

  beforeEach(() => {
    server.objects.clear();
    server.requests.length = 0;
    remote = new RemoteStorageBackend(
      new S3ObjectClient({
        endpoint: server.url,
        region: 'ap-seoul-1',
        bucket: BUCKET,
        accessKeyId: ACCESS_KEY,
        secretAccessKey: SECRET,
        retryBaseDelayMs: 0,
      }),
      { signingSecret: 'object-header-test-signing-secret-0001' }
    );
  });

  it('reads only the first 64 KiB of a large remote object with one ranged request', async () => {
    const body = crypto.randomBytes(OBJECT_HEADER_BYTES * 3 + 17);
    await remote.saveObject('uploads/big.bin', body, 'application/octet-stream', 'big.bin');
    server.requests.length = 0;

    const header = await readObjectHeader(remote, 'uploads/big.bin');
    expect(header?.equals(body.subarray(0, OBJECT_HEADER_BYTES))).toBe(true);
    const reads = server.requests.filter((r) => r.method === 'GET');
    expect(reads).toHaveLength(1);
    expect(reads[0].headers.range).toBe(`bytes=0-${OBJECT_HEADER_BYTES - 1}`);
  });

  it('returns the whole content of an object shorter than the header size', async () => {
    await remote.saveObject('uploads/small.txt', Buffer.from('%PDF-1.4'), 'application/pdf', 'small.txt');
    const header = await readObjectHeader(remote, 'uploads/small.txt');
    expect(header?.toString()).toBe('%PDF-1.4');
  });

  it('returns an empty buffer for an empty object without a ranged request, and null for a missing one', async () => {
    await remote.saveObject('uploads/empty.bin', Buffer.alloc(0), 'application/octet-stream', 'empty.bin');
    server.requests.length = 0;
    expect((await readObjectHeader(remote, 'uploads/empty.bin'))?.length).toBe(0);
    expect(server.requests.filter((r) => r.method === 'GET')).toHaveLength(0);
    expect(await readObjectHeader(remote, 'uploads/missing.bin')).toBeNull();
  });

  it('honours a smaller limit', async () => {
    await remote.saveObject('uploads/limit.bin', Buffer.from('0123456789'), 'text/plain', 'limit.bin');
    expect((await readObjectHeader(remote, 'uploads/limit.bin', 4))?.toString()).toBe('0123');
  });

  it('reads the header of an object on local disk the same way', async () => {
    const body = crypto.randomBytes(OBJECT_HEADER_BYTES + 100);
    const key = `uploads/local-${Date.now()}.bin`;
    local.saveObject(key, body, 'application/octet-stream', 'local.bin', 60_000);
    const header = await readObjectHeader(local, key);
    expect(header?.equals(body.subarray(0, OBJECT_HEADER_BYTES))).toBe(true);
    expect(await readObjectHeader(local, 'uploads/never-stored.bin')).toBeNull();
    local.deleteObject(key);
  });
});
