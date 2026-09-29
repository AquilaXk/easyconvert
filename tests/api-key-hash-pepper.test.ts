import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type KeyStoreModule = typeof import('../src/lib/api-keys/key-store');
type UserStoreModule = typeof import('../src/lib/auth/user-store');

const PEPPER = 'pepper-for-tests-3f9c1e7a4b2d8e6f0a1c5b9d7e3f2a4c6b8d0e1f3a5c7b9d';
const PEPPER_ENV = 'KEY_HASH_PEPPER';

// Independent oracles: node:crypto directly, never the module under test.
function oracleHmacSha256(key: string, content: string): string {
  return createHmac('sha256', key).update(content).digest('hex');
}

function oracleSha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

interface IsolatedModules {
  KeyStore: KeyStoreModule['KeyStore'];
  userStore: UserStoreModule['userStore'];
  keysFile: string;
}

const tempRoots: string[] = [];

/**
 * Loads fresh key-store/user-store modules whose `.easyconvert` storage directory lives in a
 * private temp dir, so disk reloads and the one-time pepper warning are deterministic and no
 * other test file's persisted keys can interfere.
 */
async function loadIsolatedModules(): Promise<IsolatedModules> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-pepper-'));
  tempRoots.push(root);
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root);
  try {
    vi.resetModules();
    const keyStoreModule: KeyStoreModule = await import('../src/lib/api-keys/key-store');
    const userStoreModule: UserStoreModule = await import('../src/lib/auth/user-store');
    return {
      KeyStore: keyStoreModule.KeyStore,
      userStore: userStoreModule.userStore,
      keysFile: path.join(root, '.easyconvert', 'api-keys.json'),
    };
  } finally {
    cwdSpy.mockRestore();
  }
}

function readPersistedHash(keysFile: string, keyId: string): string | undefined {
  const persisted: Array<{ id: string; keyHash: string }> = JSON.parse(fs.readFileSync(keysFile, 'utf-8'));
  return persisted.find((k) => k.id === keyId)?.keyHash;
}

function flipLastChar(secret: string): string {
  const last = secret.at(-1);
  return `${secret.slice(0, -1)}${last === 'a' ? 'b' : 'a'}`;
}

describe('API key hash pepper with legacy migration (#242)', () => {
  let savedPepper: string | undefined;

  beforeEach(() => {
    savedPepper = process.env[PEPPER_ENV];
    delete process.env[PEPPER_ENV];
  });

  afterEach(() => {
    if (savedPepper === undefined) {
      delete process.env[PEPPER_ENV];
    } else {
      process.env[PEPPER_ENV] = savedPepper;
    }
    vi.restoreAllMocks();
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('stores HMAC-SHA256(pepper, secret) for new keys and rejects a wrong secret', async () => {
    const { KeyStore, userStore, keysFile } = await loadIsolatedModules();
    process.env[PEPPER_ENV] = PEPPER;
    const store = new KeyStore(true);
    const user = await userStore.createUser({ email: 'pepper-new@pepper.test', name: 'Pepper New' });

    const { key, secretKey } = await store.generateApiKey(user.id, 'Peppered Key');
    const expectedHash = oracleHmacSha256(PEPPER, secretKey);
    expect(key.keyHash).toBe(expectedHash);
    expect(key.keyHash).not.toBe(oracleSha256(secretKey));
    expect(readPersistedHash(keysFile, key.id)).toBe(expectedHash);

    const verified = await store.verifyApiKey(secretKey);
    expect(verified.valid).toBe(true);
    expect(verified.key?.id).toBe(key.id);
    expect(verified.user?.id).toBe(user.id);

    const wrong = await store.verifyApiKey(flipLastChar(secretKey));
    expect(wrong.valid).toBe(false);
    expect(wrong.error).toBe('Invalid or non-existent API key');
  });

  it('verifies a legacy sha256 key and rehashes it to the peppered HMAC on first successful use', async () => {
    const { KeyStore, userStore, keysFile } = await loadIsolatedModules();
    const store = new KeyStore(true);
    const user = await userStore.createUser({ email: 'pepper-legacy@pepper.test', name: 'Pepper Legacy' });

    const { key, secretKey } = await store.generateApiKey(user.id, 'Legacy Key');
    expect(key.keyHash).toBe(oracleSha256(secretKey));

    process.env[PEPPER_ENV] = PEPPER;
    const verified = await store.verifyApiKey(secretKey);
    expect(verified.valid).toBe(true);
    expect(verified.key?.id).toBe(key.id);

    const migratedHash = oracleHmacSha256(PEPPER, secretKey);
    const [listed] = await store.listApiKeys(user.id);
    expect(listed.keyHash).toBe(migratedHash);
    expect(readPersistedHash(keysFile, key.id)).toBe(migratedHash);

    const again = await store.verifyApiKey(secretKey);
    expect(again.valid).toBe(true);
    expect(again.key?.id).toBe(key.id);

    expect((await store.verifyApiKey(flipLastChar(secretKey))).valid).toBe(false);

    // The legacy index entry is gone: without the pepper, the sha256 lookup no longer resolves.
    delete process.env[PEPPER_ENV];
    const legacyLookup = await store.verifyApiKey(secretKey);
    expect(legacyLookup.valid).toBe(false);
    expect(legacyLookup.error).toBe('Invalid or non-existent API key');
  });

  it('does not rehash a legacy key when verification fails (revoked key)', async () => {
    const { KeyStore, userStore, keysFile } = await loadIsolatedModules();
    const store = new KeyStore(true);
    const user = await userStore.createUser({ email: 'pepper-revoked@pepper.test', name: 'Pepper Revoked' });

    const { key, secretKey } = await store.generateApiKey(user.id, 'Revoked Legacy Key');
    await store.revokeApiKey(user.id, key.id);

    process.env[PEPPER_ENV] = PEPPER;
    const result = await store.verifyApiKey(secretKey);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('API key has been revoked');
    expect(readPersistedHash(keysFile, key.id)).toBe(oracleSha256(secretKey));
  });

  it('finds keys written by another store instance through the disk reload path', async () => {
    const { KeyStore, userStore } = await loadIsolatedModules();
    process.env[PEPPER_ENV] = PEPPER;
    const reader = new KeyStore(true);
    const writer = new KeyStore(true);
    const user = await userStore.createUser({ email: 'pepper-reload@pepper.test', name: 'Pepper Reload' });

    expect(await reader.listApiKeys(user.id)).toEqual([]);

    const peppered = await writer.generateApiKey(user.id, 'Written Elsewhere');
    const reloaded = await reader.verifyApiKey(peppered.secretKey);
    expect(reloaded.valid).toBe(true);
    expect(reloaded.key?.id).toBe(peppered.key.id);

    delete process.env[PEPPER_ENV];
    const legacy = await writer.generateApiKey(user.id, 'Legacy Written Elsewhere');
    process.env[PEPPER_ENV] = PEPPER;
    const legacyReloaded = await reader.verifyApiKey(legacy.secretKey);
    expect(legacyReloaded.valid).toBe(true);
    expect(legacyReloaded.key?.keyHash).toBe(oracleHmacSha256(PEPPER, legacy.secretKey));
  });

  it('falls back to sha256 without a pepper and warns exactly once', async () => {
    const { KeyStore, userStore } = await loadIsolatedModules();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new KeyStore(true);
    const user = await userStore.createUser({ email: 'pepper-unset@pepper.test', name: 'Pepper Unset' });

    const first = await store.generateApiKey(user.id, 'Unpeppered One');
    const second = await store.generateApiKey(user.id, 'Unpeppered Two');
    expect(first.key.keyHash).toBe(oracleSha256(first.secretKey));
    expect(second.key.keyHash).toBe(oracleSha256(second.secretKey));
    expect((await store.verifyApiKey(first.secretKey)).valid).toBe(true);

    const pepperWarnings = warnSpy.mock.calls.filter((args) => String(args[0]).includes(PEPPER_ENV));
    expect(pepperWarnings).toHaveLength(1);
  });
});
