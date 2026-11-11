import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteKeysInBatches, eraseAccount, planAccountErasure } from '../scripts/erase-account';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { webhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';
import { conversionQueue, resourceQueues } from '../src/lib/queue/conversion-queue';
import { enqueueConversionJob } from '../src/lib/queue/enqueue';
import { removeStoredJob } from '../src/lib/queue/ended-jobs';
import { graphScheduler } from '../src/lib/queue/graph/scheduler';
import { sealGraph } from '../src/lib/queue/graph/node-jobs';
import { checkLoginRateLimit, LOGIN_MAX_FAILED_ATTEMPTS_PER_EMAIL, recordFailedLogin } from '../src/lib/auth/login-rate-limiter';
import { issueAuthToken } from '../src/lib/auth/auth-email-token-store';
import { storageProvider } from '../src/lib/storage';
import { credentialsVault } from '../src/lib/storage/credentials-vault';
import { getRetentionLedger } from '../src/lib/storage/retention-ledger';
import { registerCompletedUpload, saveRetainedResult } from '../src/lib/storage/retention-service';
import { tusEngine } from '../src/lib/storage/tus-engine';
import { TERMS_VERSION } from '../src/lib/legal/documents';
import type { WebhookDlqEntry } from '../src/lib/api-keys/types';

/** The wait asked for in a case where nothing runs: an erasure that waits for it takes at least this long. */
const IDLE_DRAIN_HANG_GUARD_MS = 30_000;
const createdUsers: string[] = [];

async function newAccount(label: string) {
  const user = await redisUserStore.createUser({ email: `${label}_${crypto.randomUUID()}@complete.test`, name: label, acceptedTermsVersion: TERMS_VERSION });
  createdUsers.push(user.id);
  return user;
}

async function queuedJob(userId: string, label: string, queue: typeof conversionQueue = conversionQueue) {
  return enqueueConversionJob(
    queue,
    'convert',
    { jobId: '', originalFilename: `${label}.csv`, sourceFormat: 'csv', targetFormat: 'json', fileSize: 4, options: {}, userId },
    { attempts: 1 },
    { tier: 'free', inputBytes: 4 }
  );
}

async function runningGraph(userId: string) {
  const graphId = `job_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
  await graphScheduler.initGraph(
    graphId,
    sealGraph(graphId, { nodes: { upload: { op: 'import.upload', storageKey: `conversions/${userId}/in.csv` }, convert: { op: 'convert', input: 'upload', targetFormat: 'json' } } }),
    { ownerUserId: userId }
  );
  return graphId;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const userId of createdUsers.splice(0)) {
    const plan = await planAccountErasure(userId);
    if (plan) await eraseAccount(plan, { drainMs: 0 });
  }
});

describe('the keys of an account are deleted in batches', () => {
  it('names at most 500 keys in one DEL, however many the account has', async () => {
    const keys = Array.from({ length: 12_345 }, (_, i) => `easyconvert:probe:{u}:${i}`);
    const calls: string[][] = [];
    await deleteKeysInBatches({ del: async (...batch: string[]) => (calls.push(batch), batch.length) }, keys);
    expect(Math.max(...calls.map((batch) => batch.length))).toBeLessThanOrEqual(500);
    expect(calls.flat()).toEqual(keys);
  });
});

describe('erasing an account while its work may still run', () => {
  it('waits for the worker of a cancelled running job before it deletes the files of its graph, so a late output is deleted too', async () => {
    const user = await newAccount('late');
    const graphId = await runningGraph(user.id);
    const job = await queuedJob(user.id, 'late');
    // A shared Redis may hold jobs of other suites ahead of this one: take them until this job is the one popped.
    let popped = await conversionQueue._popNextWaiting?.();
    for (let taken = 0; popped && popped.id !== job.id && taken < 500; taken++) popped = await conversionQueue._popNextWaiting?.();
    expect(popped?.id).toBe(job.id);
    // The in-memory queue leaves it to the worker to mark the job it popped active; the Redis queue marks it itself.
    if (popped && popped.state !== 'active') popped.state = 'active';
    expect((await conversionQueue.getJob(job.id))?.state).toBe('active');

    // The worker has not heard of the cancel yet: it writes one more output of the graph a moment later.
    const lateKey = `results/${graphId}/convert/0/late.json`;
    setTimeout(() => void saveRetainedResult(storageProvider, lateKey, Buffer.from('[1]'), 'application/json', 'late.json'), 60);

    const plan = await planAccountErasure(user.id);
    const startedAt = Date.now();
    expect(await eraseAccount(plan!, { drainMs: 400 })).toEqual({ runningJobIds: [] });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(390);
    expect(await storageProvider.getObject(lateKey)).toBeUndefined();
    expect(await getRetentionLedger().get(lateKey)).toBeUndefined();
    expect(await graphScheduler.getGraphState(graphId)).toBeUndefined();
    expect(await redisUserStore.findById(user.id)).toBeNull();
  });

  it('does not wait when nothing was running', async () => {
    const user = await newAccount('idle');
    await queuedJob(user.id, 'idle');
    const startedAt = Date.now();
    await eraseAccount((await planAccountErasure(user.id))!, { drainMs: IDLE_DRAIN_HANG_GUARD_MS });
    expect(Date.now() - startedAt).toBeLessThan(IDLE_DRAIN_HANG_GUARD_MS);
  });

  it('keys and sessions go first: nothing new can start while the erasure runs', async () => {
    const user = await newAccount('blocked');
    const { key } = await redisKeyStore.generateApiKey(user.id, 'blocked key', { acceptedTermsVersion: TERMS_VERSION });
    const versionBefore = await redisUserStore.getSessionVersion(user.id);
    const plan = await planAccountErasure(user.id);
    const order: string[] = [];
    vi.spyOn(redisKeyStore, 'deleteApiKey').mockImplementation(async () => (order.push('key'), true));
    vi.spyOn(redisUserStore, 'incrementSessionVersion').mockImplementation(async () => (order.push('session'), versionBefore + 1));
    vi.spyOn(graphScheduler, 'cancelGraph').mockImplementation(async () => (order.push('cancel'), true));
    await runningGraph(user.id).then((graphId) => plan!.graphIds.push(graphId));
    await eraseAccount(plan!, { drainMs: 0 });
    expect(order.indexOf('key')).toBe(0);
    expect(order.indexOf('session')).toBeLessThan(order.indexOf('cancel'));
    expect(key.id).toBeTruthy();
  });

  it('leaves the graphs, their files and the account for the next run while a job is still active', async () => {
    const user = await newAccount('stuck');
    const graphId = await runningGraph(user.id);
    const job = await queuedJob(user.id, 'stuck');
    const real = conversionQueue.remove.bind(conversionQueue);
    vi.spyOn(conversionQueue, 'remove').mockImplementation(async (id: string) => (id === job.id ? false : real(id)));
    vi.spyOn(conversionQueue, 'getJob').mockImplementation(async (id: string) => (id === job.id ? ({ id, state: 'active' } as never) : undefined));

    const outcome = await eraseAccount((await planAccountErasure(user.id))!, { drainMs: 0 });

    expect(outcome.runningJobIds).toEqual([job.id]);
    expect(await redisUserStore.findById(user.id)).not.toBeNull();
    expect(await graphScheduler.getGraphState(graphId)).toBeDefined();
    vi.restoreAllMocks();
  });

  it('deletes a result a stopped job wrote that only the history of the account names', async () => {
    const user = await newAccount('history');
    const resultKey = `results/job_gone_${crypto.randomBytes(4).toString('hex')}/0/out.json`;
    await saveRetainedResult(storageProvider, resultKey, Buffer.from('{}'), 'application/json', 'out.json');
    await redisKeyStore.recordUserFile({
      userId: user.id,
      fileName: 'out.json',
      fromFormat: 'csv',
      toFormat: 'json',
      size: 2,
      downloadUrl: `/api/storage/file/${encodeURIComponent(resultKey)}`,
      storageKey: resultKey,
    });

    await eraseAccount((await planAccountErasure(user.id))!, { drainMs: 0 });

    expect(await storageProvider.getObject(resultKey)).toBeUndefined();
    expect(await getRetentionLedger().get(resultKey)).toBeUndefined();
  });
});

describe('the other records of an account', () => {
  it('deletes its open resumable uploads and no other account\'s', async () => {
    const user = await newAccount('tus');
    const other = await newAccount('tusother');
    const mine = await tusEngine.createSession({ uploadLength: 10, ownerUserId: user.id });
    const theirs = await tusEngine.createSession({ uploadLength: 10, ownerUserId: other.id });

    const plan = await planAccountErasure(user.id);
    expect(plan!.tusSessionIds).toEqual([mine.id]);
    await eraseAccount(plan!, { drainMs: 0 });

    expect(await tusEngine.getSession(mine.id)).toBeNull();
    expect(await tusEngine.getSession(theirs.id)).not.toBeNull();
    await tusEngine.terminateSession(theirs.id);
  });

  it('forgets its failed logins, so the address is not locked after the account is gone', async () => {
    const user = await newAccount('locked');
    for (let i = 0; i < LOGIN_MAX_FAILED_ATTEMPTS_PER_EMAIL; i++) await recordFailedLogin('203.0.113.9', user.email);
    expect((await checkLoginRateLimit('203.0.113.9', user.email)).allowed).toBe(false);

    await eraseAccount((await planAccountErasure(user.id))!, { drainMs: 0 });

    expect((await checkLoginRateLimit('203.0.113.77', user.email)).allowed).toBe(true);
  });

  it('removes the jobs and dead letters of a user from a queue that holds no other record of them', async () => {
    const user = await newAccount('queued');
    const other = await newAccount('queuedother');
    const job = await queuedJob(user.id, 'queued');
    await resourceQueues.light.moveToDlq?.(job, 'failed');
    const kept = await queuedJob(other.id, 'kept');
    await resourceQueues.light.moveToDlq?.(kept, 'failed');

    await eraseAccount((await planAccountErasure(user.id))!, { drainMs: 0 });

    const letters = (await resourceQueues.light.getDlqEntries?.()) ?? [];
    expect(letters.some((letter) => letter.jobId === job.id)).toBe(false);
    expect(letters.some((letter) => letter.jobId === kept.id)).toBe(true);
    expect((await conversionQueue.getJob(kept.id))?.state).toBe('waiting');
    await eraseAccount((await planAccountErasure(other.id))!, { drainMs: 0 });
  });
});

/** Every key (and every value) of the Redis server that names the account or one of its resources. */
async function recordsNaming(needles: readonly string[]): Promise<string[]> {
  const client = redisKeyStore.getRedisClient()!;
  const found: string[] = [];
  let cursor = '0';
  do {
    const [next, keys] = await client.scan(cursor, 'COUNT', 1000);
    cursor = next;
    for (const key of keys) {
      const type = await client.type(key);
      let value = '';
      if (type === 'string') value = (await client.get(key)) ?? '';
      else if (type === 'hash') value = JSON.stringify(await client.hgetall(key));
      else if (type === 'list') value = JSON.stringify(await client.lrange(key, 0, -1));
      else if (type === 'set') value = JSON.stringify(await client.smembers(key));
      else if (type === 'zset') value = JSON.stringify(await client.zrange(key, '0', '-1'));
      else if (type === 'stream') value = JSON.stringify(await client.xrange(key, '-', '+'));
      if (needles.some((needle) => key.includes(needle) || value.includes(needle))) found.push(`${type} ${key}`);
    }
  } while (cursor !== '0');
  return found.sort((a, b) => a.localeCompare(b));
}

// skip-ok: mode selection. The shards run without REDIS_URL; the Redis-mode CI step (npm run test:redis) sets it and runs this file.
describe.skipIf(!process.env.REDIS_URL)('erasing an account that owns a record of every kind, on a real Redis server', () => {
  it('leaves no key and no value that names the account or what it owned', async () => {
    const user = await newAccount('everything');
    const needles: string[] = [user.id, user.email];
    const { key } = await redisKeyStore.generateApiKey(user.id, 'everything key', { acceptedTermsVersion: TERMS_VERSION });
    needles.push(key.id);
    await redisKeyStore.checkTokenBucketRateLimit(`apikey:${key.id}`, { capacity: 1, refillRate: 0, cost: 1 });
    await redisKeyStore.deductQuota(user.id, 1);
    const credentialId = await credentialsVault.store(user.id, { type: 'http', url: 'https://93.184.215.14/out' });
    await credentialsVault.store(user.id, { type: 'http', url: 'https://93.184.215.14/temp' }, { ttlSeconds: 60 });
    needles.push(credentialId);

    const uploadKey = `conversions/${user.id}/everything.csv`;
    await storageProvider.saveObject(uploadKey, Buffer.from('a\n1\n'), 'text/csv', 'everything.csv');
    await registerCompletedUpload(storageProvider, uploadKey);
    const graphId = await runningGraph(user.id);
    needles.push(graphId);
    const graphResult = `results/${graphId}/convert/0/out.json`;
    await saveRetainedResult(storageProvider, graphResult, Buffer.from('[1]'), 'application/json', 'out.json');
    const job = await queuedJob(user.id, 'everything');
    needles.push(job.id);
    await resourceQueues.light.moveToDlq?.(job, 'failed');
    const gone = await queuedJob(user.id, 'gone', resourceQueues.light);
    needles.push(gone.id);
    await resourceQueues.light.moveToDlq?.(gone, 'failed');
    const client = redisKeyStore.getRedisClient()!;
    // A job that keeps nothing when it fails is removed, and its dead letter stays (`removeOnFail: true`).
    const queueName = resourceQueues.light.name;
    await removeStoredJob(client, {
      jobKey: (id) => `easyconvert:queue:{${queueName}}:job:${id}`,
      userJobsKey: (id) => `easyconvert:queue:{${queueName}}:user_jobs:${id}`,
      dlqKey: `easyconvert:queue:{${queueName}}:dlq`,
      stateKeys: ['waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled'].map((state) => `easyconvert:queue:{${queueName}}:${state}`) as never,
    }, gone.id);
    await redisKeyStore.recordUserFile({
      userId: user.id,
      fileName: 'out.json',
      fromFormat: 'csv',
      toFormat: 'json',
      size: 3,
      downloadUrl: `/api/storage/file/${encodeURIComponent(graphResult)}`,
      storageKey: graphResult,
    });
    const letter: WebhookDlqEntry = {
      id: `dlq_everything_${crypto.randomBytes(4).toString('hex')}`,
      originalDeliveryId: 'wh_everything',
      targetUrl: 'https://93.184.215.14/hook',
      event: 'job.failed',
      payload: { jobId: job.id },
      secret: 'whsec_letter',
      failedAt: Date.now(),
      retryCount: 1,
      status: 'failed',
      ownerUserId: user.id,
    };
    needles.push(letter.id);
    await webhookDispatcher.saveToDlq(letter);
    const session = await tusEngine.createSession({ uploadLength: 10, ownerUserId: user.id });
    needles.push(session.id);
    await issueAuthToken('reset', { userId: user.id, email: user.email });
    for (let i = 0; i < LOGIN_MAX_FAILED_ATTEMPTS_PER_EMAIL; i++) await recordFailedLogin('203.0.113.9', user.email);
    for (let i = 0; i < 1_200; i++) await client.set(`easyconvert:probe:{${user.id}}:${i}`, '1');

    expect((await recordsNaming(needles)).length).toBeGreaterThan(10);

    const plan = await planAccountErasure(user.id);
    expect(await eraseAccount(plan!, { drainMs: 0 })).toEqual({ runningJobIds: [] });

    expect(await recordsNaming(needles)).toEqual([]);
    expect(await storageProvider.getObject(uploadKey)).toBeUndefined();
    expect(await storageProvider.getObject(graphResult)).toBeUndefined();
  }, 60_000);
});
