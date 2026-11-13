import crypto from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RedisKeyStore } from '../../src/lib/api-keys/redis-key-store';
import { RECENT_CHARGES, RESERVATION_LEASE } from '../../src/lib/api-keys/reservation-ledger';
import { FREE_DAILY_CREDITS } from '../../src/lib/plan-limits';
import { redisUserStore } from '../../src/lib/auth/redis-user-store';
import { subscriptionStore } from '../../src/lib/billing/subscription-store';

/**
 * The credit ledger (docs/policy-decisions.md, entry 285): an account spends the credits of its window (the 10 of the free day
 * here) first and its package balance for the rest, only conversions that succeed are charged, the minutes beyond the first are
 * charged on top at the end, and a payment adds credits once. The same cases run on the ledger of this process and on a real Redis
 * server, where each step is one Lua script.
 */

const DAY = FREE_DAILY_CREDITS;
const NOW = Date.parse('2026-11-13T10:00:00.000Z');

export interface CreditCaseControls {
  store: () => RedisKeyStore;
  /** Lets `ms` pass for the store: the clock, and in Redis the ends of the leases of the keys. */
  advance: (ms: number) => Promise<void>;
}

export function itKeepsCredits(controls: CreditCaseControls): void {
  let owner = '';
  const store = () => controls.store();
  const usage = () => store().getQuotaUsage(owner);
  const grant = (credits: number, transactionId = `txn_${crypto.randomUUID()}`, paid = '1000') => store().creditPackage(owner, { transactionId, credits, paid, at: NOW });
  const reserve = async (units: number) => {
    const reserved = await store().reserveQuota(owner, units);
    expect(reserved.allowed, `reserve ${units}`).toBe(true);
    return reserved.reservationId as string;
  };

  beforeEach(() => {
    owner = `credit_${crypto.randomBytes(6).toString('hex')}`;
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('spends the credits of the window first and the package for the rest, and says what is left in both', async () => {
    await grant(100);
    expect(await usage()).toMatchObject({ tier: 'paid', dailyLimit: DAY, usedToday: 0, packageCredits: 100, remaining: DAY + 100 });

    const small = await store().reserveQuota(owner, 4);
    expect(small).toMatchObject({ allowed: true, remaining: DAY + 100 - 4 });
    expect(await usage()).toMatchObject({ usedToday: 4, packageCredits: 100 });

    const large = await store().reserveQuota(owner, 12);
    expect(large).toMatchObject({ allowed: true, remaining: DAY + 100 - 16 });
    // 6 credits were left of the day, the other 6 came from the package.
    expect(await usage()).toMatchObject({ usedToday: DAY, packageCredits: 94, remaining: 94 });
  });

  it('takes nothing when the window and the package together do not cover the credits, and says what is left', async () => {
    await grant(5);
    const refused = await store().reserveQuota(owner, DAY + 6);
    expect(refused).toMatchObject({ allowed: false, remaining: DAY + 5 });
    expect(await usage()).toMatchObject({ usedToday: 0, packageCredits: 5 });
    const exact = await store().reserveQuota(owner, DAY + 5);
    expect(exact).toMatchObject({ allowed: true, remaining: 0 });
    expect(await usage()).toMatchObject({ usedToday: DAY, packageCredits: 0, remaining: 0 });
  });

  it('gives a rollback back to the window and to the package, and a commit keeps both', async () => {
    await grant(50);
    const rolledBack = await reserve(DAY + 20);
    expect(await usage()).toMatchObject({ usedToday: DAY, packageCredits: 30 });
    expect(await store().rollbackQuota(rolledBack)).toBe(true);
    expect(await usage()).toMatchObject({ usedToday: 0, packageCredits: 50 });

    const kept = await reserve(DAY + 20);
    expect(await store().commitQuota(kept)).toBe(true);
    expect(await usage()).toMatchObject({ usedToday: DAY, packageCredits: 30 });
    expect(await store().rollbackQuota(kept)).toBe(false);
    expect(await usage()).toMatchObject({ usedToday: DAY, packageCredits: 30 });
  });

  it('gives the credits of the package back when the lease of a reservation ends without a renewal', async () => {
    await grant(50);
    const id = await reserve(DAY + 20);
    expect(await usage()).toMatchObject({ usedToday: DAY, packageCredits: 30 });
    await controls.advance(RESERVATION_LEASE.provisionalMs + 1000);
    expect(await usage()).toMatchObject({ usedToday: 0, packageCredits: 50 });
    expect(await store().commitQuota(id)).toBe(false);
    expect(await usage()).toMatchObject({ usedToday: 0, packageCredits: 50 });
  });

  it('gives the package credits of an ended lease back at the next touch of the balance, also when the day of the reservation is over', async () => {
    await grant(100);
    await store().commitQuota(await reserve(DAY));
    await reserve(4);
    expect(await usage()).toMatchObject({ usedToday: DAY, packageCredits: 96 });
    // The lease ends and the UTC day changes: the window of the next read is not the window the reservation was made in.
    await controls.advance(15 * 60 * 60 * 1000);
    expect(await usage()).toMatchObject({ usedToday: 0, packageCredits: 100 });
    expect(await store().packageBalance(owner)).toBe(100);
  });

  it('gives the package credits of an ended lease back when the billing period of the subscription changed, and a lease that ends later stays held', async () => {
    // A subscription belongs to an account that exists.
    const account = await redisUserStore.createUser({ email: `ledger_${crypto.randomBytes(6).toString('hex')}@credits.test`, name: 'Ledger' });
    owner = account.id;
    await grant(100);
    const subscribe = (periodEnd: number, credits: 1000 | 2500) =>
      subscriptionStore.apply({
        eventId: `evt_${crypto.randomUUID()}`,
        eventAt: Date.now(),
        userId: owner,
        subscription: { provider: 'paddle', providerSubscriptionId: `sub_${owner}`, providerCustomerId: 'ctm_fixture', status: 'active', credits, currentPeriodEnd: periodEnd },
      });
    await subscribe(NOW + 20 * 86_400_000, 1000);
    await store().commitQuota(await reserve(1000));
    const ended = await reserve(4);
    expect(await usage()).toMatchObject({ usedToday: 1000, packageCredits: 96 });
    await controls.advance(60_000);
    const live = await reserve(3);
    await controls.advance(40_000);
    // The first lease (90 s) has ended, the second (made 40 s ago) has not.
    expect(await store().packageBalance(owner)).toBe(100 - 3 - 4);

    // The switch is billed in full and starts a new period, so the next read is on another window than the reservations.
    await subscribe(NOW + 50 * 86_400_000, 2500);
    expect(await usage()).toMatchObject({ dailyLimit: 2500, usedToday: 0, packageCredits: 100 - 3 });
    expect(await store().commitQuota(ended)).toBe(false);
    expect(await store().commitQuota(live)).toBe(true);
    expect(await store().packageBalance(owner)).toBe(100 - 3);
    await subscriptionStore.forgetUser(owner);
    await redisUserStore.deleteUser(owner);
  });

  it('refunds the package first when a reservation settles to fewer credits', async () => {
    await grant(50);
    const settled = await reserve(DAY + 20);
    expect(await store().settleQuota(settled, DAY + 8)).toEqual({ success: true, difference: -12 });
    expect(await usage()).toMatchObject({ usedToday: DAY, packageCredits: 42 });
  });

  it('refunds into the window when a settle goes below what the window gave', async () => {
    await grant(50);
    const id = await reserve(DAY + 5);
    expect(await store().settleQuota(id, 4)).toEqual({ success: true, difference: -(DAY + 1) });
    expect(await usage()).toMatchObject({ usedToday: 4, packageCredits: 50 });
  });

  it('charges the minutes beyond the first on top, from the headroom of the window first and then from the package', async () => {
    await grant(10);
    const id = await reserve(4);
    // 4 are held; 6 are left in the day, so a surcharge of 9 takes 6 from the day and 3 from the package.
    expect(await store().commitQuota(id, { extra: 9, note: { from: 'docx', to: 'pdf', base: 2, surcharge: 9 } })).toBe(true);
    expect(await usage()).toMatchObject({ usedToday: DAY, packageCredits: 7 });
    expect(await store().recentCharges(owner)).toEqual([expect.objectContaining({ from: 'docx', to: 'pdf', base: 2, surcharge: 9, credits: 13, fromPackage: 3 })]);
  });

  it('charges no more than the account holds when the surcharge is more than is left, and says what it could not charge', async () => {
    const id = await reserve(DAY - 2);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await store().commitQuota(id, { extra: 7, note: { from: 'pdf', to: 'docx', base: 4, surcharge: 7 } })).toBe(true);
    // Only 2 credits were left, no package: the day is spent in full and the other 5 are not charged.
    expect(await usage()).toMatchObject({ usedToday: DAY, packageCredits: 0, remaining: 0 });
    expect(await store().recentCharges(owner)).toEqual([expect.objectContaining({ credits: DAY, uncharged: 5 })]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('owed 5 credits more than the account had left'));
  });

  it('never charges a conversion less than its base, whatever the surcharge is', async () => {
    const id = await reserve(2);
    expect(await store().commitQuota(id, { extra: 0, note: { from: 'docx', to: 'pdf', base: 2 } })).toBe(true);
    expect(await usage()).toMatchObject({ usedToday: 2 });
    expect(await store().recentCharges(owner)).toEqual([expect.objectContaining({ credits: 2 })]);
  });

  it('holds a graph\'s extension from the window and the package, once for each extension, and ends it with the reservation', async () => {
    await grant(10);
    const id = await reserve(DAY - 1);
    expect(await store().extendQuota(id, 'node-a', 4)).toEqual({ status: 'extended' });
    expect(await usage()).toMatchObject({ usedToday: DAY, packageCredits: 7 });
    expect(await store().extendQuota(id, 'node-a', 4)).toEqual({ status: 'extended' });
    expect(await usage()).toMatchObject({ usedToday: DAY, packageCredits: 7 });
    expect(await store().extendQuota(id, 'node-b', 8)).toEqual({ status: 'does-not-fit', remaining: 7 });
    expect(await store().rollbackQuota(id)).toBe(true);
    expect(await usage()).toMatchObject({ usedToday: 0, packageCredits: 10 });
  });

  it('settles a graph to the credits its nodes charged, more than it reserved when the account holds them', async () => {
    await grant(20);
    const id = await reserve(3);
    expect(await store().settleQuota(id, DAY + 12, { note: { kind: 'graph', base: DAY + 12 } })).toEqual({ success: true, difference: DAY + 9 });
    expect(await usage()).toMatchObject({ usedToday: DAY, packageCredits: 8 });
    expect(await store().recentCharges(owner)).toEqual([expect.objectContaining({ kind: 'graph', credits: DAY + 12, fromPackage: 12 })]);
  });

  it('adds the credits of a payment once for each transaction id, and a second payment adds its own', async () => {
    expect(await grant(500, 'txn_a')).toBe('granted');
    expect(await grant(500, 'txn_a')).toBe('duplicate');
    expect(await store().packageBalance(owner)).toBe(500);
    expect(await grant(2500, 'txn_b')).toBe('granted');
    expect(await store().packageBalance(owner)).toBe(3000);
    expect((await store().withCreditTier({ id: owner, tier: 'free' })).tier).toBe('paid');
    expect(await store().packageTransactionOwner('txn_a')).toBe(owner);
  });

  it('adds the credits of a payment once when the same payment arrives at the same moment', async () => {
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => grant(1000, 'txn_race')));
    expect(outcomes.filter((outcome) => outcome === 'granted')).toHaveLength(1);
    expect(await store().packageBalance(owner)).toBe(1000);
  });

  it('takes back what is left of a refunded payment, a share of it for a partial refund, once for each adjustment, never below zero', async () => {
    await grant(1000, 'txn_a', '2000');
    const full = (adjustmentId: string) => store().revokePackage(owner, { transactionId: 'txn_a', adjustmentId, amount: '2000', full: true });
    const part = (adjustmentId: string, amount: string) => store().revokePackage(owner, { transactionId: 'txn_a', adjustmentId, amount, full: false });

    expect(await part('adj_1', '500')).toEqual({ status: 'revoked', revoked: 250, unrecovered: 0 });
    expect(await store().packageBalance(owner)).toBe(750);
    expect(await part('adj_1', '500')).toEqual({ status: 'duplicate' });
    expect(await store().packageBalance(owner)).toBe(750);

    // 600 of the 750 are spent: the rest of the payment is owed, and only the 150 left are taken back.
    const id = await reserve(DAY + 600);
    await store().commitQuota(id);
    expect(await store().packageBalance(owner)).toBe(150);
    expect(await full('adj_2')).toEqual({ status: 'revoked', revoked: 150, unrecovered: 600 });
    expect(await store().packageBalance(owner)).toBe(0);
    // What was owed and spent stays owed: a later refund of the same payment finds nothing to take back.
    expect(await full('adj_3')).toEqual({ status: 'revoked', revoked: 0, unrecovered: 600 });
    expect(await store().revokePackage(owner, { transactionId: 'txn_unknown', adjustmentId: 'adj_x', amount: '1', full: true })).toEqual({ status: 'unknown-transaction' });
  });

  it('keeps the newest charges of an account, at most the limit, newest first', async () => {
    for (let n = 1; n <= RECENT_CHARGES + 3; n++) {
      const id = await reserve(1);
      await store().commitQuota(id, { note: { from: 'png', to: 'jpg', base: n } });
      await store().rollbackQuota(id);
      vi.setSystemTime(Date.now() + 1000);
      if (n % DAY === 0) vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
    }
    const charges = await store().recentCharges(owner);
    expect(charges).toHaveLength(RECENT_CHARGES);
    expect(charges[0]).toMatchObject({ base: RECENT_CHARGES + 3 });
    expect(charges.at(-1)).toMatchObject({ base: 4 });
  });

  it('forgets the balance, the payments and the charges of an account when its usage is forgotten', async () => {
    await grant(100, 'txn_a');
    const id = await reserve(2);
    await store().commitQuota(id, { note: { from: 'png', to: 'jpg', base: 1 } });
    await store().forgetUsage(owner);
    expect(await store().packageBalance(owner)).toBe(0);
    expect(await store().recentCharges(owner)).toEqual([]);
    expect(await store().packageTransactionOwner('txn_a')).toBeNull();
    // The payment can be credited again: its record went with the account.
    expect(await grant(100, 'txn_a')).toBe('granted');
  });
}
