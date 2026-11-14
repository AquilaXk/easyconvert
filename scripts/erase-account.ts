import { deleteAuthTokensOfUser } from '../src/lib/auth/auth-email-token-store';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { billingMonthWindow, calendarMonthWindow, dayWindow } from '../src/lib/api-keys/quota-window';
import { isEntitlingStatus } from '../src/lib/billing/entitlement';
import { subscriptionStore } from '../src/lib/billing/subscription-store';
import type { SubscriptionRecord } from '../src/lib/billing/types';
import { getWebhookSecretStore } from '../src/lib/api-keys/webhook-secret-store';
import { webhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';
import { resetLoginAttempts } from '../src/lib/auth/login-rate-limiter';
import { allConversionQueues, conversionQueue } from '../src/lib/queue/conversion-queue';
import { graphScheduler } from '../src/lib/queue/graph/scheduler';
import { CANCELLABLE_JOB_STATES, DEFAULT_QUEUE_KEY_PREFIX, HEARTBEAT_INTERVAL_MS, type JobState } from '../src/lib/queue/bullmq-engine';
import { userByStateKeys } from '../src/lib/queue/user-job-list';
import { storageProvider } from '../src/lib/storage';
import { tusEngine } from '../src/lib/storage/tus-engine';
import { credentialsVault } from '../src/lib/storage/credentials-vault';
import { getRetentionLedger } from '../src/lib/storage/retention-ledger';

export interface AccountErasurePlan {
  userId: string;
  email: string;
  apiKeyIds: string[];
  credentialIds: string[];
  graphIds: string[];
  jobs: { id: string; state: JobState }[];
  tusSessionIds: string[];
  /** The multipart uploads the account has open in the store (a direct upload in parts, or an upload through `/api/storage/multipart`). */
  uploadSessionIds: string[];
  storedKeys: string[];
  deadLetters: number;
  /** The subscription record of the account; the customer and the subscription stay with the payment provider, which this script never calls. */
  subscription: SubscriptionRecord | null;
  /** The package credits the account holds; they are deleted with it and the payment provider is not told, so a customer who paid for them is owed an answer before the erasure. */
  packageCredits: number;
  taggedKeys: string[];
}

export interface AccountErasureOutcome {
  /** Jobs that were still running and were only cancelled; a later run removes them, and the account with them. */
  runningJobIds: string[];
}

const MAX_JOBS_PER_RUN = 10_000;
/** Keys one DEL or EXISTS batch names: a command with tens of thousands of arguments is refused by the client and blocks the server. */
const DELETE_BATCH = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
const QUOTA_HISTORY_DAYS = 40;
const QUOTA_HISTORY_MONTHS = 3;
const UPLOAD_COMPLETION_PREFIX = 'upload-completion/';
const RECEIPT_READ_BATCH = 50;
const WEBHOOK_JOB_STATES: readonly JobState[] = ['waiting', 'delayed', 'completed', 'failed', 'cancelled'];
/**
 * How long the erasure waits after it cancelled a job that was running. A cancelled job leaves the store at once, but the worker
 * that runs it learns of it at its next heartbeat (HEARTBEAT_INTERVAL_MS) and may write one more output until it stops, so the files
 * are deleted only after two heartbeats.
 */
const DEFAULT_DRAIN_MS = HEARTBEAT_INTERVAL_MS * 2;

export interface AccountErasureOptions {
  /** The wait after cancelling a running job, in milliseconds; the default is two heartbeats of the queue. */
  drainMs?: number;
}

/** Deletes `keys` in commands of at most DELETE_BATCH keys. */
export async function deleteKeysInBatches(client: { del(...keys: string[]): Promise<number> }, keys: readonly string[]): Promise<void> {
  for (let at = 0; at < keys.length; at += DELETE_BATCH) await client.del(...keys.slice(at, at + DELETE_BATCH));
}

async function findAccount(idOrEmail: string) {
  return idOrEmail.includes('@') ? redisUserStore.findByEmail(idOrEmail) : redisUserStore.findById(idOrEmail);
}

type RedisClientLike = NonNullable<ReturnType<typeof redisKeyStore.getRedisClient>>;

interface TaggedKeyContext {
  apiKeyIds?: readonly string[];
  uploadSessionIds?: readonly string[];
  tusSessionIds?: readonly string[];
  periodEnd?: number;
}

function quotaWindowKeys(periodEnd?: number): string[] {
  const now = Date.now();
  const keys = new Set<string>();
  for (let d = 0; d <= QUOTA_HISTORY_DAYS; d++) {
    keys.add(dayWindow(now - d * DAY_MS).key);
  }
  const today = new Date(now);
  for (let m = 0; m <= QUOTA_HISTORY_MONTHS; m++) {
    keys.add(calendarMonthWindow(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - m, 1)).key);
  }
  if (periodEnd !== undefined) {
    const currentBilling = billingMonthWindow(periodEnd, now);
    if (currentBilling) keys.add(currentBilling.key);
    const priorBilling = billingMonthWindow(periodEnd, now - 32 * DAY_MS);
    if (priorBilling) keys.add(priorBilling.key);
  }
  return [...keys];
}

async function filterExistingKeys(client: RedisClientLike, candidates: Iterable<string>): Promise<string[]> {
  const unique = [...new Set(candidates)];
  if (unique.length === 0) return [];
  const present: string[] = [];
  const hasPipeline = typeof (client as { pipeline?: unknown }).pipeline === 'function';
  for (let at = 0; at < unique.length; at += DELETE_BATCH) {
    const batch = unique.slice(at, at + DELETE_BATCH);
    if (hasPipeline) {
      const pipeline = client.pipeline();
      for (const key of batch) pipeline.exists(key);
      const replies = await pipeline.exec();
      if (!replies) throw new Error('Redis pipeline returned null while checking account keys');
      for (let i = 0; i < batch.length; i++) {
        const [err, count] = replies[i] ?? [];
        if (err) throw err;
        if (Number(count) > 0) present.push(batch[i]!);
      }
    } else {
      const counts = await Promise.all(batch.map((key) => client.exists(key)));
      for (let i = 0; i < batch.length; i++) {
        if (Number(counts[i]) > 0) present.push(batch[i]!);
      }
    }
  }
  return present.sort((a, b) => a.localeCompare(b));
}

async function accountTaggedKeys(userId: string, context: TaggedKeyContext = {}): Promise<string[]> {
  const client = redisKeyStore.getRedisClient();
  if (!client) return [];
  const prefix = redisKeyStore.getPrefix?.() ?? 'easyconvert:';
  const safeUser = userId.replace(/[{}]/g, '_');
  const candidates = new Set<string>();
  const maybeClient = client as Partial<Pick<RedisClientLike, 'zrange' | 'smembers' | 'get'>>;

  const apiKeyIds = context.apiKeyIds ?? (await redisKeyStore.listApiKeys(userId)).map((key) => key.id);
  for (const keyId of apiKeyIds) {
    candidates.add(`${prefix}apikeys:${keyId}`);
    candidates.add(`${prefix}rate:apikey:${keyId}`);
    candidates.add(`webhook:sec:{${safeUser}}:${keyId}`);
  }

  const userFilesKey = `${prefix}user_files:{${userId}}`;
  candidates.add(userFilesKey);
  if (typeof maybeClient.zrange === 'function') {
    const fileIds = await maybeClient.zrange(userFilesKey, '0', '-1');
    for (const fileId of fileIds) candidates.add(`${prefix}user_file:{${userId}}:${fileId}`);
  }
  for (const file of await redisKeyStore.listUserFiles(userId)) {
    candidates.add(`${prefix}user_file:{${userId}}:${file.id}`);
  }

  candidates.add(`${prefix}usage:{${userId}}`);
  for (const windowKey of quotaWindowKeys(context.periodEnd)) {
    candidates.add(`${prefix}usage:{${userId}}:${windowKey}`);
    candidates.add(`${prefix}leases:{${userId}}:${windowKey}`);
    candidates.add(`${prefix}held:{${userId}}:${windowKey}`);
    candidates.add(`${prefix}limits:{${userId}}:${windowKey}`);
  }

  for (const suffix of ['', ':plist', ':pholds', ':debt', ':log', ':txns', ':adj']) {
    candidates.add(`${prefix}credits:{${userId}}${suffix}`);
  }

  const uploadBuckets = [`uploads:${userId}`, userId];
  for (const bucket of uploadBuckets) {
    const bucketKey = `${prefix}upload-budget:{${bucket}}`;
    candidates.add(bucketKey);
    if (typeof maybeClient.get === 'function') {
      const raw = await maybeClient.get(bucketKey);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as { open?: Record<string, { uploadId?: unknown }> };
          if (parsed.open && typeof parsed.open === 'object') {
            for (const [openId, entry] of Object.entries(parsed.open)) {
              candidates.add(`${prefix}upload-budget-link:${openId}`);
              if (entry && typeof entry.uploadId === 'string') {
                candidates.add(`${prefix}upload-budget-link:${entry.uploadId}`);
              }
            }
          }
        } catch {
          // ignore malformed upload budget JSON
        }
      }
    }
    const linksKey = `${prefix}upload-budget-links:{${bucket}}`;
    candidates.add(linksKey);
    if (typeof maybeClient.smembers === 'function') {
      for (const uploadId of await maybeClient.smembers(linksKey)) {
        candidates.add(`${prefix}upload-budget-link:${uploadId}`);
      }
    }
  }
  for (const sessionId of [...(context.uploadSessionIds ?? []), ...(context.tusSessionIds ?? [])]) {
    candidates.add(`${prefix}upload-budget-link:${sessionId}`);
  }

  candidates.add(`vault:user:{${safeUser}}`);
  candidates.add(`${prefix}vault:user:{${safeUser}}`);
  candidates.add(`easyconvert:webhook:dlq:owner:{${userId}}`);

  const secEndpointsKey = `webhook:sec-endpoints:{${safeUser}}`;
  candidates.add(secEndpointsKey);
  if (typeof maybeClient.smembers === 'function') {
    for (const targetId of await maybeClient.smembers(secEndpointsKey)) {
      candidates.add(`webhook:sec:{${safeUser}}:${targetId}`);
    }
  }

  candidates.add(`${prefix}rate:${userId}`);
  candidates.add(`${prefix}user_keys:${userId}`);
  candidates.add(`${prefix}user_graphs:{${userId}}`);

  const queueNames = new Set(['conversions', ...allConversionQueues.map((q) => q.name)]);
  const queuePrefixes = new Set([DEFAULT_QUEUE_KEY_PREFIX, `${prefix}queue:`]);
  for (const qPrefix of queuePrefixes) {
    candidates.add(`${qPrefix}user_graphs:{${userId}}`);
    for (const qName of queueNames) {
      const userJobsKey = `${qPrefix}{${qName}}:user_jobs:${userId}`;
      candidates.add(`${qPrefix}{${qName}}:user_inflight:${userId}`);
      candidates.add(userJobsKey);
      for (const byStateKey of userByStateKeys(userJobsKey)) {
        candidates.add(byStateKey);
      }
    }
  }

  return filterExistingKeys(client, candidates);
}

/**
 * The stored files of the account: the files the retention ledger holds under the account's prefix or a result of its jobs and
 * graphs, and the files its history names (a result whose job record is already gone).
 */
async function accountStoredKeys(
  userId: string,
  jobIds: readonly string[],
  graphIds: readonly string[],
  ledgerKeys?: readonly string[]
): Promise<string[]> {
  const prefixes = [
    `conversions/${userId}/`,
    ...jobIds.map((id) => `results/${id}/`),
    ...graphIds.map((id) => `results/${id}/`),
  ];
  const ledger = getRetentionLedger();
  const keys = ledgerKeys ?? (ledger.allKeys ? await ledger.allKeys() : (await ledger.liveRecords()).map((record) => record.key));
  const owned = keys.filter((key) => prefixes.some((prefix) => key.startsWith(prefix)));
  const named = (await redisKeyStore.listUserFiles(userId)).flatMap((file) => (file.storageKey ? [file.storageKey] : []));
  const history: string[] = [];
  for (const key of named) if (await Promise.resolve(storageProvider.stat(key)).catch(() => undefined)) history.push(key);
  return [...new Set([...owned, ...history])].sort((a, b) => a.localeCompare(b));
}

async function forgetUploadCompletionReceipts(
  ledger: ReturnType<typeof getRetentionLedger>,
  ledgerKeys: readonly string[],
  userId: string
): Promise<void> {
  const receiptKeys = ledgerKeys.filter((key) => key.startsWith(UPLOAD_COMPLETION_PREFIX));
  for (let at = 0; at < receiptKeys.length; at += RECEIPT_READ_BATCH) {
    const batch = receiptKeys.slice(at, at + RECEIPT_READ_BATCH);
    const records = ledger.getMany
      ? await ledger.getMany(batch)
      : await Promise.all(batch.map((key) => ledger.get(key)));
    for (let i = 0; i < batch.length; i++) {
      if (records[i]?.completion?.ownerUserId === userId) {
        await ledger.forget(batch[i]!);
      }
    }
  }
}

/** What erasing the account `idOrEmail` deletes, or undefined when there is no such account. Changes nothing. */
export async function planAccountErasure(idOrEmail: string): Promise<AccountErasurePlan | undefined> {
  const account = await findAccount(idOrEmail);
  if (!account) return undefined;
  const userId = account.id;
  const [keys, credentialIds, graphIds, jobs, letters, subscription, packageCredits, tusSessionIds, uploadSessionIds] = await Promise.all([
    redisKeyStore.listApiKeys(userId),
    credentialsVault.listByUser(userId),
    graphScheduler.graphsOfUser(userId),
    conversionQueue.getJobsByUser(userId, undefined, MAX_JOBS_PER_RUN, 0),
    webhookDispatcher.getDlqPage(userId, { includeExpired: true, limit: 1 }),
    subscriptionStore.findByUser(userId),
    redisKeyStore.packageBalance(userId),
    tusEngine.sessionsOfOwner(userId),
    storageProvider.uploadSessionsOfOwner?.(userId) ?? Promise.resolve([]),
  ]);
  const apiKeyIds = keys.map((key) => key.id);
  const [taggedKeys, storedKeys] = await Promise.all([
    accountTaggedKeys(userId, {
      apiKeyIds,
      tusSessionIds,
      uploadSessionIds,
      periodEnd: subscription?.currentPeriodEnd,
    }),
    accountStoredKeys(userId, jobs.map((job) => job.id), graphIds),
  ]);
  return {
    userId,
    email: account.email,
    apiKeyIds,
    credentialIds,
    graphIds,
    jobs: jobs.map((job) => ({ id: job.id, state: job.state })),
    tusSessionIds,
    uploadSessionIds,
    storedKeys,
    deadLetters: letters.total,
    subscription,
    packageCredits,
    taggedKeys,
  };
}

/** The graphs and jobs the account has now, so work started after the plan was made is found too. */
async function currentWork(plan: AccountErasurePlan): Promise<{ jobs: AccountErasurePlan['jobs']; graphIds: string[] }> {
  const listed = await conversionQueue.getJobsByUser(plan.userId, undefined, MAX_JOBS_PER_RUN, 0);
  const jobs = new Map(plan.jobs.map((job) => [job.id, job]));
  for (const job of listed) jobs.set(job.id, { id: job.id, state: job.state });
  const graphIds = new Set([...plan.graphIds, ...(await graphScheduler.graphsOfUser(plan.userId))]);
  for (const job of listed) if (job.data.graphId) graphIds.add(job.data.graphId);
  return { jobs: [...jobs.values()], graphIds: [...graphIds].sort((a, b) => a.localeCompare(b)) };
}

/** The ids of `jobs` that are still active, so cannot be removed. */
async function removeEndedJobs(jobIds: readonly string[]): Promise<string[]> {
  const running: string[] = [];
  for (const id of jobIds) {
    if (!(await conversionQueue.remove(id)) && (await conversionQueue.getJob(id))) running.push(id);
  }
  return running;
}

/** The rounds that look again for work started while the earlier rounds cancelled: a request authenticated before the keys went can still enqueue. */
const CANCEL_ROUNDS = 5;

/**
 * Cancels the graphs and jobs the account has, looking again after each round (and waiting for the workers of running ones) until
 * a round finds nothing new. Cancelling goes through the queue, so a job's quota is given back and the hold on its input ends.
 * Answers everything it saw.
 */
async function cancelAllWork(plan: AccountErasurePlan, drainMs: number): Promise<{ jobs: AccountErasurePlan['jobs']; graphIds: string[] }> {
  const jobs = new Map<string, AccountErasurePlan['jobs'][number]>();
  const graphIds = new Set<string>();
  for (let round = 0; round < CANCEL_ROUNDS; round++) {
    const current = await currentWork(plan);
    const freshJobs = current.jobs.filter((job) => !jobs.has(job.id));
    const freshGraphs = current.graphIds.filter((graphId) => !graphIds.has(graphId));
    if (round > 0 && freshJobs.length === 0 && freshGraphs.length === 0) break;
    for (const graphId of freshGraphs) {
      graphIds.add(graphId);
      await graphScheduler.cancelGraph(graphId, 'The account was deleted');
    }
    for (const job of freshJobs) {
      jobs.set(job.id, job);
      if (CANCELLABLE_JOB_STATES.has(job.state)) await conversionQueue.cancelJob(job.id, 'The account was deleted');
    }
    if (freshJobs.some((job) => job.state === 'active')) await new Promise((resolve) => setTimeout(resolve, drainMs));
  }
  return { jobs: [...jobs.values()], graphIds: [...graphIds].sort((a, b) => a.localeCompare(b)) };
}

/**
 * Erases the account in an order that lets nothing it started write after the erasure:
 * 1. the keys and sessions go first, so no request of the account starts new work;
 * 2. its graphs, jobs and open resumable uploads are cancelled, found again until a round finds nothing new, and when a job was
 *    running the erasure waits for its worker to notice (`drainMs`), because the files and records that job writes would be
 *    untraceable once the graph index is gone; its open multipart uploads are then aborted with the parts they hold (searched
 *    in the store by owner, after the wait, so one opened by a request the keys did not stop is found too);
 * 3. only then the graphs, files, history, counts and the keys tagged with the account (read again, not taken from the plan) go.
 * A job that is still active after the wait, one that the account's index names beyond the window this run reads (10,000) and one
 * queued after the last round leave the account, its graph index and its files in place for the next run: their ids are answered.
 */
export async function eraseAccount(plan: AccountErasurePlan, options: AccountErasureOptions = {}): Promise<AccountErasureOutcome> {
  const { userId } = plan;
  const keyIds = new Set([...plan.apiKeyIds, ...(await redisKeyStore.listApiKeys(userId)).map((key) => key.id)]);
  for (const keyId of keyIds) {
    await redisKeyStore.deleteApiKey(userId, keyId);
    await getWebhookSecretStore().deleteSecretRecord(userId, keyId);
  }
  await redisUserStore.incrementSessionVersion(userId);

  await tusEngine.terminateSessionsOfOwner(userId);
  for (const credentialId of new Set([...plan.credentialIds, ...(await credentialsVault.listByUser(userId))])) {
    await credentialsVault.delete(credentialId, userId);
  }
  const work = await cancelAllWork(plan, options.drainMs ?? DEFAULT_DRAIN_MS);
  await storageProvider.abortUploadSessionsOfOwner?.(userId);

  const stillActive = await removeEndedJobs(work.jobs.map((job) => job.id));
  if (stillActive.length > 0) return { runningJobIds: stillActive };

  for (const graphId of work.graphIds) {
    await graphScheduler.deleteGraph(graphId);
    await storageProvider.deleteByPrefix?.(`results/${graphId}/`);
    await storageProvider.deleteByPrefix?.(`intermediate/${graphId}/`);
  }
  const ledger = getRetentionLedger();
  const ledgerKeys = ledger.allKeys ? await ledger.allKeys() : (await ledger.liveRecords()).map((record) => record.key);
  for (const key of await accountStoredKeys(userId, work.jobs.map((job) => job.id), work.graphIds, ledgerKeys)) {
    await Promise.resolve(storageProvider.deleteObject(key)).catch(() => false);
    await ledger.forget(key);
  }
  await forgetUploadCompletionReceipts(ledger, ledgerKeys, userId);
  await storageProvider.deleteByPrefix?.(`conversions/${userId}/`);
  const left = (await conversionQueue.forgetUser?.(userId, new Set(work.jobs.map((job) => job.id)))) ?? [];
  if (left.length > 0) return { runningJobIds: left };

  await removeWebhookDeliveries(userId);
  await webhookDispatcher.clearDlq(userId, { strict: true });
  await redisKeyStore.forgetUsage(userId);
  const client = redisKeyStore.getRedisClient();
  if (client) {
    await deleteKeysInBatches(
      client,
      await accountTaggedKeys(userId, {
        apiKeyIds: [...keyIds],
        uploadSessionIds: plan.uploadSessionIds,
        tusSessionIds: plan.tusSessionIds,
        periodEnd: plan.subscription?.currentPeriodEnd,
      })
    );
  }
  await deleteAuthTokensOfUser(userId);
  await subscriptionStore.forgetUser(userId);
  await forgetFailedLogins(plan.email);
  await redisUserStore.deleteUser(userId);
  // An active webhook or billing event that ran before `deleteUser` may have written a retry, dead letter, or subscription index.
  await removeWebhookDeliveries(userId);
  await webhookDispatcher.clearDlq(userId, { strict: true });
  await subscriptionStore.forgetUser(userId);
  return { runningJobIds: [] };
}

/**
 * Removes the deliveries of `userId` across queued and ended states in the webhook queue: each holds the address and the
 * sealed secret of the account and would persist or be sent after the erasure. One that is running is dropped by the worker,
 * which finds the account gone before it sends again or writes a dead letter.
 */
async function removeWebhookDeliveries(userId: string): Promise<void> {
  const queue = webhookDispatcher.getQueue();
  for (const job of await queue.getJobs([...WEBHOOK_JOB_STATES])) {
    if (job.data.options?.ownerUserId === userId) await queue.remove(job.id);
  }
}

/** Deletes the failed-login counters of `email`; a Redis that does not answer fails the erasure (the limiter's own reset falls back to memory). */
async function forgetFailedLogins(email: string): Promise<void> {
  const redis = redisUserStore.getRedisClient();
  // The key the login limiter writes (`login_attempts:email:<lower-cased address>` under the user store's prefix).
  if (redis) await redis.del(`${redisUserStore.getKeyPrefix()}login_attempts:email:${email.toLowerCase().trim()}`);
  await resetLoginAttempts(email);
}

/** The subscription record is deleted here; the payment provider keeps the customer and keeps charging an active subscription until it is canceled there. */
function subscriptionLines({ subscription }: AccountErasurePlan): string[] {
  if (!subscription) return [];
  const warning = isEntitlingStatus(subscription.status)
    ? `  WARNING: the subscription is ${subscription.status}; cancel ${subscription.providerSubscriptionId} at the payment provider first, or it keeps charging the customer`
    : '  the customer stays at the payment provider';
  return [`subscription record: ${subscription.providerSubscriptionId} (${subscription.status})`, warning];
}

function describe(plan: AccountErasurePlan): string {
  return [
    `account ${plan.userId} (${plan.email})`,
    `api keys: ${plan.apiKeyIds.length}`,
    `storage credentials: ${plan.credentialIds.length}`,
    `graphs: ${plan.graphIds.length}`,
    `jobs: ${plan.jobs.length}${plan.jobs.length === MAX_JOBS_PER_RUN ? ' (the first batch; run again)' : ''}`,
    `open resumable uploads: ${plan.tusSessionIds.length}`,
    `open multipart uploads: ${plan.uploadSessionIds.length}`,
    `stored files: ${plan.storedKeys.length}`,
    `webhook dead letters: ${plan.deadLetters}`,
    ...subscriptionLines(plan),
    ...(plan.packageCredits > 0 ? [`package credits: ${plan.packageCredits} (deleted with the account)`] : []),
    `tagged redis keys: ${plan.taggedKeys.length}`,
    ...plan.taggedKeys.map((key) => `  ${key}`),
  ].join('\n');
}

async function main(argv: readonly string[]): Promise<number> {
  const userAt = argv.indexOf('--user');
  const idOrEmail = userAt >= 0 ? argv[userAt + 1] : undefined;
  if (!idOrEmail) {
    console.error('Usage: erase-account --user <account id or email> [--apply]');
    return 2;
  }
  const plan = await planAccountErasure(idOrEmail);
  if (!plan) {
    console.error(`No account ${idOrEmail}.`);
    return 1;
  }
  console.log(describe(plan));
  if (!argv.includes('--apply')) {
    console.log('Dry run: nothing was deleted. Run again with --apply to delete.');
    return 0;
  }
  const { runningJobIds } = await eraseAccount(plan);
  if (runningJobIds.length > 0) {
    console.log(`${runningJobIds.length} job(s) are not removed yet (still running, or queued after this run looked): run again once they stop.`);
    return 3;
  }
  console.log('Deleted.');
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    }
  );
}
