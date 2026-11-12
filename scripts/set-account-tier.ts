import { redisUserStore } from '../src/lib/auth/redis-user-store';
import type { UserRecord, UserTier } from '../src/lib/auth/types';
import { isEntitlingStatus } from '../src/lib/billing/entitlement';
import { subscriptionStore } from '../src/lib/billing/subscription-store';

/**
 * Sets the plan of an account by hand, for the operator's own test account (QA 2026-11-12): the paid limits without a payment.
 * A dry run by default; `--apply` writes. An account whose plan comes from a live subscription is refused, so a payment is never
 * overridden, and the change is printed with the time for the host's log. Billing events later set the plan of a paying account
 * as usual.
 */
export const SETTABLE_TIERS: readonly UserTier[] = ['free', 'pro', 'enterprise'];

export interface TierChange {
  userId: string;
  email: string;
  from: UserTier;
  to: UserTier;
}

function findAccount(idOrEmail: string): Promise<UserRecord | null | undefined> {
  return idOrEmail.includes('@') ? redisUserStore.findByEmail(idOrEmail) : redisUserStore.findById(idOrEmail);
}

/** What `--apply` would change, or why it will not. */
export async function planTierChange(idOrEmail: string, tier: UserTier): Promise<TierChange | { refusal: string }> {
  const user = await findAccount(idOrEmail);
  if (!user) return { refusal: `No account ${idOrEmail}.` };
  const subscription = await subscriptionStore.findByUser(user.id);
  if (subscription && isEntitlingStatus(subscription.status)) {
    return { refusal: `The plan of ${user.email} comes from a live subscription (${subscription.status}); change it at the payment provider.` };
  }
  return { userId: user.id, email: user.email, from: user.tier, to: tier };
}

/** Writes the plan with no end date, so a paid plan set by hand does not lapse to free. */
export async function applyTierChange(change: TierChange): Promise<void> {
  const updated = await redisUserStore.updateUser(change.userId, { tier: change.to, tierUntil: undefined });
  if (!updated || updated.tier !== change.to) throw new Error(`The plan of ${change.email} was not written.`);
}

async function main(argv: readonly string[]): Promise<number> {
  const valueOf = (flag: string): string | undefined => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const idOrEmail = valueOf('--user');
  const tier = valueOf('--tier') as UserTier | undefined;
  if (!idOrEmail || !tier || !SETTABLE_TIERS.includes(tier)) {
    console.error(`Usage: set-account-tier --user <account id or email> --tier <${SETTABLE_TIERS.join('|')}> [--apply]`);
    return 2;
  }
  const change = await planTierChange(idOrEmail, tier);
  if ('refusal' in change) {
    console.error(change.refusal);
    return 1;
  }
  console.log(`${change.email} (${change.userId}): ${change.from} -> ${change.to}`);
  if (!argv.includes('--apply')) {
    console.log('Dry run: nothing was written. Run again with --apply to write.');
    return 0;
  }
  await applyTierChange(change);
  console.log(`${new Date().toISOString()} set-account-tier: ${change.userId} ${change.from} -> ${change.to}`);
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
