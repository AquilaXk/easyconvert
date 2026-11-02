import { redisKeyStore } from './redis-key-store';
import { RESERVATION_LEASE } from './reservation-ledger';

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

/**
 * Gives the reservation `reservationId` the lease of handed-off work for `holder`, once that work is known to be stored or a
 * worker took it, as a consumer extends its hold on the work it takes. The work runs either way, so a renewal that fails is
 * logged, and the reservation keeps the lease it had.
 */
export async function leaseToHandedOffWork(reservationId: string, holder: string): Promise<void> {
  try {
    if (await redisKeyStore.renewReservation(reservationId, RESERVATION_LEASE.handedOffMs)) return;
    console.error(`[Reservation] Reservation ${reservationId} of ${holder} had ended, so ${holder} is not charged.`);
  } catch (err) {
    console.error(`[Reservation] The lease of reservation ${reservationId} of ${holder} could not be extended:`, err);
  }
}
