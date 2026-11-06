import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SecretEncryptionKeyRequiredError,
  decryptSecret,
  encryptSecret,
  needsSecretReencryption,
  reencryptSecretIfNeeded,
} from '../src/lib/api-keys/secret-encryption';
import { KeyStore } from '../src/lib/api-keys/key-store';
import { CredentialsVault, VaultKeyRequiredError } from '../src/lib/storage/credentials-vault';
import { signJwt, verifyJwt } from '../src/lib/auth/jwt';
import { userStore } from '../src/lib/auth/user-store';

const PEPPER = 'legacy-pepper-0123456789abcdef0123456789';
const JWT_SECRET = 'production-jwt-secret-0123456789abcdef';
const SHORT_KEY = 'short-key-12';
const NEW_KEK = 'new-primary-kek-0123456789abcdef012345';
const NEW_VAULT_KEY = 'new-vault-key-0123456789abcdef01234567';
const PLAIN = 'whsec_fallback_decrypt_secret';

const KEY_ENV_NAMES = [
  'KEY_ENCRYPTION_KEY',
  'KEY_HASH_PEPPER',
  'KEY_HASH_PEPPER_PREVIOUS',
  'JWT_SECRET',
  'JWT_SECRET_PREVIOUS',
  'STORAGE_VAULT_KEY',
  'REDIS_URL',
] as const;

/** Seals a secret exactly as the pre-hardening code did: SHA-256 of the raw (untrimmed) env value. */
function legacyEncryptSecret(rawSecret: string, plainText: string): string {
  const key = crypto.createHash('sha256').update(rawSecret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`;
}

function clearKeyEnv() {
  for (const name of KEY_ENV_NAMES) {
    vi.stubEnv(name, '');
  }
}

describe('Production decrypt never depends on the new primary key being set', () => {
  beforeEach(() => {
    clearKeyEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('decrypts a KEY_HASH_PEPPER-sealed secret in production with no KEY_ENCRYPTION_KEY and refuses a new encrypt with a typed error', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('KEY_HASH_PEPPER', PEPPER);
    const legacy = encryptSecret(PLAIN);

    vi.stubEnv('NODE_ENV', 'production');
    expect(decryptSecret(legacy)).toBe(PLAIN);
    expect(needsSecretReencryption(legacy)).toBe(true);
    expect(() => encryptSecret('whsec_new')).toThrow(SecretEncryptionKeyRequiredError);
    expect(() => encryptSecret('whsec_new')).toThrow(/KEY_ENCRYPTION_KEY/);

    const result = reencryptSecretIfNeeded(legacy);
    expect(result).toEqual({ plainText: PLAIN, cipherText: legacy, reencrypted: false });
  });

  it('decrypts a JWT_SECRET-sealed secret in production with no KEY_ENCRYPTION_KEY or KEY_HASH_PEPPER', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('JWT_SECRET', JWT_SECRET);
    const legacy = encryptSecret(PLAIN);

    vi.stubEnv('NODE_ENV', 'production');
    expect(decryptSecret(legacy)).toBe(PLAIN);
    expect(() => encryptSecret('whsec_new')).toThrow(SecretEncryptionKeyRequiredError);
  });

  it('keeps a legacy plain-text value readable and unchanged when no key can seal it', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(decryptSecret('whsec_plain')).toBe('whsec_plain');
    expect(reencryptSecretIfNeeded('whsec_plain')).toEqual({
      plainText: 'whsec_plain',
      cipherText: 'whsec_plain',
      reencrypted: false,
    });
  });

  it('decrypts with a KEY_ENCRYPTION_KEY shorter than 32 characters that is set, and refuses only new writes', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('KEY_ENCRYPTION_KEY', SHORT_KEY);
    const legacy = encryptSecret(PLAIN);

    vi.stubEnv('NODE_ENV', 'production');
    expect(decryptSecret(legacy)).toBe(PLAIN);
    expect(() => encryptSecret('whsec_new')).toThrow(SecretEncryptionKeyRequiredError);
    expect(reencryptSecretIfNeeded(legacy).reencrypted).toBe(false);

    vi.stubEnv('KEY_ENCRYPTION_KEY', NEW_KEK);
    vi.stubEnv('KEY_HASH_PEPPER', SHORT_KEY);
    // The short key is gone from KEY_ENCRYPTION_KEY but kept as the pepper: still a candidate.
    expect(decryptSecret(legacy)).toBe(PLAIN);
  });

  it('decrypts a value sealed under a key stored with surrounding spaces, trimmed or not', () => {
    const padded = `  ${PEPPER}  `;
    const legacy = legacyEncryptSecret(padded, PLAIN);

    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('KEY_HASH_PEPPER', padded);
    expect(decryptSecret(legacy)).toBe(PLAIN);

    // The same value is reachable once a valid primary key exists, and is then re-sealed under it.
    vi.stubEnv('KEY_ENCRYPTION_KEY', NEW_KEK);
    const result = reencryptSecretIfNeeded(legacy);
    expect(result.plainText).toBe(PLAIN);
    expect(result.reencrypted).toBe(true);
    expect(decryptSecret(result.cipherText)).toBe(PLAIN);
    expect(reencryptSecretIfNeeded(result.cipherText).reencrypted).toBe(false);
  });

  it('seals under a primary KEY_ENCRYPTION_KEY of 32+ characters and re-seals legacy ciphertexts under it', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('KEY_HASH_PEPPER', PEPPER);
    const legacy = encryptSecret(PLAIN);

    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('KEY_ENCRYPTION_KEY', NEW_KEK);
    const fresh = encryptSecret(PLAIN);
    expect(needsSecretReencryption(fresh)).toBe(false);
    expect(needsSecretReencryption(legacy)).toBe(true);

    const result = reencryptSecretIfNeeded(legacy);
    expect(result.reencrypted).toBe(true);
    expect(needsSecretReencryption(result.cipherText)).toBe(false);
  });

  describe('API key verification', () => {
    let tempWorkDir: string;

    beforeEach(() => {
      tempWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-key-fallback-'));
      vi.spyOn(process, 'cwd').mockReturnValue(tempWorkDir);
    });

    afterEach(() => {
      fs.rmSync(tempWorkDir, { recursive: true, force: true });
    });

    it('still verifies an API key that carries a webhook secret after the switch to production without KEY_ENCRYPTION_KEY', async () => {
      vi.stubEnv('KEY_HASH_PEPPER', PEPPER);
      const user = await userStore.createUser({
        name: 'Fallback Decrypt User',
        email: `fallback_${Date.now()}_${Math.random().toString(36).slice(2)}@example.com`,
        tier: 'pro',
      });
      const store = new KeyStore(true);
      const { key, secretKey } = await store.generateApiKey(user.id, 'Webhook Key', {
        webhookUrl: 'https://example.com/hook',
        webhookSecret: PLAIN,
        scopes: ['convert:write'],
      });
      expect(key.webhookSecret).toBe(PLAIN);

      vi.stubEnv('NODE_ENV', 'production');
      const verified = await store.verifyApiKey(secretKey);
      expect(verified.valid).toBe(true);
      expect(verified.error).toBeUndefined();
      expect(verified.key?.webhookSecret).toBe(PLAIN);

      const listed = await store.listApiKeys(user.id);
      expect(listed.find((item) => item.id === key.id)?.webhookSecret).toBe(PLAIN);

      await expect(
        store.generateApiKey(user.id, 'New Webhook Key', { webhookSecret: 'whsec_new', scopes: ['convert:write'] })
      ).rejects.toThrow(SecretEncryptionKeyRequiredError);
    });
  });
});

describe('Production vault reads never depend on STORAGE_VAULT_KEY being set', () => {
  const creds = {
    type: 's3' as const,
    bucket: 'b',
    accessKeyId: 'AKIA1234567890123456',
    secretAccessKey: 'secret-access-key-0123456789abcdef',
  };

  beforeEach(() => {
    clearKeyEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('reads credentials stored under JWT_SECRET only, in production, and refuses a new store with a typed error', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('JWT_SECRET', JWT_SECRET);
    const vault = new CredentialsVault();
    const ref = await vault.store('user_vault', creds);

    vi.stubEnv('NODE_ENV', 'production');
    expect(await vault.get(ref, 'user_vault')).toEqual(creds);
    await expect(vault.store('user_vault', creds)).rejects.toThrow(VaultKeyRequiredError);
    await expect(vault.store('user_vault', creds)).rejects.toThrow(/STORAGE_VAULT_KEY/);
    await expect(vault.rotate('user_vault')).rejects.toThrow(VaultKeyRequiredError);
  });

  it('reads credentials stored under a STORAGE_VAULT_KEY shorter than 32 characters, and refuses only new stores', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('STORAGE_VAULT_KEY', SHORT_KEY);
    const vault = new CredentialsVault();
    const ref = await vault.store('user_vault', creds);

    vi.stubEnv('NODE_ENV', 'production');
    expect(await vault.get(ref, 'user_vault')).toEqual(creds);
    await expect(vault.store('user_vault', creds)).rejects.toThrow(VaultKeyRequiredError);
  });

  it('reads credentials stored under a key with surrounding spaces, and rotates them under a valid STORAGE_VAULT_KEY', async () => {
    const padded = `  ${NEW_VAULT_KEY}  `;
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('KEY_ENCRYPTION_KEY', padded);
    // Dev store trims; seal the legacy record with the untrimmed derivation to mimic old data.
    const legacyVault = new CredentialsVault();
    const ref = await legacyVault.store('user_vault', creds);
    const envelope = (legacyVault as unknown as { inMemoryStore: Map<string, Record<string, string>> }).inMemoryStore.get(ref)!;
    const rawKey = Buffer.from(
      crypto.hkdfSync(
        'sha256',
        Buffer.from(padded, 'utf-8'),
        Buffer.from('easyconvert-storage-salt', 'utf-8'),
        Buffer.from('easyconvert-storage-vault-v1', 'utf-8'),
        32
      )
    );
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', rawKey, iv);
    cipher.setAAD(Buffer.from(envelope.id, 'utf-8'));
    const enc = Buffer.concat([cipher.update(JSON.stringify(creds), 'utf-8'), cipher.final()]);
    envelope.iv = iv.toString('base64');
    envelope.tag = cipher.getAuthTag().toString('base64');
    envelope.encryptedData = enc.toString('base64');

    vi.stubEnv('NODE_ENV', 'production');
    expect(await legacyVault.get(ref, 'user_vault')).toEqual(creds);

    vi.stubEnv('STORAGE_VAULT_KEY', NEW_VAULT_KEY);
    expect(await legacyVault.rotate('user_vault')).toBe(true);
    vi.stubEnv('KEY_ENCRYPTION_KEY', '');
    expect(await legacyVault.get(ref, 'user_vault')).toEqual(creds);
  });
});

describe('JWT_SECRET and JWT_SECRET_PREVIOUS treat surrounding whitespace the same way', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('verifies a token signed under a previous secret that carries surrounding spaces, as JWT_SECRET is never trimmed', () => {
    const paddedOld = `  old-jwt-secret-value-at-least-32-bytes!!  `;
    const newSecret = 'new-jwt-secret-value-at-least-32-bytes!!';

    vi.stubEnv('JWT_SECRET', paddedOld);
    const token = signJwt({ sub: 'u_pad', email: 'p@example.com', tier: 'pro' });
    expect(verifyJwt(token)?.sub).toBe('u_pad');

    vi.stubEnv('JWT_SECRET', newSecret);
    vi.stubEnv('JWT_SECRET_PREVIOUS', paddedOld);
    expect(verifyJwt(token)?.sub).toBe('u_pad');
  });
});
