import { describe, it, expect, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as createJob } from '../src/app/api/v1/jobs/route';
import { InMemoryGraphScheduler } from '../src/lib/queue/graph';
import { SealingKeyConfigError, type SealingKeyConfigError as SealingKeyConfigErrorType } from '../src/lib/security/job-secret-seal';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { getQueueForResourceClass } from '../src/lib/queue/conversion-queue';

/**
 * Sealing fails closed. A worker without a usable sealing key in production refuses to start, and
 * the API refuses to accept a graph that carries secrets it cannot seal, storing nothing.
 */
const KEY_ENVS = ['JOB_SECRET_KEK', 'STORAGE_VAULT_KEY', 'KEY_ENCRYPTION_KEY', 'JWT_SECRET'] as const;
const SECRET_QUERY = 'sig-0e9d4c71b2a85f36';
// Production storage must be configured for the worker to reach its sealing-key check.
const STORAGE_SIGNING_SECRET = 'job-secret-startup-signing-secret-0123456789';

function stubProductionWithoutKey(): void {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('STORAGE_DRIVER', 'local');
  vi.stubEnv('STORAGE_SIGNING_SECRET', STORAGE_SIGNING_SECRET);
  for (const name of KEY_ENVS) {
    vi.stubEnv(name, '');
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('worker startup', () => {
  /** Imports the worker entry in a fresh module registry; returns what it threw with that registry's error class. */
  async function importWorker(): Promise<{ error: unknown; SealingKeyConfigError: typeof SealingKeyConfigErrorType }> {
    vi.resetModules();
    const { SealingKeyConfigError } = await import('../src/lib/security/job-secret-seal');
    try {
      await import('../src/worker/index');
    } catch (error) {
      return { error, SealingKeyConfigError };
    }
    return { error: undefined, SealingKeyConfigError };
  }

  it('throws a typed error when no sealing key is configured in production', async () => {
    stubProductionWithoutKey();
    const { error, SealingKeyConfigError } = await importWorker();
    expect(error).toBeInstanceOf(SealingKeyConfigError);
    expect((error as SealingKeyConfigErrorType).code).toBe('MISSING');
  });

  it('throws a typed error when JOB_SECRET_KEK is malformed in production', async () => {
    stubProductionWithoutKey();
    vi.stubEnv('JOB_SECRET_KEK', 'too-short');
    const { error, SealingKeyConfigError } = await importWorker();
    expect(error).toBeInstanceOf(SealingKeyConfigError);
    expect((error as SealingKeyConfigErrorType).code).toBe('MALFORMED');
  });
});

describe('graph submission without a sealing key', () => {
  const graph = {
    nodes: {
      in: { op: 'import.url', url: `https://files.example.org/in/data.csv?X-Amz-Signature=${SECRET_QUERY}` },
      out: { op: 'export.internal', input: 'in' },
    },
  };

  it('refuses to schedule a graph with URL secrets and stores and queues nothing', async () => {
    stubProductionWithoutKey();
    const scheduler = new InMemoryGraphScheduler();
    const graphId = `g_nokey_${Date.now()}`;

    await expect(scheduler.initGraph(graphId, graph as never, { ownerUserId: 'u' })).rejects.toBeInstanceOf(
      SealingKeyConfigError
    );
    expect(await scheduler.getGraphState(graphId)).toBeUndefined();
    expect(await getQueueForResourceClass('light').getJob(`${graphId}:in`)).toBeUndefined();
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
