import type { UserTier } from '../auth/types';
import type { QuotaPeriod } from '../plan-limits';

export type ApiKeyScope = 'convert:read' | 'convert:write' | 'storage:download' | '*';

/** The most active (not revoked) API keys an account holds at once (docs/policy-decisions.md, entry 296). */
export const MAX_ACTIVE_API_KEYS = 20;

export const ALL_API_KEY_SCOPES: ApiKeyScope[] = [
  'convert:read',
  'convert:write',
  'storage:download',
];

export interface ApiKey {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  keyHash: string;
  previousKeyHash?: string;
  graceExpiresAt?: number;
  createdAt: number;
  lastUsedAt?: number;
  expiresAt?: number;
  status: 'active' | 'revoked';
  allowedIps?: string[];
  webhookUrl?: string;
  webhookSecret?: string;
  scopes?: ApiKeyScope[];
  lastExpiryNotifiedAt?: number;
  /** The version of the terms in force when the key was created (`TERMS_VERSION`); absent on keys made before it was recorded. */
  acceptedTermsVersion?: string;
}

export interface ApiKeyCreateOptions {
  allowedIps?: string[];
  webhookUrl?: string;
  webhookSecret?: string;
  scopes?: ApiKeyScope[];
  expiresAt?: number;
  acceptedTermsVersion?: string;
}

export interface ApiKeyUpdateOptions {
  name?: string;
  allowedIps?: string[];
  webhookUrl?: string;
  webhookSecret?: string;
  scopes?: ApiKeyScope[];
  expiresAt?: number;
}

export interface ApiKeyRotateOptions {
  gracePeriodSeconds?: number;
}

export interface ApiKeyRotateResult {
  key: ApiKey;
  newSecretKey: string;
  graceExpiresAt: number;
}

export interface ApiKeyCreateResult {
  key: ApiKey;
  secretKey: string;
}

export interface QuotaReservation {
  reservationId: string;
  userId: string;
  units: number;
  createdAt: number;
  expiresAt: number;
  status: 'reserved' | 'committed' | 'rolled_back';
}

/**
 * The credits of an account (docs/policy-decisions.md, entry 285). `dailyLimit` and `usedToday` keep the names clients already read and count
 * the credits of the window: the UTC day for anonymous callers and the free plan, the billing period of a subscription (`period`).
 * `packageCredits` is the package balance, which has no window. `remaining` is what the account can spend now: what is left of the
 * window plus the package balance.
 */
export interface QuotaUsage {
  tier: UserTier;
  period: QuotaPeriod;
  dailyLimit: number;
  usedToday: number;
  remaining: number;
  resetAt: number;
  packageCredits: number;
}

/** What a charge was for: the conversion's formats, its class cost and the credits added for processing time. */
export interface ChargeNote {
  /** The source and target format ids; absent for a graph, which charges many conversions together. */
  from?: string;
  to?: string;
  /** Credits of the conversion's class. */
  base: number;
  /** Credits added for the minutes of processing beyond the first. */
  surcharge?: number;
  /** `graph` for the credits a job graph was charged in all, `batch` for a batch of files. */
  kind?: 'graph' | 'batch';
}

/** One charge in the list of recent charges of an account. */
export interface ChargeEntry extends ChargeNote {
  /** When it was charged, in milliseconds since the epoch. */
  at: number;
  /** Credits charged in all, and how many of them came from the package balance. */
  credits: number;
  fromPackage: number;
  /** Credits owed that the account no longer had (the work was done before the surcharge was known). */
  uncharged?: number;
}

export interface UserConversionFile {
  id: string;
  userId: string;
  fileName: string;
  fromFormat: string;
  toFormat: string;
  size: number;
  downloadUrl: string;
  /** The storage key of the file, which the retention rule tracks; absent on records made before it was kept. */
  storageKey?: string;
  /** The graph that made the file, for a final output of a graph: the storage key is under `results/<graphId>/`, not under the record id. */
  graphId?: string;
  createdAt: number;
  expiresAt: number;
}

/** What a converted file's history record is made from; the store adds the creation time and the expiry. */
export interface UserConversionFileInput {
  /** The record id; made up when absent. A job's result is recorded under the job id, so recording it again changes nothing. */
  id?: string;
  userId: string;
  fileName: string;
  fromFormat: string;
  toFormat: string;
  size: number;
  downloadUrl: string;
  storageKey?: string;
  /** The graph whose final output the file is; absent for a job's result and a synchronous conversion. */
  graphId?: string;
  /** How long the record is kept; the time an undelivered result is kept when absent. */
  ttlMs?: number;
}

export interface WebhookDlqEntry {
  id: string;
  originalDeliveryId: string;
  targetUrl: string;
  event: string;
  payload: Record<string, unknown>;
  secret: string;
  failedAt: number;
  finalStatusCode?: number;
  errorMessage?: string;
  retryCount: number;
  status: 'failed' | 'replayed';
  replayedAt?: number;
  /** User who owns the webhook; entries without an owner are not exposed through the API. */
  ownerUserId?: string;
  /** API key whose settings produced the webhook, when known. */
  ownerKeyId?: string;
}
