import { redisKeyStore } from './redis-key-store';
import type { ApiKey } from './types';
import { getWebhookSecretStore } from './webhook-secret-store';

/**
 * Deletes an API key of the account: its record with the hash, its rate bucket and the rotated secret of its webhook, which would
 * otherwise be read for the key's deliveries for good. False, with nothing changed, when the account holds no such key: the secret
 * store shares its key space with the endpoint records of the account, so an id that names no key of the account must not reach it.
 * The secret goes before the key, so a failure between the two leaves a key that a retry deletes, not a secret that no key names
 * and no erasure finds (the erasure reads the secret records of the keys it lists).
 */
export async function deleteAccountApiKey(userId: string, keyId: string): Promise<boolean> {
  const held = await redisKeyStore.listApiKeys(userId, { decryptSecrets: false });
  if (!held.some((key) => key.id === keyId)) return false;
  return deleteHeldKey(userId, keyId);
}

/** Deletes a key already known to be the account's: the secret of its webhook first, then the key. */
async function deleteHeldKey(userId: string, keyId: string): Promise<boolean> {
  await getWebhookSecretStore().deleteSecretRecord(userId, keyId);
  return redisKeyStore.deleteApiKey(userId, keyId);
}

/**
 * The API keys an account holds, newest first, with the signing secret of each webhook redacted. A key that an earlier version
 * only marked as revoked (it kept its hash and stayed in the list) is deleted here, so the secret material of a key the owner
 * ended does not outlive the list that showed it. A key that cannot be deleted now is logged and left out of the answer; the next
 * read tries it again.
 */
export async function listAccountApiKeys(userId: string): Promise<ApiKey[]> {
  const keys = await redisKeyStore.listApiKeys(userId, { decryptSecrets: false });
  const live: ApiKey[] = [];
  for (const key of keys) {
    if (key.status !== 'revoked') {
      live.push(key);
      continue;
    }
    await deleteHeldKey(userId, key.id).catch((error: unknown) => {
      console.error(`[api-keys] Could not delete the revoked key ${key.id} of account ${userId}; it is left out of the list:`, error);
    });
  }
  return live;
}
