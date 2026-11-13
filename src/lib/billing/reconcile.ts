import crypto from 'node:crypto';
import { redisKeyStore, type RedisKeyStore } from '../api-keys/redis-key-store';
import { observeBillingEvent } from '../metrics/instruments';
import type { BillingResult } from '../metrics/labels';
import { getBillingProvider } from './index';
import { entitlementOf, isEntitlingStatus } from './entitlement';
import { creditPackagePurchase, refundPackagePurchase } from './package-credits';
import { subscriptionStore, type SubscriptionStore } from './subscription-store';
import type { BillingProvider, ListedPackagePurchase, ListedSubscription, PackageRefund, SubscriptionChange, SubscriptionRecord } from './types';

/**
 * Compares the subscriptions of the store with the provider's list and corrects what a lost event left wrong (docs/policy-decisions.md,
 * entries 277 and 285). The webhook is the fast path; this is the second one, so that a cancellation or a failed renewal that never
 * arrived does not leave a paid tier in place for good, and a subscription whose first event never found its account is seen. A second
 * pass reads the provider's completed payments of the last 30 days, newest first, and credits each package payment the ledger lacks
 * (the credit is idempotent by transaction id, so a payment the webhook already credited changes nothing). A third pass, after the
 * payments, reads the approved refunds and chargebacks of the same 30 days and takes back what each has not yet taken (idempotent by
 * adjustment id, so a refund the webhook applied changes nothing, and one whose payment is not in the ledger yet is left for the next run).
 *
 * The method is a periodic list of the provider's subscriptions, each read through the code that reads a webhook event and compared with
 * the local record, with the safeguards this store needs:
 *
 * - the provider is the source of truth for a subscription's status, plan and period, and its `updatedAt` is the time of the change, so
 *   a correction goes through the same atomic script as an event and is `stale` when a newer event was applied;
 * - an account is never made up: a subscription with no valid binding and no index entry is only counted and logged;
 * - a stored subscription that the provider does not list is downgraded only after a complete listing that looks like the same
 *   account's (a key of another environment lists nothing, and must not take every plan away).
 */

/** The job runs this often; each worker starts a timer, and the lock lets one of them run it. */
export const RECONCILE_INTERVAL_MS = 60 * 60 * 1000;
/** After a run that completed, the lock stays closed this long, so the timers of other workers do not run it again. */
export const RECONCILE_HOLD_MS = 50 * 60 * 1000;
/** A run ends after this long; the lock lasts a little longer, so a run that ended by its deadline has let go before another may start. */
export const RECONCILE_RUN_TIMEOUT_MS = 5 * 60 * 1000;
const LOCK_MARGIN_MS = 60 * 1000;
/** The first run waits this long after the worker starts, so a rollout of several workers does not start them in the same second. */
export const RECONCILE_FIRST_RUN_DELAY_MS = 2 * 60 * 1000;
/** Subscriptions asked for in one request (the most the provider gives), and the pages one run reads: 10,000 subscriptions. */
export const RECONCILE_PAGE_SIZE = 200;
export const RECONCILE_MAX_PAGES = 50;
/** Pause between two pages: 120 requests a minute at most, half of the provider's limit. */
const PAGE_PAUSE_MS = 500;
/** More than this share of the entitling stored subscriptions missing from the list is a list of another account, not canceled subscriptions. */
const MAX_MISSING_SHARE = 0.5;
/** The share is only read from this many entitling subscriptions up; below it a missing one is downgraded unless the list is empty. */
const MIN_FOR_MISSING_SHARE = 4;

const LOCK_NAME = 'reconcile';

export type ReconcileOutcome = 'completed' | 'partial' | 'failed' | 'skipped' | 'disabled';

export interface ReconcileReport {
  outcome: ReconcileOutcome;
  /** Subscriptions the provider listed. */
  listed: number;
  /** Corrections that were written, and stored subscriptions the provider no longer lists that were downgraded. */
  corrected: number;
  downgraded: number;
  /** Subscriptions that give a plan and that no account holds; they are logged and counted, never given an account. */
  unattributed: number;
  /** Completed payments the provider listed that buy a package, the ones the ledger lacked that were credited, and those that name no account. */
  packagesListed: number;
  packagesCredited: number;
  packagesUnattributed: number;
  /** Approved refunds and chargebacks the provider listed, and those that took credits back that no event had taken. */
  refundsListed: number;
  refundsApplied: number;
  /** Why a run is `partial` or `failed`, or the stored subscriptions left alone because the list looks wrong. */
  note?: string;
}

export interface ReconcileOptions {
  provider?: BillingProvider;
  store?: SubscriptionStore;
  now?: () => number;
  /** The ledger package payments are credited to; the key store of this process by default. */
  packages?: RedisKeyStore;
  pagePauseMs?: number;
  runTimeoutMs?: number;
}

interface Run {
  provider: BillingProvider;
  store: SubscriptionStore;
  packages: RedisKeyStore;
  runId: string;
  startedAt: number;
  byUser: Map<string, SubscriptionRecord>;
  bySubscription: Map<string, SubscriptionRecord>;
  report: ReconcileReport;
}

function count(result: BillingResult): void {
  observeBillingEvent('reconcile', result);
}

/** Whether a stored record already says what the provider says. */
function isSame(stored: SubscriptionRecord, listed: SubscriptionChange['subscription']): boolean {
  return (
    stored.providerSubscriptionId === listed.providerSubscriptionId &&
    stored.providerCustomerId === listed.providerCustomerId &&
    stored.status === listed.status &&
    stored.credits === listed.credits &&
    stored.currentPeriodEnd === listed.currentPeriodEnd &&
    stored.cancelAt === listed.cancelAt
  );
}

/** Writes one correction through the store's atomic script and counts what became of it. */
async function correct(run: Run, change: SubscriptionChange): Promise<void> {
  const answer = await run.store.apply(change, run.startedAt);
  if (answer === 'applied') {
    run.report.corrected += 1;
    count('applied');
  } else if (answer === 'unknown_user') {
    run.report.unattributed += 1;
    count('unknown_user');
    console.error(`[billing] reconcile: ${change.subscription.providerSubscriptionId} (${change.subscription.status}) names account ${change.userId}, which no longer exists; not applied`);
  } else if (answer !== 'duplicate') {
    // `stale`: a newer event was applied than the provider's last update, which is the newer word; `other_subscription`: the account holds another one.
    count(answer);
  }
}

/** One subscription of the list: compared with the store and corrected when it differs. */
async function reconcileListed(run: Run, listed: ListedSubscription): Promise<void> {
  const { providerSubscriptionId: id, change } = listed;
  if (!change) {
    count('ignored');
    return;
  }
  const entitling = isEntitlingStatus(change.subscription.status);
  const userId = change.userId ?? run.bySubscription.get(id)?.userId ?? (await run.store.userOfSubscription(id));
  if (!userId) {
    // Nothing to do for a subscription that gives no plan and has no account; one that gives a plan is a payment nobody holds.
    if (!entitling) return;
    run.report.unattributed += 1;
    count('unattributed');
    console.error(`[billing] reconcile: subscription ${id} (${change.subscription.status}, customer ${change.subscription.providerCustomerId}) gives a plan and names no account; not applied`);
    return;
  }
  const stored = run.byUser.get(userId);
  const sameSubscription = stored?.providerSubscriptionId === id;
  const credits = change.subscription.credits ?? (sameSubscription ? stored.credits : undefined);
  if (!credits) {
    count('ignored');
    return;
  }
  const subscription = { ...change.subscription, credits };
  if (sameSubscription ? isSame(stored, subscription) : !entitling) return;
  if (!sameSubscription && stored && isEntitlingStatus(stored.status)) {
    console.error(`[billing] reconcile: account ${userId} holds ${stored.providerSubscriptionId} and the provider lists ${id} as live too; left to the events`);
    return;
  }
  await correct(run, { ...change, eventId: `reconcile:${run.runId}:${id}`, userId, subscription });
}

/** A stored subscription that gives a plan and that a complete list does not name: the provider no longer has it, so it gives nothing. */
async function downgradeMissing(run: Run, listedIds: ReadonlySet<string>): Promise<void> {
  const entitling = [...run.byUser.values()].filter((record) => isEntitlingStatus(record.status) && entitlementOf(record, run.startedAt).tier !== 'free');
  const missing = entitling.filter((record) => !listedIds.has(record.providerSubscriptionId));
  if (missing.length === 0) return;
  const wrongList = listedIds.size === 0 || (entitling.length >= MIN_FOR_MISSING_SHARE && missing.length > entitling.length * MAX_MISSING_SHARE);
  if (wrongList) {
    run.report.note = `${missing.length} of ${entitling.length} stored subscriptions are not in the provider's list of ${listedIds.size}; left alone (a key or environment of another account?)`;
    console.error(`[billing] reconcile: ${run.report.note}`);
    return;
  }
  for (const record of missing) {
    const { userId, eventAt: _eventAt, ...subscription } = record;
    const change: SubscriptionChange = { eventId: `reconcile:${run.runId}:missing:${record.providerSubscriptionId}`, eventAt: run.startedAt, userId, subscription: { ...subscription, status: 'canceled' } };
    const answer = await run.store.apply(change, run.startedAt);
    if (answer === 'applied') {
      run.report.downgraded += 1;
      count('missing');
      console.error(`[billing] reconcile: ${record.providerSubscriptionId} of account ${userId} is not in the provider's list; its plan is withdrawn`);
    }
  }
}

/** Reads the provider's list a page at a time, at most `RECONCILE_MAX_PAGES` of them; true when the list was read to its end. */
async function readList(run: Run, signal: AbortSignal, listedIds: Set<string>, pagePauseMs: number): Promise<boolean> {
  const pages = run.provider.listSubscriptions({ perPage: RECONCILE_PAGE_SIZE, signal });
  try {
    for (let page = 0; ; page++) {
      const next = await pages.next();
      if (next.done) return true;
      if (page >= RECONCILE_MAX_PAGES) return false;
      for (const listed of next.value) {
        listedIds.add(listed.providerSubscriptionId);
        run.report.listed += 1;
        await reconcileListed(run, listed);
      }
      if (pagePauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pagePauseMs));
    }
  } finally {
    await pages.return();
  }
}

/** One payment of the list: credited when it buys a package and names an account; the credit does nothing for a payment the ledger already has. */
async function reconcilePayment(run: Run, listed: ListedPackagePurchase): Promise<void> {
  const { purchase } = listed;
  if (!purchase) return;
  run.report.packagesListed += 1;
  const userId = purchase.userId ?? (await run.packages.packageTransactionOwner(purchase.transactionId));
  if (!userId) {
    run.report.packagesUnattributed += 1;
    count('unattributed');
    console.error(`[billing] reconcile: package payment ${purchase.transactionId} (${purchase.credits} credits) names no account; not credited`);
    return;
  }
  const result = await creditPackagePurchase(purchase, userId, run.packages);
  if (result === 'granted') {
    run.report.packagesCredited += 1;
    count('applied');
    console.error(`[billing] reconcile: package payment ${purchase.transactionId} was missing from the ledger; ${purchase.credits} credits added to account ${userId}`);
  } else if (result === 'unknown_user') {
    run.report.packagesUnattributed += 1;
    count('unknown_user');
    console.error(`[billing] reconcile: package payment ${purchase.transactionId} names account ${userId}, which no longer exists; not credited`);
  }
}

/** Reads the provider's completed payments a page at a time, at most `RECONCILE_MAX_PAGES` of them; true when the list was read to its end. */
async function reconcilePackages(run: Run, signal: AbortSignal, pagePauseMs: number): Promise<boolean> {
  const pages = run.provider.listPackagePurchases({ perPage: RECONCILE_PAGE_SIZE, signal });
  try {
    for (let page = 0; ; page++) {
      const next = await pages.next();
      if (next.done) return true;
      if (page >= RECONCILE_MAX_PAGES) return false;
      for (const listed of next.value) await reconcilePayment(run, listed);
      if (pagePauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pagePauseMs));
    }
  } finally {
    await pages.return();
  }
}

/** One approved refund or chargeback of the list: applied once for each adjustment id; a payment the ledger does not hold (a subscription's, or one not credited yet) changes nothing. */
async function reconcileRefund(run: Run, refund: PackageRefund): Promise<void> {
  run.report.refundsListed += 1;
  if ((await refundPackagePurchase(refund, run.packages)) === 'revoked') {
    run.report.refundsApplied += 1;
    count('applied');
  }
}

/** Reads the provider's approved refunds a page at a time, at most `RECONCILE_MAX_PAGES` of them; true when the list was read back to its 30-day bound. */
async function reconcileRefunds(run: Run, signal: AbortSignal, pagePauseMs: number): Promise<boolean> {
  const pages = run.provider.listPackageRefunds({ perPage: RECONCILE_PAGE_SIZE, signal });
  try {
    for (let page = 0; ; page++) {
      const next = await pages.next();
      if (next.done) return true;
      if (page >= RECONCILE_MAX_PAGES) return false;
      for (const refund of next.value) await reconcileRefund(run, refund);
      if (pagePauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pagePauseMs));
    }
  } finally {
    await pages.return();
  }
}

async function runReconcile(run: Run, signal: AbortSignal, pagePauseMs: number): Promise<void> {
  const records = await run.store.listRecords();
  for (const record of records) {
    run.byUser.set(record.userId, record);
    run.bySubscription.set(record.providerSubscriptionId, record);
  }
  const listedIds = new Set<string>();
  const complete = await readList(run, signal, listedIds, pagePauseMs);
  if (!complete) {
    run.report.outcome = 'partial';
    run.report.note = `the list has more than ${RECONCILE_MAX_PAGES} pages of ${RECONCILE_PAGE_SIZE}; the rest was not read and no stored subscription was withdrawn`;
    console.error(`[billing] reconcile: ${run.report.note}`);
    return;
  }
  await downgradeMissing(run, listedIds);
  if (!(await reconcilePackages(run, signal, pagePauseMs))) {
    run.report.outcome = 'partial';
    run.report.note = `the list of payments has more than ${RECONCILE_MAX_PAGES} pages of ${RECONCILE_PAGE_SIZE}; the oldest were not read`;
    console.error(`[billing] reconcile: ${run.report.note}`);
  }
  // After the payments, so that a refund of a payment this run just credited is taken back in the same run. A refund is applied on its own, so it needs nothing of the lists before it to be complete.
  if (!(await reconcileRefunds(run, signal, pagePauseMs))) {
    run.report.outcome = 'partial';
    run.report.note = `${run.report.note ? `${run.report.note}; ` : ''}the list of adjustments has more than ${RECONCILE_MAX_PAGES} pages of ${RECONCILE_PAGE_SIZE}; the oldest were not read`;
    console.error(`[billing] reconcile: ${run.report.note}`);
  }
}

/**
 * One reconciliation: takes the lock (a run in another process answers `skipped`), reads the whole list through the provider, and
 * corrects the store. Idempotent: a second run over the same list writes nothing. Bounded: `RECONCILE_MAX_PAGES` pages, and
 * `RECONCILE_RUN_TIMEOUT_MS` in all. A provider or store that fails ends the run as `failed` with what it already corrected kept.
 */
export async function reconcileSubscriptions(options: ReconcileOptions = {}): Promise<ReconcileReport> {
  const provider = options.provider ?? getBillingProvider()?.provider;
  const report: ReconcileReport = { outcome: 'completed', listed: 0, corrected: 0, downgraded: 0, unattributed: 0, packagesListed: 0, packagesCredited: 0, packagesUnattributed: 0, refundsListed: 0, refundsApplied: 0 };
  if (!provider) return { ...report, outcome: 'disabled' };
  const store = options.store ?? subscriptionStore;
  const now = options.now ?? Date.now;
  const timeoutMs = options.runTimeoutMs ?? RECONCILE_RUN_TIMEOUT_MS;

  const token = await store.acquireLock(LOCK_NAME, timeoutMs + LOCK_MARGIN_MS, now());
  if (!token) return { ...report, outcome: 'skipped' };
  const run: Run = { provider, store, packages: options.packages ?? redisKeyStore, runId: crypto.randomUUID(), startedAt: now(), byUser: new Map(), bySubscription: new Map(), report };
  try {
    await runReconcile(run, AbortSignal.timeout(timeoutMs), options.pagePauseMs ?? PAGE_PAUSE_MS);
  } catch (error) {
    report.outcome = 'failed';
    report.note = error instanceof Error ? error.message : String(error);
    console.error('[billing] reconcile failed; what it already corrected stays and the next run tries again:', error);
  } finally {
    // A run that completed keeps the lock closed for the rest of the interval; any other end lets the next timer try at once.
    await store.releaseLock(LOCK_NAME, token, report.outcome === 'completed' ? RECONCILE_HOLD_MS : 0, now()).catch((error: unknown) => {
      console.error('[billing] reconcile could not release its lock; it ends by itself:', error);
    });
  }
  console.log(
    `[billing] reconcile ${report.outcome}: listed ${report.listed}, corrected ${report.corrected}, withdrawn ${report.downgraded}, without account ${report.unattributed}; ` +
      `payments listed ${report.packagesListed}, credited ${report.packagesCredited}, without account ${report.packagesUnattributed}; ` +
      `refunds listed ${report.refundsListed}, applied ${report.refundsApplied}`
  );
  return report;
}

let timer: NodeJS.Timeout | undefined;
let firstRun: NodeJS.Timeout | undefined;

/**
 * Runs the reconciliation `RECONCILE_FIRST_RUN_DELAY_MS` after the call and every `RECONCILE_INTERVAL_MS`, while billing is configured
 * (a worker without the thirteen variables does nothing). Every worker calls it; the lock lets one run at a time. A failed run is logged.
 */
export function startBillingReconcile(): void {
  if (timer) return;
  const run = (): void => {
    reconcileSubscriptions().catch((error: unknown) => console.error('[billing] reconcile could not start:', error));
  };
  firstRun = setTimeout(run, RECONCILE_FIRST_RUN_DELAY_MS);
  firstRun.unref();
  timer = setInterval(run, RECONCILE_INTERVAL_MS);
  timer.unref();
}

export function stopBillingReconcile(): void {
  if (timer) clearInterval(timer);
  if (firstRun) clearTimeout(firstRun);
  timer = undefined;
  firstRun = undefined;
}
