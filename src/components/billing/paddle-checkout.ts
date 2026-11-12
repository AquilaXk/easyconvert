import type { Paddle } from '@paddle/paddle-js';
import type { EnabledBillingStatus } from './billing-status';

/**
 * Paddle.js, loaded only when paid plans are on sale and a page needs a price or a checkout. It follows the starter kit of
 * Paddle (PaddleHQ/paddle-nextjs-starter-kit, Apache-2.0): `initializePaddle` with the client token, then `Checkout.open`.
 */

let loading: { key: string; paddle: Promise<Paddle | undefined> } | undefined;
const completedListeners = new Set<() => void>();

function load(status: EnabledBillingStatus): Promise<Paddle | undefined> {
  const key = `${status.environment}:${status.clientToken}`;
  if (loading?.key === key) return loading.paddle;
  const paddle = import('@paddle/paddle-js').then(({ initializePaddle }) =>
    initializePaddle({
      environment: status.environment,
      token: status.clientToken,
      eventCallback: (event) => {
        if (event.name === 'checkout.completed') for (const listener of completedListeners) listener();
      },
    })
  );
  loading = { key, paddle };
  return paddle;
}

/** Calls `listener` when a checkout of this page has been paid; returns the function that stops it. */
export function onCheckoutCompleted(listener: () => void): () => void {
  completedListeners.add(listener);
  return () => completedListeners.delete(listener);
}

export interface PlanPrice {
  /** The price as Paddle formats it for the visitor's country, tax included where it applies. */
  formatted: string;
  interval?: 'month' | 'year';
}

/** The price of a plan for this visitor, or undefined when Paddle.js is unavailable or gives none. */
export async function previewPrice(status: EnabledBillingStatus, priceId: string): Promise<PlanPrice | undefined> {
  const paddle = await load(status);
  const { data } = (await paddle?.PricePreview({ items: [{ priceId, quantity: 1 }] })) ?? {};
  const line = data?.details.lineItems[0];
  if (!line) return undefined;
  const cycle = line.price.billingCycle;
  const interval = cycle?.frequency === 1 && (cycle.interval === 'month' || cycle.interval === 'year') ? cycle.interval : undefined;
  return { formatted: line.formattedTotals.total, ...(interval ? { interval } : {}) };
}

export interface CheckoutInput {
  items: { priceId: string; quantity: number }[];
  customer: { email: string };
  customData: Record<string, string>;
}

/** Opens the overlay checkout; false when Paddle.js could not be loaded. */
export async function openCheckout(status: EnabledBillingStatus, input: CheckoutInput, locale: string): Promise<boolean> {
  const paddle = await load(status);
  if (!paddle) return false;
  paddle.Checkout.open({ ...input, settings: { displayMode: 'overlay', locale } });
  return true;
}
