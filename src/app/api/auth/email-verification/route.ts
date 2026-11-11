import { NextRequest, NextResponse } from 'next/server';
import { isEmailVerified } from '@/lib/auth/account-mail';
import { isAuthMailEnabled } from '@/lib/auth/mail-config';
import { readSessionOrRefusal } from '@/lib/auth/session-refusal';

export const dynamic = 'force-dynamic';

/** Whether email verification is on, and whether the address of the signed-in account is verified. */
export async function GET(req: NextRequest) {
  const session = await readSessionOrRefusal(req);
  if ('refused' in session) return session.refused;
  const { user } = session;
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized: No active session found.' }, { status: 401 });
  return NextResponse.json({ success: true, enabled: isAuthMailEnabled(), verified: isEmailVerified(user) });
}
