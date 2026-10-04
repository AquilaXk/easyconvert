import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { S3StorageAdapter, S3_DEV_ENDPOINT_ALLOWLIST_ENV, parseS3ErrorXml } from '../src/lib/storage/adapters/s3';
import {
  StorageAdapterError,
  StorageAuthenticationError,
  StorageNotFoundError,
  StorageServiceError,
  StorageSsrfError,
  StorageTimeoutError,
} from '../src/lib/storage/adapters/adapter-interface';
import { startS3StubServer, type S3StubServer } from './helpers/s3-stub-server';
import { verifySigV4Request } from './helpers/sigv4-verifier';
import testCredentials from './fixtures/sigv4/test-credentials.json';

/**
 * Oracle: a node:http S3 stub that authenticates every request with an independently written
 * SigV4 verifier (tests/helpers/sigv4-verifier.ts) and stores the bytes it actually received.
 * The verifier itself is first checked against the published S3 GET Object example.
 */

const MIB = 1024 * 1024;
const BUCKET = 'byos-bucket';
const ACCESS_KEY = testCredentials.adapterStub.accessKeyId;
const SECRET = testCredentials.adapterStub.secretAccessKey;
const MIN_PART = 5 * MIB;

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

/** Streams a buffer in small slices so the adapter has to reassemble parts itself. */
function sliced(buf: Buffer, slice = 64 * 1024): Readable {
  const pieces: Buffer[] = [];
  for (let i = 0; i < buf.length; i += slice) pieces.push(buf.subarray(i, i + slice));
  return Readable.from(pieces);
}

const PUBLISHED = testCredentials.published;

describe('independent SigV4 verifier', () => {
  // Amazon S3 API Reference, header-based auth GET Object example (documented example key).
  const published = {
    method: 'GET',
    rawUrl: '/test.txt',
    headers: {
      host: 'examplebucket.s3.amazonaws.com',
      range: 'bytes=0-9',
      'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'x-amz-date': '20130524T000000Z',
      authorization:
        `AWS4-HMAC-SHA256 Credential=${PUBLISHED.accessKeyId}/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41`,
    },
    body: Buffer.alloc(0),
    secretFor: (id: string) => (id === PUBLISHED.accessKeyId ? PUBLISHED.secretAccessKey : undefined),
  };

  it('accepts the published GET Object example', () => {
    expect(verifySigV4Request(published)).toMatchObject({ ok: true, region: 'us-east-1', service: 's3' });
  });

  it('rejects the example once a signed header changes', () => {
    const tampered = { ...published, headers: { ...published.headers, range: 'bytes=0-10' } };
    expect(verifySigV4Request(tampered)).toMatchObject({ ok: false, reason: 'signature mismatch' });
  });
});

/** An external-entity (XXE) payload: a parser that honoured the DTD would read a local file. */
const DTD_ERROR_DOCUMENT =
  '<?xml version="1.0"?><!DOCTYPE Error [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
  '<Error><Code>NoSuchKey</Code><Message>&xxe;</Message><RequestId>R1</RequestId></Error>';

describe('S3 XML handling refuses DTDs', () => {
  it('extracts nothing from an error document that declares a DTD or entities', () => {
    expect(parseS3ErrorXml(DTD_ERROR_DOCUMENT)).toEqual({});
    expect(parseS3ErrorXml('<!ENTITY a "b"><Error><Code>AccessDenied</Code></Error>')).toEqual({});
  });

  it('reads the first text-only occurrence of each element', () => {
    expect(
      parseS3ErrorXml('<Error><Code><Nested/></Code><Code>SlowDown</Code><Code>Later</Code><Message></Message></Error>')
    ).toEqual({ code: 'SlowDown', message: '', requestId: undefined });
    expect(parseS3ErrorXml('<Error><Code>Unclosed')).toEqual({ code: undefined, message: undefined, requestId: undefined });
    expect(parseS3ErrorXml('<Error><CodeX>no</CodeX><Code>A&lt;B</Code></Error>').code).toBe('A<B');
  });

  it('still reads a plain error document and leaves unknown entities literal', () => {
    expect(parseS3ErrorXml('<Error><Code>SlowDown</Code><Message>a &amp; &foo;</Message></Error>')).toEqual({
      code: 'SlowDown',
      message: 'a & &foo;',
      requestId: undefined,
    });
  });
});

describe('S3StorageAdapter against a signature-verifying stub', () => {
  let stub: S3StubServer;

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
    stub.uploads.clear();
    stub.requests.length = 0;
    stub.faults.length = 0;
    stub.complete.keepalive = undefined;
    stub.complete.failAfterComplete = undefined;
    stub.complete.afterComplete = undefined;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function adapter(overrides: Partial<{ secretAccessKey: string; sessionToken: string }> = {}, options = {}) {
    return new S3StorageAdapter(
      {
        type: 's3',
        bucket: BUCKET,
        accessKeyId: ACCESS_KEY,
        secretAccessKey: overrides.secretAccessKey ?? SECRET,
        sessionToken: overrides.sessionToken,
        region: 'eu-central-1',
        endpoint: stub.url,
        forcePathStyle: true,
      },
      { retryBaseDelayMs: 1, ...options }
    );
  }

  it('streams a small object with UNSIGNED-PAYLOAD, then GETs, HEADs, and DELETEs it', async () => {
    const payload = Buffer.from('quarterly,report\n1,2\n', 'utf-8');
    const s3 = adapter();

    const put = await s3.uploadStream('reports/q3 final.csv', Readable.from([payload]), {
      contentType: 'text/csv',
      size: payload.length,
    });
    const putReq = stub.requests[0];
    expect(putReq).toMatchObject({ method: 'PUT', key: 'reports/q3 final.csv' });
    expect(putReq.rawUrl).toBe(`/${BUCKET}/reports/q3%20final.csv`);
    expect(putReq.auth).toMatchObject({ ok: true, region: 'eu-central-1', service: 's3', payloadHash: 'UNSIGNED-PAYLOAD' });
    expect(stub.objects.get('reports/q3 final.csv')?.body.equals(payload)).toBe(true);
    expect(put.etag).toBe(crypto.createHash('md5').update(payload).digest('hex'));
    expect(put.size).toBe(payload.length);

    const downloaded = await collect(await s3.downloadStream('/reports/q3 final.csv'));
    expect(downloaded.equals(payload)).toBe(true);

    const head = await s3.head('reports/q3 final.csv');
    expect(head).toMatchObject({ size: payload.length, contentType: 'text/csv', etag: put.etag });
    expect(head?.lastModified?.toISOString()).toBe('2026-10-01T10:00:00.000Z');

    expect(await s3.delete('reports/q3 final.csv')).toBe(true);
    expect(await s3.head('reports/q3 final.csv')).toBeNull();
    expect(stub.requests.every((r) => r.auth.ok)).toBe(true);
    expect(stub.requests.map((r) => r.auth.payloadHash).slice(1)).toEqual([
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    ]);
  });

  it('uploads an object of unknown size as 5 MiB signed parts and completes the multipart upload', async () => {
    const payload = crypto.randomBytes(2 * MIN_PART + 123_457);
    const s3 = adapter({}, { partSizeBytes: MIN_PART });

    const result = await s3.uploadStream('video/big.bin', sliced(payload), { contentType: 'video/mp4' });

    const stored = stub.objects.get('video/big.bin');
    expect(stored && sha256(stored.body)).toBe(sha256(payload));
    expect(result.size).toBe(payload.length);
    expect(result.etag).toMatch(/^[0-9a-f]{32}-3$/);

    const ops = stub.requests.map((r) => `${r.method} ${[...r.query.keys()].sort().join(',')}`);
    expect(ops).toEqual(['POST uploads', 'PUT partNumber,uploadId', 'PUT partNumber,uploadId', 'PUT partNumber,uploadId', 'POST uploadId']);
    const parts = stub.requests.filter((r) => r.query.has('partNumber'));
    expect(parts.map((r) => r.bodyLength)).toEqual([MIN_PART, MIN_PART, 123_457]);
    // Parts carry a signed SHA-256 that the verifier checked against the received bytes.
    for (const part of parts) {
      expect(part.auth.ok).toBe(true);
      expect(part.auth.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(stub.uploads.size).toBe(0);
  });

  it('switches a known-size upload above the part size to multipart', async () => {
    const payload = crypto.randomBytes(MIN_PART + 1);
    const s3 = adapter({}, { partSizeBytes: MIN_PART });
    await s3.uploadStream('k/known.bin', sliced(payload), { size: payload.length });
    expect(stub.requests.filter((r) => r.query.has('partNumber')).map((r) => r.bodyLength)).toEqual([MIN_PART, 1]);
    expect(sha256(stub.objects.get('k/known.bin')!.body)).toBe(sha256(payload));
  });

  it('aborts the multipart upload when a part fails and surfaces the typed error', async () => {
    stub.faults.push({
      match: (r) => r.method === 'PUT' && r.query.get('partNumber') === '2',
      status: 403,
      code: 'AccessDenied',
      times: 1,
    });
    const s3 = adapter({}, { partSizeBytes: MIN_PART });

    await expect(s3.uploadStream('fail/obj.bin', sliced(crypto.randomBytes(2 * MIN_PART + 10)))).rejects.toThrow(
      StorageAuthenticationError
    );

    const created = stub.requests.find((r) => r.method === 'PUT' && r.query.get('partNumber') === '1');
    const abort = stub.requests.find((r) => r.method === 'DELETE' && r.query.has('uploadId'));
    expect(abort?.query.get('uploadId')).toMatch(/^stub-upload-\d+$/);
    expect(abort?.query.get('uploadId')).toBe(created?.query.get('uploadId'));
    expect(abort?.auth.ok).toBe(true);
    expect(stub.uploads.size).toBe(0);
    expect(stub.objects.has('fail/obj.bin')).toBe(false);
  });

  it('retries throttling and 5xx with backoff, including an error inside a 200 Complete response', async () => {
    stub.faults.push(
      { match: (r) => r.query.get('partNumber') === '1', status: 503, code: 'SlowDown', times: 2 },
      { match: (r) => r.method === 'POST' && r.query.has('uploadId'), status: 200, code: 'InternalError', errorIn200: true, times: 1 }
    );
    const payload = crypto.randomBytes(MIN_PART + 99);
    const s3 = adapter({}, { partSizeBytes: MIN_PART });

    await s3.uploadStream('retry/obj.bin', sliced(payload));

    expect(stub.requests.filter((r) => r.query.get('partNumber') === '1')).toHaveLength(3);
    expect(stub.requests.filter((r) => r.method === 'POST' && r.query.has('uploadId'))).toHaveLength(2);
    expect(sha256(stub.objects.get('retry/obj.bin')!.body)).toBe(sha256(payload));
  });

  it('gives up after maxAttempts on persistent 500 with a retryable StorageServiceError', async () => {
    stub.faults.push({ match: (r) => r.method === 'GET', status: 500, code: 'InternalError', times: Infinity });
    const s3 = adapter({}, { maxAttempts: 3 });
    const err = await s3.downloadStream('any.txt').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageServiceError);
    expect(err).toMatchObject({ statusCode: 500, code: 'InternalError', requestId: 'STUBREQ1', retryable: true });
    expect(stub.requests.filter((r) => r.method === 'GET')).toHaveLength(3);
  });

  it('maps error XML: NoSuchKey to StorageNotFoundError and a bad signature to StorageAuthenticationError', async () => {
    await expect(adapter().downloadStream('missing/file.txt')).rejects.toThrow(StorageNotFoundError);

    const err = await adapter({ secretAccessKey: 'wrong-secret' })
      .downloadStream('x.txt')
      .catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(StorageAuthenticationError);
    expect((err as Error).message).toContain('SignatureDoesNotMatch');
    expect((err as Error).message).not.toContain('wrong-secret');
    expect(stub.requests.at(-1)?.auth).toMatchObject({ ok: false, reason: 'signature mismatch' });
  });

  it('rejects a CreateMultipartUpload response that carries a DTD and uploads no parts', async () => {
    stub.faults.push({
      match: (r) => r.method === 'POST' && r.query.has('uploads'),
      status: 200,
      errorIn200: true,
      body:
        '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY id "stub-upload-999">]>' +
        '<InitiateMultipartUploadResult><UploadId>&id;</UploadId></InitiateMultipartUploadResult>',
      times: 1,
    });
    const err = await adapter({}, { partSizeBytes: MIN_PART })
      .uploadStream('dtd/obj.bin', sliced(crypto.randomBytes(MIN_PART + 1)))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageServiceError);
    expect(err).toMatchObject({ code: 'MalformedXML', retryable: false });
    expect(stub.requests.filter((r) => r.query.has('partNumber'))).toHaveLength(0);
  });

  it('does not trust the error code of a DTD-bearing error body', async () => {
    stub.faults.push({ match: (r) => r.method === 'GET', status: 400, body: DTD_ERROR_DOCUMENT, times: 1 });
    const err = (await adapter().downloadStream('x.txt').catch((e: unknown) => e)) as StorageServiceError;
    expect(err).toBeInstanceOf(StorageServiceError);
    expect(err.code).toBeUndefined();
    expect(err.message).not.toContain('etc/passwd');
  });

  const isComplete = (r: { method: string; query: URLSearchParams }) => r.method === 'POST' && r.query.has('uploadId');
  const isAbort = (r: { method: string; query: URLSearchParams }) => r.method === 'DELETE' && r.query.has('uploadId');

  it('keeps a CompleteMultipartUpload alive while S3 streams whitespace past the request timeout', async () => {
    // 15 ticks x 30 ms = 450 ms of keepalive: more than twice the 200 ms inactivity timeout.
    stub.complete.keepalive = { count: 15, intervalMs: 30 };
    const payload = crypto.randomBytes(MIN_PART + 5);
    const s3 = adapter({}, { partSizeBytes: MIN_PART, requestTimeoutMs: 200 });

    const result = await s3.uploadStream('slow/complete.bin', sliced(payload));

    expect(result.etag).toMatch(/^[0-9a-f]{32}-2$/);
    expect(sha256(stub.objects.get('slow/complete.bin')!.body)).toBe(sha256(payload));
    expect(stub.requests.filter(isComplete)).toHaveLength(1);
    expect(stub.requests.filter(isAbort)).toHaveLength(0);
  });

  it('verifies with ListParts and HEAD when a retried Complete finds the upload already completed', async () => {
    stub.complete.failAfterComplete = { status: 500, code: 'InternalError' };
    const payload = crypto.randomBytes(MIN_PART + 77);
    const s3 = adapter({}, { partSizeBytes: MIN_PART });

    const result = await s3.uploadStream('ambiguous/ok.bin', sliced(payload));

    expect(result).toMatchObject({ size: payload.length });
    expect(result.etag).toMatch(/^[0-9a-f]{32}-2$/);
    expect(stub.requests.filter(isComplete)).toHaveLength(2);
    expect(stub.requests.some((r) => r.method === 'GET' && r.query.has('uploadId'))).toBe(true);
    expect(stub.requests.some((r) => r.method === 'HEAD' && r.key === 'ambiguous/ok.bin')).toBe(true);
    expect(stub.requests.filter(isAbort)).toHaveLength(0);
    expect(sha256(stub.objects.get('ambiguous/ok.bin')!.body)).toBe(sha256(payload));
  });

  const isListParts = (r: { method: string; query: URLSearchParams }) => r.method === 'GET' && r.query.has('uploadId');

  it('does not take an empty 200 Complete as success without verifying the object', async () => {
    stub.faults.push({ match: isComplete, status: 200, errorIn200: true, body: '', times: 1 });
    const payload = crypto.randomBytes(MIN_PART + 3);
    const s3 = adapter({}, { partSizeBytes: MIN_PART });

    await expect(s3.uploadStream('empty/complete.bin', sliced(payload))).rejects.toThrow(StorageServiceError);
    expect(stub.requests.some(isListParts)).toBe(true);
    expect(stub.requests.filter(isAbort)).toHaveLength(1);
    expect(stub.objects.has('empty/complete.bin')).toBe(false);
  });

  it('does not take a 2xx Complete body without a result element as success', async () => {
    stub.faults.push({ match: isComplete, status: 200, errorIn200: true, body: '<Other>ok</Other>', times: Infinity });
    await expect(
      adapter({}, { partSizeBytes: MIN_PART }).uploadStream('odd/complete.bin', sliced(crypto.randomBytes(MIN_PART + 3)))
    ).rejects.toThrow(StorageServiceError);
    expect(stub.requests.some(isListParts)).toBe(true);
    expect(stub.requests.filter(isAbort)).toHaveLength(1);
  });

  it('finds an <Error> that follows more than 64 KiB of keepalive whitespace', async () => {
    stub.faults.push({
      match: isComplete,
      status: 200,
      errorIn200: true,
      body: `${' '.repeat(70 * 1024)}<Error><Code>InternalError</Code><Message>late</Message></Error>`,
      times: 1,
    });
    const payload = crypto.randomBytes(MIN_PART + 3);
    await adapter({}, { partSizeBytes: MIN_PART }).uploadStream('late/error.bin', sliced(payload));
    expect(stub.requests.filter(isComplete)).toHaveLength(2);
    expect(sha256(stub.objects.get('late/error.bin')!.body)).toBe(sha256(payload));
  });

  it('reads a Complete result after more than 64 KiB of keepalive whitespace without verification', async () => {
    stub.complete.keepalive = { count: 70, intervalMs: 1, chunk: ' '.repeat(1024) };
    const result = await adapter({}, { partSizeBytes: MIN_PART }).uploadStream(
      'long/keepalive.bin',
      sliced(crypto.randomBytes(MIN_PART + 3))
    );
    expect(result.etag).toMatch(/^[0-9a-f]{32}-2$/);
    expect(stub.requests.filter(isComplete)).toHaveLength(1);
    expect(stub.requests.some(isListParts)).toBe(false);
  });

  /** Independent oracle: S3 multipart ETag = MD5(concat of binary part MD5s) + "-" + part count. */
  function multipartEtag(payload: Buffer, partSize: number): string {
    const digests: Buffer[] = [];
    for (let i = 0; i < payload.length; i += partSize) {
      digests.push(crypto.createHash('md5').update(payload.subarray(i, i + partSize)).digest());
    }
    return `${crypto.createHash('md5').update(Buffer.concat(digests)).digest('hex')}-${digests.length}`;
  }

  it('reports the exact multipart ETag after verifying an ambiguous Complete', async () => {
    stub.complete.failAfterComplete = { status: 500, code: 'InternalError' };
    const payload = crypto.randomBytes(2 * MIN_PART + 11);
    const result = await adapter({}, { partSizeBytes: MIN_PART }).uploadStream('exact/etag.bin', sliced(payload));
    expect(result.etag).toBe(multipartEtag(payload, MIN_PART));
    expect(stub.requests.some(isListParts)).toBe(true);
  });

  it('does not accept another writer\'s object of the same size as proof of completion', async () => {
    stub.complete.failAfterComplete = { status: 500, code: 'InternalError' };
    stub.complete.afterComplete = (key) => {
      const original = stub.objects.get(key)!;
      stub.objects.set(key, {
        body: crypto.randomBytes(original.body.length),
        contentType: 'application/octet-stream',
        etag: `"${'f'.repeat(32)}-2"`,
      });
    };
    const err = await adapter({}, { partSizeBytes: MIN_PART })
      .uploadStream('foreign/obj.bin', sliced(crypto.randomBytes(MIN_PART + 9)))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageServiceError);
    expect(stub.requests.some((r) => r.method === 'HEAD' && r.key === 'foreign/obj.bin')).toBe(true);
    expect(stub.requests.filter(isAbort)).toHaveLength(1);
  });

  it('aborts after an ambiguous Complete failure when ListParts shows the upload still open', async () => {
    stub.faults.push({ match: isComplete, status: 500, code: 'InternalError', times: Infinity });
    const s3 = adapter({}, { partSizeBytes: MIN_PART, maxAttempts: 2 });

    await expect(s3.uploadStream('ambiguous/fail.bin', sliced(crypto.randomBytes(MIN_PART + 1)))).rejects.toThrow(
      StorageServiceError
    );
    expect(stub.requests.some((r) => r.method === 'GET' && r.query.has('uploadId'))).toBe(true);
    expect(stub.requests.filter(isAbort)).toHaveLength(1);
    expect(stub.objects.has('ambiguous/fail.bin')).toBe(false);
  });

  it('does not replay CreateMultipartUpload', async () => {
    stub.faults.push({ match: (r) => r.method === 'POST' && r.query.has('uploads'), status: 503, code: 'SlowDown', times: 1 });
    const err = await adapter({}, { partSizeBytes: MIN_PART })
      .uploadStream('create/once.bin', sliced(crypto.randomBytes(MIN_PART + 1)))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageServiceError);
    expect(err).toMatchObject({ statusCode: 503, code: 'SlowDown' });
    expect(stub.requests.filter((r) => r.method === 'POST' && r.query.has('uploads'))).toHaveLength(1);
    expect(stub.requests.filter((r) => r.query.has('partNumber'))).toHaveLength(0);
  });

  it('stops a peer that keeps a response alive with a byte at a time past the absolute ceiling', async () => {
    stub.faults.push({ match: (r) => r.method === 'GET', status: 500, dripMs: 20, times: 1 });
    const started = Date.now();
    const err = await adapter({}, { requestTimeoutMs: 100, maxRequestDurationMs: 400, maxAttempts: 1 })
      .downloadStream('drip.txt')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageTimeoutError);
    expect((err as Error).message).toContain('400 ms');
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 5_000);

  it('types a timeout that fires while an error body is still arriving', async () => {
    stub.faults.push({ match: (r) => r.method === 'GET', status: 500, stallBody: true, times: 1 });
    await expect(adapter({}, { requestTimeoutMs: 80, maxAttempts: 1 }).downloadStream('stall.txt')).rejects.toThrow(
      StorageTimeoutError
    );
  });

  it('types a source stream failure and aborts the multipart upload', async () => {
    async function* failingSource() {
      yield crypto.randomBytes(2 * MIN_PART + 3);
      throw new Error('source disk read failed');
    }
    const err = (await adapter({}, { partSizeBytes: MIN_PART })
      .uploadStream('src/fail.bin', Readable.from(failingSource()))
      .catch((e: unknown) => e)) as StorageServiceError;
    expect(err).toBeInstanceOf(StorageServiceError);
    expect(err.retryable).toBe(false);
    expect((err.cause as Error).message).toBe('source disk read failed');
    expect(stub.requests.filter(isAbort)).toHaveLength(1);
  });

  async function waitFor(check: () => boolean, ms = 1_000): Promise<boolean> {
    const until = Date.now() + ms;
    while (!check() && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
    return check();
  }

  it('times out a download body that trickles past the absolute ceiling and releases the socket', async () => {
    const fault = { match: (r: { method: string }) => r.method === 'GET', status: 200, dripMs: 20, times: 1 };
    stub.faults.push(fault);
    const started = Date.now();
    const stream = await adapter({}, { requestTimeoutMs: 100, maxRequestDurationMs: 400, maxAttempts: 1 }).downloadStream(
      'trickle.bin'
    );
    const err = await collect(stream).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageTimeoutError);
    expect((err as Error).message).toContain('400 ms');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await waitFor(() => (fault as { clientClosed?: boolean }).clientClosed === true)).toBe(true);
  }, 5_000);

  it('times out a download body that stalls after the headers', async () => {
    const fault = { match: (r: { method: string }) => r.method === 'GET', status: 200, stallBody: true, times: 1 };
    stub.faults.push(fault);
    const started = Date.now();
    const stream = await adapter({}, { requestTimeoutMs: 100, maxAttempts: 1 }).downloadStream('stalled.bin');
    const err = await collect(stream).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageTimeoutError);
    expect((err as Error).message).toContain('100 ms');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await waitFor(() => (fault as { clientClosed?: boolean }).clientClosed === true)).toBe(true);
  }, 5_000);

  it('streams a normal download in chunks without buffering it whole', async () => {
    const payload = crypto.randomBytes(3 * MIB + 17);
    stub.objects.set('big/stream.bin', { body: payload, contentType: 'application/octet-stream', etag: '"e"' });
    const stream = await adapter({}, { requestTimeoutMs: 100 }).downloadStream('big/stream.bin');
    const sizes: number[] = [];
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      sizes.push((chunk as Buffer).length);
      chunks.push(chunk as Buffer);
    }
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThan(payload.length);
    expect(sha256(Buffer.concat(chunks))).toBe(sha256(payload));
  });

  it('types a download body that is cut off mid-stream', async () => {
    stub.faults.push({ match: (r) => r.method === 'GET', status: 200, truncateBody: true, times: 1 });
    const stream = await adapter().downloadStream('cut.bin');
    await expect(collect(stream)).rejects.toThrow(StorageServiceError);
  });

  it('times out a request that gets no response', async () => {
    stub.faults.push({ match: (r) => r.method === 'HEAD', status: 200, times: 1, delayMs: 500 });
    await expect(adapter({}, { requestTimeoutMs: 50, maxAttempts: 1 }).head('slow.bin')).rejects.toThrow(
      StorageTimeoutError
    );
  });

  it('signs the session token', async () => {
    await adapter({ sessionToken: 'FQoGZXIvYXdzEXAMPLE//token+' }).head('none.bin');
    const req = stub.requests[0];
    expect(req.headers['x-amz-security-token']).toBe('FQoGZXIvYXdzEXAMPLE//token+');
    expect(req.auth.signedHeaders).toContain('x-amz-security-token');
    expect(req.auth.ok).toBe(true);
  });

  it('refuses keys with dot segments before sending anything', async () => {
    await expect(adapter().downloadStream('a/../../other-bucket/secret')).rejects.toThrow(StorageAdapterError);
    expect(stub.requests).toHaveLength(0);
  });

  it('keeps credentials out of serialization and error messages', async () => {
    const s3 = adapter();
    expect(JSON.stringify(s3)).not.toContain(SECRET);
    stub.faults.push({ match: () => true, status: 400, code: 'InvalidArgument', times: 1 });
    const err = (await s3.downloadStream('x').catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(StorageServiceError);
    expect(`${err.message}${err.stack}`).not.toContain(SECRET);
  });
});

describe('S3StorageAdapter endpoint policy', () => {
  const base = { type: 's3' as const, bucket: 'b-bucket', accessKeyId: 'AKIA', secretAccessKey: 'S' };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['loopback over HTTP', 'http://127.0.0.1:9000'],
    ['loopback over TLS', 'https://127.0.0.1:9000'],
    ['cloud metadata IP', 'https://169.254.169.254'],
    ['metadata hostname', 'https://metadata.google.internal'],
    ['private network', 'https://10.0.0.5'],
    ['public host without TLS', 'http://objects.example.com'],
  ])('rejects %s', (_label, endpoint) => {
    expect(() => new S3StorageAdapter({ ...base, endpoint })).toThrow(StorageSsrfError);
  });

  it.each([
    ['unset', undefined],
    ['test', 'test'],
    ['staging', 'staging'],
  ])('ignores the allowlist when NODE_ENV is %s and warns once', async (_label, nodeEnv) => {
    const saved = process.env.NODE_ENV;
    const env = process.env as Record<string, string | undefined>;
    if (nodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = nodeEnv;
    vi.stubEnv(S3_DEV_ENDPOINT_ALLOWLIST_ENV, '127.0.0.1:9000');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      vi.resetModules();
      const fresh = await import('../src/lib/storage/adapters/s3');
      const ssrf = await import('../src/lib/storage/adapters/adapter-interface');
      for (let i = 0; i < 2; i++) {
        expect(() => new fresh.S3StorageAdapter({ ...base, endpoint: 'http://127.0.0.1:9000' })).toThrow(ssrf.StorageSsrfError);
      }
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(S3_DEV_ENDPOINT_ALLOWLIST_ENV);
      expect(String(warn.mock.calls[0][0])).not.toContain('127.0.0.1');
    } finally {
      env.NODE_ENV = saved;
      warn.mockRestore();
    }
  });

  it('ignores the development allowlist in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv(S3_DEV_ENDPOINT_ALLOWLIST_ENV, '127.0.0.1:9000');
    expect(() => new S3StorageAdapter({ ...base, endpoint: 'http://127.0.0.1:9000' })).toThrow(StorageSsrfError);
  });

  it('allows only the exact allowlisted host and port in development', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv(S3_DEV_ENDPOINT_ALLOWLIST_ENV, '127.0.0.1:9000');
    expect(new S3StorageAdapter({ ...base, endpoint: 'http://127.0.0.1:9000' }).providerName).toBe('s3');
    expect(() => new S3StorageAdapter({ ...base, endpoint: 'http://127.0.0.1:9001' })).toThrow(StorageSsrfError);
  });

  it('rejects a part size below the 5 MiB minimum', () => {
    expect(() => new S3StorageAdapter({ ...base }, { partSizeBytes: MIN_PART - 1 })).toThrow(StorageAdapterError);
  });
});
