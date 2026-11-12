import crypto from 'node:crypto';

/** Webhook bodies and signatures in the shape Paddle sends them, made without any network. */

export const WEBHOOK_SECRET = 'pdl_ntfset_fixture_secret';

export function sign(body: string, secret: string, ts: number): string {
  const h1 = crypto.createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex');
  return `ts=${ts};h1=${h1}`;
}

export interface SubscriptionEventOptions {
  eventId?: string;
  type?: string;
  occurredAt?: string;
  subscriptionId?: string;
  customerId?: string;
  status?: string;
  priceIds?: string[];
  periodEnd?: string | null;
  scheduledChange?: { action: string; effective_at: string } | null;
  customData?: Record<string, unknown> | null;
}

function price(id: string) {
  return {
    id,
    product_id: 'pro_fixture',
    description: 'fixture',
    name: null,
    type: 'standard',
    billing_cycle: { interval: 'month', frequency: 1 },
    trial_period: null,
    tax_mode: 'account_setting',
    unit_price: { amount: '900', currency_code: 'USD' },
    unit_price_overrides: [],
    quantity: { minimum: 1, maximum: 1 },
    status: 'active',
    custom_data: null,
    import_meta: null,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
  };
}

/** The JSON body of a subscription event. */
export function subscriptionEventBody(options: SubscriptionEventOptions = {}): string {
  const periodEnd = options.periodEnd === undefined ? '2026-12-12T12:00:00Z' : options.periodEnd;
  return JSON.stringify({
    event_id: options.eventId ?? 'evt_01fixture',
    event_type: options.type ?? 'subscription.created',
    occurred_at: options.occurredAt ?? '2026-11-12T12:00:00.123456Z',
    notification_id: 'ntf_01fixture',
    data: {
      id: options.subscriptionId ?? 'sub_01fixture',
      status: options.status ?? 'active',
      customer_id: options.customerId ?? 'ctm_01fixture',
      address_id: 'add_01fixture',
      business_id: null,
      currency_code: 'USD',
      created_at: '2026-11-12T12:00:00Z',
      updated_at: '2026-11-12T12:00:00Z',
      started_at: '2026-11-12T12:00:00Z',
      first_billed_at: '2026-11-12T12:00:00Z',
      next_billed_at: periodEnd,
      paused_at: null,
      canceled_at: null,
      discount: null,
      collection_mode: 'automatic',
      billing_details: null,
      current_billing_period: periodEnd === null ? null : { starts_at: '2026-11-12T12:00:00Z', ends_at: periodEnd },
      billing_cycle: { interval: 'month', frequency: 1 },
      scheduled_change: options.scheduledChange ?? null,
      items: (options.priceIds ?? ['pri_pro_fixture']).map((id) => ({
        status: 'active',
        quantity: 1,
        recurring: true,
        created_at: '2026-11-12T12:00:00Z',
        updated_at: '2026-11-12T12:00:00Z',
        previously_billed_at: '2026-11-12T12:00:00Z',
        next_billed_at: periodEnd,
        trial_dates: null,
        price: price(id),
        product: null,
      })),
      consent_requirements: null,
      custom_data: options.customData === undefined ? null : options.customData,
      import_meta: null,
    },
  });
}
