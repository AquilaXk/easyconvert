import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifySigV4Request, type SigV4VerifyResult } from './sigv4-verifier';

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

export async function startS3StubServer(options: {
  bucket: string;
  credentials: Record<string, string>;
}): Promise<S3StubServer> {
  const objects = new Map<string, StoredStubObject>();
  const uploads = new Map<string, Map<number, Buffer>>();
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
      const parsed = new URL(rawUrl, 'http://stub.invalid');
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
        auth: verifySigV4Request({
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
      send(res, 200, `<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${record.key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
      return;
    }
    const uploadId = record.query.get('uploadId');
    if (uploadId !== null) {
      handleUpload(record, body, bucket, uploadId, res);
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
        const listed = [...parts.keys()].sort((a, b) => a - b).map((n) => `<Part><PartNumber>${n}</PartNumber></Part>`);
        send(res, 200, `<ListPartsResult><UploadId>${uploadId}</UploadId>${listed.join('')}</ListPartsResult>`);
        return;
      }
      case 'DELETE':
        uploads.delete(uploadId);
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
    objects.set(key, { body: Buffer.concat(ordered), contentType: 'application/octet-stream', etag });
    uploads.delete(uploadId);
    complete.afterComplete?.(key);
    if (complete.failAfterComplete) {
      const { status, code } = complete.failAfterComplete;
      complete.failAfterComplete = undefined;
      send(res, status, errorXml(code, 'Injected failure after completion'));
      return;
    }
    const resultXml = `<CompleteMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${key}</Key><ETag>${etag.replace(/"/g, '&quot;')}</ETag></CompleteMultipartUploadResult>`;
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
        objects.set(key, { body, contentType: String(record.headers['content-type'] ?? 'binary/octet-stream'), etag });
        send(res, 200, '', { etag });
        return;
      }
      case 'GET':
        if (!object) {
          send(res, 404, errorXml('NoSuchKey', 'The specified key does not exist.'));
          return;
        }
        res.writeHead(200, { 'content-type': object.contentType, 'content-length': String(object.body.length), etag: object.etag });
        res.end(object.body);
        return;
      case 'HEAD':
        if (!object) {
          send(res, 404);
          return;
        }
        res.writeHead(200, { 'content-type': object.contentType, 'content-length': String(object.body.length), etag: object.etag, 'last-modified': 'Wed, 01 Oct 2026 10:00:00 GMT' });
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
