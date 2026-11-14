import { redisKeyStore } from '../api-keys/redis-key-store';
import { webhookDispatcher } from '../api-keys/webhook-dispatcher';
import { getWebhookSecretStore } from '../api-keys/webhook-secret-store';
import { credentialsVault } from '../storage/credentials-vault';
import { redisUserStore } from './redis-user-store';
import { revokeAllUserSessions } from './session';
import type { UserRecord } from './types';

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

/**
 * Hands an account whose address was never verified to the person who just proved the address with Google, which vouches for it
 * (docs/policy-decisions.md, entry 297): the registrant's password goes first, so they cannot sign in while the account is
 * cleaned; then their sessions and what they set up (`revokeStandingAccess`); the address is marked verified and the account linked
 * to Google last. A step that fails leaves the account unverified, so the next sign-in takes this same path again and cleans again,
 * as the password reset does (`/api/auth/password-reset/confirm`). `linked` is what the sign-in adds to the record.
 */
export async function handOverUnverifiedAccount(userId: string, linked: Partial<Pick<UserRecord, 'avatarUrl'>>): Promise<UserRecord> {
  if (!(await redisUserStore.updateUser(userId, { passwordHash: '', salt: '' }))) throw new Error('The account to hand over does not exist.');
  await revokeAllUserSessions(userId);
  await revokeStandingAccess(userId);
  const handedOver = await redisUserStore.updateUser(userId, { ...linked, provider: 'google', emailVerified: true });
  if (!handedOver) throw new Error('The account to hand over does not exist.');
  return handedOver;
}
