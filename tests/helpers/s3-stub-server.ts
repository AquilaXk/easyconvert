import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifySigV4Query, verifySigV4Request, type SigV4VerifyResult } from './sigv4-verifier';

/**
 * Minimal path-style S3 endpoint for adapter tests. Every request is authenticated with the
 * independent verifier in ./sigv4-verifier; a bad signature gets the S3 SignatureDoesNotMatch
 * error document. Objects and multipart sessions live in memory.
 */

export interface StubRequestRecord {
  method: string;
  rawUrl: string;
  key: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  bodyLength: number;
  auth: SigV4VerifyResult;
}

export interface StubFault {
  /** Selects the requests to fail. */
  match: (req: StubRequestRecord) => boolean;
  status: number;
  code?: string;
  /** Send this XML in a 200 response instead (CompleteMultipartUpload can fail inside a 200). */
  errorIn200?: boolean;
  /** Number of matching requests to fail; Infinity for all. */
  times: number;
  /** Delay before answering, in ms. */
  delayMs?: number;
  /** Raw response body to send instead of the generated error document. */
  body?: string;
  /** Send the status line and part of the body, then never finish it. */
  stallBody?: boolean;
  /** Promise a 1000-byte body, send a few bytes, then reset the connection. */
  truncateBody?: boolean;
  /** Send the status line, then one space every `dripMs` until the client goes away (slow-loris). */
  dripMs?: number;
  /** Set by the stub when the client closed a stalled or dripping response's connection. */
  clientClosed?: boolean;
}

export interface StubCompleteBehavior {
  /** Send 200 headers, then this many single spaces at this interval before the result XML. */
  keepalive?: { count: number; intervalMs: number; chunk?: string };
  /** Complete the upload, then answer with this error instead of the result (once). */
  failAfterComplete?: { status: number; code: string };
  /** Runs right after an upload is assembled, e.g. to simulate another writer replacing the object. */
  afterComplete?: (key: string) => void;
}

export interface StoredStubObject {
  body: Buffer;
  contentType: string;
  etag: string;
  /** `x-amz-meta-*` headers sent with the PUT, keyed without the prefix. */
  metadata?: Record<string, string>;
}

export interface S3StubServer {
  url: string;
  host: string;
  bucket: string;
  objects: Map<string, StoredStubObject>;
  uploads: Map<string, Map<number, Buffer>>;
  requests: StubRequestRecord[];
  faults: StubFault[];
  complete: StubCompleteBehavior;
  close: () => Promise<void>;
}

function errorXml(code: string, message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${message}</Message><RequestId>STUBREQ1</RequestId></Error>`;
}

/**
 * MD5 digest for the S3 ETag. This computes an S3 protocol integrity checksum, not a security
 * control: S3 defines object and multipart ETags as MD5, so the stub must produce the same value.
 */
export function s3EtagMd5(data: Buffer): Buffer {
  return crypto.createHash('md5').update(data).digest(); // NOSONAR S4790: S3 protocol ETag checksum, not a security control
}

function md5Etag(body: Buffer): string {
  return `"${s3EtagMd5(body).toString('hex')}"`;
}

function send(res: http.ServerResponse, status: number, body = '', headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/xml', ...headers });
  res.end(body);
}

const META_PREFIX = 'x-amz-meta-';
const LAST_MODIFIED = 'Wed, 01 Oct 2026 10:00:00 GMT';
const DEFAULT_MAX_KEYS = 1000;
const DEFAULT_MAX_PARTS = 1000;
const RANGE_PATTERN = /^bytes=(\d+)-(\d*)$/;

function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Escaping as Go's encoding/xml EscapeText writes it, which MinIO and other Go servers send:
 * numeric character references for quotes and whitespace controls instead of `&quot;`/`&apos;`.
 */
const GO_XML_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&#34;'],
  ["'", '&#39;'],
  ['\t', '&#x9;'],
  ['\n', '&#xA;'],
  ['\r', '&#xD;'],
]);

function goXmlEscape(text: string): string {
  return text.replace(/[&<>"'\t\n\r]/g, (ch) => GO_XML_ESCAPES.get(ch) ?? ch);
}

function metadataFrom(headers: http.IncomingHttpHeaders): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.startsWith(META_PREFIX) && typeof value === 'string') {
      metadata[name.slice(META_PREFIX.length)] = value;
    }
  }
  return metadata;
}

/** Form URL encoding of UTF-8 bytes: unreserved bytes kept, space as `+`, everything else `%XX`. */
function formEncode(text: string): string {
  let out = '';
  for (const byte of Buffer.from(text, 'utf-8')) {
    const isUnreserved =
      (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39) || '-_.~'.includes(String.fromCharCode(byte));
    if (isUnreserved) out += String.fromCharCode(byte);
    else if (byte === 0x20) out += '+';
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

export async function startS3StubServer(options: {
  bucket: string;
  credentials: Record<string, string>;
  /** Clock for presigned-URL validity; defaults to the real time. */
  now?: () => Date;
  /**
   * How response XML text is escaped: `named` writes `&quot;` for a quote (AWS S3), `numeric` writes
   * Go-style numeric character references such as `&#34;` (MinIO). Defaults to `named`.
   */
  xmlStyle?: 'named' | 'numeric';
}): Promise<S3StubServer> {
  const escapeText = options.xmlStyle === 'numeric' ? goXmlEscape : xmlEscape;
  /** An ETag as element text; the quotes around the hash are escaped like any other text. */
  const etagText = (etag: string): string => etag.replace(/"/g, options.xmlStyle === 'numeric' ? '&#34;' : '&quot;');
  const objects = new Map<string, StoredStubObject>();
  const uploads = new Map<string, Map<number, Buffer>>();
  /** Content-Type and `x-amz-meta-*` given at CreateMultipartUpload, which S3 applies to the assembled object. */
  const uploadInfo = new Map<string, { contentType: string; metadata: Record<string, string> }>();
  const requests: StubRequestRecord[] = [];
  const faults: StubFault[] = [];
  const complete: StubCompleteBehavior = {};
  let uploadCounter = 0;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const rawUrl = req.url ?? '/';
      const parsed = new URL(rawUrl, 'https://stub.invalid');
      const segments = parsed.pathname.split('/');
      const bucket = decodeURIComponent(segments[1] ?? '');
      const key = segments.slice(2).map((s) => decodeURIComponent(s)).join('/');
      const record: StubRequestRecord = {
        method: req.method ?? 'GET',
        rawUrl,
        key,
        query: parsed.searchParams,
        headers: req.headers,
        bodyLength: body.length,
        auth: parsed.searchParams.has('X-Amz-Signature')
          ? verifySigV4Query({
              method: req.method ?? 'GET',
              rawUrl,
              headers: req.headers,
              secretFor: (id) => options.credentials[id],
              now: (options.now ?? (() => new Date()))(),
            })
          : verifySigV4Request({
              method: req.method ?? 'GET',
              rawUrl,
              headers: req.headers,
              body,
              secretFor: (id) => options.credentials[id],
            }),
      };
      requests.push(record);

      const respond = () => handle(record, body, bucket, res);
      const fault = faults.find((f) => f.times > 0 && f.match(record));
      if (!fault) {
        respond();
        return;
      }
      fault.times -= 1;
      const fail = () => {
        if (fault.stallBody || fault.dripMs) {
          res.on('close', () => {
            fault.clientClosed = true;
          });
        }
        if (fault.stallBody) {
          res.writeHead(fault.status, { 'content-type': 'application/xml' });
          res.write('<Error><Code>');
          return;
        }
        if (fault.dripMs) {
          res.writeHead(fault.status, { 'content-type': 'application/xml' });
          const drip = setInterval(() => res.write(' '), fault.dripMs);
          res.on('close', () => clearInterval(drip));
          return;
        }
        if (fault.truncateBody) {
          res.writeHead(fault.status, { 'content-type': 'application/octet-stream', 'content-length': '1000' });
          res.write(Buffer.alloc(10, 0x41), () => res.socket?.destroy());
          return;
        }
        const xml = fault.body ?? errorXml(fault.code ?? 'InternalError', 'Injected failure');
        if (fault.errorIn200) {
          send(res, 200, xml);
        } else if (record.method === 'HEAD') {
          send(res, fault.status);
        } else {
          send(res, fault.status, xml);
        }
      };
      if (fault.delayMs) {
        setTimeout(fail, fault.delayMs);
      } else {
        fail();
      }
    });
  });

  function handle(record: StubRequestRecord, body: Buffer, bucket: string, res: http.ServerResponse): void {
    const noBody = record.method === 'HEAD';
    if (!record.auth.ok) {
      send(res, 403, noBody ? '' : errorXml('SignatureDoesNotMatch', 'The request signature we calculated does not match the signature you provided.'));
      return;
    }
    if (bucket !== options.bucket) {
      send(res, 404, noBody ? '' : errorXml('NoSuchBucket', 'The specified bucket does not exist'));
      return;
    }
    if (record.method === 'POST' && record.query.has('uploads')) {
      uploadCounter += 1;
      const id = `stub-upload-${uploadCounter}`;
      uploads.set(id, new Map());
      uploadInfo.set(id, {
        contentType: String(record.headers['content-type'] ?? 'binary/octet-stream'),
        metadata: metadataFrom(record.headers),
      });
      send(res, 200, `<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${record.key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
      return;
    }
    const uploadId = record.query.get('uploadId');
    if (uploadId !== null) {
      handleUpload(record, body, bucket, uploadId, res);
      return;
    }
    if (record.key === '' && record.method === 'GET' && record.query.get('list-type') === '2') {
      handleListObjects(record, bucket, res);
      return;
    }
    handleObject(record, body, res);
  }

  /** UploadPart, ListParts, AbortMultipartUpload, and CompleteMultipartUpload for one upload id. */
  function handleUpload(record: StubRequestRecord, body: Buffer, bucket: string, uploadId: string, res: http.ServerResponse): void {
    const parts = uploads.get(uploadId);
    if (!parts) {
      send(res, 404, errorXml('NoSuchUpload', 'The specified upload does not exist'));
      return;
    }
    switch (record.method) {
      case 'PUT':
        parts.set(Number(record.query.get('partNumber')), body);
        send(res, 200, '', { etag: md5Etag(body) });
        return;
      case 'GET': {
        const marker = Number(record.query.get('part-number-marker') ?? '0');
        const maxParts = Number(record.query.get('max-parts') ?? DEFAULT_MAX_PARTS);
        const remaining = [...parts.keys()].sort((a, b) => a - b).filter((n) => n > marker);
        const page = remaining.slice(0, maxParts);
        const truncated = remaining.length > page.length;
        const entries = page.map((n) => {
          const part = parts.get(n) as Buffer;
          return `<Part><PartNumber>${n}</PartNumber><LastModified>2026-10-01T10:00:00.000Z</LastModified><ETag>${etagText(md5Etag(part))}</ETag><Size>${part.length}</Size></Part>`;
        });
        send(
          res,
          200,
          `<ListPartsResult><Bucket>${bucket}</Bucket><Key>${escapeText(record.key)}</Key><UploadId>${uploadId}</UploadId>` +
            `<PartNumberMarker>${marker}</PartNumberMarker>` +
            `<NextPartNumberMarker>${page.length > 0 ? page[page.length - 1] : marker}</NextPartNumberMarker>` +
            `<MaxParts>${maxParts}</MaxParts><IsTruncated>${truncated}</IsTruncated>${entries.join('')}</ListPartsResult>`
        );
        return;
      }
      case 'DELETE':
        uploads.delete(uploadId);
        uploadInfo.delete(uploadId);
        send(res, 204);
        return;
      case 'POST':
        handleComplete(record.key, body, bucket, uploadId, parts, res);
        return;
      default:
        send(res, 405, errorXml('MethodNotAllowed', 'Method not allowed'));
    }
  }

  /** Parts named in the Complete body, in order, or null when one is missing or its ETag differs. */
  function orderedParts(body: Buffer, parts: Map<number, Buffer>): Buffer[] | null {
    const listed = [...body.toString('utf-8').matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>([^<]*)<\/ETag>/g)];
    const ordered: Buffer[] = [];
    for (const [, num, etag] of listed) {
      const part = parts.get(Number(num));
      if (!part || etag.replace(/&quot;/g, '"') !== md5Etag(part)) {
        return null;
      }
      ordered.push(part);
    }
    return ordered;
  }

  function handleComplete(
    key: string,
    body: Buffer,
    bucket: string,
    uploadId: string,
    parts: Map<number, Buffer>,
    res: http.ServerResponse
  ): void {
    const ordered = orderedParts(body, parts);
    if (!ordered) {
      send(res, 400, errorXml('InvalidPart', 'One or more of the specified parts could not be found'));
      return;
    }
    // S3 multipart ETag: MD5 of the concatenated binary part MD5s, then "-<part count>".
    const partDigests = Buffer.concat(ordered.map((part) => s3EtagMd5(part)));
    const etag = `"${s3EtagMd5(partDigests).toString('hex')}-${ordered.length}"`;
    const info = uploadInfo.get(uploadId);
    objects.set(key, {
      body: Buffer.concat(ordered),
      contentType: info?.contentType ?? 'application/octet-stream',
      etag,
      metadata: info?.metadata ?? {},
    });
    uploads.delete(uploadId);
    uploadInfo.delete(uploadId);
    complete.afterComplete?.(key);
    if (complete.failAfterComplete) {
      const { status, code } = complete.failAfterComplete;
      complete.failAfterComplete = undefined;
      send(res, status, errorXml(code, 'Injected failure after completion'));
      return;
    }
    const resultXml = `<CompleteMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${escapeText(key)}</Key><ETag>${etagText(etag)}</ETag></CompleteMultipartUploadResult>`;
    if (complete.keepalive) {
      sendWithKeepalive(res, resultXml, complete.keepalive);
      return;
    }
    send(res, 200, resultXml);
  }

  /** 200 headers, then `count` whitespace chunks at `intervalMs`, then the result XML. */
  function sendWithKeepalive(
    res: http.ServerResponse,
    resultXml: string,
    keepalive: NonNullable<StubCompleteBehavior['keepalive']>
  ): void {
    res.writeHead(200, { 'content-type': 'application/xml' });
    let sent = 0;
    const tick = setInterval(() => {
      if (sent < keepalive.count) {
        res.write(keepalive.chunk ?? ' ');
        sent += 1;
        return;
      }
      clearInterval(tick);
      res.end(resultXml);
    }, keepalive.intervalMs);
  }

  /** PutObject, GetObject, HeadObject, and DeleteObject. */
  function handleObject(record: StubRequestRecord, body: Buffer, res: http.ServerResponse): void {
    const { method, key } = record;
    const object = objects.get(key);
    switch (method) {
      case 'PUT': {
        const etag = md5Etag(body);
        objects.set(key, {
          body,
          contentType: String(record.headers['content-type'] ?? 'binary/octet-stream'),
          etag,
          metadata: metadataFrom(record.headers),
        });
        send(res, 200, '', { etag });
        return;
      }
      case 'GET':
        if (!object) {
          send(res, 404, errorXml('NoSuchKey', 'The specified key does not exist.'));
          return;
        }
        serveObject(record, object, res);
        return;
      case 'HEAD':
        if (!object) {
          send(res, 404);
          return;
        }
        res.writeHead(200, { ...objectHeaders(object), 'content-length': String(object.body.length) });
        res.end();
        return;
      case 'DELETE':
        objects.delete(key);
        send(res, 204);
        return;
      default:
        send(res, 405, errorXml('MethodNotAllowed', 'Method not allowed'));
    }
  }

  function objectHeaders(object: StoredStubObject): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': object.contentType,
      etag: object.etag,
      'last-modified': LAST_MODIFIED,
    };
    for (const [name, value] of Object.entries(object.metadata ?? {})) {
      headers[`${META_PREFIX}${name}`] = value;
    }
    return headers;
  }

  /** GetObject with RFC 9110 single-range support: 206 for a satisfiable range, 416 past the end. */
  function serveObject(record: StubRequestRecord, object: StoredStubObject, res: http.ServerResponse): void {
    const rangeHeader = record.headers.range;
    const match = typeof rangeHeader === 'string' ? RANGE_PATTERN.exec(rangeHeader) : null;
    if (!match) {
      res.writeHead(200, { ...objectHeaders(object), 'content-length': String(object.body.length) });
      res.end(object.body);
      return;
    }
    const size = object.body.length;
    const start = Number(match[1]);
    const end = Math.min(match[2] === '' ? size - 1 : Number(match[2]), size - 1);
    if (start >= size || end < start) {
      send(res, 416, errorXml('InvalidRange', 'The requested range is not satisfiable'), {
        'content-range': `bytes */${size}`,
      });
      return;
    }
    const slice = object.body.subarray(start, end + 1);
    res.writeHead(206, {
      ...objectHeaders(object),
      'content-length': String(slice.length),
      'content-range': `bytes ${start}-${end}/${size}`,
    });
    res.end(slice);
  }

  /** S3 orders keys by UTF-8 binary order, which differs from UTF-16 code unit order for astral characters. */
  function compareUtf8Binary(a: string, b: string): number {
    return Buffer.compare(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8'));
  }

  /**
   * ListObjectsV2: lexicographic keys, `prefix`, `max-keys`, an opaque continuation token, and
   * `encoding-type=url`, which URL-encodes Key and Prefix (form encoding: space as `+`, every byte
   * outside `A-Za-z0-9-_.~` as `%XX`) so keys holding characters XML cannot carry still list.
   */
  function handleListObjects(record: StubRequestRecord, bucket: string, res: http.ServerResponse): void {
    const urlEncoded = record.query.get('encoding-type') === 'url';
    const keyText = (key: string): string => (urlEncoded ? formEncode(key) : escapeText(key));
    const prefix = record.query.get('prefix') ?? '';
    const maxKeys = Number(record.query.get('max-keys') ?? DEFAULT_MAX_KEYS);
    const token = record.query.get('continuation-token');
    const after = token ? Buffer.from(token, 'base64url').toString('utf-8') : '';
    const matching = [...objects.keys()]
      .filter((key) => key.startsWith(prefix) && compareUtf8Binary(key, after) > 0)
      .sort(compareUtf8Binary);
    const page = matching.slice(0, maxKeys);
    const truncated = matching.length > page.length;
    const next = truncated ? Buffer.from(page[page.length - 1], 'utf-8').toString('base64url') : '';
    const entries = page.map((key) => {
      const object = objects.get(key) as StoredStubObject;
      return `<Contents><Key>${keyText(key)}</Key><LastModified>2026-10-01T10:00:00.000Z</LastModified><ETag>${etagText(object.etag)}</ETag><Size>${object.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
    });
    send(
      res,
      200,
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><Prefix>${keyText(prefix)}</Prefix>` +
        (urlEncoded ? '<EncodingType>url</EncodingType>' : '') +
        (truncated ? `<NextContinuationToken>${next}</NextContinuationToken>` : '') +
        `<KeyCount>${page.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${entries.join('')}</ListBucketResult>`
    );
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const host = `127.0.0.1:${port}`;
  return {
    url: `http://${host}`,
    host,
    bucket: options.bucket,
    objects,
    uploads,
    requests,
    faults,
    complete,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
