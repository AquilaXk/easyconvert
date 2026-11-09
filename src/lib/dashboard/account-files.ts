import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import { resultAvailability } from '@/lib/storage/retention-service';
import type { AccountFile } from './snapshot-types';

/**
 * The converted files of one account as the dashboard lists them. A file the retention rule already deleted is not listed,
 * and one that is about to go counts down to that time. The files route and the server-rendered dashboard both read it.
 */
export async function listAccountFiles(userId: string, now: number = Date.now()): Promise<AccountFile[]> {
  const files = await redisKeyStore.listUserFiles(userId);
  const availabilities = await Promise.all(
    files.map((file) => (file.storageKey ? resultAvailability(file.storageKey, now) : undefined))
  );
  return files.flatMap((file, index) => {
    const availability = availabilities[index];
    if (availability?.state === 'deleted') return [];
    const expiresAt = Math.min(file.expiresAt, availability?.deleteAt ?? file.expiresAt);
    return [{ ...file, expiresAt, remainingSeconds: Math.max(0, Math.floor((expiresAt - now) / 1000)) }];
  });
}
