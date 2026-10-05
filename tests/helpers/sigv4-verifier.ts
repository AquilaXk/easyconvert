import crypto from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

/**
 * Independent server-side SigV4 (header auth) verifier for test stubs. It is written from the
 * SigV4 specification and imports nothing from src/, so it can judge the production signer.
 * It rebuilds the canonical request from what arrived on the wire: decoded path segments and
 * query pairs are re-encoded with its own RFC 3986 encoder.
 */

const UNSIGNED = 'UNSIGNED-PAYLOAD';
const AUTH_PATTERN =
  /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, ?SignedHeaders=([a-z0-9;-]+), ?Signature=([0-9a-f]{64})$/;
const UNRESERVED = /[A-Za-z0-9\-._~]/;

export interface SigV4VerifyInput {
  method: string;
  /** Raw request target as received, e.g. `/bucket/a%20b?uploads=`. */
  rawUrl: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
  secretFor: (accessKeyId: string) => string | undefined;
}

export interface SigV4VerifyResult {
  ok: boolean;
  reason?: string;
  accessKeyId?: string;
  region?: string;
  service?: string;
  signedHeaders?: string[];
  payloadHash?: string;
}

function rfc3986(value: string): string {
  let out = '';
  for (const byte of Buffer.from(value, 'utf-8')) {
    const ch = String.fromCharCode(byte);
    out += UNRESERVED.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

function hmac(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf-8').digest();
}

function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function canonicalPath(rawPath: string): string {
  return rawPath
    .split('/')
    .map((segment) => rfc3986(decodeURIComponent(segment)))
    .join('/');
}

function canonicalQuery(rawQuery: string, exclude: ReadonlySet<string> = new Set()): string {
  if (!rawQuery) return '';
  const pairs = rawQuery.split('&').filter(Boolean).map((pair) => {
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? '' : pair.slice(eq + 1);
    return [decodeURIComponent(key), rfc3986(decodeURIComponent(value))];
  }).filter(([name]) => !exclude.has(name)).map(([name, value]) => [rfc3986(name), value]);
  pairs.sort((a, b) => (a[0] === b[0] ? Number(a[1] > b[1]) - Number(a[1] < b[1]) : Number(a[0] > b[0]) - Number(a[0] < b[0])));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  if (value === undefined) return undefined;
  const joined = Array.isArray(value) ? value.join(',') : value;
  return joined.trim().replace(/\s+/g, ' ');
}

export function verifySigV4Request(input: SigV4VerifyInput): SigV4VerifyResult {
  const auth = headerValue(input.headers, 'authorization');
  const match = auth ? AUTH_PATTERN.exec(auth) : null;
  if (!match) return { ok: false, reason: 'missing or malformed Authorization header' };
  const [, accessKeyId, dateStamp, region, service, signedHeaderList, signature] = match;

  const secret = input.secretFor(accessKeyId);
  if (!secret) return { ok: false, reason: 'unknown access key', accessKeyId };

  const amzDate = headerValue(input.headers, 'x-amz-date');
  if (!amzDate || !/^\d{8}T\d{6}Z$/.test(amzDate) || amzDate.slice(0, 8) !== dateStamp) {
    return { ok: false, reason: 'x-amz-date missing or outside the credential scope' };
  }

  const signedHeaders = signedHeaderList.split(';');
  if (!signedHeaders.includes('host') || !signedHeaders.includes('x-amz-date')) {
    return { ok: false, reason: 'host and x-amz-date must be signed' };
  }
  const canonicalHeaderLines: string[] = [];
  for (const name of signedHeaders) {
    const value = headerValue(input.headers, name);
    if (value === undefined) return { ok: false, reason: `signed header ${name} not sent` };
    canonicalHeaderLines.push(`${name}:${value}\n`);
  }

  const payloadHash = headerValue(input.headers, 'x-amz-content-sha256');
  if (!payloadHash) return { ok: false, reason: 'x-amz-content-sha256 missing' };
  if (payloadHash !== UNSIGNED && payloadHash !== sha256(input.body)) {
    return { ok: false, reason: 'x-amz-content-sha256 does not match the body' };
  }

  const queryIndex = input.rawUrl.indexOf('?');
  const rawPath = queryIndex === -1 ? input.rawUrl : input.rawUrl.slice(0, queryIndex);
  const rawQuery = queryIndex === -1 ? '' : input.rawUrl.slice(queryIndex + 1);

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(rawPath),
    canonicalQuery(rawQuery),
    canonicalHeaderLines.join(''),
    signedHeaderList,
    payloadHash,
  ].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), service), 'aws4_request');
  const expected = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf-8').digest();
  const provided = Buffer.from(signature, 'hex');
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'signature mismatch', accessKeyId };
  }
  return { ok: true, accessKeyId, region, service, signedHeaders, payloadHash };
}

const QUERY_ALGORITHM = 'AWS4-HMAC-SHA256';
const MAX_PRESIGN_SECONDS = 604800;
const MAX_FUTURE_SKEW_MS = 15 * 60 * 1000;
const CREDENTIAL_PATTERN = /^([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request$/;

export interface SigV4QueryVerifyInput {
  method: string;
  /** Raw request target as received, including the `X-Amz-*` query parameters. */
  rawUrl: string;
  headers: IncomingHttpHeaders;
  secretFor: (accessKeyId: string) => string | undefined;
  now: Date;
}

function parseAmzDate(value: string): number | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!m) return undefined;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

/**
 * Independent verifier for SigV4 query-string authentication (presigned URLs), written from
 * "Authenticating Requests: Using Query Parameters": every parameter except X-Amz-Signature is
 * canonicalised, the payload is UNSIGNED-PAYLOAD, and the URL is valid from X-Amz-Date for
 * X-Amz-Expires seconds.
 */
export function verifySigV4Query(input: SigV4QueryVerifyInput): SigV4VerifyResult {
  const queryIndex = input.rawUrl.indexOf('?');
  const rawPath = queryIndex === -1 ? input.rawUrl : input.rawUrl.slice(0, queryIndex);
  const rawQuery = queryIndex === -1 ? '' : input.rawUrl.slice(queryIndex + 1);
  const params = new Map<string, string>();
  for (const pair of rawQuery.split('&').filter(Boolean)) {
    const eq = pair.indexOf('=');
    const name = decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq));
    params.set(name, decodeURIComponent(eq === -1 ? '' : pair.slice(eq + 1)));
  }

  if (params.get('X-Amz-Algorithm') !== QUERY_ALGORITHM) return { ok: false, reason: 'unsupported X-Amz-Algorithm' };
  const credential = CREDENTIAL_PATTERN.exec(params.get('X-Amz-Credential') ?? '');
  if (!credential) return { ok: false, reason: 'malformed X-Amz-Credential' };
  const [, accessKeyId, dateStamp, region, service] = credential;
  const secret = input.secretFor(accessKeyId);
  if (!secret) return { ok: false, reason: 'unknown access key', accessKeyId };

  const amzDate = params.get('X-Amz-Date') ?? '';
  const signedAt = parseAmzDate(amzDate);
  if (signedAt === undefined || amzDate.slice(0, 8) !== dateStamp) {
    return { ok: false, reason: 'X-Amz-Date missing or outside the credential scope' };
  }
  const expires = Number(params.get('X-Amz-Expires'));
  if (!Number.isInteger(expires) || expires < 1 || expires > MAX_PRESIGN_SECONDS) {
    return { ok: false, reason: 'X-Amz-Expires must be between 1 and 604800' };
  }
  const nowMs = input.now.getTime();
  if (nowMs < signedAt - MAX_FUTURE_SKEW_MS) return { ok: false, reason: 'request is not valid yet' };
  if (nowMs > signedAt + expires * 1000) return { ok: false, reason: 'request has expired' };

  const signedHeaderList = params.get('X-Amz-SignedHeaders') ?? '';
  const signedHeaders = signedHeaderList.split(';').filter(Boolean);
  if (!signedHeaders.includes('host')) return { ok: false, reason: 'host must be signed' };
  const canonicalHeaderLines: string[] = [];
  for (const name of signedHeaders) {
    const value = headerValue(input.headers, name);
    if (value === undefined) return { ok: false, reason: `signed header ${name} not sent` };
    canonicalHeaderLines.push(`${name}:${value}\n`);
  }

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(rawPath),
    canonicalQuery(rawQuery, new Set(['X-Amz-Signature'])),
    canonicalHeaderLines.join(''),
    signedHeaderList,
    UNSIGNED,
  ].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), service), 'aws4_request');
  const expected = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf-8').digest();
  const provided = Buffer.from(params.get('X-Amz-Signature') ?? '', 'hex');
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'signature mismatch', accessKeyId };
  }
  return { ok: true, accessKeyId, region, service, signedHeaders, payloadHash: UNSIGNED };
}
