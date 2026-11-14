import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: vi.fn(),
}));

import { fetch as undiciFetch } from 'undici';
import { NextRequest } from 'next/server';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import {
  RedisUserStore,
  UPDATE_USER_LUA_SCRIPT,
  RAISE_SESSION_VERSION_LUA,
} from '@/lib/auth/redis-user-store';
import { createSessionToken, getSessionFromToken, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { middleware } from '@/middleware';
import { POST as loginPost } from '@/app/api/auth/login/route';
import { hashPassword, verifyPassword } from '@/lib/auth/crypto';
import { recordFailedLogin, checkLoginRateLimit } from '@/lib/auth/login-rate-limiter';
import { SftpStorageAdapter } from '@/lib/storage/adapters/sftp';
import { StorageSizeLimitError } from '@/lib/storage/adapters/adapter-interface';
import { encryptSecret, decryptSecret } from '@/lib/api-keys/secret-encryption';
import { KeyStore, timingSafeHashMatch, apiKeyHashCandidates } from '@/lib/api-keys/key-store';
import { RedisKeyStore } from '@/lib/api-keys/redis-key-store';
import { sanitizeSvgString, decodeHtmlEntities } from '@/lib/security/svg-sanitizer';
import { resolveDeclaredFormat } from '@/lib/storage/declared-format';
import {
  sniffFixedSignature,
  ownSignatureVerdict,
  xmlRootElementName,
} from '@/lib/format-signatures';
import * as formatSignatures from '@/lib/format-signatures';
import { assertNotSpoofedFile } from '@/lib/security/file-guard';
import { isSsrfBlockedError } from '@/lib/security/ssrf';
import { POST as fetchUrlPost } from '@/app/api/fetch-url/route';
import { WebhookDispatcher } from '@/lib/api-keys/webhook-dispatcher';
import { RedisWebhookSecretStore } from '@/lib/api-keys/webhook-secret-store';
import {
  encodeFrame,
  FrameReader,
  isHelperFilePath,
} from '@/lib/security/sandbox-launcher-protocol';
import { GET as storageFileGet } from '@/app/api/storage/file/[...key]/route';
import { storageProvider } from '@/lib/storage';
import { POST as directUploadPost } from '@/app/api/v1/uploads/direct/route';
import { POST as tusUploadPost } from '@/app/api/v1/uploads/[[...id]]/route';
import { SharedObjectStore } from '@/lib/storage/shared-store';
import { eraseAccount, planAccountErasure } from '../scripts/erase-account';

describe('Batch 2 security adversarial hardening (RED -> GREEN)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  // S-1: Atomic session_version & user record synchronization
  describe('S-1: RedisUserStore atomic sessionVersion synchronization', () => {
    it('RAISE_SESSION_VERSION_LUA accepts user key + timestamp and atomically bumps both keys, preventing downgrade on stale updateUser', async () => {
      const store = new Map<string, string>();
      const baseUser = {
        id: 'user-s1',
        email: 's1@example.com',
        name: 'S1',
        passwordHash: 'hash',
        passwordSalt: 'salt',
        tier: 'free',
        sessionVersion: 3,
        createdAt: 1000,
        updatedAt: 1000,
      };
      const userKey = 'auth:{user}:user-s1';
      const versionKey = 'auth:{user}:session_version:user-s1';
      store.set(userKey, JSON.stringify(baseUser));
      store.set(versionKey, '2');

      const fakeRedis = {
        get: async (k: string) => store.get(k) ?? null,
        set: async (k: string, v: string) => {
          store.set(k, v);
          return 'OK';
        },
        del: async (...keys: string[]) => {
          let count = 0;
          for (const k of keys) {
            if (store.delete(k)) count++;
          }
          return count;
        },
        eval: async (script: string, numKeys: number, ...args: string[]) => {
          if (script === RAISE_SESSION_VERSION_LUA) {
            expect(numKeys).toBe(2);
            const [vKey, uKey] = args;
            const floor = Number(args[2]);
            const nowMs = Number(args[3]);
            const cur = Number(store.get(vKey) ?? 1);
            const rawUser = store.get(uKey);
            const user = rawUser ? JSON.parse(rawUser) : null;
            const userVer = user ? Number(user.sessionVersion ?? 1) : 1;
            const nextVer = Math.max(cur, floor, userVer) + 1;
            store.set(vKey, String(nextVer));
            if (user) {
              user.sessionVersion = nextVer;
              user.updatedAt = nowMs;
              store.set(uKey, JSON.stringify(user));
            }
            return nextVer;
          }
          if (script === UPDATE_USER_LUA_SCRIPT) {
            expect(numKeys).toBe(2);
            const [uKey, vKey] = args;
            const rawUser = store.get(uKey);
            if (!rawUser) return null;
            const user = JSON.parse(rawUser);
            const updates = JSON.parse(args[2]);
            for (const [k, v] of Object.entries(updates)) {
              user[k] = v;
            }
            const liveVer = Number(store.get(vKey) ?? 1);
            if (Number(user.sessionVersion ?? 1) < liveVer) {
              user.sessionVersion = liveVer;
            }
            user.updatedAt = Number(args[3]);
            const encoded = JSON.stringify(user);
            store.set(uKey, encoded);
            return encoded;
          }
          throw new Error('Unexpected Lua script');
        },
      };

      const userStore = new RedisUserStore({ redisClient: fakeRedis as any, keyPrefix: 'auth:{user}:' });
      const next = await userStore.incrementSessionVersion('user-s1');
      expect(next).toBe(4);
      expect(store.get(versionKey)).toBe('4');
      expect(JSON.parse(store.get(userKey)!).sessionVersion).toBe(4);

      // Simulate stale concurrent updateUser trying to write sessionVersion: 1
      await userStore.updateUser('user-s1', { sessionVersion: 1, name: 'Updated' });
      expect(JSON.parse(store.get(userKey)!).sessionVersion).toBe(4);
      expect(JSON.parse(store.get(userKey)!).name).toBe('Updated');
    });

    it('getSessionFromToken rejects stale token when live session_version counter exceeds stale userRecord.sessionVersion', async () => {
      vi.stubEnv('JWT_SECRET', 'test-jwt-secret-for-s1-verification-123456');
      vi.stubEnv('NODE_ENV', 'test');
      const authMod = await import('@/lib/auth/redis-user-store');
      vi.spyOn(authMod.redisUserStore, 'findById').mockResolvedValue({
        id: 'user-stale',
        email: 'stale@example.com',
        name: 'Stale',
        passwordHash: 'h',
        salt: 's',
        provider: 'email',
        tier: 'free',
        sessionVersion: 1, // stale cached field
        createdAt: 1000,
        updatedAt: 1000,
      });
      vi.spyOn(authMod.redisUserStore, 'getSessionVersion').mockResolvedValue(3);

      const token = createSessionToken({
        id: 'user-stale',
        email: 'stale@example.com',
        name: 'Stale',
        provider: 'email',
        tier: 'free',
        sessionVersion: 2, // greater than stale userRecord (1), less than live counter (3)
        createdAt: 1000,
        updatedAt: 1000,
      });
      const session = await getSessionFromToken(token);
      expect(session).toBeNull();
    });
  });

  // S-2 + Q-2: Unauthenticated browser cross-site POST guard + bounded edgeIpBuckets
  describe('S-2 + Q-2: middleware unauthenticated cross-site protection and bounded IP buckets', () => {
    it('rejects unauthenticated browser cross-site mutating request via Sec-Fetch-Site or disallowed Origin/Referer, while allowing CLI curl POST without those headers', async () => {
      // Cross-site Sec-Fetch-Site without cookie
      const crossSiteReq = new NextRequest('https://easyconvert.example/api/v1/convert', {
        method: 'POST',
        headers: {
          'sec-fetch-site': 'cross-site',
        },
      });
      const res1 = await middleware(crossSiteReq);
      expect(res1.status).toBe(403);
      const body1 = await res1.json();
      expect(body1.type).toBe('https://api.easyconvert.io/problems/forbidden');
      expect(body1.detail.toLowerCase()).toContain('cross-site');

      // Disallowed Origin without cookie
      const badOriginReq = new NextRequest('https://easyconvert.example/api/v1/convert', {
        method: 'POST',
        headers: {
          origin: 'https://evil.attacker',
        },
      });
      const res2 = await middleware(badOriginReq);
      expect(res2.status).toBe(403);

      // Missing Origin + disallowed Referer without cookie
      const badRefererReq = new NextRequest('https://easyconvert.example/api/v1/convert', {
        method: 'POST',
        headers: {
          referer: 'https://evil.attacker/form.html',
        },
      });
      const res3 = await middleware(badRefererReq);
      expect(res3.status).toBe(403);

      // Plain CLI request (no Origin, no Referer, no Sec-Fetch-Site, no cookie) should NOT trigger CSRF 403
      const cliReq = new NextRequest('https://easyconvert.example/api/v1/convert', {
        method: 'POST',
      });
      const res4 = await middleware(cliReq);
      expect(res4.status).not.toBe(403);
    });
  });

  // S-3: Max password length + atomic fixed-window login limiter + direct salt buffer
  describe('S-3: login DoS length bound, crypto buffer check, fixed-window Lua', () => {
    it('login route rejects passwords over 1024 characters with 401 without calling hashPassword verification bypass', async () => {
      const longPassword = 'A'.repeat(1025);
      const req = new NextRequest('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'nobody@example.com',
          password: longPassword,
        }),
      });
      const res = await loginPost(req);
      expect(res.status).toBe(401);
    });

    it('verifyPassword produces identical boolean match for valid and invalid passwords after buffer optimization', async () => {
      const { hash, salt } = await hashPassword('CorrectHorseBatteryStaple!');
      expect(await verifyPassword('CorrectHorseBatteryStaple!', hash, salt)).toBe(true);
      expect(await verifyPassword('WrongPassword!', hash, salt)).toBe(false);
    });

    it('recordFailedLogin uses atomic Lua fixed-window so TTL is not extended past initial window', async () => {
      const evalCalls: Array<{ keys: string[]; argv: string[] }> = [];
      const counts = new Map<string, number>();
      const ttls = new Map<string, number>();
      const fakeRedis = {
        eval: async (_script: string, numKeys: number, ...args: string[]) => {
          evalCalls.push({
            keys: args.slice(0, numKeys),
            argv: args.slice(numKeys),
          });
          const k = args[0];
          const win = Number(args[numKeys]);
          const next = (counts.get(k) ?? 0) + 1;
          counts.set(k, next);
          if (next === 1 || (ttls.get(k) ?? -2) < 0) {
            ttls.set(k, win);
          }
          return [next, ttls.get(k)!];
        },
        get: async (k: string) => (counts.has(k) ? String(counts.get(k)) : null),
        ttl: async (k: string) => ttls.get(k) ?? -2,
        del: async (k: string) => {
          counts.delete(k);
          ttls.delete(k);
          return 1;
        },
      };

      const authMod = await import('@/lib/auth/redis-user-store');
      vi.spyOn(authMod.redisUserStore, 'getRedisClient').mockReturnValue(fakeRedis as any);
      vi.spyOn(authMod.redisUserStore, 'getKeyPrefix').mockReturnValue('auth:');

      await recordFailedLogin('10.0.0.55', 'victim@example.com');
      expect(evalCalls.length).toBeGreaterThanOrEqual(2);
      const emailKey = 'auth:login_attempts:email:victim@example.com';
      ttls.set(emailKey, 42);
      await recordFailedLogin('10.0.0.55', 'victim@example.com');
      expect(ttls.get(emailKey)).toBe(42);
      const status = await checkLoginRateLimit('10.0.0.55', 'victim@example.com');
      expect(status.retryAfterSeconds).toBeLessThanOrEqual(42);
    });
  });

  // S-4b: SFTP uploadStream enforces SFTP_MAX_SPOOL_BYTES
  describe('S-4b: SftpStorageAdapter.uploadStream spool limit', () => {
    it('destroys oversized uploadStream, deletes partial spool file, and rejects before calling sftp batch', async () => {
      const adapter = new SftpStorageAdapter({
        type: 'sftp',
        host: 'example.com',
        username: 'tester',
        basePath: '/uploads',
        privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----',
      });
      vi.spyOn(adapter as any, 'resolveAllowedAddress').mockResolvedValue('93.184.216.34');
      const runBatchSpy = vi
        .spyOn(adapter as any, 'runSftpBatch')
        .mockResolvedValue('');

      let pushed = false;
      const bigStream = new Readable({
        read() {
          if (pushed) {
            this.push(null);
            return;
          }
          pushed = true;
          this.push(Buffer.alloc(3000, 0x41));
          this.push(Buffer.alloc(3000, 0x42));
        },
      });

      await expect(
        (adapter as any).uploadStream('oversize.bin', bigStream, { contentType: 'application/octet-stream', maxBytes: 4096 })
      ).rejects.toThrow(StorageSizeLimitError);
      expect(bigStream.destroyed).toBe(true);
      expect(runBatchSpy).not.toHaveBeenCalled();
    });
  });

  // S-5b + Q-7: AAD enc:v2:, key memoization invalidation on env change, timingSafeEqual, O(1) rotated key index
  describe('S-5b + Q-7: secret encryption AAD + rotated key O(1) lookup + timingSafeEqual', () => {
    it('supports AAD-bound enc:v2: encryption, preserves enc:v1: compatibility, and invalidates memoized keys when env changes', () => {
      vi.stubEnv('KEY_ENCRYPTION_KEY', 'env-key-alpha-1234567890');
      vi.stubEnv('NODE_ENV', 'test');

      const v1Cipher = encryptSecret('whsec_v1_secret');
      if (typeof v1Cipher !== 'string') throw new Error('Expected v1Cipher string');
      expect(v1Cipher.startsWith('enc:v1:')).toBe(true);
      expect(decryptSecret(v1Cipher)).toBe('whsec_v1_secret');

      const v2Cipher = encryptSecret('whsec_v2_secret', 'webhook:key-123');
      if (typeof v2Cipher !== 'string') throw new Error('Expected v2Cipher string');
      expect(v2Cipher.startsWith('enc:v2:')).toBe(true);
      expect(decryptSecret(v2Cipher, 'webhook:key-123')).toBe('whsec_v2_secret');
      expect(() => decryptSecret(v2Cipher, 'webhook:wrong-key')).toThrow();
      expect(() => decryptSecret(v2Cipher)).toThrow();

      // Rotate encryption key env: old ciphertext created with alpha must not decrypt under beta
      vi.stubEnv('KEY_ENCRYPTION_KEY', 'env-key-beta-0987654321');
      expect(() => decryptSecret(v2Cipher, 'webhook:key-123')).toThrow();
      const v2Beta = encryptSecret('whsec_beta', 'webhook:key-123');
      expect(decryptSecret(v2Beta, 'webhook:key-123')).toBe('whsec_beta');
    });

    it('KeyStore verifies previous rotated keys via O(1) lookup and RedisKeyStore uses constant-time hash comparison', async () => {
      vi.stubEnv('KEY_HASH_PEPPER', 'pepper-current-1234567890');
      vi.stubEnv('KEY_HASH_PEPPER_PREVIOUS', 'pepper-old-0987654321');
      const authMod = await import('@/lib/auth/redis-user-store');
      vi.spyOn(authMod.redisUserStore, 'findById').mockResolvedValue({
        id: 'user-q7',
        email: 'q7@example.com',
        name: 'Q7',
        provider: 'email',
        tier: 'free',
        emailVerified: true,
        passwordHash: 'h',
        salt: 's',
        sessionVersion: 1,
        createdAt: 1000,
        updatedAt: 1000,
      });
      const ks = new KeyStore(true);
      vi.spyOn(ks as any, 'mirrorsToDisk').mockReturnValue(false);
      const created = await ks.generateApiKey('user-q7', 'rotate-test');
      const rotated = await ks.rotateApiKey('user-q7', created.key.id, { gracePeriodSeconds: 60 });
      expect(rotated).not.toBeNull();

      // Old key still works within grace window without falling back to Map values scan
      const valuesSpy = vi.spyOn((ks as any).keys, 'values');
      const prevVerify = await ks.verifyApiKey(created.secretKey);
      expect(prevVerify.valid).toBe(true);
      expect(prevVerify.key?.id).toBe(created.key.id);
      const invalidVerify = await ks.verifyApiKey('ec_live_nonexistent_key_123456');
      expect(invalidVerify.valid).toBe(false);
      expect(valuesSpy).not.toHaveBeenCalled();

      // New key works
      const nextVerify = await ks.verifyApiKey(rotated!.newSecretKey);
      expect(nextVerify.valid).toBe(true);
      ks.resetStore();

      // Direct constant-time hash helper verification (matching length, last-char mismatch, length mismatch)
      const validHashes = apiKeyHashCandidates(rotated!.newSecretKey);
      expect(timingSafeHashMatch(validHashes.hashes, validHashes.currentHash)).toBe(true);
      const flippedEndHash =
        validHashes.currentHash.slice(0, -1) + (validHashes.currentHash.endsWith('0') ? '1' : '0');
      expect(timingSafeHashMatch(validHashes.hashes, flippedEndHash)).toBe(false);
      expect(timingSafeHashMatch(validHashes.hashes, validHashes.currentHash.slice(0, -2))).toBe(false);

      // End-to-end RedisKeyStore verification path using constant-time hash comparison
      let storedRecordJson = JSON.stringify(created.key);
      const fakeRedis = {
        get: async () => null,
        set: async () => 'OK',
        hmget: async () => [created.key.id],
        hgetall: async () => ({ data: storedRecordJson, status: 'active' }),
        hset: async () => 1,
        eval: async () => [0, 0],
      };
      const rks = new RedisKeyStore({ isolated: true, redisClient: fakeRedis as any });
      vi.spyOn(rks as any, 'mirrorsToDisk').mockReturnValue(false);
      const redisValid = await rks.verifyApiKey(created.secretKey);
      expect(redisValid.valid).toBe(true);
      expect(redisValid.key?.id).toBe(created.key.id);

      const tamperedEndHash =
        created.key.keyHash.slice(0, -1) + (created.key.keyHash.endsWith('0') ? '1' : '0');
      storedRecordJson = JSON.stringify({ ...created.key, keyHash: tamperedEndHash });
      const redisTampered = await rks.verifyApiKey(created.secretKey);
      expect(redisTampered.valid).toBe(false);
      rks.resetStore();
    });
  });

  // S-6: SVG sanitizer bypass vectors
  describe('S-6: SVG sanitizer entity, CSS escape, unquoted @import, root-relative href', () => {
    it('blocks encoded entities, CSS hex escapes in style, unquoted @import, and root-relative href without breaking CSS relative url(/...) or #fragment', () => {
      // Single-pass XML/HTML entity decoding: no recursive unescape, safe String.fromCodePoint
      expect(decodeHtmlEntities('&#38;#x6a;avascript:alert(1)')).toBe('&#x6a;avascript:alert(1)');
      expect(decodeHtmlEntities('&#x1f600;&#x110000;&#xD800;&#0;')).toBe('😀\uFFFD\uFFFD\uFFFD');

      const singleEncodedJs = `<svg xmlns="http://www.w3.org/2000/svg"><a href="&#x6a;avascript:alert(1)"><rect width="10" height="10"/></a></svg>`;
      expect(sanitizeSvgString(singleEncodedJs)).toBe(
        '<svg xmlns="http://www.w3.org/2000/svg"><a href="#"><rect width="10" height="10"/></a></svg>',
      );

      const doubleEncoded = `<svg xmlns="http://www.w3.org/2000/svg"><a href="&#38;#x6a;avascript:alert(1)"><rect width="10" height="10"/></a></svg>`;
      const outDouble = sanitizeSvgString(doubleEncoded);
      expect(outDouble.toLowerCase()).not.toContain('javascript:');

      const cssHexEscape = `<svg xmlns="http://www.w3.org/2000/svg"><rect style="background: \\75\\72\\6c(https://evil.test/x.png)" width="10" height="10"/></svg>`;
      expect(sanitizeSvgString(cssHexEscape)).toBe(
        '<svg xmlns="http://www.w3.org/2000/svg"><rect style="background: none" width="10" height="10"/></svg>',
      );

      const unquotedImport = `<svg xmlns="http://www.w3.org/2000/svg"><style>@import https://evil.test/steal.css; rect { fill: red; }</style><rect width="10" height="10"/></svg>`;
      expect(sanitizeSvgString(unquotedImport)).toBe(
        '<svg xmlns="http://www.w3.org/2000/svg"><style> rect { fill: red; }</style><rect width="10" height="10"/></svg>',
      );

      const rootHref = `<svg xmlns="http://www.w3.org/2000/svg"><use href="/internal/admin/delete"/><use href="#local-icon"/></svg>`;
      expect(sanitizeSvgString(rootHref)).toBe(
        '<svg xmlns="http://www.w3.org/2000/svg"><use href="#"/><use href="#local-icon"/></svg>',
      );

      // Preserves local CSS root-relative url(/...) already covered by tests
      const safeCssUrl = `<svg xmlns="http://www.w3.org/2000/svg"><style>.box { mask: url(/assets/mask.png); }</style></svg>`;
      expect(sanitizeSvgString(safeCssUrl)).toBe(safeCssUrl);
    });
  });

  // S-7 + Q-9: Mach-O blocking without Java .class false positive, quote-aware skipDoctype, O(1) MIME/signature lookups
  describe('S-7 + Q-9: format signatures, Mach-O blocking, quote-aware DOCTYPE, MIME lookup', () => {
    it('rejects Mach-O thin and Universal binaries in assertNotSpoofedFile while NOT misclassifying Java .class 0xCAFEBABE as Mach-O', () => {
      expect(typeof (formatSignatures as any).isMachO).toBe('function');

      const thinMachO = new Uint8Array(64);
      // 0xCFFAEDFE little-endian 64-bit Mach-O
      thinMachO.set([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01], 0);
      expect((formatSignatures as any).isMachO(thinMachO)).toBe(true);
      expect(() => assertNotSpoofedFile(thinMachO, 'png')).toThrow();

      // Universal Mach-O fat binary: 0xCAFEBABE, nfat_arch=2, cputype=0x01000007 (x86_64)
      const fatMachO = new Uint8Array(64);
      fatMachO.set([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x02, 0x01, 0x00, 0x00, 0x07], 0);
      expect((formatSignatures as any).isMachO(fatMachO)).toBe(true);
      expect(ownSignatureVerdict('pdf', fatMachO)).toBe(false);

      // Java .class file: 0xCAFEBABE, minor=0x0000, major=0x0041 (JDK 21 = 65 -> not 1..20 nfat_arch)
      const javaClass = new Uint8Array(64);
      javaClass.set([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x41, 0x00, 0x10, 0x0a, 0x00], 0);
      expect((formatSignatures as any).isMachO(javaClass)).toBe(false);
    });

    it('xmlRootElementName and assertNotSpoofedFile handle DOCTYPE with quoted > inside attribute literals and internal subset [...] cleanly', () => {
      const sample = Buffer.from(`<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://example.com/a>b" [ <!ENTITY x "c>d"> ]><!-- trailing > --><svg/>`);
      expect(xmlRootElementName(sample)).toBe('svg');
      expect(() => assertNotSpoofedFile(sample, 'svg')).not.toThrow();
    });

    it('resolveDeclaredFormat and sniffFixedSignature return accurate matches via O(1) lookups', () => {
      expect(resolveDeclaredFormat('x.unknown', 'image/png')).toBe('png');
      const pngMagic = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
      expect(sniffFixedSignature(pngMagic)).toBe('image/png');
    });
  });

  // S-8 + Q-8b: Deep cause chain SSRF detection + atomic webhook setPrimarySecret
  describe('S-8 + Q-8b: SSRF deep cause traversal + atomic webhook setPrimarySecret', () => {
    it('isSsrfBlockedError detects ESSRFBLOCKED wrapped in nested TypeError.cause and AggregateError.errors while surviving cycles', () => {
      const rootSsrf = Object.assign(
        new Error('SSRF blocked: host 169.254.169.254 is restricted'),
        { code: 'ESSRFBLOCKED' }
      );
      const wrapped = new TypeError('fetch failed', {
        cause: new AggregateError([new Error('other'), rootSsrf], 'multiple errors'),
      });
      expect(isSsrfBlockedError(wrapped)).toBe(true);

      const cycleA: any = new Error('cycle');
      cycleA.cause = cycleA;
      expect(isSsrfBlockedError(cycleA)).toBe(false);
    });

    it('fetch-url route and WebhookDispatcher treat wrapped ESSRFBLOCKED TypeError as SSRF refusal / immediate DLQ', async () => {
      vi.stubEnv('JWT_SECRET', 'test-ssrf-jwt-secret-1234567890');
      const token = createSessionToken({
        id: 'user-s8-route',
        email: 's8@example.com',
        name: 'S8',
        provider: 'email',
        tier: 'paid',
        sessionVersion: 1,
        createdAt: 1000,
        updatedAt: 1000,
      });
      const authMod = await import('@/lib/auth/redis-user-store');
      vi.spyOn(authMod.redisUserStore, 'findById').mockResolvedValue({
        id: 'user-s8-route',
        email: 's8@example.com',
        name: 'S8',
        provider: 'email',
        tier: 'paid',
        emailVerified: true,
        passwordHash: 'h',
        salt: 's',
        sessionVersion: 1,
        createdAt: 1000,
        updatedAt: 1000,
      });

      const ssrfErr = new TypeError('fetch failed', {
        cause: new AggregateError([
          Object.assign(new Error('SSRF blocked: resolved IP 127.0.0.1 is restricted'), {
            code: 'ESSRFBLOCKED',
          }),
        ]),
      });
      const undiciMod = await import('undici');
      vi.mocked(undiciMod.fetch).mockRejectedValueOnce(ssrfErr as any);

      const req = new NextRequest('http://localhost/api/fetch-url', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `${SESSION_COOKIE_NAME}=${token}`,
        },
        body: JSON.stringify({ url: 'https://93.184.216.34/public.txt' }),
      });
      const res = await fetchUrlPost(req);
      expect(res.status).toBe(403);
      const problem = await res.json();
      expect(problem.code).toBe('address_blocked');

      const dispatcher = new WebhookDispatcher();
      const origFetch = globalThis.fetch;
      vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(ssrfErr));
      try {
        const result = await (dispatcher as any).executeFetchAttempt(
          'https://93.184.216.34/hook',
          { 'content-type': 'application/json' },
          '{}',
          2000,
          1
        );
        expect(result.statusAction).toBe('dlq_immediate');
        expect(result.statusCode).toBe(403);
      } finally {
        vi.stubGlobal('fetch', origFetch);
      }
    });

    it('RedisWebhookSecretStore.setPrimarySecret preserves createdAt, previousEncrypted, and previousExpiresAt atomically via Lua', async () => {
      vi.stubEnv('WEBHOOK_SECRET_KEK', 'webhook-test-kek-1234567890');
      const kv = new Map<string, string>();
      const evalScripts: string[] = [];
      const existingRecord = {
        primaryEncrypted: 'enc:wh:v1:deadbeef',
        previousEncrypted: 'enc:wh:v1:cafebabe',
        previousExpiresAt: 9_999_999_999_999,
        createdAt: 123_456,
        rotatedAt: 200_000,
      };
      kv.set('webhook:sec:{user-q8}:target-1', JSON.stringify(existingRecord));

      const fakeRedis = {
        get: async (k: string) => kv.get(k) ?? null,
        set: async (k: string, v: string) => {
          kv.set(k, v);
          return 'OK';
        },
        del: async (k: string) => (kv.delete(k) ? 1 : 0),
        eval: async (
          script: string,
          _numKeys: number,
          key: string,
          primaryEncrypted: string,
          nowMs: string
        ) => {
          evalScripts.push(script);
          const curRaw = kv.get(key);
          const cur = curRaw ? JSON.parse(curRaw) : null;
          const nextRecord = {
            primaryEncrypted,
            ...(cur?.previousEncrypted !== undefined ? { previousEncrypted: cur.previousEncrypted } : {}),
            ...(cur?.previousExpiresAt !== undefined ? { previousExpiresAt: cur.previousExpiresAt } : {}),
            createdAt: cur?.createdAt ?? Number(nowMs),
            ...(cur?.rotatedAt !== undefined ? { rotatedAt: cur.rotatedAt } : {}),
          };
          const finalRaw = JSON.stringify(nextRecord);
          kv.set(key, finalRaw);
          return finalRaw;
        },
      };

      const store = new RedisWebhookSecretStore({ redisClient: fakeRedis as any });
      await store.setPrimarySecret('user-q8', 'target-1', 'whsec_new_primary');
      expect(evalScripts.length).toBe(1);
      const saved = JSON.parse(kv.get('webhook:sec:{user-q8}:target-1')!);
      expect(saved.createdAt).toBe(123_456);
      expect(saved.rotatedAt).toBe(200_000);
      expect(saved.previousExpiresAt).toBe(9_999_999_999_999);
      expect(saved.previousEncrypted).toBe(existingRecord.previousEncrypted);
    });
  });

  // S-9: Sandbox frame size caps
  describe('S-9: FrameReader / encodeFrame length caps', () => {
    it('rejects oversized payload/frame lengths before buffering huge payloads or allocating oversized buffers', () => {
      const reader = new FrameReader();
      // Header length valid (16 bytes), payload length exceeds MAX_FRAME_BYTES
      const badPayloadFrame = Buffer.alloc(8);
      badPayloadFrame.writeUInt32BE(16, 0);
      badPayloadFrame.writeUInt32BE(0x7fff_fff0, 4);
      expect(() => reader.push(badPayloadFrame)).toThrow(/frame|max|exceed|protocol/i);

      // Header + payload combined exceeding MAX_FRAME_BYTES with header > MAX_HEADER_BYTES also aborted
      const hugeCombo = Buffer.alloc(8);
      hugeCombo.writeUInt32BE(0x7fff_fff0, 0);
      hugeCombo.writeUInt32BE(0x7fff_fff0, 4);
      expect(() => reader.push(hugeCombo)).toThrow(/frame|max|exceed|protocol/i);

      expect(isHelperFilePath('/proc/123/fd/4', 123)).toBe(true);
      expect(isHelperFilePath('/proc/999/fd/4', 123)).toBe(false);
      expect(isHelperFilePath('/etc/passwd', 123)).toBe(false);
    });

    it('rejects oversized header or frame in encodeFrame before allocation', () => {
      const overHeader = {
        type: 'error' as const,
        id: 1,
        error: { kind: 'other' as const, message: 'x'.repeat(1024 * 1024 + 64) },
      };
      expect(() => encodeFrame(overHeader, Buffer.alloc(4))).toThrow(/header|frame|exceed|protocol/i);
    });
  });

  // S-10: Storage download zero-stat before owner check & upload size >= 1 validation
  describe('S-10: storage download ownership pre-stat check + upload totalSize >= 1', () => {
    it('never calls s3Storage.stat when caller does not own the requested storage key', async () => {
      vi.stubEnv('JWT_SECRET', 'test-s10-file-secret-1234567890');
      const otherToken = createSessionToken({
        id: 'attacker-s10',
        email: 'att@example.com',
        name: 'Attacker',
        provider: 'email',
        tier: 'free',
        sessionVersion: 1,
        createdAt: 1000,
        updatedAt: 1000,
      });
      const authMod = await import('@/lib/auth/redis-user-store');
      vi.spyOn(authMod.redisUserStore, 'findById').mockResolvedValue({
        id: 'attacker-s10',
        email: 'att@example.com',
        name: 'Attacker',
        provider: 'email',
        tier: 'free',
        emailVerified: true,
        passwordHash: 'h',
        salt: 's',
        sessionVersion: 1,
        createdAt: 1000,
        updatedAt: 1000,
      });

      const statSpy = vi.spyOn(storageProvider, 'stat');
      const req = new NextRequest('http://localhost/api/storage/file/conversions/victim-owner/secret.pdf', {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${otherToken}` },
      });
      const res = await storageFileGet(req, {
        params: Promise.resolve({ key: ['conversions', 'victim-owner', 'secret.pdf'] }),
      });
      expect(res.status).toBe(404);
      expect(statSpy).not.toHaveBeenCalled();
    });

    it('rejects totalSize=0 or non-integer on direct and multipart upload creation routes', async () => {
      vi.stubEnv('JWT_SECRET', 'test-upload-jwt-secret-1234567890');
      const token = createSessionToken({
        id: 'user-s10',
        email: 'u10@example.com',
        name: 'U10',
        provider: 'email',
        tier: 'paid',
        sessionVersion: 1,
        createdAt: 1000,
        updatedAt: 1000,
      });
      const authMod = await import('@/lib/auth/redis-user-store');
      vi.spyOn(authMod.redisUserStore, 'findById').mockResolvedValue({
        id: 'user-s10',
        email: 'u10@example.com',
        name: 'U10',
        provider: 'email',
        tier: 'paid',
        emailVerified: true,
        passwordHash: 'h',
        salt: 's',
        sessionVersion: 1,
        createdAt: 1000,
        updatedAt: 1000,
      });

      const directZero = new NextRequest('http://localhost/api/v1/uploads/direct', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `${SESSION_COOKIE_NAME}=${token}`,
        },
        body: JSON.stringify({
          filename: 'empty.txt',
          contentType: 'text/plain',
          totalSize: 0,
        }),
      });
      const rDirect = await directUploadPost(directZero);
      expect(rDirect.status).toBe(400);

      const multiZero = new NextRequest('http://localhost/api/v1/uploads', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `${SESSION_COOKIE_NAME}=${token}`,
        },
        body: JSON.stringify({
          filename: 'empty.txt',
          mimeType: 'text/plain',
          totalSize: 0,
        }),
      });
      const rMulti = await tusUploadPost(multiZero, { params: Promise.resolve({ id: [] }) });
      expect(rMulti.status).toBe(400);

      const multiFloat = new NextRequest('http://localhost/api/v1/uploads', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `${SESSION_COOKIE_NAME}=${token}`,
        },
        body: JSON.stringify({
          filename: 'float.txt',
          mimeType: 'text/plain',
          totalSize: 1.5,
        }),
      });
      const rFloat = await tusUploadPost(multiFloat, { params: Promise.resolve({ id: [] }) });
      expect(rFloat.status).toBe(400);
    });
  });

  // S-11: Local shared-store deleteByPrefix disk cleanup + eraseAccount completeness
  describe('S-11: SharedObjectStore.deleteByPrefix disk sweep & account erasure completeness', () => {
    it('SharedObjectStore.deleteByPrefix removes disk-backed objects with matching prefix even after in-memory cache is cleared', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ec-shared-s11-'));
      vi.stubEnv('EASYCONVERT_STORAGE_DIR', tmpDir);
      try {
        const writerStore = new SharedObjectStore();
        writerStore.set('conversions/u-disk/a.bin', {
          key: 'conversions/u-disk/a.bin',
          buffer: Buffer.from('secret-a'),
          filename: 'a.bin',
          mimeType: 'application/octet-stream',
          size: 8,
          etag: '"a"',
          uploadedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        });
        writerStore.set('conversions/other-user/b.bin', {
          key: 'conversions/other-user/b.bin',
          buffer: Buffer.from('keep-b'),
          filename: 'b.bin',
          mimeType: 'application/octet-stream',
          size: 6,
          etag: '"b"',
          uploadedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        });

        const coldStore = new SharedObjectStore();
        expect(typeof (coldStore as any).deleteByPrefix).toBe('function');
        const deleted = (coldStore as any).deleteByPrefix('conversions/u-disk/');
        expect(deleted).toBe(1);
        expect(coldStore.get('conversions/u-disk/a.bin')).toBeUndefined();
        expect(coldStore.get('conversions/other-user/b.bin')).toBeDefined();
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('eraseAccount removes upload-budget:{uploads:<userId>}, upload-completion/* owner receipts, and ended webhook jobs without calling global Redis SCAN', async () => {
      const userId = 'user-s11-erase';
      const scanSpy = vi.fn();
      const delCalls: string[][] = [];
      const redisEntries = new Map<string, string>([
        [`easyconvert:upload-budget:{uploads:${userId}}`, JSON.stringify({ day: '2026-11-14', bytes: 100, open: {} })],
        [`easyconvert:queue:{conversions}:user_inflight:${userId}`, '2'],
        [`easyconvert:usage:{${userId}}`, '1'],
      ]);

      const fakeClient = {
        scan: (...args: any[]) => {
          scanSpy(...args);
          return Promise.resolve(['0', []]);
        },
        exists: async (...keys: string[]) => keys.filter((k) => redisEntries.has(k)).length,
        del: async (...keys: string[]) => {
          delCalls.push(keys);
          let removed = 0;
          for (const k of keys) {
            if (redisEntries.delete(k)) removed++;
          }
          return removed;
        },
        pipeline: () => {
          const ops: Array<() => number> = [];
          const p: any = {
            exists: (k: string) => {
              ops.push(() => (redisEntries.has(k) ? 1 : 0));
              return p;
            },
            exec: async () => ops.map((fn) => [null, fn()]),
          };
          return p;
        },
      };

      const keyStoreMod = await import('@/lib/api-keys/redis-key-store');
      const userStoreMod = await import('@/lib/auth/redis-user-store');
      const retentionMod = await import('@/lib/storage/retention-ledger');
      const webhookMod = await import('@/lib/api-keys/webhook-dispatcher');

      vi.spyOn(keyStoreMod.redisKeyStore, 'getRedisClient').mockReturnValue(fakeClient as any);
      vi.spyOn(keyStoreMod.redisKeyStore, 'getPrefix' as any).mockReturnValue?.('easyconvert:');
      vi.spyOn(keyStoreMod.redisKeyStore, 'listApiKeys').mockResolvedValue([]);
      vi.spyOn(keyStoreMod.redisKeyStore, 'listUserFiles').mockResolvedValue([]);
      vi.spyOn(keyStoreMod.redisKeyStore, 'forgetUsage').mockResolvedValue(0);
      vi.spyOn(keyStoreMod.redisKeyStore, 'packageBalance').mockResolvedValue(0);
      vi.spyOn(userStoreMod.redisUserStore, 'findById').mockResolvedValue({
        id: userId,
        email: 's11@example.com',
        name: 'S11',
        provider: 'email',
        passwordHash: 'h',
        salt: 's',
        tier: 'free',
        sessionVersion: 1,
        createdAt: 1000,
        updatedAt: 1000,
      });
      vi.spyOn(userStoreMod.redisUserStore, 'incrementSessionVersion').mockResolvedValue(2);
      vi.spyOn(userStoreMod.redisUserStore, 'deleteUser').mockResolvedValue(true);

      const forgottenReceipts: string[] = [];
      const fakeLedger = {
        get: async (k: string) =>
          k === 'upload-completion/mine'
            ? { key: k, deleteAt: 0, received: [], completion: { ownerUserId: userId, key: 'conversions/x/a' } }
            : { key: k, deleteAt: 0, received: [], completion: { ownerUserId: 'other-user', key: 'conversions/y/b' } },
        allKeys: async () => ['upload-completion/mine', 'upload-completion/theirs'],
        liveRecords: async () => [],
        forget: async (k: string) => {
          forgottenReceipts.push(k);
        },
      };
      vi.spyOn(retentionMod, 'getRetentionLedger').mockReturnValue(fakeLedger as any);

      const removedWebhookJobIds: string[] = [];
      const fakeQueue = {
        getJobs: async (states: string[]) => {
          const all = [
            { id: 'wh-wait', state: 'waiting', data: { options: { ownerUserId: userId } } },
            { id: 'wh-done', state: 'completed', data: { options: { ownerUserId: userId } } },
            { id: 'wh-fail', state: 'failed', data: { options: { ownerUserId: userId } } },
          ];
          return all.filter((j) => states.includes(j.state));
        },
        remove: async (id: string) => {
          removedWebhookJobIds.push(id);
          return true;
        },
      };
      vi.spyOn(webhookMod.webhookDispatcher, 'getQueue').mockReturnValue(fakeQueue as any);
      vi.spyOn(webhookMod.webhookDispatcher, 'getDlqPage').mockResolvedValue({ entries: [], total: 0 } as any);
      vi.spyOn(webhookMod.webhookDispatcher, 'clearDlq').mockResolvedValue(undefined);

      const plan = await planAccountErasure(userId);
      expect(plan).toBeDefined();
      expect(scanSpy).not.toHaveBeenCalled();

      await eraseAccount(plan!, { drainMs: 0 });
      expect(forgottenReceipts).toContain('upload-completion/mine');
      expect(forgottenReceipts).not.toContain('upload-completion/theirs');
      expect(removedWebhookJobIds).toEqual(expect.arrayContaining(['wh-wait', 'wh-done', 'wh-fail']));
      expect(redisEntries.has(`easyconvert:upload-budget:{uploads:${userId}}`)).toBe(false);
      expect(redisEntries.has(`easyconvert:queue:{conversions}:user_inflight:${userId}`)).toBe(false);
    });

    it('erases queue-prefixed user_graphs, upload-budget-links index/entries, rejects 64-bit fat Mach-O, and prevents active webhook requeue after erasure', async () => {
      const { RedisBudgetStore } = await import('../src/lib/api-keys/upload-budget-store');
      const { endUploadReservation } = await import('../src/lib/api-keys/anonymous-upload-budget');
      const { isMachO } = await import('../src/lib/format-signatures');
      const { WebhookDispatcher } = await import('../src/lib/api-keys/webhook-dispatcher');

      // 64-bit Mach-O fat binary (0xCAFEBABF) with Apple CPU arm64 must be blocked
      const fat64 = Buffer.alloc(16);
      fat64.writeUInt32BE(0xcafebabf, 0);
      fat64.writeUInt32BE(2, 4);
      fat64.writeUInt32BE(0x0100000c, 8);
      expect(isMachO(fat64)).toBe(true);

      // RedisBudgetStore links/unlinks index set & link key cleanly
      const budgetStoreMap = new Map<string, string>();
      const budgetSets = new Map<string, Set<string>>();
      const mockBudgetRedis = {
        get: async (k: string) => budgetStoreMap.get(k) ?? null,
        set: async (k: string, v: string) => {
          budgetStoreMap.set(k, v);
          return 'OK';
        },
        del: async (...keys: string[]) => {
          let n = 0;
          for (const k of keys) if (budgetStoreMap.delete(k)) n++;
          return n;
        },
        sadd: async (k: string, ...members: string[]) => {
          const s = budgetSets.get(k) ?? new Set<string>();
          for (const m of members) s.add(m);
          budgetSets.set(k, s);
          return members.length;
        },
        srem: async (k: string, ...members: string[]) => {
          const s = budgetSets.get(k);
          if (!s) return 0;
          let n = 0;
          for (const m of members) if (s.delete(m)) n++;
          return n;
        },
        pexpire: async () => 1,
        eval: async () => 1,
      };
      const rbs = new RedisBudgetStore(mockBudgetRedis as never, 'easyconvert:');
      await rbs.link('signed-upload-1', { bucket: 'uploads:u-test', reservation: 'res-1', plan: 'free' }, Date.now() + 60_000);
      expect(budgetStoreMap.has('easyconvert:upload-budget-link:signed-upload-1')).toBe(true);
      expect(budgetSets.get('easyconvert:upload-budget-links:{uploads:u-test}')?.has('signed-upload-1')).toBe(true);
      await rbs.unlink('signed-upload-1', 'uploads:u-test');
      expect(budgetStoreMap.has('easyconvert:upload-budget-link:signed-upload-1')).toBe(false);
      expect(budgetSets.get('easyconvert:upload-budget-links:{uploads:u-test}')?.has('signed-upload-1')).toBe(false);
      expect(typeof endUploadReservation).toBe('function');

      // queue-prefixed user_graphs and upload-budget-links are removed on eraseAccount
      const userMod = await import('../src/lib/auth/redis-user-store');
      const keysMod = await import('../src/lib/api-keys/redis-key-store');
      const graphMod = await import('../src/lib/queue/graph/scheduler');
      const qMod = await import('../src/lib/queue/conversion-queue');
      const tusMod = await import('../src/lib/storage/tus-engine');
      const vaultMod = await import('../src/lib/storage/credentials-vault');
      const retentionMod = await import('../src/lib/storage/retention-ledger');
      const webhookMod = await import('../src/lib/api-keys/webhook-dispatcher');

      const userId = 'u-rev-fixes';
      const deletedKeys = new Set<string>();
      const redisEntries = new Map<string, string>([
        [`easyconvert:queue:user_graphs:{${userId}}`, '1'],
        [`easyconvert:upload-budget:{uploads:${userId}}`, JSON.stringify({ day: '2026-11-14', bytes: 0, open: { 'res-2': { bytes: 10, idleUntil: 9999999999999, expiresAt: 9999999999999, uploadId: 'tok-open-2' } } })],
        ['easyconvert:upload-budget-link:tok-open-2', '1'],
        ['easyconvert:upload-budget-link:tok-done-3', '1'],
      ]);
      const redisSets = new Map<string, Set<string>>([
        [`easyconvert:upload-budget-links:{uploads:${userId}}`, new Set(['tok-open-2', 'tok-done-3'])],
      ]);

      vi.spyOn(userMod.redisUserStore, 'findById').mockResolvedValue({ id: userId, email: 'rev@example.com' } as any);
      vi.spyOn(userMod.redisUserStore, 'incrementSessionVersion').mockResolvedValue(2 as any);
      vi.spyOn(userMod.redisUserStore, 'deleteUser').mockResolvedValue(true);
      vi.spyOn(userMod.redisUserStore, 'getRedisClient').mockReturnValue(null);
      vi.spyOn(keysMod.redisKeyStore, 'listApiKeys').mockResolvedValue([]);
      vi.spyOn(keysMod.redisKeyStore, 'packageBalance').mockResolvedValue(0);
      vi.spyOn(keysMod.redisKeyStore, 'listUserFiles').mockResolvedValue([]);
      vi.spyOn(keysMod.redisKeyStore, 'forgetUsage').mockResolvedValue(0);
      vi.spyOn(keysMod.redisKeyStore, 'getPrefix').mockReturnValue('easyconvert:');
      vi.spyOn(keysMod.redisKeyStore, 'getRedisClient').mockReturnValue({
        get: async (k: string) => redisEntries.get(k) ?? null,
        smembers: async (k: string) => [...(redisSets.get(k) ?? [])],
        zrange: async () => [],
        exists: async (k: string) => (redisEntries.has(k) || redisSets.has(k) ? 1 : 0),
        del: async (...keys: string[]) => {
          for (const k of keys) {
            deletedKeys.add(k);
            redisEntries.delete(k);
            redisSets.delete(k);
          }
          return keys.length;
        },
        scan: vi.fn(),
      } as any);
      vi.spyOn(graphMod.graphScheduler, 'graphsOfUser').mockResolvedValue([]);
      vi.spyOn(qMod.conversionQueue, 'getJobsByUser').mockResolvedValue([]);
      vi.spyOn(tusMod.tusEngine, 'sessionsOfOwner').mockResolvedValue([]);
      vi.spyOn(tusMod.tusEngine, 'terminateSessionsOfOwner').mockResolvedValue(undefined as any);
      vi.spyOn(vaultMod.credentialsVault, 'listByUser').mockResolvedValue([]);
      vi.spyOn(retentionMod, 'getRetentionLedger').mockReturnValue({
        allKeys: async () => [],
        liveRecords: async () => [],
        get: async () => undefined,
        forget: async () => undefined,
      } as any);
      vi.spyOn(webhookMod.webhookDispatcher, 'getQueue').mockReturnValue({ getJobs: async () => [], remove: async () => true } as any);
      vi.spyOn(webhookMod.webhookDispatcher, 'getDlqPage').mockResolvedValue({ entries: [], total: 0 } as any);
      vi.spyOn(webhookMod.webhookDispatcher, 'clearDlq').mockResolvedValue(undefined);

      const plan = await planAccountErasure(userId);
      await eraseAccount(plan!, { drainMs: 0 });
      expect(deletedKeys.has(`easyconvert:queue:user_graphs:{${userId}}`)).toBe(true);
      expect(deletedKeys.has('easyconvert:upload-budget-link:tok-open-2')).toBe(true);
      expect(deletedKeys.has('easyconvert:upload-budget-link:tok-done-3')).toBe(true);
      expect(deletedKeys.has(`easyconvert:upload-budget-links:{uploads:${userId}}`)).toBe(true);

      // Active webhook delivery fails after user erasure -> must NOT save to DLQ or enqueue delayed retry
      const dispatcher = new WebhookDispatcher();
      const addSpy = vi.fn();
      vi.spyOn(dispatcher, 'getQueue').mockReturnValue({ add: addSpy } as any);
      vi.spyOn(dispatcher, 'dispatch').mockResolvedValue({
        id: 'del-1',
        url: 'https://example.com/hook',
        event: 'job.failed',
        success: false,
        finalStatusCode: 500,
        totalAttempts: 1,
        durationMs: 10,
        attempts: [{ attemptNumber: 1, error: 'upstream 500' }],
      } as any);
      // First check before dispatch sees owner alive; subsequent checks during failure handling see owner erased
      const findSpy = vi.spyOn(userMod.redisUserStore, 'findById');
      findSpy.mockResolvedValueOnce({ id: userId } as any).mockResolvedValue(null);
      const { sealWebhookSecret } = await import('../src/lib/security/sealed-webhook-secret');
      await (dispatcher as any).processQueuedJob({
        data: {
          deliveryId: 'del-1',
          targetUrl: 'https://example.com/hook',
          event: 'job.failed',
          data: {},
          secret: sealWebhookSecret('whsec_test_secret_value', 'del-1'),
          options: { ownerUserId: userId, ownerKeyId: 'k1', maxRetries: 6 },
          attemptNumber: 1,
          attempts: [],
          createdAt: Date.now(),
        },
      });
      expect(addSpy).not.toHaveBeenCalled();
    });
  });
});
