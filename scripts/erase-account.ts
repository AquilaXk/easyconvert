import { deleteAuthTokensOfUser } from '../src/lib/auth/auth-email-token-store';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { getWebhookSecretStore } from '../src/lib/api-keys/webhook-secret-store';
import { webhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';
import { resetLoginAttempts } from '../src/lib/auth/login-rate-limiter';
import { conversionQueue } from '../src/lib/queue/conversion-queue';
import { graphScheduler } from '../src/lib/queue/graph/scheduler';
import { CANCELLABLE_JOB_STATES, HEARTBEAT_INTERVAL_MS, type JobState } from '../src/lib/queue/bullmq-engine';
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
  storedKeys: string[];
  deadLetters: number;
  taggedKeys: string[];
}

export interface AccountErasureOutcome {
  /** Jobs that were still running and were only cancelled; a later run removes them, and the account with them. */
  runningJobIds: string[];
}

const MAX_JOBS_PER_RUN = 10_000;
const SCAN_COUNT = 500;
/** Keys one DEL names: a command with tens of thousands of arguments is refused by the client and blocks the server. */
const DELETE_BATCH = 500;
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

async function accountTaggedKeys(userId: string): Promise<string[]> {
  const client = redisKeyStore.getRedisClient();
  if (!client) return [];
  const pattern = `*{${userId.replace(/[*?[\]\\]/g, '\\$&')}}*`;
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_COUNT);
    keys.push(...batch);
    cursor = next;
  } while (cursor !== '0');
  return keys.sort((a, b) => a.localeCompare(b));
}

/**
 * The stored files of the account: the files the retention ledger holds under the account's prefix or a result of its jobs and
 * graphs, and the files its history names (a result whose job record is already gone).
 */
async function accountStoredKeys(
  userId: string,
  jobIds: readonly string[],
  graphIds: readonly string[]
): Promise<string[]> {
  const prefixes = [
    `conversions/${userId}/`,
    ...jobIds.map((id) => `results/${id}/`),
    ...graphIds.map((id) => `results/${id}/`),
  ];
  const ledger = getRetentionLedger();
  const keys = ledger.allKeys ? await ledger.allKeys() : (await ledger.liveRecords()).map((record) => record.key);
  const owned = keys.filter((key) => prefixes.some((prefix) => key.startsWith(prefix)));
  const named = (await redisKeyStore.listUserFiles(userId)).flatMap((file) => (file.storageKey ? [file.storageKey] : []));
  const history: string[] = [];
  for (const key of named) if (await Promise.resolve(storageProvider.stat(key)).catch(() => undefined)) history.push(key);
  return [...new Set([...owned, ...history])].sort((a, b) => a.localeCompare(b));
}

/** What erasing the account `idOrEmail` deletes, or undefined when there is no such account. Changes nothing. */
export async function planAccountErasure(idOrEmail: string): Promise<AccountErasurePlan | undefined> {
  const account = await findAccount(idOrEmail);
  if (!account) return undefined;
  const userId = account.id;
  const [keys, credentialIds, graphIds, jobs, letters, taggedKeys] = await Promise.all([
    redisKeyStore.listApiKeys(userId),
    credentialsVault.listByUser(userId),
    graphScheduler.graphsOfUser(userId),
    conversionQueue.getJobsByUser(userId, undefined, MAX_JOBS_PER_RUN, 0),
    webhookDispatcher.getDlqPage(userId, { includeExpired: true, limit: 1 }),
    accountTaggedKeys(userId),
  ]);
  return {
    userId,
    email: account.email,
    apiKeyIds: keys.map((key) => key.id),
    credentialIds,
    graphIds,
    jobs: jobs.map((job) => ({ id: job.id, state: job.state })),
    tusSessionIds: await tusEngine.sessionsOfOwner(userId),
    storedKeys: await accountStoredKeys(userId, jobs.map((job) => job.id), graphIds),
    deadLetters: letters.total,
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

/**
 * Erases the account in an order that lets nothing it started write after the erasure:
 * 1. the keys and sessions go first, so no request of the account starts new work;
 * 2. its graphs, jobs and open uploads are cancelled, and when a job was running the erasure waits for its worker to notice
 *    (`drainMs`), because the files and records that job writes would be untraceable once the graph index is gone;
 * 3. only then the graphs, files, history, counts and the keys tagged with the account (read again, not taken from the plan) go.
 * A job that is still active after the wait leaves the account, its graph index and its files in place for the next run.
 */
export async function eraseAccount(plan: AccountErasurePlan, options: AccountErasureOptions = {}): Promise<AccountErasureOutcome> {
  const { userId } = plan;
  const keyIds = new Set([...plan.apiKeyIds, ...(await redisKeyStore.listApiKeys(userId)).map((key) => key.id)]);
  for (const keyId of keyIds) {
    await redisKeyStore.deleteApiKey(userId, keyId);
    await getWebhookSecretStore().deleteSecretRecord(userId, keyId);
  }
  await redisUserStore.incrementSessionVersion(userId);

  const work = await currentWork(plan);
  const wasRunning = work.jobs.some((job) => job.state === 'active');
  for (const graphId of work.graphIds) {
    await graphScheduler.cancelGraph(graphId, 'The account was deleted');
  }
  for (const job of work.jobs) {
    if (CANCELLABLE_JOB_STATES.has(job.state)) await conversionQueue.cancelJob(job.id, 'The account was deleted');
  }
  await tusEngine.terminateSessionsOfOwner(userId);
  for (const credentialId of new Set([...plan.credentialIds, ...(await credentialsVault.listByUser(userId))])) {
    await credentialsVault.delete(credentialId, userId);
  }
  if (wasRunning) await new Promise((resolve) => setTimeout(resolve, options.drainMs ?? DEFAULT_DRAIN_MS));

  const runningJobIds = await removeEndedJobs(work.jobs.map((job) => job.id));
  if (runningJobIds.length > 0) return { runningJobIds };

  for (const graphId of work.graphIds) {
    await graphScheduler.deleteGraph(graphId);
    await storageProvider.deleteByPrefix?.(`results/${graphId}/`);
    await storageProvider.deleteByPrefix?.(`intermediate/${graphId}/`);
  }
  const ledger = getRetentionLedger();
  for (const key of await accountStoredKeys(userId, work.jobs.map((job) => job.id), work.graphIds)) {
    await Promise.resolve(storageProvider.deleteObject(key)).catch(() => false);
    await ledger.forget(key);
  }
  await storageProvider.deleteByPrefix?.(`conversions/${userId}/`);
  await conversionQueue.forgetUser?.(userId);
  await webhookDispatcher.clearDlq(userId);
  await redisKeyStore.forgetUsage(userId);
  const client = redisKeyStore.getRedisClient();
  if (client) await deleteKeysInBatches(client, await accountTaggedKeys(userId));
  await deleteAuthTokensOfUser(userId);
  await resetLoginAttempts(null, plan.email);
  if (work.jobs.length < MAX_JOBS_PER_RUN) await redisUserStore.deleteUser(userId);
  return { runningJobIds };
}

function describe(plan: AccountErasurePlan): string {
  return [
    `account ${plan.userId} (${plan.email})`,
    `api keys: ${plan.apiKeyIds.length}`,
    `storage credentials: ${plan.credentialIds.length}`,
    `graphs: ${plan.graphIds.length}`,
    `jobs: ${plan.jobs.length}${plan.jobs.length === MAX_JOBS_PER_RUN ? ' (the first batch; run again)' : ''}`,
    `open resumable uploads: ${plan.tusSessionIds.length}`,
    `stored files: ${plan.storedKeys.length}`,
    `webhook dead letters: ${plan.deadLetters}`,
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
    console.log(`Cancelled ${runningJobIds.length} running job(s), not yet removed: run again once they stop.`);
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
