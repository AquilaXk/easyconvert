import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { getWebhookSecretStore } from '../src/lib/api-keys/webhook-secret-store';
import { webhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';
import { conversionQueue } from '../src/lib/queue/conversion-queue';
import { graphScheduler } from '../src/lib/queue/graph/scheduler';
import { CANCELLABLE_JOB_STATES, type JobState } from '../src/lib/queue/bullmq-engine';
import { storageProvider } from '../src/lib/storage';
import { credentialsVault } from '../src/lib/storage/credentials-vault';
import { getRetentionLedger } from '../src/lib/storage/retention-ledger';

export interface AccountErasurePlan {
  userId: string;
  email: string;
  apiKeyIds: string[];
  credentialIds: string[];
  graphIds: string[];
  jobs: { id: string; state: JobState }[];
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
  return keys.filter((key) => prefixes.some((prefix) => key.startsWith(prefix))).sort((a, b) => a.localeCompare(b));
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
    webhookDispatcher.getDlqEntries(userId, { includeExpired: true }),
    accountTaggedKeys(userId),
  ]);
  return {
    userId,
    email: account.email,
    apiKeyIds: keys.map((key) => key.id),
    credentialIds,
    graphIds,
    jobs: jobs.map((job) => ({ id: job.id, state: job.state })),
    storedKeys: await accountStoredKeys(userId, jobs.map((job) => job.id), graphIds),
    deadLetters: letters.length,
    taggedKeys,
  };
}

export async function eraseAccount(plan: AccountErasurePlan): Promise<AccountErasureOutcome> {
  const { userId } = plan;
  for (const graphId of plan.graphIds) {
    await graphScheduler.cancelGraph(graphId, 'The account was deleted');
  }
  for (const job of plan.jobs) {
    if (CANCELLABLE_JOB_STATES.has(job.state)) await conversionQueue.cancelJob(job.id, 'The account was deleted');
  }
  const runningJobIds: string[] = [];
  for (const job of plan.jobs) {
    if (!(await conversionQueue.remove(job.id)) && (await conversionQueue.getJob(job.id))) {
      runningJobIds.push(job.id);
    }
  }
  for (const graphId of plan.graphIds) {
    await graphScheduler.deleteGraph(graphId);
    await storageProvider.deleteByPrefix?.(`results/${graphId}/`);
  }
  const ledger = getRetentionLedger();
  for (const key of plan.storedKeys) {
    await Promise.resolve(storageProvider.deleteObject(key)).catch(() => false);
    await ledger.forget(key);
  }
  await storageProvider.deleteByPrefix?.(`conversions/${userId}/`);
  for (const credentialId of plan.credentialIds) {
    await credentialsVault.delete(credentialId, userId);
  }
  for (const keyId of plan.apiKeyIds) {
    await redisKeyStore.deleteApiKey(userId, keyId);
    await getWebhookSecretStore().deleteSecretRecord(userId, keyId);
  }
  await webhookDispatcher.clearDlq(userId);
  redisKeyStore.forgetUsage(userId);
  const client = redisKeyStore.getRedisClient();
  if (client && plan.taggedKeys.length > 0) await client.del(...plan.taggedKeys);
  if (runningJobIds.length === 0 && plan.jobs.length < MAX_JOBS_PER_RUN) await redisUserStore.deleteUser(userId);
  return { runningJobIds };
}

function describe(plan: AccountErasurePlan): string {
  return [
    `account ${plan.userId} (${plan.email})`,
    `api keys: ${plan.apiKeyIds.length}`,
    `storage credentials: ${plan.credentialIds.length}`,
    `graphs: ${plan.graphIds.length}`,
    `jobs: ${plan.jobs.length}${plan.jobs.length === MAX_JOBS_PER_RUN ? ' (the first batch; run again)' : ''}`,
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
