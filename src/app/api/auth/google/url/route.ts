import { NextRequest, NextResponse } from 'next/server';
import { getGoogleOAuthUrl } from '@/lib/auth/oauth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const host = req.headers.get('host') || 'localhost:3000';
  const proto = req.headers.get('x-forwarded-proto') || 'http';
  const redirectUri = `${proto}://${host}/api/auth/google/callback`;

  try {
    const url = getGoogleOAuthUrl(redirectUri);
    return NextResponse.json({
      success: true,
      url,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to generate OAuth URL';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
