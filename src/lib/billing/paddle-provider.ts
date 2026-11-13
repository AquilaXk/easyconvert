import crypto from 'node:crypto';
import { ApiError, Environment, Paddle, Webhooks } from '@paddle/paddle-node-sdk';
import { priceIdOf, productOfPriceId, type BillingConfig } from './config';
import type { Product, SubscriptionSize } from './credits';
import {
  InvalidWebhookError,
  type BillingProvider,
  type CheckoutParams,
  type ListedPackagePurchase,
  type ListedSubscription,
  type MappedSubscriptionEvent,
  type PackagePurchase,
  type PackageRefund,
  type SubscriptionRecord,
  type SubscriptionStatus,
  type VerifiedBillingEvent,
} from './types';
import { SIGNATURE_WINDOW_SECONDS, checkSignature, sameText } from './webhook-signature';

/**
 * Paddle Billing as the payment provider, following the official Node SDK (PaddleHQ/paddle-node-sdk, Apache-2.0: event classes,
 * customer portal sessions; its signature check is `webhook-signature.ts`, which reads every h1 of a header) and the checkout of the Paddle Next.js starter kit
 * (PaddleHQ/paddle-nextjs-starter-kit, Apache-2.0: Paddle.js overlay with the account carried as custom data).
 */

const SUBSCRIPTION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'subscription.created',
  'subscription.activated',
  'subscription.updated',
  'subscription.canceled',
  'subscription.past_due',
  'subscription.paused',
  'subscription.resumed',
  'subscription.trialing',
]);

const STATUSES: ReadonlySet<string> = new Set<SubscriptionStatus>(['active', 'trialing', 'past_due', 'paused', 'canceled']);

const PACKAGE_PURCHASE_EVENT = 'transaction.completed';
const PACKAGE_REFUND_EVENTS: ReadonlySet<string> = new Set(['adjustment.created', 'adjustment.updated']);
const REFUND_ACTIONS: ReadonlySet<string> = new Set(['refund', 'chargeback']);

/** How far back the list of completed payments is read: a payment older than this that the ledger lacks was lost for good, not late. */
const PACKAGE_LIST_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/** The statuses that take the paid tier away or hold it only to the end of the paid period: they are applied even when the price is no longer sold, so a retired price cannot leave a paid tier in place. */
const LOSES_PLAN: ReadonlySet<string> = new Set<SubscriptionStatus>(['canceled', 'paused', 'past_due']);

/** Every status is asked for by name: the API does not say which ones a list without the filter returns, and an entitling subscription left out of it would be withdrawn as missing. */
const LISTED_STATUSES = ['active', 'trialing', 'past_due', 'paused', 'canceled'] as const;

const USER_ID_FIELD = 'easyconvertUserId';
const BINDING_FIELD = 'easyconvertBinding';
const BINDING_LABEL = 'easyconvert:checkout:v1:';

/** The tag that ties a checkout to its account: only this server can make one, so custom data typed in a browser proves nothing. */
function bindingOf(webhookSecret: string, userId: string): string {
  return crypto.createHmac('sha256', webhookSecret).update(`${BINDING_LABEL}${userId}`).digest('base64url');
}

/** The account a checkout's custom data names, when its tag is the one `createCheckout` made. */
function boundUserId(config: BillingConfig, customData: unknown): string | undefined {
  if (typeof customData !== 'object' || customData === null) return undefined;
  const { [USER_ID_FIELD]: userId, [BINDING_FIELD]: binding } = customData as Record<string, unknown>;
  if (typeof userId !== 'string' || typeof binding !== 'string') return undefined;
  return sameText(binding, bindingOf(config.webhookSecret, userId)) ? userId : undefined;
}

function timeOf(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

interface SubscriptionData {
  id: string;
  status: string;
  customerId: string;
  customData: unknown;
  items: { price: { id: string } | null }[];
  currentBillingPeriod: { endsAt: string } | null;
  scheduledChange: { action: string; effectiveAt: string } | null;
}

/** The most credits among the subscription prices of the subscription's items; undefined when none is a price this configuration sells. */
function creditsOfItems(config: BillingConfig, items: SubscriptionData['items']): SubscriptionSize | undefined {
  const sold = items.flatMap((item) => {
    const product = item.price ? productOfPriceId(config, item.price.id) : undefined;
    return product?.kind === 'subscription' ? [product.credits] : [];
  });
  return sold.length === 0 ? undefined : Math.max(...sold) as SubscriptionSize;
}

interface TransactionData {
  id: string;
  status: string;
  customData: unknown;
  currencyCode: string;
  items: { price: { id: string } | null; quantity: number }[];
  details: { totals: { total: string } | null } | null;
  createdAt?: string;
}

interface AdjustmentData {
  id: string;
  action: string;
  status: string;
  transactionId: string;
  currencyCode: string;
  items: { type: string }[];
  totals: { total: string };
}

/** The credits of the package items of a payment, quantity included; 0 when it buys no package of this configuration. */
function packageCreditsOf(config: BillingConfig, items: TransactionData['items']): number {
  let credits = 0;
  for (const item of items) {
    const product = item.price ? productOfPriceId(config, item.price.id) : undefined;
    if (product?.kind === 'package') credits += product.credits * Math.max(1, item.quantity);
  }
  return credits;
}

const MS_PER_SECOND = 1000;

/** How often a page of the list is asked for again after the provider says to wait, and the longest wait it is obeyed for. */
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_MAX_WAIT_SECONDS = 30;

/** Waits `ms`, or throws the reason of `signal` when it ends first. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** `work`, or the reason of `signal` when it ends first (a request of the SDK has no deadline of its own). */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export class PaddleBillingProvider implements BillingProvider {
  readonly id = 'paddle';
  private readonly paddle: Paddle;

  constructor(private readonly config: BillingConfig, paddle?: Paddle) {
    this.paddle =
      paddle ?? new Paddle(config.apiKey, { environment: config.environment === 'production' ? Environment.production : Environment.sandbox });
  }

  createCheckout({ userId, email, product }: { userId: string; email: string; product: Product }): CheckoutParams {
    return {
      environment: this.config.environment,
      clientToken: this.config.clientToken,
      items: [{ priceId: priceIdOf(this.config, product), quantity: 1 }],
      customer: { email },
      customData: { [USER_ID_FIELD]: userId, [BINDING_FIELD]: bindingOf(this.config.webhookSecret, userId) },
    };
  }

  async verifyWebhook(rawBody: string, signature: string | null): Promise<VerifiedBillingEvent> {
    if (!signature) throw new InvalidWebhookError('The Paddle-Signature header is missing');
    const check = checkSignature(this.config.webhookSecret, rawBody, signature, Date.now());
    if (!check.valid) {
      // A genuine signature outside the window is a clock that is off here or at the provider (or a captured request sent again); a forged or malformed header says nothing.
      if (check.reason === 'window') {
        console.error(
          `[billing] webhook signature is genuine but its timestamp is ${Math.abs(check.skewSeconds)} s ${check.skewSeconds > 0 ? 'behind' : 'ahead of'} this server's clock (window ${SIGNATURE_WINDOW_SECONDS} s): ` +
            'the clock here or at the provider is off, or a captured request was sent again; refused'
        );
      }
      throw new InvalidWebhookError();
    }
    let event: ReturnType<typeof Webhooks.fromJson>;
    try {
      event = Webhooks.fromJson(JSON.parse(rawBody));
    } catch {
      throw new InvalidWebhookError();
    }
    return { id: event.eventId, type: event.eventType, payload: event };
  }

  mapEventToSubscription(event: VerifiedBillingEvent): MappedSubscriptionEvent | null {
    if (!SUBSCRIPTION_EVENT_TYPES.has(event.type)) return null;
    const { occurredAt, data } = event.payload as { occurredAt: string; data: SubscriptionData };
    const mapped = this.mapSubscription(data, event.id, timeOf(occurredAt));
    if (!mapped) console.error(`[billing] ${event.type} ${event.id} names no time, no known status or no subscription this configuration sells; not applied`);
    return mapped;
  }

  /** What a subscription (of an event or of the list) says, or null when it names no time, no known status or no subscription this configuration sells. */
  private mapSubscription(data: SubscriptionData, eventId: string, eventAt: number | undefined): MappedSubscriptionEvent | null {
    const credits = creditsOfItems(this.config, data.items);
    if (eventAt === undefined || !STATUSES.has(data.status) || (credits === undefined && !LOSES_PLAN.has(data.status))) return null;
    const cancelAt = data.scheduledChange?.action === 'cancel' ? timeOf(data.scheduledChange.effectiveAt) : undefined;
    const currentPeriodEnd = timeOf(data.currentBillingPeriod?.endsAt);
    return {
      eventId,
      eventAt,
      userId: boundUserId(this.config, data.customData),
      subscription: {
        provider: this.id,
        providerSubscriptionId: data.id,
        providerCustomerId: data.customerId,
        status: data.status as SubscriptionStatus,
        ...(credits === undefined ? {} : { credits }),
        ...(currentPeriodEnd === undefined ? {} : { currentPeriodEnd }),
        ...(cancelAt === undefined ? {} : { cancelAt }),
      },
    };
  }

  mapEventToPackagePurchase(event: VerifiedBillingEvent): PackagePurchase | null {
    if (event.type !== PACKAGE_PURCHASE_EVENT) return null;
    const { occurredAt, data } = event.payload as { occurredAt: string; data: TransactionData };
    return this.mapTransaction(data, timeOf(occurredAt));
  }

  /** What a completed payment (of an event or of the list) buys, or null when it is not completed, names no time or buys no package of this configuration. */
  private mapTransaction(data: TransactionData, occurredAt: number | undefined): PackagePurchase | null {
    const credits = packageCreditsOf(this.config, data.items);
    if (data.status !== 'completed' || occurredAt === undefined || credits === 0) return null;
    const userId = boundUserId(this.config, data.customData);
    return {
      transactionId: data.id,
      credits,
      paid: data.details?.totals?.total ?? '',
      currency: data.currencyCode,
      occurredAt,
      ...(userId === undefined ? {} : { userId }),
    };
  }

  mapEventToPackageRefund(event: VerifiedBillingEvent): PackageRefund | null {
    if (!PACKAGE_REFUND_EVENTS.has(event.type)) return null;
    const { occurredAt, data } = event.payload as { occurredAt: string; data: AdjustmentData };
    const at = timeOf(occurredAt);
    // A refund that is still waiting for approval, was rejected or was reversed gives nothing back yet.
    if (at === undefined || data.status !== 'approved' || !REFUND_ACTIONS.has(data.action)) return null;
    return {
      adjustmentId: data.id,
      transactionId: data.transactionId,
      amount: data.totals.total,
      currency: data.currencyCode,
      full: data.items.some((item) => item.type === 'full'),
      action: data.action as PackageRefund['action'],
      occurredAt: at,
    };
  }

  async *listPackagePurchases({ perPage, signal }: { perPage: number; signal: AbortSignal }): AsyncGenerator<ListedPackagePurchase[], void, void> {
    const since = new Date(Date.now() - PACKAGE_LIST_LOOKBACK_MS).toISOString();
    const collection = this.paddle.transactions.list({ perPage, status: ['completed'], orderBy: 'created_at[DESC]', 'createdAt[GTE]': since });
    while (collection.hasMore) {
      const page = await this.nextPage(collection, signal);
      yield page.map((transaction) => ({
        transactionId: transaction.id,
        purchase: this.mapTransaction(transaction, timeOf(transaction.billedAt ?? transaction.createdAt)),
      }));
    }
  }

  async changeSubscription(subscription: SubscriptionRecord, credits: SubscriptionSize): Promise<void> {
    await this.paddle.subscriptions.update(subscription.providerSubscriptionId, {
      items: [{ priceId: priceIdOf(this.config, { kind: 'subscription', credits }), quantity: 1 }],
      prorationBillingMode: 'full_immediately',
    });
  }

  async *listSubscriptions({ perPage, signal }: { perPage: number; signal: AbortSignal }): AsyncGenerator<ListedSubscription[], void, void> {
    const collection = this.paddle.subscriptions.list({ perPage, status: [...LISTED_STATUSES] });
    while (collection.hasMore) {
      const page = await this.nextPage(collection, signal);
      yield page.map((subscription) => ({
        providerSubscriptionId: subscription.id,
        change: this.mapSubscription(subscription, `list:${subscription.id}:${subscription.updatedAt}`, timeOf(subscription.updatedAt)),
      }));
    }
  }

  /** The next page of a list; a page the provider asks to wait for is asked for again after the wait, a few times. */
  private async nextPage<T>(collection: { next(): Promise<T[]> }, signal: AbortSignal): Promise<T[]> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await untilAborted(collection.next(), signal);
      } catch (error) {
        if (!(error instanceof ApiError) || error.retryAfter === null || attempt >= RATE_LIMIT_RETRIES) throw error;
        await pause(Math.min(error.retryAfter, RATE_LIMIT_MAX_WAIT_SECONDS) * MS_PER_SECOND, signal);
      }
    }
  }

  async createPortalLink(subscription: SubscriptionRecord): Promise<{ url: string; cancelUrl?: string }> {
    const session = await this.paddle.customerPortalSessions.create(subscription.providerCustomerId, [subscription.providerSubscriptionId]);
    const own = session.urls.subscriptions.find((entry) => entry.id === subscription.providerSubscriptionId);
    return { url: session.urls.general.overview, ...(own ? { cancelUrl: own.cancelSubscription } : {}) };
  }
}
