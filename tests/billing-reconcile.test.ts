import crypto from 'node:crypto';
import { ApiError, Paddle } from '@paddle/paddle-node-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getBillingProvider = vi.hoisted(() => vi.fn<() => { provider: unknown } | null>(() => null));
vi.mock('../src/lib/billing/index', () => ({ getBillingProvider }));

import { redisUserStore } from '../src/lib/auth/redis-user-store';
import type { BillingConfig } from '../src/lib/billing/config';
import { PaddleBillingProvider } from '../src/lib/billing/paddle-provider';
import {
  RECONCILE_FIRST_RUN_DELAY_MS,
  RECONCILE_HOLD_MS,
  RECONCILE_INTERVAL_MS,
  RECONCILE_MAX_PAGES,
  reconcileSubscriptions,
  startBillingReconcile,
  stopBillingReconcile,
  type ReconcileOptions,
} from '../src/lib/billing/reconcile';
import { subscriptionStore } from '../src/lib/billing/subscription-store';
import type { SubscriptionChange } from '../src/lib/billing/types';
import { reading, resetMetrics } from './helpers/metrics-readings';
import { WEBHOOK_SECRET } from './helpers/paddle-events';

/**
 * The reconciliation of the store with the provider's list. The SDK is replaced by a list that gives the pages a test sets, so no
 * request leaves the process; the provider's own mapping, the store and its atomic script are the real ones.
 */

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

const config: BillingConfig = {
  apiKey: 'pdl_sdbx_apikey_fixture',
  webhookSecret: WEBHOOK_SECRET,
  clientToken: 'test_fixture_client_token',
  environment: 'sandbox',
  priceIds: { pro: 'pri_pro_fixture', enterprise: 'pri_enterprise_fixture' },
};

interface ListedFixture {
  id: string;
  status?: string;
  updatedAt?: number;
  priceId?: string;
  periodEnd?: number | null;
  cancelAt?: number;
  customData?: Record<string, string> | null;
}

/** A subscription as the SDK's list gives it (the fields the mapping reads). */
function listed({ id, status = 'active', updatedAt = NOW, priceId = 'pri_pro_fixture', periodEnd = NOW + 20 * DAY, cancelAt, customData = null }: ListedFixture) {
  return {
    id,
    status,
    customerId: 'ctm_fixture',
    customData,
    updatedAt: iso(updatedAt),
    items: [{ price: { id: priceId } }],
    currentBillingPeriod: periodEnd === null ? null : { startsAt: iso(NOW - 10 * DAY), endsAt: iso(periodEnd) },
    scheduledChange: cancelAt === undefined ? null : { action: 'cancel', effectiveAt: iso(cancelAt) },
  };
}

type Listed = ReturnType<typeof listed>;

/** What `paddle.subscriptions.list` returns: pages of subscriptions, read with `next()` until `hasMore` is false. */
class FakeList {
  hasMore = true;
  calls = 0;
  constructor(private readonly pages: (Listed[] | Error | 'hang')[]) {}
  async next(): Promise<Listed[]> {
    this.calls += 1;
    const page = this.pages.shift();
    this.hasMore = this.pages.length > 0;
    if (page === 'hang') return new Promise(() => undefined);
    if (page instanceof Error) {
      this.hasMore = true;
      throw page;
    }
    return page ?? [];
  }
}

const provider = (list: FakeList) => new PaddleBillingProvider(config, { subscriptions: { list: () => list } } as unknown as Paddle);
const bound = (userId: string) => new PaddleBillingProvider(config).createCheckout({ userId, email: 'a@b.test', plan: 'pro' }).customData;

let run = '';
const created: string[] = [];
const sub = (name: string) => `sub_${run}_${name}`;

async function account(label = 'subscriber') {
  const record = await redisUserStore.createUser({ email: `${label}_${run}@billing-reconcile.test`, name: 'Subscriber' });
  created.push(record.id);
  return record.id;
}

/** Gives an account the subscription that a webhook would have stored. */
async function seed(userId: string, name: string, overrides: { status?: 'active' | 'past_due' | 'canceled'; eventAt?: number; currentPeriodEnd?: number } = {}) {
  const change: SubscriptionChange = {
    eventId: `evt_${run}_${name}`,
    eventAt: overrides.eventAt ?? NOW - 5 * DAY,
    userId,
    subscription: {
      provider: 'paddle',
      providerSubscriptionId: sub(name),
      providerCustomerId: 'ctm_fixture',
      status: overrides.status ?? 'active',
      plan: 'pro',
      currentPeriodEnd: overrides.currentPeriodEnd ?? NOW + 20 * DAY,
    },
  };
  expect(await subscriptionStore.apply(change, NOW)).toBe('applied');
}

const tierOf = async (userId: string) => (await redisUserStore.findById(userId))?.tier;
const events = (result: string) => reading('easyconvert_billing_events_total', { source: 'reconcile', result });

function reconcile(pages: (Listed[] | Error | 'hang')[], options: ReconcileOptions = {}) {
  const list = new FakeList(pages);
  return { list, result: reconcileSubscriptions({ provider: provider(list), now: () => NOW, pagePauseMs: 0, ...options }) };
}

beforeEach(() => {
  run = crypto.randomUUID().slice(0, 8);
  redisUserStore.resetStore();
  subscriptionStore.resetStore();
  resetMetrics();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(async () => {
  for (const userId of created.splice(0)) {
    await subscriptionStore.forgetUser(userId);
    await redisUserStore.deleteUser(userId);
  }
  vi.restoreAllMocks();
  getBillingProvider.mockReset();
});

describe('what the provider says wins over the store', () => {
  it('ends a plan whose cancellation never arrived: the record and the account change together', async () => {
    const user = await account();
    await seed(user, 'a');
    expect(await tierOf(user)).toBe('pro');

    const { result } = reconcile([[listed({ id: sub('a'), status: 'canceled', updatedAt: NOW - DAY })]]);
    expect(await result).toMatchObject({ outcome: 'completed', listed: 1, corrected: 1 });
    expect(await subscriptionStore.findByUser(user)).toMatchObject({ status: 'canceled', plan: 'pro', eventAt: NOW - DAY });
    expect(await tierOf(user)).toBe('free');
    expect(await events('applied')).toBe(1);
  });

  it('returns an account to free when a failed renewal never arrived and the paid period has ended', async () => {
    const user = await account();
    await seed(user, 'a');
    const { result } = reconcile([[listed({ id: sub('a'), status: 'past_due', updatedAt: NOW - DAY, periodEnd: NOW - 2 * DAY })]]);
    expect((await result).corrected).toBe(1);
    expect(await tierOf(user)).toBe('free');
  });

  it('follows a scheduled cancellation and a change of plan the events missed', async () => {
    const user = await account();
    await seed(user, 'a');
    const { result } = reconcile([[listed({ id: sub('a'), priceId: 'pri_enterprise_fixture', cancelAt: NOW + 3 * DAY, updatedAt: NOW - DAY })]]);
    expect((await result).corrected).toBe(1);
    expect(await subscriptionStore.findByUser(user)).toMatchObject({ plan: 'enterprise', cancelAt: NOW + 3 * DAY });
    expect(await redisUserStore.findById(user)).toMatchObject({ tier: 'enterprise', tierUntil: NOW + 3 * DAY });
  });

  it('gives a plan to a purchase whose first event was lost, when the checkout is bound to the account', async () => {
    const user = await account();
    const { result } = reconcile([[listed({ id: sub('a'), customData: bound(user) })]]);
    expect((await result).corrected).toBe(1);
    expect(await tierOf(user)).toBe('pro');
    expect(await subscriptionStore.userOfSubscription(sub('a'))).toBe(user);
  });

  it('reads a retired price of a canceled subscription with the plan of the stored record, and leaves a live one at an unknown price alone', async () => {
    const user = await account();
    const other = await account('other');
    await seed(user, 'a');
    await seed(other, 'b');
    const { result } = reconcile([
      [
        listed({ id: sub('a'), status: 'canceled', priceId: 'pri_retired', updatedAt: NOW - DAY }),
        listed({ id: sub('b'), status: 'active', priceId: 'pri_retired', updatedAt: NOW - DAY }),
      ],
    ]);
    expect(await result).toMatchObject({ corrected: 1 });
    expect(await tierOf(user)).toBe('free');
    expect(await tierOf(other)).toBe('pro');
    expect(await events('ignored')).toBe(1);
  });

  it('writes nothing for a subscription that already agrees, and a second run changes nothing', async () => {
    const user = await account();
    await seed(user, 'a');
    const first = reconcile([[listed({ id: sub('a'), status: 'canceled', updatedAt: NOW - DAY })]]);
    expect((await first.result).corrected).toBe(1);
    const apply = vi.spyOn(subscriptionStore, 'apply');
    const second = reconcile([[listed({ id: sub('a'), status: 'canceled', updatedAt: NOW - DAY })]], { now: () => NOW + RECONCILE_HOLD_MS + 1000 });
    expect(await second.result).toMatchObject({ outcome: 'completed', listed: 1, corrected: 0 });
    expect(apply).not.toHaveBeenCalled();
    expect(await events('applied')).toBe(1);
  });
});

describe('a correction never goes over a newer word', () => {
  it('leaves a record that a newer event set, whatever the list still says', async () => {
    const user = await account();
    await seed(user, 'a', { status: 'canceled', eventAt: NOW - 60_000 });
    const { result } = reconcile([[listed({ id: sub('a'), status: 'active', updatedAt: NOW - DAY })]]);
    expect(await result).toMatchObject({ corrected: 0 });
    expect(await subscriptionStore.findByUser(user)).toMatchObject({ status: 'canceled', eventAt: NOW - 60_000 });
    expect(await tierOf(user)).toBe('free');
    expect(await events('stale')).toBe(1);
  });

  it('does not withdraw a subscription that an event wrote after the run began', async () => {
    const user = await account();
    await seed(user, 'a', { eventAt: NOW + 1000 });
    const { result } = reconcile([[listed({ id: sub('other') })], [listed({ id: sub('other2') })]]);
    expect(await result).toMatchObject({ downgraded: 0 });
    expect(await tierOf(user)).toBe('pro');
  });
});

describe('an account is never made up', () => {
  it('only logs and counts a subscription that gives a plan and has no binding and no index entry', async () => {
    const forged = { easyconvertUserId: 'someone', easyconvertBinding: 'forged' };
    const { result } = reconcile([[listed({ id: sub('a'), customData: forged }), listed({ id: sub('b'), status: 'canceled' })]]);
    expect(await result).toMatchObject({ outcome: 'completed', listed: 2, corrected: 0, unattributed: 1 });
    expect(await subscriptionStore.listRecords()).toEqual([]);
    expect(await subscriptionStore.userOfSubscription(sub('a'))).toBeNull();
    expect(await events('unattributed')).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`subscription ${sub('a')}`));
  });

  it('counts a live subscription of an account that is gone as unknown_user and keeps nothing', async () => {
    const user = await account();
    const customData = bound(user);
    await redisUserStore.deleteUser(user);
    const { result } = reconcile([[listed({ id: sub('a'), customData })]]);
    expect(await result).toMatchObject({ corrected: 0, unattributed: 1 });
    expect(await events('unknown_user')).toBe(1);
    expect(await subscriptionStore.listRecords()).toEqual([]);
  });

  it('finds the account of an unbound subscription by the index of the store', async () => {
    const user = await account();
    await seed(user, 'a');
    const { result } = reconcile([[listed({ id: sub('a'), status: 'canceled', customData: null, updatedAt: NOW - DAY })]]);
    expect((await result).corrected).toBe(1);
    expect(await tierOf(user)).toBe('free');
  });
});

describe('a stored subscription the provider no longer lists', () => {
  it('withdraws its plan after a complete list', async () => {
    const gone = await account('gone');
    const kept = await account('kept');
    await seed(gone, 'gone');
    await seed(kept, 'kept');
    const { result } = reconcile([[listed({ id: sub('kept') }), listed({ id: sub('another'), status: 'canceled' })]]);
    expect(await result).toMatchObject({ outcome: 'completed', downgraded: 1 });
    expect(await subscriptionStore.findByUser(gone)).toMatchObject({ status: 'canceled' });
    expect(await tierOf(gone)).toBe('free');
    expect(await tierOf(kept)).toBe('pro');
    expect(await events('missing')).toBe(1);
  });

  it('leaves every plan alone when the list is empty (a key of another environment)', async () => {
    const user = await account();
    await seed(user, 'a');
    const { result } = reconcile([[]]);
    expect(await result).toMatchObject({ outcome: 'completed', downgraded: 0, note: expect.stringContaining('left alone') });
    expect(await tierOf(user)).toBe('pro');
  });

  it('leaves them alone when most of them are missing at once', async () => {
    const users = await Promise.all(['a', 'b', 'c', 'd'].map((name) => account(name)));
    await Promise.all(users.map((user, index) => seed(user, `s${index}`)));
    const { result } = reconcile([[listed({ id: sub('s0') }), listed({ id: sub('unrelated'), status: 'canceled' })]]);
    expect(await result).toMatchObject({ downgraded: 0, note: expect.stringContaining('3 of 4') });
    expect(await Promise.all(users.map(tierOf))).toEqual(['pro', 'pro', 'pro', 'pro']);
  });

  it('does not touch a record that already gives nothing', async () => {
    const user = await account();
    await seed(user, 'ended', { status: 'past_due', currentPeriodEnd: NOW - DAY, eventAt: NOW - 3 * DAY });
    const apply = vi.spyOn(subscriptionStore, 'apply');
    const { result } = reconcile([[listed({ id: sub('other'), status: 'canceled' })]]);
    expect(await result).toMatchObject({ downgraded: 0 });
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('the run is bounded', () => {
  it('reads at most the page cap and then withdraws nothing', async () => {
    const user = await account();
    await seed(user, 'a');
    const pages = Array.from({ length: RECONCILE_MAX_PAGES + 5 }, (_, index) => [listed({ id: sub(`p${index}`), status: 'canceled' })]);
    const { list, result } = reconcile(pages);
    expect(await result).toMatchObject({ outcome: 'partial', listed: RECONCILE_MAX_PAGES, downgraded: 0 });
    expect(list.calls).toBe(RECONCILE_MAX_PAGES + 1);
    expect(await tierOf(user)).toBe('pro');
  });

  it('ends at its deadline when the provider does not answer, and lets go of the lock', async () => {
    const { result } = reconcile(['hang'], { runTimeoutMs: 30 });
    expect(await result).toMatchObject({ outcome: 'failed', note: expect.stringContaining('timeout') });
    expect(await subscriptionStore.acquireLock('reconcile', 1000, NOW)).not.toBeNull();
  });

  it('asks again for a page after the provider says to wait', async () => {
    const wait = new ApiError({ type: 'request_error', code: 'too_many_requests', detail: 'slow down', documentation_url: 'https://example.test' }, 0);
    const user = await account();
    await seed(user, 'a');
    const { list, result } = reconcile([wait, [listed({ id: sub('a'), status: 'canceled', updatedAt: NOW - DAY })]]);
    expect(await result).toMatchObject({ outcome: 'completed', corrected: 1 });
    expect(list.calls).toBe(2);
  });

  it('ends as failed on an error of the provider, keeps what it corrected, and withdraws nothing', async () => {
    const user = await account();
    const missing = await account('missing');
    await seed(user, 'a');
    await seed(missing, 'm');
    const { result } = reconcile([[listed({ id: sub('a'), status: 'canceled', updatedAt: NOW - DAY })], new Error('provider is down')]);
    expect(await result).toMatchObject({ outcome: 'failed', corrected: 1, downgraded: 0, note: 'provider is down' });
    expect(await tierOf(user)).toBe('free');
    expect(await tierOf(missing)).toBe('pro');
  });
});

describe('one run at a time', () => {
  it('skips while another process holds the lock, and lets go after a run that failed', async () => {
    const held = await subscriptionStore.acquireLock('reconcile', 60_000, NOW);
    const blocked = reconcile([[]]);
    expect(await blocked.result).toMatchObject({ outcome: 'skipped' });
    expect(blocked.list.calls).toBe(0);
    if (held) await subscriptionStore.releaseLock('reconcile', held, 0, NOW);

    expect(await reconcile([new Error('down')]).result).toMatchObject({ outcome: 'failed' });
    expect(await reconcile([[listed({ id: sub('a'), status: 'canceled' })]]).result).toMatchObject({ outcome: 'completed' });
  });

  it('keeps the lock closed for the rest of the interval after a run that completed', async () => {
    expect(await reconcile([[]]).result).toMatchObject({ outcome: 'completed' });
    expect(await subscriptionStore.acquireLock('reconcile', 1000, NOW + RECONCILE_HOLD_MS - 1000)).toBeNull();
    expect(await subscriptionStore.acquireLock('reconcile', 1000, NOW + RECONCILE_HOLD_MS + 1000)).not.toBeNull();
  });
});

describe('without billing', () => {
  it('does nothing and asks the provider for nothing', async () => {
    getBillingProvider.mockReturnValue(null);
    expect(await reconcileSubscriptions()).toMatchObject({ outcome: 'disabled', listed: 0 });
  });
});

describe('the schedule of the worker', () => {
  afterEach(() => {
    stopBillingReconcile();
    vi.useRealTimers();
  });

  it('runs once after the first delay and then every interval, and starting twice starts one timer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const lists: FakeList[] = [];
    getBillingProvider.mockImplementation(() => {
      const list = new FakeList([[]]);
      lists.push(list);
      return { provider: provider(list) };
    });
    startBillingReconcile();
    startBillingReconcile();

    await vi.advanceTimersByTimeAsync(RECONCILE_FIRST_RUN_DELAY_MS - 1000);
    expect(lists).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(lists).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS);
    expect(lists).toHaveLength(2);

    stopBillingReconcile();
    await vi.advanceTimersByTimeAsync(2 * RECONCILE_INTERVAL_MS);
    expect(lists).toHaveLength(2);
  });
});
