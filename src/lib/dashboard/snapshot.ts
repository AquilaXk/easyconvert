import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import { toPublicApiKey, toPublicDlqEntry } from '@/lib/api-keys/public-views';
import { webhookDispatcher } from '@/lib/api-keys/webhook-dispatcher';
import type { User } from '@/lib/auth/types';
import { listAccountFiles } from './account-files';
import type { DashboardSnapshot } from './snapshot-types';

/**
 * What the dashboard shows on its first paint for `user`, read through the same store functions the dashboard routes use and
 * scoped to that person's id. Each read stands alone: one that fails leaves its part out, and the page reads it after
 * hydration, so a store that is slow or down for one resource does not hide the others.
 */
export async function loadDashboardSnapshot(user: User): Promise<DashboardSnapshot> {
  const [keys, quota, files, dlqEntries] = await Promise.allSettled([
    redisKeyStore.listApiKeys(user.id),
    redisKeyStore.getQuotaUsage(user.id),
    listAccountFiles(user.id),
    webhookDispatcher.getDlqEntries(user.id),
  ]);
  return {
    user,
    ...(keys.status === 'fulfilled' && { keys: keys.value.map(toPublicApiKey) }),
    ...(quota.status === 'fulfilled' && { quota: quota.value }),
    ...(files.status === 'fulfilled' && { files: files.value }),
    ...(dlqEntries.status === 'fulfilled' && { dlqEntries: dlqEntries.value.map(toPublicDlqEntry) }),
  };
}
