import type { UserTier } from '../auth/types';

export interface ApiKey {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  keyHash: string;
  createdAt: number;
  lastUsedAt?: number;
  status: 'active' | 'revoked';
}

export interface ApiKeyCreateResult {
  key: ApiKey;
  secretKey: string;
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
