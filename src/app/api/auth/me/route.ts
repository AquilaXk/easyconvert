import { NextRequest, NextResponse } from 'next/server';
import { readSessionOrRefusal } from '@/lib/auth/session-refusal';
import { isBillingConfigured } from '@/lib/billing/config';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await readSessionOrRefusal(req);
  if ('refused' in session) return session.refused;
  const { user } = session;
  // The page words a file over its plan's limit with the next plan that can be bought, and it is prerendered, so the server says here.
  const paidPlansOnSale = isBillingConfigured();

  if (!user) {
    // A visitor without a session is an expected state, not an error: answering 200 keeps the browser console clean.
    return NextResponse.json({ success: false, authenticated: false, user: null, paidPlansOnSale });
  }

  return NextResponse.json({
    success: true,
    authenticated: true,
    user,
    paidPlansOnSale,
  });
}
