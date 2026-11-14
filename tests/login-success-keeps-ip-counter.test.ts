import { beforeEach, describe, expect, it } from 'vitest';
import {
  LOGIN_MAX_FAILED_ATTEMPTS_PER_EMAIL,
  LOGIN_MAX_FAILED_ATTEMPTS_PER_IP,
  checkLoginRateLimit,
  recordFailedLogin,
  resetLoginAttempts,
  resetLoginRateLimiterStore,
} from '../src/lib/auth/login-rate-limiter';

const SHARED_IP = '198.51.100.20';

/** Failures from one address against accounts that are not the caller's own. */
async function failAgainstOthers(count: number): Promise<void> {
  for (let i = 0; i < count; i++) await recordFailedLogin(SHARED_IP, `other${i}@example.com`);
}

describe('a successful sign-in resets only the counter of the signed-in email', () => {
  beforeEach(() => {
    resetLoginRateLimiterStore();
  });

  it('keeps the per-address counter, so one own account cannot clear guessing against others', async () => {
    await failAgainstOthers(LOGIN_MAX_FAILED_ATTEMPTS_PER_IP - 1);
    await resetLoginAttempts('mine@example.com');
    await failAgainstOthers(1);
    const result = await checkLoginRateLimit(SHARED_IP, 'fresh@example.com');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('ip');
  });

  it('clears the per-email counter of the signed-in account', async () => {
    for (let i = 0; i < LOGIN_MAX_FAILED_ATTEMPTS_PER_EMAIL - 1; i++) await recordFailedLogin(SHARED_IP, 'mine@example.com');
    await resetLoginAttempts('mine@example.com');
    await recordFailedLogin(SHARED_IP, 'mine@example.com');
    expect((await checkLoginRateLimit(SHARED_IP, 'mine@example.com')).allowed).toBe(true);
  });
});
