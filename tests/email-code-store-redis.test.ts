import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EMAIL_CODE_MAX_ATTEMPTS, EMAIL_CODE_TTL_SECONDS, issueEmailCode, verifyEmailCode } from '../src/lib/auth/email-code-store';
import { MAIL_DAILY_HARD_CAP, mailBudgetLeft, mailSentToday, reserveMailSend } from '../src/lib/auth/mail-budget';
import { redisUserStore } from '../src/lib/auth/redis-user-store';

/**
 * The sign-up code and the mail budget against a real Redis: the atomic guess counting, the lifetime and what is stored. Run by
 * `npm run test:redis`; the in-memory behaviour has its own tests (tests/email-code-store.test.ts, tests/mail-budget.test.ts).
 */

const keysMade: string[] = [];

function address(): string {
  return `code_${crypto.randomUUID()}@redis.test`;
}

const wrong = (code: string) => (code === '000000' ? '000001' : '000000');

// skip-ok: mode selection. The shards run without REDIS_URL; the Redis-mode CI step (npm run test:redis) sets it and runs this file.
describe.skipIf(!process.env.REDIS_URL)('email codes and the mail budget in Redis', () => {
  beforeAll(() => {
    vi.stubEnv('KEY_HASH_PEPPER', 'redis-fixture-pepper-0123456789abcdef0123456789abcdef');
  });

  afterAll(async () => {
    const client = redisUserStore.getRedisClient()!;
    if (keysMade.length > 0) await client.del(...keysMade);
    vi.unstubAllEnvs();
  });

  async function codeKeyOf(email: string, purpose = 'signup'): Promise<string> {
    const client = redisUserStore.getRedisClient()!;
    const [key] = await client.keys(`${redisUserStore.getKeyPrefix()}email_code:${purpose}:*`).then((keys) =>
      keys.filter((candidate) => candidate.endsWith(crypto.createHash('sha256').update(email).digest('hex')))
    );
    keysMade.push(key);
    return key;
  }

  it(`keeps the code ${EMAIL_CODE_TTL_SECONDS} seconds, as a hash and never in the clear`, async () => {
    const email = address();
    const code = await issueEmailCode('signup', email);
    const client = redisUserStore.getRedisClient()!;
    const key = await codeKeyOf(email);
    const stored = await client.hgetall(key);
    expect(stored.h).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(code);
    expect(stored.a).toBe('0');
    const ttl = await client.ttl(key);
    expect(ttl).toBeGreaterThan(EMAIL_CODE_TTL_SECONDS - 5);
    expect(ttl).toBeLessThanOrEqual(EMAIL_CODE_TTL_SECONDS);
    // Under the pepper: the code alone does not hash to the stored value.
    expect(stored.h).not.toBe(crypto.createHash('sha256').update(`easyconvert:email-code:v1:signup:${email}:${code}`).digest('hex'));
  });

  it('lets exactly one of the simultaneous uses of the right code through (each one is a guess, so no more than the allowed few)', async () => {
    const email = address();
    const code = await issueEmailCode('signup', email);
    const answers = await Promise.all(Array.from({ length: EMAIL_CODE_MAX_ATTEMPTS }, () => verifyEmailCode('signup', email, code)));
    expect(answers.filter(Boolean)).toHaveLength(1);
    expect(await verifyEmailCode('signup', email, code)).toBe(false);
  });

  it(`counts simultaneous wrong guesses, so the code is burned after ${EMAIL_CODE_MAX_ATTEMPTS} of them`, async () => {
    const email = address();
    const code = await issueEmailCode('signup', email);
    const guesses = await Promise.all(Array.from({ length: 30 }, () => verifyEmailCode('signup', email, wrong(code))));
    expect(guesses.some(Boolean)).toBe(false);
    expect(await verifyEmailCode('signup', email, code)).toBe(false);
    expect(await redisUserStore.getRedisClient()!.exists(await codeKeyOf(email))).toBe(0);
  });

  it('replaces the live code of an address when a new one is issued', async () => {
    const email = address();
    const first = await issueEmailCode('signup', email);
    let second = await issueEmailCode('signup', email);
    while (second === first) second = await issueEmailCode('signup', email);
    expect(await verifyEmailCode('signup', email, first)).toBe(false);
    expect(await verifyEmailCode('signup', email, second)).toBe(true);
  });

  it('keeps today\'s mail count in Redis with a lifetime, and refuses past the cap', async () => {
    const client = redisUserStore.getRedisClient()!;
    const key = `${redisUserStore.getKeyPrefix()}mail_sent:${new Date().toISOString().slice(0, 10)}`;
    await client.del(key);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await client.set(key, MAIL_DAILY_HARD_CAP - 1, 'EX', 100);
    expect(await mailBudgetLeft()).toBe(true);
    expect(await reserveMailSend()).toBe(true);
    expect(await mailBudgetLeft()).toBe(false);
    expect(await reserveMailSend()).toBe(false);
    expect(await mailSentToday()).toBe(MAIL_DAILY_HARD_CAP + 1);
    expect(await client.ttl(key)).toBeGreaterThan(100_000);
    await client.del(key);
    vi.restoreAllMocks();
  });
});
