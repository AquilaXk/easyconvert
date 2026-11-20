import { redisKeyStore } from '../api-keys/redis-key-store';
import { subscriptionStore } from '../billing/subscription-store';
import { withRedisLeaderLock, type RenewLease } from '../redis/leader-lock';
import { eraseAccount, planAccountErasure } from './erase-account';
import { isEmailVerified } from './email-verified';
import { redisUserStore } from './redis-user-store';
import { AuthStoreUnavailableError } from './store-unavailable';
import type { UserRecord } from './types';

/**
 * Deletes the accounts whose address stayed unverified for 30 days, with everything they own (docs/policy-decisions.md, entry 364).
 * It is off unless `UNVERIFIED_ACCOUNT_PURGE_ENABLED` is `true`, because an account made while mail was off could never confirm its
 * address; once on, it logs counts without deleting anything until `UNVERIFIED_ACCOUNT_PURGE_DRY_RUN` is `false`. Each worker starts
 * a timer and a Redis leader lock lets one of them run a pass; a pass scans the user records a page at a time, claims each old
 * unverified account in one atomic step (`claimUnverifiedForPurge`, which an address confirmed a moment ago fails) and erases it
 * through the same path as the erasure of an account (`eraseAccount`). The log carries counts, never addresses.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** An account whose address is still unverified this long after it was made is deleted. */
export const UNVERIFIED_ACCOUNT_RETENTION_MS = 30 * DAY_MS;
/** A pass runs once a day; the lock stays closed 23 hours after a pass that completed, so the timers of other workers do not run it again. */
export const PURGE_INTERVAL_MS = DAY_MS;
export const PURGE_HOLD_MS = 23 * 60 * 60 * 1000;
/** A pass stops starting accounts after this long; the lock lasts longer, so a pass that ended by its deadline has let go first. */
export const PURGE_RUN_DEADLINE_MS = 20 * 60 * 1000;
const PURGE_LOCK_LEASE_MS = 30 * 60 * 1000;
/** The first pass waits this long after the worker starts, so a rollout of several workers does not start them in the same second. */
export const PURGE_FIRST_RUN_DELAY_MS = 3 * 60 * 1000;
/** Accounts one pass erases at most; a backlog is cleared over the following days. */
export const MAX_PURGES_PER_RUN = 500;
/** Failures of the store itself in a row after which a pass stops: it is down, and each further account would fail the same way. */
export const MAX_FAILURES_IN_A_ROW = 5;

const LOCK_NAME = 'unverified-account-purge';

export interface PurgeReport {
  /** Unverified accounts past the retention that the scan found. */
  expired: number;
  /** Erased, with the account itself. */
  purged: number;
  /** Claimed, but a running job of the account kept the erasure from finishing; the next pass finishes it. */
  deferred: number;
  /** Dry run only: accounts a live pass would claim and erase. A dry pass claims and deletes nothing. */
  wouldPurge: number;
  /** Left alone because the account has a payment history (a subscription record, package payments, credits, a debt or a checkout hold): someone paid. */
  keptPaying: number;
  /** Not claimed because the address was confirmed (or the account erased) after the scan read it. */
  raced: number;
  failed: number;
  /** The pass stopped before the scan ended (deadline, the cap, or failures in a row). */
  stoppedEarly: boolean;
}

export interface PurgeOptions {
  now?: number;
  maxPurges?: number;
  deadlineMs?: number;
  /** Log what a pass would do and claim nothing. */
  dryRun?: boolean;
  /** Asked before each account; false (the leader lock was lost) ends the pass. */
  keepLock?: RenewLease;
}

export type PurgeMode = 'off' | 'dry-run' | 'live';

/** Off unless `UNVERIFIED_ACCOUNT_PURGE_ENABLED` is `true`; then a dry run unless `UNVERIFIED_ACCOUNT_PURGE_DRY_RUN` is `false`. */
export function unverifiedPurgeMode(env: Record<string, string | undefined> = process.env): PurgeMode {
  if (env.UNVERIFIED_ACCOUNT_PURGE_ENABLED?.trim().toLowerCase() !== 'true') return 'off';
  return env.UNVERIFIED_ACCOUNT_PURGE_DRY_RUN?.trim().toLowerCase() === 'false' ? 'live' : 'dry-run';
}

/**
 * Whether the account has a payment history. A package that was bought and spent to zero still counts: the erasure deletes the index
 * that a later refund or chargeback finds the account by, and those events would then name a payment nobody owns.
 */
async function holdsPayment(user: UserRecord): Promise<boolean> {
  if (user.tier !== 'free') return true;
  const [subscription, transactions, credits, debt, hold] = await Promise.all([
    subscriptionStore.findByUser(user.id),
    redisKeyStore.packageTransactionCount(user.id),
    redisKeyStore.packageBalance(user.id),
    redisKeyStore.packageDebt(user.id),
    redisKeyStore.hasBillingHold(user.id),
  ]);
  return subscription !== null || transactions > 0 || credits > 0 || debt > 0 || hold;
}

type Outcome = 'purged' | 'deferred' | 'keptPaying' | 'raced' | 'wouldPurge';

async function purgeOne(userId: string, cutoff: number, dryRun: boolean): Promise<Outcome> {
  const user = await redisUserStore.findById(userId);
  if (!user || isEmailVerified(user)) return 'raced';
  if (await holdsPayment(user)) return 'keptPaying';
  if (dryRun) return 'wouldPurge';
  if (!(await redisUserStore.claimUnverifiedForPurge(userId, cutoff))) return 'raced';
  const plan = await planAccountErasure(userId);
  if (!plan) return 'raced';
  return (await eraseAccount(plan)).runningJobIds.length > 0 ? 'deferred' : 'purged';
}

const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'NR_CLOSED']);
const STORE_REFUSALS = /^(Connection is closed|OOM|LOADING|READONLY|CLUSTERDOWN|MASTERDOWN)/;

/** Whether `error` says the store is down or refusing, as opposed to one account that cannot be erased. */
function isStoreFailure(error: unknown): boolean {
  if (error instanceof AuthStoreUnavailableError) return true;
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return error.name === 'MaxRetriesPerRequestError' || (typeof code === 'string' && CONNECTION_CODES.has(code)) || STORE_REFUSALS.test(error.message);
}

/**
 * One pass over the accounts. It returns what it did. An account that fails is counted and left for the next pass, and the pass goes on
 * to the next account, so accounts that can never be erased do not stop it; it stops only after `MAX_FAILURES_IN_A_ROW` failures of the
 * store itself.
 */
export async function purgeUnverifiedAccounts(options: PurgeOptions = {}): Promise<PurgeReport> {
  const now = options.now ?? Date.now();
  const cutoff = now - UNVERIFIED_ACCOUNT_RETENTION_MS;
  const maxPurges = options.maxPurges ?? MAX_PURGES_PER_RUN;
  const deadline = Date.now() + (options.deadlineMs ?? PURGE_RUN_DEADLINE_MS);
  const dryRun = options.dryRun ?? false;
  const report: PurgeReport = { expired: 0, purged: 0, deferred: 0, wouldPurge: 0, keptPaying: 0, raced: 0, failed: 0, stoppedEarly: false };
  const failedIds = new Set<string>();
  let storeFailuresInARow = 0;

  for await (const ids of redisUserStore.scanUnverifiedBefore(cutoff)) {
    for (const userId of ids) {
      // A scan can name an id twice; an account that already failed in this pass is not tried again.
      if (failedIds.has(userId)) continue;
      if (report.purged + report.deferred >= maxPurges || Date.now() >= deadline || storeFailuresInARow >= MAX_FAILURES_IN_A_ROW || (options.keepLock && !(await options.keepLock()))) {
        report.stoppedEarly = true;
        return report;
      }
      report.expired += 1;
      try {
        report[await purgeOne(userId, cutoff, dryRun)] += 1;
        storeFailuresInARow = 0;
      } catch (error: unknown) {
        console.error(`[auth] unverified_purge account failed: ${error instanceof Error ? error.name : 'unknown error'}`);
        failedIds.add(userId);
        report.failed += 1;
        storeFailuresInARow = isStoreFailure(error) ? storeFailuresInARow + 1 : 0;
      }
    }
  }
  return report;
}

function logReport(report: PurgeReport, dryRun: boolean): void {
  console.log(
    `[auth] unverified_purge dry_run=${dryRun} expired=${report.expired} purged=${report.purged} would_purge=${report.wouldPurge} deferred=${report.deferred} kept_paying=${report.keptPaying} raced=${report.raced} failed=${report.failed} stopped_early=${report.stoppedEarly}`
  );
}

/** One pass under the leader lock: a worker whose timer fires while another holds the lock does nothing. The lease is renewed before each account. */
export async function runUnverifiedAccountPurge(options: PurgeOptions = {}): Promise<void> {
  const dryRun = options.dryRun ?? unverifiedPurgeMode() !== 'live';
  await withRedisLeaderLock(LOCK_NAME, PURGE_LOCK_LEASE_MS, PURGE_HOLD_MS, async (renew) =>
    logReport(await purgeUnverifiedAccounts({ keepLock: renew, ...options, dryRun }), dryRun)
  );
}

let timer: NodeJS.Timeout | undefined;
let firstRun: NodeJS.Timeout | undefined;

/**
 * Runs a pass `PURGE_FIRST_RUN_DELAY_MS` after the call and then every `PURGE_INTERVAL_MS`, when `UNVERIFIED_ACCOUNT_PURGE_ENABLED` is
 * `true`; otherwise no timer starts. Every worker calls it; the lock lets one run at a time. A pass that fails is logged by its error name and the next one tries again.
 */
export function startUnverifiedAccountPurge(): void {
  if (timer || unverifiedPurgeMode() === 'off') return;
  const run = (): void => {
    runUnverifiedAccountPurge().catch((error: unknown) =>
      console.error(`[auth] unverified_purge failed: ${error instanceof Error ? error.name : 'unknown error'}`)
    );
  };
  firstRun = setTimeout(run, PURGE_FIRST_RUN_DELAY_MS);
  firstRun.unref();
  timer = setInterval(run, PURGE_INTERVAL_MS);
  timer.unref();
}

export function stopUnverifiedAccountPurge(): void {
  if (timer) clearInterval(timer);
  if (firstRun) clearTimeout(firstRun);
  timer = undefined;
  firstRun = undefined;
}
