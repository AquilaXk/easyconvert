import { NextRequest } from 'next/server';
import { expect, vi } from 'vitest';
import { OPAQUE_RESPONSE_MS } from '../../src/lib/auth/opaque-response';
import { hashPassword } from '../../src/lib/auth/crypto';
import { redisUserStore } from '../../src/lib/auth/redis-user-store';
import { TERMS_VERSION } from '../../src/lib/legal/documents';

/** The values the mail features read; fake in every part, none of them reaches a network. */
export const FAKE_SMTP = {
  SMTP_HOST: 'smtp.fixture.test',
  SMTP_USER: 'sender.account@fixture.test',
  SMTP_PASSWORD: 'fixture-app-password-Zq7',
  APP_ORIGIN: 'https://convert.fixture.test',
  KEY_HASH_PEPPER: 'fixture-pepper-0123456789abcdef0123456789abcdef',
  TRUSTED_PROXIES: '10.0.0.0/8',
} as const;

export function stubMailConfig(): void {
  for (const [name, value] of Object.entries(FAKE_SMTP)) vi.stubEnv(name, value);
}

export function stubNoMailConfig(): void {
  for (const name of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_PORT', 'MAIL_FROM', 'APP_ORIGIN', 'NEXT_PUBLIC_APP_URL', 'APP_URL']) {
    vi.stubEnv(name, '');
  }
  vi.stubEnv('TRUSTED_PROXIES', FAKE_SMTP.TRUSTED_PROXIES);
}

let nextClient = 1;
/** A client address no other request of the run used, so the per-client limits of one test do not reach another. */
export function freshClientIp(): string {
  nextClient++;
  return `198.51.${Math.floor(nextClient / 250)}.${nextClient % 250}`;
}

export function jsonPost(path: string, body: unknown, options: { ip?: string; cookie?: string; headers?: Record<string, string> } = {}): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': options.ip ?? freshClientIp(),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...options.headers,
    },
    body: JSON.stringify(body),
  });
}

export const GOOD_PASSWORD = 'correct horse battery staple';

export async function passwordAccount(label: string, extra: { emailVerified?: boolean } = {}) {
  const { hash, salt } = await hashPassword(GOOD_PASSWORD);
  return redisUserStore.createUser({
    email: `${label}@fixture.test`,
    name: label,
    provider: 'email',
    passwordHash: hash,
    salt,
    acceptedTermsVersion: TERMS_VERSION,
    ...extra,
  });
}

export function googleAccount(label: string) {
  return redisUserStore.createUser({ email: `${label}@fixture.test`, name: label, provider: 'google', emailVerified: true, acceptedTermsVersion: TERMS_VERSION });
}

/** The token a mail's link carries: the fragment after `#token=`. */
export function tokenOfMail(text: string): string {
  const match = /#token=([A-Za-z0-9_-]{43})/.exec(text);
  if (!match) throw new Error('the mail carries no token');
  return match[1];
}

/**
 * Runs the requests together on a virtual clock and checks that every one of them answers at the floor of an opaque answer
 * and not before or after it, whichever way the work behind it went. The clock is virtual, so the check is exact and does not
 * depend on how busy the machine is.
 */
export async function answersAtTheOpaqueFloor(requests: ReadonlyArray<() => Promise<Response>>): Promise<Response[]> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  try {
    const answeredAt: Array<number | null> = requests.map(() => null);
    const clock = () => performance.now();
    const started = clock();
    const pending = requests.map((start, index) =>
      start().then((response) => {
        answeredAt[index] = clock() - started;
        return response;
      })
    );
    await vi.advanceTimersByTimeAsync(OPAQUE_RESPONSE_MS - 1);
    expect(answeredAt).toEqual(requests.map(() => null));
    await vi.advanceTimersByTimeAsync(1);
    const responses = await Promise.all(pending);
    expect(answeredAt).toEqual(requests.map(() => OPAQUE_RESPONSE_MS));
    return responses;
  } finally {
    vi.useRealTimers();
  }
}
