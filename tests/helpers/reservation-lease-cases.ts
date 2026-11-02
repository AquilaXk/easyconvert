import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RedisKeyStore } from '../../src/lib/api-keys/redis-key-store';
import { RESERVATION_LEASE } from '../../src/lib/api-keys/reservation-ledger';

/**
 * How a reservation lives (docs/policy-decisions.md, entry 15): as a lease that gives its units back once its holder stops
 * renewing it, and on the UTC day it was made, also when it ends after midnight. The same cases run on the ledger of this
 * process and on a real Redis server.
 */

const MINUTE_MS = 60_000;
const BEFORE_MIDNIGHT = Date.parse('2026-11-02T23:59:30.000Z');
const LATE_ON_THAT_DAY = Date.parse('2026-11-02T23:59:59.000Z');

export interface LeaseCaseControls {
  /** The store the cases reserve in, and the owner whose day they use. */
  store: () => RedisKeyStore;
  owner: () => string;
  /** Lets `ms` pass for the store: the clock, and in Redis the time to live of the owner's keys. */
  advance: (ms: number) => Promise<void>;
}

export function itLeasesReservations(controls: LeaseCaseControls): void {
  const used = async () => (await controls.store().getQuotaUsage(controls.owner())).usedToday;

  /** The units charged to the day of BEFORE_MIDNIGHT, read late on that day and then back at the time it was. */
  async function usedOnTheDayOfTheReservation(): Promise<number> {
    const now = Date.now();
    vi.setSystemTime(LATE_ON_THAT_DAY);
    const charged = await used();
    vi.setSystemTime(now);
    return charged;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: BEFORE_MIDNIGHT - 60 * MINUTE_MS });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives the units of a reservation back once its lease ends without a renewal, long before midnight', async () => {
    const unit = await controls.store().reserveQuota(controls.owner(), 2);
    expect(unit.allowed).toBe(true);
    expect(await used()).toBe(2);

    await controls.advance(RESERVATION_LEASE.provisionalMs + 1000);

    expect(await used()).toBe(0);
    expect(await controls.store().commitQuota(unit.reservationId as string)).toBe(false);
    expect(await used()).toBe(0);
  });

  it('keeps a reservation its holder renews past the provisional lease, and charges it on commit', async () => {
    const unit = await controls.store().reserveQuota(controls.owner(), 1);
    for (let beat = 0; beat < 4; beat++) {
      await controls.advance(RESERVATION_LEASE.heartbeatMs);
      expect(await controls.store().renewReservation(unit.reservationId as string, RESERVATION_LEASE.provisionalMs)).toBe(true);
    }
    expect(await used()).toBe(1);

    expect(await controls.store().commitQuota(unit.reservationId as string)).toBe(true);
    await controls.advance(10 * MINUTE_MS);
    expect(await used()).toBe(1);
  });

  it('settles a handed-off reservation that ends after midnight on the day it was made', async () => {
    vi.setSystemTime(BEFORE_MIDNIGHT);
    const unit = await controls.store().reserveQuota(controls.owner(), 2);
    await controls.store().renewReservation(unit.reservationId as string, RESERVATION_LEASE.handedOffMs);

    await controls.advance(40 * MINUTE_MS);

    expect(await controls.store().settleQuota(unit.reservationId as string, 1)).toEqual({ success: true, difference: -1 });
    expect(await used()).toBe(0);
    expect(await usedOnTheDayOfTheReservation()).toBe(1);
  });

  it('extends and gives back a handed-off reservation after midnight against the day it was made', async () => {
    vi.setSystemTime(BEFORE_MIDNIGHT);
    const unit = await controls.store().reserveQuota(controls.owner(), 1);
    await controls.store().renewReservation(unit.reservationId as string, RESERVATION_LEASE.handedOffMs);

    await controls.advance(40 * MINUTE_MS);

    expect(await controls.store().extendQuota(unit.reservationId as string, 'conv', 2)).toEqual({ status: 'extended' });
    expect(await usedOnTheDayOfTheReservation()).toBe(3);
    expect(await controls.store().rollbackQuota(unit.reservationId as string)).toBe(true);
    expect(await usedOnTheDayOfTheReservation()).toBe(0);
    expect(await used()).toBe(0);
  });

  it('refuses a renewal of a reservation that ended', async () => {
    const unit = await controls.store().reserveQuota(controls.owner(), 1);
    await controls.store().rollbackQuota(unit.reservationId as string);

    expect(await controls.store().renewReservation(unit.reservationId as string, RESERVATION_LEASE.handedOffMs)).toBe(false);
    expect(await used()).toBe(0);
  });
}
