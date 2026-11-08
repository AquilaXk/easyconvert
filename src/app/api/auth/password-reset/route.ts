import { NextResponse } from 'next/server';
import { isAuthMailEnabled } from '@/lib/auth/mail-config';

export const dynamic = 'force-dynamic';

/** Whether password reset is on (mail is configured); the sign-in page shows its link only when it is. */
export function GET() {
  return NextResponse.json({ success: true, enabled: isAuthMailEnabled() });
}
