import crypto from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { compareGrantsByBurnDownOrder, type PromoGrant } from '../../src/lib/api-keys/promo-grants';
import type { RedisKeyStore } from '../../src/lib/api-keys/redis-key-store';
import { RESERVATION_LEASE, type PromoGrantRequest } from '../../src/lib/api-keys/reservation-ledger';
import { FREE_DAILY_CREDITS } from '../../src/lib/plan-limits';

/**
 * The promotional (event) credits of the ledger (docs/policy-decisions.md, entry 374): spent after the window and before the package
 * balance in burn-down order, skipped once ended or voided, one grant for each campaign and account, a budget that holds under
 * concurrent grants, no effect on the tier, and out of the refund path. The same cases run on the ledger of this process and on a real
 * Redis server, where each step is one Lua script.
 */

const DAY = FREE_DAILY_CREDITS;
const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-21T10:00:00.000Z');

export interface PromoCaseControls {
  store: () => RedisKeyStore;
  /** Lets `ms` pass for the store: the clock, the ends of the leases and the ends of the grants. */
  advance: (ms: number) => Promise<void>;
  /** The time the store reads the ends of grants against. */
  now: () => Promise<number>;
}

/** A small seeded generator, so that a run of the order test can be repeated. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

export function itKeepsPromoCredits(controls: PromoCaseControls): void {
  let owner = '';
  const store = () => controls.store();
  const usage = () => store().getQuotaUsage(owner);
  const grants = () => store().promoGrants(owner);
  const remainingOf = async (campaignId: string) => (await grants()).find((grant) => grant.campaignId === campaignId)?.remaining;
  const giveTo = async (who: string, campaignId: string, amount: number, extra: Partial<PromoGrantRequest> = {}, budget?: number) =>
    store().grantPromoCredits(who, { campaignId, amount, priority: 0, reason: 'test', actor: 'test', at: await controls.now(), ...extra }, budget);
  const give = (campaignId: string, amount: number, extra: Partial<PromoGrantRequest> = {}, budget?: number) => giveTo(owner, campaignId, amount, extra, budget);
  const reserve = async (units: number) => {
    const reserved = await store().reserveQuota(owner, units);
    expect(reserved.allowed, `reserve ${units}`).toBe(true);
    return reserved.reservationId as string;
  };
  /** Uses up the day's credits so that the next ones come from the grants. */
  const spendTheDay = async () => {
    await store().commitQuota(await reserve(DAY));
  };
  const grant = (credits: number, transactionId = `txn_${crypto.randomUUID()}`, paid = '1000') => store().creditPackage(owner, { transactionId, credits, paid, at: NOW });

  beforeEach(() => {
    owner = `promo_${crypto.randomBytes(6).toString('hex')}`;
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('spends the window first, then the grants, then the package, and counts all three in what is left', async () => {
    await grant(100);
    expect(await give('spring', 30)).toBe('granted');
    expect(await usage()).toMatchObject({ usedToday: 0, packageCredits: 100, promoCredits: 30, remaining: DAY + 30 + 100 });

    const first = await store().reserveQuota(owner, DAY + 12);
    expect(first).toMatchObject({ allowed: true, remaining: DAY + 30 + 100 - (DAY + 12) });
    expect(await usage()).toMatchObject({ usedToday: DAY, promoCredits: 18, packageCredits: 100 });

    const second = await store().reserveQuota(owner, 25);
    expect(second).toMatchObject({ allowed: true, remaining: 18 + 100 - 25 });
    // 18 came from the grants, the other 7 from the package.
    expect(await usage()).toMatchObject({ usedToday: DAY, promoCredits: 0, packageCredits: 93, remaining: 93 });
    expect(await remainingOf('spring')).toBe(0);
  });

  it('takes nothing when the window, the grants and the package together do not cover the credits', async () => {
    await give('spring', 5);
    const refused = await store().reserveQuota(owner, DAY + 6);
    expect(refused).toMatchObject({ allowed: false, remaining: DAY + 5 });
    expect(await usage()).toMatchObject({ usedToday: 0, promoCredits: 5 });
  });

  it('leaves the tier of the account as it is: grants make no payer, held or not, and the package still does', async () => {
    await give('spring', 40);
    await spendTheDay();
    expect(await usage()).toMatchObject({ tier: 'free', promoCredits: 40 });
    expect((await store().withCreditTier({ id: owner, tier: 'free' })).tier).toBe('free');

    // All the grant's credits held by work in flight: still no payer.
    await reserve(40);
    expect(await usage()).toMatchObject({ tier: 'free', promoCredits: 0 });
    store().clearStandingCache(owner);
    expect((await store().withCreditTier({ id: owner, tier: 'free' })).tier).toBe('free');

    await grant(5);
    store().clearStandingCache(owner);
    expect((await store().withCreditTier({ id: owner, tier: 'free' })).tier).toBe('paid');
    expect(await usage()).toMatchObject({ tier: 'paid' });
  });

  it('spends the grants in burn-down order: priority, the earlier end with none last, the earlier creation, the id', async () => {
    const at = await controls.now();
    await give('low-priority', 3, { priority: 1, at });
    await give('no-end-old', 3, { at: at - 5000 });
    await give('no-end-new', 3, { at: at - 1000 });
    await give('ends-late', 3, { expiresAt: at + 10 * HOUR, at });
    await give('ends-soon', 3, { expiresAt: at + 2 * HOUR, at });
    await give('same-end-b', 3, { expiresAt: at + 5 * HOUR, at: at - 3000 });
    await give('same-end-a', 3, { expiresAt: at + 5 * HOUR, at: at - 3000 });
    await spendTheDay();
    const order = ['ends-soon', 'same-end-a', 'same-end-b', 'ends-late', 'no-end-old', 'no-end-new', 'low-priority'];

    for (const [index, campaignId] of order.entries()) {
      await store().commitQuota(await reserve(3));
      const left = Object.fromEntries((await grants()).map((entry) => [entry.campaignId, entry.remaining]));
      for (const [other, campaign] of order.entries()) expect(left[campaign], `after ${index + 1} reservations, ${campaign}`).toBe(other <= index ? 0 : 3);
      expect(left[campaignId]).toBe(0);
    }
    expect(await usage()).toMatchObject({ promoCredits: 0 });
  });

  it('spends one credit at a time in the order of the burn-down comparison, for grants drawn at random', async () => {
    const random = seeded(20261121);
    const at = await controls.now();
    const campaigns = Array.from({ length: 24 }, (_, index) => `c${String(index).padStart(2, '0')}`);
    for (const campaignId of campaigns) {
      const ends = random() < 0.6 ? at + Math.floor(random() * 4) * HOUR + Math.floor(random() * 3) * 1000 : undefined;
      await give(campaignId, 2, { priority: Math.floor(random() * 3), at: at - Math.floor(random() * 4) * 2000, ...(ends === undefined ? {} : { expiresAt: ends }) });
    }
    await spendTheDay();
    const expected = [...(await grants())].sort(compareGrantsByBurnDownOrder).flatMap((entry) => [entry.campaignId, entry.campaignId]);

    const seen: string[] = [];
    let before = new Map((await grants()).map((entry) => [entry.campaignId, entry.remaining]));
    for (let step = 0; step < expected.length; step++) {
      await store().commitQuota(await reserve(1));
      const after = new Map((await grants()).map((entry) => [entry.campaignId, entry.remaining]));
      const spent = [...after].filter(([campaignId, remaining]) => remaining < (before.get(campaignId) ?? 0)).map(([campaignId]) => campaignId);
      expect(spent).toHaveLength(1);
      seen.push(spent[0] as string);
      before = after;
    }
    expect(seen).toEqual(expected);
  });

  it('skips a grant that ended, and counts what is left and the earliest end among the grants that can still be spent', async () => {
    const at = await controls.now();
    await give('short', 10, { expiresAt: at + HOUR });
    await give('long', 10, { expiresAt: at + 10 * HOUR });
    await give('open', 10);
    // The time left to the earliest end is compared, not the end, since a Redis server cannot be moved and the ends move back instead.
    const untilEnd = async () => ((await usage()).promoExpiresAt as number) - (await controls.now());
    expect(await usage()).toMatchObject({ promoCredits: 30 });
    expect(Math.abs((await untilEnd()) - HOUR)).toBeLessThan(5000);

    await controls.advance(2 * HOUR);
    expect(await usage()).toMatchObject({ promoCredits: 20 });
    expect(Math.abs((await untilEnd()) - 8 * HOUR)).toBeLessThan(5000);
    await spendTheDay();
    expect(await store().reserveQuota(owner, 21)).toMatchObject({ allowed: false, remaining: 20 });
    await store().commitQuota(await reserve(20));
    // The ended grant kept its credits for the record and was never touched.
    expect(await remainingOf('short')).toBe(10);
    expect(await remainingOf('long')).toBe(0);
    expect(await remainingOf('open')).toBe(0);

    await controls.advance(10 * HOUR);
    expect(await usage()).toMatchObject({ promoCredits: 0 });
    expect((await usage()).promoExpiresAt).toBeUndefined();
  });

  it('voids a grant once: the credits left go, the credits spent stay spent, and the campaign cannot grant it again', async () => {
    await give('spring', 10);
    await spendTheDay();
    await store().commitQuota(await reserve(3));
    expect(await store().voidPromoCredits(owner, 'spring')).toEqual({ status: 'voided', voided: 7 });
    expect(await usage()).toMatchObject({ promoCredits: 0, remaining: 0 });
    expect(await store().voidPromoCredits(owner, 'spring')).toEqual({ status: 'already-voided' });
    expect(await store().voidPromoCredits(owner, 'never')).toEqual({ status: 'unknown-grant' });
    expect(await give('spring', 10)).toBe('duplicate');
    expect(await usage()).toMatchObject({ promoCredits: 0 });
    expect(await grants()).toEqual([expect.objectContaining({ campaignId: 'spring', amount: 10, remaining: 0, voidedRemaining: 7 })]);
    expect((await grants())[0]?.voidedAt).toBeTypeOf('number');
  });

  it('drops the units a reservation in flight returns to a voided grant and gives them back to a live one', async () => {
    await give('spring', 10);
    await give('autumn', 10, { priority: 1 });
    await spendTheDay();
    const id = await reserve(14);
    expect(await remainingOf('spring')).toBe(0);
    expect(await remainingOf('autumn')).toBe(6);
    await store().voidPromoCredits(owner, 'spring');
    expect(await store().rollbackQuota(id)).toBe(true);
    // The spring units are gone with the void; the autumn units came back.
    expect(await remainingOf('spring')).toBe(0);
    expect(await remainingOf('autumn')).toBe(10);
    expect(await usage()).toMatchObject({ promoCredits: 10 });
  });

  it('gives the units of a rollback and of an ended lease back to the grants they came from', async () => {
    await give('spring', 10);
    await spendTheDay();
    const rolledBack = await reserve(4);
    expect(await usage()).toMatchObject({ promoCredits: 6 });
    expect(await store().rollbackQuota(rolledBack)).toBe(true);
    expect(await usage()).toMatchObject({ promoCredits: 10 });

    const kept = await reserve(4);
    expect(await store().commitQuota(kept)).toBe(true);
    expect(await store().rollbackQuota(kept)).toBe(false);
    expect(await usage()).toMatchObject({ promoCredits: 6 });

    await reserve(2);
    expect(await usage()).toMatchObject({ promoCredits: 4 });
    await controls.advance(RESERVATION_LEASE.provisionalMs + 1000);
    expect(await usage()).toMatchObject({ promoCredits: 6 });
  });

  it('refunds the package first, then the grants drawn last, when a reservation settles to fewer credits', async () => {
    await grant(20);
    await give('first', 4);
    await give('second', 4, { priority: 1 });
    const id = await reserve(DAY + 4 + 4 + 5);
    expect(await usage()).toMatchObject({ usedToday: DAY, promoCredits: 0, packageCredits: 15 });
    // 13 credits stay charged: the day's 10 and 3 of the 8 from the grants. The package gets its 5 back, then 'second' its 4 and 'first' 1.
    expect(await store().settleQuota(id, DAY + 3)).toEqual({ success: true, difference: -10 });
    expect(await usage()).toMatchObject({ usedToday: DAY, packageCredits: 20, promoCredits: 5 });
    expect(await remainingOf('first')).toBe(1);
    expect(await remainingOf('second')).toBe(4);
  });

  it('charges the minutes beyond the first from the window, then the grants, then the package, and notes what came from the grants', async () => {
    await grant(10);
    await give('spring', 3);
    const id = await reserve(4);
    // 4 are held and 6 are left in the day: a surcharge of 12 takes 6 from the day, 3 from the grants and 3 from the package.
    expect(await store().commitQuota(id, { extra: 12, note: { from: 'docx', to: 'pdf', base: 2, surcharge: 12 } })).toBe(true);
    expect(await usage()).toMatchObject({ usedToday: DAY, promoCredits: 0, packageCredits: 7 });
    expect(await store().recentCharges(owner)).toEqual([expect.objectContaining({ credits: 16, fromPackage: 3, fromPromo: 3 })]);
  });

  it('holds a graph\'s extension from the window, then the grants, then the package, and ends it with the reservation', async () => {
    await grant(10);
    await give('spring', 3);
    const id = await reserve(DAY - 1);
    expect(await store().extendQuota(id, 'node-a', 5)).toEqual({ status: 'extended' });
    // 5 are held: the 1 left in the day, the 3 of the grant and 1 of the package.
    expect(await usage()).toMatchObject({ usedToday: DAY, promoCredits: 0, packageCredits: 9 });
    expect(await store().extendQuota(id, 'node-a', 5)).toEqual({ status: 'extended' });
    expect(await usage()).toMatchObject({ promoCredits: 0, packageCredits: 9 });
    expect(await store().extendQuota(id, 'node-b', 20)).toMatchObject({ status: 'does-not-fit' });
    expect(await store().rollbackQuota(id)).toBe(true);
    expect(await usage()).toMatchObject({ usedToday: 0, promoCredits: 3, packageCredits: 10 });
  });

  it('writes one grant for each campaign and account, also when the same grant arrives at the same moment', async () => {
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => give('race', 10)));
    expect(outcomes.filter((outcome) => outcome === 'granted')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'duplicate')).toHaveLength(7);
    expect(await usage()).toMatchObject({ promoCredits: 10 });
    expect(await store().promoCampaign('race')).toMatchObject({ granted: 10, count: 1 });
    expect(await give('race', 50)).toBe('duplicate');
    expect(await usage()).toMatchObject({ promoCredits: 10 });
    expect(await give('other', 7)).toBe('granted');
    expect(await usage()).toMatchObject({ promoCredits: 17 });
  });

  it('holds a campaign to its budget when many accounts are granted at the same moment, and counts each account once', async () => {
    const owners = Array.from({ length: 40 }, () => `promo_${crypto.randomBytes(6).toString('hex')}`);
    const outcomes = await Promise.all(owners.map((who) => giveTo(who, 'capped', 10, {}, 100)));
    expect(outcomes.filter((outcome) => outcome === 'granted')).toHaveLength(10);
    expect(outcomes.filter((outcome) => outcome === 'budget-exhausted')).toHaveLength(30);
    expect(await store().promoCampaign('capped')).toMatchObject({ budget: 100, granted: 100, count: 10 });
    const counted = new Set<string>();
    let cursor = '0';
    do {
      const page = await store().promoCampaignOwners('capped', cursor);
      for (const who of page.owners) counted.add(who);
      cursor = page.next;
    } while (cursor !== '0');
    expect(counted.size).toBe(10);
    const granted = owners.filter((_, index) => outcomes[index] === 'granted');
    expect([...counted].sort()).toEqual(granted.sort());
    // A grant that was counted comes again as a duplicate and takes no more of the budget; a raised budget lets one more account in.
    expect(await giveTo(granted[0] as string, 'capped', 10, {}, 100)).toBe('duplicate');
    const refused = owners.find((_, index) => outcomes[index] === 'budget-exhausted') as string;
    expect(await giveTo(refused, 'capped', 10, {}, 110)).toBe('granted');
    expect(await store().promoCampaign('capped')).toMatchObject({ budget: 110, granted: 110, count: 11 });
  });

  it('takes no more grants once the campaign is voided, and keeps the ones it made', async () => {
    expect(await give('closing', 10)).toBe('granted');
    await store().voidPromoCampaign('closing');
    expect(await store().promoCampaign('closing')).toMatchObject({ granted: 10, count: 1 });
    expect((await store().promoCampaign('closing'))?.voidedAt).toBeTypeOf('number');
    expect(await giveTo(`promo_${crypto.randomBytes(6).toString('hex')}`, 'closing', 10)).toBe('campaign-voided');
    expect(await give('closing', 10)).toBe('duplicate');
    expect(await usage()).toMatchObject({ promoCredits: 10 });
  });

  it('keeps the grants out of the refund path: a refund takes back package credits only, and never reads a grant as a payment', async () => {
    await grant(100, 'txn_paid');
    await give('spring', 50);
    expect(await store().packageTransactionCount(owner)).toBe(1);
    const revoked = await store().revokePackage(owner, { transactionId: 'txn_paid', adjustmentId: 'adj_1', amount: '1000', full: true });
    expect(revoked).toEqual({ status: 'revoked', revoked: 100, unrecovered: 0, deferred: 0 });
    expect(await store().packageBalance(owner)).toBe(0);
    expect(await store().packageDebt(owner)).toBe(0);
    expect(await usage()).toMatchObject({ promoCredits: 50, packageCredits: 0 });
    expect(await store().revokePackage(owner, { transactionId: 'promo:spring', adjustmentId: 'adj_2', amount: '1000', full: true })).toEqual({ status: 'unknown-transaction' });
    expect(await remainingOf('spring')).toBe(50);

    // Credits spent from the grants are not owed back: only the package side of a refund finds a debt.
    await spendTheDay();
    await store().commitQuota(await reserve(50));
    await grant(30, 'txn_two');
    expect(await store().revokePackage(owner, { transactionId: 'txn_two', adjustmentId: 'adj_3', amount: '1000', full: true })).toMatchObject({ status: 'revoked', revoked: 30 });
    expect(await store().packageDebt(owner)).toBe(0);
  });

  it('keeps a grant out of the standing of the package: a promo-only account has no payment on record', async () => {
    await give('spring', 20);
    expect(await store().packageTransactionCount(owner)).toBe(0);
    expect(await store().packageBalance(owner)).toBe(0);
  });

  it('spends a grant in full under many reservations at the same moment, none twice', async () => {
    await give('busy', 20);
    await spendTheDay();
    const results = await Promise.all(Array.from({ length: 30 }, () => store().reserveQuota(owner, 1)));
    expect(results.filter((result) => result.allowed)).toHaveLength(20);
    expect(await usage()).toMatchObject({ promoCredits: 0 });
    expect(await remainingOf('busy')).toBe(0);
    const ids = results.flatMap((result) => (result.allowed ? [result.reservationId as string] : []));
    await Promise.all(ids.slice(0, 5).map((id) => store().rollbackQuota(id)));
    expect(await usage()).toMatchObject({ promoCredits: 5 });
    await Promise.all(ids.slice(5).map((id) => store().commitQuota(id)));
    expect(await usage()).toMatchObject({ promoCredits: 5 });
    expect(await remainingOf('busy')).toBe(5);
  });

  it('forgets the grants of an account with its credits, and the campaign no longer counts the account', async () => {
    await give('spring', 10);
    await store().forgetUsage(owner);
    expect(await grants()).toEqual([]);
    expect(await usage()).toMatchObject({ promoCredits: 0 });
    const counted = await store().promoCampaignOwners('spring', '0');
    expect(counted.owners).not.toContain(owner);
    // The credits the campaign gave stay in its count: the budget was spent.
    expect(await store().promoCampaign('spring')).toMatchObject({ granted: 10 });
  });
}

export type { PromoGrant };
