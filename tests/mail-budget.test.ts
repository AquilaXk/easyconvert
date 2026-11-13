import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAIL_DAILY_HARD_CAP,
  MAIL_DAILY_WARN,
  mailBudgetLeft,
  mailSentToday,
  reserveMailSend,
  resetMailBudgetMemory,
} from '../src/lib/auth/mail-budget';

/** The count of mails sent in a day against the limit of the mail account, and the two lines an operator reads. */

async function reserve(times: number): Promise<boolean[]> {
  const answers: boolean[] = [];
  for (let index = 0; index < times; index++) answers.push(await reserveMailSend());
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
  it('counts every reserved send, and has room until the hard cap', async () => {
    expect(await mailBudgetLeft()).toBe(true);
    await reserve(3);
    expect(await mailSentToday()).toBe(3);
    expect(await mailBudgetLeft()).toBe(true);
  });

  it(`logs once when the day reaches ${MAIL_DAILY_WARN} sends, and keeps sending`, async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const answers = await reserve(MAIL_DAILY_WARN + 5);
    expect(answers.every(Boolean)).toBe(true);
    expect(warn.mock.calls).toEqual([[`auth_mail_budget level=warn sent=${MAIL_DAILY_WARN} cap=${MAIL_DAILY_HARD_CAP}`]]);
  });

  it(`refuses the send after ${MAIL_DAILY_HARD_CAP}, logs the cap once, and says so before a code is made`, async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const answers = await reserve(MAIL_DAILY_HARD_CAP + 3);
    expect(answers.slice(0, MAIL_DAILY_HARD_CAP).every(Boolean)).toBe(true);
    expect(answers.slice(MAIL_DAILY_HARD_CAP)).toEqual([false, false, false]);
    expect(await mailBudgetLeft()).toBe(false);
    expect(error.mock.calls).toEqual([[`auth_mail_budget level=cap sent=${MAIL_DAILY_HARD_CAP} cap=${MAIL_DAILY_HARD_CAP}`]]);
  });

  it('starts a new count at midnight UTC', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-13T23:59:00Z'));
    await reserve(MAIL_DAILY_HARD_CAP + 1);
    expect(await mailBudgetLeft()).toBe(false);
    vi.setSystemTime(new Date('2026-11-14T00:00:01Z'));
    expect(await mailBudgetLeft()).toBe(true);
    expect(await mailSentToday()).toBe(0);
  });
});
