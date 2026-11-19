import { deleteAuthTokensOfUser } from './auth-email-token-store';
import { redisUserStore } from './redis-user-store';
import { resetLoginAttempts } from './login-rate-limiter';
import { redisKeyStore } from '../api-keys/redis-key-store';
import { subscriptionStore } from '../billing/subscription-store';
import type { SubscriptionRecord } from '../billing/types';
import { getWebhookSecretStore } from '../api-keys/webhook-secret-store';
import { webhookDispatcher } from '../api-keys/webhook-dispatcher';
import { conversionQueue } from '../queue/conversion-queue';
import { graphScheduler } from '../queue/graph/scheduler';
import { CANCELLABLE_JOB_STATES, HEARTBEAT_INTERVAL_MS, type JobState } from '../queue/bullmq-engine';
import { storageProvider } from '../storage';
import { tusEngine } from '../storage/tus-engine';
import { credentialsVault } from '../storage/credentials-vault';
import { getRetentionLedger } from '../storage/retention-ledger';
import {
  accountStoredKeys,
  accountTaggedKeys,
  deleteKeysInBatches,
  forgetUploadCompletionReceipts,
} from './erase-account-keys';

export { deleteKeysInBatches };

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
  /** The subscription record of the account; a self-serve erasure cancels active subscriptions at the payment provider first. */
  subscription: SubscriptionRecord | null;
  /** The package credits the account holds; they are deleted with the account. */
  packageCredits: number;
  taggedKeys: string[];
}

export interface AccountErasureOutcome {
  /** Jobs that were still running and were only cancelled; a later run removes them, and the account with them. */
  runningJobIds: string[];
}

export interface AccountErasureOptions {
  /** The wait after cancelling a running job, in milliseconds; the default is two heartbeats of the queue. */
  drainMs?: number;
}

export const MAX_ERASURE_JOBS_PER_RUN = 10_000;
const WEBHOOK_JOB_STATES: readonly JobState[] = ['waiting', 'delayed', 'completed', 'failed', 'cancelled'];
const DEFAULT_DRAIN_MS = HEARTBEAT_INTERVAL_MS * 2;
const CANCEL_ROUNDS = 5;

async function findAccount(idOrEmail: string) {
  return idOrEmail.includes('@') ? redisUserStore.findByEmail(idOrEmail) : redisUserStore.findById(idOrEmail);
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
    conversionQueue.getJobsByUser(userId, undefined, MAX_ERASURE_JOBS_PER_RUN, 0),
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

async function currentWork(plan: AccountErasurePlan): Promise<{ jobs: AccountErasurePlan['jobs']; graphIds: string[] }> {
  const listed = await conversionQueue.getJobsByUser(plan.userId, undefined, MAX_ERASURE_JOBS_PER_RUN, 0);
  const jobs = new Map(plan.jobs.map((job) => [job.id, job]));
  for (const job of listed) jobs.set(job.id, { id: job.id, state: job.state });
  const graphIds = new Set([...plan.graphIds, ...(await graphScheduler.graphsOfUser(plan.userId))]);
  for (const job of listed) if (job.data.graphId) graphIds.add(job.data.graphId);
  return { jobs: [...jobs.values()], graphIds: [...graphIds].sort((a, b) => a.localeCompare(b)) };
}

async function removeEndedJobs(jobIds: readonly string[]): Promise<string[]> {
  const running: string[] = [];
  for (const id of jobIds) {
    if (!(await conversionQueue.remove(id)) && (await conversionQueue.getJob(id))) running.push(id);
  }
  return running;
}

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

async function removeWebhookDeliveries(userId: string): Promise<void> {
  const queue = webhookDispatcher.getQueue();
  for (const job of await queue.getJobs([...WEBHOOK_JOB_STATES])) {
    if (job.data.options?.ownerUserId === userId) await queue.remove(job.id);
  }
}

async function forgetFailedLogins(email: string): Promise<void> {
  await resetLoginAttempts(email);
}

async function revokeStandingKeysAndSessions(plan: AccountErasurePlan): Promise<Set<string>> {
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
  return keyIds;
}

async function purgeStoredArtifactsAndLedger(
  userId: string,
  work: { jobs: AccountErasurePlan['jobs']; graphIds: string[] }
): Promise<void> {
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
}

/** Erases the account and every key, session, job, file, webhook, usage counter and subscription index tied to it. */
export async function eraseAccount(plan: AccountErasurePlan, options: AccountErasureOptions = {}): Promise<AccountErasureOutcome> {
  const { userId } = plan;
  const keyIds = await revokeStandingKeysAndSessions(plan);
  const work = await cancelAllWork(plan, options.drainMs ?? DEFAULT_DRAIN_MS);
  await storageProvider.abortUploadSessionsOfOwner?.(userId);

  const stillActive = await removeEndedJobs(work.jobs.map((job) => job.id));
  if (stillActive.length > 0) return { runningJobIds: stillActive };

  await purgeStoredArtifactsAndLedger(userId, work);
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
  await removeWebhookDeliveries(userId);
  await webhookDispatcher.clearDlq(userId, { strict: true });
  await subscriptionStore.forgetUser(userId);
  return { runningJobIds: [] };
}
