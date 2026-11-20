/*
 * `compareGrantsByBurnDownOrder` is a translation to TypeScript of the function of the same name in openmeterio/openmeter,
 * openmeter/credit/engine/grant.go lines 181-208 at commit 8eb6a5bc172229394a2aaaaba34ba42dcddbbe1f (the file has the SHA-256
 * 354674bef8481f41a199288c4837c815b81aae6e17bded3f46e1ddca450c523f). Apache-2.0; the repository states no copyright line.
 * The order is that of the Go function line by line: priority, then the earlier expiry (a grant without one last), then the earlier
 * creation time, then the id. The Go types are replaced by `BurnDownGrant`, and `cmp.Compare` and `strings.Compare` by `compareNumbers`
 * and `compareText`. Everything else in this file is written for this repository. See NOTICE and docs/licensing.md, 2.38.
 */

/** The fields of a grant that decide when it is spent. */
export interface BurnDownGrant {
  /** Lower numbers are spent first. */
  priority: number;
  /** When the grant ends, in milliseconds since the epoch; absent for a grant that does not expire. */
  expiresAt?: number;
  /** When the grant was made, in milliseconds since the epoch. */
  grantedAt: number;
  grantId: string;
}

/** A grant of promotional (event) credits to one account (docs/policy-decisions.md, entry 374). */
export interface PromoGrant extends BurnDownGrant {
  campaignId: string;
  /** Credits the grant gave. */
  amount: number;
  /** Credits of it still to spend, not counting those that reservations in flight hold. */
  remaining: number;
  /** Absent while the grant is not voided. */
  voidedAt?: number;
  /** What was left of the grant when it was voided. */
  voidedRemaining?: number;
  reason: string;
  actor: string;
}

/** What a grant of promotional credits did: added to the account, already added (also after a void), or refused. */
export type PromoGrantOutcome = 'granted' | 'duplicate' | 'budget-exhausted' | 'campaign-voided';

/** What voiding a grant did: how many credits it took out of the account, or why nothing changed. */
export type PromoVoidOutcome = { status: 'voided'; voided: number } | { status: 'already-voided' } | { status: 'unknown-grant' };

/** What `campaignId` and the other fields of a new grant must look like. */
export const PROMO_LIMITS = {
  /** Lowercase letters, digits, dot, underscore and hyphen: the id travels in keys, logs and the host's command line. */
  campaignIdPattern: /^[a-z0-9][a-z0-9._-]{0,63}$/,
  maxCredits: 100_000,
  maxText: 200,
} as const;

/** The credits a grant adds to the balance of its owner and the next time any of them ends, from one pass over the grants. */
export interface PromoBalance {
  credits: number;
  /** The earliest end among the grants that still have credits, in milliseconds since the epoch; absent when none of them ends. */
  nextExpiry?: number;
}

function compareNumbers(a: number, b: number): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function compareText(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export function compareGrantsByBurnDownOrder(i: BurnDownGrant, j: BurnDownGrant): number {
  const priorityOrder = compareNumbers(i.priority, j.priority);
  if (priorityOrder !== 0) return priorityOrder;

  const iExpiration = i.expiresAt;
  const jExpiration = j.expiresAt;

  if (iExpiration === undefined && jExpiration !== undefined) return 1;

  if (iExpiration !== undefined && jExpiration === undefined) return -1;

  if (iExpiration !== undefined && jExpiration !== undefined) {
    const expirationOrder = compareNumbers(Math.floor(iExpiration / 1000), Math.floor(jExpiration / 1000));
    if (expirationOrder !== 0) return expirationOrder;
  }

  const creationOrder = compareNumbers(i.grantedAt, j.grantedAt);
  if (creationOrder !== 0) return creationOrder;

  return compareText(i.grantId, j.grantId);
}

/** Whether `grant` can be spent at `now`: not voided, not ended, with credits left. */
export function isSpendable(grant: PromoGrant, now: number): boolean {
  return grant.voidedAt === undefined && grant.remaining > 0 && (grant.expiresAt === undefined || grant.expiresAt > now);
}

/** The spendable grants in the order they are spent. */
export function spendableInBurnOrder(grants: Iterable<PromoGrant>, now: number): PromoGrant[] {
  return [...grants].filter((grant) => isSpendable(grant, now)).sort(compareGrantsByBurnDownOrder);
}

/** The credits that can be spent now and the earliest end among them. */
export function balanceOf(grants: Iterable<PromoGrant>, now: number): PromoBalance {
  let credits = 0;
  let nextExpiry: number | undefined;
  for (const grant of grants) {
    if (!isSpendable(grant, now)) continue;
    credits += grant.remaining;
    if (grant.expiresAt !== undefined && (nextExpiry === undefined || grant.expiresAt < nextExpiry)) nextExpiry = grant.expiresAt;
  }
  return nextExpiry === undefined ? { credits } : { credits, nextExpiry };
}

/** The grant id of `campaignId` for `owner`: one grant for each pair, so the id is the pair. */
export function promoGrantIdOf(campaignId: string, owner: string): string {
  return `${campaignId}:${owner}`;
}

/** The refusal text of a request for a grant, or undefined when the request can be made. */
export function promoRequestRefusal(request: { campaignId: string; amount: number; priority?: number; expiresAt?: number; reason?: string; actor?: string }, now: number): string | undefined {
  if (!PROMO_LIMITS.campaignIdPattern.test(request.campaignId)) return 'A campaign id has 1 to 64 lowercase letters, digits, dots, underscores or hyphens and starts with a letter or a digit.';
  if (!Number.isInteger(request.amount) || request.amount < 1 || request.amount > PROMO_LIMITS.maxCredits) return `Credits must be a whole number from 1 to ${PROMO_LIMITS.maxCredits}.`;
  if (request.priority !== undefined && (!Number.isInteger(request.priority) || request.priority < 0 || request.priority > 255)) return 'A priority is a whole number from 0 to 255.';
  if (request.expiresAt !== undefined && !(request.expiresAt > now)) return 'The expiry must be a time in the future.';
  if ((request.reason?.length ?? 0) > PROMO_LIMITS.maxText || (request.actor?.length ?? 0) > PROMO_LIMITS.maxText) return `A reason and an actor take at most ${PROMO_LIMITS.maxText} characters.`;
  return undefined;
}
