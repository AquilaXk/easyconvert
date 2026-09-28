import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/auth/session';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import type { ApiKeyScope } from '@/lib/api-keys/types';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getSessionFromRequest(req);
  if (!user) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized: Sign in required.' },
      { status: 401 }
    );
  }

  const keys = await redisKeyStore.listApiKeys(user.id);
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
    const allowedIps = Array.isArray(body?.allowedIps) ? body.allowedIps : undefined;
    const webhookUrl = typeof body?.webhookUrl === 'string' && body.webhookUrl.trim() ? body.webhookUrl.trim() : undefined;
    const webhookSecret = typeof body?.webhookSecret === 'string' && body.webhookSecret.trim() ? body.webhookSecret.trim() : undefined;
    const scopes = Array.isArray(body?.scopes) ? (body.scopes as ApiKeyScope[]) : undefined;
    const expiresAt = typeof body?.expiresAt === 'number' && Number.isFinite(body.expiresAt) ? body.expiresAt : undefined;

    const result = await redisKeyStore.generateApiKey(user.id, keyName, {
      allowedIps,
      webhookUrl,
      webhookSecret,
      scopes,
      expiresAt,
    });

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
