import { describe, it, expect, afterEach, vi } from 'vitest';
import { SecretSealError, unsealJobSecret } from '../src/lib/security/job-secret-seal';
import knownAnswer from './fixtures/job-secret-seal/known-answer.json';

/**
 * The blob in the fixture was produced by Python `cryptography` from fixed inputs
 * (tests/fixtures/job-secret-seal/generate.py), not by this code base. Opening it pins the wire
 * format and the key derivation: a change to the salt, the info string, the nonce handling, the
 * AAD or the key id derivation fails here instead of silently orphaning every queued job.
 */
afterEach(() => {
  vi.unstubAllEnvs();
});

function useKnownKey(): void {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('JOB_SECRET_KEK', knownAnswer.kek);
  vi.stubEnv('JOB_SECRET_KEK_PREVIOUS', '');
}

describe('known-answer blob from an independent implementation', () => {
  it('opens to the frozen plaintext under the frozen key and job id', () => {
    useKnownKey();
    expect(unsealJobSecret(knownAnswer.blob, knownAnswer.jobId)).toBe(knownAnswer.plaintext);
  });

  it('carries the key id the independent implementation derived', () => {
    expect(knownAnswer.blob.split(':')[2]).toBe(knownAnswer.keyId);
  });

  it('does not open under another job id', () => {
    useKnownKey();
    expect(() => unsealJobSecret(knownAnswer.blob, `${knownAnswer.jobId}x`)).toThrow(SecretSealError);
  });

  it('is reported as an unknown key under a different key', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('JOB_SECRET_KEK', `${knownAnswer.kek}-other`);
    vi.stubEnv('JOB_SECRET_KEK_PREVIOUS', '');
    let thrown: unknown;
    try {
      unsealJobSecret(knownAnswer.blob, knownAnswer.jobId);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as SecretSealError).code).toBe('UNKNOWN_KEY');
  });
});
