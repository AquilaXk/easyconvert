import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { countAccounts, formatAccountCounts, main, type AccountCounts } from '../scripts/count-accounts';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { TERMS_VERSION } from '../src/lib/legal/documents';

/**
 * The operator's account counts. Without REDIS_URL the user store keeps accounts in this process; the Redis-mode CI step
 * (npm run test:redis) runs the same cases against a real Redis, where the scan is the real one. Each case counts before and after
 * it seeds, so accounts that other tests left in a shared Redis do not change the result.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const created: { id: string; email: string; name: string }[] = [];

async function account(ageDays: number, fields: { provider?: 'email' | 'google'; emailVerified?: boolean; tier?: 'free' | 'paid' } = {}) {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() - ageDays * DAY_MS });
  try {
    const name = `Name${crypto.randomUUID()}`;
    const user = await redisUserStore.createUser({ email: `count_${crypto.randomUUID()}@count.test`, name, acceptedTermsVersion: TERMS_VERSION, provider: 'email', ...fields });
    created.push({ id: user.id, email: user.email, name });
    return user;
  } finally {
    vi.useRealTimers();
  }
}

function difference(after: AccountCounts, before: AccountCounts): AccountCounts {
  const tiers = new Set([...Object.keys(after.byTier), ...Object.keys(before.byTier)]);
  return {
    total: after.total - before.total,
    byProvider: { email: after.byProvider.email - before.byProvider.email, google: after.byProvider.google - before.byProvider.google, other: after.byProvider.other - before.byProvider.other },
    emailConfirmed: after.emailConfirmed - before.emailConfirmed,
    emailNotConfirmed: after.emailNotConfirmed - before.emailNotConfirmed,
    createdLast7Days: after.createdLast7Days - before.createdLast7Days,
    createdLast30Days: after.createdLast30Days - before.createdLast30Days,
    byTier: Object.fromEntries([...tiers].map((tier) => [tier, (after.byTier[tier] ?? 0) - (before.byTier[tier] ?? 0)])),
    purging: after.purging - before.purging,
    suspended: after.suspended - before.suspended,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const { id } of created.splice(0)) await redisUserStore.deleteUser(id);
});

describe('count-accounts, the operator tool that counts accounts', () => {
  it('counts each kind of account and prints no email, id or name', async () => {
    const before = await countAccounts();
    const confirmed = await account(1, { emailVerified: true });
    const unconfirmed = await account(10);
    const google = await account(40, { provider: 'google' });
    const paid = await account(3, { emailVerified: true, tier: 'paid' });
    const purging = await account(45);
    await redisUserStore.claimUnverifiedForPurge(purging.id, Date.now());
    await redisUserStore.updateUser(paid.id, { suspendedAt: Date.now(), suspendedReason: 'test' });
    const after = await countAccounts();

    expect(difference(after, before)).toEqual({
      total: 5,
      byProvider: { email: 4, google: 1, other: 0 },
      emailConfirmed: 3,
      emailNotConfirmed: 2,
      createdLast7Days: 2,
      createdLast30Days: 3,
      byTier: { free: 4, paid: 1 },
      purging: 1,
      suspended: 1,
    });

    const text = formatAccountCounts(after);
    const json = JSON.stringify(after);
    for (const user of [confirmed, unconfirmed, google, paid, purging]) {
      const seeded = created.find((entry) => entry.id === user.id) as { id: string; email: string; name: string };
      for (const secret of [seeded.id, seeded.email, seeded.name]) {
        expect(text).not.toContain(secret);
        expect(json).not.toContain(secret);
      }
    }
  });

  it('prints one line per figure, or JSON with --json, and refuses an unknown option', async () => {
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line));
    expect(await main([])).toBe(0);
    expect(lines[0].split('\n')[0]).toMatch(/^total accounts: \d+$/);
    expect(await main(['--json'])).toBe(0);
    expect(JSON.parse(lines[1])).toHaveProperty('byProvider');
    log.mockRestore();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await main(['--user', 'x'])).toBe(2);
    expect(error).toHaveBeenCalled();
  });
});
