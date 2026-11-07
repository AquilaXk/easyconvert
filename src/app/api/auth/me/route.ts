import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getSessionFromRequest(req);

  if (!user) {
    // A visitor without a session is an expected state, not an error: answering 200 keeps the browser console clean.
    return NextResponse.json({ success: false, authenticated: false, user: null });
  }

  return NextResponse.json({
    success: true,
    authenticated: true,
    user,
  });
}
