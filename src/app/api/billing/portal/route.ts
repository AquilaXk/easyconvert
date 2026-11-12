import { NextRequest, NextResponse } from 'next/server';
import { billingUnavailable, guardingStore, noSubscription, providerFailed } from '@/lib/api/billing-refusal';
import { codedRefusal } from '@/lib/api/problem-details';
import { readSessionOrRefusal } from '@/lib/auth/session-refusal';
import { getBillingProvider } from '@/lib/billing';
import { subscriptionStore } from '@/lib/billing/subscription-store';

export const dynamic = 'force-dynamic';

const HTTP_UNAUTHORIZED = 401;

/** A link for the signed-in subscriber to the provider's portal, where the payment method is changed and the plan canceled. */
export async function POST(req: NextRequest) {
  const billing = getBillingProvider();
  if (!billing) return billingUnavailable();

  return guardingStore(async () => {
    const session = await readSessionOrRefusal(req);
    if ('refused' in session) return session.refused;
    const { user } = session;
    if (!user) return codedRefusal(HTTP_UNAUTHORIZED, undefined, 'Unauthorized: sign in to manage a subscription.');

    const subscription = await subscriptionStore.findByUser(user.id);
    if (!subscription) return noSubscription();

    try {
      return NextResponse.json({ success: true, ...(await billing.provider.createPortalLink(subscription)) });
    } catch (error) {
      console.error('[billing] portal session failed:', error);
      return providerFailed();
    }
  });
}
