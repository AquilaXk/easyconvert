import { NextRequest, NextResponse } from 'next/server';
import { verifyPassword } from '@/lib/auth/crypto';
import { userStore } from '@/lib/auth/user-store';
import { createSessionToken, createSessionCookie } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email, password } = body;

    if (!email || !password) {
      return NextResponse.json(
        { success: false, error: 'Email and password are required.' },
        { status: 400 }
      );
    }

    const userRecord = await userStore.findByEmail(email);
    if (!userRecord || !userRecord.passwordHash || !userRecord.salt) {
      return NextResponse.json(
        { success: false, error: 'Invalid email address or password.' },
        { status: 401 }
      );
    }

    const isValid = await verifyPassword(password, userRecord.passwordHash, userRecord.salt);
    if (!isValid) {
      return NextResponse.json(
        { success: false, error: 'Invalid email address or password.' },
        { status: 401 }
      );
    }

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
    const message = err instanceof Error ? err.message : 'Login failed';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
