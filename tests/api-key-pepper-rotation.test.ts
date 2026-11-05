import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hmacSha256, sha256 } from '../src/lib/auth/crypto';
import { userStore } from '../src/lib/auth/user-store';
import type { User } from '../src/lib/auth/types';
import { apiKeyHashCandidates, KeyStore } from '../src/lib/api-keys/key-store';
import { RECORD_VERIFIED_KEY_LUA_SCRIPT, RedisKeyStore } from '../src/lib/api-keys/redis-key-store';

const PEPPER_V1 = 'pepper-version-1-at-least-32-bytes-long-secret';
const PEPPER_V2 = 'pepper-version-2-at-least-32-bytes-long-secret';
const WEBHOOK_SECRET = 'whsec_rotation_verification_secret';

function createFakeRedis() {
  const hashes = new Map<string, Record<string, string>>();
  const sets = new Map<string, Set<string>>();

  const client = {
    hashes,
    hset: vi.fn(async (key: string, fieldOrObj: Record<string, string> | string, val?: string) => {
      const current = hashes.get(key) ?? {};
      if (typeof fieldOrObj === 'object') {
        hashes.set(key, { ...current, ...fieldOrObj });
      } else {
        current[fieldOrObj] = String(val ?? '');
        hashes.set(key, current);
      }
      return 1;
    }),
    hdel: vi.fn(async (key: string, ...fields: string[]) => {
      const current = hashes.get(key);
      if (!current) return 0;
      let removed = 0;
      for (const field of fields) {
        if (field in current) {
          delete current[field];
          removed++;
        }
      }
      return removed;
    }),
    hgetall: vi.fn(async (key: string) => ({ ...(hashes.get(key) ?? {}) })),
    hget: vi.fn(async (key: string, field: string) => hashes.get(key)?.[field] ?? null),
    hexists: vi.fn(async (key: string, field: string) => (hashes.get(key) && field in (hashes.get(key) ?? {}) ? 1 : 0)),
    hmget: vi.fn(async (key: string, ...fields: string[]) => {
      const current = hashes.get(key) ?? {};
      return fields.map((f) => current[f] ?? null);
    }),
    sadd: vi.fn(async (key: string, member: string) => {
      const set = sets.get(key) ?? new Set<string>();
      set.add(member);
      sets.set(key, set);
      return 1;
    }),
    smembers: vi.fn(async (key: string) => Array.from(sets.get(key) ?? [])),
    eval: vi.fn(async (script: string, numKeys: number, ...args: string[]) => {
      if (script === RECORD_VERIFIED_KEY_LUA_SCRIPT && numKeys === 2) {
        const [keyRecordName, hashIndexName, lastUsedAt, data, newHash, oldHash, keyId, hashField] = args;
        const record = hashes.get(keyRecordName);
        if (!record || Object.keys(record).length === 0) return 0;
        if (newHash) {
          const targetField = hashField || 'keyHash';
          hashes.set(keyRecordName, { ...record, [targetField]: newHash, data, lastUsedAt });
          const idx = hashes.get(hashIndexName) ?? {};
          idx[newHash] = keyId;
          if (oldHash && oldHash !== newHash) {
            delete idx[oldHash];
          }
          hashes.set(hashIndexName, idx);
        } else if (data) {
          hashes.set(keyRecordName, { ...record, data, lastUsedAt });
        } else {
          hashes.set(keyRecordName, { ...record, lastUsedAt });
        }
        return 1;
      }
      return 0;
    }),
    pipeline: vi.fn(() => {
      const ops: Array<() => Promise<[null, Record<string, string>]>> = [];
      return {
        hgetall(key: string) {
          ops.push(async () => [null, { ...(hashes.get(key) ?? {}) }]);
          return this;
        },
        async exec() {
          return Promise.all(ops.map((op) => op()));
        },
      };
    }),
  };

  return client;
}

describe('Zero-downtime KEY_HASH_PEPPER rotation with KEY_HASH_PEPPER_PREVIOUS', () => {
  const savedPepper = process.env.KEY_HASH_PEPPER;
  const savedPreviousPepper = process.env.KEY_HASH_PEPPER_PREVIOUS;
  const savedEncryptionKey = process.env.KEY_ENCRYPTION_KEY;
  const savedJwtSecret = process.env.JWT_SECRET;
  let tempWorkDir: string;
  let tempDataDir: string;
  let testUser: User;

  beforeEach(async () => {
    tempWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-pepper-test-'));
    tempDataDir = path.join(tempWorkDir, '.easyconvert');
    vi.spyOn(process, 'cwd').mockReturnValue(tempWorkDir);
    delete process.env.KEY_ENCRYPTION_KEY;
    process.env.KEY_HASH_PEPPER = PEPPER_V1;
    delete process.env.KEY_HASH_PEPPER_PREVIOUS;
    testUser = await userStore.createUser({
      name: 'Pepper Rotation User',
      email: `pepper_rot_${Date.now()}_${Math.random().toString(36).slice(2)}@example.com`,
      tier: 'pro',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedPepper === undefined) delete process.env.KEY_HASH_PEPPER;
    else process.env.KEY_HASH_PEPPER = savedPepper;

    if (savedPreviousPepper === undefined) delete process.env.KEY_HASH_PEPPER_PREVIOUS;
    else process.env.KEY_HASH_PEPPER_PREVIOUS = savedPreviousPepper;

    if (savedEncryptionKey === undefined) delete process.env.KEY_ENCRYPTION_KEY;
    else process.env.KEY_ENCRYPTION_KEY = savedEncryptionKey;

    if (savedJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = savedJwtSecret;

    if (tempWorkDir) {
      fs.rmSync(tempWorkDir, { recursive: true, force: true });
    }
  });

  it('orders candidate hashes as current pepper, previous pepper, then legacy SHA-256 without duplicates', () => {
    process.env.KEY_HASH_PEPPER = PEPPER_V2;
    process.env.KEY_HASH_PEPPER_PREVIOUS = PEPPER_V1;
    const secret = 'ec_live_sample_secret';

    const candidates = apiKeyHashCandidates(secret);
    expect(candidates.currentHash).toBe(hmacSha256(PEPPER_V2, secret));
    expect(candidates.hashes).toEqual([
      hmacSha256(PEPPER_V2, secret),
      hmacSha256(PEPPER_V1, secret),
      sha256(secret),
    ]);

    process.env.KEY_HASH_PEPPER_PREVIOUS = PEPPER_V2;
    const deduplicated = apiKeyHashCandidates(secret);
    expect(deduplicated.hashes).toEqual([hmacSha256(PEPPER_V2, secret), sha256(secret)]);
  });

  it('verifies a key created under KEY_HASH_PEPPER_PREVIOUS in KeyStore and rehashes keyHash and webhookSecret', async () => {
    const store = new KeyStore(true);
    const { key, secretKey } = await store.generateApiKey(testUser.id, 'Local Rotation Key', {
      webhookUrl: 'https://example.com/hook',
      webhookSecret: WEBHOOK_SECRET,
      scopes: ['convert:write'],
    });

    expect(key.keyHash).toBe(hmacSha256(PEPPER_V1, secretKey));

    process.env.KEY_HASH_PEPPER = PEPPER_V2;
    process.env.KEY_HASH_PEPPER_PREVIOUS = PEPPER_V1;

    const verifiedDuringRotation = await store.verifyApiKey(secretKey);
    expect(verifiedDuringRotation.valid).toBe(true);
    expect(verifiedDuringRotation.key?.keyHash).toBe(hmacSha256(PEPPER_V2, secretKey));
    expect(verifiedDuringRotation.key?.webhookSecret).toBe(WEBHOOK_SECRET);

    const keysFile = path.join(tempDataDir, 'api-keys.json');
    expect(fs.existsSync(keysFile)).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(keysFile, 'utf-8')) as Array<{ id: string; keyHash: string; webhookSecret?: string }>;
    const record = persisted.find((item) => item.id === key.id);
    expect(record?.keyHash).toBe(hmacSha256(PEPPER_V2, secretKey));
    expect(record?.webhookSecret?.startsWith('enc:v1:')).toBe(true);

    delete process.env.KEY_HASH_PEPPER_PREVIOUS;

    const verifiedAfterRetiringOldPepper = await store.verifyApiKey(secretKey);
    expect(verifiedAfterRetiringOldPepper.valid).toBe(true);
    expect(verifiedAfterRetiringOldPepper.key?.webhookSecret).toBe(WEBHOOK_SECRET);

    const listed = await store.listApiKeys(testUser.id);
    expect(listed.find((item) => item.id === key.id)?.webhookSecret).toBe(WEBHOOK_SECRET);
  });

  it('verifies and lazily rehashes a key in RedisKeyStore across instances, including its encrypted webhookSecret', async () => {
    const fakeRedis = createFakeRedis();
    const prefix = 'rot_test:';
    const instanceA = new RedisKeyStore({ isolated: true, redisClient: fakeRedis as any, keyPrefix: prefix });

    const { key, secretKey } = await instanceA.generateApiKey(testUser.id, 'Redis Rotation Key', {
      webhookUrl: 'https://example.com/hook',
      webhookSecret: WEBHOOK_SECRET,
      scopes: ['convert:write'],
    });

    const hashV1 = hmacSha256(PEPPER_V1, secretKey);
    const hashV2 = hmacSha256(PEPPER_V2, secretKey);
    expect(fakeRedis.hashes.get(`${prefix}apikey_hashes`)?.[hashV1]).toBe(key.id);
    const initialStored = JSON.parse(fakeRedis.hashes.get(`${prefix}apikeys:${key.id}`)?.data ?? '{}');
    expect(initialStored.webhookSecret).toMatch(/^enc:v1:/);

    process.env.KEY_HASH_PEPPER = PEPPER_V2;
    process.env.KEY_HASH_PEPPER_PREVIOUS = PEPPER_V1;

    const instanceB = new RedisKeyStore({ isolated: true, redisClient: fakeRedis as any, keyPrefix: prefix });
    const verifiedOnB = await instanceB.verifyApiKey(secretKey);
    expect(verifiedOnB.valid).toBe(true);
    expect(verifiedOnB.key?.id).toBe(key.id);
    expect(verifiedOnB.key?.keyHash).toBe(hashV2);
    expect(verifiedOnB.key?.webhookSecret).toBe(WEBHOOK_SECRET);
    expect(fakeRedis.eval).toHaveBeenCalledWith(
      RECORD_VERIFIED_KEY_LUA_SCRIPT,
      2,
      `${prefix}apikeys:${key.id}`,
      `${prefix}apikey_hashes`,
      expect.any(String),
      expect.any(String),
      hashV2,
      hashV1,
      key.id,
      'keyHash'
    );

    expect(fakeRedis.hashes.get(`${prefix}apikey_hashes`)?.[hashV2]).toBe(key.id);
    expect(fakeRedis.hashes.get(`${prefix}apikey_hashes`)?.[hashV1]).toBeUndefined();
    expect(fakeRedis.hashes.get(`${prefix}apikeys:${key.id}`)?.keyHash).toBe(hashV2);

    delete process.env.KEY_HASH_PEPPER_PREVIOUS;

    const instanceC = new RedisKeyStore({ isolated: true, redisClient: fakeRedis as any, keyPrefix: prefix });
    const verifiedAfterRetiringV1 = await instanceC.verifyApiKey(secretKey);
    expect(verifiedAfterRetiringV1.valid).toBe(true);
    expect(verifiedAfterRetiringV1.key?.keyHash).toBe(hashV2);
    expect(verifiedAfterRetiringV1.key?.webhookSecret).toBe(WEBHOOK_SECRET);

    const listedOnC = await instanceC.listApiKeys(testUser.id);
    expect(listedOnC.find((item) => item.id === key.id)?.webhookSecret).toBe(WEBHOOK_SECRET);
  });

  it('keeps the new keyHash intact and re-encrypts webhookSecret when a key is rotated during a pepper rotation window', async () => {
    const fakeRedis = createFakeRedis();
    const prefix = 'grace_test:';
    const store = new RedisKeyStore({ isolated: true, redisClient: fakeRedis as any, keyPrefix: prefix });

    const { key, secretKey: oldSecretKey } = await store.generateApiKey(testUser.id, 'Grace Period Key', {
      webhookUrl: 'https://example.com/hook',
      webhookSecret: WEBHOOK_SECRET,
    });

    process.env.KEY_HASH_PEPPER = PEPPER_V2;
    process.env.KEY_HASH_PEPPER_PREVIOUS = PEPPER_V1;

    const rotated = await store.rotateApiKey(testUser.id, key.id, { gracePeriodSeconds: 3600 });
    expect(rotated).not.toBeNull();
    expect(rotated!.key.webhookSecret).toBe(WEBHOOK_SECRET);
    const newSecretKey = rotated!.newSecretKey;
    const expectedNewHash = hmacSha256(PEPPER_V2, newSecretKey);
    expect(rotated!.key.keyHash).toBe(expectedNewHash);
    expect(rotated!.key.previousKeyHash).toBe(hmacSha256(PEPPER_V1, oldSecretKey));

    const oldVerify = await store.verifyApiKey(oldSecretKey);
    expect(oldVerify.valid).toBe(true);
    expect(oldVerify.key?.keyHash).toBe(expectedNewHash);
    expect(oldVerify.key?.previousKeyHash).toBe(hmacSha256(PEPPER_V2, oldSecretKey));
    expect(oldVerify.key?.webhookSecret).toBe(WEBHOOK_SECRET);

    delete process.env.KEY_HASH_PEPPER_PREVIOUS;

    const oldVerifyAfterRetiringV1 = await store.verifyApiKey(oldSecretKey);
    expect(oldVerifyAfterRetiringV1.valid).toBe(true);
    expect(oldVerifyAfterRetiringV1.key?.keyHash).toBe(expectedNewHash);

    const newVerifyAfterRetiringV1 = await store.verifyApiKey(newSecretKey);
    expect(newVerifyAfterRetiringV1.valid).toBe(true);
    expect(newVerifyAfterRetiringV1.key?.keyHash).toBe(expectedNewHash);
    expect(newVerifyAfterRetiringV1.key?.webhookSecret).toBe(WEBHOOK_SECRET);

    const peerWorkDir = path.join(tempWorkDir, 'peer-node');
    fs.mkdirSync(peerWorkDir, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(peerWorkDir);
    const peerStore = new RedisKeyStore({ isolated: true, redisClient: fakeRedis as any, keyPrefix: prefix });
    const rotatedSecond = await peerStore.rotateApiKey(testUser.id, key.id, { gracePeriodSeconds: 3600 });
    vi.spyOn(process, 'cwd').mockReturnValue(tempWorkDir);
    expect(rotatedSecond).not.toBeNull();
    const restartedStore = new RedisKeyStore({ isolated: true, redisClient: fakeRedis as any, keyPrefix: prefix });
    const expiredFirstSecretVerify = await restartedStore.verifyApiKey(oldSecretKey);
    expect(expiredFirstSecretVerify.valid).toBe(false);

    fakeRedis.hmget.mockRejectedValueOnce(new Error('redis unreachable'));
    const fallbackVerifyAfterPeerRotate = await restartedStore.verifyApiKey(oldSecretKey);
    expect(fallbackVerifyAfterPeerRotate.valid).toBe(false);

    const listed = await restartedStore.listApiKeys(testUser.id);
    expect(listed.find((item) => item.id === key.id)?.webhookSecret).toBe(WEBHOOK_SECRET);
  });

  it('migrates a legacy unpeppered key and its JWT_SECRET-encrypted webhookSecret when KEY_HASH_PEPPER is introduced', async () => {
    delete process.env.KEY_HASH_PEPPER;
    delete process.env.KEY_HASH_PEPPER_PREVIOUS;
    process.env.JWT_SECRET = 'jwt-secret-used-before-pepper-was-configured-32b';

    const store = new KeyStore(true);
    const { key, secretKey } = await store.generateApiKey(testUser.id, 'Legacy Unpeppered Key', {
      webhookUrl: 'https://example.com/legacy',
      webhookSecret: WEBHOOK_SECRET,
    });
    expect(key.keyHash).toBe(sha256(secretKey));

    process.env.KEY_HASH_PEPPER = PEPPER_V1;

    const verified = await store.verifyApiKey(secretKey);
    expect(verified.valid).toBe(true);
    expect(verified.key?.keyHash).toBe(hmacSha256(PEPPER_V1, secretKey));
    expect(verified.key?.webhookSecret).toBe(WEBHOOK_SECRET);

    process.env.JWT_SECRET = 'rotated-jwt-secret-after-webhook-reencryption-32b';
    const verifiedAfterJwtChange = await store.verifyApiKey(secretKey);
    expect(verifiedAfterJwtChange.valid).toBe(true);
    expect(verifiedAfterJwtChange.key?.webhookSecret).toBe(WEBHOOK_SECRET);
  });
});
