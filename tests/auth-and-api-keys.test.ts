import { describe, it, expect, beforeEach } from 'vitest';
import { hashPassword, verifyPassword, sha256 } from '../src/lib/auth/crypto';
import { signJwt, verifyJwt } from '../src/lib/auth/jwt';
import { userStore } from '../src/lib/auth/user-store';
import { createSessionToken, createSessionCookie, clearSessionCookie, getSessionFromRequest } from '../src/lib/auth/session';
import { generateOAuthState, validateOAuthState, getGoogleOAuthUrl, exchangeGoogleCode } from '../src/lib/auth/oauth';
import { keyStore, TIER_LIMITS } from '../src/lib/api-keys/key-store';
import { validateApiAccess } from '../src/lib/api-keys/guard';
import { POST as registerHandler } from '../src/app/api/auth/register/route';
import { POST as loginHandler } from '../src/app/api/auth/login/route';
import { GET as meHandler } from '../src/app/api/auth/me/route';
import { POST as logoutHandler } from '../src/app/api/auth/logout/route';
import { GET as keysGetHandler, POST as keysPostHandler } from '../src/app/api/keys/route';
import { DELETE as keyDeleteHandler } from '../src/app/api/keys/[id]/route';
import { GET as usageGetHandler } from '../src/app/api/keys/usage/route';
import { GET as filesGetHandler } from '../src/app/api/account/files/route';
import { DELETE as fileDeleteHandler } from '../src/app/api/account/files/[id]/route';
import { POST as v1ConvertHandler } from '../src/app/api/v1/convert/route';
import { GET as googleCallbackHandler } from '../src/app/api/auth/google/callback/route';
import { GET as googleUrlHandler } from '../src/app/api/auth/google/url/route';
import { NextRequest } from 'next/server';

describe('Auth & API Key Infrastructure', () => {
  beforeEach(() => {
    userStore.resetStore();
    keyStore.resetStore();
  });

  describe('Password Hashing & PBKDF2 Crypto', () => {
    it('generates secure hash and salt, verifying correctly', async () => {
      const password = 'SuperSecretPassword123!';
      const { hash, salt } = await hashPassword(password);

      expect(hash).toBeDefined();
      expect(salt).toBeDefined();
      expect(hash.length).toBeGreaterThan(64);

      const isValid = await verifyPassword(password, hash, salt);
      expect(isValid).toBe(true);

      const isWrong = await verifyPassword('WrongPassword123!', hash, salt);
      expect(isWrong).toBe(false);
    });

    it('rejects empty or corrupt parameters safely without crashing', async () => {
      expect(await verifyPassword('', 'hash', 'salt')).toBe(false);
      expect(await verifyPassword('test', '', 'salt')).toBe(false);
      expect(await verifyPassword('test', 'hash', '')).toBe(false);
      await expect(hashPassword('')).rejects.toThrow();
    });
  });

  describe('RFC 7519 JSON Web Token (HS256)', () => {
    it('signs and verifies JWT payloads correctly', () => {
      const payload = { sub: 'user-123', email: 'test@example.com', tier: 'free' };
      const token = signJwt(payload, 'test-secret', 3600);

      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);

      const decoded = verifyJwt<typeof payload>(token, 'test-secret');
      expect(decoded).not.toBeNull();
      expect(decoded?.sub).toBe('user-123');
      expect(decoded?.email).toBe('test@example.com');
    });

    it('rejects tampered or forged JWT tokens', () => {
      const token = signJwt({ sub: 'admin' }, 'secret-a', 3600);
      const decodedWrongSecret = verifyJwt(token, 'secret-b');
      expect(decodedWrongSecret).toBeNull();

      // Tamper with payload
      const parts = token.split('.');
      const tamperedToken = `${parts[0]}.${Buffer.from('{"sub":"hacker"}').toString('base64url')}.${parts[2]}`;
      expect(verifyJwt(tamperedToken, 'secret-a')).toBeNull();
    });

    it('rejects expired tokens', () => {
      const token = signJwt({ sub: 'user-old' }, 'secret', -10); // already expired 10s ago
      expect(verifyJwt(token, 'secret')).toBeNull();
    });
  });

  describe('User Store Repository', () => {
    it('creates, indexes, and finds users by email case-insensitively', async () => {
      const user = await userStore.createUser({
        email: 'Alice@Example.COM',
        name: 'Alice Developer',
        tier: 'free',
      });

      expect(user.id).toBeDefined();
      expect(user.email).toBe('alice@example.com');

      const found = await userStore.findByEmail('ALICE@example.com');
      expect(found).not.toBeNull();
      expect(found?.id).toBe(user.id);
      expect(found?.name).toBe('Alice Developer');

      const foundById = await userStore.findById(user.id);
      expect(foundById?.email).toBe('alice@example.com');
    });

    it('enforces email uniqueness on registration', async () => {
      await userStore.createUser({
        email: 'bob@example.com',
        name: 'Bob',
      });

      await expect(
        userStore.createUser({
          email: 'BOB@example.com',
          name: 'Bob Duplicate',
        })
      ).rejects.toThrow(/already exists/i);
    });

    it('sanitizes user records by stripping password hashes', async () => {
      const userRecord = await userStore.createUser({
        email: 'carol@example.com',
        name: 'Carol',
        passwordHash: 'secret-hash',
        salt: 'secret-salt',
      });

      const sanitized = userStore.sanitizeUser(userRecord);
      expect((sanitized as any).passwordHash).toBeUndefined();
      expect((sanitized as any).salt).toBeUndefined();
      expect(sanitized.email).toBe('carol@example.com');
    });
  });

  describe('Session Cookie & Request Authentication Extraction', () => {
    it('creates valid session cookie header string', () => {
      const cookie = createSessionCookie('test-token');
      expect(cookie).toContain('easyconvert_session=test-token');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Path=/');
    });

    it('clears session cookie on logout', () => {
      const clearCookie = clearSessionCookie();
      expect(clearCookie).toContain('Max-Age=0');
    });

    it('extracts user from cookie in Request', async () => {
      const userRecord = await userStore.createUser({
        email: 'dave@example.com',
        name: 'Dave',
      });
      const user = userStore.sanitizeUser(userRecord);
      const token = createSessionToken(user);

      const reqWithCookie = new Request('http://localhost:3000/api/auth/me', {
        headers: {
          Cookie: `other_cookie=xyz; easyconvert_session=${token}; another=1`,
        },
      });

      const extracted = await getSessionFromRequest(reqWithCookie);
      expect(extracted).not.toBeNull();
      expect(extracted?.id).toBe(user.id);
      expect(extracted?.email).toBe('dave@example.com');
    });

    it('extracts user from Authorization: Bearer <jwt> header', async () => {
      const userRecord = await userStore.createUser({
        email: 'eve@example.com',
        name: 'Eve',
      });
      const user = userStore.sanitizeUser(userRecord);
      const token = createSessionToken(user);

      const reqWithBearer = new Request('http://localhost:3000/api/auth/me', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const extracted = await getSessionFromRequest(reqWithBearer);
      expect(extracted).not.toBeNull();
      expect(extracted?.id).toBe(user.id);
    });
  });

  describe('RFC 6749 OAuth 2.0 & State Management', () => {
    it('generates cryptographic state and validates once', () => {
      const state = generateOAuthState();
      expect(state).toHaveLength(48);

      const validFirst = validateOAuthState(state);
      expect(validFirst).toBe(true);

      // Second check fails (state consumed)
      const validSecond = validateOAuthState(state);
      expect(validSecond).toBe(false);
    });

    it('generates mock sandbox OAuth URL when credentials are not configured', () => {
      delete process.env.GOOGLE_CLIENT_ID;
      const url = getGoogleOAuthUrl('http://localhost:3000/api/auth/google/callback');

      expect(url).toContain('/api/auth/google/callback');
      expect(url).toContain('code=mock_code_');
      expect(url).toContain('mock=true');
    });

    it('exchanges mock code in sandbox mode returning developer profile', async () => {
      const profile = await exchangeGoogleCode('mock_code_abc', 'http://localhost:3000/api/auth/google/callback');
      expect(profile.email).toBe('dev.sandbox@example.com');
      expect(profile.name).toBe('Sandbox Developer');
    });
  });

  describe('API Key Lifecycle & Quota Management', () => {
    it('generates key with ec_live_ prefix and saves only the sha256 hash', async () => {
      const userRecord = await userStore.createUser({
        email: 'dev@example.com',
        name: 'Dev User',
      });

      const { key, secretKey } = await keyStore.generateApiKey(userRecord.id, 'My Test Key');
      expect(secretKey.startsWith('ec_live_')).toBe(true);
      expect(key.name).toBe('My Test Key');
      expect(key.status).toBe('active');
      expect(key.keyHash).toBe(sha256(secretKey));

      const verification = await keyStore.verifyApiKey(secretKey);
      expect(verification.valid).toBe(true);
      expect(verification.user?.id).toBe(userRecord.id);
      expect(verification.key?.id).toBe(key.id);
    });

    it('rejects revoked API keys immediately', async () => {
      const userRecord = await userStore.createUser({
        email: 'revoker@example.com',
        name: 'Revoker',
      });

      const { key, secretKey } = await keyStore.generateApiKey(userRecord.id, 'Temporary Key');
      const revoked = await keyStore.revokeApiKey(userRecord.id, key.id);
      expect(revoked).toBe(true);

      const verification = await keyStore.verifyApiKey(secretKey);
      expect(verification.valid).toBe(false);
    });

    it('enforces tier limits and records daily usage correctly', async () => {
      const userRecord = await userStore.createUser({
        email: 'quota-tester@example.com',
        name: 'Quota Tester',
        tier: 'free',
      });

      const initialQuota = await keyStore.getQuotaUsage(userRecord.id);
      expect(initialQuota.dailyLimit).toBe(TIER_LIMITS.free);
      expect(initialQuota.usedToday).toBe(0);
      expect(initialQuota.remaining).toBe(TIER_LIMITS.free);

      // Record 10 conversions
      const step1 = await keyStore.recordUsage(userRecord.id, 10);
      expect(step1.allowed).toBe(true);
      expect(step1.remaining).toBe(15);

      // Record 15 more conversions (reaches limit 25)
      const step2 = await keyStore.recordUsage(userRecord.id, 15);
      expect(step2.allowed).toBe(true);
      expect(step2.remaining).toBe(0);

      // Exceed quota
      const step3 = await keyStore.recordUsage(userRecord.id, 1);
      expect(step3.allowed).toBe(false);
      expect(step3.remaining).toBe(0);
    });

    it('records and lists user conversion files with 1-hour expiration', async () => {
      const userRecord = await userStore.createUser({
        email: 'file-owner@example.com',
        name: 'File Owner',
      });

      const file = await keyStore.recordUserFile({
        userId: userRecord.id,
        fileName: 'report.pdf',
        fromFormat: 'docx',
        toFormat: 'pdf',
        size: 10240,
        downloadUrl: 'data:application/pdf;base64,JVBERi0xLjc...',
      });

      expect(file.id).toBeDefined();
      expect(file.expiresAt).toBeGreaterThan(Date.now() + 3500 * 1000);

      const files = await keyStore.listUserFiles(userRecord.id);
      expect(files).toHaveLength(1);
      expect(files[0].fileName).toBe('report.pdf');

      const deleted = await keyStore.deleteUserFile(userRecord.id, file.id);
      expect(deleted).toBe(true);

      const filesAfterDelete = await keyStore.listUserFiles(userRecord.id);
      expect(filesAfterDelete).toHaveLength(0);
    });
  });

  describe('End-to-End API Route Handlers', () => {
    it('registers user, issues session cookie, and permits login', async () => {
      // 1. Register
      const regReq = new NextRequest('http://localhost:3000/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          email: 'fullstack@example.com',
          password: 'Password999!',
          name: 'Full Stack',
        }),
      });

      const regRes = await registerHandler(regReq);
      expect(regRes.status).toBe(200);
      const regData = await regRes.json();
      expect(regData.success).toBe(true);
      expect(regData.user.email).toBe('fullstack@example.com');
      const setCookie = regRes.headers.get('set-cookie');
      expect(setCookie).toContain('easyconvert_session');

      // 2. Duplicate registration fails with 409
      const dupReq = new NextRequest('http://localhost:3000/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          email: 'fullstack@example.com',
          password: 'Password999!',
          name: 'Full Stack',
        }),
      });
      const dupRes = await registerHandler(dupReq);
      expect(dupRes.status).toBe(409);

      // 3. Login with wrong password fails with 401
      const wrongLoginReq = new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: 'fullstack@example.com',
          password: 'WrongPassword!',
        }),
      });
      const wrongRes = await loginHandler(wrongLoginReq);
      expect(wrongRes.status).toBe(401);

      // 4. Login with correct password succeeds
      const loginReq = new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: 'fullstack@example.com',
          password: 'Password999!',
        }),
      });
      const loginRes = await loginHandler(loginReq);
      expect(loginRes.status).toBe(200);
      const loginData = await loginRes.json();
      expect(loginData.success).toBe(true);

      // 5. Test /api/auth/me
      const token = loginData.token;
      const meReq = new NextRequest('http://localhost:3000/api/auth/me', {
        headers: {
          Cookie: `easyconvert_session=${token}`,
        },
      });
      const meRes = await meHandler(meReq);
      expect(meRes.status).toBe(200);
      const meData = await meRes.json();
      expect(meData.user.email).toBe('fullstack@example.com');

      // 6. Test logout
      const logoutRes = await logoutHandler();
      expect(logoutRes.status).toBe(200);
      expect(logoutRes.headers.get('set-cookie')).toContain('Max-Age=0');
    });

    it('manages API keys, checks usage, and revokes keys via REST endpoints', async () => {
      // Create user and token
      const user = userStore.sanitizeUser(
        await userStore.createUser({
          email: 'api-dev@example.com',
          name: 'API Dev',
        })
      );
      const token = createSessionToken(user);
      const cookieHeader = `easyconvert_session=${token}`;

      // 1. Create API key
      const postKeyReq = new NextRequest('http://localhost:3000/api/keys', {
        method: 'POST',
        headers: { Cookie: cookieHeader },
        body: JSON.stringify({ name: 'CI/CD Pipeline Key' }),
      });
      const postKeyRes = await keysPostHandler(postKeyReq);
      expect(postKeyRes.status).toBe(200);
      const keyData = await postKeyRes.json();
      expect(keyData.success).toBe(true);
      expect(keyData.secretKey.startsWith('ec_live_')).toBe(true);

      const generatedKeyId = keyData.key.id;

      // 2. List API keys
      const getKeysReq = new NextRequest('http://localhost:3000/api/keys', {
        headers: { Cookie: cookieHeader },
      });
      const getKeysRes = await keysGetHandler(getKeysReq);
      const listData = await getKeysRes.json();
      expect(listData.keys).toHaveLength(1);
      expect(listData.keys[0].name).toBe('CI/CD Pipeline Key');

      // 3. Check Usage endpoint
      const usageReq = new NextRequest('http://localhost:3000/api/keys/usage', {
        headers: { Cookie: cookieHeader },
      });
      const usageRes = await usageGetHandler(usageReq);
      const usageData = await usageRes.json();
      expect(usageData.usage.dailyLimit).toBe(25);
      expect(usageData.usage.remaining).toBe(25);

      // 4. Revoke key
      const deleteKeyReq = new NextRequest(`http://localhost:3000/api/keys/${generatedKeyId}`, {
        method: 'DELETE',
        headers: { Cookie: cookieHeader },
      });
      const deleteKeyRes = await keyDeleteHandler(deleteKeyReq, { params: Promise.resolve({ id: generatedKeyId }) });
      expect(deleteKeyRes.status).toBe(200);

      // List again and check status is revoked
      const getKeysRes2 = await keysGetHandler(getKeysReq);
      const listData2 = await getKeysRes2.json();
      expect(listData2.keys[0].status).toBe('revoked');
    });

    it('processes programmatic file conversion via /api/v1/convert using API Key', async () => {
      // Create user and key
      const user = userStore.sanitizeUser(
        await userStore.createUser({
          email: 'programmer@example.com',
          name: 'Programmer',
        })
      );
      const { secretKey } = await keyStore.generateApiKey(user.id, 'Conversion Key');

      // Prepare sample CSV payload for JSON conversion
      const csvContent = 'name,role,level\nAlice,Engineer,Senior\nBob,Designer,Staff';
      const file = new File([csvContent], 'team.csv', { type: 'text/csv' });

      const formData = new FormData();
      formData.append('file', file);
      formData.append('targetFormat', 'json');

      const convertReq = new NextRequest('http://localhost:3000/api/v1/convert', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secretKey}`,
        },
        body: formData,
      });

      const convertRes = await v1ConvertHandler(convertReq);
      expect(convertRes.status).toBe(200);
      const convertData = await convertRes.json();
      expect(convertData.success).toBe(true);
      expect(convertData.fileName).toBe('team.json');
      expect(convertData.sourceFormat).toBe('csv');
      expect(convertData.targetFormat).toBe('json');
      expect(convertData.dataUri).toContain('data:application/json;base64,');

      // Verify quota was decremented
      const quota = await keyStore.getQuotaUsage(user.id);
      expect(quota.usedToday).toBe(1);
      expect(quota.remaining).toBe(24);

      // Verify file was recorded in user conversion files
      const userFiles = await keyStore.listUserFiles(user.id);
      expect(userFiles).toHaveLength(1);
      expect(userFiles[0].fileName).toBe('team.json');

      // Test user files endpoint
      const token = createSessionToken(user);
      const filesReq = new NextRequest('http://localhost:3000/api/account/files', {
        headers: { Cookie: `easyconvert_session=${token}` },
      });
      const filesRes = await filesGetHandler(filesReq);
      const filesData = await filesRes.json();
      expect(filesData.files).toHaveLength(1);
      expect(filesData.files[0].remainingSeconds).toBeGreaterThan(3500);

      // Test delete user file endpoint
      const fileId = userFiles[0].id;
      const deleteFileReq = new NextRequest(`http://localhost:3000/api/account/files/${fileId}`, {
        method: 'DELETE',
        headers: { Cookie: `easyconvert_session=${token}` },
      });
      const deleteRes = await fileDeleteHandler(deleteFileReq, { params: Promise.resolve({ id: fileId }) });
      expect(deleteRes.status).toBe(200);

      const filesResAfter = await filesGetHandler(filesReq);
      const filesDataAfter = await filesResAfter.json();
      expect(filesDataAfter.files).toHaveLength(0);
    });

    it('enforces 429 quota exhaustion on /api/v1/convert when daily limit is reached', async () => {
      const user = userStore.sanitizeUser(
        await userStore.createUser({
          email: 'heavy-user@example.com',
          name: 'Heavy User',
          tier: 'free',
        })
      );
      const { secretKey } = await keyStore.generateApiKey(user.id, 'Batch Key');

      // Exhaust quota manually
      await keyStore.recordUsage(user.id, 25);

      const file = new File(['1,2,3'], 'numbers.csv', { type: 'text/csv' });
      const formData = new FormData();
      formData.append('file', file);
      formData.append('targetFormat', 'json');

      const convertReq = new NextRequest('http://localhost:3000/api/v1/convert', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secretKey}`,
        },
        body: formData,
      });

      const convertRes = await v1ConvertHandler(convertReq);
      expect(convertRes.status).toBe(429);
      const errData = await convertRes.json();
      expect(errData.error).toContain('quota exceeded');
    });

    it('returns raw binary stream on /api/v1/convert when raw=true is requested', async () => {
      const user = userStore.sanitizeUser(
        await userStore.createUser({
          email: 'binary-dev@example.com',
          name: 'Binary Dev',
        })
      );
      const { secretKey } = await keyStore.generateApiKey(user.id, 'Binary Key');

      const csvContent = 'a,b\n1,2';
      const file = new File([csvContent], 'test.csv', { type: 'text/csv' });
      const formData = new FormData();
      formData.append('file', file);
      formData.append('targetFormat', 'json');

      const rawReq = new NextRequest('http://localhost:3000/api/v1/convert?raw=true', {
        method: 'POST',
        headers: {
          'x-api-key': secretKey,
        },
        body: formData,
      });

      const rawRes = await v1ConvertHandler(rawReq);
      expect(rawRes.status).toBe(200);
      expect(rawRes.headers.get('content-type')).toContain('application/json');
      expect(rawRes.headers.get('content-disposition')).toContain('attachment');
      const text = await rawRes.text();
      expect(text).toContain('"a"');
    });

    it('handles validation failures in /api/v1/convert safely', async () => {
      const user = userStore.sanitizeUser(
        await userStore.createUser({
          email: 'validator@example.com',
          name: 'Validator',
        })
      );
      const { secretKey } = await keyStore.generateApiKey(user.id, 'Validation Key');

      // 1. Missing file
      const emptyForm = new FormData();
      emptyForm.append('targetFormat', 'json');
      const req1 = new NextRequest('http://localhost:3000/api/v1/convert', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secretKey}` },
        body: emptyForm,
      });
      const res1 = await v1ConvertHandler(req1);
      expect(res1.status).toBe(400);

      // 2. Missing targetFormat
      const form2 = new FormData();
      form2.append('file', new File(['hello'], 'doc.txt', { type: 'text/plain' }));
      const req2 = new NextRequest('http://localhost:3000/api/v1/convert', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secretKey}` },
        body: form2,
      });
      const res2 = await v1ConvertHandler(req2);
      expect(res2.status).toBe(400);

      // 3. 0-byte file
      const form3 = new FormData();
      form3.append('file', new File([], 'empty.txt', { type: 'text/plain' }));
      form3.append('targetFormat', 'pdf');
      const req3 = new NextRequest('http://localhost:3000/api/v1/convert', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secretKey}` },
        body: form3,
      });
      const res3 = await v1ConvertHandler(req3);
      expect(res3.status).toBe(400);

      // CRITICAL: Ensure quota was NOT consumed by the 3 failed requests
      const usage = await keyStore.getQuotaUsage(user.id);
      expect(usage.usedToday).toBe(0);
      expect(usage.remaining).toBe(25);
    });

    it('OAuth callback strictly rejects missing or invalid state parameter to prevent CSRF', async () => {
      // Missing state entirely
      const reqMissingState = new NextRequest('http://localhost:3000/api/auth/google/callback?code=some_auth_code');
      const resMissing = await googleCallbackHandler(reqMissingState);
      expect(resMissing.status).toBe(307); // redirect
      const location = resMissing.headers.get('location') || '';
      expect(location).toContain('error=invalid_oauth_state');

      // Bogus/expired state
      const reqInvalidState = new NextRequest('http://localhost:3000/api/auth/google/callback?code=some_code&state=nonexistent_state');
      const resInvalid = await googleCallbackHandler(reqInvalidState);
      const loc2 = resInvalid.headers.get('location') || '';
      expect(loc2).toContain('error=invalid_oauth_state');
    });

    it('OAuth exchange rejects mock codes when NODE_ENV is production', async () => {
      const originalEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'production';
        await expect(exchangeGoogleCode('mock_code_attacker', 'http://localhost/callback')).rejects.toThrow(
          /mock codes are not permitted in production/i
        );
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    it('clearSessionCookie includes Secure flag in production environment', () => {
      const originalEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'production';
        const cleared = clearSessionCookie();
        expect(cleared).toContain('Secure');
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    it('verifyJwt rejects non-object JSON payloads and unsupported algorithms', () => {
      // 1. Primitive payload
      const headerB64 = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url');
      const primPayloadB64 = Buffer.from('"just-a-string"').toString('base64url');
      const sig1 = Buffer.from('sig').toString('base64url');
      expect(verifyJwt(`${headerB64}.${primPayloadB64}.${sig1}`)).toBeNull();

      // 2. Algorithm confusion (e.g., none)
      const noneHeaderB64 = Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url');
      const payloadB64 = Buffer.from('{"sub":"user1"}').toString('base64url');
      expect(verifyJwt(`${noneHeaderB64}.${payloadB64}.`)).toBeNull();
    });

    it('recordUsage handles concurrent requests safely without exceeding tier limit', async () => {
      const user = userStore.sanitizeUser(
        await userStore.createUser({
          email: 'concurrent@example.com',
          name: 'Concurrent User',
          tier: 'free',
        })
      );

      // Leave exactly 1 unit left
      await keyStore.recordUsage(user.id, 24);

      // Simulate 5 simultaneous requests trying to claim the last 1 unit
      const results = await Promise.all([
        keyStore.recordUsage(user.id, 1),
        keyStore.recordUsage(user.id, 1),
        keyStore.recordUsage(user.id, 1),
        keyStore.recordUsage(user.id, 1),
        keyStore.recordUsage(user.id, 1),
      ]);

      const allowedCount = results.filter((r) => r.allowed).length;
      expect(allowedCount).toBe(1);

      const finalQuota = await keyStore.getQuotaUsage(user.id);
      expect(finalQuota.usedToday).toBe(25);
      expect(finalQuota.remaining).toBe(0);
    });

    it('prunes expired user files and persists changes to disk', async () => {
      const user = userStore.sanitizeUser(
        await userStore.createUser({
          email: 'purge-dev@example.com',
          name: 'Purge Dev',
        })
      );

      const file = await keyStore.recordUserFile({
        userId: user.id,
        fileName: 'old.pdf',
        fromFormat: 'docx',
        toFormat: 'pdf',
        size: 100,
        downloadUrl: 'data:application/pdf;base64,123',
      });

      // Artificially expire file
      file.expiresAt = Date.now() - 1000;

      const files = await keyStore.listUserFiles(user.id);
      expect(files).toHaveLength(0);
    });

    it('rejects non-string or malformed JSON payloads in login and register routes', async () => {
      // 1. Malformed JSON to login
      const reqMalformedLogin = new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        body: 'invalid-json{',
      });
      const resMalformedLogin = await loginHandler(reqMalformedLogin);
      expect(resMalformedLogin.status).toBe(400);

      // 2. Non-string types in login
      const reqNonStringLogin = new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 12345, password: true }),
      });
      const resNonStringLogin = await loginHandler(reqNonStringLogin);
      expect(resNonStringLogin.status).toBe(400);

      // 3. Malformed JSON to register
      const reqMalformedRegister = new NextRequest('http://localhost:3000/api/auth/register', {
        method: 'POST',
        body: 'not-json',
      });
      const resMalformedRegister = await registerHandler(reqMalformedRegister);
      expect(resMalformedRegister.status).toBe(400);
    });

    it('rejects non-Blob file parameters and non-object options in /api/v1/convert', async () => {
      const user = userStore.sanitizeUser(
        await userStore.createUser({
          email: 'guard-edge@example.com',
          name: 'Guard Edge',
        })
      );
      const { secretKey } = await keyStore.generateApiKey(user.id, 'Guard Key');

      // 1. File parameter passed as plain string instead of Blob/File
      const formStringFile = new FormData();
      formStringFile.append('file', 'plain-text-string-not-file');
      formStringFile.append('targetFormat', 'pdf');
      const reqStringFile = new NextRequest('http://localhost:3000/api/v1/convert', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secretKey}` },
        body: formStringFile,
      });
      const resStringFile = await v1ConvertHandler(reqStringFile);
      expect(resStringFile.status).toBe(400);

      // 2. Options passed as non-object JSON (e.g. array or primitive)
      const formBadOptions = new FormData();
      formBadOptions.append('file', new File(['test'], 'test.txt', { type: 'text/plain' }));
      formBadOptions.append('targetFormat', 'pdf');
      formBadOptions.append('options', '[1, 2, 3]');
      const reqBadOptions = new NextRequest('http://localhost:3000/api/v1/convert', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secretKey}` },
        body: formBadOptions,
      });
      const resBadOptions = await v1ConvertHandler(reqBadOptions);
      expect(resBadOptions.status).toBe(400);
    });

    it('prevents negative or zero unit quota deductions in recordUsage', async () => {
      const user = userStore.sanitizeUser(
        await userStore.createUser({
          email: 'quota-safety@example.com',
          name: 'Quota Safety',
          tier: 'free',
        })
      );

      // Initial usage check
      const initialQuota = await keyStore.getQuotaUsage(user.id);
      expect(initialQuota.usedToday).toBe(0);

      // Attempt negative units
      const negResult = await keyStore.recordUsage(user.id, -5);
      expect(negResult.allowed).toBe(true);
      expect(negResult.remaining).toBe(25);

      // Confirm usage was NOT decremented below 0
      const quotaAfterNeg = await keyStore.getQuotaUsage(user.id);
      expect(quotaAfterNeg.usedToday).toBe(0);
      expect(quotaAfterNeg.remaining).toBe(25);

      // Zero units check
      const zeroResult = await keyStore.recordUsage(user.id, 0);
      expect(zeroResult.allowed).toBe(true);
      expect(zeroResult.remaining).toBe(25);
    });

    it('enforces fail-closed behavior for OAuth URL generation in production without credentials', async () => {
      const originalEnv = process.env.NODE_ENV;
      const originalClientId = process.env.GOOGLE_CLIENT_ID;
      try {
        process.env.NODE_ENV = 'production';
        delete process.env.GOOGLE_CLIENT_ID;

        expect(() => getGoogleOAuthUrl('http://localhost:3000/api/auth/google/callback')).toThrow(
          /GOOGLE_CLIENT_ID is not configured in production/i
        );

        const req = new NextRequest('http://localhost:3000/api/auth/google/url');
        const res = await googleUrlHandler(req);
        expect(res.status).toBe(500);
        const data = await res.json();
        expect(data.success).toBe(false);
      } finally {
        process.env.NODE_ENV = originalEnv;
        if (originalClientId) {
          process.env.GOOGLE_CLIENT_ID = originalClientId;
        }
      }
    });

    it('verifyJwt rejects array header structures', () => {
      const arrayHeaderB64 = Buffer.from('[{"alg":"HS256"}]').toString('base64url');
      const payloadB64 = Buffer.from('{"sub":"user1"}').toString('base64url');
      expect(verifyJwt(`${arrayHeaderB64}.${payloadB64}.sig`)).toBeNull();
    });
  });
});
