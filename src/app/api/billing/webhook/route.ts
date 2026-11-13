import { NextRequest, NextResponse } from 'next/server';
import { billingUnavailable, guardingStore, invalidSignature } from '@/lib/api/billing-refusal';
import { getBillingProvider } from '@/lib/billing';
import { creditPackagePurchase, refundPackagePurchase, type PackageRefundResult } from '@/lib/billing/package-credits';
import { subscriptionStore } from '@/lib/billing/subscription-store';
import { InvalidWebhookError, type BillingProvider, type VerifiedBillingEvent } from '@/lib/billing/types';
import { observeBillingEvent } from '@/lib/metrics/instruments';
import type { BillingResult } from '@/lib/metrics/labels';

export const dynamic = 'force-dynamic';

/** The credits the account's stored record has for this subscription, for an event about a price that is no longer sold. */
async function creditsOfStoredSubscription(userId: string, providerSubscriptionId: string) {
  const stored = await subscriptionStore.findByUser(userId);
  return stored?.providerSubscriptionId === providerSubscriptionId ? stored.credits : undefined;
}

const SIGNATURE_HEADER = 'paddle-signature';

/** The answer of a verified event, counted (`easyconvert_billing_events_total`) so that an event no account holds can alert. */
function answer(result: BillingResult): NextResponse {
  observeBillingEvent('webhook', result);
  return NextResponse.json({ success: true, result });
}

/** A completed payment for packages: credits the account its checkout named, once for each transaction id. */
async function applyPackagePurchase(provider: BillingProvider, event: VerifiedBillingEvent): Promise<NextResponse | undefined> {
  const purchase = provider.mapEventToPackagePurchase(event);
  if (!purchase) return undefined;
  if (!purchase.userId) {
    console.error(`[billing] ${event.type} ${event.id} (payment ${purchase.transactionId}, ${purchase.credits} credits) names no account; not credited`);
    return answer('unattributed');
  }
  const result = await creditPackagePurchase(purchase, purchase.userId);
  if (result === 'unknown_user') console.error(`[billing] ${event.type} ${event.id} is for an account that no longer exists; not credited`);
  return answer(result === 'granted' ? 'applied' : result);
}

const REFUND_RESULTS: Readonly<Record<PackageRefundResult, BillingResult>> = { revoked: 'applied', duplicate: 'duplicate', unknown_transaction: 'ignored' };

/** An approved refund or chargeback of a package payment: takes back the credits of it that are unused. */
async function applyPackageRefund(provider: BillingProvider, event: VerifiedBillingEvent): Promise<NextResponse | undefined> {
  const refund = provider.mapEventToPackageRefund(event);
  if (!refund) return undefined;
  const result = await refundPackagePurchase(refund);
  // A payment this server never credited (a subscription's, or one before the ledger) has nothing to take back.
  return answer(REFUND_RESULTS[result]);
}

/** A subscription event: the subscription it describes becomes the account's, once for each event id. */
async function applySubscription(provider: BillingProvider, event: VerifiedBillingEvent): Promise<NextResponse | undefined> {
  const change = provider.mapEventToSubscription(event);
  if (!change) return undefined;
  const userId = change.userId ?? (await subscriptionStore.userOfSubscription(change.subscription.providerSubscriptionId));
  if (!userId) {
    console.error(`[billing] ${event.type} ${event.id} names no account; not applied`);
    return answer('unattributed');
  }
  const credits = change.subscription.credits ?? (await creditsOfStoredSubscription(userId, change.subscription.providerSubscriptionId));
  if (!credits) {
    console.error(`[billing] ${event.type} ${event.id} is for a price that is no longer sold and a subscription this server does not hold; not applied`);
    return answer('ignored');
  }
  const result = await subscriptionStore.apply({ ...change, userId, subscription: { ...change.subscription, credits } });
  if (result === 'unknown_user') console.error(`[billing] ${event.type} ${event.id} is for an account that no longer exists; not applied`);
  return answer(result);
}

/**
 * The notification destination of Paddle. The body is read as text, exactly as sent, because the signature covers its bytes;
 * a body whose signature is missing, wrong or older than the provider's window is a 400 and changes nothing. A verified event
 * is applied once by its id (a replay answers 200 and changes nothing), and every answer a retry could not improve is 200: an
 * event that changes nothing, one that names no account, one for an account that is gone. Three kinds of event change anything:
 * a subscription's (its status and credits), a completed payment for packages (its credits are added once for each transaction id)
 * and an approved refund or chargeback of one (the unused credits of that payment are taken back). A store that cannot answer is a
 * 503, so Paddle sends the event again. The route reads no cookie: Paddle holds no session.
 */
export async function POST(req: NextRequest) {
  const billing = getBillingProvider();
  if (!billing) return billingUnavailable();
  const { provider } = billing;

  const rawBody = await req.text();
  let event;
  try {
    event = await provider.verifyWebhook(rawBody, req.headers.get(SIGNATURE_HEADER));
  } catch (error) {
    if (error instanceof InvalidWebhookError) return invalidSignature();
    throw error;
  }

  return guardingStore(async () => {
    for (const apply of [applySubscription, applyPackagePurchase, applyPackageRefund]) {
      const answered = await apply(provider, event);
      if (answered) return answered;
    }
    return NextResponse.json({ success: true, result: 'ignored' });
  });
}
