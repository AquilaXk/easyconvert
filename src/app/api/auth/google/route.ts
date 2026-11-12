import { NextResponse } from 'next/server';
import { isGoogleSignInEnabled } from '@/lib/auth/oauth';

export const dynamic = 'force-dynamic';

/** Whether Google sign-in is on (a client id is configured); the sign-in page shows its button only when it is. */
export function GET() {
  return NextResponse.json({ success: true, enabled: isGoogleSignInEnabled() });
}
