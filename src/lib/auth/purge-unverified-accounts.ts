import { redisKeyStore } from '../api-keys/redis-key-store';
import { subscriptionStore } from '../billing/subscription-store';
import { withRedisLeaderLock } from '../redis/leader-lock';
import { eraseAccount, planAccountErasure } from './erase-account';
import { isEmailVerified } from './email-verified';
import { redisUserStore } from './redis-user-store';
import type { UserRecord } from './types';

/**
 * Deletes the accounts whose address stayed unverified for 30 days, with everything they own (docs/policy-decisions.md, entry 364).
 * Each worker starts a timer and a Redis leader lock lets one of them run a pass; a pass scans the user records a page at a time,
 * claims each old unverified account in one atomic step (`claimUnverifiedForPurge`, which an address confirmed a moment ago
 * fails) and erases it through the same path as the erasure of an account (`eraseAccount`). The log carries counts, never addresses.
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
/** Failures in a row after which a pass stops: the store is down, and each further account would fail the same way. */
export const MAX_FAILURES_IN_A_ROW = 5;

const LOCK_NAME = 'unverified-account-purge';

export interface PurgeReport {
  /** Unverified accounts past the retention that the scan found. */
  expired: number;
  /** Erased, with the account itself. */
  purged: number;
  /** Claimed, but a running job of the account kept the erasure from finishing; the next pass finishes it. */
  deferred: number;
  /** Left alone because the account holds a plan, credits, a debt or a checkout hold: it paid, so someone owns it. */
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
}

/** Whether the account paid for something that an erasure would take away or leave unpaid. */
async function holdsPayment(user: UserRecord): Promise<boolean> {
  if (user.tier !== 'free') return true;
  const [subscription, credits, debt, hold] = await Promise.all([
    subscriptionStore.findByUser(user.id),
    redisKeyStore.packageBalance(user.id),
    redisKeyStore.packageDebt(user.id),
    redisKeyStore.hasBillingHold(user.id),
  ]);
  return subscription !== null || credits > 0 || debt > 0 || hold;
}

type Outcome = 'purged' | 'deferred' | 'keptPaying' | 'raced';

async function purgeOne(userId: string, cutoff: number): Promise<Outcome> {
  const user = await redisUserStore.findById(userId);
  if (!user || isEmailVerified(user)) return 'raced';
  if (await holdsPayment(user)) return 'keptPaying';
  if (!(await redisUserStore.claimUnverifiedForPurge(userId, cutoff))) return 'raced';
  const plan = await planAccountErasure(userId);
  if (!plan) return 'raced';
  return (await eraseAccount(plan)).runningJobIds.length > 0 ? 'deferred' : 'purged';
}

/** One pass over the accounts. It returns what it did; a failure of one account is counted, and the pass goes on to the next. */
export async function purgeUnverifiedAccounts(options: PurgeOptions = {}): Promise<PurgeReport> {
  const now = options.now ?? Date.now();
  const cutoff = now - UNVERIFIED_ACCOUNT_RETENTION_MS;
  const maxPurges = options.maxPurges ?? MAX_PURGES_PER_RUN;
  const deadline = Date.now() + (options.deadlineMs ?? PURGE_RUN_DEADLINE_MS);
  const report: PurgeReport = { expired: 0, purged: 0, deferred: 0, keptPaying: 0, raced: 0, failed: 0, stoppedEarly: false };
  let failuresInARow = 0;

  for await (const ids of redisUserStore.scanUnverifiedBefore(cutoff)) {
    for (const userId of ids) {
      if (report.purged + report.deferred >= maxPurges || Date.now() >= deadline || failuresInARow >= MAX_FAILURES_IN_A_ROW) {
        report.stoppedEarly = true;
        return report;
      }
      report.expired += 1;
      try {
        report[await purgeOne(userId, cutoff)] += 1;
        failuresInARow = 0;
      } catch (error: unknown) {
        console.error(`[auth] unverified_purge account failed: ${error instanceof Error ? error.name : 'unknown error'}`);
        report.failed += 1;
        failuresInARow += 1;
      }
    }
  }
  return report;
}

function logReport(report: PurgeReport): void {
  console.log(
    `[auth] unverified_purge expired=${report.expired} purged=${report.purged} deferred=${report.deferred} kept_paying=${report.keptPaying} raced=${report.raced} failed=${report.failed} stopped_early=${report.stoppedEarly}`
  );
}

/** One pass under the leader lock: a worker whose timer fires while another holds the lock does nothing. */
export async function runUnverifiedAccountPurge(options: PurgeOptions = {}): Promise<void> {
  await withRedisLeaderLock(LOCK_NAME, PURGE_LOCK_LEASE_MS, PURGE_HOLD_MS, async () => logReport(await purgeUnverifiedAccounts(options)));
}

let timer: NodeJS.Timeout | undefined;
let firstRun: NodeJS.Timeout | undefined;

/**
 * Runs a pass `PURGE_FIRST_RUN_DELAY_MS` after the call and then every `PURGE_INTERVAL_MS`. Every worker calls it; the lock lets one
 * run at a time. A pass that fails is logged by its error name and the next one tries again.
 */
export function startUnverifiedAccountPurge(): void {
  if (timer) return;
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
