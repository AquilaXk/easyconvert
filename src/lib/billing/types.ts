import type { UserTier } from '../auth/types';

/** The plans that are bought; `free` is what an account has without a subscription. */
export const PAID_PLANS = ['pro', 'enterprise'] as const satisfies readonly UserTier[];
export type PaidPlan = (typeof PAID_PLANS)[number];

export const isPaidPlan = (value: unknown): value is PaidPlan => PAID_PLANS.some((plan) => plan === value);

/** The states of a subscription, as the provider words them. */
export type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'paused' | 'canceled';

/** What the store keeps of one account's subscription: no card, no address, no amount. */
export interface SubscriptionRecord {
  userId: string;
  provider: string;
  providerSubscriptionId: string;
  providerCustomerId: string;
  status: SubscriptionStatus;
  plan: PaidPlan;
  /** When the period that is paid for ends, in milliseconds since the epoch. */
  currentPeriodEnd?: number;
  /** When a scheduled cancellation takes effect; the subscription stays active until then. */
  cancelAt?: number;
  /** When the newest event applied to this record happened at the provider; an older event is not applied. */
  eventAt: number;
}

/** One event of the provider, reduced to what changes a subscription. */
export interface SubscriptionChange {
  eventId: string;
  /** When the event happened at the provider, in milliseconds since the epoch. */
  eventAt: number;
  userId: string;
  subscription: Omit<SubscriptionRecord, 'userId' | 'eventAt'>;
}

/** What an event says about a subscription, before the account it belongs to is settled: `userId` is set when the event proves it. */
export type MappedSubscriptionEvent = Omit<SubscriptionChange, 'userId'> & { userId?: string };

/** What the browser needs to open a checkout for `plan`. */
export interface CheckoutParams {
  environment: 'sandbox' | 'production';
  clientToken: string;
  items: { priceId: string; quantity: number }[];
  customer: { email: string };
  /** The account the purchase is for, signed so that a purchase cannot be attributed to another account. */
  customData: Record<string, string>;
}

/** A provider event that passed its signature check; what it holds is for `mapEventToSubscription` to read. */
export interface VerifiedBillingEvent {
  id: string;
  type: string;
  /** The provider's own event object. */
  payload: unknown;
}

/** A refusal of a webhook: the signature is missing, wrong or too old. */
export class InvalidWebhookError extends Error {
  constructor(message = 'The webhook signature is not valid') {
    super(message);
    this.name = 'InvalidWebhookError';
  }
}

/** The part of a payment provider that the rest of the application depends on. */
export interface BillingProvider {
  readonly id: string;
  createCheckout(input: { userId: string; email: string; plan: PaidPlan }): CheckoutParams;
  /** Checks the signature of a webhook body; throws `InvalidWebhookError`. */
  verifyWebhook(rawBody: string, signature: string | null): Promise<VerifiedBillingEvent>;
  /** The change an event makes to a subscription, or null for an event that changes none or names no account. */
  mapEventToSubscription(event: VerifiedBillingEvent): MappedSubscriptionEvent | null;
  /** A link for the subscriber to update the payment method and to cancel. */
  createPortalLink(subscription: SubscriptionRecord): Promise<{ url: string; cancelUrl?: string }>;
}
