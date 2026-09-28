import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { redisUserStore } from '../../src/lib/auth/redis-user-store';
import { redisKeyStore } from '../../src/lib/api-keys/redis-key-store';
import { createSessionToken, createSessionCookie, getSessionFromRequest } from '../../src/lib/auth/session';
import { POST as registerHandler } from '../../src/app/api/auth/register/route';
import { POST as loginHandler } from '../../src/app/api/auth/login/route';
import { POST as jobsPostHandler } from '../../src/app/api/v1/jobs/route';
import { POST as convertPostHandler } from '../../src/app/api/v1/convert/route';
import { executeWorkerConversion } from '../../src/worker/engines';
import { storageProvider } from '../../src/lib/storage';

describe('Phase 1: Distributed Auth, Zero-Heap API & Async MIME Sniffer', () => {
  beforeEach(() => {
    redisUserStore.resetStore();
    redisKeyStore.resetStore();
  });

  afterEach(() => {
    redisUserStore.resetStore();
    redisKeyStore.resetStore();
  });

  describe('1. Distributed User Store & Unified Auth Contract', () => {
    it('creates, retrieves, and updates users in redisUserStore without local disk split-brain', async () => {
      const email = 'distributed-dev@example.com';
      const user = await redisUserStore.createUser({
        email,
        name: 'Distributed Dev',
        tier: 'pro',
        provider: 'email',
        passwordHash: 'dummy_hash',
        salt: 'dummy_salt',
      });

      expect(user.id).toBeDefined();
      expect(user.email).toBe(email);
      expect(user.tier).toBe('pro');

      const byId = await redisUserStore.findById(user.id);
      expect(byId?.id).toBe(user.id);
      expect(byId?.email).toBe(email);

      const byEmail = await redisUserStore.findByEmail(email);
      expect(byEmail?.id).toBe(user.id);

      // Duplicate email rejection
      await expect(
        redisUserStore.createUser({
          email,
          name: 'Duplicate',
        })
      ).rejects.toThrow('A user with this email address already exists');

      // Update tier
      const updated = await redisUserStore.updateTier(user.id, 'enterprise');
      expect(updated?.tier).toBe('enterprise');

      const reFetched = await redisUserStore.findById(user.id);
      expect(reFetched?.tier).toBe('enterprise');
    });

    it('authenticates session tokens strictly against redisUserStore', async () => {
      const user = await redisUserStore.createUser({
        email: 'session-user@example.com',
        name: 'Session User',
        tier: 'free',
      });

      const token = createSessionToken(redisUserStore.sanitizeUser(user));
      const req = new NextRequest('http://localhost:3000/api/dashboard', {
        headers: {
          Cookie: `easyconvert_session=${token}`,
        },
      });

      const session = await getSessionFromRequest(req);
      expect(session).not.toBeNull();
      expect(session?.id).toBe(user.id);
      expect(session?.email).toBe(user.email);
    });

    it('integrates redisKeyStore quota verification and deduction with redisUserStore', async () => {
      const user = await redisUserStore.createUser({
        email: 'key-owner@example.com',
        name: 'Key Owner',
        tier: 'pro',
      });

      const { key, secretKey } = await redisKeyStore.generateApiKey(user.id, 'Distributed Key');
      expect(secretKey).toBeDefined();

      const verification = await redisKeyStore.verifyApiKey(secretKey);
      expect(verification.valid).toBe(true);
      expect(verification.user?.id).toBe(user.id);
      expect(verification.user?.tier).toBe('pro');

      const quota = await redisKeyStore.recordUsage(user.id, 5);
      expect(quota.allowed).toBe(true);
      expect(quota.remaining).toBe(495);
    });

    it('end-to-end auth routes register and login correctly via redisUserStore', async () => {
      const regReq = new NextRequest('http://localhost:3000/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          email: 'e2e-auth@example.com',
          password: 'SecurePassword123!',
          name: 'E2E User',
        }),
      });

      const regRes = await registerHandler(regReq);
      expect(regRes.status).toBe(200);
      const regJson = await regRes.json();
      expect(regJson.success).toBe(true);
      expect(regJson.user.email).toBe('e2e-auth@example.com');

      // Verify user is in redisUserStore
      const inStore = await redisUserStore.findByEmail('e2e-auth@example.com');
      expect(inStore).not.toBeNull();
      expect(inStore?.name).toBe('E2E User');

      // Login route
      const loginReq = new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: 'e2e-auth@example.com',
          password: 'SecurePassword123!',
        }),
      });

      const loginRes = await loginHandler(loginReq);
      expect(loginRes.status).toBe(200);
      const loginJson = await loginRes.json();
      expect(loginJson.success).toBe(true);
      expect(loginJson.token).toBeDefined();
    });
  });

  describe('2. Asynchronous Queue (/api/v1/jobs) MIME Spoofing Gate', () => {
    it('fails closed (400 Bad Request) when uploading an executable or spoofed file to /api/v1/jobs', async () => {
      const user = await redisUserStore.createUser({
        email: 'queue-tester@example.com',
        name: 'Queue Tester',
        tier: 'pro',
      });
      const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'Queue Key', {
        scopes: ['convert:write', 'convert:read'],
      });

      // Spoofed file: ELF binary disguised as .docx
      const elfBytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00]);
      const blob = new Blob([elfBytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      const formData = new FormData();
      formData.append('file', blob, 'malicious.docx');
      formData.append('targetFormat', 'pdf');

      const req = new NextRequest('http://localhost:3000/api/v1/jobs', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${secretKey}`,
        },
        body: formData,
      });

      const res = await jobsPostHandler(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.title || data.error).toMatch(/spoof|invalid/i);
    });

    it('fails closed (400 Bad Request) when submitting spoofed inputBufferBase64 to /api/v1/jobs', async () => {
      const user = await redisUserStore.createUser({
        email: 'queue-tester2@example.com',
        name: 'Queue Tester 2',
        tier: 'pro',
      });
      const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'Queue Key 2', {
        scopes: ['convert:write', 'convert:read'],
      });

      const fakeDocxBase64 = Buffer.from('NOT_A_VALID_ZIP_OR_DOCX_HEADER').toString('base64');
      const req = new NextRequest('http://localhost:3000/api/v1/jobs', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          originalFilename: 'report.docx',
          sourceFormat: 'docx',
          targetFormat: 'pdf',
          inputBufferBase64: fakeDocxBase64,
        }),
      });

      const res = await jobsPostHandler(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.title || data.error).toMatch(/spoof|invalid/i);
    });

    it('enqueues authentic file upload to /api/v1/jobs successfully', async () => {
      const user = await redisUserStore.createUser({
        email: 'queue-success@example.com',
        name: 'Queue Success User',
        tier: 'pro',
      });
      const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'Queue Key 3', {
        scopes: ['convert:write', 'convert:read'],
      });

      // Valid plain text format file
      const txtBytes = Buffer.from('Authentic plain text document content for asynchronous conversion.');
      const blob = new Blob([txtBytes], { type: 'text/plain' });
      const formData = new FormData();
      formData.append('file', blob, 'notes.txt');
      formData.append('targetFormat', 'pdf');

      const req = new NextRequest('http://localhost:3000/api/v1/jobs', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${secretKey}`,
        },
        body: formData,
      });

      const res = await jobsPostHandler(req);
      expect(res.status).toBe(202);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.jobId).toBeDefined();
    });

    it('fails closed (400 Bad Request) when storageKey does not exist in storage', async () => {
      const user = await redisUserStore.createUser({
        email: 'queue-missing-storage@example.com',
        name: 'Missing Storage User',
        tier: 'pro',
      });
      const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'Queue Key Missing', {
        scopes: ['convert:write'],
      });

      const req = new NextRequest('http://localhost:3000/api/v1/jobs', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          originalFilename: 'data.txt',
          sourceFormat: 'txt',
          targetFormat: 'pdf',
          storageKey: 'non_existent_storage_key_99999',
        }),
      });

      const res = await jobsPostHandler(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.title || data.error || data.detail).toMatch(/not found/i);
    });

    it('fails closed (400 Bad Request) when storageKey points to a spoofed file', async () => {
      const user = await redisUserStore.createUser({
        email: 'queue-spoofed-storage@example.com',
        name: 'Spoofed Storage User',
        tier: 'pro',
      });
      const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'Queue Key Spoofed Store', {
        scopes: ['convert:write'],
      });

      // Save an ELF binary under a .docx storage key
      const key = `uploads/test_spoof_${Date.now()}_doc.docx`;
      const elfBytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
      storageProvider.saveObject(key, elfBytes, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'doc.docx');

      const req = new NextRequest('http://localhost:3000/api/v1/jobs', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          originalFilename: 'doc.docx',
          sourceFormat: 'docx',
          targetFormat: 'pdf',
          storageKey: key,
        }),
      });

      const res = await jobsPostHandler(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.title || data.error || data.detail).toMatch(/spoof|invalid/i);
    });

    it('enqueues authentic storageKey job successfully without memory bloat', async () => {
      const user = await redisUserStore.createUser({
        email: 'queue-storage-success@example.com',
        name: 'Storage Success User',
        tier: 'pro',
      });
      const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'Queue Key Storage Ok', {
        scopes: ['convert:write'],
      });

      const key = `uploads/valid_${Date.now()}_file.txt`;
      const validText = Buffer.from('Plain text valid document body in object storage');
      storageProvider.saveObject(key, validText, 'text/plain', 'file.txt');

      const req = new NextRequest('http://localhost:3000/api/v1/jobs', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          originalFilename: 'file.txt',
          sourceFormat: 'txt',
          targetFormat: 'pdf',
          storageKey: key,
        }),
      });

      const res = await jobsPostHandler(req);
      expect(res.status).toBe(202);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.jobId).toBeDefined();
    });
  });

  describe('3. Worker Engine Dispatcher Magic Byte Guard', () => {
    it('executeWorkerConversion rejects spoofed files before native engine dispatch', async () => {
      // Fake PE Windows binary labeled as .docx
      const peBytes = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

      await expect(
        executeWorkerConversion(peBytes, 'docx', 'pdf', {}, 'fake.docx')
      ).rejects.toThrow(/spoof|invalid/i);
    });
  });

  describe('4. Synchronous API (/api/v1/convert) Zero-Heap Optimization', () => {
    it('returns raw octet-stream without generating Base64 dataUri when requested', async () => {
      const user = await redisUserStore.createUser({
        email: 'raw-tester@example.com',
        name: 'Raw Tester',
        tier: 'pro',
      });
      const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'Raw Key', {
        scopes: ['convert:write'],
      });

      const txtBytes = Buffer.from('Hello EasyConvert Zero-Heap Raw Stream!');
      const blob = new Blob([txtBytes], { type: 'text/plain' });
      const formData = new FormData();
      formData.append('file', blob, 'doc.txt');
      formData.append('targetFormat', 'pdf');

      const req = new NextRequest('http://localhost:3000/api/v1/convert', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${secretKey}`,
          'Accept': 'application/octet-stream',
        },
        body: formData,
      });

      const res = await convertPostHandler(req);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/pdf');
      const arrayBuf = await res.arrayBuffer();
      expect(arrayBuf.byteLength).toBeGreaterThan(0);
      // Valid PDF magic bytes
      const header = Buffer.from(arrayBuf.slice(0, 4)).toString('ascii');
      expect(header).toBe('%PDF');
    });

    it('returns JSON response with dataUri for files <= 5MB', async () => {
      const user = await redisUserStore.createUser({
        email: 'small-tester@example.com',
        name: 'Small Tester',
        tier: 'pro',
      });
      const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'Small Key', {
        scopes: ['convert:write'],
      });

      const txtBytes = Buffer.from('Small document text content');
      const blob = new Blob([txtBytes], { type: 'text/plain' });
      const formData = new FormData();
      formData.append('file', blob, 'small.txt');
      formData.append('targetFormat', 'pdf');

      const req = new NextRequest('http://localhost:3000/api/v1/convert', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${secretKey}`,
        },
        body: formData,
      });

      const res = await convertPostHandler(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.dataUri).toBeDefined();
      expect(json.dataUri.startsWith('data:application/pdf;base64,')).toBe(true);
      expect(json.downloadUrl).toBeDefined();
    });
  });
});
