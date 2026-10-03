import type { UserTier } from '../auth/types';

export type ApiKeyScope = 'convert:read' | 'convert:write' | 'storage:download' | '*';

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
}

export interface ApiKeyCreateOptions {
  allowedIps?: string[];
  webhookUrl?: string;
  webhookSecret?: string;
  scopes?: ApiKeyScope[];
  expiresAt?: number;
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

export interface QuotaUsage {
  tier: UserTier;
  dailyLimit: number;
  usedToday: number;
  remaining: number;
  resetAt: number;
}

export interface UserConversionFile {
  id: string;
  userId: string;
  fileName: string;
  fromFormat: string;
  toFormat: string;
  size: number;
  downloadUrl: string;
  createdAt: number;
  expiresAt: number;
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
