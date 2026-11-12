import { NextRequest, NextResponse } from 'next/server';
import { guardingStore } from '@/lib/api/billing-refusal';
import { readSessionOrRefusal } from '@/lib/auth/session-refusal';
import { getBillingProvider } from '@/lib/billing';
import { entitlementOf } from '@/lib/billing/entitlement';
import { subscriptionStore } from '@/lib/billing/subscription-store';
import { PAID_PLANS } from '@/lib/billing/types';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

/**
 * Whether paid plans are on sale, for the pricing page and the dashboard. Without a full billing configuration the answer is
 * `{ enabled: false }` and nothing else. With one it names what Paddle.js needs to open a checkout (the client token is public
 * by design, and so are the price ids), and for a signed-in account its subscription.
 */
export async function GET(req: NextRequest) {
  const billing = getBillingProvider();
  if (!billing) return NextResponse.json({ success: true, enabled: false }, { headers: NO_STORE });
  const { config } = billing;
  const plans = PAID_PLANS.map((plan) => ({ plan, priceId: config.priceIds[plan] }));

  return guardingStore(async () => {
    const session = await readSessionOrRefusal(req);
    if ('refused' in session) return session.refused;
    const record = session.user ? await subscriptionStore.findByUser(session.user.id) : null;
    const subscription = record
      ? {
          plan: record.plan,
          status: record.status,
          ...(record.currentPeriodEnd === undefined ? {} : { currentPeriodEnd: record.currentPeriodEnd }),
          ...(record.cancelAt === undefined ? {} : { cancelAt: record.cancelAt }),
          active: entitlementOf(record, Date.now()).tier !== 'free',
        }
      : null;
    return NextResponse.json(
      { success: true, enabled: true, environment: config.environment, clientToken: config.clientToken, plans, subscription },
      { headers: NO_STORE }
    );
  });
}
