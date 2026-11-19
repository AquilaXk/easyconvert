import { parseOperatorCliArgs } from '../src/lib/auth/operator-cli-args';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import type { UserRecord } from '../src/lib/auth/types';

/**
 * Operator CLI to suspend or unsuspend an account.
 * Dry-run by default; `--apply` persists the change, revokes active JWT sessions via
 * `incrementSessionVersion`, and emits a structured ISO timestamp line for host logs.
 */
export const MAX_SUSPENSION_REASON_LENGTH = 200;

export type SuspensionAction = 'suspend' | 'unsuspend';

export interface AccountSuspensionPlan {
  action: SuspensionAction;
  userId: string;
  email: string;
  currentlySuspended: boolean;
  reason?: string;
}

/** Strips ASCII control characters (`0x00..0x1f`, `0x7f`), trims, and bounds to 200 codepoints. */
export function sanitizeSuspensionReason(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let cleaned = '';
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) continue;
    cleaned += ch;
  }
  const trimmed = cleaned.trim();
  if (!trimmed) return undefined;
  return Array.from(trimmed).slice(0, MAX_SUSPENSION_REASON_LENGTH).join('').trim() || undefined;
}

function findAccount(idOrEmail: string): Promise<UserRecord | null | undefined> {
  return idOrEmail.includes('@') ? redisUserStore.findByEmail(idOrEmail) : redisUserStore.findById(idOrEmail);
}

/** Builds a dry-run suspension or unsuspension plan without mutating the store. */
export async function planAccountSuspension(
  idOrEmail: string,
  action: SuspensionAction,
  reason?: string
): Promise<AccountSuspensionPlan | { refusal: string }> {
  const user = await findAccount(idOrEmail);
  if (!user) return { refusal: `No account ${idOrEmail}.` };
  return {
    action,
    userId: user.id,
    email: user.email,
    currentlySuspended: typeof user.suspendedAt === 'number',
    reason: action === 'suspend' ? sanitizeSuspensionReason(reason) : undefined,
  };
}

/** Persists the suspension state and advances `sessionVersion` so existing sessions stop immediately. */
export async function applyAccountSuspension(plan: AccountSuspensionPlan, now: number = Date.now()): Promise<UserRecord> {
  const updated =
    plan.action === 'suspend'
      ? await redisUserStore.updateUser(plan.userId, {
          suspendedAt: now,
          suspendedReason: plan.reason ?? null,
        })
      : await redisUserStore.updateUser(plan.userId, {
          suspendedAt: null,
          suspendedReason: null,
        });
  if (!updated) {
    throw new Error(`Account ${plan.email} (${plan.userId}) was not updated.`);
  }
  await redisUserStore.incrementSessionVersion(plan.userId);
  return updated;
}

export async function main(argv: readonly string[]): Promise<number> {
  const usage =
    'Usage: set-account-suspension --user <account id or email> (--suspend [--reason <text>] | --unsuspend) [--apply]';
  const parsed = parseOperatorCliArgs(argv, {
    valueFlags: ['--user', '--reason'],
    booleanFlags: ['--suspend', '--unsuspend', '--apply'],
  });
  if (!parsed.ok) {
    console.error(`${parsed.error}\n${usage}`);
    return 2;
  }
  const idOrEmail = parsed.values.get('--user');
  const suspendFlag = parsed.flags.has('--suspend');
  const unsuspendFlag = parsed.flags.has('--unsuspend');
  if (!idOrEmail || suspendFlag === unsuspendFlag || (unsuspendFlag && parsed.values.has('--reason'))) {
    console.error(usage);
    return 2;
  }

  const action: SuspensionAction = suspendFlag ? 'suspend' : 'unsuspend';
  const plan = await planAccountSuspension(idOrEmail, action, parsed.values.get('--reason'));
  if ('refusal' in plan) {
    console.error(plan.refusal);
    return 1;
  }

  const targetState = plan.action === 'suspend' ? 'suspended' : 'active';
  const previousState = plan.currentlySuspended ? 'suspended' : 'active';
  console.log(`${plan.email} (${plan.userId}): ${previousState} -> ${targetState}${plan.reason ? ` (${plan.reason})` : ''}`);

  if (!parsed.flags.has('--apply')) {
    console.log('Dry run: nothing was written. Run again with --apply to write.');
    return 0;
  }

  const now = Date.now();
  await applyAccountSuspension(plan, now);
  console.log(
    `${new Date(now).toISOString()} set-account-suspension: ${plan.userId} ${plan.action}${plan.reason ? ` reason=${JSON.stringify(plan.reason)}` : ''}`
  );
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
