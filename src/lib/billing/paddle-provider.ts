import crypto from 'node:crypto';
import { ApiError, Environment, Paddle } from '@paddle/paddle-node-sdk';
import { planOfPriceId, type BillingConfig } from './config';
import {
  InvalidWebhookError,
  PAID_PLANS,
  type BillingProvider,
  type CheckoutParams,
  type ListedSubscription,
  type MappedSubscriptionEvent,
  type PaidPlan,
  type SubscriptionRecord,
  type SubscriptionStatus,
  type VerifiedBillingEvent,
} from './types';

/**
 * Paddle Billing as the payment provider, following the official Node SDK (PaddleHQ/paddle-node-sdk, Apache-2.0: signature
 * check, event classes, customer portal sessions) and the checkout of the Paddle Next.js starter kit
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

/** The statuses that take a plan away or hold it only to the end of the paid period: they are applied even when the price is no longer sold, so a retired price cannot leave a paid tier in place. */
const LOSES_PLAN: ReadonlySet<string> = new Set<SubscriptionStatus>(['canceled', 'paused', 'past_due']);

const USER_ID_FIELD = 'easyconvertUserId';
const BINDING_FIELD = 'easyconvertBinding';
const BINDING_LABEL = 'easyconvert:checkout:v1:';

/** The tag that ties a checkout to its account: only this server can make one, so custom data typed in a browser proves nothing. */
function bindingOf(webhookSecret: string, userId: string): string {
  return crypto.createHmac('sha256', webhookSecret).update(`${BINDING_LABEL}${userId}`).digest('base64url');
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
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

/** The highest paid plan among the prices of the subscription's items; undefined when none is a price this configuration sells. */
function planOfItems(config: BillingConfig, items: SubscriptionData['items']): PaidPlan | undefined {
  const plans = items.flatMap((item) => (item.price ? [planOfPriceId(config, item.price.id)] : []));
  return [...PAID_PLANS].reverse().find((plan) => plans.includes(plan));
}

/** The signature window of the SDK's `webhooks.unmarshal`, in seconds. */
const SIGNATURE_WINDOW_SECONDS = 5;
const MS_PER_SECOND = 1000;

/**
 * How far from this server's clock the timestamp of a webhook signature is, in seconds, when the signature is genuine and only its
 * time is outside the window; undefined for any other header. A genuine signature outside the window is a clock that is off here or
 * at the provider (or a captured request sent again), and the SDK answers both and a forged header with the same refusal.
 */
function genuineSignatureTimeSkew(secret: string, rawBody: string, signature: string, now: number): number | undefined {
  const fields = signature.split(';').map((part) => part.split('='));
  const ts = Number(fields.find(([key]) => key === 'ts')?.[1]);
  const hashes = fields.flatMap(([key, value]) => (key === 'h1' && value ? [value] : []));
  if (!Number.isFinite(ts) || hashes.length === 0) return undefined;
  const expected = crypto.createHmac('sha256', secret).update(`${ts}:${rawBody}`).digest('hex');
  if (!hashes.some((hash) => sameText(hash, expected))) return undefined;
  const skew = Math.round(now / MS_PER_SECOND - ts);
  return Math.abs(skew) > SIGNATURE_WINDOW_SECONDS ? skew : undefined;
}

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

  createCheckout({ userId, email, plan }: { userId: string; email: string; plan: PaidPlan }): CheckoutParams {
    return {
      environment: this.config.environment,
      clientToken: this.config.clientToken,
      items: [{ priceId: this.config.priceIds[plan], quantity: 1 }],
      customer: { email },
      customData: { [USER_ID_FIELD]: userId, [BINDING_FIELD]: bindingOf(this.config.webhookSecret, userId) },
    };
  }

  async verifyWebhook(rawBody: string, signature: string | null): Promise<VerifiedBillingEvent> {
    if (!signature) throw new InvalidWebhookError('The Paddle-Signature header is missing');
    let event: Awaited<ReturnType<Paddle['webhooks']['unmarshal']>>;
    try {
      event = await this.paddle.webhooks.unmarshal(rawBody, this.config.webhookSecret, signature);
    } catch {
      const skew = genuineSignatureTimeSkew(this.config.webhookSecret, rawBody, signature, Date.now());
      if (skew !== undefined) {
        console.error(
          `[billing] webhook signature is genuine but its timestamp is ${Math.abs(skew)} s ${skew > 0 ? 'behind' : 'ahead of'} this server's clock (window ${SIGNATURE_WINDOW_SECONDS} s): ` +
            'the clock here or at the provider is off, or a captured request was sent again; refused'
        );
      }
      throw new InvalidWebhookError();
    }
    return { id: event.eventId, type: event.eventType, payload: event };
  }

  mapEventToSubscription(event: VerifiedBillingEvent): MappedSubscriptionEvent | null {
    if (!SUBSCRIPTION_EVENT_TYPES.has(event.type)) return null;
    const { occurredAt, data } = event.payload as { occurredAt: string; data: SubscriptionData };
    const mapped = this.mapSubscription(data, event.id, timeOf(occurredAt));
    if (!mapped) console.error(`[billing] ${event.type} ${event.id} names no time, no known status or no plan this configuration sells; not applied`);
    return mapped;
  }

  /** What a subscription (of an event or of the list) says, or null when it names no time, no known status or no plan this configuration sells. */
  private mapSubscription(data: SubscriptionData, eventId: string, eventAt: number | undefined): MappedSubscriptionEvent | null {
    const plan = planOfItems(this.config, data.items);
    if (eventAt === undefined || !STATUSES.has(data.status) || (plan === undefined && !LOSES_PLAN.has(data.status))) return null;
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
        ...(plan === undefined ? {} : { plan }),
        ...(currentPeriodEnd === undefined ? {} : { currentPeriodEnd }),
        ...(cancelAt === undefined ? {} : { cancelAt }),
      },
    };
  }

  async *listSubscriptions({ perPage, signal }: { perPage: number; signal: AbortSignal }): AsyncGenerator<ListedSubscription[], void, void> {
    const collection = this.paddle.subscriptions.list({ perPage });
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
