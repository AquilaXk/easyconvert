import crypto from 'node:crypto';
import {
  buildCanonicalRequest,
  buildStringToSign,
  calculateSignature,
  deriveSigningKey,
  formatSigV4Date,
  getCanonicalHeaders,
  uriEncode,
} from './sigv4-presigner';

/**
 * AWS Signature Version 4 header signing for S3-compatible object storage requests.
 * The path is taken as raw (decoded) segments and encoded exactly once, so the same string is
 * used on the wire and in the canonical request and a key is never double-encoded.
 */

export const SIGV4_ALGORITHM = 'AWS4-HMAC-SHA256';
export const S3_SERVICE = 's3';
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
export const EMPTY_PAYLOAD_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const REGION_PATTERN = /^[a-z0-9-]{1,64}$/;
/** Headers that hop-by-hop proxies or the HTTP client may rewrite, so they are never signed. */
const UNSIGNABLE_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'content-length',
  'user-agent',
  'connection',
  'expect',
  'transfer-encoding',
]);
const SEGMENT_SEPARATOR = '/';

export class SigV4SigningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SigV4SigningError';
  }
}

export interface SigV4RequestCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignedRequestInput {
  method: string;
  /** Scheme and authority only, e.g. `https://bucket.s3.eu-west-1.example`; any path is ignored. */
  origin: string;
  /** Raw, decoded path beginning with "/"; each segment is URI-encoded once. */
  path: string;
  query?: ReadonlyArray<readonly [string, string]>;
  headers?: Record<string, string>;
  /** Lowercase hex SHA-256 of the body, or `UNSIGNED-PAYLOAD` for a streamed body. */
  payloadHash: string;
  credentials: SigV4RequestCredentials;
  region: string;
  service?: string;
  now?: Date;
  /** S3 requires `x-amz-content-sha256`; other SigV4 services do not send it. Defaults to true. */
  includeContentSha256Header?: boolean;
}

export interface SignedRequest {
  url: string;
  /** Headers to send, including `authorization`, `host`, and `x-amz-date`. */
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
  signedHeaders: string;
}

/** Encodes a raw path per segment (RFC 3986 unreserved set kept, "/" kept as the separator). */
export function encodeS3Path(rawPath: string): string {
  if (!rawPath.startsWith(SEGMENT_SEPARATOR)) {
    throw new SigV4SigningError('Request path must begin with "/".');
  }
  return rawPath
    .split(SEGMENT_SEPARATOR)
    .map((segment) => uriEncode(segment, true))
    .join(SEGMENT_SEPARATOR);
}

/** Sorted canonical query; the identical string is sent on the wire. */
export function encodeS3Query(query: ReadonlyArray<readonly [string, string]>): string {
  const encoded = query.map(([key, value]) => [uriEncode(key, true), uriEncode(value, true)] as const);
  encoded.sort(([keyA, valueA], [keyB, valueB]) => {
    if (keyA !== keyB) return keyA < keyB ? -1 : 1;
    if (valueA === valueB) return 0;
    return valueA < valueB ? -1 : 1;
  });
  return encoded.map(([key, value]) => `${key}=${value}`).join('&');
}

export function sha256Hex(data: string | Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function parseOrigin(origin: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new SigV4SigningError('Request origin is not a valid URL.');
  }
  if (parsed.username || parsed.password) {
    throw new SigV4SigningError('Request origin must not carry user info.');
  }
  return parsed;
}

function assertSignableInput(input: SignedRequestInput): void {
  if (!input.credentials.accessKeyId || !input.credentials.secretAccessKey) {
    throw new SigV4SigningError('Access key id and secret access key are required.');
  }
  if (!REGION_PATTERN.test(input.region)) {
    throw new SigV4SigningError('Region must be lowercase letters, digits, and hyphens.');
  }
  if (input.payloadHash !== UNSIGNED_PAYLOAD && !SHA256_HEX_PATTERN.test(input.payloadHash)) {
    throw new SigV4SigningError('Payload hash must be lowercase hex SHA-256 or UNSIGNED-PAYLOAD.');
  }
}

/** Signs a request with an `Authorization` header (SigV4, header-based authentication). */
export function signS3Request(input: SignedRequestInput): SignedRequest {
  assertSignableInput(input);
  const origin = parseOrigin(input.origin);
  const service = input.service ?? S3_SERVICE;
  const { requestDate, dateStamp } = formatSigV4Date(input.now ?? new Date());

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    headers[name.toLowerCase()] = value;
  }
  headers.host = origin.host;
  headers['x-amz-date'] = requestDate;
  if (input.includeContentSha256Header ?? true) {
    headers['x-amz-content-sha256'] = input.payloadHash;
  }
  if (input.credentials.sessionToken) {
    headers['x-amz-security-token'] = input.credentials.sessionToken;
  }

  const toSign: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!UNSIGNABLE_HEADERS.has(name)) {
      toSign[name] = value;
    }
  }
  const { canonicalHeaders, signedHeaders } = getCanonicalHeaders(toSign);

  const canonicalUri = encodeS3Path(input.path);
  const canonicalQueryString = encodeS3Query(input.query ?? []);
  const canonicalRequest = buildCanonicalRequest({
    method: input.method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    hashedPayload: input.payloadHash,
  });

  const credentialScope = `${dateStamp}/${input.region}/${service}/aws4_request`;
  const stringToSign = buildStringToSign({
    algorithm: SIGV4_ALGORITHM,
    requestDate,
    credentialScope,
    canonicalRequest,
  });
  const signingKey = deriveSigningKey(input.credentials.secretAccessKey, dateStamp, input.region, service);
  const signature = calculateSignature(signingKey, stringToSign);

  headers.authorization =
    `${SIGV4_ALGORITHM} Credential=${input.credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const search = canonicalQueryString ? `?${canonicalQueryString}` : '';
  return {
    url: `${origin.protocol}//${origin.host}${canonicalUri}${search}`,
    headers,
    canonicalRequest,
    stringToSign,
    signature,
    signedHeaders,
  };
}

export interface S3AddressInput {
  bucket: string;
  key: string;
  region: string;
  /** Custom endpoint origin (scheme and host[:port]); defaults to the regional S3 endpoint. */
  endpoint?: string;
  forcePathStyle?: boolean;
}

export interface S3Address {
  origin: string;
  /** Raw path, encoded later by the signer. */
  path: string;
  style: 'path' | 'virtual-hosted';
}

const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const IPV4_LIKE_PATTERN = /^\d+\.\d+\.\d+\.\d+$/;
const DOT_SEGMENTS: ReadonlySet<string> = new Set(['.', '..']);

/** Bucket names that can be a DNS label under TLS (no dots, so the wildcard certificate matches). */
function isVirtualHostableBucket(bucket: string): boolean {
  return !bucket.includes('.') && !bucket.includes('--');
}

export function assertValidBucketName(bucket: string): void {
  if (!BUCKET_NAME_PATTERN.test(bucket) || IPV4_LIKE_PATTERN.test(bucket) || bucket.includes('..')) {
    throw new SigV4SigningError(`Invalid bucket name "${bucket}".`);
  }
}

/**
 * Validates an object key: dot segments are refused because URL parsers collapse them, which
 * would move a path-style request into another bucket.
 */
export function assertValidObjectKey(key: string): void {
  if (!key) {
    throw new SigV4SigningError('Object key must not be empty.');
  }
  if (key.split(SEGMENT_SEPARATOR).some((segment) => DOT_SEGMENTS.has(segment))) {
    throw new SigV4SigningError('Object key must not contain "." or ".." path segments.');
  }
}

export function defaultS3Endpoint(region: string): string {
  return `https://s3.${region}.amazonaws.com`;
}

/** Resolves path-style or virtual-hosted-style addressing for an object. */
export function resolveS3Address(input: S3AddressInput): S3Address {
  assertValidBucketName(input.bucket);
  if (input.key !== '') {
    assertValidObjectKey(input.key);
  }
  if (!REGION_PATTERN.test(input.region)) {
    throw new SigV4SigningError('Region must be lowercase letters, digits, and hyphens.');
  }
  const endpoint = parseOrigin(input.endpoint ?? defaultS3Endpoint(input.region));
  const forcePathStyle = input.forcePathStyle ?? input.endpoint !== undefined;

  if (forcePathStyle || !isVirtualHostableBucket(input.bucket)) {
    const keyPart = input.key === '' ? '' : `/${input.key}`;
    return { origin: `${endpoint.protocol}//${endpoint.host}`, path: `/${input.bucket}${keyPart}`, style: 'path' };
  }
  return {
    origin: `${endpoint.protocol}//${input.bucket}.${endpoint.host}`,
    path: `/${input.key}`,
    style: 'virtual-hosted',
  };
}
