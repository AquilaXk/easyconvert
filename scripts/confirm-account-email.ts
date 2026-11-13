import { redisUserStore } from '../src/lib/auth/redis-user-store';
import type { UserRecord } from '../src/lib/auth/types';

/**
 * Marks the email address of one password account as confirmed, for the operator's own test account (QA 2026-11-13): since
 * entry 288 an unconfirmed password account converts nothing of its own, and the smoke checks after a deploy run with that
 * account's API key. A dry run by default; `--apply` writes and prints the time for the host's log. An account that signs in
 * with Google, or whose address is already confirmed, is left alone.
 */
export interface EmailConfirmation {
  userId: string;
  email: string;
}

function findAccount(idOrEmail: string): Promise<UserRecord | null | undefined> {
  return idOrEmail.includes('@') ? redisUserStore.findByEmail(idOrEmail) : redisUserStore.findById(idOrEmail);
}

/** What `--apply` would change, or why it will not. */
export async function planEmailConfirmation(idOrEmail: string): Promise<EmailConfirmation | { refusal: string }> {
  const user = await findAccount(idOrEmail);
  if (!user) return { refusal: `No account ${idOrEmail}.` };
  if (user.provider !== 'email') return { refusal: `${user.email} signs in with ${user.provider}; its address needs no confirmation.` };
  if (user.emailVerified === true) return { refusal: `The address of ${user.email} is already confirmed.` };
  return { userId: user.id, email: user.email };
}

export async function applyEmailConfirmation(change: EmailConfirmation): Promise<void> {
  const updated = await redisUserStore.updateUser(change.userId, { emailVerified: true });
  if (updated?.emailVerified !== true) throw new Error(`The address of ${change.email} was not confirmed.`);
}

async function main(argv: readonly string[]): Promise<number> {
  const idOrEmail = argv.includes('--user') ? argv[argv.indexOf('--user') + 1] : undefined;
  if (!idOrEmail) {
    console.error('Usage: confirm-account-email --user <account id or email> [--apply]');
    return 2;
  }
  const change = await planEmailConfirmation(idOrEmail);
  if ('refusal' in change) {
    console.error(change.refusal);
    return 1;
  }
  console.log(`${change.email} (${change.userId}): address unconfirmed -> confirmed`);
  if (!argv.includes('--apply')) {
    console.log('Dry run: nothing was written. Run again with --apply to write.');
    return 0;
  }
  await applyEmailConfirmation(change);
  console.log(`${new Date().toISOString()} confirm-account-email: ${change.userId}`);
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
