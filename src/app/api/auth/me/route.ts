import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getSessionFromRequest(req);

  if (!user) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized: No active session found.' },
      { status: 401 }
    );
  }

  return NextResponse.json({
    success: true,
    user,
  });
}
