import crypto from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteKeysInBatches, eraseAccount, planAccountErasure } from '../scripts/erase-account';
import { POST as toolJobsPost } from '../src/app/api/tools/jobs/route';
import { anonymousUserId } from '../src/lib/auth/anonymous-identity';
import { accountTaggedKeys } from '../src/lib/auth/erase-account-keys';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { webhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';
import { conversionQueue, resourceQueues } from '../src/lib/queue/conversion-queue';
import { enqueueConversionJob } from '../src/lib/queue/enqueue';
import { removeStoredJob } from '../src/lib/queue/ended-jobs';
import { graphScheduler } from '../src/lib/queue/graph/scheduler';
import { sealGraph } from '../src/lib/queue/graph/node-jobs';
import {
  registerLiveWorkerHeartbeat,
  resetLocalLiveWorkersForTests,
  unregisterLiveWorkerHeartbeat,
} from '../src/lib/queue/worker-presence';
import { checkLoginRateLimit, LOGIN_MAX_FAILED_ATTEMPTS_PER_EMAIL, recordFailedLogin } from '../src/lib/auth/login-rate-limiter';
import { issueAuthToken } from '../src/lib/auth/auth-email-token-store';
import { storageProvider } from '../src/lib/storage';
import { credentialsVault } from '../src/lib/storage/credentials-vault';
import { getRetentionLedger } from '../src/lib/storage/retention-ledger';
import { registerCompletedUpload, saveRetainedResult } from '../src/lib/storage/retention-service';
import { tusEngine } from '../src/lib/storage/tus-engine';
import {
  deleteToolJob,
  eraseUserToolJobs,
  getToolJob,
  registerLocalToolAbort,
  saveToolJob,
  updateExistingToolJob,
  userToolJobsKey,
} from '../src/lib/tools/tool-job-store';
import { processQueuedToolJob } from '../src/lib/tools/queued-tool-runner';
import * as webToolsMod from '../src/lib/tools/web-tools';
import { JobCancelledError, type Job } from '../src/lib/queue/bullmq-engine';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';
import { TERMS_VERSION } from '../src/lib/legal/documents';
import type { WebhookDlqEntry } from '../src/lib/api-keys/types';
import type { WebhookJobData } from '../src/lib/api-keys/webhook-dispatcher';

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

describe('work that starts while the erasure runs', () => {
  /** Pops jobs until `id` is the one popped, and marks it active (the in-memory queue leaves that to its worker). */
  async function makeActive(id: string): Promise<void> {
    let popped = await conversionQueue._popNextWaiting?.();
    for (let taken = 0; popped && popped.id !== id && taken < 500; taken++) popped = await conversionQueue._popNextWaiting?.();
    expect(popped?.id).toBe(id);
    if (popped && popped.state !== 'active') popped.state = 'active';
  }

  it('cancels a job that was queued after the first look and is running by the next one, and does not report the account deleted with it running', async () => {
    const user = await newAccount('straggler');
    await queuedJob(user.id, 'first');
    const plan = await planAccountErasure(user.id);
    let straggler: string | undefined;
    const realGraphs = graphScheduler.graphsOfUser.bind(graphScheduler);
    let looks = 0;
    // The first look at the work has listed the jobs; a request authenticated before the keys went queues one more, and a worker takes it.
    vi.spyOn(graphScheduler, 'graphsOfUser').mockImplementation(async (userId: string) => {
      const found = await realGraphs(userId);
      if (looks++ === 0) {
        straggler = (await queuedJob(user.id, 'straggler')).id;
        await makeActive(straggler);
      }
      return found;
    });

    const outcome = await eraseAccount(plan!, { drainMs: 0 });

    expect(outcome).toEqual({ runningJobIds: [] });
    const after = await conversionQueue.getJob(straggler!);
    expect(after === undefined || after.state === 'cancelled').toBe(true);
    expect(await redisUserStore.findById(user.id)).toBeNull();
  });

  it('answers the jobs queued after the last look, and keeps the account and its index for the next run', async () => {
    const user = await newAccount('late-queue');
    const first = await queuedJob(user.id, 'first');
    let late: string | undefined;
    const real = conversionQueue.remove.bind(conversionQueue);
    vi.spyOn(conversionQueue, 'remove').mockImplementation(async (id: string) => {
      if (id === first.id && late === undefined) late = (await queuedJob(user.id, 'late')).id;
      return real(id);
    });

    const outcome = await eraseAccount((await planAccountErasure(user.id))!, { drainMs: 0 });

    expect(outcome.runningJobIds).toEqual([late]);
    expect(await redisUserStore.findById(user.id)).not.toBeNull();
    expect((await conversionQueue.getJobsByUser(user.id)).map((job) => job.id)).toEqual([late]);
    vi.restoreAllMocks();
  });

  it('leaves the jobs of the account that this run did not process, and removes the ones it did', async () => {
    const user = await newAccount('window');
    const processed = await queuedJob(user.id, 'processed');
    const beyond = await queuedJob(user.id, 'beyond');

    const left = await conversionQueue.forgetUser!(user.id, new Set([processed.id]));

    expect(left).toEqual([beyond.id]);
    expect((await conversionQueue.getJobsByUser(user.id)).map((job) => job.id)).toEqual([beyond.id]);
    expect((await conversionQueue.getJob(beyond.id))?.state).toBe('waiting');
  });
});

describe('a record the erasure could not delete fails the run', () => {
  it('fails when the dead letters cannot be cleared, and leaves the account', async () => {
    const user = await newAccount('dlqfail');
    vi.spyOn(webhookDispatcher, 'clearDlq').mockRejectedValue(new Error('redis is down'));

    await expect(eraseAccount((await planAccountErasure(user.id))!, { drainMs: 0 })).rejects.toThrow('redis is down');

    expect(await redisUserStore.findById(user.id)).not.toBeNull();
  });

  // skip-ok: mode selection. The shards run without REDIS_URL; the Redis-mode CI step (npm run test:redis) sets it and runs this file.
  it.skipIf(!process.env.REDIS_URL)('does not report the dead letters cleared when Redis refuses the removal, and does not hide a login counter it could not delete', async () => {
    const user = await newAccount('redisfail');
    const client = redisKeyStore.getRedisClient()!;
    const realPipeline = client.pipeline.bind(client);
    const broken = vi.spyOn(client, 'pipeline').mockImplementation((() => {
      throw new Error('connection lost');
    }) as never);
    await expect(webhookDispatcher.clearDlq(user.id, { strict: true })).rejects.toThrow('connection lost');
    await expect(webhookDispatcher.clearDlq(user.id)).resolves.toBeUndefined();
    broken.mockRestore();
    void realPipeline;

    const userClient = redisUserStore.getRedisClient()!;
    const realDel = userClient.del.bind(userClient) as (...keys: string[]) => Promise<number>;
    vi.spyOn(userClient, 'del').mockImplementation((async (...keys: string[]) => {
      if (keys.some((key) => key.includes('login_attempts'))) throw new Error('connection lost');
      return realDel(...keys);
    }) as never);
    await expect(eraseAccount((await planAccountErasure(user.id))!, { drainMs: 0 })).rejects.toThrow('temporarily unavailable');
    expect(await redisUserStore.findById(user.id)).not.toBeNull();
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

  it('deletes its open multipart uploads with their parts and no other account\'s', async () => {
    const user = await newAccount('multipart');
    const other = await newAccount('multipartother');
    const mine = await storageProvider.initiateMultipartUpload('in.csv', 'text/csv', 2048, user.id);
    await storageProvider.uploadPart(mine.uploadId, 1, Buffer.alloc(1024, 3));
    const theirs = await storageProvider.initiateMultipartUpload('in.csv', 'text/csv', 2048, other.id);

    const plan = await planAccountErasure(user.id);
    expect(plan!.uploadSessionIds).toEqual([mine.uploadId]);
    await eraseAccount(plan!, { drainMs: 0 });

    expect(await storageProvider.getUploadSession?.(mine.uploadId)).toBeUndefined();
    expect(await storageProvider.getUploadSession?.(theirs.uploadId)).toMatchObject({ ownerUserId: other.id });
    await storageProvider.abortMultipartUpload(theirs.uploadId);
  });

  it('finds an upload the account opened after the plan was made, and fails the run with the account left when an upload cannot be aborted', async () => {
    const user = await newAccount('multipartlate');
    const plan = await planAccountErasure(user.id);
    expect(plan!.uploadSessionIds).toEqual([]);
    const late = await storageProvider.initiateMultipartUpload('late.csv', 'text/csv', 10, user.id);

    vi.spyOn(storageProvider, 'abortUploadSessionsOfOwner').mockRejectedValue(new Error('storage is down'));
    await expect(eraseAccount(plan!, { drainMs: 0 })).rejects.toThrow('storage is down');
    expect(await redisUserStore.findById(user.id)).not.toBeNull();
    vi.restoreAllMocks();

    await eraseAccount((await planAccountErasure(user.id))!, { drainMs: 0 });
    expect(await storageProvider.getUploadSession?.(late.uploadId)).toBeUndefined();
    expect(await redisUserStore.findById(user.id)).toBeNull();
  });

  it('does not plan an erasure it cannot make complete when the uploads cannot be listed', async () => {
    const user = await newAccount('multipartlist');
    vi.spyOn(storageProvider, 'uploadSessionsOfOwner').mockRejectedValue(new Error('storage is down'));
    await expect(planAccountErasure(user.id)).rejects.toThrow('storage is down');
  });

  // skip-ok: mode selection. The shards run without REDIS_URL; the Redis-mode CI step (npm run test:redis) sets it and runs this file.
  it.skipIf(!process.env.REDIS_URL)('fails the run, leaving the account and every upload, when Redis cannot be searched for its resumable uploads', async () => {
    const user = await newAccount('tusredisfail');
    const other = await newAccount('tusredisfailother');
    const mine = await tusEngine.createSession({ uploadLength: 10, ownerUserId: user.id });
    const theirs = await tusEngine.createSession({ uploadLength: 10, ownerUserId: other.id });
    const plan = (await planAccountErasure(user.id))!;

    const redis = (tusEngine.sessionStore as unknown as { redis: { scan(...args: unknown[]): Promise<unknown> } }).redis;
    vi.spyOn(redis, 'scan').mockRejectedValue(new Error('connection lost'));
    await expect(eraseAccount(plan, { drainMs: 0 })).rejects.toThrow('connection lost');
    vi.restoreAllMocks();

    expect(await redisUserStore.findById(user.id)).not.toBeNull();
    expect(await tusEngine.getSession(mine.id)).not.toBeNull();
    expect(await tusEngine.getSession(theirs.id)).not.toBeNull();
    await tusEngine.terminateSession(mine.id);
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
    const stagedUploadKey = `uploads/${user.id}/everything-staged.csv`;
    await storageProvider.saveObject(stagedUploadKey, Buffer.from('a\n1\n'), 'text/csv', 'everything-staged.csv');
    await registerCompletedUpload(storageProvider, stagedUploadKey, { jobInput: true });
    const toolJobId = `tool_${crypto.randomUUID()}`;
    needles.push(toolJobId);
    const toolInputKey = `uploads/${user.id}/tool_${toolJobId}_in.pdf`;
    const toolResultKey = `conversions/${user.id}/tool_${toolJobId}_out.pdf`;
    await storageProvider.saveObject(toolInputKey, Buffer.from('%PDF-1.4\n'), 'application/pdf', 'in.pdf');
    await saveRetainedResult(storageProvider, toolResultKey, Buffer.from('%PDF-1.4\n'), 'application/pdf', 'out.pdf');
    await saveToolJob({
      id: toolJobId,
      userId: user.id,
      tool: 'merge',
      status: 'completed',
      progress: 100,
      inputKeys: [toolInputKey],
      result: { kind: 'file', file: { name: 'out.pdf', size: 9, key: toolResultKey, url: `/api/storage/file/${encodeURIComponent(toolResultKey)}` } },
      createdAt: Date.now(),
    });
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
    const safeTag = user.id.replace(/[{}]/g, '_');
    const bulkPipe = client.pipeline();
    for (let i = 0; i < 1_200; i++) {
      bulkPipe.sadd(`webhook:sec-endpoints:{${safeTag}}`, `probe_${i}`);
      bulkPipe.set(`webhook:sec:{${safeTag}}:probe_${i}`, '1');
    }
    await bulkPipe.exec();

    expect((await recordsNaming(needles)).length).toBeGreaterThan(10);

    const plan = await planAccountErasure(user.id);
    expect(await eraseAccount(plan!, { drainMs: 0 })).toEqual({ runningJobIds: [] });

    expect(await recordsNaming(needles)).toEqual([]);
    expect(await storageProvider.getObject(uploadKey)).toBeUndefined();
    expect(await storageProvider.getObject(stagedUploadKey)).toBeUndefined();
    expect(await storageProvider.getObject(toolInputKey)).toBeUndefined();
    expect(await storageProvider.getObject(toolResultKey)).toBeUndefined();
    expect(await getRetentionLedger().get(stagedUploadKey)).toBeUndefined();
    expect(await getToolJob(toolJobId)).toBeNull();
    expect(await storageProvider.getObject(graphResult)).toBeUndefined();
  }, 60_000);
});

describe('the webhook deliveries of an erased account', () => {
  function delivery(ownerUserId: string): WebhookJobData {
    return {
      deliveryId: `wh_erase_${crypto.randomBytes(4).toString('hex')}`,
      targetUrl: 'https://93.184.215.14/hook',
      event: 'job.completed',
      data: { jobId: 'j' },
      secret: '',
      options: { ownerUserId },
      attemptNumber: 1,
      attempts: [],
      createdAt: Date.now(),
    };
  }

  it('removes waiting, active and delayed deliveries of the erased account and leaves other accounts intact', async () => {
    const gone = await newAccount('hooks-gone');
    const kept = await newAccount('hooks-kept');
    const queue = webhookDispatcher.getQueue();
    const activeCandidate = await queue.add('webhook:delivery', delivery(gone.id));
    let popped = await queue._popNextWaiting?.();
    for (let taken = 0; popped && popped.id !== activeCandidate.id && taken < 500; taken++) popped = await queue._popNextWaiting?.();
    expect(popped?.id).toBe(activeCandidate.id);
    if (popped && popped.state !== 'active') popped.state = 'active';
    expect((await queue.getJob(activeCandidate.id))?.state).toBe('active');
    const waiting = await queue.add('webhook:delivery', delivery(gone.id));
    const delayed = await queue.add('webhook:delivery', delivery(gone.id), { delay: 60 * 60 * 1000 });
    const others = await queue.add('webhook:delivery', delivery(kept.id));
    try {
      await eraseAccount((await planAccountErasure(gone.id))!, { drainMs: 0 });

      expect(await queue.getJob(waiting.id)).toBeUndefined();
      expect(await queue.getJob(delayed.id)).toBeUndefined();
      expect(await queue.getJob(activeCandidate.id)).toBeUndefined();
      expect(await queue.getJob(others.id)).toBeDefined();
    } finally {
      await queue.remove(waiting.id).catch(() => undefined);
      await queue.remove(delayed.id).catch(() => undefined);
      await queue.remove(activeCandidate.id).catch(() => undefined);
      await queue.remove(others.id).catch(() => undefined);
    }
  });
});

describe('staged uploads and tool_job records of an erased account', () => {
  it('deletes uploads/<userId>/... staged objects and ledger records while preserving another account', async () => {
    const gone = await newAccount('staged-gone');
    const kept = await newAccount('staged-kept');
    const goneStaged = `uploads/${gone.id}/sync_staged.csv`;
    const goneLedgerStaged = `uploads/${gone.id}/direct_staged.csv`;
    const keptStaged = `uploads/${kept.id}/sync_staged.csv`;

    await storageProvider.saveObject(goneStaged, Buffer.from('a,b\n1,2\n'), 'text/csv', 'sync_staged.csv');
    await storageProvider.saveObject(goneLedgerStaged, Buffer.from('c,d\n3,4\n'), 'text/csv', 'direct_staged.csv');
    await registerCompletedUpload(storageProvider, goneLedgerStaged, { jobInput: true });
    await storageProvider.saveObject(keptStaged, Buffer.from('e,f\n5,6\n'), 'text/csv', 'sync_staged.csv');
    await registerCompletedUpload(storageProvider, keptStaged, { jobInput: true });

    try {
      const plan = (await planAccountErasure(gone.id))!;
      expect(plan.storedKeys).toContain(goneLedgerStaged);
      await eraseAccount(plan, { drainMs: 0 });

      expect(await storageProvider.getObject(goneStaged)).toBeUndefined();
      expect(await storageProvider.getObject(goneLedgerStaged)).toBeUndefined();
      expect(await getRetentionLedger().get(goneLedgerStaged)).toBeUndefined();
      expect(await storageProvider.getObject(keptStaged)).toBeDefined();
      expect(await getRetentionLedger().get(keptStaged)).toBeDefined();
    } finally {
      await storageProvider.deleteObject(keptStaged);
      await getRetentionLedger().forget(keptStaged);
    }
  });

  it('aborts local tool jobs, deletes tool_job state, index, inputs and outputs while preserving another account', async () => {
    const gone = await newAccount('tool-gone');
    const kept = await newAccount('tool-kept');
    const goneId = `tool_${crypto.randomUUID()}`;
    const keptId = `tool_${crypto.randomUUID()}`;
    const goneInput = `uploads/${gone.id}/tool_${goneId}_0_a.pdf`;
    const goneEntry = `conversions/${gone.id}/tool_${goneId}_page1.png`;
    const keptInput = `uploads/${kept.id}/tool_${keptId}_0_b.pdf`;
    const keptResult = `conversions/${kept.id}/tool_${keptId}_out.pdf`;

    await storageProvider.saveObject(goneInput, Buffer.from('%PDF-1.4\n'), 'application/pdf', 'a.pdf');
    await saveRetainedResult(storageProvider, goneEntry, Buffer.from('png'), 'image/png', 'page1.png');
    await storageProvider.saveObject(keptInput, Buffer.from('%PDF-1.4\n'), 'application/pdf', 'b.pdf');
    await saveRetainedResult(storageProvider, keptResult, Buffer.from('%PDF-1.4\n'), 'application/pdf', 'out.pdf');

    const abortController = registerLocalToolAbort(goneId);
    await saveToolJob({
      id: goneId,
      userId: gone.id,
      tool: 'archive-extract',
      status: 'running',
      progress: 50,
      inputKeys: [goneInput],
      result: { kind: 'entries', entries: [{ name: 'page1.png', size: 3, mimeType: 'image/png', key: goneEntry, url: `/api/storage/file/${encodeURIComponent(goneEntry)}` }] },
      createdAt: Date.now(),
    });
    await saveToolJob({
      id: keptId,
      userId: kept.id,
      tool: 'merge',
      status: 'completed',
      progress: 100,
      inputKeys: [keptInput],
      result: { kind: 'file', file: { name: 'out.pdf', size: 9, key: keptResult, url: `/api/storage/file/${encodeURIComponent(keptResult)}` } },
      createdAt: Date.now(),
    });

    try {
      await eraseAccount((await planAccountErasure(gone.id))!, { drainMs: 0 });

      expect(abortController.signal.aborted).toBe(true);
      expect(await getToolJob(goneId)).toBeNull();
      expect(await storageProvider.getObject(goneInput)).toBeUndefined();
      expect(await storageProvider.getObject(goneEntry)).toBeUndefined();
      expect(await getRetentionLedger().get(goneEntry)).toBeUndefined();

      const redis = redisKeyStore.getRedisClient();
      if (redis) {
        const prefix = redisKeyStore.getPrefix();
        expect(await redis.smembers(`${prefix}user:tool_jobs:${gone.id}`)).toEqual([]);
        expect(await redis.get(`${prefix}tool_job:${goneId}`)).toBeNull();
        expect(await redis.smembers(`${prefix}user:tool_jobs:${kept.id}`)).toContain(keptId);
      }

      expect(await getToolJob(keptId)).toMatchObject({ id: keptId, userId: kept.id });
      expect(await storageProvider.getObject(keptInput)).toBeDefined();
      expect(await storageProvider.getObject(keptResult)).toBeDefined();
    } finally {
      await storageProvider.deleteObject(keptInput);
      await storageProvider.deleteObject(keptResult);
      await getRetentionLedger().forget(keptResult);
    }
  });

  it('maintains per-user Redis tool_job set indices for saveToolJob, deleteToolJob, accountTaggedKeys and eraseUserToolJobs', async () => {
    const kv = new Map<string, string>();
    const sets = new Map<string, Set<string>>();
    const ttls = new Map<string, number>();

    const fakeRedis = {
      get: async (key: string) => kv.get(key) ?? null,
      set: async (key: string, val: string, _ex?: string, ttl?: number, flag?: string) => {
        if (flag === 'XX' && !kv.has(key)) {
          return null;
        }
        kv.set(key, val);
        if (ttl !== undefined) ttls.set(key, ttl);
        return 'OK';
      },
      sadd: async (key: string, member: string) => {
        const set = sets.get(key) ?? new Set<string>();
        const before = set.size;
        set.add(member);
        sets.set(key, set);
        return set.size - before;
      },
      srem: async (key: string, member: string) => {
        const set = sets.get(key);
        return set && set.delete(member) ? 1 : 0;
      },
      smembers: async (key: string) => [...(sets.get(key) ?? [])],
      expire: async (key: string, ttl: number) => {
        ttls.set(key, ttl);
        return 1;
      },
      exists: async (key: string) => (kv.has(key) || sets.has(key) ? 1 : 0),
      del: async (...keys: string[]) => {
        let removed = 0;
        for (const key of keys) {
          if (kv.delete(key)) removed++;
          if (sets.delete(key)) removed++;
        }
        return removed;
      },
      zrange: async () => [],
      pipeline: () => {
        const ops: Array<() => Promise<unknown>> = [];
        const pipe = {
          set: (key: string, val: string, ex?: string, ttl?: number) => {
            ops.push(() => fakeRedis.set(key, val, ex, ttl));
            return pipe;
          },
          sadd: (key: string, member: string) => {
            ops.push(() => fakeRedis.sadd(key, member));
            return pipe;
          },
          expire: (key: string, ttl: number) => {
            ops.push(() => fakeRedis.expire(key, ttl));
            return pipe;
          },
          exists: (key: string) => {
            ops.push(() => fakeRedis.exists(key));
            return pipe;
          },
          exec: async () => {
            const results: Array<[null, unknown]> = [];
            for (const op of ops) results.push([null, await op()]);
            return results;
          },
        };
        return pipe;
      },
    };

    const clientSpy = vi.spyOn(redisKeyStore, 'getRedisClient').mockReturnValue(fakeRedis as never);
    const listKeysSpy = vi.spyOn(redisKeyStore, 'listApiKeys').mockResolvedValue([]);
    const listFilesSpy = vi.spyOn(redisKeyStore, 'listUserFiles').mockResolvedValue([]);
    try {
      const aliceId = `user_${crypto.randomUUID()}`;
      const anonId = anonymousUserId('203.0.113.50');
      const prefix = redisKeyStore.getPrefix();
      const job1 = `tool_${crypto.randomUUID()}`;
      const job2 = `tool_${crypto.randomUUID()}`;
      const anonJob = `tool_${crypto.randomUUID()}`;

      await saveToolJob({
        id: job1,
        userId: aliceId,
        tool: 'merge',
        status: 'completed',
        progress: 100,
        inputKeys: [`uploads/${aliceId}/a.pdf`],
        result: { kind: 'file', file: { name: 'out.pdf', size: 1, key: `conversions/${aliceId}/out.pdf`, url: '/x' } },
        createdAt: Date.now(),
      });
      await saveToolJob({
        id: job2,
        userId: aliceId,
        tool: 'split',
        status: 'queued',
        progress: 0,
        createdAt: Date.now(),
      });
      await saveToolJob({
        id: anonJob,
        userId: anonId,
        tool: 'merge',
        status: 'queued',
        progress: 0,
        createdAt: Date.now(),
      });

      const indexKey = userToolJobsKey(aliceId);
      expect(sets.get(indexKey)).toEqual(new Set([job1, job2]));
      expect(ttls.get(indexKey)).toBe(3600);
      expect(sets.has(userToolJobsKey(anonId))).toBe(false);

      const tagged = await accountTaggedKeys(aliceId);
      expect(tagged).toContain(indexKey);
      expect(tagged).toContain(`${prefix}tool_job:${job1}`);
      expect(tagged).toContain(`${prefix}tool_job:${job2}`);

      await deleteToolJob(job2);
      expect(sets.get(indexKey)).toEqual(new Set([job1]));
      expect(kv.has(`${prefix}tool_job:${job2}`)).toBe(false);

      const current1 = (await getToolJob(job1))!;
      expect(
        await updateExistingToolJob({
          ...current1,
          status: 'running',
          progress: 50,
        })
      ).toBe(true);
      expect(JSON.parse(kv.get(`${prefix}tool_job:${job1}`)!)).toMatchObject({ status: 'running', progress: 50 });

      const erased = await eraseUserToolJobs(aliceId);
      expect(erased.jobIds).toEqual([job1]);
      expect(erased.storageKeys.sort()).toEqual([`conversions/${aliceId}/out.pdf`, `uploads/${aliceId}/a.pdf`]);
      expect(kv.has(`${prefix}tool_job:${job1}`)).toBe(false);
      expect(sets.has(indexKey)).toBe(false);

      expect(
        await updateExistingToolJob({
          id: job1,
          userId: aliceId,
          tool: 'merge',
          status: 'completed',
          progress: 100,
          createdAt: Date.now(),
        })
      ).toBe(false);
      expect(kv.has(`${prefix}tool_job:${job1}`)).toBe(false);
      expect(sets.has(indexKey)).toBe(false);
    } finally {
      listFilesSpy.mockRestore();
      listKeysSpy.mockRestore();
      clientSpy.mockRestore();
    }
  });

  it('records staged inputKeys on queued POST /api/tools/jobs and deletes them on account erasure', async () => {
    const user = await redisUserStore.createUser({
      email: `queued-tool_${crypto.randomUUID()}@complete.test`,
      name: 'queued-tool',
      emailVerified: true,
      acceptedTermsVersion: TERMS_VERSION,
    });
    createdUsers.push(user.id);
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'queued tool key', {
      scopes: ['convert:write', 'convert:read'],
    });
    const doc = await PDFDocument.create();
    doc.addPage([100, 100]);
    const pdfBytes = new Uint8Array(await doc.save());

    await registerLiveWorkerHeartbeat('erase-queued-tool-worker');
    try {
      const form = new FormData();
      form.set('tool', 'merge');
      form.append('files', new File([pdfBytes], 'first.pdf', { type: 'application/pdf' }));
      form.append('files', new File([pdfBytes], 'second.pdf', { type: 'application/pdf' }));

      const res = await toolJobsPost(
        new NextRequest('http://localhost:3000/api/tools/jobs', {
          method: 'POST',
          headers: { Authorization: `Bearer ${secretKey}` },
          body: form,
        })
      );
      expect(res.status).toBe(201);
      const { id: toolJobId } = (await res.json()) as { id: string };

      const saved = await getToolJob(toolJobId);
      expect(saved?.inputKeys?.length).toBe(2);
      for (const key of saved?.inputKeys ?? []) {
        expect(key).toMatch(new RegExp(`^uploads/${user.id}/tool_${toolJobId}_`));
        expect(await storageProvider.getObject(key)).toBeDefined();
      }

      await eraseAccount((await planAccountErasure(user.id))!, { drainMs: 0 });

      expect(await getToolJob(toolJobId)).toBeNull();
      for (const key of saved?.inputKeys ?? []) {
        expect(await storageProvider.getObject(key)).toBeUndefined();
      }
    } finally {
      await unregisterLiveWorkerHeartbeat('erase-queued-tool-worker');
      resetLocalLiveWorkersForTests();
    }
  });

  it('aborts and drains running launchLocalToolJob and discards late outputs if tool_job was already erased', async () => {
    const user = await redisUserStore.createUser({
      email: `local-drain_${crypto.randomUUID()}@complete.test`,
      name: 'local-drain',
      emailVerified: true,
      acceptedTermsVersion: TERMS_VERSION,
    });
    createdUsers.push(user.id);
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'local drain key', {
      scopes: ['convert:write', 'convert:read'],
    });
    const doc = await PDFDocument.create();
    doc.addPage([100, 100]);
    const pdfBytes = new Uint8Array(await doc.save());

    // 1) Normal abort + drain: eraseAccount aborts the local run and waits for it to settle.
    let markStarted!: () => void;
    const runStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let runSettled = false;
    const runSpy = vi.spyOn(webToolsMod, 'runWebTool').mockImplementation((async (_tool, _files, _opts, signal) => {
      markStarted();
      await new Promise<void>((_, reject) => {
        signal?.addEventListener(
          'abort',
          () => {
            setTimeout(() => {
              runSettled = true;
              reject(new Error('aborted'));
            }, 30);
          },
          { once: true }
        );
      });
      return webToolsMod.fileOutput('unreachable.pdf', 'application/pdf', Buffer.from('%PDF-1.4\n'));
    }) as typeof webToolsMod.runWebTool);

    const form = new FormData();
    form.set('tool', 'merge');
    form.append('files', new File([pdfBytes], 'a.pdf', { type: 'application/pdf' }));
    form.append('files', new File([pdfBytes], 'b.pdf', { type: 'application/pdf' }));

    const res1 = await toolJobsPost(
      new NextRequest('http://localhost:3000/api/tools/jobs', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secretKey}` },
        body: form,
      })
    );
    expect(res1.status).toBe(201);
    const { id: drainedJobId } = (await res1.json()) as { id: string };
    await runStarted;

    const outcome1 = await eraseAccount((await planAccountErasure(user.id))!, { drainMs: 500 });
    expect(outcome1).toEqual({ runningJobIds: [] });
    expect(runSettled).toBe(true);
    expect(await getToolJob(drainedJobId)).toBeNull();
    runSpy.mockRestore();

    // 2) Late completion after tool_job deletion must not resurrect tool_job or leak output in conversions/<userId>/...
    const user2 = await redisUserStore.createUser({
      email: `local-late_${crypto.randomUUID()}@complete.test`,
      name: 'local-late',
      emailVerified: true,
      acceptedTermsVersion: TERMS_VERSION,
    });
    createdUsers.push(user2.id);
    const { secretKey: secretKey2 } = await redisKeyStore.generateApiKey(user2.id, 'local late key', {
      scopes: ['convert:write', 'convert:read'],
    });
    const realSaveObject = storageProvider.saveObject.bind(storageProvider);
    const savedKeysBefore = vi.spyOn(storageProvider, 'saveObject');
    let markStarted2!: () => void;
    const runStarted2 = new Promise<void>((resolve) => {
      markStarted2 = resolve;
    });
    let releaseLateRun!: (val: webToolsMod.WebToolOutput) => void;
    const lateOutputPromise = new Promise<webToolsMod.WebToolOutput>((resolve) => {
      releaseLateRun = resolve;
    });
    const runSpy2 = vi.spyOn(webToolsMod, 'runWebTool').mockImplementation((async () => {
      markStarted2();
      return lateOutputPromise;
    }) as typeof webToolsMod.runWebTool);

    const form2 = new FormData();
    form2.set('tool', 'merge');
    form2.append('files', new File([pdfBytes], 'c.pdf', { type: 'application/pdf' }));
    form2.append('files', new File([pdfBytes], 'd.pdf', { type: 'application/pdf' }));

    const res2 = await toolJobsPost(
      new NextRequest('http://localhost:3000/api/tools/jobs', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secretKey2}` },
        body: form2,
      })
    );
    expect(res2.status).toBe(201);
    const { id: lateJobId } = (await res2.json()) as { id: string };
    await runStarted2;

    const pendingOutcome = await eraseAccount((await planAccountErasure(user2.id))!, { drainMs: 10 });
    expect(pendingOutcome.runningJobIds).toContain(lateJobId);
    expect(await redisUserStore.findById(user2.id)).not.toBeNull();

    // Release the late local run after abort was already triggered: afterRun check stops before writing outputs.
    releaseLateRun(webToolsMod.fileOutput('late-local.pdf', 'application/pdf', Buffer.from('%PDF-1.4\n')));
    await vi.waitFor(async () => {
      expect((await eraseAccount((await planAccountErasure(user2.id))!, { drainMs: 20 }))).toEqual({ runningJobIds: [] });
    });
    expect(
      savedKeysBefore.mock.calls.filter(([k]) => String(k).startsWith(`conversions/${user2.id}/`))
    ).toEqual([]);
    expect(await getToolJob(lateJobId)).toBeNull();
    savedKeysBefore.mockRestore();
    runSpy2.mockRestore();

    // 3) If tool_job is erased after afterRun passes and while storeToolOutput writes, discardToolOutputs removes the output.
    const user3 = await redisUserStore.createUser({
      email: `local-race_${crypto.randomUUID()}@complete.test`,
      name: 'local-race',
      emailVerified: true,
      acceptedTermsVersion: TERMS_VERSION,
    });
    createdUsers.push(user3.id);
    const { secretKey: secretKey3 } = await redisKeyStore.generateApiKey(user3.id, 'local race key', {
      scopes: ['convert:write', 'convert:read'],
    });
    let erasedDuringStore = false;
    const raceSaveSpy = vi.spyOn(storageProvider, 'saveObject').mockImplementation((async (...args) => {
      const key = String(args[0]);
      const res = await realSaveObject(...args);
      if (!erasedDuringStore && key.startsWith(`conversions/${user3.id}/`)) {
        erasedDuringStore = true;
        await eraseUserToolJobs(user3.id);
      }
      return res;
    }) as typeof storageProvider.saveObject);
    vi.spyOn(webToolsMod, 'runWebTool').mockResolvedValue(
      webToolsMod.fileOutput('race-local.pdf', 'application/pdf', Buffer.from('%PDF-1.4\n'))
    );

    const form3 = new FormData();
    form3.set('tool', 'merge');
    form3.append('files', new File([pdfBytes], 'e.pdf', { type: 'application/pdf' }));
    form3.append('files', new File([pdfBytes], 'f.pdf', { type: 'application/pdf' }));

    const res3 = await toolJobsPost(
      new NextRequest('http://localhost:3000/api/tools/jobs', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secretKey3}` },
        body: form3,
      })
    );
    expect(res3.status).toBe(201);
    const { id: raceJobId } = (await res3.json()) as { id: string };

    await vi.waitFor(async () => {
      expect(erasedDuringStore).toBe(true);
      const savedOutputKeys = raceSaveSpy.mock.calls
        .map(([k]) => String(k))
        .filter((k) => k.startsWith(`conversions/${user3.id}/`));
      expect(savedOutputKeys.length).toBeGreaterThan(0);
      for (const outKey of savedOutputKeys) {
        expect(await storageProvider.getObject(outKey)).toBeUndefined();
        expect(await getRetentionLedger().get(outKey)).toBeUndefined();
      }
    });
    expect(await getToolJob(raceJobId)).toBeNull();
    expect(await eraseAccount((await planAccountErasure(user3.id))!, { drainMs: 50 })).toEqual({ runningJobIds: [] });
  });

  it('discards queued tool outputs and avoids resurrecting tool_job when processQueuedToolJob finishes after erasure', async () => {
    const user = await newAccount('queued-runner-erased');
    const jobId = `tool_${crypto.randomUUID()}`;
    const inputKey = `uploads/${user.id}/tool_${jobId}_0_a.pdf`;
    const doc = await PDFDocument.create();
    doc.addPage([100, 100]);
    const pdfBytes = Buffer.from(await doc.save());
    await storageProvider.saveObject(inputKey, pdfBytes, 'application/pdf', 'a.pdf');
    await saveToolJob({
      id: jobId,
      userId: user.id,
      tool: 'rotate',
      status: 'queued',
      progress: 0,
      inputKeys: [inputKey],
      createdAt: Date.now(),
    });

    const realSaveObject = storageProvider.saveObject.bind(storageProvider);
    let erasedDuringQueuedStore = false;
    const saveSpy = vi.spyOn(storageProvider, 'saveObject').mockImplementation((async (...args) => {
      const key = String(args[0]);
      const res = await realSaveObject(...args);
      if (!erasedDuringQueuedStore && key.startsWith(`conversions/${user.id}/`)) {
        erasedDuringQueuedStore = true;
        await eraseUserToolJobs(user.id);
      }
      return res;
    }) as typeof storageProvider.saveObject);
    vi.spyOn(webToolsMod, 'runWebTool').mockResolvedValue(
      webToolsMod.fileOutput('late-queued.pdf', 'application/pdf', pdfBytes)
    );

    const fakeJob = {
      id: jobId,
      name: 'convert',
      data: {
        jobId,
        originalFilename: 'rotate',
        sourceFormat: 'pdf',
        targetFormat: 'pdf',
        fileSize: pdfBytes.length,
        options: {},
        userId: user.id,
        toolJob: {
          tool: 'rotate',
          options: { angle: 90 },
          storedRefs: [{ key: inputKey, name: 'a.pdf' }],
          cleanupUploadKeys: [inputKey],
        },
      } as ConversionJobData,
      timestamp: Date.now(),
      attemptsMade: 0,
      opts: { attempts: 1 },
      progress: 0,
    } as unknown as Job<ConversionJobData, ConversionJobResult>;

    await expect(processQueuedToolJob(fakeJob, storageProvider)).rejects.toBeInstanceOf(JobCancelledError);
    expect(erasedDuringQueuedStore).toBe(true);
    expect(await getToolJob(jobId)).toBeNull();
    expect(await storageProvider.getObject(inputKey)).toBeUndefined();
    const outputKeys = saveSpy.mock.calls.map(([k]) => String(k)).filter((k) => k.startsWith(`conversions/${user.id}/`));
    expect(outputKeys.length).toBeGreaterThan(0);
    for (const outKey of outputKeys) {
      expect(await storageProvider.getObject(outKey)).toBeUndefined();
      expect(await getRetentionLedger().get(outKey)).toBeUndefined();
    }
  });
});
