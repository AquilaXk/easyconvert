import { redisUserStore } from './redis-user-store';

/**
 * How many mails the server sent today (UTC), against the sending limit of the mail account (about 500 a day for a free
 * consumer account). Every mail of the auth routes is counted when it is queued, in one counter for the day.
 *
 * The day's mails are not all alike. A verification mail (a sign-up, a resend) can be asked for by anyone, so a flood of them
 * must not use up what a password reset needs: verification mails stop at `MAIL_DAILY_VERIFY_CAP` and the rest of the day, up
 * to `MAIL_DAILY_HARD_CAP`, is kept for reset mails. A refused mail is not counted, so a flood cannot eat the reserved share.
 * At `MAIL_DAILY_WARN` one line tells the operator the day is filling, and each cap logs one line when it is reached. The
 * routes that make a verification mail ask `mailBudgetLeft` first and answer that sending is unavailable for now, so the
 * visitor is told and not left waiting for a mail the account would drop. The hard cap sits under the account's limit so that
 * the mails of a few concurrent requests, which are counted after the check, still fit. The count lives in Redis (two days) and
 * falls back to memory without it.
 */
export type MailBudgetKind = 'verify' | 'reset';

export const MAIL_DAILY_WARN = 350;
export const MAIL_DAILY_VERIFY_CAP = 400;
export const MAIL_DAILY_HARD_CAP = 480;

const CAPS: Readonly<Record<MailBudgetKind, number>> = { verify: MAIL_DAILY_VERIFY_CAP, reset: MAIL_DAILY_HARD_CAP };
const COUNTER_TTL_SECONDS = 2 * 24 * 60 * 60;

// KEYS[1]: the day's counter; ARGV[1]: seconds to live, ARGV[2]: the cap of the mail's kind. Counts one mail unless the day is at
// the cap already (then -1, and the count stays), and keeps the counter for two days.
const COUNT_LUA = `
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
if count >= tonumber(ARGV[2]) then return -1 end
count = redis.call('INCR', KEYS[1])
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

/** The count after this mail, or -1 when the day is at the cap of its kind. */
async function increment(key: string, cap: number): Promise<number> {
  const redis = redisUserStore.getRedisClient();
  if (redis) {
    try {
      const count = Number(await redis.eval(COUNT_LUA, 1, key, String(COUNTER_TTL_SECONDS), String(cap)));
      if (Number.isSafeInteger(count)) return count;
    } catch {
      // Fall through to the memory count: a failed counter must not stop a mail.
    }
  }
  const current = memoryCounts.get(key) ?? 0;
  if (current >= cap) return -1;
  memoryCounts.set(key, current + 1);
  return current + 1;
}

/** The mails counted today. */
export async function mailSentToday(): Promise<number> {
  return readCount(dayKey());
}

/** Whether today's count is below the cap of the kind: a route that must tell the visitor reads this before it makes a mail. */
export async function mailBudgetLeft(kind: MailBudgetKind): Promise<boolean> {
  return (await mailSentToday()) < CAPS[kind];
}

/** Counts one mail and says whether it may be sent; false when the day is at the cap of its kind. Logs the warning and each cap once. */
export async function reserveMailSend(kind: MailBudgetKind): Promise<boolean> {
  const sent = await increment(dayKey(), CAPS[kind]);
  if (sent === -1) return false;
  if (sent === MAIL_DAILY_WARN) console.warn(`auth_mail_budget level=warn sent=${sent} cap=${MAIL_DAILY_VERIFY_CAP}`);
  if (sent === CAPS[kind]) console.error(`auth_mail_budget level=cap kind=${kind} sent=${sent} cap=${CAPS[kind]}`);
  return true;
}

/** Forgets the in-memory counts; for tests. */
export function resetMailBudgetMemory(): void {
  memoryCounts.clear();
}
