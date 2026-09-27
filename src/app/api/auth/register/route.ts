import { NextRequest, NextResponse } from 'next/server';
import { hashPassword } from '@/lib/auth/crypto';
import { userStore } from '@/lib/auth/user-store';
import { createSessionToken, createSessionCookie } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email, password, name } = body;

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return NextResponse.json(
        { success: false, error: 'A valid email address is required.' },
        { status: 400 }
      );
    }

    if (!password || typeof password !== 'string' || password.length < 8) {
      return NextResponse.json(
        { success: false, error: 'Password must be at least 8 characters in length.' },
        { status: 400 }
      );
    }

    const displayName = (name && typeof name === 'string' && name.trim()) || email.split('@')[0];

    const existingUser = await userStore.findByEmail(email);
    if (existingUser) {
      return NextResponse.json(
        { success: false, error: 'An account with this email address already exists.' },
        { status: 409 }
      );
    }

    const { hash, salt } = await hashPassword(password);
    const userRecord = await userStore.createUser({
      email,
      name: displayName,
      tier: 'free',
      provider: 'email',
      passwordHash: hash,
      salt,
    });

    const user = userStore.sanitizeUser(userRecord);
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
