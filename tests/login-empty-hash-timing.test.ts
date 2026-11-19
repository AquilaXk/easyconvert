import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../src/lib/auth/crypto', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/auth/crypto')>();
  return { ...original, verifyPassword: vi.fn(original.verifyPassword) };
});

import { POST as loginHandler } from '../src/app/api/auth/login/route';
import { verifyPassword } from '../src/lib/auth/crypto';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { resetLoginRateLimiterStore } from '../src/lib/auth/login-rate-limiter';

/**
 * `verifyPassword` answers false at once for an empty hash or salt, without the key derivation that every other answer costs. An
 * account whose password hash was emptied (a Google sign-in took over the account, entry 285) would so answer faster than an
 * unknown address or a wrong password, which tells an attacker the address has an account. The sign-in verifies the dummy
 * hash and salt for such an account, as for an unknown address.
 */
const verifyMock = vi.mocked(verifyPassword);

function login(email: string): Promise<Response> {
  return loginHandler(
    new NextRequest('http://localhost:3000/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'Some-Password-1' }),
    })
  );
}

afterEach(() => {
  verifyMock.mockClear();
  resetLoginRateLimiterStore();
});

describe('sign-in against an account without a password hash', () => {
  it.each([
    ['an empty hash', { passwordHash: '', salt: 'a'.repeat(32) }],
    ['an empty salt', { passwordHash: 'b'.repeat(128), salt: '' }],
    ['neither', { passwordHash: '', salt: '' }],
  ])('derives a key for %s, as it does for an unknown address', async (_name, credentials) => {
    const email = `google_only_${Math.random().toString(36).slice(2)}@timing.test`;
    await redisUserStore.createUser({ email, name: 'Google Only', tier: 'free', ...credentials });
    const response = await login(email);
    expect(response.status).toBe(401);
    const [, hash, salt] = verifyMock.mock.calls.at(-1) ?? [];
    expect(hash).toBeTruthy();
    expect(salt).toBeTruthy();
  });
});
