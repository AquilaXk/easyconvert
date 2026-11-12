import { NextRequest, NextResponse } from 'next/server';
import { billingUnavailable, guardingStore, invalidSignature } from '@/lib/api/billing-refusal';
import { getBillingProvider } from '@/lib/billing';
import { subscriptionStore } from '@/lib/billing/subscription-store';
import { InvalidWebhookError } from '@/lib/billing/types';

export const dynamic = 'force-dynamic';

const SIGNATURE_HEADER = 'paddle-signature';

/**
 * The notification destination of Paddle. The body is read as text, exactly as sent, because the signature covers its bytes;
 * a body whose signature is missing, wrong or older than the provider's window is a 400 and changes nothing. A verified event
 * is applied once by its id (a replay answers 200 and changes nothing), and every answer a retry could not improve is 200: an
 * event that changes no subscription, one that names no account, one for an account that is gone. A store that cannot answer
 * is a 503, so Paddle sends the event again. The route reads no cookie: Paddle holds no session.
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

  const change = provider.mapEventToSubscription(event);
  if (!change) return NextResponse.json({ success: true, result: 'ignored' });

  return guardingStore(async () => {
    const userId = change.userId ?? (await subscriptionStore.userOfSubscription(change.subscription.providerSubscriptionId));
    if (!userId) {
      console.error(`[billing] ${event.type} ${event.id} names no account; not applied`);
      return NextResponse.json({ success: true, result: 'unattributed' });
    }
    const result = await subscriptionStore.apply({ ...change, userId });
    if (result === 'unknown_user') console.error(`[billing] ${event.type} ${event.id} is for an account that no longer exists; not applied`);
    return NextResponse.json({ success: true, result });
  });
}
