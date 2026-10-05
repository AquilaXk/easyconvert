import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  JOB_SECRET_KEK_ENV,
  MAX_SEALED_BLOB_LENGTH,
  MAX_SEALED_PLAINTEXT_BYTES,
  SEALED_PREFIX,
  SealingKeyConfigError,
  SecretSealError,
  assertSealingKeyConfigured,
  sealJobSecret,
  unsealJobSecret,
} from '../src/lib/security/job-secret-seal';

/**
 * The oracle below is written from the wire format alone and never calls the module under test:
 * `sealed:v1:<nonce b64>:<tag b64>:<ciphertext b64>`, AES-256-GCM, 96-bit nonce, the job id as AAD,
 * key = HKDF-SHA256(secret, salt "easyconvert-job-seal-salt", info "easyconvert-job-secret-seal-v1").
 */
const KEK = 'unit-test-job-secret-kek-0123456789abcdef';
const JOB_ID = 'g_abc123:import_source';
const SECRET_URL = 'https://bucket.s3.example/obj.csv?X-Amz-Signature=5f2b1c9e7a&X-Amz-Credential=AKIAEXAMPLE';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_SOURCE_ENVS = [JOB_SECRET_KEK_ENV, 'STORAGE_VAULT_KEY', 'KEY_ENCRYPTION_KEY', 'JWT_SECRET'] as const;

function oracleKey(secret: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync(
      'sha256',
      Buffer.from(secret, 'utf8'),
      Buffer.from('easyconvert-job-seal-salt', 'utf8'),
      Buffer.from('easyconvert-job-secret-seal-v1', 'utf8'),
      32
    )
  );
}

function oracleParse(blob: string) {
  const parts = blob.split(':');
  expect(parts.slice(0, 2).join(':') + ':').toBe(SEALED_PREFIX);
  const [nonce, tag, ciphertext] = parts.slice(2).map((p) => Buffer.from(p, 'base64'));
  return { nonce, tag, ciphertext };
}

function oracleOpen(blob: string, jobId: string, secret: string): string {
  const { nonce, tag, ciphertext } = oracleParse(blob);
  const decipher = crypto.createDecipheriv('aes-256-gcm', oracleKey(secret), nonce);
  decipher.setAAD(Buffer.from(jobId, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function flipLastBase64Byte(part: string): string {
  const raw = Buffer.from(part, 'base64');
  raw[raw.length - 1] ^= 0x01;
  return raw.toString('base64');
}

function stubKeyEnv(values: Partial<Record<(typeof KEY_SOURCE_ENVS)[number], string>>): void {
  for (const name of KEY_SOURCE_ENVS) {
    vi.stubEnv(name, values[name] ?? '');
  }
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'development');
  stubKeyEnv({ [JOB_SECRET_KEK_ENV]: KEK });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('sealJobSecret', () => {
  it('produces a blob an independent AES-256-GCM implementation opens with the job id as AAD', () => {
    const blob = sealJobSecret(SECRET_URL, JOB_ID);
    expect(blob.startsWith(SEALED_PREFIX)).toBe(true);
    expect(oracleOpen(blob, JOB_ID, KEK)).toBe(SECRET_URL);
  });

  it('uses a 96-bit nonce and a 128-bit tag', () => {
    const { nonce, tag, ciphertext } = oracleParse(sealJobSecret(SECRET_URL, JOB_ID));
    expect(nonce.length).toBe(NONCE_BYTES);
    expect(tag.length).toBe(TAG_BYTES);
    expect(ciphertext.length).toBe(Buffer.byteLength(SECRET_URL, 'utf8'));
  });

  it('draws a fresh nonce for every seal of the same plaintext', () => {
    const nonces = new Set(Array.from({ length: 64 }, () => oracleParse(sealJobSecret(SECRET_URL, JOB_ID)).nonce.toString('hex')));
    expect(nonces.size).toBe(64);
  });

  it('does not contain the plaintext, its base64, or its hex anywhere in the blob', () => {
    const blob = sealJobSecret(SECRET_URL, JOB_ID);
    for (const needle of [SECRET_URL, 'X-Amz-Signature', '5f2b1c9e7a', Buffer.from(SECRET_URL).toString('base64'), Buffer.from(SECRET_URL).toString('hex')]) {
      expect(blob).not.toContain(needle);
    }
  });

  it('does not open under a different job id (AAD binding)', () => {
    const blob = sealJobSecret(SECRET_URL, JOB_ID);
    expect(() => oracleOpen(blob, 'g_abc123:export_target', KEK)).toThrow(/unable to authenticate data/);
  });

  it('does not open under a different key', () => {
    const blob = sealJobSecret(SECRET_URL, JOB_ID);
    expect(() => oracleOpen(blob, JOB_ID, `${KEK}-other`)).toThrow(/unable to authenticate data/);
  });

  it('refuses a plaintext above the size limit', () => {
    expect.assertions(2);
    try {
      sealJobSecret('x'.repeat(MAX_SEALED_PLAINTEXT_BYTES + 1), JOB_ID);
    } catch (err) {
      expect(err).toBeInstanceOf(SecretSealError);
      expect((err as SecretSealError).code).toBe('PLAINTEXT_TOO_LARGE');
    }
  });

  it('refuses an empty job id', () => {
    expect(() => sealJobSecret(SECRET_URL, '')).toThrow(SecretSealError);
  });
});

describe('unsealJobSecret', () => {
  it('round-trips including multi-byte text', () => {
    const text = '{"url":"https://h.example/가나다?sig=ü","headers":{"X-Api-Key":"k-1"}}';
    expect(unsealJobSecret(sealJobSecret(text, JOB_ID), JOB_ID)).toBe(text);
  });

  it('opens a blob written by the independent oracle', () => {
    const nonce = crypto.randomBytes(NONCE_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', oracleKey(KEK), nonce);
    cipher.setAAD(Buffer.from(JOB_ID, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(SECRET_URL, 'utf8'), cipher.final()]);
    const blob = `${SEALED_PREFIX}${nonce.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ciphertext.toString('base64')}`;
    expect(unsealJobSecret(blob, JOB_ID)).toBe(SECRET_URL);
  });

  function expectSealError(fn: () => unknown, code: string): void {
    let thrown: unknown;
    try {
      fn();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SecretSealError);
    expect((thrown as SecretSealError).code).toBe(code);
  }

  it('fails with a typed error when the blob is replayed into another job', () => {
    const blob = sealJobSecret(SECRET_URL, JOB_ID);
    expectSealError(() => unsealJobSecret(blob, 'g_abc123:export_target'), 'AUTHENTICATION_FAILED');
  });

  it('fails with a typed error for a modified ciphertext, tag or nonce', () => {
    const [nonce, tag, ciphertext] = sealJobSecret(SECRET_URL, JOB_ID).slice(SEALED_PREFIX.length).split(':');
    for (const [n, t, c] of [
      [nonce, tag, flipLastBase64Byte(ciphertext)],
      [nonce, flipLastBase64Byte(tag), ciphertext],
      [flipLastBase64Byte(nonce), tag, ciphertext],
    ]) {
      const tampered = `${SEALED_PREFIX}${n}:${t}:${c}`;
      expectSealError(() => unsealJobSecret(tampered, JOB_ID), 'AUTHENTICATION_FAILED');
    }
  });

  it('fails with a typed error when the key changed since sealing', () => {
    const blob = sealJobSecret(SECRET_URL, JOB_ID);
    stubKeyEnv({ [JOB_SECRET_KEK_ENV]: `${KEK}-rotated` });
    expectSealError(() => unsealJobSecret(blob, JOB_ID), 'AUTHENTICATION_FAILED');
  });

  it('fails with a typed error for structurally invalid blobs, never returning the input', () => {
    const valid = sealJobSecret(SECRET_URL, JOB_ID);
    const [nonce, tag, ciphertext] = valid.slice(SEALED_PREFIX.length).split(':');
    const shortNonce = Buffer.from(nonce, 'base64').subarray(0, NONCE_BYTES - 1).toString('base64');
    const shortTag = Buffer.from(tag, 'base64').subarray(0, TAG_BYTES - 1).toString('base64');
    for (const blob of [
      SECRET_URL,
      '',
      SEALED_PREFIX,
      `${SEALED_PREFIX}${nonce}:${tag}`,
      `${SEALED_PREFIX}${nonce}:${tag}:${ciphertext}:extra`,
      `${SEALED_PREFIX}${shortNonce}:${tag}:${ciphertext}`,
      `${SEALED_PREFIX}${nonce}:${shortTag}:${ciphertext}`,
      `${SEALED_PREFIX}${nonce}:${tag}:`,
    ]) {
      expectSealError(() => unsealJobSecret(blob, JOB_ID), 'MALFORMED_BLOB');
    }
  });

  it('fails with a typed error for an unknown format version', () => {
    const v2 = sealJobSecret(SECRET_URL, JOB_ID).replace(SEALED_PREFIX, 'sealed:v2:');
    expectSealError(() => unsealJobSecret(v2, JOB_ID), 'UNSUPPORTED_VERSION');
  });

  it('refuses a blob above the length limit before decoding it', () => {
    const huge = `${SEALED_PREFIX}${'A'.repeat(MAX_SEALED_BLOB_LENGTH)}:AA:AA`;
    expectSealError(() => unsealJobSecret(huge, JOB_ID), 'MALFORMED_BLOB');
  });

  it('never exposes the plaintext or key in an error message', () => {
    const blob = sealJobSecret(SECRET_URL, JOB_ID);
    try {
      unsealJobSecret(blob, 'other-job');
      expect.unreachable('unseal must fail');
    } catch (err) {
      const text = `${(err as Error).message} ${(err as Error).stack}`;
      expect(text).not.toContain('5f2b1c9e7a');
      expect(text).not.toContain(KEK);
    }
  });
});

describe('sealing key configuration', () => {
  it('fails closed with a typed error when no key is configured in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    stubKeyEnv({});
    expect.assertions(4);
    for (const call of [() => assertSealingKeyConfigured(), () => sealJobSecret(SECRET_URL, JOB_ID)]) {
      try {
        call();
      } catch (err) {
        expect(err).toBeInstanceOf(SealingKeyConfigError);
        expect((err as SealingKeyConfigError).code).toBe('MISSING');
      }
    }
  });

  it('fails closed with a typed error for a malformed (too short) JOB_SECRET_KEK in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    stubKeyEnv({ [JOB_SECRET_KEK_ENV]: 'short' });
    expect.assertions(2);
    try {
      assertSealingKeyConfigured();
    } catch (err) {
      expect(err).toBeInstanceOf(SealingKeyConfigError);
      expect((err as SealingKeyConfigError).code).toBe('MALFORMED');
    }
  });

  it('accepts a well-formed JOB_SECRET_KEK in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    stubKeyEnv({ [JOB_SECRET_KEK_ENV]: crypto.randomBytes(32).toString('hex') });
    assertSealingKeyConfigured();
    const blob = sealJobSecret(SECRET_URL, JOB_ID);
    expect(unsealJobSecret(blob, JOB_ID)).toBe(SECRET_URL);
  });

  it('uses the existing vault key configuration when JOB_SECRET_KEK is unset', () => {
    stubKeyEnv({ STORAGE_VAULT_KEY: 'existing-vault-key-material-0123456789' });
    const blob = sealJobSecret(SECRET_URL, JOB_ID);
    expect(oracleOpen(blob, JOB_ID, 'existing-vault-key-material-0123456789')).toBe(SECRET_URL);
  });

  it('prefers JOB_SECRET_KEK over the other key sources', () => {
    stubKeyEnv({ [JOB_SECRET_KEK_ENV]: KEK, STORAGE_VAULT_KEY: 'existing-vault-key-material-0123456789' });
    expect(oracleOpen(sealJobSecret(SECRET_URL, JOB_ID), JOB_ID, KEK)).toBe(SECRET_URL);
  });

  it('keeps local development cloud-free: a development key is derived when none is configured', () => {
    stubKeyEnv({});
    expect(unsealJobSecret(sealJobSecret(SECRET_URL, JOB_ID), JOB_ID)).toBe(SECRET_URL);
  });
});
