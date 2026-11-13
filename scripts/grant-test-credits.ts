import crypto from 'node:crypto';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import type { UserRecord } from '../src/lib/auth/types';

/**
 * Adds package credits to the operator's own test account without a payment (QA 2026-11-14): the smoke checks after a deploy
 * run with that account's API key, and since entry 285 a plan set by hand carries no credits, so the free day of 10 credits ran
 * out before the checks did. A dry run by default; `--apply` writes. The grant is recorded in the ledger like a payment, under
 * an operator transaction id with a paid amount of 0, so it shows in the account's balance and no refund can find it; the
 * time, the account and the credits are printed for the host's log.
 */
export const MAX_TEST_CREDITS = 10_000;
const OPERATOR_TRANSACTION_PREFIX = 'operator-test-';

export interface TestCreditGrant {
  userId: string;
  email: string;
  credits: number;
  balance: number;
}

function findAccount(idOrEmail: string): Promise<UserRecord | null | undefined> {
  return idOrEmail.includes('@') ? redisUserStore.findByEmail(idOrEmail) : redisUserStore.findById(idOrEmail);
}

/** What `--apply` would add, or why it will not. */
export async function planTestCredits(idOrEmail: string, credits: number): Promise<TestCreditGrant | { refusal: string }> {
  if (!Number.isInteger(credits) || credits < 1 || credits > MAX_TEST_CREDITS) return { refusal: `Credits must be a whole number from 1 to ${MAX_TEST_CREDITS}.` };
  const user = await findAccount(idOrEmail);
  if (!user) return { refusal: `No account ${idOrEmail}.` };
  return { userId: user.id, email: user.email, credits, balance: await redisKeyStore.packageBalance(user.id) };
}

/** Adds the credits once, under a transaction id of its own, and returns the new balance. */
export async function applyTestCredits(grant: TestCreditGrant, now: number = Date.now()): Promise<number> {
  const transactionId = `${OPERATOR_TRANSACTION_PREFIX}${new Date(now).toISOString()}-${crypto.randomUUID()}`;
  const outcome = await redisKeyStore.creditPackage(grant.userId, { transactionId, credits: grant.credits, paid: '0', at: now });
  if (outcome !== 'granted') throw new Error(`The credits of ${grant.email} were not added (${outcome}).`);
  return redisKeyStore.packageBalance(grant.userId);
}

async function main(argv: readonly string[]): Promise<number> {
  const valueOf = (flag: string): string | undefined => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const idOrEmail = valueOf('--user');
  const credits = Number(valueOf('--credits'));
  if (!idOrEmail || !valueOf('--credits')) {
    console.error(`Usage: grant-test-credits --user <account id or email> --credits <1-${MAX_TEST_CREDITS}> [--apply]`);
    return 2;
  }
  const grant = await planTestCredits(idOrEmail, credits);
  if ('refusal' in grant) {
    console.error(grant.refusal);
    return 1;
  }
  console.log(`${grant.email} (${grant.userId}): package balance ${grant.balance} -> ${grant.balance + grant.credits}`);
  if (!argv.includes('--apply')) {
    console.log('Dry run: nothing was written. Run again with --apply to write.');
    return 0;
  }
  const balance = await applyTestCredits(grant);
  console.log(`${new Date().toISOString()} grant-test-credits: ${grant.userId} +${grant.credits} -> ${balance}`);
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
