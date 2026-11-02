import { redisKeyStore } from './redis-key-store';
import { RESERVATION_LEASE } from './reservation-ledger';
import { QueueUnavailableError } from '../types';

/**
 * How a request hands its reserved conversion units to queued work (docs/policy-decisions.md, entry 15). The queue layer
 * builds the work, and the reservation layer (`withReservedUnit` in guard.ts) decides who owns the units.
 */

/**
 * What a lookup after a failed `start` found: the work it stored, which owns the reservation; no work, for certain, so the
 * units go back at once; or nothing it can tell, since a write that lost its reply may still land.
 */
export type Recovery<T> = { status: 'started'; work: T } | { status: 'not-started' } | { status: 'unknown' };

export const RECOVERY_UNKNOWN: Recovery<never> = { status: 'unknown' };

/** The recovery of a lookup by id: the work found, or nothing it can tell, as the write may land after the lookup. */
export function foundOrUnknown<T>(work: T | undefined): Recovery<T> {
  return work === undefined ? RECOVERY_UNKNOWN : { status: 'started', work };
}

/**
 * Queued work that takes over a reservation: `start` queues it with the reservation id, and `recover` looks it up by the id
 * the caller gave it before it started, when `start` threw.
 */
export interface HandOff<T> {
  start(reservationId: string | undefined): Promise<T>;
  recover(): Promise<Recovery<T>>;
}

/** A reservation while its request runs. Each way of ending it acts once; after one, the others do nothing. */
export interface ReservedUnit {
  /** Charges the reserved units: the conversion succeeded. */
  commit(): Promise<void>;
  /**
   * Starts the queued work that will end the reservation itself (a job or a graph commits it or gives it back), with the
   * reservation id. The request stops owning the reservation once the work started, or once `recover` finds it after `start`
   * threw, and the reservation then takes the lease of handed-off work. When `recover` is sure nothing started, the request
   * gives the units back; when it cannot tell, the reservation keeps the provisional lease, which gives them back unless work
   * that was stored late renews it first.
   */
  handOff<T>(work: HandOff<T>): Promise<T>;
}

/** The engine a refused hand-off names: the reservation it needed was gone, or its lease could not be renewed. */
export const RESERVATION_ENGINE = 'reservation';

/**
 * Moves the lease of the live reservation `reservationId` to end `leaseMs` from now, when that is later; false when no live
 * lease is left. A store that fails is logged and thrown as a `QueueUnavailableError`, a store the request cannot use now.
 */
export async function renewLease(reservationId: string, leaseMs: number): Promise<boolean> {
  try {
    return await redisKeyStore.renewReservation(reservationId, leaseMs);
  } catch (err) {
    console.error(`[Reservation] The lease of reservation ${reservationId} could not be renewed:`, err);
    throw new QueueUnavailableError(RESERVATION_ENGINE, `the lease of reservation ${reservationId} could not be renewed`);
  }
}

/** Tries of the renewal to the lease of handed-off work: a renewal that throws is tried once more, at once. */
const HANDED_OFF_RENEWAL_ATTEMPTS = 2;

/**
 * Gives the reservation `reservationId` the lease of handed-off work, once that work is known to be stored or a worker took
 * it, as a consumer extends its hold on the work it takes. The work runs either way, so a renewal that throws twice is only
 * logged, and so is one that finds no live lease, as a warning: work that committed fast, a graph that already settled, or a
 * reservation made before leases.
 */
export async function leaseToHandedOffWork(reservationId: string): Promise<void> {
  for (let attempt = 1; attempt <= HANDED_OFF_RENEWAL_ATTEMPTS; attempt++) {
    const renewed = await renewLease(reservationId, RESERVATION_LEASE.handedOffMs).catch(() => undefined);
    if (renewed === undefined) continue;
    if (!renewed) console.warn(`[Reservation] No live lease to renew for ${reservationId}.`);
    return;
  }
}
