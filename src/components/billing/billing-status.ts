'use client';

import { useEffect, useState } from 'react';
import type { PaidPlan } from '@/lib/billing/types';

/** What `/api/billing/status` says about the signed-in account's subscription. */
export interface SubscriptionView {
  plan: PaidPlan;
  status: 'active' | 'trialing' | 'past_due' | 'paused' | 'canceled';
  currentPeriodEnd?: number;
  cancelAt?: number;
  /** Whether the subscription gives the account its plan now. */
  active: boolean;
}

/** What the page needs when paid plans are on sale. */
export interface EnabledBillingStatus {
  enabled: true;
  environment: 'sandbox' | 'production';
  clientToken: string;
  plans: { plan: PaidPlan; priceId: string }[];
  subscription: SubscriptionView | null;
}

export type BillingStatus = EnabledBillingStatus | { enabled: false };

const STATUS_ENDPOINT = '/api/billing/status';
const STATUS_TIMEOUT_MS = 5000;

/** The status of billing, or null when it could not be read (the page then treats paid plans as not on sale). */
async function readBillingStatus(): Promise<BillingStatus | null> {
  try {
    const res = await fetch(STATUS_ENDPOINT, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = (await res.json()) as BillingStatus & { success?: boolean };
    return body.success && body.enabled === true ? body : { enabled: false };
  } catch {
    return null;
  }
}

/**
 * The status of billing, null until the route answers and after a failure. Every use of it treats null as "not on sale", so
 * a page that has not heard, or cannot hear, never offers a purchase; the prerendered pages carry that state.
 */
export function useBillingStatus(): BillingStatus | null {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  useEffect(() => {
    let current = true;
    void readBillingStatus().then((read) => {
      if (current) setStatus(read);
    });
    return () => {
      current = false;
    };
  }, []);
  return status;
}

/** Asks for a link to the provider's portal and goes there; resolves with the refusal's answer when there is none. */
export async function openBillingPortal(): Promise<{ payload: unknown; status: number } | undefined> {
  const res = await fetch('/api/billing/portal', { method: 'POST' });
  const payload: unknown = await res.json().catch(() => null);
  const url = (payload as { url?: unknown } | null)?.url;
  if (res.ok && typeof url === 'string') {
    window.location.assign(url);
    return undefined;
  }
  return { payload, status: res.status };
}
