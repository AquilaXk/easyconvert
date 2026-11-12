import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const portalCreate = vi.hoisted(() => vi.fn());
vi.mock('@paddle/paddle-node-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@paddle/paddle-node-sdk')>();
  class FakePaddle extends actual.Paddle {
    constructor(...args: ConstructorParameters<typeof actual.Paddle>) {
      super(...args);
      this.customerPortalSessions = { create: portalCreate } as never;
    }
  }
  return { ...actual, Paddle: FakePaddle };
});

import { GET as billingStatus } from '../src/app/api/billing/status/route';
import { POST as startCheckout } from '../src/app/api/billing/checkout/route';
import { POST as openPortal } from '../src/app/api/billing/portal/route';
import { POST as receiveWebhook } from '../src/app/api/billing/webhook/route';
import { keyStore } from '../src/lib/api-keys/key-store';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { createSessionToken, getSessionFromToken } from '../src/lib/auth/session';
import { getBillingProvider } from '../src/lib/billing';
import { subscriptionStore } from '../src/lib/billing/subscription-store';
import { PLAN_MAX_FILE_BYTES, TIER_LIMITS, maxFileBytes, planOfCaller } from '../src/lib/plan-limits';
import { WEBHOOK_SECRET, sign, subscriptionEventBody } from './helpers/paddle-events';

const ORIGIN = 'http://localhost:3000';
const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
const seconds = (ms: number) => Math.floor(ms / 1000);

const BILLING_ENV = {
  PADDLE_API_KEY: 'pdl_sdbx_apikey_fixture',
  PADDLE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  PADDLE_CLIENT_TOKEN: 'test_fixture_client_token',
  PADDLE_ENVIRONMENT: 'sandbox',
  PADDLE_PRICE_ID_PRO: 'pri_pro_fixture',
  PADDLE_PRICE_ID_ENTERPRISE: 'pri_enterprise_fixture',
};

function configure(on: boolean) {
  for (const [name, value] of Object.entries(BILLING_ENV)) vi.stubEnv(name, on ? value : '');
}

/**
 * Every test has its own run id, so the accounts, event ids and subscription ids of one test never meet those of another test or
 * of an earlier run, whether the stores are in memory or in a Redis that keeps its keys.
 */
let run = '';
const created: string[] = [];
const eventId = (name: string) => `evt_${run}_${name}`;
const SUBSCRIPTION = () => `sub_${run}`;

async function account(label = 'subscriber') {
  const record = await redisUserStore.createUser({ email: `${label}_${run}@billing-routes.test`, name: 'Subscriber' });
  created.push(record.id);
  return redisUserStore.sanitizeUser(record);
}

/** The body of a subscription event of this test's subscription, with an event id of this test. */
function eventBody(options: Parameters<typeof subscriptionEventBody>[0] = {}) {
  return subscriptionEventBody({ subscriptionId: SUBSCRIPTION(), ...options, eventId: eventId(options.eventId ?? 'event') });
}

async function cookieOf(user: Awaited<ReturnType<typeof account>>) {
  return `easyconvert_session=${createSessionToken(user)}`;
}

function request(path: string, init: { method?: string; cookie?: string; body?: string; headers?: Record<string, string> } = {}) {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: init.method ?? 'GET',
    headers: { Origin: ORIGIN, ...(init.cookie ? { Cookie: init.cookie } : {}), ...init.headers },
    ...(init.body === undefined ? {} : { body: init.body }),
  });
}

const post = (path: string, cookie?: string, body?: unknown) => request(path, { method: 'POST', cookie, body: body === undefined ? undefined : JSON.stringify(body) });

async function webhook(body: string, header?: string | null) {
  const signature = header === undefined ? sign(body, WEBHOOK_SECRET, seconds(Date.now())) : header;
  return receiveWebhook(request('/api/billing/webhook', { method: 'POST', body, headers: signature === null ? {} : { 'Paddle-Signature': signature } }));
}

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

beforeEach(() => {
  run = crypto.randomUUID();
  redisUserStore.resetStore();
  subscriptionStore.resetStore();
  keyStore.resetStore();
  portalCreate.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(async () => {
  vi.useRealTimers();
  for (const userId of created.splice(0)) {
    await subscriptionStore.forgetUser(userId);
    await redisUserStore.deleteUser(userId);
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('while billing is not configured', () => {
  beforeEach(() => configure(false));

  it('answers the status route with enabled false and nothing else', async () => {
    const res = await billingStatus(request('/api/billing/status'));
    expect({ status: res.status, body: await json(res) }).toEqual({ status: 200, body: { success: true, enabled: false } });
    expect(getBillingProvider()).toBeNull();
  });

  it.each([
    ['checkout', () => startCheckout(post('/api/billing/checkout', undefined, { plan: 'pro' }))],
    ['portal', () => openPortal(post('/api/billing/portal'))],
    ['webhook', () => webhook(eventBody())],
  ])('refuses %s with 503 billing_unavailable, even for a signed-in account', async (_name, call) => {
    const res = await call();
    expect(res.status).toBe(503);
    expect(await json(res)).toMatchObject({ success: false, code: 'billing_unavailable' });
  });

  it('refuses a checkout with 503 for a signed-in account too and changes no tier', async () => {
    const user = await account();
    const res = await startCheckout(post('/api/billing/checkout', await cookieOf(user), { plan: 'enterprise' }));
    expect(res.status).toBe(503);
    expect((await redisUserStore.findById(user.id))?.tier).toBe('free');
  });

  it('refuses a webhook with a valid signature, because there is no secret to hold it against', async () => {
    const res = await webhook(eventBody());
    expect(res.status).toBe(503);
    expect(await subscriptionStore.userOfSubscription(SUBSCRIPTION())).toBeNull();
  });
});

describe('the status route with billing configured', () => {
  beforeEach(() => configure(true));

  it('names what the checkout needs and no secret', async () => {
    const res = await billingStatus(request('/api/billing/status'));
    const body = await json(res);
    expect(body).toEqual({
      success: true,
      enabled: true,
      environment: 'sandbox',
      clientToken: 'test_fixture_client_token',
      plans: [
        { plan: 'pro', priceId: 'pri_pro_fixture' },
        { plan: 'enterprise', priceId: 'pri_enterprise_fixture' },
      ],
      subscription: null,
    });
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(JSON.stringify(body)).not.toContain(BILLING_ENV.PADDLE_API_KEY);
    expect(JSON.stringify(body)).not.toContain(WEBHOOK_SECRET);
  });
});

describe('the checkout route', () => {
  beforeEach(() => configure(true));

  it('refuses a visitor with 401', async () => {
    expect((await startCheckout(post('/api/billing/checkout', undefined, { plan: 'pro' }))).status).toBe(401);
  });

  it('refuses a plan that is not sold, and a body that is not JSON', async () => {
    const cookie = await cookieOf(await account());
    for (const body of [{ plan: 'free' }, { plan: 'gold' }, {}, { plan: ['pro'] }]) {
      const res = await startCheckout(post('/api/billing/checkout', cookie, body));
      expect({ status: res.status, code: (await json(res)).code }, JSON.stringify(body)).toEqual({ status: 400, code: 'invalid_plan' });
    }
    const res = await startCheckout(request('/api/billing/checkout', { method: 'POST', cookie, body: 'nope' }));
    expect(res.status).toBe(400);
  });

  it('gives the signed-in account the checkout of its plan, with its id signed', async () => {
    const user = await account();
    const res = await startCheckout(post('/api/billing/checkout', await cookieOf(user), { plan: 'pro' }));
    expect(res.status).toBe(200);
    const { checkout } = (await json(res)) as { checkout: Record<string, unknown> & { customData: Record<string, string> } };
    expect(checkout).toMatchObject({ environment: 'sandbox', items: [{ priceId: 'pri_pro_fixture', quantity: 1 }], customer: { email: user.email } });
    expect(checkout.customData.easyconvertUserId).toBe(user.id);
  });

  it('sends an account that has a plan to the portal instead of selling it another', async () => {
    const user = await account();
    await subscriptionStore.apply({
      eventId: eventId('seed'),
      eventAt: NOW,
      userId: user.id,
      subscription: { provider: 'paddle', providerSubscriptionId: SUBSCRIPTION(), providerCustomerId: 'ctm_seed', status: 'active', plan: 'pro' },
    });
    const res = await startCheckout(post('/api/billing/checkout', await cookieOf(user), { plan: 'enterprise' }));
    expect({ status: res.status, code: (await json(res)).code }).toEqual({ status: 409, code: 'already_subscribed' });
  });
});

describe('the portal route', () => {
  beforeEach(() => configure(true));

  it('refuses a visitor with 401 and an account without a subscription with 404', async () => {
    expect((await openPortal(post('/api/billing/portal'))).status).toBe(401);
    const res = await openPortal(post('/api/billing/portal', await cookieOf(await account())));
    expect({ status: res.status, code: (await json(res)).code }).toEqual({ status: 404, code: 'no_subscription' });
  });

  it('gives the subscriber the links of the provider, and says 502 when the provider fails', async () => {
    const user = await account();
    const cookie = await cookieOf(user);
    await subscriptionStore.apply({
      eventId: eventId('seed'),
      eventAt: NOW,
      userId: user.id,
      subscription: { provider: 'paddle', providerSubscriptionId: SUBSCRIPTION(), providerCustomerId: 'ctm_seed', status: 'active', plan: 'pro' },
    });
    portalCreate.mockResolvedValueOnce({
      urls: { general: { overview: 'https://portal.example/o' }, subscriptions: [{ id: SUBSCRIPTION(), cancelSubscription: 'https://portal.example/c' }] },
    });
    const ok = await openPortal(post('/api/billing/portal', cookie));
    expect({ status: ok.status, body: await json(ok) }).toEqual({ status: 200, body: { success: true, url: 'https://portal.example/o', cancelUrl: 'https://portal.example/c' } });
    expect(portalCreate).toHaveBeenCalledWith('ctm_seed', [SUBSCRIPTION()]);

    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    portalCreate.mockRejectedValueOnce(new Error('network down'));
    const failed = await openPortal(post('/api/billing/portal', cookie));
    expect({ status: failed.status, code: (await json(failed)).code }).toEqual({ status: 502, code: 'billing_provider_failed' });
  });
});

describe('the webhook route', () => {
  beforeEach(() => configure(true));

  async function checkoutData(user: Awaited<ReturnType<typeof account>>, plan: 'pro' | 'enterprise' = 'pro') {
    const res = await startCheckout(post('/api/billing/checkout', await cookieOf(user), { plan }));
    return ((await json(res)) as { checkout: { customData: Record<string, string> } }).checkout.customData;
  }

  it('applies a verified subscription and gives the account the limits of the plan', async () => {
    const user = await account();
    const body = eventBody({ customData: await checkoutData(user) });
    const res = await webhook(body);
    expect({ status: res.status, body: await json(res) }).toEqual({ status: 200, body: { success: true, result: 'applied' } });

    const session = await getSessionFromToken(createSessionToken(user));
    expect(session?.tier).toBe('pro');
    expect(planOfCaller(session)).toBe('pro');
    expect(maxFileBytes(planOfCaller(session))).toBe(PLAN_MAX_FILE_BYTES.pro);
    expect(maxFileBytes(planOfCaller(session))).toBeGreaterThan(PLAN_MAX_FILE_BYTES.free);
    const quota = await keyStore.getQuotaUsage(user.id);
    expect({ tier: quota.tier, dailyLimit: quota.dailyLimit }).toEqual({ tier: 'pro', dailyLimit: TIER_LIMITS.pro });
    expect(TIER_LIMITS.pro).toBeGreaterThan(TIER_LIMITS.free);
  });

  it('answers 400 to a bad signature and changes nothing', async () => {
    const user = await account();
    const body = eventBody({ customData: await checkoutData(user) });
    const cases: [string, string | null][] = [
      ['wrong secret', sign(body, 'another_secret', seconds(NOW))],
      ['stale timestamp', sign(body, WEBHOOK_SECRET, seconds(NOW) - 60)],
      ['missing header', null],
      ['garbage', 'ts=1;h1=zz'],
    ];
    for (const [label, header] of cases) {
      const res = await webhook(body, header);
      expect({ label, status: res.status, code: (await json(res)).code }).toEqual({ label, status: 400, code: 'invalid_signature' });
    }
    expect((await redisUserStore.findById(user.id))?.tier).toBe('free');
    expect(await subscriptionStore.findByUser(user.id)).toBeNull();
  });

  it('applies a replayed event id once', async () => {
    const user = await account();
    const body = eventBody({ customData: await checkoutData(user) });
    const header = sign(body, WEBHOOK_SECRET, seconds(NOW));
    expect((await json(await webhook(body, header))).result).toBe('applied');
    expect((await json(await webhook(body, header))).result).toBe('duplicate');
    expect((await redisUserStore.findById(user.id))?.tier).toBe('pro');
  });

  it('follows the subscription through an update, a scheduled cancellation and the cancellation, by its id alone', async () => {
    const user = await account();
    await webhook(eventBody({ eventId: '1', customData: await checkoutData(user) }));

    vi.setSystemTime(NOW + 60_000);
    const cancelAt = '2026-12-12T12:00:00Z';
    const scheduled = await webhook(eventBody({ eventId: '2', type: 'subscription.updated', occurredAt: '2026-11-12T12:01:00Z', scheduledChange: { action: 'cancel', effective_at: cancelAt } }));
    expect((await json(scheduled)).result).toBe('applied');
    expect((await redisUserStore.findById(user.id))?.tier).toBe('pro');

    vi.setSystemTime(Date.parse(cancelAt));
    expect((await redisUserStore.findById(user.id))?.tier).toBe('free');

    const canceled = await webhook(eventBody({ eventId: '3', type: 'subscription.canceled', status: 'canceled', periodEnd: null, occurredAt: '2026-12-12T12:00:00Z' }));
    expect((await json(canceled)).result).toBe('applied');
    expect(await subscriptionStore.findByUser(user.id)).toMatchObject({ status: 'canceled' });
  });

  it('returns the account to free when a payment failed and the paid period has ended', async () => {
    const user = await account();
    await webhook(eventBody({ eventId: '1', customData: await checkoutData(user) }));
    vi.setSystemTime(NOW + 60_000);
    await webhook(eventBody({ eventId: '2', type: 'subscription.past_due', status: 'past_due', occurredAt: '2026-11-12T12:01:00Z', periodEnd: '2026-11-13T12:00:00Z' }));
    expect((await redisUserStore.findById(user.id))?.tier).toBe('pro');
    vi.setSystemTime(Date.parse('2026-11-13T12:00:01Z'));
    expect((await redisUserStore.findById(user.id))?.tier).toBe('free');
  });

  describe('after a price has been retired or rotated', () => {
    const RETIRED = ['pri_pro_fixture'];

    async function subscribed() {
      const user = await account();
      await webhook(eventBody({ eventId: '1', customData: await checkoutData(user) }));
      expect((await redisUserStore.findById(user.id))?.tier).toBe('pro');
      vi.stubEnv('PADDLE_PRICE_ID_PRO', 'pri_pro_rotated');
      vi.setSystemTime(NOW + 60_000);
      return user;
    }

    it('still returns the account to free when the subscription at the retired price is canceled', async () => {
      const user = await subscribed();
      const res = await webhook(eventBody({ eventId: '2', type: 'subscription.canceled', status: 'canceled', periodEnd: null, priceIds: RETIRED, occurredAt: '2026-11-12T12:01:00Z' }));
      expect((await json(res)).result).toBe('applied');
      expect((await redisUserStore.findById(user.id))?.tier).toBe('free');
      expect(await subscriptionStore.findByUser(user.id)).toMatchObject({ status: 'canceled', plan: 'pro' });
    });

    it('keeps the plan of a past-due subscription at the retired price to the end of the paid period, then free', async () => {
      const user = await subscribed();
      const res = await webhook(eventBody({ eventId: '2', type: 'subscription.past_due', status: 'past_due', periodEnd: '2026-11-13T12:00:00Z', priceIds: RETIRED, occurredAt: '2026-11-12T12:01:00Z' }));
      expect((await json(res)).result).toBe('applied');
      expect((await redisUserStore.findById(user.id))?.tier).toBe('pro');
      vi.setSystemTime(Date.parse('2026-11-13T12:00:01Z'));
      expect((await redisUserStore.findById(user.id))?.tier).toBe('free');
    });

    it('gives a paused subscription at the retired price free at once', async () => {
      const user = await subscribed();
      await webhook(eventBody({ eventId: '2', type: 'subscription.paused', status: 'paused', priceIds: RETIRED, occurredAt: '2026-11-12T12:01:00Z' }));
      expect((await redisUserStore.findById(user.id))?.tier).toBe('free');
    });

    it('applies nothing for a retired price when the account holds no such subscription, and nothing that would grant a plan', async () => {
      const user = await account();
      vi.stubEnv('PADDLE_PRICE_ID_PRO', 'pri_pro_rotated');
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const customData = await checkoutData(user);
      const canceled = await webhook(eventBody({ eventId: '1', type: 'subscription.canceled', status: 'canceled', periodEnd: null, priceIds: RETIRED, customData }));
      expect((await json(canceled)).result).toBe('ignored');
      const active = await webhook(eventBody({ eventId: '2', priceIds: RETIRED, customData }));
      expect((await json(active)).result).toBe('ignored');
      expect(await subscriptionStore.findByUser(user.id)).toBeNull();
      expect((await redisUserStore.findById(user.id))?.tier).toBe('free');
    });
  });

  it('does not give a plan for custom data that this server did not sign', async () => {
    const victim = await account('victim');
    const body = eventBody({ customData: { easyconvertUserId: victim.id, easyconvertBinding: 'forged' } });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await webhook(body);
    expect((await json(res)).result).toBe('unattributed');
    expect((await redisUserStore.findById(victim.id))?.tier).toBe('free');
  });

  it('acknowledges events that change no subscription, and one for an account that is gone', async () => {
    const user = await account();
    const body = eventBody({ customData: await checkoutData(user) });
    await redisUserStore.deleteUser(user.id);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await json(await webhook(body))).result).toBe('unknown_user');
    expect((await json(await webhook(JSON.stringify({ event_id: eventId('other'), event_type: 'something.new', occurred_at: '2026-11-12T12:00:00Z', notification_id: 'ntf', data: {} })))).result).toBe('ignored');
  });
});
