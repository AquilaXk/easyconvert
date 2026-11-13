import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_TEST_CREDITS, applyTestCredits, planTestCredits } from '../scripts/grant-test-credits';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { TERMS_VERSION } from '../src/lib/legal/documents';

const created: string[] = [];

async function account() {
  const user = await redisUserStore.createUser({ email: `credits_${crypto.randomUUID()}@credits.test`, name: 'Credits', acceptedTermsVersion: TERMS_VERSION, emailVerified: true });
  created.push(user.id);
  return user;
}

afterEach(async () => {
  for (const userId of created.splice(0)) await redisUserStore.deleteUser(userId);
});

describe('grant-test-credits, the operator tool that adds credits to the test account', () => {
  it('plans the grant by email or id and writes nothing until it is applied', async () => {
    const user = await account();
    const byEmail = await planTestCredits(user.email, 500);
    expect(byEmail).toEqual({ userId: user.id, email: user.email, credits: 500, balance: 0 });
    expect(await planTestCredits(user.id, 500)).toEqual(byEmail);
    expect(await redisKeyStore.packageBalance(user.id)).toBe(0);
  });

  it('adds the credits to the package balance when applied, again on a second run, and the account then has the paid limits', async () => {
    const user = await account();
    const grant = await planTestCredits(user.id, 1000);
    if ('refusal' in grant) throw new Error(grant.refusal);
    expect(await applyTestCredits(grant)).toBe(1000);
    expect(await applyTestCredits(grant)).toBe(2000);
    const stored = await redisUserStore.findById(user.id);
    expect((await redisKeyStore.withCreditTier(stored!)).tier).toBe('paid');
  });

  it('refuses an account that does not exist and an amount out of range', async () => {
    expect(await planTestCredits('nobody@credits.test', 10)).toEqual({ refusal: 'No account nobody@credits.test.' });
    const user = await account();
    for (const credits of [0, -5, 1.5, MAX_TEST_CREDITS + 1, Number.NaN]) {
      expect(await planTestCredits(user.id, credits)).toEqual({ refusal: `Credits must be a whole number from 1 to ${MAX_TEST_CREDITS}.` });
    }
  });
});
