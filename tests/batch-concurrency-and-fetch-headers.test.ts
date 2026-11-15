import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as batchPost } from '../src/app/api/convert/batch/route';
import { POST as fetchUrlPost } from '../src/app/api/fetch-url/route';
import { createSessionToken } from '../src/lib/auth/session';
import { userStore } from '../src/lib/auth/user-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';

let authHeaders: Record<string, string>;

beforeAll(async () => {
  const user = userStore.sanitizeUser(
    await userStore.createUser({
      email: `batch_fetch_${Date.now()}@test.io`,
      name: 'Test Batch Fetch',
      tier: 'paid',
      emailVerified: true,
    })
  );
  authHeaders = {
    Cookie: `easyconvert_session=${createSessionToken(user)}`,
  };
});

describe('Batch Concurrency & Fetch-URL Custom Headers', () => {
  describe('/api/convert/batch onError handling', () => {
    it('rejects invalid onError policy with 400', async () => {
      const formData = new FormData();
      formData.append('files', new Blob(['test'], { type: 'text/plain' }), 'test.txt');
      formData.append('targetFormats', JSON.stringify({ 'test.txt': 'pdf' }));
      formData.append('onError', 'invalid_policy');

      const req = new NextRequest('https://easyconvert.test/api/convert/batch', {
        method: 'POST',
        headers: authHeaders,
        body: formData,
      });

      const res = await batchPost(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('The "onError" field must be either "fail" or "continue".');
    });

    it('settles only succeeded file credits and refunds failed file credits when onError is continue', async () => {
      const partialUser = userStore.sanitizeUser(
        await userStore.createUser({
          email: `batch_partial_${Date.now()}@test.io`,
          name: 'Partial Batch User',
          tier: 'free',
          emailVerified: true,
        })
      );
      const beforeUsage = await redisKeyStore.getQuotaUsage(partialUser.id);
      expect(beforeUsage.remaining).toBe(beforeUsage.dailyLimit);

      const formData = new FormData();
      formData.append('files', new Blob(['Hello batch world'], { type: 'text/plain' }), 'good.txt');
      formData.append('files', new Blob(['not a valid png payload'], { type: 'image/png' }), 'bad.png');
      formData.append('targetFormats', JSON.stringify({ 'good.txt': 'html', 'bad.png': 'jpg' }));
      formData.append('onError', 'continue');

      const req = new NextRequest('https://easyconvert.test/api/convert/batch', {
        method: 'POST',
        headers: {
          Cookie: `easyconvert_session=${createSessionToken(partialUser)}`,
        },
        body: formData,
      });

      const res = await batchPost(req);
      expect(res.status).toBe(200);
      expect(res.headers.get('X-Batch-Failed-Count')).toBe('1');

      const afterUsage = await redisKeyStore.getQuotaUsage(partialUser.id);
      expect(beforeUsage.remaining - afterUsage.remaining).toBe(1);
    });
  });

  describe('/api/fetch-url headers validation', () => {
    it('rejects non-object headers with 400 invalid_headers', async () => {
      const req = new NextRequest('https://easyconvert.test/api/fetch-url', {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://example.com/file.pdf',
          headers: 'not-an-object',
        }),
      });

      const res = await fetchUrlPost(req);
      const data = await res.json();
      expect(res.status).toBe(400);
      expect(data.code).toBe('invalid_headers');
    });

    it('rejects more than 16 headers with 400 invalid_headers', async () => {
      const headers: Record<string, string> = {};
      for (let i = 0; i < 17; i++) {
        headers[`X-Custom-Header-${i}`] = `value-${i}`;
      }

      const req = new NextRequest('https://easyconvert.test/api/fetch-url', {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://example.com/file.pdf',
          headers,
        }),
      });

      const res = await fetchUrlPost(req);
      const data = await res.json();
      expect(res.status).toBe(400);
      expect(data.code).toBe('invalid_headers');
      expect(data.error).toContain('At most 16 custom headers are allowed');
    });

    it('rejects forbidden headers like cookie or host with 400 invalid_headers', async () => {
      for (const forbidden of ['cookie', 'host', 'content-length', 'proxy-authorization']) {
        const req = new NextRequest('https://easyconvert.test/api/fetch-url', {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: 'https://example.com/file.pdf',
            headers: { [forbidden]: 'value' },
          }),
        });

        const res = await fetchUrlPost(req);
        const data = await res.json();
        expect(res.status).toBe(400);
        expect(data.code).toBe('invalid_headers');
        expect(data.error).toContain('is not permitted');
      }
    });

    it('rejects invalid header names with CTL or invalid chars', async () => {
      const req = new NextRequest('https://easyconvert.test/api/fetch-url', {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://example.com/file.pdf',
          headers: { 'Invalid Header Name ': 'value' },
        }),
      });

      const res = await fetchUrlPost(req);
      const data = await res.json();
      expect(res.status).toBe(400);
      expect(data.code).toBe('invalid_headers');
    });
  });

  describe('deploy/oci/easyconvert-deploy.sudoers subcommand matching', () => {
    it('allows no-arg rollback and reconcile without requiring a trailing argument token', () => {
      const sudoers = fs.readFileSync(
        path.resolve(__dirname, '..', 'deploy', 'oci', 'easyconvert-deploy.sudoers'),
        'utf-8'
      );
      expect(sudoers).toContain('/opt/easyconvert/bin/deploy.sh deploy *');
      expect(sudoers).toContain('/opt/easyconvert/bin/deploy.sh rollback,');
      expect(sudoers).toMatch(/\/opt\/easyconvert\/bin\/deploy\.sh reconcile\s*$/m);
      expect(sudoers).not.toContain('rollback *');
      expect(sudoers).not.toContain('reconcile *');
    });
  });
});
