import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { StorageServiceError } from '../src/lib/storage/adapters/adapter-interface';
import { decodeXmlText, parseS3ErrorXml } from '../src/lib/storage/adapters/s3';
import { S3ObjectClient } from '../src/lib/storage/s3-object-client';
import { startS3StubServer, type S3StubServer } from './helpers/s3-stub-server';

/**
 * Regression for numeric character references in S3 answers. Servers built on Go's encoding/xml
 * write a quote as `&#34;` and an apostrophe as `&#39;`, where others write `&quot;`. The real-server
 * test leg answered a CompleteMultipartUpload with `<ETag>&#34;<md5>-3&#34;</ETag>`, and the client
 * returned the ETag with the entities still in it.
 *
 * Oracles, none from src/: the XML 1.0 specification (section 4.1 character references and the
 * `Char` production), Go's documented EscapeText output, and MD5 recomputed with node:crypto.
 */

const BUCKET = 'xml-entities';
const CREDENTIALS = { accessKeyId: 'AKIASTUBEXAMPLE00002', secretAccessKey: 'stub/Secret+Key/EXAMPLEKEY0000000000001' };
const REGION = 'us-east-1';
const UTF8 = 'utf-8';
const MALFORMED_XML_CODE = 'MalformedXML';

function md5Hex(...chunks: Buffer[]): string {
  return crypto.createHash('md5').update(Buffer.concat(chunks)).digest('hex'); // NOSONAR S4790: S3 ETag oracle, not a security control
}

function md5Bytes(data: Buffer): Buffer {
  return crypto.createHash('md5').update(data).digest(); // NOSONAR S4790: S3 ETag oracle, not a security control
}

describe('decodeXmlText', () => {
  it.each([
    ['a decimal reference to a quote', '&#34;ab&#34;', '"ab"'],
    ['a hexadecimal reference to a quote', '&#x22;ab&#x22;', '"ab"'],
    ['a decimal reference to an apostrophe', 'it&#39;s', "it's"],
    ['the whitespace controls Go escapes', 'a&#x9;b&#xA;c&#xD;d', 'a\tb\nc\rd'],
    ['a reference above the basic plane', '&#x1F600;', '\u{1F600}'],
    ['the last code point', '&#x10FFFF;', '\u{10FFFF}'],
    ['the last code point before the surrogates', '&#xD7FF;', '퟿'],
    ['the first code point after the surrogates', '&#xE000;', ''],
    ['upper-case hexadecimal digits', '&#x1f600;&#x1F600;', '\u{1F600}\u{1F600}'],
    ['the predefined entities together with references', '&lt;&#38;&amp;&gt;&quot;&apos;', '<&&>"\''],
    ['an escaped ampersand once, never twice', '&amp;#34; and &amp;quot;', '&#34; and &quot;'],
    ['text without references', 'plain/key name.txt', 'plain/key name.txt'],
  ])('decodes %s', (_name, input, expected) => {
    expect(decodeXmlText(input)).toBe(expected);
  });

  it.each([
    ['NUL', '&#0;'],
    ['a C0 control that XML 1.0 forbids', '&#8;'],
    ['vertical tab', '&#xB;'],
    ['a high surrogate', '&#xD800;'],
    ['a low surrogate', '&#xDFFF;'],
    ['the non-character U+FFFE', '&#xFFFE;'],
    ['the non-character U+FFFF', '&#xFFFF;'],
    ['a value past the last code point', '&#x110000;'],
    ['a decimal value past the last code point', '&#99999999;'],
    ['a reference with more digits than any code point needs', `&#${'0'.repeat(64)}34;`],
    ['a hexadecimal reference with more digits than any code point needs', `&#x${'0'.repeat(64)}22;`],
  ])('refuses a reference to %s with a typed MalformedXML error', (_name, input) => {
    let thrown: unknown;
    try {
      decodeXmlText(input);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StorageServiceError);
    expect((thrown as StorageServiceError).code).toBe(MALFORMED_XML_CODE);
    expect((thrown as StorageServiceError).retryable).toBe(false);
  });
});

describe('parseS3ErrorXml', () => {
  it('decodes numeric references in an error document', () => {
    expect(parseS3ErrorXml('<Error><Code>NoSuchKey</Code><Message>no &#34;a&#34;&#x27;s key</Message></Error>')).toEqual({
      code: 'NoSuchKey',
      message: 'no "a"\'s key',
      requestId: undefined,
    });
  });

  it('yields nothing for an illegal reference, so the HTTP status alone decides the error', () => {
    expect(parseS3ErrorXml('<Error><Code>SlowDown</Code><Message>x&#0;y</Message></Error>')).toEqual({});
  });
});

describe('S3ObjectClient against a server that escapes XML like Go (&#34;, &#39;)', () => {
  let server: S3StubServer;
  let client: S3ObjectClient;

  beforeAll(async () => {
    server = await startS3StubServer({
      bucket: BUCKET,
      credentials: { [CREDENTIALS.accessKeyId]: CREDENTIALS.secretAccessKey },
      xmlStyle: 'numeric',
    });
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    server.objects.clear();
    server.uploads.clear();
    server.requests.length = 0;
    client = new S3ObjectClient({
      endpoint: server.url,
      region: REGION,
      bucket: BUCKET,
      ...CREDENTIALS,
      providerName: 's3',
      retryBaseDelayMs: 0,
      requestTimeoutMs: 5_000,
    });
  });

  it('lists keys that XML cannot carry, and keys with + and spaces, exactly as stored', async () => {
    const stored = ['listing/ctrl\u0001char.bin', 'listing/plus+and space.bin', 'listing/percent%41.bin'];
    for (const key of stored) {
      server.objects.set(key, { body: Buffer.from('x'), contentType: 'application/octet-stream', etag: `"${md5Hex(Buffer.from('x'))}"` });
    }
    const listed: string[] = [];
    for await (const object of client.listAll('listing/', 10)) listed.push(object.key);
    expect([...listed].sort()).toEqual([...stored].sort());
    const listRequest = server.requests.find((request) => request.query.get('list-type') === '2');
    expect(listRequest?.query.get('encoding-type')).toBe('url');
  });

  it('returns the multipart ETag without quotes or entities', async () => {
    const key = 'multipart/it\'s "quoted".bin';
    const first = Buffer.from('first part body');
    const second = Buffer.from('second part body');
    const uploadId = await client.createMultipartUpload(key);
    const one = await client.uploadPart(key, uploadId, 1, first);
    const two = await client.uploadPart(key, uploadId, 2, second);

    const result = await client.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: one.etag },
      { partNumber: 2, etag: two.etag },
    ]);

    expect(result.etag).toBe(`${md5Hex(Buffer.concat([md5Bytes(first), md5Bytes(second)]))}-2`);
  });

  it('lists keys and ETags exactly as stored', async () => {
    const keys = ['dir/it\'s.bin', 'dir/say "hi".bin', 'dir/a&b<c>.bin'];
    const body = Buffer.from('listed body');
    for (const key of keys) await client.putBuffer(key, body);

    const listed: Array<{ key: string; etag: string }> = [];
    for await (const object of client.listAll('dir/', 100)) listed.push({ key: object.key, etag: object.etag });

    expect(listed.map((object) => object.key).sort()).toEqual([...keys].sort());
    for (const object of listed) expect(object.etag).toBe(md5Hex(body));
  });

  it('lists the parts of an upload with plain ETags', async () => {
    const key = 'parts/it\'s.bin';
    const body = Buffer.from('part body');
    const uploadId = await client.createMultipartUpload(key);
    await client.uploadPart(key, uploadId, 1, body);

    const parts = await client.listParts(key, uploadId);

    expect(parts.map((part) => part.partNumber)).toEqual([1]);
    expect(parts[0].etag.replace(/"/g, '')).toBe(md5Hex(body));
    expect(Buffer.from(parts[0].etag, UTF8).includes('&')).toBe(false);
  });
});
