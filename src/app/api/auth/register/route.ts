import { NextRequest, NextResponse } from 'next/server';
import { hashPassword } from '@/lib/auth/crypto';
import { redisUserStore } from '@/lib/auth/redis-user-store';
import { createSessionToken, createSessionCookie } from '@/lib/auth/session';
import type { AuthErrorCode } from '@/lib/refusal-codes';

export const dynamic = 'force-dynamic';

/** A refusal for API callers (the English `error`) and for the sign-up page, which words its `code` in the page's language. */
function refusal(status: number, code: AuthErrorCode, error: string): NextResponse {
  return NextResponse.json({ success: false, code, error }, { status });
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return refusal(400, 'invalid_json', 'Invalid JSON request payload.');
  }

  try {
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';

    if (!email?.includes('@')) {
      return refusal(400, 'invalid_email', 'A valid email address is required.');
    }

    if (!password || password.length < 8 || password.length > 1024) {
      return refusal(400, 'password_length', 'Password must be between 8 and 1024 characters in length.');
    }

    const displayName = name || email.split('@')[0];

    const existingUser = await redisUserStore.findByEmail(email);
    if (existingUser) {
      return refusal(409, 'account_exists', 'An account with this email address already exists.');
    }

    const { hash, salt } = await hashPassword(password);
    const userRecord = await redisUserStore.createUser({
      email,
      name: displayName,
      tier: 'free',
      provider: 'email',
      passwordHash: hash,
      salt,
    });

    const user = redisUserStore.sanitizeUser(userRecord);
    const token = createSessionToken(user);
    const cookieHeader = createSessionCookie(token);

    const response = NextResponse.json({
      success: true,
      user,
      token,
    });

    response.headers.set('Set-Cookie', cookieHeader);
    return response;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Registration failed';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
