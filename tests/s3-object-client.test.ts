import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  S3ObjectClient,
  S3_LIST_PAGE_MAX_KEYS,
  type S3ObjectClientConfig,
} from '../src/lib/storage/s3-object-client';
import {
  StorageAdapterError,
  StorageAuthenticationError,
  StorageNotFoundError,
  StorageServiceError,
} from '../src/lib/storage/adapters/adapter-interface';
import { S3_MAX_PARTS, S3_MIN_PART_BYTES } from '../src/lib/storage/adapters/s3';
import { startS3StubServer, s3EtagMd5, type S3StubServer } from './helpers/s3-stub-server';

/**
 * Oracles, none of them derived from src/:
 * - the AWS-published presigned GET example (fixture copied from the S3 API reference);
 * - tests/helpers/sigv4-verifier.ts, an independent SigV4 verifier written from the AWS
 *   specification, which authenticates every header-signed and query-signed request the client
 *   sends to the stub S3 server in tests/helpers/s3-stub-server.ts;
 * - S3 multipart ETags recomputed here with node:crypto.
 */

const MIB = 1024 * 1024;
const BUCKET = 'internal-objects';
const REGION = 'ap-seoul-1';
const CREDENTIALS = { accessKeyId: 'AKIASTUBEXAMPLE00001', secretAccessKey: 'stub/Secret+Key/EXAMPLEKEY0000000000000' };
const PRESIGN_SECONDS = 300;
const HTTP_FORBIDDEN = 403;
const HTTP_OK = 200;

const presignedGetFixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/sigv4/s3-presigned-get.json'), 'utf-8')
) as { expectedUrl: string; timestamp: string; expiresInSeconds: number; credentials: { accessKeyId: string; secretAccessKey: string } };

function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** S3 multipart ETag per the S3 documentation: MD5 of the concatenated binary part MD5s, then "-<count>". */
function multipartEtag(parts: Buffer[]): string {
  const digests = Buffer.concat(parts.map((part) => s3EtagMd5(part)));
  return `${s3EtagMd5(digests).toString('hex')}-${parts.length}`;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

describe('S3ObjectClient against an independent SigV4-verifying S3 server', () => {
  let server: S3StubServer;
  let client: S3ObjectClient;

  function makeClient(overrides: Partial<S3ObjectClientConfig> = {}): S3ObjectClient {
    return new S3ObjectClient({
      endpoint: server.url,
      region: REGION,
      bucket: BUCKET,
      ...CREDENTIALS,
      providerName: 'oci',
      retryBaseDelayMs: 0,
      requestTimeoutMs: 5_000,
      ...overrides,
    });
  }

  beforeAll(async () => {
    server = await startS3StubServer({ bucket: BUCKET, credentials: { [CREDENTIALS.accessKeyId]: CREDENTIALS.secretAccessKey } });
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    server.objects.clear();
    server.uploads.clear();
    server.requests.length = 0;
    server.faults.length = 0;
    client = makeClient();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('authenticates every request with SigV4 as judged by the independent verifier', async () => {
    await client.putBuffer('probe/a.txt', Buffer.from('a'));
    await client.headObject('probe/a.txt');
    await client.getObject('probe/a.txt').then((got) => readAll(got!.stream));
    await client.listObjects({ prefix: 'probe/' });
    await client.deleteObject('probe/a.txt');
    expect(server.requests.length).toBeGreaterThanOrEqual(5);
    for (const request of server.requests) {
      expect(request.auth, `${request.method} ${request.rawUrl}`).toMatchObject({
        ok: true,
        accessKeyId: CREDENTIALS.accessKeyId,
        region: REGION,
        service: 's3',
      });
    }
  });

  it('is refused by the server when the secret is wrong, so the verifier really judges signatures', async () => {
    const wrong = makeClient({ secretAccessKey: 'not/the/secret' });
    await expect(wrong.putBuffer('x', Buffer.from('x'))).rejects.toBeInstanceOf(StorageAuthenticationError);
    expect(server.objects.size).toBe(0);
  });

  describe('objects', () => {
    it('round-trips bytes, content type and metadata for keys that need URI encoding', async () => {
      const body = crypto.randomBytes(300_000);
      const key = "conversions/user 1/ünï cödé %41 +plus (1)!'*.bin";
      const put = await client.putBuffer(key, body, {
        contentType: 'application/x-test',
        metadata: { filename: 'report%20v1.pdf', 'expires-at': '1791218765000' },
      });
      expect(put).toMatchObject({ size: body.length, contentType: 'application/x-test' });
      expect(put.etag).toBe(s3EtagMd5(body).toString('hex'));
      expect(server.objects.has(key)).toBe(true);

      const head = await client.headObject(key);
      expect(head).toMatchObject({
        key,
        size: body.length,
        etag: s3EtagMd5(body).toString('hex'),
        contentType: 'application/x-test',
        metadata: { filename: 'report%20v1.pdf', 'expires-at': '1791218765000' },
      });
      expect(head?.lastModified?.toISOString()).toBe('2026-10-01T10:00:00.000Z');

      const got = await client.getObject(key);
      expect(got).not.toBeNull();
      expect(sha256(await readAll(got!.stream))).toBe(sha256(body));

      expect(await client.deleteObject(key)).toBe(true);
      expect(await client.headObject(key)).toBeNull();
      expect(await client.getObject(key)).toBeNull();
      for (const request of server.requests) expect(request.auth.ok).toBe(true);
    });

    it('signs the payload hash of buffers and leaves a streamed body unsigned', async () => {
      const body = Buffer.from('payload hash probe');
      await client.putBuffer('hash/buffer.txt', body);
      await client.putStream('hash/stream.txt', Readable.from([body]), { size: body.length });
      const [buffered, streamed] = server.requests.filter((r) => r.method === 'PUT');
      expect(buffered.headers['x-amz-content-sha256']).toBe(sha256(body));
      expect(streamed.headers['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD');
      expect(server.objects.get('hash/stream.txt')?.body.equals(body)).toBe(true);
    });

    it('rejects keys that URL parsers would collapse or that are empty', async () => {
      await expect(client.putBuffer('a/../b', Buffer.from('x'))).rejects.toBeInstanceOf(StorageAdapterError);
      await expect(client.getObject('')).rejects.toBeInstanceOf(StorageAdapterError);
      await expect(client.headObject('./x')).rejects.toBeInstanceOf(StorageAdapterError);
      expect(server.requests).toHaveLength(0);
    });

    it('rejects metadata the wire cannot carry', async () => {
      await expect(client.putBuffer('m', Buffer.from('x'), { metadata: { 'Bad Name': 'v' } })).rejects.toBeInstanceOf(
        StorageAdapterError
      );
      await expect(client.putBuffer('m', Buffer.from('x'), { metadata: { ok: 'line\nbreak' } })).rejects.toBeInstanceOf(
        StorageAdapterError
      );
      await expect(
        client.putBuffer('m', Buffer.from('x'), { metadata: { big: 'v'.repeat(3000) } })
      ).rejects.toBeInstanceOf(StorageAdapterError);
      expect(server.requests).toHaveLength(0);
    });
  });

  describe('range reads', () => {
    const body = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));

    beforeEach(async () => {
      await client.putBuffer('range/blob.bin', body);
    });

    it.each([
      [0, 0],
      [0, 99],
      [250, 749],
      [900, 999],
      [990, 5000],
    ])('serves bytes %i-%i as a 206 slice of the object', async (start, end) => {
      const got = await client.getObject('range/blob.bin', { start, end });
      expect(got).not.toBeNull();
      const expectedEnd = Math.min(end, body.length - 1);
      expect(await readAll(got!.stream)).toEqual(body.subarray(start, expectedEnd + 1));
      expect(got!.range).toEqual({ start, end: expectedEnd, total: body.length });
      expect(got!.size).toBe(body.length);
      const request = server.requests[server.requests.length - 1];
      expect(request.headers.range).toBe(`bytes=${start}-${end}`);
    });

    it('fails with a typed error when the range starts past the end', async () => {
      const error = await client.getObject('range/blob.bin', { start: 1000, end: 1001 }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StorageServiceError);
      expect((error as StorageServiceError).statusCode).toBe(416);
      expect((error as StorageServiceError).retryable).toBe(false);
    });

    it('refuses a server that ignores the Range header instead of serving the whole object', async () => {
      server.faults.push({
        match: (req) => req.method === 'GET' && req.key === 'range/blob.bin',
        status: HTTP_OK,
        errorIn200: true,
        body: 'the whole object',
        times: 1,
      });
      const error = await client.getObject('range/blob.bin', { start: 0, end: 9 }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StorageServiceError);
      expect((error as StorageServiceError).code).toBe('RangeNotHonored');
    });

    it.each([
      [-1, 5],
      [5, 4],
      [1.5, 3],
      [0, Number.MAX_SAFE_INTEGER + 2],
    ])('rejects the invalid range %s-%s before sending anything', async (start, end) => {
      server.requests.length = 0;
      await expect(client.getObject('range/blob.bin', { start, end })).rejects.toBeInstanceOf(StorageAdapterError);
      expect(server.requests).toHaveLength(0);
    });
  });

  describe('listing', () => {
    beforeEach(async () => {
      for (let i = 0; i < 25; i++) {
        await client.putBuffer(`results/job-${String(i).padStart(2, '0')}/out.bin`, Buffer.from(`r${i}`));
      }
      await client.putBuffer('uploads/other.bin', Buffer.from('u'));
    });

    it('follows continuation tokens page by page and returns each object once, in key order', async () => {
      const first = await client.listObjects({ prefix: 'results/', maxKeys: 10 });
      expect(first.objects).toHaveLength(10);
      expect(first.isTruncated).toBe(true);
      expect(first.nextContinuationToken).toBeTruthy();
      expect(first.objects[0]).toMatchObject({ key: 'results/job-00/out.bin', size: 2 });

      const listed: string[] = [];
      for await (const object of client.listAll('results/', 100)) listed.push(object.key);
      expect(listed).toEqual(Array.from({ length: 25 }, (_, i) => `results/job-${String(i).padStart(2, '0')}/out.bin`));
    });

    it('bounds a walk by maxObjects instead of listing without limit', async () => {
      const walk = async () => {
        const seen: string[] = [];
        for await (const object of client.listAll('results/', 24)) seen.push(object.key);
        return seen;
      };
      await expect(walk()).rejects.toThrow(/More than 24 objects/);
    });

    it('rejects a page size outside 1..1000 before sending anything', async () => {
      server.requests.length = 0;
      await expect(client.listObjects({ maxKeys: 0 })).rejects.toBeInstanceOf(StorageAdapterError);
      await expect(client.listObjects({ maxKeys: S3_LIST_PAGE_MAX_KEYS + 1 })).rejects.toBeInstanceOf(StorageAdapterError);
      expect(server.requests).toHaveLength(0);
    });

    it('rejects a truncated page that carries no continuation token', async () => {
      server.faults.push({
        match: (req) => req.method === 'GET' && req.query.get('list-type') === '2',
        status: HTTP_OK,
        errorIn200: true,
        body: '<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>',
        times: 1,
      });
      await expect(client.listObjects()).rejects.toMatchObject({ code: 'MalformedResponse' });
    });

    it('refuses a listing that declares a DTD', async () => {
      server.faults.push({
        match: (req) => req.method === 'GET' && req.query.get('list-type') === '2',
        status: HTTP_OK,
        errorIn200: true,
        body: '<!DOCTYPE x [<!ENTITY a "b">]><ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>',
        times: 1,
      });
      await expect(client.listObjects()).rejects.toMatchObject({ code: 'MalformedXML' });
    });
  });

  describe('multipart uploads', () => {
    it('creates, uploads, lists, completes and yields the documented multipart ETag', async () => {
      const key = 'uploads/multipart.bin';
      const partA = crypto.randomBytes(S3_MIN_PART_BYTES);
      const partB = crypto.randomBytes(1234);
      const uploadId = await client.createMultipartUpload(key, { contentType: 'application/x-multi' });
      expect(uploadId).toMatch(/^stub-upload-\d+$/);

      const etagA = (await client.uploadPart(key, uploadId, 1, partA)).etag;
      const etagB = (await client.uploadPart(key, uploadId, 2, partB)).etag;
      expect(etagA.replace(/"/g, '')).toBe(s3EtagMd5(partA).toString('hex'));

      const listed = await client.listParts(key, uploadId);
      // Part ETags are opaque tokens that complete echoes back, so they are reported as the server sent them.
      expect(listed).toEqual([
        { partNumber: 1, size: partA.length, etag: `"${s3EtagMd5(partA).toString('hex')}"` },
        { partNumber: 2, size: partB.length, etag: `"${s3EtagMd5(partB).toString('hex')}"` },
      ]);

      const completed = await client.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag: etagA },
        { partNumber: 2, etag: etagB },
      ]);
      expect(completed.etag).toBe(multipartEtag([partA, partB]));
      expect(server.objects.get(key)?.body.equals(Buffer.concat([partA, partB]))).toBe(true);
      expect(server.uploads.size).toBe(0);
      for (const request of server.requests) expect(request.auth.ok).toBe(true);
    });

    it('uploads a part from a stream of declared length', async () => {
      const key = 'uploads/streamed-part.bin';
      const part = crypto.randomBytes(S3_MIN_PART_BYTES + 7);
      const uploadId = await client.createMultipartUpload(key);
      const { etag } = await client.uploadPart(key, uploadId, 1, Readable.from([part.subarray(0, 1000), part.subarray(1000)]), part.length);
      await client.completeMultipartUpload(key, uploadId, [{ partNumber: 1, etag }]);
      expect(server.objects.get(key)?.body.equals(part)).toBe(true);
      const upload = server.requests.find((r) => r.method === 'PUT' && r.query.has('partNumber'))!;
      expect(upload.headers['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD');
    });

    it('aborts an upload and the server forgets its parts', async () => {
      const key = 'uploads/aborted.bin';
      const uploadId = await client.createMultipartUpload(key);
      await client.uploadPart(key, uploadId, 1, Buffer.from('part'));
      expect(server.uploads.size).toBe(1);
      await client.abortMultipartUpload(key, uploadId);
      expect(server.uploads.size).toBe(0);
      await expect(client.listParts(key, uploadId)).rejects.toMatchObject({ code: 'NoSuchUpload' });
    });

    it('pages ListParts with part-number-marker', async () => {
      const key = 'uploads/many-parts.bin';
      const uploadId = await client.createMultipartUpload(key);
      for (let n = 1; n <= 1005; n++) {
        server.uploads.get(uploadId)!.set(n, Buffer.from([n % 256]));
      }
      const listed = await client.listParts(key, uploadId);
      expect(listed).toHaveLength(1005);
      expect(listed[0].partNumber).toBe(1);
      expect(listed[1004]).toMatchObject({ partNumber: 1005, size: 1 });
      const listRequests = server.requests.filter((r) => r.method === 'GET' && r.query.has('uploadId'));
      expect(listRequests).toHaveLength(2);
      expect(listRequests[1].query.get('part-number-marker')).toBe('1000');
    });

    it.each([
      ['no parts', []],
      ['descending parts', [{ partNumber: 2, etag: 'a' }, { partNumber: 1, etag: 'b' }]],
      ['duplicate parts', [{ partNumber: 1, etag: 'a' }, { partNumber: 1, etag: 'b' }]],
      ['part number 0', [{ partNumber: 0, etag: 'a' }]],
      ['part number past 10,000', [{ partNumber: S3_MAX_PARTS + 1, etag: 'a' }]],
      ['a part without an ETag', [{ partNumber: 1, etag: '' }]],
    ])('refuses to complete with %s before sending anything', async (_name, parts) => {
      server.requests.length = 0;
      await expect(client.completeMultipartUpload('k', 'upload', parts)).rejects.toBeInstanceOf(StorageAdapterError);
      expect(server.requests).toHaveLength(0);
    });

    it('refuses part numbers outside 1..10,000 and parts without a known length', async () => {
      server.requests.length = 0;
      await expect(client.uploadPart('k', 'u', 0, Buffer.from('x'))).rejects.toBeInstanceOf(StorageAdapterError);
      await expect(client.uploadPart('k', 'u', S3_MAX_PARTS + 1, Buffer.from('x'))).rejects.toBeInstanceOf(
        StorageAdapterError
      );
      await expect(client.uploadPart('k', 'u', 1, Readable.from(['x']))).rejects.toBeInstanceOf(StorageAdapterError);
      expect(server.requests).toHaveLength(0);
    });

    it('reports a 200 answer that carries an <Error> as a failure', async () => {
      const key = 'uploads/error-in-200.bin';
      const uploadId = await client.createMultipartUpload(key);
      const { etag } = await client.uploadPart(key, uploadId, 1, Buffer.from('p'));
      server.faults.push({
        match: (req) => req.method === 'POST' && req.query.has('uploadId'),
        status: HTTP_OK,
        errorIn200: true,
        code: 'InternalError',
        times: Infinity,
      });
      const error = await client.completeMultipartUpload(key, uploadId, [{ partNumber: 1, etag }]).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StorageServiceError);
      expect((error as StorageServiceError).code).toBe('InternalError');
      expect(server.objects.has(key)).toBe(false);
    });
  });

  describe('streaming uploads', () => {
    it('sends a stream of unknown length larger than one part as a multipart upload and aborts nothing on success', async () => {
      const body = crypto.randomBytes(2 * S3_MIN_PART_BYTES + 4321);
      const small = makeClient({ partSizeBytes: S3_MIN_PART_BYTES });
      const result = await small.putStream('stream/big.bin', Readable.from([body.subarray(0, 700_000), body.subarray(700_000)]), {
        contentType: 'application/octet-stream',
      });
      expect(result.size).toBe(body.length);
      expect(result.etag).toBe(
        multipartEtag([
          body.subarray(0, S3_MIN_PART_BYTES),
          body.subarray(S3_MIN_PART_BYTES, 2 * S3_MIN_PART_BYTES),
          body.subarray(2 * S3_MIN_PART_BYTES),
        ])
      );
      expect(sha256(server.objects.get('stream/big.bin')!.body)).toBe(sha256(body));
      expect(server.requests.some((r) => r.method === 'DELETE')).toBe(false);
    });

    it('sends a stream that fits one part as a single PutObject', async () => {
      const body = crypto.randomBytes(100_000);
      const result = await client.putStream('stream/small.bin', Readable.from([body]));
      expect(result).toMatchObject({ size: body.length, etag: s3EtagMd5(body).toString('hex') });
      expect(server.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
    });

    describe('a source stream that cannot be replayed is closed when the upload fails', () => {
      const ATTEMPT_ONCE = 1;
      const LARGE_SOURCE_BYTES = 6 * MIB;
      let spoolDir: string;

      beforeEach(() => {
        spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-source-stream-'));
      });

      afterEach(() => {
        fs.rmSync(spoolDir, { recursive: true, force: true });
      });

      /** Resolves once the stream is closed; a file stream then holds no descriptor (`fd` is null). */
      async function closedFd(stream: fs.ReadStream): Promise<number | null> {
        await new Promise<void>((resolve) => {
          if (stream.closed) resolve();
          else stream.once('close', () => resolve());
        });
        return stream.fd;
      }

      for (const [status, code] of [
        [503, 'SlowDown'],
        [403, 'AccessDenied'],
      ] as const) {
        it(`closes a file stream after the store answers ${status}`, async () => {
          const file = path.join(spoolDir, 'source.bin');
          // Large enough that the store answers before the body has been read to its end.
          fs.writeFileSync(file, Buffer.alloc(LARGE_SOURCE_BYTES, 7));
          server.faults.push({ match: (req) => req.method === 'PUT', status, code, times: Infinity });
          const source = fs.createReadStream(file);
          await expect(
            makeClient({ maxAttempts: ATTEMPT_ONCE }).putStream('stream/fail.bin', source, { size: LARGE_SOURCE_BYTES })
          ).rejects.toMatchObject({ provider: 'oci', name: status === 503 ? 'StorageServiceError' : 'StorageAuthenticationError' });
          expect(await closedFd(source)).toBeNull();
        });
      }

      it('closes a file stream when the store cannot be reached at all', async () => {
        const file = path.join(spoolDir, 'source.bin');
        fs.writeFileSync(file, Buffer.alloc(1000, 7));
        const source = fs.createReadStream(file);
        const unreachable = makeClient({ endpoint: 'http://127.0.0.1:1', maxAttempts: ATTEMPT_ONCE });
        await expect(unreachable.putStream('stream/fail.bin', source, { size: 1000 })).rejects.toMatchObject({
          provider: 'oci',
          name: 'StorageServiceError',
          retryable: true,
        });
        expect(await closedFd(source)).toBeNull();
      });

      it('closes a part stream the store refused', async () => {
        const upload = await client.createMultipartUpload('stream/part.bin');
        const file = path.join(spoolDir, 'part.bin');
        fs.writeFileSync(file, Buffer.alloc(2000, 7));
        const source = fs.createReadStream(file);
        server.faults.push({ match: (req) => req.method === 'PUT', status: 403, code: 'AccessDenied', times: Infinity });
        await expect(client.uploadPart('stream/part.bin', upload, 1, source, 2000)).rejects.toBeInstanceOf(StorageAuthenticationError);
        expect(await closedFd(source)).toBeNull();
      });
    });

    it('stores an empty stream as an empty object', async () => {
      const result = await client.putStream('stream/empty.bin', Readable.from([]));
      expect(result.size).toBe(0);
      expect(server.objects.get('stream/empty.bin')?.body.length).toBe(0);
    });

    it('aborts the multipart upload and surfaces a typed error when the source stream fails', async () => {
      async function* failing(): AsyncGenerator<Buffer> {
        yield crypto.randomBytes(S3_MIN_PART_BYTES + 10);
        yield crypto.randomBytes(S3_MIN_PART_BYTES + 10);
        throw new Error('source disk read failed');
      }
      const small = makeClient({ partSizeBytes: S3_MIN_PART_BYTES });
      const error = await small.putStream('stream/broken.bin', Readable.from(failing())).catch((e: unknown) => e);
      expect(server.requests.some((r) => r.method === 'POST' && r.query.has('uploads'))).toBe(true);
      expect(error).toBeInstanceOf(StorageServiceError);
      expect((error as StorageServiceError).retryable).toBe(false);
      expect(server.uploads.size).toBe(0);
      expect(server.objects.has('stream/broken.bin')).toBe(false);
    });

    it('rejects a negative or fractional declared size before sending anything', async () => {
      await expect(client.putStream('s', Readable.from([]), { size: -1 })).rejects.toThrow('Invalid upload size: -1');
      await expect(client.putStream('s', Readable.from([]), { size: 1.5 })).rejects.toThrow('Invalid upload size: 1.5');
      expect(server.requests).toHaveLength(0);
    });
  });

  describe('errors and retries', () => {
    it('retries transient server errors on replayable requests and then succeeds', async () => {
      server.faults.push({ match: (req) => req.method === 'PUT', status: 503, code: 'SlowDown', times: 2 });
      await client.putBuffer('retry/ok.txt', Buffer.from('eventually'));
      expect(server.requests.filter((r) => r.method === 'PUT')).toHaveLength(3);
      expect(server.objects.get('retry/ok.txt')?.body.toString()).toBe('eventually');
    });

    it('gives up after the attempt budget with a retryable typed error', async () => {
      const limited = makeClient({ maxAttempts: 2 });
      server.faults.push({ match: () => true, status: 500, code: 'InternalError', times: Infinity });
      const error = await limited.putBuffer('retry/fail.txt', Buffer.from('x')).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StorageServiceError);
      expect((error as StorageServiceError).retryable).toBe(true);
      expect(server.requests).toHaveLength(2);
    });

    it('does not retry a stream that was already consumed', async () => {
      server.faults.push({ match: (req) => req.method === 'PUT', status: 503, code: 'SlowDown', times: Infinity });
      const error = await client.putStream('retry/stream.txt', Readable.from([Buffer.from('abc')]), { size: 3 }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StorageServiceError);
      expect(server.requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
    });

    it('maps a missing bucket to not-found without retrying', async () => {
      const wrongBucket = makeClient({ bucket: 'no-such-bucket' });
      await expect(wrongBucket.putBuffer('k', Buffer.from('x'))).rejects.toBeInstanceOf(StorageNotFoundError);
      expect(server.requests).toHaveLength(1);
    });

    it('times out a response that never finishes with a typed timeout', async () => {
      const impatient = makeClient({ requestTimeoutMs: 150, maxAttempts: 1 });
      server.faults.push({ match: (req) => req.method === 'HEAD', status: 200, delayMs: 2_000, times: 1 });
      await expect(impatient.headObject('slow')).rejects.toMatchObject({ name: 'StorageTimeoutError' });
    });

    it('does not follow redirects', async () => {
      server.faults.push({ match: () => true, status: 307, code: 'TemporaryRedirect', times: 1 });
      const error = await client.putBuffer('redirect', Buffer.from('x')).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StorageServiceError);
      expect((error as StorageServiceError).statusCode).toBe(307);
    });
  });

  describe('presigned URLs', () => {
    it('reproduces the AWS-published presigned GET example byte for byte (virtual-hosted style)', () => {
      const awsClient = new S3ObjectClient({
        endpoint: 'https://s3.amazonaws.com',
        region: 'us-east-1',
        bucket: 'examplebucket',
        forcePathStyle: false,
        ...presignedGetFixture.credentials,
      });
      const presigned = awsClient.presignGetUrl('test.txt', presignedGetFixture.expiresInSeconds, {
        now: new Date(presignedGetFixture.timestamp),
      });
      expect(presigned.url).toBe(presignedGetFixture.expectedUrl);
      expect(presigned.signature).toBe('aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
      expect(presigned.expiresAt).toBe(Date.parse(presignedGetFixture.timestamp) + 86_400_000);
    });

    it('addresses OCI Object Storage path-style on the namespace compat host with the real access key', () => {
      const oci = new S3ObjectClient({
        endpoint: 'https://axyz123.compat.objectstorage.ap-seoul-1.oraclecloud.com',
        region: 'ap-seoul-1',
        bucket: 'easyconvert-internal',
        ...CREDENTIALS,
      });
      const url = new URL(oci.presignGetUrl('results/job 1/out.pdf', 600, { now: new Date('2026-10-05T00:00:00Z') }).url);
      expect(url.origin).toBe('https://axyz123.compat.objectstorage.ap-seoul-1.oraclecloud.com');
      expect(url.pathname).toBe('/easyconvert-internal/results/job%201/out.pdf');
      expect(url.searchParams.get('X-Amz-Credential')).toBe(
        `${CREDENTIALS.accessKeyId}/20261005/ap-seoul-1/s3/aws4_request`
      );
      expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    });

    it('serves a presigned GET to a plain HTTP client and carries the response disposition', async () => {
      const body = crypto.randomBytes(5000);
      await client.putBuffer('dl/file.bin', body);
      const presigned = client.presignGetUrl('dl/file.bin', PRESIGN_SECONDS, {
        responseContentDisposition: 'attachment; filename="file.bin"',
      });
      expect(new URL(presigned.url).searchParams.get('response-content-disposition')).toBe('attachment; filename="file.bin"');
      const res = await fetch(presigned.url);
      expect(res.status).toBe(HTTP_OK);
      expect(Buffer.from(await res.arrayBuffer()).equals(body)).toBe(true);
      const served = server.requests[server.requests.length - 1];
      expect(served.auth).toMatchObject({ ok: true, accessKeyId: CREDENTIALS.accessKeyId, payloadHash: 'UNSIGNED-PAYLOAD' });
    });

    it('lets a plain HTTP client PUT whole objects and individual parts through presigned URLs', async () => {
      const put = client.presignPutUrl('up/whole.bin', PRESIGN_SECONDS);
      const body = crypto.randomBytes(2048);
      const putRes = await fetch(put.url, { method: 'PUT', body });
      expect(putRes.status).toBe(HTTP_OK);
      expect(server.objects.get('up/whole.bin')?.body.equals(body)).toBe(true);

      const key = 'up/parts.bin';
      const uploadId = await client.createMultipartUpload(key);
      const part = crypto.randomBytes(S3_MIN_PART_BYTES);
      const partUrl = client.presignUploadPartUrl(key, uploadId, 1, PRESIGN_SECONDS);
      const parsed = new URL(partUrl.url);
      expect(parsed.searchParams.get('partNumber')).toBe('1');
      expect(parsed.searchParams.get('uploadId')).toBe(uploadId);
      const partRes = await fetch(partUrl.url, { method: 'PUT', body: part });
      expect(partRes.status).toBe(HTTP_OK);
      const etag = partRes.headers.get('etag')!;
      expect(etag.replace(/"/g, '')).toBe(s3EtagMd5(part).toString('hex'));
      await client.completeMultipartUpload(key, uploadId, [{ partNumber: 1, etag }]);
      expect(server.objects.get(key)?.body.equals(part)).toBe(true);
    });

    it('is rejected by the server when tampered with, used with another method, or expired', async () => {
      await client.putBuffer('sec/file.bin', Buffer.from('secret'));
      const good = client.presignGetUrl('sec/file.bin', PRESIGN_SECONDS);
      expect((await fetch(good.url)).status).toBe(HTTP_OK);

      const tampered = good.url.replace(/X-Amz-Signature=[0-9a-f]{2}/, 'X-Amz-Signature=00');
      expect((await fetch(tampered)).status).toBe(HTTP_FORBIDDEN);

      const otherKey = good.url.replace('sec/file.bin', 'sec/other.bin');
      expect((await fetch(otherKey)).status).toBe(HTTP_FORBIDDEN);

      expect((await fetch(good.url, { method: 'PUT', body: 'overwrite' })).status).toBe(HTTP_FORBIDDEN);
      expect(server.objects.get('sec/file.bin')?.body.toString()).toBe('secret');

      const expired = client.presignGetUrl('sec/file.bin', 60, { now: new Date(Date.now() - 3_600_000) });
      expect((await fetch(expired.url)).status).toBe(HTTP_FORBIDDEN);

      const strangerKey = makeClient({ secretAccessKey: 'another/secret' }).presignGetUrl('sec/file.bin', PRESIGN_SECONDS);
      expect((await fetch(strangerKey.url)).status).toBe(HTTP_FORBIDDEN);
    });

    it.each([0, -5, 1.5, 604_801, Number.NaN])('rejects the presign expiry %s', (seconds) => {
      expect(() => client.presignGetUrl('k', seconds)).toThrow(StorageAdapterError);
      expect(() => client.presignPutUrl('k', seconds)).toThrow(StorageAdapterError);
    });

    it('never signs with a placeholder key: the credential scope is always the configured access key', () => {
      const url = new URL(client.presignGetUrl('k', PRESIGN_SECONDS).url);
      expect(url.searchParams.get('X-Amz-Credential')?.startsWith(`${CREDENTIALS.accessKeyId}/`)).toBe(true);
      expect(url.href).not.toContain('DEV_ACCESS_KEY_ID');
    });
  });

  describe('configuration', () => {
    const base: S3ObjectClientConfig = {
      endpoint: 'https://ns.compat.objectstorage.ap-seoul-1.oraclecloud.com',
      region: REGION,
      bucket: BUCKET,
      ...CREDENTIALS,
    };

    it('requires https for the endpoint in production but allows a local http server otherwise', () => {
      vi.stubEnv('NODE_ENV', 'production');
      expect(() => new S3ObjectClient({ ...base, endpoint: 'http://127.0.0.1:9000' })).toThrow(/https in production/);
      expect(() => new S3ObjectClient(base)).not.toThrow();
      vi.stubEnv('NODE_ENV', 'development');
      expect(() => new S3ObjectClient({ ...base, endpoint: 'http://127.0.0.1:9000' })).not.toThrow();
    });

    it.each([
      ['an empty access key', { accessKeyId: '' }],
      ['an empty secret key', { secretAccessKey: '' }],
      ['an empty bucket', { bucket: '' }],
      ['an empty region', { region: '' }],
      ['an empty endpoint', { endpoint: '' }],
      ['an endpoint that is not a URL', { endpoint: 'not a url' }],
      ['an endpoint with user info', { endpoint: 'https://user:pw@host.example' }],
      ['an endpoint with a non-http scheme', { endpoint: 'ftp://host.example' }],
      ['an invalid bucket name', { bucket: 'UPPER_case' }],
      ['a part size under 5 MiB', { partSizeBytes: 5 * MIB - 1 }],
      ['a part size over 5 GiB', { partSizeBytes: 5 * 1024 * MIB + 1 }],
      ['a fractional part size', { partSizeBytes: 5 * MIB + 0.5 }],
    ] as Array<[string, Partial<S3ObjectClientConfig>]>)('throws typed for %s', (_name, override) => {
      expect(() => new S3ObjectClient({ ...base, ...override })).toThrow(StorageAdapterError);
    });
  });
});

/**
 * Real-server leg. It needs an S3-compatible server that verifies SigV4 itself (MinIO, or the
 * OCI compat endpoint of a scratch bucket), described by environment variables. Without them the
 * leg is skipped; under ORACLE_STRICT_MODE=1 its absence is a failure, because a green strict run
 * must mean the client was checked against a server it did not write.
 */
const REAL_ENDPOINT = process.env.STORAGE_TEST_S3_ENDPOINT;
const REAL_ACCESS_KEY = process.env.STORAGE_TEST_S3_ACCESS_KEY_ID;
const REAL_SECRET_KEY = process.env.STORAGE_TEST_S3_SECRET_ACCESS_KEY;
const REAL_BUCKET = process.env.STORAGE_TEST_S3_BUCKET ?? 'easyconvert-client-test';
const REAL_REGION = process.env.STORAGE_TEST_S3_REGION ?? 'us-east-1';
const REAL_CONFIGURED = Boolean(REAL_ENDPOINT && REAL_ACCESS_KEY && REAL_SECRET_KEY);
const STRICT = process.env.ORACLE_STRICT_MODE === '1';

describe.skipIf(!REAL_CONFIGURED && !STRICT)('S3ObjectClient against a real S3-compatible server', () => {
  if (!REAL_CONFIGURED) {
    it('requires STORAGE_TEST_S3_ENDPOINT, STORAGE_TEST_S3_ACCESS_KEY_ID and STORAGE_TEST_S3_SECRET_ACCESS_KEY', () => {
      throw new Error(
        'ORACLE_STRICT_MODE=1 requires an S3-compatible test server: set STORAGE_TEST_S3_ENDPOINT, ' +
          'STORAGE_TEST_S3_ACCESS_KEY_ID and STORAGE_TEST_S3_SECRET_ACCESS_KEY (CI service container, see #476).'
      );
    });
    return;
  }

  let real: S3ObjectClient;
  const prefix = `client-test-${crypto.randomBytes(4).toString('hex')}/`;

  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { signS3Request, EMPTY_PAYLOAD_SHA256 } = await import('../src/lib/storage/s3-sigv4');
    const signed = signS3Request({
      method: 'PUT',
      origin: REAL_ENDPOINT as string,
      path: `/${REAL_BUCKET}`,
      payloadHash: EMPTY_PAYLOAD_SHA256,
      credentials: { accessKeyId: REAL_ACCESS_KEY as string, secretAccessKey: REAL_SECRET_KEY as string },
      region: REAL_REGION,
    });
    const created = await fetch(signed.url, { method: 'PUT', headers: signed.headers });
    // 200 on create, 409 when the bucket already exists and is ours.
    expect([200, 409]).toContain(created.status);
    real = new S3ObjectClient({
      endpoint: REAL_ENDPOINT as string,
      region: REAL_REGION,
      bucket: REAL_BUCKET,
      accessKeyId: REAL_ACCESS_KEY as string,
      secretAccessKey: REAL_SECRET_KEY as string,
      partSizeBytes: S3_MIN_PART_BYTES,
    });
  });

  afterAll(async () => {
    if (!real) return;
    for await (const object of real.listAll(prefix, 1000)) {
      await real.deleteObject(object.key);
    }
    vi.unstubAllEnvs();
  });

  it('round-trips an object with a range read, metadata and a listing', async () => {
    const body = crypto.randomBytes(100_000);
    const key = `${prefix}dir/ünï file+1.bin`;
    await real.putBuffer(key, body, { contentType: 'application/x-real', metadata: { filename: 'a.bin' } });
    const head = await real.headObject(key);
    expect(head).toMatchObject({ size: body.length, contentType: 'application/x-real' });
    expect(head?.metadata.filename).toBe('a.bin');

    const slice = await real.getObject(key, { start: 10, end: 99 });
    expect(await readAll(slice!.stream)).toEqual(body.subarray(10, 100));
    expect(slice!.range).toEqual({ start: 10, end: 99, total: body.length });

    const listed: string[] = [];
    for await (const object of real.listAll(prefix, 100)) listed.push(object.key);
    expect(listed).toContain(key);
    expect(await real.deleteObject(key)).toBe(true);
    expect(await real.headObject(key)).toBeNull();
  });

  it('assembles a multipart object from streamed parts with the documented ETag and serves a presigned GET', async () => {
    const body = crypto.randomBytes(2 * S3_MIN_PART_BYTES + 99);
    const key = `${prefix}multipart.bin`;
    const result = await real.putStream(key, Readable.from([body]));
    expect(result.etag).toBe(
      multipartEtag([
        body.subarray(0, S3_MIN_PART_BYTES),
        body.subarray(S3_MIN_PART_BYTES, 2 * S3_MIN_PART_BYTES),
        body.subarray(2 * S3_MIN_PART_BYTES),
      ])
    );
    const got = await real.getObject(key);
    expect(sha256(await readAll(got!.stream))).toBe(sha256(body));

    const presigned = real.presignGetUrl(key, PRESIGN_SECONDS);
    const res = await fetch(presigned.url);
    expect(res.status).toBe(HTTP_OK);
    expect(sha256(Buffer.from(await res.arrayBuffer()))).toBe(sha256(body));
  });
});
