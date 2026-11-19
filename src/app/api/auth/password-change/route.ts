import { NextRequest, NextResponse } from 'next/server';
import { authStoreUnavailableRefusal, codedRefusal, serverFault } from '@/lib/api/problem-details';
import { readJsonObject } from '@/lib/api/json-body';
import { isPasswordAccount } from '@/lib/auth/account-mail';
import { hashPassword, iterationsOf, verifyPassword } from '@/lib/auth/crypto';
import {
  authRateLimitRefusal,
  checkLoginRateLimit,
  recordFailedLogin,
  resetLoginAttempts,
  resolveAuthClientIp,
} from '@/lib/auth/login-rate-limiter';
import { redisUserStore } from '@/lib/auth/redis-user-store';
import { createSessionCookie, createSessionToken, revokeAllUserSessions } from '@/lib/auth/session';
import { readSessionOrRefusal } from '@/lib/auth/session-refusal';
import { AuthStoreUnavailableError } from '@/lib/auth/store-unavailable';
import type { AuthErrorCode } from '@/lib/refusal-codes';

export const dynamic = 'force-dynamic';

const refusal = codedRefusal<AuthErrorCode>;
const DUMMY_HASH = '0'.repeat(128);
const DUMMY_SALT = '0'.repeat(32);
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 1024;

/**
 * Changes the password of the signed-in account after verifying its current password, revokes every earlier session
 * of the account (`sessionVersion`), and issues a fresh session cookie for this browser.
 */
export async function POST(req: NextRequest) {
  const session = await readSessionOrRefusal(req);
  if ('refused' in session) return session.refused;
  if (!session.user) {
    return codedRefusal(401, undefined, 'Unauthorized: sign in to change your password.');
  }

  const body = await readJsonObject(req);
  if (!body) return refusal(400, 'invalid_json', 'Invalid JSON request payload.');

  const resolvedIp = resolveAuthClientIp(req);
  if ('refused' in resolvedIp) return resolvedIp.refused;
  const { clientIp } = resolvedIp;

  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
  if (!currentPassword || !newPassword) {
    return refusal(400, 'missing_fields', 'Current password and new password are required.');
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH || newPassword.length > MAX_PASSWORD_LENGTH) {
    return refusal(400, 'password_length', 'Password must be between 8 and 1024 characters in length.');
  }

  try {
    const record = await redisUserStore.findById(session.user.id);
    if (!record || !isPasswordAccount(record) || !record.passwordHash || !record.salt) {
      await verifyPassword('not-a-password-account', DUMMY_HASH, DUMMY_SALT);
      return refusal(400, 'invalid_credentials', 'Password sign-in is not configured for this account.');
    }

    const rateLimit = await checkLoginRateLimit(clientIp, record.email);
    if (!rateLimit.allowed) {
      return authRateLimitRefusal(
        rateLimit.retryAfterSeconds,
        `Too many failed password attempts. Please try again in ${rateLimit.retryAfterSeconds} seconds.`
      );
    }

    if (currentPassword.length > MAX_PASSWORD_LENGTH) {
      await verifyPassword('invalid-length', DUMMY_HASH, DUMMY_SALT);
      await recordFailedLogin(clientIp, record.email);
      return refusal(401, 'invalid_credentials', 'Current password is incorrect.');
    }

    const validCurrent = await verifyPassword(currentPassword, record.passwordHash, record.salt, iterationsOf(record));
    if (!validCurrent) {
      await recordFailedLogin(clientIp, record.email);
      return refusal(401, 'invalid_credentials', 'Current password is incorrect.');
    }

    const { hash, salt, iterations } = await hashPassword(newPassword);
    if (!(await redisUserStore.updateUser(record.id, { passwordHash: hash, salt, passwordIterations: iterations }))) {
      return codedRefusal(404, undefined, 'Account not found.');
    }
    await revokeAllUserSessions(record.id);
    await resetLoginAttempts(record.email);

    const updated = await redisUserStore.findById(record.id);
    const response = NextResponse.json({ success: true });
    if (updated) {
      const token = createSessionToken(redisUserStore.sanitizeUser(updated));
      response.headers.set('Set-Cookie', createSessionCookie(token));
    }
    return response;
  } catch (err: unknown) {
    if (err instanceof AuthStoreUnavailableError) return authStoreUnavailableRefusal(err);
    return serverFault('auth/password-change', err, 'Password change failed on the server.');
  }
}
