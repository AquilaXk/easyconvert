import { NextRequest, NextResponse } from 'next/server';
import { alreadySubscribed, billingUnavailable, guardingStore, invalidProduct, providerFailed } from '@/lib/api/billing-refusal';
import { readJsonObject } from '@/lib/api/json-body';
import { codedRefusal } from '@/lib/api/problem-details';
import { readSessionOrRefusal } from '@/lib/auth/session-refusal';
import { getBillingProvider } from '@/lib/billing';
import { isPackageSize, isSubscriptionSize, type Product } from '@/lib/billing/credits';
import { entitlementOf } from '@/lib/billing/entitlement';
import { subscriptionStore } from '@/lib/billing/subscription-store';

export const dynamic = 'force-dynamic';

const HTTP_UNAUTHORIZED = 401;

/** The product a request body names (`{ kind, credits }`), or undefined when it is not a package or subscription size that is sold. */
function productOf(body: Record<string, unknown> | null): Product | undefined {
  if (body?.kind === 'package' && isPackageSize(body.credits)) return { kind: 'package', credits: body.credits };
  if (body?.kind === 'subscription' && isSubscriptionSize(body.credits)) return { kind: 'subscription', credits: body.credits };
  return undefined;
}

/**
 * What the browser needs to open the checkout of a package or a subscription for the signed-in account: the price, the customer's
 * address and the account id signed by this server, which the webhook trusts to tell whose purchase it is. A package can be bought at
 * any time, also with a subscription. An account that already has a subscription is moved to the size it asks for at once (the credits
 * left in the period it leaves are dropped, and the answer has `changed: true`) instead of buying a second subscription.
 */
export async function POST(req: NextRequest) {
  const billing = getBillingProvider();
  if (!billing) return billingUnavailable();

  return guardingStore(async () => {
    const session = await readSessionOrRefusal(req);
    if ('refused' in session) return session.refused;
    const { user } = session;
    if (!user) return codedRefusal(HTTP_UNAUTHORIZED, undefined, 'Unauthorized: sign in to buy credits.');

    const product = productOf(await readJsonObject(req));
    if (!product) return invalidProduct();

    if (product.kind === 'subscription') {
      const existing = await subscriptionStore.findByUser(user.id);
      if (existing && entitlementOf(existing, Date.now()).tier !== 'free') {
        if (existing.credits === product.credits) return alreadySubscribed();
        try {
          await billing.provider.changeSubscription(existing, product.credits);
        } catch (error) {
          console.error('[billing] subscription change failed:', error);
          return providerFailed();
        }
        return NextResponse.json({ success: true, changed: true });
      }
    }

    return NextResponse.json({ success: true, checkout: billing.provider.createCheckout({ userId: user.id, email: user.email, product }) });
  });
}
