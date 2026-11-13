import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAIL_DAILY_HARD_CAP,
  MAIL_DAILY_VERIFY_CAP,
  MAIL_DAILY_WARN,
  mailBudgetLeft,
  mailSentToday,
  reserveMailSend,
  resetMailBudgetMemory,
  type MailBudgetKind,
} from '../src/lib/auth/mail-budget';

/** The count of mails sent in a day against the limit of the mail account, the share kept for resets, and the lines an operator reads. */

async function reserve(kind: MailBudgetKind, times: number): Promise<boolean[]> {
  const answers: boolean[] = [];
  for (let index = 0; index < times; index++) answers.push(await reserveMailSend(kind));
  return answers;
}

beforeEach(() => {
  resetMailBudgetMemory();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the daily mail budget', () => {
  it('counts every reserved send, and has room for both kinds until their caps', async () => {
    expect(await mailBudgetLeft('verify')).toBe(true);
    await reserve('verify', 2);
    await reserve('reset', 1);
    expect(await mailSentToday()).toBe(3);
    expect(await mailBudgetLeft('verify')).toBe(true);
    expect(await mailBudgetLeft('reset')).toBe(true);
  });

  it(`logs once when the day reaches ${MAIL_DAILY_WARN} sends, and keeps sending`, async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const answers = await reserve('verify', MAIL_DAILY_WARN + 5);
    expect(answers.every(Boolean)).toBe(true);
    expect(warn.mock.calls).toEqual([[`auth_mail_budget level=warn sent=${MAIL_DAILY_WARN} cap=${MAIL_DAILY_VERIFY_CAP}`]]);
  });

  it(`refuses a verification mail after ${MAIL_DAILY_VERIFY_CAP}, logs the cap once, and keeps the rest of the day for resets`, async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const answers = await reserve('verify', MAIL_DAILY_VERIFY_CAP + 3);
    expect(answers.slice(0, MAIL_DAILY_VERIFY_CAP).every(Boolean)).toBe(true);
    expect(answers.slice(MAIL_DAILY_VERIFY_CAP)).toEqual([false, false, false]);
    expect(await mailBudgetLeft('verify')).toBe(false);
    expect(await mailBudgetLeft('reset')).toBe(true);
    // A refused mail is not counted, so a flood of verification mails cannot eat the share of the resets.
    expect(await mailSentToday()).toBe(MAIL_DAILY_VERIFY_CAP);
    expect(error.mock.calls).toEqual([[`auth_mail_budget level=cap kind=verify sent=${MAIL_DAILY_VERIFY_CAP} cap=${MAIL_DAILY_VERIFY_CAP}`]]);

    const resets = await reserve('reset', MAIL_DAILY_HARD_CAP - MAIL_DAILY_VERIFY_CAP + 2);
    expect(resets.filter(Boolean)).toHaveLength(MAIL_DAILY_HARD_CAP - MAIL_DAILY_VERIFY_CAP);
    expect(await mailBudgetLeft('reset')).toBe(false);
    expect(error.mock.calls.at(-1)).toEqual([`auth_mail_budget level=cap kind=reset sent=${MAIL_DAILY_HARD_CAP} cap=${MAIL_DAILY_HARD_CAP}`]);
  });

  it('starts a new count at midnight UTC', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-13T23:59:00Z'));
    await reserve('verify', MAIL_DAILY_VERIFY_CAP + 1);
    expect(await mailBudgetLeft('verify')).toBe(false);
    vi.setSystemTime(new Date('2026-11-14T00:00:01Z'));
    expect(await mailBudgetLeft('verify')).toBe(true);
    expect(await mailSentToday()).toBe(0);
  });
});
