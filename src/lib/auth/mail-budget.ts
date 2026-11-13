import { redisUserStore } from './redis-user-store';

/**
 * How many mails the server sent today (UTC), against the sending limit of the mail account (about 500 a day for a Gmail
 * account). Every mail of the auth routes is counted when it is queued. At `MAIL_DAILY_WARN` one line tells the operator the
 * day is filling; past `MAIL_DAILY_HARD_CAP` a send is refused, and the route that mails a sign-up code asks
 * `mailBudgetLeft` first and answers that sending is unavailable for now, so the visitor is told and not left waiting for a
 * mail the account would drop. The cap sits below the account's limit so that the mails of a few concurrent requests, which
 * are counted after the check, still fit under it. The count lives in Redis (two days) and falls back to memory without it.
 */
export const MAIL_DAILY_WARN = 400;
export const MAIL_DAILY_HARD_CAP = 480;

const COUNTER_TTL_SECONDS = 2 * 24 * 60 * 60;

// KEYS[1]: the day's counter; ARGV[1]: seconds to live. Counts one and keeps the counter for two days.
const COUNT_LUA = `
local count = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
return count
`;

const memoryCounts = new Map<string, number>();

const dayKey = () => `${redisUserStore.getKeyPrefix()}mail_sent:${new Date().toISOString().slice(0, 10)}`;

async function readCount(key: string): Promise<number> {
  const redis = redisUserStore.getRedisClient();
  if (redis) {
    try {
      return Number((await redis.get(key)) ?? 0);
    } catch {
      // The memory count below answers when Redis cannot.
    }
  }
  return memoryCounts.get(key) ?? 0;
}

async function increment(key: string): Promise<number> {
  const redis = redisUserStore.getRedisClient();
  if (redis) {
    try {
      const count = Number(await redis.eval(COUNT_LUA, 1, key, String(COUNTER_TTL_SECONDS)));
      if (Number.isSafeInteger(count)) return count;
    } catch {
      // Fall through to the memory count: a failed counter must not stop a mail.
    }
  }
  const count = (memoryCounts.get(key) ?? 0) + 1;
  memoryCounts.set(key, count);
  return count;
}

/** The mails counted today. */
export async function mailSentToday(): Promise<number> {
  return readCount(dayKey());
}

/** Whether today's count is below the hard cap: a route that must tell the visitor reads this before it makes a code. */
export async function mailBudgetLeft(): Promise<boolean> {
  return (await mailSentToday()) < MAIL_DAILY_HARD_CAP;
}

/** Counts one mail and says whether it may be sent; false past the hard cap. Logs the warning and the cap once each. */
export async function reserveMailSend(): Promise<boolean> {
  const sent = await increment(dayKey());
  if (sent === MAIL_DAILY_WARN) console.warn(`auth_mail_budget level=warn sent=${sent} cap=${MAIL_DAILY_HARD_CAP}`);
  if (sent === MAIL_DAILY_HARD_CAP) console.error(`auth_mail_budget level=cap sent=${sent} cap=${MAIL_DAILY_HARD_CAP}`);
  return sent <= MAIL_DAILY_HARD_CAP;
}

/** Forgets the in-memory counts; for tests. */
export function resetMailBudgetMemory(): void {
  memoryCounts.clear();
}
