import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

import {
  presignSigV4QueryUrl,
  verifySigV4QueryUrl,
  buildCanonicalRequest,
  buildStringToSign,
  deriveSigningKey,
  calculateSignature,
  getCanonicalQueryString,
  getCanonicalHeaders,
  getCanonicalUri,
} from '../src/lib/storage/sigv4-presigner';

import { POST as directPostHandler } from '../src/app/api/v1/uploads/direct/route';
import { PUT as directPartPutHandler } from '../src/app/api/v1/uploads/direct/part/route';
import { POST as directCompletePostHandler } from '../src/app/api/v1/uploads/direct/complete/route';
import { DELETE as directDeleteHandler } from '../src/app/api/v1/uploads/direct/[id]/route';

import { s3Storage } from '../src/lib/storage/s3-storage';
import { userStore } from '../src/lib/auth/user-store';
import { createSessionToken } from '../src/lib/auth/session';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import type { User } from '../src/lib/auth/types';
import type { ApiKeyScope } from '../src/lib/api-keys/types';

const BASE_URL = 'http://localhost:3000';

function uniqueSuffix(): string {
  return `${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

async function createTestUser(label: string): Promise<User> {
  const email = `${label}_${uniqueSuffix()}@direct-upload-test.local`;
  return userStore.sanitizeUser(await userStore.createUser({ email, name: label, tier: 'pro' }));
}

function sessionHeaders(user: User): Record<string, string> {
  return { Cookie: `easyconvert_session=${createSessionToken(user)}` };
}

async function apiKeyHeaders(
  user: User,
  scopes: ApiKeyScope[] = ['convert:write']
): Promise<Record<string, string>> {
  const key = await redisKeyStore.generateApiKey(user.id, `${user.name} test key`, { scopes });
  return { Authorization: `Bearer ${key.secretKey}` };
}

function createStreamRequest(url: string, init: any): NextRequest {
  return new NextRequest(url, { ...init, duplex: 'half' } as any);
}

describe('Presigned Direct Multipart Upload (WP-22)', () => {
  let userA: User;
  let userB: User;

  beforeEach(async () => {
    userA = await createTestUser('alice');
    userB = await createTestUser('bob');
  });

  describe('1. Differential Oracle Verification against Official AWS SigV4 Test Vectors', () => {
    it('matches official AWS S3 Presigned GET documentation test vector byte-for-byte', () => {
      const fixturePath = path.join(__dirname, 'fixtures/sigv4/s3-presigned-get.json');
      const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));

      const result = presignSigV4QueryUrl({
        method: fixture.method,
        url: fixture.url,
        credentials: fixture.credentials,
        expiresInSeconds: fixture.expiresInSeconds,
        timestamp: new Date(fixture.timestamp),
      });

      expect(result.canonicalRequest).toBe(fixture.expectedCanonicalRequest);
      expect(result.stringToSign).toBe(fixture.expectedStringToSign);
      expect(result.signature).toBe(fixture.expectedSignature);

      // Verify that verifySigV4QueryUrl accepts the resulting URL
      const verifyResult = verifySigV4QueryUrl(result.url, {
        secretAccessKey: fixture.credentials.secretAccessKey,
        expectedMethod: fixture.method,
        now: new Date('2013-05-24T01:00:00.000Z'),
      });

      expect(verifyResult.valid).toBe(true);
      expect(verifyResult.accessKeyId).toBe(fixture.credentials.accessKeyId);
      expect(verifyResult.dateStamp).toBe('20130524');
      expect(verifyResult.region).toBe(fixture.credentials.region);
      expect(verifyResult.service).toBe(fixture.credentials.service);
    });

    it('matches S3 Presigned Multipart PUT Part test vector', () => {
      const fixturePath = path.join(__dirname, 'fixtures/sigv4/s3-presigned-put-part.json');
      const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));

      const result = presignSigV4QueryUrl({
        method: fixture.method,
        url: fixture.url,
        queryParams: fixture.queryParams,
        credentials: fixture.credentials,
        expiresInSeconds: fixture.expiresInSeconds,
        timestamp: new Date(fixture.timestamp),
      });

      expect(result.canonicalRequest).toBe(fixture.expectedCanonicalRequest);
      expect(result.stringToSign).toBe(fixture.expectedStringToSign);
      expect(result.signature).toBe(fixture.expectedSignature);

      const verifyResult = verifySigV4QueryUrl(result.url, {
        secretAccessKey: fixture.credentials.secretAccessKey,
        expectedMethod: fixture.method,
        now: new Date('2026-10-04T12:05:00.000Z'),
      });

      expect(verifyResult.valid).toBe(true);
      expect(verifyResult.accessKeyId).toBe(fixture.credentials.accessKeyId);
    });

    it('matches canonical requests and signatures from AWS SigV4 Test Suite', () => {
      const suitePath = path.join(__dirname, 'fixtures/sigv4/aws-sigv4-test-suite.json');
      const testCases = JSON.parse(fs.readFileSync(suitePath, 'utf-8'));

      for (const tc of testCases) {
        const { canonicalHeaders, signedHeaders } = getCanonicalHeaders(tc.headers);
        const canonicalUri = getCanonicalUri(tc.canonicalUri);
        const canonicalQueryString = tc.canonicalQueryString;

        const creq = buildCanonicalRequest({
          method: tc.method,
          canonicalUri,
          canonicalQueryString,
          canonicalHeaders,
          signedHeaders,
          hashedPayload: tc.hashedPayload,
        });

        expect(creq).toBe(tc.expectedCanonicalRequest);

        const credentialScope = `${tc.dateStamp}/${tc.credentials.region}/${tc.credentials.service}/aws4_request`;
        const sts = buildStringToSign({
          algorithm: 'AWS4-HMAC-SHA256',
          requestDate: tc.timestamp,
          credentialScope,
          canonicalRequest: creq,
        });

        expect(sts).toBe(tc.expectedStringToSign);

        const signingKey = deriveSigningKey(
          tc.credentials.secretAccessKey,
          tc.dateStamp,
          tc.credentials.region,
          tc.credentials.service
        );
        const signature = calculateSignature(signingKey, sts);

        expect(signature).toBe(tc.expectedSignature);
      }
    });
  });

  describe('2. End-to-End Direct Multipart Upload with Exact Byte-by-Byte SHA256 Match', () => {
    it('completes multipart direct upload through presigned URLs with exact byte and checksum fidelity', async () => {
      const auth = sessionHeaders(userA);

      // Generate 3 chunks of deterministic data
      const chunk1 = crypto.randomBytes(64 * 1024); // 64 KiB
      const chunk2 = crypto.randomBytes(64 * 1024); // 64 KiB
      const chunk3 = crypto.randomBytes(32 * 1024); // 32 KiB
      const fullBuffer = Buffer.concat([chunk1, chunk2, chunk3]);
      const totalSize = fullBuffer.length;
      const expectedSha256 = crypto.createHash('sha256').update(fullBuffer).digest('hex');

      // 1. Initiate Multipart Direct Upload: POST /api/v1/uploads/direct
      const initReq = new NextRequest(`${BASE_URL}/api/v1/uploads/direct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({
          filename: 'archive_payload.tar',
          mimeType: 'application/x-tar',
          totalSize,
          partSize: 64 * 1024,
        }),
      });

      const initRes = await directPostHandler(initReq);
      expect(initRes.status).toBe(200);

      const initData = await initRes.json();
      expect(initData.uploadId).toBeDefined();
      expect(initData.totalParts).toBe(3);
      expect(initData.parts).toHaveLength(3);
      expect(initData.parts[0].partNumber).toBe(1);
      expect(initData.parts[1].partNumber).toBe(2);
      expect(initData.parts[2].partNumber).toBe(3);
      expect(initData.parts[0].uploadUrl).toContain('uploadId=');
      expect(initData.parts[0].uploadUrl).toContain('partNumber=1');

      const uploadId = initData.uploadId;
      const partsToComplete: Array<{ partNumber: number; etag: string }> = [];

      // 2. Upload each chunk via PUT /api/v1/uploads/direct/part
      const chunks = [chunk1, chunk2, chunk3];
      for (let i = 0; i < chunks.length; i++) {
        const partInfo = initData.parts[i];
        const partBuffer = chunks[i];

        const partReq = createStreamRequest(partInfo.uploadUrl, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(partBuffer.length),
          },
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(partBuffer);
              controller.close();
            },
          }),
        });

        const partRes = await directPartPutHandler(partReq);
        expect(partRes.status).toBe(200);

        const etagHeader = partRes.headers.get('ETag');
        expect(etagHeader).toBeTruthy();

        const partJson = await partRes.json();
        expect(partJson.success).toBe(true);
        expect(partJson.partNumber).toBe(i + 1);
        expect(partJson.size).toBe(partBuffer.length);
        expect(partJson.etag).toBe(etagHeader);

        partsToComplete.push({
          partNumber: i + 1,
          etag: partJson.etag,
        });
      }

      // 3. Complete Assembly: POST /api/v1/uploads/direct/complete
      const completeReq = new NextRequest(`${BASE_URL}/api/v1/uploads/direct/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({
          uploadId,
          parts: partsToComplete,
        }),
      });

      const completeRes = await directCompletePostHandler(completeReq);
      expect(completeRes.status).toBe(200);

      const completeJson = await completeRes.json();
      expect(completeJson.key).toBe(initData.key);
      expect(completeJson.size).toBe(totalSize);
      expect(completeJson.storageKey).toBe(initData.key);
      expect(completeJson.location).toBe(`/api/storage/file/${encodeURIComponent(initData.key)}`);

      // 4. Verify Assembled File Byte-by-Byte via SHA256
      const storedStream = s3Storage.getObjectStream(completeJson.key);
      expect(storedStream).not.toBeNull();

      const receivedChunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        storedStream!.on('data', (buf) => receivedChunks.push(Buffer.from(buf)));
        storedStream!.on('end', () => resolve());
        storedStream!.on('error', reject);
      });

      const assembledBuffer = Buffer.concat(receivedChunks);
      expect(assembledBuffer).toHaveLength(totalSize);

      const actualSha256 = crypto.createHash('sha256').update(assembledBuffer).digest('hex');
      expect(actualSha256).toBe(expectedSha256);
      expect(assembledBuffer.equals(fullBuffer)).toBe(true);
    });
  });

  describe('3. Security: Tampered Signature and Expired Timestamp Rejection', () => {
    it('rejects PUT request with tampered SigV4 signature fail-closed with 403 Forbidden', async () => {
      const auth = sessionHeaders(userA);

      const initReq = new NextRequest(`${BASE_URL}/api/v1/uploads/direct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({
          filename: 'secure_sample.bin',
          mimeType: 'application/octet-stream',
          totalSize: 1024,
        }),
      });

      const initRes = await directPostHandler(initReq);
      const initData = await initRes.json();
      const validUrl = initData.parts[0].uploadUrl;

      // Tamper signature by altering the hex value
      const parsedUrl = new URL(validUrl);
      const originalSig = parsedUrl.searchParams.get('X-Amz-Signature');
      expect(originalSig).toBeTruthy();

      const tamperedSig = originalSig!.replace(/^[0-9a-f]/, (c) => (c === 'a' ? 'b' : 'a'));
      parsedUrl.searchParams.set('X-Amz-Signature', tamperedSig);

      const testChunk = Buffer.from('TAMPER_DATA');
      const tamperedReq = createStreamRequest(parsedUrl.toString(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(testChunk);
            controller.close();
          },
        }),
      });

      const tamperedRes = await directPartPutHandler(tamperedReq);
      expect(tamperedRes.status).toBe(403);

      const errJson = await tamperedRes.json();
      expect(errJson.status).toBe(403);
      expect(errJson.detail).toContain('Signature mismatch');
    });

    it('rejects PUT request with expired timestamp fail-closed with 403 Forbidden', async () => {
      const auth = sessionHeaders(userA);

      const initReq = new NextRequest(`${BASE_URL}/api/v1/uploads/direct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({
          filename: 'expired_sample.bin',
          mimeType: 'application/octet-stream',
          totalSize: 2048,
        }),
      });

      const initRes = await directPostHandler(initReq);
      const initData = await initRes.json();
      const session = s3Storage.getUploadSession(initData.uploadId)!;

      // Create an expired presigned URL (1 second expiry in the past)
      const expiredPastDate = new Date(Date.now() - 3600 * 1000);
      const expiredPresign = presignSigV4QueryUrl({
        method: 'PUT',
        url: `${BASE_URL}/api/v1/uploads/direct/part`,
        queryParams: {
          uploadId: session.uploadId,
          partNumber: 1,
          key: session.key,
        },
        credentials: {
          accessKeyId: 'DEV_ACCESS_KEY_ID',
          secretAccessKey: s3Storage.getSigningSecret(),
          region: 'us-east-1',
          service: 's3',
        },
        expiresInSeconds: 10,
        timestamp: expiredPastDate,
      });

      const testChunk = Buffer.from('EXPIRED_DATA');
      const expiredReq = createStreamRequest(expiredPresign.url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(testChunk);
            controller.close();
          },
        }),
      });

      const expiredRes = await directPartPutHandler(expiredReq);
      expect(expiredRes.status).toBe(403);

      const errJson = await expiredRes.json();
      expect(errJson.status).toBe(403);
      expect(errJson.detail).toContain('expired');
    });

    it('rejects PUT request with missing signature query parameters with 403 Forbidden', async () => {
      const auth = sessionHeaders(userA);

      const initReq = new NextRequest(`${BASE_URL}/api/v1/uploads/direct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({
          filename: 'unsigned_sample.bin',
          mimeType: 'application/octet-stream',
          totalSize: 1024,
        }),
      });

      const initRes = await directPostHandler(initReq);
      const initData = await initRes.json();

      // Send PUT with no X-Amz-Signature and no HMAC signature
      const unsignedUrl = `${BASE_URL}/api/v1/uploads/direct/part?uploadId=${initData.uploadId}&partNumber=1`;
      const testChunk = Buffer.from('UNSIGNED_DATA');
      const unsignedReq = createStreamRequest(unsignedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(testChunk);
            controller.close();
          },
        }),
      });

      const unsignedRes = await directPartPutHandler(unsignedReq);
      expect(unsignedRes.status).toBe(403);
    });

    it('rejects PUT request with future timestamp beyond clock skew with 403 Forbidden', async () => {
      const auth = sessionHeaders(userA);

      const initReq = new NextRequest(`${BASE_URL}/api/v1/uploads/direct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({
          filename: 'future_sample.bin',
          totalSize: 1024,
        }),
      });

      const initRes = await directPostHandler(initReq);
      const initData = await initRes.json();
      const session = s3Storage.getUploadSession(initData.uploadId)!;

      // Presigned timestamp 2 hours in the future
      const futureDate = new Date(Date.now() + 7200 * 1000);
      const futurePresign = presignSigV4QueryUrl({
        method: 'PUT',
        url: `${BASE_URL}/api/v1/uploads/direct/part`,
        queryParams: {
          uploadId: session.uploadId,
          partNumber: 1,
          key: session.key,
        },
        credentials: {
          accessKeyId: 'DEV_ACCESS_KEY_ID',
          secretAccessKey: s3Storage.getSigningSecret(),
          region: 'us-east-1',
          service: 's3',
        },
        expiresInSeconds: 900,
        timestamp: futureDate,
      });

      const testChunk = Buffer.from('FUTURE_DATA');
      const futureReq = createStreamRequest(futurePresign.url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(testChunk);
            controller.close();
          },
        }),
      });

      const futureRes = await directPartPutHandler(futureReq);
      expect(futureRes.status).toBe(403);
      const errJson = await futureRes.json();
      expect(errJson.detail).toContain('in the future');
    });

    it('rejects PUT request when a signed header declared in X-Amz-SignedHeaders is missing with 403 Forbidden', async () => {
      const auth = sessionHeaders(userA);

      const initReq = new NextRequest(`${BASE_URL}/api/v1/uploads/direct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({
          filename: 'signed_headers_sample.bin',
          totalSize: 1024,
        }),
      });

      const initRes = await directPostHandler(initReq);
      const initData = await initRes.json();
      const session = s3Storage.getUploadSession(initData.uploadId)!;

      // Presigned URL that signs both host and x-custom-token
      const presigned = presignSigV4QueryUrl({
        method: 'PUT',
        url: `${BASE_URL}/api/v1/uploads/direct/part`,
        queryParams: {
          uploadId: session.uploadId,
          partNumber: 1,
          key: session.key,
        },
        headers: {
          'x-custom-token': 'secret-token-value',
        },
        credentials: {
          accessKeyId: 'DEV_ACCESS_KEY_ID',
          secretAccessKey: s3Storage.getSigningSecret(),
          region: 'us-east-1',
          service: 's3',
        },
        expiresInSeconds: 900,
      });

      // Send PUT request WITHOUT the required 'x-custom-token' header
      const testChunk = Buffer.from('MISSING_HEADER_DATA');
      const missingHeaderReq = createStreamRequest(presigned.url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          // Note: x-custom-token is omitted!
        },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(testChunk);
            controller.close();
          },
        }),
      });

      const missingHeaderRes = await directPartPutHandler(missingHeaderReq);
      expect(missingHeaderRes.status).toBe(403);
      const errJson = await missingHeaderRes.json();
      expect(errJson.detail).toContain('Missing required signed header');
    });

    it('rejects PUT request when query param key mismatches upload session key with 403 Forbidden', async () => {
      const auth = sessionHeaders(userA);

      const initReq = new NextRequest(`${BASE_URL}/api/v1/uploads/direct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({
          filename: 'valid_sample.bin',
          totalSize: 1024,
        }),
      });

      const initRes = await directPostHandler(initReq);
      const initData = await initRes.json();
      const validPartUrl = initData.parts[0].uploadUrl;

      // Tamper key query param to a different path
      const url = new URL(validPartUrl);
      url.searchParams.set('key', 'conversions/malicious/spoofed_key.bin');

      const testChunk = Buffer.from('KEY_MISMATCH_DATA');
      const tamperedKeyReq = createStreamRequest(url.toString(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(testChunk);
            controller.close();
          },
        }),
      });

      const tamperedKeyRes = await directPartPutHandler(tamperedKeyReq);
      expect(tamperedKeyRes.status).toBe(403);
      const errJson = await tamperedKeyRes.json();
      expect(errJson.detail).toContain('Key mismatch');
    });

    it('rejects PUT request with X-Amz-Expires exceeding 7 days with 403 Forbidden', async () => {
      const auth = sessionHeaders(userA);

      const initReq = new NextRequest(`${BASE_URL}/api/v1/uploads/direct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({
          filename: 'huge_expiry.bin',
          totalSize: 1024,
        }),
      });

      const initRes = await directPostHandler(initReq);
      const initData = await initRes.json();
      const validPartUrl = initData.parts[0].uploadUrl;

      const url = new URL(validPartUrl);
      url.searchParams.set('X-Amz-Expires', '999999999');

      const testChunk = Buffer.from('HUGE_EXPIRY_DATA');
      const req = createStreamRequest(url.toString(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(testChunk);
            controller.close();
          },
        }),
      });

      const res = await directPartPutHandler(req);
      expect(res.status).toBe(403);
      const errJson = await res.json();
      expect(errJson.detail).toContain('Invalid X-Amz-Expires');
    });
  });

  describe('4. Fail-Closed Magic Bytes Spoofing Rejection (422 Unprocessable Entity)', () => {
    it('completes multipart direct upload when mimeType is omitted (defaults to application/octet-stream) with valid PDF', async () => {
      const auth = sessionHeaders(userA);

      // Authentic PDF byte sequence
      const validPdf = Buffer.from(
        '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n'
      );

      // 1. Initiate upload without mimeType
      const initReq = new NextRequest(`${BASE_URL}/api/v1/uploads/direct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({
          filename: 'my_genuine_document.pdf',
          totalSize: validPdf.length,
          partSize: validPdf.length,
        }),
      });

      const initRes = await directPostHandler(initReq);
      expect(initRes.status).toBe(200);
      const initData = await initRes.json();

      // 2. Upload part
      const partReq = createStreamRequest(initData.parts[0].uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(validPdf);
            controller.close();
          },
        }),
      });

      const partRes = await directPartPutHandler(partReq);
      expect(partRes.status).toBe(200);
      const partJson = await partRes.json();

      // 3. Complete assembly - should recognize .pdf extension from filename and succeed
      const completeReq = new NextRequest(`${BASE_URL}/api/v1/uploads/direct/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({
          uploadId: initData.uploadId,
          parts: [{ partNumber: 1, etag: partJson.etag }],
        }),
      });

      const completeRes = await directCompletePostHandler(completeReq);
      expect(completeRes.status).toBe(200);
      const completeJson = await completeRes.json();
      expect(completeJson.size).toBe(validPdf.length);
      expect(completeJson.key).toBe(initData.key);

      const storedObj = s3Storage.getObject(initData.key);
      expect(storedObj).toBeDefined();
    });

    it('rejects spoofed payload when mimeType is omitted with 422 Unprocessable Entity', async () => {
      const auth = sessionHeaders(userA);

      // Plain text disguised as a PDF
      const fakePdf = Buffer.from('JUST A RAW TEXT FILE NOT PDF AT ALL');

      const initReq = new NextRequest(`${BASE_URL}/api/v1/uploads/direct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({
          filename: 'disguised_fake.pdf',
          totalSize: fakePdf.length,
          partSize: fakePdf.length,
        }),
      });

      const initRes = await directPostHandler(initReq);
      expect(initRes.status).toBe(200);
      const initData = await initRes.json();

      const partReq = createStreamRequest(initData.parts[0].uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(fakePdf);
            controller.close();
          },
        }),
      });

      const partRes = await directPartPutHandler(partReq);
      expect(partRes.status).toBe(200);
      const partJson = await partRes.json();

      const completeReq = new NextRequest(`${BASE_URL}/api/v1/uploads/direct/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({
          uploadId: initData.uploadId,
          parts: [{ partNumber: 1, etag: partJson.etag }],
        }),
      });

      const completeRes = await directCompletePostHandler(completeReq);
      expect(completeRes.status).toBe(422);
      const completeJson = await completeRes.json();
      expect(completeJson.status).toBe(422);
      expect(completeJson.detail).toContain('File spoofing rejected');
      expect(completeJson.detail).toContain('.pdf');
    });

    it('rejects multipart complete when file magic bytes do not match declared format and purges assembled file', async () => {
      const auth = sessionHeaders(userA);

      // Declared as PDF, but body content is invalid text/garbage
      const fakePdfContent = Buffer.from('NOT_A_PDF_HEADER_THIS_IS_PURE_TEXT_SPOOFED_PAYLOAD_DATA');

      // 1. Initiate as PDF
      const initReq = new NextRequest(`${BASE_URL}/api/v1/uploads/direct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({
          filename: 'malicious_spoofed.pdf',
          mimeType: 'application/pdf',
          totalSize: fakePdfContent.length,
          partSize: fakePdfContent.length,
        }),
      });

      const initRes = await directPostHandler(initReq);
      expect(initRes.status).toBe(200);
      const initData = await initRes.json();

      // 2. Upload part
      const partReq = createStreamRequest(initData.parts[0].uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(fakePdfContent);
            controller.close();
          },
        }),
      });

      const partRes = await directPartPutHandler(partReq);
      expect(partRes.status).toBe(200);
      const partJson = await partRes.json();

      // 3. Complete assembly - should trigger magic byte check and fail with 422
      const completeReq = new NextRequest(`${BASE_URL}/api/v1/uploads/direct/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({
          uploadId: initData.uploadId,
          parts: [{ partNumber: 1, etag: partJson.etag }],
        }),
      });

      const completeRes = await directCompletePostHandler(completeReq);
      expect(completeRes.status).toBe(422);

      const completeJson = await completeRes.json();
      expect(completeJson.status).toBe(422);
      expect(completeJson.title).toBe('Unprocessable Entity');
      expect(completeJson.detail).toContain('File spoofing rejected');

      // 4. Verify file was completely purged from storage
      const storedObj = s3Storage.getObject(initData.key);
      expect(storedObj).toBeUndefined();
    });
  });

  describe('5. Access Control & Cross-User Session Isolation (401/404)', () => {
    it('enforces authentication and convert:write scope on /api/v1/uploads/direct', async () => {
      // Unauthenticated
      const unauthReq = new NextRequest(`${BASE_URL}/api/v1/uploads/direct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'test.mp4', totalSize: 1024 }),
      });
      const unauthRes = await directPostHandler(unauthReq);
      expect(unauthRes.status).toBe(401);

      // Insufficient scope: convert:read
      const readScopeHeaders = await apiKeyHeaders(userA, ['convert:read']);
      const readOnlyReq = new NextRequest(`${BASE_URL}/api/v1/uploads/direct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...readScopeHeaders },
        body: JSON.stringify({ filename: 'test.mp4', totalSize: 1024 }),
      });
      const readOnlyRes = await directPostHandler(readOnlyReq);
      expect(readOnlyRes.status).toBe(403);
    });

    it('rejects cross-user completion and abort fail-closed with 404 Not Found', async () => {
      const userAHeaders = sessionHeaders(userA);
      const userBHeaders = sessionHeaders(userB);

      // User A initiates upload
      const initReq = new NextRequest(`${BASE_URL}/api/v1/uploads/direct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...userAHeaders },
        body: JSON.stringify({
          filename: 'alice_file.bin',
          mimeType: 'application/octet-stream',
          totalSize: 1024,
        }),
      });

      const initRes = await directPostHandler(initReq);
      expect(initRes.status).toBe(200);
      const initData = await initRes.json();
      const uploadId = initData.uploadId;

      // User B attempts to complete User A upload session
      const crossCompleteReq = new NextRequest(`${BASE_URL}/api/v1/uploads/direct/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...userBHeaders },
        body: JSON.stringify({
          uploadId,
          parts: [{ partNumber: 1, etag: '"dummy"' }],
        }),
      });

      const crossCompleteRes = await directCompletePostHandler(crossCompleteReq);
      expect(crossCompleteRes.status).toBe(404);

      // User B attempts to delete User A upload session
      const crossDeleteReq = new NextRequest(`${BASE_URL}/api/v1/uploads/direct/${uploadId}`, {
        method: 'DELETE',
        headers: userBHeaders,
      });

      const crossDeleteRes = await directDeleteHandler(crossDeleteReq, {
        params: Promise.resolve({ id: uploadId }),
      });
      expect(crossDeleteRes.status).toBe(404);

      // User A can abort their own upload session cleanly
      const validDeleteReq = new NextRequest(`${BASE_URL}/api/v1/uploads/direct/${uploadId}`, {
        method: 'DELETE',
        headers: userAHeaders,
      });

      const validDeleteRes = await directDeleteHandler(validDeleteReq, {
        params: Promise.resolve({ id: uploadId }),
      });
      expect(validDeleteRes.status).toBe(204);

      // Subsequent abort of deleted session returns 404
      const retryDeleteRes = await directDeleteHandler(validDeleteReq, {
        params: Promise.resolve({ id: uploadId }),
      });
      expect(retryDeleteRes.status).toBe(404);
    });
  });

  describe('6. Additional Edge Cases, HMAC Presigning & Boundary Validations', () => {
    it('supports HMAC presigned upload part URLs and rejects tampered HMAC signatures', async () => {
      const auth = sessionHeaders(userA);

      // 1. Initiate upload
      const initReq = new NextRequest(`${BASE_URL}/api/v1/uploads/direct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({
          filename: 'hmac_test.dat',
          mimeType: 'application/octet-stream',
          totalSize: 1024,
        }),
      });

      const initRes = await directPostHandler(initReq);
      const initData = await initRes.json();
      const uploadId = initData.uploadId;

      // 2. Generate local HMAC presigned URL
      const hmacPresigned = s3Storage.generatePresignedHmacPartUrl(
        initData.key,
        uploadId,
        1,
        900
      );

      expect(hmacPresigned.url).toContain('signature=');
      expect(hmacPresigned.url).toContain('expiresAt=');

      // 3. Upload chunk using HMAC presigned URL
      const testChunk = Buffer.from('GENUINE_HMAC_CHUNK_DATA');
      const hmacReq = createStreamRequest(hmacPresigned.url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(testChunk);
            controller.close();
          },
        }),
      });

      const hmacRes = await directPartPutHandler(hmacReq);
      expect(hmacRes.status).toBe(200);
      const hmacJson = await hmacRes.json();
      expect(hmacJson.success).toBe(true);
      expect(hmacJson.size).toBe(testChunk.length);

      // 4. Tampered HMAC signature returns 403
      const tamperedUrl = hmacPresigned.url.replace(/signature=[0-9a-f]{6}/, 'signature=deadbeef');
      const tamperedReq = createStreamRequest(tamperedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(testChunk);
            controller.close();
          },
        }),
      });

      const tamperedRes = await directPartPutHandler(tamperedReq);
      expect(tamperedRes.status).toBe(403);

      // 5. Expired HMAC URL returns 403
      const expiredUrl = hmacPresigned.url.replace(/expiresAt=\d+/, 'expiresAt=1000000000');
      const expiredReq = createStreamRequest(expiredUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(testChunk);
            controller.close();
          },
        }),
      });

      const expiredRes = await directPartPutHandler(expiredReq);
      expect(expiredRes.status).toBe(403);
    });

    it('rejects invalid partNumber boundaries on PUT /api/v1/uploads/direct/part', async () => {
      // Missing partNumber
      const noPartNumReq = new NextRequest(`${BASE_URL}/api/v1/uploads/direct/part?uploadId=any`, {
        method: 'PUT',
      });
      const noPartNumRes = await directPartPutHandler(noPartNumReq);
      expect(noPartNumRes.status).toBe(400);

      // Part number 0
      const zeroPartReq = new NextRequest(
        `${BASE_URL}/api/v1/uploads/direct/part?uploadId=any&partNumber=0`,
        { method: 'PUT' }
      );
      const zeroPartRes = await directPartPutHandler(zeroPartReq);
      expect(zeroPartRes.status).toBe(400);

      // Part number > 10000
      const largePartReq = new NextRequest(
        `${BASE_URL}/api/v1/uploads/direct/part?uploadId=any&partNumber=10001`,
        { method: 'PUT' }
      );
      const largePartRes = await directPartPutHandler(largePartReq);
      expect(largePartRes.status).toBe(400);
    });

    it('enforces totalSize and parts limits on initiation', async () => {
      const auth = sessionHeaders(userA);

      // Negative totalSize
      const negReq = new NextRequest(`${BASE_URL}/api/v1/uploads/direct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ filename: 'test.bin', totalSize: -5 }),
      });
      const negRes = await directPostHandler(negReq);
      expect(negRes.status).toBe(400);

      // Exceeds 10 GiB limit
      const hugeReq = new NextRequest(`${BASE_URL}/api/v1/uploads/direct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ filename: 'test.bin', totalSize: 11 * 1024 * 1024 * 1024 }),
      });
      const hugeRes = await directPostHandler(hugeReq);
      expect(hugeRes.status).toBe(413);

      // Parts count > 10000 (totalSize 20,000, partSize 1 -> 20000 parts)
      const manyPartsReq = new NextRequest(`${BASE_URL}/api/v1/uploads/direct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ filename: 'test.bin', totalSize: 20000, partSize: 1 }),
      });
      const manyPartsRes = await directPostHandler(manyPartsReq);
      expect(manyPartsRes.status).toBe(400);
    });

    it('presigns and verifies URLs containing spaces and percent-encoded paths without double-encoding', () => {
      const creds = {
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        region: 'us-east-1',
        service: 's3',
      };

      const testUrl = 'https://storage.easyconvert.app/uploads/my%20presentation%20file.pdf';
      const presigned = presignSigV4QueryUrl({
        method: 'PUT',
        url: testUrl,
        queryParams: { partNumber: 1, uploadId: 'sess_123' },
        credentials: creds,
        expiresInSeconds: 900,
        timestamp: new Date('2026-10-04T12:00:00.000Z'),
      });

      // Canonical request must have single-encoded /uploads/my%20presentation%20file.pdf
      const pathLine = presigned.canonicalRequest.split('\n')[1];
      expect(pathLine).toBe('/uploads/my%20presentation%20file.pdf');

      // The presigned URL path must match the canonical request path exactly
      const parsedUrl = new URL(presigned.url);
      expect(parsedUrl.pathname).toBe('/uploads/my%20presentation%20file.pdf');

      // Verify accepts the presigned URL
      const verifyRes = verifySigV4QueryUrl(presigned.url, {
        secretAccessKey: creds.secretAccessKey,
        expectedMethod: 'PUT',
        now: new Date('2026-10-04T12:05:00.000Z'),
      });

      expect(verifyRes.valid).toBe(true);
      expect(verifyRes.accessKeyId).toBe(creds.accessKeyId);
    });
  });
});
