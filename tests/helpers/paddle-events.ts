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
      items: (options.priceIds ?? ['pri_subscription_1000_fixture']).map((id) => ({
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

export interface TransactionEventOptions {
  eventId?: string;
  type?: string;
  occurredAt?: string;
  transactionId?: string;
  status?: string;
  subscriptionId?: string | null;
  items?: { priceId: string; quantity?: number }[];
  /** What the customer paid in all, in the lowest unit of the currency. */
  total?: string;
  currency?: string;
  customData?: Record<string, unknown> | null;
}

/** The JSON body of a transaction event; `total` is the amount a refund is read against. */
export function transactionEventBody(options: TransactionEventOptions = {}): string {
  return JSON.stringify({
    event_id: options.eventId ?? 'evt_txn_01fixture',
    event_type: options.type ?? 'transaction.completed',
    occurred_at: options.occurredAt ?? '2026-11-12T12:00:00.123456Z',
    notification_id: 'ntf_txn_01fixture',
    data: transactionData(options),
  });
}

/** One transaction as the API and the notifications carry it. */
export function transactionData(options: TransactionEventOptions = {}) {
  const total = options.total ?? '499';
  return {
    id: options.transactionId ?? 'txn_01fixture',
    status: options.status ?? 'completed',
    customer_id: 'ctm_01fixture',
    address_id: 'add_01fixture',
    business_id: null,
    custom_data: options.customData === undefined ? null : options.customData,
    currency_code: options.currency ?? 'USD',
    origin: 'web',
    subscription_id: options.subscriptionId ?? null,
    invoice_id: null,
    invoice_number: null,
    collection_mode: 'automatic',
    discount_id: null,
    billing_details: null,
    billing_period: null,
    items: (options.items ?? [{ priceId: 'pri_package_1000_fixture' }]).map(({ priceId, quantity }) => ({ price_id: priceId, price: price(priceId), quantity: quantity ?? 1, proration: null })),
    details: {
      tax_rates_used: [],
      totals: { subtotal: total, discount: '0', tax: '0', total, credit: '0', credit_to_balance: '0', balance: '0', grand_total: total, grand_total_tax: '0', fee: null, earnings: null, currency_code: options.currency ?? 'USD' },
      adjusted_totals: null,
      payout_totals: null,
      adjusted_payout_totals: null,
      line_items: [],
    },
    payments: [],
    checkout: null,
    created_at: '2026-11-12T11:59:00Z',
    updated_at: '2026-11-12T12:00:00Z',
    billed_at: '2026-11-12T12:00:00Z',
    revised_at: null,
  };
}

export interface AdjustmentEventOptions {
  eventId?: string;
  type?: string;
  occurredAt?: string;
  adjustmentId?: string;
  transactionId?: string;
  action?: string;
  status?: string;
  /** The type of the item of the adjustment: `full` for the whole payment, `partial` for a part of it. */
  itemType?: 'full' | 'partial' | 'tax' | 'proration';
  /** The amount returned, in the lowest unit of the currency. */
  total?: string;
}

/** The JSON body of an adjustment (refund, chargeback) event. */
export function adjustmentEventBody(options: AdjustmentEventOptions = {}): string {
  const total = options.total ?? '499';
  return JSON.stringify({
    event_id: options.eventId ?? 'evt_adj_01fixture',
    event_type: options.type ?? 'adjustment.updated',
    occurred_at: options.occurredAt ?? '2026-11-13T12:00:00.123456Z',
    notification_id: 'ntf_adj_01fixture',
    data: {
      id: options.adjustmentId ?? 'adj_01fixture',
      action: options.action ?? 'refund',
      type: 'full',
      transaction_id: options.transactionId ?? 'txn_01fixture',
      subscription_id: null,
      customer_id: 'ctm_01fixture',
      reason: 'fixture',
      credit_applied_to_balance: null,
      currency_code: 'USD',
      status: options.status ?? 'approved',
      items: [{ id: 'adjitm_01fixture', item_id: 'txnitm_01fixture', type: options.itemType ?? 'full', amount: null, proration: null, totals: { subtotal: total, tax: '0', total } }],
      totals: { subtotal: total, tax: '0', total, fee: '0', earnings: '0', currency_code: 'USD' },
      payout_totals: null,
      tax_rates_used: null,
      created_at: '2026-11-13T12:00:00Z',
      updated_at: '2026-11-13T12:00:00Z',
    },
  });
}
