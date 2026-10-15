import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import { POST as createKeyRoute } from '../src/app/api/keys/route';
import { PATCH as updateKeyRoute, DELETE as deleteKeyRoute } from '../src/app/api/keys/[id]/route';
import { POST as rotateKeyRoute } from '../src/app/api/keys/[id]/rotate/route';
import { redisKeyStore, RedisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { hashApiKeySecret } from '../src/lib/api-keys/key-store';
import { encryptSecret, decryptSecret } from '../src/lib/api-keys/secret-encryption';
import { isScopeAllowed } from '../src/lib/api-keys/guard';
import { toPublicApiKey } from '../src/lib/api-keys/public-views';
import type { User } from '../src/lib/auth/types';

describe('Phase 1-A: API Key Scope Integrity, Redis Revocation Sync & Rotation', () => {
  let testUser: User;
  let adminSecretKey: string;
  let adminKeyId: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    process.env.KEY_HASH_PEPPER = 'test-pepper-phase1a-9876543210abcdef';
    redisKeyStore.resetStore();

    testUser = await userStore.createUser({
      email: `test-api-keys-${crypto.randomUUID()}@example.com`,
      name: 'API Key Test User',
    });

    const adminKeyResult = await redisKeyStore.generateApiKey(testUser.id, 'Admin Master Key', {
      scopes: ['*'],
    });
    adminSecretKey = adminKeyResult.secretKey;
    adminKeyId = adminKeyResult.key.id;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.restoreAllMocks();
  });

  describe('1. Scope Integrity & Rejection of Empty/Unknown Scopes', () => {
    it('rejects POST /api/keys with empty scopes array [] with 400 Bad Request', async () => {
      const req = new NextRequest('http://localhost/api/keys', {
        method: 'POST',
        headers: {
          'x-api-key': adminSecretKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Empty Scopes Key',
          scopes: [],
        }),
      });

      const res = await createKeyRoute(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain('scopes must be a non-empty array');
    });

    it('rejects POST /api/keys with invalid or unrecognized scope tokens with 400 Bad Request', async () => {
      const req = new NextRequest('http://localhost/api/keys', {
        method: 'POST',
        headers: {
          'x-api-key': adminSecretKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Invalid Scope Key',
          scopes: ['convert:read', 'admin:superpower'],
        }),
      });

      const res = await createKeyRoute(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain("Invalid scope 'admin:superpower'");
    });

    it('defaults omitted scopes to least privilege convert:read on POST /api/keys', async () => {
      const req = new NextRequest('http://localhost/api/keys', {
        method: 'POST',
        headers: {
          'x-api-key': adminSecretKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Default Scope Key',
        }),
      });

      const res = await createKeyRoute(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.key.scopes).toEqual(['convert:read']);
    });

    it('rejects PATCH /api/keys/[id] with empty scopes or invalid tokens with 400', async () => {
      const emptyReq = new NextRequest(`http://localhost/api/keys/${adminKeyId}`, {
        method: 'PATCH',
        headers: {
          'x-api-key': adminSecretKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          scopes: [],
        }),
      });

      const emptyRes = await updateKeyRoute(emptyReq, { params: Promise.resolve({ id: adminKeyId }) });
      expect(emptyRes.status).toBe(400);
      const emptyJson = await emptyRes.json();
      expect(emptyJson.error).toContain('scopes must be a non-empty array');

      const invalidReq = new NextRequest(`http://localhost/api/keys/${adminKeyId}`, {
        method: 'PATCH',
        headers: {
          'x-api-key': adminSecretKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          scopes: ['malicious:elevate'],
        }),
      });

      const invalidRes = await updateKeyRoute(invalidReq, { params: Promise.resolve({ id: adminKeyId }) });
      expect(invalidRes.status).toBe(400);
      const invalidJson = await invalidRes.json();
      expect(invalidJson.error).toContain("Invalid scope 'malicious:elevate'");
    });

    it('successfully updates key properties via PATCH /api/keys/[id]', async () => {
      const patchReq = new NextRequest(`http://localhost/api/keys/${adminKeyId}`, {
        method: 'PATCH',
        headers: {
          'x-api-key': adminSecretKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Renamed Key',
          scopes: ['convert:read', 'convert:write'],
          allowedIps: ['192.168.1.100'],
        }),
      });

      const res = await updateKeyRoute(patchReq, { params: Promise.resolve({ id: adminKeyId }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.key.name).toBe('Renamed Key');
      expect(json.key.scopes).toEqual(['convert:read', 'convert:write']);
      expect(json.key.allowedIps).toEqual(['192.168.1.100']);
    });
  });

  describe('2. Fail-Closed Production Requirement for KEY_HASH_PEPPER', () => {
    it('throws fatal error in NODE_ENV=production when KEY_HASH_PEPPER is missing', () => {
      delete process.env.KEY_HASH_PEPPER;
      process.env.NODE_ENV = 'production';

      expect(() => {
        hashApiKeySecret('any_secret_key');
      }).toThrow(/KEY_HASH_PEPPER environment variable is required in production/);
    });

    it('operates normally when KEY_HASH_PEPPER is provided in production', () => {
      process.env.KEY_HASH_PEPPER = 'secure-production-pepper-0123456789abcdef';
      process.env.NODE_ENV = 'production';

      const hash = hashApiKeySecret('ec_live_test_secret_value');
      expect(hash).toBeDefined();
      expect(hash.length).toBe(64);
    });
  });

  describe('3. Webhook Secret AES-256-GCM Encryption at Rest', () => {
    it('authentically encrypts and decrypts secrets with AES-256-GCM', () => {
      const plaintext = 'whsec_sensitive_webhook_signing_secret_999';
      const encrypted = encryptSecret(plaintext);

      expect(encrypted).toBeDefined();
      expect(encrypted).toMatch(/^enc:v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
      expect(encrypted).not.toContain(plaintext);

      const decrypted = decryptSecret(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('encrypts webhookSecret when generating API key and decrypts upon retrieval', async () => {
      const rawSecret = 'whsec_my_super_secret_webhook_key';
      const created = await redisKeyStore.generateApiKey(testUser.id, 'Webhook Key', {
        webhookUrl: 'https://example.com/webhook',
        webhookSecret: rawSecret,
      });

      // The returned creation object provides unencrypted for convenience
      expect(created.key.webhookSecret).toBe(rawSecret);

      // Verify the key: returned key object should have decrypted secret
      const verified = await redisKeyStore.verifyApiKey(created.secretKey);
      expect(verified.valid).toBe(true);
      expect(verified.key?.webhookSecret).toBe(rawSecret);

      // Public API view never leaks the secret
      const publicView = toPublicApiKey(verified.key!);
      expect((publicView as Record<string, unknown>).webhookSecret).toBeUndefined();
      expect(publicView.hasWebhookSecret).toBe(true);
    });
  });

  describe('4. Zero-Downtime Key Rotation with Grace Period', () => {
    it('allows both old and new keys during grace period and rejects old key after expiration', async () => {
      const { key, secretKey: initialSecret } = await redisKeyStore.generateApiKey(
        testUser.id,
        'Rotatable Key',
        { scopes: ['convert:write'] }
      );

      // Rotate with a 2-second grace period
      const rotateReq = new NextRequest(`http://localhost/api/keys/${key.id}/rotate`, {
        method: 'POST',
        headers: {
          'x-api-key': adminSecretKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          gracePeriodSeconds: 2,
        }),
      });

      const rotateRes = await rotateKeyRoute(rotateReq, { params: Promise.resolve({ id: key.id }) });
      expect(rotateRes.status).toBe(200);
      const rotateJson = await rotateRes.json();
      expect(rotateJson.success).toBe(true);
      const newSecretKey = rotateJson.secretKey;
      expect(newSecretKey).toBeDefined();
      expect(newSecretKey).not.toBe(initialSecret);

      // 1. Immediately during grace period: BOTH old and new secrets authenticate
      const verifyOldDuringGrace = await redisKeyStore.verifyApiKey(initialSecret);
      expect(verifyOldDuringGrace.valid).toBe(true);
      expect(verifyOldDuringGrace.key?.id).toBe(key.id);

      const verifyNew = await redisKeyStore.verifyApiKey(newSecretKey);
      expect(verifyNew.valid).toBe(true);
      expect(verifyNew.key?.id).toBe(key.id);

      // 2. Advance clock past grace period
      const originalNow = Date.now;
      try {
        Date.now = () => rotateJson.graceExpiresAt + 1000;

        // Old key must now be rejected
        const verifyOldAfterGrace = await redisKeyStore.verifyApiKey(initialSecret);
        expect(verifyOldAfterGrace.valid).toBe(false);
        expect(verifyOldAfterGrace.error).toContain('Previous API key has expired following key rotation');

        // New key continues to work seamlessly
        const verifyNewAfterGrace = await redisKeyStore.verifyApiKey(newSecretKey);
        expect(verifyNewAfterGrace.valid).toBe(true);
      } finally {
        Date.now = originalNow;
      }
    });

    it('rejects rotation requests with negative or excessive grace period values', async () => {
      const req = new NextRequest(`http://localhost/api/keys/${adminKeyId}/rotate`, {
        method: 'POST',
        headers: {
          'x-api-key': adminSecretKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          gracePeriodSeconds: -50,
        }),
      });

      const res = await rotateKeyRoute(req, { params: Promise.resolve({ id: adminKeyId }) });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('gracePeriodSeconds must be a finite number between 0 and 604800');
    });
  });

  describe('5. Multi-Instance Revocation Synchronization via Redis', () => {
    it('synchronizes revocation immediately between distinct store instances connected to Redis', async () => {
      // Mock Redis client shared by instance A and instance B
      const memoryRedisMap = new Map<string, Record<string, string>>();
      const memoryHashMap = new Map<string, string>();
      const memorySetMap = new Map<string, Set<string>>();

      const mockRedisClient = {
        hset: vi.fn(async (key: string, fieldOrObj: any, val?: any) => {
          if (typeof fieldOrObj === 'object') {
            const current = memoryRedisMap.get(key) || {};
            memoryRedisMap.set(key, { ...current, ...fieldOrObj });
          } else {
            if (key.endsWith('apikey_hashes')) {
              memoryHashMap.set(fieldOrObj, val);
            } else {
              const current = memoryRedisMap.get(key) || {};
              current[fieldOrObj] = String(val);
              memoryRedisMap.set(key, current);
            }
          }
          return 1;
        }),
        hgetall: vi.fn(async (key: string) => {
          return memoryRedisMap.get(key) || {};
        }),
        hget: vi.fn(async (key: string, field: string) => {
          const obj = memoryRedisMap.get(key);
          return obj ? obj[field] ?? null : null;
        }),
        hexists: vi.fn(async (key: string, field: string) => {
          const obj = memoryRedisMap.get(key);
          return obj && field in obj ? 1 : 0;
        }),
        hmget: vi.fn(async (key: string, ...fields: string[]) => {
          return fields.map((f) => memoryHashMap.get(f) || null);
        }),
        sadd: vi.fn(async (key: string, member: string) => {
          let s = memorySetMap.get(key);
          if (!s) {
            s = new Set();
            memorySetMap.set(key, s);
          }
          s.add(member);
          return 1;
        }),
        smembers: vi.fn(async (key: string) => {
          const s = memorySetMap.get(key);
          return s ? Array.from(s) : [];
        }),
      } as any;

      // Instance A and Instance B are two separate server instances sharing the same Redis cluster
      const instanceA = new RedisKeyStore({ isolated: true, redisClient: mockRedisClient });
      const instanceB = new RedisKeyStore({ isolated: true, redisClient: mockRedisClient });

      // Instance A generates an API key
      const { key, secretKey } = await instanceA.generateApiKey(testUser.id, 'Shared Redis Key', {
        scopes: ['convert:write'],
      });

      // Instance B verifies the key (loading it from Redis hash index)
      const verifyOnB1 = await instanceB.verifyApiKey(secretKey);
      expect(verifyOnB1.valid).toBe(true);
      expect(verifyOnB1.key?.id).toBe(key.id);

      // Instance A revokes the key
      const revoked = await instanceA.revokeApiKey(testUser.id, key.id);
      expect(revoked).toBe(true);

      // Instance B immediately attempts to verify: MUST be rejected with revoked status without server reload
      const verifyOnB2 = await instanceB.verifyApiKey(secretKey);
      expect(verifyOnB2.valid).toBe(false);
      expect(verifyOnB2.error).toBe('API key has been revoked');
    });
  });
});
