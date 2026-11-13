import type { PackageSize, Product, SubscriptionSize } from './credits';

/** The states of a subscription, as the provider words them. */
export type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'paused' | 'canceled';

/** What the store keeps of one account's subscription: no card, no address, no amount. */
export interface SubscriptionRecord {
  userId: string;
  provider: string;
  providerSubscriptionId: string;
  providerCustomerId: string;
  status: SubscriptionStatus;
  /** Credits the subscription gives each billing period. */
  credits: SubscriptionSize;
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

/**
 * What an event says about a subscription, before the account it belongs to is settled: `userId` is set when the event proves
 * it. `credits` is absent when the subscription's price is one this configuration no longer sells (a retired or rotated price); the
 * event is then read for its status alone, and the credits are those the stored record of that subscription has.
 */
export type MappedSubscriptionEvent = Omit<SubscriptionChange, 'userId' | 'subscription'> & {
  userId?: string;
  subscription: Omit<SubscriptionChange['subscription'], 'credits'> & { credits?: SubscriptionSize };
};

/** A completed payment for packages, read from a provider event or list: the credits it buys and the account the checkout named. */
export interface PackagePurchase {
  transactionId: string;
  /** Credits of all the package items of the payment (quantity included). */
  credits: number;
  /** What the customer paid in all, in the lowest unit of `currency` as the provider states it; the share of a refund is read against it. */
  paid: string;
  currency: string;
  /** When the provider says the payment happened, in milliseconds since the epoch. */
  occurredAt: number;
  /** The account the payment names, when its custom data carries this server's tag. */
  userId?: string;
}

/** A refund or a chargeback of a package payment, read from a provider event. */
export interface PackageRefund {
  adjustmentId: string;
  transactionId: string;
  /** The amount returned, in the lowest unit of `currency`, and how much of the payment's total that is (0 to 1; 1 for a full refund). */
  amount: string;
  currency: string;
  full: boolean;
  action: 'refund' | 'chargeback';
  occurredAt: number;
}

/** One payment of the provider's own list, read as an event is: `purchase` is null for a payment that buys no package of this configuration. */
export interface ListedPackagePurchase {
  transactionId: string;
  purchase: PackagePurchase | null;
}

/** One subscription of the provider's own list, read as an event is: `change` is null for one whose status or price this configuration does not read. */
export interface ListedSubscription {
  providerSubscriptionId: string;
  change: MappedSubscriptionEvent | null;
}

/** The credits and Paddle price of each size that is sold. */
export interface SizedPrice<Size extends number> {
  credits: Size;
  priceId: string;
}

/** What a page needs to offer packages and subscriptions: Paddle.js settings and the price of each size. All of it is public by design (entry 262). */
export interface PublicBillingConfig {
  environment: 'sandbox' | 'production';
  clientToken: string;
  packages: SizedPrice<PackageSize>[];
  subscriptions: SizedPrice<SubscriptionSize>[];
}

/** What the browser needs to open a checkout for a product. */
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
  createCheckout(input: { userId: string; email: string; product: Product }): CheckoutParams;
  /** Checks the signature of a webhook body; throws `InvalidWebhookError`. */
  verifyWebhook(rawBody: string, signature: string | null): Promise<VerifiedBillingEvent>;
  /** The change an event makes to a subscription, or null for an event that changes none or names no account. */
  mapEventToSubscription(event: VerifiedBillingEvent): MappedSubscriptionEvent | null;
  /** The package payment a completed-payment event reports, or null for an event that is no such payment. */
  mapEventToPackagePurchase(event: VerifiedBillingEvent): PackagePurchase | null;
  /** The refund or chargeback of a package payment an adjustment event reports, once approved, or null. */
  mapEventToPackageRefund(event: VerifiedBillingEvent): PackageRefund | null;
  /**
   * The approved refunds and chargebacks of the last 30 days from the provider's own list, newest first, a page at a time, read as the
   * events of `mapEventToPackageRefund` are. Ends when the list is read back to the first adjustment older than that; a page that
   * cannot be read in time throws.
   */
  listPackageRefunds(options: { perPage: number; signal: AbortSignal }): AsyncGenerator<PackageRefund[], void, void>;
  /**
   * The completed payments of the provider's own list, newest first, a page at a time, read as the events of
   * `mapEventToPackagePurchase` are. A page that cannot be read in time throws.
   */
  listPackagePurchases(options: { perPage: number; signal: AbortSignal }): AsyncGenerator<ListedPackagePurchase[], void, void>;
  /** Moves the subscription to another size at once: the new price is billed in full, so credits of the new size are never handed out for the price of the difference; throws when the provider refuses. */
  changeSubscription(subscription: SubscriptionRecord, credits: SubscriptionSize): Promise<void>;
  /**
   * Every subscription the provider holds, a page at a time, read as the events of `mapEventToSubscription` are: the time of a
   * change is when the provider last updated the subscription. A page that cannot be read in time throws.
   */
  listSubscriptions(options: { perPage: number; signal: AbortSignal }): AsyncGenerator<ListedSubscription[], void, void>;
  /** A link for the subscriber to update the payment method and to cancel. */
  createPortalLink(subscription: SubscriptionRecord): Promise<{ url: string; cancelUrl?: string }>;
}
