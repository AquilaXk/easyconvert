import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addGrantToSummary, main, parseExpiry, summarizeCampaign, type CampaignSummary } from '../scripts/grant-event-credits';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { accountTaggedKeys } from '../src/lib/auth/erase-account-keys';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { TERMS_VERSION } from '../src/lib/legal/documents';

/**
 * The operator tool that gives event credits (entry 374). Each case names its own campaign and seeds its own accounts, and the
 * bulk case that scans every account runs only when the user store is this process's, since a Redis shared with other suites has
 * accounts that are not the case's.
 */

const created: string[] = [];
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'grant-event-credits-'));
let output: string[] = [];
let errors: string[] = [];

async function account(fields: { emailVerified?: boolean } = { emailVerified: true }) {
  const user = await redisUserStore.createUser({ email: `event_${crypto.randomUUID()}@event.test`, name: 'Event', acceptedTermsVersion: TERMS_VERSION, ...fields });
  created.push(user.id);
  return user;
}

function campaign(): string {
  return `camp-${crypto.randomBytes(5).toString('hex')}`;
}

async function run(...argv: string[]): Promise<number> {
  return main(argv);
}

beforeEach(() => {
  output = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => void output.push(line));
  vi.spyOn(console, 'error').mockImplementation((line: string) => void errors.push(line));
});

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const id of created.splice(0)) {
    await redisKeyStore.forgetUsage(id);
    await redisUserStore.deleteUser(id);
  }
});

describe('grant-event-credits, the operator tool that gives event credits', () => {
  it('writes nothing in a dry run and says how many accounts it would grant', async () => {
    const id = campaign();
    const user = await account();
    expect(await run('--campaign', id, '--credits', '30', '--user', user.id)).toBe(0);
    expect(output.join('\n')).toContain('would grant: 1');
    expect(output.join('\n')).toContain('Dry run: nothing was written');
    expect(await redisKeyStore.promoGrants(user.id)).toEqual([]);
    expect(await redisKeyStore.promoCampaign(id)).toBeNull();
  });

  it('grants a confirmed account by id or email once, logs one line, and grants nobody twice', async () => {
    const id = campaign();
    const user = await account();
    expect(await run('--campaign', id, '--credits', '30', '--user', user.email, '--apply')).toBe(0);
    expect(output.filter((line) => line.includes('grant-event-credits: campaign='))).toHaveLength(1);
    expect(output.join('\n')).toContain('no expiry');
    expect(await redisKeyStore.promoGrants(user.id)).toEqual([expect.objectContaining({ campaignId: id, amount: 30, remaining: 30, actor: 'operator-cli' })]);
    expect((await redisKeyStore.getQuotaUsage(user.id)).promoCredits).toBe(30);

    output = [];
    expect(await run('--campaign', id, '--credits', '30', '--user', user.id, '--apply')).toBe(0);
    expect(output.join('\n')).toContain('already granted: 1');
    expect((await redisKeyStore.getQuotaUsage(user.id)).promoCredits).toBe(30);
  });

  it('skips an account with an unconfirmed address, a checkout hold, a suspension or a purge in progress, and names the reason in counts', async () => {
    const id = campaign();
    const unconfirmed = await account({ emailVerified: false });
    const held = await account();
    await redisKeyStore.setBillingHold(held.id, 'chargeback');
    const suspended = await account();
    await redisUserStore.updateUser(suspended.id, { suspendedAt: Date.now(), suspendedReason: 'test' });
    const file = path.join(scratch, `${id}.txt`);
    fs.writeFileSync(file, ['# the batch', unconfirmed.id, held.email, suspended.id, '', 'nobody@event.test'].join('\n'));
    expect(await run('--campaign', id, '--credits', '5', '--users-file', file, '--apply')).toBe(0);
    const text = output.join('\n');
    expect(text).toContain('skipped, email not confirmed: 1');
    expect(text).toContain('skipped, checkout hold: 1');
    expect(text).toContain('skipped, suspended: 1');
    expect(text).toContain('no such account: 1');
    for (const user of [unconfirmed, held, suspended]) expect(await redisKeyStore.promoGrants(user.id)).toEqual([]);
    expect(text).not.toContain('@event.test');
    await redisKeyStore.clearBillingHold(held.id);
  });

  it('holds the campaign to its budget and says how many accounts were over it', async () => {
    const id = campaign();
    const users = [await account(), await account(), await account()];
    const file = path.join(scratch, `${id}.txt`);
    fs.writeFileSync(file, users.map((user) => user.id).join('\n'));
    expect(await run('--campaign', id, '--credits', '10', '--users-file', file, '--budget', '25')).toBe(0);
    expect(output.join('\n')).toContain('would grant: 2');
    expect(output.join('\n')).toContain('over the budget: 1');
    output = [];
    expect(await run('--campaign', id, '--credits', '10', '--users-file', file, '--budget', '25', '--apply')).toBe(0);
    expect(output.join('\n')).toContain('granted: 2');
    expect(output.join('\n')).toContain('over the budget: 1');
    expect(await redisKeyStore.promoCampaign(id)).toMatchObject({ budget: 25, granted: 20, count: 2 });
  });

  it('reads a date as the end of that day in Korea and refuses a time in the past, a bad date and a bad amount', async () => {
    expect(parseExpiry('2031-12-31')).toBe(Date.parse('2031-12-31T14:59:59.999Z'));
    expect(parseExpiry('2031-12-31')).toBe(Date.parse('2031-12-31T23:59:59.999+09:00'));
    expect(parseExpiry('2031-12-31T14:59:59+09:00')).toBe(Date.parse('2031-12-31T05:59:59Z'));
    expect(parseExpiry('2031-12-31T14:59:59')).toBeUndefined();
    expect(parseExpiry('31/12/2031')).toBeUndefined();
    const user = await account();
    const base = ['--campaign', campaign(), '--user', user.id];
    expect(await run(...base, '--credits', '5', '--expires', '2001-01-01')).toBe(2);
    expect(errors.at(-1)).toContain('future');
    expect(await run(...base, '--credits', '5', '--expires', 'next week')).toBe(2);
    expect(await run(...base, '--credits', '0')).toBe(2);
    expect(await run(...base, '--credits', '5.5')).toBe(2);
    expect(await run('--campaign', 'Bad Id', '--credits', '5', '--user', user.id)).toBe(2);
    expect(await run('--campaign', campaign(), '--credits', '5')).toBe(2);
    expect(await run('--campaign', campaign(), '--credits', '5', '--user', user.id, '--all-confirmed')).toBe(2);
    expect(await run('--campaign', campaign(), '--credits', '5', '--user', 'nobody@event.test')).toBe(1);
  });

  it('records the expiry, which ends the grant', async () => {
    const id = campaign();
    const user = await account();
    expect(await run('--campaign', id, '--credits', '5', '--user', user.id, '--expires', '2031-12-31', '--apply')).toBe(0);
    expect(output.join('\n')).toContain('expires 2031-12-31T14:59:59.999Z');
    const usage = await redisKeyStore.getQuotaUsage(user.id);
    expect(usage).toMatchObject({ promoCredits: 5, promoExpiresAt: Date.parse('2031-12-31T23:59:59.999+09:00') });
  });

  it('voids one account, then the whole campaign, and keeps what was spent; the campaign then takes no new account', async () => {
    const id = campaign();
    const first = await account();
    const second = await account();
    await run('--campaign', id, '--credits', '10', '--user', first.id, '--apply');
    await run('--campaign', id, '--credits', '10', '--user', second.id, '--apply');
    const reserved = await redisKeyStore.reserveQuota(first.id, 12);
    await redisKeyStore.commitQuota(reserved.reservationId as string);

    output = [];
    expect(await run('--void', '--campaign', id, '--user', first.id)).toBe(0);
    expect(output.join('\n')).toContain('would void: 1');
    expect((await redisKeyStore.getQuotaUsage(first.id)).promoCredits).toBe(8);

    expect(await run('--void', '--campaign', id, '--user', first.id, '--apply')).toBe(0);
    expect((await redisKeyStore.getQuotaUsage(first.id)).promoCredits).toBe(0);
    output = [];
    expect(await run('--void', '--campaign', id, '--apply')).toBe(0);
    expect(output.join('\n')).toContain('already voided: 1');
    expect(output.join('\n')).toContain('voided: 1');
    expect((await redisKeyStore.getQuotaUsage(second.id)).promoCredits).toBe(0);

    const third = await account();
    expect(await run('--campaign', id, '--credits', '10', '--user', third.id, '--apply')).toBe(1);
    expect(errors.at(-1)).toContain('was voided');
    expect(await redisKeyStore.promoGrants(third.id)).toEqual([]);
    expect(await run('--void', '--campaign', 'unknown-campaign')).toBe(1);
  });

  it('reports granted, used, remaining, expired and voided credits of a campaign, with counts only', async () => {
    const id = campaign();
    const [spender, idle, voided] = [await account(), await account(), await account()];
    for (const user of [spender, idle, voided]) await run('--campaign', id, '--credits', '10', '--user', user.id, '--apply');
    const reserved = await redisKeyStore.reserveQuota(spender.id, 14);
    await redisKeyStore.commitQuota(reserved.reservationId as string);
    await redisKeyStore.voidPromoCredits(voided.id, id);

    output = [];
    expect(await run('--report', '--campaign', id)).toBe(0);
    expect(output.join('\n')).toBe([`campaign ${id}`, 'accounts: 3', 'granted: 30', 'used: 4', 'remaining: 16', 'expired: 0', 'voided: 10'].join('\n'));
    expect(await run('--report', '--campaign', 'unknown-campaign')).toBe(1);
    expect((await summarizeCampaign(id))?.summary).toEqual({ accounts: 3, granted: 30, used: 4, remaining: 16, expired: 0, voided: 10 });
  });

  it('counts the credits of an ended grant as expired and the rest of the grants by what became of them', () => {
    const summary: CampaignSummary = { accounts: 0, granted: 0, used: 0, remaining: 0, expired: 0, voided: 0 };
    const grant = { campaignId: 'c', grantId: 'c:a', priority: 0, grantedAt: 1, reason: '', actor: '' };
    addGrantToSummary(summary, { ...grant, amount: 10, remaining: 6, expiresAt: 100 }, 200);
    addGrantToSummary(summary, { ...grant, amount: 10, remaining: 6, expiresAt: 300 }, 200);
    addGrantToSummary(summary, { ...grant, amount: 10, remaining: 0, voidedAt: 150, voidedRemaining: 7 }, 200);
    expect(summary).toEqual({ accounts: 3, granted: 30, used: 4 + 4 + 3, remaining: 6, expired: 6, voided: 7 });
  });

  // skip-ok: mode selection. A Redis shared with other suites holds accounts that are not this case's, and the case grants every confirmed one.
  it.skipIf(Boolean(process.env.REDIS_URL))('grants every confirmed account with --all-confirmed and prints counts only', async () => {
    const id = campaign();
    const [a, b] = [await account(), await account()];
    await account({ emailVerified: false });
    expect(await run('--campaign', id, '--credits', '3', '--all-confirmed', '--apply')).toBe(0);
    expect(output.join('\n')).toContain('granted: 2');
    expect(output.join('\n')).toContain('skipped, email not confirmed: 1');
    expect(output.join('\n')).not.toContain('@event.test');
    for (const user of [a, b]) expect((await redisKeyStore.getQuotaUsage(user.id)).promoCredits).toBe(3);
  });

  // skip-ok: mode selection. The keys of an account exist only in Redis; the memory ledger has none to find.
  it.skipIf(!process.env.REDIS_URL)('lists the grant keys of an account among the keys its erasure deletes, held units included', async () => {
    const user = await account();
    await run('--campaign', campaign(), '--credits', '30', '--user', user.id, '--apply');
    // Spend the day and then some of the grant, so that a reservation in flight holds grant units.
    const day = await redisKeyStore.reserveQuota(user.id, 12);
    expect(day.allowed).toBe(true);
    const prefix = redisKeyStore.getPrefix();
    const keys = await accountTaggedKeys(user.id);
    for (const suffix of ['', ':qlist', ':qholds']) expect(keys.includes(`${prefix}promo:{${user.id}}${suffix}`), `promo:{id}${suffix}`).toBe(true);
    await redisKeyStore.rollbackQuota(day.reservationId as string);
  });

  it('prints a usage text for a bad option and exits 2', async () => {
    expect(await run('--nonsense')).toBe(2);
    expect(errors.join('\n')).toContain('Usage:');
    expect(await run('--report', '--campaign', campaign(), '--apply')).toBe(2);
  });
});
