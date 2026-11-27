import { redisKeyStore } from './redis-key-store';
import type { ApiKey } from './types';
import { getWebhookSecretStore } from './webhook-secret-store';

/**
 * Deletes an API key of the account: its record with the hash, its rate bucket and the rotated secret of its webhook, which would
 * otherwise be read for the key's deliveries for good. The secret goes first, so a failure between the two leaves a key that a
 * retry deletes, not a secret that no key names and no erasure finds. False when the account holds no such key.
 */
export async function deleteAccountApiKey(userId: string, keyId: string): Promise<boolean> {
  await getWebhookSecretStore().deleteSecretRecord(userId, keyId);
  return redisKeyStore.deleteApiKey(userId, keyId);
}

/**
 * The API keys an account holds, newest first, with the signing secret of each webhook redacted. A key that an earlier version
 * only marked as revoked (it kept its hash and stayed in the list) is deleted here, so the secret material of a key the owner
 * ended does not outlive the list that showed it.
 */
export async function listAccountApiKeys(userId: string): Promise<ApiKey[]> {
  const keys = await redisKeyStore.listApiKeys(userId, { decryptSecrets: false });
  const live: ApiKey[] = [];
  for (const key of keys) {
    if (key.status === 'revoked') await deleteAccountApiKey(userId, key.id);
    else live.push(key);
  }
  return live;
}
