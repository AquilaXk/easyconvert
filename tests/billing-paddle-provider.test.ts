import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BillingConfig } from '../src/lib/billing/config';
import { PaddleBillingProvider } from '../src/lib/billing/paddle-provider';
import type { SubscriptionRecord } from '../src/lib/billing/types';
import { WEBHOOK_SECRET, sign, subscriptionEventBody } from './helpers/paddle-events';

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
const SECONDS = (ms: number) => Math.floor(ms / 1000);

const config: BillingConfig = {
  apiKey: 'pdl_sdbx_apikey_fixture',
  webhookSecret: WEBHOOK_SECRET,
  clientToken: 'test_fixture_client_token',
  environment: 'sandbox',
  priceIds: { pro: 'pri_pro_fixture', enterprise: 'pri_enterprise_fixture' },
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
  const checkout = provider.createCheckout({ userId: 'user-42', email: 'a@b.test', plan: 'pro' });

  it('reads a new subscription: its plan, status, period end, time and the account the checkout names', async () => {
    expect(await mapped({ customData: checkout.customData })).toEqual({
      eventId: 'evt_01fixture',
      eventAt: Date.parse('2026-11-12T12:00:00.123Z'),
      userId: 'user-42',
      subscription: {
        provider: 'paddle',
        providerSubscriptionId: 'sub_01fixture',
        providerCustomerId: 'ctm_01fixture',
        status: 'active',
        plan: 'pro',
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

  it('gives the highest plan among the items and reads a plan change', async () => {
    expect((await mapped({ priceIds: ['pri_pro_fixture', 'pri_enterprise_fixture'] }))?.subscription.plan).toBe('enterprise');
    expect((await mapped({ type: 'subscription.updated', priceIds: ['pri_enterprise_fixture'] }))?.subscription.plan).toBe('enterprise');
  });

  it('applies nothing for a price it does not sell, a status it does not know, or an event that is no subscription event', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await mapped({ priceIds: ['pri_someone_else'] })).toBeNull();
    expect(await mapped({ status: 'unheard_of' })).toBeNull();
    expect(error).toHaveBeenCalledTimes(2);
    for (const type of ['transaction.completed', 'customer.updated', 'something.new']) {
      expect(provider.mapEventToSubscription({ id: 'evt_x', type, payload: {} }), type).toBeNull();
    }
  });
});

describe('createCheckout', () => {
  it('names the price of the plan, the customer and the signed account', () => {
    const params = provider.createCheckout({ userId: 'user-42', email: 'a@b.test', plan: 'enterprise' });
    expect(params).toMatchObject({
      environment: 'sandbox',
      clientToken: 'test_fixture_client_token',
      items: [{ priceId: 'pri_enterprise_fixture', quantity: 1 }],
      customer: { email: 'a@b.test' },
    });
    expect(params.customData.easyconvertUserId).toBe('user-42');
    expect(params.customData.easyconvertBinding).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(params)).not.toContain(WEBHOOK_SECRET);
    expect(JSON.stringify(params)).not.toContain(config.apiKey);
  });

  it('makes a different tag for each account and for each secret', () => {
    const tag = (secret: string, userId: string) =>
      new PaddleBillingProvider({ ...config, webhookSecret: secret }).createCheckout({ userId, email: 'a@b.test', plan: 'pro' }).customData.easyconvertBinding;
    expect(tag('s1', 'u1')).not.toBe(tag('s1', 'u2'));
    expect(tag('s1', 'u1')).not.toBe(tag('s2', 'u1'));
    expect(tag('s1', 'u1')).toBe(tag('s1', 'u1'));
  });
});

describe('createPortalLink', () => {
  const subscription: SubscriptionRecord = {
    userId: 'user-42',
    provider: 'paddle',
    providerSubscriptionId: 'sub_01fixture',
    providerCustomerId: 'ctm_01fixture',
    status: 'active',
    plan: 'pro',
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
