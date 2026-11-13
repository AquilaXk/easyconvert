import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { applyEmailConfirmation, planEmailConfirmation } from '../scripts/confirm-account-email';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { TERMS_VERSION } from '../src/lib/legal/documents';

const created: string[] = [];

async function account(fields: { provider?: 'email' | 'google'; emailVerified?: boolean } = {}) {
  const user = await redisUserStore.createUser({ email: `confirm_${crypto.randomUUID()}@confirm.test`, name: 'Confirm', acceptedTermsVersion: TERMS_VERSION, ...fields });
  created.push(user.id);
  return user;
}

afterEach(async () => {
  for (const userId of created.splice(0)) await redisUserStore.deleteUser(userId);
});

describe('confirm-account-email, the operator tool that confirms the address of a test account', () => {
  it('plans the confirmation by email or id and writes nothing until it is applied', async () => {
    const user = await account();
    const byEmail = await planEmailConfirmation(user.email);
    expect(byEmail).toEqual({ userId: user.id, email: user.email });
    expect(await planEmailConfirmation(user.id)).toEqual(byEmail);
    expect((await redisUserStore.findById(user.id))?.emailVerified).not.toBe(true);
  });

  it('confirms the address when applied, and then refuses to run again', async () => {
    const user = await account();
    const change = await planEmailConfirmation(user.id);
    if ('refusal' in change) throw new Error(change.refusal);
    await applyEmailConfirmation(change);
    expect((await redisUserStore.findById(user.id))?.emailVerified).toBe(true);
    expect(await planEmailConfirmation(user.id)).toEqual({ refusal: `The address of ${user.email} is already confirmed.` });
  });

  it('leaves an account that does not exist or that signs in with Google alone', async () => {
    expect(await planEmailConfirmation('nobody@confirm.test')).toEqual({ refusal: 'No account nobody@confirm.test.' });
    const google = await account({ provider: 'google' });
    expect(await planEmailConfirmation(google.id)).toEqual({ refusal: `${google.email} signs in with google; its address needs no confirmation.` });
  });
});
