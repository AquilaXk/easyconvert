import { describe, it, expect, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as createJob } from '../src/app/api/v1/jobs/route';
import { sealGraph } from '../src/lib/queue/graph/node-jobs';
import { SealingKeyConfigError } from '../src/lib/security/job-secret-seal';
import type { ConfigurationError as ConfigurationErrorType } from '../src/lib/config';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';

/**
 * Sealing fails closed. A worker without a usable sealing key in production refuses to start, and
 * the API refuses to accept a graph that carries secrets it cannot seal, storing nothing.
 */
const KEY_ENVS = ['JOB_SECRET_KEK', 'STORAGE_VAULT_KEY', 'KEY_ENCRYPTION_KEY', 'JWT_SECRET'] as const;
const SECRET_QUERY = 'sig-0e9d4c71b2a85f36';
// Production storage must be configured for the worker to reach its sealing-key check.
const STORAGE_SIGNING_SECRET = 'job-secret-startup-signing-secret-0123456789';
// A worker also needs the webhook key in production (docs/configuration.md).
const WEBHOOK_SECRET_KEK = 'job-secret-startup-webhook-kek-0123456789abcdef';

function stubProductionWithoutKey(): void {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('STORAGE_DRIVER', 'local');
  vi.stubEnv('STORAGE_SIGNING_SECRET', STORAGE_SIGNING_SECRET);
  vi.stubEnv('WEBHOOK_SECRET_KEK', WEBHOOK_SECRET_KEK);
  for (const name of KEY_ENVS) {
    vi.stubEnv(name, '');
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('worker startup', () => {
  /** Imports the worker entry in a fresh module registry; returns what it threw with that registry's error class. */
  async function importWorker(): Promise<{ error: unknown; ConfigurationError: typeof ConfigurationErrorType }> {
    vi.resetModules();
    const { ConfigurationError } = await import('../src/lib/config');
    try {
      await import('../src/worker/index');
    } catch (error) {
      return { error, ConfigurationError };
    }
    return { error: undefined, ConfigurationError };
  }

  // The configuration check is the first import of the worker entry, so it reports the missing or malformed key
  // (with every other bad variable) before the sealing module is loaded; the sealing module's own checks stay
  // as a second gate and are covered in job-secret-seal.test.ts.
  it('throws a typed error naming JOB_SECRET_KEK when no sealing key is configured in production', async () => {
    stubProductionWithoutKey();
    const { error, ConfigurationError } = await importWorker();
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as ConfigurationErrorType).failures).toEqual([{ variable: 'JOB_SECRET_KEK', rule: 'is required in production' }]);
  });

  it('throws a typed error naming JOB_SECRET_KEK when it is malformed in production, without its value', async () => {
    stubProductionWithoutKey();
    vi.stubEnv('JOB_SECRET_KEK', 'too-short');
    const { error, ConfigurationError } = await importWorker();
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as ConfigurationErrorType).failures).toEqual([
      { variable: 'JOB_SECRET_KEK', rule: 'must be at least 32 bytes (UTF-8 text, not decoded) in production' },
    ]);
    expect((error as Error).message).not.toContain('too-short');
  });
});

describe('graph submission without a sealing key', () => {
  const graph = {
    nodes: {
      in: { op: 'import.url', url: `https://files.example.org/in/data.csv?X-Amz-Signature=${SECRET_QUERY}` },
      conv: { op: 'convert', input: 'in', targetFormat: 'json' },
      out: { op: 'export.internal', input: 'conv' },
    },
  };

  it('refuses to seal a graph with URL secrets, the step before anything is stored or queued', () => {
    stubProductionWithoutKey();

    expect(() => sealGraph(`g_nokey_${Date.now()}`, graph as never)).toThrow(SealingKeyConfigError);
  });

  it('answers the API with 503 and no configuration detail', async () => {
    stubProductionWithoutKey();
    // Authentication has its own secret in production; only the sealing key is absent here.
    vi.stubEnv('KEY_HASH_PEPPER', 'pepper-for-this-test-0123456789abcdef');
    const user = await userStore.createUser({ email: `nokey_${Date.now()}@seal.test`, name: 'nokey', tier: 'pro' });
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'nokey', { scopes: ['convert:read', 'convert:write'] });

    const res = await createJob(
      new NextRequest('https://easyconvert.app/api/v1/jobs', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ graph, targetFormat: 'csv' }),
      })
    );
    const text = await res.text();

    expect(res.status, text).toBe(503);
    expect(text).not.toContain('JOB_SECRET_KEK');
    expect(text).not.toContain(SECRET_QUERY);
  });
});
