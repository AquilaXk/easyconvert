import crypto from 'node:crypto';
import type Redis from 'ioredis';
import { JOB_DEADLINE_CEILING_MS } from '../config/schema';
import {
  EXTEND_QUOTA_LUA_SCRIPT,
  GRANT_PACKAGE_LUA_SCRIPT,
  RENEW_QUOTA_LUA_SCRIPT,
  RESERVE_QUOTA_LUA_SCRIPT,
  REVOKE_PACKAGE_LUA_SCRIPT,
  SETTLE_TO_QUOTA_LUA_SCRIPT,
  USED_QUOTA_LUA_SCRIPT,
} from './quota-lua-scripts';
import type { ChargeEntry, ChargeNote } from './types';

/**
 * Where the credits of an owner are reserved, charged and given back (docs/policy-decisions.md, entries 15 and 285): in Redis
 * beside the other quota counters, or in this process when the quota store has no Redis. Both keep one count per owner and
 * window (the UTC day of the free plan, the billing period of a subscription), which holds what is charged and what is reserved,
 * and one package balance per owner, which has no window. A reservation draws on the window first and on the balance for the rest;
 * a refund goes back to the balance first.
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
 * sends a keep-alive every third of the lease's time to live, so one missed renewal does not end it. A handed-off lease is a
 * day, at least an hour past the longest deadline a job may be given (JOB_DEADLINE_CEILING_MS, the bound of every deadline
 * setting, which this module checks when it loads); it is the backstop for work whose end is never reported.
 */
export const RESERVATION_LEASE = {
  provisionalMs: 90_000,
  heartbeatMs: 30_000,
  handedOffMs: 24 * HOUR_MS,
} as const;

if (RESERVATION_LEASE.handedOffMs - JOB_DEADLINE_CEILING_MS < HOUR_MS) {
  throw new Error(`The lease of handed-off work (${RESERVATION_LEASE.handedOffMs} ms) must outlast the longest job deadline (${JOB_DEADLINE_CEILING_MS} ms) by an hour.`);
}

/** What `extend` did: held the units, refused them because they do not fit in what the owner can spend (with the credits left), or found no reservation. */
export type QuotaExtension = { status: 'extended' } | { status: 'does-not-fit'; remaining: number } | { status: 'no-reservation' };

/** What ending a reservation did: whether it was live, the credits charged more than it held (fewer when negative), and the credits that were owed and could not be charged. */
export interface Settlement {
  success: boolean;
  difference: number;
  uncharged: number;
}

/** What more a reservation is charged when it ends: credits on top (the minute surcharge), held to the window the reservation was made in, and the note that joins the list of recent charges. */
export interface ChargeOptions {
  extra?: number;
  note?: ChargeNote;
}

/** What the ledger holds of one owner: the window's count and the package balance. */
export interface LedgerCounts {
  used: number;
  packageCredits: number;
}

/** What a package payment did to the balance: credited once, or already credited. */
export type PackageGrantOutcome = 'granted' | 'duplicate';

/** What a refund of a package payment did: the credits taken back, the credits that were owed back and are already spent, or why nothing was taken. */
export type PackageRevokeOutcome = { status: 'revoked'; revoked: number; unrecovered: number } | { status: 'duplicate' } | { status: 'unknown-transaction' };

/** A refund of a package payment: the amount returned in the lowest unit of the currency, and whether it is the whole payment. */
export interface PackageRefundRequest {
  transactionId: string;
  adjustmentId: string;
  amount: string;
  full: boolean;
}

export interface PackageGrant {
  transactionId: string;
  credits: number;
  /** What the customer paid in all, in the lowest unit of the currency, for the share of a refund. */
  paid: string;
  at: number;
}

/**
 * The steps on reservations. Every lease is given as a duration from now, and each ledger reads now from one clock: the
 * clock of the Redis server, or this process's clock for the ledger of this process.
 */
export interface ReservationLedger {
  /** Reserves `units` of `owner`'s `day` under `limit` as `reservationId`, leased for `leaseMs`, from the window and then the package balance; answers the credits left in both. */
  reserve(request: { owner: string; day: string; dayLeftMs: number; reservationId: string; units: number; limit: number; leaseMs: number }): Promise<{ allowed: boolean; remaining: number }>;
  /** Ends a live reservation and keeps its units charged, with what `charge` adds on top; `success` is false when it is gone. */
  commit(reservationId: string, charge?: ChargeOptions): Promise<Settlement>;
  /** Gives the units of a live reservation back; false when it is gone. */
  rollback(reservationId: string): Promise<boolean>;
  /** Ends a live reservation charging `units` in place of those it held, with what `charge` adds on top. */
  settle(reservationId: string, units: number, charge?: ChargeOptions): Promise<Settlement>;
  /** Holds what the extension `extensionId` holds in all, `units`, in a live reservation, under `limit` and the package balance. */
  extend(reservationId: string, extensionId: string, units: number, limit: number): Promise<QuotaExtension>;
  /** Moves the lease of a live reservation to end `leaseMs` from now, when that is later; false when it is gone. */
  renew(reservationId: string, leaseMs: number): Promise<boolean>;
  /** The units counted on `owner`'s `day` and the package balance, once the leases that ended gave theirs back. */
  used(owner: string, day: string): Promise<LedgerCounts>;
  /** Adds the credits of a paid package payment to the balance, once for each transaction id. */
  grantPackage(owner: string, grant: PackageGrant): Promise<PackageGrantOutcome>;
  /** Takes back the unused credits of a refunded package payment: all that is left of it for a full refund, else the share of it that `amount` is of what was paid, once for each adjustment id. */
  revokePackage(owner: string, refund: PackageRefundRequest): Promise<PackageRevokeOutcome>;
  /** The newest charges of `owner`, newest first. */
  recentCharges(owner: string): Promise<ChargeEntry[]>;
  /** Remembers which account a package payment belongs to, so that a refund event, which names only the payment, finds it. */
  rememberTransactionOwner(transactionId: string, owner: string): Promise<void>;
  /** The account a package payment was credited to, or null. */
  transactionOwner(transactionId: string): Promise<string | null>;
  /** The package balance of `owner`. */
  packageBalance(owner: string): Promise<number>;
  /** Deletes the package balance, payments, adjustments, charges and payment index entries of `owner`; the erasure of an account calls it. */
  forgetPackages(owner: string): Promise<void>;
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

/** The keys every step on one reservation is given: those of its window, the package balance, its extensions and the list of charges. */
type ReservationKeys = [usage: string, leases: string, held: string, packageHeld: string, pool: string, extensions: string, log: string];

/** How many recent charges an owner keeps; the settle script trims its list to this. */
export const RECENT_CHARGES = 50;

/** The ledger every web and worker instance shares: one Lua script per step (quota-lua-scripts.ts). */
export class RedisReservationLedger implements ReservationLedger {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string
  ) {}

  /** The keys of `owner`'s `window`: its count, its leases, the units they hold from it and from the package balance, and the balance itself. */
  private windowKeys(owner: string, window: string): [string, string, string, string, string] {
    return [
      `${this.prefix}usage:{${owner}}:${window}`,
      `${this.prefix}leases:{${owner}}:${window}`,
      `${this.prefix}held:{${owner}}:${window}`,
      `${this.prefix}pheld:{${owner}}:${window}`,
      this.poolKey(owner),
    ];
  }

  private poolKey(owner: string): string {
    return `${this.prefix}credits:{${owner}}`;
  }

  private logKey(owner: string): string {
    return `${this.prefix}credits:{${owner}}:log`;
  }

  private transactionsKey(owner: string): string {
    return `${this.prefix}credits:{${owner}}:txns`;
  }

  private adjustmentsKey(owner: string): string {
    return `${this.prefix}credits:{${owner}}:adj`;
  }

  /** The keys of the reservation `reservationId`; undefined for an id of another form. */
  private keysOf(reservationId: string): ReservationKeys | undefined {
    const named = parseReservationId(reservationId);
    if (!named) return undefined;
    return [...this.windowKeys(named.userId, named.day), `${this.prefix}res:{${named.userId}}:${reservationId}:ext`, this.logKey(named.userId)];
  }

  /** Runs `script` on the keys of `reservationId`; undefined for an id of another form. */
  private async onReservation(script: string, reservationId: string, ...args: Array<string | number>): Promise<unknown> {
    const keys = this.keysOf(reservationId);
    if (!keys) return undefined;
    return this.redis.eval(script, keys.length, ...keys, reservationId, ...args);
  }

  /** Ends `reservationId`, charging `units` in its place or keeping what it held, and what `charge` adds (`SETTLE_TO_QUOTA_LUA_SCRIPT`). */
  private async settleTo(reservationId: string, units: number | 'held', charge: ChargeOptions = {}): Promise<Settlement> {
    const entry = charge.note ? JSON.stringify(charge.note) : '';
    const reply = (await this.onReservation(SETTLE_TO_QUOTA_LUA_SCRIPT, reservationId, units, charge.extra ?? 0, entry)) as [number, number, number] | undefined;
    if (!reply) return { success: false, difference: 0, uncharged: 0 };
    return { success: Number(reply[0]) === 1, difference: Number(reply[1]), uncharged: Number(reply[2]) };
  }

  async reserve(request: Parameters<ReservationLedger['reserve']>[0]) {
    const args = [request.units, request.limit, request.reservationId, request.leaseMs, request.dayLeftMs];
    const [allowed, remaining] = (await this.redis.eval(RESERVE_QUOTA_LUA_SCRIPT, 5, ...this.windowKeys(request.owner, request.day), ...args)) as [number, number];
    return { allowed: Number(allowed) === 1, remaining: Number(remaining) };
  }

  async commit(reservationId: string, charge?: ChargeOptions) {
    return this.settleTo(reservationId, 'held', charge);
  }

  async rollback(reservationId: string): Promise<boolean> {
    return (await this.settleTo(reservationId, 0)).success;
  }

  async settle(reservationId: string, units: number, charge?: ChargeOptions) {
    return this.settleTo(reservationId, units, charge);
  }

  async extend(reservationId: string, extensionId: string, units: number, limit: number): Promise<QuotaExtension> {
    const reply = (await this.onReservation(EXTEND_QUOTA_LUA_SCRIPT, reservationId, extensionId, units, limit)) as [number, number] | undefined;
    if (!reply) return { status: 'no-reservation' };
    const outcome = EXTENSION_STATUS[String(reply[0])];
    if (outcome === undefined) throw new Error(`The extension script of reservation ${reservationId} answered the unknown status ${String(reply[0])}.`);
    return outcome === 'does-not-fit' ? { status: outcome, remaining: Math.max(0, Number(reply[1])) } : { status: outcome };
  }

  async renew(reservationId: string, leaseMs: number): Promise<boolean> {
    return Number(await this.onReservation(RENEW_QUOTA_LUA_SCRIPT, reservationId, leaseMs)) === 1;
  }

  async used(owner: string, day: string): Promise<LedgerCounts> {
    const [used, packageCredits] = (await this.redis.eval(USED_QUOTA_LUA_SCRIPT, 5, ...this.windowKeys(owner, day))) as [number, number];
    return { used: Number(used), packageCredits: Number(packageCredits) };
  }

  async grantPackage(owner: string, grant: PackageGrant): Promise<PackageGrantOutcome> {
    const reply = (await this.redis.eval(GRANT_PACKAGE_LUA_SCRIPT, 2, this.poolKey(owner), this.transactionsKey(owner), grant.transactionId, grant.credits, grant.paid, grant.at)) as [number, number];
    return Number(reply[0]) === 1 ? 'granted' : 'duplicate';
  }

  async revokePackage(owner: string, refund: PackageRefundRequest): Promise<PackageRevokeOutcome> {
    const reply = (await this.redis.eval(REVOKE_PACKAGE_LUA_SCRIPT, 3, this.poolKey(owner), this.transactionsKey(owner), this.adjustmentsKey(owner), refund.transactionId, refund.adjustmentId, refund.amount, refund.full ? 1 : 0)) as [number, number, number];
    const status = Number(reply[0]);
    if (status === 1) return { status: 'revoked', revoked: Number(reply[1]), unrecovered: Number(reply[2]) };
    return { status: status === 0 ? 'duplicate' : 'unknown-transaction' };
  }

  async recentCharges(owner: string): Promise<ChargeEntry[]> {
    const raws = await this.redis.lrange(this.logKey(owner), 0, RECENT_CHARGES - 1);
    return raws.map((raw) => JSON.parse(raw) as ChargeEntry);
  }

  async rememberTransactionOwner(transactionId: string, owner: string): Promise<void> {
    await this.redis.set(`${this.prefix}credits:txnowner:${transactionId}`, owner);
  }

  async transactionOwner(transactionId: string): Promise<string | null> {
    return this.redis.get(`${this.prefix}credits:txnowner:${transactionId}`);
  }

  async packageBalance(owner: string): Promise<number> {
    return Number((await this.redis.get(this.poolKey(owner))) ?? 0);
  }

  async forgetPackages(owner: string): Promise<void> {
    const transactionIds = await this.redis.hkeys(this.transactionsKey(owner));
    const indexKeys = transactionIds.map((id) => `${this.prefix}credits:txnowner:${id}`);
    await this.redis.del(this.poolKey(owner), this.logKey(owner), this.transactionsKey(owner), this.adjustmentsKey(owner), ...indexKeys);
  }
}

/** A reservation this process holds. */
interface HeldReservation {
  /** The units it holds from the window's count. */
  units: number;
  /** The units it holds from the owner's package balance. */
  packed: number;
  owner: string;
  /** The `<owner>:<day>` count it is counted in, and the limit of that window when the reservation was made. */
  dateKey: string;
  limit: number;
  leaseUntil: number;
  /** The units each extension added, by extension id. */
  extensions: Record<string, number>;
}

/** What this process holds of one owner's package credits, as the keys of `credits:{owner}` do in Redis. */
interface MemoryPackages {
  balance: number;
  payments: Map<string, { credits: number; paid: string; revoked: number; at: number }>;
  adjustments: Map<string, number>;
  charges: ChargeEntry[];
}

/**
 * The ledger of one process, for a deployment without Redis. The window counts are the key store's, which it persists;
 * `persist` writes them after a change. The package balances and payments live in this process only, like the subscriptions of
 * the subscription store. The steps run between two awaits, so they never interleave. Now is this process's clock, the only one its
 * reservations are seen by.
 */
export class MemoryReservationLedger implements ReservationLedger {
  private readonly reservations = new Map<string, HeldReservation>();
  private readonly packages = new Map<string, MemoryPackages>();
  private readonly transactionOwners = new Map<string, string>();

  constructor(
    private readonly counts: Map<string, number>,
    private readonly persist: () => void
  ) {}

  /** Forgets every reservation and package, as a reset of the key store forgets its counts. */
  clear(): void {
    this.reservations.clear();
    this.packages.clear();
    this.transactionOwners.clear();
  }

  /** Forgets every reservation, package balance, payment and charge of `owner`. */
  forgetOwner(owner: string): void {
    for (const [id, reservation] of this.reservations) {
      if (reservation.owner === owner) this.reservations.delete(id);
    }
    this.packages.delete(owner);
    for (const [transactionId, holder] of this.transactionOwners) {
      if (holder === owner) this.transactionOwners.delete(transactionId);
    }
  }

  /** Gives back the units of every lease that ended by `now`; answers how many it gave back. */
  reclaim(now: number = Date.now()): number {
    let reclaimed = 0;
    for (const [id, reservation] of this.reservations) {
      if (reservation.leaseUntil > now) continue;
      this.charge(reservation.dateKey, -reservation.units);
      this.chargePackage(reservation.owner, -reservation.packed);
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

  /** Charges `difference` more units to the package balance of `owner`; a balance that was never made is not made by a refund. */
  private chargePackage(owner: string, difference: number): void {
    const held = this.packages.get(owner);
    if (held === undefined || difference === 0) return;
    held.balance = Math.max(0, held.balance - difference);
  }

  private balanceOf(owner: string): number {
    return this.packages.get(owner)?.balance ?? 0;
  }

  /** The window's headroom under `limit` and the package balance: what an owner can still spend from each. */
  private room(dateKey: string, owner: string, limit: number): { free: number; balance: number } {
    return { free: Math.max(0, limit - (this.counts.get(dateKey) ?? 0)), balance: this.balanceOf(owner) };
  }

  /** The live reservation `reservationId`, after the leases that ended gave their units back. */
  private live(reservationId: string): HeldReservation | undefined {
    this.reclaim();
    return this.reservations.get(reservationId);
  }

  /** Ends the live reservation `reservationId` as `SETTLE_TO_QUOTA_LUA_SCRIPT` does; success false when it is gone. */
  private end(reservationId: string, units: number | 'held', charge: ChargeOptions = {}): Settlement {
    const reservation = this.live(reservationId);
    if (!reservation) return { success: false, difference: 0, uncharged: 0 };
    this.reservations.delete(reservationId);
    const heldTotal = reservation.units + reservation.packed;
    const target = (units === 'held' ? heldTotal : units) + (charge.extra ?? 0);
    let window = reservation.units;
    let packed = reservation.packed;
    let uncharged = 0;
    if (target <= heldTotal) {
      window = Math.min(reservation.units, target);
      packed = target - window;
    } else {
      const more = target - heldTotal;
      const { free, balance } = this.room(reservation.dateKey, reservation.owner, reservation.limit);
      const addWindow = Math.min(more, free);
      const addPackage = Math.min(more - addWindow, balance);
      window += addWindow;
      packed += addPackage;
      uncharged = more - addWindow - addPackage;
    }
    this.charge(reservation.dateKey, window - reservation.units);
    this.chargePackage(reservation.owner, packed - reservation.packed);
    if (charge.note && window + packed > 0) {
      const held = this.packages.get(reservation.owner) ?? this.newPackages(reservation.owner);
      held.charges.unshift({ ...charge.note, at: Date.now(), credits: window + packed, fromPackage: packed, ...(uncharged > 0 ? { uncharged } : {}) });
      held.charges.length = Math.min(held.charges.length, RECENT_CHARGES);
    }
    this.persist();
    return { success: true, difference: window + packed - heldTotal, uncharged };
  }

  private newPackages(owner: string): MemoryPackages {
    const created: MemoryPackages = { balance: 0, payments: new Map(), adjustments: new Map(), charges: [] };
    this.packages.set(owner, created);
    return created;
  }

  async reserve(request: Parameters<ReservationLedger['reserve']>[0]) {
    this.reclaim();
    const dateKey = `${request.owner}:${request.day}`;
    const { free, balance } = this.room(dateKey, request.owner, request.limit);
    const fromWindow = Math.min(request.units, free);
    const fromPackage = request.units - fromWindow;
    if (fromPackage > balance) return { allowed: false, remaining: free + balance };
    if (fromWindow > 0) this.counts.set(dateKey, (this.counts.get(dateKey) ?? 0) + fromWindow);
    this.chargePackage(request.owner, fromPackage);
    this.reservations.set(request.reservationId, {
      units: fromWindow,
      packed: fromPackage,
      owner: request.owner,
      dateKey,
      limit: request.limit,
      leaseUntil: Date.now() + request.leaseMs,
      extensions: {},
    });
    this.persist();
    return { allowed: true, remaining: free + balance - request.units };
  }

  async commit(reservationId: string, charge?: ChargeOptions): Promise<Settlement> {
    return this.end(reservationId, 'held', charge);
  }

  async rollback(reservationId: string): Promise<boolean> {
    return this.end(reservationId, 0).success;
  }

  async settle(reservationId: string, units: number, charge?: ChargeOptions): Promise<Settlement> {
    return this.end(reservationId, units, charge);
  }

  async extend(reservationId: string, extensionId: string, units: number, limit: number): Promise<QuotaExtension> {
    const reservation = this.live(reservationId);
    // As the script in Redis: a reservation whose window's count is gone is not extended, and no count is made.
    if (!reservation || !this.counts.has(reservation.dateKey)) return { status: 'no-reservation' };
    const { free, balance } = this.room(reservation.dateKey, reservation.owner, limit);
    const added = units - (reservation.extensions[extensionId] ?? 0);
    if (added <= 0) return { status: 'extended' };
    if (added > free + balance) return { status: 'does-not-fit', remaining: free + balance };
    const fromWindow = Math.min(added, free);
    this.counts.set(reservation.dateKey, (this.counts.get(reservation.dateKey) ?? 0) + fromWindow);
    this.chargePackage(reservation.owner, added - fromWindow);
    reservation.units += fromWindow;
    reservation.packed += added - fromWindow;
    reservation.extensions[extensionId] = units;
    this.persist();
    return { status: 'extended' };
  }

  async renew(reservationId: string, leaseMs: number): Promise<boolean> {
    const reservation = this.live(reservationId);
    if (!reservation) return false;
    reservation.leaseUntil = Math.max(reservation.leaseUntil, Date.now() + leaseMs);
    return true;
  }

  async used(owner: string, day: string): Promise<LedgerCounts> {
    this.reclaim();
    return { used: this.counts.get(`${owner}:${day}`) ?? 0, packageCredits: this.balanceOf(owner) };
  }

  async grantPackage(owner: string, grant: PackageGrant): Promise<PackageGrantOutcome> {
    const held = this.packages.get(owner) ?? this.newPackages(owner);
    if (held.payments.has(grant.transactionId)) return 'duplicate';
    held.payments.set(grant.transactionId, { credits: grant.credits, paid: grant.paid, revoked: 0, at: grant.at });
    held.balance += grant.credits;
    return 'granted';
  }

  async revokePackage(owner: string, refund: PackageRefundRequest): Promise<PackageRevokeOutcome> {
    const held = this.packages.get(owner);
    const payment = held?.payments.get(refund.transactionId);
    if (!held || !payment) return { status: 'unknown-transaction' };
    if (held.adjustments.has(refund.adjustmentId)) return { status: 'duplicate' };
    const left = payment.credits - payment.revoked;
    const paid = Number(payment.paid) || 0;
    const share = paid > 0 ? Math.min(left, Math.floor((payment.credits * (Number(refund.amount) || 0)) / paid)) : 0;
    const want = refund.full ? left : share;
    const take = Math.min(want, held.balance);
    held.balance -= take;
    payment.revoked += take;
    held.adjustments.set(refund.adjustmentId, take);
    return { status: 'revoked', revoked: take, unrecovered: want - take };
  }

  async recentCharges(owner: string): Promise<ChargeEntry[]> {
    return [...(this.packages.get(owner)?.charges ?? [])];
  }

  async rememberTransactionOwner(transactionId: string, owner: string): Promise<void> {
    this.transactionOwners.set(transactionId, owner);
  }

  async transactionOwner(transactionId: string): Promise<string | null> {
    return this.transactionOwners.get(transactionId) ?? null;
  }

  async packageBalance(owner: string): Promise<number> {
    return this.balanceOf(owner);
  }

  async forgetPackages(owner: string): Promise<void> {
    this.forgetOwner(owner);
  }
}
