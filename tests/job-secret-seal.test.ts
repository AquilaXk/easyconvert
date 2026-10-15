import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  JOB_SECRET_KEK_ENV,
  JOB_SECRET_KEK_PREVIOUS_ENV,
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
 * `sealed:v1:<kid>:<nonce b64>:<tag b64>:<ciphertext b64>`, AES-256-GCM, 96-bit nonce, the job id as
 * AAD, key = HKDF-SHA256(KEK, salt "easyconvert-job-seal-salt", info "easyconvert-job-secret-seal-v1"),
 * kid = first 12 hex characters of SHA-256("easyconvert-job-secret-kid-v1" || key).
 * tests/job-secret-seal-known-answer.test.ts additionally pins a blob made by another implementation.
 */
const KEK = 'unit-test-job-secret-kek-0123456789abcdef';
const OTHER_KEK = 'another-unit-test-job-secret-kek-0123456789';
const JOB_ID = 'g_abc123:import_source';
const SECRET_URL = 'https://bucket.s3.example/obj.csv?X-Amz-Signature=5f2b1c9e7a&X-Amz-Credential=AKIAEXAMPLE';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KID_HEX_LENGTH = 12;
const MIN_KEK_BYTES = 32;
const KEY_ENVS = [
  JOB_SECRET_KEK_ENV,
  JOB_SECRET_KEK_PREVIOUS_ENV,
  'STORAGE_VAULT_KEY',
  'KEY_ENCRYPTION_KEY',
  'JWT_SECRET',
] as const;

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

function oracleKid(secret: string): string {
  return crypto
    .createHash('sha256')
    .update(Buffer.concat([Buffer.from('easyconvert-job-secret-kid-v1', 'utf8'), oracleKey(secret)]))
    .digest('hex')
    .slice(0, KID_HEX_LENGTH);
}

function oracleParse(blob: string) {
  const parts = blob.split(':');
  expect(parts.slice(0, 2).join(':') + ':').toBe(SEALED_PREFIX);
  const [kid, ...encoded] = parts.slice(2);
  const [nonce, tag, ciphertext] = encoded.map((p) => Buffer.from(p, 'base64'));
  return { kid, nonce, tag, ciphertext };
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

function stubKeyEnv(values: Partial<Record<(typeof KEY_ENVS)[number], string>>): void {
  for (const name of KEY_ENVS) {
    vi.stubEnv(name, values[name] ?? '');
  }
}

function sealErrorOf(fn: () => unknown): SecretSealError {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(SecretSealError);
  return thrown as SecretSealError;
}

function configErrorOf(fn: () => unknown): SealingKeyConfigError {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(SealingKeyConfigError);
  return thrown as SealingKeyConfigError;
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

  it('names the sealing key by its key id', () => {
    expect(oracleParse(sealJobSecret(SECRET_URL, JOB_ID)).kid).toBe(oracleKid(KEK));
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
    expect(() => oracleOpen(blob, JOB_ID, OTHER_KEK)).toThrow(/unable to authenticate data/);
  });

  it('refuses a plaintext above the size limit', () => {
    const error = sealErrorOf(() => sealJobSecret('x'.repeat(MAX_SEALED_PLAINTEXT_BYTES + 1), JOB_ID));
    expect(error.code).toBe('PLAINTEXT_TOO_LARGE');
  });

  it('refuses an empty job id', () => {
    expect(sealErrorOf(() => sealJobSecret(SECRET_URL, '')).code).toBe('INVALID_JOB_ID');
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
    const blob = `${SEALED_PREFIX}${oracleKid(KEK)}:${nonce.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ciphertext.toString('base64')}`;
    expect(unsealJobSecret(blob, JOB_ID)).toBe(SECRET_URL);
  });

  it('fails with a typed error when the blob is replayed into another job', () => {
    const blob = sealJobSecret(SECRET_URL, JOB_ID);
    expect(sealErrorOf(() => unsealJobSecret(blob, 'g_abc123:export_target')).code).toBe('AUTHENTICATION_FAILED');
  });

  it('fails with a typed error for a modified ciphertext, tag or nonce', () => {
    const [kid, nonce, tag, ciphertext] = sealJobSecret(SECRET_URL, JOB_ID).slice(SEALED_PREFIX.length).split(':');
    for (const [n, t, c] of [
      [nonce, tag, flipLastBase64Byte(ciphertext)],
      [nonce, flipLastBase64Byte(tag), ciphertext],
      [flipLastBase64Byte(nonce), tag, ciphertext],
    ]) {
      const tampered = `${SEALED_PREFIX}${kid}:${n}:${t}:${c}`;
      expect(sealErrorOf(() => unsealJobSecret(tampered, JOB_ID)).code).toBe('AUTHENTICATION_FAILED');
    }
  });

  it('fails with a typed error for structurally invalid blobs, never returning the input', () => {
    const valid = sealJobSecret(SECRET_URL, JOB_ID);
    const [kid, nonce, tag, ciphertext] = valid.slice(SEALED_PREFIX.length).split(':');
    const shortNonce = Buffer.from(nonce, 'base64').subarray(0, NONCE_BYTES - 1).toString('base64');
    const shortTag = Buffer.from(tag, 'base64').subarray(0, TAG_BYTES - 1).toString('base64');
    for (const blob of [
      SECRET_URL,
      '',
      SEALED_PREFIX,
      `${SEALED_PREFIX}${kid}:${nonce}:${tag}`,
      `${SEALED_PREFIX}${nonce}:${tag}:${ciphertext}`,
      `${SEALED_PREFIX}${kid}:${nonce}:${tag}:${ciphertext}:extra`,
      `${SEALED_PREFIX}${kid}:${shortNonce}:${tag}:${ciphertext}`,
      `${SEALED_PREFIX}${kid}:${nonce}:${shortTag}:${ciphertext}`,
      `${SEALED_PREFIX}${kid}:${nonce}:${tag}:`,
      `${SEALED_PREFIX}not-a-key-id:${nonce}:${tag}:${ciphertext}`,
      `${SEALED_PREFIX}${kid.toUpperCase()}:${nonce}:${tag}:${ciphertext}`,
    ]) {
      expect(sealErrorOf(() => unsealJobSecret(blob, JOB_ID)).code, blob).toBe('MALFORMED_BLOB');
    }
  });

  it('fails with a typed error for an unknown format version without echoing it', () => {
    const v2 = sealJobSecret(SECRET_URL, JOB_ID).replace('sealed:v1:', 'sealed:v7777:');
    const error = sealErrorOf(() => unsealJobSecret(v2, JOB_ID));
    expect(error.code).toBe('UNSUPPORTED_VERSION');
    expect(error.message).toBe('[JobSecretSeal] Unsupported sealed secret version.');
    expect(error.message).not.toContain('7777');
  });

  it('refuses a blob above the length limit before decoding it', () => {
    const huge = `${SEALED_PREFIX}${'A'.repeat(MAX_SEALED_BLOB_LENGTH)}:AA:AA`;
    expect(sealErrorOf(() => unsealJobSecret(huge, JOB_ID)).code).toBe('MALFORMED_BLOB');
  });

  it('never echoes attacker-controlled text in an error message', () => {
    const hostile = 'sealed:vSECRETTEXT:zz:aa:bb:cc';
    const error = sealErrorOf(() => unsealJobSecret(hostile, JOB_ID));
    expect(error.message).toBe('[JobSecretSeal] Sealed secret is malformed.');
  });

  it('never exposes the plaintext or key in an error message', () => {
    const blob = sealJobSecret(SECRET_URL, JOB_ID);
    const error = sealErrorOf(() => unsealJobSecret(blob, 'other-job'));
    const text = `${error.message} ${error.stack}`;
    expect(text).not.toContain('5f2b1c9e7a');
    expect(text).not.toContain(KEK);
  });
});

describe('key rotation', () => {
  it('reports a blob sealed under another key as an unknown key, not as tampering', () => {
    const blob = sealJobSecret(SECRET_URL, JOB_ID);
    stubKeyEnv({ [JOB_SECRET_KEK_ENV]: OTHER_KEK });
    expect(sealErrorOf(() => unsealJobSecret(blob, JOB_ID)).code).toBe('UNKNOWN_KEY');
  });

  it('opens a blob sealed under the previous key while JOB_SECRET_KEK_PREVIOUS names it', () => {
    const oldBlob = sealJobSecret(SECRET_URL, JOB_ID);
    stubKeyEnv({ [JOB_SECRET_KEK_ENV]: OTHER_KEK, [JOB_SECRET_KEK_PREVIOUS_ENV]: KEK });
    expect(unsealJobSecret(oldBlob, JOB_ID)).toBe(SECRET_URL);
    // New blobs are always sealed under the current key.
    const fresh = sealJobSecret(SECRET_URL, JOB_ID);
    expect(oracleParse(fresh).kid).toBe(oracleKid(OTHER_KEK));
    expect(oracleOpen(fresh, JOB_ID, OTHER_KEK)).toBe(SECRET_URL);
  });

  it('still authenticates against the key the key id names', () => {
    const [kid, nonce, tag, ciphertext] = sealJobSecret(SECRET_URL, JOB_ID).slice(SEALED_PREFIX.length).split(':');
    const forged = `${SEALED_PREFIX}${kid}:${nonce}:${tag}:${flipLastBase64Byte(ciphertext)}`;
    stubKeyEnv({ [JOB_SECRET_KEK_ENV]: KEK, [JOB_SECRET_KEK_PREVIOUS_ENV]: OTHER_KEK });
    expect(sealErrorOf(() => unsealJobSecret(forged, JOB_ID)).code).toBe('AUTHENTICATION_FAILED');
  });
});

describe('sealing key configuration', () => {
  it('requires JOB_SECRET_KEK in production and ignores the other secrets', () => {
    vi.stubEnv('NODE_ENV', 'production');
    stubKeyEnv({ JWT_SECRET: 'a-long-enough-jwt-secret-0123456789abcdef', STORAGE_VAULT_KEY: 'vault-key-0123456789abcdef0123456789', KEY_ENCRYPTION_KEY: 'enc-key-0123456789abcdef0123456789' });
    for (const call of [() => assertSealingKeyConfigured(), () => sealJobSecret(SECRET_URL, JOB_ID)]) {
      expect(configErrorOf(call).code).toBe('MISSING');
    }
  });

  it('requires at least 32 bytes in production, counting bytes and not characters', () => {
    vi.stubEnv('NODE_ENV', 'production');
    stubKeyEnv({ [JOB_SECRET_KEK_ENV]: 'x'.repeat(MIN_KEK_BYTES - 1) });
    expect(configErrorOf(() => assertSealingKeyConfigured()).code).toBe('MALFORMED');

    stubKeyEnv({ [JOB_SECRET_KEK_ENV]: 'x'.repeat(MIN_KEK_BYTES) });
    assertSealingKeyConfigured();

    // 11 Korean characters are 33 UTF-8 bytes.
    stubKeyEnv({ [JOB_SECRET_KEK_ENV]: '가'.repeat(11) });
    assertSealingKeyConfigured();
  });

  it('rejects whitespace around or instead of the key in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    for (const value of [`${KEK} `, `\n${KEK}`, ' '.repeat(MIN_KEK_BYTES + 1)]) {
      stubKeyEnv({ [JOB_SECRET_KEK_ENV]: value });
      expect(configErrorOf(() => assertSealingKeyConfigured()).code).toBe('MALFORMED');
    }
  });

  it('rejects a malformed JOB_SECRET_KEK_PREVIOUS in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    stubKeyEnv({ [JOB_SECRET_KEK_ENV]: KEK, [JOB_SECRET_KEK_PREVIOUS_ENV]: 'short' });
    expect(configErrorOf(() => assertSealingKeyConfigured()).code).toBe('MALFORMED');
  });

  it('accepts a random 32-byte key in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    stubKeyEnv({ [JOB_SECRET_KEK_ENV]: crypto.randomBytes(32).toString('hex') });
    assertSealingKeyConfigured();
    expect(unsealJobSecret(sealJobSecret(SECRET_URL, JOB_ID), JOB_ID)).toBe(SECRET_URL);
  });

  it('keeps local development cloud-free: a development key is used when none is configured', () => {
    stubKeyEnv({});
    expect(unsealJobSecret(sealJobSecret(SECRET_URL, JOB_ID), JOB_ID)).toBe(SECRET_URL);
  });

  it('does not borrow the vault or JWT secrets in development either', () => {
    stubKeyEnv({});
    const blob = sealJobSecret(SECRET_URL, JOB_ID);
    stubKeyEnv({ JWT_SECRET: 'some-jwt-secret', STORAGE_VAULT_KEY: 'some-vault-key' });
    expect(unsealJobSecret(blob, JOB_ID)).toBe(SECRET_URL);
  });
});
