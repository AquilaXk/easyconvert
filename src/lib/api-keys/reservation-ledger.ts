import crypto from 'node:crypto';
import type Redis from 'ioredis';
import {
  COMMIT_QUOTA_LUA_SCRIPT,
  EXTEND_QUOTA_LUA_SCRIPT,
  RENEW_QUOTA_LUA_SCRIPT,
  RESERVE_QUOTA_LUA_SCRIPT,
  ROLLBACK_QUOTA_LUA_SCRIPT,
  SETTLE_QUOTA_LUA_SCRIPT,
  USED_QUOTA_LUA_SCRIPT,
} from './quota-lua-scripts';
import { JOB_DEADLINE_CEILING_MS } from '../config/schema';

/**
 * Where the conversion units of a day are reserved, charged and given back (docs/policy-decisions.md, entry 15): in Redis
 * beside the other quota counters, or in this process when the quota store has no Redis. Both keep one count per owner and
 * UTC day, which holds what is charged and what is reserved.
 *
 * A reservation is a lease, as a lock service leases a lock to the process that holds it: it counts until it is committed,
 * settled or given back, or until its lease ends, which gives its units back. A request holds a short lease and renews it
 * while it runs, so the unit of a process that dies is back within RESERVATION_LEASE.provisionalMs; the queued work it hands
 * the reservation to (a job or a graph) holds a long one, since the queue reports every end of that work. Every step is
 * written against the day the reservation was made on, which its id names, so work that ends after midnight is charged,
 * settled or given back on that day, as a request is billed to the period it arrived in.
 */

const HOUR_MS = 60 * 60 * 1000;

/**
 * The lifetimes of a reservation's lease. The holder renews a provisional lease every third of its length, as a lease client
 * keeps a lease alive (etcd's client sends a keep-alive every TTL/3), so one missed renewal does not end it. A handed-off
 * lease outlasts the longest queued work: a day, and at least an hour past the longest deadline a job may be given
 * (JOB_DEADLINE_CEILING_MS, the bound of every deadline setting); it is the backstop for work whose end is never reported.
 */
export const RESERVATION_LEASE = {
  provisionalMs: 90_000,
  heartbeatMs: 30_000,
  handedOffMs: Math.max(24 * HOUR_MS, JOB_DEADLINE_CEILING_MS + HOUR_MS),
} as const;

/** What `extend` did: held the units, refused them because they do not fit in the day (with the conversions left), or found no reservation. */
export type QuotaExtension = { status: 'extended' } | { status: 'does-not-fit'; remaining: number } | { status: 'no-reservation' };

/** How `renew` moves a lease: only to a later end (`extend`), or to the end it names, sooner or later (`set`). */
export type LeaseChange = 'extend' | 'set';

/**
 * The steps on reservations. Every lease is given as a duration from now, and each ledger reads now from one clock: the
 * clock of the Redis server, or this process's clock for the ledger of this process.
 */
export interface ReservationLedger {
  /** Reserves `units` of `owner`'s `day` under `limit` as `reservationId`, leased for `leaseMs`; answers the units left. */
  reserve(request: { owner: string; day: string; dayLeftMs: number; reservationId: string; units: number; limit: number; leaseMs: number }): Promise<{ allowed: boolean; remaining: number }>;
  /** Ends a live reservation and keeps its units charged; false when it is gone. */
  commit(reservationId: string): Promise<boolean>;
  /** Gives the units of a live reservation back; false when it is gone. */
  rollback(reservationId: string): Promise<boolean>;
  /** Ends a live reservation charging `units` in place of those it held. */
  settle(reservationId: string, units: number): Promise<{ success: boolean; difference: number }>;
  /** Holds what the extension `extensionId` holds in all, `units`, in a live reservation, under `limit`. */
  extend(reservationId: string, extensionId: string, units: number, limit: number): Promise<QuotaExtension>;
  /** Moves the lease of a live reservation to end `leaseMs` from now, as `change` says; false when it is gone. */
  renew(reservationId: string, leaseMs: number, change: LeaseChange): Promise<boolean>;
  /** The units counted on `owner`'s `day`, once the leases that ended gave theirs back. */
  used(owner: string, day: string): Promise<number>;
}

/** The id of a reservation: `res_<encoded userId>_<YYYY-MM-DD>_<ms>_<random>`, which names its owner and its day. */
export function reservationIdOf(userId: string, day: string): string {
  return `res_${encodeURIComponent(userId)}_${day}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}

/** The owner and day a reservation id names, read from the right: the encoded user id is everything in between. */
export function parseReservationId(reservationId: string): { userId: string; day: string } | undefined {
  const parts = reservationId.split('_');
  if (parts.length < 5 || parts[0] !== 'res') return undefined;
  const named = { userId: decodeURIComponent(parts.slice(1, -3).join('_')), day: parts[parts.length - 3] };
  return named.userId && named.day ? named : undefined;
}

const EXTENSION_STATUS: Readonly<Record<string, QuotaExtension['status']>> = { '1': 'extended', '0': 'does-not-fit', '-1': 'no-reservation' };

/** The keys a step on one reservation reads: those of its day, its extensions, and its key from before leases. */
interface ReservationKeys {
  day: [string, string, string];
  extensions: string;
  beforeLeases: string;
}

/** The ledger every web and worker instance shares: one Lua script per step (quota-lua-scripts.ts). */
export class RedisReservationLedger implements ReservationLedger {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string
  ) {}

  /** The keys of `owner`'s `day`: its count, its leases and the units they hold. */
  private dayKeys(owner: string, day: string): [string, string, string] {
    return [`${this.prefix}usage:{${owner}}:${day}`, `${this.prefix}leases:{${owner}}:${day}`, `${this.prefix}held:{${owner}}:${day}`];
  }

  /** The keys of the reservation `reservationId`; undefined for an id of another form. */
  private keysOf(reservationId: string): ReservationKeys | undefined {
    const named = parseReservationId(reservationId);
    if (!named) return undefined;
    const reservationKey = `${this.prefix}res:{${named.userId}}:${reservationId}`;
    return { day: this.dayKeys(named.userId, named.day), extensions: `${reservationKey}:ext`, beforeLeases: reservationKey };
  }

  /** Runs `script` on the keys of the day of `reservationId` and `fourth`; undefined for an id of another form. */
  private async onReservation(script: string, reservationId: string, fourth: keyof Omit<ReservationKeys, 'day'>, ...args: Array<string | number>): Promise<unknown> {
    const keys = this.keysOf(reservationId);
    if (!keys) return undefined;
    return this.redis.eval(script, 4, ...keys.day, keys[fourth], reservationId, ...args);
  }

  async reserve(request: Parameters<ReservationLedger['reserve']>[0]) {
    const args = [request.units, request.limit, request.reservationId, request.leaseMs, request.dayLeftMs];
    const [allowed, remaining] = (await this.redis.eval(RESERVE_QUOTA_LUA_SCRIPT, 3, ...this.dayKeys(request.owner, request.day), ...args)) as [number, number];
    return { allowed: Number(allowed) === 1, remaining: Number(remaining) };
  }

  async commit(reservationId: string): Promise<boolean> {
    return Number(await this.onReservation(COMMIT_QUOTA_LUA_SCRIPT, reservationId, 'beforeLeases')) === 1;
  }

  async rollback(reservationId: string): Promise<boolean> {
    return Number(await this.onReservation(ROLLBACK_QUOTA_LUA_SCRIPT, reservationId, 'beforeLeases')) === 1;
  }

  async settle(reservationId: string, units: number) {
    const reply = (await this.onReservation(SETTLE_QUOTA_LUA_SCRIPT, reservationId, 'beforeLeases', units)) as [number, number] | undefined;
    if (!reply) return { success: false, difference: 0 };
    return { success: Number(reply[0]) === 1, difference: Number(reply[1]) };
  }

  async extend(reservationId: string, extensionId: string, units: number, limit: number): Promise<QuotaExtension> {
    const reply = (await this.onReservation(EXTEND_QUOTA_LUA_SCRIPT, reservationId, 'extensions', extensionId, units, limit)) as [number, number] | undefined;
    if (!reply) return { status: 'no-reservation' };
    const outcome = EXTENSION_STATUS[String(reply[0])];
    if (outcome === undefined) throw new Error(`The extension script of reservation ${reservationId} answered the unknown status ${String(reply[0])}.`);
    return outcome === 'does-not-fit' ? { status: outcome, remaining: Math.max(0, Number(reply[1])) } : { status: outcome };
  }

  async renew(reservationId: string, leaseMs: number, change: LeaseChange): Promise<boolean> {
    return Number(await this.onReservation(RENEW_QUOTA_LUA_SCRIPT, reservationId, 'extensions', leaseMs, change)) === 1;
  }

  async used(owner: string, day: string): Promise<number> {
    return Number(await this.redis.eval(USED_QUOTA_LUA_SCRIPT, 3, ...this.dayKeys(owner, day)));
  }
}

/** A reservation this process holds. */
interface HeldReservation {
  units: number;
  /** The `<owner>:<day>` count it is counted in. */
  dateKey: string;
  leaseUntil: number;
  /** The units each extension added, by extension id. */
  extensions: Record<string, number>;
}

/**
 * The ledger of one process, for a deployment without Redis. The counts are the key store's day counts, which it persists;
 * `persist` writes them after a change. The steps run between two awaits, so they never interleave. Now is this process's
 * clock, the only one its reservations are seen by.
 */
export class MemoryReservationLedger implements ReservationLedger {
  private readonly reservations = new Map<string, HeldReservation>();

  constructor(
    private readonly counts: Map<string, number>,
    private readonly persist: () => void
  ) {}

  /** Forgets every reservation, as a reset of the key store forgets its counts. */
  clear(): void {
    this.reservations.clear();
  }

  /** Gives back the units of every lease that ended by `now`; answers how many it gave back. */
  reclaim(now: number = Date.now()): number {
    let reclaimed = 0;
    for (const [id, reservation] of this.reservations) {
      if (reservation.leaseUntil > now) continue;
      this.charge(reservation.dateKey, -reservation.units);
      this.reservations.delete(id);
      reclaimed++;
    }
    if (reclaimed > 0) this.persist();
    return reclaimed;
  }

  /** Charges `difference` more units to the count `dateKey`; a count that is gone (its day removed) is not made again. */
  private charge(dateKey: string, difference: number): void {
    const used = this.counts.get(dateKey);
    if (used === undefined || difference === 0) return;
    this.counts.set(dateKey, Math.max(0, used + difference));
  }

  /** The live reservation `reservationId`, after the leases that ended gave their units back. */
  private live(reservationId: string): HeldReservation | undefined {
    this.reclaim();
    return this.reservations.get(reservationId);
  }

  /** Ends the live reservation `reservationId`, charging its count `difference(units held)` more; undefined when it is gone. */
  private end(reservationId: string, difference: (held: HeldReservation) => number): number | undefined {
    const reservation = this.live(reservationId);
    if (!reservation) return undefined;
    const charged = difference(reservation);
    this.charge(reservation.dateKey, charged);
    this.reservations.delete(reservationId);
    this.persist();
    return charged;
  }

  async reserve(request: Parameters<ReservationLedger['reserve']>[0]) {
    this.reclaim();
    const dateKey = `${request.owner}:${request.day}`;
    const used = this.counts.get(dateKey) ?? 0;
    if (used + request.units > request.limit) return { allowed: false, remaining: Math.max(0, request.limit - used) };
    this.counts.set(dateKey, used + request.units);
    this.reservations.set(request.reservationId, { units: request.units, dateKey, leaseUntil: Date.now() + request.leaseMs, extensions: {} });
    this.persist();
    return { allowed: true, remaining: request.limit - used - request.units };
  }

  async commit(reservationId: string): Promise<boolean> {
    return this.end(reservationId, () => 0) !== undefined;
  }

  async rollback(reservationId: string): Promise<boolean> {
    return this.end(reservationId, (held) => -held.units) !== undefined;
  }

  async settle(reservationId: string, units: number) {
    const difference = this.end(reservationId, (held) => units - held.units);
    return difference === undefined ? { success: false, difference: 0 } : { success: true, difference };
  }

  async extend(reservationId: string, extensionId: string, units: number, limit: number): Promise<QuotaExtension> {
    const reservation = this.live(reservationId);
    // As the script in Redis: a reservation whose day's count is gone is not extended, and no count is made.
    const used = this.counts.get(reservation?.dateKey ?? '');
    if (!reservation || used === undefined) return { status: 'no-reservation' };
    const added = units - (reservation.extensions[extensionId] ?? 0);
    if (added <= 0) return { status: 'extended' };
    if (used + added > limit) return { status: 'does-not-fit', remaining: Math.max(0, limit - used) };
    this.counts.set(reservation.dateKey, used + added);
    reservation.units += added;
    reservation.extensions[extensionId] = units;
    this.persist();
    return { status: 'extended' };
  }

  async renew(reservationId: string, leaseMs: number, change: LeaseChange): Promise<boolean> {
    const reservation = this.live(reservationId);
    if (!reservation) return false;
    const leaseUntil = Date.now() + leaseMs;
    reservation.leaseUntil = change === 'set' ? leaseUntil : Math.max(reservation.leaseUntil, leaseUntil);
    return true;
  }

  async used(owner: string, day: string): Promise<number> {
    this.reclaim();
    return this.counts.get(`${owner}:${day}`) ?? 0;
  }
}
