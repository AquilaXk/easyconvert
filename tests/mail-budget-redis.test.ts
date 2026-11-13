import { afterAll, describe, expect, it, vi } from 'vitest';
import { MAIL_DAILY_HARD_CAP, MAIL_DAILY_VERIFY_CAP, mailBudgetLeft, mailSentToday, reserveMailSend } from '../src/lib/auth/mail-budget';
import { redisUserStore } from '../src/lib/auth/redis-user-store';

/**
 * The mail budget against a real Redis: the atomic count that does not count a refused mail, the two caps and the lifetime of the
 * counter. Run by `npm run test:redis`; the in-memory behaviour has its own test (tests/mail-budget.test.ts).
 */

const dayKey = () => `${redisUserStore.getKeyPrefix()}mail_sent:${new Date().toISOString().slice(0, 10)}`;

// skip-ok: mode selection. The shards run without REDIS_URL; the Redis-mode CI step (npm run test:redis) sets it and runs this file.
describe.skipIf(!process.env.REDIS_URL)('the mail budget in Redis', () => {
  afterAll(async () => {
    await redisUserStore.getRedisClient()!.del(dayKey());
    vi.restoreAllMocks();
  });

  it('keeps the count with a lifetime, refuses a verification mail past its cap without counting it, and keeps the rest for resets', async () => {
    const client = redisUserStore.getRedisClient()!;
    const key = dayKey();
    await client.del(key);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await client.set(key, MAIL_DAILY_VERIFY_CAP - 1, 'EX', 100);
    expect(await mailBudgetLeft('verify')).toBe(true);
    expect(await reserveMailSend('verify')).toBe(true);
    expect(await mailBudgetLeft('verify')).toBe(false);
    expect(await reserveMailSend('verify')).toBe(false);
    expect(await mailSentToday()).toBe(MAIL_DAILY_VERIFY_CAP);
    expect(await mailBudgetLeft('reset')).toBe(true);
    expect(await reserveMailSend('reset')).toBe(true);
    expect(await mailSentToday()).toBe(MAIL_DAILY_VERIFY_CAP + 1);
    // The Lua step gives the counter a lifetime of two days.
    expect(await client.ttl(key)).toBeGreaterThan(100_000);

    await client.set(key, MAIL_DAILY_HARD_CAP, 'EX', 100);
    expect(await reserveMailSend('reset')).toBe(false);
    expect(await mailSentToday()).toBe(MAIL_DAILY_HARD_CAP);
  });

  it('counts simultaneous reservations exactly, so no more than the cap are allowed', async () => {
    const client = redisUserStore.getRedisClient()!;
    const key = dayKey();
    await client.set(key, MAIL_DAILY_VERIFY_CAP - 3, 'EX', 100);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const answers = await Promise.all(Array.from({ length: 20 }, () => reserveMailSend('verify')));
    expect(answers.filter(Boolean)).toHaveLength(3);
    expect(await mailSentToday()).toBe(MAIL_DAILY_VERIFY_CAP);
  });
});
