import { redisKeyStore } from '../api-keys/redis-key-store';
import { webhookDispatcher } from '../api-keys/webhook-dispatcher';
import { getWebhookSecretStore } from '../api-keys/webhook-secret-store';
import { credentialsVault } from '../storage/credentials-vault';

/** The rounds that look again for a key made while the earlier rounds deleted: a key of the account can make another until it is gone. */
const SWEEP_ROUNDS = 3;

/**
 * Ends what an account's former holder set up that outlives their sessions: every API key (deleted, not only revoked, so that
 * no webhook address stays in view), the secret of each key's webhook, the failed webhook deliveries still waiting to be
 * replayed to those addresses, and the storage credentials saved for the account. It is for the moment an account changes
 * hands: the real owner of an address took it back by a password reset, and whatever was made with the registrant's password
 * must not reach the owner's account or send anything on to the registrant. The keys are listed again after each round
 * because a key with the `*` scope can make a key until it is deleted.
 */
export async function revokeStandingAccess(userId: string): Promise<void> {
  for (let round = 0; round < SWEEP_ROUNDS; round++) {
    const keys = await redisKeyStore.listApiKeys(userId);
    if (keys.length === 0) break;
    for (const key of keys) {
      await redisKeyStore.deleteApiKey(userId, key.id);
      await getWebhookSecretStore().deleteSecretRecord(userId, key.id);
    }
  }
  await webhookDispatcher.clearDlq(userId, { strict: true });
  for (const credentialRef of await credentialsVault.listByUser(userId)) await credentialsVault.delete(credentialRef, userId);
}
