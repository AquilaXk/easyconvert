import { redisKeyStore } from '../api-keys/redis-key-store';
import { billingMonthWindow, calendarMonthWindow, dayWindow } from '../api-keys/quota-window';
import { allConversionQueues } from '../queue/conversion-queue';
import { DEFAULT_QUEUE_KEY_PREFIX } from '../queue/bullmq-engine';
import { userByStateKeys } from '../queue/user-job-list';
import { storageProvider } from '../storage';
import { getRetentionLedger } from '../storage/retention-ledger';

const DELETE_BATCH = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
const QUOTA_HISTORY_DAYS = 40;
const QUOTA_HISTORY_MONTHS = 3;
const UPLOAD_COMPLETION_PREFIX = 'upload-completion/';
const RECEIPT_READ_BATCH = 50;

type RedisClientLike = NonNullable<ReturnType<typeof redisKeyStore.getRedisClient>>;

export interface TaggedKeyContext {
  apiKeyIds?: readonly string[];
  uploadSessionIds?: readonly string[];
  tusSessionIds?: readonly string[];
  periodEnd?: number;
}

/** Deletes `keys` in commands of at most DELETE_BATCH keys. */
export async function deleteKeysInBatches(client: { del(...keys: string[]): Promise<number> }, keys: readonly string[]): Promise<void> {
  for (let at = 0; at < keys.length; at += DELETE_BATCH) {
    await client.del(...keys.slice(at, at + DELETE_BATCH));
  }
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

async function checkBatchWithPipeline(client: RedisClientLike, batch: readonly string[]): Promise<string[]> {
  const pipeline = client.pipeline();
  for (const key of batch) pipeline.exists(key);
  const replies = await pipeline.exec();
  if (!replies) throw new Error('Redis pipeline returned null while checking account keys');
  const found: string[] = [];
  for (let i = 0; i < batch.length; i++) {
    const [err, count] = replies[i] ?? [];
    if (err) throw err;
    if (Number(count) > 0) found.push(batch[i]!);
  }
  return found;
}

async function filterExistingKeys(client: RedisClientLike, candidates: Iterable<string>): Promise<string[]> {
  const unique = [...new Set(candidates)];
  if (unique.length === 0) return [];
  const present: string[] = [];
  const hasPipeline = typeof (client as { pipeline?: unknown }).pipeline === 'function';
  for (let at = 0; at < unique.length; at += DELETE_BATCH) {
    const batch = unique.slice(at, at + DELETE_BATCH);
    if (hasPipeline) {
      present.push(...(await checkBatchWithPipeline(client, batch)));
      continue;
    }
    const counts = await Promise.all(batch.map((key) => client.exists(key)));
    for (let i = 0; i < batch.length; i++) {
      if (Number(counts[i]) > 0) present.push(batch[i]!);
    }
  }
  return present.sort((a, b) => a.localeCompare(b));
}

function addOpenUploadLinksFromJson(candidates: Set<string>, prefix: string, raw: string): void {
  try {
    const parsed = JSON.parse(raw) as { open?: Record<string, { uploadId?: unknown }> };
    if (!parsed.open || typeof parsed.open !== 'object') return;
    for (const [openId, entry] of Object.entries(parsed.open)) {
      candidates.add(`${prefix}upload-budget-link:${openId}`);
      if (entry && typeof entry.uploadId === 'string') {
        candidates.add(`${prefix}upload-budget-link:${entry.uploadId}`);
      }
    }
  } catch {
    // ignore malformed upload budget JSON
  }
}

async function addUploadBudgetCandidates(
  candidates: Set<string>,
  maybeClient: Partial<Pick<RedisClientLike, 'smembers' | 'get'>>,
  prefix: string,
  userId: string,
  context: TaggedKeyContext
): Promise<void> {
  for (const bucket of [`uploads:${userId}`, userId]) {
    const bucketKey = `${prefix}upload-budget:{${bucket}}`;
    candidates.add(bucketKey);
    const raw = typeof maybeClient.get === 'function' ? await maybeClient.get(bucketKey) : null;
    if (raw) addOpenUploadLinksFromJson(candidates, prefix, raw);

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
}

function addQueueIndexCandidates(candidates: Set<string>, prefix: string, userId: string): void {
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
}

export async function accountTaggedKeys(userId: string, context: TaggedKeyContext = {}): Promise<string[]> {
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
    for (const fileId of await maybeClient.zrange(userFilesKey, '0', '-1')) {
      candidates.add(`${prefix}user_file:{${userId}}:${fileId}`);
    }
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
  for (const suffix of ['', ':plist', ':pholds', ':debt', ':hold', ':log', ':txns', ':adj']) {
    candidates.add(`${prefix}credits:{${userId}}${suffix}`);
  }

  await addUploadBudgetCandidates(candidates, maybeClient, prefix, userId, context);

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
  addQueueIndexCandidates(candidates, prefix, userId);

  return filterExistingKeys(client, candidates);
}

/**
 * The stored files of the account: the files the retention ledger holds under the account's prefix or a result of its jobs and
 * graphs, and the files its history names (a result whose job record is already gone).
 */
export async function accountStoredKeys(
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
  for (const key of named) {
    if (await Promise.resolve(storageProvider.stat(key)).catch(() => undefined)) history.push(key);
  }
  return [...new Set([...owned, ...history])].sort((a, b) => a.localeCompare(b));
}

export async function forgetUploadCompletionReceipts(
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
