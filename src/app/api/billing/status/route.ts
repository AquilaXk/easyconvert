import { NextRequest, NextResponse } from 'next/server';
import { guardingStore } from '@/lib/api/billing-refusal';
import { readSessionOrRefusal } from '@/lib/auth/session-refusal';
import { readPublicBillingConfig } from '@/lib/billing/config';
import { entitlementOf } from '@/lib/billing/entitlement';
import { subscriptionStore } from '@/lib/billing/subscription-store';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

/**
 * Whether paid plans are on sale, for the pricing page and the dashboard. Without a full billing configuration the answer is
 * `{ enabled: false }` and nothing else. With one it names what Paddle.js needs to open a checkout (the client token is public
 * by design, and so are the price ids), and for a signed-in account its subscription.
 */
export async function GET(req: NextRequest) {
  const publicConfig = readPublicBillingConfig();
  if (!publicConfig) return NextResponse.json({ success: true, enabled: false }, { headers: NO_STORE });

  return guardingStore(async () => {
    const session = await readSessionOrRefusal(req);
    if ('refused' in session) return session.refused;
    const record = session.user ? await subscriptionStore.findByUser(session.user.id) : null;
    const subscription = record
      ? {
          credits: record.credits,
          status: record.status,
          ...(record.currentPeriodEnd === undefined ? {} : { currentPeriodEnd: record.currentPeriodEnd }),
          ...(record.cancelAt === undefined ? {} : { cancelAt: record.cancelAt }),
          active: entitlementOf(record, Date.now()).tier === 'paid',
        }
      : null;
    return NextResponse.json(
      { success: true, enabled: true, ...publicConfig, subscription },
      { headers: NO_STORE }
    );
  });
}
