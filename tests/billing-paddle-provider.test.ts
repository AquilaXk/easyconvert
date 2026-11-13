import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BillingConfig } from '../src/lib/billing/config';
import { PaddleBillingProvider } from '../src/lib/billing/paddle-provider';
import type { SubscriptionRecord } from '../src/lib/billing/types';
import { WEBHOOK_SECRET, adjustmentEventBody, sign, subscriptionEventBody, transactionEventBody } from './helpers/paddle-events';

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
const SECONDS = (ms: number) => Math.floor(ms / 1000);

const config: BillingConfig = {
  apiKey: 'pdl_sdbx_apikey_fixture',
  webhookSecret: WEBHOOK_SECRET,
  clientToken: 'test_fixture_client_token',
  environment: 'sandbox',
  packagePriceIds: { 500: 'pri_package_500_fixture', 1000: 'pri_package_1000_fixture', 2500: 'pri_package_2500_fixture', 5000: 'pri_package_5000_fixture', 10000: 'pri_package_10000_fixture' },
  subscriptionPriceIds: { 1000: 'pri_subscription_1000_fixture', 2500: 'pri_subscription_2500_fixture', 5000: 'pri_subscription_5000_fixture', 10000: 'pri_subscription_10000_fixture' },
};

const provider = new PaddleBillingProvider(config);
const INVALID = { name: 'InvalidWebhookError', message: expect.any(String) };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('verifyWebhook', () => {
  const body = subscriptionEventBody();

  it('accepts a body signed with the secret now and names its event', async () => {
    const event = await provider.verifyWebhook(body, sign(body, WEBHOOK_SECRET, SECONDS(NOW)));
    expect(event).toMatchObject({ id: 'evt_01fixture', type: 'subscription.created' });
  });

  it('refuses a signature made with another secret', async () => {
    await expect(provider.verifyWebhook(body, sign(body, 'another_secret', SECONDS(NOW)))).rejects.toMatchObject(INVALID);
  });

  it('refuses a body that changed after it was signed', async () => {
    const signature = sign(body, WEBHOOK_SECRET, SECONDS(NOW));
    await expect(provider.verifyWebhook(body.replace('active', 'canceled'), signature)).rejects.toMatchObject(INVALID);
  });

  it('refuses a stale timestamp, even with a correct signature, and one from the future', async () => {
    await expect(provider.verifyWebhook(body, sign(body, WEBHOOK_SECRET, SECONDS(NOW) - 10))).rejects.toMatchObject(INVALID);
    await expect(provider.verifyWebhook(body, sign(body, WEBHOOK_SECRET, SECONDS(NOW) + 10))).rejects.toMatchObject(INVALID);
    await expect(provider.verifyWebhook(body, sign(body, WEBHOOK_SECRET, SECONDS(NOW) - 3))).resolves.toMatchObject({ id: 'evt_01fixture' });
  });

  it('says in the log that a genuine signature is outside the window, and nothing for a forged or malformed one', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(provider.verifyWebhook(body, sign(body, WEBHOOK_SECRET, SECONDS(NOW) - 12))).rejects.toMatchObject(INVALID);
    await expect(provider.verifyWebhook(body, sign(body, WEBHOOK_SECRET, SECONDS(NOW) + 30))).rejects.toMatchObject(INVALID);
    expect(logged.mock.calls.map(([line]) => String(line))).toEqual([
      expect.stringContaining('timestamp is 12 s behind this server\'s clock (window 5 s)'),
      expect.stringContaining('timestamp is 30 s ahead of this server\'s clock (window 5 s)'),
    ]);

    logged.mockClear();
    await expect(provider.verifyWebhook(body, sign(body, 'another_secret', SECONDS(NOW) - 12))).rejects.toMatchObject(INVALID);
    await expect(provider.verifyWebhook(body.replace('active', 'canceled'), sign(body, WEBHOOK_SECRET, SECONDS(NOW) - 12))).rejects.toMatchObject(INVALID);
    await expect(provider.verifyWebhook(body, 'garbage')).rejects.toMatchObject(INVALID);
    await expect(provider.verifyWebhook(body, sign(body, WEBHOOK_SECRET, SECONDS(NOW) - 3))).resolves.toMatchObject({ id: 'evt_01fixture' });
    expect(logged).not.toHaveBeenCalled();
  });

  it('refuses a missing or malformed header', async () => {
    await expect(provider.verifyWebhook(body, null)).rejects.toMatchObject(INVALID);
    await expect(provider.verifyWebhook(body, '')).rejects.toMatchObject(INVALID);
    await expect(provider.verifyWebhook(body, 'garbage')).rejects.toMatchObject(INVALID);
    await expect(provider.verifyWebhook(body, `ts=${SECONDS(NOW)}`)).rejects.toMatchObject(INVALID);
  });

  it('refuses a signed body that is not JSON', async () => {
    const text = 'not json';
    await expect(provider.verifyWebhook(text, sign(text, WEBHOOK_SECRET, SECONDS(NOW)))).rejects.toMatchObject(INVALID);
  });
});

describe('mapEventToSubscription', () => {
  async function mapped(options: Parameters<typeof subscriptionEventBody>[0] = {}) {
    const body = subscriptionEventBody(options);
    return provider.mapEventToSubscription(await provider.verifyWebhook(body, sign(body, WEBHOOK_SECRET, SECONDS(NOW))));
  }
  const checkout = provider.createCheckout({ userId: 'user-42', email: 'a@b.test', product: { kind: 'subscription', credits: 1000 } });

  it('reads a new subscription: its credits, status, period end, time and the account the checkout names', async () => {
    expect(await mapped({ customData: checkout.customData, priceIds: ['pri_subscription_1000_fixture'] })).toEqual({
      eventId: 'evt_01fixture',
      eventAt: Date.parse('2026-11-12T12:00:00.123Z'),
      userId: 'user-42',
      subscription: {
        provider: 'paddle',
        providerSubscriptionId: 'sub_01fixture',
        providerCustomerId: 'ctm_01fixture',
        status: 'active',
        credits: 1000,
        currentPeriodEnd: Date.parse('2026-12-12T12:00:00Z'),
      },
    });
  });

  it('takes no account from custom data it did not sign', async () => {
    expect((await mapped({ customData: { easyconvertUserId: 'user-42', easyconvertBinding: 'forged' } }))?.userId).toBeUndefined();
    expect((await mapped({ customData: { easyconvertUserId: 'user-43', easyconvertBinding: checkout.customData.easyconvertBinding } }))?.userId).toBeUndefined();
    expect((await mapped({ customData: { easyconvertUserId: 'user-42' } }))?.userId).toBeUndefined();
    expect((await mapped({ customData: null }))?.userId).toBeUndefined();
  });

  it('reads a scheduled cancellation as the end of the plan', async () => {
    const result = await mapped({ type: 'subscription.updated', scheduledChange: { action: 'cancel', effective_at: '2026-12-12T12:00:00Z' } });
    expect(result?.subscription).toMatchObject({ status: 'active', cancelAt: Date.parse('2026-12-12T12:00:00Z') });
    expect((await mapped({ scheduledChange: { action: 'pause', effective_at: '2026-12-12T12:00:00Z' } }))?.subscription.cancelAt).toBeUndefined();
  });

  it('reads the statuses of cancellation and a failed payment', async () => {
    expect((await mapped({ type: 'subscription.canceled', status: 'canceled', periodEnd: null }))?.subscription).toMatchObject({ status: 'canceled' });
    expect((await mapped({ type: 'subscription.past_due', status: 'past_due' }))?.subscription).toMatchObject({ status: 'past_due', currentPeriodEnd: Date.parse('2026-12-12T12:00:00Z') });
  });

  it('still reads a canceled, paused or past-due subscription whose price is no longer sold, with no credits of its own', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const status of ['canceled', 'paused', 'past_due']) {
      const result = await mapped({ type: `subscription.${status}`, status, priceIds: ['pri_retired'], periodEnd: status === 'canceled' ? null : '2026-12-12T12:00:00Z' });
      expect(result?.subscription, status).toMatchObject({ status, providerSubscriptionId: 'sub_01fixture' });
      expect(result?.subscription.credits, status).toBeUndefined();
    }
    expect(error).not.toHaveBeenCalled();
  });

  it('gives the most credits among the subscription items, ignores a package item and reads a change of size', async () => {
    expect((await mapped({ priceIds: ['pri_subscription_2500_fixture', 'pri_subscription_10000_fixture'] }))?.subscription.credits).toBe(10000);
    expect((await mapped({ priceIds: ['pri_subscription_1000_fixture', 'pri_subscription_2500_fixture'] }))?.subscription.credits).toBe(2500);
    expect((await mapped({ priceIds: ['pri_subscription_1000_fixture'] }))?.subscription.credits).toBe(1000);
    expect((await mapped({ type: 'subscription.updated', priceIds: ['pri_subscription_5000_fixture'] }))?.subscription.credits).toBe(5000);
    expect(await mapped({ priceIds: ['pri_package_1000_fixture'] })).toBeNull();
  });

  it('applies nothing for a new subscription at a price it does not sell, a status it does not know, or an event that is no subscription event', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await mapped({ priceIds: ['pri_someone_else'] })).toBeNull();
    expect(await mapped({ type: 'subscription.trialing', status: 'trialing', priceIds: ['pri_someone_else'] })).toBeNull();
    expect(await mapped({ status: 'unheard_of' })).toBeNull();
    expect(error).toHaveBeenCalledTimes(3);
    for (const type of ['transaction.completed', 'adjustment.updated', 'customer.updated', 'something.new']) {
      expect(provider.mapEventToSubscription({ id: 'evt_x', type, payload: {} }), type).toBeNull();
    }
  });
});

describe('createCheckout', () => {
  it('names the price of the package or subscription, the customer and the signed account', () => {
    const subscription = provider.createCheckout({ userId: 'user-42', email: 'a@b.test', product: { kind: 'subscription', credits: 10000 } });
    expect(subscription).toMatchObject({
      environment: 'sandbox',
      clientToken: 'test_fixture_client_token',
      items: [{ priceId: 'pri_subscription_10000_fixture', quantity: 1 }],
      customer: { email: 'a@b.test' },
    });
    expect(subscription.customData.easyconvertUserId).toBe('user-42');
    expect(subscription.customData.easyconvertBinding).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(subscription)).not.toContain(WEBHOOK_SECRET);
    expect(JSON.stringify(subscription)).not.toContain(config.apiKey);
    const pack = provider.createCheckout({ userId: 'user-42', email: 'a@b.test', product: { kind: 'package', credits: 500 } });
    expect(pack.items).toEqual([{ priceId: 'pri_package_500_fixture', quantity: 1 }]);
    expect(pack.customData).toEqual(subscription.customData);
  });

  it('makes a different tag for each account and for each secret', () => {
    const tag = (secret: string, userId: string) =>
      new PaddleBillingProvider({ ...config, webhookSecret: secret }).createCheckout({ userId, email: 'a@b.test', product: { kind: 'package', credits: 1000 } }).customData.easyconvertBinding;
    expect(tag('s1', 'u1')).not.toBe(tag('s1', 'u2'));
    expect(tag('s1', 'u1')).not.toBe(tag('s2', 'u1'));
    expect(tag('s1', 'u1')).toBe(tag('s1', 'u1'));
  });
});

describe('mapEventToPackagePurchase', () => {
  const customData = provider.createCheckout({ userId: 'user-42', email: 'a@b.test', product: { kind: 'package', credits: 1000 } }).customData;
  async function purchase(options: Parameters<typeof transactionEventBody>[0] = {}) {
    const body = transactionEventBody(options);
    return provider.mapEventToPackagePurchase(await provider.verifyWebhook(body, sign(body, WEBHOOK_SECRET, SECONDS(NOW))));
  }

  it('reads a completed payment for a package: its credits, what was paid, the time and the account the checkout names', async () => {
    expect(await purchase({ customData })).toEqual({
      transactionId: 'txn_01fixture',
      credits: 1000,
      paid: '499',
      currency: 'USD',
      occurredAt: Date.parse('2026-11-12T12:00:00.123Z'),
      userId: 'user-42',
    });
  });

  it('adds the credits of every package item, with its quantity, and ignores an item that is no package', async () => {
    const result = await purchase({
      customData,
      items: [{ priceId: 'pri_package_500_fixture' }, { priceId: 'pri_package_2500_fixture', quantity: 2 }, { priceId: 'pri_subscription_1000_fixture' }, { priceId: 'pri_someone_else' }],
    });
    expect(result?.credits).toBe(500 + 2 * 2500);
  });

  it('takes no account from custom data it did not sign', async () => {
    expect((await purchase({ customData: { easyconvertUserId: 'user-42', easyconvertBinding: 'forged' } }))?.userId).toBeUndefined();
    expect((await purchase({ customData: { easyconvertUserId: 'user-43', easyconvertBinding: customData.easyconvertBinding } }))?.userId).toBeUndefined();
    expect((await purchase({ customData: null }))?.userId).toBeUndefined();
  });

  it('reads nothing from a payment that is not completed, buys no package of this configuration, or is another event', async () => {
    expect(await purchase({ status: 'billed' })).toBeNull();
    expect(await purchase({ status: 'paid' })).toBeNull();
    expect(await purchase({ items: [{ priceId: 'pri_subscription_1000_fixture' }], subscriptionId: 'sub_01fixture' })).toBeNull();
    expect(await purchase({ items: [{ priceId: 'pri_someone_else' }] })).toBeNull();
    expect(provider.mapEventToPackagePurchase({ id: 'evt_x', type: 'transaction.billed', payload: {} })).toBeNull();
  });
});

describe('mapEventToPackageRefund', () => {
  async function refund(options: Parameters<typeof adjustmentEventBody>[0] = {}) {
    const body = adjustmentEventBody(options);
    return provider.mapEventToPackageRefund(await provider.verifyWebhook(body, sign(body, WEBHOOK_SECRET, SECONDS(NOW))));
  }

  it('reads an approved full refund and an approved chargeback of a payment', async () => {
    expect(await refund()).toEqual({ adjustmentId: 'adj_01fixture', transactionId: 'txn_01fixture', amount: '499', currency: 'USD', full: true, action: 'refund', occurredAt: Date.parse('2026-11-13T12:00:00.123Z') });
    expect(await refund({ action: 'chargeback' })).toMatchObject({ action: 'chargeback', full: true });
    expect(await refund({ type: 'adjustment.created' })).toMatchObject({ action: 'refund' });
  });

  it('reads a partial refund with its amount', async () => {
    expect(await refund({ itemType: 'partial', total: '125' })).toMatchObject({ full: false, amount: '125' });
  });

  it('reads nothing from a refund that waits for approval, was rejected or reversed, or an action that is no refund', async () => {
    for (const status of ['pending_approval', 'rejected', 'reversed']) expect(await refund({ status }), status).toBeNull();
    for (const action of ['credit', 'chargeback_warning', 'chargeback_reverse']) expect(await refund({ action }), action).toBeNull();
    expect(provider.mapEventToPackageRefund({ id: 'evt_x', type: 'transaction.completed', payload: {} })).toBeNull();
  });
});

describe('listPackagePurchases', () => {
  const customData = provider.createCheckout({ userId: 'user-42', email: 'a@b.test', product: { kind: 'package', credits: 2500 } }).customData;
  /** A transaction as the SDK returns it from a list (camel case). */
  const listed = (id: string, priceId: string, data: Record<string, unknown> | null) => ({
    id,
    status: 'completed',
    customData: data,
    currencyCode: 'USD',
    items: [{ price: { id: priceId }, quantity: 1 }],
    details: { totals: { total: '1999' } },
    billedAt: '2026-11-12T10:00:00Z',
    createdAt: '2026-11-12T09:59:00Z',
  });

  it('asks for completed payments, newest first, of the last 30 days, and reads each as an event is', async () => {
    const collection = { hasMore: true, next: vi.fn(async () => { collection.hasMore = false; return [listed('txn_new', 'pri_package_2500_fixture', customData), listed('txn_sub', 'pri_subscription_1000_fixture', null)]; }) };
    const list = vi.fn().mockReturnValue(collection);
    const fake = new PaddleBillingProvider(config, { transactions: { list } } as never);
    const seen: unknown[] = [];
    for await (const page of fake.listPackagePurchases({ perPage: 200, signal: new AbortController().signal })) seen.push(...page);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ perPage: 200, status: ['completed'], orderBy: 'created_at[DESC]' }));
    const since = (list.mock.calls[0][0] as Record<string, string>)['createdAt[GTE]'];
    expect(Date.parse(since)).toBe(NOW - 30 * 24 * 60 * 60 * 1000);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ transactionId: 'txn_new', purchase: { credits: 2500, paid: '1999', userId: 'user-42', occurredAt: Date.parse('2026-11-12T10:00:00Z') } });
    expect(seen[1]).toEqual({ transactionId: 'txn_sub', purchase: null });
  });
});

describe('changeSubscription', () => {
  it('moves the subscription to the price of the new size at once, the new price billed in full', async () => {
    const update = vi.fn().mockResolvedValue({});
    const fake = new PaddleBillingProvider(config, { subscriptions: { update } } as never);
    await fake.changeSubscription({ userId: 'u', provider: 'paddle', providerSubscriptionId: 'sub_01fixture', providerCustomerId: 'ctm_1', status: 'active', credits: 1000, eventAt: NOW }, 5000);
    expect(update).toHaveBeenCalledWith('sub_01fixture', { items: [{ priceId: 'pri_subscription_5000_fixture', quantity: 1 }], prorationBillingMode: 'full_immediately' });
  });
});

describe('createPortalLink', () => {
  const subscription: SubscriptionRecord = {
    userId: 'user-42',
    provider: 'paddle',
    providerSubscriptionId: 'sub_01fixture',
    providerCustomerId: 'ctm_01fixture',
    status: 'active',
    credits: 1000,
    eventAt: NOW,
  };

  it('asks for a portal session of the customer and the subscription, and returns its links', async () => {
    const create = vi.fn().mockResolvedValue({
      urls: {
        general: { overview: 'https://portal.example/overview' },
        subscriptions: [{ id: 'sub_01fixture', cancelSubscription: 'https://portal.example/cancel' }],
      },
    });
    const fake = new PaddleBillingProvider(config, { customerPortalSessions: { create } } as never);
    expect(await fake.createPortalLink(subscription)).toEqual({ url: 'https://portal.example/overview', cancelUrl: 'https://portal.example/cancel' });
    expect(create).toHaveBeenCalledWith('ctm_01fixture', ['sub_01fixture']);
  });

  it('returns only the overview when the session lists no link for the subscription', async () => {
    const create = vi.fn().mockResolvedValue({ urls: { general: { overview: 'https://portal.example/overview' }, subscriptions: [] } });
    const fake = new PaddleBillingProvider(config, { customerPortalSessions: { create } } as never);
    expect(await fake.createPortalLink(subscription)).toEqual({ url: 'https://portal.example/overview' });
  });
});
