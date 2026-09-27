import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/auth/session';
import { keyStore } from '@/lib/api-keys/key-store';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getSessionFromRequest(req);
  if (!user) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized: Sign in required.' },
      { status: 401 }
    );
  }

  const keys = await keyStore.listApiKeys(user.id);
  return NextResponse.json({
    success: true,
    keys,
  });
}

export async function POST(req: NextRequest) {
  const user = await getSessionFromRequest(req);
  if (!user) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized: Sign in required.' },
      { status: 401 }
    );
  }

  try {
    const body = await req.json().catch(() => ({}));
    const keyName = (body && typeof body.name === 'string' && body.name.trim()) || 'Production API Key';

    const result = await keyStore.generateApiKey(user.id, keyName);

    return NextResponse.json({
      success: true,
      key: result.key,
      secretKey: result.secretKey,
      warning: 'Please copy your API key now. You will not be able to see it again.',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to generate API key';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
