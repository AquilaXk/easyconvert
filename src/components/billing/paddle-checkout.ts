import type { Paddle } from '@paddle/paddle-js';
import { convertAmountFromLowestUnit } from '@/lib/billing/parse-money';
import type { PublicBillingConfig } from '@/lib/billing/types';

/**
 * Paddle.js, loaded only when paid plans are on sale and a page needs a price or a checkout. It follows the starter kit of
 * Paddle (PaddleHQ/paddle-nextjs-starter-kit, Apache-2.0): `initializePaddle` with the client token, then `Checkout.open`.
 */

let loading: { key: string; paddle: Promise<Paddle | undefined> } | undefined;
const completedListeners = new Set<() => void>();

function load(status: PublicBillingConfig): Promise<Paddle | undefined> {
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
  /** The same price as a number of whole currency units, and the currency, for a price per credit. */
  amount: number;
  currency: string;
  interval?: 'month' | 'year';
}

/**
 * The prices of `priceIds` for this visitor, by price id, in one request; empty when Paddle.js is unavailable or gives none. The amount
 * comes from the lowest-unit string Paddle returns, read by the money helper of the starter kit.
 */
export async function previewPrices(status: PublicBillingConfig, priceIds: readonly string[]): Promise<Record<string, PlanPrice>> {
  const paddle = await load(status);
  const { data } = (await paddle?.PricePreview({ items: priceIds.map((priceId) => ({ priceId, quantity: 1 })) })) ?? {};
  const prices: Record<string, PlanPrice> = {};
  for (const line of data?.details.lineItems ?? []) {
    const cycle = line.price.billingCycle;
    const interval = cycle?.frequency === 1 && (cycle.interval === 'month' || cycle.interval === 'year') ? cycle.interval : undefined;
    prices[line.price.id] = {
      formatted: line.formattedTotals.total,
      amount: convertAmountFromLowestUnit(line.totals.total, data?.currencyCode ?? 'USD'),
      currency: data?.currencyCode ?? 'USD',
      ...(interval ? { interval } : {}),
    };
  }
  return prices;
}

export interface CheckoutInput {
  items: { priceId: string; quantity: number }[];
  customer: { email: string };
  customData: Record<string, string>;
}

/** Opens the overlay checkout; false when Paddle.js could not be loaded. */
export async function openCheckout(status: PublicBillingConfig, input: CheckoutInput, locale: string): Promise<boolean> {
  const paddle = await load(status);
  if (!paddle) return false;
  paddle.Checkout.open({ ...input, settings: { displayMode: 'overlay', locale } });
  return true;
}
