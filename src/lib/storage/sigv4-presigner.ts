import crypto from 'node:crypto';

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string; // defaults to 's3'
}

export type QueryParamValue = string | number | boolean | undefined | null;

export interface PresignQueryOptions {
  method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD';
  url: string;
  queryParams?: Record<string, QueryParamValue>;
  headers?: Record<string, string>;
  credentials: SigV4Credentials;
  expiresInSeconds?: number; // defaults to 900 (15 min)
  timestamp?: Date; // defaults to new Date()
}

export interface PresignQueryResult {
  url: string;
  expiresAt: number; // millisecond epoch timestamp
  signature: string;
  canonicalRequest: string;
  stringToSign: string;
}

export interface VerifySigV4Options {
  secretAccessKey: string;
  expectedMethod?: string;
  now?: Date;
  clockSkewSeconds?: number;
  headers?: Record<string, string>;
}

export interface VerifySigV4Result {
  valid: boolean;
  reason?: string;
  accessKeyId?: string;
  dateStamp?: string;
  region?: string;
  service?: string;
  expiresAt?: number;
  queryParams?: Record<string, string>;
}

/**
 * URI encode per RFC 3986.
 * Characters [A-Z, a-z, 0-9, '-', '_', '.', '~'] are unreserved.
 * If encodeSlash is false, '/' (%2F) is preserved unencoded.
 */
export function uriEncode(input: string, encodeSlash: boolean = true): string {
  const encoded = encodeURIComponent(input).replace(
    /[!'()*]/g,
    (c) => '%' + c.codePointAt(0)!.toString(16).toUpperCase()
  );
  if (!encodeSlash) {
    return encoded.replace(/%2F/gi, '/');
  }
  return encoded;
}

function safeDecode(str: string): string {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

/**
 * Builds the canonical URI for SigV4.
 * Normalized per RFC 3986 with exact single percent-encoding per segment.
 */
export function getCanonicalUri(pathname: string): string {
  if (!pathname || pathname === '' || pathname === '/') {
    return '/';
  }
  const segments = pathname.split('/').map((seg) => uriEncode(safeDecode(seg), true));
  const result = segments.join('/');
  return result.startsWith('/') ? result : '/' + result;
}

/**
 * Builds the canonical query string for SigV4.
 * Parameters are sorted by URI-encoded key in byte (ASCII) order,
 * and URI-encoded value for ties. X-Amz-Signature is excluded.
 */
export function getCanonicalQueryString(
  params: Record<string, string | number | boolean | undefined | null> | URLSearchParams
): string {
  const rawEntries: [string, string][] = [];

  if (params instanceof URLSearchParams) {
    for (const [key, value] of params.entries()) {
      if (key === 'X-Amz-Signature') continue;
      rawEntries.push([key, value]);
    }
  } else {
    for (const [key, value] of Object.entries(params)) {
      if (key === 'X-Amz-Signature' || value === undefined || value === null) continue;
      rawEntries.push([key, String(value)]);
    }
  }

  // Pre-encode key-value pairs per RFC 3986
  const encodedEntries = rawEntries.map(([k, v]) => ({
    key: uriEncode(k),
    val: uriEncode(v),
  }));

  // Sort by byte order of encoded key, then by byte order of encoded value
  encodedEntries.sort((a, b) => {
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    if (a.val !== b.val) return a.val < b.val ? -1 : 1;
    return 0;
  });

  return encodedEntries.map(({ key, val }) => `${key}=${val}`).join('&');
}

/**
 * Normalizes headers and builds canonical headers and signed headers list.
 */
export function getCanonicalHeaders(headers: Record<string, string | undefined>): {
  canonicalHeaders: string;
  signedHeaders: string;
} {
  const lowerHeaderMap = new Map<string, string>();

  for (const [name, val] of Object.entries(headers)) {
    if (val === undefined || val === null) continue;
    const lowerName = name.toLowerCase().trim();
    // Collapse internal whitespace sequences to single space and trim
    const trimmedVal = val.trim().replace(/\s+/g, ' ');
    lowerHeaderMap.set(lowerName, trimmedVal);
  }

  const sortedKeys = Array.from(lowerHeaderMap.keys()).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalHeaders = sortedKeys
    .map((k) => `${k}:${lowerHeaderMap.get(k)}\n`)
    .join('');
  const signedHeaders = sortedKeys.join(';');

  return { canonicalHeaders, signedHeaders };
}

/**
 * Builds the SigV4 Canonical Request string.
 */
export function buildCanonicalRequest(params: {
  method: string;
  canonicalUri: string;
  canonicalQueryString: string;
  canonicalHeaders: string;
  signedHeaders: string;
  hashedPayload: string;
}): string {
  return [
    params.method.toUpperCase(),
    params.canonicalUri,
    params.canonicalQueryString,
    params.canonicalHeaders,
    params.signedHeaders,
    params.hashedPayload,
  ].join('\n');
}

/**
 * Builds the SigV4 StringToSign.
 */
export function buildStringToSign(params: {
  algorithm?: string;
  requestDate: string;
  credentialScope: string;
  canonicalRequest: string;
}): string {
  const algorithm = params.algorithm || 'AWS4-HMAC-SHA256';
  const hashedCanonicalRequest = crypto
    .createHash('sha256')
    .update(params.canonicalRequest, 'utf8')
    .digest('hex');

  return [
    algorithm,
    params.requestDate,
    params.credentialScope,
    hashedCanonicalRequest,
  ].join('\n');
}

/**
 * Derives the SigV4 4-tier signing key using HMAC-SHA256.
 * kDate = HMAC-SHA256("AWS4" + secret, dateStamp)
 * kRegion = HMAC-SHA256(kDate, region)
 * kService = HMAC-SHA256(kRegion, service)
 * kSigning = HMAC-SHA256(kService, "aws4_request")
 */
export function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string
): Buffer {
  const kDate = crypto
    .createHmac('sha256', 'AWS4' + secretAccessKey)
    .update(dateStamp, 'utf8')
    .digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(region, 'utf8').digest();
  const kService = crypto.createHmac('sha256', kRegion).update(service, 'utf8').digest();
  return crypto.createHmac('sha256', kService).update('aws4_request', 'utf8').digest();
}

/**
 * Calculates the hex HMAC-SHA256 signature.
 */
export function calculateSignature(signingKey: Buffer, stringToSign: string): string {
  return crypto
    .createHmac('sha256', signingKey)
    .update(stringToSign, 'utf8')
    .digest('hex');
}

/**
 * Formats a Date object into SigV4 timestamps: { requestDate: "YYYYMMDDTHHMMSSZ", dateStamp: "YYYYMMDD" }.
 */
export function formatSigV4Date(date: Date): { requestDate: string; dateStamp: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return {
    requestDate: iso,
    dateStamp: iso.slice(0, 8),
  };
}

/**
 * Generates an AWS SigV4 presigned query-string URL.
 */
export function presignSigV4QueryUrl(options: PresignQueryOptions): PresignQueryResult {
  const method = options.method.toUpperCase() as PresignQueryOptions['method'];
  const timestamp = options.timestamp || new Date();
  const { requestDate, dateStamp } = formatSigV4Date(timestamp);

  const region = options.credentials.region || 'us-east-1';
  const service = options.credentials.service || 's3';
  const accessKeyId = options.credentials.accessKeyId;
  const secretAccessKey = options.credentials.secretAccessKey;

  const expiresInSeconds = options.expiresInSeconds ?? 900;
  if (expiresInSeconds < 1 || expiresInSeconds > 604800) {
    throw new Error(`Invalid expiresInSeconds: ${expiresInSeconds}. Must be between 1 and 604800 (7 days).`);
  }

  const expiresAt = timestamp.getTime() + expiresInSeconds * 1000;
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const credential = `${accessKeyId}/${credentialScope}`;

  // Parse input URL
  const isRelative = !options.url.startsWith('http://') && !options.url.startsWith('https://');
  const dummyBase = 'http://localhost';
  const parsed = new URL(options.url, dummyBase);

  // Headers
  const hostValue = parsed.host;
  const headersToSign: Record<string, string> = { host: hostValue, ...options.headers };
  const { canonicalHeaders, signedHeaders } = getCanonicalHeaders(headersToSign);

  // Query parameters: existing searchParams + options.queryParams + SigV4 query params
  const queryEntries: Record<string, QueryParamValue> = {};
  for (const [k, v] of parsed.searchParams.entries()) {
    queryEntries[k] = v;
  }
  if (options.queryParams) {
    for (const [k, v] of Object.entries(options.queryParams)) {
      queryEntries[k] = v;
    }
  }

  // SigV4 auth parameters
  queryEntries['X-Amz-Algorithm'] = 'AWS4-HMAC-SHA256';
  queryEntries['X-Amz-Credential'] = credential;
  queryEntries['X-Amz-Date'] = requestDate;
  queryEntries['X-Amz-Expires'] = expiresInSeconds;
  queryEntries['X-Amz-SignedHeaders'] = signedHeaders;

  const canonicalQueryString = getCanonicalQueryString(queryEntries);
  const canonicalUri = getCanonicalUri(parsed.pathname);
  const hashedPayload = 'UNSIGNED-PAYLOAD';

  const canonicalRequest = buildCanonicalRequest({
    method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    hashedPayload,
  });

  const stringToSign = buildStringToSign({
    algorithm: 'AWS4-HMAC-SHA256',
    requestDate,
    credentialScope,
    canonicalRequest,
  });

  const signingKey = deriveSigningKey(secretAccessKey, dateStamp, region, service);
  const signature = calculateSignature(signingKey, stringToSign);

  const finalQuery = `${canonicalQueryString}&X-Amz-Signature=${signature}`;

  let finalUrl: string;
  if (isRelative) {
    finalUrl = `${canonicalUri}?${finalQuery}`;
  } else {
    finalUrl = `${parsed.origin}${canonicalUri}?${finalQuery}`;
  }

  return {
    url: finalUrl,
    expiresAt,
    signature,
    canonicalRequest,
    stringToSign,
  };
}

/**
 * Verifies authenticity, timestamp, and signature of an incoming SigV4 presigned request.
 */
export function verifySigV4QueryUrl(
  urlStr: string,
  options: VerifySigV4Options
): VerifySigV4Result {
  try {
    const dummyBase = 'http://localhost';
    const parsed = new URL(urlStr, dummyBase);

    const algorithm = parsed.searchParams.get('X-Amz-Algorithm');
    const credential = parsed.searchParams.get('X-Amz-Credential');
    const requestDate = parsed.searchParams.get('X-Amz-Date');
    const expiresStr = parsed.searchParams.get('X-Amz-Expires');
    const signedHeadersStr = parsed.searchParams.get('X-Amz-SignedHeaders');
    const signature = parsed.searchParams.get('X-Amz-Signature');

    if (!algorithm || !credential || !requestDate || !expiresStr || !signedHeadersStr || !signature) {
      return { valid: false, reason: 'Missing required SigV4 query parameters' };
    }

    if (!/^[0-9a-fA-F]{64}$/.test(signature)) {
      return { valid: false, reason: 'Invalid X-Amz-Signature format: must be 64-character hex' };
    }

    if (algorithm !== 'AWS4-HMAC-SHA256') {
      return { valid: false, reason: `Unsupported algorithm: ${algorithm}` };
    }

    const expiresInSeconds = Number.parseInt(expiresStr, 10);
    if (!Number.isFinite(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 604800) {
      return { valid: false, reason: `Invalid X-Amz-Expires: ${expiresStr}. Must be between 1 and 604800 seconds.` };
    }

    // Parse ISO date string (YYYYMMDDTHHMMSSZ)
    if (!/^\d{8}T\d{6}Z$/.test(requestDate)) {
      return { valid: false, reason: `Invalid X-Amz-Date format: ${requestDate}` };
    }

    const year = Number.parseInt(requestDate.slice(0, 4), 10);
    const month = Number.parseInt(requestDate.slice(4, 6), 10) - 1;
    const day = Number.parseInt(requestDate.slice(6, 8), 10);
    const hour = Number.parseInt(requestDate.slice(9, 11), 10);
    const min = Number.parseInt(requestDate.slice(11, 13), 10);
    const sec = Number.parseInt(requestDate.slice(13, 15), 10);
    const reqTimestamp = Date.UTC(year, month, day, hour, min, sec);

    const now = options.now || new Date();
    const expiresAt = reqTimestamp + expiresInSeconds * 1000;
    const clockSkewMs = (options.clockSkewSeconds ?? 60) * 1000;

    if (now.getTime() < reqTimestamp - clockSkewMs) {
      return { valid: false, reason: 'Request timestamp is in the future', expiresAt };
    }

    if (now.getTime() > expiresAt + clockSkewMs) {
      return { valid: false, reason: 'Presigned URL has expired', expiresAt };
    }

    // Parse credential: <accessKeyId>/<dateStamp>/<region>/<service>/aws4_request
    const credParts = credential.split('/');
    if (credParts.length !== 5 || credParts[4] !== 'aws4_request') {
      return { valid: false, reason: 'Invalid X-Amz-Credential format' };
    }

    const [accessKeyId, dateStamp, region, service] = credParts;
    if (dateStamp !== requestDate.slice(0, 8)) {
      return { valid: false, reason: 'Date stamp mismatch between X-Amz-Date and X-Amz-Credential' };
    }

    // Reconstruct canonical query string without X-Amz-Signature
    const canonicalQueryString = getCanonicalQueryString(parsed.searchParams);

    // Reconstruct canonical headers for the signed headers
    const signedHeaderNames = signedHeadersStr
      .split(';')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    const headerSource: Record<string, string> = {
      host: parsed.host,
      ...options.headers,
    };

    const headersToSign: Record<string, string> = {};
    for (const name of signedHeaderNames) {
      const foundEntry = Object.entries(headerSource).find(
        ([k]) => k.toLowerCase() === name
      );
      if (foundEntry === undefined || foundEntry[1] === undefined) {
        return { valid: false, reason: `Missing required signed header: "${name}"` };
      }
      headersToSign[name] = foundEntry[1];
    }

    const { canonicalHeaders, signedHeaders } = getCanonicalHeaders(headersToSign);
    const canonicalUri = getCanonicalUri(parsed.pathname);
    const method = (options.expectedMethod || 'GET').toUpperCase();
    const hashedPayload = 'UNSIGNED-PAYLOAD';

    const canonicalRequest = buildCanonicalRequest({
      method,
      canonicalUri,
      canonicalQueryString,
      canonicalHeaders,
      signedHeaders,
      hashedPayload,
    });

    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = buildStringToSign({
      algorithm: 'AWS4-HMAC-SHA256',
      requestDate,
      credentialScope,
      canonicalRequest,
    });

    const signingKey = deriveSigningKey(options.secretAccessKey, dateStamp, region, service);
    const expectedSignature = calculateSignature(signingKey, stringToSign);

    const sigBuf = Buffer.from(signature.toLowerCase(), 'hex');
    const expBuf = Buffer.from(expectedSignature.toLowerCase(), 'hex');

    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return { valid: false, reason: 'Signature mismatch' };
    }

    const queryParams: Record<string, string> = {};
    for (const [k, v] of parsed.searchParams.entries()) {
      queryParams[k] = v;
    }

    return {
      valid: true,
      accessKeyId,
      dateStamp,
      region,
      service,
      expiresAt,
      queryParams,
    };
  } catch (err: any) {
    return { valid: false, reason: err?.message || 'Verification exception' };
  }
}
