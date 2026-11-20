import crypto from 'node:crypto';
import type Redis from 'ioredis';
import { JOB_DEADLINE_CEILING_MS } from '../config/schema';
import {
  EXTEND_QUOTA_LUA_SCRIPT,
  GRANT_PACKAGE_LUA_SCRIPT,
  GRANT_PROMO_LUA_SCRIPT,
  PACKAGE_STANDING_LUA_SCRIPT,
  RELEASE_PROMO_BUDGET_LUA_SCRIPT,
  RENEW_QUOTA_LUA_SCRIPT,
  RESERVE_PROMO_BUDGET_LUA_SCRIPT,
  RESERVE_QUOTA_LUA_SCRIPT,
  REVOKE_PACKAGE_LUA_SCRIPT,
  SETTLE_TO_QUOTA_LUA_SCRIPT,
  USED_QUOTA_LUA_SCRIPT,
  VOID_PROMO_LUA_SCRIPT,
} from './quota-lua-scripts';
import { balanceOf, compareGrantsByBurnDownOrder, promoGrantIdOf, spendableInBurnOrder, type PromoGrant, type PromoGrantOutcome, type PromoVoidOutcome } from './promo-grants';
import type { ChargeEntry, ChargeNote } from './types';

/**
 * Where the credits of an owner are reserved, charged and given back (docs/policy-decisions.md, entries 15 and 285): in Redis
 * beside the other quota counters, or in this process when the quota store has no Redis. Both keep one count per owner and
 * window (the UTC day of the free plan, the billing period of a subscription), which holds what is charged and what is reserved,
 * and one package balance per owner, which has no window, and the promotional grants of the owner (entry 374), which are spent in
 * burn-down order between the two. A reservation draws on the window first, then on the grants, and on the balance for the rest;
 * a refund goes back to the balance first, then to the grants drawn last.
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

/**
 * What the ledger holds of one owner: the window's count, the package balance (what can be spent now) and the package credits that
 * reservations in flight hold, net of what refunds claim from them (what makes an account a payer while it spends them).
 */
export interface LedgerCounts {
  used: number;
  packageCredits: number;
  packageHeld: number;
  /** The credits of the promotional grants that can be spent now, and the earliest end among them. They make no one a payer. */
  promoCredits: number;
  promoNextExpiry?: number;
}

/** A grant of promotional credits to write: one for each campaign and account. */
export interface PromoGrantRequest {
  campaignId: string;
  amount: number;
  priority: number;
  expiresAt?: number;
  reason: string;
  actor: string;
  at: number;
}

/** What the ledger holds of one campaign. */
export interface PromoCampaign {
  /** The credits the campaign may give in all; absent for no cap. */
  budget?: number;
  /** The credits and the accounts counted against it so far. */
  granted: number;
  count: number;
  createdAt?: number;
  /** Set when the whole campaign was voided; it takes no more grants. */
  voidedAt?: number;
}

/** What a package payment did to the balance: credited once, or already credited. */
export type PackageGrantOutcome = 'granted' | 'duplicate';

/**
 * What a refund of a package payment did: the credits taken back now, the credits that were owed back and are already spent, the credits
 * that reservations in flight hold and that are taken back when those units return, or why nothing was taken.
 */
export type PackageRevokeOutcome = { status: 'revoked'; revoked: number; unrecovered: number; deferred: number } | { status: 'duplicate' } | { status: 'unknown-transaction' };

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
  /** The package balance of `owner`: what can be spent now. */
  packageBalance(owner: string): Promise<number>;
  /** The package credit debt of `owner` carried forward from spent refunded or charged-back package credits. */
  packageDebt(owner: string): Promise<number>;
  /** How many package payments were ever credited to `owner`, spent or not: the history a later refund or chargeback names. */
  packageTransactionCount(owner: string): Promise<number>;
  /** The package balance of `owner` and the package credits held by reservations in flight, net of what refunds claim from them. */
  packageStanding(owner: string): Promise<{ balance: number; held: number }>;
  /** Places an account-level checkout hold (e.g. after an approved payment chargeback). */
  setBillingHold(owner: string, reason: string): Promise<void>;
  /** Clears an account-level checkout hold. */
  clearBillingHold(owner: string): Promise<void>;
  /** Whether `owner` currently has an active checkout hold. */
  hasBillingHold(owner: string): Promise<boolean>;
  /** Deletes the package balance, payments, adjustments, charges, hold, promotional grants and payment index entries of `owner`; the erasure of an account calls it. */
  forgetPackages(owner: string): Promise<void>;
  /** Gives `owner` the promotional grant of a campaign, once for each campaign and account, and counts it against the campaign's `budget` (set or raised when given). */
  grantPromo(owner: string, request: PromoGrantRequest, budget?: number): Promise<PromoGrantOutcome>;
  /** Takes what is left of the grant of `campaignId` out of `owner`'s balance; what was spent stays spent, and the grant stays so that the campaign cannot grant it again. */
  voidPromo(owner: string, campaignId: string, at: number): Promise<PromoVoidOutcome>;
  /** Marks the campaign voided, so that it takes no more grants. */
  voidPromoCampaign(campaignId: string, at: number): Promise<void>;
  /** Every promotional grant of `owner`, voided and ended ones too. */
  promoGrants(owner: string): Promise<PromoGrant[]>;
  /** The count of a campaign, or null when it never granted. */
  promoCampaign(campaignId: string): Promise<PromoCampaign | null>;
  /** A page of the accounts a campaign counts, from `cursor` ('0' to start); `next` is '0' at the end. */
  promoCampaignOwners(campaignId: string, cursor: string): Promise<{ owners: string[]; next: string }>;
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
type ReservationKeys = [usage: string, leases: string, held: string, limits: string, pool: string, packageLeases: string, packageHolds: string, packageDebt: string, promo: string, promoLeases: string, promoHolds: string, extensions: string, log: string];

/** The grant record as the scripts keep it (JSON with the field names of Lua), and the name each field has here. */
interface StoredGrant {
  grant_id: string;
  campaign_id: string;
  amount: number;
  remaining: number;
  granted_at: number;
  expires_at?: number;
  voided_at?: number;
  voided_remaining?: number;
  priority: number;
  reason: string;
  actor: string;
}

function grantFromStored(stored: StoredGrant): PromoGrant {
  return {
    grantId: stored.grant_id,
    campaignId: stored.campaign_id,
    amount: stored.amount,
    remaining: stored.remaining,
    grantedAt: stored.granted_at,
    priority: stored.priority,
    reason: stored.reason,
    actor: stored.actor,
    ...(stored.expires_at === undefined ? {} : { expiresAt: stored.expires_at }),
    ...(stored.voided_at === undefined ? {} : { voidedAt: stored.voided_at }),
    ...(stored.voided_remaining === undefined ? {} : { voidedRemaining: stored.voided_remaining }),
  };
}

/** The status the budget script answered for a grant, by its number. */
const PROMO_BUDGET_REFUSAL: Readonly<Record<string, PromoGrantOutcome>> = { '-1': 'campaign-voided', '-2': 'budget-exhausted' };

/** How many recent charges an owner keeps; the settle script trims its list to this. */
export const RECENT_CHARGES = 50;

/** The ledger every web and worker instance shares: one Lua script per step (quota-lua-scripts.ts). */
export class RedisReservationLedger implements ReservationLedger {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string
  ) {}

  /**
   * The keys of `owner`'s `window`: its count, its leases, the units they hold from it and the limit each was made under; then the
   * owner's own: the package balance, the leases that hold package units (which a script reclaims whichever window it is given), the
   * units they hold and the debt of refunds that found them held; then the promotional grants, their leases and held units.
   */
  private windowKeys(owner: string, window: string): [string, string, string, string, string, string, string, string, string, string, string] {
    return [
      `${this.prefix}usage:{${owner}}:${window}`,
      `${this.prefix}leases:{${owner}}:${window}`,
      `${this.prefix}held:{${owner}}:${window}`,
      `${this.prefix}limits:{${owner}}:${window}`,
      this.poolKey(owner),
      ...this.packageLeaseKeys(owner),
      ...this.promoKeys(owner),
    ];
  }

  /** The owner's promotional grants (a hash by campaign id), the leases that hold their units and the units they hold. */
  private promoKeys(owner: string): [string, string, string] {
    return [`${this.prefix}promo:{${owner}}`, `${this.prefix}promo:{${owner}}:qlist`, `${this.prefix}promo:{${owner}}:qholds`];
  }

  /** A campaign's count (a hash) and the accounts it counts (a set); both carry the campaign's tag, apart from the accounts' keys. */
  private campaignKeys(campaignId: string): [string, string] {
    return [`${this.prefix}promo:campaign:{${campaignId}}`, `${this.prefix}promo:campaign:{${campaignId}}:owners`];
  }

  /** The owner's package leases, the units they hold and the debt of refunds that found them held. */
  private packageLeaseKeys(owner: string): [string, string, string] {
    return [`${this.prefix}credits:{${owner}}:plist`, `${this.prefix}credits:{${owner}}:pholds`, `${this.prefix}credits:{${owner}}:debt`];
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

  private debtKey(owner: string): string {
    return `${this.prefix}credits:{${owner}}:debt`;
  }

  private holdKey(owner: string): string {
    return `${this.prefix}credits:{${owner}}:hold`;
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
    const [allowed, remaining] = (await this.redis.eval(RESERVE_QUOTA_LUA_SCRIPT, 11, ...this.windowKeys(request.owner, request.day), ...args)) as [number, number];
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
    const [used, packageCredits, packageHeld, promoCredits, promoNextExpiry] = (await this.redis.eval(USED_QUOTA_LUA_SCRIPT, 11, ...this.windowKeys(owner, day))) as [number, number, number, number, number];
    return { used: Number(used), packageCredits: Number(packageCredits), packageHeld: Number(packageHeld), promoCredits: Number(promoCredits), ...(Number(promoNextExpiry) > 0 ? { promoNextExpiry: Number(promoNextExpiry) } : {}) };
  }

  async grantPackage(owner: string, grant: PackageGrant): Promise<PackageGrantOutcome> {
    const reply = (await this.redis.eval(
      GRANT_PACKAGE_LUA_SCRIPT,
      3,
      this.poolKey(owner),
      this.transactionsKey(owner),
      this.debtKey(owner),
      grant.transactionId,
      grant.credits,
      grant.paid,
      grant.at
    )) as [number, number];
    return Number(reply[0]) === 1 ? 'granted' : 'duplicate';
  }

  async revokePackage(owner: string, refund: PackageRefundRequest): Promise<PackageRevokeOutcome> {
    const reply = (await this.redis.eval(REVOKE_PACKAGE_LUA_SCRIPT, 6, this.poolKey(owner), this.transactionsKey(owner), this.adjustmentsKey(owner), ...this.packageLeaseKeys(owner), refund.transactionId, refund.adjustmentId, refund.amount, refund.full ? 1 : 0)) as [number, number, number, number];
    const status = Number(reply[0]);
    if (status === 1) return { status: 'revoked', revoked: Number(reply[1]), unrecovered: Number(reply[2]), deferred: Number(reply[3]) };
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

  async packageDebt(owner: string): Promise<number> {
    return Number((await this.redis.get(this.debtKey(owner))) ?? 0);
  }

  async packageTransactionCount(owner: string): Promise<number> {
    return this.redis.hlen(this.transactionsKey(owner));
  }

  async packageStanding(owner: string): Promise<{ balance: number; held: number }> {
    const [balance, held] = (await this.redis.eval(PACKAGE_STANDING_LUA_SCRIPT, 4, this.poolKey(owner), ...this.packageLeaseKeys(owner))) as [number, number];
    return { balance: Number(balance), held: Number(held) };
  }

  async setBillingHold(owner: string, reason: string): Promise<void> {
    await this.redis.set(this.holdKey(owner), reason);
  }

  async clearBillingHold(owner: string): Promise<void> {
    await this.redis.del(this.holdKey(owner));
  }

  async hasBillingHold(owner: string): Promise<boolean> {
    return (await this.redis.get(this.holdKey(owner))) !== null;
  }

  async forgetPackages(owner: string): Promise<void> {
    const transactionIds = await this.redis.hkeys(this.transactionsKey(owner));
    // The keys of the account share one slot; the payment index keys carry no tag, so each goes in a command of its own (Redis Cluster refuses a DEL over two slots).
    await this.redis.del(
      this.poolKey(owner),
      this.logKey(owner),
      this.transactionsKey(owner),
      this.adjustmentsKey(owner),
      this.holdKey(owner),
      ...this.packageLeaseKeys(owner)
    );
    for (const id of transactionIds) await this.redis.del(`${this.prefix}credits:txnowner:${id}`);
    // The campaigns drop the account too, so that nothing of it stays in their sets; their counts of credits granted stay, since the budget was spent.
    for (const campaignId of await this.redis.hkeys(this.promoKeys(owner)[0])) await this.redis.srem(this.campaignKeys(campaignId)[1], owner);
    await this.redis.del(...this.promoKeys(owner));
  }

  async grantPromo(owner: string, request: PromoGrantRequest, budget?: number): Promise<PromoGrantOutcome> {
    const [campaignKey, ownersKey] = this.campaignKeys(request.campaignId);
    const reserved = (await this.redis.eval(RESERVE_PROMO_BUDGET_LUA_SCRIPT, 2, campaignKey, ownersKey, owner, request.amount, budget ?? '', request.at)) as [number, number];
    const refusal = PROMO_BUDGET_REFUSAL[String(reserved[0])];
    if (refusal) return refusal;
    const stored: StoredGrant = {
      grant_id: promoGrantIdOf(request.campaignId, owner),
      campaign_id: request.campaignId,
      amount: request.amount,
      remaining: request.amount,
      granted_at: request.at,
      priority: request.priority,
      reason: request.reason,
      actor: request.actor,
      ...(request.expiresAt === undefined ? {} : { expires_at: request.expiresAt }),
    };
    const written = Number(await this.redis.eval(GRANT_PROMO_LUA_SCRIPT, 1, this.promoKeys(owner)[0], request.campaignId, JSON.stringify(stored)));
    if (written === 1) return 'granted';
    // The account held the grant already. Had this call counted it, the count is given back: the first call did.
    if (Number(reserved[0]) === 1) await this.redis.eval(RELEASE_PROMO_BUDGET_LUA_SCRIPT, 2, campaignKey, ownersKey, owner, request.amount);
    return 'duplicate';
  }

  async voidPromo(owner: string, campaignId: string, at: number): Promise<PromoVoidOutcome> {
    const [status, voided] = (await this.redis.eval(VOID_PROMO_LUA_SCRIPT, 1, this.promoKeys(owner)[0], campaignId, at)) as [number, number];
    if (Number(status) === 1) return { status: 'voided', voided: Number(voided) };
    return { status: Number(status) === 0 ? 'already-voided' : 'unknown-grant' };
  }

  async voidPromoCampaign(campaignId: string, at: number): Promise<void> {
    await this.redis.hsetnx(this.campaignKeys(campaignId)[0], 'voided_at', String(at));
  }

  async promoGrants(owner: string): Promise<PromoGrant[]> {
    const raws = await this.redis.hvals(this.promoKeys(owner)[0]);
    return raws.map((raw) => grantFromStored(JSON.parse(raw) as StoredGrant)).sort(compareGrantsByBurnDownOrder);
  }

  async promoCampaign(campaignId: string): Promise<PromoCampaign | null> {
    const fields = await this.redis.hgetall(this.campaignKeys(campaignId)[0]);
    if (Object.keys(fields).length === 0) return null;
    return {
      granted: Number(fields.granted ?? 0),
      count: Number(fields.count ?? 0),
      ...(fields.budget === undefined ? {} : { budget: Number(fields.budget) }),
      ...(fields.created_at === undefined ? {} : { createdAt: Number(fields.created_at) }),
      ...(fields.voided_at === undefined ? {} : { voidedAt: Number(fields.voided_at) }),
    };
  }

  async promoCampaignOwners(campaignId: string, cursor: string): Promise<{ owners: string[]; next: string }> {
    const [next, owners] = await this.redis.sscan(this.campaignKeys(campaignId)[1], cursor, 'COUNT', 500);
    return { owners, next };
  }
}

/** A reservation this process holds. */
interface HeldReservation {
  /** The units it holds from the window's count. */
  units: number;
  /** The units it holds from the owner's package balance. */
  packed: number;
  /** The units it holds from the owner's promotional grants, by campaign, in the order they were drawn. */
  promo: Array<{ campaignId: string; units: number }>;
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
  /** The credits of refunds not yet covered by returned held units or subsequent package grants. */
  debt: number;
  hold?: string;
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
  /** The promotional grants of each owner, by campaign id, as the `promo:{owner}` hash keeps them in Redis. */
  private readonly promoByOwner = new Map<string, Map<string, PromoGrant>>();
  private readonly campaigns = new Map<string, PromoCampaign & { owners: Set<string> }>();

  constructor(
    private readonly counts: Map<string, number>,
    private readonly persist: () => void
  ) {}

  /** Forgets every reservation and package, as a reset of the key store forgets its counts. */
  clear(): void {
    this.reservations.clear();
    this.packages.clear();
    this.transactionOwners.clear();
    this.promoByOwner.clear();
    this.campaigns.clear();
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
    for (const campaignId of this.promoByOwner.get(owner)?.keys() ?? []) this.campaigns.get(campaignId)?.owners.delete(owner);
    this.promoByOwner.delete(owner);
  }

  /** Gives back the units of every lease that ended by `now`; answers how many it gave back. */
  reclaim(now: number = Date.now()): number {
    let reclaimed = 0;
    for (const [id, reservation] of this.reservations) {
      if (reservation.leaseUntil > now) continue;
      this.charge(reservation.dateKey, -reservation.units);
      this.reservations.delete(id);
      this.returnPackage(reservation.owner, reservation.packed);
      this.returnPromo(reservation.owner, reservation.promo);
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

  /** Gives package units that a reservation held back to `owner`: the debt of refunds that found them held first, the balance with the rest. */
  private returnPackage(owner: string, units: number): void {
    const held = this.packages.get(owner);
    if (held === undefined || units <= 0) return;
    const paid = Math.min(held.debt, units);
    held.debt -= paid;
    held.balance += units - paid;
  }

  /** The grants of `owner` that can be spent now, in burn-down order. */
  private spendable(owner: string, now: number = Date.now()): PromoGrant[] {
    return spendableInBurnOrder(this.promoByOwner.get(owner)?.values() ?? [], now);
  }

  /** Spends `units` of the grants of `owner` in burn-down order and answers what each gave; the caller has checked that they fit. */
  private drawPromo(owner: string, units: number): Array<{ campaignId: string; units: number }> {
    const draws: Array<{ campaignId: string; units: number }> = [];
    let left = units;
    for (const grant of this.spendable(owner)) {
      if (left <= 0) break;
      const take = Math.min(left, grant.remaining);
      grant.remaining -= take;
      left -= take;
      draws.push({ campaignId: grant.campaignId, units: take });
    }
    return draws;
  }

  /** Gives units back to the grants they were drawn from, except those voided or gone. */
  private returnPromo(owner: string, draws: ReadonlyArray<{ campaignId: string; units: number }>): void {
    for (const draw of draws) {
      const grant = this.promoByOwner.get(owner)?.get(draw.campaignId);
      if (grant && grant.voidedAt === undefined) grant.remaining += draw.units;
    }
  }

  /** The credits of the grants of `owner` that can be spent now. */
  private promoLeft(owner: string): number {
    return balanceOf(this.promoByOwner.get(owner)?.values() ?? [], Date.now()).credits;
  }

  /** The package credits that live reservations of `owner` hold. */
  private heldPackage(owner: string): number {
    let total = 0;
    for (const reservation of this.reservations.values()) {
      if (reservation.owner === owner) total += reservation.packed;
    }
    return total;
  }

  /** The held credits that no refund claims. */
  private unclaimedHeld(owner: string): number {
    return Math.max(0, this.heldPackage(owner) - (this.packages.get(owner)?.debt ?? 0));
  }

  private balanceOf(owner: string): number {
    return this.packages.get(owner)?.balance ?? 0;
  }

  /** The window's headroom under `limit`, the credits of the promotional grants and the package balance: what an owner can still spend from each. */
  private room(dateKey: string, owner: string, limit: number): { free: number; promo: number; balance: number } {
    return { free: Math.max(0, limit - (this.counts.get(dateKey) ?? 0)), promo: this.promoLeft(owner), balance: this.balanceOf(owner) };
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
    const heldPromo = reservation.promo.reduce((total, draw) => total + draw.units, 0);
    const heldTotal = reservation.units + heldPromo + reservation.packed;
    const target = (units === 'held' ? heldTotal : units) + (charge.extra ?? 0);
    let window = reservation.units;
    let promo = heldPromo;
    let packed = reservation.packed;
    let uncharged = 0;
    if (target <= heldTotal) {
      window = Math.min(reservation.units, target);
      promo = Math.min(heldPromo, target - window);
      packed = target - window - promo;
    } else {
      const more = target - heldTotal;
      const { free, promo: promoLeft, balance } = this.room(reservation.dateKey, reservation.owner, reservation.limit);
      const addWindow = Math.min(more, free);
      const addPromo = Math.min(more - addWindow, promoLeft);
      const addPackage = Math.min(more - addWindow - addPromo, balance);
      window += addWindow;
      promo += addPromo;
      packed += addPackage;
      uncharged = more - addWindow - addPromo - addPackage;
    }
    this.charge(reservation.dateKey, window - reservation.units);
    if (promo < heldPromo) this.returnPromo(reservation.owner, this.takeBack(reservation.promo, heldPromo - promo));
    else if (promo > heldPromo) this.drawPromo(reservation.owner, promo - heldPromo);
    if (packed < reservation.packed) this.returnPackage(reservation.owner, reservation.packed - packed);
    else this.chargePackage(reservation.owner, packed - reservation.packed);
    if (charge.note && window + promo + packed > 0) {
      const held = this.packages.get(reservation.owner) ?? this.newPackages(reservation.owner);
      held.charges.unshift({ ...charge.note, at: Date.now(), credits: window + promo + packed, fromPackage: packed, ...(promo > 0 ? { fromPromo: promo } : {}), ...(uncharged > 0 ? { uncharged } : {}) });
      held.charges.length = Math.min(held.charges.length, RECENT_CHARGES);
    }
    this.persist();
    return { success: true, difference: window + promo + packed - heldTotal, uncharged };
  }

  /** Takes `units` out of `hold`, from the grants drawn last, and answers what was taken. */
  private takeBack(hold: Array<{ campaignId: string; units: number }>, units: number): Array<{ campaignId: string; units: number }> {
    const back: Array<{ campaignId: string; units: number }> = [];
    let left = units;
    for (let i = hold.length - 1; i >= 0 && left > 0; i--) {
      const give = Math.min(left, hold[i]!.units);
      hold[i]!.units -= give;
      left -= give;
      back.push({ campaignId: hold[i]!.campaignId, units: give });
    }
    return back;
  }

  /** Adds `draws` to `hold`, joining those of a grant the hold has. */
  private mergeDraws(hold: Array<{ campaignId: string; units: number }>, draws: ReadonlyArray<{ campaignId: string; units: number }>): void {
    for (const draw of draws) {
      const same = hold.find((entry) => entry.campaignId === draw.campaignId);
      if (same) same.units += draw.units;
      else hold.push({ ...draw });
    }
  }

  private newPackages(owner: string): MemoryPackages {
    const created: MemoryPackages = { balance: 0, debt: 0, payments: new Map(), adjustments: new Map(), charges: [] };
    this.packages.set(owner, created);
    return created;
  }

  async reserve(request: Parameters<ReservationLedger['reserve']>[0]) {
    this.reclaim();
    const dateKey = `${request.owner}:${request.day}`;
    const { free, promo, balance } = this.room(dateKey, request.owner, request.limit);
    const fromWindow = Math.min(request.units, free);
    const fromPromo = Math.min(request.units - fromWindow, promo);
    const fromPackage = request.units - fromWindow - fromPromo;
    if (fromPackage > balance) return { allowed: false, remaining: free + promo + balance };
    if (fromWindow > 0) this.counts.set(dateKey, (this.counts.get(dateKey) ?? 0) + fromWindow);
    const promoHeld = fromPromo > 0 ? this.drawPromo(request.owner, fromPromo) : [];
    this.chargePackage(request.owner, fromPackage);
    this.reservations.set(request.reservationId, {
      units: fromWindow,
      promo: promoHeld,
      packed: fromPackage,
      owner: request.owner,
      dateKey,
      limit: request.limit,
      leaseUntil: Date.now() + request.leaseMs,
      extensions: {},
    });
    this.persist();
    return { allowed: true, remaining: free + promo + balance - request.units };
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
    const { free, promo, balance } = this.room(reservation.dateKey, reservation.owner, limit);
    const added = units - (reservation.extensions[extensionId] ?? 0);
    if (added <= 0) return { status: 'extended' };
    if (added > free + promo + balance) return { status: 'does-not-fit', remaining: free + promo + balance };
    const fromWindow = Math.min(added, free);
    const fromPromo = Math.min(added - fromWindow, promo);
    this.counts.set(reservation.dateKey, (this.counts.get(reservation.dateKey) ?? 0) + fromWindow);
    if (fromPromo > 0) this.mergeDraws(reservation.promo, this.drawPromo(reservation.owner, fromPromo));
    this.chargePackage(reservation.owner, added - fromWindow - fromPromo);
    reservation.units += fromWindow;
    reservation.packed += added - fromWindow - fromPromo;
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
    const promo = balanceOf(this.promoByOwner.get(owner)?.values() ?? [], Date.now());
    return {
      used: this.counts.get(`${owner}:${day}`) ?? 0,
      packageCredits: this.balanceOf(owner),
      packageHeld: this.unclaimedHeld(owner),
      promoCredits: promo.credits,
      ...(promo.nextExpiry === undefined ? {} : { promoNextExpiry: promo.nextExpiry }),
    };
  }

  async grantPackage(owner: string, grant: PackageGrant): Promise<PackageGrantOutcome> {
    const held = this.packages.get(owner) ?? this.newPackages(owner);
    if (held.payments.has(grant.transactionId)) return 'duplicate';
    held.payments.set(grant.transactionId, { credits: grant.credits, paid: grant.paid, revoked: 0, at: grant.at });
    const paidDebt = Math.min(grant.credits, held.debt);
    held.debt -= paidDebt;
    held.balance += grant.credits - paidDebt;
    return 'granted';
  }

  async revokePackage(owner: string, refund: PackageRefundRequest): Promise<PackageRevokeOutcome> {
    this.reclaim();
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
    const short = want - take;
    const deferred = Math.min(short, this.unclaimedHeld(owner));
    held.debt += short;
    payment.revoked += want;
    held.adjustments.set(refund.adjustmentId, want);
    return { status: 'revoked', revoked: take, unrecovered: short - deferred, deferred };
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

  async packageDebt(owner: string): Promise<number> {
    return this.packages.get(owner)?.debt ?? 0;
  }

  async packageTransactionCount(owner: string): Promise<number> {
    return this.packages.get(owner)?.payments.size ?? 0;
  }

  async packageStanding(owner: string): Promise<{ balance: number; held: number }> {
    this.reclaim();
    return { balance: this.balanceOf(owner), held: this.unclaimedHeld(owner) };
  }

  async setBillingHold(owner: string, reason: string): Promise<void> {
    const held = this.packages.get(owner) ?? this.newPackages(owner);
    held.hold = reason;
  }

  async clearBillingHold(owner: string): Promise<void> {
    const held = this.packages.get(owner);
    if (held) delete held.hold;
  }

  async hasBillingHold(owner: string): Promise<boolean> {
    return Boolean(this.packages.get(owner)?.hold);
  }

  async forgetPackages(owner: string): Promise<void> {
    this.forgetOwner(owner);
  }

  async grantPromo(owner: string, request: PromoGrantRequest, budget?: number): Promise<PromoGrantOutcome> {
    const campaign = this.campaigns.get(request.campaignId) ?? { granted: 0, count: 0, owners: new Set<string>() };
    const counted = campaign.owners.has(owner);
    if (!counted) {
      if (campaign.voidedAt !== undefined) return 'campaign-voided';
      if (budget !== undefined) campaign.budget = budget;
      if (campaign.budget !== undefined && campaign.granted + request.amount > campaign.budget) return 'budget-exhausted';
      campaign.granted += request.amount;
      campaign.count += 1;
      campaign.createdAt ??= request.at;
      campaign.owners.add(owner);
      this.campaigns.set(request.campaignId, campaign);
    }
    const grants = this.promoByOwner.get(owner) ?? new Map<string, PromoGrant>();
    if (grants.has(request.campaignId)) {
      if (!counted) {
        campaign.granted -= request.amount;
        campaign.count -= 1;
        campaign.owners.delete(owner);
      }
      return 'duplicate';
    }
    grants.set(request.campaignId, {
      grantId: promoGrantIdOf(request.campaignId, owner),
      campaignId: request.campaignId,
      amount: request.amount,
      remaining: request.amount,
      grantedAt: request.at,
      priority: request.priority,
      reason: request.reason,
      actor: request.actor,
      ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
    });
    this.promoByOwner.set(owner, grants);
    return 'granted';
  }

  async voidPromo(owner: string, campaignId: string, at: number): Promise<PromoVoidOutcome> {
    const grant = this.promoByOwner.get(owner)?.get(campaignId);
    if (!grant) return { status: 'unknown-grant' };
    if (grant.voidedAt !== undefined) return { status: 'already-voided' };
    const voided = grant.remaining;
    grant.voidedAt = at;
    grant.voidedRemaining = voided;
    grant.remaining = 0;
    return { status: 'voided', voided };
  }

  async voidPromoCampaign(campaignId: string, at: number): Promise<void> {
    const campaign = this.campaigns.get(campaignId) ?? { granted: 0, count: 0, owners: new Set<string>() };
    campaign.voidedAt ??= at;
    this.campaigns.set(campaignId, campaign);
  }

  async promoGrants(owner: string): Promise<PromoGrant[]> {
    return [...(this.promoByOwner.get(owner)?.values() ?? [])].map((grant) => ({ ...grant })).sort(compareGrantsByBurnDownOrder);
  }

  async promoCampaign(campaignId: string): Promise<PromoCampaign | null> {
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) return null;
    const { owners: _owners, ...record } = campaign;
    return record;
  }

  async promoCampaignOwners(campaignId: string): Promise<{ owners: string[]; next: string }> {
    return { owners: [...(this.campaigns.get(campaignId)?.owners ?? [])], next: '0' };
  }
}
