import { NextRequest, NextResponse } from 'next/server';
import { alreadySubscribed, billingUnavailable, guardingStore, invalidPlan } from '@/lib/api/billing-refusal';
import { readJsonObject } from '@/lib/api/json-body';
import { codedRefusal } from '@/lib/api/problem-details';
import { readSessionOrRefusal } from '@/lib/auth/session-refusal';
import { getBillingProvider } from '@/lib/billing';
import { entitlementOf } from '@/lib/billing/entitlement';
import { subscriptionStore } from '@/lib/billing/subscription-store';
import { isPaidPlan } from '@/lib/billing/types';

export const dynamic = 'force-dynamic';

const HTTP_UNAUTHORIZED = 401;

/**
 * What the browser needs to open the checkout of `plan` for the signed-in account: the price, the customer's address and the
 * account id signed by this server, which the webhook trusts to tell whose purchase it is. An account that already has a plan
 * is sent to the billing portal instead of buying a second subscription.
 */
export async function POST(req: NextRequest) {
  const billing = getBillingProvider();
  if (!billing) return billingUnavailable();

  return guardingStore(async () => {
    const session = await readSessionOrRefusal(req);
    if ('refused' in session) return session.refused;
    const { user } = session;
    if (!user) return codedRefusal(HTTP_UNAUTHORIZED, undefined, 'Unauthorized: sign in to subscribe.');

    const plan = (await readJsonObject(req))?.plan;
    if (!isPaidPlan(plan)) return invalidPlan();

    const existing = await subscriptionStore.findByUser(user.id);
    if (existing && entitlementOf(existing, Date.now()).tier !== 'free') return alreadySubscribed();

    return NextResponse.json({ success: true, checkout: billing.provider.createCheckout({ userId: user.id, email: user.email, plan }) });
  });
}
