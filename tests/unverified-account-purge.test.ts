import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eraseAccount, planAccountErasure } from '../scripts/erase-account';
import { POST as confirmVerification } from '../src/app/api/auth/email-verification/confirm/route';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { consumeAuthToken, issueAuthToken } from '../src/lib/auth/auth-email-token-store';
import { resetLoginRateLimiterStore } from '../src/lib/auth/login-rate-limiter';
import {
  MAX_FAILURES_IN_A_ROW,
  purgeUnverifiedAccounts,
  runUnverifiedAccountPurge,
  UNVERIFIED_ACCOUNT_RETENTION_MS,
} from '../src/lib/auth/purge-unverified-accounts';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { TERMS_VERSION } from '../src/lib/legal/documents';
import { resetLocalSweepLocksForTests } from '../src/lib/redis/leader-lock';
import { credentialsVault } from '../src/lib/storage/credentials-vault';
import { jsonPost, stubMailConfig } from './helpers/auth-mail-fixtures';

/**
 * The accounts whose address stays unverified for 30 days are deleted with everything they own (docs/policy-decisions.md, entry
 * 363). Without REDIS_URL the user store keeps accounts in this process; the Redis-mode CI step (npm run test:redis) runs the same
 * cases against a real Redis, where the scan, the atomic claim and the erasure of the keys are the real ones.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const created: string[] = [];

/** An account made `ageDays` ago, so the retention can be judged without waiting. */
async function accountAged(
  ageDays: number,
  fields: { provider?: 'email' | 'google'; emailVerified?: boolean; tier?: 'free' | 'paid' } = {}
) {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() - ageDays * DAY_MS });
  try {
    const user = await redisUserStore.createUser({
      email: `purge_${crypto.randomUUID()}@purge.test`,
      name: 'Purge',
      acceptedTermsVersion: TERMS_VERSION,
      provider: 'email',
      ...fields,
    });
    created.push(user.id);
    return user;
  } finally {
    vi.useRealTimers();
  }
}

async function ownedRecords(userId: string) {
  const { key, secretKey } = await redisKeyStore.generateApiKey(userId, 'squat key', { scopes: ['*'], acceptedTermsVersion: TERMS_VERSION });
  const credentialId = await credentialsVault.store(userId, { type: 'http', url: 'https://93.184.215.14/out' });
  return { keyId: key.id, secretKey, credentialId };
}

async function leftOf(user: { id: string; email: string }, owned: { secretKey: string; credentialId: string }) {
  return {
    record: await redisUserStore.findById(user.id),
    byEmail: await redisUserStore.findByEmail(user.email),
    keyValid: (await redisKeyStore.verifyApiKey(owned.secretKey)).valid,
    credentials: await credentialsVault.listByUser(user.id),
  };
}

beforeEach(() => {
  stubMailConfig();
  vi.stubEnv('STORAGE_VAULT_KEY', 'purge-vault-key-0123456789abcdef0123');
  resetLoginRateLimiterStore();
  resetLocalSweepLocksForTests();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  const client = redisKeyStore.getRedisClient();
  if (client) await client.del(`${redisKeyStore.getPrefix()}sweep_lock:unverified-account-purge`);
  for (const userId of created.splice(0)) {
    const plan = await planAccountErasure(userId);
    if (plan) await eraseAccount(plan, { drainMs: 0 });
  }
});

describe('the purge of accounts that stayed unverified', () => {
  it('deletes an account unverified for more than 30 days with its keys, credentials, tokens and email index', async () => {
    const user = await accountAged(31);
    const owned = await ownedRecords(user.id);
    const token = await issueAuthToken('verify', { userId: user.id, email: user.email });
    await redisKeyStore.deductQuota(user.id, 1);

    const report = await purgeUnverifiedAccounts();

    expect(report).toMatchObject({ purged: 1, deferred: 0, failed: 0, stoppedEarly: false });
    expect(await leftOf(user, owned)).toEqual({ record: null, byEmail: null, keyValid: false, credentials: [] });
    expect(await consumeAuthToken('verify', token)).toBeNull();
    expect(await redisUserStore.getSessionVersion(user.id)).toBe(1);
  });

  it('keeps an account that is not yet 30 days old, at the edge of the retention', async () => {
    const young = await accountAged(29);
    const edge = await accountAged(UNVERIFIED_ACCOUNT_RETENTION_MS / DAY_MS - 0.001);
    const youngOwned = await ownedRecords(young.id);

    const report = await purgeUnverifiedAccounts();

    expect(report.purged).toBe(0);
    expect((await leftOf(young, youngOwned)).record?.id).toBe(young.id);
    expect((await redisUserStore.findById(edge.id))?.id).toBe(edge.id);
  });

  it('never touches a verified account, a Google account, or an account verified by the old rule, however old', async () => {
    const verified = await accountAged(400, { emailVerified: true });
    const google = await accountAged(400, { provider: 'google', emailVerified: true });
    const verifiedOwned = await ownedRecords(verified.id);

    const report = await purgeUnverifiedAccounts();

    expect(report).toMatchObject({ expired: 0, purged: 0 });
    expect((await leftOf(verified, verifiedOwned)).keyValid).toBe(true);
    expect((await redisUserStore.findById(google.id))?.id).toBe(google.id);
  });

  it('keeps an old unverified account that paid: a paid tier, package credits', async () => {
    const paidTier = await accountAged(60, { tier: 'paid' });
    const credited = await accountAged(60);
    await redisKeyStore.creditPackage(credited.id, { transactionId: `txn_${crypto.randomUUID()}`, credits: 100, paid: '500', at: Date.now() });

    const report = await purgeUnverifiedAccounts();

    expect(report).toMatchObject({ expired: 2, keptPaying: 2, purged: 0 });
    expect(await redisUserStore.findById(paidTier.id)).not.toBeNull();
    expect(await redisUserStore.findById(credited.id)).not.toBeNull();
  });

  it('does not delete an account whose address was confirmed between the scan and the claim', async () => {
    const user = await accountAged(45);
    const owned = await ownedRecords(user.id);
    const claim = redisUserStore.claimUnverifiedForPurge.bind(redisUserStore);
    vi.spyOn(redisUserStore, 'claimUnverifiedForPurge').mockImplementationOnce(async (id, cutoff) => {
      await redisUserStore.updateUser(id, { emailVerified: true, verifiedAt: Date.now() });
      return claim(id, cutoff);
    });

    const report = await purgeUnverifiedAccounts();

    expect(report).toMatchObject({ expired: 1, raced: 1, purged: 0 });
    const left = await leftOf(user, owned);
    expect(left.record?.emailVerified).toBe(true);
    expect(left.keyValid).toBe(true);
    expect(left.credentials).toEqual([owned.credentialId]);
  });

  it('refuses to confirm an account once it is claimed, by the link and by the store', async () => {
    const user = await accountAged(45);
    expect(await redisUserStore.claimUnverifiedForPurge(user.id, Date.now() - UNVERIFIED_ACCOUNT_RETENTION_MS)).toBe(true);
    // A claim that stopped halfway is claimed again by the next pass.
    expect(await redisUserStore.claimUnverifiedForPurge(user.id, Date.now() - UNVERIFIED_ACCOUNT_RETENTION_MS)).toBe(true);

    expect(await redisUserStore.updateUser(user.id, { emailVerified: true })).toBeNull();
    const token = await issueAuthToken('verify', { userId: user.id, email: user.email });
    const response = await confirmVerification(jsonPost('/api/auth/email-verification/confirm', { token }));
    expect(response.status).toBe(400);
    expect((await redisUserStore.findById(user.id))?.emailVerified).not.toBe(true);
  });

  it('lets exactly one of a claim and a confirmation win when they arrive together', async () => {
    const cutoff = Date.now() - UNVERIFIED_ACCOUNT_RETENTION_MS;
    for (let round = 0; round < 25; round++) {
      const user = await accountAged(45);
      const [claimed, confirmed] = await Promise.all([
        redisUserStore.claimUnverifiedForPurge(user.id, cutoff),
        redisUserStore.updateUser(user.id, { emailVerified: true, verifiedAt: Date.now() }),
      ]);
      const stored = await redisUserStore.findById(user.id);
      // The claim won and the confirmation was refused, or the confirmation won and the claim found a verified account.
      expect(claimed).toBe(confirmed === null);
      expect(stored?.emailVerified === true).toBe(confirmed !== null);
      expect(stored?.purgingAt !== undefined).toBe(claimed);
    }
  });

  it('claims nothing that is verified, too young, or gone', async () => {
    const verified = await accountAged(90, { emailVerified: true });
    const young = await accountAged(1);
    const cutoff = Date.now() - UNVERIFIED_ACCOUNT_RETENTION_MS;

    expect(await redisUserStore.claimUnverifiedForPurge(verified.id, cutoff)).toBe(false);
    expect(await redisUserStore.claimUnverifiedForPurge(young.id, cutoff)).toBe(false);
    expect(await redisUserStore.claimUnverifiedForPurge(crypto.randomUUID(), cutoff)).toBe(false);
    expect((await redisUserStore.findById(young.id))?.purgingAt).toBeUndefined();
  });

  it('erases at most the cap in one pass, and the next pass goes on', async () => {
    const accounts = [await accountAged(40), await accountAged(41), await accountAged(42)];

    const first = await purgeUnverifiedAccounts({ maxPurges: 2 });
    expect(first).toMatchObject({ purged: 2, stoppedEarly: true });
    const second = await purgeUnverifiedAccounts({ maxPurges: 2 });
    expect(second).toMatchObject({ purged: 1, stoppedEarly: false });
    for (const account of accounts) expect(await redisUserStore.findById(account.id)).toBeNull();
  });

  it('stops after failures in a row, and counts a failure of one account without stopping the rest', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const accounts: { id: string }[] = [];
    for (let n = 0; n < MAX_FAILURES_IN_A_ROW + 2; n++) accounts.push(await accountAged(50 + n));
    const claim = vi.spyOn(redisUserStore, 'claimUnverifiedForPurge').mockRejectedValue(new Error('the store went away'));

    const report = await purgeUnverifiedAccounts();
    expect(report).toMatchObject({ failed: MAX_FAILURES_IN_A_ROW, purged: 0, stoppedEarly: true });

    claim.mockRestore();
    const rerun = await purgeUnverifiedAccounts();
    expect(rerun).toMatchObject({ purged: MAX_FAILURES_IN_A_ROW + 2, failed: 0 });
  });

  it('stops starting accounts once its deadline has passed', async () => {
    await accountAged(40);
    const report = await purgeUnverifiedAccounts({ deadlineMs: 0 });
    expect(report).toMatchObject({ purged: 0, stoppedEarly: true });
  });

  it('logs counts only, never an address or an id, and runs once under the leader lock', async () => {
    const user = await accountAged(40);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runUnverifiedAccountPurge();
    await runUnverifiedAccountPurge();

    const lines = log.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('unverified_purge'));
    expect(lines).toEqual(['[auth] unverified_purge expired=1 purged=1 deferred=0 kept_paying=0 raced=0 failed=0 stopped_early=false']);
    expect(lines.join('\n')).not.toContain(user.email);
    expect(lines.join('\n')).not.toContain(user.id);
  });
});

describe('the scan of unverified accounts', () => {
  it('returns the ids of old unverified accounts in pages, and no other key of the user store', async () => {
    const cutoff = Date.now() - UNVERIFIED_ACCOUNT_RETENTION_MS;
    const old = [];
    for (let n = 0; n < 7; n++) old.push((await accountAged(40 + n)).id);
    await accountAged(40, { emailVerified: true });
    await accountAged(2);
    await redisUserStore.incrementSessionVersion(old[0]);
    await redisUserStore.revokeJti(`jti-${crypto.randomUUID()}`, 60);

    const pages: string[][] = [];
    for await (const ids of redisUserStore.scanUnverifiedBefore(cutoff, 2)) pages.push(ids);

    expect(pages.flat().sort()).toEqual([...old].sort());
    expect(new Set(pages.flat()).size).toBe(old.length);
  });
});
