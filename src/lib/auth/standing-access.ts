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
 *
 * `createdBefore` limits it to what was made before that time, in milliseconds since the epoch: the time the address was first
 * confirmed (`verifiedAt`), so that an owner who confirmed the address by its link and reset the password later takes back an
 * account without the keys that were made before anyone proved the address, and keeps the keys made since.
 */
export async function revokeStandingAccess(userId: string, createdBefore?: number): Promise<void> {
  const isStanding = (madeAt: number): boolean => createdBefore === undefined || madeAt < createdBefore;
  for (let round = 0; round < SWEEP_ROUNDS; round++) {
    const keys = (await redisKeyStore.listApiKeys(userId, { decryptSecrets: false })).filter((key) => isStanding(key.createdAt));
    if (keys.length === 0) break;
    for (const key of keys) {
      await redisKeyStore.deleteApiKey(userId, key.id);
      await getWebhookSecretStore().deleteSecretRecord(userId, key.id);
    }
  }
  await webhookDispatcher.clearDlq(userId, { strict: true, failedBefore: createdBefore });
  const credentialRefs =
    createdBefore === undefined
      ? await credentialsVault.listByUser(userId)
      : (await credentialsVault.list(userId)).filter((credential) => isStanding(credential.createdAt)).map((credential) => credential.id);
  for (const credentialRef of credentialRefs) await credentialsVault.delete(credentialRef, userId);
}

/** The account is being erased by the purge of unverified accounts (or is gone): it cannot be handed over, and nothing of it was changed. */
export class AccountBeingErasedError extends Error {
  constructor() {
    super('The account is being erased and cannot be handed over.');
    this.name = 'AccountBeingErasedError';
  }
}

/**
 * Hands an account whose address was never verified to the person who just proved the address with Google, which vouches for it
 * (docs/policy-decisions.md, entry 297): the registrant's password goes first, so they cannot sign in while the account is
 * cleaned; then their sessions and what they set up (`revokeStandingAccess`); the address is marked verified and the account linked
 * to Google last, and the terms it records as accepted are the owner's own, given with the sign-in, not the registrant's. A step
 * that fails leaves the account unverified, so the next sign-in takes this same path again and cleans again, as the password reset
 * does (`/api/auth/password-reset/confirm`). `linked` is what the sign-in adds to the record.
 */
export async function handOverUnverifiedAccount(userId: string, linked: Pick<UserRecord, 'acceptedTermsVersion'> & Partial<Pick<UserRecord, 'avatarUrl'>>): Promise<UserRecord> {
  // An account the purge has claimed refuses its confirmation, so it is refused here before anything of it is cleaned.
  const current = await redisUserStore.findById(userId);
  if (!current || current.purgingAt !== undefined) throw new AccountBeingErasedError();
  if (!(await redisUserStore.updateUser(userId, { passwordHash: '', salt: '' }))) throw new AccountBeingErasedError();
  await revokeAllUserSessions(userId);
  await revokeStandingAccess(userId);
  const handedOver = await redisUserStore.updateUser(userId, { ...linked, provider: 'google', emailVerified: true });
  if (!handedOver) throw new AccountBeingErasedError();
  return handedOver;
}
