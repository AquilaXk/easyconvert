import { describe, it, expect } from 'vitest';
import {
  StorageAdapterError,
  StorageAuthenticationError,
  StorageInputError,
  StorageInvalidKeyError,
  StorageNotFoundError,
  StorageServiceError,
  StorageTimeoutError,
} from '../src/lib/storage/adapters/adapter-interface';
import { describeStorageError, storageErrorResponse } from '../src/lib/api/storage-error-response';
import { assertValidObjectKey, resolveS3Address, SigV4SigningError } from '../src/lib/storage/s3-sigv4';
import { uriEncode } from '../src/lib/storage/sigv4-presigner';
import { limitFilename } from '../src/lib/storage/object-attributes';

/**
 * Storage failures reach API callers as typed problem documents: an unavailable store is a 503
 * that names no provider, credential or request id; a caller's bad input is a 400.
 */

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_INTERNAL = 500;
const HTTP_UNAVAILABLE = 503;
const PROBLEM_JSON = 'application/problem+json';
const INSTANCE = '/api/v1/uploads/direct';

describe('storage error mapper', () => {
  const unavailable: Array<[string, Error]> = [
    ['a timeout', new StorageTimeoutError(60_000, 'oci')],
    ['a rejected credential', new StorageAuthenticationError('AccessDenied: key AKIAOCIEXAMPLE0000001 is disabled', 'oci')],
    [
      'a retryable service failure',
      new StorageServiceError('S3 request failed (HTTP 503 SlowDown)', 'oci', {
        statusCode: 503,
        code: 'SlowDown',
        requestId: 'req-7f3a-secret-trace',
        retryable: true,
      }),
    ],
  ];

  for (const [label, error] of unavailable) {
    it(`answers ${label} with a 503 problem document that leaks no provider detail`, async () => {
      const response = storageErrorResponse(error, INSTANCE);
      expect(response?.status).toBe(HTTP_UNAVAILABLE);
      expect(response?.headers.get('Content-Type')).toBe(PROBLEM_JSON);
      expect(Number(response?.headers.get('Retry-After'))).toBeGreaterThan(0);
      const body = await response!.json();
      expect(body).toMatchObject({
        status: HTTP_UNAVAILABLE,
        title: 'Service Unavailable',
        type: 'https://api.easyconvert.io/problems/service-unavailable',
        instance: INSTANCE,
        success: false,
      });
      const text = JSON.stringify(body);
      for (const secret of ['oci', 'AKIA', 'AccessDenied', 'SlowDown', 'req-7f3a', 'S3 request failed', 'timed out']) {
        expect(text).not.toContain(secret);
      }
    });
  }

  it('answers a caller error with a 400 that keeps the validation message', async () => {
    const input = storageErrorResponse(new StorageInputError('Part number must be an integer between 1 and 10000', 's3'), INSTANCE);
    expect(input?.status).toBe(HTTP_BAD_REQUEST);
    expect((await input!.json()).detail).toBe('Part number must be an integer between 1 and 10000');

    const key = storageErrorResponse(new StorageInvalidKeyError('Object key must not contain "." or ".." path segments.', 'oci'), INSTANCE);
    expect(key?.status).toBe(HTTP_BAD_REQUEST);
    expect((await key!.json()).detail).toBe('The object key is not valid for object storage.');
  });

  it('answers a vanished upload with 404 and a rejected part list with 400', () => {
    const noSuchUpload = new StorageServiceError('Multipart upload no longer exists', 'oci', {
      statusCode: 404,
      code: 'NoSuchUpload',
      retryable: false,
    });
    expect(describeStorageError(noSuchUpload)?.status).toBe(HTTP_NOT_FOUND);
    expect(describeStorageError(new StorageNotFoundError('k', 'oci'))?.status).toBe(HTTP_NOT_FOUND);
    for (const code of ['EntityTooSmall', 'InvalidPart', 'InvalidPartOrder', 'EntityTooLarge']) {
      const rejected = new StorageServiceError(`S3 request failed (HTTP 400 ${code})`, 'oci', {
        statusCode: 400,
        code,
        retryable: false,
      });
      expect(describeStorageError(rejected)?.status).toBe(HTTP_BAD_REQUEST);
    }
  });

  it('answers any other storage failure with a generic 500 and leaves foreign errors alone', () => {
    const permanent = new StorageServiceError('S3 endpoint answered with a redirect (HTTP 301)', 'oci', {
      statusCode: 301,
      retryable: false,
    });
    const described = describeStorageError(permanent);
    expect(described).toMatchObject({ status: HTTP_INTERNAL, detail: 'The object storage request failed.' });
    expect(describeStorageError(new StorageAdapterError('Staged 1 bytes but the object has 2 bytes', 'oci'))?.status).toBe(HTTP_INTERNAL);

    expect(describeStorageError(new Error('boom'))).toBeUndefined();
    expect(describeStorageError('text')).toBeUndefined();
    expect(describeStorageError(undefined)).toBeUndefined();
    expect(storageErrorResponse(new TypeError('x'), INSTANCE)).toBeUndefined();
  });
});

describe('object keys and filenames the store cannot address are typed errors', () => {
  const LONE_HIGH = '\ud800';
  const LONE_LOW = '\udc00';

  it('rejects a lone surrogate, a non-string key and an over-long key before any URL is built', () => {
    for (const key of [`a${LONE_HIGH}b`, `${LONE_LOW}`, `x/${LONE_HIGH}`]) {
      expect(() => assertValidObjectKey(key)).toThrow(SigV4SigningError);
    }
    for (const key of [undefined, null, 42, { x: 1 }, ['a']]) {
      expect(() => assertValidObjectKey(key as unknown as string)).toThrow(SigV4SigningError);
    }
    expect(() => assertValidObjectKey('k'.repeat(1025))).toThrow(SigV4SigningError);
    expect(() => assertValidObjectKey('é'.repeat(513))).toThrow(SigV4SigningError);
    const address = (key: string) =>
      resolveS3Address({ bucket: 'internal-objects', region: 'ap-seoul-1', endpoint: 'https://objects.example.com', key });
    expect(address('k'.repeat(1024)).path).toBe(`/internal-objects/${'k'.repeat(1024)}`);
    expect(address('é/🙂.bin').path).toBe('/internal-objects/é/🙂.bin');
  });

  it('refuses to percent-encode a lone surrogate instead of throwing a URIError', () => {
    let thrown: unknown;
    try {
      uriEncode(`a${LONE_HIGH}b`);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SigV4SigningError);
    expect(thrown).not.toBeInstanceOf(URIError);
    expect(uriEncode('é🙂')).toBe('%C3%A9%F0%9F%99%82');
  });

  it('rejects a filename with a lone surrogate with a StorageInputError', () => {
    expect(() => limitFilename(`doc${LONE_HIGH}.pdf`)).toThrow(StorageInputError);
    expect(limitFilename('doc.pdf')).toBe('doc.pdf');
  });

  it('shortens an over-long non-BMP filename without cutting a surrogate pair in half', () => {
    const limited = limitFilename('🙂'.repeat(400));
    expect(encodeURIComponent(limited).length).toBeLessThanOrEqual(1024);
    expect(Array.from(limited).every((char) => char === '🙂')).toBe(true);
    expect(limited.length).toBeGreaterThan(0);
  });
});
