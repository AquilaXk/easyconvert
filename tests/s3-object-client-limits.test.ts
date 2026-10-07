import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import { S3ObjectClient, S3_LIST_MAX_PAGES, S3_MAX_XML_RESPONSE_BYTES } from '../src/lib/storage/s3-object-client';
import { StorageAdapterError, StorageServiceError } from '../src/lib/storage/adapters/adapter-interface';
import { S3_MIN_PART_BYTES } from '../src/lib/storage/adapters/s3';
import { startS3StubServer, s3EtagMd5, type S3StubServer } from './helpers/s3-stub-server';

/**
 * The protocol limits of the S3 client, driven by servers whose answers are written by hand in
 * this file (a scripted undici MockAgent for answers no real store gives, the stub S3 server for
 * the rest): an oversized XML answer, a response body whose length differs from its
 * Content-Length, a ranged read the server does not honour, a listing that never ends, and an
 * ambiguous CompleteMultipartUpload.
 */

const BUCKET = 'internal-objects';
const REGION = 'ap-seoul-1';
const CREDENTIALS = { accessKeyId: 'AKIASTUBEXAMPLE00001', secretAccessKey: 'stub/Secret+Key/EXAMPLEKEY0000000000000' };
const MOCK_ORIGIN = 'http://objects.mock';
const HTTP_OK = 200;
const HTTP_PARTIAL = 206;
const MIB = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

function makeClient(endpoint: string, overrides: Record<string, unknown> = {}): S3ObjectClient {
  return new S3ObjectClient({
    endpoint,
    region: REGION,
    bucket: BUCKET,
    ...CREDENTIALS,
    providerName: 'oci',
    retryBaseDelayMs: 0,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    maxAttempts: 1,
    ...overrides,
  });
}

async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

async function failureOf(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('answers scripted at the HTTP level', () => {
  let original: Dispatcher;
  let agent: MockAgent;

  beforeAll(() => {
    original = getGlobalDispatcher();
  });

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    await agent.close();
    setGlobalDispatcher(original);
  });

  const objectPath = (key: string) => `/${BUCKET}/${key}`;

  describe('response body length', () => {
    it('fails a download whose body is shorter than its Content-Length', async () => {
      agent
        .get(MOCK_ORIGIN)
        .intercept({ path: objectPath('short.bin'), method: 'GET' })
        .reply(HTTP_OK, 'abcde', { headers: { 'content-length': '10', etag: '"e"' } });
      const got = await makeClient(MOCK_ORIGIN).getObject('short.bin');
      const err = await failureOf(() => drain(got!.stream));
      expect(err).toBeInstanceOf(StorageServiceError);
      expect(err).toMatchObject({ code: 'BodyLengthMismatch', retryable: false });
      expect((err as Error).message).toBe('Response body length 5 does not match Content-Length 10');
    });

    it('fails a download whose body is longer than its Content-Length', async () => {
      agent
        .get(MOCK_ORIGIN)
        .intercept({ path: objectPath('long.bin'), method: 'GET' })
        .reply(HTTP_OK, 'abcdefghij', { headers: { 'content-length': '5', etag: '"e"' } });
      const got = await makeClient(MOCK_ORIGIN).getObject('long.bin');
      const err = await failureOf(() => drain(got!.stream));
      expect(err).toMatchObject({ code: 'BodyLengthMismatch', retryable: false });
      expect((err as Error).message).toBe('Response body length 10 does not match Content-Length 5');
    });

    it('delivers a body whose length matches its Content-Length', async () => {
      agent
        .get(MOCK_ORIGIN)
        .intercept({ path: objectPath('exact.bin'), method: 'GET' })
        .reply(HTTP_OK, 'abcde', { headers: { 'content-length': '5', etag: '"e"' } });
      const got = await makeClient(MOCK_ORIGIN).getObject('exact.bin');
      expect((await drain(got!.stream)).toString()).toBe('abcde');
    });
  });

  describe('ranged reads', () => {
    const request = { start: 10, end: 19 };

    function scripted(status: number, headers: Record<string, string>, body = '0123456789') {
      agent
        .get(MOCK_ORIGIN)
        .intercept({ path: objectPath('ranged.bin'), method: 'GET', headers: { range: 'bytes=10-19' } })
        .reply(status, body, { headers: { etag: '"e"', ...headers } });
    }

    it('reports the served range and the whole object\'s size from Content-Range', async () => {
      scripted(HTTP_PARTIAL, { 'content-range': 'bytes 10-19/100', 'content-length': '10' });
      const got = await makeClient(MOCK_ORIGIN).getObject('ranged.bin', request);
      expect(got?.range).toEqual({ start: 10, end: 19, total: 100 });
      expect(got?.size).toBe(100);
      expect((await drain(got!.stream)).toString()).toBe('0123456789');
    });

    it('accepts a server that serves fewer bytes than asked for at the end of the object', async () => {
      scripted(HTTP_PARTIAL, { 'content-range': 'bytes 10-14/15', 'content-length': '5' }, '01234');
      const got = await makeClient(MOCK_ORIGIN).getObject('ranged.bin', request);
      expect(got?.range).toEqual({ start: 10, end: 14, total: 15 });
    });

    it('refuses a server that answers a ranged read with the whole object', async () => {
      scripted(HTTP_OK, { 'content-length': '10' });
      const err = await failureOf(() => makeClient(MOCK_ORIGIN).getObject('ranged.bin', request));
      expect(err).toBeInstanceOf(StorageServiceError);
      expect(err).toMatchObject({ code: 'RangeNotHonored', statusCode: HTTP_OK, retryable: false });
    });

    it.each([
      ['no Content-Range', {}],
      ['an unparseable Content-Range', { 'content-range': 'bytes ten-nineteen/hundred' }],
      ['a Content-Range with an unknown total', { 'content-range': 'bytes 10-19/*' }],
      ['a range that starts elsewhere', { 'content-range': 'bytes 0-9/100' }],
      ['a range that runs past the one asked for', { 'content-range': 'bytes 10-29/100' }],
    ])('refuses a 206 with %s', async (_label, headers) => {
      scripted(HTTP_PARTIAL, { 'content-length': '10', ...headers });
      const err = await failureOf(() => makeClient(MOCK_ORIGIN).getObject('ranged.bin', request));
      expect(err).toBeInstanceOf(StorageServiceError);
      expect(err).toMatchObject({ code: 'MalformedResponse', retryable: false });
    });
  });

  describe('listing without an end', () => {
    it('stops after the page bound instead of following continuation tokens forever', async () => {
      let pages = 0;
      agent
        .get(MOCK_ORIGIN)
        .intercept({ path: (path) => path.startsWith(`/${BUCKET}?`) && path.includes('list-type=2'), method: 'GET' })
        .reply(() => {
          pages += 1;
          return {
            statusCode: HTTP_OK,
            data: `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t${pages}</NextContinuationToken></ListBucketResult>`,
          };
        })
        .persist();

      const listed: string[] = [];
      const err = await failureOf(async () => {
        for await (const object of makeClient(MOCK_ORIGIN).listAll('walk/', 10)) listed.push(object.key);
      });
      expect(listed).toEqual([]);
      expect(err).toBeInstanceOf(StorageAdapterError);
      expect((err as Error).message).toBe(`Listing "walk/" did not finish within ${S3_LIST_MAX_PAGES} pages`);
      expect(pages).toBe(S3_LIST_MAX_PAGES);
    });
  });
});

describe('answers from the stub S3 server', () => {
  let server: S3StubServer;

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
    server.complete.failAfterComplete = undefined;
    server.complete.afterComplete = undefined;
  });

  describe('an XML answer larger than the limit', () => {
    function oversizedListing(): string {
      return `<ListBucketResult>${'x'.repeat(S3_MAX_XML_RESPONSE_BYTES + 1024)}</ListBucketResult>`;
    }

    it('is refused with a typed error instead of being buffered', async () => {
      server.faults.push({
        match: (req) => req.method === 'GET' && req.query.get('list-type') === '2',
        status: HTTP_OK,
        errorIn200: true,
        body: oversizedListing(),
        times: 1,
      });
      const err = await failureOf(() => makeClient(server.url).listObjects({}));
      expect(err).toBeInstanceOf(StorageServiceError);
      expect(err).toMatchObject({ code: 'ResponseTooLarge', retryable: false });
      expect((err as Error).message).toBe(`S3 answer is larger than ${S3_MAX_XML_RESPONSE_BYTES} bytes and was refused`);
    });

    it('is refused for an error document too, and the client stays usable', async () => {
      server.faults.push({
        match: (req) => req.method === 'GET' && req.query.get('list-type') === '2',
        status: 500,
        body: oversizedListing(),
        times: 1,
      });
      const client = makeClient(server.url);
      expect(await failureOf(() => client.listObjects({}))).toBeInstanceOf(StorageServiceError);
      await client.putBuffer('after/oversize.txt', Buffer.from('still works'));
      expect((await client.listObjects({ prefix: 'after/' })).objects.map((object) => object.key)).toEqual(['after/oversize.txt']);
    });
  });

  describe('a CompleteMultipartUpload whose answer was lost', () => {
    const partSize = S3_MIN_PART_BYTES;
    const body = crypto.randomBytes(2 * partSize + 4321);
    const expectedEtag = (() => {
      const parts = [body.subarray(0, partSize), body.subarray(partSize, 2 * partSize), body.subarray(2 * partSize)];
      const digests = Buffer.concat(parts.map((part) => s3EtagMd5(part)));
      return `${s3EtagMd5(digests).toString('hex')}-${parts.length}`;
    })();

    it('counts a streamed upload as done when the object at the key is exactly the one it assembled', async () => {
      server.complete.failAfterComplete = { status: 500, code: 'InternalError' };
      const result = await makeClient(server.url, { partSizeBytes: partSize, maxAttempts: 4 }).putStream(
        'lost/answer.bin',
        Readable.from([body])
      );
      expect(result).toMatchObject({ size: body.length, etag: expectedEtag });
      expect(server.objects.get('lost/answer.bin')?.body.equals(body)).toBe(true);
      expect(server.requests.some((req) => req.method === 'DELETE')).toBe(false);
    });

    it('does not take another writer\'s object at the key for its own', async () => {
      server.complete.failAfterComplete = { status: 500, code: 'InternalError' };
      server.complete.afterComplete = (key) => {
        const stored = server.objects.get(key);
        if (stored) server.objects.set(key, { ...stored, body: Buffer.from('replaced by someone else'), etag: 'replaced' });
      };
      const err = await failureOf(() =>
        makeClient(server.url, { partSizeBytes: partSize, maxAttempts: 4 }).putStream('lost/other.bin', Readable.from([body]))
      );
      expect(err).toBeInstanceOf(StorageServiceError);
      expect((err as StorageServiceError).code).toBe('NoSuchUpload');
    });

    it('fails a streamed upload whose object never appeared', async () => {
      server.complete.failAfterComplete = { status: 500, code: 'InternalError' };
      server.complete.afterComplete = (key) => {
        server.objects.delete(key);
      };
      const err = await failureOf(() =>
        makeClient(server.url, { partSizeBytes: partSize, maxAttempts: 4 }).putStream('lost/gone.bin', Readable.from([body]))
      );
      expect(err).toBeInstanceOf(StorageServiceError);
      expect(server.objects.has('lost/gone.bin')).toBe(false);
    });
  });

  it('keeps a 1 MiB boundary: an XML answer just under the limit is read whole', async () => {
    const filler = 'y'.repeat(MIB);
    server.faults.push({
      match: (req) => req.method === 'GET' && req.query.get('list-type') === '2',
      status: HTTP_OK,
      errorIn200: true,
      body: `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>${filler}</Key><Size>1</Size></Contents></ListBucketResult>`,
      times: 1,
    });
    const page = await makeClient(server.url).listObjects({});
    expect(page.objects).toHaveLength(1);
    expect(page.objects[0].key).toBe(filler);
  });
});
