import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  encodeS3Path,
  resolveS3Address,
  signS3Request,
  SigV4SigningError,
  UNSIGNED_PAYLOAD,
} from '../src/lib/storage/s3-sigv4';

/**
 * Oracle: published SigV4 vectors hand-copied into tests/fixtures/sigv4/s3-header-auth-vectors.json
 * Each vector carries a "source" naming the fetched file and commit: the 2015 AWS SigV4 test suite
 * (boto/botocore) and the S3 GET Object example with AKIAIOSFODNN7EXAMPLE (durch/rust-s3).
 * Nothing here is derived from src/.
 */

interface SuiteVector {
  name: string;
  source: string;
  method: string;
  path: string;
  query: Array<[string, string]>;
  headers: Record<string, string>;
  body?: string;
  sessionToken?: string;
  payloadHash: string;
  expectedCanonicalRequest: string;
  expectedStringToSign: string;
  expectedAuthorization: string;
}

interface S3DocVector {
  name: string;
  source: string;
  method: string;
  key: string;
  query: Array<[string, string]>;
  headers: Record<string, string>;
  body?: string;
  payloadHash: string;
  expectedUrl: string;
  expectedCanonicalRequest: string;
  expectedStringToSign: string;
  expectedSignature: string;
}

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/sigv4/s3-header-auth-vectors.json'), 'utf-8')
) as {
  suite2015: {
    credentials: { accessKeyId: string; secretAccessKey: string };
    region: string;
    service: string;
    timestamp: string;
    origin: string;
    vectors: SuiteVector[];
  };
  s3doc: {
    credentials: { accessKeyId: string; secretAccessKey: string };
    region: string;
    timestamp: string;
    bucket: string;
    vectors: S3DocVector[];
  };
};

const S3_GLOBAL_ENDPOINT = 'https://s3.amazonaws.com';

describe('SigV4 signer: AWS SigV4 test suite (2015)', () => {
  const suite = fixture.suite2015;

  it.each(suite.vectors.map((v) => [v.name, v] as const))('%s', (_name, vector) => {
    if (vector.body !== undefined) {
      // The fixture's payload hash is the published one; confirm it matches the published body.
      expect(crypto.createHash('sha256').update(vector.body).digest('hex')).toBe(vector.payloadHash);
    }
    const signed = signS3Request({
      method: vector.method,
      origin: suite.origin,
      path: vector.path,
      query: vector.query,
      headers: vector.headers,
      payloadHash: vector.payloadHash,
      credentials: { ...suite.credentials, sessionToken: vector.sessionToken },
      region: suite.region,
      service: suite.service,
      now: new Date(suite.timestamp),
      includeContentSha256Header: false,
    });

    expect(signed.canonicalRequest).toBe(vector.expectedCanonicalRequest);
    expect(signed.stringToSign).toBe(vector.expectedStringToSign);
    expect(signed.headers.authorization).toBe(vector.expectedAuthorization);
    expect(signed.headers['x-amz-date']).toBe('20150830T123600Z');
    if (vector.sessionToken) {
      expect(signed.headers['x-amz-security-token']).toBe(vector.sessionToken);
    }
  });
});

describe('SigV4 signer: Amazon S3 header-auth examples', () => {
  const doc = fixture.s3doc;

  it.each(doc.vectors.map((v) => [v.name, v] as const))('%s', (_name, vector) => {
    if (vector.body !== undefined) {
      expect(crypto.createHash('sha256').update(vector.body).digest('hex')).toBe(vector.payloadHash);
    }
    const address = resolveS3Address({
      bucket: doc.bucket,
      key: vector.key,
      region: doc.region,
      endpoint: S3_GLOBAL_ENDPOINT,
      forcePathStyle: false,
    });
    expect(address.style).toBe('virtual-hosted');

    const signed = signS3Request({
      method: vector.method,
      origin: address.origin,
      path: address.path,
      query: vector.query,
      headers: vector.headers,
      payloadHash: vector.payloadHash,
      credentials: doc.credentials,
      region: doc.region,
      now: new Date(doc.timestamp),
    });

    expect(signed.url).toBe(vector.expectedUrl);
    expect(signed.canonicalRequest).toBe(vector.expectedCanonicalRequest);
    expect(signed.stringToSign).toBe(vector.expectedStringToSign);
    expect(signed.signature).toBe(vector.expectedSignature);
    expect(signed.headers['x-amz-content-sha256']).toBe(vector.payloadHash);
  });
});

describe('SigV4 signer: vector provenance', () => {
  it('cites a pinned file for every vector', () => {
    const all = [...fixture.suite2015.vectors, ...fixture.s3doc.vectors];
    expect(all).toHaveLength(10);
    for (const vector of all) {
      expect(vector.source).toMatch(/^(boto\/botocore|durch\/rust-s3)@[0-9a-f]{40}:\S+/);
    }
  });
});

describe('SigV4 signer: S3 request rules', () => {
  const now = new Date('2013-05-24T00:00:00.000Z');
  const credentials = fixture.s3doc.credentials;

  it('places UNSIGNED-PAYLOAD in both the canonical request and x-amz-content-sha256', () => {
    const signed = signS3Request({
      method: 'PUT',
      origin: 'https://examplebucket.s3.amazonaws.com',
      path: '/stream.bin',
      payloadHash: UNSIGNED_PAYLOAD,
      credentials,
      region: 'us-east-1',
      now,
    });
    const lines = signed.canonicalRequest.split('\n');
    expect(lines.at(-1)).toBe('UNSIGNED-PAYLOAD');
    expect(lines).toContain('x-amz-content-sha256:UNSIGNED-PAYLOAD');
    expect(signed.headers['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD');
    expect(signed.signedHeaders).toBe('host;x-amz-content-sha256;x-amz-date');
  });

  it('encodes each key segment once and keeps the separators', () => {
    // RFC 3986 unreserved set kept; space -> %20, "%" -> %25 (no double-decoding of a literal %XX).
    expect(encodeS3Path('/photos/2024 summer/a+b%41.jpg')).toBe('/photos/2024%20summer/a%2Bb%2541.jpg');
    expect(encodeS3Path('/a//b/')).toBe('/a//b/');
    // "$" is outside the RFC 3986 unreserved set, so it must be percent-encoded (URL parsers keep it raw).
    expect(encodeS3Path('/test$file.text')).toBe('/test%24file.text');
  });

  it('signs a session token and leaves content-length and user-agent unsigned', () => {
    const signed = signS3Request({
      method: 'PUT',
      origin: 'https://examplebucket.s3.amazonaws.com',
      path: '/x',
      headers: { 'Content-Length': '5', 'User-Agent': 'agent/1', 'Content-Type': 'text/plain' },
      payloadHash: UNSIGNED_PAYLOAD,
      credentials: { ...credentials, sessionToken: 'TOKEN/with+chars==' },
      region: 'us-east-1',
      now,
    });
    expect(signed.signedHeaders).toBe('content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token');
    expect(signed.headers['x-amz-security-token']).toBe('TOKEN/with+chars==');
  });

  it('rejects a payload hash that is neither SHA-256 hex nor UNSIGNED-PAYLOAD', () => {
    expect(() =>
      signS3Request({
        method: 'GET',
        origin: 'https://examplebucket.s3.amazonaws.com',
        path: '/x',
        payloadHash: 'not-a-hash',
        credentials,
        region: 'us-east-1',
      })
    ).toThrow(SigV4SigningError);
  });
});

describe('S3 addressing', () => {
  it('uses path style for a custom endpoint and keeps its port', () => {
    expect(
      resolveS3Address({ bucket: 'media', key: 'a/b.txt', region: 'eu-west-1', endpoint: 'http://127.0.0.1:9000' })
    ).toEqual({ origin: 'http://127.0.0.1:9000', path: '/media/a/b.txt', style: 'path' });
  });

  it('uses the regional virtual-hosted endpoint by default', () => {
    expect(resolveS3Address({ bucket: 'media', key: 'k', region: 'ap-northeast-2' })).toEqual({
      origin: 'https://media.s3.ap-northeast-2.amazonaws.com',
      path: '/k',
      style: 'virtual-hosted',
    });
  });

  it('falls back to path style for a dotted bucket so TLS hostnames still match', () => {
    expect(resolveS3Address({ bucket: 'my.bucket', key: 'k', region: 'us-east-1' }).style).toBe('path');
  });

  it('refuses dot segments that a URL parser would collapse into another bucket', () => {
    expect(() => resolveS3Address({ bucket: 'media', key: '../other/secret', region: 'us-east-1' })).toThrow(
      SigV4SigningError
    );
    expect(() => resolveS3Address({ bucket: 'media', key: 'a/./b', region: 'us-east-1' })).toThrow(SigV4SigningError);
  });

  it('refuses invalid bucket names that could alter the host', () => {
    expect(() => resolveS3Address({ bucket: 'evil.com/x', key: 'k', region: 'us-east-1' })).toThrow(SigV4SigningError);
    expect(() => resolveS3Address({ bucket: 'Upper', key: 'k', region: 'us-east-1' })).toThrow(SigV4SigningError);
    expect(() => resolveS3Address({ bucket: '192.168.1.1', key: 'k', region: 'us-east-1' })).toThrow(
      SigV4SigningError
    );
  });
});
