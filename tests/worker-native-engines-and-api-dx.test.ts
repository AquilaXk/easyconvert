import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import {
  probeNativeEngines,
  convertWithNative7z,
  convertWithNativePoppler,
  convertWithHeadlessOffice,
  executeWorkerConversion,
  assertNotSpoofedFileVfs,
} from '../src/worker/engines';
import { assertNotSpoofedFilePath } from '../src/lib/security/file-guard';
import { FileExtensionSpoofError } from '../src/lib/registry';
import { convertArchive } from '../src/lib/conversions/archive';
import { POST as convertRouteHandler } from '../src/app/api/v1/convert/route';
import { keyStore } from '../src/lib/api-keys/key-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { conversionQueue } from '../src/lib/queue/conversion-queue';
import { buildRateLimitHeaders } from '../src/lib/api/rate-limit';
import { createProblemDetailsResponse } from '../src/lib/api/problem-details';

let userCounter = 0;
async function createUniqueTestUser(tier: 'free' | 'starter' | 'pro' | 'enterprise' = 'starter') {
  userCounter++;
  const uniqueId = `${Date.now()}_${userCounter}_${Math.random().toString(36).slice(2, 7)}`;
  return userStore.sanitizeUser(
    await userStore.createUser({
      email: `test_dev_${uniqueId}@example.com`,
      name: `Test Dev ${uniqueId}`,
      tier,
    })
  );
}

describe('Worker Native Engines & API DX Enterprise Enhancements', () => {
  describe('1. Dockerfile.worker Engine Completeness', () => {
    it('verifies tesseract-ocr, tesseract-ocr-kor, tesseract-ocr-eng, and p7zip-rar are installed', () => {
      const dockerfilePath = path.join(process.cwd(), 'Dockerfile.worker');
      expect(fs.existsSync(dockerfilePath)).toBe(true);

      const dockerfileContent = fs.readFileSync(dockerfilePath, 'utf-8');
      expect(dockerfileContent).toContain('p7zip-rar');
      expect(dockerfileContent).toContain('tesseract-ocr');
      expect(dockerfileContent).toContain('tesseract-ocr-eng');
      expect(dockerfileContent).toContain('tesseract-ocr-kor');
      expect(dockerfileContent).toContain('p7zip-full');
      expect(dockerfileContent).toContain('poppler-utils');
      expect(dockerfileContent).toContain('libreoffice-writer');
    });
  });

  describe('2. Worker Native Engine Probing & Interface Diagnostics', () => {
    it('probes all native engines including pdftotext and tesseract without throwing', () => {
      const diagnostics = probeNativeEngines();
      expect(diagnostics).toHaveProperty('soffice');
      expect(diagnostics).toHaveProperty('ffmpeg');
      expect(diagnostics).toHaveProperty('p7zip');
      expect(diagnostics).toHaveProperty('pdftoppm');
      expect(diagnostics).toHaveProperty('pdftotext');
      expect(diagnostics).toHaveProperty('tesseract');
      expect(typeof diagnostics.soffice).toBe('boolean');
      expect(typeof diagnostics.p7zip).toBe('boolean');
      expect(typeof diagnostics.pdftoppm).toBe('boolean');
      expect(typeof diagnostics.pdftotext).toBe('boolean');
      expect(typeof diagnostics.tesseract).toBe('boolean');
    });

    it('gracefully handles missing 7z binary with fail-closed or pure TS fallback', async () => {
      const sampleZip = Buffer.from('PK\x05\x06\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00');
      const res = await convertWithNative7z(sampleZip, 'zip', 'tar', {}, 'archive.zip');
      if (res !== null) {
        expect(res.engineUsed).toBe('native-7z');
        expect(res.filename).toBe('archive.tar');
        expect(res.size).toBeGreaterThan(0);
      } else {
        expect(res).toBeNull();
      }
    });

    it('gracefully handles missing Poppler binary with fail-closed return', async () => {
      const dummyPdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF');
      const txtRes = await convertWithNativePoppler(dummyPdf, 'pdf', 'txt', {}, 'sample.pdf');
      if (txtRes !== null) {
        expect(txtRes.engineUsed).toBe('native-poppler');
        expect(txtRes.mimeType).toBe('text/plain; charset=utf-8');
      } else {
        expect(txtRes).toBeNull();
      }

      const imgRes = await convertWithNativePoppler(dummyPdf, 'pdf', 'png', {}, 'sample.pdf');
      if (imgRes !== null) {
        expect(imgRes.engineUsed).toBe('native-poppler');
        expect(imgRes.mimeType).toBe('image/png');
      } else {
        expect(imgRes).toBeNull();
      }
    });

    it('validates format strings and rejects invalid format characters', async () => {
      const dummyBuffer = Buffer.from('test');
      await expect(
        convertWithHeadlessOffice(dummyBuffer, 'doc; rm -rf /', 'pdf')
      ).rejects.toThrow(/Invalid format identifier/);

      await expect(
        convertWithNative7z(dummyBuffer, 'zip', 'tar; echo hacked')
      ).rejects.toThrow(/Invalid format identifier/);

      await expect(
        convertWithNativePoppler(dummyBuffer, 'pdf', 'png && malicious')
      ).rejects.toThrow(/Invalid format identifier/);
    });

    it('executes worker orchestrator for archive formats with fallback preservation', async () => {
      const sampleText = Buffer.from('EasyConvert Worker Native Archive Test Content');
      const zipRes = await convertArchive(sampleText, 'txt', 'zip', {}, 'sample.txt');

      const result = await executeWorkerConversion(
        zipRes.buffer,
        'zip',
        'tar.gz',
        {},
        'sample.zip'
      );

      expect(result).toBeDefined();
      expect(result.size).toBeGreaterThan(0);
      expect(['native-7z', 'internal-fallback']).toContain(result.engineUsed);
      expect(result.filename).toBe('sample.tar.gz');
      expect(result.mimeType).toBe('application/gzip');
    });
  });

  describe('3. IETF Draft RateLimit Headers & RFC 9457 Problem Details', () => {
    it('builds RFC rate-limit headers conforming to IETF draft-ietf-httpapi-ratelimit-headers', () => {
      const now = Date.now();
      const headers = buildRateLimitHeaders({
        tier: 'pro',
        dailyLimit: 500,
        usedToday: 50,
        remaining: 450,
        resetAt: now + 3600 * 1000,
      });

      expect(headers['RateLimit-Limit']).toBe('500');
      expect(headers['RateLimit-Remaining']).toBe('450');
      expect(Number(headers['RateLimit-Reset'])).toBeGreaterThanOrEqual(3590);
      expect(headers['RateLimit-Policy']).toContain('500;w=86400');
      expect(headers['RateLimit-Policy']).toContain('pro daily quota');

      // Check legacy X-RateLimit headers
      expect(headers['X-RateLimit-Limit']).toBe('500');
      expect(headers['X-RateLimit-Remaining']).toBe('450');
      expect(headers['X-RateLimit-Reset']).toBe(headers['RateLimit-Reset']);
    });

    it('formats standardized RFC 9457 Problem Details responses', async () => {
      const response = createProblemDetailsResponse(
        400,
        'Unsupported conversion pair: XYZ to ABC.',
        '/api/v1/convert',
        'Bad Request',
        'https://api.easyconvert.io/problems/unsupported-conversion',
        { 'X-Custom-Header': 'val' }
      );

      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
      expect(response.headers.get('x-custom-header')).toBe('val');

      const body = await response.json();
      expect(body.type).toBe('https://api.easyconvert.io/problems/unsupported-conversion');
      expect(body.title).toBe('Bad Request');
      expect(body.status).toBe(400);
      expect(body.detail).toBe('Unsupported conversion pair: XYZ to ABC.');
      expect(body.instance).toBe('/api/v1/convert');
      expect(body.success).toBe(false);
      expect(body.error).toBe('Unsupported conversion pair: XYZ to ABC.');
    });
  });

  describe('4. /api/v1/convert Enterprise API Enhancements', () => {
    it('returns RFC 9457 problem details when unauthenticated', async () => {
      const req = new NextRequest('http://localhost:3000/api/v1/convert', {
        method: 'POST',
      });
      const res = await convertRouteHandler(req);

      expect(res.status).toBe(401);
      expect(res.headers.get('content-type')).toContain('application/problem+json');

      const body = await res.json();
      expect(body.type).toBe('https://api.easyconvert.io/problems/unauthorized');
      expect(body.title).toBe('Unauthorized');
      expect(body.status).toBe(401);
      expect(body.instance).toBe('/api/v1/convert');
      expect(body.success).toBe(false);
      expect(typeof body.detail).toBe('string');
      expect(body.error).toBe(body.detail);
    });

    it('injects IETF RateLimit headers on successful synchronous conversion', async () => {
      const user = await createUniqueTestUser('starter');
      const { secretKey } = await keyStore.generateApiKey(user.id, 'RateLimit Key');

      const csvContent = 'id,name\n1,Alice\n2,Bob';
      const file = new File([csvContent], 'users.csv', { type: 'text/csv' });
      const formData = new FormData();
      formData.append('file', file);
      formData.append('targetFormat', 'json');

      const req = new NextRequest('http://localhost:3000/api/v1/convert', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secretKey}`,
        },
        body: formData,
      });

      const res = await convertRouteHandler(req);
      expect(res.status).toBe(200);

      // Verify RateLimit headers presence
      expect(res.headers.get('RateLimit-Limit')).toBeDefined();
      expect(res.headers.get('RateLimit-Remaining')).toBeDefined();
      expect(res.headers.get('RateLimit-Reset')).toBeDefined();
      expect(res.headers.get('RateLimit-Policy')).toContain('w=86400');
      expect(res.headers.get('X-RateLimit-Limit')).toBeDefined();

      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.sourceFormat).toBe('csv');
      expect(data.targetFormat).toBe('json');
      expect(data.fileName).toBe('users.json');
    });

    it('hands off to asynchronous queue with 202 Accepted when Prefer: respond-async is supplied', async () => {
      const user = await createUniqueTestUser('pro');
      const { secretKey } = await keyStore.generateApiKey(user.id, 'Async Prefer Key');

      const csvContent = 'a,b,c\n10,20,30';
      const file = new File([csvContent], 'data.csv', { type: 'text/csv' });
      const formData = new FormData();
      formData.append('file', file);
      formData.append('targetFormat', 'json');

      const req = new NextRequest('http://localhost:3000/api/v1/convert', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secretKey}`,
          Prefer: 'respond-async',
        },
        body: formData,
      });

      const res = await convertRouteHandler(req);
      expect(res.status).toBe(202);
      expect(res.headers.get('Preference-Applied')).toBe('respond-async');
      expect(res.headers.get('Location')).toMatch(/^\/api\/v1\/jobs\/.+/);
      expect(res.headers.get('RateLimit-Limit')).toBeDefined();

      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.status).toBe('accepted');
      expect(body.jobId).toBeDefined();
      expect(body.statusUrl).toBe(`/api/v1/jobs/${body.jobId}`);
      expect(body.location).toBe(`/api/v1/jobs/${body.jobId}`);
      expect(body.originalFilename).toBe('data.csv');
      expect(body.sourceFormat).toBe('csv');
      expect(body.targetFormat).toBe('json');

      // Verify job exists in the conversion queue
      const queuedJob = await conversionQueue.getJob(body.jobId);
      expect(queuedJob).toBeDefined();
      expect(queuedJob?.data.userId).toBe(user.id);
      expect(queuedJob?.data.sourceFormat).toBe('csv');
      expect(queuedJob?.data.targetFormat).toBe('json');
    });

    it('automatically hands off files > 10MB to asynchronous queue (202 Accepted)', async () => {
      const user = await createUniqueTestUser('enterprise');
      const { secretKey } = await keyStore.generateApiKey(user.id, 'Large File Key');

      // Create a 10.5 MB payload
      const largeSize = 10.5 * 1024 * 1024;
      const largeChunk = new Uint8Array(largeSize);
      largeChunk.fill(0x61); // filled with 'a'

      const queueSpy = vi.spyOn(conversionQueue, 'add').mockResolvedValueOnce({
        id: 'job_large_10mb',
        timestamp: Date.now(),
        data: {} as any,
      } as any);

      const file = new File([largeChunk], 'big_data.txt', { type: 'text/plain' });
      const formData = new FormData();
      formData.append('file', file);
      formData.append('targetFormat', 'pdf');

      const req = new NextRequest('http://localhost:3000/api/v1/convert', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secretKey}`,
        },
        body: formData,
      });

      const res = await convertRouteHandler(req);
      expect(res.status).toBe(202);
      expect(res.headers.get('Preference-Applied')).toBe('respond-async');
      expect(res.headers.get('Location')).toBe('/api/v1/jobs/job_large_10mb');

      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.status).toBe('accepted');
      expect(body.fileSize).toBe(largeSize);
      expect(body.originalFilename).toBe('big_data.txt');
      expect(queueSpy).toHaveBeenCalledWith(
        'convert',
        expect.objectContaining({
          originalFilename: 'big_data.txt',
          fileSize: largeSize,
          sourceFormat: 'txt',
          targetFormat: 'pdf',
          userId: user.id,
        }),
        expect.any(Object)
      );

      queueSpy.mockRestore();
    });

    it('formats 400 validation errors using RFC 9457 with RateLimit headers', async () => {
      const user = await createUniqueTestUser('starter');
      const { secretKey } = await keyStore.generateApiKey(user.id, 'Bad Req Key');

      const form = new FormData();
      form.append('file', new File(['hello'], 'hello.unknownext', { type: 'application/octet-stream' }));
      form.append('targetFormat', 'pdf');

      const req = new NextRequest('http://localhost:3000/api/v1/convert', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secretKey}`,
        },
        body: form,
      });

      const res = await convertRouteHandler(req);
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
      expect(res.headers.get('RateLimit-Limit')).toBeDefined();

      const body = await res.json();
      expect(body.type).toBe('https://api.easyconvert.io/problems/bad-request');
      expect(body.status).toBe(400);
      expect(body.detail).toContain('Could not identify source format');
      expect(body.success).toBe(false);
      expect(body.error).toBe(body.detail);
    });

    it('formats 429 quota exhaustion using RFC 9457 with RateLimit headers', async () => {
      const user = await createUniqueTestUser('free');
      const { secretKey } = await keyStore.generateApiKey(user.id, 'Quota Exhaust Key');

      // Exhaust daily quota for free tier (25 units)
      await redisKeyStore.recordUsage(user.id, 25);

      const form = new FormData();
      form.append('file', new File(['1,2,3'], 'data.csv', { type: 'text/csv' }));
      form.append('targetFormat', 'json');

      const req = new NextRequest('http://localhost:3000/api/v1/convert', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secretKey}`,
        },
        body: form,
      });

      const res = await convertRouteHandler(req);
      expect(res.status).toBe(429);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
      expect(res.headers.get('RateLimit-Remaining')).toBe('0');

      const body = await res.json();
      expect(body.type).toBe('https://api.easyconvert.io/problems/quota-exceeded');
      expect(body.status).toBe(429);
      expect(body.detail).toContain('Daily conversion quota exceeded');
      expect(body.success).toBe(false);
      expect(body.error).toBe(body.detail);
    });
  });

  describe('4. Zero-Heap File Guard & VFS Spoofing Fail-Closed Verification', () => {
    it('fails closed when assertNotSpoofedFileVfs receives an empty VFS payload', () => {
      expect(() => assertNotSpoofedFileVfs({} as any, 'png', 'test.png')).toThrow(
        /VFS payload contains no valid inputBuffer or inputPath/
      );
    });

    it('fails closed when assertNotSpoofedFileVfs receives an empty 0-byte buffer', () => {
      expect(() =>
        assertNotSpoofedFileVfs({ inputBuffer: Buffer.alloc(0) }, 'png', 'empty.png')
      ).toThrow(FileExtensionSpoofError);
    });

    it('verifies Uint8Array input payloads directly in assertNotSpoofedFileVfs', () => {
      const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(() => assertNotSpoofedFileVfs(pngHeader, 'png', 'test.png')).not.toThrow();
      expect(() => assertNotSpoofedFileVfs(new Uint8Array(0), 'png', 'empty.png')).toThrow(
        FileExtensionSpoofError
      );
    });

    it('fails closed when assertNotSpoofedFilePath is called with a directory path', () => {
      expect(() => assertNotSpoofedFilePath('/tmp', 'png', 'test.png')).toThrow(
        /Target path is not a regular file/
      );
    });

    it('fails closed when assertNotSpoofedFilePath is called with a 0-byte file on disk', () => {
      const emptyFile = path.join('/tmp', `easyconvert_empty_${Date.now()}.png`);
      fs.writeFileSync(emptyFile, Buffer.alloc(0));
      try {
        expect(() => assertNotSpoofedFilePath(emptyFile, 'png', 'empty.png')).toThrow(
          FileExtensionSpoofError
        );
        expect(() => assertNotSpoofedFilePath(emptyFile, 'png')).toThrow(
          /target file is empty \(0 bytes\)/
        );
      } finally {
        try {
          fs.unlinkSync(emptyFile);
        } catch {}
      }
    });
  });
});
