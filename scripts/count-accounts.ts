import { isEmailVerified } from '../src/lib/auth/email-verified';
import { parseOperatorCliArgs } from '../src/lib/auth/operator-cli-args';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import type { UserRecord } from '../src/lib/auth/types';

/**
 * Prints how many accounts there are and how they split, for the operator's weekly look at sign-ups. It reads the user records a page
 * at a time (`redisUserStore.scanRecords`), adds each one to the counters and drops the page, so memory does not grow with the number
 * of accounts. It writes nothing and prints no address, id or name, only counts.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AccountCounts {
  total: number;
  /** Sign-in method: `other` is a provider this release does not know. */
  byProvider: { email: number; google: number; other: number };
  /** By `isEmailVerified`: a Google account counts as confirmed, an email account without the field as not confirmed. */
  emailConfirmed: number;
  emailNotConfirmed: number;
  createdLast7Days: number;
  createdLast30Days: number;
  /** By the tier as stored. */
  byTier: Record<string, number>;
  /** The purge of unverified accounts claimed these (`purgingAt`). */
  purging: number;
  suspended: number;
}

function emptyCounts(): AccountCounts {
  return {
    total: 0,
    byProvider: { email: 0, google: 0, other: 0 },
    emailConfirmed: 0,
    emailNotConfirmed: 0,
    createdLast7Days: 0,
    createdLast30Days: 0,
    byTier: {},
    purging: 0,
    suspended: 0,
  };
}

function addAccount(counts: AccountCounts, user: UserRecord, now: number): void {
  counts.total += 1;
  counts.byProvider[user.provider === 'email' || user.provider === 'google' ? user.provider : 'other'] += 1;
  counts[isEmailVerified(user) ? 'emailConfirmed' : 'emailNotConfirmed'] += 1;
  if (user.createdAt > now - 7 * DAY_MS) counts.createdLast7Days += 1;
  if (user.createdAt > now - 30 * DAY_MS) counts.createdLast30Days += 1;
  counts.byTier[user.tier] = (counts.byTier[user.tier] ?? 0) + 1;
  if (typeof user.purgingAt === 'number') counts.purging += 1;
  if (typeof user.suspendedAt === 'number') counts.suspended += 1;
}

export async function countAccounts(now: number = Date.now()): Promise<AccountCounts> {
  const counts = emptyCounts();
  for await (const page of redisUserStore.scanRecords()) {
    for (const user of page) addAccount(counts, user, now);
  }
  return counts;
}

export function formatAccountCounts(counts: AccountCounts): string {
  const tiers = Object.entries(counts.byTier).sort(([a], [b]) => a.localeCompare(b));
  return [
    `total accounts: ${counts.total}`,
    `sign-in email: ${counts.byProvider.email}`,
    `sign-in google: ${counts.byProvider.google}`,
    `sign-in other: ${counts.byProvider.other}`,
    `email confirmed: ${counts.emailConfirmed}`,
    `email not confirmed: ${counts.emailNotConfirmed}`,
    `created in the last 7 days: ${counts.createdLast7Days}`,
    `created in the last 30 days: ${counts.createdLast30Days}`,
    ...tiers.map(([tier, count]) => `tier ${tier}: ${count}`),
    `being purged: ${counts.purging}`,
    `suspended: ${counts.suspended}`,
  ].join('\n');
}

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseOperatorCliArgs(argv, { valueFlags: [], booleanFlags: ['--json'] });
  if (!parsed.ok) {
    console.error(`${parsed.error}\nUsage: count-accounts [--json]`);
    return 2;
  }
  const counts = await countAccounts();
  console.log(parsed.flags.has('--json') ? JSON.stringify(counts) : formatAccountCounts(counts));
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    }
  );
}
