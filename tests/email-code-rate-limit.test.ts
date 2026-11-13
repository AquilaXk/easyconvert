import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMAIL_CODE_MAX_PER_ADDRESS_AND_IP,
  MAIL_LINK_MAX_PER_SUBJECT,
  consumeEmailCodeRateLimit,
  resetLoginRateLimiterStore,
} from '../src/lib/auth/login-rate-limiter';

const EMAIL = 'new.person@fixture.test';

beforeEach(() => {
  resetLoginRateLimiterStore();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-13T10:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the limit on mailed codes', () => {
  it(`lets one client have ${EMAIL_CODE_MAX_PER_ADDRESS_AND_IP} codes sent to one address in a minute, and refuses the next with the wait`, async () => {
    for (let sent = 0; sent < EMAIL_CODE_MAX_PER_ADDRESS_AND_IP; sent++) {
      expect((await consumeEmailCodeRateLimit('203.0.113.7', EMAIL)).allowed).toBe(true);
    }
    const refused = await consumeEmailCodeRateLimit('203.0.113.7', EMAIL);
    expect(refused).toMatchObject({ allowed: false, reason: 'ip' });
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(60);

    vi.setSystemTime(new Date('2026-11-13T10:01:01Z'));
    expect((await consumeEmailCodeRateLimit('203.0.113.7', EMAIL)).allowed).toBe(true);
  });

  it('counts the pair, so the same client can ask for another address and another client for this one', async () => {
    for (let sent = 0; sent < EMAIL_CODE_MAX_PER_ADDRESS_AND_IP; sent++) await consumeEmailCodeRateLimit('203.0.113.7', EMAIL);
    expect((await consumeEmailCodeRateLimit('203.0.113.7', 'someone.else@fixture.test')).allowed).toBe(true);
    expect((await consumeEmailCodeRateLimit('203.0.113.8', EMAIL)).allowed).toBe(true);
  });

  it(`stops ${MAIL_LINK_MAX_PER_SUBJECT} codes to one address in ten minutes whatever the clients, and reads the address without regard to case`, async () => {
    for (let client = 0; client < MAIL_LINK_MAX_PER_SUBJECT; client++) {
      expect((await consumeEmailCodeRateLimit(`203.0.113.${client + 10}`, client % 2 ? EMAIL.toUpperCase() : EMAIL)).allowed).toBe(true);
    }
    const refused = await consumeEmailCodeRateLimit('203.0.113.99', EMAIL);
    expect(refused).toMatchObject({ allowed: false, reason: 'email' });
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(600);

    vi.setSystemTime(new Date('2026-11-13T10:10:01Z'));
    expect((await consumeEmailCodeRateLimit('203.0.113.99', EMAIL)).allowed).toBe(true);
  });

  it('counts an unattributed client against the address alone', async () => {
    for (let sent = 0; sent < MAIL_LINK_MAX_PER_SUBJECT; sent++) expect((await consumeEmailCodeRateLimit(null, EMAIL)).allowed).toBe(true);
    expect(await consumeEmailCodeRateLimit(null, EMAIL)).toMatchObject({ allowed: false, reason: 'email' });
  });
});
