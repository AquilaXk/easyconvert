import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { getWebhookSecretStore } from '../src/lib/api-keys/webhook-secret-store';
import { webhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';
import { conversionQueue } from '../src/lib/queue/conversion-queue';
import { CANCELLABLE_JOB_STATES } from '../src/lib/queue/bullmq-engine';
import { storageProvider } from '../src/lib/storage';
import { getRetentionLedger } from '../src/lib/storage/retention-ledger';
import { deleteResult } from '../src/lib/storage/retention-service';

/**
 * Deletes what EasyConvert keeps about one account when its owner asks for that (privacy policy, sections 4 and 10, answered
 * within 10 days). It lists, and with `--apply` deletes, every family of records of the account:
 *
 * - its conversion jobs in every queue, with the index of its jobs: live ones are cancelled first, and a job whose attempt is
 *   still running is left for a second run;
 * - the stored files of those jobs and of the account, through the retention ledger, as the retention sweep deletes them;
 * - its API keys and their webhook signing secrets;
 * - its webhook dead letters;
 * - its conversion counts, in this process and as the Redis keys tagged with the account id (usage, reservations, leases);
 * - the account record, its email index and its session version, last and only once no job is left, so that a run that
 *   stops, or that leaves a running job, can be run again.
 *
 * Run it in the worker container, which reaches Redis and the storage root:
 *   node dist/erase-account.js --user <account id or email>           lists what would be deleted
 *   node dist/erase-account.js --user <account id or email> --apply   deletes it
 */

export interface AccountErasurePlan {
  userId: string;
  email: string;
  apiKeyIds: string[];
  jobs: { id: string; state: string }[];
  storedKeys: string[];
  deadLetters: number;
  taggedKeys: string[];
}

export interface AccountErasureOutcome {
  /** Jobs that were still running and were only cancelled; a later run removes them, and the account with them. */
  runningJobIds: string[];
}

/** Most jobs of one account a run reads; an account with more is erased over several runs. */
const MAX_JOBS_PER_RUN = 10_000;
/** Keys one SCAN step of Redis returns at most. */
const SCAN_COUNT = 500;

async function findAccount(idOrEmail: string) {
  return idOrEmail.includes('@') ? redisUserStore.findByEmail(idOrEmail) : redisUserStore.findById(idOrEmail);
}

/** Redis keys whose hash tag is the account id, `{<id>}`, the slot every per-account counter and secret record shares. */
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
  return keys.sort();
}

/** The stored files the retention ledger tracks for the account and for `jobIds`, by storage key. */
async function accountStoredKeys(userId: string, jobIds: readonly string[]): Promise<string[]> {
  const prefixes = [`conversions/${userId}/`, ...jobIds.map((id) => `results/${id}/`)];
  const records = await getRetentionLedger().liveRecords();
  return records.map((record) => record.key).filter((key) => prefixes.some((prefix) => key.startsWith(prefix))).sort();
}

/** What erasing the account `idOrEmail` deletes, or undefined when there is no such account. Changes nothing. */
export async function planAccountErasure(idOrEmail: string): Promise<AccountErasurePlan | undefined> {
  const account = await findAccount(idOrEmail);
  if (!account) return undefined;
  const userId = account.id;
  const [keys, jobs, letters, taggedKeys] = await Promise.all([
    redisKeyStore.listApiKeys(userId),
    conversionQueue.getJobsByUser(userId, undefined, MAX_JOBS_PER_RUN, 0),
    webhookDispatcher.getDlqEntries(userId),
    accountTaggedKeys(userId),
  ]);
  return {
    userId,
    email: account.email,
    apiKeyIds: keys.map((key) => key.id),
    jobs: jobs.map((job) => ({ id: job.id, state: job.state })),
    storedKeys: await accountStoredKeys(userId, jobs.map((job) => job.id)),
    deadLetters: letters.length,
    taggedKeys,
  };
}

/** Deletes everything `plan` lists. */
export async function eraseAccount(plan: AccountErasurePlan): Promise<AccountErasureOutcome> {
  const { userId } = plan;
  for (const job of plan.jobs) {
    if (CANCELLABLE_JOB_STATES.has(job.state as never)) await conversionQueue.cancelJob(job.id, 'The account was deleted');
  }
  const runningJobIds: string[] = [];
  for (const job of plan.jobs) {
    if (!(await conversionQueue.remove(job.id))) runningJobIds.push(job.id);
  }
  for (const key of plan.storedKeys) await deleteResult(storageProvider, key);
  await storageProvider.deleteByPrefix?.(`conversions/${userId}/`);
  for (const keyId of plan.apiKeyIds) {
    await redisKeyStore.deleteApiKey(userId, keyId);
    await getWebhookSecretStore().deleteSecretRecord(userId, keyId);
  }
  await webhookDispatcher.clearDlq(userId);
  redisKeyStore.forgetUsage(userId);
  const client = redisKeyStore.getRedisClient();
  if (client && plan.taggedKeys.length > 0) await client.del(...plan.taggedKeys);
  // The account goes last, and only once no job is left, so that a second run still finds it by its id.
  if (runningJobIds.length === 0) await redisUserStore.deleteUser(userId);
  return { runningJobIds };
}

function describe(plan: AccountErasurePlan): string {
  return [
    `account ${plan.userId} (${plan.email})`,
    `api keys: ${plan.apiKeyIds.length}`,
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
